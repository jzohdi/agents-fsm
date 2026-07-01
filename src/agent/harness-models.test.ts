/** Tests for the harness model catalogs (the source of the dashboard's model dropdown). */

import { describe, expect, it } from 'vitest';

import { HARNESS_IDS } from './harness';
import { CURSOR_MODEL_MAP } from './cursor-profile';
import {
  CLAUDE_CODE_CATALOG,
  CURSOR_CATALOG,
  catalogForHarness,
  catalogHasModel,
  type HarnessCatalog,
} from './harness-models';

describe('CLAUDE_CODE_CATALOG', () => {
  it('exposes the claude-code harness with unique, non-empty model ids', () => {
    expect(CLAUDE_CODE_CATALOG.harness).toBe('claude-code');
    expect(CLAUDE_CODE_CATALOG.models.length).toBeGreaterThan(0);
    const ids = CLAUDE_CODE_CATALOG.models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    for (const m of CLAUDE_CODE_CATALOG.models) {
      expect(m.id).toBeTruthy();
      expect(m.label).toBeTruthy();
    }
    // The everyday aliases must be selectable.
    expect(ids).toEqual(expect.arrayContaining(['opus', 'sonnet', 'haiku']));
  });
});

describe('CURSOR_CATALOG', () => {
  it('exposes the cursor harness with unique, non-empty model ids', () => {
    expect(CURSOR_CATALOG.harness).toBe('cursor');
    expect(CURSOR_CATALOG.models.length).toBeGreaterThan(0);
    const ids = CURSOR_CATALOG.models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of CURSOR_CATALOG.models) {
      expect(m.id).toBeTruthy();
      expect(m.label).toBeTruthy();
    }
  });

  it('lists every concrete model the recipe-facing model map resolves to', () => {
    // Drift guard: a logical name the profile maps must be a selectable model, else the dropdown could
    // never reproduce the harness's own default choice.
    const ids = CURSOR_CATALOG.models.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(Object.values(CURSOR_MODEL_MAP)));
  });
});

describe('catalogForHarness', () => {
  it('resolves each known harness to its catalog and returns undefined otherwise', () => {
    expect(catalogForHarness('claude-code')).toBe(CLAUDE_CODE_CATALOG);
    expect(catalogForHarness('cursor')).toBe(CURSOR_CATALOG);
    expect(catalogForHarness('gemini')).toBeUndefined();
    expect(catalogForHarness('')).toBeUndefined();
  });

  it('has a catalog for every known harness id, each self-labelled with that id (drift guard)', () => {
    // If a later PR adds a harness to HARNESS_IDS but forgets its catalog, `getModels`/`setModel` would
    // silently offer no models for it — catch that here rather than in a live run.
    for (const id of HARNESS_IDS) {
      const catalog = catalogForHarness(id);
      expect(catalog, `no catalog registered for harness "${id}"`).toBeDefined();
      expect(catalog!.harness).toBe(id);
    }
  });
});

describe('catalogHasModel', () => {
  const catalog: HarnessCatalog = { harness: 'x', models: [{ id: 'opus', label: 'Opus' }] };

  it('accepts a listed model and rejects anything else', () => {
    expect(catalogHasModel(catalog, 'opus')).toBe(true);
    expect(catalogHasModel(catalog, 'gpt-4')).toBe(false);
    expect(catalogHasModel(catalog, '')).toBe(false);
  });
});
