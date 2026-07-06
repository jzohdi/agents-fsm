/** Thin fetch client for the Layer 6 API. Throws `Error(message)` from the server's `{ error }` body. */

import { getToken } from './auth';

/**
 * A `401` from the daemon (issue #25): the API requires a token and the stored one is missing/invalid.
 * The store catches this to raise the token prompt (distinct from a generic load failure).
 */
export class AuthError extends Error {
  readonly status = 401;
  constructor(message = 'authentication required') {
    super(message);
    this.name = 'AuthError';
  }
}

export async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method };
  // Build one headers object so the bearer token (issue #25) never clobbers the JSON content type.
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (Object.keys(headers).length) opts.headers = headers;
  const res = await fetch(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) throw new AuthError((data && data.error) || 'authentication required');
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data as T;
}
