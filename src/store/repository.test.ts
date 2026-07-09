import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compareRuns } from '../loop/scheduler';
import { openDb, type Db } from './db';
import { Repository } from './repository';

let db: Db;
let repo: Repository;

beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repository(db);
});

function newRun() {
  return repo.createRun({ issueRef: 'owner/repo#1', repoRef: 'owner/repo', initialState: 'triage', fsmConfigVersion: 'v1' });
}

describe('runs', () => {
  it('creates and reads a run with sane defaults', () => {
    const run = newRun();
    expect(run).toMatchObject({
      issueRef: 'owner/repo#1',
      repoRef: 'owner/repo',
      currentState: 'triage',
      status: 'running',
      fsmConfigVersion: 'v1',
      prNumber: null,
      branch: null,
      tokensUsed: 0,
      agentRunsCount: 0,
      flags: {},
    });
    expect(repo.getRun(run.id)).toEqual(run);
  });

  it('merges skip flags (last write wins per key)', () => {
    const run = newRun();
    expect(repo.mergeRunFlags(run.id, { needs_frontend: false, needs_backend: true }).flags).toEqual({
      needs_frontend: false,
      needs_backend: true,
    });
    // A later merge updates only the named keys.
    repo.mergeRunFlags(run.id, { needs_frontend: true });
    expect(repo.getRun(run.id)!.flags).toEqual({ needs_frontend: true, needs_backend: true });
  });

  it('returns undefined for a missing run', () => {
    expect(repo.getRun(999)).toBeUndefined();
  });

  it('lists runs newest-first, optionally filtered by status', () => {
    const a = repo.createRun({ issueRef: 'o/r#1', repoRef: 'o/r', initialState: 'triage', fsmConfigVersion: 'v1' });
    const b = repo.createRun({ issueRef: 'o/r#2', repoRef: 'o/r', initialState: 'triage', fsmConfigVersion: 'v1' });
    repo.setRunStatus(b.id, 'needs_human');

    expect(repo.listRuns().map((r) => r.id)).toEqual([b.id, a.id]);
    expect(repo.listRuns({ status: 'running' }).map((r) => r.id)).toEqual([a.id]);
    expect(repo.listRuns({ status: 'needs_human' }).map((r) => r.id)).toEqual([b.id]);
  });

  it('updates state, status, PR, and usage', () => {
    const run = newRun();
    repo.setRunState(run.id, 'plan');
    repo.setRunStatus(run.id, 'needs_human');
    repo.setRunBranch(run.id, 'agent/issue-1');
    repo.setRunPr(run.id, 42);
    repo.addRunUsage(run.id, { tokens: 100, cost: 1.5, agentRuns: 2 });
    repo.addRunUsage(run.id, { tokens: 50 });

    const updated = repo.getRun(run.id)!;
    expect(updated).toMatchObject({
      currentState: 'plan',
      status: 'needs_human',
      prNumber: 42,
      branch: 'agent/issue-1',
      tokensUsed: 150,
      costUsed: 1.5,
      agentRunsCount: 2,
    });
  });

  it('sums cost_used across active runs and sets/clears the cost override (Milestone 8 B3)', () => {
    const a = repo.createRun({ issueRef: 'o/r#1', repoRef: 'o/r', initialState: 'triage', fsmConfigVersion: 'v1' });
    const b = repo.createRun({ issueRef: 'o/r#2', repoRef: 'o/r', initialState: 'triage', fsmConfigVersion: 'v1' });
    const c = repo.createRun({ issueRef: 'o/r#3', repoRef: 'o/r', initialState: 'triage', fsmConfigVersion: 'v1' });
    repo.addRunUsage(a.id, { cost: 2 });
    repo.addRunUsage(b.id, { cost: 3 });
    repo.addRunUsage(c.id, { cost: 5 });
    expect(repo.sumActiveCost()).toBe(10);

    // A terminal run's cost drops out of the active sum (finishing/stopping frees ceiling headroom).
    repo.setRunStatus(c.id, 'done');
    expect(repo.sumActiveCost()).toBe(5);
    repo.setRunStatus(b.id, 'stopped');
    expect(repo.sumActiveCost()).toBe(2);

    expect(repo.getRun(a.id)!.costOverride).toBeNull();
    repo.setCostOverride(a.id, 'next_step');
    expect(repo.getRun(a.id)!.costOverride).toBe('next_step');
    repo.setCostOverride(a.id, 'full');
    expect(repo.getRun(a.id)!.costOverride).toBe('full');
    repo.setCostOverride(a.id, null);
    expect(repo.getRun(a.id)!.costOverride).toBeNull();
  });

  it('sumActiveCost is 0 when there are no active runs', () => {
    expect(repo.sumActiveCost()).toBe(0);
  });

  it('sets and clears a run model override (defaults to null)', () => {
    const run = newRun();
    expect(repo.getRun(run.id)!.modelOverride).toBeNull();
    repo.setRunModelOverride(run.id, 'sonnet');
    expect(repo.getRun(run.id)!.modelOverride).toBe('sonnet');
    repo.setRunModelOverride(run.id, 'claude-opus-4-8');
    expect(repo.getRun(run.id)!.modelOverride).toBe('claude-opus-4-8');
    repo.setRunModelOverride(run.id, null); // clear → back to the daemon default
    expect(repo.getRun(run.id)!.modelOverride).toBeNull();
  });

  it('sets and clears a run per-run operator context, normalizing blank to null (agents-fsm#5)', () => {
    const run = newRun();
    // Absent by default (Layer 3 = per-run operator context; null = none).
    expect(repo.getRun(run.id)!.issueContext).toBeNull();

    repo.setRunIssueContext(run.id, 'backend agent: prefer thin controllers');
    expect(repo.getRun(run.id)!.issueContext).toBe('backend agent: prefer thin controllers');

    // A blank / whitespace-only write is stored as null so "cleared" and "blank" are one state (INV-CLEAR).
    repo.setRunIssueContext(run.id, '   \n  ');
    expect(repo.getRun(run.id)!.issueContext).toBeNull();

    repo.setRunIssueContext(run.id, 'again');
    expect(repo.getRun(run.id)!.issueContext).toBe('again');
    repo.setRunIssueContext(run.id, null); // explicit clear
    expect(repo.getRun(run.id)!.issueContext).toBeNull();
  });

  it('writes only the issue_context column, leaving the run’s other fields intact (agents-fsm#5)', () => {
    const run = newRun();
    repo.setRunModelOverride(run.id, 'sonnet');
    repo.setRunState(run.id, 'backend');

    repo.setRunIssueContext(run.id, 'per-issue guidance');
    const after = repo.getRun(run.id)!;
    expect(after.issueContext).toBe('per-issue guidance');
    expect(after.modelOverride).toBe('sonnet');
    expect(after.currentState).toBe('backend');
    expect(after.status).toBe('running');
  });

  it('defaults a run to the claude-code harness, and stamps an explicit one', () => {
    expect(newRun().harness).toBe('claude-code'); // omitted → the shipped default
    const chosen = repo.createRun({ issueRef: 'o/r#9', repoRef: 'o/r', initialState: 'triage', fsmConfigVersion: 'v1', harness: 'cursor' });
    expect(repo.getRun(chosen.id)!.harness).toBe('cursor'); // pinned per-run, round-trips through the store
  });

  it('changes a run harness, writing only that column and round-tripping through the store', () => {
    const run = newRun();
    expect(repo.getRun(run.id)!.harness).toBe('claude-code');

    // Give it some unrelated state, so we can prove setRunHarness touches only the harness column.
    repo.setRunModelOverride(run.id, 'sonnet');
    repo.setRunState(run.id, 'plan');

    repo.setRunHarness(run.id, 'cursor');
    const after = repo.getRun(run.id)!;
    expect(after.harness).toBe('cursor'); // survives a reload → the "persists across restart" criterion
    // Only the harness column moved — no incidental clobbering of the run's other fields.
    expect(after.modelOverride).toBe('sonnet');
    expect(after.currentState).toBe('plan');
    expect(after.status).toBe('running');

    // A subsequent change replaces the value in place (not a second row / stale read).
    repo.setRunHarness(run.id, 'claude-code');
    expect(repo.getRun(run.id)!.harness).toBe('claude-code');
  });

  it('round-trips a setting and upserts on a repeated key', () => {
    expect(repo.getSetting('default_harness')).toBeUndefined(); // never set → undefined
    repo.setSetting('default_harness', 'cursor');
    expect(repo.getSetting('default_harness')).toBe('cursor');
    repo.setSetting('default_harness', 'claude-code'); // upsert, not a second row
    expect(repo.getSetting('default_harness')).toBe('claude-code');
  });

  it('persists the branch (at plan) independently of the PR number (at tdd)', () => {
    const run = newRun();
    // Branch is created when `plan` begins, before any PR exists.
    repo.setRunBranch(run.id, 'agent/issue-1');
    expect(repo.getRun(run.id)).toMatchObject({ branch: 'agent/issue-1', prNumber: null });

    // The PR number arrives later at `tdd`, without disturbing the branch.
    repo.setRunPr(run.id, 42);
    expect(repo.getRun(run.id)).toMatchObject({ branch: 'agent/issue-1', prNumber: 42 });
  });
});

describe('transitions + computeCounters (round counters derived from the log)', () => {
  it('records transitions in order with parsed JSON reason', () => {
    const run = newRun();
    repo.appendTransition({ runId: run.id, fromState: 'triage', toState: 'plan', trigger: 'proceed' });
    repo.appendTransition({
      runId: run.id,
      fromState: 'plan_review',
      toState: 'plan',
      trigger: 'request_changes',
      reason: { note: 'tighten scope' },
      backEdge: true,
      counterKey: 'plan_review',
    });

    const ts = repo.listTransitions(run.id);
    expect(ts).toHaveLength(2);
    expect(ts[0]!.trigger).toBe('proceed');
    expect(ts[1]!.reason).toEqual({ note: 'tighten scope' });
    expect(ts[1]!.backEdge).toBe(true);
  });

  it('counts guarded back-edges per counter key', () => {
    const run = newRun();
    const backEdge = (counterKey: string) =>
      repo.appendTransition({ runId: run.id, fromState: 'x', toState: 'y', trigger: 't', backEdge: true, counterKey });
    backEdge('plan_review');
    backEdge('plan_review');
    backEdge('code_review');
    // a non-back-edge with a counter key must not count
    repo.appendTransition({ runId: run.id, fromState: 'x', toState: 'y', trigger: 't', counterKey: 'plan_review' });

    expect(repo.computeCounters(run.id)).toEqual({ plan_review: 2, code_review: 1 });
  });

  it('resets a single counter on a keyed reset marker', () => {
    const run = newRun();
    const be = (counterKey: string) =>
      repo.appendTransition({ runId: run.id, fromState: 'x', toState: 'y', trigger: 't', backEdge: true, counterKey });
    be('plan_review');
    be('code_review');
    repo.appendTransition({ runId: run.id, fromState: 'needs_human', toState: 'plan_review', trigger: 'resume', isReset: true, counterKey: 'plan_review' });
    be('plan_review');

    expect(repo.computeCounters(run.id)).toEqual({ plan_review: 1, code_review: 1 });
  });

  it('resets all counters on an unkeyed reset marker', () => {
    const run = newRun();
    const be = (counterKey: string) =>
      repo.appendTransition({ runId: run.id, fromState: 'x', toState: 'y', trigger: 't', backEdge: true, counterKey });
    be('plan_review');
    be('code_review');
    repo.appendTransition({ runId: run.id, fromState: 'needs_human', toState: 'plan', trigger: 'resume', isReset: true });

    expect(repo.computeCounters(run.id)).toEqual({ plan_review: 0, code_review: 0 });
  });
});

describe('commitTransition + transaction (atomic state changes)', () => {
  it('records the transition and advances run state together', () => {
    const run = newRun();
    repo.commitTransition({
      runId: run.id,
      fromState: 'plan_review',
      toState: 'needs_human',
      trigger: 'request_changes',
      status: 'needs_human',
    });

    expect(repo.getRun(run.id)).toMatchObject({ currentState: 'needs_human', status: 'needs_human' });
    expect(repo.listTransitions(run.id)).toHaveLength(1);
  });

  it('rolls back every write when the transaction throws', () => {
    const run = newRun();
    expect(() =>
      repo.transaction(() => {
        repo.appendTransition({ runId: run.id, fromState: 'triage', toState: 'plan', trigger: 'proceed' });
        repo.setRunState(run.id, 'plan');
        throw new Error('boom');
      }),
    ).toThrow('boom');

    // Nothing persisted: the partial work was rolled back.
    expect(repo.listTransitions(run.id)).toHaveLength(0);
    expect(repo.getRun(run.id)!.currentState).toBe('triage');
  });
});

describe('events (at-least-once queue)', () => {
  it('claims the oldest pending event atomically and marks it done', () => {
    const run = newRun();
    repo.enqueueEvent({ runId: run.id, type: 'stage_done', payload: { stage: 'triage' } });
    repo.enqueueEvent({ runId: run.id, type: 'stage_done', payload: { stage: 'plan' } });

    const first = repo.claimNextEvent()!;
    expect(first.payload).toEqual({ stage: 'triage' });
    expect(first.status).toBe('processing');

    // Within-run serialization: the run already has a stage in flight, so its next
    // (older) event is held back until the first finalizes — never two at once.
    expect(repo.claimNextEvent()).toBeUndefined();

    repo.markEventDone(first.id);
    const second = repo.claimNextEvent()!;
    expect(second.payload).toEqual({ stage: 'plan' });

    repo.markEventDone(second.id);
    expect(repo.claimNextEvent()).toBeUndefined();
  });

  it('serializes within a run but stays parallel across runs (Milestone 8 Phase B)', () => {
    const a = newRun();
    const b = newRun();
    repo.enqueueEvent({ runId: a.id, type: 'stage_done' });
    repo.enqueueEvent({ runId: a.id, type: 'stage_done' });
    repo.enqueueEvent({ runId: b.id, type: 'stage_done' });

    // Worker 1 claims run A's first event → A now has a stage in flight.
    const first = repo.claimNextEvent()!;
    expect(first.runId).toBe(a.id);

    // Worker 2 claims next: A is skipped (in flight); run B's event is served instead.
    const second = repo.claimNextEvent()!;
    expect(second.runId).toBe(b.id);

    // Both runs are now busy → nothing else claimable, even though A has a pending event.
    expect(repo.claimNextEvent()).toBeUndefined();

    // A finishes → its second event becomes claimable again (serial within the run).
    repo.markEventDone(first.id);
    expect(repo.claimNextEvent()!.runId).toBe(a.id);
  });

  it('with onlyOverrides, claims only a run carrying a cost override (the M8 B3 ceiling gate)', () => {
    const plain = newRun();
    const overridden = newRun();
    repo.enqueueEvent({ runId: plain.id, type: 'stage_done' });
    repo.enqueueEvent({ runId: overridden.id, type: 'stage_done' });

    // Over the ceiling: a run with no override is parked; only the overridden run is dispatchable.
    expect(repo.claimNextEvent({ onlyOverrides: true })).toBeUndefined();
    repo.setCostOverride(overridden.id, 'full');
    expect(repo.claimNextEvent({ onlyOverrides: true })!.runId).toBe(overridden.id);

    // Under the ceiling (default): the parked run is claimable again.
    expect(repo.claimNextEvent()!.runId).toBe(plain.id);
  });

  it('only claims events whose run is dispatchable (status = running)', () => {
    const running = newRun();
    const paused = newRun();
    repo.setRunStatus(paused.id, 'paused');

    // The paused run's event is enqueued first, but must not be claimed while paused.
    repo.enqueueEvent({ runId: paused.id, type: 'stage_done' });
    repo.enqueueEvent({ runId: running.id, type: 'stage_done' });

    const claimed = repo.claimNextEvent()!;
    expect(claimed.runId).toBe(running.id);

    // Nothing else dispatchable while the other run stays paused.
    expect(repo.claimNextEvent()).toBeUndefined();

    // Resuming the run makes its (older) event claimable.
    repo.setRunStatus(paused.id, 'running');
    expect(repo.claimNextEvent()!.runId).toBe(paused.id);
  });

  it('discards a run\'s pending events (operator revert) without touching in-flight or done ones', () => {
    const run = newRun();
    repo.enqueueEvent({ runId: run.id, type: 'stage_done' });
    repo.enqueueEvent({ runId: run.id, type: 'stage_done' });
    const inFlight = repo.claimNextEvent()!; // one is now `processing`

    // Cancels only the still-`pending` event; the `processing` one is left to finish.
    expect(repo.discardPendingEvents(run.id)).toBe(1);
    repo.markEventDone(inFlight.id);
    expect(repo.claimNextEvent()).toBeUndefined(); // nothing left to claim

    expect(repo.discardPendingEvents(run.id)).toBe(0); // idempotent: nothing pending now
  });

  it('reports whether a run has a stage in flight (a `processing` event)', () => {
    const run = newRun();
    expect(repo.hasProcessingEvent(run.id)).toBe(false);
    repo.enqueueEvent({ runId: run.id, type: 'stage_done' });
    expect(repo.hasProcessingEvent(run.id)).toBe(false); // pending, not in flight
    const claimed = repo.claimNextEvent()!;
    expect(repo.hasProcessingEvent(run.id)).toBe(true); // now processing
    repo.markEventDone(claimed.id);
    expect(repo.hasProcessingEvent(run.id)).toBe(false);
  });

  it('reclaims stranded `processing` events on recovery so they are re-claimable', () => {
    // Two runs so two events can be in flight at once (within a run, stages are serial).
    const a = newRun();
    const b = newRun();
    repo.enqueueEvent({ runId: a.id, type: 'stage_done' });
    repo.enqueueEvent({ runId: b.id, type: 'stage_done' });

    // Simulate a crash mid-flight under the pool: both events claimed (now `processing`), one done.
    const claimedA = repo.claimNextEvent()!;
    repo.claimNextEvent();
    repo.markEventDone(claimedA.id);

    // The one left in `processing` is invisible to claimNextEvent until reclaimed.
    expect(repo.claimNextEvent()).toBeUndefined();
    expect(repo.recoverProcessingEvents()).toBe(1);

    // After recovery it is pending again and can be claimed; the `done` one stays done.
    expect(repo.claimNextEvent()).toBeDefined();
    expect(repo.claimNextEvent()).toBeUndefined();
  });
});

describe('event-keyed idempotent transitions (at-least-once delivery)', () => {
  it('finds the transition recorded for an event', () => {
    const run = newRun();
    const event = repo.enqueueEvent({ runId: run.id, type: 'stage_done' });
    expect(repo.getTransitionByEventId(event.id)).toBeUndefined();

    repo.commitTransition({ runId: run.id, fromState: 'triage', toState: 'plan', trigger: 'proceed', eventId: event.id });

    const found = repo.getTransitionByEventId(event.id)!;
    expect(found).toMatchObject({ toState: 'plan', eventId: event.id });
  });

  it('rejects a second transition for the same event (UNIQUE event_id)', () => {
    const run = newRun();
    const event = repo.enqueueEvent({ runId: run.id, type: 'stage_done' });
    repo.commitTransition({ runId: run.id, fromState: 'triage', toState: 'plan', trigger: 'proceed', eventId: event.id });

    expect(() =>
      repo.appendTransition({ runId: run.id, fromState: 'triage', toState: 'plan', trigger: 'proceed', eventId: event.id }),
    ).toThrow(/UNIQUE/);
  });

  it('allows many transitions with no event id (manual transitions / resets)', () => {
    const run = newRun();
    repo.appendTransition({ runId: run.id, fromState: 'a', toState: 'b', trigger: 'proceed' });
    repo.appendTransition({ runId: run.id, fromState: 'b', toState: 'c', trigger: 'proceed' });
    expect(repo.listTransitions(run.id)).toHaveLength(2);
    expect(repo.listTransitions(run.id).every((t) => t.eventId === null)).toBe(true);
  });
});

describe('agent_runs + artifacts', () => {
  it('records agent runs (one per phase) and artifacts', () => {
    const run = newRun();
    repo.recordAgentRun({ runId: run.id, stage: 'plan', phase: 'produce', model: 'frontier', tokens: 1200 });
    repo.recordAgentRun({ runId: run.id, stage: 'plan', phase: 'self_review', model: 'frontier', tokens: 800 });
    repo.recordAgentRun({ runId: run.id, stage: 'plan', phase: 'simplify', model: 'cheap', tokens: 300 });

    const count = (db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE run_id = ?').get(run.id) as { n: number }).n;
    expect(count).toBe(3);

    repo.recordArtifact({ runId: run.id, kind: 'plan', locator: { branch: 'agent/issue-1', path: '.agent/plan.md', sha: 'abc' } });
    const artifacts = repo.listArtifacts(run.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.locator).toEqual({ branch: 'agent/issue-1', path: '.agent/plan.md', sha: 'abc' });
  });
});

describe('logs (the live activity stream)', () => {
  it('appends structured log lines and lists them oldest-first', () => {
    const run = newRun();
    repo.recordLog({ runId: run.id, message: 'tool: Read README.md', data: { stage: 'triage', phase: 'produce', kind: 'tool_use' } });
    repo.recordLog({ runId: run.id, level: 'warn', message: 'assistant: hmm' });

    const logs = repo.listLogs(run.id);
    expect(logs.map((l) => l.message)).toEqual(['tool: Read README.md', 'assistant: hmm']);
    expect(logs[0]).toMatchObject({ level: 'info', data: { stage: 'triage', phase: 'produce', kind: 'tool_use' } });
    expect(logs[1]).toMatchObject({ level: 'warn', data: null });
  });

  it('scopes listing to the run', () => {
    const a = newRun();
    const b = newRun();
    repo.recordLog({ runId: a.id, message: 'for a' });
    repo.recordLog({ runId: b.id, message: 'for b' });
    expect(repo.listLogs(a.id).map((l) => l.message)).toEqual(['for a']);
  });
});

describe('stateVisitCount (the side-effect ledger visit index)', () => {
  it('counts transitions into a state and ignores other runs/states', () => {
    const run = newRun();
    const other = newRun();
    expect(repo.stateVisitCount(run.id, 'code_review')).toBe(0);

    repo.appendTransition({ runId: run.id, fromState: 'backend', toState: 'code_review', trigger: 'proceed' });
    expect(repo.stateVisitCount(run.id, 'code_review')).toBe(1);

    // A back-edge out then a fresh entry — a legitimate second review round bumps the visit index.
    repo.appendTransition({ runId: run.id, fromState: 'code_review', toState: 'backend', trigger: 'request_changes', backEdge: true });
    repo.appendTransition({ runId: run.id, fromState: 'backend', toState: 'code_review', trigger: 'proceed' });
    expect(repo.stateVisitCount(run.id, 'code_review')).toBe(2);

    // Scoped to the run + state.
    repo.appendTransition({ runId: other.id, fromState: 'backend', toState: 'code_review', trigger: 'proceed' });
    expect(repo.stateVisitCount(run.id, 'code_review')).toBe(2);
    expect(repo.stateVisitCount(run.id, 'backend')).toBe(1);
  });
});

describe('side-effect ledger (the transactional outbox, README Milestone 7)', () => {
  it('claims fresh, then reports pending until completed, then reuses the stored result', () => {
    const run = newRun();
    const key = 'triage#0:signoff';

    // First claim wins → fresh; the caller now performs the external call.
    expect(repo.beginSideEffect(run.id, key)).toEqual({ state: 'fresh' });

    // A replay before completion sees the in-flight claim → pending (ambiguous; caller escalates).
    expect(repo.beginSideEffect(run.id, key)).toEqual({ state: 'pending' });

    // After completion, replays reuse the stored result and never re-perform the call.
    repo.completeSideEffect(run.id, key, { id: 42, author: 'agent-bot' });
    expect(repo.beginSideEffect(run.id, key)).toEqual({ state: 'done', result: { id: 42, author: 'agent-bot' } });
  });

  it('scopes slots per run and per key', () => {
    const a = newRun();
    const b = newRun();
    repo.beginSideEffect(a.id, 'k');
    // Same key, different run, and same run, different key are both independent claims.
    expect(repo.beginSideEffect(b.id, 'k')).toEqual({ state: 'fresh' });
    expect(repo.beginSideEffect(a.id, 'other')).toEqual({ state: 'fresh' });
  });

  it('round-trips a null/undefined result as a done claim', () => {
    const run = newRun();
    repo.beginSideEffect(run.id, 'k');
    repo.completeSideEffect(run.id, 'k', undefined); // fire-and-forget calls (e.g. a signoff comment)
    expect(repo.beginSideEffect(run.id, 'k')).toEqual({ state: 'done', result: null });
  });
});

describe('foreign keys', () => {
  it('rejects a transition referencing a non-existent run', () => {
    expect(() =>
      repo.appendTransition({ runId: 9999, fromState: 'a', toState: 'b', trigger: 'proceed' }),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('on-disk persistence (restart correctness, README Milestone 7)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-fleet-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives a close and reopen', () => {
    const path = join(dir, 'state.db');

    const first = openDb(path);
    const repo1 = new Repository(first);
    const run = repo1.createRun({ issueRef: 'o/r#1', repoRef: 'o/r', initialState: 'triage', fsmConfigVersion: 'v1' });
    repo1.commitTransition({ runId: run.id, fromState: 'triage', toState: 'plan', trigger: 'proceed' });
    first.close();

    const second = openDb(path);
    const repo2 = new Repository(second);
    expect(repo2.getRun(run.id)).toMatchObject({ currentState: 'plan' });
    expect(repo2.listTransitions(run.id)).toHaveLength(1);
    second.close();
  });
});

describe('repos registry (Milestone 8 Phase A)', () => {
  it('enrolls a repo and reads it back with sane defaults', () => {
    const enrolled = repo.upsertRepo({ repoRef: 'owner/repo', workingRoot: './work/owner-repo' });
    expect(enrolled).toMatchObject({
      repoRef: 'owner/repo',
      workingRoot: './work/owner-repo',
      baseBranch: 'main', // defaulted
      cloneUrl: null,
      localRepo: null,
      watch: false, // continuous mode is opt-in (Milestone 11)
      watchLabel: null,
      sourceMode: null, // no working directory until one is chosen (Milestone 12)
    });
    expect(repo.getRepo('owner/repo')).toEqual(enrolled);
  });

  it('binds a working-directory source independently of the adapter config, surviving a re-enroll (Milestone 12)', () => {
    repo.upsertRepo({ repoRef: 'o/r', workingRoot: './a' });
    expect(repo.getRepo('o/r')?.sourceMode).toBeNull(); // unconfigured

    // Clone-on-run: no local path.
    repo.setRepoSource('o/r', 'clone', null);
    expect(repo.getRepo('o/r')).toMatchObject({ sourceMode: 'clone', localRepo: null });

    // Local mode: stores the path…
    repo.setRepoSource('o/r', 'local', '/home/me/o-r');
    expect(repo.getRepo('o/r')).toMatchObject({ sourceMode: 'local', localRepo: '/home/me/o-r' });

    // …and a re-enroll (upsert never touches the source columns) keeps it.
    repo.upsertRepo({ repoRef: 'o/r', workingRoot: './b', baseBranch: 'develop' });
    expect(repo.getRepo('o/r')).toMatchObject({ workingRoot: './b', sourceMode: 'local', localRepo: '/home/me/o-r' });

    // Switching back to clone clears the stored path; `null` returns it to unconfigured.
    repo.setRepoSource('o/r', 'clone', null);
    expect(repo.getRepo('o/r')?.localRepo).toBeNull();
    repo.setRepoSource('o/r', null, null);
    expect(repo.getRepo('o/r')?.sourceMode).toBeNull();
  });

  it('toggles watch independently of the adapter config (Milestone 11)', () => {
    repo.upsertRepo({ repoRef: 'o/r', workingRoot: './a' });

    repo.setRepoWatch('o/r', true);
    expect(repo.getRepo('o/r')).toMatchObject({ watch: true, watchLabel: null });

    // A custom override label…
    repo.setRepoWatch('o/r', true, 'fleet: go');
    expect(repo.getRepo('o/r')).toMatchObject({ watch: true, watchLabel: 'fleet: go' });

    // …survives a re-enroll (upsert never touches the watch columns)…
    repo.upsertRepo({ repoRef: 'o/r', workingRoot: './b', baseBranch: 'develop' });
    expect(repo.getRepo('o/r')).toMatchObject({ workingRoot: './b', watch: true, watchLabel: 'fleet: go' });

    // …and `null` resets the label to the default; omitting the label leaves it as-is.
    repo.setRepoWatch('o/r', true, null);
    expect(repo.getRepo('o/r')?.watchLabel).toBeNull();
    repo.setRepoWatch('o/r', false);
    expect(repo.getRepo('o/r')).toMatchObject({ watch: false, watchLabel: null });
  });

  it('setRepoWatch matches the ref case-insensitively', () => {
    repo.upsertRepo({ repoRef: 'Acme/Web', workingRoot: './a' });
    repo.setRepoWatch('acme/web', true);
    expect(repo.getRepo('Acme/Web')?.watch).toBe(true);
  });

  it('enrolls a repo with no scope filter set by default (issue #11)', () => {
    const enrolled = repo.upsertRepo({ repoRef: 'o/r', workingRoot: './a' });
    expect(enrolled).toMatchObject({ watchFilterLabel: null, watchFilterMilestone: null });
  });

  it('round-trips the watch scope filter columns, independently settable/clearable (issue #11)', () => {
    repo.upsertRepo({ repoRef: 'o/r', workingRoot: './a' });

    // Set both filter fields alongside the watch flag.
    repo.setRepoWatch('o/r', true, undefined, { filterLabel: 'bug', filterMilestone: 'v2' });
    expect(repo.getRepo('o/r')).toMatchObject({
      watch: true,
      watchFilterLabel: 'bug',
      watchFilterMilestone: 'v2',
    });

    // An omitted filter key leaves that column as-is (a plain toggle never clobbers the scope filter)…
    repo.setRepoWatch('o/r', false);
    expect(repo.getRepo('o/r')).toMatchObject({
      watch: false,
      watchFilterLabel: 'bug',
      watchFilterMilestone: 'v2',
    });

    // …a `null` clears just that column, leaving the other set…
    repo.setRepoWatch('o/r', true, undefined, { filterLabel: null });
    expect(repo.getRepo('o/r')).toMatchObject({ watchFilterLabel: null, watchFilterMilestone: 'v2' });

    // …and the scope filter is distinct from the guard-bypass override label.
    repo.setRepoWatch('o/r', true, 'fleet: go', { filterMilestone: null });
    expect(repo.getRepo('o/r')).toMatchObject({
      watchLabel: 'fleet: go',
      watchFilterLabel: null,
      watchFilterMilestone: null,
    });
  });

  it('the scope filter survives a re-enroll (upsert never touches the watch columns) (issue #11)', () => {
    repo.upsertRepo({ repoRef: 'o/r', workingRoot: './a' });
    repo.setRepoWatch('o/r', true, undefined, { filterLabel: 'bug', filterMilestone: 'v2' });

    repo.upsertRepo({ repoRef: 'o/r', workingRoot: './b', baseBranch: 'develop' });
    expect(repo.getRepo('o/r')).toMatchObject({
      workingRoot: './b',
      watchFilterLabel: 'bug',
      watchFilterMilestone: 'v2',
    });
  });

  it('upsert is idempotent on repo_ref and re-points the adapter config', () => {
    repo.upsertRepo({ repoRef: 'o/r', workingRoot: './a', baseBranch: 'main' });
    const updated = repo.upsertRepo({ repoRef: 'o/r', workingRoot: './b', baseBranch: 'develop', cloneUrl: 'git@host:o/r.git' });

    expect(updated).toMatchObject({ workingRoot: './b', baseBranch: 'develop', cloneUrl: 'git@host:o/r.git' });
    expect(repo.listRepos()).toHaveLength(1); // still one row, not a duplicate
  });

  it('upsert dedups across casing (case-insensitive uniqueness, not two rows)', () => {
    // `--repo Acme/Web` and an issue URL's `acme/web` are the same repo; the registry must not split
    // them — else the case-insensitive `getRepo` would match a row ambiguously (repo_ref is COLLATE NOCASE).
    repo.upsertRepo({ repoRef: 'Acme/Web', workingRoot: './a' });
    repo.upsertRepo({ repoRef: 'acme/web', workingRoot: './b' });

    expect(repo.listRepos()).toHaveLength(1);
    expect(repo.getRepo('ACME/WEB')?.workingRoot).toBe('./b'); // the second upsert updated the one row
  });

  it('looks up case-insensitively and returns undefined when unenrolled', () => {
    repo.upsertRepo({ repoRef: 'Owner/Repo', workingRoot: './w' });
    expect(repo.getRepo('owner/repo')?.repoRef).toBe('Owner/Repo');
    expect(repo.getRepo('other/repo')).toBeUndefined();
  });

  it('lists repos in enrollment order (oldest first)', () => {
    repo.upsertRepo({ repoRef: 'a/one', workingRoot: './1' });
    repo.upsertRepo({ repoRef: 'b/two', workingRoot: './2' });
    expect(repo.listRepos().map((r) => r.repoRef)).toEqual(['a/one', 'b/two']);
  });

  it('filters runs by repo (case-insensitive), alone and combined with status', () => {
    const a1 = repo.createRun({ issueRef: 'a/one#1', repoRef: 'a/one', initialState: 'triage', fsmConfigVersion: 'v1' });
    const b1 = repo.createRun({ issueRef: 'b/two#1', repoRef: 'b/two', initialState: 'triage', fsmConfigVersion: 'v1' });
    repo.setRunStatus(b1.id, 'needs_human');

    expect(repo.listRuns({ repo: 'A/ONE' }).map((r) => r.id)).toEqual([a1.id]);
    expect(repo.listRuns({ repo: 'b/two', status: 'needs_human' }).map((r) => r.id)).toEqual([b1.id]);
    expect(repo.listRuns({ repo: 'b/two', status: 'running' })).toHaveLength(0);
  });
});

describe('scheduling cache + dependency gate (Milestone 9)', () => {
  function runOn(issue: number) {
    return repo.createRun({ issueRef: `owner/repo#${issue}`, repoRef: 'owner/repo', initialState: 'triage', fsmConfigVersion: 'v1' });
  }

  it('defaults to no dependencies, default priority, no latch', () => {
    const run = newRun();
    expect(run).toMatchObject({ dependsOn: [], priority: 0, orderKey: '', depsSatisfiedAt: null });
  });

  it('caches a declaration, canonicalizing depends_on (sorted, de-duplicated)', () => {
    const run = newRun();
    repo.setRunScheduling(run.id, { dependsOn: [57, 42, 57], priority: 10.9, orderKey: 'k' });
    expect(repo.getRun(run.id)).toMatchObject({ dependsOn: [42, 57], priority: 10, orderKey: 'k' });
  });

  it('stamps the satisfaction latch, and keeps it across a declaration whose deps are unchanged', () => {
    const run = newRun();
    repo.setRunScheduling(run.id, { dependsOn: [42], priority: 0, orderKey: '' });
    repo.stampDepsSatisfied(run.id);
    expect(repo.getRun(run.id)!.depsSatisfiedAt).not.toBeNull();

    // Same deps (even unsorted), different priority: the latch survives — satisfaction didn't change.
    repo.setRunScheduling(run.id, { dependsOn: [42], priority: 5, orderKey: 'z' });
    expect(repo.getRun(run.id)!.depsSatisfiedAt).not.toBeNull();
  });

  it('clears the latch when the dependency set changes (a human added a dep — re-verify)', () => {
    const run = newRun();
    repo.setRunScheduling(run.id, { dependsOn: [42], priority: 0, orderKey: '' });
    repo.stampDepsSatisfied(run.id);

    repo.setRunScheduling(run.id, { dependsOn: [42, 57], priority: 0, orderKey: '' });
    expect(repo.getRun(run.id)!.depsSatisfiedAt).toBeNull();
  });

  it('never claims a run with unsatisfied cached deps; the stamped latch (or an emptied set) admits it', () => {
    const gated = newRun();
    repo.setRunScheduling(gated.id, { dependsOn: [42], priority: 0, orderKey: '' });
    repo.enqueueEvent({ runId: gated.id, type: 'stage_done' });

    // Status is `running`, but the dependency gate holds the claim back (correctness lives in SQL,
    // not in the visible `blocked` flip — M9 plan §2).
    expect(repo.claimNextEvent()).toBeUndefined();

    repo.stampDepsSatisfied(gated.id);
    const claimed = repo.claimNextEvent()!;
    expect(claimed.runId).toBe(gated.id);
    repo.markEventDone(claimed.id);

    // Declaration emptied: dispatchable with no latch at all.
    repo.setRunScheduling(gated.id, { dependsOn: [], priority: 0, orderKey: '' });
    repo.enqueueEvent({ runId: gated.id, type: 'stage_done' });
    expect(repo.claimNextEvent()!.runId).toBe(gated.id);
  });

  it('claims in the Scheduler total order: priority desc, order_key asc, issue number asc, event id', () => {
    // Enqueued in deliberately scrambled order; every run dispatchable (no deps).
    const low = runOn(1); // priority 0
    const highLateKey = runOn(2); // priority 5, order_key "b"
    const highEarlyKey = runOn(3); // priority 5, order_key "a"
    const highTieYoungIssue = runOn(4); // priority 5, order_key "a" — loses to issue 3 on issue number
    repo.setRunScheduling(highLateKey.id, { dependsOn: [], priority: 5, orderKey: 'b' });
    repo.setRunScheduling(highEarlyKey.id, { dependsOn: [], priority: 5, orderKey: 'a' });
    repo.setRunScheduling(highTieYoungIssue.id, { dependsOn: [], priority: 5, orderKey: 'a' });
    for (const r of [low, highTieYoungIssue, highLateKey, highEarlyKey]) {
      repo.enqueueEvent({ runId: r.id, type: 'stage_done' });
    }

    const order: number[] = [];
    for (;;) {
      const event = repo.claimNextEvent();
      if (!event) break;
      order.push(event.runId);
      repo.markEventDone(event.id);
    }
    expect(order).toEqual([highEarlyKey.id, highTieYoungIssue.id, highLateKey.id, low.id]);
  });

  it('agrees with compareRuns on every pick — the SQL-vs-comparator drift guard', () => {
    // A key set exercising every tier of the order: distinct priorities, tied priorities with
    // distinct keys, and full ties broken by issue number. The claim's ORDER BY and the pure
    // comparator are two encodings of one order; this test fails if either changes alone.
    const keys = [
      { issueNumber: 11, priority: 0, orderKey: '' },
      { issueNumber: 12, priority: 3, orderKey: 'beta' },
      { issueNumber: 13, priority: 3, orderKey: 'alpha' },
      { issueNumber: 14, priority: 3, orderKey: 'alpha' },
      { issueNumber: 15, priority: -1, orderKey: 'zzz' },
      { issueNumber: 16, priority: 0, orderKey: 'a' },
    ];
    const byIssue = new Map<number, number>(); // issue → run id
    for (const k of [...keys].reverse()) {
      const run = runOn(k.issueNumber);
      repo.setRunScheduling(run.id, { dependsOn: [], priority: k.priority, orderKey: k.orderKey });
      repo.enqueueEvent({ runId: run.id, type: 'stage_done' });
      byIssue.set(k.issueNumber, run.id);
    }

    const claimedOrder: number[] = [];
    for (;;) {
      const event = repo.claimNextEvent();
      if (!event) break;
      claimedOrder.push(event.runId);
      repo.markEventDone(event.id);
    }
    const comparatorOrder = [...keys].sort(compareRuns).map((k) => byIssue.get(k.issueNumber)!);
    expect(claimedOrder).toEqual(comparatorOrder);
  });

  it('setRunIssueRef (split handoff) resets the cached scheduling and latch', () => {
    const run = newRun();
    repo.setRunScheduling(run.id, { dependsOn: [42], priority: 9, orderKey: 'k' });
    repo.stampDepsSatisfied(run.id);

    repo.setRunIssueRef(run.id, 'owner/repo#77');

    expect(repo.getRun(run.id)).toMatchObject({
      issueRef: 'owner/repo#77',
      dependsOn: [],
      priority: 0,
      orderKey: '',
      depsSatisfiedAt: null,
    });
  });

  it('findActiveRunByIssue: newest active run, case-insensitive; terminal/archived excluded', () => {
    const first = newRun();
    repo.setRunStatus(first.id, 'done'); // terminal → not active
    const second = newRun();
    repo.setRunStatus(second.id, 'needs_human'); // non-terminal → still active

    expect(repo.findActiveRunByIssue('OWNER/REPO#1')?.id).toBe(second.id);

    repo.setRunStatus(second.id, 'stopped');
    expect(repo.findActiveRunByIssue('owner/repo#1')).toBeUndefined();

    const third = newRun();
    repo.setRunArchived(third.id, true); // archived → filed away, not active
    expect(repo.findActiveRunByIssue('owner/repo#1')).toBeUndefined();
  });
});

describe('run chat (the per-run operator ↔ agent side channel)', () => {
  it('creates a queued exchange and lists a run thread oldest-first', () => {
    const run = newRun();
    const a = repo.createChatExchange({ runId: run.id, prompt: 'what does the PR change?', mode: 'read' });
    const b = repo.createChatExchange({ runId: run.id, prompt: 'fix the failing build', mode: 'write' });

    expect(a).toMatchObject({ runId: run.id, prompt: 'what does the PR change?', mode: 'read', status: 'queued', response: null, error: null, commitSha: null, tokens: 0 });
    expect(repo.listChatExchanges(run.id).map((c) => c.id)).toEqual([a.id, b.id]);
    expect(repo.getChatExchange(999)).toBeUndefined();
  });

  it('claims a read exchange even while a stage event is processing', () => {
    const run = newRun();
    repo.enqueueEvent({ runId: run.id, type: 'advance' });
    expect(repo.claimNextEvent()).toBeDefined(); // a stage is now in flight
    const chat = repo.createChatExchange({ runId: run.id, prompt: 'q', mode: 'read' });

    const claimed = repo.claimNextChatExchange();
    expect(claimed?.id).toBe(chat.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.startedAt).not.toBeNull();
  });

  it('holds a write exchange until the run is parked with no stage in flight', () => {
    const run = newRun(); // status running
    repo.enqueueEvent({ runId: run.id, type: 'advance' });
    const event = repo.claimNextEvent()!; // stage in flight
    const chat = repo.createChatExchange({ runId: run.id, prompt: 'fix it', mode: 'write' });

    expect(repo.claimNextChatExchange()).toBeUndefined(); // running status → held
    repo.setRunStatus(run.id, 'paused');
    expect(repo.claimNextChatExchange()).toBeUndefined(); // paused but the stage is still mid-flight
    repo.markEventDone(event.id);
    expect(repo.claimNextChatExchange()?.id).toBe(chat.id); // parked + idle → claimable
  });

  it('claims write exchanges in every paused-like status, never running/blocked', () => {
    const claimable = (status: string) => {
      const run = newRun();
      repo.setRunStatus(run.id, status as never);
      repo.createChatExchange({ runId: run.id, prompt: 'p', mode: 'write' });
      const claimed = repo.claimNextChatExchange();
      if (claimed) repo.completeChatExchange(claimed.id, { response: 'ok' }); // clear for the next case
      return claimed !== undefined;
    };
    expect(claimable('running')).toBe(false);
    expect(claimable('blocked')).toBe(false);
    for (const status of ['paused', 'needs_human', 'awaiting_input', 'done', 'stopped']) {
      expect(claimable(status), status).toBe(true);
    }
  });

  it('runs one chat at a time per run, in FIFO order', () => {
    const run = newRun();
    repo.setRunStatus(run.id, 'paused');
    const first = repo.createChatExchange({ runId: run.id, prompt: 'one', mode: 'read' });
    const second = repo.createChatExchange({ runId: run.id, prompt: 'two', mode: 'write' });

    expect(repo.claimNextChatExchange()?.id).toBe(first.id);
    expect(repo.claimNextChatExchange()).toBeUndefined(); // first is still running
    repo.completeChatExchange(first.id, { response: 'answer', tokens: 12 });
    expect(repo.claimNextChatExchange()?.id).toBe(second.id);
  });

  it('blocks stage dispatch while a write chat runs, and never for a read chat', () => {
    const run = newRun();
    repo.setRunStatus(run.id, 'paused');
    const write = repo.createChatExchange({ runId: run.id, prompt: 'w', mode: 'write' });
    expect(repo.claimNextChatExchange()?.id).toBe(write.id);

    // The operator resumes mid-chat: the pending event must park until the write chat finishes.
    repo.setRunStatus(run.id, 'running');
    repo.enqueueEvent({ runId: run.id, type: 'advance' });
    expect(repo.claimNextEvent()).toBeUndefined();
    repo.completeChatExchange(write.id, { response: 'done', commitSha: 'abc123' });
    expect(repo.claimNextEvent()).toBeDefined();
    expect(repo.getChatExchange(write.id)).toMatchObject({ status: 'done', response: 'done', commitSha: 'abc123' });

    // A running *read* chat never gates dispatch.
    repo.recoverProcessingEvents();
    const read = repo.createChatExchange({ runId: run.id, prompt: 'r', mode: 'read' });
    expect(repo.claimNextChatExchange()?.id).toBe(read.id);
    expect(repo.claimNextEvent()).toBeDefined();
  });

  it('completes, fails, and cancels exchanges through their lifecycle', () => {
    const run = newRun();
    repo.setRunStatus(run.id, 'paused');
    const chat = repo.createChatExchange({ runId: run.id, prompt: 'p', mode: 'read' });

    // Only a queued exchange is cancellable.
    expect(repo.claimNextChatExchange()?.id).toBe(chat.id);
    expect(repo.cancelChatExchange(chat.id)).toBe(false);
    repo.failChatExchange(chat.id, 'boom');
    expect(repo.getChatExchange(chat.id)).toMatchObject({ status: 'error', error: 'boom' });

    const queued = repo.createChatExchange({ runId: run.id, prompt: 'q', mode: 'write' });
    expect(repo.cancelChatExchange(queued.id)).toBe(true);
    expect(repo.getChatExchange(queued.id)!.status).toBe('cancelled');
    expect(repo.claimNextChatExchange()).toBeUndefined(); // a cancelled exchange is never claimed
  });

  it('re-queues exchanges stranded running by a crash (recoverRunningChats)', () => {
    const run = newRun();
    repo.setRunStatus(run.id, 'paused');
    const chat = repo.createChatExchange({ runId: run.id, prompt: 'p', mode: 'write' });
    expect(repo.claimNextChatExchange()?.id).toBe(chat.id);

    expect(repo.recoverRunningChats()).toBe(1);
    const recovered = repo.getChatExchange(chat.id)!;
    expect(recovered.status).toBe('queued');
    expect(recovered.startedAt).toBeNull();
    expect(repo.claimNextChatExchange()?.id).toBe(chat.id); // claimable again
  });
});

describe('run advice (the escalation-resolution advisor, Layer 3)', () => {
  it('inserts an advisor result and reads the latest back, round-tripping the options JSON', () => {
    const run = newRun();
    const options = [
      { label: 'Accept and retry', rationale: 'The findings are cosmetic.', action: 'resume' as const, suggestedNotes: 'accept' },
      { label: 'Revert to plan', rationale: 'The plan scoped too much.', action: 'revert' as const, toState: 'plan', suggestedNotes: 'narrow' },
    ];

    const stored = repo.insertAdvice({ runId: run.id, summary: 'stuck in the review loop', options, tokens: 12 });

    expect(stored).toMatchObject({ runId: run.id, summary: 'stuck in the review loop', options, tokens: 12 });
    expect(typeof stored.id).toBe('number');
    expect(stored.createdAt).toBeTruthy();
    expect(repo.getLatestAdvice(run.id)).toEqual(stored);
  });

  it('returns the most recent advice when several exist for a run', () => {
    const run = newRun();
    repo.insertAdvice({ runId: run.id, summary: 'first pass', options: [], tokens: 1 });
    const second = repo.insertAdvice({ runId: run.id, summary: 'second pass', options: [{ label: 'a', rationale: 'b', action: 'resume' as const }], tokens: 2 });

    expect(repo.getLatestAdvice(run.id)).toEqual(second);
  });

  it('is undefined for a run with no advice yet', () => {
    expect(repo.getLatestAdvice(newRun().id)).toBeUndefined();
  });
});
