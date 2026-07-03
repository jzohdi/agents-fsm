/**
 * HTTP + SSE server tests (Milestone 5): drive the real server over an ephemeral port with `fetch`,
 * so the routing, JSON in/out, status codes, and the SSE stream are all exercised end to end —
 * still on the stub executor + fake GitHub (no network, no cost).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadDefaultConfig } from '../fsm/config';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { AgentRunner } from '../agent/runner';
import { StubExecutor, goldenPathHandler, type StubHandler } from '../agent/executor';
import { catalogForHarness } from '../agent/harness-models';
import { FakeGitHub } from '../integration/github-fake';
import { singleRepoResolver } from '../integration/github-resolver';
import { Orchestrator } from './orchestrator';
import { Broadcaster } from './stream';
import { createApiServer } from './server';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function start(opts: { publicDir?: string; handler?: StubHandler } = {}): Promise<{ base: string; orchestrator: Orchestrator; repo: Repository; github: FakeGitHub }> {
  const loaded = loadDefaultConfig();
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ autoSeedIssues: true });
  const broadcaster = new Broadcaster();
  const runner = new AgentRunner(repo, new StubExecutor(opts.handler ?? goldenPathHandler), loaded.agents, github, {
    onActivity: (activity) => broadcaster.publish({ type: 'activity', activity }),
  });
  const resolver = singleRepoResolver({ github, baseBranch: 'main' });
  const orchestrator = new Orchestrator({
    repo,
    runner,
    config: loaded,
    broadcaster,
    suggestionSource: { suggest: (q: string) => github.suggestIssues(q) },
    resolver,
    defaultWorkingRoot: './w',
    catalogFor: catalogForHarness,
    defaultModel: 'opus',
    // Stub the local-checkout validator so `POST /repos/source` local-mode is exercisable without a real
    // filesystem: a path containing "wrong" is rejected, everything else accepted (Milestone 12).
    validateLocalCheckout: async (dir) =>
      dir.includes('wrong') ? { ok: false, reason: `that directory is a checkout of other/repo, not the linked repo` } : { ok: true },
  });
  const server = createApiServer(orchestrator, opts.publicDir ? { publicDir: opts.publicDir } : {});
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, orchestrator, repo, github };
}

/** A throwaway dashboard dir so the static-serving test doesn't depend on a real `build:dashboard`. */
function fixturePublicDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'af-public-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>agent-fleet — orchestrator</title><div id="app"></div>');
  writeFileSync(join(dir, 'app.js'), 'export const x = 1;');
  writeFileSync(join(dir, 'style.css'), 'body{}');
  return dir;
}

describe('HTTP API', () => {
  it('starts a run, lists runs, and fetches run detail', async () => {
    const { base, orchestrator } = await start();

    const created = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueRef: 'o/r#1' }),
    });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: number; status: string };
    expect(run.status).toBe('running');

    await orchestrator.settle();

    const list = await (await fetch(`${base}/runs`)).json();
    expect((list as Array<{ id: number }>).some((r) => r.id === run.id)).toBe(true);

    const detail = (await (await fetch(`${base}/runs/${run.id}`)).json()) as {
      run: { status: string };
      transitions: unknown[];
      agentRuns: unknown[];
      artifacts: unknown[];
      logs: unknown[];
    };
    expect(detail.run.status).toBe('done');
    expect(detail.transitions.length).toBeGreaterThan(0);
    expect(Array.isArray(detail.agentRuns)).toBe(true);
    expect(Array.isArray(detail.artifacts)).toBe(true);
    expect(Array.isArray(detail.logs)).toBe(true);
  });

  it('threads an optional harness on POST /runs, defaulting when absent and 400ing an unknown one', async () => {
    const { base } = await start();

    // Absent → the daemon default.
    const def = await (await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueRef: 'o/r#1' }),
    })).json();
    expect((def as { harness: string }).harness).toBe('claude-code');

    // Explicit → stamped on the run.
    const chosen = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueRef: 'o/r#2', harness: 'cursor' }),
    });
    expect(chosen.status).toBe(201);
    expect((await chosen.json() as { harness: string }).harness).toBe('cursor');

    // Unknown → 400 (validated in the orchestrator via isHarnessId).
    const bad = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueRef: 'o/r#3', harness: 'gemini' }),
    });
    expect(bad.status).toBe(400);
  });

  it('re-points a run at another harness via POST /runs/:id/harness, clearing its model override', async () => {
    // Park the run in needs_human at `plan` so it can't drain to terminal before the switch lands.
    const { base, repo, orchestrator } = await start({
      handler: (req) => {
        if (req.stage === 'plan') throw new Error('parked for the harness-switch test');
        return goldenPathHandler(req);
      },
    });

    const run = (await (await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueRef: 'o/r#1', model: 'sonnet' }),
    })).json()) as { id: number };
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('needs_human'); // parked, not terminal — switchable

    const switched = await fetch(`${base}/runs/${run.id}/harness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness: 'cursor' }),
    });
    expect(switched.status).toBe(200);
    expect((await switched.json()) as object).toMatchObject({ harness: 'cursor', modelOverride: null });
    expect(repo.getRun(run.id)!.harness).toBe('cursor');

    // Unknown harness → 400; missing body field → 400.
    expect((await fetch(`${base}/runs/${run.id}/harness`, { method: 'POST', body: JSON.stringify({ harness: 'gemini' }) })).status).toBe(400);
    expect((await fetch(`${base}/runs/${run.id}/harness`, { method: 'POST', body: '{}' })).status).toBe(400);
  });

  it('serves a specific harness\'s catalog via GET /models?harness=, 400ing an unknown one', async () => {
    const { base } = await start();

    const cursor = (await (await fetch(`${base}/models?harness=cursor`)).json()) as { harness: string; models: Array<{ id: string }> };
    expect(cursor.harness).toBe('cursor');
    expect(cursor.models.map((m) => m.id)).toContain('gpt-5.4-high');

    const def = (await (await fetch(`${base}/models`)).json()) as { harness: string };
    expect(def.harness).toBe('claude-code'); // absent → the default harness, unchanged

    expect((await fetch(`${base}/models?harness=gemini`)).status).toBe(400);
  });

  it('threads an optional pre-selected model on POST /runs, seeding the override or 400ing a bad one', async () => {
    const { base } = await start();

    // A valid model for the chosen harness seeds the run's override.
    const withModel = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueRef: 'o/r#1', model: 'sonnet' }),
    });
    expect(withModel.status).toBe(201);
    expect((await withModel.json() as { modelOverride: string | null }).modelOverride).toBe('sonnet');

    // A model the chosen harness doesn't list (a Cursor id on the default claude-code harness) → 400.
    const bad = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueRef: 'o/r#2', model: 'gpt-5.4-high' }),
    });
    expect(bad.status).toBe(400);
  });

  it('threads pre-start effort on POST /runs and persists the sticky default via PUT /settings/default-model', async () => {
    const { base } = await start();
    const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

    // Pre-start effort is stamped on the run alongside the model (read from the immediate create response).
    const run = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueRef: 'o/r#1', model: 'opus', effort: 'high' }),
    }).then(json);
    expect(run.effortOverride).toBe('high');

    // An unknown effort level at start → 400 (validated against the chosen model).
    const badEffort = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueRef: 'o/r#2', model: 'opus', effort: 'ultra' }),
    });
    expect(badEffort.status).toBe(400);

    // The sticky default: persist a model+effort, then read it back through GET /settings.
    const saved = await fetch(`${base}/settings/default-model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet', effort: 'xhigh' }),
    }).then(json);
    expect(saved).toMatchObject({ defaultModel: 'sonnet', defaultEffort: 'xhigh' });
    const settings = await fetch(`${base}/settings`).then(json);
    expect(settings).toMatchObject({ defaultModel: 'sonnet', defaultEffort: 'xhigh' });
  });

  it('maps command errors to status codes', async () => {
    const { base, orchestrator } = await start();

    // Unknown run → 404.
    expect((await fetch(`${base}/runs/9999`)).status).toBe(404);
    // Missing issueRef → 400.
    const noIssue = await fetch(`${base}/runs`, { method: 'POST', body: '{}' });
    expect(noIssue.status).toBe(400);
    // Malformed JSON → 400.
    const badJson = await fetch(`${base}/runs`, { method: 'POST', body: '{not json' });
    expect(badJson.status).toBe(400);
    // Unknown non-GET route → 404 (an extension-less GET falls back to the SPA shell instead).
    expect((await fetch(`${base}/nope`, { method: 'POST' })).status).toBe(404);

    // Pausing a finished run → 409.
    const run = (await (await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1' }) })).json()) as { id: number };
    await orchestrator.settle();
    expect((await fetch(`${base}/runs/${run.id}/pause`, { method: 'POST' })).status).toBe(409);

    // The revert route parses a body: a finished run → 409 (route + body reached the command), and a
    // missing `toState` → 400 (input validation).
    const revertDone = await fetch(`${base}/runs/${run.id}/revert`, { method: 'POST', body: JSON.stringify({ toState: 'plan', reason: 'x' }) });
    expect(revertDone.status).toBe(409);
    const revertBad = await fetch(`${base}/runs/${run.id}/revert`, { method: 'POST', body: JSON.stringify({ reason: 'x' }) });
    expect(revertBad.status).toBe(400);

    // Resume validates the optional guidance notes before dispatching the command.
    const resumeBadNotes = await fetch(`${base}/runs/${run.id}/resume`, { method: 'POST', body: JSON.stringify({ notes: 42 }) });
    expect(resumeBadNotes.status).toBe(400);
  });

  it('resumes a needs_human run with operator guidance notes (recorded on the resume transition)', async () => {
    let failed = false;
    const { base, orchestrator, repo } = await start({
      handler: (req) => {
        if (req.stage === 'plan' && req.phase === 'produce' && !failed) {
          failed = true;
          throw new Error('transient harness failure');
        }
        return goldenPathHandler(req);
      },
    });

    const run = (await (await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1' }) })).json()) as { id: number };
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('needs_human');

    const res = await fetch(`${base}/runs/${run.id}/resume`, { method: 'POST', body: JSON.stringify({ notes: 'just retry' }) });
    expect(res.status).toBe(200);
    await orchestrator.settle();

    const resumeT = repo.listTransitions(run.id).find((t) => t.trigger === 'resume')!;
    expect(resumeT.reason).toEqual({ kind: 'operator_resume', notes: 'just retry' });
    expect(repo.getRun(run.id)!.status).toBe('done');
  });

  it('archives a terminal run and unarchives it (and 409s a live run)', async () => {
    const { base, orchestrator } = await start();
    const run = (await (await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1' }) })).json()) as { id: number };
    await orchestrator.settle(); // → done

    const archived = (await (await fetch(`${base}/runs/${run.id}/archive`, { method: 'POST' })).json()) as { archivedAt: string | null };
    expect(archived.archivedAt).toBeTruthy();
    const restored = (await (await fetch(`${base}/runs/${run.id}/unarchive`, { method: 'POST' })).json()) as { archivedAt: string | null };
    expect(restored.archivedAt).toBeNull();

    // archiving a missing run → 404 (the terminal-only 409 is covered deterministically in the orchestrator unit test)
    expect((await fetch(`${base}/runs/99999/archive`, { method: 'POST' })).status).toBe(404);
  });

  it('validates and routes POST /runs/:id/cost-override, and reports cost status (Milestone 8 B3)', async () => {
    const { base, orchestrator } = await start();
    const run = (await (await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1' }) })).json()) as { id: number };

    // GET /cost reports the ceiling (null — none configured here) and current active spend.
    const cost = (await (await fetch(`${base}/cost`)).json()) as { ceiling: number | null; activeCost: number };
    expect(cost.ceiling).toBeNull();
    expect(typeof cost.activeCost).toBe('number');

    // An invalid mode is a 400, validated at the boundary before touching the run.
    const bad = await fetch(`${base}/runs/${run.id}/cost-override`, { method: 'POST', body: JSON.stringify({ mode: 'sometimes' }) });
    expect(bad.status).toBe(400);

    // Let the run finish, then a valid override on the (now terminal) run is a 409.
    await orchestrator.settle();
    const onDone = await fetch(`${base}/runs/${run.id}/cost-override`, { method: 'POST', body: JSON.stringify({ mode: 'full' }) });
    expect(onDone.status).toBe(409);
  });

  it('gets the config and rejects an invalid update (read-only without a config path)', async () => {
    const { base } = await start();
    const config = (await (await fetch(`${base}/config`)).json()) as { version: string; fsm: { initial: string } };
    expect(config.fsm.initial).toBe('triage');
    expect(config.version).toMatch(/^[0-9a-f]{16}$/);

    // No config path was wired, so updates are read-only → 400.
    const put = await fetch(`${base}/config`, { method: 'PUT', body: JSON.stringify(config.fsm) });
    expect(put.status).toBe(400);

    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('serves new-run suggestions for ?q= from the suggestion source', async () => {
    const { base, github } = await start();
    github.seedIssue('acme/web#318', { number: 318, title: 'Checkout token refresh' });

    const res = await fetch(`${base}/suggestions?q=checkout`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ kind: 'issue', ref: 'acme/web#318', repo: 'acme/web', number: 318, title: 'Checkout token refresh' }]);

    expect(await (await fetch(`${base}/suggestions`)).json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ ref: 'acme/web#318' })]),
    ); // no query → all seeded issues
  });

  it('serves the harness model catalog and sets/clears/validates a run model override', async () => {
    // A malformed-output handler parks the run in needs_human (non-terminal), so the model override
    // applies regardless of how far the background drain has progressed — no race on the run finishing.
    const { base, repo } = await start({ handler: () => ({ output: { unparseable: true } }) });

    const models = (await (await fetch(`${base}/models`)).json()) as { harness: string; defaultModel: string; models: Array<{ id: string }> };
    expect(models.harness).toBe('claude-code');
    expect(models.defaultModel).toBe('opus');
    expect(models.models.map((m) => m.id)).toEqual(expect.arrayContaining(['opus', 'sonnet', 'haiku']));

    const run = (await (await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1' }) })).json()) as { id: number };

    const set = await fetch(`${base}/runs/${run.id}/model`, { method: 'POST', body: JSON.stringify({ model: 'sonnet' }) });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { modelOverride: string | null }).modelOverride).toBe('sonnet');

    const clear = await fetch(`${base}/runs/${run.id}/model`, { method: 'POST', body: JSON.stringify({ model: null }) });
    expect(((await clear.json()) as { modelOverride: string | null }).modelOverride).toBeNull();
    expect(repo.getRun(run.id)!.modelOverride).toBeNull();

    // An unknown model is a 400; a missing model field is a 400.
    expect((await fetch(`${base}/runs/${run.id}/model`, { method: 'POST', body: JSON.stringify({ model: 'gpt-4' }) })).status).toBe(400);
    expect((await fetch(`${base}/runs/${run.id}/model`, { method: 'POST', body: JSON.stringify({}) })).status).toBe(400);
  });

  it('serves the harness settings and persists a default-harness change (GET/PUT /settings)', async () => {
    const { base, repo } = await start();

    const before = (await (await fetch(`${base}/settings`)).json()) as { defaultHarness: string; harnesses: string[] };
    expect(before.defaultHarness).toBe('claude-code');
    expect(before.harnesses).toEqual(expect.arrayContaining(['claude-code', 'cursor']));

    // A valid change is persisted and echoed back; GET reflects it, and GET /models re-points to it.
    const put = await fetch(`${base}/settings/default-harness`, { method: 'PUT', body: JSON.stringify({ harness: 'cursor' }) });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { defaultHarness: string }).defaultHarness).toBe('cursor');
    expect(((await (await fetch(`${base}/settings`)).json()) as { defaultHarness: string }).defaultHarness).toBe('cursor');
    expect(((await (await fetch(`${base}/models`)).json()) as { harness: string }).harness).toBe('cursor');
    expect(repo.getSetting('default_harness')).toBe('cursor');

    // A bad id → 400; a missing field → 400.
    expect((await fetch(`${base}/settings/default-harness`, { method: 'PUT', body: JSON.stringify({ harness: 'gemini' }) })).status).toBe(400);
    expect((await fetch(`${base}/settings/default-harness`, { method: 'PUT', body: JSON.stringify({}) })).status).toBe(400);
  });

  it('routes POST /runs/:id/check-pr-feedback to an on-demand PR feedback check', async () => {
    const { base, orchestrator, repo, github } = await start();
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();
    const prNumber = repo.getRun(run.id)!.prNumber!;

    // With no new feedback, the finished run is still being watched.
    const first = (await (await fetch(`${base}/runs/${run.id}/check-pr-feedback`, { method: 'POST' })).json()) as { result: string };
    expect(first.result).toBe('watching');

    // A `feedback:` comment left after the run finished → the next check re-opens it and reports it.
    const finishedAt = repo.listTransitions(run.id).at(-1)!.createdAt;
    const after = new Date(Date.parse(finishedAt) + 1000).toISOString();
    github.seedPrComment(prNumber, { author: 'alice', body: 'feedback: rename it', createdAt: after });
    const res = await fetch(`${base}/runs/${run.id}/check-pr-feedback`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { status: string }; result: string };
    expect(body.result).toBe('reopened');
    expect(body.run.status).toBe('running');

    expect((await fetch(`${base}/runs/99999/check-pr-feedback`, { method: 'POST' })).status).toBe(404);
  });

  it('routes POST /runs/:id/check-reply to an on-demand reply check', async () => {
    let clarified = false;
    const { base, orchestrator, repo, github } = await start({
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

    // No reply yet.
    const first = (await (await fetch(`${base}/runs/${run.id}/check-reply`, { method: 'POST' })).json()) as { result: string };
    expect(first.result).toBe('no_reply');

    // The human replies on the issue → the check resumes the run.
    github.seedIssueComment(1, { author: 'human', body: 'feedback: use sqlite' });
    const res = await fetch(`${base}/runs/${run.id}/check-reply`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { status: string }; result: string };
    expect(body.result).toBe('resumed');

    expect((await fetch(`${base}/runs/99999/check-reply`, { method: 'POST' })).status).toBe(404);
  });

  it('routes POST /scheduler/check to an on-demand Scheduler pass (Milestone 9)', async () => {
    const { base, orchestrator, github } = await start();
    github.seedIssue('o/r#1', { number: 1 }); // the open dependency
    github.seedIssue('o/r#2', { number: 2, body: '<!-- agent-orchestrator:v1\ndepends_on: [1]\n-->' });
    const run = orchestrator.start({ issueRef: 'o/r#2' });
    await orchestrator.settle(); // triage caches the declaration; the claim parks the run

    const res = await fetch(`${base}/scheduler/check`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ parked: 1, woken: 0, escalated: 0 });
    // The scheduling cache is on the run JSON (read-only — the issue is the editor).
    const shown = (await (await fetch(`${base}/runs/${run.id}`)).json()) as { run: { status: string; dependsOn: number[] } };
    expect(shown.run).toMatchObject({ status: 'blocked', dependsOn: [1] });
  });

  it('streams live events over SSE', async () => {
    const { base, orchestrator } = await start();
    const controller = new AbortController();

    const res = await fetch(`${base}/stream`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();

    // Trigger work, drain it, then read what the stream captured.
    await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1' }) });
    await orchestrator.settle();

    const text = await readUntil(reader, (acc) => acc.includes('event: transition'));
    expect(text).toContain(': connected'); // the SSE preamble
    expect(text).toContain('event: transition');
    // The transition event payload is JSON with the run and the new state.
    const line = text.split('\n').find((l) => l.startsWith('data:') && l.includes('"type":"transition"'))!;
    const payload = JSON.parse(line.slice('data:'.length).trim()) as { type: string; run: { id: number } };
    expect(payload.type).toBe('transition');
    expect(typeof payload.run.id).toBe('number');

    await reader.cancel();
    controller.abort();
  });

  it('filters the SSE stream by ?runId', async () => {
    const { base, orchestrator } = await start();
    const controller = new AbortController();

    const res = await fetch(`${base}/stream?runId=1`, { signal: controller.signal });
    const reader = res.body!.getReader();

    // Start two runs; only run 1's events should reach this filtered stream.
    await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1' }) });
    await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#2' }) });
    await orchestrator.settle();

    // Read until run 1 reaches done; by then every event has been written.
    const text = await readUntil(reader, (acc) => acc.includes('"toState":"done"'));
    expect(text).toContain('"runId":1');
    expect(text).not.toContain('"runId":2'); // run 2's events were filtered out

    await reader.cancel();
    controller.abort();
  });

  it('enrolls a repo (POST /repos), lists them (GET /repos), and filters runs by ?repo= (Milestone 8)', async () => {
    const { base, orchestrator } = await start();

    const enroll = await fetch(`${base}/repos`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', baseBranch: 'develop' }) });
    expect(enroll.status).toBe(201);
    expect(await enroll.json()).toMatchObject({ repoRef: 'acme/web', baseBranch: 'develop' });
    // A malformed ref is a 400, not a row.
    expect((await fetch(`${base}/repos`, { method: 'POST', body: JSON.stringify({ repoRef: 'not a repo' }) })).status).toBe(400);

    const repos = (await (await fetch(`${base}/repos`)).json()) as Array<{ repoRef: string }>;
    expect(repos.map((r) => r.repoRef)).toEqual(['acme/web']);

    // An enrolled repo needs a working directory before it can run (M12); bind clone-on-run.
    await fetch(`${base}/repos/source`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', mode: 'clone' }) });

    // Runs in two repos (the single-repo resolver admits both); ?repo= scopes the list.
    await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'acme/web#1' }) });
    await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'acme/api#1' }) });
    await orchestrator.settle();

    const webRuns = (await (await fetch(`${base}/runs?repo=ACME/WEB`)).json()) as Array<{ repoRef: string }>;
    expect(webRuns.map((r) => r.repoRef)).toEqual(['acme/web']); // case-insensitive filter
  });

  it('binds a repo working directory via POST /repos/source (Milestone 12)', async () => {
    const { base } = await start();
    await fetch(`${base}/repos`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web' }) });

    // Clone-on-run.
    const clone = await fetch(`${base}/repos/source`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', mode: 'clone' }) });
    expect(clone.status).toBe(200);
    expect(await clone.json()).toMatchObject({ repoRef: 'acme/web', sourceMode: 'clone' });

    // A validated local directory.
    const local = await fetch(`${base}/repos/source`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', mode: 'local', localRepo: '/home/me/acme' }) });
    expect(await local.json()).toMatchObject({ sourceMode: 'local', localRepo: '/home/me/acme' });

    // The wrong directory is a 400 with the mismatch reason; an unknown mode is a 400; an unenrolled repo is a 404.
    const wrong = await fetch(`${base}/repos/source`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', mode: 'local', localRepo: '/home/me/wrong' }) });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toMatch(/checkout of other\/repo/);
    expect((await fetch(`${base}/repos/source`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', mode: 'sideways' }) })).status).toBe(400);
    expect((await fetch(`${base}/repos/source`, { method: 'POST', body: JSON.stringify({ repoRef: 'no/such', mode: 'clone' }) })).status).toBe(404);
  });

  it('serves directory-path completions for the local-directory picker (GET /fs/dirs)', async () => {
    const { base } = await start();
    const root = mkdtempSync(join(tmpdir(), 'af-fsdirs-'));
    mkdirSync(join(root, 'projects'));
    const res = await fetch(`${base}/fs/dirs?q=${encodeURIComponent(`${root}/pro`)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dirs: [join(root, 'projects')] });
    rmSync(root, { recursive: true, force: true });
  });

  it('toggles continuous mode via POST /repos/watch (Milestone 11)', async () => {
    const { base } = await start();
    await fetch(`${base}/repos`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web' }) });
    await fetch(`${base}/repos/source`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', mode: 'clone' }) }); // configured → watchable (M12)

    const on = await fetch(`${base}/repos/watch`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', watch: true, label: 'fleet: go' }) });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ repoRef: 'acme/web', watch: true, watchLabel: 'fleet: go' });

    // Watching an unenrolled repo is a 404; a non-boolean `watch` is a 400.
    expect((await fetch(`${base}/repos/watch`, { method: 'POST', body: JSON.stringify({ repoRef: 'no/such', watch: true }) })).status).toBe(404);
    expect((await fetch(`${base}/repos/watch`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', watch: 'yes' }) })).status).toBe(400);

    const off = await fetch(`${base}/repos/watch`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', watch: false }) });
    expect(await off.json()).toMatchObject({ watch: false });
  });

  it('filters the SSE stream by ?repo', async () => {
    const { base, orchestrator } = await start();
    const controller = new AbortController();

    const res = await fetch(`${base}/stream?repo=acme/web`, { signal: controller.signal });
    const reader = res.body!.getReader();

    // Two runs in different repos; only acme/web's events should reach this repo-scoped stream.
    await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'acme/web#1' }) });
    await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'acme/api#1' }) });
    await orchestrator.settle();

    const text = await readUntil(reader, (acc) => acc.includes('"toState":"done"'));
    expect(text).toContain('acme/web');
    expect(text).not.toContain('acme/api'); // the other repo's events were filtered out

    await reader.cancel();
    controller.abort();
  });
  it('serves the dashboard static assets (Layer 7) with correct content types', async () => {
    const { base } = await start({ publicDir: fixturePublicDir() });

    const index = await fetch(`${base}/`); // "/" → index.html
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('<title>agent-fleet');

    const app = await fetch(`${base}/app.js`);
    expect(app.status).toBe(200);
    expect(app.headers.get('content-type')).toContain('text/javascript');

    const css = await fetch(`${base}/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');

    // A missing asset is a clean 404 (and the API routes still win over static).
    expect((await fetch(`${base}/does-not-exist.js`)).status).toBe(404);

    // Extension-less client routes fall back to the SPA shell (deep links / reloads on /pipelines).
    for (const route of ['/pipelines', '/editor', '/nope']) {
      const page = await fetch(`${base}${route}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain('<title>agent-fleet');
    }
  });
});

/** Read chunks until `predicate(accumulated)` holds or a bound is hit (keeps the test from hanging). */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (accumulated: string) => boolean,
  maxChunks = 50,
): Promise<string> {
  const decoder = new TextDecoder();
  let acc = '';
  for (let i = 0; i < maxChunks; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    if (predicate(acc)) return acc;
  }
  throw new Error(`stream predicate not met; received:\n${acc}`);
}
