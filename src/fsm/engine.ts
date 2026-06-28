/**
 * The FSM engine (Layer 2 — see README §3.3).
 *
 * A pure, side-effect-free module. It knows nothing about agents, HTTP, or the
 * database. Given the current state, the completed stage's result, and the guard
 * counters, it answers exactly one question: what is the next state?
 *
 * Two invariants it must never break (see README Milestone 1):
 *  1. Every decision is either a FORWARD move in canonical order or a declared edge.
 *  2. Reaching a round limit always lands in the escalation state.
 */

import {
  FORWARD,
  type Decision,
  type DecisionContext,
  type FsmConfig,
  type RunBudget,
  type StateDef,
  type StateName,
  type TransitionDef,
} from './types';

/** Base class for all engine errors, so callers can catch the family. */
export class FsmError extends Error {}

/** A state name was referenced that does not exist in the config. */
export class UnknownStateError extends FsmError {
  constructor(public readonly state: StateName) {
    super(`Unknown state: ${JSON.stringify(state)}`);
    this.name = 'UnknownStateError';
  }
}

/** `decideNext` was called on a terminal state (`done` / `needs_human`). */
export class TerminalStateError extends FsmError {
  constructor(public readonly state: StateName) {
    super(`Cannot transition out of terminal state: ${JSON.stringify(state)}`);
    this.name = 'TerminalStateError';
  }
}

/** The requested transition is not legal from the current state. */
export class IllegalTransitionError extends FsmError {
  constructor(
    public readonly state: StateName,
    public readonly trigger: string,
    detail?: string,
  ) {
    super(
      `Illegal transition ${JSON.stringify(trigger)} from state ${JSON.stringify(state)}` +
        (detail ? `: ${detail}` : ''),
    );
    this.name = 'IllegalTransitionError';
  }
}

function getState(config: FsmConfig, name: StateName): StateDef {
  const def = config.states[name];
  if (!def) throw new UnknownStateError(name);
  return def;
}

/** True when the state is skipped during a FORWARD advance given the run's flags. */
function isSkipped(def: StateDef, flags: Record<string, boolean> | undefined): boolean {
  return def.optionalFlag !== undefined && flags?.[def.optionalFlag] === false;
}

/**
 * Resolve a FORWARD move: the next state in `forwardOrder` after `current`,
 * skipping optional states disabled by `flags`.
 */
function resolveForward(
  config: FsmConfig,
  current: StateName,
  flags: Record<string, boolean> | undefined,
): StateName {
  const idx = config.forwardOrder.indexOf(current);
  if (idx < 0) {
    throw new IllegalTransitionError(current, FORWARD, 'state is not in forwardOrder');
  }
  for (let i = idx + 1; i < config.forwardOrder.length; i++) {
    const candidate = config.forwardOrder[i];
    if (candidate === undefined) continue; // unreachable; satisfies noUncheckedIndexedAccess
    if (isSkipped(getState(config, candidate), flags)) continue;
    return candidate;
  }
  throw new IllegalTransitionError(current, FORWARD, 'no forward state after this one');
}

/** Resolve the concrete target of a matched transition (excluding guard handling). */
function resolveTarget(
  config: FsmConfig,
  current: StateName,
  trigger: string,
  def: TransitionDef,
  ctx: DecisionContext,
): StateName {
  if (def.toOneOf) {
    const chosen = ctx.result.target;
    if (chosen === undefined) {
      throw new IllegalTransitionError(
        current,
        trigger,
        `result.target is required (one of ${def.toOneOf.join(', ')})`,
      );
    }
    if (!def.toOneOf.includes(chosen)) {
      throw new IllegalTransitionError(
        current,
        trigger,
        `target ${JSON.stringify(chosen)} not allowed (expected one of ${def.toOneOf.join(', ')})`,
      );
    }
    // Reject targets that are out of scope for this run (e.g. choosing a skipped stage).
    if (isSkipped(getState(config, chosen), ctx.result.flags)) {
      throw new IllegalTransitionError(current, trigger, `target ${JSON.stringify(chosen)} is skipped for this run`);
    }
    return chosen;
  }
  if (def.to === FORWARD) {
    return resolveForward(config, current, ctx.result.flags);
  }
  if (def.to === undefined) {
    throw new IllegalTransitionError(current, trigger, 'transition has neither `to` nor `toOneOf`');
  }
  // A concrete target: confirm it exists so we never hand back an unknown state.
  getState(config, def.to);
  return def.to;
}

/**
 * Compute the next state for a completed stage.
 *
 * @throws {TerminalStateError} if `current` is terminal.
 * @throws {IllegalTransitionError} if the requested transition is undefined or its target is invalid.
 * @throws {UnknownStateError} if `current` (or a referenced target) is not in the config.
 */
export function decideNext(config: FsmConfig, ctx: DecisionContext): Decision {
  const state = getState(config, ctx.current);
  if (state.terminal || !state.transitions) {
    throw new TerminalStateError(ctx.current);
  }

  const trigger = ctx.result.requestedTransition;
  const def = state.transitions[trigger];
  if (!def) {
    throw new IllegalTransitionError(ctx.current, trigger);
  }

  // Guard: a counted back-edge that has already hit its round limit escalates instead of looping.
  if (def.backEdge && def.counter !== undefined) {
    const limit = config.guards[def.counter];
    const count = ctx.counters?.[def.counter] ?? 0;
    if (limit !== undefined && count >= limit) {
      // The taken edge goes to escalation, not a loop-back: backEdge is false so the
      // caller does not record a counter increment. `counter` is kept for telemetry
      // (which guard tripped).
      return { to: config.escalationState, escalated: true, backEdge: false, counter: def.counter };
    }
  }

  const to = resolveTarget(config, ctx.current, trigger, def, ctx);
  return { to, escalated: false, backEdge: def.backEdge ?? false, counter: def.counter };
}

/**
 * Pure run-budget check (README §2 run budget). The event loop calls this before
 * dispatching a stage; if it returns true, the run is routed to `needs_human`.
 * Kept here so the budget rule is in the engine module and unit-tested, without
 * entangling it with next-state logic.
 */
export interface RunUsage {
  tokens?: number;
  agentRuns?: number;
  wallClockMs?: number;
}

export function budgetExceeded(budget: RunBudget | undefined, usage: RunUsage): boolean {
  if (!budget) return false;
  if (budget.maxTokens !== undefined && (usage.tokens ?? 0) > budget.maxTokens) return true;
  if (budget.maxAgentRuns !== undefined && (usage.agentRuns ?? 0) > budget.maxAgentRuns) return true;
  if (budget.maxWallClockMs !== undefined && (usage.wallClockMs ?? 0) > budget.maxWallClockMs) return true;
  return false;
}
