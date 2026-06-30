/** Thin fetch client for the Layer 6 API. Throws `Error(message)` from the server's `{ error }` body. */

export async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data as T;
}
