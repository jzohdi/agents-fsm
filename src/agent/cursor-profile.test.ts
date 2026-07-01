/**
 * Cursor harness profile tests.
 *
 * The generic subprocess engine is already contract-tested (executor-contract.test.ts adds a Cursor
 * participant). These pin the Cursor-specific departures from Claude Code: the combined prompt (no
 * `--append-system-prompt`), `--force` with no `--allowedTools`, the model map, and — the important
 * safety property — that a Cursor auth failure is a **recoverable** per-run escalation, NOT a fatal
 * fleet-abort (plan §8.1). All offline: the process spawn is faked.
 */

import { describe, expect, it } from 'vitest';

import { FatalExecutorError, type AgentRunRequest } from './executor';
import { CURSOR_MODEL_MAP, CURSOR_PROFILE, isCursorAuthFailure } from './cursor-profile';
import { HarnessError, SubprocessStageExecutor, type ProcessResult, type SpawnProcess } from './subprocess-executor';

function req(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return { runId: 1, stage: 'plan', phase: 'produce', model: 'frontier', system: 'SYS', input: 'GO', ...overrides };
}

/** A fake spawn that always resolves with `result`. */
function fakeSpawn(result: ProcessResult): SpawnProcess {
  return () => Promise.resolve(result);
}

const cursorExec = (spawnProcess?: SpawnProcess) =>
  new SubprocessStageExecutor({ profile: CURSOR_PROFILE, ...(spawnProcess ? { spawnProcess } : {}) });

describe('CURSOR_PROFILE — argv', () => {
  it('builds a headless stream-json invocation with --force and no --allowedTools', () => {
    const args = cursorExec().buildArgs(req({ allowedTools: ['Read', 'Grep'] }));
    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--force']));
    expect(args).not.toContain('--allowedTools'); // Cursor has no per-tool allow-list
    expect(args).not.toContain('--append-system-prompt'); // …and no system-prompt flag
  });

  it('folds the system prompt into the single prompt string (no --append-system-prompt)', () => {
    const strArgs = cursorExec().buildArgs(req({ system: 'You are plan', input: 'DO IT' }));
    expect(strArgs[strArgs.indexOf('-p') + 1]).toBe('You are plan\n\nDO IT');
    // A structured input is JSON-encoded after the system prompt, same as Claude's user prompt.
    const objArgs = cursorExec().buildArgs(req({ system: 'SYS', input: { a: 1 } }));
    expect(objArgs[objArgs.indexOf('-p') + 1]).toBe('SYS\n\n{"a":1}');
  });

  it('maps logical model names via the Cursor catalog, passing unknown ones through', () => {
    const exec = cursorExec();
    expect(exec.resolveModel('frontier')).toBe(CURSOR_MODEL_MAP.frontier);
    expect(exec.resolveModel('cheap')).toBe(CURSOR_MODEL_MAP.cheap);
    expect(exec.resolveModel('some-exact-cursor-id')).toBe('some-exact-cursor-id');
    // The resolved model is what lands after --model.
    const args = exec.buildArgs(req({ model: 'frontier' }));
    expect(args[args.indexOf('--model') + 1]).toBe(CURSOR_MODEL_MAP.frontier);
  });
});

describe('isCursorAuthFailure', () => {
  it('recognizes Cursor auth wording and nothing unrelated', () => {
    for (const s of ['Not logged in', 'Unauthorized', 'invalid api key', 'set CURSOR_API_KEY', 'please run login']) {
      expect(isCursorAuthFailure(s)).toBe(true);
    }
    for (const s of ['boom: bad model', 'rate limit exceeded', 'ENOENT', 'file not found']) {
      expect(isCursorAuthFailure(s)).toBe(false);
    }
  });
});

describe('CURSOR_PROFILE — auth is a per-run escalation, not a fatal fleet-abort (plan §8.1)', () => {
  it('classifies an auth failure on a non-zero exit as a recoverable HarnessError, not FatalExecutorError', async () => {
    const exec = cursorExec(fakeSpawn({ code: 1, stdout: '', stderr: 'Error: not logged in. Please run cursor-agent login' }));
    await expect(exec.run(req())).rejects.toBeInstanceOf(HarnessError);
    await expect(exec.run(req())).rejects.not.toBeInstanceOf(FatalExecutorError);
    // The remedy travels in the message, so it lands in the run's escalation log.
    await expect(exec.run(req())).rejects.toThrowError(/cursor-agent login/);
  });

  it('classifies an auth failure in an is_error result the same way (recoverable, carries the remedy)', async () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Unauthorized: invalid api key' });
    const exec = cursorExec(fakeSpawn({ code: 0, stdout, stderr: '' }));
    await expect(exec.run(req())).rejects.toBeInstanceOf(HarnessError);
    await expect(exec.run(req())).rejects.not.toBeInstanceOf(FatalExecutorError);
    await expect(exec.run(req())).rejects.toThrowError(/CURSOR_API_KEY/);
  });
});
