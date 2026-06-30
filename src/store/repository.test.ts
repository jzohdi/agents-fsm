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
    expect(repo.listRuns('running').map((r) => r.id)).toEqual([a.id]);
    expect(repo.listRuns('needs_human').map((r) => r.id)).toEqual([b.id]);
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

    const second = repo.claimNextEvent()!;
    expect(second.payload).toEqual({ stage: 'plan' });

    // both claimed → nothing left pending
    expect(repo.claimNextEvent()).toBeUndefined();

    repo.markEventDone(first.id);
    expect(repo.claimNextEvent()).toBeUndefined();
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

  it('reclaims stranded `processing` events on recovery so they are re-claimable', () => {
    const run = newRun();
    repo.enqueueEvent({ runId: run.id, type: 'stage_done' });
    repo.enqueueEvent({ runId: run.id, type: 'stage_done' });

    // Simulate a crash mid-flight: both events claimed (now `processing`), one done.
    const a = repo.claimNextEvent()!;
    repo.claimNextEvent();
    repo.markEventDone(a.id);

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
