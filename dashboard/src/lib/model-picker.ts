/**
 * Pure list-building for {@link ./ModelPicker.svelte} — filtering, grouping, and the flat row list the
 * popover renders and navigates. It lives outside the component so it is unit-testable without a DOM, and
 * so the component stays a thin view over a single, well-defined data shape (no index arithmetic in the
 * template).
 */

import type { HarnessModel } from './types';

/** A rendered row in the picker popover: the default row, a group header, or a selectable model. */
export type PickerRow =
  | { kind: 'default' }
  | { kind: 'header'; label: string }
  | { kind: 'model'; model: HarnessModel };

/** Models matching `query` (label/id/provider/group, case-insensitive), in catalog order; all when blank. */
export function filterModels(models: HarnessModel[], query: string): HarnessModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((m) =>
    [m.label, m.id, m.provider ?? '', m.group ?? ''].some((s) => s.toLowerCase().includes(q)),
  );
}

/**
 * The flat rows the popover renders top-to-bottom: the "default" row, then a "Recommended" shortlist (only
 * when not searching — it's a jumping-off point, not a filter), then the filtered models grouped under
 * their `group` header (ungrouped last). A row's array position IS its keyboard-nav index, so neither the
 * component nor the caller needs any index arithmetic. Recommended models intentionally also appear in
 * their provider group (a shortcut at the top, not a move).
 */
export function buildRows(models: HarnessModel[], query: string): PickerRow[] {
  const rows: PickerRow[] = [{ kind: 'default' }];
  if (!query.trim()) {
    const recommended = models.filter((m) => m.recommended);
    if (recommended.length) {
      rows.push({ kind: 'header', label: 'Recommended' });
      for (const m of recommended) rows.push({ kind: 'model', model: m });
    }
  }
  const groups = new Map<string, HarnessModel[]>();
  for (const m of filterModels(models, query)) {
    const key = m.group ?? '';
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
  }
  for (const [group, items] of groups) {
    if (group) rows.push({ kind: 'header', label: group });
    for (const m of items) rows.push({ kind: 'model', model: m });
  }
  return rows;
}

/** The next *selectable* row index moving `dir` from `from`, skipping headers and staying in range;
 *  returns `from` unchanged when there's nowhere further to go (so Up/Down clamp at the ends). */
export function nextSelectable(rows: PickerRow[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
    if (rows[i]!.kind !== 'header') return i;
  }
  return from;
}

/** The row index to highlight for `value`: the matching model's row, or the default row (0) when `value`
 *  is `null` or isn't in the list. */
export function selectedIndex(rows: PickerRow[], value: string | null): number {
  if (value === null) return 0;
  const i = rows.findIndex((r) => r.kind === 'model' && r.model.id === value);
  return i >= 0 ? i : 0;
}
