/**
 * Dashboard API token storage + URL helper (issue #25).
 *
 * The daemon's API + SSE can require a shared-secret bearer token. The browser stores it in
 * `localStorage`, attaches it as `Authorization: Bearer <token>` on fetches, and — because
 * `EventSource` can't set headers — appends it as `?token=` on the SSE URL. Keeping the URL/header
 * building pure (a `token` argument, not a hidden `localStorage` read) lets a small vitest cover it
 * (mirrors `model-picker.ts`).
 *
 * TDD stage (issue #25): intentionally UNIMPLEMENTED stubs — signatures pin the contract from
 * `.agent/interface.md` so `auth.test.ts` compiles and fails for the right reason (missing
 * behaviour). The implementation stage fills the bodies in.
 */

const STORAGE_KEY = 'fleet_api_token';
void STORAGE_KEY;

/** The stored token, or `null` when none is set. */
export function getToken(): string | null {
  throw new Error('getToken not implemented (issue #25)');
}

/** Store a token; a blank/whitespace-only value clears it instead. */
export function setToken(token: string): void {
  void token;
  throw new Error('setToken not implemented (issue #25)');
}

/** Remove the stored token. */
export function clearToken(): void {
  throw new Error('clearToken not implemented (issue #25)');
}

/**
 * Append `?token=<token>` (URL-encoded) to a same-origin path for the SSE URL. Uses the passed
 * `token` when provided, else the stored token; preserves an existing query string (uses `&` vs
 * `?`); returns `path` unchanged when there is no token.
 */
export function withToken(path: string, token?: string | null): string {
  void path;
  void token;
  throw new Error('withToken not implemented (issue #25)');
}
