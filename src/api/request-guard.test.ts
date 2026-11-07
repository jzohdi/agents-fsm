import { describe, expect, it } from 'vitest';

import { buildAllowedHosts, checkRequest, hostnameOf, isJsonContentType, type RequestPolicy } from './request-guard';

const authOff = (allowedOrigins: string[] = [], bindHost?: string): RequestPolicy => ({
  authOn: false,
  allowedHosts: buildAllowedHosts(bindHost, allowedOrigins),
  allowedOrigins,
});

describe('hostnameOf', () => {
  it.each([
    ['127.0.0.1:4319', '127.0.0.1'],
    ['LOCALHOST', 'localhost'],
    [' localhost:80 ', 'localhost'],
    ['[::1]:80', '[::1]'],
    ['[::1]', '[::1]'],
    ['evil.example:4319', 'evil.example'],
    ['127.0.0.1:', '127.0.0.1'],
    ['localhost.:4319', 'localhost.'],
    // malformed values come back whole, so they match no allowed name
    ['127.0.0.1:80:evil', '127.0.0.1:80:evil'],
    ['[::1]evil.example', '[::1]evil.example'],
    ['[::1]:80:x', '[::1]:80:x'],
    ['localhost:abc', 'localhost:abc'],
  ])('%s → %s', (host, expected) => {
    expect(hostnameOf(host)).toBe(expected);
  });
});

describe('buildAllowedHosts', () => {
  it('is the loopback names by default', () => {
    expect([...buildAllowedHosts(undefined, [])].sort()).toEqual(['127.0.0.1', '[::1]', 'localhost']);
  });

  it('adds a specific bound host, never a wildcard', () => {
    expect(buildAllowedHosts('100.64.0.5', []).has('100.64.0.5')).toBe(true);
    expect(buildAllowedHosts('0.0.0.0', []).size).toBe(3);
    expect(buildAllowedHosts('::', []).size).toBe(3);
  });

  it('brackets a bare IPv6 bound host, as it appears in Host', () => {
    expect(buildAllowedHosts('fd00::5', []).has('[fd00::5]')).toBe(true);
  });

  it("adds each allow-listed origin's hostname and skips malformed ones", () => {
    const hosts = buildAllowedHosts(undefined, ['https://Fleet.example:8443', 'not a url']);
    expect(hosts.has('fleet.example')).toBe(true);
    expect(hosts.size).toBe(4);
  });
});

describe('checkRequest (auth off)', () => {
  const policy = authOff();
  const host = '127.0.0.1:4319';

  it('refuses a foreign or missing Host for reads and writes (DNS rebinding)', () => {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      expect(checkRequest({ method, host: 'evil.example:4319' }, policy)).toMatchObject({ ok: false, status: 403 });
    }
    expect(checkRequest({ method: 'GET' }, policy).ok).toBe(false);
  });

  it('accepts loopback Host names on any port (ssh -L, another port), in any case', () => {
    expect(checkRequest({ method: 'GET', host: 'localhost:9999' }, policy).ok).toBe(true);
    expect(checkRequest({ method: 'GET', host: 'LOCALHOST:4319' }, policy).ok).toBe(true);
    expect(checkRequest({ method: 'GET', host: '[::1]:4319' }, policy).ok).toBe(true);
  });

  it.each(['', 'localhost.:4319', '[::1]evil.example', '[::ffff:127.0.0.1]:4319', '127.0.0.2:4319', 'localhost:abc'])(
    'refuses the near-miss Host %j',
    (host) => expect(checkRequest({ method: 'GET', host }, policy).ok).toBe(false),
  );

  it('accepts a write with no Origin (curl, scripts) unless Sec-Fetch-Site says it is cross-site', () => {
    expect(checkRequest({ method: 'POST', host }, policy).ok).toBe(true);
    expect(checkRequest({ method: 'POST', host, secFetchSite: 'same-origin' }, policy).ok).toBe(true);
    expect(checkRequest({ method: 'POST', host, secFetchSite: 'cross-site' }, policy).ok).toBe(false);
    expect(checkRequest({ method: 'DELETE', host, secFetchSite: 'same-site' }, policy).ok).toBe(false);
  });

  it.each(['http://evil.example', 'null', 'file://', 'chrome-extension://abc', 'not a url', 'http://localhost:3000', 'http://[::1]:9', 'https://localhost:5173'])('refuses a write from Origin %s', (origin) => {
    expect(checkRequest({ method: 'POST', host, origin }, policy)).toMatchObject({ ok: false, status: 403 });
  });

  it('accepts writes from the same origin, the dev dashboard (Vite on 5173), or an allow-listed origin', () => {
    expect(checkRequest({ method: 'POST', host, origin: 'http://localhost:5173' }, policy).ok).toBe(true);
    expect(checkRequest({ method: 'POST', host, origin: 'http://127.0.0.1:5173' }, policy).ok).toBe(true);
    expect(checkRequest({ method: 'POST', host: 'localhost:8080', origin: 'http://localhost:8080' }, policy).ok).toBe(true); // ssh -L
    expect(checkRequest({ method: 'PUT', host, origin: `http://${host}` }, policy).ok).toBe(true);
    const tunnel = authOff(['https://ops.example']);
    expect(checkRequest({ method: 'POST', host: 'ops.example', origin: 'https://ops.example' }, tunnel).ok).toBe(true);
  });

  it('accepts the bound host as Host, and an Origin on it', () => {
    const lan = authOff([], '100.64.0.5');
    expect(checkRequest({ method: 'POST', host: '100.64.0.5:4319', origin: 'http://100.64.0.5:4319' }, lan).ok).toBe(true);
  });

  it('lets reads through with any Origin (CORS already hides the reply)', () => {
    expect(checkRequest({ method: 'GET', host, origin: 'http://evil.example' }, policy).ok).toBe(true);
  });
});

describe('checkRequest (auth on)', () => {
  it('steps aside: the token gate is the boundary', () => {
    const policy: RequestPolicy = { ...authOff(), authOn: true };
    expect(checkRequest({ method: 'GET', host: 'evil.example' }, policy).ok).toBe(true);
    expect(checkRequest({ method: 'POST', host: 'evil.example', origin: 'null', secFetchSite: 'cross-site' }, policy).ok).toBe(true);
    expect(checkRequest({ method: 'POST' }, policy).ok).toBe(true);
  });
});

describe('isJsonContentType', () => {
  it('matches application/json alone or with a UTF-8 charset, case-insensitively', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/json; charset="UTF-8"')).toBe(true);
    expect(isJsonContentType('application/json; charset=latin1')).toBe(false);
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false);
    expect(isJsonContentType('application/json-patch+json')).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });

  it.each(['application/json;,text/plain', 'application/json; x=,text/plain', 'application/json;x=", text/plain"', 'application/json;charset=utf-8, text/plain'])(
    'refuses the comma trick %j (a browser may send it without a preflight)',
    (ct) => expect(isJsonContentType(ct)).toBe(false),
  );
});
