/**
 * Dashboard store — operator context actions (jzohdi/agents-fsm#5).
 *
 * The three layers are edited from the dashboard through optimistic-update-then-rollback actions,
 * mirroring `setDefaultHarness` / `setModel`:
 *   - `loadSettings` hydrates `ui.contextGlobal` + `ui.contextStages` from `GET /settings`;
 *   - `setGlobalContext(text)` → `PUT /settings/context/global`;
 *   - `setStageContext(stage, text)` → `PUT /settings/context/stage`;
 *   - `setRunContext(id, text)` → `POST /runs/:id/context`, updating that run's `issueContext`.
 * On a rejected request each action rolls its optimistic change back and raises a banner.
 *
 * The API layer is mocked (not `fetch`) so each case drives `request`'s result directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Run, Settings } from './types';

vi.mock('./api', () => ({ request: vi.fn(), AuthError: class extends Error {} }));

import { request } from './api';
import { loadSettings, setGlobalContext, setRunContext, setStageContext, ui } from './store.svelte.ts';

const settings = (over: Partial<Settings> = {}): Settings => ({
  defaultHarness: 'claude-code',
  harnesses: ['claude-code', 'cursor'],
  defaultModel: null,
  defaultEffort: null,
  contextGlobal: null,
  contextStages: {},
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  id: 1,
  issueRef: 'o/r#1',
  repoRef: 'o/r',
  currentState: 'backend',
  status: 'running',
  fsmConfigVersion: 'v1',
  prNumber: null,
  branch: null,
  tokensUsed: 0,
  costUsed: 0,
  agentRunsCount: 0,
  flags: {},
  archivedAt: null,
  modelOverride: null,
  effortOverride: null,
  harness: 'claude-code',
  issueContext: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

beforeEach(() => {
  vi.mocked(request).mockReset();
  ui.runs = [];
  ui.banner = null;
  ui.contextGlobal = null;
  ui.contextStages = {};
});

describe('loadSettings — operator context hydration', () => {
  it('hydrates ui.contextGlobal + ui.contextStages from GET /settings', async () => {
    vi.mocked(request).mockResolvedValueOnce(settings({ contextGlobal: 'always KISS', contextStages: { frontend: 'small sections' } }));
    await loadSettings();
    expect(ui.contextGlobal).toBe('always KISS');
    expect(ui.contextStages).toEqual({ frontend: 'small sections' });
  });
});

describe('setGlobalContext (Layer 1)', () => {
  it('optimistically sets, then reflects the server value', async () => {
    vi.mocked(request).mockResolvedValueOnce({ contextGlobal: 'be terse' });
    await setGlobalContext('be terse');
    expect(request).toHaveBeenCalledWith('PUT', '/settings/context/global', { context: 'be terse' });
    expect(ui.contextGlobal).toBe('be terse');
  });

  it('rolls back and banners on a rejected request', async () => {
    ui.contextGlobal = 'previous';
    vi.mocked(request).mockRejectedValueOnce(new Error('boom'));
    await setGlobalContext('new value');
    expect(ui.contextGlobal).toBe('previous'); // rolled back
    expect(ui.banner?.kind).toBe('err');
  });
});

describe('setStageContext (Layer 2)', () => {
  it('optimistically sets a stage entry and posts the right body', async () => {
    vi.mocked(request).mockResolvedValueOnce({ stage: 'code_review', contextStages: { code_review: 'simplify' } });
    await setStageContext('code_review', 'simplify');
    expect(request).toHaveBeenCalledWith('PUT', '/settings/context/stage', { stage: 'code_review', context: 'simplify' });
    expect(ui.contextStages.code_review).toBe('simplify');
  });

  it('rolls back a stage entry and banners on failure', async () => {
    ui.contextStages = { code_review: 'original' };
    vi.mocked(request).mockRejectedValueOnce(new Error('nope'));
    await setStageContext('code_review', 'changed');
    expect(ui.contextStages.code_review).toBe('original'); // rolled back
    expect(ui.banner?.kind).toBe('err');
  });
});

describe('setRunContext (Layer 3)', () => {
  it('updates the run’s issueContext from the returned run', async () => {
    ui.runs = [run({ id: 7, issueContext: null })];
    vi.mocked(request).mockResolvedValueOnce(run({ id: 7, issueContext: 'add an index' }));
    await setRunContext(7, 'add an index');
    expect(request).toHaveBeenCalledWith('POST', '/runs/7/context', { context: 'add an index' });
    expect(ui.runs.find((r) => r.id === 7)!.issueContext).toBe('add an index');
  });

  it('banners on a rejected request', async () => {
    ui.runs = [run({ id: 7, issueContext: 'keep' })];
    vi.mocked(request).mockRejectedValueOnce(new Error('down'));
    await setRunContext(7, 'change');
    expect(ui.banner?.kind).toBe('err');
  });
});
