/**
 * Agent Runner tests: the per-stage phase recipe and the bounded self-review → fix loop
 * (Milestone 2), the harness request (Milestone 3), and malformed-output handling — all
 * exercised with stub agents and the in-memory GitHub fake.
 *
 * The end-to-end working-tree / PR / comment lifecycle is covered in runner-lifecycle.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AgentsConfig } from '../fsm/config';
import { FakeGitHub } from '../integration/github-fake';
import { openDb } from '../store/db';
import { Repository, type Run } from '../store/repository';
import { StubExecutor, type AgentRunRequest, type StageExecutor, type StubHandler } from './executor';
import { AgentRunner, phaseModel, type AgentRunnerOptions } from './runner';

describe('phaseModel', () => {
  it('replaces only the frontier role when an override is set', () => {
    expect(phaseModel('frontier', 'sonnet')).toBe('sonnet'); // primary work → the override
    expect(phaseModel('cheap', 'sonnet')).toBe('cheap'); // cheap role untouched
  });
  it('falls through to the logical model with no override', () => {
    expect(phaseModel('frontier', null)).toBe('frontier');
    expect(phaseModel('cheap', null)).toBe('cheap');
  });
});

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
        return { output: { decision: 'proceed' } }; // triage's own decision contract
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

describe('AgentRunner — live activity', () => {
  /** A stub executor that streams two activities (as a real harness would) before returning. */
  function streamingHandler(output: unknown): StageExecutor {
    return {
      run: (r) => {
        r.onActivity?.({ kind: 'tool_use', summary: 'tool: Read README.md' });
        r.onActivity?.({ kind: 'assistant', summary: 'assistant: done' });
        return Promise.resolve({ output, usage: { tokens: 1 } });
      },
    };
  }

  it('persists each streamed activity to the run log and forwards it with run context', async () => {
    const repo = new Repository(openDb(':memory:'));
    const forwarded: Array<{ stage: string; phase: string; summary: string }> = [];
    const runner = new AgentRunner(repo, streamingHandler({ requestedTransition: 'proceed' }), { plan: { phases: ['produce'] } }, new FakeGitHub({ autoSeedIssues: true }), {
      onActivity: (a) => forwarded.push({ stage: a.stage, phase: a.phase, summary: a.activity.summary }),
    });
    const run = repo.createRun({ issueRef: 'o/r#1', repoRef: 'o/r', initialState: 'plan', fsmConfigVersion: 'v1' });

    await runner.runStage(run);

    // Persisted to the durable log stream, in order, with stage/phase/kind in the structured data.
    const logs = repo.listLogs(run.id);
    expect(logs.map((l) => l.message)).toEqual(['tool: Read README.md', 'assistant: done']);
    expect(logs[0]!.data).toMatchObject({ stage: 'plan', phase: 'produce', kind: 'tool_use' });
    // Forwarded in-process to the watcher with the run context the bare activity lacks.
    expect(forwarded).toEqual([
      { stage: 'plan', phase: 'produce', summary: 'tool: Read README.md' },
      { stage: 'plan', phase: 'produce', summary: 'assistant: done' },
    ]);
  });

  it('persists activity even with no in-process watcher, and a throwing watcher never breaks the run', async () => {
    const repo = new Repository(openDb(':memory:'));
    const runner = new AgentRunner(repo, streamingHandler({ requestedTransition: 'proceed' }), { plan: { phases: ['produce'] } }, new FakeGitHub({ autoSeedIssues: true }), {
      onActivity: () => { throw new Error('watcher boom'); },
    });
    const run = repo.createRun({ issueRef: 'o/r#1', repoRef: 'o/r', initialState: 'plan', fsmConfigVersion: 'v1' });

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('handoff');
    expect(repo.listLogs(run.id)).toHaveLength(2); // persistence is independent of the watcher
  });
});

describe('AgentRunner — side-effect outbox (idempotent non-idempotent calls, README Milestone 7)', () => {
  it('posts review PR comments once across a replay of the same visit', async () => {
    const { repo, runner, run, github } = setup(
      () => ({ output: { requestedTransition: 'approve', comments: ['nit: rename x', 'add a test'] } }),
      { code_review: { phases: ['produce'], io: { kind: 'review' } } },
      {},
      'code_review',
    );
    const pr = await github.openPr({ branch: 'b', base: 'main', title: 't', body: '' });
    repo.setRunPr(run.id, pr.number);
    const postComment = vi.spyOn(github, 'postComment');

    await runner.runStage(repo.getRun(run.id)!); // attempt 1 posts the comments + records the outbox
    expect(postComment).toHaveBeenCalledTimes(2);

    await runner.runStage(repo.getRun(run.id)!); // replay (same visit): the outbox reuses, no re-post
    expect(postComment).toHaveBeenCalledTimes(2); // not 4
  });

  it('posts triage sub-issues and the split comment once across a replay', async () => {
    const { repo, runner, run, github } = setup(
      () => ({ output: { decision: 'split', subIssues: [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }] } }),
      { triage: { phases: ['produce'], io: { kind: 'triage' } } },
      {},
      'triage',
    );
    const createIssue = vi.spyOn(github, 'createIssue');
    const postIssueComment = vi.spyOn(github, 'postIssueComment');

    const first = await runner.runStage(repo.getRun(run.id)!);
    const second = await runner.runStage(repo.getRun(run.id)!); // replay

    expect(createIssue).toHaveBeenCalledTimes(2); // not 4
    expect(postIssueComment).toHaveBeenCalledTimes(1); // not 2
    // The replay still returns the same escalation outcome (driven by the reused sub-issues).
    expect(first.kind).toBe('escalate');
    expect(second.kind).toBe('escalate');
  });

  it('reuses the stored comment on a clarify replay, preserving the await_input anchor', async () => {
    // clarify is the case that *depends* on the call result (the comment id/author the reply poller
    // anchors on), so the outbox must return the same stored comment — not just skip the re-post.
    const { repo, runner, run, github } = setup(
      () => ({ output: { decision: 'clarify', questions: ['which db?'] } }),
      { triage: { phases: ['produce'], io: { kind: 'triage' } } },
      {},
      'triage',
    );
    const postIssueComment = vi.spyOn(github, 'postIssueComment');

    const first = await runner.runStage(repo.getRun(run.id)!);
    const second = await runner.runStage(repo.getRun(run.id)!); // replay, same visit

    expect(postIssueComment).toHaveBeenCalledTimes(1); // posted once
    const anchorOf = (o: typeof first) => (o.kind === 'await_input' ? (o.reason as { commentId: number }).commentId : null);
    expect(anchorOf(first)).not.toBeNull();
    expect(anchorOf(second)).toBe(anchorOf(first)); // the reused comment carries the same anchor
  });

  it('re-posts side effects on a legitimate re-entry (a new visit bumps the slot keys)', async () => {
    // A back-edge that brings a run back to a review stage is a genuine new round — its comments must
    // NOT be suppressed by the outbox. The visit index (transitions into the state) makes the keys fresh.
    const { repo, runner, run, github } = setup(
      () => ({ output: { requestedTransition: 'approve', comments: ['nit'] } }),
      { code_review: { phases: ['produce'], io: { kind: 'review' } } },
      {},
      'code_review',
    );
    const pr = await github.openPr({ branch: 'b', base: 'main', title: 't', body: '' });
    repo.setRunPr(run.id, pr.number);
    const postComment = vi.spyOn(github, 'postComment');

    await runner.runStage(repo.getRun(run.id)!); // visit 0 → posts
    expect(postComment).toHaveBeenCalledTimes(1);

    // Simulate the run leaving and re-entering code_review (a committed transition bumps the visit).
    repo.appendTransition({ runId: run.id, fromState: 'backend', toState: 'code_review', trigger: 'proceed' });

    await runner.runStage(repo.getRun(run.id)!); // visit 1 → fresh slot → posts again
    expect(postComment).toHaveBeenCalledTimes(2); // a new round, not suppressed
  });

  it('escalates partial_side_effect when a prior attempt left a call in-flight (a crash mid-call)', async () => {
    const { repo, runner, run, github } = setup(
      () => ({ output: { decision: 'proceed' } }),
      { triage: { phases: ['produce'], io: { kind: 'triage' } } },
      {},
      'triage',
    );
    // Simulate a crash *during* the signoff comment: the slot (visit 0) was claimed, never completed.
    repo.beginSideEffect(run.id, 'triage#0:signoff');
    const postIssueComment = vi.spyOn(github, 'postIssueComment');

    const outcome = await runner.runStage(repo.getRun(run.id)!);

    expect(outcome.kind).toBe('escalate');
    if (outcome.kind === 'escalate') {
      expect(outcome.trigger).toBe('partial_side_effect');
      expect(outcome.reason).toMatchObject({ kind: 'partial_side_effect', key: 'triage#0:signoff' });
    }
    expect(postIssueComment).not.toHaveBeenCalled(); // the ambiguous call is never retried
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

describe('AgentRunner — per-run model override', () => {
  /** Run one produce → self_review → simplify stage, capturing the model each phase asked the harness for. */
  async function modelsForOverride(override: string | null): Promise<Record<string, string>> {
    const models: Record<string, string> = {};
    // Reject the first review so `simplify` also runs, giving us all three phases in one stage.
    let reviewed = false;
    const { repo, runner, run } = setup((req) => {
      models[req.phase] = req.model;
      if (req.phase === 'self_review' && !reviewed) {
        reviewed = true;
        return { output: { acceptable: false, notes: 'tighten' } };
      }
      if (req.phase === 'self_review') return { output: { acceptable: true } };
      return { output: { requestedTransition: 'proceed' } };
    });
    repo.setRunModelOverride(run.id, override);
    await runner.runStage(repo.getRun(run.id)!); // fresh snapshot, the way the loop dispatches a stage
    return models;
  }

  it('replaces the frontier role (produce + self_review) but leaves the cheap simplify phase', async () => {
    const models = await modelsForOverride('sonnet');
    expect(models.produce).toBe('sonnet');
    expect(models.self_review).toBe('sonnet');
    expect(models.simplify).toBe('cheap'); // the cheaper pass is untouched by the override
  });

  it('falls through to the recipe logical models when no override is set', async () => {
    const models = await modelsForOverride(null);
    expect(models.produce).toBe('frontier'); // the Layer-5 executor resolves these logical names
    expect(models.self_review).toBe('frontier');
    expect(models.simplify).toBe('cheap');
  });
});
