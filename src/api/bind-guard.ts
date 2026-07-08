/**
 * Bind-address guard (issue #26) — pure, dependency-light, unit-testable in isolation.
 *
 * Mirrors the `src/api/auth.ts` pure-helper precedent: no coupling to `node:http`, `process`, the
 * filesystem, or the orchestrator. Inputs are strings/booleans; outputs are values. This is the
 * safety-critical core of "reach the dashboard off-localhost" — `serve.ts` classifies the resolved
 * bind host and refuses to expose the daemon off loopback unless an API token is configured. Keeping
 * the decision pure lets `bind-guard.test.ts` exercise the loopback classification + the allow/refuse
 * verdict directly (no DNS, no I/O — `localhost` is classified by literal string, never resolved).
 *
 * TDD stage (issue #26): these are intentionally UNIMPLEMENTED stubs — the signatures pin the contract
 * from `.agent/interface.md` so `bind-guard.test.ts` compiles and fails for the right reason (missing
 * behaviour, not an import/compile error). The implementation stage fills the bodies in.
 */

/** The bind decision: allowed, or refused with an actionable reason to surface (throw + non-zero exit). */
export type BindVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Classify a bind host as loopback (`true`) or not (`false`). Normalizes first: trims surrounding
 * whitespace, lowercases, and strips one pair of surrounding brackets from a bracketed IPv6 literal
 * (`[::1]` → `::1`).
 *
 * Loopback ⇒ `true`: `localhost` (literal, never DNS-resolved), `::1`/`[::1]`, the IPv6-mapped IPv4
 * loopback `::ffff:127.x.x.x`, and the entire IPv4 `127.0.0.0/8` block (dotted-quad parsed numerically,
 * first octet `=== 127`, so `127.foo`/`1270.0.0.1`/`127.0.0.1.5` do not slip through).
 *
 * Non-loopback ⇒ `false`: everything else — notably the wildcard binds `0.0.0.0` and `::` (they bind
 * every interface), any LAN / public address, the empty string, and any bogus/unparseable host.
 *
 * Fail-safe invariant: when a host cannot be confidently classified as loopback, return `false` —
 * mis-classifying loopback→non-loopback only *engages* the guard (safe); the reverse would *expose*
 * the daemon (unsafe), so ambiguity must resolve to non-loopback.
 */
export function isLoopbackHost(host: string): boolean {
  throw new Error(`isLoopbackHost not implemented (issue #26): ${host}`);
}

/**
 * The bind decision over (host loopback-ness × token presence):
 *   - loopback host  ⇒ `{ ok: true }` regardless of `hasToken` (the unchanged default path).
 *   - non-loopback host **with** a token ⇒ `{ ok: true }`.
 *   - non-loopback host **without** a token ⇒ `{ ok: false, reason }`.
 *
 * `hasToken` is a plain boolean — the caller passes `Boolean(resolveApiToken(args))`; this guard does
 * not know how the token is configured (validation stays in `auth.ts`). On refusal, `reason` is a
 * single actionable sentence that names the offending `host`, tells the operator to set
 * `FLEET_API_TOKEN` (or `--api-token`) before exposing off-localhost (or to bind `127.0.0.1`, the
 * default), and points at the README remote-access section.
 */
export function checkBindAllowed(host: string, hasToken: boolean): BindVerdict {
  throw new Error(`checkBindAllowed not implemented (issue #26): ${host} hasToken=${hasToken}`);
}
