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
import { stateLabelMirror } from './api/state-label-mirror';
import { buildOrchestrator } from './build-runner';
import { ReplyPoller } from './loop/reply-poller';
import type { CliArgs } from './cli-args';

export async function serve(args: CliArgs): Promise<void> {
  // The daemon no longer needs to be pinned to a repo at startup. It boots with whatever repos are
  // already enrolled (none, on a fresh DB); you add repos from the dashboard, and filing a run on a new
  // repo auto-enrolls it (Orchestrator.start). `--repo` still works as a convenience: it bootstrap-
  // enrolls that one repo. The autocomplete is user-scoped (the logged-in `gh` account), not repo-bound.
  const { orchestrator, repo, resolver, broadcaster } = buildOrchestrator(args);
  // Mirror each run's FSM state onto its PR as an `af:<state>` label (README §3.5 — a derived view,
  // best-effort by contract; a failure logs and the next transition retries naturally).
  broadcaster.subscribe(stateLabelMirror(resolver));
  orchestrator.recover(); // reclaim crash-stranded events and resume any queued work on startup

  const server = createApiServer(orchestrator);
  await listen(server, args.port);
  const config = orchestrator.getConfig();
  console.log(`agent-fleet daemon listening on http://localhost:${args.port} (FSM config ${config.version}${args.mock ? ', mock mode' : ', real mode'})`);
  console.log(
    args.db === ':memory:'
      ? '  ⚠ state: in-memory — runs are LOST on shutdown. Pass --db <path> to persist across restarts.'
      : `  state: ${args.db} (persists across restarts; the daemon recovers queued work on startup)`,
  );
  if (!args.mock) {
    const repos = orchestrator.listRepos();
    console.log(
      repos.length === 0
        ? '  repos: none enrolled — add one from the dashboard, or just file a run (its repo auto-enrolls). Autocomplete uses your `gh` login.'
        : `  repos: ${repos.map((r) => r.repoRef).join(', ')} (file a run on any other repo to auto-enroll it)`,
    );
  }
  console.log('  POST /runs · GET /runs · GET /runs/:id · POST /runs/:id/{pause,resume,stop,revert,archive,unarchive,cost-override,model,effort} · GET|POST /repos · POST /repos/watch · GET /cost · GET /models · GET /settings · PUT /settings/{default-harness,default-model} · GET|PUT /config · GET /stream');
  if (!existsSync(DEFAULT_PUBLIC_DIR)) {
    console.warn('  ⚠ dashboard not built — run `npm run build:dashboard` (or `npm run dev:dashboard` for HMR). The API works regardless.');
  }

  // Background reply polling: re-arm `awaiting_input` runs when a human replies on the issue (each via
  // its own repo's adapter — the resolver, not a single bound adapter, so multi-repo runs poll correctly).
  const stopPolling = startReplyPolling(orchestrator, repo, resolver, args);
  // Background PR-feedback polling: re-open a finished run when a human leaves a `feedback:` comment on
  // its still-open PR, and stop watching once the PR merges/closes (see the PR Feedback Poller). The
  // Orchestrator owns the poller instance (shared with the dashboard's on-demand "Check now").
  const stopFeedbackPolling = startPrFeedbackPolling(orchestrator, args);
  // Background dependency scheduling (Milestone 9): refresh §3.5 declarations, park runs whose
  // dependencies are unmerged, wake them when the dependency's issue closes (the merge signal), and
  // escalate cycles. Same interval + disable switch as the other pollers.
  const stopSchedulerPolling = startSchedulerPolling(orchestrator, args);
  // Background issue intake (Milestone 11 — continuous mode): scan each watched repo's open issues and
  // auto-start a run for the next eligible one (sequential, one per repo). Same interval + disable
  // switch as the other pollers; the Orchestrator owns the poller instance.
  const stopIntakePolling = startIssueIntakePolling(orchestrator, args);

  // Graceful shutdown: stop accepting connections and clear the poll timer so the process can exit.
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log('\nShutting down…');
      stopPolling();
      stopFeedbackPolling();
      stopSchedulerPolling();
      stopIntakePolling();
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
  resolver: ReturnType<typeof buildOrchestrator>['resolver'],
  args: CliArgs,
): () => void {
  if (args.pollTimeoutMinutes <= 0) return () => {};
  // The Orchestrator satisfies the poller's `AwaitingResumer` (it re-arms the run and kicks the pump).
  const poller = new ReplyPoller(repo, resolver, orchestrator);
  const timer = setInterval(() => {
    void poller.checkOnce().catch((err) => console.error(`[reply-poller] ${String(err)}`));
  }, args.pollIntervalSeconds * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Periodically scan finished runs' open PRs for a new `feedback:` comment and re-open the run to
 * address it (the daemon's continuous PR-feedback loop). Shares the reply poller's interval and its
 * `--poll-timeout 0` disable switch. The Orchestrator owns the poller (so the dashboard's "Check now"
 * drives the same instance); this just ticks it on a timer. Returns a stop function.
 */
function startPrFeedbackPolling(
  orchestrator: ReturnType<typeof buildOrchestrator>['orchestrator'],
  args: CliArgs,
): () => void {
  if (args.pollTimeoutMinutes <= 0) return () => {};
  const timer = setInterval(() => {
    void orchestrator.pollPrFeedbackOnce().catch((err) => console.error(`[pr-feedback-poller] ${String(err)}`));
  }, args.pollIntervalSeconds * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Periodically run one Scheduler pass (Milestone 9): refresh each active run's §3.5 declarations from
 * its issue, verify dependency satisfaction (issue-closed = merged, via `Closes #N` auto-close),
 * park/wake `blocked` runs, and escalate dependency cycles. Shares the other pollers' interval and
 * `--poll-timeout 0` disable switch; the Orchestrator owns the poller (so `POST /scheduler/check`
 * drives the same instance) and kicks the pump itself after a pass that woke runs.
 */
function startSchedulerPolling(
  orchestrator: ReturnType<typeof buildOrchestrator>['orchestrator'],
  args: CliArgs,
): () => void {
  if (args.pollTimeoutMinutes <= 0) return () => {};
  const timer = setInterval(() => {
    void orchestrator.checkDependencies().catch((err) => console.error(`[scheduler-poller] ${String(err)}`));
  }, args.pollIntervalSeconds * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Periodically scan every **watched** repo's open issues and auto-start a run for the next eligible one
 * (Milestone 11 — continuous mode). Sequential: one run in flight per repo, the next admitted when the
 * current one's issue closes (a human merges its PR) or is stopped. Shares the other pollers' interval
 * and `--poll-timeout 0` disable switch; the Orchestrator owns the poller. Returns a stop function.
 */
function startIssueIntakePolling(
  orchestrator: ReturnType<typeof buildOrchestrator>['orchestrator'],
  args: CliArgs,
): () => void {
  if (args.pollTimeoutMinutes <= 0) return () => {};
  const timer = setInterval(() => {
    void orchestrator.pollIssueIntakeOnce().catch((err) => console.error(`[issue-intake] ${String(err)}`));
  }, args.pollIntervalSeconds * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
