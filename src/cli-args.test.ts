/**
 * CLI argument parsing tests. The load-bearing case is the safety default: without `--real`, the
 * CLI must stay in stub/fake mode so it never spends tokens or touches GitHub by accident.
 */

import { describe, expect, it } from 'vitest';

import { parseCliArgs } from './cli-args';

describe('parseCliArgs', () => {
  it('defaults to stub/fake mode (never real unless asked) with safe defaults', () => {
    const args = parseCliArgs(['owner/repo#1']);
    expect(args.real).toBe(false); // SAFETY: no tokens / no GitHub unless --real
    expect(args.cheap).toBe(false);
    expect(args.db).toBe(':memory:');
    expect(args.base).toBe('main');
    expect(args.work).toBe('./.agent-work');
    expect(args.positionals).toEqual(['owner/repo#1']);
  });

  it('reads the real-mode flags and config (both --key value and --key=value)', () => {
    const args = parseCliArgs(['owner/repo#1', '--real', '--cheap', '--repo', 'o/r', '--base=develop', '--work', '/tmp/w']);
    expect(args.real).toBe(true);
    expect(args.cheap).toBe(true);
    expect(args.repo).toBe('o/r');
    expect(args.base).toBe('develop');
    expect(args.work).toBe('/tmp/w');
  });

  it('keeps the resume subcommand and run id as positionals', () => {
    const args = parseCliArgs(['resume', '7', '--db', 'run.db']);
    expect(args.positionals).toEqual(['resume', '7']);
    expect(args.db).toBe('run.db');
  });

  it('errors loudly on an unknown flag instead of ignoring it', () => {
    expect(() => parseCliArgs(['owner/repo#1', '--bogus'])).toThrow();
  });
});
