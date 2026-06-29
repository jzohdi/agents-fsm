/**
 * Event Loop integration tests (Milestone 2): drive whole runs on stub agents and assert
 * the orchestration mechanism — exact transition sequences, the skip branch, back-edge
 * guard escalation, crash recovery (idempotency), and the loop-owned guards.
 */

import { describe, expect, it } from 'vitest';

import { loadDefaultConfig } from '../fsm/config';
import type { FsmConfig } from '../fsm/types';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { AgentRunner } from '../agent/runner';
import { StubExecutor, goldenPathHandler, type StubHandler } from '../agent/executor';
import { EVENT_ADVANCE, EventLoop, type EventLoopOptions } from './event-loop';

function setup(handler: StubHandler, opts: EventLoopOptions = {}, fsmOverride?: (fsm: FsmConfig) => FsmConfig) {
  const loaded = loadDefaultConfig();
  const fsm = fsmOverride ? fsmOverride(loaded.fsm) : loaded.fsm;
  const repo = new Repository(openDb(':memory:'));
  const runner = new AgentRunner(repo, new StubExecutor(handler), loaded.agents);
  const loop = new EventLoop(repo, fsm, loaded.version, runner, opts);
  return { repo, loop, fsm };
}

function sequence(repo: Repository, runId: number): Array<[string, string, string]> {
  return repo.listTransitions(runId).map((t) => [t.fromState, t.trigger, t.toState]);
}

const GOLDEN_PATH: Array<[string, string, string]> = [
  ['triage', 'proceed', 'plan'],
  ['plan', 'proceed', 'plan_review'],
  ['plan_review', 'approve', 'interface_design'],
  ['interface_design', 'proceed', 'tdd'],
  ['tdd', 'proceed', 'frontend'],
  ['frontend', 'proceed', 'backend'],
  ['backend', 'proceed', 'code_review'],
  ['code_review', 'approve', 'done'],
];

describe('golden path (start → done on stubs)', () => {
  it('walks the exact canonical transition sequence and ends done', async () => {
    const transitions: string[] = [];
    const { repo, loop } = setup(goldenPathHandler, {
      onTransition: (t) => transitions.push(t.toState),
    });

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    const finalRun = repo.getRun(run.id)!;
    expect(finalRun.currentState).toBe('done');
    expect(finalRun.status).toBe('done');
    expect(sequence(repo, run.id)).toEqual(GOLDEN_PATH);

    // The onTransition stream saw every transition in order.
    expect(transitions).toEqual(GOLDEN_PATH.map(([, , to]) => to));

    // Each transition is keyed to a distinct, non-null event (idempotency foundation).
    const eventIds = repo.listTransitions(run.id).map((t) => t.eventId);
    expect(eventIds.every((id) => id !== null)).toBe(true);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  it('records the right phases per stage (producing stages self-review; review stages do not)', async () => {
    const { repo, loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    const phasesOf = (stage: string) =>
      repo
        .listAgentRuns(run.id)
        .filter((r) => r.stage === stage)
        .map((r) => r.phase);

    expect(phasesOf('plan')).toEqual(['produce', 'self_review']);
    expect(phasesOf('plan_review')).toEqual(['produce']);
    expect(phasesOf('code_review')).toEqual(['produce']);
  });

  it('records the artifacts an envelope declares', async () => {
    const { repo, loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    const kinds = repo.listArtifacts(run.id).map((a) => a.kind);
    // plan, interface, and the PR (from tdd) are all recorded from their envelopes.
    expect(kinds).toEqual(['plan', 'interface', 'pr']);
  });

  it('drives multiple runs to done in a single drain (serial multi-run)', async () => {
    const { repo, loop } = setup(goldenPathHandler);
    const a = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    const b = loop.startRun({ issueRef: 'o/r#2', repoRef: 'o/r' });

    await loop.runUntilIdle();

    // Both runs complete independently, each with its own clean golden-path log.
    expect(repo.getRun(a.id)!.currentState).toBe('done');
    expect(repo.getRun(b.id)!.currentState).toBe('done');
    expect(sequence(repo, a.id)).toEqual(GOLDEN_PATH);
    expect(sequence(repo, b.id)).toEqual(GOLDEN_PATH);
  });
});

describe('skip branch (flags persist across stages)', () => {
  it('skips frontend when plan declares needs_frontend = false', async () => {
    const handler: StubHandler = (req) => {
      if (req.stage === 'plan' && req.phase === 'produce') {
        return { output: { requestedTransition: 'proceed', flags: { needs_frontend: false, needs_backend: true } } };
      }
      return goldenPathHandler(req);
    };
    const { repo, loop } = setup(handler);

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    const seq = sequence(repo, run.id);
    expect(seq).toContainEqual(['tdd', 'proceed', 'backend']); // tdd jumped straight to backend
    expect(seq.some(([from]) => from === 'frontend')).toBe(false);
    expect(repo.listAgentRuns(run.id).some((r) => r.stage === 'frontend')).toBe(false);
    expect(repo.getRun(run.id)!.currentState).toBe('done');
    // The flag was persisted on the run, not just used transiently.
    expect(repo.getRun(run.id)!.flags).toMatchObject({ needs_frontend: false, needs_backend: true });
  });
});

describe('back-edge guard escalation', () => {
  it('escalates to needs_human after the code_review round limit', async () => {
    const handler: StubHandler = (req) =>
      req.stage === 'code_review'
        ? { output: { requestedTransition: 'request_changes', target: 'backend', reason: { note: 'fix the bug' } } }
        : goldenPathHandler(req);
    const { repo, loop, fsm } = setup(handler);

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    const finalRun = repo.getRun(run.id)!;
    expect(finalRun.currentState).toBe('needs_human');
    expect(finalRun.status).toBe('needs_human');

    const backEdges = repo
      .listTransitions(run.id)
      .filter((t) => t.backEdge && t.counterKey === 'code_review');
    expect(backEdges).toHaveLength(fsm.guards.code_review!);

    const last = repo.listTransitions(run.id).at(-1)!;
    expect(last.toState).toBe('needs_human');
  });
});

describe('crash recovery (idempotent processing)', () => {
  it('does not re-run a stage or duplicate its transition when recovering a post-commit crash', async () => {
    const produceCounts = new Map<string, number>();
    const handler: StubHandler = (req) => {
      if (req.phase === 'produce') produceCounts.set(req.stage, (produceCounts.get(req.stage) ?? 0) + 1);
      return goldenPathHandler(req);
    };
    const { repo, loop } = setup(handler);

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.tick(); // triage → plan
    await loop.tick(); // plan → plan_review

    // Simulate a crash on the plan_review event: claim and apply (commit happens), but
    // never finalize — exactly the post-commit / pre-markDone window.
    const event = repo.claimNextEvent()!;
    await loop.applyEvent(event);
    expect(produceCounts.get('plan_review')).toBe(1);
    expect(repo.getTransitionByEventId(event.id)).toBeDefined();

    // Restart: reclaim the stranded event and drain.
    expect(loop.recover()).toBe(1);
    await loop.runUntilIdle();

    // plan_review was NOT re-run (no duplicate charge), the run completed, and the
    // transition log is exactly the golden path (no duplicate transition).
    expect(produceCounts.get('plan_review')).toBe(1);
    expect(repo.getRun(run.id)!.currentState).toBe('done');
    expect(sequence(repo, run.id)).toEqual(GOLDEN_PATH);
  });
});

describe('loop-owned guards escalate', () => {
  it('escalates before dispatch when the run budget is exceeded', async () => {
    const { repo, loop } = setup(goldenPathHandler, {}, (fsm) => ({ ...fsm, budget: { maxTokens: 1 } }));

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    repo.addRunUsage(run.id, { tokens: 5 }); // already over budget
    await loop.runUntilIdle();

    const finalRun = repo.getRun(run.id)!;
    expect(finalRun.status).toBe('needs_human');
    expect(finalRun.currentState).toBe('needs_human');
    // No stage ran — the guard fired before dispatch.
    expect(repo.listAgentRuns(run.id)).toHaveLength(0);
    expect(repo.listTransitions(run.id).at(-1)!.trigger).toBe('budget_exceeded');
  });

  it('escalates when the agent requests an illegal transition (never coerced)', async () => {
    const handler: StubHandler = (req) =>
      req.stage === 'triage' && req.phase === 'produce'
        ? { output: { requestedTransition: 'teleport' } }
        : goldenPathHandler(req);
    const { repo, loop } = setup(handler);

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    const finalRun = repo.getRun(run.id)!;
    expect(finalRun.status).toBe('needs_human');
    expect(repo.listTransitions(run.id).at(-1)!.trigger).toBe('invalid_transition');
  });

  it('escalates when a back-edge is requested without a reason (reversion without progress)', async () => {
    const handler: StubHandler = (req) =>
      req.stage === 'code_review'
        ? { output: { requestedTransition: 'request_changes', target: 'backend' } } // no reason
        : goldenPathHandler(req);
    const { repo, loop } = setup(handler);

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    const finalRun = repo.getRun(run.id)!;
    expect(finalRun.status).toBe('needs_human');
    // It escalated on the first code_review rather than looping a reasonless back-edge.
    expect(repo.listTransitions(run.id).filter((t) => t.backEdge)).toHaveLength(0);
    expect(repo.listTransitions(run.id).at(-1)!.trigger).toBe('missing_reason');
  });

  it('does not dispatch a paused run, then resumes it when set back to running', async () => {
    const { repo, loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });

    // Pause before the first event is processed: the queue is non-empty but nothing dispatches.
    repo.setRunStatus(run.id, 'paused');
    expect(await loop.tick()).toBe(false);
    expect(repo.listAgentRuns(run.id)).toHaveLength(0);
    expect(repo.getRun(run.id)!.currentState).toBe('triage');

    // Resume: the run drains to completion.
    repo.setRunStatus(run.id, 'running');
    await loop.runUntilIdle();
    expect(repo.getRun(run.id)!.currentState).toBe('done');
  });

  it('escalates when the executor throws (retries exhausted) instead of crashing the loop', async () => {
    const handler: StubHandler = (req) => {
      if (req.stage === 'plan' && req.phase === 'produce') throw new Error('harness exploded');
      return goldenPathHandler(req);
    };
    const { repo, loop } = setup(handler);

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle(); // must not throw

    const finalRun = repo.getRun(run.id)!;
    expect(finalRun.status).toBe('needs_human');
    expect(finalRun.currentState).toBe('needs_human');
    const last = repo.listTransitions(run.id).at(-1)!;
    expect(last.fromState).toBe('plan');
    expect(last.trigger).toBe('executor_error');
  });

  it('escalates a run pinned to a different config version (fail safe, never mis-process)', async () => {
    const { repo, loop } = setup(goldenPathHandler);
    // A run started under a stale config version — simulates config edited + daemon restarted.
    const run = repo.createRun({
      issueRef: 'o/r#1',
      repoRef: 'o/r',
      initialState: 'triage',
      fsmConfigVersion: 'stale-version',
    });
    repo.enqueueEvent({ runId: run.id, type: EVENT_ADVANCE });
    await loop.runUntilIdle();

    const finalRun = repo.getRun(run.id)!;
    expect(finalRun.status).toBe('needs_human');
    expect(repo.listAgentRuns(run.id)).toHaveLength(0); // no stage ran
    expect(repo.listTransitions(run.id).at(-1)!.trigger).toBe('config_version_mismatch');
  });

  it('keeps draining when an onTransition subscriber throws (best-effort notification)', async () => {
    const { repo, loop } = setup(goldenPathHandler, {
      onTransition: () => {
        throw new Error('subscriber boom');
      },
    });

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await expect(loop.runUntilIdle()).resolves.toBeUndefined(); // a throwing subscriber must not wedge the loop

    expect(repo.getRun(run.id)!.currentState).toBe('done');
  });
});
