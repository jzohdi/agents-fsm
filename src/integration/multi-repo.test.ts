/**
 * End-to-end multi-repo execution (Milestone 8 Phase A).
 *
 * The marquee Phase A capability: one **serial** Event Loop drives runs from *different* repos to
 * `done`, each serviced by its own repo's adapter and base branch. This exercises the whole chain the
 * other M8 tests cover only in isolation — the `repos` registry → the real `EnrolledRepoResolver` →
 * the Agent Runner → the loop — proving "the loop simply pulls events from runs in any repo" (README
 * §5 Milestone 8 Phase A) with zero new concurrency.
 */

import { describe, expect, it } from 'vitest';

import { goldenPathHandler, StubExecutor } from '../agent/executor';
import { AgentRunner } from '../agent/runner';
import { loadDefaultConfig } from '../fsm/config';
import { EventLoop } from '../loop/event-loop';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { FakeGitHub } from './github-fake';
import { EnrolledRepoResolver } from './github-resolver';

describe('multi-repo serial execution (Milestone 8 Phase A)', () => {
  it('drives runs from two repos to done on one serial loop, each via its own adapter + base', async () => {
    const { fsm, agents, version } = loadDefaultConfig();
    const repo = new Repository(openDb(':memory:'));

    // Two enrolled repos with *different* base branches, to prove the per-repo base threads through.
    repo.upsertRepo({ repoRef: 'acme/web', workingRoot: './w/web', baseBranch: 'main' });
    repo.upsertRepo({ repoRef: 'acme/api', workingRoot: './w/api', baseBranch: 'develop' });

    // The real registry-backed resolver, building a fake adapter per repo (captured so we can assert
    // each repo's side effects landed on its *own* adapter, never the other's).
    const adapters = new Map<string, FakeGitHub>();
    const resolver = new EnrolledRepoResolver(
      (ref) => repo.getRepo(ref),
      (row) => {
        const gh = new FakeGitHub({ repoRef: row.repoRef, autoSeedIssues: true });
        adapters.set(row.repoRef, gh);
        return gh;
      },
    );
    const runner = new AgentRunner(repo, new StubExecutor(goldenPathHandler), agents, resolver);
    const loop = new EventLoop(repo, fsm, version, runner);

    const webRun = loop.startRun({ issueRef: 'acme/web#1', repoRef: 'acme/web' });
    const apiRun = loop.startRun({ issueRef: 'acme/api#1', repoRef: 'acme/api' });
    await loop.runUntilIdle(); // one serial loop drains both runs, interleaved

    // Both runs completed the full pipeline.
    expect(repo.getRun(webRun.id)!.status).toBe('done');
    expect(repo.getRun(apiRun.id)!.status).toBe('done');

    // Each repo's PR landed on its own adapter, against that repo's base — no cross-talk.
    expect(adapters.get('acme/web')!.listPrs()).toHaveLength(1);
    expect(adapters.get('acme/api')!.listPrs()).toHaveLength(1);
    expect(adapters.get('acme/web')!.listPrs()[0]!.base).toBe('main');
    expect(adapters.get('acme/api')!.listPrs()[0]!.base).toBe('develop');
  });
});
