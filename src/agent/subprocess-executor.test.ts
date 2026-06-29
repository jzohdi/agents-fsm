/**
 * Unit tests for the Claude Code subprocess executor (Milestone 3).
 *
 * The process spawn is faked, so these exercise the executor's own logic — argv construction,
 * model mapping, stream-json parsing, usage summation, and error handling — entirely offline,
 * with no CLI and no network. The same contract suite (executor-contract.test.ts) then pins
 * the result *shape* against both the stub and (behind a flag) the real CLI.
 */

import { describe, expect, it } from 'vitest';

import type { AgentRunRequest } from './executor';
import {
  HarnessError,
  parseHarnessOutput,
  SubprocessStageExecutor,
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
