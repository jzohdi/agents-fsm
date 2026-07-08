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
 * TDD stage (issue #26): the signatures pin the contract from `.agent/interface.md`; the bodies below
 * satisfy `bind-guard.test.ts`.
 */

/** The bind decision: allowed, or refused with an actionable reason to surface (throw + non-zero exit). */
export type BindVerdict = { ok: true } | { ok: false; reason: string };

/**
 * True iff `s` is a dotted-quad IPv4 whose first octet is `127` (the whole `127.0.0.0/8` loopback
 * block). Parsed **numerically**: exactly four octets, each a run of digits in `0..255` with no
 * surprises, so near-misses a loose `startsWith('127.')` would wave through — `127.foo`,
 * `1270.0.0.1`, `127.0.0.1.5`, `127.0.0.256` — all return `false`.
 */
function isLoopbackIpv4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    // Digits only (rejects `foo`, empty, signs, whitespace); `Number` gives the value for the range check.
    if (!/^\d+$/.test(part)) return false;
    const n = Number(part);
    if (n > 255) return false;
  }
  return Number(parts[0]) === 127;
}

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
  // Normalize: trim, lowercase, and strip one pair of surrounding brackets (`[::1]` → `::1`).
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);

  if (h === '') return false; // empty / whitespace-only → non-loopback (fail safe)
  if (h === 'localhost') return true; // literal only — never DNS-resolved
  if (h === '::1') return true; // IPv6 loopback
  // IPv6-mapped IPv4 loopback (`::ffff:127.x.x.x`): the mapped tail must itself be 127/8.
  if (h.startsWith('::ffff:')) return isLoopbackIpv4(h.slice('::ffff:'.length));
  // The entire IPv4 `127.0.0.0/8` block, parsed numerically (not `startsWith('127.')`).
  return isLoopbackIpv4(h);
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
  if (isLoopbackHost(host)) return { ok: true }; // loopback is always allowed (the unchanged default path)
  if (hasToken) return { ok: true }; // off-loopback is fine once a token gates the API surface
  return {
    ok: false,
    reason:
      `refusing to bind to a non-loopback host (${host}) without an API token — set FLEET_API_TOKEN ` +
      `(or --api-token) before exposing the daemon off localhost, or bind 127.0.0.1 (the default). ` +
      `See README §9 "Remote access (off-localhost)".`,
  };
}
