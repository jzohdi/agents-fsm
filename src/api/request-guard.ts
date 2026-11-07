/**
 * Cross-site request guard — pure, dependency-light, unit-testable in isolation (the `auth.ts` /
 * `bind-guard.ts` pattern: no `node:http`, `process`, or orchestrator).
 *
 * With auth off (the localhost default) the daemon trusts whoever can reach it. A browser on this
 * machine can reach it too, on behalf of any page it visits:
 *  - a cross-site "simple" POST (a `text/plain` fetch or an HTML form) needs no CORS preflight, so the
 *    browser sends it and only hides the reply — the run still starts;
 *  - DNS rebinding points an attacker's hostname at 127.0.0.1, making reads same-origin for the page.
 *
 * So, while no API token is set, every request must name an allowed `Host` (loopback names, the bound
 * host, or an allow-listed origin's hostname), and every state-changing request that carries an
 * `Origin` must come from the same origin, the dev dashboard or an allow-listed origin. A page on another
 * local port is not trusted: it may be any project's dev server. With a token configured the bearer
 * token is the boundary and this guard steps aside (a cross-site page can't read or guess the token).
 */

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const STATE_CHANGING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '[::]']);
/** `npm run dev:dashboard`'s Vite dev server (its default port): the proxy forwards the page's Origin.
 *  Other local ports are not trusted — a page there may be any project's dev server. */
const DEV_DASHBOARD_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/** `name[:port]` or `[ipv6][:port]`, the only shapes a browser puts in `Host`. */
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::\d*)?$/;

/** Hostname of a `Host` header value: lowercased, port dropped, an IPv6 literal kept bracketed. A
 *  malformed value (`[::1]evil`, `a:1:2`, `localhost:abc`) comes back whole, so it matches no allowed
 *  name. A trailing dot (`localhost.`) is kept, so it doesn't match either. */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  return HOST_HEADER.exec(h)?.[1] ?? h;
}

/** The `Host` names the daemon answers: loopback, the bound host (unless a wildcard), and the hostname
 *  of each allow-listed origin (e.g. a tunnel's public name). Malformed origins are skipped. */
export function buildAllowedHosts(bindHost: string | undefined, allowedOrigins: readonly string[]): Set<string> {
  const hosts = new Set(LOOPBACK_HOSTNAMES);
  let bound = (bindHost ?? '').trim().toLowerCase();
  if (bound.includes(':') && !bound.startsWith('[')) bound = `[${bound}]`; // bare IPv6 → URL/Host form
  if (bound !== '' && !WILDCARD_HOSTS.has(bound)) hosts.add(bound);
  for (const origin of allowedOrigins) {
    try {
      hosts.add(new URL(origin).hostname.toLowerCase());
    } catch {
      // not a URL — it can never match a request's Origin either
    }
  }
  return hosts;
}

export interface RequestPolicy {
  /** An API token is configured: the token gate is the boundary, so the guard admits everything. */
  authOn: boolean;
  allowedHosts: ReadonlySet<string>;
  /** `FLEET_CORS_ORIGINS`: exact origins trusted for writes (and for CORS reads). */
  allowedOrigins: readonly string[];
}

export interface GuardedRequest {
  method: string;
  host?: string;
  origin?: string;
  secFetchSite?: string;
}

export type GuardVerdict = { ok: true } | { ok: false; status: 403; reason: string };

const ALLOW: GuardVerdict = { ok: true };
const deny = (reason: string): GuardVerdict => ({ ok: false, status: 403, reason });
const HOST_DENIED = deny(
  'host not allowed: open the dashboard at 127.0.0.1 or localhost, set FLEET_API_TOKEN, or add its origin to FLEET_CORS_ORIGINS',
);
const ORIGIN_DENIED = deny('cross-origin request refused: add the origin to FLEET_CORS_ORIGINS or set FLEET_API_TOKEN');

/** Decide whether a request may proceed (see the module comment for the threat it closes). */
export function checkRequest(req: GuardedRequest, policy: RequestPolicy): GuardVerdict {
  if (policy.authOn) return ALLOW;
  if (!req.host || !policy.allowedHosts.has(hostnameOf(req.host))) return HOST_DENIED;
  if (!STATE_CHANGING.has(req.method)) return ALLOW;

  if (req.origin === undefined) {
    // Non-browser clients (curl, scripts, tests) send no Origin. Browsers send Origin on every
    // POST/PUT/PATCH/DELETE ("null" when the referrer is hidden), so Referer adds nothing; a browser
    // that somehow omits Origin still says where the request came from in Sec-Fetch-Site.
    return req.secFetchSite === 'cross-site' || req.secFetchSite === 'same-site' ? ORIGIN_DENIED : ALLOW;
  }
  if (policy.allowedOrigins.includes(req.origin) || DEV_DASHBOARD_ORIGINS.includes(req.origin)) return ALLOW;
  // Same origin: the dashboard itself, including through `ssh -L` on another port (Host matches).
  let origin: URL;
  try {
    origin = new URL(req.origin); // the opaque origin "null" (sandboxed frames, file://) throws here
  } catch {
    return ORIGIN_DENIED;
  }
  const httpScheme = origin.protocol === 'http:' || origin.protocol === 'https:';
  return httpScheme && origin.host === req.host.trim().toLowerCase() ? ALLOW : ORIGIN_DENIED;
}

/** True for `application/json` with or without parameters (`; charset=utf-8`). */
export function isJsonContentType(contentType: string | undefined): boolean {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json';
}
