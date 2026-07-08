/**
 * CLI argument parsing tests. The load-bearing case is the mode default: runs are real unless
 * `--mock` is passed, so `mock` defaults to `false` (and the other defaults stay sane).
 */

import { describe, expect, it } from 'vitest';

import { parseCliArgs } from './cli-args';

describe('parseCliArgs', () => {
  it('defaults to a real run (mock off) with safe defaults', () => {
    const args = parseCliArgs(['owner/repo#1']);
    expect(args.mock).toBe(false); // real by default; --mock opts into the no-cost stub/fake harness
    expect(args.cheap).toBe(false);
    expect(args.db).toBe(':memory:');
    expect(args.base).toBe('main');
    expect(args.work).toBe('./.agent-work');
    expect(args.positionals).toEqual(['owner/repo#1']);
    // Reply polling is on by default with sane cadence/budget.
    expect(args.pollTimeoutMinutes).toBe(30);
    expect(args.pollIntervalSeconds).toBe(15);
    // Daemon defaults (M5): a fixed port, no config file (so PUT /config is read-only).
    expect(args.port).toBe(4319);
    expect(args.config).toBeUndefined();
    // Concurrency is unset on the command line by default; the daemon resolves its own fallback.
    expect(args.concurrency).toBeUndefined();
  });

  it('reads the serve daemon flags', () => {
    const args = parseCliArgs(['serve', '--port', '8080', '--config=/etc/af/fsm.json', '--concurrency', '8', '--cost-ceiling', '25']);
    expect(args.positionals).toEqual(['serve']);
    expect(args.port).toBe(8080);
    expect(args.config).toBe('/etc/af/fsm.json');
    expect(args.concurrency).toBe(8);
    expect(args.costCeiling).toBe(25);
  });

  it('reads the remote-access flags (--host / --tls-cert / --tls-key), both --key value and --key=value', () => {
    const args = parseCliArgs(['serve', '--host', '0.0.0.0', '--tls-cert=/etc/af/cert.pem', '--tls-key', '/etc/af/key.pem']);
    expect(args.host).toBe('0.0.0.0');
    expect(args.tlsCert).toBe('/etc/af/cert.pem');
    expect(args.tlsKey).toBe('/etc/af/key.pem');
  });

  it('leaves the remote-access flags undefined when unset (the resolver owns the loopback default)', () => {
    const args = parseCliArgs(['serve']);
    expect(args.host).toBeUndefined(); // NOT defaulted to 127.0.0.1 here — resolveHost does that
    expect(args.tlsCert).toBeUndefined();
    expect(args.tlsKey).toBeUndefined();
  });

  it('reads the reply-poll overrides', () => {
    const args = parseCliArgs(['owner/repo#1', '--poll-timeout', '5', '--poll-interval=30']);
    expect(args.pollTimeoutMinutes).toBe(5);
    expect(args.pollIntervalSeconds).toBe(30);
  });

  it('reads the run flags and config (both --key value and --key=value)', () => {
    const args = parseCliArgs([
      'owner/repo#1', '--mock', '--cheap', '--repo', 'o/r', '--base=develop', '--work', '/tmp/w',
      '--clone-url', 'git@github.com:o/r.git', '--local-repo', '/home/me/o-r', '--permission-mode=acceptEdits',
      '--model', 'sonnet', '--max-retries', '2', '--harness', 'cursor',
    ]);
    expect(args.mock).toBe(true);
    expect(args.cheap).toBe(true);
    expect(args.repo).toBe('o/r');
    expect(args.base).toBe('develop');
    expect(args.work).toBe('/tmp/w');
    expect(args.cloneUrl).toBe('git@github.com:o/r.git');
    expect(args.localRepo).toBe('/home/me/o-r');
    expect(args.permissionMode).toBe('acceptEdits');
    expect(args.model).toBe('sonnet');
    expect(args.maxRetries).toBe(2);
    expect(args.harness).toBe('cursor');
  });

  it('keeps the resume subcommand and run id as positionals', () => {
    const args = parseCliArgs(['resume', '7', '--db', 'run.db']);
    expect(args.positionals).toEqual(['resume', '7']);
    expect(args.db).toBe('run.db');
  });

  it('errors loudly on an unknown flag instead of ignoring it', () => {
    expect(() => parseCliArgs(['owner/repo#1', '--bogus'])).toThrow();
  });

  describe('DB default (serve persists across restarts; one-shot/mock stay ephemeral)', () => {
    it('defaults `serve` to an on-disk DB under the working root so a daemon survives a restart', () => {
      expect(parseCliArgs(['serve', '--repo', 'o/r']).db).toBe('./.agent-work/run.db');
      expect(parseCliArgs(['serve', '--repo', 'o/r', '--work', '/data/agent']).db).toBe('/data/agent/run.db');
    });

    it('keeps `serve --mock` and the one-shot CLI ephemeral (:memory:)', () => {
      expect(parseCliArgs(['serve', '--mock']).db).toBe(':memory:');
      expect(parseCliArgs(['owner/repo#1']).db).toBe(':memory:'); // one-shot run
    });

    it('an explicit --db always wins', () => {
      expect(parseCliArgs(['serve', '--repo', 'o/r', '--db', ':memory:']).db).toBe(':memory:');
      expect(parseCliArgs(['serve', '--repo', 'o/r', '--db', '/tmp/x.db']).db).toBe('/tmp/x.db');
    });
  });
});
