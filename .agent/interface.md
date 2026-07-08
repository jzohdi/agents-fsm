# Interface — Remote access: reach the dashboard off-localhost (bind config + TLS/tunnel)

Issue: jzohdi/agents-fsm#26 · Plan: `.agent/plan.md`

This spec pins the types, signatures, and invariants the `tdd` stage writes failing tests against and
the implementation satisfies. It follows the `src/api/auth.ts` pure-helper precedent: the safety-
critical decision is a pure, side-effect-free function; transport/process concerns stay in `serve.ts`.

Backend-only. No dashboard change (the client already uses relative-path `fetch`/`EventSource`).

---

## 1. New module — `src/api/bind-guard.ts` (pure, the testable core)

Mirrors `src/api/auth.ts`: **no** coupling to `node:http`, `process`, the filesystem, or the
orchestrator. Inputs are strings/booleans; outputs are values. `src/api/bind-guard.test.ts` exercises
it directly. No DNS resolution (keep it pure/offline) — `localhost` is classified by literal string.

### 1.1 `isLoopbackHost`

```ts
export function isLoopbackHost(host: string): boolean;
```

Classify a bind host as loopback (`true`) or not (`false`). Normalization: trim surrounding
whitespace, lowercase, and strip one pair of surrounding brackets from a bracketed IPv6 literal
(`[::1]` → `::1`) before classifying.

**Loopback ⇒ `true`:**
- `localhost` (literal string; never DNS-resolved).
- `::1` and its bracketed form `[::1]`.
- The IPv6-mapped IPv4 loopback: `::ffff:127.0.0.1` (and any `::ffff:127.x.x.x`).
- The entire IPv4 `127.0.0.0/8` block — `127.0.0.1`, `127.0.0.2`, `127.255.255.254`, etc. Parse the
  dotted-quad **numerically** (four integer octets, each `0–255`, first octet `=== 127`); do **not**
  use a loose `startsWith('127.')` (so `127.foo`, `1270.0.0.1`, `127.0.0.1.5` do **not** slip through).

**Non-loopback ⇒ `false`:** everything else, notably —
- Wildcard binds `0.0.0.0` and `::` (these bind every interface — must be non-loopback).
- Any LAN / public address (`192.168.x.x`, `10.x`, a routable IPv6, a public IPv4).
- Empty string, or any bogus/unparseable host.

**Invariant (fail-safe):** when a host cannot be confidently classified as loopback, return `false`.
Mis-classifying loopback→non-loopback only *engages* the guard (safe); the reverse would *expose* the
daemon (unsafe), so ambiguity must resolve to non-loopback.

### 1.2 `checkBindAllowed`

```ts
export type BindVerdict = { ok: true } | { ok: false; reason: string };

export function checkBindAllowed(host: string, hasToken: boolean): BindVerdict;
```

The bind decision, over the two inputs (host loopback-ness × token presence):

| host           | `hasToken` | result                          |
|----------------|------------|---------------------------------|
| loopback       | `false`    | `{ ok: true }`                  |
| loopback       | `true`     | `{ ok: true }`                  |
| non-loopback   | `true`     | `{ ok: true }`                  |
| non-loopback   | `false`    | `{ ok: false, reason: <msg> }`  |

- Uses `isLoopbackHost(host)` for the loopback column. A loopback host is always allowed regardless of
  token (the unchanged default path).
- `hasToken` is a plain boolean — the caller passes `Boolean(resolveApiToken(args))`. The guard does
  **not** know how the token is configured; token *validation* stays in `auth.ts`.
- On refusal, `reason` is a single actionable sentence that:
  - names the offending `host`,
  - tells the operator to set `FLEET_API_TOKEN` (or `--api-token`) before exposing off-localhost, or to
    bind `127.0.0.1` (the default),
  - points at the README remote-access section.
  Keep the wording stable in the module so a test can assert on a substring. Tests should assert
  `reason` **contains** the offending host string and the literal `FLEET_API_TOKEN` (not the full
  sentence, to avoid brittleness).

**Why a reason string, not a throw:** keeps the function pure and trivially unit-testable; `serve.ts`
decides how to surface it (throw + non-zero exit).

---

## 2. Config threading — `src/cli-args.ts`

Add three optional fields to `CliArgs`, following the existing daemon-flag precedent (`apiToken`,
`concurrency`): **captured here, left `undefined` when unset**; env-fallback + default live in the
resolver, not baked in here.

```ts
export interface CliArgs {
  // …existing…
  /** Bind address for the `serve` daemon — `--host`. Undefined here → falls back to `FLEET_HOST`,
   *  then `127.0.0.1` (loopback, unchanged default). Off-loopback requires an API token (bind guard). */
  host?: string;
  /** PEM cert path for direct TLS termination on the `serve` daemon — `--tls-cert`. Both `--tls-cert`
   *  and `--tls-key` must be given together; absent ⇒ plain HTTP (unchanged default). */
  tlsCert?: string;
  /** PEM private-key path paired with `--tls-cert` — `--tls-key`. */
  tlsKey?: string;
}
```

`parseCliArgs`:
- Add to the `parseArgs` `options` map: `host: { type: 'string' }`, `'tls-cert': { type: 'string' }`,
  `'tls-key': { type: 'string' }`.
- Return: `host: values.host`, `tlsCert: values['tls-cert']`, `tlsKey: values['tls-key']`.
- Do **not** default `host` to `127.0.0.1` here (the resolver owns the default).

Both `--host v` and `--host=v` must parse (inherent to `parseArgs`). Unset ⇒ `host`/`tlsCert`/`tlsKey`
are `undefined`.

---

## 3. Host resolver — `src/build-runner.ts`

Add one resolver alongside `resolveApiToken` / `resolveConcurrency`, same flag→env→default shape:

```ts
export function resolveHost(args: CliArgs): string;
```

- Precedence: `args.host` (`--host`) → `process.env.FLEET_HOST` → `'127.0.0.1'`.
- A blank / whitespace-only value at either level is treated as **unset** (mirrors `resolveApiToken`'s
  `.trim() || undefined`), so `FLEET_HOST=` keeps the loopback default.
- Always returns a non-empty string (never `undefined`) — the default guarantees it.

**Invariant:** with no `--host` and no `FLEET_HOST`, `resolveHost` returns exactly `'127.0.0.1'`. The
default bind is loopback and must stay so (the whole security default rests on this).

Cert/key paths are **not** resolved here — they are transport concerns read directly in `serve.ts`
(like `apiToken` is applied in `serve.ts`, not threaded through `buildOrchestrator`).

---

## 4. Transport wiring — `src/api/server.ts`

Extend the server options with an optional TLS block; branch the server constructor on it. The request
handler `handle(...)` and the return type are **unchanged** (`https.Server` shares `node:http`'s
request/`listen` surface).

```ts
export interface ApiServerOptions {
  publicDir?: string;
  apiToken?: string;
  /**
   * Direct TLS termination (issue #26). When set, the server is built with `https.createServer`
   * using these already-read PEM strings; absent ⇒ plain `http.createServer` (unchanged default).
   * `serve.ts` reads the files and passes resolved PEM contents — the server stays free of filesystem
   * concerns. TLS is transport confidentiality only; it does **not** exempt the bind-token guard.
   */
  tls?: { cert: string; key: string };
}
```

`createApiServer(orchestrator, options)`:
- If `options.tls` is set → `createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handler)`
  (import `createServer as createHttpsServer` from `node:https`).
- Else → `createServer(handler)` as today.
- Same `handler` body in both branches; return type stays `Server` (a `node:http`-compatible server).

**Invariant:** `tls` carries **PEM string contents**, never file paths — `server.ts` performs no
filesystem I/O.

---

## 5. Boot sequence — `src/serve.ts`

Order in `serve()` (guard must run **before** the server binds):

1. `const host = resolveHost(args);`
2. `const apiToken = resolveApiToken(args);` (already present).
3. **Bind guard, fail-fast:**
   ```ts
   const verdict = checkBindAllowed(host, Boolean(apiToken));
   if (!verdict.ok) throw new Error(verdict.reason);
   ```
   Throw an `Error(verdict.reason)` — surfaces the same way other boot failures do (e.g.
   `resolveDefaultHarness`'s fail-fast throw) and yields a non-zero exit. Must precede building/listening.
4. **TLS option assembly (optional):**
   - Both-or-neither: if exactly one of `args.tlsCert` / `args.tlsKey` is set → throw a clear
     `Error` naming which is missing.
   - If both set → read each with `readFileSync(path, 'utf8')`; on a missing/unreadable path, surface
     an actionable `Error` naming the offending path. Pass `{ tls: { cert, key } }` into `createApiServer`.
   - If neither set → no `tls` option (plain HTTP, unchanged).
   - **Independence from the guard:** a non-loopback bind requires a token *even with* TLS — do not let
     TLS exempt step 3.
5. `const server = createApiServer(orchestrator, { ...(apiToken ? { apiToken } : {}), ...(tls ? { tls } : {}) });`
6. `await listen(server, args.port, host);`

`listen` signature changes:

```ts
function listen(server: Server, port: number, host: string): Promise<void>;
```

- Body: `server.listen(port, host, () => { … })` (was hard-coded `'127.0.0.1'`). Update the
  loopback-only comment (currently lines 142–144) to describe the configurable bind + the guard that
  protects off-loopback exposure.

**Startup banner** (currently the hard-coded `http://localhost:${args.port}` line):
- Scheme reflects TLS: `https` when a `tls` option is in effect, else `http`.
- Host reflects the bind: show `host`, except for wildcard binds (`0.0.0.0` / `::`) show a
  human hint (e.g. `<this-host>`) rather than the literal wildcard, since the wildcard isn't a
  reachable address.
- When bound off-loopback, add a one-line notice that the daemon is reachable from other devices and
  that auth is required (guaranteed by the guard).
- Keep the existing auth line (currently lines 54–58) unchanged.

**Invariants preserved:** default path (no `--host`, no TLS) binds `127.0.0.1` over plain HTTP and the
banner reads `http://localhost:${port}` — byte-compatible with today for the default case is not
required, but the default *behaviour* (loopback + HTTP) is.

---

## 6. Help text — `src/cli.ts`

Extend the `serve` usage/help comment to mention `--host`, `--tls-cert`, `--tls-key` (documentation
only; no behavioural contract).

---

## 7. Docs — `README.md`

- §3.4 "Future remote/phone access" row: reflect that off-localhost access now exists (bind config +
  tunnel/TLS), gated on the token.
- §9.3 API-authentication note: loopback is now the *default*, not a hard pin; off-localhost binding is
  implemented (this issue), not deferred.
- New §9.x "Remote access (off-localhost)" subsection: the (already-met) auth prerequisite; the
  recommended **tunnel** path (Tailscale / Cloudflare Tunnel / `ssh -L`) as primary; the optional
  direct-**TLS** path (`--tls-cert`/`--tls-key`); the bind-guard behaviour (non-loopback without a
  token fails fast).

---

## 8. Testing contract (what `tdd` writes against)

- **`src/api/bind-guard.test.ts` (pure — the acceptance-criteria coverage):**
  - `isLoopbackHost` truthy: `127.0.0.1`, `127.0.0.2`, `127.255.255.254`, `::1`, `[::1]`, `localhost`,
    `::ffff:127.0.0.1`, plus case/whitespace variants (`LOCALHOST`, ` 127.0.0.1 `).
  - `isLoopbackHost` falsy: `0.0.0.0`, `::`, `192.168.1.10`, `10.0.0.5`, a public IPv4, `127.foo`,
    `1270.0.0.1`, `''`, garbage.
  - `checkBindAllowed` four quadrants: loopback±token ⇒ `ok:true`; non-loopback+token ⇒ `ok:true`;
    non-loopback+no-token ⇒ `ok:false` with `reason` containing the host and `FLEET_API_TOKEN`.
- **`src/cli-args.test.ts`:** `--host` / `--tls-cert` / `--tls-key` parse in both `--k v` and `--k=v`
  forms; when unset, `host`/`tlsCert`/`tlsKey` are `undefined`.
- **`src/build-runner.test.ts`:** `resolveHost` precedence — flag beats env beats default; blank flag
  and blank env both treated as unset; no-config ⇒ `'127.0.0.1'`. (Restore any `process.env.FLEET_HOST`
  mutation after each case.)
- **`src/api/server.test.ts` (optional light smoke):** `createApiServer` with a `tls` option (self-
  signed PEMs generated in-test in a temp dir, `rejectUnauthorized: false`) serves over HTTPS. The
  guard logic is fully covered by the pure tests; this is a transport smoke test only.

**Working-tree hygiene:** no test certs/keys committed — any TLS test generates PEMs in a temp dir and
cleans up (nothing under the repo). No new dependencies (`node:https`, `node:fs`, `node:crypto` are all
built-in). No lockfile churn.
