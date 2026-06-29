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

/** The single event type that drives the MVP loop: "advance this run's current stage." */
export const EVENT_ADVANCE = 'advance';

export interface EventLoopOptions {
  /** Called after every committed transition — the seam the CLI/dashboard stream subscribes to. */
  onTransition?: (transition: Transition, run: Run) => void;
  /** Injectable clock (for the wall-clock budget and deterministic tests). */
  now?: () => number;
  /** Safety bound so a misconfigured run can never spin `runUntilIdle` forever. */
  maxIterations?: number;
}

export class EventLoop {
  constructor(
    private readonly repo: Repository,
    private readonly fsm: FsmConfig,
    private readonly version: string,
    private readonly runner: AgentRunner,
    private readonly options: EventLoopOptions = {},
  ) {}

  /** Create a run in the initial state and enqueue its first event. Returns the run. */
  startRun(input: { issueRef: string; repoRef: string }): Run {
    const run = this.repo.createRun({
      issueRef: input.issueRef,
      repoRef: input.repoRef,
      initialState: this.fsm.initial,
      fsmConfigVersion: this.version,
    });
    this.repo.enqueueEvent({ runId: run.id, type: EVENT_ADVANCE });
    return run;
  }

  /** Reclaim events stranded `processing` by a crash. Call once on startup, before ticking. */
  recover(): number {
    return this.repo.recoverProcessingEvents();
  }

  /** Process one event if any is dispatchable. Returns false when the queue is idle. */
  async tick(): Promise<boolean> {
    const event = this.repo.claimNextEvent();
    if (!event) return false;
    await this.processEvent(event);
    return true;
  }

  /** Drain the queue. Serial MVP: one stage at a time. */
  async runUntilIdle(): Promise<void> {
    const max = this.options.maxIterations ?? 1000;
    for (let i = 0; i < max; i++) {
      if (!(await this.tick())) return;
    }
    throw new Error('EventLoop.runUntilIdle exceeded maxIterations — possible runaway');
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
    // Escalate this run rather than letting one stage failure kill the whole drain loop.
    let outcome: StageOutcome;
    try {
      outcome = await this.runner.runStage(run);
    } catch (err) {
      this.escalate(run, event, 'executor_error', { error: String(err) });
      return;
    }
    if (outcome.kind === 'escalate') {
      this.escalate(run, event, 'internal_escalation', outcome.reason);
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
    const status: RunStatus = terminal
      ? decision.to === this.fsm.escalationState
        ? 'needs_human'
        : 'done'
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
      // Keep the run moving only while it stays running; terminal runs hold no executor.
      if (!terminal) this.repo.enqueueEvent({ runId: run.id, type: EVENT_ADVANCE });
      return t;
    });

    this.emit(transition, run.id);
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
