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

import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';

import { createApiServer, DEFAULT_PUBLIC_DIR } from './api/server';
import { checkBindAllowed, isLoopbackHost } from './api/bind-guard';
import { stateLabelMirror } from './api/state-label-mirror';
import { buildOrchestrator, resolveApiToken, resolveHost } from './build-runner';
import type { CliArgs } from './cli-args';

export async function serve(args: CliArgs): Promise<void> {
  // --- boot-config validation, BEFORE any side effect. `recover()` below kicks a background drain
  // that dispatches queued stages (real harness children); a config refusal after that would leave
  // work running headless — no API bound, no shutdown handlers — until it settles. So resolve and
  // validate everything refusable first, then boot the orchestrator. ---

  // API auth (issue #25): a resolved token gates every route except /health + static (see `requiresAuth`).
  // Absent ⇒ auth off, the localhost-only default (byte-for-byte unchanged). Pass `{}` when unset so the
  // server's `DEFAULT_PUBLIC_DIR` default is untouched.
  const apiToken = resolveApiToken(args);

  // Bind host (issue #26): `--host` → `FLEET_HOST` → `127.0.0.1` (loopback, the unchanged default).
  const host = resolveHost(args);
  // Bind guard, fail-fast BEFORE the server binds: refuse a non-loopback bind unless a token gates the
  // API surface. Throwing surfaces it like other boot failures (a non-zero exit) — TLS does NOT exempt
  // this (transport confidentiality is not authn; the guard is unconditional on a non-loopback host).
  const verdict = checkBindAllowed(host, Boolean(apiToken));
  if (!verdict.ok) throw new Error(verdict.reason);

  // Direct TLS termination (issue #26): `--tls-cert` / `--tls-key`, both-or-neither. Read the PEM files
  // here (the server stays free of filesystem concerns) and pass the resolved contents through.
  const tls = resolveTls(args);

  // The daemon no longer needs to be pinned to a repo at startup. It boots with whatever repos are
  // already enrolled (none, on a fresh DB); you add repos from the dashboard, and filing a run on a new
  // repo auto-enrolls it (Orchestrator.start). `--repo` still works as a convenience: it bootstrap-
  // enrolls that one repo. The autocomplete is user-scoped (the logged-in `gh` account), not repo-bound.
  const { orchestrator, resolver, broadcaster } = buildOrchestrator(args);
  // Mirror each run's FSM state onto its PR as an `af:<state>` label (README §3.5 — a derived view,
  // best-effort by contract; a failure logs and the next transition retries naturally).
  broadcaster.subscribe(stateLabelMirror(resolver));
  orchestrator.recover(); // reclaim crash-stranded events and resume any queued work on startup

  const server = createApiServer(orchestrator, { ...(apiToken ? { apiToken } : {}), ...(tls ? { tls } : {}) });
  await listen(server, args.port, host);
  const config = orchestrator.getConfig();
  const scheme = tls ? 'https' : 'http';
  // Wildcard binds (`0.0.0.0` / `::`) aren't a reachable address — show a hint instead of the literal.
  const shownHost = host === '0.0.0.0' || host === '::' ? '<this-host>' : host;
  console.log(`agent-fleet daemon listening on ${scheme}://${shownHost}:${args.port} (FSM config ${config.version}${args.mock ? ', mock mode' : ', real mode'})`);
  if (!isLoopbackHost(host)) {
    console.log(`  🌐 reachable off-localhost (bound ${host}) — auth is required (guaranteed by the bind guard).${tls ? '' : ' Front it with a tunnel or TLS; see README §9.'}`);
  }
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
  console.log(
    apiToken
      ? '  auth: API token required on every route except /health (Authorization: Bearer <token>, or ?token= for the SSE stream).'
      : '  auth: OFF — the API is open (localhost only). Set FLEET_API_TOKEN (or --api-token) to require a token before exposing it.',
  );
  console.log('  POST /runs · GET /runs · GET /runs/:id · POST /runs/:id/{pause,resume,stop,revert,archive,unarchive,cost-override,model,effort} · GET|POST /repos · POST /repos/{watch,conflict-policy} · GET /cost · GET /models · GET /settings · PUT /settings/{default-harness,default-model} · GET|PUT /config · GET /stream');
  if (!existsSync(DEFAULT_PUBLIC_DIR)) {
    console.warn('  ⚠ dashboard not built — run `npm run build:dashboard` (or `npm run dev:dashboard` for HMR). The API works regardless.');
  }

  // Background reply polling: re-arm `awaiting_input` runs when a human replies on the issue. The
  // Orchestrator owns the poller (shared with the dashboard's on-demand "Check for a reply"); this ticks
  // it. It reads each run's thread via that run's repo adapter (the resolver), so multi-repo runs poll
  // correctly, and identifies the human's reply by a comment marker — not author login, which the daemon
  // shares with the operator (it comments via the same `gh` account).
  const stopPolling = startReplyPolling(orchestrator, args);
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

  // Graceful shutdown (SIGINT/SIGTERM): pause the fleet so the next start resumes where it left off.
  // Order matters: pollers first (no new work admitted), then the Orchestrator's shutdown — stop
  // claiming events, interrupt in-flight harness children, wait for the drain to settle, savepoint
  // interrupted runs' dirty worktrees — then close HTTP + SSE. An interrupted stage is *not* escalated
  // to needs_human (it wasn't a harness fault); its event stays `processing` and `recover()` re-runs it
  // on the next start. A second signal force-quits, and a hard cap keeps a wedged child from hanging
  // the exit — either way, events stay recoverable, which is the same guarantee a crash already has.
  await new Promise<void>((resolve) => {
    const forceQuit = () => {
      console.error('\nForced shutdown — in-flight stages will be recovered on the next start.');
      process.exit(130);
    };
    const shutdown = () => {
      console.log('\nShutting down gracefully… (press Ctrl-C again to force-quit)');
      process.once('SIGINT', forceQuit);
      process.once('SIGTERM', forceQuit);
      stopPolling();
      stopFeedbackPolling();
      stopSchedulerPolling();
      stopIntakePolling();
      void (async () => {
        const summary = await withTimeout(orchestrator.shutdown(), SHUTDOWN_GRACE_MS);
        if (summary) {
          if (summary.interruptedRuns > 0) {
            console.log(
              `  ${summary.interruptedRuns} in-flight stage(s) interrupted (${summary.savepointed} savepoint commit(s)); they resume on the next start.`,
            );
          }
        } else {
          console.warn('  shutdown grace period elapsed; exiting anyway — in-flight stages will be recovered on the next start.');
        }
        server.close(() => resolve());
        // Long-lived SSE connections would otherwise keep `close` from ever completing — terminate them
        // so the process can exit promptly on Ctrl-C (Node ≥18.2; engines require ≥20).
        server.closeAllConnections();
      })();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

/** How long a graceful shutdown waits for in-flight stages to abort/finish before exiting anyway. */
const SHUTDOWN_GRACE_MS = 30_000;

/** Resolve with `promise`'s value, or `undefined` if it hasn't settled within `ms` (never rejects the race). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise.catch((err) => {
      console.error(`[shutdown] ${String(err)}`);
      return undefined;
    }),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref()),
  ]);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Bind to the resolved `host` (issue #26). The default is loopback (`127.0.0.1`); binding off-loopback
    // is now supported but gated by the bind guard (`checkBindAllowed` in `serve()`), which refuses a
    // non-loopback bind unless an API token is configured — so exposure is deliberate, never accidental.
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Assemble the optional direct-TLS config (issue #26) from `--tls-cert` / `--tls-key`. Both-or-neither:
 * exactly one set is operator error (a clear throw). When both are set, read each PEM file here so the
 * server receives resolved contents (kept free of filesystem concerns); an unreadable path throws an
 * actionable error naming it. Neither set ⇒ `undefined` (plain HTTP, the unchanged default).
 */
function resolveTls(args: CliArgs): { cert: string; key: string } | undefined {
  const { tlsCert, tlsKey } = args;
  if (!tlsCert && !tlsKey) return undefined;
  if (!tlsCert || !tlsKey) {
    throw new Error('direct TLS requires both --tls-cert and --tls-key (only one was given) — pass both PEM paths, or neither for plain HTTP.');
  }
  return { cert: readPem(tlsCert, '--tls-cert'), key: readPem(tlsKey, '--tls-key') };
}

function readPem(path: string, flag: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${flag} PEM file at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Periodically check `awaiting_input` runs for a human reply and re-arm them (the daemon's continuous
 * counterpart to the CLI's bounded `poll`). Disabled with `--poll-timeout 0`. Returns a stop function.
 */
function startReplyPolling(
  orchestrator: ReturnType<typeof buildOrchestrator>['orchestrator'],
  args: CliArgs,
): () => void {
  if (args.pollTimeoutMinutes <= 0) return () => {};
  const timer = setInterval(() => {
    void orchestrator.pollRepliesOnce().catch((err) => console.error(`[reply-poller] ${String(err)}`));
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
