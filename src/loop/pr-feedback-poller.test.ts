/**
 * PR Feedback Poller tests: detecting a human reviewer's `feedback:` comment left on a finished run's
 * open PR *after it finished* and re-opening the run to address it. Driven against the in-memory GitHub
 * fake and a real Event Loop + Agent Runner, so the whole done → feedback → re-open loop runs offline.
 *
 * The "after it finished" boundary is the run's most recent transition timestamp, so tests seed comments
 * with a `createdAt` relative to that transition (via {@link finishPlus}) to make the time comparison
 * deterministic regardless of the wall clock.
 */

import { describe, expect, it } from 'vitest';

import { goldenPathHandler, StubExecutor, type StubHandler } from '../agent/executor';
import { ADDRESSING_PR_FEEDBACK_FLAG, EventLoop } from './event-loop';
import { AgentRunner } from '../agent/runner';
import { loadDefaultConfig } from '../fsm/config';
import { FakeGitHub } from '../integration/github-fake';
import type { PrComment } from '../integration/github';
import type { RepoResolver } from '../integration/github-resolver';
import { openDb } from '../store/db';
import { Repository, type Run } from '../store/repository';
import { DEFAULT_FEEDBACK_MARKER, isFeedbackComment, newFeedbackComments, PR_FEEDBACK_CLOSED_FLAG, PrFeedbackPoller } from './pr-feedback-poller';

const { fsm, agents, version } = loadDefaultConfig();
const ISSUE_REF = 'o/r#7';
const BOT = 'bot[bot]';
const noopSleep = () => Promise.resolve();

/** Drive a fresh run to the given terminal state on stubs; returns the harness + the finished run. */
async function runToTerminal(handler: StubHandler): Promise<{ repo: Repository; github: FakeGitHub; loop: EventLoop; run: Run }> {
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ repoRef: 'o/r', botLogin: BOT });
  github.seedIssue(ISSUE_REF, { number: 7, title: 'Do a thing' });
  const runner = new AgentRunner(repo, new StubExecutor(handler), agents, github);
  const loop = new EventLoop(repo, fsm, version, runner);
  const run = loop.startRun({ issueRef: ISSUE_REF, repoRef: 'o/r' });
  await loop.runUntilIdle();
  return { repo, github, loop, run };
}

/** A run that walks the golden path all the way to `done` (PR opened at tdd). */
const runToDone = () => runToTerminal(goldenPathHandler);

/** A run that opens the PR (tdd) then escalates at code_review, parking in `needs_human` with a PR. */
function runToNeedsHumanWithPr() {
  const handler: StubHandler = (req) =>
    req.stage === 'code_review' && req.phase === 'produce'
      ? { output: { requestedTransition: 'escalate', reason: { note: 'needs a human' } } }
      : goldenPathHandler(req);
  return runToTerminal(handler);
}

/** An ISO timestamp `offsetMs` from the run's finished-state transition (its most recent transition). */
function finishPlus(repo: Repository, runId: number, offsetMs: number): string {
  const finishedAt = repo.listTransitions(runId).at(-1)!.createdAt;
  return new Date(Date.parse(finishedAt) + offsetMs).toISOString();
}

/** Seed a reviewer's `feedback:` comment on a run's PR, timed `offsetMs` from when the run finished. */
function seedFeedback(repo: Repository, github: FakeGitHub, run: Run, offsetMs: number, body = 'feedback: rename the endpoint') {
  return github.seedPrComment(repo.getRun(run.id)!.prNumber!, { author: 'alice', body, createdAt: finishPlus(repo, run.id, offsetMs) });
}

describe('isFeedbackComment', () => {
  it('matches the marker case-insensitively after leading whitespace, and nothing else', () => {
    const m = DEFAULT_FEEDBACK_MARKER;
    expect(isFeedbackComment('feedback: please rename foo', m)).toBe(true);
    expect(isFeedbackComment('  FEEDBACK: still counts', m)).toBe(true);
    expect(isFeedbackComment('Feedback: mixed case', m)).toBe(true);
    // A trailing newline + heading (what GitHub renders from "feedback:\n\n## …") still starts with the marker.
    expect(isFeedbackComment('feedback:\n\n## Improvement to make\n- do X', m)).toBe(true);
    expect(isFeedbackComment('nice work!', m)).toBe(false);
    expect(isFeedbackComment('some feedback: buried mid-sentence', m)).toBe(false);
    expect(isFeedbackComment('', m)).toBe(false);
  });
});

describe('newFeedbackComments', () => {
  const c = (id: number, body: string, createdAt: string): PrComment => ({ id, prNumber: 1, author: 'alice', body, createdAt });
  const since = '2026-07-01T12:00:00.000Z';

  it('keeps only marker comments strictly newer than the finished-at boundary', () => {
    const comments = [
      c(1, 'feedback: before finish', '2026-07-01T11:59:59Z'), // older → excluded (a pre-completion comment)
      c(2, 'looks good', '2026-07-01T12:00:05Z'), // no marker → excluded
      c(3, 'feedback: after finish', '2026-07-01T12:00:05Z'), // marker + newer → the one
      c(4, 'FEEDBACK: also after', '2026-07-01T12:30:00Z'), // marker + newer → also
    ];
    expect(newFeedbackComments(comments, DEFAULT_FEEDBACK_MARKER, since).map((x) => x.id)).toEqual([3, 4]);
  });

  it('with no boundary (undefined), every marker comment counts', () => {
    const comments = [c(1, 'feedback: x', '2000-01-01T00:00:00Z'), c(2, 'hi', '2030-01-01T00:00:00Z')];
    expect(newFeedbackComments(comments, DEFAULT_FEEDBACK_MARKER, undefined).map((x) => x.id)).toEqual([1]);
  });
});

describe('PrFeedbackPoller — checkOnce', () => {
  it('re-opens a done run at plan when a feedback: comment is left after it finished', async () => {
    const { repo, github, loop, run } = await runToDone();
    seedFeedback(repo, github, run, 1000);
    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });

    expect(await poller.checkOnce()).toBe(1);
    const reopened = repo.getRun(run.id)!;
    expect(reopened.status).toBe('running');
    expect(reopened.currentState).toBe('plan'); // re-entered at the default re-entry stage
    expect(reopened.flags[ADDRESSING_PR_FEEDBACK_FLAG]).toBe(true);
    expect(repo.claimNextEvent()).toMatchObject({ runId: run.id, type: 'advance' });
  });

  it('ignores a feedback: comment that predates completion (a pipeline/pre-finish comment)', async () => {
    const { repo, github, loop, run } = await runToDone();
    seedFeedback(repo, github, run, -1000); // left *before* the run finished

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkOnce()).toBe(0);
    expect(repo.getRun(run.id)!.status).toBe('done');
  });

  it('ignores a benign comment (no marker) left after completion', async () => {
    const { repo, github, loop, run } = await runToDone();
    seedFeedback(repo, github, run, 1000, 'looks great, thanks!');

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkOnce()).toBe(0);
    expect(repo.getRun(run.id)!.status).toBe('done');
  });

  it('does not re-detect the feedback once the run has been re-opened (it is no longer watched)', async () => {
    const { repo, github, loop, run } = await runToDone();
    seedFeedback(repo, github, run, 1000);
    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });

    expect(await poller.checkOnce()).toBe(1);
    // The run is now running (re-opened) → not a watched finished run, so a second pass is a no-op.
    expect(await poller.checkOnce()).toBe(0);
  });

  it('stops watching once the PR is merged (flags the run, never re-opens)', async () => {
    const { repo, github, loop, run } = await runToDone();
    const prNumber = repo.getRun(run.id)!.prNumber!;
    github.setPrState(prNumber, 'merged');
    seedFeedback(repo, github, run, 1000, 'feedback: too late, already merged');

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkOnce()).toBe(0);
    const after = repo.getRun(run.id)!;
    expect(after.flags[PR_FEEDBACK_CLOSED_FLAG]).toBe(true);
    expect(after.status).toBe('done');
    expect(await poller.checkOnce()).toBe(0); // flagged → skipped entirely next tick
  });

  it('stops watching once the PR is closed without merging', async () => {
    const { repo, github, loop, run } = await runToDone();
    github.setPrState(repo.getRun(run.id)!.prNumber!, 'closed');
    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });

    expect(await poller.checkOnce()).toBe(0);
    expect(repo.getRun(run.id)!.flags[PR_FEEDBACK_CLOSED_FLAG]).toBe(true);
  });

  it('re-opens a needs_human run that has an open PR', async () => {
    const { repo, github, loop, run } = await runToNeedsHumanWithPr();
    expect(repo.getRun(run.id)!.status).toBe('needs_human');
    seedFeedback(repo, github, run, 1000, 'feedback: try another approach');
    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });

    expect(await poller.checkOnce()).toBe(1);
    const reopened = repo.getRun(run.id)!;
    expect(reopened.status).toBe('running');
    expect(reopened.currentState).toBe('plan');
  });

  it('does not watch an archived run (archiving files a resolved run away)', async () => {
    const { repo, github, loop, run } = await runToDone();
    repo.setRunArchived(run.id, true);
    seedFeedback(repo, github, run, 1000, 'feedback: reconsider this');

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkOnce()).toBe(0);
    expect(await poller.checkRun(run.id)).toBe('not_watching');
    expect(repo.getRun(run.id)!.status).toBe('done');
  });

  it('survives a transient read error on one run (logs it, does not throw, leaves it watched)', async () => {
    const { repo, github, loop, run } = await runToDone();
    github.getPr = () => Promise.reject(new Error('GitHub 502'));

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    await expect(poller.checkOnce()).resolves.toBe(0);

    expect(repo.getRun(run.id)!.status).toBe('done'); // untouched, retried next tick
    expect(repo.listLogs(run.id).some((l) => l.level === 'warn' && /PR feedback poll failed/.test(l.message))).toBe(true);
  });
});

describe('PrFeedbackPoller — checkRun (on-demand single run)', () => {
  it('returns the outcome of checking one run: watching → reopened → not_watching → stopped', async () => {
    const { repo, github, loop, run } = await runToDone();
    const prNumber = repo.getRun(run.id)!.prNumber!;
    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });

    expect(await poller.checkRun(run.id)).toBe('watching'); // open PR, no feedback yet
    seedFeedback(repo, github, run, 1000, 'feedback: do X');
    expect(await poller.checkRun(run.id)).toBe('reopened');

    expect(await poller.checkRun(run.id)).toBe('not_watching'); // now running (re-opened)
    await loop.runUntilIdle(); // back to done, past the addressed comment
    github.setPrState(prNumber, 'merged');
    expect(await poller.checkRun(run.id)).toBe('stopped');

    expect(await poller.checkRun(9999)).toBe('not_watching'); // unknown run
  });
});

describe('PrFeedbackPoller — poll driver', () => {
  it('polls, re-opens on the feedback, drains, and the run returns to done exactly once', async () => {
    const { repo, github, loop, run } = await runToDone();
    seedFeedback(repo, github, run, 1); // just after finish → before the (later) re-finish, so it fires once
    const poller = new PrFeedbackPoller(repo, github, loop, { intervalMs: 1, sleep: noopSleep });

    let t = 0;
    const now = () => {
      const v = t;
      t += 100;
      return v;
    };
    const total = await poller.poll({ maxWaitMs: 150, drain: () => loop.runUntilIdle(), now });
    expect(total).toBe(1);
    expect(repo.getRun(run.id)!.status).toBe('done');
  });
});

describe('PrFeedbackPoller — multi-repo (Milestone 8 Phase A)', () => {
  it('scans each finished run via its own repo’s adapter, not a single shared one', async () => {
    const repo = new Repository(openDb(':memory:'));
    const webGh = new FakeGitHub({ repoRef: 'acme/web', botLogin: BOT }).seedIssue('acme/web#1', { number: 1 });
    const apiGh = new FakeGitHub({ repoRef: 'acme/api', botLogin: BOT }).seedIssue('acme/api#1', { number: 1 });
    const resolver: RepoResolver = { for: (ref) => ({ github: ref === 'acme/web' ? webGh : apiGh, baseBranch: 'main' }), invalidate: () => {} };
    const runner = new AgentRunner(repo, new StubExecutor(goldenPathHandler), agents, resolver);
    const loop = new EventLoop(repo, fsm, version, runner);

    const webRun = loop.startRun({ issueRef: 'acme/web#1', repoRef: 'acme/web' });
    const apiRun = loop.startRun({ issueRef: 'acme/api#1', repoRef: 'acme/api' });
    await loop.runUntilIdle();

    const poller = new PrFeedbackPoller(repo, resolver, loop, { sleep: noopSleep });
    // Feedback lands only on the web repo's PR; only the web run re-opens.
    webGh.seedPrComment(repo.getRun(webRun.id)!.prNumber!, { author: 'alice', body: 'feedback: change X', createdAt: finishPlus(repo, webRun.id, 1000) });
    expect(await poller.checkOnce()).toBe(1);
    expect(repo.getRun(webRun.id)!.status).toBe('running');
    expect(repo.getRun(apiRun.id)!.status).toBe('done');
  });
});

describe('PrFeedbackPoller — post-merge worktree reclaim + base freshen (agents-fsm#20)', () => {
  it('on merge, reclaims the run’s worktree and freshens the local base, exactly once', async () => {
    const { repo, github, loop, run } = await runToDone();
    const prNumber = repo.getRun(run.id)!.prNumber!;
    github.setPrState(prNumber, 'merged');

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkOnce()).toBe(0); // merge is terminal — never a re-open

    // The run's worktree is de-registered and the operator's base is fast-forwarded.
    expect(github.droppedTrees).toContain(run.id);
    expect(github.syncedBases).toContain('main');

    // …and the run is flagged stopped, still `done` (cleanup does not change run state).
    const after = repo.getRun(run.id)!;
    expect(after.flags[PR_FEEDBACK_CLOSED_FLAG]).toBe(true);
    expect(after.status).toBe('done');

    // A second pass is a no-op: the flagged run has left the watch set, so neither op fires again.
    expect(await poller.checkOnce()).toBe(0);
    expect(github.droppedTrees.filter((id) => id === run.id)).toHaveLength(1);
    expect(github.syncedBases.filter((b) => b === 'main')).toHaveLength(1);
  });

  it('re-running the reclaim is idempotent — a missing tree is a no-op, not a throw', async () => {
    const { repo, github, loop, run } = await runToDone();
    const prNumber = repo.getRun(run.id)!.prNumber!;
    github.setPrState(prNumber, 'merged');

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    // Drive the merge reclaim on-demand twice back to back (the second sees an already-removed tree).
    await expect(poller.checkRun(run.id)).resolves.toBe('stopped');
    await expect(poller.checkRun(run.id)).resolves.toBe('not_watching'); // flagged → left the watch set
    expect(github.droppedTrees).toContain(run.id); // dropped, no error on the re-run
  });

  it('does not reclaim while the PR is still open (done alone must not trigger cleanup)', async () => {
    const { repo, github, loop, run } = await runToDone(); // PR stays open

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkRun(run.id)).toBe('watching');
    expect(await poller.checkOnce()).toBe(0);

    expect(github.droppedTrees).not.toContain(run.id); // no reclaim
    expect(github.syncedBases).toHaveLength(0); // no freshen
    expect(repo.getRun(run.id)!.flags[PR_FEEDBACK_CLOSED_FLAG]).toBeUndefined();
  });

  it('does not reclaim when the PR is closed without merging (only merge triggers cleanup)', async () => {
    const { repo, github, loop, run } = await runToDone();
    github.setPrState(repo.getRun(run.id)!.prNumber!, 'closed');

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkOnce()).toBe(0);

    expect(github.droppedTrees).not.toContain(run.id); // abandoned ≠ merged → no reclaim
    expect(github.syncedBases).toHaveLength(0);
    expect(repo.getRun(run.id)!.flags[PR_FEEDBACK_CLOSED_FLAG]).toBe(true); // still stops watching
  });

  it('keeps the run watched (and retries) when the worktree reclaim fails, so it is crash-safe', async () => {
    const { repo, github, loop, run } = await runToDone();
    github.setPrState(repo.getRun(run.id)!.prNumber!, 'merged');

    // The first reclaim attempt throws (e.g. a transient git failure / a crash mid-reclaim); the next succeeds.
    const realDrop = github.dropWorkingTree.bind(github);
    let attempts = 0;
    github.dropWorkingTree = (id: number) => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('git worktree remove failed')) : realDrop(id);
    };

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });

    // Tick 1: reclaim throws → logged, the stop flag is NOT set, the run stays watched.
    expect(await poller.checkOnce()).toBe(0);
    expect(repo.getRun(run.id)!.flags[PR_FEEDBACK_CLOSED_FLAG]).toBeUndefined();
    expect(repo.listLogs(run.id).some((l) => l.level === 'warn' && /PR feedback poll failed/.test(l.message))).toBe(true);

    // Tick 2: the retry drops the tree and the stop flag finally lands (idempotent across restart).
    expect(await poller.checkOnce()).toBe(0);
    expect(github.droppedTrees).toContain(run.id);
    expect(repo.getRun(run.id)!.flags[PR_FEEDBACK_CLOSED_FLAG]).toBe(true);
  });

  it('treats a base-freshen failure as best-effort — the tree is still reclaimed and the run flagged', async () => {
    const { repo, github, loop, run } = await runToDone();
    github.setPrState(repo.getRun(run.id)!.prNumber!, 'merged');
    github.syncBaseBranch = () => Promise.reject(new Error('git fetch origin failed'));

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkOnce()).toBe(0);

    // The reclaim happened and the run stopped watching despite the sync miss…
    expect(github.droppedTrees).toContain(run.id);
    expect(repo.getRun(run.id)!.flags[PR_FEEDBACK_CLOSED_FLAG]).toBe(true);
    // …and the failure was logged (cosmetic — the next fetch recovers), not thrown.
    expect(repo.listLogs(run.id).some((l) => l.level === 'warn' && /post-merge sync of the local checkout failed/.test(l.message))).toBe(true);
  });
});

describe('PrFeedbackPoller — merge-conflict detection on finished runs', () => {
  /** Enroll o/r with the given conflict policy (the poller reads it fresh per check). */
  function enroll(repo: Repository, policy: 'manual' | 'auto') {
    repo.upsertRepo({ repoRef: 'o/r', workingRoot: '/tmp/agent-fleet-test' });
    repo.setRepoConflictPolicy('o/r', policy);
  }

  it('runs the dedicated resolver (not a pipeline re-run) on a CONFLICTING done PR under auto policy', async () => {
    const { repo, github, loop, run } = await runToDone();
    enroll(repo, 'auto');
    github.setPrMergeable(repo.getRun(run.id)!.prNumber!, 'conflicting');

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkRun(run.id)).toBe('reopened');
    // The run enters the dedicated resolve_conflicts pseudo-state — NOT plan (the old behavior) — and
    // does not touch the pr-feedback flag (this is conflict resolution, not addressing review feedback).
    const resolving = repo.getRun(run.id)!;
    expect(resolving.currentState).toBe('resolve_conflicts');
    expect(resolving.status).toBe('running');
    expect(resolving.flags[ADDRESSING_PR_FEEDBACK_FLAG]).toBeUndefined();

    // Drive the queued EVENT_RESOLVE_CONFLICTS: with no conflict queued in the fake the resolver is a
    // no-op merge and the run returns straight to done — never re-running plan/tdd/etc.
    await loop.runUntilIdle();
    const resolved = repo.getRun(run.id)!;
    expect(resolved.currentState).toBe('done');
    expect(resolved.status).toBe('done');
    // The tail is the resolve round-trip only — no pipeline stage was re-dispatched.
    const tail = repo.listTransitions(run.id).slice(-2).map((t) => [t.fromState, t.trigger, t.toState]);
    expect(tail).toEqual([
      ['done', 'resolve_conflicts', 'resolve_conflicts'],
      ['resolve_conflicts', 'resolved', 'done'],
    ]);
  });

  it('leaves a conflicting PR alone under manual policy (the human drives resolution)', async () => {
    const { repo, github, loop, run } = await runToDone();
    enroll(repo, 'manual');
    github.setPrMergeable(repo.getRun(run.id)!.prNumber!, 'conflicting');

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkRun(run.id)).toBe('watching');
    expect(repo.getRun(run.id)!.status).toBe('done'); // untouched
  });

  it('never self-reopens a needs_human run for conflicts — it is parked for a person', async () => {
    const { repo, github, loop, run } = await runToNeedsHumanWithPr();
    enroll(repo, 'auto');
    github.setPrMergeable(repo.getRun(run.id)!.prNumber!, 'conflicting');

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkRun(run.id)).toBe('watching');
    expect(repo.getRun(run.id)!.status).toBe('needs_human'); // untouched
  });

  it('treats mergeable/unknown as "no signal" (GitHub may still be computing)', async () => {
    const { repo, github, loop, run } = await runToDone();
    enroll(repo, 'auto');
    github.setPrMergeable(repo.getRun(run.id)!.prNumber!, 'unknown');
    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkRun(run.id)).toBe('watching');
  });
});
