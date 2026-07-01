/**
 * Concurrent crash recovery under the worker pool (Milestone 8 Phase B — B2).
 *
 * B1 proved the pool is parallel across runs / serial within a run and respects the cap. B2 proves the
 * at-least-once + idempotent-handler design (README §3.3 Layer 3) and the M7 transactional outbox still
 * hold when several runs across *different repos* are recovered and drained **concurrently** — the
 * README-mandated Phase B test: "kill mid-flight with several runs in progress across repos; on restart
 * assert no duplicate or lost events, no duplicate transitions, no duplicate comments/sub-issues."
 *
 * The per-repo working roots + per-run working trees this relies on already exist (Phase A wires each
 * repo's adapter from its `repos` row; `prepareWorkingTree` keys the tree by the *global* run id), so
 * these tests exercise that machinery rather than adding to it. The FSM engine and its tests are
 * untouched, per the milestone invariant.
 */

import { describe, expect, it, vi } from 'vitest';

import { goldenPathHandler, StubExecutor, type StubHandler } from '../agent/executor';
import { AgentRunner } from '../agent/runner';
import { loadDefaultConfig } from '../fsm/config';
import { EventLoop } from '../loop/event-loop';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { FakeGitHub } from './github-fake';
import { EnrolledRepoResolver } from './github-resolver';

/** Two enrolled repos (distinct base branches), a real registry-backed resolver building one fake
 *  adapter per repo (captured so a test can assert each repo's side effects landed on its own adapter),
 *  and a pool-capable loop. Mirrors the Phase A multi-repo harness, now driven concurrently. */
function makeFleet(handler: StubHandler = goldenPathHandler) {
  const { fsm, agents, version } = loadDefaultConfig();
  const repo = new Repository(openDb(':memory:'));
  repo.upsertRepo({ repoRef: 'acme/web', workingRoot: './w/web', baseBranch: 'main' });
  repo.upsertRepo({ repoRef: 'acme/api', workingRoot: './w/api', baseBranch: 'develop' });

  const adapters = new Map<string, FakeGitHub>();
  const resolver = new EnrolledRepoResolver(
    (ref) => repo.getRepo(ref),
    (row) => {
      const gh = new FakeGitHub({ repoRef: row.repoRef, autoSeedIssues: true });
      adapters.set(row.repoRef, gh);
      return gh;
    },
  );
  const runner = new AgentRunner(repo, new StubExecutor(handler), agents, resolver);
  const loop = new EventLoop(repo, fsm, version, runner);
  return { repo, loop, runner, resolver, adapters };
}

/** The canonical golden path is 8 transitions (triage → … → done); each run should have exactly these. */
const GOLDEN_PATH_LENGTH = 8;

describe('concurrent crash recovery under the pool (Milestone 8 Phase B — B2)', () => {
  it('recovers several post-commit crashes across repos with no duplicate or lost events', async () => {
    const { repo, loop, adapters } = makeFleet();

    // Four runs, two per repo, each with its own issue.
    const runs = [
      loop.startRun({ issueRef: 'acme/web#1', repoRef: 'acme/web' }),
      loop.startRun({ issueRef: 'acme/web#2', repoRef: 'acme/web' }),
      loop.startRun({ issueRef: 'acme/api#1', repoRef: 'acme/api' }),
      loop.startRun({ issueRef: 'acme/api#2', repoRef: 'acme/api' }),
    ];

    // Simulate a crash mid-flight with every run in progress: claim + apply each run's first event
    // (the transition commits and enqueues the follow-up) but never finalize it — the exact
    // post-commit / pre-markDone window, times N runs. The within-run claim guard hands out a distinct
    // run per claim, so one pass leaves all four stranded `processing` with committed transitions.
    for (let i = 0; i < runs.length; i++) {
      const event = repo.claimNextEvent()!;
      await loop.applyEvent(event);
    }
    expect(repo.listRuns().every((r) => repo.listTransitions(r.id).length === 1)).toBe(true);

    // Restart: reclaim the four stranded events, then drain them concurrently under the pool.
    expect(loop.recover()).toBe(runs.length);
    await loop.drain(3);

    for (const run of runs) {
      const finalRun = repo.getRun(run.id)!;
      expect(finalRun.status).toBe('done'); // no lost event — every run reached the terminal state

      // Exactly the golden path: the stranded first stage finalized (not re-run) and each later stage
      // advanced once. A duplicate transition is impossible (UNIQUE event_id) and a re-run would show as
      // an extra transition; distinct non-null event ids prove event-keyed integrity.
      const eventIds = repo.listTransitions(run.id).map((t) => t.eventId);
      expect(eventIds).toHaveLength(GOLDEN_PATH_LENGTH);
      expect(eventIds.every((id) => id !== null)).toBe(true);
      expect(new Set(eventIds).size).toBe(eventIds.length);
    }

    // Side effects landed exactly once, each on its own repo's adapter — one PR per run, distinct
    // per-run branches (the per-run working trees), no cross-repo talk.
    for (const [repoRef, count] of [['acme/web', 2], ['acme/api', 2]] as const) {
      const prs = adapters.get(repoRef)!.listPrs();
      expect(prs).toHaveLength(count);
      expect(new Set(prs.map((p) => p.branch)).size).toBe(count); // distinct branches ⇒ distinct trees
    }
  });

  it('holds the transactional outbox under concurrency: no duplicate sub-issues or comments on replay', async () => {
    // Each run's triage decides `split` (create two sub-issues + post a comment — all non-idempotent),
    // then escalates `should_split` (no handoff). Golden path for any other stage (unused here).
    const splitHandler: StubHandler = (req) =>
      req.stage === 'triage'
        ? { output: { decision: 'split', subIssues: [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }] } }
        : goldenPathHandler(req);
    const { repo, loop, runner, resolver, adapters } = makeFleet(splitHandler);

    // Build both adapters up front so we can spy on the non-idempotent calls per repo.
    resolver.for('acme/web');
    resolver.for('acme/api');
    const spies = new Map(
      [...adapters].map(([ref, gh]) => [
        ref,
        { createIssue: vi.spyOn(gh, 'createIssue'), postIssueComment: vi.spyOn(gh, 'postIssueComment') },
      ]),
    );

    const runs = [
      loop.startRun({ issueRef: 'acme/web#1', repoRef: 'acme/web' }),
      loop.startRun({ issueRef: 'acme/api#1', repoRef: 'acme/api' }),
    ];

    // Simulate a PRE-commit crash on every run: claim its event and run the stage (the split's GitHub
    // calls execute and are recorded in the outbox), but the daemon dies before the transition commits —
    // the event stays `processing`, the transition log empty.
    for (const run of runs) {
      repo.claimNextEvent();
      await runner.runStage(repo.getRun(run.id)!);
    }
    for (const [, s] of spies) {
      expect(s.createIssue).toHaveBeenCalledTimes(2); // two sub-issues per run, once
      expect(s.postIssueComment).toHaveBeenCalledTimes(1);
    }
    expect(repo.listRuns().every((r) => repo.listTransitions(r.id).length === 0)).toBe(true);

    // Restart: reclaim both stranded events and drain concurrently. triage re-runs for both runs at
    // once, but every non-idempotent call replays from each run's own `(run_id, key)` ledger — so NO
    // duplicate sub-issues and NO duplicate comment, on either repo.
    expect(loop.recover()).toBe(runs.length);
    await loop.drain(2);

    for (const [, s] of spies) {
      expect(s.createIssue).toHaveBeenCalledTimes(2); // still 2, not 4
      expect(s.postIssueComment).toHaveBeenCalledTimes(1); // still 1, not 2
    }
    for (const run of runs) {
      expect(repo.getRun(run.id)!.status).toBe('needs_human'); // a no-handoff split escalates
      expect(repo.listTransitions(run.id).filter((t) => t.trigger === 'should_split')).toHaveLength(1);
    }
  });
});
