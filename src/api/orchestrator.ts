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
import { EventLoop, ShutdownInterruptError } from '../loop/event-loop';
import { interruptHarnessChildren } from '../agent/subprocess-executor';
import { PrFeedbackPoller, type PrFeedbackCheck } from '../loop/pr-feedback-poller';
import { SchedulerPoller, type SchedulerPass } from '../loop/scheduler-poller';
import { IssueIntakePoller, type IntakePass } from '../loop/issue-intake-poller';
import { ReplyPoller, type ReplyCheck } from '../loop/reply-poller';
import type { AgentRunner } from '../agent/runner';
import type {
  AgentRunRecord,
  Artifact,
  CostOverride,
  ListRunsFilter,
  LogRecord,
  Repo,
  Repository,
  RepoSourceMode,
  Run,
  RunStatus,
  Transition,
} from '../store/repository';
import type { CheckoutValidation } from '../integration/local-checkout';
import type { Suggestion } from '../integration/github';
import type { SuggestionSource } from '../integration/github-account';
import { catalogHasModel, catalogSupportsEffort, EFFORT_LEVELS, isEffortLevel, modelEfforts, type HarnessCatalog } from '../agent/harness-models';
import {
  DEFAULT_EFFORT_SETTING_KEY,
  DEFAULT_HARNESS,
  DEFAULT_HARNESS_SETTING_KEY,
  DEFAULT_MODEL_SETTING_KEY,
  HARNESS_IDS,
  isHarnessId,
  type HarnessId,
} from '../agent/harness';
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
  /**
   * User-scoped discovery source for the new-run autocomplete (the repo-less {@link SuggestionSource}
   * — real mode wires a `GitHubCliAccount`, mock wraps the fake). Omit → suggestions are empty. It is
   * *not* repo-bound, which is what lets the daemon start without a pinned repo.
   */
  suggestionSource?: SuggestionSource;
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
  /**
   * Global cost ceiling (M8 B3): when the aggregate `cost_used` of active runs reaches this, {@link
   * Orchestrator.start} refuses new runs (429) and the loop parks existing runs' next stages until the
   * aggregate clears or an operator overrides a run ({@link Orchestrator.overrideCost}). Undefined = off.
   */
  costCeiling?: number;
  /**
   * The stage a run re-enters when the PR Feedback Poller re-opens it to address reviewer feedback
   * ({@link Orchestrator.reopenForPrFeedback}). Must be a defined, non-terminal state. Defaults to
   * `plan` (see `EventLoop.DEFAULT_FEEDBACK_REENTRY_STATE`).
   */
  feedbackReentryState?: string;
  /** Marker a PR comment must start with to count as actionable feedback. Defaults to `feedback:`. */
  feedbackMarker?: string;
  /** Called when a background drain throws (e.g. a `FatalExecutorError`). Default: log to stderr. */
  onError?: (err: unknown) => void;
  /**
   * The harness a run gets when {@link Orchestrator.start} receives no explicit one (its precedence —
   * flag/env > persisted > default — is resolved upstream in `build-runner`). Also selects the catalog
   * `GET /models` reports. Defaults to the shipped {@link DEFAULT_HARNESS}.
   */
  defaultHarness?: HarnessId;
  /**
   * Resolves a harness id to its selectable-model catalog (the dashboard's model dropdown). `getModels`
   * asks for the *default* harness's catalog; `setModel` for the *run's* — so the allow-list always
   * matches the harness that will run. Omit → model selection is unavailable (empty list).
   */
  catalogFor?: (harness: string) => HarnessCatalog | undefined;
  /** The model a run uses when it has no override — what the dropdown shows as "Default". */
  defaultModel?: string;
  /**
   * Validates a "local directory" source pick (Milestone 12): whether `dir` is a checkout of `repoRef`.
   * Injected so the orchestrator stays transport/filesystem-free and unit-testable with a stub. Omit →
   * local-directory mode is unavailable (a `local` config request is a `400`); clone-on-run still works.
   */
  validateLocalCheckout?: (dir: string, repoRef: string) => Promise<CheckoutValidation>;
}

/** Statuses a run can no longer advance from — `updateConfig` is safe only when every run is here. */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['done', 'stopped']);

export class Orchestrator {
  private readonly broadcaster: Broadcaster;
  private readonly repo: Repository;
  private readonly runner: AgentRunner;
  private readonly loop: EventLoop;
  private readonly configPath?: string;
  private readonly suggestionSource?: SuggestionSource;
  private readonly resolver: RepoResolver;
  private readonly defaultWorkingRoot?: string;
  private readonly concurrency: number;
  private readonly costCeiling?: number;
  // Mutable: the dashboard's harness selector (`setDefaultHarness`) changes it live, without a restart.
  private defaultHarness: HarnessId;
  private readonly catalogFor?: (harness: string) => HarnessCatalog | undefined;
  private readonly defaultModel?: string;
  private readonly validateLocalCheckout?: (dir: string, repoRef: string) => Promise<CheckoutValidation>;
  private readonly prFeedbackPoller: PrFeedbackPoller;
  private readonly schedulerPoller: SchedulerPoller;
  private readonly issueIntakePoller: IssueIntakePoller;
  private readonly replyPoller: ReplyPoller;
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
    this.suggestionSource = options.suggestionSource;
    this.resolver = options.resolver;
    this.defaultWorkingRoot = options.defaultWorkingRoot;
    this.concurrency = options.concurrency ?? 1; // the requested cap; `EventLoop.drain` clamps it to a valid ≥ 1
    this.costCeiling = options.costCeiling;
    this.defaultHarness = options.defaultHarness ?? DEFAULT_HARNESS;
    this.catalogFor = options.catalogFor;
    this.defaultModel = options.defaultModel;
    this.validateLocalCheckout = options.validateLocalCheckout;
    this.onError = options.onError ?? ((err) => console.error(`[orchestrator] drain pump error: ${String(err)}`));
    this.loop = new EventLoop(this.repo, this.config.fsm, this.config.version, this.runner, {
      onTransition: (transition, run) => this.broadcaster.publish({ type: 'transition', runId: run.id, transition, run }),
      ...(options.now ? { now: options.now } : {}),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(options.costCeiling !== undefined ? { costCeiling: options.costCeiling } : {}),
      ...(options.feedbackReentryState !== undefined ? { feedbackReentryState: options.feedbackReentryState } : {}),
    });
    // The Orchestrator owns the PR Feedback Poller (it is the `PrFeedbackReopener`), so the daemon's
    // background tick and the dashboard's on-demand "Check now" both drive the *same* instance.
    this.prFeedbackPoller = new PrFeedbackPoller(this.repo, this.resolver, this, {
      ...(options.feedbackMarker !== undefined ? { marker: options.feedbackMarker } : {}),
    });
    // Likewise the Scheduler Poller (Milestone 9): the loop is its `BlockedController`, and both the
    // daemon's background tick and `POST /scheduler/check` drive this one instance.
    this.schedulerPoller = new SchedulerPoller(this.repo, this.resolver, this.loop);
    // The Issue Intake Poller (Milestone 11): the Orchestrator is its `RunStarter`, so an auto-picked
    // issue goes through the same `start` (dedup / cost ceiling / enrollment) as a manually-filed run.
    this.issueIntakePoller = new IssueIntakePoller(this.repo, this.resolver, this);
    // The Reply Poller (Q1 triage human-in-the-loop): the Orchestrator is its `AwaitingResumer`, so the
    // daemon's background tick and the dashboard's on-demand "Check for a reply" both drive one instance.
    this.replyPoller = new ReplyPoller(this.repo, this.resolver, this);
  }

  /** Reclaim crash-stranded events, then drain anything already queued (e.g. after a daemon restart). */
  recover(): void {
    this.loop.recover();
    this.kick();
  }

  /**
   * Graceful shutdown (the daemon's SIGINT/SIGTERM path). Pauses the fleet in a state the next start
   * resumes from exactly where it left off:
   *
   *  1. **Stop dispatching** — the loop's shutdown latch keeps the pump from claiming new events;
   *     queued work stays `pending` and dispatches on the next start's `recover()`.
   *  2. **Interrupt in-flight harness children** — a terminal Ctrl-C already SIGINTs them via the
   *     process group; this covers SIGTERM (kill/launchd) so shutdown never waits out a stage timeout.
   *  3. **Wait for the drain to settle** — an interrupted stage's failure surfaces as a
   *     {@link ShutdownInterruptError} (never a `needs_human` escalation) and its event stays
   *     `processing`, which startup recovery re-queues; a stage that finishes in this window still
   *     commits its transition normally, so completed work is never discarded.
   *  4. **Savepoint** — each interrupted run's dirty working tree is committed locally
   *     (`wip: shutdown savepoint …`, never pushed) so the agent's in-progress edits survive and the
   *     re-run stage finds them in the tree + `git log`.
   *
   * Returns a summary for the daemon's shutdown log. Idempotent; safe with zero in-flight work.
   */
  async shutdown(): Promise<{ interruptedRuns: number; savepointed: number }> {
    this.loop.beginShutdown();
    interruptHarnessChildren();
    await this.current; // the background drain (if any) — its workers either commit or abort as interrupted
    const runIds = this.repo.listProcessingRunIds();
    let savepointed = 0;
    for (const runId of runIds) {
      const run = this.repo.getRun(runId);
      if (!run) continue;
      try {
        // Savepoints are best-effort by contract: a failure (missing tree, git hiccup) must never block
        // exit — worst case the stage re-runs from its last commit, the same crash recovery already handles.
        const committed = await this.resolver
          .for(run.repoRef)
          .github.savepointWorkingTree(run.id, `wip: shutdown savepoint (run ${run.id}, stage ${run.currentState})`);
        if (committed) savepointed++;
      } catch (err) {
        console.error(`[shutdown] savepoint for run ${run.id} failed (continuing): ${String(err)}`);
      }
    }
    return { interruptedRuns: runIds.length, savepointed };
  }

  // --- commands ----------------------------------------------------------------

  /** Start a run for an issue and begin advancing it. Returns the created run immediately (the drain
   *  runs in the background; watch the stream for progress). */
  start(input: { issueRef: string; repoRef?: string; harness?: string; model?: string; effort?: string }): Run {
    if (!input.issueRef) throw new ApiError(400, 'issueRef is required');
    // Accept any form the operator pastes (owner/repo#N, a browser issue URL, …) and normalize to the
    // canonical ref the adapter expects (see integration/refs); a malformed ref is a 400, not a run.
    let parsed: ParsedIssueRef;
    try {
      parsed = parseIssueRef(input.issueRef);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
    const repoRef = input.repoRef ?? parsed.repo;
    // One active run per issue (Milestone 9): with several issues in flight, a second run racing the
    // same issue would fight over the branch and the §3.5 marker block. Terminal/archived runs don't
    // count — re-running a finished issue is legitimate.
    const existing = this.repo.findActiveRunByIssue(parsed.ref);
    if (existing) {
      throw new ApiError(409, `issue ${parsed.ref} already has an active run (#${existing.id}, ${existing.status})`);
    }
    // Harness selection (plan §6.5): absent or empty → the daemon default; a present-but-unknown id is a
    // 400 (never silently coerced to the default). Validated before any side effect (cost/enrollment).
    let harness: HarnessId;
    if (input.harness === undefined || input.harness === '') {
      harness = this.defaultHarness;
    } else if (isHarnessId(input.harness)) {
      harness = input.harness;
    } else {
      throw new ApiError(400, `unknown harness "${input.harness}"`);
    }
    // Pre-start model + effort (the picker): an explicit non-empty pick is validated against the *chosen
    // harness's* catalog (a 400, never silently coerced); omitted → the operator's persisted default
    // pre-selection (best-effort — a stale one that no longer fits the harness is ignored). Both resolved
    // before any side effect, against the harness that will run it. Effort is validated against the model.
    const model = this.resolvedStartModel(harness, input.model);
    const effort = this.resolvedStartEffort(harness, model, input.effort);
    // Global cost ceiling (M8 B3): refuse to admit a *new* run while active spend is at/over the
    // ceiling — a currently-executing stage is never interrupted, but no new work is started. The
    // operator lets in-flight runs finish (freeing headroom) or raises the ceiling. Existing runs park
    // and stay overridable per-run; only new-run admission bounces here. Checked *before* enrollment so a
    // cost-rejected request doesn't leave an orphan repo enrolled.
    if (this.costCeiling !== undefined) {
      const activeCost = this.repo.sumActiveCost();
      if (activeCost >= this.costCeiling) {
        throw new ApiError(
          429,
          `fleet cost ceiling reached ($${activeCost.toFixed(2)} of $${this.costCeiling.toFixed(2)} across active runs); ` +
            `let active runs finish or raise --cost-ceiling before starting new work`,
        );
      }
    }
    // Enrollment + working-directory gate (Milestone 8 Phase A + Milestone 12): admit a run only for a
    // repo the daemon can service AND that has an explicit source binding. A repo must declare where its
    // code lives — clone-on-run or a validated local directory — before any run starts, so a run can
    // never silently execute in the wrong (or the daemon's own) working tree.
    const row = this.repo.getRepo(repoRef);
    if (row) {
      if (row.sourceMode === null) {
        throw new ApiError(
          400,
          `repo ${repoRef} is attached but has no working directory configured — choose clone-on-run or a ` +
            `local directory for it in the dashboard (Repositories) before starting runs`,
        );
      }
      try {
        this.resolver.for(repoRef); // build/adopt the configured adapter (a bad config still throws)
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : String(err));
      }
    } else {
      // No registry row. Mock/single-repo resolvers service any ref (no registry) — try that first. Under
      // the real resolver an unknown repo throws; rather than a dead-end 400, attach it **unconfigured**
      // so it shows up in the dashboard's Repositories ledger, then bounce the run with an actionable
      // message asking the operator to pick a working directory. (Attaching needs a default working root.)
      try {
        this.resolver.for(repoRef);
      } catch (notEnrolled) {
        if (!this.defaultWorkingRoot) {
          throw new ApiError(400, notEnrolled instanceof Error ? notEnrolled.message : String(notEnrolled));
        }
        this.enrollRepo({ repoRef }); // creates an unconfigured registry row (working root = the daemon's --work)
        throw new ApiError(
          400,
          `attached ${repoRef} — now choose a working directory (clone-on-run or a local directory) for it ` +
            `in the dashboard (Repositories) before starting runs`,
        );
      }
    }
    const run = this.loop.startRun({ issueRef: parsed.ref, repoRef, harness, model, effort });
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
   * `needs_human` run resumes from where it escalated (counter reset); a `stopped` run re-opens and
   * continues from the stage it was stopped at (README §3.3 — `stop` is reversible, it keeps all state
   * and artifacts). Any other status is a `409`. An `awaiting_input` run is resumed by the Reply Poller
   * on a human reply (or the on-demand {@link checkReply}), not by this command.
   *
   * Optional `notes` (needs_human only — a paused/stopped run re-runs a stage that already has its
   * context, so there is nothing extra to guide) are the operator's guidance for the retried stage; the
   * loop records them on the resume transition and the Agent Runner delivers them as re-entry context.
   */
  resume(runId: number, notes?: string): Run {
    const existing = this.requireRun(runId);
    if (existing.status === 'paused') {
      const run = this.loop.resumePausedRun(runId);
      this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
      this.kick();
      return run;
    }
    if (existing.status === 'needs_human') {
      const run = this.conflictOnThrow(() => this.loop.resumeRun(runId, notes !== undefined ? { notes } : {})); // emits its own transition event
      this.kick();
      return run;
    }
    if (existing.status === 'stopped') {
      const run = this.conflictOnThrow(() => this.loop.resumeStoppedRun(runId)); // emits its own transition event
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

  /**
   * Re-open a finished run (`done`/`needs_human`) to address reviewer feedback on its open PR — the PR
   * Feedback Poller calls this in the daemon when it detects a new `feedback:` comment. It re-enters the
   * run at the configured stage (`plan` by default) with the open-PR context, then kicks the pump so the
   * loop re-dispatches. Publishes the status change to the stream. Satisfies {@link PrFeedbackReopener}.
   */
  reopenForPrFeedback(runId: number, reason: unknown): Run {
    const run = this.loop.reopenForPrFeedback(runId, reason);
    this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
    this.kick();
    return run;
  }

  /**
   * Check one run's open PR for feedback **right now** (the dashboard's "Check now" button), rather than
   * waiting for the next background tick. Returns the (possibly re-opened) run plus the outcome so the
   * caller can tell the operator what happened. A `reopened` result already published its status +
   * kicked the pump (via {@link reopenForPrFeedback}); for any other outcome we publish a `status` event
   * so connected dashboards pick up a changed watch flag / high-water mark. 404 for an unknown run.
   */
  async checkPrFeedback(runId: number): Promise<{ run: Run; result: PrFeedbackCheck }> {
    this.requireRun(runId); // 404 if missing
    const result = await this.prFeedbackPoller.checkRun(runId);
    const run = this.requireRun(runId);
    if (result !== 'reopened') this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
    return { run, result };
  }

  /**
   * One pass of the PR Feedback Poller over every watched run (the daemon's background tick calls this on
   * a timer). Returns how many runs were re-opened. Kept on the Orchestrator so the poller has a single
   * owner shared with {@link checkPrFeedback}.
   */
  pollPrFeedbackOnce(): Promise<number> {
    return this.prFeedbackPoller.checkOnce();
  }

  /**
   * One pass of the Issue Intake Poller (Milestone 11 — continuous mode): scan every watched repo's
   * open issues and auto-start a run for the next eligible one (sequential, one per repo). The daemon's
   * background tick calls this on the shared poll interval. Returns what the pass did. Kept on the
   * Orchestrator so the poller has one owner (the same pattern as PR-feedback + scheduler polling).
   */
  pollIssueIntakeOnce(): Promise<IntakePass> {
    return this.issueIntakePoller.checkOnce();
  }

  /**
   * One pass of the Reply Poller (Q1 triage human-in-the-loop): re-arm every `awaiting_input` run whose
   * issue thread has a human reply. The daemon's background tick calls this on the shared poll interval.
   * Returns how many runs were re-armed. Owned here so the poller has a single instance shared with the
   * dashboard's on-demand {@link checkReply}.
   */
  pollRepliesOnce(): Promise<number> {
    return this.replyPoller.checkOnce();
  }

  /**
   * Check one `awaiting_input` run for a human reply **right now** (the dashboard's "Check for a reply"
   * button), rather than waiting for the next background tick. Returns the (possibly resumed) run plus
   * the outcome so the caller can tell the operator what happened. A `resumed` result already re-armed
   * the run + kicked the pump (via {@link resumeAwaitingInput}); for any other outcome we publish a
   * `status` event so connected dashboards stay current. 404 for an unknown run.
   */
  async checkReply(runId: number): Promise<{ run: Run; result: ReplyCheck }> {
    this.requireRun(runId); // 404 if missing
    const result = await this.replyPoller.checkRun(runId);
    const run = this.requireRun(runId);
    if (result !== 'resumed') this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
    return { run, result };
  }

  /**
   * One pass of the Scheduler Poller (Milestone 9): refresh §3.5 declarations from the issues,
   * escalate dependency cycles, latch verified satisfaction, and flip `running ↔ blocked`. Serves
   * both the daemon's background tick and the dashboard's on-demand `POST /scheduler/check`. A pass
   * that woke runs kicks the pump so the freed work dispatches immediately.
   */
  async checkDependencies(): Promise<SchedulerPass> {
    const pass = await this.schedulerPoller.checkOnce();
    if (pass.woken > 0) this.kick();
    return pass;
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
   * Override the global cost ceiling for one run (M8 B3), the human-in-the-loop control the operator
   * uses when the fleet is parked at the ceiling: `next_step` lets the run advance exactly one more
   * stage (then it re-parks), `full` lets it run to completion, `null` clears an override. Kicks the
   * pump so the newly-admitted run advances. Refuses (`409`) a terminal run (nothing to advance).
   */
  overrideCost(runId: number, mode: CostOverride | null): Run {
    const existing = this.requireRun(runId); // 404
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new ApiError(409, `cannot override the cost ceiling for a "${existing.status}" run`);
    }
    this.repo.setCostOverride(runId, mode);
    const run = this.requireRun(runId);
    this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
    this.kick();
    return run;
  }

  /**
   * Set (or clear, with `null`) a run's harness model — the dashboard's model dropdown. The runner reads
   * the override fresh at each stage, so it takes effect on the run's **next** stage; the current stage
   * keeps the model it started with (no `kick` — the run advances on its own event flow). Refuses (`409`)
   * a terminal run (no next stage to apply it to) and (`400`) a model the active harness doesn't list.
   */
  setModel(runId: number, model: string | null): Run {
    const existing = this.requireRun(runId); // 404
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new ApiError(409, `cannot set the model for a "${existing.status}" run — it has no further stages`);
    }
    // Validate against the *run's* harness catalog — a run stamped `cursor` must accept Cursor's models,
    // not the default harness's — so the allow-list matches what will actually run.
    if (model !== null) {
      const catalog = this.catalogFor?.(existing.harness);
      if (!catalog || !catalogHasModel(catalog, model)) {
        throw new ApiError(400, `unknown model "${model}" for the ${existing.harness} harness`);
      }
    }
    this.repo.setRunModelOverride(runId, model);
    // Keep the pair consistent: if the new model doesn't support the run's current effort, drop it (a
    // stale effort on an effort-less model would otherwise linger). The runner reads both fresh next stage.
    if (existing.effortOverride && this.effortError(existing.harness, model, existing.effortOverride)) {
      this.repo.setRunEffortOverride(runId, null);
    }
    const run = this.requireRun(runId);
    this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
    return run;
  }

  /**
   * Re-point a run at another harness — the dashboard's per-run harness selector. Like the model
   * override, the loop loads the run fresh for each stage dispatch, so the switch takes effect on the
   * run's **next** stage; an in-flight stage finishes on the executor it started with (pause first to
   * hold the run before its next dispatch). Harnesses share the working-tree/artifact contract, so the
   * new one simply picks up the branch where the old one left it. Switching clears the run's model +
   * effort overrides — they name models from the old harness's catalog — returning the run to the new
   * harness's defaults until the operator picks again. Refuses (`409`) a terminal run and (`400`) an
   * unknown harness. Same-harness calls are a no-op (overrides kept).
   */
  setHarness(runId: number, harness: string): Run {
    const existing = this.requireRun(runId); // 404
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new ApiError(409, `cannot set the harness for a "${existing.status}" run — it has no further stages`);
    }
    if (!isHarnessId(harness)) throw new ApiError(400, `unknown harness "${harness}"`);
    if (harness !== existing.harness) {
      // One atomic write: the run must never be observable pointing at the new harness while still
      // carrying the old catalog's model/effort overrides.
      this.repo.transaction(() => {
        this.repo.setRunHarness(runId, harness);
        this.repo.setRunModelOverride(runId, null);
        this.repo.setRunEffortOverride(runId, null);
      });
    }
    const run = this.requireRun(runId);
    this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
    return run;
  }

  /**
   * Set (or clear, with `null`) a run's reasoning-effort override — the picker's effort control. Like the
   * model override it takes effect on the run's **next** stage. Refuses (`409`) a terminal run and (`400`)
   * an effort the run's harness/model doesn't support (validated against the run's own harness + model).
   */
  setEffort(runId: number, effort: string | null): Run {
    const existing = this.requireRun(runId); // 404
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new ApiError(409, `cannot set the effort for a "${existing.status}" run — it has no further stages`);
    }
    if (effort !== null) {
      const problem = this.effortError(existing.harness, existing.modelOverride, effort);
      if (problem) throw new ApiError(400, problem);
    }
    this.repo.setRunEffortOverride(runId, effort);
    const run = this.requireRun(runId);
    this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });
    return run;
  }

  /** The reason `effort` is not valid for `harness`+`modelId` (a 400 message), or `null` when it's fine.
   *  Shared by `start`, `setEffort`, and the persisted-default fallback so all three validate identically. */
  private effortError(harness: string, modelId: string | null, effort: string): string | null {
    if (!isEffortLevel(effort)) return `unknown effort "${effort}" (expected ${EFFORT_LEVELS.join(' | ')})`;
    const catalog = this.catalogFor?.(harness);
    if (!catalog || !catalogSupportsEffort(catalog)) return `the ${harness} harness doesn't support reasoning effort`;
    // When a *known* concrete model is chosen, its own level list must include the effort — a model that
    // declares none (e.g. Haiku) rejects every level. An unknown model id isn't gated (the harness applies
    // its own fallback), nor is the "no model chosen" case (validated against the harness only).
    const model = modelId ? catalog.models.find((m) => m.id === modelId) : undefined;
    if (model && !modelEfforts(catalog, model.id).includes(effort)) {
      return `model "${modelId}" doesn't support the "${effort}" effort`;
    }
    return null;
  }

  /** Resolve the model a new run starts on: an explicit non-empty pick (validated → 400) or the operator's
   *  persisted default (used only if still valid for this harness's catalog; a stale one is ignored). */
  private resolvedStartModel(harness: HarnessId, explicit: string | undefined): string | null {
    if (explicit) {
      const catalog = this.catalogFor?.(harness);
      if (!catalog || !catalogHasModel(catalog, explicit)) {
        throw new ApiError(400, `unknown model "${explicit}" for the ${harness} harness`);
      }
      return explicit;
    }
    const persisted = this.repo.getSetting(DEFAULT_MODEL_SETTING_KEY);
    const catalog = this.catalogFor?.(harness);
    return persisted && catalog && catalogHasModel(catalog, persisted) ? persisted : null;
  }

  /** Resolve the effort a new run starts on: an explicit pick (validated → 400) or the persisted default
   *  (used only if still valid for this harness + model; a stale one is ignored). */
  private resolvedStartEffort(harness: HarnessId, modelId: string | null, explicit: string | undefined): string | null {
    if (explicit) {
      const problem = this.effortError(harness, modelId, explicit);
      if (problem) throw new ApiError(400, problem);
      return explicit;
    }
    const persisted = this.repo.getSetting(DEFAULT_EFFORT_SETTING_KEY);
    return persisted && !this.effortError(harness, modelId, persisted) ? persisted : null;
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

  /**
   * The global cost ceiling (`null` when disabled) and the current aggregate `cost_used` of active runs
   * (M8 B3) — what the dashboard reads to show the fleet's spend vs. its ceiling and whether it's parked.
   */
  costStatus(): { ceiling: number | null; activeCost: number } {
    return { ceiling: this.costCeiling ?? null, activeCost: this.repo.sumActiveCost() };
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
  enrollRepo(input: { repoRef: string; workingRoot?: string; baseBranch?: string; cloneUrl?: string }): Repo {
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
    });
    this.resolver.invalidate(ref); // a re-enroll changed the config → drop any cached adapter
    return repo;
  }

  /**
   * Bind an enrolled repo's working-directory source (Milestone 12 — `POST /repos/source`): `clone` clones
   * a fresh per-run tree from the GitHub remote; `local` uses `localRepo` (an absolute path on the daemon's
   * machine) via `git worktree`, after {@link validateLocalCheckout} confirms it is a checkout of the linked
   * repo (a mismatch is a `400` with the reason — the wrong-directory guard). A `404` for an unenrolled repo
   * (enroll it first) and a `400` for a malformed ref. Invalidates the resolver cache so the new source takes
   * effect on the next run without a restart.
   */
  async configureRepoSource(input: { repoRef: string; mode: RepoSourceMode; localRepo?: string }): Promise<Repo> {
    if (!input.repoRef) throw new ApiError(400, 'repoRef is required');
    let ref: string;
    try {
      ref = parseRepoRef(input.repoRef);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
    if (input.mode !== 'clone' && input.mode !== 'local') throw new ApiError(400, `unknown source mode "${input.mode}" (expected clone | local)`);
    if (!this.repo.getRepo(ref)) throw new ApiError(404, `repo ${ref} is not enrolled — attach it (POST /repos) before configuring its working directory`);

    if (input.mode === 'local') {
      const dir = input.localRepo?.trim();
      if (!dir) throw new ApiError(400, 'localRepo (an absolute path to the checkout) is required for local mode');
      if (!this.validateLocalCheckout) throw new ApiError(400, 'local-directory mode is not available in this daemon');
      const check = await this.validateLocalCheckout(dir, ref);
      if (!check.ok) throw new ApiError(400, check.reason);
      this.repo.setRepoSource(ref, 'local', dir);
    } else {
      this.repo.setRepoSource(ref, 'clone', null);
    }
    this.resolver.invalidate(ref); // the source changed → drop any cached adapter so the next run rebuilds it
    return this.repo.getRepo(ref)!; // the dashboard re-fetches the repo list after configuring (like watch)
  }

  /**
   * Turn continuous mode on/off for an enrolled repo (Milestone 11 — `POST /repos/watch`). When on, the
   * Issue Intake Poller auto-picks the repo's eligible open issues (owner-filed, unassigned, non-`[WIP]`,
   * or bearing the override label). `label` sets a custom override label — omit to leave it, `null` to
   * reset to the default. A `404` for a repo that was never enrolled (enroll it first); a malformed ref
   * is a `400`. Watch state is independent of the adapter config, so a later re-enroll won't reset it.
   */
  setRepoWatch(input: { repoRef: string; watch: boolean; label?: string | null }): Repo {
    if (!input.repoRef) throw new ApiError(400, 'repoRef is required');
    let ref: string;
    try {
      ref = parseRepoRef(input.repoRef);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
    const existing = this.repo.getRepo(ref);
    if (!existing) throw new ApiError(404, `repo ${ref} is not enrolled — enroll it (POST /repos) before watching it`);
    // Continuous mode auto-starts runs, so the repo must have a working directory first — else every
    // auto-picked issue would bounce at the start gate (Milestone 12). Turning watch *off* is always allowed.
    if (input.watch && existing.sourceMode === null) {
      throw new ApiError(400, `repo ${ref} has no working directory configured — choose clone-on-run or a local directory before watching it`);
    }
    this.repo.setRepoWatch(ref, input.watch, input.label);
    return this.repo.getRepo(ref)!;
  }

  /**
   * Repos + open issues matching `query` for the dashboard's new-run autocomplete (README §3.3 Layer 7).
   * Delegates to the user-scoped {@link SuggestionSource}; with none configured there are no suggestions.
   * (Kept named `suggestIssues` — the route/method name — though it now also returns repo suggestions.)
   */
  async suggestIssues(query: string): Promise<Suggestion[]> {
    if (!this.suggestionSource) return [];
    return this.suggestionSource.suggest(query);
  }

  /**
   * A harness's selectable models + the daemon's default model (what a run without an override uses) —
   * powers the dashboard's model dropdowns (`GET /models[?harness=]`). With no `harness` it resolves the
   * *default* harness's catalog (the new-run bar); with one it resolves that harness's (the per-run picker,
   * which must offer the catalog of the harness the run is actually on). An unknown harness is a `400`;
   * with no catalog configured (or resolver) the model list is empty.
   */
  getModels(harness?: string): { harness: string | null; models: HarnessCatalog['models']; defaultModel: string | null } {
    if (harness !== undefined && !isHarnessId(harness)) throw new ApiError(400, `unknown harness "${harness}"`);
    const catalog = this.catalogFor?.(harness ?? this.defaultHarness);
    // Only report a default model that's actually a selectable model in the shown catalog — so it stays
    // consistent with the catalog even after a runtime harness change (the daemon's configured
    // `defaultModel` is the Claude `--model`, meaningless under another harness's catalog).
    const defaultModel = this.defaultModel && catalog && catalogHasModel(catalog, this.defaultModel) ? this.defaultModel : null;
    return {
      harness: catalog?.harness ?? null,
      models: catalog?.models ?? [],
      defaultModel,
    };
  }

  /**
   * The daemon's current default harness + selectable ids + the operator's persisted pre-run selection
   * (`GET /settings`). `defaultModel`/`defaultEffort` are the sticky pre-selection the *File a new run* bar
   * pre-fills and a start request falls back to; they're returned only while still valid for the default
   * harness (a stale one — e.g. left over from another harness — reads back as `null`).
   */
  getSettings(): {
    defaultHarness: HarnessId;
    harnesses: readonly HarnessId[];
    defaultModel: string | null;
    defaultEffort: string | null;
  } {
    const catalog = this.catalogFor?.(this.defaultHarness);
    const persistedModel = this.repo.getSetting(DEFAULT_MODEL_SETTING_KEY);
    const defaultModel = persistedModel && catalog && catalogHasModel(catalog, persistedModel) ? persistedModel : null;
    const persistedEffort = this.repo.getSetting(DEFAULT_EFFORT_SETTING_KEY);
    const defaultEffort = persistedEffort && !this.effortError(this.defaultHarness, defaultModel, persistedEffort) ? persistedEffort : null;
    return { defaultHarness: this.defaultHarness, harnesses: HARNESS_IDS, defaultModel, defaultEffort };
  }

  /**
   * Change the default harness and remember it across restarts (`PUT /settings/default-harness`). Takes
   * effect immediately for new runs and for {@link getModels}, no daemon restart — and persists to the
   * settings KV so the next boot (without a `--harness`/`FLEET_HARNESS` session override) starts with it.
   * A bad id is a `400`; nothing is persisted or changed in that case. Clears the persisted default model +
   * effort, since those belong to the old harness's catalog and don't carry over.
   */
  setDefaultHarness(harness: string): { defaultHarness: HarnessId } {
    if (!isHarnessId(harness)) throw new ApiError(400, `unknown harness "${harness}"`);
    this.repo.setSetting(DEFAULT_HARNESS_SETTING_KEY, harness);
    this.repo.setSetting(DEFAULT_MODEL_SETTING_KEY, null);
    this.repo.setSetting(DEFAULT_EFFORT_SETTING_KEY, null);
    this.defaultHarness = harness;
    return { defaultHarness: harness };
  }

  /**
   * Persist the operator's pre-run model + effort selection (`PUT /settings/default-model`) so it sticks
   * as the default for later runs and across restarts (the *File a new run* bar writes it on every pick).
   * `null` clears. Validated against the current default harness's catalog — a bad model/effort is a `400`,
   * nothing persisted. Effort is cleared automatically when it no longer fits the chosen model.
   */
  setDefaultModel(model: string | null, effort: string | null): { defaultModel: string | null; defaultEffort: string | null } {
    if (model !== null) {
      const catalog = this.catalogFor?.(this.defaultHarness);
      if (!catalog || !catalogHasModel(catalog, model)) {
        throw new ApiError(400, `unknown model "${model}" for the ${this.defaultHarness} harness`);
      }
    }
    // An effort only makes sense with a model that supports it; drop it otherwise (rather than 400 on a
    // combination the UI wouldn't offer), keeping the persisted pair self-consistent.
    const keptEffort = effort !== null && !this.effortError(this.defaultHarness, model, effort) ? effort : null;
    this.repo.setSetting(DEFAULT_MODEL_SETTING_KEY, model);
    this.repo.setSetting(DEFAULT_EFFORT_SETTING_KEY, keptEffort);
    return { defaultModel: model, defaultEffort: keptEffort };
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

  /**
   * Start a background drain if none is running; otherwise (a) flag the running one to re-scan once it
   * settles (§2.2) **and** (b) `wake()` its worker pool so the just-enqueued event fills a free
   * concurrency slot *immediately* instead of waiting for an in-flight stage to finish. The `wake` is
   * what keeps a run admitted mid-drain — an auto-picked issue, a resume, a new `start` — from starving
   * behind a long-running stage while the cap still has room; `rerun` remains the backstop for work that
   * lands in the gap between the pool going idle and the next drain starting.
   */
  private kick(): void {
    if (this.draining) {
      this.rerun = true;
      this.loop.wake();
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
      // An interruption during graceful shutdown is expected, not an error: the event stays
      // `processing` and the next start resumes it. Log it calmly so the operator's Ctrl-C doesn't
      // end on a scary stack trace for behavior that is working as designed.
      if (err instanceof ShutdownInterruptError) {
        console.log(`[shutdown] ${err.message} — it will resume on the next start`);
        return;
      }
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
