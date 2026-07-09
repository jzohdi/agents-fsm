/**
 * HTTP + SSE server tests (Milestone 5): drive the real server over an ephemeral port with `fetch`,
 * so the routing, JSON in/out, status codes, and the SSE stream are all exercised end to end —
 * still on the stub executor + fake GitHub (no network, no cost).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
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
import type { SuggestionSource } from '../integration/github-account';
import { singleRepoResolver } from '../integration/github-resolver';
import { Orchestrator } from './orchestrator';
import { Broadcaster } from './stream';
import { createApiServer } from './server';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

interface StartOpts {
  publicDir?: string;
  handler?: StubHandler;
  apiToken?: string;
  tls?: { cert: string; key: string };
  // --- remote-access hardening (issue #27) ---
  /** Token-bucket config threaded into `createApiServer` (mutating/expensive routes). */
  rateLimit?: { capacity: number; refillPerSec: number };
  /** Max request-body bytes before a `413`. */
  maxBodyBytes?: number;
  /** Exact-match CORS allow-list (empty/omitted ⇒ deny all cross-origin). */
  allowedOrigins?: string[];
  /** Injected clock (epoch ms) so the rate limiter is deterministic in tests. */
  now?: () => number;
  /** Override the autocomplete suggestion source — used to force a non-`ApiError` internal throw. */
  suggestionSource?: SuggestionSource;
}

async function start(opts: StartOpts = {}): Promise<{ base: string; orchestrator: Orchestrator; repo: Repository; github: FakeGitHub }> {
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
    suggestionSource: opts.suggestionSource ?? { suggest: (q: string) => github.suggestIssues(q) },
    resolver,
    defaultWorkingRoot: './w',
    catalogFor: catalogForHarness,
    defaultModel: 'opus',
    // Stub the local-checkout validator so `POST /repos/source` local-mode is exercisable without a real
    // filesystem: a path containing "wrong" is rejected, everything else accepted (Milestone 12).
    validateLocalCheckout: async (dir) =>
      dir.includes('wrong') ? { ok: false, reason: `that directory is a checkout of other/repo, not the linked repo` } : { ok: true },
  });
  const server = createApiServer(orchestrator, {
    ...(opts.publicDir ? { publicDir: opts.publicDir } : {}),
    ...(opts.apiToken ? { apiToken: opts.apiToken } : {}),
    ...(opts.tls ? { tls: opts.tls } : {}),
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `${opts.tls ? 'https' : 'http'}://127.0.0.1:${port}`, orchestrator, repo, github };
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

  it('changes a run harness via POST /runs/:id/harness, clearing its model/effort overrides', async () => {
    // A malformed-output handler parks the run in needs_human (non-terminal), so the harness change
    // applies regardless of how far the background drain has progressed — no race on the run finishing.
    const { base, repo } = await start({ handler: () => ({ output: { unparseable: true } }) });

    const run = (await (await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1', model: 'opus', effort: 'high' }) })).json()) as {
      id: number;
      harness: string;
    };
    expect(run.harness).toBe('claude-code');

    // A valid harness id is echoed back on the updated run, and the overrides are cleared to null.
    const set = await fetch(`${base}/runs/${run.id}/harness`, { method: 'POST', body: JSON.stringify({ harness: 'cursor' }) });
    expect(set.status).toBe(200);
    const body = (await set.json()) as { harness: string; modelOverride: string | null; effortOverride: string | null };
    expect(body.harness).toBe('cursor');
    expect(body.modelOverride).toBeNull();
    expect(body.effortOverride).toBeNull();
    expect(repo.getRun(run.id)!.harness).toBe('cursor'); // persisted

    // A missing / non-string body → 400; an unknown harness id → 400.
    expect((await fetch(`${base}/runs/${run.id}/harness`, { method: 'POST', body: JSON.stringify({}) })).status).toBe(400);
    expect((await fetch(`${base}/runs/${run.id}/harness`, { method: 'POST', body: JSON.stringify({ harness: 42 }) })).status).toBe(400);
    expect((await fetch(`${base}/runs/${run.id}/harness`, { method: 'POST', body: JSON.stringify({ harness: 'gemini' }) })).status).toBe(400);
  });

  it('409s a harness change on a terminal run', async () => {
    const { base, orchestrator, repo } = await start();
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle(); // drives it to done (terminal)
    expect(repo.getRun(run.id)!.status).toBe('done');

    expect((await fetch(`${base}/runs/${run.id}/harness`, { method: 'POST', body: JSON.stringify({ harness: 'cursor' }) })).status).toBe(409);
    expect(repo.getRun(run.id)!.harness).toBe('claude-code'); // unchanged
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

  it('toggles auto-merge via POST /repos/auto-merge (agents-fsm#15)', async () => {
    const { base } = await start();
    await fetch(`${base}/repos`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web' }) });

    const on = await fetch(`${base}/repos/auto-merge`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', enabled: true }) });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ repoRef: 'acme/web', autoMerge: true });

    // Auto-merging an unenrolled repo is a 404; a non-boolean `enabled` is a 400.
    expect((await fetch(`${base}/repos/auto-merge`, { method: 'POST', body: JSON.stringify({ repoRef: 'no/such', enabled: true }) })).status).toBe(404);
    expect((await fetch(`${base}/repos/auto-merge`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', enabled: 'yes' }) })).status).toBe(400);

    const off = await fetch(`${base}/repos/auto-merge`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', enabled: false }) });
    expect(await off.json()).toMatchObject({ autoMerge: false });
  });

  it('round-trips the scope filter through POST /repos/watch (issue #11)', async () => {
    const { base } = await start();
    await fetch(`${base}/repos`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web' }) });
    await fetch(`${base}/repos/source`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', mode: 'clone' }) });

    // A label + milestone filter persists and comes back on the returned Repo.
    const set = await fetch(`${base}/repos/watch`, {
      method: 'POST',
      body: JSON.stringify({ repoRef: 'acme/web', watch: true, filterLabel: 'bug', filterMilestone: 'v2' }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ watch: true, watchFilterLabel: 'bug', watchFilterMilestone: 'v2' });

    // It is visible on GET /repos too.
    const repos = (await (await fetch(`${base}/repos`)).json()) as Array<{ repoRef: string }>;
    expect(repos.find((r: { repoRef: string }) => r.repoRef === 'acme/web')).toMatchObject({
      watchFilterLabel: 'bug',
      watchFilterMilestone: 'v2',
    });

    // An empty-string filter field normalizes to null (a blank input clears the filter).
    const cleared = await fetch(`${base}/repos/watch`, {
      method: 'POST',
      body: JSON.stringify({ repoRef: 'acme/web', watch: true, filterLabel: '' }),
    });
    expect(await cleared.json()).toMatchObject({ watchFilterLabel: null, watchFilterMilestone: 'v2' });

    // A non-string / non-null filter field is a 400.
    expect(
      (
        await fetch(`${base}/repos/watch`, {
          method: 'POST',
          body: JSON.stringify({ repoRef: 'acme/web', watch: true, filterLabel: 42 }),
        })
      ).status,
    ).toBe(400);
  });

  it('accepts and round-trips inFlightCap through POST /repos/watch, rejecting a bad value (agents-fsm#10)', async () => {
    const { base } = await start();
    await fetch(`${base}/repos`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web' }) });
    await fetch(`${base}/repos/source`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', mode: 'clone' }) });

    // A valid cap persists and comes back on the returned Repo.
    const set = await fetch(`${base}/repos/watch`, {
      method: 'POST',
      body: JSON.stringify({ repoRef: 'acme/web', watch: true, inFlightCap: 3 }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ watch: true, watchInFlightCap: 3 });

    // A non-number cap is a 400 at the route boundary; 0 (non-positive) is a 400 at the orchestrator.
    expect(
      (await fetch(`${base}/repos/watch`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', watch: true, inFlightCap: 'lots' }) })).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/repos/watch`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', watch: true, inFlightCap: 0 }) })).status,
    ).toBe(400);

    // Omitting the cap (a plain toggle) leaves the stored value unchanged; GET /repos round-trips it.
    await fetch(`${base}/repos/watch`, { method: 'POST', body: JSON.stringify({ repoRef: 'acme/web', watch: false }) });
    const repos = (await (await fetch(`${base}/repos`)).json()) as Array<{ repoRef: string; watchInFlightCap: number }>;
    expect(repos.find((r) => r.repoRef === 'acme/web')?.watchInFlightCap).toBe(3);
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

describe('HTTP API — auth (issue #25)', () => {
  const TOKEN = 'super-secret-fleet-token';

  it('auth-off passthrough: with no token configured a normal route and /stream still succeed', async () => {
    const { base } = await start(); // no apiToken → auth disabled (byte-for-byte current behaviour)

    // A normal route is open.
    expect((await fetch(`${base}/runs`)).status).toBe(200);

    // The SSE stream is open too.
    const controller = new AbortController();
    const stream = await fetch(`${base}/stream`, { signal: controller.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    controller.abort();
  });

  it('auth-on normal route: /runs rejects missing/wrong tokens with 401 and accepts a valid Bearer', async () => {
    const { base } = await start({ apiToken: TOKEN });

    // No credential → 401 with the "missing" message.
    const missing = await fetch(`${base}/runs`);
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { error: string }).error).toBe('authentication required');

    // A present-but-wrong credential → 401 with the distinct "invalid" message.
    const wrong = await fetch(`${base}/runs`, { headers: { Authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid token');

    // The correct Bearer token → the route runs normally (200).
    const ok = await fetch(`${base}/runs`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(Array.isArray(await ok.json())).toBe(true);
  });

  it('auth-on gates before the body is parsed: an unauthenticated POST /runs is a 401, not a 400', async () => {
    const { base } = await start({ apiToken: TOKEN });

    // Even with a malformed body, the auth gate fires first (would otherwise be a 400 JSON error).
    const res = await fetch(`${base}/runs`, { method: 'POST', body: '{not json' });
    expect(res.status).toBe(401);
  });

  it('auth-on /stream: rejects a tokenless SSE request with 401 and accepts ?token=<correct>', async () => {
    const { base } = await start({ apiToken: TOKEN });

    // EventSource can't set headers, so the gate must reject a tokenless stream request as a plain
    // 401 JSON (never a text/event-stream upgrade).
    const denied = await fetch(`${base}/stream`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('content-type')).not.toBe('text/event-stream');

    // The ?token= fallback authenticates the stream.
    const controller = new AbortController();
    const ok = await fetch(`${base}/stream?token=${encodeURIComponent(TOKEN)}`, { signal: controller.signal });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('text/event-stream');
    controller.abort();
  });

  it('auth-on leaves /health open (liveness probes) even with no token supplied', async () => {
    const { base } = await start({ apiToken: TOKEN });
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe('HTTP API — direct TLS termination (issue #26)', () => {
  // A throwaway self-signed cert/key for `localhost`, held as inline PEM strings so the transport smoke
  // test needs no `openssl` at test time and writes nothing under the repo (working-tree hygiene). The
  // client below trusts it via `rejectUnauthorized: false` — never used to bind anything real.
  const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUNERBzT9cHwMvLzsltp2xEK0/THcwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDcwODE2NTU1M1oYDzIxMjYw
NjE0MTY1NTUzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCJHVB3G47jcjgkkObm9AqC4dJPPTh8JxImc5y23zFY
pP2dgnsO7uwhfiCnR+HW1tqwOF+yiiFbajXlEebu9jkwxMQ/wF0Rmzjo7u5LbQfj
ELwx+ZVbgIJJU5wugYI6dwNkjSD8Qg64dDTy4bUgXCEN6X92u3ZFdSQ5axjdbBWF
NOw/h+Rjg/e34AE+I3CNkBaP2yQ29XjcybWaBruUwySYkZlAt5wgnYzGhRKOPlLf
5tKLBemFs6BfWTOoUa17S2hwJzYvcD+tyEyibdRZZz2mF48puRm/IKifprzzOPkJ
nLWwZXiu84Mwd4k/Byjcw3OFw5jnQQxvQBsY9naAVM+DAgMBAAGjUzBRMB0GA1Ud
DgQWBBRyxfGmoZkvCs6IUWnmmIjhAoZsyjAfBgNVHSMEGDAWgBRyxfGmoZkvCs6I
UWnmmIjhAoZsyjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAY
2PnPSCoEZ73PWagM18HWcf39TD4gWfV51nI37ufsePzlhDkD1aedou0+YGqwoV+v
ozODgZ4Sbz0dYiAajz6+7qBqTzTeJ2Zj9f8xrZ3YqW780eH1CtVU9S3t31aNtE+o
MjEEaKaD2MafFUZUEIHeKfTQVWOnM0LFEp9Awae6lThEvGvh2V2f6pFlp65wscGy
oqqoJGEnQB6YJmLxAZF540JdsdK1V4PWcGKIKT0GF2sq3DE+xb0hlImZsJNk30ag
5lle78LbC7B1sMOluDT98K9uLLEKCPmMxoMHRJjyGsoeoUSqWNxnpiyX31S+uFLy
2Vfo+OGn7DgiMO6ZwbVe
-----END CERTIFICATE-----
`;
  const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCJHVB3G47jcjgk
kObm9AqC4dJPPTh8JxImc5y23zFYpP2dgnsO7uwhfiCnR+HW1tqwOF+yiiFbajXl
Eebu9jkwxMQ/wF0Rmzjo7u5LbQfjELwx+ZVbgIJJU5wugYI6dwNkjSD8Qg64dDTy
4bUgXCEN6X92u3ZFdSQ5axjdbBWFNOw/h+Rjg/e34AE+I3CNkBaP2yQ29XjcybWa
BruUwySYkZlAt5wgnYzGhRKOPlLf5tKLBemFs6BfWTOoUa17S2hwJzYvcD+tyEyi
bdRZZz2mF48puRm/IKifprzzOPkJnLWwZXiu84Mwd4k/Byjcw3OFw5jnQQxvQBsY
9naAVM+DAgMBAAECggEAB9XOAFBp1ON1A9nn5/CwHRSMcQy9ipKs/deDcAvHBRrA
h1yqbYsHoU5UzVpVNHKoooNGLKyqBVBHbiScvrEBSaEk2cPDTbtCAEWPBm5fkgEl
z/FEMKtiRpBpj1rFN1QPtJI//UpFDxNM50gwkn3RQbtDFmTV+FgeTs2o6RZBEJCF
OSdaGWYhZKuDvC/EtyGG/rJLin2mztnRujiEPJSIN6slgjjw/a2TQlXxstT/UDEA
gcQgLXeMkY+JwlOfP70ZbR0hGuNHbOhXO4oJt0+H3D2xWdG6ZhaM8OyhOmfLmNS7
1uhjGLILPQVgn8dTifYe7lt8bhFB60rueY67i6E06QKBgQC+onFfuG5f1yy7wt+Z
bScHA7A1UUaRbSx8fKyg3PGezIDDBPFBkD2/XQqpO6qN9m9ChMR15oIblwJ6R3cw
+o6BEzFkrDvLijEa2bX2h0RAHzw+BDzUxmHFI/Z+MhB+3tRUsu1xu1JThWX0ah/Q
AfdGyXiO75CtnMNn7P64QML+rQKBgQC4IPqt57O4FoERr8w4ixmwT083B4HV+Gxx
x9HWAwchBiUgg2IO6vpdGzHQJeRaZcnRUm5vV9i4Lh3Cnap1tfb/IxdvfHrFvtjg
ckujfOCr7FSLFC99GyIS5Bmkd/H+8YttHSvgUukr53Rzdl5EmeGCfewavuesO+ey
HOozhoq87wKBgQCq9ZkBA7AQSTL3y6KkwEuwsbETj6jegG7V0SUrOhmBlNqgik0l
xApsFC+cZ0Lj/y32FITvSuJBheKV8INGrFyiCqlQJFmXhn3VG4tg5Bvj+V8YKsq2
8pX5qu/Canl6nbEDqFbimOASwN4XHBkdfLXaiJGSdetkluJy0An7CTEWHQKBgQCp
S2FRPkWGz+IyQeHSZ0riSbl6zkM5WeVTpDaxwCzw1zaRs1sYfkJeEt/1ErHnz8kE
1fbGFw4jIfuo8dBF1F3abghhMCGt6XB8xXn4QpxMVsnQ6mlTbPwiRGmzR7lQAASC
+Zxa78CF5pSyiLXZ+2ZV1bOdT8OxH49Du8Q2RdEQLwKBgQCwWSvMfBY1YW8PVlP8
m3M/ryBWz6Eb9oX9+TTnKm2kwpSYrT/sq3z5hGeVpDD9zRsSwgxc3jLSJiIOJvbO
HkAd++ivfplXhBSVTUoPkh+Gb50s4lHGzKMem5UuJrVNMXJKT9cm3fHOfiA+MgtR
uPuM5Z8MrdV2HddJ7V9u4t1TMQ==
-----END PRIVATE KEY-----
`;

  /** GET `url` over HTTPS, trusting the self-signed cert (`rejectUnauthorized: false`); resolves the
   *  status + parsed JSON body. A short socket timeout keeps a mis-negotiated handshake from hanging. */
  function getHttps(url: string): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(url, { rejectUnauthorized: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : undefined }));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('TLS request timed out — server is not serving HTTPS')));
      req.end();
    });
  }

  it('serves over HTTPS when a `tls` option (cert/key PEMs) is provided', async () => {
    const { base } = await start({ tls: { cert: TEST_TLS_CERT, key: TEST_TLS_KEY } });
    expect(base.startsWith('https://')).toBe(true);

    // The transport branch is exercised end-to-end: a real TLS handshake + an HTTPS request to /health.
    // TLS is transport confidentiality only — the same `handle()` routing serves it, so /health answers
    // 200 { ok: true } exactly as over plain HTTP.
    const health = await getHttps(`${base}/health`);
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true });
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

describe('HTTP API — run chat', () => {
  const chatHandler: StubHandler = (req) =>
    req.stage === 'chat' ? { output: { response: 'the PR adds a retry loop' }, tokens: 3 } : goldenPathHandler(req);

  it('sends a prompt, lists the thread, and reports the reply on the run detail', async () => {
    const { base, orchestrator } = await start({ handler: chatHandler });
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle(); // run to done, so a write prompt dispatches immediately too

    const created = await fetch(`${base}/runs/${run.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'what does the PR change?', mode: 'read' }),
    });
    expect(created.status).toBe(201);
    const exchange = (await created.json()) as { id: number; mode: string; status: string };
    expect(exchange.mode).toBe('read');
    await orchestrator.settle();

    const listed = await fetch(`${base}/runs/${run.id}/chat`);
    expect(listed.status).toBe(200);
    const thread = (await listed.json()) as Array<{ id: number; status: string; response: string | null }>;
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ id: exchange.id, status: 'done', response: 'the PR adds a retry loop' });

    const detail = await fetch(`${base}/runs/${run.id}`);
    expect(((await detail.json()) as { chat: unknown[] }).chat).toHaveLength(1);
  });

  it('cancels a queued prompt and maps chat errors to statuses (400/404/409)', async () => {
    const { base, orchestrator, repo } = await start({ handler: chatHandler });
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();
    // Park the run `blocked` (dependency-gated): NOT a write-safe status, so a write prompt holds.
    repo.setRunStatus(run.id, 'blocked');

    const queued = await fetch(`${base}/runs/${run.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'fix the build', mode: 'write' }),
    });
    const exchange = (await queued.json()) as { id: number; status: string };
    expect(exchange.status).toBe('queued');

    const cancelled = await fetch(`${base}/runs/${run.id}/chat/${exchange.id}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { status: string }).status).toBe('cancelled');
    // Cancelling again is a 409 (only a queued prompt can be withdrawn).
    expect((await fetch(`${base}/runs/${run.id}/chat/${exchange.id}/cancel`, { method: 'POST' })).status).toBe(409);

    // Validation + routing errors.
    const noPrompt = await fetch(`${base}/runs/${run.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'read' }),
    });
    expect(noPrompt.status).toBe(400);
    const badMode = await fetch(`${base}/runs/${run.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', mode: 'sudo' }),
    });
    expect(badMode.status).toBe(400);
    expect((await fetch(`${base}/runs/9999/chat`)).status).toBe(404);
    expect((await fetch(`${base}/runs/${run.id}/chat`, { method: 'PUT' })).status).toBe(405);
  });
});

describe('resolution advisor route + per-resume extraRounds validation (Layer 3)', () => {
  const advice = { summary: 'stuck', options: [{ label: 'Retry', rationale: 'transient', action: 'resume', suggestedNotes: 'retry' }] };

  /** Fail plan produce once (→ needs_human), answer the advise pseudo-stage with canned advice. */
  function stuckHandler(): StubHandler {
    let failed = false;
    return (req) => {
      if (req.stage === 'advise') return { output: advice, tokens: 4 };
      if (req.stage === 'plan' && req.phase === 'produce' && !failed) {
        failed = true;
        throw new Error('transient harness failure');
      }
      return goldenPathHandler(req);
    };
  }

  it('routes POST /runs/:id/advise to the advisor (200 + shape) for a needs_human run, 404 unknown', async () => {
    const { base, orchestrator, repo } = await start({ handler: stuckHandler() });
    const run = (await (await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1' }) })).json()) as { id: number };
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('needs_human');

    const res = await fetch(`${base}/runs/${run.id}/advise`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: number; summary: string; options: unknown[] };
    expect(body).toMatchObject({ runId: run.id, summary: 'stuck' });
    expect(body.options).toHaveLength(1);

    expect((await fetch(`${base}/runs/99999/advise`, { method: 'POST' })).status).toBe(404);
  });

  it('409s an advise request on a run that is not needs_human', async () => {
    const { base, orchestrator, repo } = await start();
    const run = (await (await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1' }) })).json()) as { id: number };
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('done');

    expect((await fetch(`${base}/runs/${run.id}/advise`, { method: 'POST' })).status).toBe(409);
  });

  it('validates extraRounds on POST /runs/:id/resume (integer 1..10) and records a valid one', async () => {
    const { base, orchestrator, repo } = await start({ handler: stuckHandler() });
    const run = (await (await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1' }) })).json()) as { id: number };
    await orchestrator.settle();
    expect(repo.getRun(run.id)!.status).toBe('needs_human');

    for (const bad of [0, -1, 1.5, 11, 'two']) {
      const r = await fetch(`${base}/runs/${run.id}/resume`, { method: 'POST', body: JSON.stringify({ extraRounds: bad }) });
      expect(r.status).toBe(400);
    }

    const ok = await fetch(`${base}/runs/${run.id}/resume`, { method: 'POST', body: JSON.stringify({ notes: 'more room', extraRounds: 3 }) });
    expect(ok.status).toBe(200);
    await orchestrator.settle();
    const resumeT = repo.listTransitions(run.id).find((t) => t.trigger === 'resume')!;
    expect(resumeT.reason).toEqual({ kind: 'operator_resume', notes: 'more room', extraRounds: 3 });
  });
});

describe('HTTP API — remote-access hardening (issue #27)', () => {
  /** Assert the baseline security headers ride on any response (JSON, static, SSE, error). */
  const assertBaseline = (res: Response): void => {
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    // No HSTS from the app — TLS termination is the tunnel/proxy's job (documented in the threat model).
    expect(res.headers.get('strict-transport-security')).toBeNull();
  };

  it('throttles mutating routes past the limit with 429 + Retry-After, never throttling GET / health', async () => {
    // A tiny bucket + a frozen clock (no refill) makes the throttle deterministic. The mutating route
    // 404s on an unknown run — the point is the first `capacity` calls are admitted and the next is not.
    const NOW = 5_000_000;
    const { base } = await start({ rateLimit: { capacity: 2, refillPerSec: 1 }, now: () => NOW });
    const hit = (): Promise<Response> => fetch(`${base}/runs/999999/pause`, { method: 'POST' });

    expect((await hit()).status).toBe(404); // token 1 consumed — admitted
    expect((await hit()).status).toBe(404); // token 2 consumed — admitted
    const limited = await hit(); // bucket empty at the same instant → throttled
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe('rate limit exceeded');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Cheap GETs and the liveness probe are never throttled, even after the mutating bucket is drained.
    for (let i = 0; i < 5; i++) {
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/runs`)).status).toBe(200);
    }
  });

  it('rejects an oversized request body with 413 (and still accepts a normal small body)', async () => {
    const { base } = await start({ maxBodyBytes: 512 });

    // A body past the cap is refused inside `readJson` (during the read, before the body is validated)
    // — a generic, non-leaking 413. Uses the route's real (PUT) method so the body-reading handler runs;
    // the missing-`harness` field never matters because the cap trips first.
    const big = await fetch(`${base}/settings/default-harness`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(5000) }),
    });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toBe('request body too large');

    // A normal, small, valid body is unaffected by the cap.
    const ok = await fetch(`${base}/settings/default-harness`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness: 'cursor' }),
    });
    expect(ok.status).toBe(200);
  });

  it('sanitizes a non-ApiError internal failure to a generic 500 (no path / raw-message leak)', async () => {
    // Force an unexpected throw deep in a route: the suggestion source raises a raw Error whose message
    // embeds an internal filesystem path — exactly the kind of detail that must NOT reach a remote caller.
    const INTERNAL = "ENOENT: no such file or directory, open '/Users/secret-operator/app/.env'";
    const { base } = await start({ suggestionSource: { suggest() { throw new Error(INTERNAL); } } });

    const res = await fetch(`${base}/suggestions?q=x`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: 'internal server error' });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('/Users/secret-operator');
    expect(raw).not.toContain('ENOENT');

    // A deliberate ApiError still surfaces its client-facing message verbatim (the API contract).
    const bad = await fetch(`${base}/runs`, { method: 'POST', body: '{}' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/issueRef/);
  });

  it('carries the baseline security headers on every response — JSON, static asset, 404, and SSE', async () => {
    const { base } = await start({ publicDir: fixturePublicDir() });

    assertBaseline(await fetch(`${base}/health`)); // JSON
    assertBaseline(await fetch(`${base}/app.js`)); // static asset
    assertBaseline(await fetch(`${base}/missing-asset.js`)); // 404

    const controller = new AbortController();
    const sse = await fetch(`${base}/stream`, { signal: controller.signal });
    expect(sse.headers.get('content-type')).toBe('text/event-stream'); // unchanged SSE content-type
    assertBaseline(sse);
    controller.abort();
  });

  it('adds the CSP to HTML documents only (not JSON or SSE)', async () => {
    const { base } = await start({ publicDir: fixturePublicDir() });

    // The SPA shell (index.html) carries a locked-down CSP.
    const html = await fetch(`${base}/`);
    expect(html.headers.get('content-type')).toContain('text/html');
    const csp = html.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");

    // JSON responses do NOT get a CSP (it only makes sense for an HTML document).
    expect((await fetch(`${base}/health`)).headers.get('content-security-policy')).toBeNull();

    // Neither does the SSE stream.
    const controller = new AbortController();
    const sse = await fetch(`${base}/stream`, { signal: controller.signal });
    expect(sse.headers.get('content-security-policy')).toBeNull();
    controller.abort();
  });

  it('denies cross-origin by default: an OPTIONS preflight gets a locked-down 204 with no wildcard ACAO', async () => {
    const { base } = await start(); // no allow-list ⇒ deny all cross-origin

    const pre = await fetch(`${base}/runs`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(pre.status).toBe(204); // preflight is answered, not fallen through to the SPA/404
    expect(pre.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(pre.headers.get('access-control-allow-origin')).toBeNull(); // disallowed → no ACAO at all

    // A simple cross-origin GET from a disallowed origin still runs, but hands back no ACAO, so the
    // browser blocks the response read (the default same-origin-only posture).
    const simple = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(simple.status).toBe(200);
    expect(simple.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('echoes an explicitly allow-listed origin on the preflight (never a wildcard)', async () => {
    const { base } = await start({ allowedOrigins: ['https://ops.example'] });

    const pre = await fetch(`${base}/runs`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://ops.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://ops.example');
    expect(pre.headers.get('vary')).toContain('Origin');

    // An origin NOT on the list is still denied even when a list is configured.
    const denied = await fetch(`${base}/runs`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://other.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never leaks configured secrets in GET /config or an SSE frame (pins the non-gap)', async () => {
    const SECRET_GH = 'ghp_SENTINEL_do_not_leak_1234567890';
    const SECRET_ANTHROPIC = 'sk-ant-SENTINEL-do-not-leak';
    const prevGh = process.env.GITHUB_TOKEN;
    const prevAnth = process.env.ANTHROPIC_API_KEY;
    process.env.GITHUB_TOKEN = SECRET_GH;
    process.env.ANTHROPIC_API_KEY = SECRET_ANTHROPIC;
    try {
      const { base, orchestrator } = await start();
      const controller = new AbortController();
      const sse = await fetch(`${base}/stream`, { signal: controller.signal });
      const reader = sse.body!.getReader();

      const cfgText = await (await fetch(`${base}/config`)).text();
      expect(cfgText).not.toContain(SECRET_GH);
      expect(cfgText).not.toContain(SECRET_ANTHROPIC);

      // Drive a transition so at least one SSE frame is emitted, then confirm no secret rode along.
      await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1' }) });
      await orchestrator.settle();
      const frames = await readUntil(reader, (acc) => acc.includes('event: transition'));
      expect(frames).not.toContain(SECRET_GH);
      expect(frames).not.toContain(SECRET_ANTHROPIC);

      await reader.cancel();
      controller.abort();
    } finally {
      if (prevGh === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevGh;
      if (prevAnth === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnth;
    }
  });

  it('never puts the API token in an error body (auth-on) — pins the non-gap', async () => {
    const TOKEN = 'super-secret-fleet-token-xyz';
    const { base } = await start({ apiToken: TOKEN });

    const denied = await fetch(`${base}/runs`, { headers: { Authorization: 'Bearer wrong' } });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain(TOKEN);
  });
});

describe('HTTP API — operator context routes (agents-fsm#5)', () => {
  const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
  const put = (base: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('persists + clears the global base context and surfaces it via GET /settings (Layer 1)', async () => {
    const { base } = await start();

    const saved = await put(base, '/settings/context/global', { context: 'always KISS' }).then(json);
    expect(saved).toEqual({ contextGlobal: 'always KISS' });
    expect(await fetch(`${base}/settings`).then(json)).toMatchObject({ contextGlobal: 'always KISS' });

    // null clears.
    expect(await put(base, '/settings/context/global', { context: null }).then(json)).toEqual({ contextGlobal: null });
    expect(await fetch(`${base}/settings`).then(json)).toMatchObject({ contextGlobal: null });

    // A non-string, non-null body → 400.
    expect((await put(base, '/settings/context/global', { context: 42 })).status).toBe(400);
  });

  it('persists per-stage context for a known stage and 400s an unknown one (Layer 2)', async () => {
    const { base } = await start();

    const res = await put(base, '/settings/context/stage', { stage: 'code_review', context: 'look for ways to simplify' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'code_review',
      contextStages: { code_review: 'look for ways to simplify' },
    });
    expect(await fetch(`${base}/settings`).then(json)).toMatchObject({
      contextStages: { code_review: 'look for ways to simplify' },
    });

    // Unknown stage → 400 (typo guard); a non-string/non-null context → 400.
    expect((await put(base, '/settings/context/stage', { stage: 'frontned', context: 'x' })).status).toBe(400);
    expect((await put(base, '/settings/context/stage', { stage: 'frontend', context: 7 })).status).toBe(400);
  });

  it('sets + clears a run’s per-issue context via POST /runs/:id/context (Layer 3)', async () => {
    const { base } = await start();
    const run = (await (await fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ issueRef: 'o/r#1' }) })).json()) as { id: number };

    const set = await fetch(`${base}/runs/${run.id}/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'add a DB index for this issue' }),
    }).then(json);
    expect(set).toMatchObject({ id: run.id, issueContext: 'add a DB index for this issue' });

    const cleared = await fetch(`${base}/runs/${run.id}/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: null }),
    }).then(json);
    expect(cleared).toMatchObject({ id: run.id, issueContext: null });

    // A non-string/non-null context → 400; a missing run → 404.
    const badBody = await fetch(`${base}/runs/${run.id}/context`, { method: 'POST', body: JSON.stringify({ context: 9 }) });
    expect(badBody.status).toBe(400);
    const missing = await fetch(`${base}/runs/99999/context`, { method: 'POST', body: JSON.stringify({ context: 'x' }) });
    expect(missing.status).toBe(404);
  });
});
