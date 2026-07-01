/** Tests for the harness model catalogs (the source of the dashboard's model dropdown). */

import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE_CATALOG, catalogHasModel, type HarnessCatalog } from './harness-models';

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

describe('catalogHasModel', () => {
  const catalog: HarnessCatalog = { harness: 'x', models: [{ id: 'opus', label: 'Opus' }] };

  it('accepts a listed model and rejects anything else', () => {
    expect(catalogHasModel(catalog, 'opus')).toBe(true);
    expect(catalogHasModel(catalog, 'gpt-4')).toBe(false);
    expect(catalogHasModel(catalog, '')).toBe(false);
  });
});
