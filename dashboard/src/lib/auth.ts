/**
 * Dashboard API token storage + URL helper (issue #25).
 *
 * The daemon's API + SSE can require a shared-secret bearer token. The browser stores it in
 * `localStorage`, attaches it as `Authorization: Bearer <token>` on fetches, and — because
 * `EventSource` can't set headers — appends it as `?token=` on the SSE URL. Keeping the URL/header
 * building pure (a `token` argument, not a hidden `localStorage` read) lets a small vitest cover it
 * (mirrors `model-picker.ts`).
 */

const STORAGE_KEY = 'fleet_api_token';

/** The stored token, or `null` when none is set (or `localStorage` is unavailable, e.g. under SSR/tests). */
export function getToken(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(STORAGE_KEY) || null;
}

/** Store a token; a blank/whitespace-only value clears it instead. */
export function setToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed === '') return clearToken();
  localStorage.setItem(STORAGE_KEY, trimmed);
}

/** Remove the stored token. */
export function clearToken(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Append `?token=<token>` (URL-encoded) to a same-origin path for the SSE URL. Uses the passed
 * `token` when provided, else the stored token; preserves an existing query string (uses `&` vs
 * `?`); returns `path` unchanged when there is no token.
 */
export function withToken(path: string, token?: string | null): string {
  const tok = token === undefined ? getToken() : token;
  if (!tok) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(tok)}`;
}
