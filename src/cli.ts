/**
 * Demo / operator CLI: start a run and watch it advance through the FSM, or resume a parked run.
 *
 * Two modes:
 *  - **stub/fake (default)** — the `StubExecutor` + `FakeGitHub`, so the demo makes no network calls
 *    and costs nothing. Milestone 2 validated the orchestration mechanism this way; Milestone 4a
 *    added the working-tree lifecycle through the `GitHub` adapter (here the fake).
 *  - **real (`--real`)** — the Claude Code subprocess executor + the `gh`/`git`-backed `GitHubCli`
 *    with the real composed system prompts (Milestone 4b). This spends tokens and creates a real
 *    branch + PR, so it is opt-in. Preconditions: `gh auth status` logged in with push access,
 *    `ANTHROPIC_API_KEY` set (plans/milestone-4.md §6).
 *
 * Usage:
 *   tsx src/cli.ts <issueRef> [--db <path>]                                  # start (stub/fake)
 *   tsx src/cli.ts <issueRef> --real [--repo o/r] [--base main]             # start (real)
 *                  [--work ./.agent-work] [--cheap] [--db <path>]
 *   tsx src/cli.ts resume <runId> [--real --repo o/r ...] [--db <path>]      # resume a needs_human run
 *
 * With no `--db` it uses an in-memory database (nothing persists); `resume` across processes needs a
 * file path. The demo `FakeGitHub` auto-seeds issues, so any issueRef works in stub mode. `--cheap`
 * pins every phase to the cheap model for a low-cost first real run (README §6). Arg parsing is
 * `node:util parseArgs`, so both `--key value` and `--key=value` work and unknown flags error.
 */

import { loadDefaultConfig, type AgentsConfig } from './fsm/config';
import { openDb } from './store/db';
import { Repository } from './store/repository';
import { AgentRunner } from './agent/runner';
import { StubExecutor, goldenPathHandler } from './agent/executor';
import { FakeGitHub } from './integration/github-fake';
import { buildRealRunner } from './real-run';
import { EventLoop } from './loop/event-loop';
import { parseCliArgs, type CliArgs } from './cli-args';

/** Build the Agent Runner for the selected mode (real vs. stub/fake). */
function buildRunner(args: CliArgs, repo: Repository, agents: AgentsConfig, repoRef: string): AgentRunner {
  if (!args.real) {
    return new AgentRunner(repo, new StubExecutor(goldenPathHandler), agents, new FakeGitHub({ autoSeedIssues: true }));
  }
  const config = { repo: args.repo ?? repoRef, baseBranch: args.base, workingRoot: args.work, cheap: args.cheap };
  console.log(`[real mode] repo=${config.repo} base=${config.baseBranch} work=${config.workingRoot} cheap=${config.cheap} — spends tokens, opens a real PR.`);
  return buildRealRunner(repo, agents, config);
}

function buildLoop(args: CliArgs, repoRef: string): { repo: Repository; loop: EventLoop; version: string } {
  const { fsm, agents, version } = loadDefaultConfig();
  const repo = new Repository(openDb(args.db));
  const runner = buildRunner(args, repo, agents, repoRef);
  const loop = new EventLoop(repo, fsm, version, runner, {
    onTransition: (t) => console.log(`  ${t.fromState.padEnd(18)} --${t.trigger}-->  ${t.toState}`),
  });
  return { repo, loop, version };
}

function report(repo: Repository, runId: number): void {
  const run = repo.getRun(runId);
  const agentRuns = repo.listAgentRuns(runId);
  console.log(`\nRun ${runId} finished in state "${run?.currentState}" (status: ${run?.status}).`);
  console.log(`Agent invocations: ${agentRuns.length}; tokens used: ${run?.tokensUsed}.`);
}

async function start(args: CliArgs): Promise<void> {
  const issueRef = args.positionals[0] ?? 'demo/repo#1';
  const repoRef = issueRef.split('#')[0] ?? issueRef;
  const { repo, loop, version } = buildLoop(args, repoRef);

  console.log(`Config version ${version}; starting run for issue ${issueRef}`);
  loop.recover(); // no-op on a fresh DB; proves the startup sweep is wired
  const run = loop.startRun({ issueRef, repoRef });
  console.log(`Run ${run.id} created in state "${run.currentState}". Transitions:`);

  await loop.runUntilIdle();
  report(repo, run.id);
}

async function resume(args: CliArgs): Promise<void> {
  const runId = Number(args.positionals[1]);
  if (!Number.isInteger(runId)) throw new Error('usage: cli.ts resume <runId> [--real --repo o/r ...] [--db <path>]');
  const { repo, loop } = buildLoop(args, '');

  console.log(`Resuming run ${runId}. Transitions:`);
  loop.recover();
  loop.resumeRun(runId);
  await loop.runUntilIdle();
  report(repo, runId);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.positionals[0] === 'resume') {
    await resume(args);
  } else {
    await start(args);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
