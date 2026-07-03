/**
 * Event Loop (Layer 3 — see README §3.3).
 *
 * An in-process, serial loop backed by the `events` table. It claims an event, runs the
 * run's current stage via the Agent Runner, asks the pure FSM engine for the next state,
 * and atomically commits the transition (+ the follow-up event). Delivery is at-least-once
 * and handlers are idempotent, so a crash mid-flight is safe to recover (README §3.3 Layer 3).
 *
 * Idempotency design (what the crash-recovery test proves):
 *  - Each transition records the `event_id` that caused it, under a UNIQUE index. If we
 *    crash after committing but before marking the event done, recovery reclaims the event
 *    and `processEvent` sees the existing transition and merely finalizes — the stage is not
 *    re-run, so there is no duplicate transition and no second charge.
 *  - `applyEvent` does the agent work and commits; `processEvent` marks the event done as a
 *    separate final step. Keeping `markEventDone` out of the commit transaction is exactly
 *    what makes the post-commit crash window recoverable.
 */

import { budgetExceeded, decideNext, FsmError } from '../fsm/engine';
import type { Decision, FsmConfig, StageResult } from '../fsm/types';
import type { EventRow, Repository, Run, RunStatus, Transition } from '../store/repository';
import type { AgentRunner, StageOutcome } from '../agent/runner';
import { FatalExecutorError } from '../agent/executor';

/** The single event type that drives the MVP loop: "advance this run's current stage." */
export const EVENT_ADVANCE = 'advance';

/**
 * Trigger recorded on the self-transition that parks a run awaiting a human reply (triage `clarify`).
 * Its transition `reason` carries the data the Reply Poller anchors on (issue, question comment, bot
 * login), so the poller reads it straight from the log — no separate marker store.
 */
export const AWAIT_INPUT_TRIGGER = 'await_input';

/**
 * Trigger recorded on the loop-owned transition that re-opens a finished run to address reviewer
 * feedback on its open PR (see the PR Feedback Poller). Like `revert`/`resume`, this transition
 * bypasses the FSM engine — it is a control action, not an agent-requested edge.
 */
export const PR_FEEDBACK_TRIGGER = 'pr_feedback';

/**
 * Triggers recorded on the two operator control transitions ({@link EventLoop.resumeRun} /
 * {@link EventLoop.revertRun}). Exported so the Agent Runner can recognize them when it builds the
 * re-entry context it hands the re-dispatched stage (the delivery half of README §2 "the target
 * state knows why it is being re-run").
 */
export const RESUME_TRIGGER = 'resume';
export const REVERT_TRIGGER = 'revert';

/**
 * Trigger recorded when the Scheduler finds the run's issue in a dependency cycle (Milestone 9):
 * every member escalates to `needs_human` rather than deadlocking forever (README §3.3). A control
 * transition like `revert`/`resume` — the FSM engine never sees it.
 */
export const DEPENDENCY_CYCLE_TRIGGER = 'dependency_cycle';

/** Default stage a run re-enters when the PR Feedback Poller re-opens it (README §2 planning). */
export const DEFAULT_FEEDBACK_REENTRY_STATE = 'plan';

/**
 * A stage failure observed **while the daemon is shutting down** ({@link EventLoop.beginShutdown}).
 * When the operator stops the daemon, in-flight harness children die from the same signal (terminal
 * Ctrl-C signals the whole process group; a SIGTERM shutdown interrupts them deliberately) — so their
 * non-zero exits are the *operator's* interruption, not a harness fault. Escalating them would park
 * healthy runs in `needs_human` (the Run-5 "cursor-agent exited with code 130" bug). Instead the loop
 * throws this: the drain aborts, the event stays `processing`, and startup recovery
 * ({@link EventLoop.recover}) re-queues it — the stage simply re-runs where it left off, on the same
 * branch and working tree (stage side effects are idempotent by design, README §2).
 */
export class ShutdownInterruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShutdownInterruptError';
  }
}

/**
 * Run flag set when a run is re-opened to address PR feedback. The Agent Runner reads it to inject
 * the open PR + its comment thread into every stage's input (so stages iterate on the existing PR
 * instead of rebuilding it). Once set it stays set for the run's life — a PR, once opened, is always
 * being iterated on. It is a boolean run flag, alongside `needs_frontend`/`needs_backend`.
 */
export const ADDRESSING_PR_FEEDBACK_FLAG = 'addressing_pr_feedback';

export interface EventLoopOptions {
  /** Called after every committed transition — the seam the CLI/dashboard stream subscribes to. */
  onTransition?: (transition: Transition, run: Run) => void;
  /** Injectable clock (for the wall-clock budget and deterministic tests). */
  now?: () => number;
  /** Safety bound so a misconfigured run can never spin `runUntilIdle` forever. */
  maxIterations?: number;
  /**
   * Global cost ceiling (M8 B3): when the aggregate `cost_used` of active runs reaches this, the loop
   * stops dispatching new stages (parks) — except a run an operator gave a `cost_override`. Undefined
   * disables the gate (the default; the one-shot CLI never sets it). See {@link claimNext}.
   */
  costCeiling?: number;
  /**
   * The stage a run re-enters when the PR Feedback Poller re-opens it to address reviewer feedback
   * ({@link EventLoop.reopenForPrFeedback}). Must be a defined, non-terminal state. Defaults to
   * {@link DEFAULT_FEEDBACK_REENTRY_STATE} (`plan`).
   */
  feedbackReentryState?: string;
}

export class EventLoop {
  /**
   * The active {@link drain} pool's `pump` while a drain is running, else `null`. {@link wake} calls it
   * so work enqueued *mid-drain* fills any free pool slot **immediately**, instead of waiting for an
   * in-flight worker to complete (which is the only other thing that re-pumps). Without this, a run
   * newly admitted while a long stage is in flight — an auto-picked issue, a resumed run, a fresh
   * `start` — starves behind that stage even though the concurrency cap has room.
   */
  private activePump: (() => void) | null = null;

  /**
   * Graceful-shutdown latch ({@link beginShutdown}). Once set: the claim gate stops handing out new
   * events (queued work stays `pending` for the next start), and an in-flight stage failure is treated
   * as an operator interruption ({@link ShutdownInterruptError}) rather than escalated. Never reset —
   * the loop instance dies with the process.
   */
  private shuttingDown = false;

  constructor(
    private readonly repo: Repository,
    private fsm: FsmConfig,
    private version: string,
    private readonly runner: AgentRunner,
    private readonly options: EventLoopOptions = {},
  ) {}

  /**
   * Swap the FSM rules + version the loop applies to *new* work (M5 `updateConfig`). The Orchestrator
   * only calls this while no run is in flight, so an in-flight run is never re-pointed at changed rules
   * (the config-version pinning invariant, README §3.3 Layer 2). New runs pick up the new version.
   */
  setConfig(fsm: FsmConfig, version: string): void {
    this.fsm = fsm;
    this.version = version;
  }

  /** Create a run in the initial state and enqueue its first event. Returns the run. The run's `harness`
   *  is pinned here (like the FSM config version); omitted → the store's column default (`claude-code`).
   *  Optional `model`/`effort` seed the run's overrides (the pre-start picker); omitted → daemon default. */
  startRun(input: { issueRef: string; repoRef: string; harness?: string; model?: string | null; effort?: string | null }): Run {
    const run = this.repo.createRun({
      issueRef: input.issueRef,
      repoRef: input.repoRef,
      initialState: this.fsm.initial,
      fsmConfigVersion: this.version,
      ...(input.harness !== undefined ? { harness: input.harness } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    });
    this.repo.enqueueEvent({ runId: run.id, type: EVENT_ADVANCE });
    return run;
  }

  /** Reclaim events stranded `processing` by a crash. Call once on startup, before ticking. */
  recover(): number {
    return this.repo.recoverProcessingEvents();
  }

  /**
   * Enter shutdown mode (the loop half of the daemon's graceful shutdown; see Orchestrator.shutdown).
   * From this point on no new event is claimed, and an in-flight stage that fails is *interrupted*
   * (its event left `processing` for startup recovery), not escalated to `needs_human`. In-flight
   * stages that complete normally still commit — finished work is never thrown away.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /** Whether {@link beginShutdown} has been called (read by the Orchestrator's shutdown sequencing). */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Resume a `needs_human` run from where it escalated (plans/milestone-4.md §3.10). The operator
   * fixes the cause, then calls this: it moves the run back to the stage it escalated from, resets
   * the round counters (a fresh budget, per README §3.3 Layer 6), and enqueues an advance event so
   * the loop re-dispatches that stage — safely, because every stage side effect is idempotent.
   *
   * Optional `notes` are the operator's guidance for the retry ("accept the reviewer's findings",
   * "drop requirement X"). They are recorded as the resume transition's reason — one record that is
   * both the audit trail and what the Agent Runner delivers to the re-dispatched stage as its
   * re-entry context — so a guided resume actually changes the stage's behavior instead of
   * re-running it blind.
   *
   * Part of the M5 control surface alongside {@link pauseRun} / {@link stopRun} / {@link revertRun}.
   * Returns the updated run; the caller (`Orchestrator`) kicks the drain pump.
   */
  resumeRun(runId: number, options: { notes?: string } = {}): Run {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`resumeRun: run ${runId} not found`);
    if (run.status !== 'needs_human') throw new Error(`resumeRun: run ${runId} is "${run.status}", not needs_human`);

    const escalation = [...this.repo.listTransitions(runId)].reverse().find((t) => t.toState === this.fsm.escalationState);
    if (!escalation) throw new Error(`resumeRun: run ${runId} has no escalation transition to resume from`);
    const target = escalation.fromState;
    const notes = options.notes?.trim();

    const transition = this.repo.transaction(() => {
      const t = this.repo.commitTransition({
        runId,
        fromState: this.fsm.escalationState,
        toState: target,
        trigger: RESUME_TRIGGER,
        ...(notes ? { reason: { kind: 'operator_resume', notes } } : {}),
        isReset: true, // reset round counters → a fresh budget of rounds for the resumed loop
        status: 'running',
        eventId: null, // a manual operator transition, not driven by an event
      });
      this.repo.enqueueEvent({ runId, type: EVENT_ADVANCE });
      return t;
    });
    this.emit(transition, runId);
    return this.requireRun(runId);
  }

  /**
   * Pause a `running` run (README §3.3 Layer 6 — `pause` halts dispatch and is resumable). Status-only:
   * the dispatch gate then leaves the run's pending event parked until {@link resumePausedRun}. A stage
   * already in flight finishes (the commit honors the pause, §2.3); pause never interrupts the agent.
   * Returns the updated run. Throws if the run isn't `running`.
   */
  pauseRun(runId: number): Run {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`pauseRun: run ${runId} not found`);
    if (run.status !== 'running') throw new Error(`pauseRun: run ${runId} is "${run.status}", not running`);
    this.repo.setRunStatus(runId, 'paused');
    return this.requireRun(runId);
  }

  /**
   * Resume a `paused` run: flip it back to `running` so the dispatch gate admits its already-pending
   * event (paused never removes it). Status-only — no new transition, no new event (which would risk a
   * duplicate dispatch). Returns the updated run; the caller kicks the pump. Throws if not `paused`.
   */
  resumePausedRun(runId: number): Run {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`resumePausedRun: run ${runId} not found`);
    if (run.status !== 'paused') throw new Error(`resumePausedRun: run ${runId} is "${run.status}", not paused`);
    this.repo.setRunStatus(runId, 'running');
    return this.requireRun(runId);
  }

  /**
   * Re-open a `stopped` run and continue it **from where it left off** — the operator's "pick it back
   * up" (README §3.3 Layer 6: `stop` is not delete; all state/artifacts are kept, so a stop is
   * reversible). Records a loop-owned self-transition at the run's current state, resets the round
   * counters (a fresh budget, like {@link resumeRun}), sets status `running`, and enqueues one advance
   * event so the loop re-dispatches the stage it was stopped at. Unlike `stop`, this is not an FSM
   * edge — a control action, so no `src/fsm` change. Refuses a run that isn't `stopped`, or one parked
   * at a terminal state (a `done`→`stopped` edge can't happen, but guard anyway; use `revert` to pick a
   * stage). `stopRun` discarded the pending event, so the fresh advance is the only one. Caller kicks.
   */
  resumeStoppedRun(runId: number): Run {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`resumeStoppedRun: run ${runId} not found`);
    if (run.status !== 'stopped') throw new Error(`resumeStoppedRun: run ${runId} is "${run.status}", not stopped`);
    const state = this.fsm.states[run.currentState];
    if (!state || state.terminal) {
      throw new Error(`resumeStoppedRun: run ${runId} is at terminal state "${run.currentState}"; use revert to choose a stage to resume from`);
    }
    const transition = this.repo.transaction(() => {
      this.repo.discardPendingEvents(runId); // defensive: stop already cleared it; ensure exactly one fresh advance
      const t = this.repo.commitTransition({
        runId,
        fromState: run.currentState,
        toState: run.currentState, // self-edge: continue where it left off
        trigger: RESUME_TRIGGER,
        isReset: true, // a fresh budget of rounds for the resumed cycle
        status: 'running',
        eventId: null, // a control transition, not driven by an event
      });
      this.repo.enqueueEvent({ runId, type: EVENT_ADVANCE });
      return t;
    });
    this.emit(transition, runId);
    return this.requireRun(runId);
  }

  /**
   * Park a `running` run on unsatisfied dependencies (Milestone 9): the Scheduler Poller's visible
   * mirror of the claim's dependency gate. Status-only, like {@link pauseRun} — the pending event
   * stays, held back by the gate, and correctness never depends on this flip having happened (the
   * claim's `depends_on`/`deps_satisfied_at` predicate is the enforcement; this is what the operator
   * sees). Throws if the run isn't `running`.
   */
  parkBlocked(runId: number): Run {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`parkBlocked: run ${runId} not found`);
    if (run.status !== 'running') throw new Error(`parkBlocked: run ${runId} is "${run.status}", not running`);
    this.repo.setRunStatus(runId, 'blocked');
    return this.requireRun(runId);
  }

  /**
   * Wake a dependency-`blocked` run whose dependencies have cleared (Milestone 9): flip it back to
   * `running` so the dispatch gate admits its parked event. Status-only — no new transition, no new
   * event (the parked one is still pending; enqueueing another would double-dispatch). The caller
   * (the Scheduler Poller) stamps the satisfaction latch and drops the stale working tree *before*
   * this flip, so nothing can dispatch against pre-merge base. Only `blocked` is ever woken —
   * `paused`/`needs_human`/`awaiting_input` park for different reasons and their owners resume them.
   */
  wakeBlocked(runId: number): Run {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`wakeBlocked: run ${runId} not found`);
    if (run.status !== 'blocked') throw new Error(`wakeBlocked: run ${runId} is "${run.status}", not blocked`);
    this.repo.setRunStatus(runId, 'running');
    return this.requireRun(runId);
  }

  /**
   * Escalate a run whose issue sits in a dependency cycle (Milestone 9): left alone the members
   * would block each other forever, so every one goes to `needs_human` with the cycle named in the
   * reason (README §3.3 — escalate, never deadlock). A loop-owned control transition (eventId null),
   * with pending events discarded first so a later `resume` is driven by exactly one fresh advance
   * event (the {@link revertRun} discipline). `resumeRun` works unchanged afterwards — and if the
   * operator fixed nothing, the next Scheduler pass simply re-escalates. Accepts `running` or
   * `blocked` runs; anything else is parked for a different reason and is left to its owner.
   */
  escalateDependencyCycle(runId: number, reason: unknown): Run {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`escalateDependencyCycle: run ${runId} not found`);
    if (run.status !== 'running' && run.status !== 'blocked') {
      throw new Error(`escalateDependencyCycle: run ${runId} is "${run.status}", not running/blocked`);
    }
    const transition = this.repo.transaction(() => {
      this.repo.discardPendingEvents(runId);
      return this.repo.commitTransition({
        runId,
        fromState: run.currentState,
        toState: this.fsm.escalationState,
        trigger: DEPENDENCY_CYCLE_TRIGGER,
        reason,
        status: 'needs_human',
        eventId: null, // a control transition, not driven by an event
      });
    });
    this.emit(transition, runId);
    return this.requireRun(runId);
  }

  /**
   * Stop a run (README §3.3 Layer 6 — terminal, not resumable; `stop` is not delete, all state/artifacts
   * stay for inspection). Sets the terminal `stopped` status; the dispatch gate then never admits its
   * events. A stage in flight finishes and its commit honors the stop (§2.3). Returns the updated run.
   * Throws if the run is already terminal (`done`/`stopped`).
   */
  stopRun(runId: number): Run {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`stopRun: run ${runId} not found`);
    if (run.status === 'done' || run.status === 'stopped') {
      throw new Error(`stopRun: run ${runId} is already "${run.status}"`);
    }
    // Cancel any not-yet-claimed follow-up event so a terminal run leaves no stale entry in the queue
    // (an in-flight `processing` event is untouched — it finishes and its commit honors the stop, §2.3).
    this.repo.transaction(() => {
      this.repo.discardPendingEvents(runId);
      this.repo.setRunStatus(runId, 'stopped');
    });
    return this.requireRun(runId);
  }

  /**
   * Revert a run to an earlier (or any non-terminal) state on operator command (README §3.3 Layer 6 —
   * `revert <state>` for normal control and `needs_human` resolution). Records a manual transition to
   * `toState`, resets the round counters (a fresh budget, like {@link resumeRun}), sets `running`, and
   * enqueues an advance event so the loop re-dispatches there. A `reason` is required so the target
   * stage knows why it is re-running (README §2 — a reasonless revert just repeats prior output).
   * Returns the updated run; the caller kicks the pump.
   */
  revertRun(runId: number, toState: string, reason: unknown): Run {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`revertRun: run ${runId} not found`);
    if (run.status === 'done' || run.status === 'stopped') {
      throw new Error(`revertRun: run ${runId} is terminal ("${run.status}")`);
    }
    const target = this.fsm.states[toState];
    if (!target) throw new Error(`revertRun: unknown state "${toState}"`);
    if (target.terminal) throw new Error(`revertRun: cannot revert to terminal state "${toState}"`);
    if (reason === undefined || reason === null || reason === '') {
      throw new Error('revertRun: a reason is required so the target stage knows why it is re-running');
    }
    // Refuse while a stage is mid-flight: that stage will commit its own transition when it finishes
    // and would clobber the revert (a serial-loop race). Wait for the stage to finish (pausing the run
    // stops the *next* dispatch, so it then parks) before reverting.
    if (this.repo.hasProcessingEvent(runId)) {
      throw new Error(`revertRun: run ${runId} has a stage in flight; wait for it to finish (pause the run) before reverting`);
    }

    const transition = this.repo.transaction(() => {
      // Cancel any follow-up event left over from the state the run was parked in, so the revert is
      // driven by exactly one fresh advance event (never a stale one targeting the old state).
      this.repo.discardPendingEvents(runId);
      const t = this.repo.commitTransition({
        runId,
        fromState: run.currentState,
        toState,
        trigger: REVERT_TRIGGER,
        reason,
        isReset: true, // fresh budget of rounds for the reverted-to loop
        status: 'running',
        eventId: null, // a manual operator transition, not driven by an event
      });
      this.repo.enqueueEvent({ runId, type: EVENT_ADVANCE });
      return t;
    });
    this.emit(transition, runId);
    return this.requireRun(runId);
  }

  /**
   * Re-open a **finished** run (`done` or `needs_human`) to address reviewer feedback on its still-open
   * PR — the PR Feedback Poller calls this when it detects a new marker-matching comment. It records a
   * loop-owned transition from the run's current (terminal) state back to the configured re-entry stage
   * (`plan` by default), resets the round counters (a fresh budget for the new cycle, like {@link
   * resumeRun}), sets status `running`, sets the {@link ADDRESSING_PR_FEEDBACK_FLAG} flag so the Agent
   * Runner injects the open-PR context into every stage, and enqueues an advance event so the loop
   * re-dispatches. Like `revert`/`resume` this bypasses the FSM engine (a control action, not an
   * agent-requested edge), so it needs no `src/fsm` change. A `reason` is required so the re-entered
   * stage knows why it is re-running. Returns the updated run; the caller kicks the pump.
   */
  reopenForPrFeedback(runId: number, reason: unknown): Run {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`reopenForPrFeedback: run ${runId} not found`);
    if (run.status !== 'done' && run.status !== 'needs_human') {
      throw new Error(`reopenForPrFeedback: run ${runId} is "${run.status}", not a finished (done/needs_human) run`);
    }
    if (reason === undefined || reason === null || reason === '') {
      throw new Error('reopenForPrFeedback: a reason is required so the re-entered stage knows why it is re-running');
    }
    const toState = this.options.feedbackReentryState ?? DEFAULT_FEEDBACK_REENTRY_STATE;
    const target = this.fsm.states[toState];
    if (!target) throw new Error(`reopenForPrFeedback: unknown re-entry state "${toState}"`);
    if (target.terminal) throw new Error(`reopenForPrFeedback: re-entry state "${toState}" is terminal`);

    const transition = this.repo.transaction(() => {
      // A finished run holds no follow-up event, but discard defensively so the re-entry is driven by
      // exactly one fresh advance event (mirrors revertRun).
      this.repo.discardPendingEvents(runId);
      const t = this.repo.commitTransition({
        runId,
        fromState: run.currentState,
        toState,
        trigger: PR_FEEDBACK_TRIGGER,
        reason,
        isReset: true, // fresh budget of rounds for the re-opened cycle
        status: 'running',
        eventId: null, // a control transition, not driven by an event
      });
      this.repo.mergeRunFlags(runId, { [ADDRESSING_PR_FEEDBACK_FLAG]: true });
      this.repo.enqueueEvent({ runId, type: EVENT_ADVANCE });
      return t;
    });
    this.emit(transition, runId);
    return this.requireRun(runId);
  }

  private requireRun(runId: number): Run {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`run ${runId} vanished`);
    return run;
  }

  /**
   * Claim the next dispatchable event, applying the global cost-ceiling gate (M8 B3). Under the
   * ceiling — or with no ceiling configured — this is a plain claim. At/over the ceiling only a run
   * carrying a `cost_override` is admitted; a one-shot `next_step` override is consumed here so the
   * run advances exactly one stage and its follow-up then re-parks. Shared by {@link tick} (serial)
   * and {@link drain} (pool) so both honor the ceiling identically.
   */
  private claimNext(): EventRow | undefined {
    // Shutdown gate first: once the daemon is stopping, no new stage starts — queued events stay
    // `pending` and dispatch on the next start (recovery kicks the pump). Cheaper and safer than
    // cancelling: nothing to undo, nothing racing the in-flight workers we are waiting out.
    if (this.shuttingDown) return undefined;
    const ceiling = this.options.costCeiling;
    if (ceiling === undefined) return this.repo.claimNextEvent();
    const overCeiling = this.repo.sumActiveCost() >= ceiling;
    const event = this.repo.claimNextEvent({ onlyOverrides: overCeiling });
    if (event && overCeiling && this.repo.getRun(event.runId)?.costOverride === 'next_step') {
      this.repo.setCostOverride(event.runId, null); // consume the one-stage override
    }
    return event;
  }

  /** Process one event if any is dispatchable. Returns false when the queue is idle. */
  async tick(): Promise<boolean> {
    const event = this.claimNext();
    if (!event) return false;
    await this.processEvent(event);
    return true;
  }

  /** Drain the queue. Serial: one stage at a time. Used by the one-shot CLI and the Reply Poller. */
  async runUntilIdle(): Promise<void> {
    const max = this.options.maxIterations ?? 1000;
    for (let i = 0; i < max; i++) {
      if (!(await this.tick())) return;
    }
    throw new Error('EventLoop.runUntilIdle exceeded maxIterations — possible runaway');
  }

  /**
   * Drain the queue with a bounded worker pool (Milestone 8 Phase B — the daemon path). Up to
   * `concurrency` stages run at once: **parallel across runs, serial within a run** — the claim's
   * within-run guard ({@link Repository.claimNextEvent}) never hands out a second event for a run
   * with a stage already in flight, so two stages of one run can't overlap (they share a working
   * tree and a state cursor). Resolves once the queue is idle *and* every worker has settled.
   *
   * `concurrency = 1` is exactly the serial drain (why the Orchestrator defaults to 1 and existing
   * tests are unchanged); the daemon runs a higher global cap. A failure — a worker throw (only a
   * {@link FatalExecutorError} escapes `processEvent`, since escalate/await are commits, not throws) or
   * a synchronous claim error (a broken DB) — stops new dispatch and, once the already-running workers
   * settle, rejects the drain with the first error, mirroring the serial path: the triggering event
   * stays recoverable and the entry point surfaces the remedy. In-flight stages always finish (a
   * failure never abandons a mid-flight commit).
   *
   * The DB claim/commit calls are synchronous (better-sqlite3), so the pump's `inFlight` bookkeeping
   * runs on the single JS thread with no interleaving; the only real concurrency is the overlapping
   * `await runner.runStage(...)` calls.
   */
  async drain(concurrency: number): Promise<void> {
    // Authoritative clamp for the whole pool: any non-finite or < 1 cap falls back to serial (1) rather
    // than wedging (`inFlight < NaN` is always false → nothing dispatches) or ignoring the cap entirely.
    const limit = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 1;
    let inFlight = 0;
    let firstError: unknown;
    let stopped = false;

    const fail = (err: unknown): void => {
      if (!stopped) {
        stopped = true;
        firstError = err;
      }
    };

    await new Promise<void>((resolve) => {
      const pump = (): void => {
        while (!stopped && inFlight < limit) {
          let event: EventRow | undefined;
          try {
            event = this.claimNext();
          } catch (err) {
            // A synchronous claim failure (e.g. a DB error) must not escape into the voided worker
            // promise and wedge the drain — abort like the serial path, letting in-flight work settle.
            fail(err);
            break;
          }
          if (!event) break;
          inFlight++;
          void this.processEvent(event).then(
            () => {
              inFlight--;
              pump();
            },
            (err) => {
              inFlight--;
              fail(err);
              pump();
            },
          );
        }
        // Idle once no worker is running and the pump found nothing more to claim. Clear the wake hook
        // in the same tick so a `wake()` racing the resolve can't re-enter a finished pool (the caller's
        // `rerun` flag starts a fresh drain for any work that lands in that gap).
        if (inFlight === 0) {
          this.activePump = null;
          resolve();
        }
      };
      // Publish the pump so `wake()` can nudge it while the drain runs (see the field doc). Assigned
      // before the first `pump()` so a claim inside it already sees the live hook.
      this.activePump = pump;
      pump();
    });

    if (stopped) throw firstError;
  }

  /**
   * Nudge an in-progress {@link drain} to claim newly-enqueued events into any free pool slots **now**,
   * rather than only when an in-flight worker finishes. A no-op when no drain is running (the caller is
   * expected to start one). Idempotent and safe to call after any `enqueueEvent`; the pump claims only
   * what the cap and the dependency/cost gates allow, so an extra call never over-dispatches.
   */
  wake(): void {
    this.activePump?.();
  }

  /**
   * Process a claimed event idempotently. If the event already produced a transition
   * (crash after commit, before finalize), just finalize; otherwise apply it, then finalize.
   */
  async processEvent(event: EventRow): Promise<void> {
    if (this.repo.getTransitionByEventId(event.id)) {
      this.repo.markEventDone(event.id);
      return;
    }
    await this.applyEvent(event);
    this.repo.markEventDone(event.id);
  }

  /**
   * Run the event's stage and atomically commit its transition (and the follow-up event).
   * Deliberately does NOT mark the event done — `processEvent` does, which is what makes the
   * post-commit crash window recoverable. Exposed so the crash-recovery test can simulate a
   * crash by calling this and then *not* finalizing.
   */
  async applyEvent(event: EventRow): Promise<void> {
    const run = this.repo.getRun(event.runId);
    if (!run) throw new Error(`applyEvent: run ${event.runId} not found`);

    // Config-version pinning (README §3.3 Layer 2): a run uses the config version it
    // started under for its whole lifetime. This loop carries one config; if the run was
    // started under a different one, we must not silently apply these (possibly changed)
    // rules. Loading the run's *pinned* version is the versioned-config-store job (Milestone
    // 5/6); until then, fail safe — escalate rather than mis-process.
    if (run.fsmConfigVersion !== this.version) {
      this.escalate(run, event, 'config_version_mismatch', {
        runVersion: run.fsmConfigVersion,
        loopVersion: this.version,
        note: 'run started under a different FSM config version; resolve before resuming',
      });
      return;
    }

    // Run-budget guard: checked before dispatching the stage (README §2 run budget).
    const usage = {
      tokens: run.tokensUsed,
      agentRuns: run.agentRunsCount,
      wallClockMs: this.now() - Date.parse(run.createdAt),
    };
    if (budgetExceeded(this.fsm.budget, usage)) {
      this.escalate(run, event, 'budget_exceeded', { budget: this.fsm.budget, usage });
      return;
    }

    // The executor owns retry/backoff (Layer 5); if it still throws, retries are exhausted.
    // Escalate this run rather than letting one stage failure kill the whole drain loop —
    // EXCEPT a FatalExecutorError (e.g. the harness is unauthenticated), which every run would
    // hit: propagate it so the drain aborts and the entry point surfaces the remedy. The event
    // stays unclaimed-and-recoverable, so fixing the cause and re-running just resumes it.
    let outcome: StageOutcome;
    try {
      outcome = await this.runner.runStage(run);
    } catch (err) {
      // During shutdown a failure is (almost surely) our own interruption — the harness child was
      // signalled, or a git/gh subprocess died with it. Never park the run in `needs_human` for that:
      // throw so the event stays `processing` and startup recovery re-runs the stage. (If the failure
      // was actually genuine, the re-run fails again after restart and escalates normally then.)
      if (this.shuttingDown) {
        throw new ShutdownInterruptError(`stage "${run.currentState}" of run ${run.id} interrupted by shutdown: ${String(err)}`);
      }
      if (err instanceof FatalExecutorError) throw err;
      this.escalate(run, event, 'executor_error', { error: String(err) });
      return;
    }
    if (outcome.kind === 'escalate') {
      // Same shutdown rule for runner-labeled escalations (git_error, malformed_output, …): a git
      // subprocess or truncated harness stream killed by the shutdown signal must not park the run.
      if (this.shuttingDown) {
        throw new ShutdownInterruptError(
          `stage "${run.currentState}" of run ${run.id} interrupted by shutdown (would have escalated: ${outcome.trigger})`,
        );
      }
      // The runner labels *why* it escalated (malformed_output, internal_review_cap, git_error),
      // so the cause is a first-class trigger in the log, not buried in the reason payload.
      this.escalate(run, event, outcome.trigger, outcome.reason);
      return;
    }
    if (outcome.kind === 'await_input') {
      // triage asked the human a question on the issue. Park the run; the Reply Poller re-arms it
      // when a human replies. Like escalate, this is a loop-owned outcome the engine never sees.
      this.parkAwaitingInput(run, event, outcome.reason);
      return;
    }

    const envelope = outcome.envelope;
    // Persisted flags + this stage's flags drive the engine's skip decisions (README §2).
    const mergedFlags = { ...run.flags, ...(envelope.flags ?? {}) };
    const result: StageResult = {
      requestedTransition: envelope.requestedTransition,
      ...(envelope.target !== undefined ? { target: envelope.target } : {}),
      flags: mergedFlags,
    };

    let decision: Decision;
    try {
      decision = decideNext(this.fsm, {
        current: run.currentState,
        result,
        counters: this.repo.computeCounters(run.id),
      });
    } catch (err) {
      // The agent only *requests* a transition; the engine enforces legality. An illegal or
      // unknown request is bad output — escalate, never coerce (README §3.3 Layer 4).
      if (err instanceof FsmError) {
        this.escalate(run, event, 'invalid_transition', { requested: envelope.requestedTransition, error: String(err) });
        return;
      }
      throw err;
    }

    // A back-edge without a reason would make the target stage repeat itself (README §2,
    // risk "reversion without progress"). Refuse it — escalate rather than loop blindly.
    if (decision.backEdge && (envelope.reason === undefined || envelope.reason === null)) {
      this.escalate(run, event, 'missing_reason', {
        requested: envelope.requestedTransition,
        to: decision.to,
        note: 'back-edge requested without a required reason',
      });
      return;
    }

    const terminal = this.fsm.states[decision.to]?.terminal === true;

    // A `pause`/`stop` command can land *while* a stage runs (the stage awaits the harness). The
    // dispatch gate already stops the *next* dispatch; here we also honor a status flipped mid-stage
    // so the in-flight stage's commit doesn't clobber it back to `running` (M5, plans/milestone-5.md
    // §2.3). The current stage always finishes — pause halts dispatch, it does not interrupt the agent.
    const interrupted = this.repo.getRun(run.id)?.status;
    const status: RunStatus = terminal
      ? decision.to === this.fsm.escalationState
        ? 'needs_human'
        : 'done'
      : interrupted === 'paused' || interrupted === 'stopped'
        ? interrupted
        : 'running';

    const transition = this.repo.transaction(() => {
      const t = this.repo.commitTransition({
        runId: run.id,
        fromState: run.currentState,
        toState: decision.to,
        trigger: result.requestedTransition,
        reason: envelope.reason ?? null,
        backEdge: decision.backEdge,
        counterKey: decision.counter ?? null,
        eventId: event.id,
        status,
      });
      if (envelope.flags && Object.keys(envelope.flags).length > 0) {
        this.repo.mergeRunFlags(run.id, envelope.flags);
      }
      for (const artifact of envelope.artifacts ?? []) {
        this.repo.recordArtifact({ runId: run.id, kind: artifact.kind, locator: artifact.locator });
      }
      // Keep the run moving while it can still advance. A `stopped` run is terminal (no follow-up);
      // a `paused` run keeps its pending event so `resume` re-dispatches it (§2.3).
      if (!terminal && status !== 'stopped') this.repo.enqueueEvent({ runId: run.id, type: EVENT_ADVANCE });
      return t;
    });

    this.emit(transition, run.id);
  }

  /**
   * Park a run that asked the human a question (`triage` → `clarify`). Records a self-transition that
   * keeps the run in its current stage and sets status `awaiting_input`, and — deliberately — enqueues
   * NO follow-up event, so the run holds no executor until re-armed. The transition is keyed to the
   * event id like any other, so a replayed event is finalized rather than re-run (at-least-once safe).
   * The Reply Poller calls {@link resumeAwaitingInput} when a human replies on the issue.
   */
  private parkAwaitingInput(run: Run, event: EventRow, reason: unknown): void {
    const transition = this.repo.commitTransition({
      runId: run.id,
      fromState: run.currentState,
      toState: run.currentState, // stays put; a human reply re-runs this same stage (triage)
      trigger: AWAIT_INPUT_TRIGGER,
      reason,
      status: 'awaiting_input',
      eventId: event.id,
    });
    this.emit(transition, run.id);
  }

  /**
   * Re-arm an `awaiting_input` run after a human replied on the issue: flip it back to `running` and
   * enqueue an advance event so the loop re-runs the stage that asked (triage), which now reads the
   * reply from the issue thread. Re-running is safe because every triage side effect is idempotent.
   * Called by the Reply Poller; the two writes are one transaction so the run is never `running`
   * without a pending event to act on.
   */
  resumeAwaitingInput(runId: number): void {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`resumeAwaitingInput: run ${runId} not found`);
    if (run.status !== 'awaiting_input') {
      throw new Error(`resumeAwaitingInput: run ${runId} is "${run.status}", not awaiting_input`);
    }
    this.repo.transaction(() => {
      this.repo.setRunStatus(runId, 'running');
      this.repo.enqueueEvent({ runId, type: EVENT_ADVANCE });
    });
  }

  /** Force a run to the escalation state (needs_human). Used by loop-owned guards. */
  private escalate(run: Run, event: EventRow, trigger: string, reason: unknown): void {
    // commitTransition is already atomic; no outer transaction needed for a single write.
    const transition = this.repo.commitTransition({
      runId: run.id,
      fromState: run.currentState,
      toState: this.fsm.escalationState,
      trigger,
      reason,
      status: 'needs_human',
      eventId: event.id,
    });
    this.emit(transition, run.id);
  }

  private emit(transition: Transition, runId: number): void {
    if (!this.options.onTransition) return;
    const run = this.repo.getRun(runId);
    if (!run) return;
    try {
      this.options.onTransition(transition, run);
    } catch {
      // Best-effort notification: a throwing subscriber must never wedge the loop.
      // Subscribers own their error handling; the loop keeps draining.
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
