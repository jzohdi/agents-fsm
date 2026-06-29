/**
 * Demo CLI (Milestone 2): start a run and watch it advance through the FSM with stub
 * agents — no network, no cost. This validates the whole orchestration mechanism end to
 * end. Real agents replace the stub in Milestone 4; the HTTP/WS API arrives in Milestone 5.
 *
 * Usage:
 *   tsx src/cli.ts [issueRef] [--db <path>]
 *
 * With no `--db` it uses an in-memory database (nothing persists). Pass a file path to
 * keep state across runs.
 */

import { loadDefaultConfig } from './fsm/config';
import { openDb } from './store/db';
import { Repository } from './store/repository';
import { AgentRunner } from './agent/runner';
import { StubExecutor, goldenPathHandler } from './agent/executor';
import { EventLoop } from './loop/event-loop';

interface Args {
  issueRef: string;
  dbPath: string;
}

function parseArgs(argv: string[]): Args {
  let issueRef = 'demo/repo#1';
  let dbPath = ':memory:';
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db') {
      dbPath = argv[++i] ?? ':memory:';
    } else if (arg !== undefined && !arg.startsWith('--')) {
      positional.push(arg);
    }
  }
  if (positional[0]) issueRef = positional[0];
  return { issueRef, dbPath };
}

async function main(): Promise<void> {
  const { issueRef, dbPath } = parseArgs(process.argv.slice(2));
  const { fsm, agents, version } = loadDefaultConfig();

  const repo = new Repository(openDb(dbPath));
  const executor = new StubExecutor(goldenPathHandler);
  const runner = new AgentRunner(repo, executor, agents);

  const loop = new EventLoop(repo, fsm, version, runner, {
    onTransition: (t) => {
      console.log(`  ${t.fromState.padEnd(18)} --${t.trigger}-->  ${t.toState}`);
    },
  });

  console.log(`Config version ${version}; starting run for issue ${issueRef}`);
  loop.recover(); // no-op on a fresh DB; proves the startup sweep is wired
  const run = loop.startRun({ issueRef, repoRef: issueRef.split('#')[0] ?? issueRef });
  console.log(`Run ${run.id} created in state "${run.currentState}". Transitions:`);

  await loop.runUntilIdle();

  const final = repo.getRun(run.id);
  const agentRuns = repo.listAgentRuns(run.id);
  console.log(`\nRun ${run.id} finished in state "${final?.currentState}" (status: ${final?.status}).`);
  console.log(`Agent invocations: ${agentRuns.length}; tokens used: ${final?.tokensUsed}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
