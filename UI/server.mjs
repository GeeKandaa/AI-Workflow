#!/usr/bin/env node
// Plan UI server: node server.mjs [--port 4317] [--host 127.0.0.1] [--data <dir>]
// Serves the web UI, reads workspaces through their plan.mjs, runs human gates, and streams headless phase runs.
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as C from './lib/config.mjs';
import * as W from './lib/workspace.mjs';
import * as R from './lib/runs.mjs';
import { Router, sendJson, readJson, serveStatic, sse } from './lib/http.mjs';

const PUBLIC = path.join(C.UI_ROOT, 'public');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// --- live status per workspace ------------------------------------------------------------------------------------

const watched = new Map(); // wsId -> { listeners:Set, stop(), timer, last }

async function snapshot(ws) {
  const [status, archived] = await Promise.all([W.status(ws), Promise.resolve(W.archived(ws))]);
  return { status, archived, runs: R.activeRuns().filter((r) => r.workspaceId === ws.id) };
}

function subscribeStatus(ws, send) {
  let w = watched.get(ws.id);
  if (!w) {
    w = { listeners: new Set(), last: null, busy: false, again: false };
    const refresh = async () => {
      if (w.busy) { w.again = true; return; }
      w.busy = true;
      try {
        const snap = await snapshot(ws);
        const hash = crypto.createHash('sha1').update(JSON.stringify(snap)).digest('hex');
        if (hash !== w.last) { w.last = hash; for (const fn of w.listeners) fn('status', snap); }
      } catch (e) { for (const fn of w.listeners) fn('status-error', { message: e.message }); }
      w.busy = false;
      if (w.again) { w.again = false; refresh(); }
    };
    w.refresh = refresh;
    w.stopWatch = W.watchPlans(ws, refresh);
    w.timer = setInterval(refresh, C.loadConfig().pollSeconds * 1000);
    watched.set(ws.id, w);
  }
  w.listeners.add(send);
  w.last = null; // make the new subscriber receive the current state
  w.refresh();
  return () => {
    w.listeners.delete(send);
    if (!w.listeners.size) { clearInterval(w.timer); w.stopWatch(); watched.delete(ws.id); }
  };
}

R.events.on('run', (meta) => {
  const w = watched.get(meta.workspaceId);
  if (!w) return;
  for (const fn of w.listeners) fn('run', meta);
  w.refresh();
});

/**
 * Added to every run in a workspace: read-only `git -C <worktree> …` rules for its worktrees, and the workspace's
 * own allow rules (its build and test commands, allowed from a run page or the Workspaces page).
 */
async function worktreeTools(ws) {
  let git = [];
  try { git = C.worktreeGitRules(Object.keys((await W.status(ws)).worktrees || {}), ws.path); } catch {}
  return [...git, ...(ws.allowedTools || [])];
}
const startRun = async (ws, opts) => R.start(ws, { ...opts, extraTools: await worktreeTools(ws) });

// --- routes -------------------------------------------------------------------------------------------------------

const api = new Router();

api.add('GET', '/api/config', () => {
  const cfg = C.loadConfig();
  return { ...cfg, gates: W.GATES, dataDir: C.DATA_DIR };
});
api.add('PUT', '/api/config', async (req) => C.updateSettings(await readJson(req)));
api.add('POST', '/api/phases/:phase/allow', async (req, p) => {
  const cfg = C.allowForPhase(p.phase, (await readJson(req)).rules);
  return { phase: p.phase, allowedTools: cfg.phases[p.phase].allowedTools };
});
api.add('GET', '/api/health', (req, p, url) => R.claudeHealth(C.loadConfig(), { fresh: url.searchParams.has('fresh') }));

api.add('POST', '/api/workspaces', async (req) => { const b = await readJson(req); return C.addWorkspace(b.path, b.name); });
api.add('POST', '/api/workspaces/:id/allow', async (req, p) => ({ allowedTools: C.setWorkspaceRules(p.id, (await readJson(req)).rules, 'add') }));
api.add('PUT', '/api/workspaces/:id/allow', async (req, p) => ({ allowedTools: C.setWorkspaceRules(p.id, (await readJson(req)).rules, 'replace') }));
api.add('DELETE', '/api/workspaces/:id', (req, p) => { C.removeWorkspace(p.id); return { ok: true }; });

api.add('GET', '/api/ws/:id/status', async (req, p) => snapshot(C.getWorkspace(p.id)));
api.add('GET', '/api/ws/:id/plans/:name', (req, p) => W.readPlan(C.getWorkspace(p.id), p.name));

api.add('POST', '/api/ws/:id/plans/:name/gate', async (req, p) => {
  const ws = C.getWorkspace(p.id); const b = await readJson(req);
  const result = await W.gate(ws, p.name, b.action, b);
  if (result.ok && result.next && b.runNext) result.run = await startRun(ws, { phase: result.next, plan: result.nextPlan || p.name });
  watched.get(ws.id)?.refresh();
  return result;
});

api.add('GET', '/api/ws/:id/runs', (req, p, url) => R.list(C.getWorkspace(p.id).id, { plan: url.searchParams.get('plan') }));
api.add('POST', '/api/ws/:id/runs', async (req, p) => {
  const ws = C.getWorkspace(p.id); const b = await readJson(req);
  return startRun(ws, { phase: b.phase, plan: b.plan || null, description: b.description || null, instructions: b.instructions || null });
});
api.add('POST', '/api/ws/:id/runs/:run/reply', async (req, p) => {
  const ws = C.getWorkspace(p.id); const b = await readJson(req);
  return R.reply(ws, p.run, { text: b.text, extraTools: await worktreeTools(ws) });
});
api.add('GET', '/api/ws/:id/runs/:run', (req, p) => R.getMeta(C.getWorkspace(p.id).id, p.run));
api.add('POST', '/api/ws/:id/runs/:run/stop', (req, p) => { R.getMeta(C.getWorkspace(p.id).id, p.run); R.stop(p.run); return { ok: true }; });

// Streams (handled separately: they keep the response open).
const streams = new Router();
streams.add('GET', '/api/ws/:id/events', (req, res, p) => {
  const ws = C.getWorkspace(p.id);
  const s = sse(req, res);
  s.onClose(subscribeStatus(ws, (event, data) => s.send(event, data)));
});
streams.add('GET', '/api/ws/:id/runs/:run/events', (req, res, p) => {
  const ws = C.getWorkspace(p.id);
  R.getMeta(ws.id, p.run);
  const s = sse(req, res);
  s.onClose(R.follow(ws.id, p.run, (ev) => (ev ? s.send('event', ev) : (s.send('end', {}), s.close()))));
});

// --- server -------------------------------------------------------------------------------------------------------

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      // Only local pages may talk to this server: check Host (DNS rebinding) and, for writes, a custom header
      // that a cross-site form or image cannot send without a CORS preflight, which this server never grants.
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!LOCAL_HOSTS.has(host)) return sendJson(res, 403, { error: 'Forbidden host.' });
      if (req.method !== 'GET' && req.headers['x-plan-ui'] !== '1') return sendJson(res, 403, { error: 'Missing X-Plan-UI header.' });

      if (url.pathname.startsWith('/api/')) {
        const s = streams.match(req.method, url.pathname);
        if (s) return s.handler(req, res, s.params);
        const m = api.match(req.method, url.pathname);
        if (!m) return sendJson(res, 404, { error: 'Not found.' });
        const out = await m.handler(req, m.params, url);
        return sendJson(res, 200, out ?? {});
      }
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      if (!serveStatic(res, PUBLIC, rel)) serveStatic(res, PUBLIC, 'index.html') || sendJson(res, 404, { error: 'Not found.' });
    } catch (e) {
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
      else res.end();
    }
  });
}

function parseArgs(argv) {
  const o = { port: 4317, host: '127.0.0.1', data: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') o.port = Number(argv[++i]);
    else if (argv[i] === '--host') o.host = argv[++i];
    else if (argv[i] === '--data') o.data = argv[++i];
    else if (argv[i] === '--help') { console.log('node server.mjs [--port 4317] [--host 127.0.0.1] [--data <dir>]'); process.exit(0); }
  }
  return o;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = parseArgs(process.argv.slice(2));
  if (o.data) C.setDataDir(o.data);
  if (!LOCAL_HOSTS.has(o.host) && o.host !== '::1') console.warn(`Warning: listening on ${o.host}; requests are still only accepted with a local Host header.`);
  const n = R.markInterrupted();
  if (n) console.log(`Marked ${n} run(s) left over from a previous server as interrupted.`);
  const srv = createServer();
  srv.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${o.port} is already in use. Is the UI already running? Use --port <n> to pick another.` : e.message);
    process.exit(1);
  });
  srv.listen(o.port, o.host, () => {
    console.log(`Plan UI: http://${o.host === '127.0.0.1' ? 'localhost' : o.host}:${o.port}  (data: ${C.DATA_DIR})`);
    R.claudeHealth().then((h) => console.log(h.ok ? `Claude Code ${h.version}: ready.` : `Warning: ${h.error}`));
  });
}
