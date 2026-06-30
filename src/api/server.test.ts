/**
 * HTTP + SSE server tests (Milestone 5): drive the real server over an ephemeral port with `fetch`,
 * so the routing, JSON in/out, status codes, and the SSE stream are all exercised end to end —
 * still on the stub executor + fake GitHub (no network, no cost).
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { loadDefaultConfig } from '../fsm/config';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { AgentRunner } from '../agent/runner';
import { StubExecutor, goldenPathHandler } from '../agent/executor';
import { FakeGitHub } from '../integration/github-fake';
import { Orchestrator } from './orchestrator';
import { Broadcaster } from './stream';
import { createApiServer } from './server';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function start(): Promise<{ base: string; orchestrator: Orchestrator }> {
  const loaded = loadDefaultConfig();
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ autoSeedIssues: true });
  const broadcaster = new Broadcaster();
  const runner = new AgentRunner(repo, new StubExecutor(goldenPathHandler), loaded.agents, github, {
    onActivity: (activity) => broadcaster.publish({ type: 'activity', activity }),
  });
  const orchestrator = new Orchestrator({ repo, runner, config: loaded, broadcaster });
  const server = createApiServer(orchestrator);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, orchestrator };
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
    // Unknown route → 404.
    expect((await fetch(`${base}/nope`)).status).toBe(404);

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
