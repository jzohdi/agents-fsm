/**
 * FSM config loading, validation, and content-hash versioning (Layer 2 / Milestone 0).
 *
 * The config file is the version-controllable source of truth (README §3.3 Layer 2).
 * Loading produces a validated `FsmConfig` plus a stable `version` hash that every
 * run pins, so editing the config never changes the rules for an in-flight run.
 *
 * This module depends on zod and `node:fs`; the engine (engine.ts) stays pure and
 * never imports it.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { FORWARD, type FsmConfig } from './types';

/** Aggregates every problem found so the operator fixes them in one pass. */
export class ConfigValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid FSM config:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

const transitionSchema = z
  .object({
    to: z.string().optional(),
    toOneOf: z.array(z.string()).optional(),
    backEdge: z.boolean().optional(),
    counter: z.string().optional(),
  })
  .strict();

const stateSchema = z
  .object({
    transitions: z.record(z.string(), transitionSchema).optional(),
    optionalFlag: z.string().optional(),
    terminal: z.boolean().optional(),
  })
  .strict();

const budgetSchema = z
  .object({
    maxTokens: z.number().positive().optional(),
    maxAgentRuns: z.number().positive().optional(),
    maxWallClockMs: z.number().positive().optional(),
  })
  .strict();

const configSchema = z
  .object({
    initial: z.string(),
    escalationState: z.string(),
    forwardOrder: z.array(z.string()),
    states: z.record(z.string(), stateSchema),
    guards: z.record(z.string(), z.number().int().nonnegative()),
    budget: budgetSchema.optional(),
  })
  .strict();

/**
 * Semantic checks beyond structural (zod) validation. These are what make the
 * engine trustworthy: every referenced state exists, every guarded edge has a
 * limit, terminal/non-terminal states are well-formed, etc.
 */
function validateSemantics(config: FsmConfig): string[] {
  const problems: string[] = [];
  const stateNames = new Set(Object.keys(config.states));
  const has = (name: string) => stateNames.has(name);

  if (stateNames.size === 0) problems.push('states must not be empty');
  if (!has(config.initial)) problems.push(`initial state ${q(config.initial)} is not defined`);
  if (!has(config.escalationState)) {
    problems.push(`escalationState ${q(config.escalationState)} is not defined`);
  }

  const seenForward = new Set<string>();
  for (const name of config.forwardOrder) {
    if (!has(name)) problems.push(`forwardOrder references unknown state ${q(name)}`);
    if (seenForward.has(name)) problems.push(`forwardOrder contains duplicate ${q(name)}`);
    seenForward.add(name);
  }

  for (const [name, state] of Object.entries(config.states)) {
    const triggers = state.transitions ? Object.entries(state.transitions) : [];

    if (state.terminal) {
      if (triggers.length > 0) problems.push(`terminal state ${q(name)} must have no transitions`);
    } else if (triggers.length === 0) {
      problems.push(`non-terminal state ${q(name)} must define at least one transition`);
    }

    if (state.optionalFlag !== undefined && !seenForward.has(name)) {
      problems.push(`state ${q(name)} has optionalFlag but is not in forwardOrder, so it can never be skipped`);
    }

    for (const [trigger, def] of triggers) {
      const where = `${name}.${trigger}`;
      const hasTo = def.to !== undefined;
      const hasOneOf = def.toOneOf !== undefined;

      if (hasTo === hasOneOf) {
        problems.push(`transition ${q(where)} must set exactly one of \`to\` or \`toOneOf\``);
      }
      if (def.to !== undefined && def.to !== FORWARD && !has(def.to)) {
        problems.push(`transition ${q(where)} targets unknown state ${q(def.to)}`);
      }
      if (def.to === FORWARD) {
        if (!seenForward.has(name)) {
          problems.push(`transition ${q(where)} uses FORWARD but ${q(name)} is not in forwardOrder`);
        } else if (config.forwardOrder[config.forwardOrder.length - 1] === name) {
          problems.push(`transition ${q(where)} uses FORWARD but ${q(name)} is last in forwardOrder (no successor)`);
        }
      }
      if (def.toOneOf) {
        if (def.toOneOf.length === 0) problems.push(`transition ${q(where)} has an empty toOneOf`);
        for (const target of def.toOneOf) {
          if (!has(target)) problems.push(`transition ${q(where)} toOneOf references unknown state ${q(target)}`);
        }
      }
      if (def.counter !== undefined) {
        if (!def.backEdge) problems.push(`transition ${q(where)} sets a counter but is not a backEdge`);
        if (config.guards[def.counter] === undefined) {
          problems.push(`transition ${q(where)} uses counter ${q(def.counter)} with no matching guard limit`);
        }
      }
    }
  }

  return problems;
}

function q(value: string): string {
  return JSON.stringify(value);
}

/** Validate an untrusted object into an `FsmConfig`, or throw `ConfigValidationError`. */
export function parseFsmConfig(raw: unknown): FsmConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const config = parsed.data as FsmConfig;
  const problems = validateSemantics(config);
  if (problems.length > 0) throw new ConfigValidationError(problems);
  return config;
}

/**
 * Stable content hash of a validated config. Object keys are sorted so formatting
 * and key order do not affect the version; array order (e.g. `forwardOrder`) is
 * preserved because it is semantically meaningful.
 */
export function hashConfig(config: FsmConfig): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(config))).digest('hex').slice(0, 16);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export interface LoadedConfig {
  config: FsmConfig;
  version: string;
}

/** Load, validate, and version a config from a JSON file path. */
export function loadFsmConfig(path: string | URL): LoadedConfig {
  const config = parseFsmConfig(JSON.parse(readFileSync(path, 'utf8')));
  return { config, version: hashConfig(config) };
}

/** Load the built-in canonical pipeline (README §2). */
export function loadDefaultFsmConfig(): LoadedConfig {
  return loadFsmConfig(new URL('./default-config.json', import.meta.url));
}
