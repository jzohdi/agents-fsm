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
  /**
   * Session override for the default harness a new run gets (`claude-code` | `cursor`) — `--harness`.
   * Takes precedence over the persisted default (see `resolveDefaultHarness`) but does not clobber it.
   * Undefined here → falls back to `FLEET_HARNESS`, then the persisted setting, then `claude-code`.
   */
  harness?: string;
  /** Per-invocation wall-clock cap in **minutes** — `--timeout`. */
  timeoutMinutes?: number;
  /** How many times to retry a rate-limited harness invocation before escalating — `--max-retries`. */
  maxRetries?: number;
  /** How long to keep polling for a human reply when triage asks a question, in **minutes**. 0 disables polling. `--poll-timeout`. */
  pollTimeoutMinutes: number;
  /** Delay between reply-poll checks, in **seconds** — `--poll-interval`. Also drives PR-feedback polling. */
  pollIntervalSeconds: number;
  /** Marker a PR comment must start with to be treated as actionable feedback — `--feedback-marker`. Default `feedback:`. */
  feedbackMarker: string;
  /** Stage a run re-enters when PR feedback arrives on its open PR — `--feedback-reentry`. Default `plan`. */
  feedbackReentryState: string;
  /** FSM config file the daemon/CLI runs under; enables `PUT /config` to persist edits — `--config`. */
  config?: string;
  /** Port the `serve` daemon listens on — `--port`. Default 4319. */
  port: number;
  /**
   * Global concurrency cap for the `serve` daemon's drain pump (Milestone 8 Phase B) — `--concurrency`.
   * Undefined here means "not set on the command line"; the daemon then falls back to `FLEET_CONCURRENCY`
   * or its default (see `build-runner`). The one-shot CLI drains serially regardless of this flag.
   */
  concurrency?: number;
  /**
   * Global cost ceiling in dollars for the `serve` daemon (Milestone 8 B3) — `--cost-ceiling`. When the
   * aggregate `cost_used` of active runs reaches this, new runs are refused and existing runs park until
   * an operator overrides them. Undefined here → falls back to `FLEET_COST_CEILING` or off (no ceiling).
   */
  costCeiling?: number;
  /**
   * Shared-secret bearer token for the `serve` daemon's API + SSE (issue #25) — `--api-token`. Undefined
   * here → falls back to `FLEET_API_TOKEN`, then auth is disabled (the localhost-only default). Env-only
   * in practice; never persisted to SQLite (README §9.1).
   */
  apiToken?: string;
  /**
   * Bind address for the `serve` daemon (issue #26) — `--host`. Undefined here → falls back to
   * `FLEET_HOST`, then `127.0.0.1` (loopback, the unchanged default). Binding off-loopback requires an
   * API token (the bind guard, `src/api/bind-guard.ts`), else the daemon fails fast at boot.
   */
  host?: string;
  /**
   * PEM cert path for direct TLS termination on the `serve` daemon (issue #26) — `--tls-cert`. Both
   * `--tls-cert` and `--tls-key` must be given together; absent ⇒ plain HTTP (the unchanged default).
   */
  tlsCert?: string;
  /** PEM private-key path paired with `--tls-cert` (issue #26) — `--tls-key`. */
  tlsKey?: string;
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
      harness: { type: 'string' },
      timeout: { type: 'string' },
      'max-retries': { type: 'string' },
      'poll-timeout': { type: 'string' },
      'poll-interval': { type: 'string' },
      'feedback-marker': { type: 'string' },
      'feedback-reentry': { type: 'string' },
      config: { type: 'string' },
      port: { type: 'string' },
      concurrency: { type: 'string' },
      'cost-ceiling': { type: 'string' },
      'api-token': { type: 'string' },
      host: { type: 'string' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
    },
  });
  const mock = values.mock ?? false;
  const work = values.work ?? './.agent-work';
  // A `serve` daemon must survive restarts — its `recover()` reclaims stranded events and resumes
  // queued work — so default it to an **on-disk** DB under the working root. Without this, a daemon
  // silently loses every run on shutdown. The one-shot CLI and any `--mock` run stay ephemeral
  // (`:memory:`): a single watched run / a no-cost test has no state worth persisting.
  const serving = positionals[0] === 'serve';
  const db = values.db ?? (serving && !mock ? `${work}/run.db` : ':memory:');
  return {
    positionals,
    db,
    mock,
    cheap: values.cheap ?? false,
    repo: values.repo,
    base: values.base ?? 'main',
    work,
    cloneUrl: values['clone-url'],
    localRepo: values['local-repo'],
    permissionMode: values['permission-mode'],
    model: values.model,
    harness: values.harness,
    timeoutMinutes: values.timeout !== undefined ? Number(values.timeout) : undefined,
    ...(values['max-retries'] !== undefined ? { maxRetries: Number(values['max-retries']) } : {}),
    pollTimeoutMinutes: values['poll-timeout'] !== undefined ? Number(values['poll-timeout']) : 30,
    pollIntervalSeconds: values['poll-interval'] !== undefined ? Number(values['poll-interval']) : 15,
    feedbackMarker: values['feedback-marker'] ?? 'feedback:',
    feedbackReentryState: values['feedback-reentry'] ?? 'plan',
    config: values.config,
    port: values.port !== undefined ? Number(values.port) : 4319,
    ...(values.concurrency !== undefined ? { concurrency: Number(values.concurrency) } : {}),
    ...(values['cost-ceiling'] !== undefined ? { costCeiling: Number(values['cost-ceiling']) } : {}),
    apiToken: values['api-token'],
  };
}
