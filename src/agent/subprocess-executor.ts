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

import { FatalExecutorError, type AgentActivity, type AgentRunRequest, type AgentRunResult, type StageExecutor } from './executor';

/** The result of running a subprocess to completion. */
export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Options for one {@link SpawnProcess} invocation. */
export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * Optional sink called once per complete stdout line *as it arrives* (newline-delimited, the
   * separator the harness's stream-json uses). It runs alongside — not instead of — full-output
   * buffering, so the terminal result is still parsed from the complete `stdout`. This is what lets
   * the executor surface live progress without giving up the buffered final-result parse.
   */
  onStdoutLine?: (line: string) => void;
}

/** Injectable process runner: run `command args` in `cwd`, resolve with its captured output. */
export type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => Promise<ProcessResult>;

/**
 * Default per-invocation wall-clock cap (20 min). A single stage's harness invocation can otherwise
 * run unbounded — a real run saw a `tdd` invocation iterate on a slow browser test suite for 23
 * minutes with no ceiling. On timeout the child is killed and the phase escalates (recoverable);
 * a repo with a genuinely slow suite raises this via `--timeout`.
 */
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

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
  /** Per-invocation wall-clock cap in ms; the child is killed when exceeded. Default {@link DEFAULT_TIMEOUT_MS}. 0 disables. */
  timeoutMs?: number;
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

/** Operator instructions printed when the spawned `claude` CLI is not authenticated. */
export const CLAUDE_AUTH_REMEDY = [
  'The `claude` CLI the orchestrator spawns is not authenticated (a desktop-app session does not',
  'carry over to a spawned `claude -p` subprocess). Authenticate the standalone CLI, then re-run:',
  '',
  '  Fix:   claude login            (persists a login to disk; uses your subscription)',
  '         — or —  export ANTHROPIC_API_KEY=sk-ant-...',
  '  Test:  claude -p \'reply with {"ok":true}\' --model haiku < /dev/null',
  '         → it should print a real result, not "Not logged in".',
].join('\n');

/**
 * The harness is not authenticated — fatal (every stage would hit it). {@link FatalExecutorError}
 * so the loop aborts rather than escalating one run; the CLI prints {@link CLAUDE_AUTH_REMEDY}.
 */
export class HarnessAuthError extends FatalExecutorError {
  constructor(detail: string) {
    super(`Claude Code is not authenticated: ${detail}`, CLAUDE_AUTH_REMEDY);
    this.name = 'HarnessAuthError';
  }
}

/** Recognize the harness's "not authenticated" signatures (login required or bad API key). */
function isAuthFailure(text: string): boolean {
  return /not logged in|please run \/login|authentication_failed|not authenticated|invalid api key|invalid x-api-key/i.test(text);
}

export class SubprocessStageExecutor implements StageExecutor {
  private readonly command: string;
  private readonly modelMap: Record<string, string>;
  private readonly extraArgs: string[];
  private readonly defaultWorkingDir: string;
  private readonly timeoutMs: number;
  private readonly spawnProcess: SpawnProcess;

  constructor(options: SubprocessExecutorOptions = {}) {
    this.command = options.command ?? 'claude';
    this.modelMap = options.modelMap ?? DEFAULT_MODEL_MAP;
    this.extraArgs = options.extraArgs ?? [];
    this.defaultWorkingDir = options.defaultWorkingDir ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    const options: SpawnOptions = { cwd, env: process.env, timeoutMs: this.timeoutMs };
    // Only stream when someone is listening: parse each stream-json line and forward the activities
    // it summarizes to. Streaming is pure observability — a throwing sink must never affect the run.
    if (req.onActivity) options.onStdoutLine = (line) => emitActivities(line, req.onActivity!);
    const result = await this.spawnProcess(this.command, this.buildArgs(req), options);

    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || '(no output)';
      if (isAuthFailure(detail)) throw new HarnessAuthError(detail);
      throw new HarnessError(`claude exited with code ${result.code}: ${detail}`);
    }
    return parseHarnessOutput(result.stdout);
  }
}

/** The user-message text for one invocation: the structured input, JSON-encoded. */
function userPrompt(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}

// --- live activity (pure, exported for direct tests) ------------------------

/** Parse one stream-json line and forward every {@link AgentActivity} it yields, swallowing both
 * JSON-parse noise and a throwing sink — live progress must never break the run. */
function emitActivities(line: string, onActivity: (a: AgentActivity) => void): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return; // non-JSON noise line; ignore (same tolerance as the result parser)
  }
  for (const activity of summarizeEvent(parsed)) {
    try {
      onActivity(activity);
    } catch {
      // A throwing subscriber must never wedge the harness stream; observability is best-effort.
    }
  }
}

/** Longest activity summary we surface; harness text is snipped to keep a log line readable. */
const SUMMARY_MAX = 140;

/**
 * Turn one parsed stream-json event into zero or more human-readable activities. Pure and exported
 * so the (many) harness event shapes are unit-tested directly. An `assistant` turn can carry several
 * content blocks (text + tool calls), so this returns a list, one activity per block. Unknown event
 * types yield nothing rather than noise.
 */
export function summarizeEvent(parsed: unknown): AgentActivity[] {
  if (!isObject(parsed)) return [];
  switch (parsed.type) {
    case 'system':
      return [{ kind: 'init', summary: `session ${asString(parsed.subtype) ?? 'started'}`, detail: parsed }];
    case 'assistant':
    case 'user':
      return summarizeMessage(parsed);
    case 'result':
      return [{ kind: 'result', summary: parsed.is_error === true ? 'run errored' : 'run complete' }];
    default:
      return [];
  }
}

/** Summarize the content blocks of an `assistant`/`user` message event. */
function summarizeMessage(event: Record<string, unknown>): AgentActivity[] {
  const message = event.message;
  const content = isObject(message) ? message.content : undefined;
  if (!Array.isArray(content)) return [];

  const out: AgentActivity[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    switch (block.type) {
      case 'text': {
        const text = asString(block.text);
        if (text && text.trim()) out.push({ kind: 'assistant', summary: `assistant: ${snip(text)}`, detail: block });
        break;
      }
      case 'thinking': {
        const thinking = asString(block.thinking);
        out.push({ kind: 'thinking', summary: thinking ? `thinking: ${snip(thinking)}` : 'thinking…', detail: block });
        break;
      }
      case 'tool_use': {
        const name = asString(block.name) ?? 'tool';
        const target = toolTarget(block.input);
        out.push({ kind: 'tool_use', summary: `tool: ${name}${target ? ` ${target}` : ''}`, detail: block });
        break;
      }
      case 'tool_result': {
        out.push({ kind: 'tool_result', summary: block.is_error === true ? 'tool result: error' : 'tool result', detail: block });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Pull a short, recognizable target from a tool's input (the file, command, or pattern it acts on). */
function toolTarget(input: unknown): string | undefined {
  if (!isObject(input)) return undefined;
  const candidate = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.notebook_path;
  const text = asString(candidate);
  return text ? snip(text.split('\n')[0]!) : undefined;
}

/** First line of `text`, collapsed and truncated to {@link SUMMARY_MAX} for a tidy one-line summary. */
function snip(text: string): string {
  const firstLine = text.trim().split('\n')[0]!.trim();
  return firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX - 1)}…` : firstLine;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
  if (event.is_error) {
    const detail = event.result ?? '(no detail)';
    if (isAuthFailure(detail)) throw new HarnessAuthError(detail);
    throw new HarnessError(`harness reported an error result: ${detail}`);
  }

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
 * Parse the agent's final text into structured JSON, tolerating the common LLM habit of wrapping
 * the JSON in a prose preamble/epilogue or a markdown fence even when told to emit JSON only.
 *
 * Order: (1) the whole text (the ideal the contract asks for, optionally fenced); (2) the last
 * balanced top-level `{…}` object embedded in the text — models routinely write a sentence before
 * the envelope. If nothing parses we return the raw string so the Agent Runner escalates malformed.
 *
 * This is recovery, not coercion: we only ever return JSON the model actually wrote, and the strict
 * envelope/verdict schema downstream still rejects anything that isn't a valid result.
 */
function parseResultText(text: string): unknown {
  const direct = tryParse(stripFence(text.trim()));
  if (direct !== undefined) return direct;

  // Try embedded objects, last first (the envelope is the agent's "final answer", usually last).
  const objects = balancedObjects(text);
  for (let i = objects.length - 1; i >= 0; i--) {
    const parsed = tryParse(objects[i]!);
    if (parsed !== undefined) return parsed;
  }
  return text;
}

function tryParse(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined; // no JSON value parses to undefined, so it is a safe "did not parse" sentinel
  }
}

function stripFence(text: string): string {
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/;
  const match = fence.exec(text);
  return match ? match[1]!.trim() : text;
}

/**
 * Every balanced top-level `{…}` substring in `text`, in order. String contents (and escapes) are
 * skipped so braces inside JSON strings never throw off the depth count. Used to pull an envelope
 * out of surrounding prose; nested objects stay part of their enclosing top-level object.
 */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
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

/**
 * Default {@link SpawnProcess}: a thin promise wrapper over `child_process.spawn`.
 *
 * stdin is `'ignore'` (`/dev/null`): we hand the harness its prompt as an argv argument, so it has
 * no stdin to read. Without this, `claude -p` blocks waiting on stdin, warns "no stdin data received
 * in 3s", and exits non-zero — the empty pipe is never closed. Giving it `/dev/null` is exactly what
 * that warning recommends.
 *
 * `timeoutMs` bounds a single invocation: on expiry the child is killed (SIGTERM, then SIGKILL) and
 * the result is marked non-zero with a timeout note, so the executor turns it into an escalation
 * rather than letting one stage run forever.
 */
export function defaultSpawnProcess(command: string, args: string[], options: SpawnOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    // Carry any partial trailing line across chunks so the live sink only ever sees whole lines.
    let lineBuf = '';
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref(); // force-kill if it ignores SIGTERM
      }, options.timeoutMs);
    }
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!options.onStdoutLine) return;
      const { lines, rest } = takeCompleteLines(lineBuf + text);
      lineBuf = rest;
      for (const line of lines) options.onStdoutLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err); // e.g. the binary is not on PATH
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (options.onStdoutLine && lineBuf.length > 0) options.onStdoutLine(lineBuf); // flush a final newline-less line
      if (timedOut) {
        resolve({ code: code ?? 124, stdout, stderr: `${stderr}\n[killed: exceeded ${options.timeoutMs}ms timeout]` });
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

/**
 * Split `buffer` into its complete (newline-terminated) lines plus the trailing remainder that has
 * not been terminated yet. Pure and exported so the cross-chunk buffering the live stream depends on
 * is tested directly, without timing a real subprocess. The remainder is fed back in with the next
 * chunk; the caller flushes it as a final line on close.
 */
export function takeCompleteLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? ''; // the last element is the unterminated remainder ('' if buffer ended in \n)
  return { lines: parts, rest };
}
