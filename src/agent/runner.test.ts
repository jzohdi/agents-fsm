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
import { Repository, type Run, type Transition } from '../store/repository';
import { StubExecutor, goldenPathHandler, type AgentRunRequest, type StageExecutor, type StubHandler } from './executor';
import { HarnessRegistry } from './harness';
import { AgentRunner, chatCommitMessage, chatResponseText, phaseModel, reentryContext, type AgentRunnerOptions } from './runner';
import { ADDRESSING_PR_FEEDBACK_FLAG } from '../loop/event-loop';

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

  it('gives each round its context, carrying the previous findings from round 2 on (convergence aid)', async () => {
    const reviewRounds: unknown[] = [];
    const fixRounds: unknown[] = [];
    let reviews = 0;
    const { runner, run } = setup(
      (req) => {
        const round = (req.input as { reviewRound?: unknown }).reviewRound;
        if (req.phase === 'self_review') {
          reviewRounds.push(round);
          reviews += 1;
          return { output: { acceptable: reviews > 2, notes: `round ${reviews} findings` } };
        }
        if (req.phase === 'simplify') fixRounds.push(round);
        return { output: { requestedTransition: 'proceed' } };
      },
      { plan: { phases: ['produce', 'self_review', 'simplify'], reviewCap: 3 } },
    );

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('handoff'); // converged on round 3
    expect(reviewRounds).toEqual([
      { round: 1, cap: 3 },
      { round: 2, cap: 3, previousNotes: 'round 1 findings' },
      { round: 3, cap: 3, previousNotes: 'round 2 findings' },
    ]);
    // The fix phase shares the same round context it is fixing within.
    expect(fixRounds).toEqual([
      { round: 1, cap: 3 },
      { round: 2, cap: 3, previousNotes: 'round 1 findings' },
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

  it('forwards the run reasoning effort to every frontier-role phase — including the fix pass', async () => {
    const seen: AgentRunRequest[] = [];
    const handler: StubHandler = (req) => {
      seen.push(req);
      if (req.phase === 'self_review') return { output: { acceptable: false, notes: 'again' } }; // force simplify to run
      return { output: { requestedTransition: 'proceed' } };
    };
    const { repo, runner, run } = setup(handler, { plan: { phases: ['produce', 'self_review', 'simplify'], reviewCap: 1 } });
    repo.setRunEffortOverride(run.id, 'high');

    await runner.runStage(repo.getRun(run.id)!);

    // All default phases use the frontier role now (the fix pass must match the reviewer), so all carry the effort.
    expect(seen.find((r) => r.phase === 'produce')!.effort).toBe('high');
    expect(seen.find((r) => r.phase === 'simplify')!.effort).toBe('high');
  });

  it('spares a phase explicitly configured onto a cheaper logical model from the effort override', async () => {
    const seen: AgentRunRequest[] = [];
    const handler: StubHandler = (req) => {
      seen.push(req);
      if (req.phase === 'self_review') return { output: { acceptable: false, notes: 'again' } };
      return { output: { requestedTransition: 'proceed' } };
    };
    const { repo, runner, run } = setup(handler, {
      plan: { phases: ['produce', 'self_review', 'simplify'], reviewCap: 1, models: { simplify: 'cheap' } },
    });
    repo.setRunEffortOverride(run.id, 'high');

    await runner.runStage(repo.getRun(run.id)!);

    expect(seen.find((r) => r.phase === 'produce')!.effort).toBe('high');
    expect(seen.find((r) => r.phase === 'simplify')!.effort).toBeUndefined(); // stays on its configured cheap role
  });

  it('runs triage inside the prepared repo checkout, still omitting allowedTools (Milestone 12)', async () => {
    // triage prepares a working tree so the harness runs *in the target repo*, not the daemon's own cwd
    // (the tmux-speedrun#35 failure). It still carries no allowedTools (that's a per-recipe setting).
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
    expect(seen[0]!.workingDir).toBe(`/tmp/agent-fleet-fake/run-${run.id}`);
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

describe('AgentRunner — PR feedback context injection', () => {
  /** A produce/self_review handler that records every request it sees. */
  function recordingSetup() {
    const seen: AgentRunRequest[] = [];
    const h = setup((req) => {
      seen.push(req);
      return req.phase === 'self_review' ? { output: { acceptable: true } } : { output: { requestedTransition: 'proceed' } };
    });
    return { ...h, seen };
  }

  it('injects the open PR + feedback thread when the run is addressing PR feedback', async () => {
    const { repo, runner, run, github, seen } = recordingSetup();
    const pr = await github.openPr({ branch: 'agent/run', base: 'main', title: 't', body: '' });
    repo.setRunPr(run.id, pr.number);
    repo.mergeRunFlags(run.id, { [ADDRESSING_PR_FEEDBACK_FLAG]: true });
    github.seedPrComment(pr.number, { author: 'alice', body: 'feedback: rename the endpoint' });

    await runner.runStage(repo.getRun(run.id)!); // pass the updated snapshot (flag + PR set)

    const input = seen[0]!.input as { pullRequest?: { number: number; addressingFeedback: boolean }; prFeedback?: Array<{ body: string }> };
    expect(input.pullRequest).toMatchObject({ number: pr.number, addressingFeedback: true });
    expect(input.prFeedback?.map((c) => c.body)).toEqual(['feedback: rename the endpoint']);
  });

  it('does not inject PR context on a normal first-pass stage (PR exists but the flag is unset)', async () => {
    const { repo, runner, run, github, seen } = recordingSetup();
    const pr = await github.openPr({ branch: 'agent/run', base: 'main', title: 't', body: '' });
    repo.setRunPr(run.id, pr.number); // PR exists, but this is the initial build — no feedback flag

    await runner.runStage(repo.getRun(run.id)!);

    const input = seen[0]!.input as { pullRequest?: unknown; prFeedback?: unknown };
    expect(input.pullRequest).toBeUndefined();
    expect(input.prFeedback).toBeUndefined();
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
  async function modelsForOverride(override: string | null, agents: AgentsConfig = {}): Promise<Record<string, string>> {
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
    }, agents);
    repo.setRunModelOverride(run.id, override);
    await runner.runStage(repo.getRun(run.id)!); // fresh snapshot, the way the loop dispatches a stage
    return models;
  }

  it('replaces every frontier-role phase — produce, self_review, and the fix pass', async () => {
    const models = await modelsForOverride('sonnet');
    expect(models.produce).toBe('sonnet');
    expect(models.self_review).toBe('sonnet');
    expect(models.simplify).toBe('sonnet'); // the fix pass runs on the same brain as the reviewer
  });

  it('falls through to the recipe logical models when no override is set', async () => {
    const models = await modelsForOverride(null);
    expect(models.produce).toBe('frontier'); // the Layer-5 executor resolves these logical names
    expect(models.self_review).toBe('frontier');
    expect(models.simplify).toBe('frontier');
  });

  it('leaves a phase explicitly configured onto a cheaper logical model untouched by the override', async () => {
    const models = await modelsForOverride('sonnet', {
      plan: { phases: ['produce', 'self_review', 'simplify'], models: { simplify: 'cheap' } },
    });
    expect(models.produce).toBe('sonnet');
    expect(models.simplify).toBe('cheap'); // per-stage config wins over the default frontier fix pass
  });
});

describe('AgentRunner — per-run harness dispatch', () => {
  /** A stub whose handler records the stages it saw, so we can tell which executor a run used. */
  function recordingExecutor(seen: string[]): StubExecutor {
    return new StubExecutor((req) => {
      seen.push(req.stage);
      return req.phase === 'self_review' ? { output: { acceptable: true } } : { output: { requestedTransition: 'proceed' } };
    });
  }

  it('dispatches each run to the executor its `harness` id names, and no other', async () => {
    const repo = new Repository(openDb(':memory:'));
    const github = new FakeGitHub({ autoSeedIssues: true });
    const seenDefault: string[] = [];
    const seenOther: string[] = [];
    const registry = new HarnessRegistry({ 'claude-code': recordingExecutor(seenDefault), other: recordingExecutor(seenOther) });
    const runner = new AgentRunner(repo, registry, {}, github);

    const runDefault = repo.createRun({ issueRef: 'o/r#1', repoRef: 'o/r', initialState: 'plan', fsmConfigVersion: 'v1' }); // harness → default 'claude-code'
    const runOther = repo.createRun({ issueRef: 'o/r#2', repoRef: 'o/r', initialState: 'plan', fsmConfigVersion: 'v1', harness: 'other' });

    await runner.runStage(runDefault);
    expect(seenDefault).toContain('plan'); // the default-harness run hit the claude-code executor…
    expect(seenOther).toEqual([]); // …and left the other one untouched

    await runner.runStage(runOther);
    expect(seenOther).toContain('plan'); // the 'other'-harness run hit the other executor
  });

  it('escalates a run whose harness is not registered (throws → the loop parks it, never a silent fallback)', async () => {
    const repo = new Repository(openDb(':memory:'));
    const github = new FakeGitHub({ autoSeedIssues: true });
    const runner = new AgentRunner(repo, new HarnessRegistry({ 'claude-code': new StubExecutor(() => ({ output: {} })) }), {}, github);
    const ghost = repo.createRun({ issueRef: 'o/r#1', repoRef: 'o/r', initialState: 'plan', fsmConfigVersion: 'v1', harness: 'ghost' });

    // The runner rethrows the resolution error (recorded as a failed agent_run); the event loop turns a
    // non-fatal throw into an `executor_error` escalation, so one bad harness parks its run, not the fleet.
    await expect(runner.runStage(ghost)).rejects.toThrowError(/no executor registered for harness "ghost"/);
    expect(repo.listAgentRuns(ghost.id).some((r) => !r.success)).toBe(true);
  });
});

describe('reentryContext — why a stage is being re-run (README §2 reason delivery)', () => {
  const tr = (over: Partial<Transition>): Transition => ({
    id: 1,
    runId: 1,
    fromState: 'triage',
    toState: 'plan',
    trigger: 'proceed',
    reason: null,
    backEdge: false,
    counterKey: null,
    isReset: false,
    eventId: null,
    createdAt: '',
    ...over,
  });

  it('is undefined on a first visit and on a normal forward handoff', () => {
    expect(reentryContext([], 'plan')).toBeUndefined();
    expect(reentryContext([tr({})], 'plan')).toBeUndefined();
  });

  it('is undefined when the latest transition does not target the current state', () => {
    expect(reentryContext([tr({ trigger: 'revert', reason: 'notes', toState: 'plan' })], 'tdd')).toBeUndefined();
  });

  it('classifies an operator resume, attaching the escalation it undoes and the operator notes', () => {
    const transitions = [
      tr({ id: 1, fromState: 'plan', toState: 'needs_human', trigger: 'internal_review_cap', reason: { kind: 'internal_review_cap', cap: 2, notes: { issues: ['x'] } } }),
      tr({ id: 2, fromState: 'needs_human', toState: 'plan', trigger: 'resume', reason: { kind: 'operator_resume', notes: 'accept the findings' } }),
    ];
    expect(reentryContext(transitions, 'plan')).toEqual({
      kind: 'operator_resume',
      trigger: 'internal_review_cap',
      reason: { kind: 'internal_review_cap', cap: 2, notes: { issues: ['x'] } },
      operatorNotes: 'accept the findings',
    });
  });

  it('resolves the escalation for the stage actually resumed, not an earlier one from another stage', () => {
    const transitions = [
      tr({ id: 1, fromState: 'tdd', toState: 'needs_human', trigger: 'git_error', reason: { kind: 'git_error' } }),
      tr({ id: 2, fromState: 'needs_human', toState: 'tdd', trigger: 'resume' }),
      tr({ id: 3, fromState: 'tdd', toState: 'backend', trigger: 'proceed' }),
      tr({ id: 4, fromState: 'backend', toState: 'needs_human', trigger: 'executor_error', reason: { kind: 'executor_error', error: 'boom' } }),
      tr({ id: 5, fromState: 'needs_human', toState: 'backend', trigger: 'resume' }),
    ];
    expect(reentryContext(transitions, 'backend')).toEqual({
      kind: 'operator_resume',
      trigger: 'executor_error',
      reason: { kind: 'executor_error', error: 'boom' },
    });
  });

  it('classifies an operator revert, surfacing a string reason as the operator notes', () => {
    const transitions = [tr({ fromState: 'needs_human', toState: 'plan', trigger: 'revert', reason: 'scope this down to the API only' })];
    expect(reentryContext(transitions, 'plan')).toEqual({
      kind: 'operator_revert',
      trigger: 'revert',
      operatorNotes: 'scope this down to the API only',
    });
  });

  it('classifies an agent back-edge with its structured reason', () => {
    const transitions = [tr({ fromState: 'plan_review', toState: 'plan', trigger: 'request_changes', backEdge: true, reason: { kind: 'plan_changes', issues: ['missing rollout plan'] } })];
    expect(reentryContext(transitions, 'plan')).toEqual({
      kind: 'back_edge',
      trigger: 'request_changes',
      reason: { kind: 'plan_changes', issues: ['missing rollout plan'] },
    });
  });

  it('is undefined for an await_input re-arm (triage reads the reply from the issue thread instead)', () => {
    const transitions = [tr({ fromState: 'triage', toState: 'triage', trigger: 'await_input', reason: { kind: 'needs_more_detail' } })];
    expect(reentryContext(transitions, 'triage')).toBeUndefined();
  });
});

describe('AgentRunner — re-entry context delivery', () => {
  it('injects the escalation reason + operator notes into every phase input of the resumed stage', async () => {
    const seen: Record<string, unknown>[] = [];
    const { repo, runner, run } = setup((req) => {
      seen.push(req.input as Record<string, unknown>);
      return req.phase === 'self_review' ? { output: { acceptable: true } } : { output: { requestedTransition: 'proceed' } };
    });
    repo.commitTransition({
      runId: run.id,
      fromState: 'plan',
      toState: 'needs_human',
      trigger: 'internal_review_cap',
      reason: { kind: 'internal_review_cap', cap: 2, notes: { issues: ['naming is wrong'] } },
      status: 'needs_human',
    });
    repo.commitTransition({
      runId: run.id,
      fromState: 'needs_human',
      toState: 'plan',
      trigger: 'resume',
      reason: { kind: 'operator_resume', notes: 'rename per the review' },
      isReset: true,
      status: 'running',
    });

    await runner.runStage(run);

    expect(seen.length).toBeGreaterThan(1);
    for (const input of seen) {
      expect(input.reentry).toEqual({
        kind: 'operator_resume',
        trigger: 'internal_review_cap',
        reason: { kind: 'internal_review_cap', cap: 2, notes: { issues: ['naming is wrong'] } },
        operatorNotes: 'rename per the review',
      });
    }
  });

  it('omits the reentry field entirely on a first visit', async () => {
    const seen: Record<string, unknown>[] = [];
    const { runner, run } = setup((req) => {
      seen.push(req.input as Record<string, unknown>);
      return req.phase === 'self_review' ? { output: { acceptable: true } } : { output: { requestedTransition: 'proceed' } };
    });

    await runner.runStage(run);

    expect(seen.length).toBeGreaterThan(0);
    for (const input of seen) expect('reentry' in input).toBe(false);
  });
});

describe('AgentRunner.resolveConflicts (standalone dedicated resolver)', () => {
  it('up to date → resolved with no agent call and no push', async () => {
    const { runner, run, github } = setup(goldenPathHandler);
    const before = github.commitCount();
    const outcome = await runner.resolveConflicts(run); // fake default sync = up_to_date
    expect(outcome).toEqual({ kind: 'resolved' });
    expect(github.commitCount()).toBe(before); // nothing pushed
  });

  it('a clean base merge is pushed (no later stage will), then resolved', async () => {
    const { runner, run, github } = setup(goldenPathHandler);
    github.queueBaseSync({ result: 'merged', conflictFiles: [] });
    const before = github.commitCount();
    const outcome = await runner.resolveConflicts(run);
    expect(outcome).toEqual({ kind: 'resolved' });
    expect(github.commitCount()).toBe(before + 1); // commitAndPush pushed the clean merge
  });

  it('pre-approves the resolver’s edit tools (Edit/Write, no Bash) so a headless run never stalls on a prompt', async () => {
    let resolverReq: AgentRunRequest | undefined;
    const { runner, run, github } = setup((req) => {
      if (req.stage === 'resolve_conflicts') resolverReq = req;
      return goldenPathHandler(req);
    });
    github.queueBaseSync({ result: 'conflict', conflictFiles: ['x.ts'] });
    await runner.resolveConflicts(run);

    expect(resolverReq?.allowedTools).toContain('Edit');
    expect(resolverReq?.allowedTools).toContain('Write');
    expect(resolverReq?.allowedTools).not.toContain('Bash'); // must not disturb the in-progress merge
  });

  it('a conflict runs the resolver + finish; a verification miss escalates with the evidence (tree aborted)', async () => {
    const { runner, run, github } = setup(goldenPathHandler);
    github.queueBaseSync({ result: 'conflict', conflictFiles: ['x.ts'] });
    github.finishBaseMergeResult = { ok: false, unresolved: ['x.ts'] };
    const outcome = await runner.resolveConflicts(run);
    expect(outcome).toMatchObject({ kind: 'escalate', reason: { kind: 'merge_conflict', resolutionAttempted: true, unresolved: ['x.ts'] } });
    expect(github.abortedMerges).toEqual([run.id]);
  });
});

describe('AgentRunner — run chat (the operator side channel)', () => {
  const chatReply = (text: string): StubHandler => () => ({ output: { response: text }, tokens: 7, cost: 0.02 });

  function chatExchange(repo: Repository, run: Run, prompt: string, mode: 'read' | 'write') {
    const exchange = repo.createChatExchange({ runId: run.id, prompt, mode });
    // The orchestrator's pump claims before running; mirror that so the runner sees a `running` row.
    repo.setRunStatus(run.id, mode === 'write' ? 'paused' : run.status);
    return repo.claimNextChatExchange() ?? exchange;
  }

  it('read mode: answers with the read-only tool grant, in the run tree, without committing', async () => {
    const requests: AgentRunRequest[] = [];
    const { repo, runner, run, github } = setup((req) => {
      requests.push(req);
      return { output: { response: 'The PR adds a retry loop.' }, tokens: 7, cost: 0.02 };
    });
    const exchange = chatExchange(repo, run, 'what does the PR change?', 'read');

    const result = await runner.runChat(run, exchange);

    expect(result).toEqual({ response: 'The PR adds a retry loop.', tokens: 7 });
    const req = requests[0]!;
    expect(req.stage).toBe('chat');
    expect(req.phase).toBe('produce');
    expect(req.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)']);
    expect(req.workingDir).toBeTruthy(); // never the daemon's own cwd (the M12 rule)
    expect((req.input as { chat: { mode: string; prompt: string } }).chat).toMatchObject({ mode: 'read', prompt: 'what does the PR change?' });
    // No write happened: nothing was committed to the fake.
    expect(await github.readDiff({ workingDir: req.workingDir!, base: 'main', branch: repo.getRun(run.id)!.branch! })).toBe('');
  });

  it('write mode: grants edit tools, then commits and pushes the tree with the prompt as message', async () => {
    const requests: AgentRunRequest[] = [];
    const { repo, runner, run, github } = setup((req) => {
      requests.push(req);
      return { output: { response: 'Fixed the build.' }, tokens: 9 };
    });
    const exchange = chatExchange(repo, run, 'fix the failing build', 'write');

    const result = await runner.runChat(repo.getRun(run.id)!, exchange);

    expect(result.response).toBe('Fixed the build.');
    expect(result.commitSha).toMatch(/^fakesha/);
    expect(requests[0]!.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
    // The commit landed in the run's tree under the chat message.
    const diff = await github.readDiff({ workingDir: requests[0]!.workingDir!, base: 'main', branch: repo.getRun(run.id)!.branch! });
    expect(diff).toContain('[agent] chat: fix the failing build');
  });

  it('records chat telemetry and charges tokens/cost but never the run budget (agentRuns)', async () => {
    const { repo, runner, run } = setup(chatReply('ok'));
    const exchange = chatExchange(repo, run, 'q', 'read');

    await runner.runChat(run, exchange);

    const records = repo.listAgentRuns(run.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ stage: 'chat', phase: 'produce', tokens: 7, success: true });
    const after = repo.getRun(run.id)!;
    expect(after.tokensUsed).toBe(7);
    expect(after.costUsed).toBeCloseTo(0.02);
    expect(after.agentRunsCount).toBe(0); // chat spend must not eat the pipeline's stage budget
  });

  it('hands the run model override + prior completed exchanges to the invocation', async () => {
    const requests: AgentRunRequest[] = [];
    const { repo, runner, run } = setup((req) => {
      requests.push(req);
      return { output: { response: 'again: 42' } };
    });
    repo.setRunModelOverride(run.id, 'sonnet');
    // A finished earlier exchange becomes conversation history; queued/cancelled ones never do.
    const prior = repo.createChatExchange({ runId: run.id, prompt: 'what is 6×7?', mode: 'read' });
    repo.claimNextChatExchange();
    repo.completeChatExchange(prior.id, { response: '42' });
    repo.cancelChatExchange(repo.createChatExchange({ runId: run.id, prompt: 'never ran', mode: 'read' }).id);
    const exchange = chatExchange(repo, run, 'say it again', 'read');

    await runner.runChat(repo.getRun(run.id)!, exchange);

    expect(requests[0]!.model).toBe('sonnet');
    const chat = (requests[0]!.input as { chat: { history: unknown[] } }).chat;
    expect(chat.history).toEqual([{ mode: 'read', prompt: 'what is 6×7?', response: '42' }]);
  });

  it('records a failed invocation and rethrows so the pump can fail the exchange', async () => {
    const { repo, runner, run } = setup(() => {
      throw new Error('harness exploded');
    });
    const exchange = chatExchange(repo, run, 'q', 'read');

    await expect(runner.runChat(run, exchange)).rejects.toThrow('harness exploded');
    const records = repo.listAgentRuns(run.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ stage: 'chat', success: false });
  });
});

describe('chatResponseText + chatCommitMessage (pure)', () => {
  it('prefers the contract shape, falls back to plain text, and shows anything else as JSON', () => {
    expect(chatResponseText({ response: '  All green. ' })).toBe('All green.');
    expect(chatResponseText('plain words')).toBe('plain words');
    expect(chatResponseText({ acceptable: true })).toBe('{\n  "acceptable": true\n}');
  });

  it('bounds the commit subject to the prompt’s first line', () => {
    expect(chatCommitMessage('fix the build\nand more detail')).toBe('[agent] chat: fix the build');
    const long = 'x'.repeat(100);
    expect(chatCommitMessage(long)).toBe(`[agent] chat: ${'x'.repeat(71)}…`);
  });
});
