/**
 * The Milestone 9 gate test, end-to-end (README §5 M9): a dependent run is never dispatched against
 * unmerged work. Two runs, B depends on A — B parks after triage, A driving to `done` does NOT wake
 * it (done = merge-ready, not merged), the dependency's issue closing (the merge signal, §3.5) does,
 * and B then finishes on a fresh working tree. Driven under the M8 worker pool (`drain`), so the
 * claim's dependency gate is exercised on the concurrent path, with an independent run in the mix to
 * show the fleet keeps flowing around a parked run.
 */

import { describe, expect, it } from 'vitest';

import { goldenPathHandler, StubExecutor } from '../agent/executor';
import { AgentRunner } from '../agent/runner';
import { loadDefaultConfig } from '../fsm/config';
import { EventLoop } from '../loop/event-loop';
import { SchedulerPoller } from '../loop/scheduler-poller';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { FakeGitHub } from './github-fake';

const DEP_MARKER = '<!-- agent-orchestrator:v1\ndepends_on: [1]\n-->';

describe('dependency ordering, end to end (Milestone 9)', () => {
  it('B (depends on A) parks after triage, ignores A reaching done, wakes when A\'s issue closes, then finishes', async () => {
    const { fsm, agents, version } = loadDefaultConfig();
    const repo = new Repository(openDb(':memory:'));
    const github = new FakeGitHub({ repoRef: 'o/r' });
    github.seedIssue('o/r#1', { number: 1, title: 'A: the dependency', body: 'build the base' });
    github.seedIssue('o/r#2', { number: 2, title: 'B: the dependent', body: `builds on #1\n\n${DEP_MARKER}` });
    github.seedIssue('o/r#3', { number: 3, title: 'C: independent', body: 'unrelated' });
    const runner = new AgentRunner(repo, new StubExecutor(goldenPathHandler), agents, github);
    const loop = new EventLoop(repo, fsm, version, runner);
    const poller = new SchedulerPoller(repo, github, loop);

    const a = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    const b = loop.startRun({ issueRef: 'o/r#2', repoRef: 'o/r' });
    const c = loop.startRun({ issueRef: 'o/r#3', repoRef: 'o/r' });
    await loop.drain(3); // the M8 pool — the gate must hold on the concurrent path

    // A and C ran the whole pipeline; B ran ONLY triage (which cached the human-declared dependency,
    // gating B's next event in the claim itself — before any poller tick).
    expect(repo.getRun(a.id)!.status).toBe('done');
    expect(repo.getRun(c.id)!.status).toBe('done');
    expect(repo.getRun(b.id)!.currentState).toBe('plan'); // committed triage → plan, then parked at the gate
    expect(repo.getRun(b.id)).toMatchObject({ status: 'running', dependsOn: [1], depsSatisfiedAt: null });

    // A poller pass makes the park visible; A being `done` does NOT satisfy — its issue is still open
    // (done = merge-ready; nothing auto-merges — the README-required distinction).
    await poller.checkOnce();
    expect(repo.getRun(b.id)!.status).toBe('blocked');
    await loop.drain(3);
    expect(repo.getRun(b.id)!.currentState).toBe('plan'); // still parked; the pool flows around it

    // The human merges A's PR → GitHub auto-closes its issue (`Closes #1`). Simulated by closing #1.
    github.closeIssue(1);
    const woken = await poller.checkOnce();
    expect(woken).toMatchObject({ woken: 1 });

    await loop.drain(3);

    // B finished its own full pipeline and opened its own PR — no stacked PRs, one per run.
    expect(repo.getRun(b.id)!.status).toBe('done');
    expect(repo.getRun(b.id)!.depsSatisfiedAt).not.toBeNull();
    expect(github.listPrs()).toHaveLength(3);

    // No duplicate or lost work anywhere: every run's transition log is exactly the golden sequence.
    for (const run of [a, b, c]) {
      const states = repo.listTransitions(run.id).map((t) => t.toState);
      expect(states).toEqual(['plan', 'plan_review', 'interface_design', 'tdd', 'frontend', 'backend', 'code_review', 'done']);
    }
  });
});
