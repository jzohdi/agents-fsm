/**
 * FSM type definitions (Layer 2 — see README §3.3).
 *
 * These describe the *shape* of the workflow config that the pure engine consumes.
 * The engine is handed an already-validated `FsmConfig`; it never reads files or a DB.
 */

export type StateName = string;

/**
 * Sentinel `to` value meaning "advance to the next state in `forwardOrder`,
 * skipping any optional states disabled by the run's flags". See README §2 forward path.
 */
export const FORWARD = 'FORWARD' as const;
export type Forward = typeof FORWARD;

export interface TransitionDef {
  /**
   * Target state, or {@link FORWARD} to advance in canonical order.
   * Mutually exclusive with `toOneOf`.
   */
  to?: StateName | Forward;
  /**
   * The set of legal concrete targets when the agent must choose (e.g. `code_review`
   * requesting changes to `frontend` *or* `backend`). The stage result must name one.
   */
  toOneOf?: StateName[];
  /** True when this edge moves work to an earlier state (README §2 back-edges). */
  backEdge?: boolean;
  /**
   * Round-counter key for guarding a looping back-edge. When set, `guards[counter]`
   * caps how many times the loop may run before escalating (README §2 guards).
   */
  counter?: string;
}

export interface StateDef {
  /** Outgoing transitions keyed by trigger name (the agent's `requestedTransition`). */
  transitions?: Record<string, TransitionDef>;
  /**
   * When set, this state is skipped during a FORWARD advance if the run's
   * `flags[optionalFlag]` is `false` (README §2 skipping frontend/backend).
   */
  optionalFlag?: string;
  /** Terminal states (`done`, `needs_human`) have no outgoing transitions. */
  terminal?: boolean;
}

export interface RunBudget {
  maxTokens?: number;
  maxAgentRuns?: number;
  maxWallClockMs?: number;
}

export interface FsmConfig {
  /** State a new run starts in (e.g. `triage`). */
  initial: StateName;
  /** Where guard trips and `escalate` triggers land (e.g. `needs_human`). */
  escalationState: StateName;
  /** Canonical forward order used to resolve {@link FORWARD}. */
  forwardOrder: StateName[];
  /** Every state in the machine. */
  states: Record<StateName, StateDef>;
  /** Round limit per counter key (README §2 guards). */
  guards: Record<string, number>;
  /** Optional per-run ceilings, the backstop against slow drift (README §2 run budget). */
  budget?: RunBudget;
}

/** What a completed stage hands the engine in order to compute the next state. */
export interface StageResult {
  /** Must be a trigger defined on the current state's `transitions`. */
  requestedTransition: string;
  /** Concrete target, required when the matched transition uses `toOneOf`. */
  target?: StateName;
  /** Skip flags such as `needs_frontend` / `needs_backend`, set by `plan`. */
  flags?: Record<string, boolean>;
}

export interface DecisionContext {
  current: StateName;
  result: StageResult;
  /**
   * Round counters by key, derived from the transitions log (README §3.3 Layer 1).
   * Absent keys are treated as 0.
   */
  counters?: Record<string, number>;
}

export interface Decision {
  /** The next state. */
  to: StateName;
  /** True when a guard tripped and we routed to `escalationState` instead of the requested edge. */
  escalated: boolean;
  /** True when the taken edge is a back-edge (relevant for counter bookkeeping by the caller). */
  backEdge: boolean;
  /** The counter key this transition advances, if any (so the caller can persist it). */
  counter?: string;
}
