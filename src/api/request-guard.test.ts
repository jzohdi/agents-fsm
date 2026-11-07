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

  it('accepts loopback Host names on any port (ssh -L, another port)', () => {
    expect(checkRequest({ method: 'GET', host: 'localhost:9999' }, policy).ok).toBe(true);
    expect(checkRequest({ method: 'GET', host: '[::1]:4319' }, policy).ok).toBe(true);
  });

  it('accepts a write with no Origin (curl, scripts) unless Sec-Fetch-Site says it is cross-site', () => {
    expect(checkRequest({ method: 'POST', host }, policy).ok).toBe(true);
    expect(checkRequest({ method: 'POST', host, secFetchSite: 'same-origin' }, policy).ok).toBe(true);
    expect(checkRequest({ method: 'POST', host, secFetchSite: 'cross-site' }, policy).ok).toBe(false);
    expect(checkRequest({ method: 'DELETE', host, secFetchSite: 'same-site' }, policy).ok).toBe(false);
  });

  it.each(['http://evil.example', 'null', 'file://', 'chrome-extension://abc', 'not a url'])('refuses a write from Origin %s', (origin) => {
    expect(checkRequest({ method: 'POST', host, origin }, policy)).toMatchObject({ ok: false, status: 403 });
  });

  it('accepts writes from a loopback origin, the same origin, or an allow-listed origin', () => {
    expect(checkRequest({ method: 'POST', host, origin: 'http://localhost:5173' }, policy).ok).toBe(true);
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
  it('matches application/json with or without parameters, case-insensitively', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});
