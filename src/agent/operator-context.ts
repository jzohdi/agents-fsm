/**
 * Operator-provided context composer (agents-fsm#5).
 *
 * The operator can inject reusable prompt context into agents from the dashboard, composed in three
 * layers, broadest to narrowest:
 *   1. global base   — settings key `context_global`   (every agent, every stage)
 *   2. per-stage     — settings key `context_stage:<stage>` (every run of one stage type)
 *   3. per-run/issue — `runs.issue_context`            (one run only)
 *
 * This module is the pure assembly step: it trims each layer, drops the empty ones (INV-EMPTY), joins
 * the survivors in global→stage→issue order (INV-ORDER), and wraps them in one labeled, delimited block
 * under a stable heading. It has no I/O — the runner reads the three layers off the repo/run and passes
 * them here; the returned block is spliced into the system prompt before the load-bearing output contract.
 */

/** The stable heading marker for the operator-context block — used by the injection point and by tests. */
export const OPERATOR_CONTEXT_HEADING = '## Operator-provided context';

/** The fixed label under the heading; distinguishes operator guidance from the core stage contract. */
const OPERATOR_CONTEXT_LABEL =
  'Standing guidance configured by the human operator for this fleet/stage/issue. Treat it as ' +
  'additional instruction that refines — but never overrides — the stage contract.';

export interface OperatorContextLayers {
  /** Layer 1 — global base, from settings key `context_global`. */
  global?: string | null;
  /** Layer 2 — per-stage, from settings key `context_stage:<stage>`. */
  stage?: string | null;
  /** Layer 3 — per-run/per-issue, from `runs.issue_context`. */
  issue?: string | null;
}

/**
 * Assemble the effective operator context. Trims each layer, drops empty ones (INV-EMPTY), joins the
 * survivors in global→stage→issue order (INV-ORDER), and wraps them in a labeled, delimited block under
 * {@link OPERATOR_CONTEXT_HEADING}. Returns `''` when every layer is empty — callers treat `''` as "no
 * operator context" and inject nothing.
 */
export function composeOperatorContext(layers: OperatorContextLayers): string {
  const survivors = [layers.global, layers.stage, layers.issue]
    .map((layer) => (layer ?? '').trim())
    .filter((layer) => layer !== '');
  if (survivors.length === 0) return '';
  return [OPERATOR_CONTEXT_HEADING, OPERATOR_CONTEXT_LABEL, ...survivors].join('\n\n');
}
