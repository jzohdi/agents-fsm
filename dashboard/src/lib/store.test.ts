/**
 * Tests for the dashboard store's per-harness catalog cache (`loadCatalog`) — the guard that lets an
 * off-default run's inspector offer *its own* harness's models. `loadCatalog(h)` fetches
 * `GET /models?harness=<h>` and caches the result into `ui.catalogs[h]` **only** when the response's
 * `harness` field matches the request. That mismatch-refusal is the acceptance-criteria guard: an
 * older daemon that ignores the query param returns the *default* catalog, which must NOT be cached
 * under the requested harness (else the picker would show wrong-harness models).
 *
 * The API layer is mocked (not `fetch`) so each case drives `request`'s result directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelCatalog } from './types';

vi.mock('./api', () => ({ request: vi.fn(), AuthError: class extends Error {} }));

import { request } from './api';
import { loadCatalog, ui } from './store.svelte.ts';

const catalog = (harness: string | null): ModelCatalog => ({ harness, models: [], defaultModel: null });

beforeEach(() => {
  // `ui.catalogs` is module-global `$state`; clear it in place (keep the same reference — never reassign
  // a rune field) so cases don't leak the "already cached → short-circuit" path into one another.
  for (const key of Object.keys(ui.catalogs)) delete ui.catalogs[key];
  vi.mocked(request).mockReset();
});

describe('loadCatalog', () => {
  it('C1: caches the catalog when the response harness matches the request', async () => {
    vi.mocked(request).mockResolvedValueOnce(catalog('cursor'));
    await loadCatalog('cursor');
    expect(request).toHaveBeenCalledWith('GET', '/models?harness=cursor');
    expect(ui.catalogs.cursor).toEqual(catalog('cursor'));
  });

  it('C2: refuses to cache when the response harness is a different id (daemon default)', async () => {
    vi.mocked(request).mockResolvedValueOnce(catalog('claude'));
    await loadCatalog('cursor');
    expect(ui.catalogs.cursor).toBeUndefined();
  });

  it('C3: refuses to cache when the response harness is null (older-daemon default fallback)', async () => {
    vi.mocked(request).mockResolvedValueOnce(catalog(null));
    await loadCatalog('cursor');
    expect(ui.catalogs.cursor).toBeUndefined();
  });

  it('C4: short-circuits (no refetch) when the harness is already cached', async () => {
    ui.catalogs.cursor = catalog('cursor');
    await loadCatalog('cursor');
    expect(request).not.toHaveBeenCalled();
    expect(ui.catalogs.cursor).toEqual(catalog('cursor'));
  });

  it('C5: swallows a request rejection and leaves the harness uncached', async () => {
    vi.mocked(request).mockRejectedValueOnce(new Error('network down'));
    await expect(loadCatalog('cursor')).resolves.toBeUndefined();
    expect(ui.catalogs.cursor).toBeUndefined();
  });

  it('URL-encodes the harness id in the request path', async () => {
    vi.mocked(request).mockResolvedValueOnce(catalog('a/b harness'));
    await loadCatalog('a/b harness');
    expect(request).toHaveBeenCalledWith('GET', '/models?harness=a%2Fb%20harness');
  });
});
