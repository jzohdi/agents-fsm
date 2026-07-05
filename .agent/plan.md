# Plan — Authenticate the HTTP/SSE API (token auth) — jzohdi/agents-fsm#25

## Goal (restated)

Add an optional shared-secret **bearer-token** auth layer to the daemon's HTTP + SSE API so it can
later be safely exposed beyond loopback. This is the foundational piece of the remote-access epic
(#16); networking/TLS and the hardening review are **separate issues, out of scope here**.

Behaviour contract:
- **No token configured ⇒ auth disabled** — behaviour is byte-for-byte unchanged (localhost, open
  API). This preserves every existing test and dev flow.
- **Token configured ⇒ every API route (incl. SSE `GET /stream`) requires a valid credential**,
  returning a distinct `401` for missing/invalid. `GET /health` stays open (liveness probes). The
  static dashboard assets stay open (the SPA must load in order to prompt for and attach a token).
- Constant-time token comparison; token comes **only from the environment** (`FLEET_API_TOKEN`),
  never SQLite (README §9.1 secrets-in-env rule).
- The dashboard accepts a token (stored in `localStorage`), attaches it to every fetch and to the SSE
  URL, and surfaces a clear `401` state.

## How the code works today (grounding)

- `src/api/server.ts` — Node built-in `http`, no framework. `createApiServer(orchestrator, options)`
  returns a `Server`; `handle()` does linear route matching. SSE `GET /stream` is handled first
  (`streamSse`), then `GET /health`, then the JSON routes, and finally a catch-all
  `if (method === 'GET') return serveStatic(...)` serves the SPA bundle (incl. SPA-fallback for
  extension-less routes like `/pipelines`, `/editor`). Errors flow through `sendError`, which maps
  `ApiError.status` (verified: `ApiError` accepts any status, so `401` passes through cleanly) and
  otherwise `500`.
- `src/serve.ts` — builds the orchestrator via `buildOrchestrator(args)`, then
  `createApiServer(orchestrator)` and `listen(server, args.port)`. `listen()` binds `127.0.0.1`
  **and keeps doing so** (off-loopback binding is the separate networking issue). Prints a boot
  banner + route list.
- `src/build-runner.ts` — has the `resolveConcurrency` / `resolveCostCeiling` / `resolveDefaultHarness`
  pattern (flag → env → default). New token resolution follows the same shape.
- `src/cli-args.ts` — `parseArgs`-based; add a flag here.
- `dashboard/src/lib/api.ts` — `request(method, path, body)` thin fetch wrapper; throws `Error` from
  the `{ error }` body.
- `dashboard/src/lib/store.svelte.ts` — `connectStream()` opens `new EventSource('/stream')`; all data
  actions call `request(...)`. `ui` is the single reactive `$state` object.
- `dashboard/src/App.svelte` — `onMount` loads config/runs/etc then `connectStream()`; renders the
  topbar with a live-connection chip.
- `src/api/server.test.ts` — drives the real server over an ephemeral port with `fetch` on the stub
  executor. `start()` helper builds the server via `createApiServer(orchestrator, opts.publicDir ? …)`.
- Pattern precedent: pure, unit-tested helper modules (`static.ts`'s `resolveStaticPath`, `render.ts`,
  `model-picker.ts`) — the auth logic will follow this so the constant-time comparison is testable in
  isolation.

## Approach & architecture

### 1. New pure auth module — `src/api/auth.ts` (+ `src/api/auth.test.ts`)

Small, dependency-light, unit-testable functions (no `http`/`process` coupling):

- `tokenMatches(provided: string | undefined, expected: string): boolean` — **constant-time**.
  Implementation: SHA-256 both values (`node:crypto` `createHash`) to fixed 32-byte digests, then
  `timingSafeEqual`. Hashing to a fixed length sidesteps `timingSafeEqual`'s equal-length requirement
  and avoids leaking the token length. Returns `false` for an absent/empty `provided`.
- `extractToken(headers, url): string | undefined` — reads `Authorization: Bearer <token>` first;
  falls back to the `?token=` query param (needed for SSE — browser `EventSource` can't set headers;
  harmless to also accept on other routes). (Cookie support is explicitly *not* added — the query
  param is the KISS path the issue permits.)
- `requiresAuth(path: string): boolean` — the auth boundary. Returns `true` for the API surface,
  `false` for `/health` and static/SPA paths so the dashboard can bootstrap. Implemented as an
  explicit allowlist of API path prefixes (`/runs`, `/repos`, `/config`, `/cost`, `/models`,
  `/settings`, `/suggestions`, `/scheduler`, `/fs`, `/stream`) — `path === p || path.startsWith(p + '/')`.
  `/health` is deliberately excluded (stays open). Everything else falls to static.
  - *Why an allowlist and not "gate everything except static":* the routing is linear and static is
    the catch-all fall-through, so there's no clean "is this static?" predicate without replaying the
    route table. An explicit prefix list is simplest and directly unit-testable. Risk (a future API
    route added without updating the list would be unauthed) is mitigated by a test asserting each
    known API prefix requires auth.

### 2. Wire the token into the server — `src/api/server.ts`

- Extend `ApiServerOptions` with `apiToken?: string`.
- In `handle()`, immediately after computing `method`/`path`/`url` and **before** any route dispatch
  or body reads: if `apiToken` is a non-empty string **and** `requiresAuth(path)` **and**
  `!tokenMatches(extractToken(req.headers, url), apiToken)` → `throw new ApiError(401, 'authentication required')`
  (message `'invalid token'` when a token was supplied — both `401`, message-only difference). Throwing
  lets the existing `.catch(sendError)` produce the JSON `{ error }` body with status `401`.
  - Gating before body parsing means unauthenticated POSTs are rejected without consuming/parsing the
    body.
  - The SSE branch runs after this gate, so `GET /stream` is covered by the same check.
- Absent/empty `apiToken` ⇒ the whole block is skipped ⇒ current behaviour preserved.

### 3. Resolve + thread the token — `src/build-runner.ts`, `src/cli-args.ts`, `src/serve.ts`

- `cli-args.ts`: add `apiToken?: string` to `CliArgs` and an `'api-token': { type: 'string' }` option;
  map `values['api-token']`.
- `build-runner.ts`: add `resolveApiToken(args): string | undefined` mirroring `resolveCostCeiling` —
  precedence `--api-token` flag → `FLEET_API_TOKEN` env → `undefined` (auth off). Empty string treated
  as unset.
- `serve.ts`: `const apiToken = resolveApiToken(args); const server = createApiServer(orchestrator,
  { apiToken });`. Add one boot-banner line indicating whether auth is **on** or **off** (never print
  the token). Keep the `listen()` loopback bind and its comment (off-loopback is the networking issue);
  optionally soften the comment to note auth now exists but binding is still loopback pending #16.

### 4. Dashboard client — `dashboard/`

- New tiny token module (e.g. `dashboard/src/lib/auth.ts`): `getToken()`/`setToken()`/`clearToken()`
  backed by `localStorage['fleet_api_token']`, plus a pure `withToken(path)` helper that appends
  `?token=` for the SSE URL (unit-testable). Keeping the URL/header building pure lets a small vitest
  cover it (mirrors `model-picker.test.ts`).
- `api.ts` `request()`: attach `Authorization: Bearer <token>` header when a token is stored. On a
  `401` response, flag an auth-required state (throw a recognizable error / set a store flag) so the UI
  can prompt.
- `store.svelte.ts`: add `ui.authRequired` (boolean). In the `request` 401 path (or a wrapper), set it.
  `connectStream()` builds the `EventSource` URL via `withToken('/stream')` so the stream carries the
  token. Note: `EventSource` can't read the HTTP status, so an SSE `401` only surfaces as `onerror`
  (→ `conn: 'off'`); the fetch routes (loadConfig/loadRuns on mount) surface the `401` first and drive
  the prompt, so this is acceptable — documented in code.
- `App.svelte` (or a small `TokenPrompt.svelte`): when `ui.authRequired`, show a minimal overlay/banner
  to enter a token; on submit → `setToken()`, clear the flag, re-run the mount loads
  (`loadConfig`/`loadRuns`/…) and reconnect the stream. Also allow clearing the token.
- Dev proxy (`dashboard/vite.config.ts`): no change required — Vite's proxy forwards query params and
  the `Authorization` header by default; `/stream` is already proxied.

### 5. Docs

- `.env.example`: add `FLEET_API_TOKEN=` with a comment (absent ⇒ auth disabled / localhost-only;
  set ⇒ all API + SSE routes require `Authorization: Bearer` or `?token=`).
- `README.md` §9 (the `serve` daemon paragraph ~line 544 and §9.1 secrets ~line 708): document the
  token env var, that it's env-only (never SQLite), how clients authenticate (Bearer header; `?token=`
  for the SSE/`EventSource`), that `/health` stays open, that static assets stay open for SPA
  bootstrap, and that the loopback bind is unchanged pending the networking issue (#16).

## Files to change

- `src/api/auth.ts` — **new** (pure auth helpers).
- `src/api/auth.test.ts` — **new** (constant-time compare, extract, requiresAuth).
- `src/api/server.ts` — `ApiServerOptions.apiToken`, auth gate in `handle()`.
- `src/api/server.test.ts` — auth-off passthrough, auth-on reject/accept for a normal route + `/stream`,
  `/health` open.
- `src/cli-args.ts` — `--api-token` flag + `CliArgs.apiToken`.
- `src/build-runner.ts` — `resolveApiToken`.
- `src/serve.ts` — resolve token, pass to `createApiServer`, boot-log auth on/off.
- `dashboard/src/lib/auth.ts` — **new** (token storage + URL helper).
- `dashboard/src/lib/auth.test.ts` — **new** (pure URL/header helper) *(optional but preferred)*.
- `dashboard/src/lib/api.ts` — attach header, detect 401.
- `dashboard/src/lib/store.svelte.ts` — `ui.authRequired`, tokenized stream URL, re-auth flow.
- `dashboard/src/App.svelte` (+ optional `TokenPrompt.svelte`) — token prompt / 401 state.
- `.env.example`, `README.md` — docs.

## Risks & edge cases

- **Must not break the auth-off default.** Every existing `server.test.ts` call sends no token; with
  `apiToken` unset the gate is skipped, so all stay `200`. This is the primary regression guard.
- **Constant-time / length leak.** Use SHA-256 digests + `timingSafeEqual`; never a plain `===` or a
  raw `timingSafeEqual` on unequal-length buffers (throws / leaks length).
- **SSE 401 in the browser.** `EventSource` can't surface the status; rely on the fetch routes to drive
  the prompt. Documented, not worked around (WebSocket/cookie upgrades are out of scope).
- **`?token=` in URLs** can appear in logs/referrers — accepted for the `EventSource` limitation the
  issue calls out; the Bearer header remains primary for normal fetches.
- **Static assets stay open by design** — gating them would prevent the SPA from loading to enter the
  token. Matches the issue wording ("all API routes"), and the assets aren't secret.
- **New API routes** added later must be added to the `requiresAuth` allowlist — covered by a test that
  asserts the known API prefixes require auth (and `/health` does not).
- **Keep the tree clean:** no lockfile churn (no new deps — `node:crypto` is built in), no build output.

## Testing

- **Unit (`src/api/auth.test.ts`):** `tokenMatches` accepts the exact token, rejects wrong/empty/undefined,
  and rejects a token that is a prefix/superset (fixed-length digest); `extractToken` reads Bearer and
  `?token=`; `requiresAuth` is true for each API prefix and false for `/health` and static paths.
- **Integration (`src/api/server.test.ts`):**
  - *auth-off passthrough* — server without a token: a normal route + `/stream` succeed (existing
    behaviour).
  - *auth-on reject/accept (normal route)* — `GET /runs` with no token → `401`, wrong token → `401`,
    correct `Authorization: Bearer` → `200`.
  - *auth-on reject/accept (`/stream`)* — `GET /stream` with no token → `401`; with `?token=<correct>`
    → `200` + `text/event-stream`.
  - *`/health` open* — `200` even with auth on and no token.
- **Dashboard unit** *(optional)* — the pure `withToken`/header helper attaches the token.
- **End-to-end (verify):** run a token-protected daemon (`FLEET_API_TOKEN=…`), confirm the dashboard
  prompts, authenticates, loads data, and the live stream connects; `npm test` + lint green.

## Scope flags

- `needs_backend: true` — server auth gate, serve/build-runner/cli-args wiring, new auth module + tests.
- `needs_frontend: true` — dashboard token storage, header/stream wiring, 401 prompt UI.
