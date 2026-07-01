/**
 * Selectable model catalogs per harness (Layer 5 metadata).
 *
 * The dashboard's per-run model dropdown needs to know which models the *current harness* accepts. That
 * list is harness-specific — Claude Code's `--model` tags differ from whatever a future harness exposes —
 * so it lives behind a small {@link HarnessCatalog} abstraction rather than being hardcoded in the UI or
 * the API. Today there is exactly one real harness (Claude Code, {@link ./subprocess-executor}); adding
 * another means adding its catalog here and wiring it in `build-runner`, with no change above Layer 6.
 *
 * A model's `id` is passed verbatim to the harness (Claude Code's `--model`), so it must be a value the
 * harness accepts. Keep this list current with the harness's supported tags (README model catalog).
 */

/** One selectable model: the harness tag (`id`) plus a human label and an optional dropdown group. */
export interface HarnessModel {
  /** The value handed to the harness's model selector (Claude Code's `--model`). */
  id: string;
  /** Human-readable label for the dropdown. */
  label: string;
  /** Optional grouping header for the dropdown (e.g. `Aliases`, `Pinned versions`). */
  group?: string;
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
 */
export const CLAUDE_CODE_CATALOG: HarnessCatalog = {
  harness: 'claude-code',
  models: [
    { id: 'opus', label: 'Opus (latest)', group: 'Aliases' },
    { id: 'sonnet', label: 'Sonnet (latest)', group: 'Aliases' },
    { id: 'haiku', label: 'Haiku (latest)', group: 'Aliases' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8', group: 'Pinned versions' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', group: 'Pinned versions' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', group: 'Pinned versions' },
    { id: 'claude-fable-5', label: 'Fable 5', group: 'Pinned versions' },
  ],
};

/** Whether `modelId` is one of the catalog's selectable models — the validation the API applies before
 *  storing a per-run override, so a typo can't set a model the harness would later reject. */
export function catalogHasModel(catalog: HarnessCatalog, modelId: string): boolean {
  return catalog.models.some((m) => m.id === modelId);
}
