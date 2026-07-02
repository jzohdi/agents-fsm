/** Tests for the harness model catalogs (the source of the dashboard's model dropdown). */

import { describe, expect, it } from 'vitest';

import { HARNESS_IDS } from './harness';
import { CURSOR_MODEL_MAP } from './cursor-profile';
import {
  CLAUDE_CODE_CATALOG,
  CURSOR_CATALOG,
  EFFORT_LEVELS,
  catalogForHarness,
  catalogHasModel,
  catalogSupportsEffort,
  isEffortLevel,
  modelEfforts,
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

  it('advertises reasoning-effort levels on the frontier models but not on Haiku', () => {
    // Claude Code's --effort support (docs): opus/sonnet aliases + pinned frontier models take all levels.
    expect(modelEfforts(CLAUDE_CODE_CATALOG, 'opus')).toEqual([...EFFORT_LEVELS]);
    expect(modelEfforts(CLAUDE_CODE_CATALOG, 'claude-opus-4-8')).toEqual([...EFFORT_LEVELS]);
    // Haiku isn't in Claude Code's effort list.
    expect(modelEfforts(CLAUDE_CODE_CATALOG, 'haiku')).toEqual([]);
    expect(catalogSupportsEffort(CLAUDE_CODE_CATALOG)).toBe(true);
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

  it('is a long, provider-grouped catalog with picker metadata (provider, cost, a recommended shortlist)', () => {
    // The picker leans on this metadata: several providers to group under, a cost tier per model, and at
    // least one "recommended" model surfaced at the top. Guard the shape so a bad edit is caught here.
    expect(CURSOR_CATALOG.models.length).toBeGreaterThanOrEqual(12);
    for (const m of CURSOR_CATALOG.models) {
      expect(m.provider, `model ${m.id} needs a provider for its brand mark`).toBeTruthy();
      expect(m.cost, `model ${m.id} needs a cost tier 1–4`).toBeGreaterThanOrEqual(1);
      expect(m.cost!).toBeLessThanOrEqual(4);
    }
    expect(new Set(CURSOR_CATALOG.models.map((m) => m.provider)).size).toBeGreaterThanOrEqual(3);
    expect(CURSOR_CATALOG.models.some((m) => m.recommended)).toBe(true);
  });

  it('offers no reasoning effort — cursor-agent has no working effort parameter today', () => {
    expect(catalogSupportsEffort(CURSOR_CATALOG)).toBe(false);
    expect(CURSOR_CATALOG.models.every((m) => !m.efforts || m.efforts.length === 0)).toBe(true);
  });
});

describe('effort helpers', () => {
  it('recognizes the known effort levels and rejects anything else', () => {
    for (const level of EFFORT_LEVELS) expect(isEffortLevel(level)).toBe(true);
    expect(isEffortLevel('ultra')).toBe(false);
    expect(isEffortLevel('')).toBe(false);
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('reports a model\'s effort levels, empty for an unknown or effort-less model', () => {
    const catalog: HarnessCatalog = {
      harness: 'x',
      models: [{ id: 'a', label: 'A', efforts: ['low', 'high'] }, { id: 'b', label: 'B' }],
    };
    expect(modelEfforts(catalog, 'a')).toEqual(['low', 'high']);
    expect(modelEfforts(catalog, 'b')).toEqual([]);
    expect(modelEfforts(catalog, 'missing')).toEqual([]);
    expect(catalogSupportsEffort(catalog)).toBe(true);
    expect(catalogSupportsEffort({ harness: 'y', models: [{ id: 'b', label: 'B' }] })).toBe(false);
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
