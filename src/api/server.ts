/**
 * HTTP + SSE server (Layer 6 transport — README §3.3 / Milestone 5).
 *
 * A thin adapter over the {@link Orchestrator}: parse a request, call one orchestrator method,
 * serialize the result. No orchestration logic lives here (README §3.1 — the engine is independent
 * of the UI), so the dashboard (M6) and any other client are pure consumers of this surface.
 *
 * Built on Node's built-in `http` — no web framework — to keep the dependency surface tiny (KISS).
 * The live stream is **SSE**, not WebSocket: updates only flow server→client, so SSE is the simpler
 * fit (no extra library, browser `EventSource` auto-reconnects); README §3.3 Layer 6 allows either.
 *
 * Routes (plans/milestone-5.md §3; /repos is Milestone 8 Phase A):
 *   POST /runs[?...]            GET /runs[?status=&repo=]   GET /runs/:id
 *   POST /runs/:id/pause        POST /runs/:id/resume
 *   POST /runs/:id/stop         POST /runs/:id/revert
 *   POST /runs/:id/archive      POST /runs/:id/unarchive
 *   POST /runs/:id/cost-override POST /runs/:id/model
 *   POST /runs/:id/check-pr-feedback
 *   GET  /repos                 POST /repos
 *   GET  /config                PUT /config
 *   GET  /models                GET /suggestions[?q=]
 *   GET  /stream[?runId=&repo=] GET /health
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { ApiError, type Orchestrator } from './orchestrator';
import { serveStatic } from './static';
import type { RunStatus } from '../store/repository';
import type { StreamEvent } from './stream';

/** Heartbeat so idle SSE connections aren't dropped by intermediaries (a bare comment line). */
const SSE_HEARTBEAT_MS = 25_000;

/**
 * The built dashboard assets (Layer 7) — the output of `npm run build:dashboard`. Resolved from this
 * module so it works under `tsx`. Built on demand and gitignored; the daemon warns if it is missing.
 */
export const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../../dashboard/dist/', import.meta.url));

export interface ApiServerOptions {
  /** Directory the dashboard's static assets are served from. Defaults to the bundled `public/`. */
  publicDir?: string;
}

/** Build the daemon's HTTP server. The caller decides when/where to `listen` (port 0 in tests). */
export function createApiServer(orchestrator: Orchestrator, options: ApiServerOptions = {}): Server {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  return createServer((req, res) => {
    handle(orchestrator, req, res, publicDir).catch((err) => sendError(res, err));
  });
}

async function handle(orch: Orchestrator, req: IncomingMessage, res: ServerResponse, publicDir: string): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // --- stream (long-lived; handled before the JSON routes) ---
  if (method === 'GET' && path === '/stream') {
    streamSse(orch, req, res, url);
    return;
  }

  if (method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true });

  // --- fleet cost status: the global ceiling (or null) + current active spend (Milestone 8 B3) ---
  if (method === 'GET' && path === '/cost') return sendJson(res, 200, orch.costStatus());

  // --- harness model catalog: selectable models + the daemon default (the model dropdown) ---
  if (method === 'GET' && path === '/models') return sendJson(res, 200, orch.getModels());

  // --- new-run autocomplete: your repos + their open issues matching ?q= (README §3.3 Layer 7) ---
  if (method === 'GET' && path === '/suggestions') {
    return sendJson(res, 200, await orch.suggestIssues(url.searchParams.get('q') ?? ''));
  }

  // --- repos (Milestone 8 Phase A: enroll a repo the fleet can run / list enrolled repos) ---
  if (path === '/repos') {
    if (method === 'GET') return sendJson(res, 200, orch.listRepos());
    if (method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 201, orch.enrollRepo({
        repoRef: str(body, 'repoRef'),
        workingRoot: optStr(body, 'workingRoot'),
        baseBranch: optStr(body, 'baseBranch'),
        cloneUrl: optStr(body, 'cloneUrl'),
        localRepo: optStr(body, 'localRepo'),
      }));
    }
    return sendError(res, new ApiError(405, `method ${method} not allowed on /repos`));
  }

  // --- runs ---
  if (path === '/runs') {
    if (method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined;
      const repo = url.searchParams.get('repo') ?? undefined;
      return sendJson(res, 200, orch.listRuns({ status: status as RunStatus | undefined, repo }));
    }
    if (method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 201, orch.start({ issueRef: str(body, 'issueRef'), repoRef: optStr(body, 'repoRef') }));
    }
    return sendError(res, new ApiError(405, `method ${method} not allowed on /runs`));
  }

  const runMatch = /^\/runs\/(\d+)$/.exec(path);
  if (runMatch && method === 'GET') return sendJson(res, 200, orch.getRunDetail(Number(runMatch[1])));

  const actionMatch = /^\/runs\/(\d+)\/(pause|resume|stop|revert|archive|unarchive|cost-override|model)$/.exec(path);
  if (actionMatch && method === 'POST') {
    const id = Number(actionMatch[1]);
    switch (actionMatch[2]) {
      case 'pause':
        return sendJson(res, 200, orch.pause(id));
      case 'resume':
        return sendJson(res, 200, orch.resume(id));
      case 'stop':
        return sendJson(res, 200, orch.stop(id));
      case 'archive':
        return sendJson(res, 200, orch.archive(id));
      case 'unarchive':
        return sendJson(res, 200, orch.unarchive(id));
      case 'revert': {
        const body = await readJson(req);
        return sendJson(res, 200, orch.revert(id, str(body, 'toState'), body.reason));
      }
      case 'cost-override': {
        // `mode`: 'next_step' | 'full' to let the run cross the global cost ceiling, or 'none' to clear (M8 B3).
        const raw = str(await readJson(req), 'mode');
        if (raw !== 'next_step' && raw !== 'full' && raw !== 'none') {
          return sendError(res, new ApiError(400, `invalid cost-override mode "${raw}" (expected next_step | full | none)`));
        }
        return sendJson(res, 200, orch.overrideCost(id, raw === 'none' ? null : raw));
      }
      case 'model': {
        // `model`: a harness model tag to run this run under, or `null` to clear back to the daemon default.
        const raw = (await readJson(req)).model;
        if (raw !== null && typeof raw !== 'string') {
          return sendError(res, new ApiError(400, '"model" (string, or null to clear) is required'));
        }
        return sendJson(res, 200, orch.setModel(id, raw));
      }
    }
  }

  // --- on-demand PR-feedback check: poll one run's open PR now (the dashboard's "Check now") ---
  const feedbackMatch = /^\/runs\/(\d+)\/check-pr-feedback$/.exec(path);
  if (feedbackMatch && method === 'POST') {
    return sendJson(res, 200, await orch.checkPrFeedback(Number(feedbackMatch[1])));
  }

  // --- config ---
  if (path === '/config') {
    if (method === 'GET') return sendJson(res, 200, orch.getConfig());
    if (method === 'PUT') return sendJson(res, 200, orch.updateConfig(await readJson(req)));
    return sendError(res, new ApiError(405, `method ${method} not allowed on /config`));
  }

  // --- dashboard (Layer 7): any other GET serves a static asset (`/` → index.html) ---
  if (method === 'GET') return serveStatic(res, publicDir, url.pathname);

  sendError(res, new ApiError(404, `no route for ${method} ${path}`));
}

/** Open an SSE connection and forward every (optionally run-filtered) stream event until disconnect. */
function streamSse(orch: Orchestrator, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const runFilter = url.searchParams.get('runId');
  const onlyRun = runFilter !== null ? Number(runFilter) : undefined;
  // Repo-scoped stream (Milestone 8 Phase A): the dashboard's repo view subscribes with ?repo= and
  // sees only that repo's events. Every event carries a run id; we resolve it to its repo (once per
  // event, only while filtering) since activity events don't carry the repo inline.
  // An absent or empty `?repo=` means no filter (matches GET /runs); a value scopes to that repo.
  const onlyRepo = url.searchParams.get('repo')?.toLowerCase() || undefined;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Writing to a half-closed socket throws; guard so a racing publish/heartbeat never crashes the
  // process (the `close` handler below unsubscribes, but a write can lose the race by a tick).
  const write = (chunk: string): void => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(chunk);
    } catch {
      /* client vanished mid-write; the `close` handler will clean up */
    }
  };

  write(': connected\n\n');
  const unsubscribe = orch.subscribe((event) => {
    if (onlyRun !== undefined && eventRunId(event) !== onlyRun) return;
    if (onlyRepo !== undefined && orch.repoOfRun(eventRunId(event))?.toLowerCase() !== onlyRepo) return;
    write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => write(': ping\n\n'), SSE_HEARTBEAT_MS);
  // Don't let the heartbeat timer keep the process alive on its own (tests + clean shutdown).
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function eventRunId(event: StreamEvent): number {
  return event.type === 'activity' ? event.activity.runId : event.runId;
}

// --- request/response helpers -------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = err instanceof ApiError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, status, { error: message });
}

/** Read and JSON-parse a request body. Empty body → `{}`; malformed JSON → `400`. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError(400, 'request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'invalid JSON in request body');
  }
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value === '') throw new ApiError(400, `"${key}" (string) is required`);
  return value;
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ApiError(400, `"${key}" must be a string`);
  return value;
}
