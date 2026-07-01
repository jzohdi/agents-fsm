/**
 * PR Feedback Poller tests: detecting a human reviewer's `feedback:` comment on a finished run's open
 * PR and re-opening the run to address it. Driven against the in-memory GitHub fake and a real Event
 * Loop + Agent Runner, so the whole done → feedback → re-open → done loop is exercised offline.
 */

import { describe, expect, it } from 'vitest';

import { goldenPathHandler, StubExecutor, type StubHandler } from '../agent/executor';
import { ADDRESSING_PR_FEEDBACK_FLAG, EventLoop } from './event-loop';
import { AgentRunner } from '../agent/runner';
import { loadDefaultConfig } from '../fsm/config';
import { FakeGitHub } from '../integration/github-fake';
import type { RepoResolver } from '../integration/github-resolver';
import { openDb } from '../store/db';
import { Repository, type Run } from '../store/repository';
import { DEFAULT_FEEDBACK_MARKER, isFeedbackComment, PR_FEEDBACK_CLOSED_FLAG, PrFeedbackPoller } from './pr-feedback-poller';

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

describe('isFeedbackComment', () => {
  it('matches the marker case-insensitively after leading whitespace, and nothing else', () => {
    const m = DEFAULT_FEEDBACK_MARKER;
    expect(isFeedbackComment('feedback: please rename foo', m)).toBe(true);
    expect(isFeedbackComment('  FEEDBACK: still counts', m)).toBe(true);
    expect(isFeedbackComment('Feedback: mixed case', m)).toBe(true);
    expect(isFeedbackComment('nice work!', m)).toBe(false);
    expect(isFeedbackComment('some feedback: buried mid-sentence', m)).toBe(false);
    expect(isFeedbackComment('', m)).toBe(false);
  });
});

describe('PrFeedbackPoller — checkOnce', () => {
  it('baselines a newly-seen finished run on first sight without re-opening it', async () => {
    const { repo, github, loop, run } = await runToDone();
    expect(repo.getRun(run.id)!.prNumber).not.toBeNull();
    // A pre-existing (non-feedback) comment on the PR must not trigger anything.
    github.seedPrComment(repo.getRun(run.id)!.prNumber!, { author: 'alice', body: 'nice work' });

    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkOnce()).toBe(0);

    const after = repo.getRun(run.id)!;
    expect(after.status).toBe('done'); // untouched
    expect(after.prFeedbackWatermark).not.toBeNull(); // baselined past the existing comment
  });

  it('re-opens a done run at plan when a new feedback: comment arrives after baselining', async () => {
    const { repo, github, loop, run } = await runToDone();
    const prNumber = repo.getRun(run.id)!.prNumber!;
    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });

    await poller.checkOnce(); // baseline (no comments yet)
    github.seedPrComment(prNumber, { author: 'alice', body: 'feedback: rename the endpoint' });

    expect(await poller.checkOnce()).toBe(1);
    const reopened = repo.getRun(run.id)!;
    expect(reopened.status).toBe('running');
    expect(reopened.currentState).toBe('plan'); // re-entered at the default re-entry stage
    expect(reopened.flags[ADDRESSING_PR_FEEDBACK_FLAG]).toBe(true);
    // A fresh advance event is queued for the loop to pick up.
    expect(repo.claimNextEvent()).toMatchObject({ runId: run.id, type: 'advance' });
  });

  it('ignores a benign comment (no marker) and advances the mark so it is evaluated only once', async () => {
    const { repo, github, loop, run } = await runToDone();
    const prNumber = repo.getRun(run.id)!.prNumber!;
    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });

    await poller.checkOnce(); // baseline
    github.seedPrComment(prNumber, { author: 'alice', body: 'looks great, thanks!' });

    expect(await poller.checkOnce()).toBe(0);
    expect(repo.getRun(run.id)!.status).toBe('done'); // not re-opened
    // The benign comment is now under the watermark, so a later feedback comment is the only trigger.
    github.seedPrComment(prNumber, { author: 'alice', body: 'feedback: address the edge case' });
    expect(await poller.checkOnce()).toBe(1);
  });

  it('stops watching once the PR is merged (flags the run, never re-opens)', async () => {
    const { repo, github, loop, run } = await runToDone();
    const prNumber = repo.getRun(run.id)!.prNumber!;
    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });

    await poller.checkOnce(); // baseline
    github.setPrState(prNumber, 'merged');
    github.seedPrComment(prNumber, { author: 'alice', body: 'feedback: too late, already merged' });

    expect(await poller.checkOnce()).toBe(0);
    const after = repo.getRun(run.id)!;
    expect(after.flags[PR_FEEDBACK_CLOSED_FLAG]).toBe(true);
    expect(after.status).toBe('done');
    // Flagged runs are skipped entirely on subsequent ticks — even a fresh feedback comment is inert.
    expect(await poller.checkOnce()).toBe(0);
  });

  it('stops watching once the PR is closed without merging', async () => {
    const { repo, github, loop, run } = await runToDone();
    const prNumber = repo.getRun(run.id)!.prNumber!;
    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });

    github.setPrState(prNumber, 'closed');
    expect(await poller.checkOnce()).toBe(0);
    expect(repo.getRun(run.id)!.flags[PR_FEEDBACK_CLOSED_FLAG]).toBe(true);
  });

  it('re-opens a needs_human run that has an open PR', async () => {
    const { repo, github, loop, run } = await runToNeedsHumanWithPr();
    expect(repo.getRun(run.id)!.status).toBe('needs_human');
    const prNumber = repo.getRun(run.id)!.prNumber!;
    expect(prNumber).not.toBeNull();
    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });

    await poller.checkOnce(); // baseline
    github.seedPrComment(prNumber, { author: 'alice', body: 'feedback: try another approach' });

    expect(await poller.checkOnce()).toBe(1);
    const reopened = repo.getRun(run.id)!;
    expect(reopened.status).toBe('running');
    expect(reopened.currentState).toBe('plan');
  });

  it('does not re-detect the same feedback after the re-opened run finishes again', async () => {
    const { repo, github, loop, run } = await runToDone();
    const prNumber = repo.getRun(run.id)!.prNumber!;
    const poller = new PrFeedbackPoller(repo, github, loop, { sleep: noopSleep });

    await poller.checkOnce(); // baseline
    github.seedPrComment(prNumber, { author: 'alice', body: 'feedback: rename it' });
    expect(await poller.checkOnce()).toBe(1);

    await loop.runUntilIdle(); // the re-opened run walks back to done (adopting the existing PR)
    expect(repo.getRun(run.id)!.status).toBe('done');
    expect(repo.getRun(run.id)!.prNumber).toBe(prNumber); // no duplicate PR

    // The consumed feedback is under the watermark, so it must not fire again.
    expect(await poller.checkOnce()).toBe(0);
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

describe('PrFeedbackPoller — poll driver', () => {
  it('polls, re-opens on the feedback, drains, and the run returns to done', async () => {
    const { repo, github, loop, run } = await runToDone();
    const prNumber = repo.getRun(run.id)!.prNumber!;
    const poller = new PrFeedbackPoller(repo, github, loop, { intervalMs: 1, sleep: noopSleep });

    await poller.checkOnce(); // baseline before feedback arrives
    github.seedPrComment(prNumber, { author: 'alice', body: 'feedback: tweak the copy' });

    // Stop after one tick's worth of virtual time so the deadline is reached regardless of outcome.
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
    await poller.checkOnce(); // baseline both

    // Feedback lands only on the web repo's PR; only the web run re-opens.
    webGh.seedPrComment(repo.getRun(webRun.id)!.prNumber!, { author: 'alice', body: 'feedback: change X' });
    expect(await poller.checkOnce()).toBe(1);
    expect(repo.getRun(webRun.id)!.status).toBe('running');
    expect(repo.getRun(apiRun.id)!.status).toBe('done');
  });
});
