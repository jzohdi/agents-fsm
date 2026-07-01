/**
 * Orchestrator tests (Milestone 5): the run-control commands, the drain pump, the config get/update
 * flow, and stream emission — all against the stub executor + fake GitHub, so no network and no cost.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadDefaultConfig } from '../fsm/config';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { AgentRunner } from '../agent/runner';
import {
  FatalExecutorError,
  StubExecutor,
  goldenPathHandler,
  type AgentRunRequest,
  type AgentRunResult,
  type StageExecutor,
  type StubHandler,
} from '../agent/executor';
import { FakeGitHub } from '../integration/github-fake';
import type { GitHub } from '../integration/github';
import { EnrolledRepoResolver, singleRepoResolver, type RepoResolver } from '../integration/github-resolver';
import { ApiError, Orchestrator } from './orchestrator';
import { Broadcaster, type StreamEvent } from './stream';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../fsm/default-config.json', import.meta.url));

/** Build an Orchestrator over an in-memory DB + stub + fake GitHub. The handler can reference the
 *  orchestrator via the returned object (e.g. to pause itself mid-stage) through a late binding. */
function setup(
  opts: {
    handler?: StubHandler;
    /** Override the stage executor entirely (e.g. a gated one to observe drain concurrency). */
    executor?: StageExecutor;
    configPath?: string;
    /** Build a custom resolver (e.g. an EnrolledRepoResolver) to exercise the enrollment check; the
     *  default accepts any repo (single-repo/mock behavior). */
    makeResolver?: (repo: Repository, github: GitHub) => RepoResolver;
    defaultWorkingRoot?: string;
    /** Global concurrency cap for the drain pump (Milestone 8 Phase B). Defaults to 1 (serial). */
    concurrency?: number;
    /** Global cost ceiling in dollars (Milestone 8 B3). Undefined = off. */
    costCeiling?: number;
  } = {},
) {
  const loaded = loadDefaultConfig();
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ autoSeedIssues: true });
  const broadcaster = new Broadcaster();
  const events: StreamEvent[] = [];
  broadcaster.subscribe((e) => events.push(e));
  const executor = opts.executor ?? new StubExecutor(opts.handler ?? goldenPathHandler);
  const runner = new AgentRunner(repo, executor, loaded.agents, github, {
    onActivity: (activity) => broadcaster.publish({ type: 'activity', activity }),
  });
  const resolver = opts.makeResolver?.(repo, github) ?? singleRepoResolver({ github, baseBranch: 'main' });
  const orchestrator = new Orchestrator({
    repo,
    runner,
    config: loaded,
    broadcaster,
    suggestionSource: { suggest: (q: string) => github.suggestIssues(q) },
    resolver,
    ...(opts.defaultWorkingRoot ? { defaultWorkingRoot: opts.defaultWorkingRoot } : {}),
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.costCeiling !== undefined ? { costCeiling: opts.costCeiling } : {}),
  });
  return { orchestrator, repo, github, events };
}

/** A handler that runs the golden path but fires `effect(runId)` once, the first time `stage` produces
 *  — used to simulate an operator command (pause/stop) arriving *while* a stage is in flight. */
function golden_with_interrupt(stage: string, effect: (runId: number) => void): StubHandler {
  let fired = false;
  return (req) => {
    if (!fired && req.stage === stage && req.phase === 'produce') {
      fired = true;
      effect(req.runId);
    }
    return goldenPathHandler(req);
  };
}

describe('Orchestrator — start + drain', () => {
  it('starts a run and drains it to done, streaming every transition', async () => {
    const { orchestrator, repo, events } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    expect(run.status).toBe('running');

    await orchestrator.settle();

    const final = repo.getRun(run.id)!;
    expect(final.status).toBe('done');
    expect(final.currentState).toBe('done');

    const streamed = events.filter((e) => e.type === 'transition').map((e) => (e.type === 'transition' ? e.transition.toState : ''));
    expect(streamed).toEqual(['plan', 'plan_review', 'interface_design', 'tdd', 'frontend', 'backend', 'code_review', 'done']);
  });

  it('derives repoRef from the issueRef when omitted, and requires an issueRef', () => {
    const { orchestrator, repo } = setup();
    const run = orchestrator.start({ issueRef: 'acme/widgets#7' });
    expect(repo.getRun(run.id)!.repoRef).toBe('acme/widgets');
    expect(() => orchestrator.start({ issueRef: '' })).toThrow(ApiError);
  });

  it('normalizes a pasted issue URL to the canonical owner/repo#N ref and repo', () => {
    const { orchestrator, repo } = setup();
    const run = orchestrator.start({ issueRef: 'https://github.com/jzohdi/tmux-speedrun/issues/31' });
    const stored = repo.getRun(run.id)!;
    expect(stored.issueRef).toBe('jzohdi/tmux-speedrun#31');
    expect(stored.repoRef).toBe('jzohdi/tmux-speedrun');
  });

  it('rejects an unparseable issue reference with a 400', () => {
    const { orchestrator } = setup();
    expect(() => orchestrator.start({ issueRef: 'not a ref' })).toThrow(ApiError);
  });

  it('refuses an unenrolled repo (400) when it cannot auto-enroll (no default working root)', () => {
    // A registry-backed (real) daemon with no `defaultWorkingRoot`: it can't auto-enroll, so an
    // unenrolled repo is a loud 400 and no run is created for it.
    const { orchestrator, repo } = setup({
      makeResolver: (repo, github) => new EnrolledRepoResolver((ref) => repo.getRepo(ref), () => github),
    });
    repo.upsertRepo({ repoRef: 'jzohdi/tmux-speedrun', workingRoot: './w' });

    // Enrolled repo (any casing/URL form) is admitted…
    expect(() => orchestrator.start({ issueRef: 'https://github.com/JZohdi/tmux-speedrun/issues/31' })).not.toThrow();
    // …an unenrolled repo is refused, and no run is created for it.
    expect(() => orchestrator.start({ issueRef: 'acme/web#318' })).toThrow(/not enrolled/);
    expect(repo.listRuns().map((r) => r.repoRef.toLowerCase())).toEqual(['jzohdi/tmux-speedrun']);
  });

  it('auto-enrolls an unenrolled repo on first run when a default working root is configured', () => {
    // The daemon path: `defaultWorkingRoot` is set (from `--work`), so filing a run on a repo the fleet
    // has never seen enrolls it with defaults and starts the run — no separate enroll step required.
    const { orchestrator, repo } = setup({
      defaultWorkingRoot: './work',
      makeResolver: (repo, github) => new EnrolledRepoResolver((ref) => repo.getRepo(ref), () => github),
    });

    const run = orchestrator.start({ issueRef: 'acme/web#318' });
    expect(run.status).toBe('running');
    expect(orchestrator.listRepos().map((r) => r.repoRef)).toEqual(['acme/web']); // auto-enrolled
    expect(repo.getRepo('acme/web')).toMatchObject({ workingRoot: './work', baseBranch: 'main' });
  });

  it('admits any repo under the single-repo/mock resolver (no enrollment gate)', () => {
    const { orchestrator } = setup(); // default: singleRepoResolver, accepts all
    expect(() => orchestrator.start({ issueRef: 'acme/web#1' })).not.toThrow();
    expect(() => orchestrator.start({ issueRef: 'other/repo#2' })).not.toThrow();
  });
});

describe('Orchestrator — repos (Milestone 8 Phase A)', () => {
  it('enrolls a repo (defaulting the working root) and lists it', () => {
    const { orchestrator } = setup({ defaultWorkingRoot: './work' });
    const enrolled = orchestrator.enrollRepo({ repoRef: 'acme/web' });
    expect(enrolled).toMatchObject({ repoRef: 'acme/web', workingRoot: './work', baseBranch: 'main' });
    expect(orchestrator.listRepos().map((r) => r.repoRef)).toEqual(['acme/web']);
  });

  it('rejects a malformed repoRef (400) and a missing working root with no daemon default (400)', () => {
    const { orchestrator } = setup(); // no defaultWorkingRoot
    expect(() => orchestrator.enrollRepo({ repoRef: 'not a repo' })).toThrow(ApiError);
    expect(() => orchestrator.enrollRepo({ repoRef: 'acme/web' })).toThrow(/workingRoot is required/);
  });

  it('re-enrolling updates the config AND invalidates the resolver cache (takes effect without restart)', () => {
    // The regression guard for the resolver's per-repo cache: a re-enroll must not leave a stale adapter.
    let resolver: EnrolledRepoResolver;
    const { orchestrator } = setup({
      defaultWorkingRoot: './work',
      makeResolver: (repo, github) => (resolver = new EnrolledRepoResolver((ref) => repo.getRepo(ref), () => github)),
    });

    orchestrator.enrollRepo({ repoRef: 'acme/web', baseBranch: 'main' });
    expect(resolver!.for('acme/web').baseBranch).toBe('main'); // resolves and caches

    orchestrator.enrollRepo({ repoRef: 'acme/web', baseBranch: 'develop' }); // re-enroll with new base
    expect(resolver!.for('acme/web').baseBranch).toBe('develop'); // cache was invalidated, not stale
    expect(orchestrator.listRepos()).toHaveLength(1); // still one repo
  });

  it('filters runs by repo and resolves a run to its repo (repoOfRun)', async () => {
    const { orchestrator } = setup(); // single-repo resolver accepts any repo
    const web = orchestrator.start({ issueRef: 'acme/web#1' });
    orchestrator.start({ issueRef: 'acme/api#1' });
    await orchestrator.settle();

    expect(orchestrator.listRuns({ repo: 'acme/web' }).map((r) => r.repoRef)).toEqual(['acme/web']);
    expect(orchestrator.repoOfRun(web.id)).toBe('acme/web');
    expect(orchestrator.repoOfRun(99999)).toBeUndefined();
  });
});

describe('Orchestrator — queries', () => {
  it('lists runs, fetches detail, and 404s an unknown run', async () => {
    const { orchestrator } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();

    expect(orchestrator.listRuns().map((r) => r.id)).toContain(run.id);
    expect(orchestrator.listRuns({ status: 'done' }).map((r) => r.id)).toContain(run.id);

    const detail = orchestrator.getRunDetail(run.id);
    expect(detail.run.id).toBe(run.id);
    expect(detail.transitions.length).toBeGreaterThan(0);
    expect(detail.agentRuns.length).toBeGreaterThan(0);
    expect(detail.artifacts.length).toBeGreaterThan(0); // plan/interface/pr artifacts recorded

    expect(() => orchestrator.getRun(99999)).toThrowError(/not found/);
    try {
      orchestrator.getRun(99999);
    } catch (err) {
      expect((err as ApiError).status).toBe(404);
    }
  });

  it('suggests from the suggestion source, and returns none when none is configured', async () => {
    const { orchestrator, github } = setup();
    github.seedIssue('acme/web#318', { number: 318, title: 'Checkout token refresh' });
    expect(await orchestrator.suggestIssues('checkout')).toEqual([
      { kind: 'issue', ref: 'acme/web#318', repo: 'acme/web', number: 318, title: 'Checkout token refresh' },
    ]);

    const loaded = loadDefaultConfig();
    const repo = new Repository(openDb(':memory:'));
    const broadcaster = new Broadcaster();
    const runner = new AgentRunner(repo, new StubExecutor(goldenPathHandler), loaded.agents, new FakeGitHub());
    const resolver = singleRepoResolver({ github: new FakeGitHub(), baseBranch: 'main' });
    const noGh = new Orchestrator({ repo, runner, config: loaded, broadcaster, resolver }); // suggestionSource omitted
    expect(await noGh.suggestIssues('anything')).toEqual([]);
  });
});

describe('Orchestrator — pause / resume', () => {
  it('honors a pause that arrives during a stage and resumes to done', async () => {
    const holder: { orchestrator?: Orchestrator } = {};
    const handler = golden_with_interrupt('plan', (runId) => holder.orchestrator!.pause(runId));
    const { orchestrator, repo, events } = setup({ handler });
    holder.orchestrator = orchestrator;

    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();

    // The in-flight `plan` stage finished and committed, but the run is parked — no further dispatch.
    const parked = repo.getRun(run.id)!;
    expect(parked.status).toBe('paused');
    expect(parked.currentState).toBe('plan_review'); // plan committed its transition, then dispatch stopped
    expect(events.some((e) => e.type === 'status' && e.status === 'paused')).toBe(true);

    const resumed = orchestrator.resume(run.id);
    expect(resumed.status).toBe('running');
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('done');
  });

  it('rejects pausing a non-running run and resuming a non-resumable one', async () => {
    const { orchestrator } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle(); // now done

    expectApiError(() => orchestrator.pause(run.id), 409);
    expectApiError(() => orchestrator.resume(run.id), 409);
  });

  it('resumes a needs_human run from where it escalated', async () => {
    let failed = false;
    const handler: StubHandler = (req) => {
      if (req.stage === 'plan' && req.phase === 'produce' && !failed) {
        failed = true;
        throw new Error('transient harness failure');
      }
      return goldenPathHandler(req);
    };
    const { orchestrator, repo } = setup({ handler });

    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('needs_human');

    const resumed = orchestrator.resume(run.id); // dispatches on status → loop.resumeRun
    expect(resumed.status).toBe('running');
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('done');
  });
});

describe('Orchestrator — stop', () => {
  it('stops an in-flight run terminally and refuses to resume it', async () => {
    const holder: { orchestrator?: Orchestrator } = {};
    const handler = golden_with_interrupt('plan', (runId) => holder.orchestrator!.stop(runId));
    const { orchestrator, repo, events } = setup({ handler });
    holder.orchestrator = orchestrator;

    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();

    const stopped = repo.getRun(run.id)!;
    expect(stopped.status).toBe('stopped');
    expect(events.some((e) => e.type === 'status' && e.status === 'stopped')).toBe(true);

    // Terminal: no further events dispatch, and resume/stop are refused.
    expectApiError(() => orchestrator.resume(run.id), 409);
    expectApiError(() => orchestrator.stop(run.id), 409);
  });
});

describe('Orchestrator — revert', () => {
  it('reverts a parked run to an earlier state and re-drives it to done (one fresh event, no stale follow-up)', async () => {
    // Park the run paused mid-`plan` (so it carries a leftover pending event), then revert further back.
    const holder: { orchestrator?: Orchestrator } = {};
    const handler = golden_with_interrupt('plan', (runId) => holder.orchestrator!.pause(runId));
    const { orchestrator, repo } = setup({ handler });
    holder.orchestrator = orchestrator;

    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('paused');

    orchestrator.revert(run.id, 'plan', 'plan needs a rethink');
    await orchestrator.settle();

    const transitions = repo.listTransitions(run.id);
    const revert = transitions.find((t) => t.trigger === 'revert')!;
    expect(revert.toState).toBe('plan');
    expect(revert.isReset).toBe(true); // counters reset, a fresh budget of rounds
    // The stale follow-up event was discarded, so each forward state is visited exactly once.
    const forwardVisits = transitions.filter((t) => t.toState === 'interface_design').length;
    expect(forwardVisits).toBe(1);
    expect(repo.getRun(run.id)!.status).toBe('done'); // re-drove forward to done again
  });

  it('validates revert input (reason + a real, non-terminal state) and refuses a terminal run', async () => {
    const { orchestrator } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1' });

    expectApiError(() => orchestrator.revert(run.id, 'plan', ''), 400); // missing reason
    expectApiError(() => orchestrator.revert(run.id, 'nope', 'x'), 400); // unknown state
    expectApiError(() => orchestrator.revert(run.id, 'done', 'x'), 400); // terminal target

    await orchestrator.settle(); // run reaches done
    expectApiError(() => orchestrator.revert(run.id, 'plan', 'x'), 409); // can't revert a terminal run
  });
});

describe('Orchestrator — archive', () => {
  it('archives a terminal run, refuses a live one (409), and unarchives anything', async () => {
    const { orchestrator, repo, events } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle(); // → done (terminal)

    const archived = orchestrator.archive(run.id);
    expect(archived.archivedAt).toBeTruthy();
    expect(repo.getRun(run.id)!.archivedAt).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ type: 'status', runId: run.id }); // broadcast for live clients

    const restored = orchestrator.unarchive(run.id);
    expect(restored.archivedAt).toBeNull();

    const live = orchestrator.start({ issueRef: 'o/r#2' }); // fresh run, not yet drained
    expectApiError(() => orchestrator.archive(live.id), 409);
    expectApiError(() => orchestrator.archive(99999), 404);
    await orchestrator.settle();
  });
});

describe('Orchestrator — config', () => {
  it('returns the live config', () => {
    const { orchestrator } = setup();
    const config = orchestrator.getConfig();
    expect(config.version).toMatch(/^[0-9a-f]{16}$/);
    expect(config.fsm.initial).toBe('triage');
  });

  it('validates, persists, and hot-swaps a new config version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-m5-cfg-'));
    const path = join(dir, 'config.json');
    const raw = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(raw));

    const { orchestrator } = setup({ configPath: path });
    const before = orchestrator.getConfig().version;

    const edited = { ...raw, budget: { ...(raw.budget as object), maxTokens: 123456 } };
    const { version } = orchestrator.updateConfig(edited);
    expect(version).not.toBe(before);
    expect(orchestrator.getConfig().version).toBe(version);
    expect(orchestrator.getConfig().fsm.budget?.maxTokens).toBe(123456);
    // The file on disk was rewritten with the new config.
    expect((JSON.parse(readFileSync(path, 'utf8')) as { budget: { maxTokens: number } }).budget.maxTokens).toBe(123456);

    // New runs pick up the new version; they still drive to done.
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();
    expect(orchestrator.getRun(run.id).fsmConfigVersion).toBe(version);
  });

  it('rejects an invalid config (400) without writing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-m5-cfg-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, '{"keep":"me"}');
    const { orchestrator } = setup({ configPath: path });

    expectApiError(() => orchestrator.updateConfig({ initial: 'ghost', escalationState: 'x', forwardOrder: [], states: {}, guards: {} }), 400);
    expect(readFileSync(path, 'utf8')).toBe('{"keep":"me"}'); // untouched
  });

  it('refuses to edit config while a run is in flight (409)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-m5-cfg-'));
    const path = join(dir, 'config.json');
    const raw = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(raw));

    const holder: { orchestrator?: Orchestrator } = {};
    const handler = golden_with_interrupt('plan', (runId) => holder.orchestrator!.pause(runId));
    const { orchestrator } = setup({ handler, configPath: path });
    holder.orchestrator = orchestrator;

    orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle(); // parks paused (non-terminal)

    expectApiError(() => orchestrator.updateConfig(raw), 409);
  });

  it('is read-only when no config path is configured (400)', () => {
    const { orchestrator } = setup();
    expectApiError(() => orchestrator.updateConfig({}), 400);
  });
});

describe('Orchestrator — drain errors', () => {
  it('routes a fatal drain error to onError without crashing or escalating the run', async () => {
    const loaded = loadDefaultConfig();
    const repo = new Repository(openDb(':memory:'));
    const broadcaster = new Broadcaster();
    const executor: StageExecutor = {
      run: () => Promise.reject(new FatalExecutorError('harness not authenticated', 'run `claude login`')),
    };
    const runner = new AgentRunner(repo, executor, loaded.agents, new FakeGitHub({ autoSeedIssues: true }));
    const errors: unknown[] = [];
    const resolver = singleRepoResolver({ github: new FakeGitHub(), baseBranch: 'main' });
    const orchestrator = new Orchestrator({ repo, runner, config: loaded, broadcaster, resolver, onError: (e) => errors.push(e) });

    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle(); // must not reject

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(FatalExecutorError);
    // The run is NOT escalated (every run would hit this); the claimed event stays recoverable.
    expect(repo.getRun(run.id)!.status).toBe('running');
    expect(repo.recoverProcessingEvents()).toBe(1);
  });
});

describe('Orchestrator — parallel drain (Milestone 8 Phase B)', () => {
  /** A gated executor that overlaps in flight and records peak global concurrency. Drives golden path. */
  class GatedExecutor implements StageExecutor {
    active = 0;
    peak = 0;
    async run(req: AgentRunRequest): Promise<AgentRunResult> {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const reply = goldenPathHandler(req);
        return { output: reply.output, usage: { tokens: reply.tokens ?? 1 } };
      } finally {
        this.active -= 1;
      }
    }
  }

  it('drives runs in different repos to done concurrently under the global cap', async () => {
    const executor = new GatedExecutor();
    const { orchestrator, repo } = setup({ executor, concurrency: 2 });

    // Two runs in different repos, started back-to-back; the pump should advance them in parallel.
    const a = orchestrator.start({ issueRef: 'a/one#1' });
    const b = orchestrator.start({ issueRef: 'b/two#1' });
    await orchestrator.settle();

    expect(repo.getRun(a.id)!.status).toBe('done');
    expect(repo.getRun(b.id)!.status).toBe('done');
    expect(repo.getRun(a.id)!.repoRef).toBe('a/one');
    expect(repo.getRun(b.id)!.repoRef).toBe('b/two');
    expect(executor.peak).toBeGreaterThan(1); // genuinely concurrent
    expect(executor.peak).toBeLessThanOrEqual(2); // never exceeds the cap
  });

  it('defaults to serial (concurrency 1) so at most one stage runs at a time', async () => {
    const executor = new GatedExecutor();
    const { orchestrator, repo } = setup({ executor }); // no concurrency → default 1

    const a = orchestrator.start({ issueRef: 'o/r#1' });
    const b = orchestrator.start({ issueRef: 'o/r#2' });
    await orchestrator.settle();

    expect(repo.getRun(a.id)!.status).toBe('done');
    expect(repo.getRun(b.id)!.status).toBe('done');
    expect(executor.peak).toBe(1);
  });
});

describe('Orchestrator — global cost ceiling + overrides (Milestone 8 B3)', () => {
  /** Golden path where every `produce` phase costs $1, so a run accrues ~$1 per stage. */
  const costlyHandler: StubHandler = (req) => (req.phase === 'produce' ? { ...goldenPathHandler(req), cost: 1 } : goldenPathHandler(req));

  it('refuses to start a new run once active spend reaches the ceiling (429)', () => {
    const { orchestrator, repo } = setup({ costCeiling: 5 });
    // A pre-existing active run already at the ceiling (a placeholder — never drained here).
    const active = repo.createRun({ issueRef: 'o/r#9', repoRef: 'o/r', initialState: 'triage', fsmConfigVersion: loadDefaultConfig().version });
    repo.addRunUsage(active.id, { cost: 5 });

    expectApiError(() => orchestrator.start({ issueRef: 'o/r#1' }), 429);
  });

  it('overrideCost lets a cost-parked run finish, then refuses the (now terminal) run (409)', async () => {
    const { orchestrator, repo } = setup({ costCeiling: 2, handler: costlyHandler });
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();

    // Parked mid-pipeline by the ceiling — running, not done.
    expect(repo.getRun(run.id)!.status).toBe('running');
    expect(repo.getRun(run.id)!.currentState).not.toBe('done');

    orchestrator.overrideCost(run.id, 'full');
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('done');

    // Nothing to advance on a terminal run.
    expectApiError(() => orchestrator.overrideCost(run.id, 'next_step'), 409);
  });
});

function expectApiError(fn: () => unknown, status: number): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    return;
  }
  throw new Error(`expected an ApiError(${status}) but none was thrown`);
}
