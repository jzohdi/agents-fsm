/**
 * Unit tests for the Claude Code subprocess executor (Milestone 3).
 *
 * The process spawn is faked, so these exercise the executor's own logic — argv construction,
 * model mapping, stream-json parsing, usage summation, and error handling — entirely offline,
 * with no CLI and no network. The same contract suite (executor-contract.test.ts) then pins
 * the result *shape* against both the stub and (behind a flag) the real CLI.
 */

import { describe, expect, it } from 'vitest';

import { FatalExecutorError, type AgentActivity, type AgentRunRequest } from './executor';
import {
  defaultSpawnProcess,
  HarnessError,
  parseHarnessOutput,
  SubprocessStageExecutor,
  summarizeEvent,
  takeCompleteLines,
  type ProcessResult,
  type SpawnProcess,
} from './subprocess-executor';

/** A fake spawn that always resolves with the given result and records how it was called. */
function fakeSpawn(result: ProcessResult): { spawnProcess: SpawnProcess; calls: Array<{ command: string; args: string[]; cwd: string }> } {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const spawnProcess: SpawnProcess = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return Promise.resolve(result);
  };
  return { spawnProcess, calls };
}

/** Build a stream-json stdout string ending in a result event. */
function streamJson(result: string, usage: Record<string, number> = { input_tokens: 100, output_tokens: 20 }): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, usage }),
  ].join('\n');
}

function req(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: 1,
    stage: 'plan',
    phase: 'produce',
    model: 'frontier',
    system: 'You are the plan agent.',
    input: { issueRef: 'o/r#1' },
    ...overrides,
  };
}

describe('defaultSpawnProcess — stdin is closed', () => {
  it('does not hang when the child reads stdin (gives it /dev/null)', async () => {
    // `cat` with no args copies stdin to stdout until EOF. With an inherited, never-closed stdin
    // pipe it would hang forever; with stdin set to /dev/null it reads EOF and exits immediately.
    // This is the regression guard for the real-run bug where `claude -p` blocked waiting on stdin.
    const result = await defaultSpawnProcess('cat', [], { cwd: process.cwd(), env: process.env });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  }, 5000);
});

describe('defaultSpawnProcess — per-invocation timeout', () => {
  it('kills a child that exceeds the timeout and marks the result non-zero', async () => {
    // A real subprocess that would run far longer than the cap — proves the kill actually fires.
    const result = await defaultSpawnProcess('sleep', ['30'], { cwd: process.cwd(), env: process.env, timeoutMs: 250 });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('exceeded 250ms timeout');
  }, 5000);
});

describe('SubprocessStageExecutor — argv', () => {
  it('builds the headless stream-json invocation with model and system prompt', () => {
    const exec = new SubprocessStageExecutor();
    const args = exec.buildArgs(req({ model: 'frontier', system: 'SYS', input: 'GO' }));
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('GO');
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose']));
    expect(args[args.indexOf('--model') + 1]).toBe('opus'); // frontier → opus
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('SYS');
  });

  it('JSON-encodes a structured input as the user prompt', () => {
    const exec = new SubprocessStageExecutor();
    const args = exec.buildArgs(req({ input: { a: 1 } }));
    expect(args[args.indexOf('-p') + 1]).toBe('{"a":1}');
  });

  it('passes a comma-separated allow-list only when tools are given', () => {
    const exec = new SubprocessStageExecutor();
    expect(exec.buildArgs(req({ allowedTools: ['Read', 'Grep'] }))).toEqual(
      expect.arrayContaining(['--allowedTools', 'Read,Grep']),
    );
    expect(exec.buildArgs(req({ allowedTools: [] }))).not.toContain('--allowedTools');
    expect(exec.buildArgs(req())).not.toContain('--allowedTools');
  });

  it('maps logical model names, passing unknown names through', () => {
    const exec = new SubprocessStageExecutor();
    expect(exec.resolveModel('frontier')).toBe('opus');
    expect(exec.resolveModel('cheap')).toBe('haiku');
    expect(exec.resolveModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('honors a custom command, model map, and extra args', () => {
    const exec = new SubprocessStageExecutor({
      command: 'my-claude',
      modelMap: { frontier: 'sonnet' },
      extraArgs: ['--dangerously-skip-permissions'],
    });
    const args = exec.buildArgs(req({ model: 'frontier' }));
    expect(exec.resolveModel('frontier')).toBe('sonnet');
    expect(args).toContain('--dangerously-skip-permissions');
  });
});

describe('SubprocessStageExecutor — run', () => {
  it('spawns in the request working dir and parses the structured result + usage', async () => {
    const { spawnProcess, calls } = fakeSpawn({
      code: 0,
      stdout: streamJson(JSON.stringify({ requestedTransition: 'proceed' }), { input_tokens: 100, output_tokens: 23 }),
      stderr: '',
    });
    const exec = new SubprocessStageExecutor({ spawnProcess });

    const result = await exec.run(req({ workingDir: '/work/run-1' }));

    expect(calls[0]!.command).toBe('claude');
    expect(calls[0]!.cwd).toBe('/work/run-1');
    expect(result.output).toEqual({ requestedTransition: 'proceed' });
    expect(result.usage.tokens).toBe(123);
  });

  it('falls back to the default working dir when the request omits one', async () => {
    const { spawnProcess, calls } = fakeSpawn({ code: 0, stdout: streamJson('{}'), stderr: '' });
    const exec = new SubprocessStageExecutor({ spawnProcess, defaultWorkingDir: '/default' });
    await exec.run(req({ workingDir: undefined }));
    expect(calls[0]!.cwd).toBe('/default');
  });

  it('throws HarnessError on a non-zero exit, surfacing stderr', async () => {
    const { spawnProcess } = fakeSpawn({ code: 2, stdout: '', stderr: 'boom: bad model' });
    const exec = new SubprocessStageExecutor({ spawnProcess });
    await expect(exec.run(req())).rejects.toThrowError(/boom: bad model/);
    await expect(exec.run(req())).rejects.toBeInstanceOf(HarnessError);
  });

  it('throws HarnessError when the harness reports an error result', async () => {
    const errorEvent = JSON.stringify({ type: 'result', is_error: true, result: 'rate limited' });
    const { spawnProcess } = fakeSpawn({ code: 0, stdout: errorEvent, stderr: '' });
    const exec = new SubprocessStageExecutor({ spawnProcess });
    await expect(exec.run(req())).rejects.toThrowError(/rate limited/);
  });

  it('propagates a spawn error (e.g. binary not found)', async () => {
    const spawnProcess: SpawnProcess = () => Promise.reject(new Error('ENOENT'));
    const exec = new SubprocessStageExecutor({ spawnProcess });
    await expect(exec.run(req())).rejects.toThrowError(/ENOENT/);
  });

  it('classifies a "Not logged in" result as a fatal auth error carrying a remedy', async () => {
    const authEvent = JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' });
    const { spawnProcess } = fakeSpawn({ code: 0, stdout: authEvent, stderr: '' });
    const exec = new SubprocessStageExecutor({ spawnProcess });

    // Fatal (the loop aborts on this), and it carries operator instructions for the CLI to print.
    await expect(exec.run(req())).rejects.toBeInstanceOf(FatalExecutorError);
    await expect(exec.run(req())).rejects.toMatchObject({ remedy: expect.stringContaining('claude login') });
  });

  it('classifies an auth failure on a non-zero exit too', async () => {
    const { spawnProcess } = fakeSpawn({ code: 1, stdout: '', stderr: 'Invalid API key · Please run /login' });
    const exec = new SubprocessStageExecutor({ spawnProcess });
    await expect(exec.run(req())).rejects.toBeInstanceOf(FatalExecutorError);
  });

  it('surfaces a timeout result as a (non-fatal, per-run) HarnessError', async () => {
    const { spawnProcess } = fakeSpawn({ code: 124, stdout: '', stderr: '[killed: exceeded 1000ms timeout]' });
    const exec = new SubprocessStageExecutor({ spawnProcess });
    // A timeout escalates one run (executor_error), it does NOT abort the whole drain like auth does.
    await expect(exec.run(req())).rejects.toBeInstanceOf(HarnessError);
    await expect(exec.run(req())).rejects.not.toBeInstanceOf(FatalExecutorError);
  });
});

describe('parseHarnessOutput', () => {
  it('keeps the last result event and ignores non-JSON noise', () => {
    const stdout = ['not json', streamJson('{"v":1}'), 'trailing noise'].join('\n');
    expect(parseHarnessOutput(stdout).output).toEqual({ v: 1 });
  });

  it('accepts a single-object json result', () => {
    const stdout = JSON.stringify({ type: 'result', result: '{"ok":true}', usage: { input_tokens: 5 } });
    const parsed = parseHarnessOutput(stdout);
    expect(parsed.output).toEqual({ ok: true });
    expect(parsed.usage.tokens).toBe(5);
  });

  it('strips a markdown json fence around the result', () => {
    const fenced = '```json\n{"requestedTransition":"approve"}\n```';
    const stdout = JSON.stringify({ type: 'result', result: fenced });
    expect(parseHarnessOutput(stdout).output).toEqual({ requestedTransition: 'approve' });
  });

  it('returns the raw string when the result is not JSON (runner will escalate)', () => {
    const stdout = JSON.stringify({ type: 'result', result: 'I could not complete the task.' });
    expect(parseHarnessOutput(stdout).output).toBe('I could not complete the task.');
  });

  it('extracts a JSON envelope wrapped in a prose preamble (the real-run failure mode)', () => {
    // Verbatim shape of what Sonnet emitted: a one-line preamble, then a valid envelope.
    const text =
      'The plan is written to `.agent/plan.md`. This is a pure frontend change — no backend work needed.\n\n' +
      '{"requestedTransition":"proceed","artifacts":[{"kind":"plan","locator":{"path":".agent/plan.md"}}],"flags":{"needs_frontend":true,"needs_backend":false}}';
    const stdout = JSON.stringify({ type: 'result', result: text });
    expect(parseHarnessOutput(stdout).output).toEqual({
      requestedTransition: 'proceed',
      artifacts: [{ kind: 'plan', locator: { path: '.agent/plan.md' } }],
      flags: { needs_frontend: true, needs_backend: false },
    });
  });

  it('extracts a JSON object with a trailing epilogue and ignores braces inside strings', () => {
    const text = '{"requestedTransition":"approve","comments":["rename {x} to y"]}\n\nDone — looks good!';
    const stdout = JSON.stringify({ type: 'result', result: text });
    expect(parseHarnessOutput(stdout).output).toEqual({ requestedTransition: 'approve', comments: ['rename {x} to y'] });
  });

  it('picks the last JSON object when the prose contains an earlier one', () => {
    const text = 'Example shape: {"requestedTransition":"x"}. My actual answer:\n{"requestedTransition":"proceed"}';
    const stdout = JSON.stringify({ type: 'result', result: text });
    expect(parseHarnessOutput(stdout).output).toEqual({ requestedTransition: 'proceed' });
  });

  it('throws when there is no result event', () => {
    const stdout = JSON.stringify({ type: 'assistant', message: {} });
    expect(() => parseHarnessOutput(stdout)).toThrowError(HarnessError);
  });

  it('sums cache token fields alongside input/output', () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: '{}',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
    });
    expect(parseHarnessOutput(stdout).usage.tokens).toBe(20);
  });

  it('ignores non-token numeric usage fields (only known token fields count)', () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: '{}',
      usage: { input_tokens: 10, output_tokens: 5, web_search_requests: 99, duration_ms: 1234 },
    });
    expect(parseHarnessOutput(stdout).usage.tokens).toBe(15);
  });

  it('surfaces the harness dollar cost when reported, and omits it otherwise', () => {
    const withCost = JSON.stringify({ type: 'result', result: '{}', total_cost_usd: 0.0123 });
    expect(parseHarnessOutput(withCost).usage.cost).toBe(0.0123);
    const noCost = JSON.stringify({ type: 'result', result: '{}' });
    expect(parseHarnessOutput(noCost).usage.cost).toBeUndefined();
  });
});

describe('summarizeEvent — live activity', () => {
  it('summarizes a session-init system event', () => {
    expect(summarizeEvent({ type: 'system', subtype: 'init', session_id: 's1' })).toEqual([
      { kind: 'init', summary: 'session init', detail: { type: 'system', subtype: 'init', session_id: 's1' } },
    ]);
  });

  it('summarizes assistant text, snipping to the first line', () => {
    const event = { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the plan\nthen editing' }] } };
    const [activity] = summarizeEvent(event);
    expect(activity).toMatchObject({ kind: 'assistant', summary: 'assistant: Reading the plan' });
  });

  it('describes a tool call by name and its target file', () => {
    const event = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/foo.ts' } }] } };
    expect(summarizeEvent(event)[0]).toMatchObject({ kind: 'tool_use', summary: 'tool: Edit src/foo.ts' });
  });

  it('falls back to other input keys for the tool target (command, pattern)', () => {
    const bash = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } };
    expect(summarizeEvent(bash)[0]!.summary).toBe('tool: Bash npm test');
    const grep = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }] } };
    expect(summarizeEvent(grep)[0]!.summary).toBe('tool: Grep TODO');
  });

  it('emits one activity per content block, in order', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Editing now' }, { type: 'tool_use', name: 'Write', input: { path: 'a.md' } }] },
    };
    expect(summarizeEvent(event).map((a) => a.kind)).toEqual(['assistant', 'tool_use']);
  });

  it('summarizes a thinking block and tool results (incl. errors)', () => {
    const thinking = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'I should check the tests' }] } };
    expect(summarizeEvent(thinking)[0]).toMatchObject({ kind: 'thinking', summary: 'thinking: I should check the tests' });
    const result = { type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } };
    expect(summarizeEvent(result)[0]).toMatchObject({ kind: 'tool_result', summary: 'tool result: error' });
  });

  it('marks the terminal result event', () => {
    expect(summarizeEvent({ type: 'result', is_error: false })).toEqual([{ kind: 'result', summary: 'run complete' }]);
    expect(summarizeEvent({ type: 'result', is_error: true })[0]!.summary).toBe('run errored');
  });

  it('ignores empty assistant text and unknown event shapes', () => {
    expect(summarizeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } })).toEqual([]);
    expect(summarizeEvent({ type: 'mystery' })).toEqual([]);
    expect(summarizeEvent('not an object')).toEqual([]);
  });
});

/** A fake spawn that streams the given stdout line-by-line through `onStdoutLine`, then resolves. */
function streamingSpawn(stdout: string, code = 0): SpawnProcess {
  return (_command, _args, options) => {
    if (options.onStdoutLine) for (const line of stdout.split('\n')) options.onStdoutLine(line);
    return Promise.resolve({ code, stdout, stderr: '' });
  };
}

describe('SubprocessStageExecutor — live activity streaming', () => {
  it('forwards summarized activities to onActivity as lines stream in', async () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] } }),
      JSON.stringify({ type: 'result', is_error: false, result: '{"requestedTransition":"proceed"}', usage: { input_tokens: 1 } }),
    ].join('\n');
    const seen: AgentActivity[] = [];
    const exec = new SubprocessStageExecutor({ spawnProcess: streamingSpawn(stdout) });

    const result = await exec.run(req({ onActivity: (a) => seen.push(a) }));

    expect(seen.map((a) => a.summary)).toEqual(['session init', 'tool: Read README.md', 'run complete']);
    // Streaming does not disturb the buffered final-result parse.
    expect(result.output).toEqual({ requestedTransition: 'proceed' });
  });

  it('does not stream (no onStdoutLine wired) when no onActivity is given', async () => {
    let lineSinkWired = false;
    const spawnProcess: SpawnProcess = (_c, _a, options) => {
      lineSinkWired = options.onStdoutLine !== undefined;
      return Promise.resolve({ code: 0, stdout: streamJson('{}'), stderr: '' });
    };
    await new SubprocessStageExecutor({ spawnProcess }).run(req());
    expect(lineSinkWired).toBe(false);
  });

  it('a throwing onActivity never breaks the run', async () => {
    const exec = new SubprocessStageExecutor({ spawnProcess: streamingSpawn(streamJson('{"requestedTransition":"approve"}')) });
    const result = await exec.run(req({ onActivity: () => { throw new Error('subscriber boom'); } }));
    expect(result.output).toEqual({ requestedTransition: 'approve' });
  });
});

describe('takeCompleteLines — cross-chunk buffering', () => {
  it('returns complete lines and the unterminated remainder', () => {
    expect(takeCompleteLines('a\nb\nc')).toEqual({ lines: ['a', 'b'], rest: 'c' });
    expect(takeCompleteLines('a\nb\n')).toEqual({ lines: ['a', 'b'], rest: '' });
    expect(takeCompleteLines('abc')).toEqual({ lines: [], rest: 'abc' });
    expect(takeCompleteLines('')).toEqual({ lines: [], rest: '' });
  });

  it('reassembles a line split across two chunks when the remainder is fed back', () => {
    // Simulate the data handler: chunk 1 carries a partial line, chunk 2 completes it.
    const first = takeCompleteLines('' + 'par');
    expect(first).toEqual({ lines: [], rest: 'par' });
    const second = takeCompleteLines(first.rest + 'tial\ndone\n');
    expect(second).toEqual({ lines: ['partial', 'done'], rest: '' });
  });
});

describe('defaultSpawnProcess — line streaming', () => {
  it('emits complete stdout lines and flushes a final newline-less fragment', async () => {
    const lines: string[] = [];
    const result = await defaultSpawnProcess(
      'node',
      ['-e', 'process.stdout.write("alpha\\nbeta\\n"); process.stdout.write("gamma")'],
      { cwd: process.cwd(), env: process.env, onStdoutLine: (line) => lines.push(line) },
    );
    expect(result.code).toBe(0);
    expect(lines).toEqual(['alpha', 'beta', 'gamma']);
  }, 5000);
});
