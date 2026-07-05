# Interface — Authenticate the HTTP/SSE API (token auth) — jzohdi/agents-fsm#25

This spec pins the exact types, signatures, module boundaries, and invariants the `tdd` and
implementation stages build against. It refines `.agent/plan.md`; where a detail here is more
specific than the plan, this wins.

## Guiding invariant (the regression guard)

**Auth-off is byte-for-byte the current behaviour.** When no token is configured (`apiToken`
absent/empty), the auth gate is *entirely skipped* — no header inspection, no branch taken, no
change to any status code or body. Every existing `server.test.ts` and dev flow sends no token and
must stay green. This is the single most important contract of the change.

---

## Module 1 — `src/api/auth.ts` (NEW, pure, dependency-light)

Pure functions only. May import `node:crypto`. **Must not** import `node:http`, touch `process`, or
depend on the orchestrator — so `auth.test.ts` unit-tests it in isolation (mirrors `static.ts`'s
`resolveStaticPath`, `model-picker.ts`).

### `tokenMatches(provided, expected)`

```ts
export function tokenMatches(provided: string | undefined, expected: string): boolean;
```

- **Constant-time.** Implementation: SHA-256 both operands to fixed 32-byte digests
  (`crypto.createHash('sha256').update(value).digest()`), then `crypto.timingSafeEqual(a, b)`.
  Hashing to a fixed length sidesteps `timingSafeEqual`'s equal-length-buffer requirement (it
  throws on unequal lengths) and avoids leaking the token's length.
- Returns `false` when `provided` is `undefined` or `''` (empty). A short-circuit before hashing is
  acceptable for the absent case.
- Returns `true` **iff** `provided === expected` byte-for-byte. A prefix or superset of the correct
  token (e.g. `expected + 'x'`, or a strict prefix) must return `false` — the fixed-length digest
  guarantees this.
- `expected` is assumed non-empty (the caller only invokes the gate when a token is configured); no
  special handling for empty `expected` is required.

### `extractToken(headers, url)`

```ts
export function extractToken(
  headers: import('node:http').IncomingHttpHeaders,
  url: URL,
): string | undefined;
```

- Reads the credential from the request. Precedence:
  1. `Authorization: Bearer <token>` header — case-insensitive scheme match (`Bearer`/`bearer`);
     the token is everything after the single space. Return the raw token (do not trim beyond the
     scheme split).
  2. Fallback: the `?token=` query param (`url.searchParams.get('token')`). Needed for SSE — browser
     `EventSource` can't set headers. Harmless to also accept on other routes.
- Returns `undefined` when neither is present (or the header is malformed / not a Bearer scheme, or
  the query param is absent). An empty-string result is normalized to `undefined`, so it flows to a
  `401` via `tokenMatches`.
- `headers['authorization']` may be `string | string[] | undefined`; treat a non-string as absent.

### `requiresAuth(path)`

```ts
export function requiresAuth(path: string): boolean;
```

- The auth boundary. `path` is the already-normalized pathname (trailing slashes stripped, exactly
  as `handle()` computes it: `url.pathname.replace(/\/+$/, '') || '/'`).
- Returns `true` for the protected API surface, `false` for `/health` and everything that falls
  through to static/SPA serving (so the dashboard can bootstrap and prompt for a token).
- Implemented as an **explicit allowlist of API path prefixes**. A path is protected iff, for some
  prefix `p` in the list, `path === p || path.startsWith(p + '/')`.
- The prefix list (authoritative — every current API prefix in `server.ts`):

  ```
  /runs        /repos       /config      /cost
  /models      /settings    /suggestions /scheduler
  /fs          /stream
  ```

- `/health` is deliberately **excluded** → stays open (liveness probes).
- Any path not matching a prefix (`/`, `/pipelines`, `/editor`, `/assets/*`, `index.html`, etc.) →
  `false` (static, open by design).
- **Maintenance invariant:** a new API route added later must be added to this list or it ships
  unauthenticated. A test asserts each known prefix requires auth and `/health` does not (see
  Testing).

---

## Module 2 — `src/api/server.ts` (server wiring)

### `ApiServerOptions` — extend

```ts
export interface ApiServerOptions {
  publicDir?: string;
  /**
   * Shared-secret bearer token gating the API + SSE surface. Absent/empty ⇒ auth disabled
   * (current behaviour). When set, every `requiresAuth(path)` route requires a valid credential.
   * Env-provided only (never persisted); the server just receives the resolved value.
   */
  apiToken?: string;
}
```

`createApiServer(orchestrator, options = {})` is otherwise unchanged; it threads `options.apiToken`
into `handle()` alongside `publicDir`.

### The auth gate in `handle()`

Location: **immediately after** computing `method` / `url` / `path`, and **before** the `/stream`
branch and every other route dispatch or body read.

```ts
if (apiToken && requiresAuth(path)) {
  const provided = extractToken(req.headers, url);
  if (!tokenMatches(provided, apiToken)) {
    throw new ApiError(401, provided === undefined ? 'authentication required' : 'invalid token');
  }
}
```

- `apiToken` truthiness first ⇒ auth-off short-circuits (empty string is falsy = disabled).
- `throw new ApiError(401, …)` propagates to the existing `createApiServer` `.catch(sendError)`,
  which serializes `{ error: <message> }` with HTTP `401`. `ApiError` already accepts any status and
  `sendError` maps `err.status` cleanly — **no change to `sendError` is needed.**
- **Message distinction** (both status `401`): missing credential → `'authentication required'`;
  present-but-wrong → `'invalid token'`. `extractToken` normalizing empty → `undefined` makes this
  check correct.
- **Gate runs before body parsing** ⇒ an unauthenticated `POST` is rejected without consuming or
  JSON-parsing its body.
- The `/stream` SSE branch runs *after* the gate ⇒ `GET /stream` is covered by the same check; a
  missing/invalid token yields a plain `401` JSON response (headers not yet written), never a
  `text/event-stream` upgrade.

**Invariants:**
- `GET /health` → never gated (`requiresAuth('/health') === false`), `200` even with auth on and no
  token.
- Static assets / SPA fallback → never gated (open, so the SPA can load to prompt for a token).
- With `apiToken` unset, the entire block is skipped ⇒ current behaviour preserved.

---

## Module 3 — Token resolution + wiring

### `src/cli-args.ts`

- Add to `CliArgs`:
  ```ts
  /**
   * Shared-secret bearer token for the `serve` daemon's API + SSE (`--api-token`). Undefined here →
   * falls back to `FLEET_API_TOKEN`, then auth is disabled. Env-only in practice; never persisted to
   * SQLite.
   */
  apiToken?: string;
  ```
- Add option `'api-token': { type: 'string' }` to the `parseArgs` `options` map.
- Map in the returned object: `apiToken: values['api-token']`.

### `src/build-runner.ts`

- New exported resolver, mirroring `resolveCostCeiling` (flag → env → default):
  ```ts
  /**
   * Resolve the daemon's API auth token (issue #25), precedence: `--api-token` flag →
   * `FLEET_API_TOKEN` env → undefined (auth disabled). A blank/whitespace-only value is treated as
   * unset, so `FLEET_API_TOKEN=` keeps auth off. Never read from / written to SQLite (README §9.1).
   */
  export function resolveApiToken(args: CliArgs): string | undefined;
  ```
  - Effectively `(args.apiToken ?? process.env.FLEET_API_TOKEN)?.trim() || undefined`.
  - **Not** threaded through `buildOrchestrator` — the token gates the transport, not the
    orchestrator. It is resolved and applied in `serve.ts`. `buildOrchestrator`'s signature and
    return shape are unchanged.

### `src/serve.ts`

- After `buildOrchestrator(args)`, at `createApiServer`:
  ```ts
  const apiToken = resolveApiToken(args);
  const server = createApiServer(orchestrator, apiToken ? { apiToken } : {});
  ```
  (Pass `{}` when unset so the existing default behaviour and `DEFAULT_PUBLIC_DIR` are untouched.)
- Boot banner: add **one** line stating whether auth is on or off. **Never print the token.** e.g.
  `  auth: API token required (all routes except /health)` vs
  `  auth: OFF — API is open (localhost only). Set FLEET_API_TOKEN to require a token.`
- `listen()` keeps binding `127.0.0.1` (off-loopback binding is the separate networking issue #16).
  Optionally soften its comment to note auth now exists but the bind is still loopback pending #16 —
  no behavioural change.

---

## Module 4 — Dashboard client (`dashboard/`)

### `dashboard/src/lib/auth.ts` (NEW, small, testable)

`localStorage`-backed token storage + a pure URL helper.

```ts
const STORAGE_KEY = 'fleet_api_token';

export function getToken(): string | null;           // localStorage[STORAGE_KEY] || null
export function setToken(token: string): void;        // trims; empty ⇒ clearToken()
export function clearToken(): void;                   // removes the key

/** Append `?token=<stored>` to a same-origin path for the SSE URL (EventSource can't set headers).
 *  No token stored ⇒ returns `path` unchanged. Preserves any existing query string (uses `&` vs `?`).
 *  Pure/deterministic given the token arg for unit testing. */
export function withToken(path: string, token?: string | null): string;
```

- `withToken` uses the passed `token` when provided, else `getToken()`; encodes via
  `encodeURIComponent`. Assertions the test can pin:
  - `withToken('/stream', 'abc') === '/stream?token=abc'`
  - `withToken('/stream?runId=1', 'a b') === '/stream?runId=1&token=a%20b'`
  - `withToken('/stream', null) === '/stream'`

### `dashboard/src/lib/api.ts` — attach header + detect 401

- `request()` attaches `Authorization: Bearer <token>` when a token is stored (`getToken()`), in
  addition to the existing `Content-Type` header on body requests. Build one `headers` object so the
  bearer header never clobbers `Content-Type`.
- On an HTTP `401` response, throw a **recognizable** error so the store can flag the auth-required
  state (rather than an anonymous `Error`). Implementer's choice, but be consistent and importable
  from `store.svelte.ts`:
  - `export class AuthError extends Error {}` thrown when `res.status === 401`, **or**
  - an attached discriminator (e.g. `err.status = 401`) the store checks.

### `dashboard/src/lib/store.svelte.ts`

- Add to the `ui` `$state`: `authRequired: false` (boolean). True ⇒ show the token prompt.
- Central handling: on catching an `AuthError`/`401` from any mount-load (`loadConfig`, `loadRuns`,
  …) or action, set `ui.authRequired = true`. Keep this in **one** place (a small wrapper, or the
  `App.svelte` `onMount` catch that inspects the error kind).
- `connectStream()` builds the `EventSource` URL via `withToken('/stream')` so the stream carries the
  token as `?token=`. Documented in code: `EventSource` can't read the HTTP status, so an SSE `401`
  only surfaces as `onerror` → `ui.conn = 'off'`; the fetch mount-loads surface the `401` first and
  drive the prompt, so this is acceptable.
- Re-auth flow helper:
  ```ts
  export async function authenticate(token: string): Promise<void>;
  ```
  `setToken(token)` → clear `ui.authRequired` → re-run the mount loads
  (`loadConfig`/`loadRuns`/`loadRepos`/`loadCost`/`loadModels`/`loadSettings`) → `connectStream()`
  (reconnect with the token). On a fresh `401`, re-set `ui.authRequired`. Also expose a sign-out
  path (`clearToken()` + `ui.authRequired = true`).

### `dashboard/src/App.svelte` (+ optional `TokenPrompt.svelte`)

- When `ui.authRequired`, render a minimal overlay/banner with a token input; submit →
  `authenticate(token)`. Also allow clearing/replacing the token.
- The overlay must render even though data loads failed (independent of `ui.runs` etc.), since the
  static SPA is served open. The existing `onMount` chain (`loadConfig` → … → `connectStream`) must
  route a `401` into `ui.authRequired` rather than just a generic "Failed to load" banner.

### Dev proxy — `dashboard/vite.config.ts`

- **No change required.** Vite's proxy forwards query params and the `Authorization` header by
  default; `/stream` is already proxied.

---

## Module 5 — Docs & tree hygiene

- `.env.example`: add `FLEET_API_TOKEN=` with a comment — absent/blank ⇒ auth disabled
  (localhost-only default); set ⇒ all API + SSE routes require `Authorization: Bearer <token>` or
  `?token=`; `/health` and static assets stay open.
- `README.md` §9 (serve daemon) + §9.1 (secrets): document the env var, that it is env-only (never
  SQLite), how clients authenticate (Bearer header; `?token=` for SSE/`EventSource`), that `/health`
  and the static SPA stay open, and that the loopback bind is unchanged pending #16.
- **Tree hygiene:** no new runtime deps (`node:crypto` is built in) ⇒ no lockfile churn; no build
  output committed. Revert any incidental `package-lock.json` changes.

---

## Data shapes / contracts summary

| Concern | Shape |
| --- | --- |
| Auth-off | `apiToken` absent/`''` ⇒ gate skipped; all routes behave as today |
| 401 body | `{ "error": "authentication required" \| "invalid token" }`, HTTP `401` |
| Credential (fetch) | `Authorization: Bearer <token>` header |
| Credential (SSE) | `?token=<token>` query param on `/stream` |
| Open routes | `GET /health`, static/SPA assets |
| Token source | `--api-token` flag → `FLEET_API_TOKEN` env → disabled (never SQLite) |
| Comparison | SHA-256 digest + `timingSafeEqual` (constant-time, length-hiding) |

## Testing contract (what tdd writes against)

**`src/api/auth.test.ts` (unit):**
- `tokenMatches`: exact match → `true`; wrong value → `false`; `undefined`/`''` provided → `false`;
  a prefix and a superset of the correct token → `false`.
- `extractToken`: reads `Authorization: Bearer <t>` (case-insensitive scheme); falls back to
  `?token=`; header takes precedence over query when both present; returns `undefined` when neither
  present / malformed header / non-string header.
- `requiresAuth`: `true` for **each** API prefix in the allowlist (and a `/runs/5` sub-path);
  `false` for `/health`, `/`, `/pipelines`, `/assets/app.js`.

**`src/api/server.test.ts` (integration — extend the `start()` helper to accept an optional
`apiToken` and pass it into `createApiServer(orchestrator, { apiToken, publicDir })`):**
- *auth-off passthrough* — no token configured: a normal route (`GET /runs`) and `GET /stream`
  succeed (existing behaviour preserved).
- *auth-on normal route* — `GET /runs`: no token → `401`; wrong token → `401`; correct
  `Authorization: Bearer <t>` → `200`.
- *auth-on `/stream`* — no token → `401`; `?token=<correct>` → `200` + `Content-Type:
  text/event-stream`.
- *`/health` open* — `200` with auth on and no token supplied.

**`dashboard/src/lib/auth.test.ts` (unit, preferred):** `withToken` appends `?token=` / `&token=`,
encodes special chars, and returns the path unchanged with no token; `setToken('')` clears.

**End-to-end (verify stage):** a token-protected daemon (`FLEET_API_TOKEN=…`) — the dashboard
prompts, authenticates, loads data, and the live stream connects; `npm test` + lint green.

## Explicit non-goals (out of scope — do not build)

- Multi-user / RBAC (README §1).
- TLS / tunneling / off-loopback binding (issue #16 — `listen()` stays `127.0.0.1`).
- Session cookies / WebSocket upgrade for SSE auth (the `?token=` query param is the sanctioned KISS
  path; cookies explicitly not added).
- The hardening review (its own issue).
