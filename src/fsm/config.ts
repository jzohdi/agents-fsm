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

import type { AgentPhase } from '../store/repository';
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
 * Stable content hash of any validated value. Object keys are sorted so formatting
 * and key order do not affect the version; array order (e.g. `forwardOrder`) is
 * preserved because it is semantically meaningful.
 */
function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex').slice(0, 16);
}

/** Content hash of an FSM config (kept as a focused utility for callers/tests). */
export function hashConfig(config: FsmConfig): string {
  return hashValue(config);
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

// --- agent config (Layer 4 recipe; consumed by the Agent Runner, never the engine) ---
//
// The FSM engine (engine.ts) only ever receives the `FsmConfig`. The per-stage phase
// recipe + model-per-phase live in the *same* config file under an `agents` key, but
// are split out here so the engine stays pure and never sees them (README §3.3 Layer 4).

/** Per-stage agent recipe: which phases to run, which model per phase, the internal-loop cap. */
export interface StageAgentConfig {
  /** Ordered phases the Agent Runner executes for this stage (e.g. `[produce, self_review, simplify]`). */
  phases: AgentPhase[];
  /** Logical model name per phase (resolved to a real model by the Layer 5 Stage Executor). */
  models?: Partial<Record<AgentPhase, string>>;
  /** Cap on the internal self-review → fix loop before escalating (README §2 internal review rounds). */
  reviewCap?: number;
  /**
   * Per-stage tool allow-list passed through to the harness (README §3.3 Layer 4/5), e.g.
   * review stages get read-only tools. Absent means the harness's default policy applies.
   */
  allowedTools?: string[];
}

/** Agent config keyed by stage name. Stages absent here use {@link DEFAULT_PHASES}. */
export type AgentsConfig = Record<string, StageAgentConfig>;

/** Producing stages run the full sequence; pure review stages override to `[produce]`. */
export const DEFAULT_PHASES: readonly AgentPhase[] = ['produce', 'self_review', 'simplify'];
export const DEFAULT_REVIEW_CAP = 2;

const phaseSchema = z.enum(['produce', 'self_review', 'simplify']);

/**
 * The Agent Runner always runs `produce` first, then treats `self_review`/`simplify` as
 * toggles in that fixed order (simplify only runs inside the self-review loop). So the only
 * meaningful recipes are prefixes of `[produce, self_review, simplify]`. Rejecting anything
 * else (e.g. `[produce, simplify]` or `[self_review]`) means the config can never express a
 * recipe the runner would silently misinterpret.
 */
function isCanonicalPrefix(phases: readonly AgentPhase[]): boolean {
  return phases.every((p, i) => p === DEFAULT_PHASES[i]);
}

const stageAgentSchema = z
  .object({
    phases: z
      .array(phaseSchema)
      .nonempty()
      .refine(isCanonicalPrefix, {
        message: 'phases must be a prefix of [produce, self_review, simplify] (produce first; simplify requires self_review)',
      }),
    models: z
      .object({ produce: z.string().optional(), self_review: z.string().optional(), simplify: z.string().optional() })
      .strict()
      .optional(),
    reviewCap: z.number().int().positive().optional(),
    allowedTools: z.array(z.string()).optional(),
  })
  .strict();

const agentsSchema = z.record(z.string(), stageAgentSchema);

/** Validate the optional `agents` section, defaulting to `{}` when absent. */
export function parseAgentsConfig(raw: unknown): AgentsConfig {
  if (raw === undefined) return {};
  const parsed = agentsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error.issues.map((i) => `agents.${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return parsed.data as AgentsConfig;
}

/** The effective recipe for a stage: configured values, or the producing-stage defaults. */
export function recipeFor(
  stage: string,
  agents: AgentsConfig,
): { phases: AgentPhase[]; models: Partial<Record<AgentPhase, string>>; reviewCap: number; allowedTools?: string[] } {
  const c = agents[stage];
  return {
    phases: c?.phases ?? [...DEFAULT_PHASES],
    models: c?.models ?? {},
    reviewCap: c?.reviewCap ?? DEFAULT_REVIEW_CAP,
    allowedTools: c?.allowedTools,
  };
}

/** Cross-check agent config against the FSM: every keyed stage must be a real, non-terminal state. */
function validateAgents(fsm: FsmConfig, agents: AgentsConfig): string[] {
  const problems: string[] = [];
  for (const stage of Object.keys(agents)) {
    const state = fsm.states[stage];
    if (!state) problems.push(`agents references unknown state ${q(stage)}`);
    else if (state.terminal) problems.push(`agents references terminal state ${q(stage)} (no agent runs there)`);
  }
  return problems;
}

// --- combined load (FSM rules + agent recipe + one pinned version) --------------

export interface LoadedConfig {
  /** The pure FSM rules handed to the engine. */
  fsm: FsmConfig;
  /** The per-stage agent recipe handed to the Agent Runner. */
  agents: AgentsConfig;
  /** Content hash over the whole file (FSM + agents), so a run pins both together. */
  version: string;
}

/** Validate a raw config object into its FSM and agent halves. */
export function parseConfigFile(raw: unknown): { fsm: FsmConfig; agents: AgentsConfig } {
  let agentsRaw: unknown;
  let fsmRaw: unknown = raw;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'agents' in raw) {
    const { agents, ...rest } = raw as Record<string, unknown>;
    agentsRaw = agents;
    fsmRaw = rest;
  }
  const fsm = parseFsmConfig(fsmRaw);
  const agents = parseAgentsConfig(agentsRaw);
  const problems = validateAgents(fsm, agents);
  if (problems.length > 0) throw new ConfigValidationError(problems);
  return { fsm, agents };
}

/** Load, validate, and version a config (FSM + agents) from a JSON file path. */
export function loadConfig(path: string | URL): LoadedConfig {
  const { fsm, agents } = parseConfigFile(JSON.parse(readFileSync(path, 'utf8')));
  return { fsm, agents, version: hashValue({ fsm, agents }) };
}

/** Load the built-in canonical pipeline (README §2). */
export function loadDefaultConfig(): LoadedConfig {
  return loadConfig(new URL('./default-config.json', import.meta.url));
}
