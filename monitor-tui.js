#!/usr/bin/env node
/**
 * Uptime Monitor — TUI dashboard (blessed)
 *
 * Checks endpoints via TCP, and optionally layers an HTTP request on
 * top (set "checkMode": "tcp" in config.json to skip HTTP entirely —
 * use this for non-HTTP services like game servers, where there's no
 * HTTP response to wait for and a real HTTP request would just be
 * ignored or rejected by the server).
 *
 * Rendered as a fixed terminal UI: no flicker, no scrolling away,
 * pinned boxes that just update their contents in place.
 *
 * Usage:
 *   node monitor-tui.js                 # uses config.json
 *   node monitor-tui.js --config=my.json
 *   q or Ctrl+C to quit
 *
 * (For a one-shot check with no UI, e.g. for cron/logging, use
 * monitor.js --once instead — this file is interactive-only.)
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const blessed = require('blessed');

// ---------- CLI args ----------
const args = process.argv.slice(2);
const configArg = args.find(a => a.startsWith('--config='));
const configPath = configArg
  ? path.resolve(process.cwd(), configArg.split('=')[1])
  : path.resolve(__dirname, 'config.json');

// ---------- Load config ----------
function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    console.error(`Could not read config file at ${configPath}`);
    console.error(err.message);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Config file is not valid JSON: ${configPath}`);
    console.error(err.message);
    process.exit(1);
  }
}

// ---------- Layered endpoint check (TCP -> HTTP -> status code) ----------
// Identical logic to monitor.js — kept in sync deliberately.

function doHttpCheck(host, port, cfg, start, baseResult, finish) {
  const lib = cfg.useHttps ? https : http;
  const timeoutMs = cfg.timeoutMs || 3000;

  const req = lib.get(
    {
      host,
      port,
      path: cfg.path || '/',
      timeout: timeoutMs,
      rejectUnauthorized: false, // tolerate self-signed certs on monitored boxes
    },
    (res) => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      res.resume(); // drain so the socket closes cleanly
      finish({
        httpOk: true,
        statusCode: res.statusCode,
        ms,
      });
    }
  );

  req.on('timeout', () => {
    req.destroy();
    finish({ reason: 'HTTP timed out (TCP open)' });
  });

  req.on('error', (err) => {
    finish({ reason: `TCP open, no HTTP (${mapErrorReason(err)})` });
  });
}

function mapErrorReason(err) {
  switch (err.code) {
    case 'ECONNREFUSED': return 'connection refused';
    case 'EHOSTUNREACH': return 'host unreachable';
    case 'ENETUNREACH': return 'network unreachable';
    case 'ETIMEDOUT': return 'timed out';
    default: return err.code || 'timed out';
  }
}

function isOnline(r) {
  // TCP-only mode: reachable on the port is "online", no HTTP expected.
  // HTTP mode (default): requires both TCP connect and a real HTTP response —
  // appropriate for web servers, but wrong for non-HTTP services (game
  // servers, raw sockets, etc.) where there's no HTTP to respond with.
  if (r.checkMode === 'tcp') return r.tcpOk;
  return r.tcpOk && r.httpOk;
}

function checkEndpointTracked(endpoint, cfg, state, onUpdate) {
  return new Promise((resolve) => {
    const host = endpoint.host;
    const port = endpoint.port || cfg.port || 80;
    const timeoutMs = cfg.timeoutMs || 3000;
    const checkMode = endpoint.checkMode || cfg.checkMode || 'http';
    const start = process.hrtime.bigint();

    const result = {
      name: endpoint.name,
      host,
      port,
      checkMode,
      tcpOk: false,
      httpOk: false,
      statusCode: null,
      ms: null,
      reason: null,
    };

    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve({ ...result, ...extra });
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      result.tcpOk = true;

      if (checkMode === 'tcp') {
        // TCP-only: a successful connection IS the result. Don't send
        // anything — for non-HTTP services, writing an HTTP request
        // line can confuse the server or get the connection dropped.
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        finish({ ms });
        return;
      }

      state.step = 'TCP ok, requesting HTTP…';
      onUpdate();
      socket.destroy();
      doHttpCheck(host, port, cfg, start, result, finish);
    });

    socket.once('timeout', () => finish({ reason: 'timed out' }));
    socket.once('error', (err) => finish({ reason: mapErrorReason(err) }));
  });
}

function runCycle(cfg, states, onUpdate) {
  for (const s of states) {
    s.status = 'checking';
    s.step = 'connecting…';
    s.result = s.result || {};
  }
  onUpdate();

  const checks = cfg.endpoints.map((ep, i) => {
    const state = states[i];
    return checkEndpointTracked(ep, cfg, state, onUpdate).then((result) => {
      state.status = 'done';
      state.result = result;
      onUpdate();
    });
  });

  return Promise.all(checks);
}

// ---------- Formatting helpers ----------
function pad(str, len) {
  str = String(str);
  const gap = Math.max(2, len - str.length);
  return str + ' '.repeat(gap);
}

// Truncates with an ellipsis so long names/hosts never wrap or
// blow out the fixed-width columns inside a half-screen box.
function truncate(str, maxLen) {
  str = String(str);
  if (str.length <= maxLen) return str;
  return str.slice(0, Math.max(1, maxLen - 1)) + '…';
}

function fmtMs(ms) {
  return `${Math.round(ms)} ms`;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function countdownBar(remainingMs, totalMs, width = 24) {
  const ratio = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ---------- Main ----------
function main() {
  const cfg = loadConfig();

  if (!Array.isArray(cfg.endpoints) || cfg.endpoints.length === 0) {
    console.error('Config has no endpoints. Add some to config.json and try again.');
    process.exit(1);
  }

  const states = cfg.endpoints.map(ep => ({
    name: ep.name,
    host: ep.host,
    status: 'pending', // 'pending' | 'checking' | 'done'
    step: '',
    result: {},
  }));

  // ---------- blessed screen setup ----------
  // Defensive: some constrained/non-standard terminal environments
  // report 0 columns/rows even though isTTY is true. Force a sane
  // minimum so the UI never collapses to an unusable 1x1 box.
  if (!process.stdout.columns || process.stdout.columns < 10) {
    process.stdout.columns = 80;
  }
  if (!process.stdout.rows || process.stdout.rows < 10) {
    process.stdout.rows = 24;
  }

  const screen = blessed.screen({
    smartCSR: true,
    title: 'Uptime Monitor',
    fullUnicode: true,
    dockBorders: true,
  });

  const headerBar = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: { fg: 'white', bg: 'blue' },
    content: ' UPTIME MONITOR',
  });

  const onlineBox = blessed.box({
    parent: screen,
    label: ' ONLINE ',
    top: 1,
    left: 0,
    width: '50%',
    height: '70%-1',
    tags: true,
    wrap: false,
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      label: { fg: 'green', bold: true },
    },
    scrollable: true,
    alwaysScroll: true,
  });

  const offlineBox = blessed.box({
    parent: screen,
    label: ' OFFLINE ',
    top: 1,
    left: '50%',
    width: '50%',
    height: '70%-1',
    tags: true,
    wrap: false,
    border: { type: 'line' },
    style: {
      border: { fg: 'red' },
      label: { fg: 'red', bold: true },
    },
    scrollable: true,
    alwaysScroll: true,
  });

  const checkingBox = blessed.box({
    parent: screen,
    label: ' CHECKING ',
    top: '70%',
    left: 0,
    width: '100%',
    height: '30%-2',
    tags: true,
    wrap: false,
    border: { type: 'line' },
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'yellow', bold: true },
    },
    scrollable: true,
    alwaysScroll: true,
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: { fg: 'white', bg: 'blue' },
  });

  screen.key(['q', 'C-c', 'escape'], () => {
    clearInterval(tickHandle);
    screen.destroy();
    process.exit(0);
  });

  // ---------- Repaint logic ----------
  let frame = 0;
  let nextCheckAt = Date.now();
  let cycleInFlight = false;
  const intervalMs = (cfg.refreshSeconds || 5) * 1000;

  function escapeTags(str) {
    // blessed uses {tag} syntax for styling; escape literal braces
    // from hostnames/reasons so they never get misinterpreted.
    return String(str).replace(/\{/g, '\\{').replace(/\}/g, '\\}');
  }

  function repaint() {
    const done = states.filter(s => s.status === 'done');
    const inFlight = states.filter(s => s.status !== 'done');

    const online = done.filter(s => isOnline(s.result)).sort((a, b) => a.name.localeCompare(b.name));
    const offline = done.filter(s => !isOnline(s.result)).sort((a, b) => a.name.localeCompare(b.name));
    const pending = inFlight.sort((a, b) => a.name.localeCompare(b.name));

    // ONLINE box
    if (online.length === 0) {
      onlineBox.setContent('{grey-fg}  (none yet){/grey-fg}');
    } else {
      const lines = online.map(s => {
        const r = s.result;
        const statusTag = r.statusCode != null ? ` [${r.statusCode}]` : '';
        const name = pad(truncate(escapeTags(s.name), 7), 9);
        const host = pad(truncate(escapeTags(s.host), 9), 11);
        const ms = pad(fmtMs(r.ms), 7);
        return `{green-fg} ${name}${host}${ms}${statusTag}{/green-fg}`;
      });
      onlineBox.setContent(lines.join('\n'));
    }

    // OFFLINE box
    if (offline.length === 0) {
      offlineBox.setContent('{grey-fg}  (none yet){/grey-fg}');
    } else {
      const lines = offline.map(s => {
        const r = s.result;
        let reason = r.reason || 'timed out';
        if (r.statusCode != null && !(r.tcpOk && !r.httpOk)) {
          reason = `HTTP ${r.statusCode}`;
        }
        const name = pad(truncate(escapeTags(s.name), 7), 9);
        const host = pad(truncate(escapeTags(s.host), 9), 11);
        return `{red-fg} ${name}${host}${truncate(escapeTags(reason), 11)}{/red-fg}`;
      });
      offlineBox.setContent(lines.join('\n'));
    }

    // CHECKING box (full width, more room)
    if (pending.length === 0) {
      checkingBox.setContent('{grey-fg}  idle — waiting for next cycle{/grey-fg}');
    } else {
      const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      const lines = pending.map(s => {
        const step = s.status === 'checking' ? (s.step || 'connecting…') : 'queued…';
        const name = pad(escapeTags(s.name), 16);
        const host = pad(escapeTags(s.host), 20);
        return `{yellow-fg} ${spin} ${name}${host}${escapeTags(step)}{/yellow-fg}`;
      });
      checkingBox.setContent(lines.join('\n'));
    }

    // Header: live counts
    headerBar.setContent(
      ` UPTIME MONITOR   {bold}${online.length} online{/bold} / {bold}${offline.length} offline{/bold} / ${pending.length} checking   |   port ${cfg.port}`
    );

    // Footer: countdown + bar + controls
    const remaining = Math.max(0, nextCheckAt - Date.now());
    const secondsLeft = Math.ceil(remaining / 1000);
    const bar = countdownBar(remaining, intervalMs);
    const timestamp = new Date().toLocaleTimeString();
    footer.setContent(
      ` last checked: ${timestamp}   next check in ${secondsLeft}s ${bar}   [q] quit`
    );

    screen.render();
  }

  const tickHandle = setInterval(async () => {
    frame++;

    if (Date.now() >= nextCheckAt && !cycleInFlight) {
      cycleInFlight = true;
      try {
        await runCycle(cfg, states, repaint);
      } finally {
        cycleInFlight = false;
        nextCheckAt = Date.now() + intervalMs;
      }
    }

    repaint();
  }, 150);

  repaint();

  // Test-only: dump periodic screenshots of the rendered screen buffer
  // to disk so behavior can be verified without a real attached terminal.
  if (process.env.MONITOR_TUI_DEBUG_SNAPSHOT) {
    const snapPath = process.env.MONITOR_TUI_DEBUG_SNAPSHOT;
    const delays = (process.env.MONITOR_TUI_DEBUG_DELAY || '3000')
      .split(',').map(Number);

    function takeSnapshot(suffix) {
      try {
        const lines = [];
        for (let y = 0; y < screen.height; y++) {
          let line = '';
          for (let x = 0; x < screen.width; x++) {
            const cell = screen.lines[y] && screen.lines[y][x];
            line += cell ? cell[1] : ' ';
          }
          lines.push(line.replace(/\s+$/, ''));
        }
        fs.writeFileSync(`${snapPath}.${suffix}`, lines.join('\n'));
      } catch (e) {
        fs.writeFileSync(`${snapPath}.${suffix}.error`, String(e.stack || e));
      }
    }

    delays.forEach((d, i) => setTimeout(() => takeSnapshot(i), d));

    setTimeout(() => {
      clearInterval(tickHandle);
      screen.destroy();
      process.exit(0);
    }, Math.max(...delays) + 200);
  }
}

main();
