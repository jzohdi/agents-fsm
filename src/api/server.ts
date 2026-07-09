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
 *   POST /runs/:id/effort       POST /runs/:id/harness
 *   POST /runs/:id/context      (agents-fsm#5: per-issue operator context, Layer 3)
 *   POST /runs/:id/resolve-conflicts
 *   POST /runs/:id/check-pr-feedback   POST /runs/:id/check-reply
 *   POST /runs/:id/chat         GET /runs/:id/chat          POST /runs/:id/chat/:chatId/cancel
 *   GET  /repos                 POST /repos                 POST /repos/watch
 *   POST /repos/source          (Milestone 12: bind clone-on-run / a local directory)
 *   GET  /fs/dirs[?q=]          (Milestone 12: path completions for the local-directory picker)
 *   GET  /config                PUT /config
 *   GET  /cost                  GET /models[?harness=]
 *   GET  /suggestions[?q=]      POST /scheduler/check
 *   GET  /settings              PUT /settings/default-harness
 *   PUT  /settings/context/global   PUT /settings/context/stage   (agents-fsm#5: operator context Layers 1–2)
 *   GET  /stream[?runId=&repo=] GET /health
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';

import { ApiError, type Orchestrator } from './orchestrator';
import { extractToken, requiresAuth, tokenMatches } from './auth';
import { createRateLimiter, type RateLimiter } from './rate-limit';
import { corsHeaders, securityHeaders } from './security-headers';
import { suggestDirs } from './dir-suggest';
import { serveStatic } from './static';
import type { RunStatus } from '../store/repository';
import type { StreamEvent } from './stream';

/** Heartbeat so idle SSE connections aren't dropped by intermediaries (a bare comment line). */
const SSE_HEARTBEAT_MS = 25_000;

/** Generous rate-limit default (issue #27): a normal local dashboard never trips a 60-burst / 1-per-sec bucket. */
const DEFAULT_RATE_LIMIT = { capacity: 60, refillPerSec: 1 };
/** Default request-body cap (issue #27): 1 MiB, enough for any legitimate control-plane payload. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * The built dashboard assets (Layer 7) — the output of `npm run build:dashboard`. Resolved from this
 * module so it works under `tsx`. Built on demand and gitignored; the daemon warns if it is missing.
 */
export const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../../dashboard/dist/', import.meta.url));

export interface ApiServerOptions {
  /** Directory the dashboard's static assets are served from. Defaults to the bundled `public/`. */
  publicDir?: string;
  /**
   * Shared-secret bearer token gating the API + SSE surface (issue #25). Absent/empty ⇒ auth
   * disabled (current behaviour). When set, every `requiresAuth(path)` route requires a valid
   * credential. Env-provided only (never persisted); the server just receives the resolved value.
   */
  apiToken?: string;
  /**
   * Direct TLS termination (issue #26). When set, the server is built with `https.createServer` using
   * these already-read PEM strings; absent ⇒ plain `http.createServer` (the unchanged default).
   * `serve.ts` reads the files and passes resolved PEM contents — the server stays free of filesystem
   * concerns. TLS is transport confidentiality only; it does **not** exempt the bind-token guard.
   */
  tls?: { cert: string; key: string };
  // --- remote-access hardening (issue #27) — all optional; omit ⇒ hardened defaults ---
  /**
   * Token-bucket config for mutating/expensive routes. Omit ⇒ a generous built-in default
   * (capacity 60, refillPerSec 1) that a normal local dashboard never trips.
   */
  rateLimit?: { capacity: number; refillPerSec: number };
  /** Max request-body bytes before `413`. Omit ⇒ default 1 MiB (1_048_576). */
  maxBodyBytes?: number;
  /** Exact-match CORS allow-list. Omit/empty ⇒ deny all cross-origin (the default). */
  allowedOrigins?: string[];
  /** Injectable clock (epoch ms) for the rate limiter, for deterministic tests. Omit ⇒ `Date.now`. */
  now?: () => number;
}

/**
 * Per-request hardening context (issue #27), assembled once in {@link createApiServer} and shared
 * across every request: the process-lifetime rate limiter (so per-source buckets persist), the body
 * cap, the CORS allow-list, and the injectable clock. Bundled so `handle` and its helpers thread one
 * value instead of a growing positional list.
 */
interface HardeningContext {
  publicDir: string;
  apiToken?: string;
  limiter: RateLimiter;
  maxBodyBytes: number;
  allowedOrigins: readonly string[];
  now: () => number;
}

/** Build the daemon's HTTP server. The caller decides when/where to `listen` (port 0 in tests). */
export function createApiServer(orchestrator: Orchestrator, options: ApiServerOptions = {}): Server {
  // Assemble the hardening context once — the rate limiter especially must be a single per-process
  // instance so a client's token bucket persists across its requests (per-source-key state).
  const ctx: HardeningContext = {
    publicDir: options.publicDir ?? DEFAULT_PUBLIC_DIR,
    ...(options.apiToken ? { apiToken: options.apiToken } : {}),
    limiter: createRateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT),
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    allowedOrigins: options.allowedOrigins ?? [],
    now: options.now ?? Date.now,
  };
  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    // Baseline security headers ride on EVERY response — set here (before any dispatch) so even an
    // early throw or a static/SSE writeHead carries them (writeHead merges over setHeader values).
    for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
    handle(orchestrator, req, res, ctx).catch((err) => sendError(res, err));
  };
  // Direct TLS termination (issue #26): when `tls` PEM strings are supplied, build an `https` server;
  // otherwise plain `http` (the unchanged default). `https.Server` shares `node:http`'s request/`listen`
  // surface and the same `handle(...)` routing serves both — TLS is transport confidentiality only.
  return options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, listener)
    : createServer(listener);
}

async function handle(
  orch: Orchestrator,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HardeningContext,
): Promise<void> {
  const { publicDir, apiToken } = ctx;
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // --- CORS / cross-origin (issue #27): default posture is same-origin only (the dashboard is served
  // by this same daemon, so it needs no CORS grant). `corsHeaders` returns an ACAO **only** for an exact
  // allow-listed origin — never a `*` wildcard — so a disallowed origin gets nothing and the browser
  // blocks the cross-origin read. Set on the response for every method; a preflight is answered here. ---
  for (const [k, v] of Object.entries(corsHeaders(req.headers.origin, ctx.allowedOrigins))) res.setHeader(k, v);
  if (method === 'OPTIONS') {
    // A locked-down preflight answer (never falls through to the SPA/404). ACAO is present only for an
    // allow-listed origin (set above); Max-Age caches the decision. Emitting CORS never bypasses auth —
    // OPTIONS carries no credential and drives no route.
    res.writeHead(204, { 'Access-Control-Max-Age': '600' });
    res.end();
    return;
  }

  // --- auth gate (issue #25): runs before any route dispatch or body read. Absent/empty token ⇒
  // skipped entirely (auth-off is byte-for-byte the old behaviour). `/health` + static/SPA paths are
  // open (`requiresAuth` false) so liveness probes and the token-prompt bootstrap still work. The
  // `/stream` branch below runs after this, so SSE is covered by the same check (a tokenless stream
  // gets a plain 401 JSON, never a text/event-stream upgrade). ---
  if (apiToken && requiresAuth(path)) {
    const provided = extractToken(req.headers, url);
    if (!tokenMatches(provided, apiToken)) {
      throw new ApiError(401, provided === undefined ? 'authentication required' : 'invalid token');
    }
  }

  // --- rate limit (issue #27): the abuse backstop, applied to mutating/expensive routes only (see
  // `isRateLimited`). Cheap GETs, the SSE stream, and `/health` are never throttled, so a normal local
  // dashboard never trips it. Keyed by the client's source address — a coarse per-source-IP backstop
  // (behind a shared-IP tunnel all clients collapse to one bucket; `X-Forwarded-For` is untrusted /
  // spoofable and deliberately NOT consulted). Runs after auth, but a limited route still consumes a
  // token on an auth failure, so auth itself can't be brute-forced unboundedly. ---
  if (isRateLimited(method, path)) {
    const key = req.socket.remoteAddress ?? 'unknown';
    const decision = ctx.limiter.check(key, ctx.now());
    if (!decision.ok) {
      res.setHeader('Retry-After', String(decision.retryAfterSec ?? 1));
      throw new ApiError(429, 'rate limit exceeded');
    }
  }

  // --- stream (long-lived; handled before the JSON routes) ---
  if (method === 'GET' && path === '/stream') {
    streamSse(orch, req, res, url);
    return;
  }

  if (method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true });

  // --- fleet cost status: the global ceiling (or null) + current active spend (Milestone 8 B3) ---
  if (method === 'GET' && path === '/cost') return sendJson(res, 200, orch.costStatus());

  // --- harness model catalog: selectable models + the daemon default (the model dropdowns). An
  // optional `?harness=` resolves that harness's catalog (the per-run picker); absent → the default's.
  // An unknown id is a 400, raised in `getModels` (validation lives in the orchestrator). ---
  if (method === 'GET' && path === '/models') {
    return sendJson(res, 200, orch.getModels(url.searchParams.get('harness') ?? undefined));
  }

  // --- settings: the default harness + the operator's sticky pre-run model/effort selection ---
  if (method === 'GET' && path === '/settings') return sendJson(res, 200, orch.getSettings());
  if (method === 'PUT' && path === '/settings/default-harness') {
    return sendJson(res, 200, orch.setDefaultHarness(str(await readJson(req, ctx.maxBodyBytes), 'harness')));
  }
  if (method === 'PUT' && path === '/settings/default-model') {
    // `model`/`effort` persist the bar's pre-run pick; either may be `null` to clear (an absent field is
    // treated as null). Validated in the orchestrator against the default harness's catalog.
    const body = await readJson(req, ctx.maxBodyBytes);
    const model = body.model ?? null;
    const effort = body.effort ?? null;
    if (model !== null && typeof model !== 'string') return sendError(res, new ApiError(400, '"model" must be a string or null'));
    if (effort !== null && typeof effort !== 'string') return sendError(res, new ApiError(400, '"effort" must be a string or null'));
    return sendJson(res, 200, orch.setDefaultModel(model, effort));
  }

  // --- operator context (agents-fsm#5): the global base (Layer 1) + per-stage (Layer 2) prompts. Both
  // `context` bodies are a string or null (null/blank clears the key). Per-stage also carries `stage`,
  // validated against the known stage set in the orchestrator (an unknown one → 400 typo guard). ---
  if (method === 'PUT' && path === '/settings/context/global') {
    const context = (await readJson(req, ctx.maxBodyBytes)).context ?? null;
    if (context !== null && typeof context !== 'string') return sendError(res, new ApiError(400, '"context" must be a string or null'));
    return sendJson(res, 200, orch.setGlobalContext(context));
  }
  if (method === 'PUT' && path === '/settings/context/stage') {
    const body = await readJson(req, ctx.maxBodyBytes);
    const context = body.context ?? null;
    if (context !== null && typeof context !== 'string') return sendError(res, new ApiError(400, '"context" must be a string or null'));
    return sendJson(res, 200, orch.setStageContext(str(body, 'stage'), context));
  }

  // --- new-run autocomplete: your repos + their open issues matching ?q= (README §3.3 Layer 7) ---
  if (method === 'GET' && path === '/suggestions') {
    return sendJson(res, 200, await orch.suggestIssues(url.searchParams.get('q') ?? ''));
  }

  // --- on-demand Scheduler pass (Milestone 9): fleet-wide, not per-run — cycles and the closed-issue
  // set span runs. The dashboard's "Check dependencies now"; returns what the pass did. ---
  if (method === 'POST' && path === '/scheduler/check') {
    return sendJson(res, 200, await orch.checkDependencies());
  }

  // --- repo watch (Milestone 11: turn continuous mode on/off for an enrolled repo). Body-carried
  // repoRef (it contains a `/`, awkward in a path segment); `watch` boolean required, `label` optional
  // (string to set a custom override label, null to reset to the default, absent to leave it).
  // `filterLabel`/`filterMilestone` (issue #11) are the optional scope filter — same shape as `label`:
  // a string to set, null to clear, absent to leave; an empty string normalizes to null server-side.
  // `inFlightCap` (agents-fsm#10) is the optional parallel-pickup cap — a number to set, absent to leave;
  // the integer / `>= 1` check lives in the orchestrator (the single validation authority). ---
  if (method === 'POST' && path === '/repos/watch') {
    const body = await readJson(req, ctx.maxBodyBytes);
    const watch = body.watch;
    if (typeof watch !== 'boolean') return sendError(res, new ApiError(400, '"watch" (boolean) is required'));
    const label = body.label;
    if (label !== undefined && label !== null && typeof label !== 'string') {
      return sendError(res, new ApiError(400, '"label" must be a string, null, or omitted'));
    }
    const filterLabel = body.filterLabel;
    if (filterLabel !== undefined && filterLabel !== null && typeof filterLabel !== 'string') {
      return sendError(res, new ApiError(400, '"filterLabel" must be a string, null, or omitted'));
    }
    const filterMilestone = body.filterMilestone;
    if (filterMilestone !== undefined && filterMilestone !== null && typeof filterMilestone !== 'string') {
      return sendError(res, new ApiError(400, '"filterMilestone" must be a string, null, or omitted'));
    }
    const inFlightCap = body.inFlightCap;
    if (inFlightCap !== undefined && typeof inFlightCap !== 'number') {
      return sendError(res, new ApiError(400, '"inFlightCap" must be a positive integer or omitted'));
    }
    return sendJson(
      res,
      200,
      orch.setRepoWatch({
        repoRef: str(body, 'repoRef'),
        watch,
        label: label as string | null | undefined,
        filterLabel: filterLabel as string | null | undefined,
        filterMilestone: filterMilestone as string | null | undefined,
        inFlightCap: inFlightCap as number | undefined,
      }),
    );
  }

  // --- repo merge-conflict policy: what a run does when merging the latest base into its branch
  // conflicts — 'manual' parks it needs_human; 'auto' lets a verified resolver invocation handle it.
  // Body-carried repoRef (contains a `/`), like /repos/watch. ---
  if (method === 'POST' && path === '/repos/conflict-policy') {
    const body = await readJson(req, ctx.maxBodyBytes);
    return sendJson(res, 200, orch.setRepoConflictPolicy({ repoRef: str(body, 'repoRef'), policy: str(body, 'policy') }));
  }

  // --- repo auto-merge flag (agents-fsm#15): when on, a run reaching terminal `done` merges its PR into
  // base instead of parking merge-ready for a human — same approved signal `done` requires, no bypass.
  // Body-carried repoRef (contains a `/`), like /repos/conflict-policy. ---
  if (method === 'POST' && path === '/repos/auto-merge') {
    const body = await readJson(req, ctx.maxBodyBytes);
    const enabled = body.enabled;
    if (typeof enabled !== 'boolean') return sendError(res, new ApiError(400, '"enabled" (boolean) is required'));
    return sendJson(res, 200, orch.setRepoAutoMerge({ repoRef: str(body, 'repoRef'), enabled }));
  }

  // --- directory-path completions for the local-checkout picker (Milestone 12 UI). The browser can't
  // read absolute paths from a native folder dialog, so the daemon (which runs on the operator's
  // machine) supplies shell-style tab-completions instead. Read-only, names-only. ---
  if (method === 'GET' && path === '/fs/dirs') {
    return sendJson(res, 200, { dirs: suggestDirs(url.searchParams.get('q') ?? '') });
  }

  // --- repo working-directory source (Milestone 12): bind an enrolled repo to clone-on-run or a validated
  // local directory. Body-carried repoRef (contains a `/`); `mode` ∈ clone|local; `localRepo` (absolute
  // path) required for local mode. A wrong directory is a 400 with the mismatch reason. ---
  if (method === 'POST' && path === '/repos/source') {
    const body = await readJson(req, ctx.maxBodyBytes);
    const mode = str(body, 'mode');
    if (mode !== 'clone' && mode !== 'local') return sendError(res, new ApiError(400, '"mode" must be "clone" or "local"'));
    return sendJson(res, 200, await orch.configureRepoSource({
      repoRef: str(body, 'repoRef'),
      mode,
      localRepo: optStr(body, 'localRepo'),
    }));
  }

  // --- repos (Milestone 8 Phase A: enroll a repo the fleet can run / list enrolled repos) ---
  if (path === '/repos') {
    if (method === 'GET') return sendJson(res, 200, orch.listRepos());
    if (method === 'POST') {
      const body = await readJson(req, ctx.maxBodyBytes);
      return sendJson(res, 201, orch.enrollRepo({
        repoRef: str(body, 'repoRef'),
        workingRoot: optStr(body, 'workingRoot'),
        baseBranch: optStr(body, 'baseBranch'),
        cloneUrl: optStr(body, 'cloneUrl'),
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
      const body = await readJson(req, ctx.maxBodyBytes);
      // `harness` is optional: absent/empty → the daemon default; a present-but-unknown id → 400 (in
      // `orch.start` via isHarnessId). We only transport it here, keeping validation in the orchestrator.
      return sendJson(res, 201, orch.start({
        issueRef: str(body, 'issueRef'),
        repoRef: optStr(body, 'repoRef'),
        harness: optStr(body, 'harness'),
        // `model`/`effort` are optional: absent/empty → the operator's persisted default (or none); a
        // present-but-invalid value → 400 (in `orch.start`, validated against the chosen harness/model).
        model: optStr(body, 'model'),
        effort: optStr(body, 'effort'),
      }));
    }
    return sendError(res, new ApiError(405, `method ${method} not allowed on /runs`));
  }

  const runMatch = /^\/runs\/(\d+)$/.exec(path);
  if (runMatch && method === 'GET') return sendJson(res, 200, orch.getRunDetail(Number(runMatch[1])));

  const actionMatch = /^\/runs\/(\d+)\/(pause|resume|stop|revert|archive|unarchive|cost-override|model|effort|harness|context|resolve-conflicts)$/.exec(path);
  if (actionMatch && method === 'POST') {
    const id = Number(actionMatch[1]);
    switch (actionMatch[2]) {
      case 'pause':
        return sendJson(res, 200, orch.pause(id));
      case 'resume': {
        // Optional `notes`: operator guidance for the retried stage (delivered as its re-entry context).
        const body = await readJson(req, ctx.maxBodyBytes);
        const raw = body.notes;
        if (raw !== undefined && typeof raw !== 'string') {
          return sendError(res, new ApiError(400, '"notes" must be a string when provided'));
        }
        // Optional `extraRounds` (Layer 3): a per-resume review-cap bump for an `internal_review_cap`
        // escalation that was converging — an integer 1..10.
        const extra = body.extraRounds;
        if (extra !== undefined && (typeof extra !== 'number' || !Number.isInteger(extra) || extra <= 0 || extra > 10)) {
          return sendError(res, new ApiError(400, '"extraRounds" must be an integer between 1 and 10 when provided'));
        }
        return sendJson(res, 200, orch.resume(id, raw, extra));
      }
      case 'stop':
        return sendJson(res, 200, orch.stop(id));
      case 'archive':
        return sendJson(res, 200, orch.archive(id));
      case 'unarchive':
        return sendJson(res, 200, orch.unarchive(id));
      case 'revert': {
        const body = await readJson(req, ctx.maxBodyBytes);
        return sendJson(res, 200, orch.revert(id, str(body, 'toState'), body.reason));
      }
      case 'cost-override': {
        // `mode`: 'next_step' | 'full' to let the run cross the global cost ceiling, or 'none' to clear (M8 B3).
        const raw = str(await readJson(req, ctx.maxBodyBytes), 'mode');
        if (raw !== 'next_step' && raw !== 'full' && raw !== 'none') {
          return sendError(res, new ApiError(400, `invalid cost-override mode "${raw}" (expected next_step | full | none)`));
        }
        return sendJson(res, 200, orch.overrideCost(id, raw === 'none' ? null : raw));
      }
      case 'model': {
        // `model`: a harness model tag to run this run under, or `null` to clear back to the daemon default.
        const raw = (await readJson(req, ctx.maxBodyBytes)).model;
        if (raw !== null && typeof raw !== 'string') {
          return sendError(res, new ApiError(400, '"model" (string, or null to clear) is required'));
        }
        return sendJson(res, 200, orch.setModel(id, raw));
      }
      case 'effort': {
        // `effort`: a reasoning-effort level to run this run under, or `null` to clear back to the default.
        const raw = (await readJson(req, ctx.maxBodyBytes)).effort;
        if (raw !== null && typeof raw !== 'string') {
          return sendError(res, new ApiError(400, '"effort" (string, or null to clear) is required'));
        }
        return sendJson(res, 200, orch.setEffort(id, raw));
      }
      case 'harness': {
        // `harness`: re-point the run at another harness from its next stage on (clears model/effort overrides).
        return sendJson(res, 200, orch.setHarness(id, str(await readJson(req, ctx.maxBodyBytes), 'harness')));
      }
      case 'context': {
        // `context`: the run's per-issue operator context (Layer 3, agents-fsm#5), or `null`/blank to clear.
        const raw = (await readJson(req, ctx.maxBodyBytes)).context;
        if (raw !== null && typeof raw !== 'string') {
          return sendError(res, new ApiError(400, '"context" (string, or null to clear) is required'));
        }
        return sendJson(res, 200, orch.setRunContext(id, raw));
      }
      case 'resolve-conflicts':
        // Escape hatch: run the dedicated resolver on a finished run whose PR conflicts (any policy).
        return sendJson(res, 200, orch.resolveConflicts(id));
    }
  }

  // --- run chat (the operator's per-run side channel): send a prompt (mode read = immediate,
  // read-only tools; mode write = held until the pipeline pauses, then edit tools + commit/push),
  // list the thread, or withdraw a still-queued prompt. Replies stream as `chat` events. ---
  const chatMatch = /^\/runs\/(\d+)\/chat$/.exec(path);
  if (chatMatch) {
    const id = Number(chatMatch[1]);
    if (method === 'GET') return sendJson(res, 200, orch.listChat(id));
    if (method === 'POST') {
      const body = await readJson(req, ctx.maxBodyBytes);
      return sendJson(res, 201, orch.chat(id, { prompt: str(body, 'prompt'), mode: str(body, 'mode') }));
    }
    return sendError(res, new ApiError(405, `method ${method} not allowed on /runs/:id/chat`));
  }
  const chatCancelMatch = /^\/runs\/(\d+)\/chat\/(\d+)\/cancel$/.exec(path);
  if (chatCancelMatch && method === 'POST') {
    return sendJson(res, 200, orch.cancelChat(Number(chatCancelMatch[1]), Number(chatCancelMatch[2])));
  }

  // --- on-demand PR-feedback check: poll one run's open PR now (the dashboard's "Check now") ---
  const feedbackMatch = /^\/runs\/(\d+)\/check-pr-feedback$/.exec(path);
  if (feedbackMatch && method === 'POST') {
    return sendJson(res, 200, await orch.checkPrFeedback(Number(feedbackMatch[1])));
  }

  // --- on-demand reply check: poll one `awaiting_input` run's issue thread now for a human reply ---
  const replyMatch = /^\/runs\/(\d+)\/check-reply$/.exec(path);
  if (replyMatch && method === 'POST') {
    return sendJson(res, 200, await orch.checkReply(Number(replyMatch[1])));
  }

  // --- on-demand resolution advisor: suggest how to resolve a needs_human escalation (Layer 3) ---
  const adviseMatch = /^\/runs\/(\d+)\/advise$/.exec(path);
  if (adviseMatch && method === 'POST') {
    return sendJson(res, 200, await orch.advise(Number(adviseMatch[1])));
  }

  // --- config ---
  if (path === '/config') {
    if (method === 'GET') return sendJson(res, 200, orch.getConfig());
    if (method === 'PUT') return sendJson(res, 200, orch.updateConfig(await readJson(req, ctx.maxBodyBytes)));
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

/**
 * Whether a request should be rate-limited (issue #27): every **mutating/expensive** call — any
 * `POST`/`PUT`/`DELETE`/`PATCH` — which covers `POST /runs`, the control-plane mutations, and the
 * on-demand poll/advise routes. Cheap reads (`GET`/`HEAD`), the SSE stream, `OPTIONS` preflights, and
 * `/health` (liveness probes) are **never** throttled, so a normal local dashboard is unaffected.
 */
function isRateLimited(method: string, path: string): boolean {
  if (path === '/health') return false;
  return method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
}

// --- request/response helpers -------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/**
 * Serialize an error to the client. An {@link ApiError} carries a deliberate, client-facing status +
 * message (the API contract — including the new `413`/`429`). **Any other throw** (a bug, an I/O
 * error, an unexpected failure) is sanitized to a generic `500 { error: 'internal server error' }` and
 * the real error is logged **server-side only** — so a raw `.message`, stack, or internal filesystem
 * path never reaches a remote caller (issue #27). Stack traces were already never sent; the change is
 * that a non-`ApiError`'s raw message is no longer echoed. Baseline security headers ride along via the
 * `setHeader` set in the listener; if the stream already started (SSE mid-frame) we just end the body.
 */
function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof ApiError) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  console.error('[api] unhandled error:', err); // server-side only — never surfaced to the caller
  sendJson(res, 500, { error: 'internal server error' });
}

/**
 * Read and JSON-parse a request body. Empty body → `{}`; malformed JSON → `400`. The body is capped at
 * `maxBytes`: as soon as the cumulative bytes read **exceed** it, reading stops and a generic
 * `413 request body too large` is thrown — an unbounded payload can't exhaust memory once the surface
 * is remotely reachable (issue #27).
 */
async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new ApiError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
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
