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
import { catalogForHarness } from '../agent/harness-models';
import { HarnessRegistry } from '../agent/harness';
import { EnrolledRepoResolver, singleRepoResolver, type RepoResolver } from '../integration/github-resolver';
import { ApiError, Orchestrator } from './orchestrator';
import { Broadcaster, type StreamEvent } from './stream';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../fsm/default-config.json', import.meta.url));

/** Build an Orchestrator over an in-memory DB + stub + fake GitHub. The handler can reference the
 *  orchestrator via the returned object (e.g. to pause itself mid-stage) through a late binding. */
function setup(
  opts: {
    handler?: StubHandler;
    /** Override the stage executor entirely (e.g. a gated one to observe drain concurrency, or a
     *  {@link HarnessRegistry} to exercise per-run harness dispatch). */
    executor?: StageExecutor | HarnessRegistry;
    configPath?: string;
    /** Build a custom resolver (e.g. an EnrolledRepoResolver) to exercise the enrollment check; the
     *  default accepts any repo (single-repo/mock behavior). */
    makeResolver?: (repo: Repository, github: GitHub) => RepoResolver;
    defaultWorkingRoot?: string;
    /** Global concurrency cap for the drain pump (Milestone 8 Phase B). Defaults to 1 (serial). */
    concurrency?: number;
    /** Global cost ceiling in dollars (Milestone 8 B3). Undefined = off. */
    costCeiling?: number;
    /** Stub local-checkout validator (Milestone 12). Defaults to always-ok so `configureRepoSource('local')`
     *  is testable without a real filesystem; pass a rejecting one to exercise the wrong-directory guard. */
    validateLocalCheckout?: (dir: string, repoRef: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
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
    catalogFor: catalogForHarness,
    defaultModel: 'opus',
    validateLocalCheckout: opts.validateLocalCheckout ?? (async () => ({ ok: true }) as const),
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
    repo.setRepoSource('jzohdi/tmux-speedrun', 'clone', null); // a configured working directory (M12)

    // Enrolled + configured repo (any casing/URL form) is admitted…
    expect(() => orchestrator.start({ issueRef: 'https://github.com/JZohdi/tmux-speedrun/issues/31' })).not.toThrow();
    // …an unenrolled repo is refused, and no run is created for it.
    expect(() => orchestrator.start({ issueRef: 'acme/web#318' })).toThrow(/not enrolled/);
    expect(repo.listRuns().map((r) => r.repoRef.toLowerCase())).toEqual(['jzohdi/tmux-speedrun']);
  });

  it('attaches an unknown repo UNCONFIGURED on first run and refuses to start until a directory is chosen (M12)', async () => {
    // With a `defaultWorkingRoot` (from `--work`), filing a run on a never-seen repo *attaches* it (so it
    // shows up in the Repositories ledger) but bounces the run — the operator must pick a working directory
    // first, rather than a run silently executing with no real source (the tmux-speedrun#35 failure).
    const { orchestrator, repo } = setup({
      defaultWorkingRoot: './work',
      makeResolver: (repo, github) => new EnrolledRepoResolver((ref) => repo.getRepo(ref), () => github),
    });

    expect(() => orchestrator.start({ issueRef: 'acme/web#318' })).toThrow(/choose a working directory/);
    expect(repo.listRuns()).toHaveLength(0); // no run started
    expect(orchestrator.listRepos().map((r) => r.repoRef)).toEqual(['acme/web']); // but attached (unconfigured)
    expect(repo.getRepo('acme/web')).toMatchObject({ workingRoot: './work', sourceMode: null });

    // Once configured, the run starts normally.
    await orchestrator.configureRepoSource({ repoRef: 'acme/web', mode: 'clone' });
    const run = orchestrator.start({ issueRef: 'acme/web#318' });
    expect(run.status).toBe('running');
  });

  it('refuses to start a run for an attached-but-unconfigured repo (M12)', () => {
    const { orchestrator, repo } = setup({
      makeResolver: (repo, github) => new EnrolledRepoResolver((ref) => repo.getRepo(ref), () => github),
    });
    repo.upsertRepo({ repoRef: 'acme/web', workingRoot: './w' }); // enrolled, no source chosen
    expect(() => orchestrator.start({ issueRef: 'acme/web#1' })).toThrow(/no working directory configured/);
    expect(repo.listRuns()).toHaveLength(0);
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

  it('reports the harness model catalog + the daemon default (empty when unconfigured)', () => {
    const { orchestrator } = setup();
    const models = orchestrator.getModels();
    expect(models.harness).toBe('claude-code');
    expect(models.defaultModel).toBe('opus');
    expect(models.models.map((m) => m.id)).toEqual(expect.arrayContaining(['opus', 'sonnet', 'haiku']));

    const loaded = loadDefaultConfig();
    const repo = new Repository(openDb(':memory:'));
    const broadcaster = new Broadcaster();
    const runner = new AgentRunner(repo, new StubExecutor(goldenPathHandler), loaded.agents, new FakeGitHub());
    const resolver = singleRepoResolver({ github: new FakeGitHub(), baseBranch: 'main' });
    const noCatalog = new Orchestrator({ repo, runner, config: loaded, broadcaster, resolver }); // catalogFor omitted
    expect(noCatalog.getModels()).toEqual({ harness: null, models: [], defaultModel: null });
  });
});

describe('Orchestrator — harness selection', () => {
  it('stamps the requested harness, defaults when omitted, and 400s an unknown one', () => {
    const { orchestrator } = setup();

    expect(orchestrator.start({ issueRef: 'o/r#1' }).harness).toBe('claude-code'); // omitted → default
    expect(orchestrator.start({ issueRef: 'o/r#2', harness: '' }).harness).toBe('claude-code'); // empty → default
    expect(orchestrator.start({ issueRef: 'o/r#3', harness: 'cursor' }).harness).toBe('cursor'); // explicit

    try {
      orchestrator.start({ issueRef: 'o/r#4', harness: 'gemini' });
      throw new Error('expected an unknown harness to be rejected');
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toMatch(/unknown harness "gemini"/);
    }
  });

  it('stamps a pre-selected model, defaults when omitted, and validates it against the chosen harness', () => {
    const { orchestrator, repo } = setup();

    // A valid model for the (default) harness seeds the run's override at creation.
    const withModel = orchestrator.start({ issueRef: 'o/r#1', model: 'sonnet' });
    expect(repo.getRun(withModel.id)!.modelOverride).toBe('sonnet');

    // Omitted / empty → no override (the daemon default applies).
    expect(repo.getRun(orchestrator.start({ issueRef: 'o/r#2' }).id)!.modelOverride).toBeNull();
    expect(repo.getRun(orchestrator.start({ issueRef: 'o/r#3', model: '' }).id)!.modelOverride).toBeNull();

    // The model is validated against the *chosen* harness's catalog: a Cursor model is fine for a cursor
    // run but rejected for the default (claude-code) harness, and an unknown model is always a 400.
    const cursorRun = orchestrator.start({ issueRef: 'o/r#4', harness: 'cursor', model: 'gpt-5.4-high' });
    expect(repo.getRun(cursorRun.id)!.modelOverride).toBe('gpt-5.4-high');

    expect(() => orchestrator.start({ issueRef: 'o/r#5', model: 'gpt-5.4-high' })).toThrow(
      /unknown model "gpt-5.4-high" for the claude-code harness/,
    );
    try {
      orchestrator.start({ issueRef: 'o/r#6', model: 'no-such-model' });
      throw new Error('expected an unknown model to be rejected');
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
    }
  });

  it('reports + changes the default harness, persisting it and re-pointing getModels (no restart)', () => {
    const { orchestrator, repo } = setup();

    const before = orchestrator.getSettings();
    expect(before.defaultHarness).toBe('claude-code');
    expect(before.harnesses).toContain('cursor');
    expect(orchestrator.getModels().harness).toBe('claude-code');

    const result = orchestrator.setDefaultHarness('cursor');
    expect(result.defaultHarness).toBe('cursor');
    // Live: a harness-less run now defaults to cursor, and the model dropdown follows the new default…
    expect(orchestrator.getSettings().defaultHarness).toBe('cursor');
    const models = orchestrator.getModels();
    expect(models.harness).toBe('cursor');
    // …and the reported default model stays consistent with the shown catalog — the Claude `opus` default
    // isn't a Cursor model, so it's dropped rather than mislabeled as Cursor's default.
    expect(models.models.map((m) => m.id)).not.toContain('opus');
    expect(models.defaultModel).toBeNull();
    expect(orchestrator.start({ issueRef: 'o/r#1' }).harness).toBe('cursor');
    // …and it's persisted, so a future boot (resolveDefaultHarness) reads it back.
    expect(repo.getSetting('default_harness')).toBe('cursor');
  });

  it('rejects an unknown default harness (400) and leaves the current default + setting untouched', () => {
    const { orchestrator, repo } = setup();
    try {
      orchestrator.setDefaultHarness('gemini');
      throw new Error('expected setDefaultHarness to reject an unknown id');
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
    }
    expect(orchestrator.getSettings().defaultHarness).toBe('claude-code'); // unchanged
    expect(repo.getSetting('default_harness')).toBeUndefined(); // nothing persisted
  });

  it('validates a model override against the run\'s own harness catalog', async () => {
    const { orchestrator, repo } = setup();
    const cursorRun = orchestrator.start({ issueRef: 'o/r#1', harness: 'cursor' });

    // A cursor model is accepted for a cursor run; a Claude-only model is a 400 (wrong harness).
    orchestrator.setModel(cursorRun.id, 'claude-4.5-sonnet');
    expect(repo.getRun(cursorRun.id)!.modelOverride).toBe('claude-4.5-sonnet');
    expect(() => orchestrator.setModel(cursorRun.id, 'opus')).toThrow(/unknown model "opus" for the cursor harness/);

    await orchestrator.settle();
  });

  it('resolves a specific harness\'s catalog via getModels(harness), 400ing an unknown one', () => {
    const { orchestrator } = setup();

    // The per-run picker asks for the catalog of the harness the run is on, not the default's.
    const cursor = orchestrator.getModels('cursor');
    expect(cursor.harness).toBe('cursor');
    expect(cursor.models.map((m) => m.id)).toContain('gpt-5.4-high');
    expect(cursor.defaultModel).toBeNull(); // the Claude `opus` default is not a Cursor model

    expect(orchestrator.getModels().harness).toBe('claude-code'); // absent → the default, unchanged

    try {
      orchestrator.getModels('gemini');
      throw new Error('expected an unknown harness to be rejected');
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
    }
  });
});

describe('Orchestrator — per-run harness switch', () => {
  it('re-points the run, clears the old catalog\'s model/effort overrides, and broadcasts', async () => {
    const { orchestrator, repo, events } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1', model: 'sonnet', effort: 'high' });

    const switched = orchestrator.setHarness(run.id, 'cursor');
    expect(switched.harness).toBe('cursor');
    // The overrides named claude-code models; they must not survive onto the cursor catalog.
    expect(repo.getRun(run.id)!.modelOverride).toBeNull();
    expect(repo.getRun(run.id)!.effortOverride).toBeNull();
    expect(events.some((e) => e.type === 'status' && e.runId === run.id)).toBe(true);

    await orchestrator.settle();
  });

  it('keeps the overrides on a same-harness call (a no-op, not a reset)', async () => {
    const { orchestrator, repo } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1', model: 'sonnet' });

    orchestrator.setHarness(run.id, 'claude-code');
    expect(repo.getRun(run.id)!.modelOverride).toBe('sonnet');

    await orchestrator.settle();
  });

  it('404s an unknown run, 400s an unknown harness, and 409s a terminal run', async () => {
    const { orchestrator, repo } = setup();
    expect(() => orchestrator.setHarness(99999, 'cursor')).toThrow(/not found/);

    const run = orchestrator.start({ issueRef: 'o/r#1' });
    try {
      orchestrator.setHarness(run.id, 'gemini');
      throw new Error('expected an unknown harness to be rejected');
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
    }

    await orchestrator.settle(); // → done (terminal)
    try {
      orchestrator.setHarness(run.id, 'cursor');
      throw new Error('expected setHarness to throw on a terminal run');
    } catch (err) {
      expect((err as ApiError).status).toBe(409);
    }
    expect(repo.getRun(run.id)!.harness).toBe('claude-code'); // both guards precede any write
  });

  it('dispatches the next stage on the new harness executor — pause, switch, resume (through the loop)', async () => {
    // Two recording executors behind a registry: the run starts on claude-code, pauses mid-`plan`,
    // is re-pointed at cursor, and every stage after the resume must hit the cursor executor only.
    const stagesOn = (seen: string[]): StubExecutor =>
      new StubExecutor((req) => {
        if (req.phase === 'produce') seen.push(req.stage);
        return goldenPathHandler(req);
      });
    const seenClaude: string[] = [];
    const seenCursor: string[] = [];
    const holder: { orchestrator?: Orchestrator } = {};
    const registry = new HarnessRegistry({
      'claude-code': new StubExecutor((req) => {
        if (req.phase === 'produce') {
          seenClaude.push(req.stage);
          if (req.stage === 'plan') holder.orchestrator!.pause(req.runId); // honored when the stage commits
        }
        return goldenPathHandler(req);
      }),
      cursor: stagesOn(seenCursor),
    });
    const { orchestrator, repo } = setup({ executor: registry });
    holder.orchestrator = orchestrator;

    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('paused'); // parked after `plan` finished

    orchestrator.setHarness(run.id, 'cursor');
    orchestrator.resume(run.id);
    await orchestrator.settle();

    expect(repo.getRun(run.id)!.status).toBe('done');
    expect(seenClaude).toEqual(['triage', 'plan']); // everything up to the pause, and nothing after
    expect(seenCursor).toContain('plan_review'); // the very next stage onward ran on cursor
    expect(seenCursor).toContain('code_review');
  });

  it('leaves a paused run paused (no status change, no premature advance)', async () => {
    const holder: { orchestrator?: Orchestrator } = {};
    const handler = golden_with_interrupt('plan', (runId) => holder.orchestrator!.pause(runId));
    const { orchestrator, repo } = setup({ handler });
    holder.orchestrator = orchestrator;

    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle(); // parks paused mid-pipeline
    expect(repo.getRun(run.id)!.status).toBe('paused');
    const parkedState = repo.getRun(run.id)!.currentState;

    orchestrator.setHarness(run.id, 'cursor');
    await orchestrator.settle(); // a harness change must NOT kick the run forward

    const after = repo.getRun(run.id)!;
    expect(after.status).toBe('paused'); // still parked — only Resume advances it
    expect(after.currentState).toBe(parkedState); // its parked stage is untouched
    expect(after.harness).toBe('cursor'); // …but the change is applied, ready for the next stage on resume
  });

  it('400s an unknown harness id and leaves the run (and its overrides) untouched', () => {
    const { orchestrator, repo } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1', model: 'opus', effort: 'high' });

    expectApiError(() => orchestrator.setHarness(run.id, 'gemini'), 400);

    // The validation precedes every write: harness unchanged AND the overrides are NOT cleared.
    const after = repo.getRun(run.id)!;
    expect(after.harness).toBe('claude-code');
    expect(after.modelOverride).toBe('opus');
    expect(after.effortOverride).toBe('high');
  });
});

describe('Orchestrator — model selection', () => {
  it('sets, clears, and validates a run model override; broadcasts the change', async () => {
    const { orchestrator, repo, events } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1' });

    orchestrator.setModel(run.id, 'sonnet');
    expect(repo.getRun(run.id)!.modelOverride).toBe('sonnet');
    // The change is broadcast so connected dashboards update live.
    expect(events.some((e) => e.type === 'status' && e.runId === run.id)).toBe(true);

    orchestrator.setModel(run.id, null); // clear → back to the daemon default
    expect(repo.getRun(run.id)!.modelOverride).toBeNull();

    // A model the harness catalog doesn't list is a 400, and never stored.
    expect(() => orchestrator.setModel(run.id, 'gpt-4')).toThrow(/unknown model/);
    expect(repo.getRun(run.id)!.modelOverride).toBeNull();

    await orchestrator.settle();
  });

  it('404s an unknown run and 409s a terminal run', async () => {
    const { orchestrator } = setup();
    expect(() => orchestrator.setModel(99999, 'opus')).toThrow(/not found/);

    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle(); // drives it to done (terminal)
    try {
      orchestrator.setModel(run.id, 'opus');
      throw new Error('expected setModel to throw on a terminal run');
    } catch (err) {
      expect((err as ApiError).status).toBe(409);
    }
  });

  it('applies a mid-run model change on the next stage, not the current one (through the loop)', async () => {
    // Record the model each stage's produce phase asked for, and flip the override while `plan` runs.
    const seen: Record<string, string> = {};
    const { orchestrator } = setup({
      handler: (req) => {
        if (req.phase === 'produce' && !(req.stage in seen)) seen[req.stage] = req.model;
        if (req.stage === 'plan' && req.phase === 'produce') orchestrator.setModel(req.runId, 'sonnet');
        return goldenPathHandler(req);
      },
    });

    orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();

    expect(seen.triage).toBe('frontier'); // before the change
    expect(seen.plan).toBe('frontier'); // the stage that made the change keeps the model it started with
    expect(seen.plan_review).toBe('sonnet'); // the NEXT stage's fresh dispatch picks up the override
    expect(seen.tdd).toBe('sonnet'); // …and every stage after it
  });
});

describe('Orchestrator — reasoning effort', () => {
  it('stamps a pre-start effort, and validates it against the harness + model', () => {
    const { orchestrator, repo } = setup();

    // A valid effort for an effort-capable model is stamped on the run.
    const run = orchestrator.start({ issueRef: 'o/r#1', model: 'opus', effort: 'high' });
    expect(repo.getRun(run.id)!.effortOverride).toBe('high');

    // An unknown level, a model that doesn't support effort, and the cursor harness are each a 400.
    expect(() => orchestrator.start({ issueRef: 'o/r#2', model: 'opus', effort: 'ultra' })).toThrow(/unknown effort/);
    expect(() => orchestrator.start({ issueRef: 'o/r#3', model: 'haiku', effort: 'high' })).toThrow(/doesn't support the "high" effort/);
    expect(() => orchestrator.start({ issueRef: 'o/r#4', harness: 'cursor', effort: 'high' })).toThrow(/cursor harness doesn't support reasoning effort/);
  });

  it('sets, clears, and validates a run effort override, and drops it when the model stops supporting it', () => {
    const { orchestrator, repo, events } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1', model: 'opus' });

    orchestrator.setEffort(run.id, 'xhigh');
    expect(repo.getRun(run.id)!.effortOverride).toBe('xhigh');
    expect(events.some((e) => e.type === 'status' && e.runId === run.id)).toBe(true);

    // Switching to a model without effort support silently clears the now-invalid effort.
    orchestrator.setModel(run.id, 'haiku');
    expect(repo.getRun(run.id)!.effortOverride).toBeNull();

    // An unknown level is a 400 and nothing is stored.
    orchestrator.setModel(run.id, 'opus');
    orchestrator.setEffort(run.id, 'medium');
    expect(() => orchestrator.setEffort(run.id, 'ultra')).toThrow(/unknown effort/);
    expect(repo.getRun(run.id)!.effortOverride).toBe('medium');

    orchestrator.setEffort(run.id, null); // clear
    expect(repo.getRun(run.id)!.effortOverride).toBeNull();
  });
});

describe('Orchestrator — sticky defaults (persisted pre-run selection)', () => {
  it('persists the pre-run model + effort and pre-fills them back through getSettings', () => {
    const { orchestrator } = setup();
    expect(orchestrator.getSettings().defaultModel).toBeNull();

    const saved = orchestrator.setDefaultModel('opus', 'high');
    expect(saved).toEqual({ defaultModel: 'opus', defaultEffort: 'high' });
    const settings = orchestrator.getSettings();
    expect(settings.defaultModel).toBe('opus');
    expect(settings.defaultEffort).toBe('high');

    // An effort that doesn't fit the model is dropped (not a 400) so the stored pair stays consistent.
    expect(orchestrator.setDefaultModel('haiku', 'high')).toEqual({ defaultModel: 'haiku', defaultEffort: null });
    // A model the harness doesn't list is a 400.
    expect(() => orchestrator.setDefaultModel('gpt-4', null)).toThrow(/unknown model/);
  });

  it('applies the persisted default when a start request omits model/effort, and clears it on harness change', () => {
    const { orchestrator, repo } = setup();
    orchestrator.setDefaultModel('opus', 'high');

    // A start with no explicit model/effort falls back to the persisted default.
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    expect(repo.getRun(run.id)!.modelOverride).toBe('opus');
    expect(repo.getRun(run.id)!.effortOverride).toBe('high');

    // Changing the default harness clears the (now cross-harness) persisted model + effort.
    orchestrator.setDefaultHarness('cursor');
    const settings = orchestrator.getSettings();
    expect(settings.defaultModel).toBeNull();
    expect(settings.defaultEffort).toBeNull();
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

  it('threads guided-resume notes through to the resume transition', async () => {
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

    orchestrator.resume(run.id, 'just retry');
    await orchestrator.settle();

    const resumeT = repo.listTransitions(run.id).find((t) => t.trigger === 'resume')!;
    expect(resumeT.reason).toEqual({ kind: 'operator_resume', notes: 'just retry' });
    expect(repo.getRun(run.id)!.status).toBe('done');
  });
});

describe('Orchestrator — stop', () => {
  it('stops an in-flight run terminally; stopping again is refused (but resume re-opens it)', async () => {
    const holder: { orchestrator?: Orchestrator } = {};
    const handler = golden_with_interrupt('plan', (runId) => holder.orchestrator!.stop(runId));
    const { orchestrator, repo, events } = setup({ handler });
    holder.orchestrator = orchestrator;

    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();

    const stopped = repo.getRun(run.id)!;
    expect(stopped.status).toBe('stopped');
    expect(events.some((e) => e.type === 'status' && e.status === 'stopped')).toBe(true);

    // Terminal: no follow-up event dispatched, and stopping again is a 409. Resuming a stopped run,
    // by contrast, re-opens it — `stop` is reversible (see the resume-stopped test).
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

describe('Orchestrator — on-demand PR feedback check', () => {
  /** Start a run and drive it to `done` (so it has an open PR). */
  async function toDone() {
    const h = setup();
    const run = h.orchestrator.start({ issueRef: 'o/r#1' });
    await h.orchestrator.settle();
    expect(h.repo.getRun(run.id)!.status).toBe('done');
    return { ...h, run };
  }

  /** Seed a reviewer feedback comment timed after the run finished, so it counts as unaddressed. */
  function seedFeedbackAfterFinish(repo: Repository, github: FakeGitHub, runId: number) {
    const finishedAt = repo.listTransitions(runId).at(-1)!.createdAt;
    const after = new Date(Date.parse(finishedAt) + 1000).toISOString();
    github.seedPrComment(repo.getRun(runId)!.prNumber!, { author: 'alice', body: 'feedback: rename the endpoint', createdAt: after });
  }

  it('re-opens the run when a feedback: comment is left after it finished, else keeps watching', async () => {
    const { orchestrator, repo, github, run } = await toDone();
    const prNumber = repo.getRun(run.id)!.prNumber!;

    expect((await orchestrator.checkPrFeedback(run.id)).result).toBe('watching'); // open PR, no new feedback
    seedFeedbackAfterFinish(repo, github, run.id);

    const { result } = await orchestrator.checkPrFeedback(run.id);
    expect(result).toBe('reopened');
    await orchestrator.settle();
    // Re-opened and driven back to done on the same PR (no duplicate).
    expect(repo.getRun(run.id)!.prNumber).toBe(prNumber);
  });

  it('reports "stopped" and flags the run once the PR is merged', async () => {
    const { orchestrator, repo, github, run } = await toDone();
    github.setPrState(repo.getRun(run.id)!.prNumber!, 'merged');

    const { result } = await orchestrator.checkPrFeedback(run.id);
    expect(result).toBe('stopped');
    expect(repo.getRun(run.id)!.flags.pr_feedback_closed).toBe(true);
  });

  it('reports "not_watching" for a finished run without a PR, and 404s an unknown run', async () => {
    const { orchestrator, repo } = setup();
    const bare = repo.createRun({ issueRef: 'o/r#9', repoRef: 'o/r', initialState: 'triage', fsmConfigVersion: 'v1' });
    repo.setRunStatus(bare.id, 'done'); // done but never opened a PR

    expect((await orchestrator.checkPrFeedback(bare.id)).result).toBe('not_watching');
    await expect(orchestrator.checkPrFeedback(999)).rejects.toBeInstanceOf(ApiError);
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

describe('Orchestrator — dependency scheduling (Milestone 9)', () => {
  it('refuses a second active run for the same issue (409), but allows a re-run once finished', async () => {
    const { orchestrator, repo } = setup();
    const first = orchestrator.start({ issueRef: 'o/r#1' });

    // Active (running) → a duplicate is a conflict, whatever the ref's casing/URL form.
    expect(() => orchestrator.start({ issueRef: 'o/r#1' })).toThrow(/already has an active run/);
    expect(() => orchestrator.start({ issueRef: 'O/R#1' })).toThrow(ApiError);

    await orchestrator.settle();
    expect(repo.getRun(first.id)!.status).toBe('done');
    // Finished → re-running the issue is legitimate (e.g. a follow-up fix).
    expect(() => orchestrator.start({ issueRef: 'o/r#1' })).not.toThrow();
  });

  it('checkDependencies runs one Scheduler pass and kicks the pump after a wake', async () => {
    const { orchestrator, repo, github } = setup();
    github.seedIssue('o/r#1', { number: 1 }); // the open dependency
    github.seedIssue('o/r#2', { number: 2, body: '<!-- agent-orchestrator:v1\ndepends_on: [1]\n-->' });
    const run = orchestrator.start({ issueRef: 'o/r#2' });
    await orchestrator.settle(); // triage caches the declaration; the claim then parks the run

    expect((await orchestrator.checkDependencies()).parked).toBe(1);
    expect(repo.getRun(run.id)!.status).toBe('blocked');

    github.closeIssue(1);
    expect((await orchestrator.checkDependencies()).woken).toBe(1);
    await orchestrator.settle(); // the kick dispatched the freed work

    expect(repo.getRun(run.id)!.status).toBe('done');
  });
});

describe('Orchestrator — repo working-directory source (Milestone 12)', () => {
  it('binds clone-on-run mode without touching the filesystem', async () => {
    const { orchestrator, repo } = setup({ defaultWorkingRoot: './work' });
    orchestrator.enrollRepo({ repoRef: 'acme/web' });
    const configured = await orchestrator.configureRepoSource({ repoRef: 'acme/web', mode: 'clone' });
    expect(configured).toMatchObject({ sourceMode: 'clone', localRepo: null });
    expect(repo.getRepo('acme/web')!.sourceMode).toBe('clone');
  });

  it('binds a validated local directory (worktree mode), storing the path', async () => {
    const seen: Array<[string, string]> = [];
    const { orchestrator, repo } = setup({
      defaultWorkingRoot: './work',
      validateLocalCheckout: async (dir, ref) => { seen.push([dir, ref]); return { ok: true }; },
    });
    orchestrator.enrollRepo({ repoRef: 'acme/web' });
    const configured = await orchestrator.configureRepoSource({ repoRef: 'acme/web', mode: 'local', localRepo: '/home/me/acme' });
    expect(configured).toMatchObject({ sourceMode: 'local', localRepo: '/home/me/acme' });
    expect(seen).toEqual([['/home/me/acme', 'acme/web']]); // validated against the linked repo
    expect(repo.getRepo('acme/web')!.localRepo).toBe('/home/me/acme');
  });

  it('rejects a directory that is a checkout of a different repo (the wrong-directory guard)', async () => {
    const { orchestrator, repo } = setup({
      defaultWorkingRoot: './work',
      validateLocalCheckout: async () => ({ ok: false, reason: 'that directory is a checkout of other/repo, not acme/web' }),
    });
    orchestrator.enrollRepo({ repoRef: 'acme/web' });
    await expect(orchestrator.configureRepoSource({ repoRef: 'acme/web', mode: 'local', localRepo: '/home/me/other' }))
      .rejects.toThrow(/checkout of other\/repo/);
    expect(repo.getRepo('acme/web')!.sourceMode).toBeNull(); // unchanged — still unconfigured
  });

  it('requires a path for local mode (400) and refuses an unenrolled repo (404)', async () => {
    const { orchestrator } = setup({ defaultWorkingRoot: './work' });
    await expect(orchestrator.configureRepoSource({ repoRef: 'ghost/repo', mode: 'clone' })).rejects.toThrow(/not enrolled/);
    orchestrator.enrollRepo({ repoRef: 'acme/web' });
    await expect(orchestrator.configureRepoSource({ repoRef: 'acme/web', mode: 'local' })).rejects.toThrow(/localRepo .* is required/);
  });

  it('a re-enroll (POST /repos) never resets a repo\'s chosen working directory', async () => {
    const { orchestrator, repo } = setup({ defaultWorkingRoot: './work' });
    orchestrator.enrollRepo({ repoRef: 'acme/web' });
    await orchestrator.configureRepoSource({ repoRef: 'acme/web', mode: 'local', localRepo: '/home/me/acme' });
    orchestrator.enrollRepo({ repoRef: 'acme/web', baseBranch: 'develop' }); // re-enroll with a new base
    expect(repo.getRepo('acme/web')).toMatchObject({ baseBranch: 'develop', sourceMode: 'local', localRepo: '/home/me/acme' });
  });
});

describe('Orchestrator — repo watch + issue intake (Milestone 11)', () => {
  it('setRepoWatch requires an enrolled repo (404), a valid ref (400), and a configured working directory (400)', () => {
    const { orchestrator, repo } = setup();
    expect(() => orchestrator.setRepoWatch({ repoRef: 'o/r', watch: true })).toThrow(/not enrolled/);
    expect(() => orchestrator.setRepoWatch({ repoRef: 'not a repo', watch: true })).toThrow(ApiError);

    orchestrator.enrollRepo({ repoRef: 'o/r', workingRoot: './w' });
    // Enrolled but no working directory chosen yet → can't watch it (M12).
    expect(() => orchestrator.setRepoWatch({ repoRef: 'o/r', watch: true })).toThrow(/no working directory configured/);

    repo.setRepoSource('o/r', 'clone', null);
    const watched = orchestrator.setRepoWatch({ repoRef: 'o/r', watch: true, label: 'fleet: go' });
    expect(watched).toMatchObject({ watch: true, watchLabel: 'fleet: go' });
  });

  it('a watch pass auto-starts a run for an eligible issue and drains it to done', async () => {
    const { orchestrator, repo, github } = setup();
    orchestrator.enrollRepo({ repoRef: 'o/r', workingRoot: './w' });
    repo.setRepoSource('o/r', 'clone', null);
    orchestrator.setRepoWatch({ repoRef: 'o/r', watch: true });
    github.seedIssue('o/r#1', { number: 1, author: 'o' }); // owner-filed → eligible

    const pass = await orchestrator.pollIssueIntakeOnce();
    expect(pass).toMatchObject({ reposScanned: 1, started: 1 });
    await orchestrator.settle(); // the auto-started run kicked the pump

    const run = repo.listRuns()[0]!;
    expect(run.issueRef).toBe('o/r#1');
    expect(repo.getRun(run.id)!.status).toBe('done');
  });

  it('the intake path honors start guards: a non-owner issue is skipped, no run created', async () => {
    const { orchestrator, repo, github } = setup();
    orchestrator.enrollRepo({ repoRef: 'o/r', workingRoot: './w' });
    repo.setRepoSource('o/r', 'clone', null);
    orchestrator.setRepoWatch({ repoRef: 'o/r', watch: true });
    github.seedIssue('o/r#1', { number: 1, author: 'stranger' });

    expect(await orchestrator.pollIssueIntakeOnce()).toMatchObject({ started: 0, skipped: 1 });
    expect(repo.listRuns()).toHaveLength(0);
  });

  it('an unwatched enrolled repo is never scanned', async () => {
    const { orchestrator, repo, github } = setup();
    orchestrator.enrollRepo({ repoRef: 'o/r', workingRoot: './w' }); // enrolled, not watched
    github.seedIssue('o/r#1', { number: 1, author: 'o' });

    expect(await orchestrator.pollIssueIntakeOnce()).toMatchObject({ reposScanned: 0, started: 0 });
    expect(repo.listRuns()).toHaveLength(0);
  });
});

describe('Orchestrator — resume a stopped run + on-demand reply check', () => {
  it('resume re-opens a stopped run and drains it from where it left off', async () => {
    const holder: { orch?: Orchestrator } = {};
    let stopped = false;
    const { orchestrator, repo } = setup({
      handler: (req) => {
        if (!stopped && req.stage === 'plan' && req.phase === 'produce') {
          stopped = true;
          holder.orch!.stop(req.runId); // stop mid-pipeline → terminal at a non-terminal state
        }
        return goldenPathHandler(req);
      },
    });
    holder.orch = orchestrator;

    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('stopped');

    const resumed = orchestrator.resume(run.id);
    expect(resumed.status).toBe('running');
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('done'); // picked back up and finished
  });

  it('resume still refuses a genuinely un-resumable status (e.g. running) with a 409', async () => {
    const { orchestrator } = setup({ executor: { run: () => new Promise<never>(() => {}) } }); // stage never resolves
    const run = orchestrator.start({ issueRef: 'o/r#1' }); // stays running
    expect(() => orchestrator.resume(run.id)).toThrow(/cannot resume a "running" run/);
  });

  it('checkReply resumes an awaiting_input run when the human replied (on-demand)', async () => {
    let clarified = false;
    const { orchestrator, repo, github } = setup({
      handler: (req) => {
        if (req.stage === 'triage') {
          if (!clarified) { clarified = true; return { output: { decision: 'clarify', questions: ['which db?'] } }; }
          return { output: { decision: 'proceed' } };
        }
        return goldenPathHandler(req);
      },
    });
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('awaiting_input');

    // No reply yet → no_reply, still parked.
    expect((await orchestrator.checkReply(run.id)).result).toBe('no_reply');

    // The operator replies on the issue; detection is by the bot-comment marker, not author login.
    github.seedIssueComment(1, { author: 'o', body: 'feedback: use sqlite, proceed' });
    const checked = await orchestrator.checkReply(run.id);
    expect(checked.result).toBe('resumed');
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('done');
  });

  it('checkReply reports not_awaiting for a run that is not parked on input, and 404s an unknown run', async () => {
    const { orchestrator, repo } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('done');
    expect((await orchestrator.checkReply(run.id)).result).toBe('not_awaiting');
    await expect(orchestrator.checkReply(9999)).rejects.toThrow(ApiError);
  });
});

describe('Orchestrator — drain pump wake (mid-flight admission)', () => {
  /** A stage executor whose every stage blocks until released, recording start order — lets a test see a
   *  second run begin while the first is still in flight. */
  class GatedExecutor implements StageExecutor {
    started: string[] = [];
    private waiters: Array<() => void> = [];
    async run(req: AgentRunRequest): Promise<AgentRunResult> {
      this.started.push(`${req.runId}:${req.stage}`);
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      const reply = goldenPathHandler(req);
      return { output: reply.output, usage: { tokens: reply.tokens ?? 1 } };
    }
    releaseAll(): void {
      const waiting = this.waiters;
      this.waiters = [];
      for (const r of waiting) r();
    }
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('a run started while another is mid-stage dispatches immediately when the cap has room', async () => {
    const executor = new GatedExecutor();
    // Concurrency 2 so the second run has a free slot; the regression is that it wasn't used until the
    // first stage finished. (At the default cap of 1 this is correctly serial and not what we test.)
    const { orchestrator, repo } = setup({ executor, concurrency: 2 });

    const a = orchestrator.start({ issueRef: 'o/r#1' });
    await flush();
    expect(executor.started).toEqual([`${a.id}:triage`]); // A in flight, gated

    const b = orchestrator.start({ issueRef: 'o/r#2' }); // admitted mid-drain → kick() wakes the pool
    await flush();
    expect(executor.started).toContain(`${b.id}:triage`); // B dispatched WITHOUT A completing

    // Drive both to completion, then confirm a clean drain.
    for (let i = 0; i < 1000 && (repo.getRun(a.id)!.status !== 'done' || repo.getRun(b.id)!.status !== 'done'); i++) {
      executor.releaseAll();
      await flush();
    }
    await orchestrator.settle();
    expect(repo.getRun(a.id)!.status).toBe('done');
    expect(repo.getRun(b.id)!.status).toBe('done');
  });
});

describe('Orchestrator — graceful shutdown', () => {
  it('interrupts an in-flight stage without escalating, savepoints its tree, and leaves the event recoverable', async () => {
    // A stage held in flight, like a real harness child mid-run when the operator hits Ctrl-C.
    let interrupt: ((err: Error) => void) | undefined;
    const stub = new StubExecutor(goldenPathHandler);
    const executor: StageExecutor = {
      run(req: AgentRunRequest): Promise<AgentRunResult> {
        if (req.stage === 'plan' && !interrupt) {
          return new Promise((_, reject) => {
            interrupt = reject;
          });
        }
        return stub.run(req);
      },
    };
    const { orchestrator, repo, github } = setup({ executor });
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    for (let i = 0; i < 200 && !interrupt; i++) await new Promise((r) => setTimeout(r, 0)); // until plan is in flight
    expect(interrupt).toBeDefined(); // plan started: its working tree exists, its harness "child" is live

    const shutdown = orchestrator.shutdown(); // latch the loop, then wait for the drain to settle…
    interrupt!(new Error('cursor-agent exited with code 130: Aborting operation...')); // …as the signalled child dies
    const summary = await shutdown;

    // The interruption was recognized as shutdown, not misfiled as a harness failure.
    expect(summary).toEqual({ interruptedRuns: 1, savepointed: 1 });
    expect(github.savepoints).toEqual([{ runId: run.id, message: `wip: shutdown savepoint (run ${run.id}, stage plan)` }]);
    const parked = repo.getRun(run.id)!;
    expect(parked.status).toBe('running'); // NOT needs_human
    expect(parked.currentState).toBe('plan'); // still at the interrupted stage
    // The event is stranded `processing` — exactly what the next start's recover() re-queues.
    expect(repo.listProcessingRunIds()).toEqual([run.id]);
    expect(repo.recoverProcessingEvents()).toBe(1);
  });

  it('with nothing in flight, shutdown is a clean no-op summary', async () => {
    const { orchestrator, repo } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle(); // run completes before shutdown begins

    expect(await orchestrator.shutdown()).toEqual({ interruptedRuns: 0, savepointed: 0 });
    expect(repo.getRun(run.id)!.status).toBe('done'); // untouched
  });
});
