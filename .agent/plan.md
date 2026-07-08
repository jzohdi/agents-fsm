# Plan — Remote access: reach the dashboard off-localhost (bind config + TLS/tunnel)

Issue: jzohdi/agents-fsm#26

## Goal (restated)

Let the `serve` daemon be reached from another device (e.g. a phone) over a secure channel, instead
of being pinned to `127.0.0.1`. Concretely:

- Make the bind address configurable (`--host` / `FLEET_HOST`), default `127.0.0.1` (behaviour
  unchanged out of the box).
- Refuse to bind to a **non-loopback** host unless an API token is configured, and fail fast with a
  clear, actionable message. Implement the decision as a **pure, unit-testable** function mirroring
  the `src/api/auth.ts` pure-helper precedent.
- Provide a documented secure path off-localhost: **tunnel-based** access as the primary
  recommendation (Tailscale / Cloudflare Tunnel / `ssh -L`), and optional **direct TLS termination**
  (`--tls-cert` / `--tls-key`, Node `https`) for operators who prefer it.
- README §9 operating-guide section documenting both, noting the (already-met) auth prerequisite.

The API auth mechanism itself is done (#25) — this issue only wires the bind address to that existing
token guard and adds an optional TLS transport. **Backend-only**: the dashboard already uses
relative-path `fetch`/`EventSource` (`dashboard/src/lib/api.ts:28`, `store.svelte.ts:655`), so it
reaches the daemon over any host/scheme with no client change.

## Current state (grounding)

- `src/serve.ts` `listen(server, port)` (lines 139–150) hard-codes `server.listen(port, '127.0.0.1', …)`
  with a comment explicitly naming off-loopback binding as the sole remaining post-MVP step (this issue).
- `src/serve.ts` `serve()` builds the HTTP server via `createApiServer(orchestrator, apiToken ? { apiToken } : {})`
  (line 37), then `await listen(server, args.port)` (line 38), then prints a startup banner that
  currently hard-codes `http://localhost:${args.port}` (line 40) and an auth line (lines 54–58).
- `src/build-runner.ts` already has the pure-resolver precedent: `resolveApiToken` (155–157),
  `resolveConcurrency` (131–135), `resolveCostCeiling` (142–146) — flag → env → default, blank
  treated as unset. `resolveApiToken` returns `undefined` when no token is configured.
- `src/api/server.ts` `createApiServer` (63–69) wraps `node:http` `createServer`; `ApiServerOptions`
  (51–60) currently carries `publicDir` + `apiToken`. The request handler `handle(...)` is
  transport-agnostic — it works identically behind `https.createServer`.
- `src/cli-args.ts` — `CliArgs` interface + `parseCliArgs` (`node:util parseArgs`); flags are declared
  in the `options` map and defaulted in the returned object. Precedent for env-fallback flags
  (`apiToken`, `concurrency`, `costCeiling`) is: flag captured here, env fallback resolved in
  `build-runner.ts`.
- `src/api/auth.ts` — the pure-helper precedent to mirror (no `node:http`/process/orchestrator
  coupling), with `src/api/auth.test.ts` exercising it directly.
- README: §3.4 table row "Future remote/phone access" (line 280); §9.3 "API authentication" note
  (lines 757–768) currently says the daemon "still binds loopback regardless; binding off-localhost is
  a separate networking/TLS issue (#16)".

## Approach

Three small, well-separated pieces: a **pure bind-guard** module (the testable core), **config
threading** for the new flags, and **transport wiring** in `serve.ts` (host + optional TLS + guard +
banner). Plus docs.

### 1. Pure bind-guard module — `src/api/bind-guard.ts` (+ `bind-guard.test.ts`)

New module mirroring `auth.ts`: no `node:http`/process/orchestrator coupling, only string/boolean in.

- `export function isLoopbackHost(host: string): boolean` — classify a bind host as loopback.
  - Loopback (true): `127.0.0.1` and the whole `127.0.0.0/8` block, `::1`, `localhost`, and the
    IPv6-mapped `::ffff:127.x.x.x` form. Trim + lowercase; strip surrounding brackets from a bracketed
    IPv6 literal (`[::1]`).
  - Non-loopback (false): everything else — notably the wildcard binds `0.0.0.0` and `::`, and any LAN
    / public address. When in doubt, classify as **non-loopback** (fail safe → guard engages).
  - Keep it dependency-light: parse the IPv4 dotted-quad numerically for the `127.` block rather than a
    loose `startsWith('127.')` (so `127.foo` or `1270.0.0.1` don't slip through); recognise the small
    set of IPv6 loopback spellings explicitly.
- `export function checkBindAllowed(host: string, hasToken: boolean): { ok: true } | { ok: false; reason: string }`
  — the decision:
  - loopback host ⇒ `{ ok: true }` regardless of token (unchanged default path).
  - non-loopback host **with** a token ⇒ `{ ok: true }`.
  - non-loopback host **without** a token ⇒ `{ ok: false, reason: <actionable message> }`.
  - `reason` names the offending host and the fix, e.g.: *"refusing to bind to a non-loopback host
    (`0.0.0.0`) without an API token — set FLEET_API_TOKEN (or --api-token) before exposing the daemon
    off localhost, or bind 127.0.0.1 (the default). See README §9.x."* Keep the exact wording in the
    module so tests assert on a stable substring.

Rationale for returning a reason string (not throwing) from the pure fn: keeps it side-effect-free and
trivially unit-testable; `serve.ts` decides how to surface it (throw / `console.error` + exit).

### 2. Config threading — `src/cli-args.ts` + `src/build-runner.ts`

`cli-args.ts`:
- Add to `CliArgs`: `host?: string`, `tlsCert?: string`, `tlsKey?: string` (doc-commented like the
  neighbouring daemon flags; note default `127.0.0.1` and env fallback `FLEET_HOST`).
- Add to `parseArgs` `options`: `host: { type: 'string' }`, `'tls-cert': { type: 'string' }`,
  `'tls-key': { type: 'string' }`.
- Return them: `host: values.host`, `tlsCert: values['tls-cert']`, `tlsKey: values['tls-key']`.
  Leave `host` **undefined when unset** (like `concurrency`/`apiToken`) so the env fallback + default
  live in the resolver — do not bake `127.0.0.1` in here.

`build-runner.ts`:
- Add `export function resolveHost(args: CliArgs): string` — precedence `--host` → `FLEET_HOST` →
  `'127.0.0.1'`; blank/whitespace-only treated as unset (mirrors `resolveApiToken`). This keeps the
  "flag → env → default" pattern consistent and unit-testable alongside the existing resolvers.
- (Cert/key are read directly in `serve.ts` — they're transport concerns, like `apiToken` is applied
  in `serve.ts` rather than threaded through `buildOrchestrator`.)

### 3. Transport wiring — `src/serve.ts` + `src/api/server.ts`

`src/api/server.ts`:
- Extend `ApiServerOptions` with `tls?: { cert: string; key: string }`.
- In `createApiServer`, branch: if `options.tls` is set, build the server with
  `https.createServer({ cert, key }, handler)`; otherwise `http.createServer(handler)` as today. Both
  return a `node:http`-compatible `Server` (`https.Server` shares the request/`listen` surface), so
  the return type and the `handle(...)` body are unchanged. Import `createServer as createHttpsServer`
  from `node:https` only where used.

`src/serve.ts`:
- Resolve `host = resolveHost(args)` and `apiToken = resolveApiToken(args)`.
- **Guard, fail-fast, before building/listening**: `const verdict = checkBindAllowed(host, Boolean(apiToken));`
  if `!verdict.ok`, `console.error` the reason and exit non-zero (throw an `Error(verdict.reason)` so
  it surfaces the same way other boot failures do — pick the pattern already used for
  `resolveDefaultHarness`'s fail-fast throw). This must happen **before** the server binds.
- TLS option assembly: if `args.tlsCert` / `args.tlsKey` are set, require **both** (error if only one),
  read the two files (`readFileSync`, utf8) with a clear error if a path is missing/unreadable, and
  pass `{ tls: { cert, key } }` into `createApiServer`. Reading here keeps `createApiServer` pure of
  filesystem concerns (it just receives resolved PEM strings) and testable.
- Change `listen` to `listen(server, port, host)` → `server.listen(port, host, …)`. Update the
  loopback-only comment (139–144) to describe the new configurable bind + guard.
- Banner: replace the hard-coded `http://localhost:${port}` (line 40) with the real scheme + host —
  `${tls ? 'https' : 'http'}://${host === '0.0.0.0' || host === '::' ? '<this-host>' : host}:${port}`
  (show a hint rather than the literal wildcard). When bound off-loopback, add a one-line notice that
  it's reachable from other devices and that auth is required (it is, by the guard). Keep the existing
  auth line (54–58).

### Files to change

- `src/api/bind-guard.ts` — **new**: `isLoopbackHost`, `checkBindAllowed` (pure).
- `src/api/bind-guard.test.ts` — **new**: unit tests for both.
- `src/cli-args.ts` — add `host` / `tls-cert` / `tls-key` flags + fields.
- `src/cli-args.test.ts` — assert the new flags parse (and default `host` undefined).
- `src/build-runner.ts` — add `resolveHost`.
- `src/build-runner.test.ts` — assert `resolveHost` precedence (flag → env → default; blank = unset).
- `src/api/server.ts` — `ApiServerOptions.tls`; `https` branch in `createApiServer`.
- `src/serve.ts` — resolve host, apply guard (fail-fast), optional TLS assembly, `listen(…, host)`,
  banner scheme/host.
- `src/cli.ts` — extend the `serve` usage/help comment (line ~19) to mention `--host` / `--tls-cert` /
  `--tls-key`.
- `README.md` — §3.4 row update; §9.3 note update (loopback is now the *default*, not a hard pin);
  new §9.x "Remote access (off-localhost)" subsection.
- Update §8 "Remaining planned work" / issue-tracking prose only if it explicitly lists this as open
  (leave the frozen status counts alone — see the README-status-test-count memory).

## Risks and edge cases

- **Security-critical default**: the default MUST stay loopback. Guard against a stray default of
  `0.0.0.0`. Tests must pin: no `--host` ⇒ `127.0.0.1`; loopback ⇒ allowed with/without token;
  non-loopback + no token ⇒ refused; non-loopback + token ⇒ allowed.
- **Loopback classification correctness** — the guard is the whole safety story:
  - `0.0.0.0` and `::` (wildcard, binds every interface) must classify **non-loopback**.
  - `127.0.0.1` **and** the rest of `127.0.0.0/8` (e.g. `127.0.0.2`) are loopback.
  - `::1`, `[::1]`, `localhost` are loopback; `::ffff:127.0.0.1` is loopback.
  - A bogus/unparseable host classifies non-loopback (fail safe → guard engages) rather than throwing.
  - Do **not** DNS-resolve `localhost` (keep it pure/offline); treat the literal string as loopback.
- **TLS both-or-neither**: one of `--tls-cert`/`--tls-key` without the other is operator error → clear
  fail-fast message. Missing/unreadable cert file → actionable error naming the path.
- **Guard vs. TLS interaction**: TLS does not exempt the token guard — a non-loopback bind still
  requires a token even over HTTPS (TLS is transport confidentiality, the token is authn; the issue's
  guard is unconditional on non-loopback). Keep the guard independent of TLS.
- **Working tree cleanliness**: don't commit any test certs/keys. Any TLS test must generate PEMs in a
  temp dir (or skip real TLS I/O and unit-test the option-assembly logic) and clean up — nothing under
  the repo. No lockfile churn (no new deps: `node:https`, `node:fs` are built-in).
- **No new dependencies** — everything is Node built-ins, consistent with the KISS/no-framework stance.

## How it will be tested

- **Unit (pure, the core):** `bind-guard.test.ts` — `isLoopbackHost` across the table above
  (`127.0.0.1`, `127.0.0.2`, `::1`, `[::1]`, `localhost`, `::ffff:127.0.0.1` ⇒ true; `0.0.0.0`, `::`,
  `192.168.x`, a public IP, garbage ⇒ false); `checkBindAllowed` across the four quadrants
  (loopback±token, non-loopback±token) asserting `ok` and, on refusal, a stable substring of `reason`
  (mentions the host + `FLEET_API_TOKEN`). This is the acceptance-criteria coverage the issue asks for.
- **Unit:** `cli-args.test.ts` — `--host` / `--tls-cert` / `--tls-key` parse (both `--k v` and `--k=v`);
  `host` undefined when unset. `build-runner.test.ts` — `resolveHost` precedence incl. blank-as-unset.
- **Integration (optional, light):** `server.test.ts` — `createApiServer` with a `tls` option returns
  a server that serves over HTTPS (self-signed PEMs generated in-test, `rejectUnauthorized: false`),
  proving the transport branch works end-to-end. Keep it small; the guard logic is fully covered by
  the pure tests, so this is a smoke test only.
- **Full suite** `npm test` + typecheck/lint must stay green; default-path tests (loopback, no TLS)
  unchanged.

## Scope flags

- `needs_frontend`: **false** — dashboard already transport-agnostic (relative URLs); no client change.
- `needs_backend`: **true** — CLI args, resolver, pure guard, transport wiring, docs.
