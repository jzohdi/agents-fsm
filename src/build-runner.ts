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
import { GitHubCliAccount, type SuggestionSource } from './integration/github-account';
import { catalogForHarness } from './agent/harness-models';
import { DEFAULT_HARNESS, DEFAULT_HARNESS_SETTING_KEY, HARNESS_IDS, isHarnessId, type HarnessId } from './agent/harness';
import { DEFAULT_MODEL_MAP } from './agent/subprocess-executor';
import { EnrolledRepoResolver, singleRepoResolver, type RepoResolver } from './integration/github-resolver';
import { buildRealGitHub, buildRealRunner } from './real-run';
import { Orchestrator } from './api/orchestrator';
import { Broadcaster } from './api/stream';
import type { CliArgs } from './cli-args';

export interface BuildRunnerOptions {
  /** Live-progress sink (the "what is the agent doing now" feed). Stub mode never streams, so it stays quiet there. */
  onActivity?: (activity: PhaseActivity) => void;
}

/** Wrap a {@link FakeGitHub} as a {@link SuggestionSource} so mock-mode autocomplete reads its seeded
 *  issues (tagged `kind:'issue'`). Repos aren't seeded, so mock suggestions are issues only. */
function fakeSuggestionSource(github: FakeGitHub): SuggestionSource {
  return { suggest: (query) => github.suggestIssues(query) };
}

/**
 * Build the Agent Runner + its resolver + the autocomplete {@link SuggestionSource} for the selected
 * mode. In mock mode the resolver's {@link FakeGitHub} is also returned as `github`, so callers that
 * seed it in memory (dev-preview, tests) share the one instance; real mode omits `github` (the daemon
 * is no longer pinned to a single repo's adapter).
 */
export function buildRunner(
  args: CliArgs,
  repo: Repository,
  agents: AgentsConfig,
  repoRef: string,
  options: BuildRunnerOptions = {},
): { runner: AgentRunner; resolver: RepoResolver; suggestionSource: SuggestionSource; github?: GitHub } {
  if (args.mock) {
    // Mock mode is single-repo by nature (one in-memory fake); the resolver returns it for any ref.
    const github = new FakeGitHub({ autoSeedIssues: true });
    const resolver = singleRepoResolver({ github, baseBranch: args.base });
    const runner = new AgentRunner(repo, new StubExecutor(goldenPathHandler), agents, resolver, {
      ...(options.onActivity ? { onActivity: options.onActivity } : {}),
    });
    return { runner, github, resolver, suggestionSource: fakeSuggestionSource(github) };
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
    ...(args.maxRetries !== undefined ? { maxRetries: args.maxRetries } : {}),
  };
  // Bootstrap-enroll the daemon's bound repo *only when one was given* (`--repo` or a start issueRef).
  // With none, the daemon boots empty and repos are enrolled on demand — via `POST /repos` or the
  // auto-enroll-on-first-run path in `Orchestrator.start` (Milestone 8 Phase A + this change). The
  // per-repo adapter is built straight from the registry row, so each run is serviced by its repo's.
  if (config.repo) {
    repo.upsertRepo({
      repoRef: config.repo,
      workingRoot: config.workingRoot,
      baseBranch: config.baseBranch,
      cloneUrl: config.cloneUrl ?? null,
      localRepo: config.localRepo ?? null,
    });
  }
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
  // The new-run autocomplete is powered by the logged-in `gh` user's own repos + their open issues —
  // a *repo-less*, user-scoped source (README §M8). That decoupling from any single repo is exactly
  // what lets the daemon start without `--repo`. The runner and Reply Poller use the resolver, not this.
  const suggestionSource = new GitHubCliAccount();
  return { runner, resolver, suggestionSource };
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
 * Resolve the daemon's global cost ceiling in dollars (Milestone 8 B3), precedence: `--cost-ceiling` →
 * `FLEET_COST_CEILING` → **off** (undefined = no ceiling). A non-finite or negative value is treated as
 * off, so a typo never wedges the fleet; `0` is a valid ceiling (park everything but overrides).
 */
export function resolveCostCeiling(args: CliArgs): number | undefined {
  const fromEnv = process.env.FLEET_COST_CEILING !== undefined ? Number(process.env.FLEET_COST_CEILING) : undefined;
  const candidate = args.costCeiling ?? fromEnv;
  return candidate !== undefined && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
}

/**
 * Resolve the harness a new run gets when the request omits one (plan §5.2), precedence: the
 * `--harness` flag → the `FLEET_HARNESS` env → the persisted `settings.default_harness` → the shipped
 * {@link DEFAULT_HARNESS}. Shared by both entry points (the daemon and the one-shot CLI) so the default
 * can't drift between them.
 *
 * A present-but-invalid **flag/env** value is operator error → we throw so the process fails fast at
 * boot (a typo shouldn't silently fall through to another harness). A stale/garbage **persisted** value
 * is read defensively — it falls back to the default rather than wedging boot (a bad settings row must
 * never stop the daemon).
 */
export function resolveDefaultHarness(args: CliArgs, repo: Repository): HarnessId {
  const flag = args.harness ?? process.env.FLEET_HARNESS;
  if (flag !== undefined && flag !== '') {
    if (!isHarnessId(flag)) {
      throw new Error(`invalid --harness/FLEET_HARNESS value "${flag}" (choose one of: ${HARNESS_IDS.join(', ')})`);
    }
    return flag;
  }
  const persisted = repo.getSetting(DEFAULT_HARNESS_SETTING_KEY);
  return persisted !== undefined && isHarnessId(persisted) ? persisted : DEFAULT_HARNESS;
}

/**
 * Build the daemon's {@link Orchestrator} and its dependencies. The runner's live activities are wired
 * into the shared {@link Broadcaster}, so the SSE stream sees them alongside transitions and status
 * changes. The GitHub adapter is returned so the daemon can share it with the Reply Poller.
 */
export function buildOrchestrator(args: CliArgs): {
  orchestrator: Orchestrator;
  repo: Repository;
  github?: GitHub;
  resolver: RepoResolver;
  broadcaster: Broadcaster;
} {
  const { loaded, configPath } = loadRunConfig(args);
  const repo = new Repository(openDb(args.db));
  // Effective default harness for runs that omit one (flag/env > persisted > claude-code). Resolved up
  // front so a bad `--harness`/`FLEET_HARNESS` fails fast — before we build executors or enroll a repo.
  // Also selects the catalog `GET /models` shows.
  const defaultHarness = resolveDefaultHarness(args, repo);
  const broadcaster = new Broadcaster();
  const repoRef = args.repo ?? args.positionals[1]?.split('#')[0] ?? '';
  const { runner, github, resolver, suggestionSource } = buildRunner(args, repo, loaded.agents, repoRef, {
    onActivity: (activity) => broadcaster.publish({ type: 'activity', activity }),
  });
  const orchestrator = new Orchestrator({
    repo,
    runner,
    config: loaded,
    broadcaster,
    suggestionSource, // powers the new-run autocomplete (GET /suggestions)
    resolver, // per-repo adapter resolution + the start-time enrollment check (Milestone 8)
    defaultWorkingRoot: args.work, // a POST /repos enrollment defaults its working root to the daemon's --work
    // Harness + model selection. `defaultHarness` is what a run without an explicit harness gets, and
    // which harness's catalog `GET /models` shows; `catalogFor` resolves each harness to its selectable
    // models (per-run for `setModel`, the default for `getModels`). Mock mode reuses the real catalogs
    // for UI parity — the stub executor ignores the chosen harness/model.
    defaultHarness,
    catalogFor: catalogForHarness,
    // The concrete model a run uses when it has no override — the dropdown's "Default". This is the Claude
    // `--model` flag (or its `opus` default); `getModels` only surfaces it when it's a model in the shown
    // harness's catalog, so it's ignored for a non-Claude default rather than mislabeled.
    defaultModel: args.model ?? DEFAULT_MODEL_MAP.frontier,
    concurrency: resolveConcurrency(args), // global cap for the parallel drain pump (Milestone 8 Phase B)
    feedbackReentryState: args.feedbackReentryState, // stage a run re-enters on PR feedback (default plan)
    feedbackMarker: args.feedbackMarker, // marker a PR comment must start with to count as feedback (default `feedback:`)
    ...(resolveCostCeiling(args) !== undefined ? { costCeiling: resolveCostCeiling(args) } : {}), // global cost ceiling (M8 B3)
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
