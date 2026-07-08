# Plan — Remote access: hardening review of the now-exposed API surface (#27)

## Goal (restated)

The daemon can now be authenticated (issue #25, `src/api/auth.ts`) and bound off-localhost
(issue #26, `src/api/bind-guard.ts` — both merged via PR #30). Now that the HTTP/SSE surface is
actually *exposable*, review and harden it against the threats that only matter once it is no longer
loopback-only, and ship the concrete fixes for the real gaps — each with a test. Deliver a short
threat-model write-up describing what an off-localhost attacker can and cannot do.

This is a **review + targeted fixes** issue, not a rewrite. Existing localhost behaviour and tests
must stay green; auth-off (loopback default) must remain byte-for-byte unchanged where practical.

## Current surface (grounded in the code today)

- **`src/api/server.ts`** — the whole HTTP/SSE surface. A thin adapter over `Orchestrator`, built on
  Node's `http`/`https` (no framework). `handle()` runs the auth gate first (when a token is set),
  then dispatches routes. Response helpers: `sendJson`, `sendError`, `readJson`, `str`, `optStr`.
  `streamSse()` is the long-lived SSE endpoint.
- **`src/api/auth.ts`** — constant-time token compare (`tokenMatches` via SHA-256 + `timingSafeEqual`),
  `extractToken` (Bearer header or `?token=` for SSE), `requiresAuth` prefix allowlist (`API_PREFIXES`).
  `/health` + static/SPA paths are intentionally open.
- **`src/api/static.ts`** — `resolveStaticPath` path-traversal guard (decode → strip leading slashes →
  `resolve` → assert `target === base || target.startsWith(base + sep)`), content-type map, SPA
  fallback. This is the only defense against `GET /../../etc/passwd`.
- **`src/api/stream.ts`** — in-process `Broadcaster`; SSE frames serialize `StreamEvent` (`transition`
  carries a full `Run`, `activity` a `PhaseActivity`, `status`, `chat`).
- **`src/serve.ts`** — boots config/token/bind-guard/TLS, then `createApiServer`. Prints the banner.
- **`src/api/orchestrator.ts`** — `getConfig()` returns `LoadedConfig` = `{ fsm, agents, version }`
  (verified: **no secrets**). `ApiError(status, message)` is the only typed HTTP error.

### Gaps found by the review (what this issue fixes)

1. **No rate limiting / abuse control.** Every route is unthrottled. An exposed daemon can be flooded
   on expensive/mutating routes (`POST /runs` starts real harness work; the control-plane mutations
   and the on-demand poll routes — `check-pr-feedback`, `check-reply`, `advise`, `scheduler/check` —
   trigger real work / GitHub calls). No `429` path exists.
2. **No request-body size cap.** `readJson()` (server.ts:417) concatenates the entire request body
   into memory with **no limit** — an unbounded-payload memory-exhaustion DoS. Only matters once
   remote clients can reach it.
3. **500 responses echo internal messages.** `sendError()` (server.ts:406) sends `err.message` for
   *any* thrown error. `ApiError` messages are intentionally client-facing, but a non-`ApiError`
   (a bug, an I/O error) leaks its raw `.message` — which can contain absolute filesystem paths or
   internal detail — to a remote caller. (Stack traces are *not* sent — only `.message` — but the
   message itself is the leak.)
4. **No security response headers.** No `X-Content-Type-Options: nosniff`, no `X-Frame-Options` /
   frame-ancestors, no CSP for the SPA, no `Referrer-Policy`. The dashboard holds a token in memory;
   clickjacking / MIME-sniff / referrer-leak protections are absent.
5. **No explicit CORS / cross-origin policy.** No `Access-Control-Allow-Origin` header is ever set.
   Today that means the browser blocks cross-origin *reads* of API responses by default (a safe
   default), but the posture is implicit and undocumented, and cross-origin *writes* (simple requests)
   still reach the handler. The threat model must state the policy explicitly and lock it down.

### Non-gaps to confirm (and pin with tests so they stay non-gaps)

- **CSRF is largely N/A** — auth is a bearer token in the `Authorization` header or `?token=` query
  param, **never a cookie**. There is no ambient/implicit credential a cross-site page can force the
  browser to attach, so classic CSRF (the attacker riding the victim's cookie) does not apply. Worth
  documenting explicitly; worth a guard against the one residual vector (see §CORS decision below).
- **No secret is readable back.** `GITHUB_TOKEN` / `ANTHROPIC_API_KEY` are env-only; they never enter
  `LoadedConfig`, the `Run` record, `StreamEvent` frames, or any orchestrator return value. `GET
  /config` returns only `{ fsm, agents, version }`. Pin this with a test asserting no route body /
  SSE frame contains these values.
- **Token never lands in logs / SSE / error bodies.** `serve.ts` prints only that auth is *on*, never
  the token; `tokenMatches` doesn't log; SSE frames carry `Run`/activity data, not the token. Pin
  with a test.
- **Path params are integer-guarded** (`/^\/runs\/(\d+)\/…$/`) — no injection surface there.
- **`resolveStaticPath` traversal guard** already covers `..`, encoded traversal, and sibling-prefix
  escapes; re-verify under remote exposure and add any missing edge case (e.g. backslash, NUL byte).

## Approach & architecture

Keep the KISS, no-framework, pure-helper-plus-thin-adapter shape the surface already uses. Each fix
is a small, independently-testable unit wired into `handle()` / the response helpers. No new runtime
dependencies.

### 1. Rate limiting — `src/api/rate-limit.ts` (new, pure)

A tiny in-process **token-bucket / fixed-window** limiter, pure and unit-testable in the `auth.ts` /
`bind-guard.ts` precedent (no `node:http`, no timers-of-its-own for the core decision — pass `now` in).

- `createRateLimiter({ capacity, refillPerSec })` → `{ check(key, now): { ok: true } | { ok: false;
  retryAfterSec } }`. Keyed by client identity.
- **Client key**: the remote socket address (`req.socket.remoteAddress`). Behind a tunnel/proxy all
  clients may share one address — document that limits are per-source-IP and are an abuse backstop,
  not a fairness mechanism. (Do **not** trust `X-Forwarded-For` by default — spoofable; note it as a
  future opt-in.)
- **Scope**: apply to *mutating + expensive* routes only — `POST`/`PUT`/`DELETE` and the on-demand
  poll/advise routes. Cheap `GET`s and the SSE stream stay unthrottled (the dashboard polls them).
  `/health` is never limited (liveness probes).
- On exceed: `429` with a `Retry-After` header and a JSON `{ error }` body. Add a `429` branch to the
  error path. Limits are configurable via env/CLI with safe defaults (e.g. capacity 60, refill 1/s);
  default generous enough that the local dashboard never trips it.
- Bound memory: evict idle buckets (lazy sweep on access, or a capped Map) so the limiter can't be
  used to grow memory itself.

### 2. Body-size cap — in `readJson()` (server.ts)

Track cumulative bytes while consuming `req`; once the total exceeds a cap (e.g. 1 MiB, configurable),
stop reading and throw `ApiError(413, 'request body too large')`. Add `413` to the error mapping.
Preserves the empty-body → `{}` and malformed-JSON → `400` behaviour.

### 3. Error-response sanitization — in `sendError()` (server.ts)

Only surface `err.message` for `ApiError` (those are deliberately client-facing). For any other error:
respond `500` with a generic body (`{ error: 'internal server error' }`) and log the real error
**server-side only** (with a short id/label so an operator can correlate). No internal paths or raw
messages reach a remote caller. Keep `ApiError` messages verbatim (they're the API contract).

### 4. Security headers — `src/api/security-headers.ts` (new, pure) applied to every response

A single helper returning the baseline header set, applied in `sendJson`, `sendError`, the static
handler, and the SSE `writeHead`:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` (and `frame-ancestors 'none'` via CSP) — the dashboard is not meant to be
  framed.
- `Referrer-Policy: no-referrer`
- **CSP for the SPA** (on HTML/static responses): `default-src 'self'`; `connect-src 'self'` (same-origin
  API + SSE); `img-src 'self' data:`; `style-src 'self' 'unsafe-inline'` (Vite-built styles);
  `script-src 'self'`; `frame-ancestors 'none'`; `base-uri 'none'`. **Risk/verification:** confirm the
  built dashboard (`dashboard/dist/index.html`) loads under this CSP — if the Vite build emits an
  inline bootstrap script or inline module preload, relax `script-src` minimally (prefer hashing over
  `'unsafe-inline'`) or adjust the build. This must be checked against the actual built asset before
  finalizing the policy (keeps this a backend/header change, not a frontend rewrite — see scope note).
- Do **not** set HSTS from the app (TLS may be terminated by a tunnel/proxy; HSTS is the terminator's
  job) — document that in the threat model.

### 5. CORS decision — explicit deny by default, in `handle()`

- Keep the safe implicit default explicit: **do not** emit a permissive `Access-Control-Allow-Origin`.
  Default policy = same-origin only (the dashboard is served by the same daemon, so it needs no CORS
  grant).
- Add a minimal `OPTIONS` preflight responder that returns the restrictive policy (no wildcard ACAO),
  so cross-origin callers get a clear, locked-down answer instead of falling through to the SPA/404.
- Optionally accept a configurable allow-list of origins (env/CLI) for operators who deliberately host
  the SPA elsewhere — default empty (deny all cross-origin). Document the residual: because auth is a
  bearer token (not a cookie), a locked-down ACAO plus no-cookie auth means a malicious page cannot
  read responses *or* ride an ambient credential.

### 6. Threat-model write-up — `plans/remote-access-threat-model.md` (new)

Short, concrete: the exposed surface, the trust boundary (off-localhost attacker with/without the
token), what they **can** do (reach `/health`, the SPA shell, attempt auth — constant-time), what they
**cannot** do (drive the API without the token, read secrets, traverse the filesystem, flood past the
rate limit, exhaust memory via body size, clickjack the SPA), the per-gap disposition (fixed-with-test
vs. explicitly-deferred-with-rationale), and **token rotation** (restart the daemon with a new
`FLEET_API_TOKEN`; there is one shared token by design — multi-user/RBAC is out of scope per README §1).
Add a brief pointer + the rotation note to README §9.11 so the operating guide stays the entry point.

## Files to change

- **New:** `src/api/rate-limit.ts` (+ `rate-limit.test.ts`) — pure token-bucket limiter.
- **New:** `src/api/security-headers.ts` (+ `security-headers.test.ts`) — baseline header set + CSP.
- **New:** `plans/remote-access-threat-model.md` — the write-up.
- **Edit:** `src/api/server.ts` — wire in the limiter (mutating/expensive routes → `429`), body-size
  cap in `readJson` (`413`), sanitize `sendError` (generic `500`), apply security headers in
  `sendJson`/`sendError`/`streamSse`, add the `OPTIONS`/CORS-deny branch. Extend the error status map.
- **Edit:** `src/api/static.ts` — apply security headers (incl. CSP) to static/SPA + `404` responses;
  re-verify `resolveStaticPath` and add any missing traversal edge-case test.
- **Edit:** `src/serve.ts` — resolve rate-limit + body-size + CORS-origin config (env/CLI) and pass
  through to `createApiServer`; extend `ApiServerOptions`. Keep the banner honest (mention limits are
  active). No change to the bind-guard/auth boot order.
- **Edit (config plumbing):** `src/cli-args.ts` / `src/build-runner.ts` — new optional flags/env for
  the limiter caps, max body size, and CORS allow-list (all with safe defaults; omitting them = the
  hardened default). Follow the `resolveApiToken` / `resolveHost` precedent.
- **Edit:** `README.md` §9.11 — pointer to the threat model + rotation note + the new knobs.

## Risks & edge cases

- **CSP breaking the SPA** — the main risk. Must be validated against the *built* dashboard asset; a
  too-strict `script-src`/`style-src` blanks the dashboard. Mitigation: verify against
  `dashboard/dist`, prefer hashes, fall back to minimal `'unsafe-inline'` for styles only. If the CSP
  cannot be satisfied without touching Svelte/build code, that would pull frontend into scope — flag
  it back rather than loosening to `*`.
- **Rate limiter false-positives** — the local dashboard polls several `GET`s; keep `GET`s unthrottled
  and defaults generous so a normal operator never hits `429`. Behind a shared-IP tunnel, all clients
  collapse to one bucket — document this as a coarse backstop, not fairness.
- **Auth-off / loopback default must stay unchanged** — headers and body-cap apply universally (fine),
  but rate limiting and CORS should not change the local single-user experience. Defaults must be a
  no-op for a normal localhost session.
- **SSE + headers** — set security headers alongside the existing `text/event-stream` headers in
  `streamSse`'s `writeHead`; don't disturb `Cache-Control: no-cache` / `Connection: keep-alive`.
- **`Retry-After` + `413`/`429` must not leak internals** — generic messages only.
- **Do not touch `src/fsm/`** (project rule) — none of this requires it.
- Keep the working tree clean: no build output, no coverage, no lockfile churn.

## How it will be tested

Follow the existing `server.test.ts` pattern (drive the real server over an ephemeral port with
`fetch`, stub executor + fake GitHub) plus pure unit tests for the new helpers (the `auth.test.ts` /
`bind-guard.test.ts` precedent):

- **rate-limit.test.ts** — bucket allows up to capacity, refills over time, `429` + `retryAfterSec`
  on exceed, independent keys are independent, idle-bucket eviction bounds memory.
- **security-headers.test.ts** — the baseline set is present; CSP string is well-formed and includes
  `frame-ancestors 'none'` / `default-src 'self'`.
- **server.test.ts additions** — mutating route past the limit → `429` with `Retry-After`; oversized
  body → `413`; a forced internal (non-`ApiError`) failure → `500` with a generic body (no path / raw
  message leak); every response (JSON, static, SSE, 404) carries the security headers; `OPTIONS`
  cross-origin → locked-down (no wildcard ACAO); GET `/config` and an SSE frame contain **no**
  `GITHUB_TOKEN`/`ANTHROPIC_API_KEY`/token value; token never appears in any error body.
- **static.test.ts additions** — headers on static + 404 + SPA-fallback responses; extra traversal
  edge cases hold.
- Full `npm test` + `npm run lint` + `npm run typecheck` green (existing localhost behaviour intact).

## Scope flags

- **needs_backend: true** — all fixes live in the HTTP/SSE server, its pure helpers, config plumbing,
  and docs.
- **needs_frontend: false** — the change is server-emitted headers + server-side limits + a doc; no
  Svelte/dashboard source changes are planned. The CSP is validated against the *already-built*
  dashboard asset; only if the built SPA cannot load under a reasonable CSP without editing dashboard
  source would frontend enter scope — called out as a risk to surface, not to silently absorb.
