/**
 * Orchestrator — the daemon's service layer (Layer 6, README §3.3 / Milestone 5).
 *
 * Sits between the HTTP transport and the Event Loop / store. It owns:
 *  - the **run-control commands** (start / pause / resume / stop / revert) and the read queries
 *    (list / fetch runs, get/update FSM config);
 *  - the in-process **drain pump** that advances runs after a command enqueues work, without
 *    blocking the HTTP response (a real stage takes minutes);
 *  - wiring the loop's `onTransition` into the {@link Broadcaster} so every committed transition
 *    reaches the live stream.
 *
 * It is deliberately transport-free: every method takes/returns domain objects and throws
 * {@link ApiError} for client-visible failures, so the whole control surface is unit-testable
 * against an in-memory DB + stub executor + fake GitHub, with the HTTP layer a thin shell on top
 * (plans/milestone-5.md §2.1).
 */

import { saveConfig, type LoadedConfig } from '../fsm/config';
import { EventLoop } from '../loop/event-loop';
import type { AgentRunner } from '../agent/runner';
import type {
  AgentRunRecord,
  Artifact,
  ListRunsFilter,
  LogRecord,
  Repo,
  Repository,
  Run,
  RunStatus,
  Transition,
} from '../store/repository';
import type { GitHub, IssueSuggestion } from '../integration/github';
import type { RepoResolver } from '../integration/github-resolver';
import { parseIssueRef, parseRepoRef, type ParsedIssueRef } from '../integration/refs';
import { Broadcaster, type StreamListener } from './stream';

/** A failure with a client-facing HTTP status. The server maps `status` straight onto the response. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A run plus everything the dashboard's run view needs (README §3.3 Layer 7 — run view + artifacts). */
export interface RunDetail {
  run: Run;
  transitions: Transition[];
  agentRuns: AgentRunRecord[];
  artifacts: Artifact[];
  logs: LogRecord[];
}

export interface OrchestratorOptions {
  repo: Repository;
  /** Already constructed with its `onActivity` wired to {@link broadcaster} (see `buildOrchestrator`). */
  runner: AgentRunner;
  config: LoadedConfig;
  broadcaster: Broadcaster;
  /** GitHub adapter, used (read-only) to power the new-run autocomplete. Omit → suggestions are empty. */
  github?: GitHub;
  /**
   * Resolves the per-repo adapter for a run's repo (Milestone 8 Phase A). {@link Orchestrator.start}
   * validates against it — a run is admitted only for a repo the daemon can service (an enrolled repo in
   * real mode; any repo under the single-repo/mock resolver). It replaces the pre-M8 single-repo guard.
   */
  resolver: RepoResolver;
  /** Working-tree root a `POST /repos` enrollment defaults to when the request omits one (the daemon's
   *  `--work`). Runs clone into `<workingRoot>/run-<id>` (run ids are global, so a shared root is safe). */
  defaultWorkingRoot?: string;
  /** Path the FSM config is persisted to; required for `updateConfig` (omit → config is read-only). */
  configPath?: string;
  now?: () => number;
  maxIterations?: number;
  /**
   * Global concurrency cap (Milestone 8 Phase B): the max number of stages the drain pump runs at
   * once — parallel across runs, serial within a run. Defaults to `1` (serial, the pre-B1 behavior),
   * so unit tests are unchanged; the daemon passes a higher cap (see `build-runner`).
   */
  concurrency?: number;
  /** Called when a background drain throws (e.g. a `FatalExecutorError`). Default: log to stderr. */
  onError?: (err: unknown) => void;
}

/** Statuses a run can no longer advance from — `updateConfig` is safe only when every run is here. */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['done', 'stopped']);

export class Orchestrator {
  private readonly broadcaster: Broadcaster;
  private readonly repo: Repository;
  private readonly runner: AgentRunner;
  private readonly loop: EventLoop;
  private readonly configPath?: string;
  private readonly github?: GitHub;
  private readonly resolver: RepoResolver;
  private readonly defaultWorkingRoot?: string;
  private readonly concurrency: number;
  private config: LoadedConfig;

  // Single-flight drain pump (plans/milestone-5.md §2.2).
  private draining = false;
  private rerun = false;
  private current: Promise<void> = Promise.resolve();
  private readonly onError: (err: unknown) => void;

  constructor(options: OrchestratorOptions) {
    this.repo = options.repo;
    this.runner = options.runner;
    this.broadcaster = options.broadcaster;
    this.config = options.config;
    this.configPath = options.configPath;
    this.github = options.github;
    this.resolver = options.resolver;
    this.defaultWorkingRoot = options.defaultWorkingRoot;
    this.concurrency = options.concurrency ?? 1; // the requested cap; `EventLoop.drain` clamps it to a valid ≥ 1
    this.onError = options.onError ?? ((err) => console.error(`[orchestrator] drain pump error: ${String(err)}`));
    this.loop = new EventLoop(this.repo, this.config.fsm, this.config.version, this.runner, {
      onTransition: (transition, run) => this.broadcaster.publish({ type: 'transition', runId: run.id, transition, run }),
      ...(options.now ? { now: options.now } : {}),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    });
  }

  /** Reclaim crash-stranded events, then drain anything already queued (e.g. after a daemon restart). */
  recover(): void {
    this.loop.recover();
    this.kick();
  }

  // --- commands ----------------------------------------------------------------

  /** Start a run for an issue and begin advancing it. Returns the created run immediately (the drain
   *  runs in the background; watch the stream for progress). */
  start(input: { issueRef: string; repoRef?: string }): Run {
    if (!input.issueRef) throw new ApiError(400, 'issueRef is required');
    // Accept any form the operator pastes (owner/repo#N, a browser issue URL, …) and normalize to the
    // canonical ref the adapter expects (see integration/refs); a malformed ref is a 400, not a run.
    let parsed: ParsedIssueRef;
    try {
      parsed = parseIssueRef(input.issueRef);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
    // Enrollment check (Milestone 8 Phase A): admit a run only for a repo the daemon can service.
    // The resolver decides — any repo under the single-repo/mock resolver, an enrolled repo under the
    // real one — and throws an actionable "not enrolled" message otherwise (which we surface as a 400,
    // never a run that would later fail deep in the loop). This replaces the pre-M8 single-repo guard.
    const repoRef = input.repoRef ?? parsed.repo;
    try {
      this.resolver.for(repoRef);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
    const run = this.loop.startRun({ issueRef: parsed.ref, repoRef });
    this.kick();
    return run;
  }

  /** Pause a `running` run (halts the next dispatch; the current stage finishes). */
  pause(runId: number): Run {
    this.requireRun(runId); // 404 if missing
    const run = this.conflictOnThrow(() => this.loop.pauseRun(runId)); // 409 if not running
    this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
    return run;
  }

  /**
   * Resume a parked run — dispatching on its status: a `paused` run flips back to `running`; a
   * `needs_human` run resumes from where it escalated (counter reset). Any other status is a `409`.
   * An `awaiting_input` run is resumed by the Reply Poller on a human reply, not by this command.
   */
  resume(runId: number): Run {
    const existing = this.requireRun(runId);
    if (existing.status === 'paused') {
      const run = this.loop.resumePausedRun(runId);
      this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
      this.kick();
      return run;
    }
    if (existing.status === 'needs_human') {
      const run = this.conflictOnThrow(() => this.loop.resumeRun(runId)); // emits its own transition event
      this.kick();
      return run;
    }
    throw new ApiError(409, `cannot resume a "${existing.status}" run`);
  }

  /** Stop a run (terminal, not resumable; state and artifacts are kept). */
  stop(runId: number): Run {
    this.requireRun(runId); // 404 if missing
    const run = this.conflictOnThrow(() => this.loop.stopRun(runId)); // 409 if already terminal
    this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
    return run;
  }

  /**
   * Re-arm an `awaiting_input` run after a human replied on the issue (the Reply Poller calls this in
   * the daemon). Flips it back to `running`, then kicks the pump so the loop re-runs the stage that
   * asked (`triage`). Publishes the status change to the stream.
   */
  resumeAwaitingInput(runId: number): Run {
    this.loop.resumeAwaitingInput(runId);
    const run = this.requireRun(runId);
    this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
    this.kick();
    return run;
  }

  /** Revert a run to an earlier state with a reason, then re-dispatch it (README §3.3 Layer 6). */
  revert(runId: number, toState: string, reason: unknown): Run {
    if (!toState) throw new ApiError(400, 'toState is required');
    if (reason === undefined || reason === null || reason === '') throw new ApiError(400, 'reason is required');
    const target = this.config.fsm.states[toState];
    if (!target) throw new ApiError(400, `unknown state "${toState}"`);
    if (target.terminal) throw new ApiError(400, `cannot revert to terminal state "${toState}"`);
    this.requireRun(runId); // 404 if missing
    const run = this.conflictOnThrow(() => this.loop.revertRun(runId, toState, reason)); // emits its own transition event
    this.kick();
    return run;
  }

  /**
   * Archive a terminal (done/stopped) run so the dashboard drops it from the Resolved lane. Refuses
   * (`409`) a non-terminal run — you don't hide work that's still in flight. Publishes a `status`
   * event (status unchanged) so connected dashboards update live.
   */
  archive(runId: number): Run {
    const existing = this.requireRun(runId);
    if (!TERMINAL_STATUSES.has(existing.status)) {
      throw new ApiError(409, `cannot archive a "${existing.status}" run — only done/stopped runs can be archived`);
    }
    this.repo.setRunArchived(runId, true);
    const run = this.requireRun(runId);
    this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
    return run;
  }

  /** Restore an archived run to the Resolved lane. Allowed regardless of status (it's a no-op undo). */
  unarchive(runId: number): Run {
    this.requireRun(runId); // 404 if missing
    this.repo.setRunArchived(runId, false);
    const run = this.requireRun(runId);
    this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
    return run;
  }

  // --- queries -----------------------------------------------------------------

  getRun(runId: number): Run {
    return this.requireRun(runId);
  }

  /** A run plus its transition history, per-phase agent runs, artifact refs, and activity log. */
  getRunDetail(runId: number): RunDetail {
    const run = this.requireRun(runId);
    return {
      run,
      transitions: this.repo.listTransitions(runId),
      agentRuns: this.repo.listAgentRuns(runId),
      artifacts: this.repo.listArtifacts(runId),
      logs: this.repo.listLogs(runId),
    };
  }

  listRuns(filter: ListRunsFilter = {}): Run[] {
    return this.repo.listRuns(filter);
  }

  /** The repo a run belongs to (for the repo-scoped live stream). Undefined for an unknown run id. */
  repoOfRun(runId: number): string | undefined {
    return this.repo.getRun(runId)?.repoRef;
  }

  // --- repos (Milestone 8 Phase A) ---------------------------------------------

  /** Every enrolled repo (the dashboard's repo selector reads this). */
  listRepos(): Repo[] {
    return this.repo.listRepos();
  }

  /**
   * Enroll a repo (or re-enroll to replace its adapter config), so runs can be started for it. `repoRef`
   * is normalized to canonical `owner/name` (a malformed one is a `400`); `workingRoot` defaults to the
   * daemon's `--work` when omitted. Invalidates the resolver's cache so the change takes effect without a
   * restart. Mock/single-repo daemons accept runs for any repo regardless, so enrolling is a no-op there.
   *
   * Re-enroll is a **full replace** (upsert), not a patch: an omitted optional field resets to its
   * default (e.g. re-enrolling without `cloneUrl` clears it back to the derived GitHub URL). The
   * dashboard's enroll form posts the complete config, so this matches a form-based UI.
   */
  enrollRepo(input: { repoRef: string; workingRoot?: string; baseBranch?: string; cloneUrl?: string; localRepo?: string }): Repo {
    if (!input.repoRef) throw new ApiError(400, 'repoRef is required');
    let ref: string;
    try {
      ref = parseRepoRef(input.repoRef);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
    const workingRoot = input.workingRoot ?? this.defaultWorkingRoot;
    if (!workingRoot) throw new ApiError(400, 'workingRoot is required (the daemon has no default --work configured)');
    const repo = this.repo.upsertRepo({
      repoRef: ref,
      workingRoot,
      ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
      ...(input.cloneUrl ? { cloneUrl: input.cloneUrl } : {}),
      ...(input.localRepo ? { localRepo: input.localRepo } : {}),
    });
    this.resolver.invalidate(ref); // a re-enroll changed the config → drop any cached adapter
    return repo;
  }

  /**
   * Open issues matching `query` for the dashboard's new-run autocomplete (README §3.3 Layer 7).
   * Delegates to the GitHub adapter; with no adapter configured there are simply no suggestions.
   */
  async suggestIssues(query: string): Promise<IssueSuggestion[]> {
    if (!this.github) return [];
    return this.github.suggestIssues(query);
  }

  // --- config ------------------------------------------------------------------

  /** The live FSM rules + agent recipe + pinned version. */
  getConfig(): LoadedConfig {
    return this.config;
  }

  /**
   * Validate and persist a new FSM config, hot-swapping it in for *new* runs. Refuses (`409`) while
   * any run is non-terminal, so an in-flight run is never re-pointed at changed rules (README §3.1 —
   * edits only affect new runs; the per-run versioned store that would lift this restriction is M6).
   * Invalid config → `400` with the aggregated problems; the file is only written once validation
   * passes. Returns the new version.
   */
  updateConfig(raw: unknown): { version: string } {
    if (!this.configPath) throw new ApiError(400, 'config is read-only (no config path configured)');
    const active = this.repo.listRuns().filter((r) => !TERMINAL_STATUSES.has(r.status));
    if (active.length > 0) {
      const ids = active.map((r) => r.id).join(', ');
      throw new ApiError(409, `cannot edit the FSM config while runs are in flight (run(s) ${ids}); pause/stop or let them finish first`);
    }
    let loaded: LoadedConfig;
    try {
      loaded = saveConfig(this.configPath, raw);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
    this.config = loaded;
    this.loop.setConfig(loaded.fsm, loaded.version);
    this.runner.setAgents(loaded.agents);
    return { version: loaded.version };
  }

  // --- stream + pump -----------------------------------------------------------

  subscribe(listener: StreamListener): () => void {
    return this.broadcaster.subscribe(listener);
  }

  /** Await the in-flight drain (tests use this instead of sleeping; a daemon never needs to). */
  async settle(): Promise<void> {
    await this.current;
  }

  /** Start a background drain if none is running; otherwise flag the running one to re-scan (§2.2). */
  private kick(): void {
    if (this.draining) {
      this.rerun = true;
      return;
    }
    this.draining = true;
    this.current = this.drainLoop();
  }

  private async drainLoop(): Promise<void> {
    try {
      do {
        this.rerun = false;
        await this.loop.drain(this.concurrency);
      } while (this.rerun);
    } catch (err) {
      // A throwing drain (e.g. a FatalExecutorError when the harness is unauthenticated) aborts the
      // whole pass; surface it rather than crashing the daemon. The triggering event stays recoverable
      // (unmarked), so fixing the cause and re-kicking resumes from there.
      this.onError(err);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Run a loop control method, mapping any throw to a `409` (the run exists — callers `requireRun`
   * first for the `404` — so a throw here means the run is in the wrong status for this command).
   */
  private conflictOnThrow(fn: () => Run): Run {
    try {
      return fn();
    } catch (err) {
      throw new ApiError(409, err instanceof Error ? err.message : String(err));
    }
  }

  private requireRun(runId: number): Run {
    const run = this.repo.getRun(runId);
    if (!run) throw new ApiError(404, `run ${runId} not found`);
    return run;
  }
}
