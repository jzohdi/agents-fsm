/**
 * API auth helpers (issue #25) — pure, dependency-light, unit-testable in isolation.
 *
 * Mirrors the pure-helper precedent (`static.ts`'s `resolveStaticPath`, `model-picker.ts`): no
 * coupling to `node:http` request/response objects, `process`, or the orchestrator, so
 * `auth.test.ts` can exercise the constant-time comparison, credential extraction, and the auth
 * boundary directly.
 *
 * TDD stage (issue #25): these are intentionally UNIMPLEMENTED stubs — the signatures pin the
 * contract from `.agent/interface.md` so `auth.test.ts` compiles and fails for the right reason
 * (missing behaviour). The implementation stage fills the bodies in.
 */

import type { IncomingHttpHeaders } from 'node:http';

/**
 * Constant-time equality of a provided credential against the configured token. Returns `false`
 * for an absent/empty `provided`; `true` iff `provided === expected` byte-for-byte (a prefix or a
 * superset of the correct token must be `false`). Implemented via fixed-length SHA-256 digests +
 * `crypto.timingSafeEqual` so it neither leaks the token length nor short-circuits on the first
 * differing byte.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  void provided;
  void expected;
  throw new Error('tokenMatches not implemented (issue #25)');
}

/**
 * Extract the bearer credential from a request: `Authorization: Bearer <token>` (case-insensitive
 * scheme) first, then the `?token=` query param (needed for SSE — `EventSource` can't set headers).
 * Returns `undefined` when neither is present, the header is malformed/non-string, or the resolved
 * value is empty.
 */
export function extractToken(headers: IncomingHttpHeaders, url: URL): string | undefined {
  void headers;
  void url;
  throw new Error('extractToken not implemented (issue #25)');
}

/**
 * The auth boundary: `true` for the protected API surface, `false` for `/health` and the
 * static/SPA paths (so the dashboard can bootstrap and prompt for a token). `path` is the
 * already-normalized pathname (`url.pathname.replace(/\/+$/, '') || '/'`).
 */
export function requiresAuth(path: string): boolean {
  void path;
  throw new Error('requiresAuth not implemented (issue #25)');
}
