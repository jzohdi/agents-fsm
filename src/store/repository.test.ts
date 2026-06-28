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
    });
    expect(repo.getRun(run.id)).toEqual(run);
  });

  it('returns undefined for a missing run', () => {
    expect(repo.getRun(999)).toBeUndefined();
  });

  it('updates state, status, PR, and usage', () => {
    const run = newRun();
    repo.setRunState(run.id, 'plan');
    repo.setRunStatus(run.id, 'needs_human');
    repo.setRunPr(run.id, 42, 'agent/issue-1');
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
