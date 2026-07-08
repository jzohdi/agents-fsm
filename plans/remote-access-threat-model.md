# Remote-access threat model — the exposed HTTP/SSE surface (issue #27)

Once the daemon can be authenticated (issue #25) and bound off-localhost (issue #26), its HTTP + SSE
surface is actually reachable by something other than a local process. This document is the hardening
review that issue #27 asked for: the trust boundary, what an off-localhost attacker can and cannot do,
and the per-gap disposition (fixed-with-test or deferred-with-rationale).

It is deliberately scoped to the threats that **only matter once the surface is exposed**. The
loopback-only default is unchanged, and everything here is either universal-and-cheap or defaulted so a
normal local session is byte-for-byte unaffected.

## Trust boundary

The daemon is a single headless process (`src/serve.ts`) exposing:

- an HTTP command API and an SSE live stream (`src/api/server.ts`), and
- the built dashboard as static assets (`src/api/static.ts`).

The **trust boundary** is the network socket. Inside it: the operator's machine, `GITHUB_TOKEN` /
`ANTHROPIC_API_KEY` in the process environment, the SQLite state, and the working trees. Outside it,
once bound off-localhost: anyone who can reach the socket — with or without the shared API token.

Two attacker profiles:

1. **Unauthenticated off-localhost attacker** — can reach the socket but does not hold the token.
2. **Token-bearing client** — holds the shared bearer token (e.g. the operator's phone, or a leaked
   token). By design there is one shared token; multi-user/RBAC is out of scope (README §1).

## What an off-localhost attacker **can** do

- **Reach `/health`** (open by design — liveness probes) and **fetch the SPA shell / static assets**
  (the dashboard must load before it can prompt for a token). No state, no secrets.
- **Attempt authentication.** The token is compared in constant time (`tokenMatches` → SHA-256 +
  `timingSafeEqual`, `src/api/auth.ts`), so there is no timing oracle and no length leak. A wrong token
  is a `401` whose body never echoes the attempt or the real token.
- **With a valid token: drive the API** — exactly the surface the operator can. The token *is* the
  authority; protect it accordingly (rotate on suspicion — see below).

## What an off-localhost attacker **cannot** do

- **Drive the API without the token.** Every `requiresAuth(path)` route requires a valid credential
  when a token is configured; the bind guard (`checkBindAllowed`) refuses a non-loopback bind unless a
  token is set, so an exposed daemon is never tokenless.
- **Read back a secret.** `GET /config` returns only `{ fsm, agents, version }`. `GITHUB_TOKEN` /
  `ANTHROPIC_API_KEY` are env-only — they never enter `LoadedConfig`, a `Run` record, a `StreamEvent`
  frame, or any orchestrator return value. *(Pinned: a test asserts neither a `GET /config` body nor an
  SSE frame contains the sentinels.)*
- **Traverse the filesystem via static paths.** `resolveStaticPath` decodes, strips leading slashes,
  resolves, and asserts the result is the base dir or strictly within it (`base + sep`). Backslash
  separators, embedded NUL bytes, doubly-encoded traversal, absolute-path smuggling, and sibling-prefix
  escapes (`…/publicXYZ`) all resolve to `null` or stay confined. *(Pinned with regression tests.)*
- **Flood the daemon cheaply.** Mutating/expensive routes (`POST`/`PUT`/`DELETE`) are rate-limited by a
  per-source token bucket; past the burst they get `429` + `Retry-After`. *(Fixed with a test.)*
- **Exhaust memory with a giant body.** `readJson` caps the cumulative bytes read and throws `413`
  before an unbounded payload lands in memory. *(Fixed with a test.)*
- **Clickjack / frame the SPA.** `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`.
- **Read cross-origin API responses.** No permissive `Access-Control-Allow-Origin` is ever emitted; the
  default is deny-all, and even an allow-list is exact-match (never `*`). *(Fixed with a test.)*
- **Ride an ambient credential (classic CSRF).** Auth is a bearer token in the `Authorization` header
  (or `?token=` for SSE) — **never a cookie**. There is no ambient credential a cross-site page can force
  the browser to attach, so classic CSRF does not apply. A locked-down ACAO + no-cookie auth means a
  malicious page can neither read responses nor ride a credential.
- **Learn internal detail from an error.** A non-`ApiError` throw is sanitized to a generic
  `500 { error: 'internal server error' }`; the real error is logged server-side only. No stack trace,
  raw message, or filesystem path reaches a remote caller. *(Fixed with a test.)*

## Per-gap disposition

| Scope item (issue #27) | Disposition |
|------------------------|-------------|
| Rate limiting / abuse on mutating routes | **Fixed + test** — per-source token bucket (`src/api/rate-limit.ts`); `429` + `Retry-After`; `GET`/SSE/`/health` never throttled. |
| Request-body size cap | **Fixed + test** — `readJson` caps bytes → `413` (default 1 MiB, configurable). |
| CSRF / cross-origin | **Fixed + test** — deny-all CORS by default, exact-match allow-list, never `*`; bearer-token (non-cookie) auth ⇒ classic CSRF N/A. |
| Input validation / path params | **Confirmed + test** — path params are integer-guarded (`/^\/runs\/(\d+)\/…$/`); malformed JSON → `400`; oversized → `413`. |
| Static path-traversal guard | **Confirmed + regression tests** — `resolveStaticPath` holds under the trickier remote vectors. |
| Security headers | **Fixed + test** — `nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer` on every response; CSP on the SPA document. |
| Error info leakage | **Fixed + test** — generic `500`, real error logged server-side only. |
| Token handling (logs/SSE/errors) | **Confirmed + test** — token never in a response/error body, SSE frame, or log line. |
| Secrets exposure | **Confirmed + test** — no route or frame returns `GITHUB_TOKEN` / `ANTHROPIC_API_KEY` / the API token. |
| Multi-user / RBAC / audit | **Deferred (out of scope)** — one shared token by design (README §1). |
| `X-Forwarded-For`-aware limiting | **Deferred** — spoofable; the per-source-IP bucket is a coarse backstop. A future opt-in behind a trusted proxy. |
| HSTS | **Deferred (by design)** — TLS may be terminated by a tunnel/proxy; HSTS is the terminator's responsibility, not the app's. |

## Documented residuals

- **Rate limiting is per-source-IP.** Behind a shared-IP tunnel/proxy, all clients collapse into one
  bucket — it is an abuse backstop, not a fairness mechanism. `X-Forwarded-For` is deliberately not
  trusted (spoofable).
- **HSTS is the TLS terminator's job.** The daemon does not emit `Strict-Transport-Security`; a tunnel
  or reverse proxy that terminates TLS should.
- **CSP permits Google Fonts.** The SPA shell pulls a remote font stylesheet + font files
  (`fonts.googleapis.com` / `fonts.gstatic.com`), so `style-src`/`font-src` allow exactly those origins.
  Losing the remote font is acceptable graceful degradation; a blanked dashboard is not.

## Token rotation

There is a single shared token by design. To rotate it, **restart the daemon with a new
`FLEET_API_TOKEN`** (or `--api-token`). Every dashboard client re-prompts on the next `401` and stores
the new value. The token is env-only — never persisted to SQLite, and never written to a log line, an
SSE frame, or an error body.
