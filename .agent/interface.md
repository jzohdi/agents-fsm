# Interface — Remote access: hardening the exposed API surface (#27)

Contracts the TDD stage writes failing tests against and the implementation stages satisfy. This is a
**review + targeted fixes** issue: keep the KISS, no-framework, pure-helper-plus-thin-adapter shape the
surface already uses (`auth.ts` / `bind-guard.ts` / `static.ts` precedent). **No new runtime
dependencies. Do not touch `src/fsm/`.**

The overriding invariant: the **auth-off / loopback default must stay byte-for-byte the same observable
behaviour** for a normal localhost operator. Every new control here is either universal-and-cheap
(security headers, body cap, error sanitization) or defaulted-generous enough that a single local
dashboard never trips it (rate limiting, CORS deny).

---

## 1. Rate limiter — `src/api/rate-limit.ts` (new, pure)

A tiny in-process token-bucket limiter. Pure and unit-testable — **no `node:http`, no timers, no
`Date.now()` of its own**; the caller passes `now` in (the `auth.ts` injection precedent).

```ts
/** The verdict for one request. `retryAfterSec` is present (an integer ≥ 1) iff `ok === false`. */
export interface RateLimitDecision {
  ok: boolean;
  retryAfterSec?: number;
}

export interface RateLimiterOptions {
  /** Bucket capacity = max burst before throttling. Must be ≥ 1. */
  capacity: number;
  /** Tokens replenished per second (fractional allowed, e.g. 1 = one per second). Must be > 0. */
  refillPerSec: number;
  /**
   * Evict a bucket untouched for at least this long (ms) on the next `check()` (lazy sweep), so an
   * attacker cycling source IPs can't grow the map unboundedly. Default ≈ 10 min.
   */
  idleEvictMs?: number;
  /**
   * Hard cap on simultaneously-tracked buckets (memory backstop). On overflow, evict the
   * least-recently-seen. Default ≈ 10_000.
   */
  maxKeys?: number;
}

export interface RateLimiter {
  /** Consume one token for `key` at time `now` (epoch ms). Returns allow/deny + retry hint. */
  check(key: string, now: number): RateLimitDecision;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter;
```

**Semantics / invariants**

- Each `key` starts full (`capacity` tokens). `check` refills based on elapsed time since that key's
  last `check` (`refillPerSec * elapsedSec`, clamped to `capacity`), then consumes one token.
- `ok: true` while tokens ≥ 1 (i.e. the first `capacity` rapid calls succeed); after that `ok: false`
  with `retryAfterSec = ceil((1 − tokens) / refillPerSec)` — always an integer ≥ 1.
- Tokens never exceed `capacity` and never go negative.
- Distinct keys are fully independent.
- Waiting long enough fully restores a throttled key (a later `now` yields `ok: true` again).
- `now` is monotonic per the server's clock; a non-increasing `now` must not increase available tokens
  (never a negative-elapsed refill).
- Memory is bounded: idle keys are evicted after `idleEvictMs`; the live set never exceeds `maxKeys`.
  Eviction must not affect the decision for an active key.

---

## 2. Security response headers + CORS — `src/api/security-headers.ts` (new, pure)

Pure header-policy helpers, applied by the transport. No `node:http` coupling.

```ts
/**
 * Baseline security headers applied to EVERY response (JSON, static asset, SSE, 404, error). These do
 * not vary by route and are safe for any content type.
 */
export function securityHeaders(): Record<string, string>;

/**
 * The Content-Security-Policy header value for HTML/SPA document responses only (added on top of the
 * baseline by the static handler when it serves `text/html`). Not applied to JSON/SSE.
 */
export const CONTENT_SECURITY_POLICY: string;

/**
 * Cross-origin response headers for a request's `Origin`. Returns the ACAO/allow-* set ONLY when
 * `origin` is a non-empty exact member of `allowedOrigins`; otherwise returns `{}` (deny — no ACAO,
 * so a browser blocks the cross-origin read). Never emits a `*` wildcard. Always include
 * `Vary: Origin` in the header set it returns so caches don't cross-serve.
 */
export function corsHeaders(origin: string | undefined, allowedOrigins: readonly string[]): Record<string, string>;
```

**`securityHeaders()` — required entries (exact names; values as noted):**

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- (Do **not** set HSTS — TLS may be terminated by a tunnel/proxy; that's the terminator's job.
  Documented in the threat model.)

**`CONTENT_SECURITY_POLICY` — required invariants (the string must contain, at minimum):**

- `default-src 'self'`
- `frame-ancestors 'none'` (clickjacking defense, pairs with `X-Frame-Options`)
- `base-uri 'none'`
- `object-src 'none'`
- `script-src 'self'` (the built SPA loads a hashed module bundle from same-origin — no inline script)
- `connect-src 'self'` (same-origin API + SSE)
- `img-src 'self' data:` (the favicon is a `data:` URI)

> **CSP ↔ built-dashboard reality (verified against `dashboard/index.html`, the Vite source — the
> `dist/` bundle is gitignored/not built in this tree).** The SPA shell pulls **Google Fonts**:
> `<link href="https://fonts.googleapis.com/…" rel="stylesheet">` plus font files from
> `https://fonts.gstatic.com`, and Svelte/Vite emit component styles. To avoid blanking styling under
> CSP, the policy MUST also permit:
> - `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` (Vite/Svelte inject styles; the
>   fonts stylesheet is remote),
> - `font-src 'self' https://fonts.gstatic.com`.
>
> The implementation MUST verify the CSP against the actual built asset (`npm run build:dashboard` →
> `dashboard/dist/index.html`) before finalizing, and prefer hashes over `'unsafe-inline'` for
> `script-src` if the Vite build turns out to emit an inline bootstrap/module-preload script. **If the
> SPA cannot load under a reasonable CSP without editing Svelte/build source, do not loosen to `*` —
> surface it back** (that would pull frontend into scope; this stage is `needs_frontend: false`). Losing
> the remote font is acceptable graceful degradation; a blanked dashboard is not.

**`corsHeaders` invariants:** allowed origin → `Access-Control-Allow-Origin: <origin>` (echoed exactly,
never `*`), `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers: Authorization, Content-Type`,
and `Vary: Origin`. Disallowed/absent origin → no ACAO at all. `allowedOrigins` empty (the default) ⇒
every cross-origin request is denied.

---

## 3. `src/api/server.ts` — wiring the fixes into the transport

### 3.1 `ApiServerOptions` extension (additive, all optional; omit ⇒ hardened defaults)

```ts
export interface ApiServerOptions {
  publicDir?: string;                       // unchanged
  apiToken?: string;                        // unchanged
  tls?: { cert: string; key: string };      // unchanged
  // --- NEW (#27) ---
  /** Token-bucket config for mutating/expensive routes. Omit ⇒ a generous built-in default
   *  (e.g. capacity 60, refillPerSec 1) that a normal local dashboard never trips. */
  rateLimit?: { capacity: number; refillPerSec: number };
  /** Max request-body bytes before `413`. Omit ⇒ default 1 MiB (1_048_576). */
  maxBodyBytes?: number;
  /** Exact-match CORS allow-list. Omit/empty ⇒ deny all cross-origin (the default). */
  allowedOrigins?: string[];
  /** Injectable clock (epoch ms) for the rate limiter, for deterministic tests. Omit ⇒ `Date.now`. */
  now?: () => number;
}
```

`createApiServer` builds one `RateLimiter` from `rateLimit` (or the default) and holds it for the
server's lifetime; the same instance is shared across all requests (per-process, per-source-key state).

### 3.2 Request pipeline order inside `handle()`

The gate order is a contract (each step happens before the next):

1. **Security headers** — applied to *every* response, including errors and 404s, via the response
   helpers (§3.4) and the SSE `writeHead` (§3.6) and the static handler (§4). Universal.
2. **CORS / OPTIONS** — if `method === 'OPTIONS'`: respond `204 No Content` with `corsHeaders(origin,
   allowedOrigins)` + the baseline security headers + `Access-Control-Max-Age`, and return (never falls
   through to the SPA/404). For non-OPTIONS requests, `corsHeaders(...)` is merged into the response so
   an allowed origin can read the body; a disallowed origin still gets no ACAO. Emitting CORS does not
   bypass auth.
3. **Auth gate** — unchanged (`requiresAuth(path)` + `tokenMatches`). Still first among
   *authorization* checks, still skipped entirely when `apiToken` is unset.
4. **Rate limit** — for **rate-limited routes only** (see predicate below): compute the client key,
   `limiter.check(key, now())`; on `ok: false` respond `429` (§3.5) and return. Applied *after* auth so
   an unauthenticated flood still gets `401` (cheap) — but the limiter is also consulted so auth itself
   can't be brute-forced unboundedly (a `401` on a limited route still consumes a token). Order:
   auth-fail short-circuits to `401`; a rate-limited *authenticated* request that exceeds gets `429`.
   > Simpler acceptable equivalent: run the rate-limit check immediately before dispatch for limited
   > routes (after the auth gate). The observable contract is: an authenticated client exceeding the
   > limit on a mutating route gets `429`; `/health` and cheap `GET`s never get `429`.
5. **Dispatch** — the existing route table, unchanged.

**Rate-limited-route predicate** (pure, e.g. `isRateLimited(method, path)`):

- Limit every **mutating/expensive** request: `method` ∈ {`POST`, `PUT`, `DELETE`, `PATCH`}. This
  covers `POST /runs`, all control-plane mutations, and the on-demand poll/advise routes
  (`check-pr-feedback`, `check-reply`, `advise`, `scheduler/check`) — all POST.
- **Never** limit: `GET` (incl. `GET /stream` SSE and the dashboard's polling GETs), `HEAD`,
  `OPTIONS`, and **`/health`** regardless of method (liveness probes).

**Client key:** `req.socket.remoteAddress ?? 'unknown'`. Document (threat model + code comment) that
this is per-source-IP and a coarse abuse backstop — behind a shared-IP tunnel/proxy all clients collapse
to one bucket. **Do not trust `X-Forwarded-For`** (spoofable); note it as a future opt-in only.

### 3.3 Body-size cap — `readJson(req, maxBytes)`

```ts
async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>>;
```

- Track cumulative bytes while consuming `req`. As soon as the total **exceeds** `maxBytes`, stop
  reading and throw `new ApiError(413, 'request body too large')`.
- Preserve existing behaviour exactly otherwise: empty/whitespace body → `{}`; non-object JSON →
  `ApiError(400, 'request body must be a JSON object')`; malformed JSON → `ApiError(400, 'invalid JSON
  in request body')`.
- `maxBytes` is threaded from `ApiServerOptions.maxBodyBytes` (default 1 MiB). Every current
  `readJson(req)` call site becomes `readJson(req, maxBytes)`.

### 3.4 Error-response sanitization — `sendError()`

- `ApiError` → its `status` + its `message` verbatim (these are the deliberate, client-facing API
  contract — including the new `413`/`429` messages).
- **Any non-`ApiError`** (a bug, an I/O error, an unexpected throw) → **`500` with a fixed generic body
  `{ error: 'internal server error' }`**. The real error is logged **server-side only**
  (`console.error`), optionally with a short correlation label, so an operator can still diagnose. **No
  raw `.message`, stack, or filesystem path reaches a remote caller.**
- Stack traces were already never sent; the change is that the raw `.message` of a non-`ApiError` is no
  longer echoed.
- `sendError` still no-ops the body if `res.headersSent` (SSE mid-stream), and still applies the
  baseline security headers when it does write.

### 3.5 New status codes

Extend the error path to emit, with generic non-leaking bodies:

- **`413 Payload Too Large`** — body cap exceeded. Body `{ error: 'request body too large' }`.
- **`429 Too Many Requests`** — rate limit exceeded. Body `{ error: 'rate limit exceeded' }` **and a
  `Retry-After: <retryAfterSec>` header** (integer seconds from the limiter). Never leaks the key or
  limit internals.

Both are raised as `ApiError` so they flow through the sanitized `sendError` unchanged (the `429` also
needs the `Retry-After` header set — either raise a small `ApiError` subtype carrying it, or set the
header before/around the throw; the contract is only that the response has status `429` + `Retry-After`).

### 3.6 SSE — `streamSse`

Add the baseline security headers to the existing `res.writeHead(200, {...})` alongside
`Content-Type: text/event-stream` / `Cache-Control: no-cache` / `Connection: keep-alive` — **without
disturbing** those. Do **not** add CSP to the SSE response (not an HTML document). SSE frames must
continue to carry only `StreamEvent` data (never the token).

### 3.7 `sendJson`

Applies the baseline security headers on its `writeHead` (in addition to `Content-Type:
application/json`). Behaviour otherwise unchanged.

---

## 4. `src/api/static.ts` — headers on static/SPA + traversal re-verification

- `serveStatic`, the SPA fallback, and `notFound` all apply the baseline `securityHeaders()`.
- HTML responses (`contentTypeFor` → `text/html…`, i.e. `index.html` and the SPA fallback) **also**
  emit `Content-Security-Policy: CONTENT_SECURITY_POLICY`. Non-HTML assets (JS/CSS/SVG/etc.) get the
  baseline set but **not** CSP.
- `resolveStaticPath` is unchanged in behaviour but re-verified under remote exposure. Add regression
  tests for edge cases and confirm each returns `null` (rejected): backslash separators
  (`/..\\..\\etc`), an embedded NUL byte (`/foo%00.js`), doubly-encoded traversal (`/%252e%252e/`),
  absolute-path smuggling, and the sibling-prefix escape (`publicDir` + `XYZ`). If any currently
  *passes* (escapes the base), that is a real gap to fix in `resolveStaticPath` — otherwise the tests
  just pin the existing guard.

---

## 5. Config plumbing — `src/cli-args.ts` / `src/build-runner.ts` / `src/serve.ts`

Follow the `resolveApiToken` / `resolveHost` precedent (flag → env → safe default; blank ⇒ unset).

**New `CliArgs` fields (all optional):**

| CliArgs field           | flag                 | env                     | default            |
|-------------------------|----------------------|-------------------------|--------------------|
| `rateLimitCapacity?`    | `--rate-limit`       | `FLEET_RATE_LIMIT`      | 60 (burst)         |
| `rateLimitRefillPerSec?`| `--rate-limit-refill`| `FLEET_RATE_LIMIT_REFILL`| 1 (per second)    |
| `maxBodyBytes?`         | `--max-body-bytes`   | `FLEET_MAX_BODY_BYTES`  | 1_048_576 (1 MiB)  |
| `allowedOrigins?`       | `--cors-origin`       | `FLEET_CORS_ORIGINS`    | `[]` (deny all)    |

- `--cors-origin` may be repeated **or** comma-separated; `FLEET_CORS_ORIGINS` is comma-separated. A
  blank value ⇒ empty list (deny all cross-origin). Each entry is an exact origin string
  (`https://host[:port]`).
- New `build-runner` resolvers mirroring the existing ones (name suggestions; keep the shape):
  `resolveRateLimit(args): { capacity: number; refillPerSec: number }`,
  `resolveMaxBodyBytes(args): number`, `resolveAllowedOrigins(args): string[]`. Non-finite / negative /
  garbage values fall back to the safe default (a typo must never wedge the daemon or, worse, *disable*
  a protection).
- `serve.ts` resolves these and passes them into `createApiServer(orchestrator, { …, rateLimit,
  maxBodyBytes, allowedOrigins })`. **No change to the auth/bind-guard/TLS boot order.** Update the
  banner to note limits are active (keep it honest, don't leak values that matter).

---

## 6. Threat-model write-up — `plans/remote-access-threat-model.md` (new)

Short and concrete (the issue Deliverable):

- **Trust boundary:** an off-localhost attacker, with and without the shared token.
- **Can do:** reach `/health`, fetch the SPA shell, attempt auth (constant-time compare — no timing
  oracle, no length leak).
- **Cannot do:** drive the API without the token; read back `GITHUB_TOKEN` / `ANTHROPIC_API_KEY` / any
  config secret; traverse the filesystem via static paths; flood past the rate limit; exhaust memory via
  an unbounded body; clickjack/frame the SPA; read cross-origin API responses (no permissive ACAO); ride
  an ambient credential (auth is a **bearer token, never a cookie** ⇒ classic CSRF is N/A).
- **Per-gap disposition table:** each item from the issue scope marked *fixed-with-test* or
  *deferred-with-rationale*.
- **Token rotation:** restart the daemon with a new `FLEET_API_TOKEN`; one shared token by design —
  multi-user/RBAC is out of scope (README §1).
- **Documented residuals:** rate limiting is per-source-IP (coarse behind a shared-IP tunnel); HSTS is
  the TLS terminator's responsibility, not the app's; `X-Forwarded-For` is untrusted.
- Add a brief pointer + the rotation note to **README §9.11** so the operating guide stays the entry
  point.

---

## 7. Non-gaps to pin with tests (confirm they stay non-gaps)

- **No secret is readable back:** `GET /config` returns only `{ fsm, agents, version }`; no route body
  or SSE frame contains `GITHUB_TOKEN` / `ANTHROPIC_API_KEY` / the API token value.
- **Token never leaks:** it never appears in any response body (incl. error bodies), SSE frame, or log
  line (`serve.ts` prints only that auth is *on*).
- **Path params stay integer-guarded** (`/^\/runs\/(\d+)\/…$/`) — no injection surface.

---

## 8. Testing contract (what the TDD stage writes against)

Follow the existing patterns: pure unit tests for the new helpers (`auth.test.ts` /
`bind-guard.test.ts` precedent) + integration tests driving the real server over an ephemeral port with
`fetch` and the stub executor / fake GitHub (`server.test.ts` precedent).

- **`rate-limit.test.ts`** — first `capacity` calls `ok`; the next is `ok:false` with integer
  `retryAfterSec ≥ 1`; refills over injected `now`; independent keys independent; non-increasing `now`
  never over-refills; idle eviction + `maxKeys` bound the map.
- **`security-headers.test.ts`** — `securityHeaders()` has `nosniff` / `X-Frame-Options: DENY` /
  `Referrer-Policy: no-referrer` and no HSTS; `CONTENT_SECURITY_POLICY` contains `default-src 'self'`,
  `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, and permits the Google-Fonts
  origins for `style-src`/`font-src`; `corsHeaders` echoes an allowed origin (never `*`) with `Vary:
  Origin`, and returns no ACAO for a disallowed/absent origin or an empty allow-list.
- **`server.test.ts` additions** — a mutating route past the limit → `429` + `Retry-After` (and a cheap
  `GET`/`/health` never throttled); oversized body → `413`; a forced non-`ApiError` internal failure →
  `500` with `{ error: 'internal server error' }` (no path/raw-message leak); every response (JSON,
  static, SSE, 404) carries the baseline security headers; HTML carries CSP, JSON does not; `OPTIONS`
  cross-origin from a non-allowed origin → locked-down (no wildcard ACAO); an allowed origin (server
  configured with `allowedOrigins`) is echoed; `GET /config` + a captured SSE frame contain **no**
  secret/token value; the token appears in no error body.
- **`static.test.ts` additions** — headers on static + 404 + SPA-fallback; CSP only on HTML; the extra
  `resolveStaticPath` traversal edge cases all reject.
- Full `npm test` + `npm run lint` + `npm run typecheck` green; existing localhost behaviour and tests
  unchanged.

---

## 9. Files

- **New:** `src/api/rate-limit.ts` (+ `rate-limit.test.ts`)
- **New:** `src/api/security-headers.ts` (+ `security-headers.test.ts`) — baseline headers, CSP, CORS
- **New:** `plans/remote-access-threat-model.md`
- **Edit:** `src/api/server.ts` — `ApiServerOptions` extension, headers in helpers + SSE, `readJson`
  body cap, sanitized `sendError`, rate-limit + CORS/OPTIONS branches, `413`/`429` mapping
- **Edit:** `src/api/static.ts` — baseline headers + CSP on HTML; traversal edge-case tests
- **Edit:** `src/cli-args.ts` — new flags/fields
- **Edit:** `src/build-runner.ts` — `resolveRateLimit` / `resolveMaxBodyBytes` / `resolveAllowedOrigins`
- **Edit:** `src/serve.ts` — resolve + pass the new options through; honest banner
- **Edit:** `README.md` §9.11 — threat-model pointer + rotation note + the new knobs

## 10. Scope flags

- **needs_backend: true** — server, pure helpers, config plumbing, docs.
- **needs_frontend: false** — server-emitted headers/limits + a doc; no Svelte source changes. CSP is
  validated against the *already-built* dashboard asset. Only if the built SPA cannot load under a
  reasonable CSP without editing dashboard source would frontend enter scope — surfaced as a risk, not
  silently absorbed.
