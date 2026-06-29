/**
 * Agent Runner tests (Milestone 2): the per-stage phase recipe and the bounded
 * self-review → fix loop, exercised with stub agents.
 */

import { describe, expect, it } from 'vitest';

import type { AgentsConfig } from '../fsm/config';
import { openDb } from '../store/db';
import { Repository, type Run } from '../store/repository';
import { StubExecutor, type AgentRunRequest, type StageExecutor, type StubHandler } from './executor';
import { AgentRunner, type AgentRunnerOptions } from './runner';

function setup(handler: StubHandler, agents: AgentsConfig = {}, options: AgentRunnerOptions = {}) {
  const repo = new Repository(openDb(':memory:'));
  const runner = new AgentRunner(repo, new StubExecutor(handler), agents, options);
  const run: Run = repo.createRun({ issueRef: 'o/r#1', repoRef: 'o/r', initialState: 'plan', fsmConfigVersion: 'v1' });
  return { repo, runner, run };
}

describe('AgentRunner — phase recipe', () => {
  it('runs produce then self-review, and hands off when review accepts on the first pass', async () => {
    const { repo, runner, run } = setup((req) =>
      req.phase === 'self_review'
        ? { output: { acceptable: true } }
        : { output: { requestedTransition: 'proceed' } },
    );

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('handoff');
    expect(repo.listAgentRuns(run.id).map((r) => r.phase)).toEqual(['produce', 'self_review']);
    // Usage is accumulated per phase.
    expect(repo.getRun(run.id)!.agentRunsCount).toBe(2);
  });

  it('loops review → fix → re-review, running simplify when the first review rejects', async () => {
    let reviews = 0;
    const { repo, runner, run } = setup((req) => {
      if (req.phase === 'self_review') {
        reviews += 1;
        return { output: { acceptable: reviews > 1, notes: 'tighten naming' } };
      }
      return { output: { requestedTransition: 'proceed' } };
    });

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('handoff');
    expect(repo.listAgentRuns(run.id).map((r) => r.phase)).toEqual([
      'produce',
      'self_review',
      'simplify',
      'self_review',
    ]);
  });

  it('escalates when the review cap is hit with blocking issues remaining', async () => {
    const { repo, runner, run } = setup(
      (req) =>
        req.phase === 'self_review'
          ? { output: { acceptable: false, notes: 'still wrong' } }
          : { output: { requestedTransition: 'proceed' } },
      { plan: { phases: ['produce', 'self_review', 'simplify'], reviewCap: 2 } },
    );

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('escalate');
    if (outcome.kind === 'escalate') {
      expect(outcome.reason).toMatchObject({ kind: 'internal_review_cap', cap: 2 });
    }
    // produce + 2×(self_review + simplify).
    expect(repo.listAgentRuns(run.id).map((r) => r.phase)).toEqual([
      'produce',
      'self_review',
      'simplify',
      'self_review',
      'simplify',
    ]);
  });

  it('hands off after produce only when the recipe has no self-review', async () => {
    const { repo, runner, run } = setup(() => ({ output: { requestedTransition: 'approve' } }), {
      plan: { phases: ['produce'] },
    });

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('handoff');
    expect(repo.listAgentRuns(run.id).map((r) => r.phase)).toEqual(['produce']);
  });

  it('records the configured model per phase', async () => {
    const { repo, runner, run } = setup(
      (req) => (req.phase === 'self_review' ? { output: { acceptable: true } } : { output: { requestedTransition: 'proceed' } }),
      { plan: { phases: ['produce', 'self_review'], models: { produce: 'big', self_review: 'big' } } },
    );

    await runner.runStage(run);

    expect(repo.listAgentRuns(run.id).map((r) => r.model)).toEqual(['big', 'big']);
  });
});

describe('AgentRunner — harness request (Milestone 3)', () => {
  it('forwards the per-stage allow-list and resolved working dir to the executor', async () => {
    const seen: AgentRunRequest[] = [];
    const handler: StubHandler = (req) => {
      seen.push(req);
      return req.phase === 'self_review' ? { output: { acceptable: true } } : { output: { requestedTransition: 'proceed' } };
    };
    const { runner, run } = setup(
      handler,
      { plan: { phases: ['produce', 'self_review'], allowedTools: ['Read', 'Edit'] } },
      { resolveWorkingDir: (r) => `/work/run-${r.id}` },
    );

    await runner.runStage(run);

    expect(seen).not.toHaveLength(0);
    for (const req of seen) {
      expect(req.allowedTools).toEqual(['Read', 'Edit']);
      expect(req.workingDir).toBe(`/work/run-${run.id}`);
    }
  });

  it('records a failed agent_run and propagates when the executor throws', async () => {
    const repo = new Repository(openDb(':memory:'));
    const throwing: StageExecutor = { run: () => Promise.reject(new Error('harness boom')) };
    const runner = new AgentRunner(repo, throwing, {});
    const run = repo.createRun({ issueRef: 'o/r#1', repoRef: 'o/r', initialState: 'plan', fsmConfigVersion: 'v1' });

    await expect(runner.runStage(run)).rejects.toThrowError(/harness boom/);

    const rows = repo.listAgentRuns(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: 'produce', success: false });
    // A failed invocation contributes no usage.
    expect(repo.getRun(run.id)!.agentRunsCount).toBe(0);
  });

  it('aggregates per-phase token and dollar cost onto the run', async () => {
    const { repo, runner, run } = setup((req) =>
      req.phase === 'self_review'
        ? { output: { acceptable: true }, tokens: 5, cost: 0.01 }
        : { output: { requestedTransition: 'proceed' }, tokens: 10, cost: 0.02 },
    );

    await runner.runStage(run); // produce + self_review

    const after = repo.getRun(run.id)!;
    expect(after.tokensUsed).toBe(15);
    expect(after.costUsed).toBeCloseTo(0.03);
  });

  it('omits allowedTools and workingDir when not configured', async () => {
    const seen: AgentRunRequest[] = [];
    const { runner, run } = setup((req) => {
      seen.push(req);
      return req.phase === 'self_review' ? { output: { acceptable: true } } : { output: { requestedTransition: 'proceed' } };
    });

    await runner.runStage(run);

    expect(seen[0]!.allowedTools).toBeUndefined();
    expect(seen[0]!.workingDir).toBeUndefined();
  });
});

describe('AgentRunner — malformed output escalates (never coerce)', () => {
  it('escalates when produce returns an output that fails the envelope schema', async () => {
    const { runner, run } = setup(() => ({ output: { not: 'an envelope' } }));

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('escalate');
    if (outcome.kind === 'escalate') {
      expect(outcome.reason).toMatchObject({ kind: 'malformed_output', phase: 'produce' });
    }
  });

  it('escalates when self-review returns a malformed verdict', async () => {
    const { runner, run } = setup((req) =>
      req.phase === 'self_review' ? { output: { verdict: 'maybe' } } : { output: { requestedTransition: 'proceed' } },
    );

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('escalate');
    if (outcome.kind === 'escalate') {
      expect(outcome.reason).toMatchObject({ kind: 'malformed_output', phase: 'self_review' });
    }
  });
});
