/**
 * Per-repo adapter resolution (Milestone 8 Phase A — README §5).
 *
 * Before M8 the Agent Runner and Reply Poller each held a *single* {@link GitHub} adapter bound to one
 * repo. To service runs from more than one repo, they instead hold a {@link RepoResolver}: given a
 * run's `repoRef` it returns that repo's adapter + base branch (a {@link RepoContext}). This is the one
 * seam multi-repo execution turns on — nothing above it (the FSM engine, the event loop) changes.
 *
 * Two implementations: {@link singleRepoResolver} (one repo / mock / tests — ignores the ref) and
 * {@link EnrolledRepoResolver} (looks the ref up in the `repos` registry and builds the adapter from
 * the row, memoized).
 */

import type { GitHub } from './github';
import type { Repo } from '../store/repository';

/** Everything a stage needs that varies per repository: its adapter and its base branch. */
export interface RepoContext {
  github: GitHub;
  baseBranch: string;
}

/** Resolves the {@link RepoContext} for a run's canonical `owner/name` ref (the sibling of {@link GitHub}). */
export interface RepoResolver {
  for(repoRef: string): RepoContext;
  /** Drop any cached adapter for `repoRef` so the next {@link RepoResolver.for} rebuilds it from the
   *  current registry row. Called after a repo's config is re-enrolled (`POST /repos`). No-op when the
   *  resolver holds no per-repo cache. */
  invalidate(repoRef: string): void;
}

/**
 * Whether `x` is a {@link RepoResolver} (vs. a bare {@link GitHub}). Lets the Runner/Poller accept
 * either — single-repo callers and tests pass one adapter; the multi-repo daemon passes a resolver.
 */
export function isRepoResolver(x: GitHub | RepoResolver): x is RepoResolver {
  return typeof (x as RepoResolver).for === 'function';
}

/** A resolver bound to one fixed context — the single-repo / mock / test path (ignores the ref). */
export function singleRepoResolver(context: RepoContext): RepoResolver {
  return { for: () => context, invalidate: () => {} };
}

/**
 * Resolves each enrolled repo to a live adapter, memoized per repo so an adapter (and its working-tree
 * clone) is built once and reused across that repo's runs. `lookup` reads the `repos` registry;
 * `build` maps a row to an adapter (real mode wires a `GitHubCli`; tests inject a fake builder). A run
 * referencing a repo that was never enrolled is a loud, actionable error rather than a silent default.
 *
 * The cache is keyed by repo (so a stateful adapter — a fake, or a real one holding a working-tree
 * handle — is reused across a repo's resolves). A *new* repo enrolled after startup resolves on its
 * first `for()` (cache miss → fresh lookup); a *re-enrolled* repo whose config changed is picked up
 * only after {@link EnrolledRepoResolver.invalidate} drops its stale entry — which the enroll command
 * calls, so `POST /repos` takes effect without a restart.
 */
export class EnrolledRepoResolver implements RepoResolver {
  private readonly cache = new Map<string, RepoContext>();

  constructor(
    private readonly lookup: (repoRef: string) => Repo | undefined,
    private readonly build: (repo: Repo) => GitHub,
  ) {}

  for(repoRef: string): RepoContext {
    const key = repoRef.toLowerCase(); // refs are case-insensitive (so is the registry lookup)
    const cached = this.cache.get(key);
    if (cached) return cached;
    const row = this.lookup(repoRef);
    if (!row) {
      throw new Error(
        `repo not enrolled: ${repoRef}. Enroll it (POST /repos) or start the daemon with --repo ${repoRef}.`,
      );
    }
    const context: RepoContext = { github: this.build(row), baseBranch: row.baseBranch };
    this.cache.set(key, context);
    return context;
  }

  invalidate(repoRef: string): void {
    this.cache.delete(repoRef.toLowerCase());
  }
}
