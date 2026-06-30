/**
 * Demo / operator CLI: start a run and watch it advance through the FSM, or resume a parked run.
 *
 * Two modes:
 *  - **real (default)** — the Claude Code subprocess executor + the `gh`/`git`-backed `GitHubCli`
 *    with the real composed system prompts (Milestone 4b). This spends tokens and creates a real
 *    branch + PR. Preconditions: `gh auth status` logged in with push access, `ANTHROPIC_API_KEY`
 *    set (plans/milestone-4.md §6), and `--repo <owner/name>`.
 *  - **stub/fake (`--mock`)** — the `StubExecutor` + `FakeGitHub`, so it makes no network calls and
 *    costs nothing. Milestone 2 validated the orchestration mechanism this way; the tests and UI dev
 *    use it. The `FakeGitHub` auto-seeds issues, so any issueRef works.
 *
 * Usage:
 *   tsx src/cli.ts <issueRef> --repo o/r [--base main]                       # start (real, the default)
 *                  [--work ./.agent-work] [--cheap] [--db <path>]
 *                  [--local-repo <path>] [--clone-url <url>] [--permission-mode <mode>] [--model sonnet] [--timeout <min>]
 *   tsx src/cli.ts <issueRef> --mock [--db <path>]                           # start (no tokens / no network)
 *   tsx src/cli.ts resume <runId> [--repo o/r ...] [--mock] [--db <path>]    # resume a needs_human run
 *   tsx src/cli.ts serve [--port 4319] [--db <path>] [--config <path>] [--mock]  # run the daemon (HTTP API + live stream, M5)
 *
 * With no `--db` it uses an in-memory database (nothing persists); `resume` across processes needs a
 * file path. `--cheap`
 * pins every phase to the cheap model (haiku) — proves plumbing but too weak to follow the JSON
 * contract to `done`; `--model sonnet` runs produce/review on a cheaper-than-opus model that does.
 * `--local-repo` clones each run's working tree from a local checkout (offline) while still pushing.
 * Arg parsing is `node:util parseArgs`, so both `--key value` and `--key=value` work and unknown
 * flags error.
 */

import { loadDefaultConfig } from './fsm/config';
import { openDb } from './store/db';
import { Repository } from './store/repository';
import type { PhaseActivity } from './agent/runner';
import { FatalExecutorError } from './agent/executor';
import type { GitHub } from './integration/github';
import { parseIssueRef } from './integration/refs';
import { EventLoop } from './loop/event-loop';
import { ReplyPoller } from './loop/reply-poller';
import { parseCliArgs, type CliArgs } from './cli-args';
import { buildRunner } from './build-runner';
import { serve } from './serve';

/** Print one live agent activity, indented under the current transition for a readable run trace. */
function printActivity(a: PhaseActivity): void {
  console.log(`     · [${a.stage}:${a.phase}] ${a.activity.summary}`);
}

function buildLoop(args: CliArgs, repoRef: string): { repo: Repository; loop: EventLoop; version: string; github: GitHub } {
  const { fsm, agents, version } = loadDefaultConfig();
  const repo = new Repository(openDb(args.db));
  if (!args.mock) {
    const model = args.cheap ? 'cheap (haiku, plumbing only)' : args.model ?? 'default (opus)';
    console.log(`[real mode] repo=${args.repo ?? repoRef} base=${args.base} work=${args.work} model=${model} — spends tokens, opens a real PR. (pass --mock for a no-cost run)`);
  }
  const { runner, github } = buildRunner(args, repo, agents, repoRef, { onActivity: printActivity });
  const loop = new EventLoop(repo, fsm, version, runner, {
    onTransition: (t) => console.log(`  ${t.fromState.padEnd(18)} --${t.trigger}-->  ${t.toState}`),
  });
  return { repo, loop, version, github };
}

/**
 * Drain the loop, then — if any run is parked waiting on a human reply (triage `clarify`) — poll the
 * issue thread for the answer and resume, until everything settles or the poll budget runs out. This
 * is the cheap, polling-based human-in-the-loop the operator opts into via `--poll-timeout`.
 */
async function drainWithReplyPolling(args: CliArgs, repo: Repository, loop: EventLoop, github: GitHub): Promise<void> {
  await loop.runUntilIdle();
  const awaiting = repo.listRuns('awaiting_input');
  if (awaiting.length === 0 || args.pollTimeoutMinutes <= 0) {
    if (awaiting.length > 0) {
      console.log(`\n⏸  ${awaiting.length} run(s) awaiting a human reply on the issue. Polling disabled (--poll-timeout 0); reply, then re-run to resume.`);
    }
    return;
  }
  console.log(
    `\n⏳ ${awaiting.length} run(s) awaiting your reply on the issue. Polling every ${args.pollIntervalSeconds}s for up to ${args.pollTimeoutMinutes}m…`,
  );
  const poller = new ReplyPoller(repo, github, loop, { intervalMs: args.pollIntervalSeconds * 1000 });
  await poller.poll({ maxWaitMs: args.pollTimeoutMinutes * 60_000, drain: () => loop.runUntilIdle() });
}

function report(repo: Repository, runId: number): void {
  const run = repo.getRun(runId);
  const agentRuns = repo.listAgentRuns(runId);
  console.log(`\nRun ${runId} finished in state "${run?.currentState}" (status: ${run?.status}).`);
  console.log(`Agent invocations: ${agentRuns.length}; tokens used: ${run?.tokensUsed}; cost: $${run?.costUsed?.toFixed(4) ?? '0'}.`);

  // On escalation, surface *why* (the cause is otherwise only in the DB) and how to continue.
  if (run?.status === 'needs_human') {
    const last = repo.listTransitions(runId).at(-1);
    console.log(`\n⚠️  Escalated to needs_human via "${last?.trigger ?? '?'}". Reason:`);
    console.log(indent(formatReason(last?.reason)));
    console.log(`\nFix the cause, then resume:  npm start -- resume ${runId} --repo <owner/name> [--model …] [--local-repo …] [--db <path>]`);
  }

  // Awaiting a human reply: triage asked a question on the issue. Tell the operator how to pick it
  // back up after replying (the poll budget for this session has elapsed).
  if (run?.status === 'awaiting_input') {
    const last = repo.listTransitions(runId).at(-1);
    console.log(`\n💬  Awaiting your reply on the issue. Triage asked:`);
    console.log(indent(formatReason(last?.reason)));
    console.log(`\nReply on the issue, then resume:  npm start -- resume ${runId} --repo <owner/name> --db <path>`);
  }
}

/** Pretty-print a transition reason (structured payload or string) for the terminal. */
function formatReason(reason: unknown): string {
  if (reason === undefined || reason === null) return '(no reason recorded)';
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason, null, 2);
  } catch {
    return String(reason);
  }
}

function indent(text: string): string {
  return text.split('\n').map((line) => `    ${line}`).join('\n');
}

async function start(args: CliArgs): Promise<void> {
  // A bare `start` only has a safe default in mock mode (the fake auto-seeds any issue). In real mode
  // we refuse to invent an issue/repo — point the operator at the two supported ways to begin instead.
  let issueRef = args.positionals[0] ?? (args.mock ? 'demo/repo#1' : undefined);
  if (!issueRef) {
    console.error(
      [
        'No issue to run. Either:',
        '  • run one issue from the CLI:   npm start -- owner/repo#123 --repo owner/repo',
        '  • or start the app + dashboard and submit runs from the new-run box:',
        '        npm run dev            (build-watch + daemon)',
        '        npm start -- serve     (daemon only)',
        '  • no-cost demo run (fake harness, no tokens/GitHub):   npm start -- --mock',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }
  // Accept a pasted issue URL or clone string and normalize to the canonical owner/repo#N (see
  // integration/refs). Tolerate non-canonical refs in mock mode, where the fake seeds any ref.
  let repoRef: string;
  try {
    const parsed = parseIssueRef(issueRef);
    issueRef = parsed.ref;
    repoRef = parsed.repo;
  } catch {
    repoRef = issueRef.split('#')[0] ?? issueRef;
  }
  const { repo, loop, version, github } = buildLoop(args, repoRef);

  console.log(`Config version ${version}; starting run for issue ${issueRef}`);
  loop.recover(); // no-op on a fresh DB; proves the startup sweep is wired
  const run = loop.startRun({ issueRef, repoRef });
  console.log(`Run ${run.id} created in state "${run.currentState}". Transitions:`);

  await drainWithReplyPolling(args, repo, loop, github);
  report(repo, run.id);
}

async function resume(args: CliArgs): Promise<void> {
  const runId = Number(args.positionals[1]);
  if (!Number.isInteger(runId)) throw new Error('usage: cli.ts resume <runId> [--repo o/r ...] [--mock] [--db <path>]');
  const { repo, loop, github } = buildLoop(args, '');

  loop.recover();
  const run = repo.getRun(runId);
  if (!run) throw new Error(`resume: run ${runId} not found (did you pass the same --db?)`);

  if (run.status === 'awaiting_input') {
    // The run is waiting on a human reply (triage clarify). Don't force a transition — just check the
    // issue for the answer (drainWithReplyPolling polls) and let it pick back up when the reply lands.
    console.log(`Run ${runId} is awaiting a human reply on its issue. Checking for it…`);
  } else {
    console.log(`Resuming run ${runId}. Transitions:`);
    loop.resumeRun(runId);
  }
  await drainWithReplyPolling(args, repo, loop, github);
  report(repo, runId);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.positionals[0] === 'serve') {
    await serve(args); // start the daemon (HTTP API + live stream) and keep running
  } else if (args.positionals[0] === 'resume') {
    await resume(args);
  } else {
    await start(args);
  }
}

main().catch((err) => {
  // A fatal, environment-level failure (e.g. the harness is unauthenticated) affects every run, so
  // we shut down and print actionable instructions rather than a stack trace (plans/milestone-4.md §6).
  if (err instanceof FatalExecutorError) {
    console.error(`\n✖ Aborting — ${err.message}\n\n${err.remedy}\n`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
