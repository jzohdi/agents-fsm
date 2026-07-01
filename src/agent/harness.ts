/**
 * Harness registry (Layer 5 — the swappable agent harness, README §3.3).
 *
 * A run names which harness executes it (its `harness` id, pinned at start like the FSM config version).
 * The registry resolves that id to the concrete {@link StageExecutor} for the whole daemon — the seam
 * that lets one fleet mix harnesses without the runner, loop, or store knowing which is running. It
 * mirrors the per-repo {@link RepoResolver} pattern (Milestone 8): resolve a per-run dependency by a key
 * carried on the run.
 *
 * Two harnesses are registered today — Claude Code ({@link ./subprocess-executor}) and Cursor
 * ({@link ./cursor-profile}); a third is a new entry here plus its executor, with no change above
 * Layer 5. The selectable-model side of a harness lives separately in {@link ./harness-models}; the ids
 * here match a catalog's `harness` field.
 */

import type { StageExecutor } from './executor';

/** Identifier for a selectable harness. Matches the `harness` field of its {@link HarnessCatalog}. */
export type HarnessId = 'claude-code' | 'cursor';

/** Every harness id the system knows about — the source of truth for validation + the selectable list. */
export const HARNESS_IDS: readonly HarnessId[] = ['claude-code', 'cursor'];

/** The harness a run uses when none is chosen: the shipped default (Claude Code). */
export const DEFAULT_HARNESS: HarnessId = 'claude-code';

/**
 * Settings-store key the persisted default harness lives under (the tiny KV in the store, Layer 1). The
 * dashboard's harness selector writes it (`PUT /settings/default-harness`); `resolveDefaultHarness` reads
 * it at boot. Co-located with the harness ids so its one writer and one reader share a single source.
 */
export const DEFAULT_HARNESS_SETTING_KEY = 'default_harness';

/** Narrow an untrusted value to a known {@link HarnessId} — the validation the API applies to a request. */
export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value);
}

/** Resolves the {@link StageExecutor} for a run's harness id. Mirrors {@link RepoResolver.for}. */
export interface HarnessResolver {
  for(harness: string): StageExecutor;
}

/**
 * A registry over the daemon's pre-built executors, keyed by harness id. An unknown/unregistered id
 * **throws** — it must never silently fall back to another harness (a run stamped for one harness that
 * ran on another would be wrong and confusing). The runner resolves inside its per-phase try/catch, so
 * a miss escalates that one run (`executor_error` → needs_human) rather than crashing the drain.
 */
export class HarnessRegistry implements HarnessResolver {
  private readonly executors: Map<string, StageExecutor>;

  constructor(executors: Record<string, StageExecutor>) {
    this.executors = new Map(Object.entries(executors));
  }

  for(harness: string): StageExecutor {
    const executor = this.executors.get(harness);
    if (!executor) {
      const registered = [...this.executors.keys()].join(', ') || 'none';
      throw new Error(`no executor registered for harness "${harness}" (registered: ${registered})`);
    }
    return executor;
  }

  /** Which harnesses this registry can service — the daemon's available set. */
  available(): string[] {
    return [...this.executors.keys()];
  }
}

/**
 * Wrap a single executor as a resolver that returns it for any id — the harness-never-varies case
 * (mock/stub mode and the many unit tests that construct a runner with one executor). Mirrors
 * {@link singleRepoResolver}.
 */
export function singleHarness(executor: StageExecutor): HarnessResolver {
  return { for: () => executor };
}

/** Whether `value` is a {@link HarnessResolver} (has `for`) vs a bare {@link StageExecutor} (has `run`). */
export function isHarnessResolver(value: StageExecutor | HarnessResolver): value is HarnessResolver {
  return typeof (value as Partial<HarnessResolver>).for === 'function';
}
