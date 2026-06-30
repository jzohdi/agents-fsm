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
): { runner: AgentRunner; github: GitHub } {
  if (args.mock) {
    const github = new FakeGitHub({ autoSeedIssues: true });
    const runner = new AgentRunner(repo, new StubExecutor(goldenPathHandler), agents, github, {
      ...(options.onActivity ? { onActivity: options.onActivity } : {}),
    });
    return { runner, github };
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
  const github = buildRealGitHub(config);
  const runner = buildRealRunner(repo, agents, config, {
    github,
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
  });
  return { runner, github };
}

/** Load the FSM config the daemon/CLI runs under: `--config <path>` when given, else the bundled default. */
export function loadRunConfig(args: CliArgs): { loaded: LoadedConfig; configPath?: string } {
  if (args.config) return { loaded: loadConfig(args.config), configPath: args.config };
  return { loaded: loadDefaultConfig() }; // no path → `updateConfig` is read-only (never overwrites the bundled default)
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
  broadcaster: Broadcaster;
} {
  const { loaded, configPath } = loadRunConfig(args);
  const repo = new Repository(openDb(args.db));
  const broadcaster = new Broadcaster();
  const repoRef = args.repo ?? args.positionals[1]?.split('#')[0] ?? '';
  const { runner, github } = buildRunner(args, repo, loaded.agents, repoRef, {
    onActivity: (activity) => broadcaster.publish({ type: 'activity', activity }),
  });
  const orchestrator = new Orchestrator({
    repo,
    runner,
    config: loaded,
    broadcaster,
    github, // powers the new-run autocomplete (GET /suggestions)
    ...(configPath ? { configPath } : {}),
    // A FatalExecutorError (e.g. the harness is unauthenticated) fails every run; surface its remedy
    // prominently rather than a bare stack trace, the way the one-shot CLI does on shutdown.
    onError: (err) => {
      if (err instanceof FatalExecutorError) console.error(`\n✖ ${err.message}\n\n${err.remedy}\n`);
      else console.error(`[daemon] drain error: ${String(err)}`);
    },
  });
  return { orchestrator, repo, github, broadcaster };
}
