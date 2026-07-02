/**
 * Selectable model catalogs per harness (Layer 5 metadata).
 *
 * The dashboard's per-run model dropdown needs to know which models the *current harness* accepts. That
 * list is harness-specific — Claude Code's `--model` tags differ from whatever a future harness exposes —
 * so it lives behind a small {@link HarnessCatalog} abstraction rather than being hardcoded in the UI or
 * the API. Two harnesses ship a catalog today — Claude Code ({@link ./subprocess-executor}) and Cursor
 * ({@link ./cursor-profile}); adding another means adding its catalog here and registering it in {@link
 * HARNESS_CATALOGS}, with no change above Layer 6.
 *
 * A model's `id` is passed verbatim to the harness (Claude Code's `--model`), so it must be a value the
 * harness accepts. Keep this list current with the harness's supported tags (README model catalog).
 */

import cursorModels from './cursor-models.json';

/** One selectable model: the harness tag (`id`) plus a human label and optional picker metadata. */
export interface HarnessModel {
  /** The value handed to the harness's model selector (Claude Code's `--model`). */
  id: string;
  /** Human-readable label for the dropdown. */
  label: string;
  /** Optional grouping header for the dropdown (e.g. a provider name, `Aliases`, `Pinned versions`). */
  group?: string;
  /**
   * Optional provider slug for the model picker's logo + colour (`anthropic`, `openai`, `google`, `xai`,
   * `deepseek`, `moonshot`). Purely presentational — the dashboard maps it to a brand mark; an unknown or
   * absent slug falls back to a neutral monogram.
   */
  provider?: string;
  /** Optional relative cost tier 1–4, rendered as dollar signs in the picker (1 = cheapest). */
  cost?: number;
  /** Optional flag: surface this model in the picker's "Recommended" shortlist at the top. */
  recommended?: boolean;
  /**
   * Optional reasoning-effort levels this model accepts, in ascending order (a subset of {@link
   * EFFORT_LEVELS}). Absent/empty → the model has no selectable effort (the picker hides the effort
   * control). Claude Code applies the chosen level via its `--effort` flag; Cursor's CLI has no working
   * effort parameter today (its model-suffix scheme is documented but ignored — see README §9.8), so its
   * models leave this empty.
   */
  efforts?: string[];
}

/**
 * Reasoning-effort levels, ascending. Claude Code's `--effort` accepts exactly these; a model advertises
 * the subset it supports via {@link HarnessModel.efforts}. `max` is the deepest (session-only in the CLI,
 * but the flag accepts it). Kept as the single source of truth the API validates a chosen effort against.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Whether `value` is a known effort level (the typo guard the API applies before storing an effort). */
export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** The effort levels a specific model in a catalog supports (empty when the model has none / is unknown). */
export function modelEfforts(catalog: HarnessCatalog, modelId: string): string[] {
  return catalog.models.find((m) => m.id === modelId)?.efforts ?? [];
}

/** Whether any model in the catalog supports reasoning effort — i.e. the harness offers it at all. */
export function catalogSupportsEffort(catalog: HarnessCatalog): boolean {
  return catalog.models.some((m) => m.efforts && m.efforts.length > 0);
}

/** The set of models a harness accepts, in display order. */
export interface HarnessCatalog {
  /** Harness identifier (e.g. `claude-code`). */
  harness: string;
  /** Selectable models, in the order the dropdown should show them. */
  models: HarnessModel[];
}

/**
 * Claude Code's selectable `--model` tags. Two groups:
 *  - **Aliases** — the everyday tags that always resolve to the latest of each family (`opus`, `sonnet`,
 *    `haiku`). This is what most operators want.
 *  - **Pinned versions** — exact model ids, for a reproducible run that won't shift when a new latest
 *    ships.
 * Keep in sync with the models Claude Code accepts (the README model catalog).
 *
 * `efforts` mirror Claude Code's `--effort` support (docs "Model configuration"): the `opus`/`sonnet`
 * aliases (latest Opus/Sonnet) and the pinned frontier models take all five levels; Haiku has none.
 */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CLAUDE_CODE_CATALOG: HarnessCatalog = {
  harness: 'claude-code',
  models: [
    { id: 'opus', label: 'Opus (latest)', group: 'Aliases', provider: 'anthropic', cost: 4, recommended: true, efforts: CLAUDE_EFFORTS },
    { id: 'sonnet', label: 'Sonnet (latest)', group: 'Aliases', provider: 'anthropic', cost: 3, recommended: true, efforts: CLAUDE_EFFORTS },
    { id: 'haiku', label: 'Haiku (latest)', group: 'Aliases', provider: 'anthropic', cost: 1, recommended: true },
    { id: 'claude-opus-4-8', label: 'Opus 4.8', group: 'Pinned versions', provider: 'anthropic', cost: 4, efforts: CLAUDE_EFFORTS },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', group: 'Pinned versions', provider: 'anthropic', cost: 3, efforts: CLAUDE_EFFORTS },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', group: 'Pinned versions', provider: 'anthropic', cost: 1 },
    { id: 'claude-fable-5', label: 'Fable 5', group: 'Pinned versions', provider: 'anthropic', cost: 2, efforts: CLAUDE_EFFORTS },
  ],
};

/**
 * Cursor's selectable `--model` tags — the **exact** ids `cursor-agent` accepts, each passed verbatim to
 * `--model`. Unlike Claude Code (a separate `--effort` flag), Cursor bakes the **reasoning effort into the
 * model id** (e.g. `gpt-5.5-high`, `gpt-5.5-extra-high`, `claude-opus-4-8-xhigh`) and it is *required* for
 * most models — so the effort ladder is expressed as distinct catalog entries, not a separate control. The
 * naming is non-uniform (`extra-high` vs `xhigh`; some models omit the suffix for their default), so we
 * list concrete ids rather than synthesize them.
 *
 * The list is **data, not code** — it lives in {@link ./cursor-models.json}, curated from
 * `cursor-agent --list-models` and refreshable with `npm run models:refresh` (see
 * {@link ./cursor-models-source}). {@link CURSOR_MODEL_MAP}'s two values (frontier / cheap) must stay
 * listed there (drift guard in the tests). Cost tiers are relative hints, not billing figures.
 */
export const CURSOR_CATALOG: HarnessCatalog = {
  harness: 'cursor',
  models: cursorModels as HarnessModel[],
};

/** Every harness's catalog, keyed by harness id — the source {@link catalogForHarness} resolves against. */
export const HARNESS_CATALOGS: Record<string, HarnessCatalog> = {
  [CLAUDE_CODE_CATALOG.harness]: CLAUDE_CODE_CATALOG,
  [CURSOR_CATALOG.harness]: CURSOR_CATALOG,
};

/**
 * The selectable-model catalog for a harness id (the per-run model dropdown's source), or `undefined`
 * for an unknown harness. `getModels` resolves the *default* harness's catalog; `setModel` resolves the
 * *run's* — so the model allow-list always matches the harness that will actually run.
 */
export function catalogForHarness(harness: string): HarnessCatalog | undefined {
  return HARNESS_CATALOGS[harness];
}

/** Whether `modelId` is one of the catalog's selectable models — the validation the API applies before
 *  storing a per-run override, so a typo can't set a model the harness would later reject. */
export function catalogHasModel(catalog: HarnessCatalog, modelId: string): boolean {
  return catalog.models.some((m) => m.id === modelId);
}
