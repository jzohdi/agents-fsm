/** Tests for the ModelPicker's pure list logic (filter / rows / keyboard nav) — no DOM needed. */

import { describe, expect, it } from 'vitest';

import { buildRows, filterModels, nextSelectable, selectedIndex, type PickerRow } from './model-picker';
import type { HarnessModel } from './types';

const MODELS: HarnessModel[] = [
  { id: 'sonnet-4.5', label: 'Claude Sonnet 4.5', group: 'Anthropic', provider: 'anthropic', cost: 3, recommended: true },
  { id: 'opus-4.1', label: 'Claude Opus 4.1', group: 'Anthropic', provider: 'anthropic', cost: 4 },
  { id: 'gpt-5', label: 'GPT-5', group: 'OpenAI', provider: 'openai', cost: 3, recommended: true },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini', group: 'OpenAI', provider: 'openai', cost: 1 },
  { id: 'kimi-k2', label: 'Kimi K2', group: 'Moonshot', provider: 'moonshot', cost: 1 },
];

const modelIds = (rows: PickerRow[]): string[] => rows.flatMap((r) => (r.kind === 'model' ? [r.model.id] : []));

describe('filterModels', () => {
  it('returns everything for a blank query and preserves catalog order', () => {
    expect(filterModels(MODELS, '')).toEqual(MODELS);
    expect(filterModels(MODELS, '   ')).toEqual(MODELS);
  });

  it('matches label, id, provider, and group, case-insensitively', () => {
    expect(filterModels(MODELS, 'gpt').map((m) => m.id)).toEqual(['gpt-5', 'gpt-5-mini']); // id/label
    expect(filterModels(MODELS, 'anthropic').map((m) => m.id)).toEqual(['sonnet-4.5', 'opus-4.1']); // provider
    expect(filterModels(MODELS, 'MOONSHOT').map((m) => m.id)).toEqual(['kimi-k2']); // group, case-insensitive
    expect(filterModels(MODELS, 'nope')).toEqual([]);
  });
});

describe('buildRows', () => {
  it('leads with the default row, a recommended shortlist, then provider groups (blank query)', () => {
    const rows = buildRows(MODELS, '');
    expect(rows[0]).toEqual({ kind: 'default' });
    // The recommended shortlist comes first, then each provider group under its header.
    const headers = rows.flatMap((r) => (r.kind === 'header' ? [r.label] : []));
    expect(headers).toEqual(['Recommended', 'Anthropic', 'OpenAI', 'Moonshot']);
    // Recommended models are duplicated into their group (a top shortcut, not a move).
    expect(modelIds(rows).filter((id) => id === 'gpt-5')).toHaveLength(2);
  });

  it('drops the recommended shortlist while searching and only lists matches', () => {
    const rows = buildRows(MODELS, 'gpt');
    expect(rows.some((r) => r.kind === 'header' && r.label === 'Recommended')).toBe(false);
    expect(modelIds(rows)).toEqual(['gpt-5', 'gpt-5-mini']); // no duplication when filtered
    expect(rows.find((r) => r.kind === 'header')).toEqual({ kind: 'header', label: 'OpenAI' });
  });

  it('keeps just the default row when nothing matches', () => {
    expect(buildRows(MODELS, 'zzz')).toEqual([{ kind: 'default' }]);
  });
});

describe('nextSelectable', () => {
  const rows = buildRows(MODELS, ''); // [default, "Recommended", 2 models, "Anthropic", 2, "OpenAI", 2, "Moonshot", 1]

  it('skips header rows when moving down and up', () => {
    // From the default row (0), down lands on the first recommended model (index 2), skipping the header at 1.
    expect(nextSelectable(rows, 0, 1)).toBe(2);
    expect(rows[nextSelectable(rows, 0, 1)]!.kind).toBe('model');
    // Moving up from that model returns to the default row, again stepping over the header.
    expect(nextSelectable(rows, 2, -1)).toBe(0);
  });

  it('clamps at both ends (never lands out of range or on a header)', () => {
    expect(nextSelectable(rows, 0, -1)).toBe(0); // already at the top
    const last = rows.length - 1;
    expect(nextSelectable(rows, last, 1)).toBe(last); // already at the bottom
    expect(rows[last]!.kind).toBe('model'); // a group's last row is always selectable
  });
});

describe('selectedIndex', () => {
  const rows = buildRows(MODELS, '');

  it('points at the default row for null or an unlisted value', () => {
    expect(selectedIndex(rows, null)).toBe(0);
    expect(selectedIndex(rows, 'not-a-model')).toBe(0);
  });

  it('points at the matching model row', () => {
    const idx = selectedIndex(rows, 'gpt-5');
    expect(rows[idx]).toMatchObject({ kind: 'model', model: { id: 'gpt-5' } });
  });
});
