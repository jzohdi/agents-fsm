import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('sets the PR-feedback watermark (defaults to null)', () => {
    const run = newRun();
    expect(repo.getRun(run.id)!.prFeedbackWatermark).toBeNull();
    repo.setPrFeedbackWatermark(run.id, 12);
    expect(repo.getRun(run.id)!.prFeedbackWatermark).toBe(12);
    repo.setPrFeedbackWatermark(run.id, 34); // advances as the poller consumes newer comments
    expect(repo.getRun(run.id)!.prFeedbackWatermark).toBe(34);
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
    });
    expect(repo.getRepo('owner/repo')).toEqual(enrolled);
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
