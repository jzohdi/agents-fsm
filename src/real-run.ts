/**
 * Real-run assembly (Milestone 4b — plans/milestone-4.md §3.8, §6).
 *
 * Builds the Agent Runner that drives a *live*, token-spending run: the Claude Code subprocess
 * executor, the `gh`/`git`-backed adapter, and the real composed system prompts. Factored out of the
 * CLI so the operator CLI (real by default, unless `--mock`) and the flag-gated end-to-end test share one wiring — and so the
 * §6 cost-control "cheap model first" override is reachable from both and unit-testable.
 *
 * Constructing the executor and adapter is cheap and side-effect-free (neither spawns a process or
 * touches the network until used), so this is safe to call from a test that never runs a stage.
 */

import { createSystemPromptFn } from './agent/prompts';
import { AgentRunner, type AgentRunnerOptions, type PhaseActivity } from './agent/runner';
import { DEFAULT_MODEL_MAP, SubprocessStageExecutor, type SubprocessExecutorOptions } from './agent/subprocess-executor';
import { GitHubCli } from './integration/github-cli';
import type { GitHub } from './integration/github';
import type { RepoResolver } from './integration/github-resolver';
import type { AgentsConfig } from './fsm/config';
import type { AgentPhase, Repository } from './store/repository';

export interface RealRunConfig {
  /** Target repo as `owner/name` (also the `gh` target). Required. */
  repo: string;
  /** Base branch the run's working branch is cut from and diffed against. */
  baseBranch: string;
  /** Root each run's working tree is cloned under (`<workingRoot>/run-<id>`). */
  workingRoot: string;
  /** Force every phase onto the `cheap` logical model — the cost-controlled first run (README §6). */
  cheap?: boolean;
  /**
   * Concrete model the `frontier` logical name resolves to (produce/self-review phases). Overrides
   * the default (`opus`) so an operator can pick e.g. `sonnet` — cheaper than opus, but capable
   * enough to follow the strict JSON contract that the cheap model (haiku) does not. Ignored under
   * `cheap` (which forces every phase to the cheap model).
   */
  frontierModel?: string;
  /** GitHub remote to fetch/push/PR against, e.g. an SSH remote. Defaults to the repo's HTTPS URL. */
  cloneUrl?: string;
  /** A local checkout to clone the working tree from (fast/offline); origin is still the GitHub remote. */
  localRepo?: string;
  /**
   * Permission mode for the headless harness (`acceptEdits` / `bypassPermissions` / …). Producing
   * stages must edit files and run tests unattended; pass this so the harness does not stall on a
   * permission prompt it can't answer in `-p` mode (plans/milestone-4.md §6 harness permissions).
   */
  permissionMode?: string;
  /** Per-invocation wall-clock cap in ms; a single stage is killed + escalated when exceeded. */
  timeoutMs?: number;
  /** How many times to retry a rate-limited/overloaded invocation before escalating (Milestone 8 B3). */
  maxRetries?: number;
}

/** The `cheap` logical model the cost-control override pins every phase to (the executor maps it to a concrete model). */
const CHEAP_MODEL = 'cheap';

/**
 * Pin every stage's phases to the cheap model. README §6: the first real run should use the cheap
 * model for all phases to shake out plumbing before switching to the real per-phase defaults. Other
 * per-stage config (phases, io, allowedTools) is preserved — only the models are overridden.
 */
export function forceCheapModels(agents: AgentsConfig): AgentsConfig {
  const out: AgentsConfig = {};
  for (const [stage, cfg] of Object.entries(agents)) {
    const models: Partial<Record<AgentPhase, string>> = { produce: CHEAP_MODEL, self_review: CHEAP_MODEL, simplify: CHEAP_MODEL };
    out[stage] = { ...cfg, models };
  }
  return out;
}

/** Build the `gh`/`git`-backed adapter for a real run. Exposed so the CLI can share one instance
 * between the runner and the Reply Poller. Throws if no repo is given. */
export function buildRealGitHub(config: RealRunConfig): GitHubCli {
  if (!config.repo) throw new Error('a real run needs a repo (owner/name); pass --repo or a start issueRef');
  return new GitHubCli({
    repo: config.repo,
    workingRoot: config.workingRoot,
    ...(config.cloneUrl ? { cloneUrl: config.cloneUrl } : {}),
    ...(config.localRepo ? { localRepo: config.localRepo } : {}),
  });
}

export interface BuildRealRunnerOptions {
  /** Receives the harness's live progress (the "what is the agent doing now" feed); also persisted. */
  onActivity?: (activity: PhaseActivity) => void;
  /**
   * A pre-built GitHub adapter, or a multi-repo {@link RepoResolver}, for the runner to use (e.g. shared
   * with the Reply Poller). A single adapter built from `config` is used if omitted (single-repo).
   */
  github?: GitHub | RepoResolver;
}

/**
 * Build the Agent Runner for a real, token-spending run. Throws if no repo is given (unless a
 * `github` adapter is injected). Pass `onActivity` to receive the harness's live progress.
 */
export function buildRealRunner(
  repo: Repository,
  agents: AgentsConfig,
  config: RealRunConfig,
  options: BuildRealRunnerOptions = {},
): AgentRunner {
  const executorOpts: SubprocessExecutorOptions = {
    extraArgs: config.permissionMode ? ['--permission-mode', config.permissionMode] : [],
  };
  if (config.frontierModel) executorOpts.modelMap = { ...DEFAULT_MODEL_MAP, frontier: config.frontierModel };
  if (config.timeoutMs !== undefined) executorOpts.timeoutMs = config.timeoutMs;
  if (config.maxRetries !== undefined) executorOpts.maxRetries = config.maxRetries;
  const executor = new SubprocessStageExecutor(executorOpts);
  const github = options.github ?? buildRealGitHub(config);
  const recipe = config.cheap ? forceCheapModels(agents) : agents;
  const runnerOptions: AgentRunnerOptions = { systemPrompt: createSystemPromptFn(), baseBranch: config.baseBranch };
  if (options.onActivity) runnerOptions.onActivity = options.onActivity;
  return new AgentRunner(repo, executor, recipe, github, runnerOptions);
}
