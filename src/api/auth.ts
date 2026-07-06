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

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/** Every API path prefix that requires a token (issue #25). Anything not matching → open (static/SPA,
 *  `/health`). A new API route added later must be added here or it ships unauthenticated. */
const API_PREFIXES = [
  '/runs',
  '/repos',
  '/config',
  '/cost',
  '/models',
  '/settings',
  '/suggestions',
  '/scheduler',
  '/fs',
  '/stream',
] as const;

/** SHA-256 digest of a value (fixed 32 bytes) — hashing before comparison hides length + fixes the
 *  equal-length requirement of `timingSafeEqual`. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time equality of a provided credential against the configured token. Returns `false`
 * for an absent/empty `provided`; `true` iff `provided === expected` byte-for-byte (a prefix or a
 * superset of the correct token must be `false`). Implemented via fixed-length SHA-256 digests +
 * `crypto.timingSafeEqual` so it neither leaks the token length nor short-circuits on the first
 * differing byte.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false; // absent/empty ⇒ never a match (no need to hash)
  return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * Extract the bearer credential from a request: `Authorization: Bearer <token>` (case-insensitive
 * scheme) first, then the `?token=` query param (needed for SSE — `EventSource` can't set headers).
 * Returns `undefined` when neither is present, the header is malformed/non-string, or the resolved
 * value is empty.
 */
export function extractToken(headers: IncomingHttpHeaders, url: URL): string | undefined {
  const auth = headers.authorization;
  if (typeof auth === 'string') {
    const space = auth.indexOf(' ');
    if (space > 0 && auth.slice(0, space).toLowerCase() === 'bearer') {
      const token = auth.slice(space + 1);
      if (token !== '') return token;
    }
  }
  return url.searchParams.get('token') || undefined; // empty '' → undefined
}

/**
 * The auth boundary: `true` for the protected API surface, `false` for `/health` and the
 * static/SPA paths (so the dashboard can bootstrap and prompt for a token). `path` is the
 * already-normalized pathname (`url.pathname.replace(/\/+$/, '') || '/'`).
 */
export function requiresAuth(path: string): boolean {
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}
