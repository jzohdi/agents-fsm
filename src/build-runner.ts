/**
 * Shared wiring for the operator entry points (the one-shot CLI and the `serve` daemon).
 *
 * `buildRunner` constructs the Agent Runner + its GitHub adapter for the selected mode — real
 * (default: the Claude Code subprocess executor + the `gh`/`git` adapter + real prompts) or stub/fake
 * (`--mock`: no network, no cost). Factored out of `cli.ts` so the CLI and the M5 daemon build the
 * runner identically and the wiring can't drift.
 *
 * `buildOrchestrator` adds the M5 service layer on top: a shared {@link Broadcaster}, the runner's
 * live activities wired into it, and an {@link Orchestrator} (which owns the Event Loop). The same
 * builder backs the daemon and its tests.
 */

import { loadConfig, loadDefaultConfig, type AgentsConfig, type LoadedConfig } from './fsm/config';
import { openDb } from './store/db';
import { Repository } from './store/repository';
import { AgentRunner, type PhaseActivity } from './agent/runner';
import { FatalExecutorError, StubExecutor, goldenPathHandler } from './agent/executor';
import { FakeGitHub } from './integration/github-fake';
import type { GitHub } from './integration/github';
import { EnrolledRepoResolver, singleRepoResolver, type RepoResolver } from './integration/github-resolver';
import { buildRealGitHub, buildRealRunner } from './real-run';
import { Orchestrator } from './api/orchestrator';
import { Broadcaster } from './api/stream';
import type { CliArgs } from './cli-args';

export interface BuildRunnerOptions {
  /** Live-progress sink (the "what is the agent doing now" feed). Stub mode never streams, so it stays quiet there. */
  onActivity?: (activity: PhaseActivity) => void;
}

/**
 * Build the Agent Runner + GitHub adapter for the selected mode. The adapter is returned so callers
 * (the CLI's Reply Poller, the daemon) can share the one instance — important for the fake, whose
 * seeded issues live in memory.
 */
export function buildRunner(
  args: CliArgs,
  repo: Repository,
  agents: AgentsConfig,
  repoRef: string,
  options: BuildRunnerOptions = {},
): { runner: AgentRunner; github: GitHub; resolver: RepoResolver } {
  if (args.mock) {
    // Mock mode is single-repo by nature (one in-memory fake); the resolver returns it for any ref.
    const github = new FakeGitHub({ autoSeedIssues: true });
    const resolver = singleRepoResolver({ github, baseBranch: args.base });
    const runner = new AgentRunner(repo, new StubExecutor(goldenPathHandler), agents, resolver, {
      ...(options.onActivity ? { onActivity: options.onActivity } : {}),
    });
    return { runner, github, resolver };
  }
  const config = {
    repo: args.repo ?? repoRef,
    baseBranch: args.base,
    workingRoot: args.work,
    cheap: args.cheap,
    cloneUrl: args.cloneUrl,
    localRepo: args.localRepo,
    permissionMode: args.permissionMode,
    frontierModel: args.model,
    ...(args.timeoutMinutes !== undefined ? { timeoutMs: args.timeoutMinutes * 60_000 } : {}),
  };
  // A real run is bound to a repo; refuse early with actionable guidance rather than a later
  // "repo not enrolled" from the resolver (matches the pre-M8 buildRealGitHub guard).
  if (!config.repo) throw new Error('a real run needs a repo (owner/name); pass --repo or a start issueRef');
  // Enroll the daemon's bound repo (boot-time, idempotent) so the resolver can find it. Other repos
  // are enrolled at runtime via `POST /repos` (Milestone 8 Phase A). The per-repo adapter is built
  // straight from the registry row, so each run is serviced by *its* repo's adapter (README §M8).
  repo.upsertRepo({
    repoRef: config.repo,
    workingRoot: config.workingRoot,
    baseBranch: config.baseBranch,
    cloneUrl: config.cloneUrl ?? null,
    localRepo: config.localRepo ?? null,
  });
  const resolver = new EnrolledRepoResolver(
    (ref) => repo.getRepo(ref),
    (row) =>
      buildRealGitHub({
        repo: row.repoRef,
        workingRoot: row.workingRoot,
        baseBranch: row.baseBranch,
        ...(row.cloneUrl ? { cloneUrl: row.cloneUrl } : {}),
        ...(row.localRepo ? { localRepo: row.localRepo } : {}),
      }),
  );
  const runner = buildRealRunner(repo, agents, config, {
    github: resolver,
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
  });
  // The bound repo's adapter powers the new-run autocomplete (a cross-repo `gh` search — any adapter
  // works, this is just the one on hand). The runner and Reply Poller use the resolver, not this.
  const github = resolver.for(config.repo).github;
  return { runner, github, resolver };
}

/** Load the FSM config the daemon/CLI runs under: `--config <path>` when given, else the bundled default. */
export function loadRunConfig(args: CliArgs): { loaded: LoadedConfig; configPath?: string } {
  if (args.config) return { loaded: loadConfig(args.config), configPath: args.config };
  return { loaded: loadDefaultConfig() }; // no path → `updateConfig` is read-only (never overwrites the bundled default)
}

/** The daemon's default global concurrency cap when neither `--concurrency` nor `FLEET_CONCURRENCY` is set. */
const DEFAULT_CONCURRENCY = 4;

/**
 * Resolve the daemon's global concurrency cap (Milestone 8 Phase B), precedence: the `--concurrency`
 * flag → the `FLEET_CONCURRENCY` env var → {@link DEFAULT_CONCURRENCY}. A non-positive or non-numeric
 * value falls through to the default, so a typo can never wedge the pump at 0. The Orchestrator clamps
 * to ≥ 1 as a second guard.
 */
export function resolveConcurrency(args: CliArgs): number {
  const fromEnv = process.env.FLEET_CONCURRENCY !== undefined ? Number(process.env.FLEET_CONCURRENCY) : undefined;
  const candidate = args.concurrency ?? fromEnv;
  return candidate !== undefined && Number.isFinite(candidate) && candidate >= 1 ? Math.floor(candidate) : DEFAULT_CONCURRENCY;
}

/**
 * Build the daemon's {@link Orchestrator} and its dependencies. The runner's live activities are wired
 * into the shared {@link Broadcaster}, so the SSE stream sees them alongside transitions and status
 * changes. The GitHub adapter is returned so the daemon can share it with the Reply Poller.
 */
export function buildOrchestrator(args: CliArgs): {
  orchestrator: Orchestrator;
  repo: Repository;
  github: GitHub;
  resolver: RepoResolver;
  broadcaster: Broadcaster;
} {
  const { loaded, configPath } = loadRunConfig(args);
  const repo = new Repository(openDb(args.db));
  const broadcaster = new Broadcaster();
  const repoRef = args.repo ?? args.positionals[1]?.split('#')[0] ?? '';
  const { runner, github, resolver } = buildRunner(args, repo, loaded.agents, repoRef, {
    onActivity: (activity) => broadcaster.publish({ type: 'activity', activity }),
  });
  const orchestrator = new Orchestrator({
    repo,
    runner,
    config: loaded,
    broadcaster,
    github, // powers the new-run autocomplete (GET /suggestions)
    resolver, // per-repo adapter resolution + the start-time enrollment check (Milestone 8)
    defaultWorkingRoot: args.work, // a POST /repos enrollment defaults its working root to the daemon's --work
    concurrency: resolveConcurrency(args), // global cap for the parallel drain pump (Milestone 8 Phase B)
    ...(configPath ? { configPath } : {}),
    // A FatalExecutorError (e.g. the harness is unauthenticated) fails every run; surface its remedy
    // prominently rather than a bare stack trace, the way the one-shot CLI does on shutdown.
    onError: (err) => {
      if (err instanceof FatalExecutorError) console.error(`\n✖ ${err.message}\n\n${err.remedy}\n`);
      else console.error(`[daemon] drain error: ${String(err)}`);
    },
  });
  return { orchestrator, repo, github, resolver, broadcaster };
}
