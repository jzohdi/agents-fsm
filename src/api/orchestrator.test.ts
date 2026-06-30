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
import { FatalExecutorError, StubExecutor, goldenPathHandler, type StageExecutor, type StubHandler } from '../agent/executor';
import { FakeGitHub } from '../integration/github-fake';
import { ApiError, Orchestrator } from './orchestrator';
import { Broadcaster, type StreamEvent } from './stream';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../fsm/default-config.json', import.meta.url));

/** Build an Orchestrator over an in-memory DB + stub + fake GitHub. The handler can reference the
 *  orchestrator via the returned object (e.g. to pause itself mid-stage) through a late binding. */
function setup(opts: { handler?: StubHandler; configPath?: string } = {}) {
  const loaded = loadDefaultConfig();
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ autoSeedIssues: true });
  const broadcaster = new Broadcaster();
  const events: StreamEvent[] = [];
  broadcaster.subscribe((e) => events.push(e));
  const runner = new AgentRunner(repo, new StubExecutor(opts.handler ?? goldenPathHandler), loaded.agents, github, {
    onActivity: (activity) => broadcaster.publish({ type: 'activity', activity }),
  });
  const orchestrator = new Orchestrator({
    repo,
    runner,
    config: loaded,
    broadcaster,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
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
});

describe('Orchestrator — queries', () => {
  it('lists runs, fetches detail, and 404s an unknown run', async () => {
    const { orchestrator } = setup();
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();

    expect(orchestrator.listRuns().map((r) => r.id)).toContain(run.id);
    expect(orchestrator.listRuns('done').map((r) => r.id)).toContain(run.id);

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
    const orchestrator = new Orchestrator({ repo, runner, config: loaded, broadcaster, onError: (e) => errors.push(e) });

    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle(); // must not reject

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(FatalExecutorError);
    // The run is NOT escalated (every run would hit this); the claimed event stays recoverable.
    expect(repo.getRun(run.id)!.status).toBe('running');
    expect(repo.recoverProcessingEvents()).toBe(1);
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
