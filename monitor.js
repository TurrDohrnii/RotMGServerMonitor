#!/usr/bin/env node
/**
 * Uptime Monitor — terminal dashboard
 *
 * Checks a list of endpoints on a fixed port via:
 *   1. TCP connect      (is the port even open?)
 *   2. HTTP(S) request  (does it speak HTTP?)
 *   3. Status code      (what did it respond with?)
 *
 * Renders a live, auto-refreshing ONLINE / OFFLINE dashboard
 * in the same style as the original screenshot.
 *
 * Usage:
 *   node monitor.js                 # uses config.json, live mode
 *   node monitor.js --once          # run a single check and exit
 *   node monitor.js --config=my.json
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');

// ---------- CLI args ----------
const args = process.argv.slice(2);
const onceMode = args.includes('--once');
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

// ---------- Single endpoint check ----------
// Layered result:
//   tcpOk      - did the TCP connection to host:port succeed?
//   httpOk     - did we get a complete HTTP response?
//   statusCode - HTTP status code, if any
//   ms         - latency of whichever step we measured to (HTTP if available, else TCP)
//   reason     - human-readable failure reason when not fully online
//
// (See checkEndpointTracked() further below — it's this same logic,
// plus state.step updates so the live dashboard can show progress.)

function doHttpCheck(host, port, cfg, start, baseResult, finish) {
  const lib = cfg.useHttps ? https : http;
  const timeoutMs = cfg.timeoutMs || 3000;

  const req = lib.get(
    {
      host,
      port,
      path: cfg.path || '/',
      timeout: timeoutMs,
      // Many monitored boxes use self-signed certs; ignore TLS errors
      // for reachability purposes if useHttps is on.
      rejectUnauthorized: false,
    },
    (res) => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      // Drain response so the socket closes cleanly
      res.resume();
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

// ---------- Status classification ----------
// TCP-only mode: reachable on the port is "online", no HTTP expected.
// HTTP mode (default): requires both TCP connect and a real HTTP response —
// appropriate for web servers, but wrong for non-HTTP services (game
// servers, raw sockets, etc.) where there's no HTTP to respond with.
function isOnline(r) {
  if (r.checkMode === 'tcp') return r.tcpOk;
  return r.tcpOk && r.httpOk;
}

// ---------- ANSI helpers ----------
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};
const useColor = process.stdout.isTTY !== false;
function color(text, code) {
  if (!useColor) return text;
  return `${code}${text}${ANSI.reset}`;
}

// Braille spinner — reads as "actively working" without being silly. UwU
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ---------- Rendering ----------
const DIVIDER = '-'.repeat(56);

function pad(str, len) {
  str = String(str);
  const gap = Math.max(2, len - str.length);
  return str + ' '.repeat(gap);
}

function fmtMs(ms) {
  return `${Math.round(ms)} ms`;
}

// Builds a "[####------]" style progress bar counting DOWN
// to the next check cycle (full -> empty as time elapses).
function countdownBar(remainingMs, totalMs, width = 20) {
  const ratio = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
  const filled = Math.round(ratio * width);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  return `[${bar}]`;
}

// state.status per endpoint: 'pending' | 'checking' | 'done'
function render(states, cfg, frame, remainingMs, intervalMs) {
  const done = states.filter(s => s.status === 'done');
  const inFlight = states.filter(s => s.status !== 'done');

  const online = done.filter(s => isOnline(s.result)).sort((a, b) => a.name.localeCompare(b.name));
  const offline = done.filter(s => !isOnline(s.result)).sort((a, b) => a.name.localeCompare(b.name));
  const pending = inFlight.sort((a, b) => a.name.localeCompare(b.name));

  const lines = [];

  lines.push(color('ONLINE', ANSI.bold));
  lines.push(DIVIDER);
  lines.push('');
  if (online.length === 0) {
    lines.push(color('  (none yet)', ANSI.gray));
  }
  for (const s of online) {
    const r = s.result;
    const statusTag = r.statusCode != null ? `  [${r.statusCode}]` : '';
    const row = `  ${pad(s.name, 14)}${pad(s.host, 18)}${pad(fmtMs(r.ms), 10)}${statusTag}`;
    lines.push(color(row, ANSI.green));
  }
  lines.push('');

  lines.push(color('OFFLINE', ANSI.bold));
  lines.push(DIVIDER);
  lines.push('');
  if (offline.length === 0) {
    lines.push(color('  (none yet)', ANSI.gray));
  }
  for (const s of offline) {
    const r = s.result;
    let reason = r.reason || 'timed out';
    if (r.tcpOk && !r.httpOk) {
      // already descriptive
    } else if (r.statusCode != null) {
      reason = `HTTP ${r.statusCode}`;
    }
    const row = `  ${pad(s.name, 14)}${pad(s.host, 18)}${pad(reason, 24)}`;
    lines.push(color(row, ANSI.red));
  }

  // In-flight checks get their own visible section so you can watch
  // each connection attempt resolve in real time.
  if (pending.length > 0) {
    lines.push('');
    lines.push(color('CHECKING', ANSI.bold));
    lines.push(DIVIDER);
    lines.push('');
    for (const s of pending) {
      const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      const step = s.status === 'checking' ? (s.step || 'connecting…') : 'queued…';
      const row = `  ${spin} ${pad(s.name, 14)}${pad(s.host, 18)}${step}`;
      lines.push(color(row, ANSI.yellow));
    }
  }

  lines.push('');
  lines.push(DIVIDER);

  const timestamp = new Date().toLocaleTimeString();
  const secondsLeft = Math.ceil(remainingMs / 1000);
  const bar = countdownBar(remainingMs, intervalMs);
  const summary = `${online.length} online, ${offline.length} offline`;

  lines.push(
    color(`  last checked: ${timestamp}   ${summary}`, ANSI.dim)
  );
  lines.push(
    `  next check in ${color(`${secondsLeft}s`, ANSI.cyan)} ${color(bar, ANSI.cyan)}   port ${cfg.port}   ${color('ctrl+c to quit', ANSI.gray)}`
  );

  return lines.join('\n');
}

// ---------- Main run loop ----------

// Runs one full check cycle. Calls onUpdate() every time any
// individual endpoint's state changes, so the caller can repaint
// live as each connection attempt resolves — not just at the end.
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

// Same layered TCP -> HTTP check as before, but updates `state.step`
// at each phase so the UI can show "connecting…" -> "TCP ok, requesting…"
// before the final result lands. In "tcp" checkMode, stops after the
// TCP connect succeeds — no HTTP request is sent at all.
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

async function main() {
  const cfg = loadConfig();

  if (!Array.isArray(cfg.endpoints) || cfg.endpoints.length === 0) {
    console.error('Config has no endpoints. Add some to config.json and try again.');
    process.exit(1);
  }

  const states = cfg.endpoints.map(ep => ({
    name: ep.name,
    host: ep.host,
    status: 'pending',
    step: '',
    result: {},
  }));

  if (onceMode) {
    await runCycle(cfg, states, () => {});
    console.log(render(states, cfg, 0, 0, 1));
    return;
  }

  // ---------- Live mode ----------
  const intervalMs = (cfg.refreshSeconds || 5) * 1000;
  let running = true;
  let frame = 0;
  let nextCheckAt = Date.now(); // run immediately on start
  let cycleInFlight = false;

  process.stdout.write('\x1b[?25l'); // hide cursor

  function repaint() {
    const remaining = Math.max(0, nextCheckAt - Date.now());
    process.stdout.write('\x1b[2J\x1b[H'); // clear + home
    process.stdout.write(render(states, cfg, frame, remaining, intervalMs) + '\n');
  }

  // Fast tick: drives the spinner animation and the countdown bar
  // smoothly, independent of how long checks themselves take.
  const tickHandle = setInterval(async () => {
    if (!running) return;
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

  process.on('SIGINT', () => {
    running = false;
    clearInterval(tickHandle);
    process.stdout.write('\x1b[?25h'); // show cursor again
    console.log('\nStopped.');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
