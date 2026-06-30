/**
 * Dev preview of the real dashboard against the real control plane.
 *
 * Boots the genuine {@link Orchestrator} + HTTP/SSE server (the same `createApiServer` the `serve`
 * daemon uses, serving the built `dashboard/dist`), but seeds it in-process with a rich run set
 * ({@link ./dev-seed}) and a handful of suggestable issues, then streams synthetic "model thinking"
 * activity for the running run so the live feed animates. This replaced an earlier standalone fake
 * HTTP server: every code path the dashboard exercises here is the production one — only the *data*
 * is seeded (the stub executor can't manufacture varied statuses, back-edges, or a live stream).
 *
 * Run it with `npm run dev:preview` (build the dashboard first). NOT shipped; delete once a real
 * seeded daemon or fixtures exist. Uses an in-memory DB, so each launch starts clean.
 */

import type { Server } from 'node:http';

import { parseCliArgs } from './cli-args';
import { buildOrchestrator } from './build-runner';
import { createApiServer } from './api/server';
import { FakeGitHub } from './integration/github-fake';
import { seedRuns, seedSuggestions } from './dev-seed';
import type { AgentActivity } from './agent/executor';

const PORT = Number(process.env.PORT ?? 4319);

// Generic so they read sensibly whichever running run the dashboard auto-selects.
const THOUGHTS = [
  're-reading the failing assertion from the last test run',
  'narrowing the change to the smallest safe diff',
  'checking callers of the function under edit … 6 references',
  'editing the target module (+18 −6)',
  'edge case: the error path must clean up state',
  'adding a regression test for the boundary condition',
  'running the test suite `vitest`',
  '**all tests passing** — no regressions',
  'reviewing the diff once more before handoff',
  'summarizing the change for the review stage',
];

function main(): void {
  // `--mock`: the preview must use the stub executor + in-memory FakeGitHub (we seed both), never the
  // real harness — runs are real by default now, so this flag is required here.
  const args = parseCliArgs(['serve', '--mock', '--db', ':memory:', '--port', String(PORT), '--poll-timeout', '0']);
  const { orchestrator, repo, github, broadcaster } = buildOrchestrator(args);

  const version = orchestrator.getConfig().version;
  const ids = seedRuns(repo, version);
  if (github instanceof FakeGitHub) seedSuggestions(github);
  // The dashboard opens the highest-id running run by default; aim the live feed at the same one so
  // the "model thinking" stream animates on the run the operator first sees.
  const running = repo.listRuns('running');
  const runningId = running.length ? Math.max(...running.map((r) => r.id)) : ids[0]!;

  const server: Server = createApiServer(orchestrator);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`dashboard preview → http://127.0.0.1:${PORT}/  (real daemon, seeded; ${ids.length} runs, FSM ${version})`);
    console.log('  serving dashboard/dist — run `npm run build:dashboard` first if it 404s');
  });

  // Stream synthetic "model thinking" for the running run so the live feed animates like real work.
  let i = 0;
  const ticker = setInterval(() => {
    const activity: AgentActivity = { kind: 'thinking', summary: THOUGHTS[i % THOUGHTS.length]! };
    i += 1;
    broadcaster.publish({ type: 'activity', activity: { runId: runningId, stage: 'frontend', phase: 'produce', activity } });
  }, 1600);
  ticker.unref?.();

  const shutdown = () => {
    clearInterval(ticker);
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main();
