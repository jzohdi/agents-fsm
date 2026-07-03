/**
 * Reply Poller tests (Q1): detecting a human's reply to triage's clarifying questions and re-arming
 * the parked run. Driven against the in-memory GitHub fake and a real Event Loop + Agent Runner, so
 * the whole clarify → wait → reply → resume loop is exercised offline.
 */

import { describe, expect, it } from 'vitest';

import { goldenPathHandler, StubExecutor, type StubHandler } from '../agent/executor';
import { AgentRunner } from '../agent/runner';
import { loadDefaultConfig } from '../fsm/config';
import { FakeGitHub } from '../integration/github-fake';
import { BOT_COMMENT_MARKER } from '../integration/issue-markers';
import type { RepoResolver } from '../integration/github-resolver';
import { openDb } from '../store/db';
import { Repository, type Run } from '../store/repository';
import { EventLoop } from './event-loop';
import { ReplyPoller } from './reply-poller';

const { fsm, agents, version } = loadDefaultConfig();
const ISSUE_REF = 'o/r#7';
const BOT = 'bot[bot]';
const noopSleep = () => Promise.resolve();

/** Build a run, drive it through triage so it clarifies and parks awaiting the human. `botLogin` sets
 *  the login the daemon posts under — pass the operator's own login to exercise the shared-identity case. */
async function parkOnClarify(handler: StubHandler, botLogin = BOT) {
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ repoRef: 'o/r', botLogin });
  github.seedIssue(ISSUE_REF, { number: 7, title: 'Do a thing' });
  const runner = new AgentRunner(repo, new StubExecutor(handler), agents, github);
  const loop = new EventLoop(repo, fsm, version, runner);
  const run: Run = loop.startRun({ issueRef: ISSUE_REF, repoRef: 'o/r' });
  await loop.runUntilIdle();
  expect(repo.getRun(run.id)!.status).toBe('awaiting_input');
  return { repo, github, loop, run };
}

const alwaysClarify: StubHandler = (req) =>
  req.stage === 'triage' ? { output: { decision: 'clarify', questions: ['which database?'] } } : goldenPathHandler(req);

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

describe('ReplyPoller — checkOnce', () => {
  it('re-arms a parked run when a human replies after the question', async () => {
    const { repo, github, loop, run } = await parkOnClarify(alwaysClarify);
    github.seedIssueComment(7, { author: 'alice', body: 'Use Postgres.' });

    const poller = new ReplyPoller(repo, github, loop, { sleep: noopSleep });
    const rearmed = await poller.checkOnce();

    expect(rearmed).toBe(1);
    // Re-armed = back to running, with a fresh advance event pending for the loop to pick up.
    expect(repo.getRun(run.id)!.status).toBe('running');
    expect(repo.claimNextEvent()).toMatchObject({ runId: run.id, type: 'advance' });
  });

  it('does nothing while there is no reply (only the bot\'s own question)', async () => {
    const { repo, github, loop, run } = await parkOnClarify(alwaysClarify);

    const poller = new ReplyPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkOnce()).toBe(0);
    expect(repo.getRun(run.id)!.status).toBe('awaiting_input'); // still parked
  });

  it('ignores a later comment the fleet posted itself (identified by its marker, not a human reply)', async () => {
    const { repo, github, loop } = await parkOnClarify(alwaysClarify);
    // A fleet-posted comment carries the bot marker — even a later one is not a human reply.
    github.seedIssueComment(7, { author: BOT, body: `a follow-up from the agent\n\n${BOT_COMMENT_MARKER}` });

    const poller = new ReplyPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkOnce()).toBe(0);
  });

  it('detects the human reply even when the daemon posts under the operator\'s own login (shared-identity bug)', async () => {
    // The real-world case: the daemon comments via the operator's `gh` account, so the "bot" login and
    // the human's login are identical. Author-based filtering rejected the reply; the marker fixes it.
    const OPERATOR = 'jzohdi';
    const { repo, github, loop, run } = await parkOnClarify(alwaysClarify, OPERATOR);
    github.seedIssueComment(7, { author: OPERATOR, body: 'feedback: use Postgres, proceed.' }); // human reply, same login, no marker

    const poller = new ReplyPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkOnce()).toBe(1);
    expect(repo.getRun(run.id)!.status).toBe('running');
  });

  it('survives a transient read error on one run (logs it, leaves the run parked, does not throw)', async () => {
    const { repo, github, loop, run } = await parkOnClarify(alwaysClarify);
    github.listIssueComments = () => Promise.reject(new Error('GitHub 502'));

    const poller = new ReplyPoller(repo, github, loop, { sleep: noopSleep });
    await expect(poller.checkOnce()).resolves.toBe(0); // no throw, nothing re-armed

    expect(repo.getRun(run.id)!.status).toBe('awaiting_input'); // still parked, retried next tick
    expect(repo.listLogs(run.id).some((l) => l.level === 'warn' && /reply poll failed/.test(l.message))).toBe(true);
  });

  it('advances the question marker across rounds, never re-detecting a consumed reply', async () => {
    // Triage clarifies twice (rounds 1–2), then proceeds. Comment ids interleave:
    // q1=1, reply=2, q2=3, reply=4 — so the marker must advance to id 3 to ignore the spent reply 2.
    let round = 0;
    const handler: StubHandler = (req) => {
      if (req.stage === 'triage') {
        round += 1;
        return round <= 2 ? { output: { decision: 'clarify', questions: [`q${round}`] } } : { output: { decision: 'proceed' } };
      }
      return goldenPathHandler(req);
    };
    const { repo, github, loop, run } = await parkOnClarify(handler);
    const poller = new ReplyPoller(repo, github, loop, { sleep: noopSleep });

    github.seedIssueComment(7, { author: 'alice', body: 'answer 1' }); // id 2
    expect(await poller.checkOnce()).toBe(1);
    await loop.runUntilIdle();
    expect(repo.getRun(run.id)!.status).toBe('awaiting_input'); // re-clarified (round 2)

    // The consumed reply (id 2) is older than the new marker (id 3): it must not re-fire.
    expect(await poller.checkOnce()).toBe(0);

    github.seedIssueComment(7, { author: 'alice', body: 'answer 2' }); // id 4
    expect(await poller.checkOnce()).toBe(1);
    await loop.runUntilIdle();
    expect(repo.getRun(run.id)!.status).toBe('done');
  });
});

describe('ReplyPoller — checkRun (on-demand)', () => {
  it('resumes a parked run when a reply is present', async () => {
    const { repo, github, loop, run } = await parkOnClarify(alwaysClarify);
    github.seedIssueComment(7, { author: 'alice', body: 'Use Postgres.' });

    const poller = new ReplyPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkRun(run.id)).toBe('resumed');
    expect(repo.getRun(run.id)!.status).toBe('running');
  });

  it('reports no_reply while parked with nothing new', async () => {
    const { repo, github, loop, run } = await parkOnClarify(alwaysClarify);
    const poller = new ReplyPoller(repo, github, loop, { sleep: noopSleep });
    expect(await poller.checkRun(run.id)).toBe('no_reply');
    expect(repo.getRun(run.id)!.status).toBe('awaiting_input');
  });

  it('reports not_awaiting for a run that isn\'t parked on input', async () => {
    const { repo, github, loop, run } = await parkOnClarify(clarifyOnceThenProceed());
    github.seedIssueComment(7, { author: 'alice', body: 'go' });
    const poller = new ReplyPoller(repo, github, loop, { sleep: noopSleep });
    await poller.checkRun(run.id); // resumes it
    await loop.runUntilIdle(); // run proceeds to done
    expect(await poller.checkRun(run.id)).toBe('not_awaiting');
  });
});

describe('ReplyPoller — poll driver', () => {
  it('polls, re-arms on the reply, drains, and the run proceeds to done', async () => {
    const { repo, github, loop, run } = await parkOnClarify(clarifyOnceThenProceed());
    github.seedIssueComment(7, { author: 'alice', body: 'Use Postgres.' });

    const poller = new ReplyPoller(repo, github, loop, { intervalMs: 1, sleep: noopSleep });
    const total = await poller.poll({ maxWaitMs: 10_000, drain: () => loop.runUntilIdle() });

    expect(total).toBe(1);
    expect(repo.getRun(run.id)!.status).toBe('done');
  });

  it('stops at the deadline when no reply ever arrives (no infinite loop)', async () => {
    const { repo, github, loop, run } = await parkOnClarify(alwaysClarify); // no reply seeded

    // A clock that advances past the deadline after a single tick, so the loop terminates.
    let t = 0;
    const now = () => {
      const v = t;
      t += 100;
      return v;
    };
    const poller = new ReplyPoller(repo, github, loop, { intervalMs: 1, sleep: noopSleep });
    const total = await poller.poll({ maxWaitMs: 150, drain: () => loop.runUntilIdle(), now });

    expect(total).toBe(0);
    expect(repo.getRun(run.id)!.status).toBe('awaiting_input'); // still parked, just gave up waiting
  });
});

describe('ReplyPoller — multi-repo (Milestone 8 Phase A)', () => {
  it('polls each parked run via its own repo’s adapter, not a single shared one', async () => {
    const repo = new Repository(openDb(':memory:'));
    const webGh = new FakeGitHub({ repoRef: 'acme/web', botLogin: BOT }).seedIssue('acme/web#1', { number: 1 });
    const apiGh = new FakeGitHub({ repoRef: 'acme/api', botLogin: BOT }).seedIssue('acme/api#1', { number: 1 });
    const resolver: RepoResolver = { for: (ref) => ({ github: ref === 'acme/web' ? webGh : apiGh, baseBranch: 'main' }), invalidate: () => {} };
    const runner = new AgentRunner(repo, new StubExecutor(alwaysClarify), agents, resolver);
    const loop = new EventLoop(repo, fsm, version, runner);

    const webRun = loop.startRun({ issueRef: 'acme/web#1', repoRef: 'acme/web' });
    const apiRun = loop.startRun({ issueRef: 'acme/api#1', repoRef: 'acme/api' });
    await loop.runUntilIdle();
    expect(repo.getRun(webRun.id)!.status).toBe('awaiting_input');
    expect(repo.getRun(apiRun.id)!.status).toBe('awaiting_input');

    // A human replies only on the web repo's issue. A single-adapter poller would read the wrong repo's
    // thread; the resolver-driven poller re-arms exactly the web run and leaves the api run parked.
    webGh.seedIssueComment(1, { author: 'alice', body: 'Use Postgres.' });
    const poller = new ReplyPoller(repo, resolver, loop, { sleep: noopSleep });

    expect(await poller.checkOnce()).toBe(1);
    expect(repo.getRun(webRun.id)!.status).toBe('running');
    expect(repo.getRun(apiRun.id)!.status).toBe('awaiting_input');

    // The api run re-arms only once *its* repo's thread gets a reply.
    apiGh.seedIssueComment(1, { author: 'bob', body: 'Use SQLite.' });
    expect(await poller.checkOnce()).toBe(1);
    expect(repo.getRun(apiRun.id)!.status).toBe('running');
  });
});
