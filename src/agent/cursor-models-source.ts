/**
 * Pure helpers behind `npm run models:refresh` (the {@link ../../scripts/refresh-cursor-models} script) —
 * turning `cursor-agent --list-models` output into catalog entries and merging them with the curated
 * {@link ./cursor-models.json}. Kept pure (no spawn, no fs) so the fragile bit — running the CLI — is a
 * thin script wrapper around this tested core.
 *
 * The CLI's list is the **authoritative** set of `--model` values (each is passed verbatim; the ids
 * encode reasoning effort as a suffix, e.g. `gpt-5.5-high`). We read the ids as-is — no base/effort
 * splitting (Cursor's naming is non-uniform) — and infer only provider + a rough label/cost. Curated
 * entries in the JSON always win on merge, so hand-checked labels/costs/`recommended` survive a refresh;
 * the script only discovers new ids and drops ones Cursor removed.
 */

import type { HarnessModel } from './harness-models';

/** Provider slug → display group, and the order providers appear in the picker. */
const PROVIDER_GROUPS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  cursor: 'Cursor',
  zai: 'Z.ai',
  moonshot: 'Moonshot',
  deepseek: 'DeepSeek',
  other: 'Other',
};

/** Id-prefix → provider. First match wins; unknown → `other` (still pickable, just ungrouped-ish). */
const PROVIDER_BY_PREFIX: Array<[RegExp, string]> = [
  [/^(claude|anthropic)/, 'anthropic'],
  [/^composer/, 'cursor'],
  [/^(gpt|o[0-9]|openai)/, 'openai'],
  [/^(gemini|google)/, 'google'],
  [/^(grok|xai)/, 'xai'],
  [/^(glm|z-?ai)/, 'zai'],
  [/^(kimi|moonshot)/, 'moonshot'],
  [/^deepseek/, 'deepseek'],
];

/** Tokens rendered all-caps in a humanized label (brand acronyms). */
const ACRONYMS = new Set(['gpt', 'glm', 'ai']);

/** The provider a model id belongs to, inferred from its prefix. */
export function providerForId(id: string): string {
  return PROVIDER_BY_PREFIX.find(([re]) => re.test(id))?.[1] ?? 'other';
}

/** A rough, deterministic display label for an id — used only for *newly discovered* models (curated
 *  entries keep their hand-written labels), so an approximate title-case is fine pending a human edit. */
export function humanizeId(id: string): string {
  return id
    .split('-')
    .map((t) => (ACRONYMS.has(t) ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1)))
    .join(' ');
}

/** A catalog entry for a discovered id: inferred provider/group, humanized label, and a neutral cost tier
 *  (a hint until curated — cheaper for the obvious small/fast variants). */
export function idToModel(id: string): HarnessModel {
  const provider = providerForId(id);
  const cheap = /-(mini|nano|flash)\b|^gpt-5-mini|^grok-build|^composer/.test(id);
  return { id, label: humanizeId(id), provider, group: PROVIDER_GROUPS[provider] ?? PROVIDER_GROUPS.other!, cost: cheap ? 1 : 2 };
}

/**
 * Every concrete model id from `cursor-agent --list-models` output, in sorted order. Tolerant of the
 * output shape (comma- or newline-separated, with or without surrounding prose): an id is a lowercase
 * token that **contains a digit** (every real Cursor id does — `gpt-5.5`, `claude-opus-4-8`,
 * `composer-2.5`), which excludes prose words and the `auto` pseudo-model. `-fast` variants (a 2×-price
 * priority-speed toggle of an existing model) are dropped to keep the catalog to one entry per model.
 */
export function parseModelList(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/[a-z][a-z0-9.]*(?:-[a-z0-9.]+)*/g)) {
    const id = m[0];
    if (!/[0-9]/.test(id)) continue; // real ids all carry a version digit; excludes prose + `auto`
    if (id.endsWith('-fast')) continue; // priority-speed variant of another model — skip
    ids.add(id);
  }
  return [...ids].sort();
}

/** The result of reconciling the curated catalog with the CLI's model list. */
export interface MergeResult {
  /** The merged catalog: curated entries preserved (order kept, grouped contiguously), discovered ones added. */
  models: HarnessModel[];
  /** Ids reported by the CLI but not in the curated catalog (newly added, with inferred metadata). */
  added: string[];
  /** Ids in the curated catalog no longer reported by the CLI (dropped). */
  removed: string[];
}

/**
 * Reconcile the curated catalog with the CLI's model ids: keep every curated entry that still exists (its
 * hand-checked label/cost/recommended intact), add discovered ones with inferred metadata, drop ones
 * Cursor removed — then order so each provider's group is contiguous (first-seen order, stable within).
 */
export function mergeModels(curated: HarnessModel[], ids: string[]): MergeResult {
  const wanted = [...new Set(ids)];
  const wantedSet = new Set(wanted);
  const curatedById = new Map(curated.map((m) => [m.id, m]));

  const models: HarnessModel[] = curated.filter((m) => wantedSet.has(m.id));
  const added: string[] = [];
  for (const id of wanted) {
    if (!curatedById.has(id)) {
      models.push(idToModel(id));
      added.push(id);
    }
  }
  const removed = curated.filter((m) => !wantedSet.has(m.id)).map((m) => m.id);

  // Stable sort by each group's first appearance, so a newly-added model lands in its provider's block
  // rather than forming a duplicate header far down the list.
  const groupOrder = new Map<string, number>();
  for (const m of models) if (!groupOrder.has(m.group ?? '')) groupOrder.set(m.group ?? '', groupOrder.size);
  models.sort((a, b) => groupOrder.get(a.group ?? '')! - groupOrder.get(b.group ?? '')!);

  return { models, added, removed };
}
