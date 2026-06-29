/**
 * Agent Runner tests: the per-stage phase recipe and the bounded self-review → fix loop
 * (Milestone 2), the harness request (Milestone 3), and malformed-output handling — all
 * exercised with stub agents and the in-memory GitHub fake.
 *
 * The end-to-end working-tree / PR / comment lifecycle is covered in runner-lifecycle.test.ts.
 */

import { describe, expect, it } from 'vitest';

import type { AgentsConfig } from '../fsm/config';
import { FakeGitHub } from '../integration/github-fake';
import { openDb } from '../store/db';
import { Repository, type Run } from '../store/repository';
import { StubExecutor, type AgentRunRequest, type StageExecutor, type StubHandler } from './executor';
import { AgentRunner, type AgentRunnerOptions } from './runner';

function setup(handler: StubHandler, agents: AgentsConfig = {}, options: AgentRunnerOptions = {}, initialState = 'plan') {
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ autoSeedIssues: true });
  const runner = new AgentRunner(repo, new StubExecutor(handler), agents, github, options);
  const run: Run = repo.createRun({ issueRef: 'o/r#1', repoRef: 'o/r', initialState, fsmConfigVersion: 'v1' });
  return { repo, runner, run, github };
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

describe('AgentRunner — internal sequence finds and fixes a seeded defect', () => {
  it('self-review rejects a defective produce output and hands off the simplify-corrected one', async () => {
    // produce seeds a defect: it declares no backend work when the issue needs it. self-review
    // catches it; the fix phase corrects the envelope; re-review accepts the corrected output.
    let produced = 0;
    const handler: StubHandler = (req) => {
      if (req.phase === 'produce') {
        produced += 1;
        return { output: { requestedTransition: 'proceed', flags: { needs_frontend: true, needs_backend: false } } };
      }
      if (req.phase === 'simplify') {
        return { output: { requestedTransition: 'proceed', flags: { needs_frontend: true, needs_backend: true } } };
      }
      // self_review: the produced envelope is defective; the corrected (simplify) one is acceptable.
      const env = (req.input as { producedEnvelope?: { flags?: { needs_backend?: boolean } } }).producedEnvelope;
      const fixed = env?.flags?.needs_backend === true;
      return { output: fixed ? { acceptable: true } : { acceptable: false, notes: 'needs_backend must be true' } };
    };
    const { repo, runner, run } = setup(handler, { plan: { phases: ['produce', 'self_review', 'simplify'] } });

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('handoff');
    if (outcome.kind === 'handoff') {
      // The defect is corrected in the handed-off envelope — the fix phase's output won, not produce's.
      expect(outcome.envelope.flags).toEqual({ needs_frontend: true, needs_backend: true });
    }
    expect(produced).toBe(1); // produce ran once; the fix came from simplify, not a re-produce
    expect(repo.listAgentRuns(run.id).map((r) => r.phase)).toEqual(['produce', 'self_review', 'simplify', 'self_review']);
  });
});

describe('AgentRunner — harness request', () => {
  it('forwards the per-stage allow-list and the prepared working dir to the executor', async () => {
    const seen: AgentRunRequest[] = [];
    const handler: StubHandler = (req) => {
      seen.push(req);
      return req.phase === 'self_review' ? { output: { acceptable: true } } : { output: { requestedTransition: 'proceed' } };
    };
    const { runner, run } = setup(handler, {
      plan: { phases: ['produce', 'self_review'], allowedTools: ['Read', 'Edit'] },
    });

    await runner.runStage(run);

    expect(seen).not.toHaveLength(0);
    for (const req of seen) {
      expect(req.allowedTools).toEqual(['Read', 'Edit']);
      // produce stages run in the prepared working tree (the fake's per-run path).
      expect(req.workingDir).toMatch(new RegExp(`run-${run.id}$`));
    }
  });

  it('omits allowedTools and the working dir for a tree-less triage stage', async () => {
    const seen: AgentRunRequest[] = [];
    const { runner, run } = setup(
      (req) => {
        seen.push(req);
        return { output: { requestedTransition: 'proceed' } };
      },
      { triage: { phases: ['produce'], io: { kind: 'triage' } } },
      {},
      'triage',
    );

    await runner.runStage(run);

    expect(seen[0]!.allowedTools).toBeUndefined();
    expect(seen[0]!.workingDir).toBeUndefined();
  });

  it('records a failed agent_run and propagates when the executor throws', async () => {
    const repo = new Repository(openDb(':memory:'));
    const throwing: StageExecutor = { run: () => Promise.reject(new Error('harness boom')) };
    const runner = new AgentRunner(repo, throwing, {}, new FakeGitHub({ autoSeedIssues: true }));
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
});

describe('AgentRunner — malformed output (retry, then escalate, never coerce)', () => {
  it('retries then escalates when produce keeps failing the envelope schema', async () => {
    let attempts = 0;
    const { runner, run } = setup((req) => {
      if (req.phase === 'produce') attempts += 1;
      return { output: { not: 'an envelope' } };
    });

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('escalate');
    if (outcome.kind === 'escalate') {
      expect(outcome.reason).toMatchObject({ kind: 'malformed_output', phase: 'produce' });
    }
    // Default cap is 1 extra attempt → 2 invocations before escalating.
    expect(attempts).toBe(2);
  });

  it('feeds the previous error back on retry, and recovers when a retry yields valid output', async () => {
    let attempts = 0;
    const inputs: unknown[] = [];
    const { runner, run } = setup((req) => {
      if (req.phase !== 'produce') return { output: { acceptable: true } };
      attempts += 1;
      inputs.push(req.input);
      return attempts === 1 ? { output: { garbage: true } } : { output: { requestedTransition: 'proceed' } };
    });

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('handoff'); // the second produce attempt parsed cleanly
    expect(attempts).toBe(2);
    // The first attempt has no hint; the retry carries the previous parse error so the agent can correct.
    expect((inputs[0] as { retry?: unknown }).retry).toBeUndefined();
    expect((inputs[1] as { retry?: { previousError: string } }).retry?.previousError).toBeTruthy();
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
