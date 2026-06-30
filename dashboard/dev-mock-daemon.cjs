/*
 * Dev-only mock of the M5 control plane for previewing the dashboard with rich, representative data.
 *
 * The real `serve` daemon in its default (stub) mode runs the golden path with no activity stream and
 * no back-edges, so it can't exercise the design (varied statuses, escalations, back-edge arcs, the
 * live "model thinking" feed). This tiny server speaks the same HTTP/SSE surface the dashboard is a
 * pure client of — GET /config, /runs, /runs/:id, /health and the SSE /stream — and also serves the
 * built SPA from dashboard/dist, so one `node dev-mock-daemon.cjs` shows the whole UI populated.
 *
 * NOT shipped / NOT wired into the app. Uses only absolute paths (never process.cwd()) so it runs
 * under the sandboxed preview spawner. Delete once a real seeded daemon or fixtures exist.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = path.dirname(__filename); // dashboard/
const DIST = path.join(DIR, 'dist');
const PORT = Number(process.env.PORT || 4319);

// --- config (reuse the real default FSM so stages/back-edges match production) ---
const raw = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'src', 'fsm', 'default-config.json'), 'utf8'));
const { agents, ...fsm } = raw;
const CONFIG = { fsm, agents, version: 'v3' };
const FORWARD = fsm.forwardOrder.filter((s) => !fsm.states[s]?.terminal);

// --- runs -----------------------------------------------------------------------
let nextId = 320;
const RUNS = [
  mk(318, 'acme/web', 'frontend', 'running', 84200, 1.83, { branch: 'af/318-checkout-fix' }),
  mk(290, 'acme/api', 'tdd', 'running', 22100, 0.49, { branch: 'af/290-cursor' }),
  mk(277, 'acme/web', 'backend', 'running', 41200, 0.92, { branch: 'af/277-webhooks' }),
  mk(256, 'acme/web', 'plan_review', 'running', 15300, 0.34, { branch: 'af/256-a11y' }),
  mk(205, 'acme/api', 'code_review', 'paused', 51000, 1.12, { branch: 'af/205-rate-limit', pr: 207 }),
  mk(312, 'acme/web', 'plan', 'awaiting_input', 33400, 0.74, { branch: 'af/312-rounding' }),
  mk(301, 'acme/web', 'needs_human', 'needs_human', 47600, 1.05, { branch: 'af/301-mobile-nav', reached: 'code_review' }),
  mk(88, 'acme/infra', 'done', 'done', 120000, 2.41, { branch: 'af/88-tls', pr: 90 }),
  mk(84, 'acme/infra', 'done', 'done', 96000, 1.88, { branch: 'af/84-imagebump', pr: 86 }),
  mk(79, 'acme/web', 'done', 'done', 71000, 1.42, { branch: 'af/79-darkmode', pr: 81 }),
  mk(70, 'acme/api', 'done', 'done', 64000, 1.27, { branch: 'af/70-pagination', pr: 72 }),
  mk(66, 'acme/web', 'frontend', 'stopped', 18000, 0.39, { branch: 'af/66-banner' }),
  mk(61, 'acme/docs', 'done', 'done', 41000, 0.81, { branch: 'af/61-webhooks-doc', pr: 63 }),
  mk(54, 'acme/docs', 'tdd', 'stopped', 12100, 0.28, { branch: 'af/54-retry-doc' }),
];

function mk(issue, repo, currentState, status, tokens, cost, extra = {}) {
  return {
    id: issue,
    issueRef: `${repo}#${issue}`,
    repoRef: repo,
    currentState,
    status,
    fsmConfigVersion: 'v3',
    prNumber: extra.pr ?? null,
    branch: extra.branch ?? null,
    tokensUsed: tokens,
    costUsed: cost,
    agentRunsCount: 0, // filled from detail below
    flags: {},
    createdAt: new Date(Date.now() - issue * 60000).toISOString(),
    updatedAt: new Date().toISOString(),
    _reached: extra.reached,
  };
}

// --- detail generation ----------------------------------------------------------
function visitedPath(run) {
  const target = run._reached || (run.status === 'done' ? 'done' : run.currentState);
  const idx = FORWARD.indexOf(target);
  const upto = idx === -1 ? FORWARD.length : idx + (run.status === 'done' ? 0 : 0);
  return FORWARD.slice(0, Math.max(1, run.status === 'done' ? FORWARD.length : idx + 1));
}

function detailFor(run) {
  // featured run 318: a code_review → frontend back-edge so the stepper draws a return arc
  if (run.id === 318) return featured318(run);
  if (run.id === 301) return escalated301(run);

  const path0 = visitedPath(run);
  const transitions = [{ id: 1, fromState: '—', toState: 'triage', trigger: 'start', reason: null, backEdge: false, createdAt: '' }];
  for (let i = 0; i < path0.length - 1; i++) {
    transitions.push({ id: i + 2, fromState: path0[i], toState: path0[i + 1], trigger: 'proceed', reason: null, backEdge: false, createdAt: '' });
  }
  if (run.status === 'stopped') {
    transitions.push({ id: 99, fromState: run.currentState, toState: 'stopped', trigger: 'stop', reason: 'stopped by operator', backEdge: false, createdAt: '' });
  }
  const agentRuns = [];
  path0.forEach((stage, i) => {
    const n = stage === 'frontend' || stage === 'backend' || stage === 'tdd' ? 2 : 1;
    for (let k = 0; k < n; k++) agentRuns.push({ stage, phase: 'produce', model: 'claude-opus-4-8', tokens: Math.round((run.tokensUsed / (path0.length + 2)) * (0.7 + k * 0.3)), durationMs: 18000 + i * 9000 + k * 12000, success: true });
  });
  run.agentRunsCount = agentRuns.length;
  const artifacts = [{ kind: 'branch', locator: run.branch }];
  if (run.prNumber) artifacts.push({ kind: 'pr', locator: { url: `https://github.com/${run.repoRef}/pull/${run.prNumber}` } });
  artifacts.push({ kind: 'diff', locator: `${2 + (run.id % 6)} files · +${40 + (run.id % 200)} −${run.id % 40}` });
  const logs = [
    { level: 'info', message: `Entered \`${run.currentState}\` stage`, data: { stage: run.currentState } },
    { level: 'info', message: `Working on ${run.issueRef}`, data: { stage: run.currentState } },
  ];
  if (run.status === 'stopped') logs.push({ level: 'warn', message: 'Run **stopped** by operator', data: { stage: run.currentState } });
  return { run, transitions, agentRuns, artifacts, logs };
}

function featured318(run) {
  const transitions = [
    { id: 1, fromState: '—', toState: 'triage', trigger: 'start', reason: null, backEdge: false, createdAt: '' },
    { id: 2, fromState: 'triage', toState: 'plan', trigger: 'proceed', reason: null, backEdge: false, createdAt: '' },
    { id: 3, fromState: 'plan', toState: 'plan_review', trigger: 'proceed', reason: null, backEdge: false, createdAt: '' },
    { id: 4, fromState: 'plan_review', toState: 'interface_design', trigger: 'approve', reason: null, backEdge: false, createdAt: '' },
    { id: 5, fromState: 'interface_design', toState: 'tdd', trigger: 'proceed', reason: null, backEdge: false, createdAt: '' },
    { id: 6, fromState: 'tdd', toState: 'frontend', trigger: 'proceed', reason: null, backEdge: false, createdAt: '' },
    { id: 7, fromState: 'frontend', toState: 'code_review', trigger: 'proceed', reason: null, backEdge: false, createdAt: '' },
    { id: 8, fromState: 'code_review', toState: 'frontend', trigger: 'request_changes', reason: 'token refresh races a concurrent request — 2 cases failing', backEdge: true, createdAt: '' },
  ];
  const agentRuns = [
    { stage: 'triage', phase: 'produce', model: 'claude-opus-4-8', tokens: 6200, durationMs: 14000, success: true },
    { stage: 'plan', phase: 'produce', model: 'claude-opus-4-8', tokens: 12400, durationMs: 26000, success: true },
    { stage: 'plan_review', phase: 'produce', model: 'claude-opus-4-8', tokens: 6000, durationMs: 15000, success: true },
    { stage: 'interface_design', phase: 'produce', model: 'claude-opus-4-8', tokens: 9000, durationMs: 22000, success: true },
    { stage: 'tdd', phase: 'produce', model: 'claude-opus-4-8', tokens: 14000, durationMs: 41000, success: true },
    { stage: 'frontend', phase: 'produce', model: 'claude-opus-4-8', tokens: 21600, durationMs: 78000, success: true },
    { stage: 'frontend', phase: 'self_review', model: 'claude-opus-4-8', tokens: 8000, durationMs: 26000, success: true },
    { stage: 'code_review', phase: 'produce', model: 'claude-opus-4-8', tokens: 7000, durationMs: 19000, success: true },
  ];
  run.agentRunsCount = agentRuns.length;
  const artifacts = [
    { kind: 'branch', locator: run.branch },
    { kind: 'diff', locator: '7 files · +218 −64' },
    { kind: 'tests', locator: '28 passed · 0 failed' },
    { kind: 'pr', locator: 'pending — opens at integrate' },
  ];
  const logs = [
    { level: 'info', message: 'Editing `src/checkout/session.ts`', data: { stage: 'frontend' } },
    { level: 'warn', message: '2 tests failing — routing **back to planner**', data: { stage: 'code_review' } },
    { level: 'info', message: 'Revised plan: split refresh into an **idempotent step**', data: { stage: 'frontend' } },
    { level: 'info', message: 'Running suite `vitest · 28 cases`', data: { stage: 'frontend' } },
    { level: 'info', message: 'All tests **passing** — preparing review handoff', data: { stage: 'frontend' } },
  ];
  return { run, transitions, agentRuns, artifacts, logs };
}

function escalated301(run) {
  const transitions = [
    { id: 1, fromState: '—', toState: 'triage', trigger: 'start', reason: null, backEdge: false, createdAt: '' },
    { id: 2, fromState: 'triage', toState: 'plan', trigger: 'proceed', reason: null, backEdge: false, createdAt: '' },
    { id: 3, fromState: 'plan', toState: 'plan_review', trigger: 'proceed', reason: null, backEdge: false, createdAt: '' },
    { id: 4, fromState: 'plan_review', toState: 'interface_design', trigger: 'approve', reason: null, backEdge: false, createdAt: '' },
    { id: 5, fromState: 'interface_design', toState: 'tdd', trigger: 'proceed', reason: null, backEdge: false, createdAt: '' },
    { id: 6, fromState: 'tdd', toState: 'frontend', trigger: 'proceed', reason: null, backEdge: false, createdAt: '' },
    { id: 7, fromState: 'frontend', toState: 'code_review', trigger: 'proceed', reason: null, backEdge: false, createdAt: '' },
    { id: 8, fromState: 'code_review', toState: 'frontend', trigger: 'request_changes', reason: 'layout regressions persist', backEdge: true, createdAt: '' },
    { id: 9, fromState: 'code_review', toState: 'needs_human', trigger: 'escalate', reason: 'exceeded revise limit (3)', backEdge: false, createdAt: '' },
  ];
  const agentRuns = ['triage', 'plan', 'plan_review', 'interface_design', 'tdd', 'frontend', 'frontend', 'code_review', 'code_review'].map((stage, i) => ({
    stage, phase: 'produce', model: 'claude-opus-4-8', tokens: 4000 + i * 900, durationMs: 14000 + i * 7000, success: true,
  }));
  run.agentRunsCount = agentRuns.length;
  const artifacts = [
    { kind: 'branch', locator: run.branch },
    { kind: 'diff', locator: '5 files · +131 −88' },
    { kind: 'tests', locator: '3 failed · 19 passed' },
  ];
  const logs = [
    { level: 'warn', message: 'Visual diff still failing on `iPhone SE`', data: { stage: 'code_review' } },
    { level: 'warn', message: 'Revise budget exhausted (3 / 3)', data: { stage: 'code_review' } },
    { level: 'error', message: '**Escalated** — needs human', data: { stage: 'code_review' } },
  ];
  return { run, transitions, agentRuns, artifacts, logs };
}

// pre-compute agentRunsCount for the list payload
RUNS.forEach((r) => detailFor(r));

// --- live activity stream (drives the "model thinking" box for the running run) ---
const THINK = [
  'reading failing assertion in `session.test.ts:48`',
  'refresh races a concurrent request — needs a guard',
  'wrapping refresh in a single-flight promise',
  'checking callers of `getSession()` … 6 references',
  'editing `src/checkout/session.ts` (+18 −6)',
  'edge case: a rejected refresh must clear the cache',
  'adding test: concurrent expiry triggers one refresh',
  'running `vitest src/checkout/session.test.ts`',
  '**28 passing** — no regressions in cart flow',
  'summarizing the change for review handoff',
];
const sseClients = new Set();
let tick = 0;
setInterval(() => {
  const [t] = [THINK[tick % THINK.length]];
  tick++;
  const payload = JSON.stringify({ activity: { runId: 318, stage: 'frontend', activity: { summary: t } } });
  for (const res of sseClients) {
    try {
      res.write(`event: activity\ndata: ${payload}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}, 1600);

// --- http -----------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/health') return json(res, 200, { ok: true });
  if (url === '/config' && req.method === 'GET') return json(res, 200, CONFIG);
  if (url === '/runs' && req.method === 'GET') return json(res, 200, RUNS.map(strip));
  if (url === '/runs' && req.method === 'POST') {
    const r = mk(nextId, 'acme/web', 'triage', 'running', 0, 0, { branch: `af/${nextId}-new` });
    nextId++;
    RUNS.unshift(r);
    detailFor(r);
    return json(res, 201, strip(r));
  }
  const m = url.match(/^\/runs\/(\d+)$/);
  if (m && req.method === 'GET') {
    const r = RUNS.find((x) => x.id === Number(m[1]));
    if (!r) return json(res, 404, { error: 'not found' });
    const d = detailFor(r);
    return json(res, 200, { run: strip(r), transitions: d.transitions, agentRuns: d.agentRuns, artifacts: d.artifacts, logs: d.logs });
  }
  // run-control endpoints — accept and echo so the buttons feel live in the preview
  const ctl = url.match(/^\/runs\/(\d+)\/(pause|resume|stop|revert)$/);
  if (ctl && req.method === 'POST') {
    const r = RUNS.find((x) => x.id === Number(ctl[1]));
    if (!r) return json(res, 404, { error: 'not found' });
    if (ctl[2] === 'pause') r.status = 'paused';
    else if (ctl[2] === 'resume') r.status = 'running';
    else if (ctl[2] === 'stop') r.status = 'stopped';
    return json(res, 200, strip(r));
  }

  if (url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // static SPA
  let p = path.normalize(path.join(DIST, url === '/' ? 'index.html' : url));
  if (!p.startsWith(DIST)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(p, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(DIST, 'index.html'), (e2, html) => {
        if (e2) {
          res.writeHead(404);
          return res.end('not found — run `npm run build:dashboard`');
        }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});

function strip(r) {
  const { _reached, ...rest } = r;
  return rest;
}

server.listen(PORT, '127.0.0.1', () => console.log(`dev mock daemon → http://127.0.0.1:${PORT}/  (serving dashboard/dist + mock API)`));
