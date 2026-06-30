/**
 * CLI argument parsing for the demo / operator CLI (separated from `cli.ts` so it is testable
 * without running the loop — `cli.ts` executes `main()` on import).
 *
 * Backed by `node:util parseArgs`, so `--key value` and `--key=value` both work and an unknown flag
 * errors loudly instead of being silently ignored. The defaults matter for safety: `real` defaults
 * to `false`, so the CLI never spends tokens or touches GitHub unless `--real` is passed explicitly.
 */

import { parseArgs } from 'node:util';

export interface CliArgs {
  /** Subcommand + operands: `[]` or `[issueRef]` to start, `['resume', runId]` to resume. */
  positionals: string[];
  db: string;
  real: boolean;
  cheap: boolean;
  repo?: string;
  base: string;
  work: string;
  /** GitHub remote override (e.g. an SSH remote) — `--clone-url`. */
  cloneUrl?: string;
  /** Local checkout to clone the working tree from (fast/offline) — `--local-repo`. */
  localRepo?: string;
  /** Harness permission mode for autonomous edits (e.g. `acceptEdits`) — `--permission-mode`. */
  permissionMode?: string;
  /** Concrete model for produce/self-review phases (e.g. `sonnet`); default is opus — `--model`. */
  model?: string;
  /** Per-invocation wall-clock cap in **minutes** — `--timeout`. */
  timeoutMinutes?: number;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      repo: { type: 'string' },
      base: { type: 'string' },
      work: { type: 'string' },
      real: { type: 'boolean' },
      cheap: { type: 'boolean' },
      'clone-url': { type: 'string' },
      'local-repo': { type: 'string' },
      'permission-mode': { type: 'string' },
      model: { type: 'string' },
      timeout: { type: 'string' },
    },
  });
  return {
    positionals,
    db: values.db ?? ':memory:',
    real: values.real ?? false,
    cheap: values.cheap ?? false,
    repo: values.repo,
    base: values.base ?? 'main',
    work: values.work ?? './.agent-work',
    cloneUrl: values['clone-url'],
    localRepo: values['local-repo'],
    permissionMode: values['permission-mode'],
    model: values.model,
    timeoutMinutes: values.timeout !== undefined ? Number(values.timeout) : undefined,
  };
}
