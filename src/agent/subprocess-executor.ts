/**
 * Claude Code subprocess Stage Executor (Layer 5 — README §3.3, Milestone 3).
 *
 * The first *real* {@link StageExecutor}: it wraps the headless Claude Code CLI as the
 * per-stage harness. It spawns `claude -p` in the run's working tree with the stage's system
 * prompt, the concrete model, and the per-stage tool allow-list, then reads back the harness's
 * structured final output and token usage. It slots in behind the existing `StageExecutor`
 * interface — the in-memory stub is unchanged — and it builds **no** tool-use loop of its own,
 * because the harness owns that (README §3.3 Layer 5).
 *
 * We never call the model API directly: the Anthropic API key is just an env var the harness
 * consumes (README Milestone 3). Token accounting is read from whatever the harness reports.
 *
 * Testability: the actual process spawn is injected ({@link SpawnProcess}), so the argv,
 * model mapping, output parsing, and error handling are all exercised offline with a fake
 * harness. The same contract suite then runs against the real CLI behind a flag, so the stub
 * cannot silently drift from harness behavior (README Milestone 3 tests).
 */

import { spawn } from 'node:child_process';

import type { AgentRunRequest, AgentRunResult, StageExecutor } from './executor';

/** The result of running a subprocess to completion. */
export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable process runner: run `command args` in `cwd`, resolve with its captured output. */
export type SpawnProcess = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<ProcessResult>;

export interface SubprocessExecutorOptions {
  /** The CLI binary to invoke. Defaults to `claude`. */
  command?: string;
  /** Logical → concrete model map (README §3.3: logical names like `frontier`/`cheap`). */
  modelMap?: Record<string, string>;
  /**
   * Extra args appended to every invocation — the escape hatch for deployment-specific flags
   * (e.g. `--permission-mode acceptEdits` or `--dangerously-skip-permissions` when a stage's
   * `--allowedTools` grant is not enough on its own). Listed tools are already pre-approved in
   * `-p` mode, so this is only needed for broader policies.
   */
  extraArgs?: string[];
  /** Working directory used when a request omits `workingDir`. Defaults to `process.cwd()`. */
  defaultWorkingDir?: string;
  /** Injectable spawn (for tests). Defaults to a real `child_process.spawn` wrapper. */
  spawnProcess?: SpawnProcess;
}

/** Default logical→concrete model mapping. Claude Code accepts these aliases for `--model`. */
export const DEFAULT_MODEL_MAP: Record<string, string> = {
  frontier: 'opus',
  cheap: 'haiku',
};

/** Raised when the harness fails or returns output we cannot turn into a structured result. */
export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

export class SubprocessStageExecutor implements StageExecutor {
  private readonly command: string;
  private readonly modelMap: Record<string, string>;
  private readonly extraArgs: string[];
  private readonly defaultWorkingDir: string;
  private readonly spawnProcess: SpawnProcess;

  constructor(options: SubprocessExecutorOptions = {}) {
    this.command = options.command ?? 'claude';
    this.modelMap = options.modelMap ?? DEFAULT_MODEL_MAP;
    this.extraArgs = options.extraArgs ?? [];
    this.defaultWorkingDir = options.defaultWorkingDir ?? process.cwd();
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  }

  /** Map a logical model name to a concrete one; unknown names pass through verbatim. */
  resolveModel(logical: string): string {
    return this.modelMap[logical] ?? logical;
  }

  /** Build the argv for one phase invocation (kept pure so it is directly testable). */
  buildArgs(req: AgentRunRequest): string[] {
    const args = [
      '-p',
      userPrompt(req.input),
      '--output-format',
      'stream-json',
      '--verbose', // required by Claude Code to stream JSON in `-p` mode
      '--model',
      this.resolveModel(req.model),
      '--append-system-prompt',
      req.system,
    ];
    if (req.allowedTools && req.allowedTools.length > 0) {
      // Claude Code reads `--allowedTools` as a comma-separated list.
      args.push('--allowedTools', req.allowedTools.join(','));
    }
    args.push(...this.extraArgs);
    return args;
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const cwd = req.workingDir ?? this.defaultWorkingDir;
    const result = await this.spawnProcess(this.command, this.buildArgs(req), { cwd, env: process.env });

    if (result.code !== 0) {
      throw new HarnessError(
        `claude exited with code ${result.code}: ${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
      );
    }
    return parseHarnessOutput(result.stdout);
  }
}

/** The user-message text for one invocation: the structured input, JSON-encoded. */
function userPrompt(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}

// --- output parsing (pure, exported for direct tests) -----------------------

/** The shape of the Claude Code `result` event we read (extra fields ignored). */
interface ResultEvent {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  usage?: Record<string, unknown>;
  total_cost_usd?: number;
}

/**
 * Parse the harness's stream-json stdout into our structured result. We scan the
 * newline-delimited events for the terminal `type: "result"` event, parse its `result`
 * text as the agent's structured output (the Agent Runner validates it against the
 * envelope schema), and sum its token usage. This also accepts single-object `json`
 * output, since that one object is itself the final result event.
 */
export function parseHarnessOutput(stdout: string): AgentRunResult {
  const event = findResultEvent(stdout);
  if (!event) throw new HarnessError('harness produced no result event');
  if (event.is_error) throw new HarnessError(`harness reported an error result: ${event.result ?? '(no detail)'}`);

  const usage: AgentRunResult['usage'] = { tokens: sumTokens(event.usage) };
  if (typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd)) {
    usage.cost = event.total_cost_usd;
  }
  return { output: parseResultText(event.result ?? ''), usage };
}

function findResultEvent(stdout: string): ResultEvent | undefined {
  let found: ResultEvent | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // ignore non-JSON noise lines
    }
    if (isResultEvent(parsed)) found = parsed; // keep the last result event
  }
  return found;
}

function isResultEvent(value: unknown): value is ResultEvent {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'result';
}

/**
 * Parse the agent's final text into structured JSON. Agents sometimes wrap JSON in a
 * markdown fence; we strip a single fence before parsing. If it still is not JSON we return
 * the raw string, leaving the Agent Runner to escalate on malformed output (never coerce).
 */
function parseResultText(text: string): unknown {
  const candidate = stripFence(text.trim());
  try {
    return JSON.parse(candidate);
  } catch {
    return text;
  }
}

function stripFence(text: string): string {
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/;
  const match = fence.exec(text);
  return match ? match[1]!.trim() : text;
}

/** The Anthropic token-count fields on a usage object — summed for "tokens used". */
const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;

/**
 * Sum the known token fields the harness reports. We name them explicitly rather than summing
 * every numeric field, so a future non-token numeric field (e.g. a tool-call count) can never
 * silently inflate the count, and the budget guard stays predictable.
 */
function sumTokens(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  let total = 0;
  for (const field of TOKEN_FIELDS) {
    const value = usage[field];
    if (typeof value === 'number' && Number.isFinite(value)) total += value;
  }
  return total;
}

/** Default {@link SpawnProcess}: a thin promise wrapper over `child_process.spawn`. */
function defaultSpawnProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject); // e.g. the binary is not on PATH
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
