# Uptime Monitor
A Node.js app that checks a list of RotMG endpoints and shows
them as ONLINE / OFFLINE.

## Two ways to run it:
`monitor-tui.js` — Fixed terminal UI (recommended, looks nicer). 
`monitor.js` — Original plain-text version. No dependencies

## Setup
```bash
git clone
```
Install the one dependency (only needed for the TUI version):
```bash
npm install
```

`port` — default port for all endpoints (override per-endpoint with `"port": ...` on that entry)
`checkMode` — `"tcp"` or `"http"`, see above (also overridable per-endpoint)
`path` — the HTTP path to request, only used in `http` mode, e.g. `/health`
`useHttps` — set `true` if your endpoints serve HTTPS, only used in `http` mode (self-signed certs are tolerated)
`timeoutMs` — how long to wait before marking an endpoint as timed out
`refreshSeconds` — how often the dashboard re-checks everything

Running the TUI dashboard (recommended)
```bash
node monitor-tui.js
or: npm start
```
Press q, Esc, or Ctrl+C to quit.
