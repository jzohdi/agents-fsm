/**
 * `serve` — the orchestrator daemon (Milestone 5).
 *
 * Builds the {@link Orchestrator} (real by default; `--mock` opts into the no-cost stub/fake
 * harness + in-memory GitHub) and serves the HTTP command API + the SSE live stream. This is the
 * headless control plane the M6 web dashboard will be a pure client of (README §3.1).
 *
 * It also runs the Reply Poller in the background so a `triage` `clarify` is picked back up when a
 * human replies on the issue — the same human-in-the-loop the one-shot CLI offers, but continuous.
 *
 * KISS: a single long-lived process. Stop it with Ctrl-C (SIGINT/SIGTERM → graceful close).
 */

import { existsSync } from 'node:fs';
import type { Server } from 'node:http';

import { createApiServer, DEFAULT_PUBLIC_DIR } from './api/server';
import { buildOrchestrator } from './build-runner';
import { ReplyPoller } from './loop/reply-poller';
import type { CliArgs } from './cli-args';

export async function serve(args: CliArgs): Promise<void> {
  // Single-repo MVP: the real adapter is pinned to one repo at startup (and `buildRealGitHub` requires
  // it). Catch the missing-repo case here with actionable guidance rather than an eager stack trace.
  if (!args.mock && !args.repo) {
    console.error('Real mode needs a target repo. Start with `--repo owner/name`, or `--mock` for no-cost runs (single-repo MVP).');
    process.exitCode = 1;
    return;
  }
  const { orchestrator, repo, github } = buildOrchestrator(args);
  orchestrator.recover(); // reclaim crash-stranded events and resume any queued work on startup

  const server = createApiServer(orchestrator);
  await listen(server, args.port);
  const config = orchestrator.getConfig();
  console.log(`agent-fleet daemon listening on http://localhost:${args.port} (FSM config ${config.version}${args.mock ? ', mock mode' : ', real mode'})`);
  console.log('  POST /runs · GET /runs · GET /runs/:id · POST /runs/:id/{pause,resume,stop,revert} · GET|PUT /config · GET /stream');
  if (!existsSync(DEFAULT_PUBLIC_DIR)) {
    console.warn('  ⚠ dashboard not built — run `npm run build:dashboard` (or `npm run dev:dashboard` for HMR). The API works regardless.');
  }

  // Background reply polling: re-arm `awaiting_input` runs when a human replies on the issue.
  const stopPolling = startReplyPolling(orchestrator, repo, github, args);

  // Graceful shutdown: stop accepting connections and clear the poll timer so the process can exit.
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log('\nShutting down…');
      stopPolling();
      server.close(() => resolve());
      // Long-lived SSE connections would otherwise keep `close` from ever completing — terminate them
      // so the process can exit promptly on Ctrl-C (Node ≥18.2; engines require ≥20).
      server.closeAllConnections();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Bind to loopback only: the MVP API is unauthenticated and meant for a localhost dashboard
    // (README §1 / Layer 7), so it must not be reachable from the LAN. Remote access is a deliberate
    // post-MVP add-on (auth + networking), not an accident of the default bind address.
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Periodically check `awaiting_input` runs for a human reply and re-arm them (the daemon's continuous
 * counterpart to the CLI's bounded `poll`). Disabled with `--poll-timeout 0`. Returns a stop function.
 */
function startReplyPolling(
  orchestrator: ReturnType<typeof buildOrchestrator>['orchestrator'],
  repo: ReturnType<typeof buildOrchestrator>['repo'],
  github: ReturnType<typeof buildOrchestrator>['github'],
  args: CliArgs,
): () => void {
  if (args.pollTimeoutMinutes <= 0) return () => {};
  // The Orchestrator satisfies the poller's `AwaitingResumer` (it re-arms the run and kicks the pump).
  const poller = new ReplyPoller(repo, github, orchestrator);
  const timer = setInterval(() => {
    void poller.checkOnce().catch((err) => console.error(`[reply-poller] ${String(err)}`));
  }, args.pollIntervalSeconds * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
