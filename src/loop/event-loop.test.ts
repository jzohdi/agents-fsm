/**
 * Event Loop integration tests (Milestone 2): drive whole runs on stub agents and assert
 * the orchestration mechanism — exact transition sequences, the skip branch, back-edge
 * guard escalation, crash recovery (idempotency), and the loop-owned guards.
 */

import { describe, expect, it, vi } from 'vitest';

import { loadDefaultConfig } from '../fsm/config';
import type { FsmConfig } from '../fsm/types';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { AgentRunner } from '../agent/runner';
import {
  StubExecutor,
  goldenPathHandler,
  FatalExecutorError,
  type AgentRunRequest,
  type AgentRunResult,
  type StageExecutor,
  type StubHandler,
} from '../agent/executor';
import { FakeGitHub } from '../integration/github-fake';
import { ADDRESSING_PR_FEEDBACK_FLAG, EVENT_ADVANCE, EventLoop, PR_FEEDBACK_TRIGGER, type EventLoopOptions } from './event-loop';

function setup(handler: StubHandler, opts: EventLoopOptions = {}, fsmOverride?: (fsm: FsmConfig) => FsmConfig) {
  const loaded = loadDefaultConfig();
  const fsm = fsmOverride ? fsmOverride(loaded.fsm) : loaded.fsm;
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ autoSeedIssues: true });
  const runner = new AgentRunner(repo, new StubExecutor(handler), loaded.agents, github);
  const loop = new EventLoop(repo, fsm, loaded.version, runner, opts);
  return { repo, loop, fsm, github, runner };
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

    // The working-tree lifecycle ran: the branch was created (at plan) and the PR opened (at tdd).
    expect(finalRun.branch).toMatch(new RegExp(`^agent/run-${run.id}-[0-9a-f]{6}$`)); // id + unique suffix
    expect(finalRun.prNumber).not.toBeNull();

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

    const artifacts = repo.listArtifacts(run.id);
    // plan, interface, and the PR (from tdd) are all recorded from their envelopes.
    expect(artifacts.map((a) => a.kind)).toEqual(['plan', 'interface', 'pr']);
    // Locators carry the runner's real branch/sha enrichment and the opened PR number.
    const plan = artifacts.find((a) => a.kind === 'plan')!;
    expect((plan.locator as { branch: string }).branch).toMatch(new RegExp(`^agent/run-${run.id}-[0-9a-f]{6}$`));
    expect(plan.locator).toHaveProperty('sha');
    expect(artifacts.find((a) => a.kind === 'pr')!.locator).toHaveProperty('number');
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

  it('recovering a post-commit crash on a triage clarify does not re-ask or duplicate the park', async () => {
    let triageProduces = 0;
    const { repo, loop, github } = setup((req) => {
      if (req.stage === 'triage' && req.phase === 'produce') triageProduces += 1;
      return req.stage === 'triage' ? { output: { decision: 'clarify', questions: ['which db?'] } } : goldenPathHandler(req);
    });

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });

    // Crash window: claim + apply (the park commits) but never finalize the event.
    const event = repo.claimNextEvent()!;
    await loop.applyEvent(event);
    expect(triageProduces).toBe(1);
    expect(repo.getRun(run.id)!.status).toBe('awaiting_input');
    expect(repo.getTransitionByEventId(event.id)).toBeDefined();

    // Restart: the reclaimed event must finalize against the existing transition, not re-run triage.
    expect(loop.recover()).toBe(1);
    await loop.runUntilIdle();

    expect(triageProduces).toBe(1); // not re-asked
    expect(repo.listTransitions(run.id).filter((t) => t.trigger === 'await_input')).toHaveLength(1);
    expect((await github.listIssueComments(1)).length).toBe(1); // exactly one question comment
  });

  it('recovering a PRE-commit crash on a triage split does not duplicate sub-issues or the comment', async () => {
    // The transactional outbox (README Milestone 7) regression test: triage split posts a comment and
    // creates sub-issues — both non-idempotent. A crash *after* those calls but *before* the loop
    // commits the transition leaves the event to be replayed, re-running the whole stage.
    const { repo, loop, github, runner } = setup((req) =>
      req.stage === 'triage'
        ? { output: { decision: 'split', subIssues: [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }] } }
        : goldenPathHandler(req),
    );
    const createIssue = vi.spyOn(github, 'createIssue');
    const postIssueComment = vi.spyOn(github, 'postIssueComment');

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });

    // Crash window: the loop claims the event and the stage performs its GitHub side effects (recorded
    // in the outbox), then the daemon dies before committing the transition — the event stays
    // `processing`, the transition log is empty.
    const event = repo.claimNextEvent()!;
    await runner.runStage(repo.getRun(run.id)!);
    expect(createIssue).toHaveBeenCalledTimes(2);
    expect(postIssueComment).toHaveBeenCalledTimes(1);
    expect(repo.getTransitionByEventId(event.id)).toBeUndefined(); // nothing committed

    // Restart: reclaim the stranded event and drain. triage re-runs, but every non-idempotent call
    // replays from the outbox — so NO duplicate sub-issues and NO duplicate comment.
    expect(loop.recover()).toBe(1);
    await loop.runUntilIdle();

    expect(createIssue).toHaveBeenCalledTimes(2); // not 4
    expect(postIssueComment).toHaveBeenCalledTimes(1); // not 2
    // A no-handoff split escalates `should_split`, exactly once.
    const finalRun = repo.getRun(run.id)!;
    expect(finalRun.status).toBe('needs_human');
    expect(repo.listTransitions(run.id).filter((t) => t.trigger === 'should_split')).toHaveLength(1);
  });

  it('a partial_side_effect escalation is resolved by resume (fresh visit), not re-escalated forever', async () => {
    // The critical no-infinite-loop property of the visit-index outbox: a slot left `pending` by a
    // crash escalates partial_side_effect; resume re-enters the stage at a NEW visit (fresh keys), so
    // the retry performs cleanly instead of re-hitting the stale pending row and escalating again.
    const { repo, loop } = setup((req) => (req.stage === 'triage' ? { output: { decision: 'proceed' } } : goldenPathHandler(req)));

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    // Simulate a crash mid-signoff: the visit-0 slot was claimed but never completed.
    repo.beginSideEffect(run.id, 'triage#0:signoff');

    await loop.runUntilIdle();
    expect(repo.getRun(run.id)!.status).toBe('needs_human');
    expect(repo.listTransitions(run.id).at(-1)!.trigger).toBe('partial_side_effect');

    // Operator verifies GitHub, removes any partial artifact, and resumes → a clean retry at visit 1.
    loop.resumeRun(run.id);
    await loop.runUntilIdle();

    // The run advanced past triage to done — it did not get stuck re-escalating on the stale slot.
    expect(repo.getRun(run.id)!.status).toBe('done');
    expect(repo.listTransitions(run.id).filter((t) => t.trigger === 'partial_side_effect')).toHaveLength(1);
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
    // `plan` (not triage) is the producing stage here: it emits the generic work envelope, so an
    // unknown `requestedTransition` exercises the engine's legality check (triage has its own contract).
    const handler: StubHandler = (req) =>
      req.stage === 'plan' && req.phase === 'produce'
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

  it('parks a run with a git_error trigger when a stage side effect fails', async () => {
    const { repo, loop, github } = setup(goldenPathHandler);
    github.commitAndPush = () => Promise.reject(new Error('push rejected'));

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle(); // must not throw

    const finalRun = repo.getRun(run.id)!;
    expect(finalRun.status).toBe('needs_human');
    const last = repo.listTransitions(run.id).at(-1)!;
    expect(last.trigger).toBe('git_error'); // labeled cause, not a generic escalation
    expect(last.fromState).toBe('plan'); // the first produce stage that commits
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

  it('resumes a parked run from where it escalated and drives it to done', async () => {
    let failed = false;
    const handler: StubHandler = (req) => {
      if (req.stage === 'plan' && req.phase === 'produce' && !failed) {
        failed = true;
        throw new Error('transient harness failure');
      }
      return goldenPathHandler(req);
    };
    const { repo, loop } = setup(handler);

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    // It parked in needs_human, having escalated from plan.
    expect(repo.getRun(run.id)!.status).toBe('needs_human');
    expect(repo.listTransitions(run.id).at(-1)!.fromState).toBe('plan');

    // Resume: plan now succeeds, and the run completes.
    loop.resumeRun(run.id);
    await loop.runUntilIdle();

    const finalRun = repo.getRun(run.id)!;
    expect(finalRun.currentState).toBe('done');
    expect(finalRun.status).toBe('done');
    // The resume is recorded as a manual transition (needs_human → plan) with no event id.
    const resumeT = repo.listTransitions(run.id).find((t) => t.trigger === 'resume')!;
    expect(resumeT).toMatchObject({ fromState: 'needs_human', toState: 'plan', eventId: null, isReset: true });
    expect(resumeT.reason).toBeNull(); // a plain resume carries no operator guidance
  });

  it('records operator notes on a guided resume, and the retried stage receives them as re-entry context', async () => {
    const seen: Record<string, unknown>[] = [];
    let failed = false;
    const handler: StubHandler = (req) => {
      seen.push(req.input as Record<string, unknown>);
      if (req.stage === 'plan' && req.phase === 'produce' && !failed) {
        failed = true;
        throw new Error('transient harness failure');
      }
      return goldenPathHandler(req);
    };
    const { repo, loop } = setup(handler);

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();
    expect(repo.getRun(run.id)!.status).toBe('needs_human');

    loop.resumeRun(run.id, { notes: 'the harness hiccuped — retry, nothing to change' });
    await loop.runUntilIdle();
    expect(repo.getRun(run.id)!.status).toBe('done');

    // One record serves both: the audit trail on the resume transition…
    const resumeT = repo.listTransitions(run.id).find((t) => t.trigger === 'resume')!;
    expect(resumeT.reason).toEqual({ kind: 'operator_resume', notes: 'the harness hiccuped — retry, nothing to change' });
    // …and the delivered `reentry` input on the retried stage (escalation cause + the operator's words).
    const retried = seen.find((input) => input.reentry !== undefined)!;
    expect(retried.reentry).toMatchObject({
      kind: 'operator_resume',
      trigger: 'executor_error',
      operatorNotes: 'the harness hiccuped — retry, nothing to change',
    });
  });

  it('restores a fresh round budget when resuming after a round-limit escalation', async () => {
    const handler: StubHandler = (req) =>
      req.stage === 'code_review'
        ? { output: { requestedTransition: 'request_changes', target: 'backend', reason: { note: 'again' } } }
        : goldenPathHandler(req);
    const { repo, loop, fsm } = setup(handler);
    const limit = fsm.guards.code_review!;

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    const countBackEdges = () =>
      repo.listTransitions(run.id).filter((t) => t.backEdge && t.counterKey === 'code_review').length;
    expect(repo.getRun(run.id)!.status).toBe('needs_human');
    expect(countBackEdges()).toBe(limit);

    // Resume: the counter reset gives code_review another full `limit` rounds before re-escalating.
    loop.resumeRun(run.id);
    await loop.runUntilIdle();

    expect(repo.getRun(run.id)!.status).toBe('needs_human');
    expect(countBackEdges()).toBe(2 * limit);
  });

  it('refuses to resume a run that is not needs_human', () => {
    const { repo, loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    expect(() => loop.resumeRun(run.id)).toThrowError(/not needs_human/);
    expect(repo.getRun(run.id)!.currentState).toBe('triage'); // unchanged
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

describe('triage clarify → awaiting_input → resume', () => {
  /** A handler whose triage clarifies on the first pass, then proceeds; other stages golden-path. */
  function clarifyOnceThenProceed(): StubHandler {
    let clarified = false;
    return (req) => {
      if (req.stage === 'triage') {
        if (!clarified) {
          clarified = true;
          return { output: { decision: 'clarify', questions: ['which database?'] } };
        }
        return { output: { decision: 'proceed' } };
      }
      return goldenPathHandler(req);
    };
  }

  it('parks the run in awaiting_input via a self-transition, with no event left to dispatch', async () => {
    const { repo, loop } = setup((req) =>
      req.stage === 'triage' ? { output: { decision: 'clarify', questions: ['which database?'] } } : goldenPathHandler(req),
    );
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    const parked = repo.getRun(run.id)!;
    expect(parked.status).toBe('awaiting_input');
    expect(parked.currentState).toBe('triage'); // stays put; a reply re-runs triage
    const last = repo.listTransitions(run.id).at(-1)!;
    expect([last.fromState, last.trigger, last.toState]).toEqual(['triage', 'await_input', 'triage']);
    expect(last.eventId).not.toBeNull(); // keyed to its event (at-least-once safe)
    // The run holds no executor: nothing is dispatchable while it is awaiting_input.
    expect(await loop.tick()).toBe(false);
  });

  it('resumeAwaitingInput re-arms the run and re-runs triage, which now proceeds to done', async () => {
    const { repo, loop } = setup(clarifyOnceThenProceed());
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();
    expect(repo.getRun(run.id)!.status).toBe('awaiting_input');

    loop.resumeAwaitingInput(run.id);
    await loop.runUntilIdle();

    const final = repo.getRun(run.id)!;
    expect(final.status).toBe('done');
    expect(final.currentState).toBe('done');
    // triage ran twice (clarify, then proceed); the second produced the forward transition to plan.
    const triageProceed = repo.listTransitions(run.id).find((t) => t.fromState === 'triage' && t.toState === 'plan');
    expect(triageProceed).toBeTruthy();
  });

  it('refuses to re-arm a run that is not awaiting_input', () => {
    const { loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    expect(() => loop.resumeAwaitingInput(run.id)).toThrowError(/not awaiting_input/);
  });
});

describe('M5 control methods (pause / resume-paused / stop / revert)', () => {
  it('pause halts the next dispatch; resume re-arms the parked event', async () => {
    const { repo, loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.tick(); // process exactly one event (triage → plan), leaving a pending advance event

    const paused = loop.pauseRun(run.id);
    expect(paused.status).toBe('paused');
    await loop.runUntilIdle(); // the dispatch gate refuses the parked event while paused
    expect(repo.getRun(run.id)!.currentState).toBe('plan'); // did not advance

    loop.resumePausedRun(run.id);
    await loop.runUntilIdle();
    expect(repo.getRun(run.id)!.status).toBe('done');
  });

  it('honors a pause that lands during a stage (the stage finishes, dispatch stops)', async () => {
    const holder: { loop?: EventLoop } = {};
    const handler: StubHandler = (req) => {
      if (req.stage === 'plan' && req.phase === 'produce') holder.loop!.pauseRun(req.runId);
      return goldenPathHandler(req);
    };
    const { repo, loop } = setup(handler);
    holder.loop = loop;

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    const parked = repo.getRun(run.id)!;
    expect(parked.status).toBe('paused'); // the in-flight commit honored the pause
    expect(parked.currentState).toBe('plan_review'); // plan still committed its transition
  });

  it('stop discards a parked run\'s pending follow-up event (no stale queue entry)', async () => {
    // Park paused mid-`plan` so a pending advance event is left in the queue, then stop.
    const holder: { loop?: EventLoop } = {};
    const handler: StubHandler = (req) => {
      if (req.stage === 'plan' && req.phase === 'produce') holder.loop!.pauseRun(req.runId);
      return goldenPathHandler(req);
    };
    const { repo, loop } = setup(handler);
    holder.loop = loop;

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();
    expect(repo.getRun(run.id)!.status).toBe('paused'); // a pending follow-up event exists

    loop.stopRun(run.id);
    // Force the gate open: if the event had only been *gated* (not discarded) it would now be claimed.
    repo.setRunStatus(run.id, 'running');
    expect(await loop.tick()).toBe(false); // nothing to claim — the pending event was discarded
  });

  it('stop is terminal: the stage finishes but no follow-up event is enqueued', async () => {
    const holder: { loop?: EventLoop } = {};
    const handler: StubHandler = (req) => {
      if (req.stage === 'plan' && req.phase === 'produce') holder.loop!.stopRun(req.runId);
      return goldenPathHandler(req);
    };
    const { repo, loop } = setup(handler);
    holder.loop = loop;

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    expect(repo.getRun(run.id)!.status).toBe('stopped');
    expect(() => loop.stopRun(run.id)).toThrowError(/already "stopped"/);
    expect(() => loop.resumePausedRun(run.id)).toThrowError(/not paused/);
  });

  it('revert moves a parked run to an earlier state with a reset, discarding the stale follow-up event', async () => {
    // Park paused mid-`plan` so the run carries a leftover pending event, then revert.
    const holder: { loop?: EventLoop } = {};
    const handler: StubHandler = (req) => {
      if (req.stage === 'plan' && req.phase === 'produce') holder.loop!.pauseRun(req.runId);
      return goldenPathHandler(req);
    };
    const { repo, loop } = setup(handler);
    holder.loop = loop;

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();
    expect(repo.getRun(run.id)!.status).toBe('paused');

    loop.revertRun(run.id, 'plan', { note: 'redo the plan' });
    // The stale follow-up event was cancelled, so exactly one advance event drives the revert.
    await loop.runUntilIdle();

    const revert = repo.listTransitions(run.id).find((t) => t.trigger === 'revert')!;
    expect(revert).toMatchObject({ toState: 'plan', isReset: true, eventId: null });
    // plan re-pauses (the handler still fires), so the run parks again — proving the single clean event.
    expect(repo.getRun(run.id)!.status).toBe('paused');
    expect(repo.getRun(run.id)!.currentState).toBe('plan_review');
  });

  it('revert resets the round counters (a fresh budget for the reverted-to loop)', () => {
    const { repo, loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    // Seed a round counter; the run is `running` with only a pending (not processing) event, so revert
    // is allowed. This isolates the reset effect on the derived counters (README M7 needs_human UX).
    repo.appendTransition({ runId: run.id, fromState: 'code_review', toState: 'backend', trigger: 'request_changes', backEdge: true, counterKey: 'code_review' });
    expect(repo.computeCounters(run.id)).toEqual({ code_review: 1 });

    loop.revertRun(run.id, 'plan', { note: 'redo the plan' });

    // The reset transition zeroes the derived counter immediately — the next loop starts fresh.
    expect(repo.computeCounters(run.id)).toEqual({ code_review: 0 });
  });

  it('refuses to revert while a stage is in flight (would race the committing stage)', () => {
    const { repo, loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    repo.claimNextEvent(); // the run's event is now `processing` — a stage is mid-flight
    expect(() => loop.revertRun(run.id, 'plan', { note: 'x' })).toThrowError(/in flight/);
  });

  it('validates control inputs', () => {
    const { loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    expect(() => loop.pauseRun(999)).toThrowError(/not found/);
    expect(() => loop.resumePausedRun(run.id)).toThrowError(/not paused/); // it's running
    expect(() => loop.revertRun(run.id, 'plan', '')).toThrowError(/reason is required/);
    expect(() => loop.revertRun(run.id, 'ghost', { note: 'x' })).toThrowError(/unknown state/);
    expect(() => loop.revertRun(run.id, 'done', { note: 'x' })).toThrowError(/terminal/);
  });
});

describe('bounded worker pool (Milestone 8 Phase B — drain concurrency)', () => {
  /**
   * A stage executor that stays in flight for a macrotask, so multiple stages genuinely overlap under
   * the pool, and records the peak concurrency both globally and per run. `perRunPeak` is the safety
   * witness: within-run serialization means it must never exceed 1 (two stages of one run overlapping
   * would corrupt the shared working tree / state cursor). It otherwise drives the golden path.
   */
  class PoolExecutor implements StageExecutor {
    active = 0;
    peak = 0;
    perRunPeak = 0;
    private readonly activeByRun = new Map<number, number>();

    async run(req: AgentRunRequest): Promise<AgentRunResult> {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      const perRun = (this.activeByRun.get(req.runId) ?? 0) + 1;
      this.activeByRun.set(req.runId, perRun);
      this.perRunPeak = Math.max(this.perRunPeak, perRun);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const reply = goldenPathHandler(req);
        return { output: reply.output, usage: { tokens: reply.tokens ?? 1 } };
      } finally {
        this.active -= 1;
        this.activeByRun.set(req.runId, (this.activeByRun.get(req.runId) ?? 1) - 1);
      }
    }
  }

  function poolSetup() {
    const loaded = loadDefaultConfig();
    const repo = new Repository(openDb(':memory:'));
    const executor = new PoolExecutor();
    const runner = new AgentRunner(repo, executor, loaded.agents, new FakeGitHub({ autoSeedIssues: true }));
    const loop = new EventLoop(repo, loaded.fsm, loaded.version, runner);
    return { repo, loop, executor };
  }

  it('runs stages in parallel across runs, serial within a run, each event exactly once', async () => {
    const { repo, loop, executor } = poolSetup();
    const runs = Array.from({ length: 5 }, (_, i) => loop.startRun({ issueRef: `o/r#${i + 1}`, repoRef: 'o/r' }));

    await loop.drain(3);

    // Every run completed on a clean golden path: a duplicate-processed event would show as a re-run
    // or (blocked by the UNIQUE event-id index) a missing transition — neither happens.
    for (const run of runs) {
      expect(repo.getRun(run.id)!.status).toBe('done');
      expect(sequence(repo, run.id)).toEqual(GOLDEN_PATH);
    }
    expect(executor.peak).toBeGreaterThan(1); // genuinely parallel, not accidentally serial
    expect(executor.peak).toBeLessThanOrEqual(3); // never exceeds the global cap
    expect(executor.perRunPeak).toBe(1); // serial within a run — two stages of one run never overlap
  });

  it('clamps an invalid cap (0 / negative / non-finite) to serial rather than wedging or ignoring it', async () => {
    for (const badCap of [0, -3, NaN, Infinity]) {
      const { repo, loop, executor } = poolSetup();
      const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
      await loop.drain(badCap); // must terminate (a NaN cap would otherwise dispatch nothing forever)
      expect(repo.getRun(run.id)!.status).toBe('done');
      expect(executor.peak).toBe(1); // treated as serial
    }
  });

  it('drain(1) is exactly the serial drain — never more than one stage at a time', async () => {
    const { repo, loop, executor } = poolSetup();
    const a = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    const b = loop.startRun({ issueRef: 'o/r#2', repoRef: 'o/r' });

    await loop.drain(1);

    expect(executor.peak).toBe(1);
    expect(repo.getRun(a.id)!.status).toBe('done');
    expect(repo.getRun(b.id)!.status).toBe('done');
  });

  it('a fatal executor error rejects the pooled drain (in-flight settles, work stays recoverable)', async () => {
    const repo = new Repository(openDb(':memory:'));
    const { fsm, agents, version } = loadDefaultConfig();
    const executor: StageExecutor = {
      run: () => Promise.reject(new FatalExecutorError('harness not authenticated', 'run `claude login`')),
    };
    const runner = new AgentRunner(repo, executor, agents, new FakeGitHub({ autoSeedIssues: true }));
    const loop = new EventLoop(repo, fsm, version, runner);
    const a = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    const b = loop.startRun({ issueRef: 'o/r#2', repoRef: 'o/r' });

    await expect(loop.drain(3)).rejects.toBeInstanceOf(FatalExecutorError);

    // Neither run escalated; both claimed events are left `processing` → reclaimable on restart.
    expect(repo.getRun(a.id)!.status).toBe('running');
    expect(repo.getRun(b.id)!.status).toBe('running');
    expect(repo.listTransitions(a.id)).toHaveLength(0);
    expect(loop.recover()).toBe(2);
  });

  it('aborts (does not hang) when the claim throws mid-drain — a DB error rejects the drain', async () => {
    const { repo, loop } = poolSetup();
    loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });

    // First claim serves the run's event; a later claim (fired from a worker's completion) throws, the
    // way a broken DB would. The throw must reject the drain, not escape into the voided worker promise
    // and wedge it — the vitest timeout would fail this test if `drain` ever hung.
    const realClaim = repo.claimNextEvent.bind(repo);
    let claims = 0;
    vi.spyOn(repo, 'claimNextEvent').mockImplementation(() => {
      claims += 1;
      if (claims === 1) return realClaim();
      throw new Error('database is locked');
    });

    await expect(loop.drain(2)).rejects.toThrow(/database is locked/);
  });
});

describe('global cost ceiling + per-run overrides (Milestone 8 Phase B — B3)', () => {
  /** Golden path where every `produce` phase costs $1, so a run accrues ~$1 per stage. */
  const costlyHandler: StubHandler = (req) => (req.phase === 'produce' ? { ...goldenPathHandler(req), cost: 1 } : goldenPathHandler(req));

  function costSetup(costCeiling: number) {
    const loaded = loadDefaultConfig();
    const repo = new Repository(openDb(':memory:'));
    const runner = new AgentRunner(repo, new StubExecutor(costlyHandler), loaded.agents, new FakeGitHub({ autoSeedIssues: true }));
    const loop = new EventLoop(repo, loaded.fsm, loaded.version, runner, { costCeiling });
    return { repo, loop };
  }

  it('parks a run mid-pipeline once the aggregate cost reaches the ceiling', async () => {
    const { repo, loop } = costSetup(2); // ceiling $2; each stage costs ~$1
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });

    await loop.drain(1);

    // It advanced only while under the ceiling, then parked (still running, not done, no override).
    const parked = repo.getRun(run.id)!;
    expect(parked.status).toBe('running');
    expect(parked.currentState).not.toBe('done');
    expect(parked.costUsed).toBeGreaterThanOrEqual(2);
    expect(parked.costOverride).toBeNull();
  });

  it("'full' override runs a parked run to completion despite the ceiling", async () => {
    const { repo, loop } = costSetup(2);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.drain(1);
    expect(repo.getRun(run.id)!.currentState).not.toBe('done'); // parked

    repo.setCostOverride(run.id, 'full');
    await loop.drain(1);

    expect(repo.getRun(run.id)!.status).toBe('done'); // ran to completion ignoring the ceiling
  });

  it("'next_step' override advances exactly one stage, then re-parks (override consumed)", async () => {
    const { repo, loop } = costSetup(2);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.drain(1);
    const parkedAt = repo.getRun(run.id)!.currentState;

    repo.setCostOverride(run.id, 'next_step');
    await loop.drain(1);

    const after = repo.getRun(run.id)!;
    expect(after.currentState).not.toBe(parkedAt); // advanced one stage
    expect(after.status).toBe('running');
    expect(after.currentState).not.toBe('done'); // then re-parked (not run to completion)
    expect(after.costOverride).toBeNull(); // the one-shot override was consumed
  });

  it('does not gate anything while under the ceiling', async () => {
    const { repo, loop } = costSetup(1000); // effectively no ceiling
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.drain(2);
    expect(repo.getRun(run.id)!.status).toBe('done');
  });

  it('gates under the worker pool: over the ceiling only an overridden run advances (drain N)', async () => {
    const { repo, loop } = costSetup(2);
    const runs = [
      loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' }),
      loop.startRun({ issueRef: 'o/r#2', repoRef: 'o/r' }),
      loop.startRun({ issueRef: 'o/r#3', repoRef: 'o/r' }),
    ];

    await loop.drain(3);
    // The fleet parked at the ceiling — every run is still running, none reached done.
    for (const r of runs) expect(repo.getRun(r.id)!.status).toBe('running');
    expect(repo.listRuns().some((r) => r.currentState === 'done')).toBe(false);
    expect(repo.sumActiveCost()).toBeGreaterThanOrEqual(2);

    // Override one run to completion; under the pool only it advances to done, the others stay parked.
    repo.setCostOverride(runs[0]!.id, 'full');
    await loop.drain(3);
    expect(repo.getRun(runs[0]!.id)!.status).toBe('done');
    expect(repo.getRun(runs[1]!.id)!.currentState).not.toBe('done');
    expect(repo.getRun(runs[2]!.id)!.currentState).not.toBe('done');
  });
});

describe('fatal executor error aborts the drain (does not escalate one run)', () => {
  it('propagates the error and leaves the run running + the event recoverable', async () => {
    const repo = new Repository(openDb(':memory:'));
    const { fsm, agents, version } = loadDefaultConfig();
    // A FatalExecutorError means "no run can proceed" (e.g. the harness is unauthenticated).
    const executor: StageExecutor = {
      run: () => Promise.reject(new FatalExecutorError('harness not authenticated', 'run `claude login`')),
    };
    const runner = new AgentRunner(repo, executor, agents, new FakeGitHub({ autoSeedIssues: true }));
    const loop = new EventLoop(repo, fsm, version, runner);

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });

    // The drain aborts by propagating the fatal error, rather than parking the run in needs_human.
    await expect(loop.runUntilIdle()).rejects.toBeInstanceOf(FatalExecutorError);

    const after = repo.getRun(run.id)!;
    expect(after.status).toBe('running'); // NOT escalated
    expect(after.currentState).toBe('triage'); // still at the first stage
    expect(repo.listTransitions(run.id)).toHaveLength(0); // no escalation transition written
    // The claimed event was left `processing`, so a restart reclaims it → fix-and-rerun resumes.
    expect(loop.recover()).toBe(1);
  });
});

describe('reopenForPrFeedback (PR feedback re-entry)', () => {
  /** Drive a fresh run to `done` on the golden path (so it has an open PR), returning the harness. */
  async function toDone(opts: EventLoopOptions = {}) {
    const h = setup(goldenPathHandler, opts);
    const run = h.loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await h.loop.runUntilIdle();
    expect(h.repo.getRun(run.id)!.status).toBe('done');
    return { ...h, run };
  }

  it('re-opens a done run at the default re-entry stage (plan) with a fresh advance event and reset counters', async () => {
    const { repo, loop, run } = await toDone();

    loop.reopenForPrFeedback(run.id, { kind: 'pr_feedback', prNumber: 1 });

    const after = repo.getRun(run.id)!;
    expect(after.status).toBe('running');
    expect(after.currentState).toBe('plan');
    expect(after.flags[ADDRESSING_PR_FEEDBACK_FLAG]).toBe(true);

    const last = repo.listTransitions(run.id).at(-1)!;
    expect(last.toState).toBe('plan');
    expect(last.trigger).toBe(PR_FEEDBACK_TRIGGER);
    expect(last.isReset).toBe(true); // fresh budget of rounds for the re-opened cycle
    expect(last.eventId).toBeNull(); // a control transition, not driven by an event
    expect(repo.claimNextEvent()).toMatchObject({ runId: run.id, type: 'advance' });
  });

  it('honors a configured re-entry stage', async () => {
    const { repo, loop, run } = await toDone({ feedbackReentryState: 'interface_design' });
    loop.reopenForPrFeedback(run.id, { note: 'x' });
    expect(repo.getRun(run.id)!.currentState).toBe('interface_design');
  });

  it('re-opens a needs_human run too', async () => {
    const escalateAtReview: StubHandler = (req) =>
      req.stage === 'code_review' && req.phase === 'produce'
        ? { output: { requestedTransition: 'escalate', reason: { note: 'needs a human' } } }
        : goldenPathHandler(req);
    const { repo, loop } = setup(escalateAtReview);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();
    expect(repo.getRun(run.id)!.status).toBe('needs_human');

    loop.reopenForPrFeedback(run.id, { note: 'address feedback' });
    expect(repo.getRun(run.id)!.status).toBe('running');
    expect(repo.getRun(run.id)!.currentState).toBe('plan');
  });

  it('rejects a run that is not finished, a missing reason, and a terminal re-entry target', async () => {
    const running = setup(goldenPathHandler);
    const runningRun = running.loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    expect(() => running.loop.reopenForPrFeedback(runningRun.id, { note: 'x' })).toThrowError(/not a finished/);
    expect(() => running.loop.reopenForPrFeedback(999, { note: 'x' })).toThrowError(/not found/);

    const { loop, run } = await toDone();
    expect(() => loop.reopenForPrFeedback(run.id, '')).toThrowError(/reason is required/);

    const { loop: badLoop, run: badRun } = await toDone({ feedbackReentryState: 'done' });
    expect(() => badLoop.reopenForPrFeedback(badRun.id, { note: 'x' })).toThrowError(/terminal/);
  });
});

describe('dependency-scheduling control methods (Milestone 9)', () => {
  it('parkBlocked/wakeBlocked flip running ↔ blocked (status-only: the pending event survives)', async () => {
    const { repo, loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });

    expect(loop.parkBlocked(run.id).status).toBe('blocked');
    // Status-only park: the start event is still pending, just not dispatchable while blocked.
    expect(repo.claimNextEvent()).toBeUndefined();

    expect(loop.wakeBlocked(run.id).status).toBe('running');
    await loop.runUntilIdle(); // the surviving event dispatches — no re-enqueue was needed
    expect(repo.getRun(run.id)!.status).toBe('done');
  });

  it('refuses illegal flips: only running parks, only blocked wakes', () => {
    const { repo, loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });

    expect(() => loop.wakeBlocked(run.id)).toThrow(/not blocked/);
    repo.setRunStatus(run.id, 'paused');
    expect(() => loop.parkBlocked(run.id)).toThrow(/not running/);
  });

  it('escalateDependencyCycle: discards pending events, records the control transition, and resume returns to the stage', async () => {
    const { repo, loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });

    const escalated = loop.escalateDependencyCycle(run.id, { kind: 'dependency_cycle', runs: [run.id], issues: [1] });

    expect(escalated.status).toBe('needs_human');
    expect(repo.claimNextEvent()).toBeUndefined(); // the start event was discarded, not left to go stale
    expect(sequence(repo, run.id)).toEqual([['triage', 'dependency_cycle', 'needs_human']]);

    // The standard operator path works unchanged: resume returns to the escalated-from stage and re-runs.
    loop.resumeRun(run.id);
    await loop.runUntilIdle();
    expect(repo.getRun(run.id)!.status).toBe('done');
  });

  it('escalateDependencyCycle refuses runs parked for other reasons (their owners resume them)', () => {
    const { repo, loop } = setup(goldenPathHandler);
    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    repo.setRunStatus(run.id, 'awaiting_input');
    expect(() => loop.escalateDependencyCycle(run.id, { kind: 'dependency_cycle' })).toThrow(/not running\/blocked/);
  });
});
