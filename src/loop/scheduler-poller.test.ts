/**
 * Scheduler Poller tests (Milestone 9): the impure driver around the pure Scheduler, against the
 * in-memory fake and the real Event Loop control methods. What each pass must do: refresh cached
 * declarations from the issue (the issue wins), verify + latch satisfaction (issue-closed is the
 * signal), park/wake with the fresh-tree discipline, escalate cycles, and stay per-repo.
 */

import { describe, expect, it } from 'vitest';

import { loadDefaultConfig } from '../fsm/config';
import { FakeGitHub } from '../integration/github-fake';
import type { RepoResolver } from '../integration/github-resolver';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import type { AgentRunner } from '../agent/runner';
import { EventLoop } from './event-loop';
import { SchedulerPoller } from './scheduler-poller';

/** A §3.5 marker block for test issue bodies. */
function marker(deps: number[], priority = 0, orderKey = ''): string {
  return `<!-- agent-orchestrator:v1\ndepends_on: [${deps.join(', ')}]\npriority: ${priority}\norder_key: ${JSON.stringify(orderKey)}\n-->`;
}

/** Poller fixture: real store + real EventLoop control methods; the runner is never invoked. */
function setup() {
  const { fsm, version } = loadDefaultConfig();
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ repoRef: 'o/r' });
  const neverRun = { runStage: () => Promise.reject(new Error('poller tests never run stages')) } as unknown as AgentRunner;
  const loop = new EventLoop(repo, fsm, version, neverRun);
  const poller = new SchedulerPoller(repo, github, loop);
  const startRun = (issue: number) =>
    repo.createRun({ issueRef: `o/r#${issue}`, repoRef: 'o/r', initialState: 'triage', fsmConfigVersion: version });
  return { repo, github, loop, poller, startRun };
}

describe('SchedulerPoller — park / wake', () => {
  it('parks a running run with unsatisfied deps, then wakes it when the dependency issue closes', async () => {
    const { repo, github, poller, startRun } = setup();
    github.seedIssue('o/r#1', { number: 1 }); // the open dependency
    github.seedIssue('o/r#2', { number: 2, body: marker([1]) });
    const run = startRun(2);

    // Pass 1: declaration refreshed from the issue, dependency open → parked visibly.
    const first = await poller.checkOnce();
    expect(first).toMatchObject({ refreshed: 1, parked: 1, woken: 0, escalated: 0 });
    expect(repo.getRun(run.id)).toMatchObject({ status: 'blocked', dependsOn: [1], depsSatisfiedAt: null });

    // Pass 2: nothing changed — idempotent, no flapping.
    expect(await poller.checkOnce()).toEqual({ refreshed: 0, parked: 0, woken: 0, escalated: 0 });

    // The dependency closes (a human merged its `Closes #1` PR) → latch + wake.
    github.closeIssue(1);
    const third = await poller.checkOnce();
    expect(third).toMatchObject({ woken: 1 });
    expect(repo.getRun(run.id)!.status).toBe('running');
    expect(repo.getRun(run.id)!.depsSatisfiedAt).not.toBeNull();

    // Latched: the dependency is never re-verified, the run stays running.
    expect(await poller.checkOnce()).toEqual({ refreshed: 0, parked: 0, woken: 0, escalated: 0 });
  });

  it('drops the working tree at wake, so the next prepare re-clones off fresh base (§3.1)', async () => {
    const { github, poller, startRun } = setup();
    github.seedIssue('o/r#1', { number: 1 });
    github.seedIssue('o/r#2', { number: 2, body: marker([1]) });
    const run = startRun(2);
    // The tree triage created, off pre-merge base.
    await github.prepareWorkingTree({ runId: run.id, branch: 'stale-branch', base: 'main' });

    await poller.checkOnce(); // parks
    github.closeIssue(1);
    await poller.checkOnce(); // wakes — and must drop the tree first

    // A re-prepare builds a fresh tree (the fake would have returned the memoized 'stale-branch' one).
    const fresh = await github.prepareWorkingTree({ runId: run.id, branch: 'fresh-branch', base: 'main' });
    expect(fresh.branch).toBe('fresh-branch');
  });

  it('never parks a run with a stage in flight (the mid-stage commit race)', async () => {
    const { repo, github, poller, startRun } = setup();
    github.seedIssue('o/r#1', { number: 1 });
    github.seedIssue('o/r#2', { number: 2, body: marker([1]) });
    const run = startRun(2);
    repo.enqueueEvent({ runId: run.id, type: 'advance' });
    repo.claimNextEvent(); // a stage is now in flight for this run

    const pass = await poller.checkOnce();

    expect(pass.parked).toBe(0);
    expect(repo.getRun(run.id)!.status).toBe('running'); // the claim predicate still gates it — invisibly, this tick
  });

  it('leaves paused / awaiting_input / needs_human runs alone (they park for different reasons)', async () => {
    const { repo, github, poller, startRun } = setup();
    github.seedIssue('o/r#1', { number: 1 });
    for (const [issue, status] of [
      [2, 'paused'],
      [3, 'awaiting_input'],
      [4, 'needs_human'],
    ] as const) {
      github.seedIssue(`o/r#${issue}`, { number: issue, body: marker([1]) });
      const run = startRun(issue);
      repo.setRunStatus(run.id, status);
    }

    const pass = await poller.checkOnce();

    expect(pass).toEqual({ refreshed: 0, parked: 0, woken: 0, escalated: 0 });
    expect(repo.listRuns().map((r) => r.status).sort()).toEqual(['awaiting_input', 'needs_human', 'paused']);
  });

  it('a human edit on the issue wins within a tick: adding a dep to a latched run re-parks it', async () => {
    const { repo, github, poller, startRun } = setup();
    github.seedIssue('o/r#1', { number: 1, state: 'closed' });
    github.seedIssue('o/r#8', { number: 8 }); // open — the human's new dependency
    github.seedIssue('o/r#2', { number: 2, body: marker([1]) });
    const run = startRun(2);

    await poller.checkOnce(); // #1 already closed → latch stamped, run stays running
    expect(repo.getRun(run.id)).toMatchObject({ status: 'running', depsSatisfiedAt: expect.any(String) as unknown });

    // A human edits the issue's block to also require the (open) #8.
    await github.updateIssue({ number: 2, body: marker([1, 8]) });
    const pass = await poller.checkOnce();

    expect(pass).toMatchObject({ refreshed: 1, parked: 1 });
    expect(repo.getRun(run.id)).toMatchObject({ status: 'blocked', dependsOn: [1, 8], depsSatisfiedAt: null });
  });
});

describe('SchedulerPoller — dependency cycles', () => {
  it('escalates every member of a cycle to needs_human, with the cycle named in the reason', async () => {
    const { repo, github, poller, startRun } = setup();
    github.seedIssue('o/r#1', { number: 1, body: marker([2]) });
    github.seedIssue('o/r#2', { number: 2, body: marker([1]) });
    github.seedIssue('o/r#3', { number: 3 }); // innocent bystander, no deps
    const a = startRun(1);
    const b = startRun(2);
    const c = startRun(3);

    const pass = await poller.checkOnce();

    expect(pass.escalated).toBe(2);
    for (const run of [a, b]) {
      expect(repo.getRun(run.id)!.status).toBe('needs_human');
      const escalation = repo.listTransitions(run.id).at(-1)!;
      expect(escalation.trigger).toBe('dependency_cycle');
      expect(escalation.reason).toMatchObject({ kind: 'dependency_cycle', runs: [a.id, b.id], issues: [1, 2] });
    }
    expect(repo.getRun(c.id)!.status).toBe('running');

    // Escalated members leave the active set — the next pass does not re-escalate.
    expect((await poller.checkOnce()).escalated).toBe(0);
  });
});

describe('SchedulerPoller — per-repo isolation (issue numbers collide across repos)', () => {
  function twoRepoSetup() {
    const { fsm, version } = loadDefaultConfig();
    const repo = new Repository(openDb(':memory:'));
    const fakes = new Map<string, FakeGitHub>([
      ['a/one', new FakeGitHub({ repoRef: 'a/one' })],
      ['b/two', new FakeGitHub({ repoRef: 'b/two' })],
    ]);
    const resolver: RepoResolver = {
      for: (ref) => ({ github: fakes.get(ref.toLowerCase())!, baseBranch: 'main' }),
      invalidate: () => {},
    };
    const neverRun = { runStage: () => Promise.reject(new Error('never')) } as unknown as AgentRunner;
    const loop = new EventLoop(repo, fsm, version, neverRun);
    return { repo, fakes, poller: new SchedulerPoller(repo, resolver, loop), version };
  }

  it('a dependency closed in the OTHER repo does not satisfy, and colliding numbers form no false cycle', async () => {
    const { repo, fakes, poller, version } = twoRepoSetup();
    // Repo A: run on issue 1 depends on A's #2 (open). Repo B: run on issue 2 depends on B's #1 (closed).
    // Cross-fed, A#1→#2 and B#2→#1 would look like a 1↔2 cycle, and B's closed #1 would wrongly
    // satisfy nothing-in-B / A's open #2 confusion. Per-repo, there is no cycle and exactly one wake path.
    fakes.get('a/one')!.seedIssue('a/one#1', { number: 1, body: marker([2]) });
    fakes.get('a/one')!.seedIssue('a/one#2', { number: 2 }); // open in A
    fakes.get('b/two')!.seedIssue('b/two#2', { number: 2, body: marker([1]) });
    fakes.get('b/two')!.seedIssue('b/two#1', { number: 1, state: 'closed' }); // closed in B
    const runA = repo.createRun({ issueRef: 'a/one#1', repoRef: 'a/one', initialState: 'triage', fsmConfigVersion: version });
    const runB = repo.createRun({ issueRef: 'b/two#2', repoRef: 'b/two', initialState: 'triage', fsmConfigVersion: version });

    const pass = await poller.checkOnce();

    expect(pass.escalated).toBe(0); // no false cross-repo cycle
    expect(repo.getRun(runA.id)!.status).toBe('blocked'); // A's #2 is open — B's closed #2-run doesn't count
    expect(repo.getRun(runB.id)!.status).toBe('running'); // B's #1 is closed — satisfied in its own repo
    expect(repo.getRun(runB.id)!.depsSatisfiedAt).not.toBeNull();
  });
});
