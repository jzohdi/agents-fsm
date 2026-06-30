/**
 * CLI argument parsing for the demo / operator CLI (separated from `cli.ts` so it is testable
 * without running the loop — `cli.ts` executes `main()` on import).
 *
 * Backed by `node:util parseArgs`, so `--key value` and `--key=value` both work and an unknown flag
 * errors loudly instead of being silently ignored. Runs are **real by default** (the Claude Code
 * harness + `gh`/`git` adapter — spends tokens, touches GitHub); pass `--mock` to use the stub
 * executor + in-memory fake GitHub instead (no tokens, no network), as the tests and UI dev do.
 */

import { parseArgs } from 'node:util';

export interface CliArgs {
  /** Subcommand + operands: `[]` or `[issueRef]` to start, `['resume', runId]` to resume. */
  positionals: string[];
  db: string;
  /** Use the stub executor + fake GitHub (no tokens, no network). Default `false` → a real run. */
  mock: boolean;
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
  /** How long to keep polling for a human reply when triage asks a question, in **minutes**. 0 disables polling. `--poll-timeout`. */
  pollTimeoutMinutes: number;
  /** Delay between reply-poll checks, in **seconds** — `--poll-interval`. */
  pollIntervalSeconds: number;
  /** FSM config file the daemon/CLI runs under; enables `PUT /config` to persist edits — `--config`. */
  config?: string;
  /** Port the `serve` daemon listens on — `--port`. Default 4319. */
  port: number;
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
      mock: { type: 'boolean' },
      cheap: { type: 'boolean' },
      'clone-url': { type: 'string' },
      'local-repo': { type: 'string' },
      'permission-mode': { type: 'string' },
      model: { type: 'string' },
      timeout: { type: 'string' },
      'poll-timeout': { type: 'string' },
      'poll-interval': { type: 'string' },
      config: { type: 'string' },
      port: { type: 'string' },
    },
  });
  return {
    positionals,
    db: values.db ?? ':memory:',
    mock: values.mock ?? false,
    cheap: values.cheap ?? false,
    repo: values.repo,
    base: values.base ?? 'main',
    work: values.work ?? './.agent-work',
    cloneUrl: values['clone-url'],
    localRepo: values['local-repo'],
    permissionMode: values['permission-mode'],
    model: values.model,
    timeoutMinutes: values.timeout !== undefined ? Number(values.timeout) : undefined,
    pollTimeoutMinutes: values['poll-timeout'] !== undefined ? Number(values['poll-timeout']) : 30,
    pollIntervalSeconds: values['poll-interval'] !== undefined ? Number(values['poll-interval']) : 15,
    config: values.config,
    port: values.port !== undefined ? Number(values.port) : 4319,
  };
}
