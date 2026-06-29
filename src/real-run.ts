/**
 * Real-run assembly (Milestone 4b — plans/milestone-4.md §3.8, §6).
 *
 * Builds the Agent Runner that drives a *live*, token-spending run: the Claude Code subprocess
 * executor, the `gh`/`git`-backed adapter, and the real composed system prompts. Factored out of the
 * CLI so the operator CLI (`--real`) and the flag-gated end-to-end test share one wiring — and so the
 * §6 cost-control "cheap model first" override is reachable from both and unit-testable.
 *
 * Constructing the executor and adapter is cheap and side-effect-free (neither spawns a process or
 * touches the network until used), so this is safe to call from a test that never runs a stage.
 */

import { createSystemPromptFn } from './agent/prompts';
import { AgentRunner, type AgentRunnerOptions } from './agent/runner';
import { SubprocessStageExecutor } from './agent/subprocess-executor';
import { GitHubCli } from './integration/github-cli';
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

/** Build the Agent Runner for a real, token-spending run. Throws if no repo is given. */
export function buildRealRunner(repo: Repository, agents: AgentsConfig, config: RealRunConfig): AgentRunner {
  if (!config.repo) throw new Error('a real run needs a repo (owner/name); pass --repo or a start issueRef');
  const executor = new SubprocessStageExecutor();
  const github = new GitHubCli({ repo: config.repo, workingRoot: config.workingRoot });
  const recipe = config.cheap ? forceCheapModels(agents) : agents;
  const options: AgentRunnerOptions = { systemPrompt: createSystemPromptFn(), baseBranch: config.baseBranch };
  return new AgentRunner(repo, executor, recipe, github, options);
}
