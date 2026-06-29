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
  };
}
