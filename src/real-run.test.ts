/**
 * Real-run assembly tests (Milestone 4b — plans/milestone-4.md §6).
 *
 * Covers the logic in the real-run wiring that is worth pinning without spending tokens: the §6
 * cost-control cheap-model override (and that it preserves the rest of each stage's recipe), and the
 * empty-repo guard. Building the runner against the real default config also smoke-tests that the
 * executor/adapter/prompt construction does not throw.
 */

import { describe, expect, it } from 'vitest';

import type { AgentRunRequest } from './agent/executor';
import { HARNESS_IDS } from './agent/harness';
import { SubprocessStageExecutor } from './agent/subprocess-executor';
import { AgentRunner } from './agent/runner';
import { loadDefaultConfig } from './fsm/config';
import { buildHarnessRegistry, buildRealRunner, forceCheapModels } from './real-run';
import { openDb } from './store/db';
import { Repository } from './store/repository';

const { agents } = loadDefaultConfig();

/** A minimal phase request for exercising an executor's pure `buildArgs`/`resolveModel`. */
function req(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return { runId: 1, stage: 'plan', phase: 'produce', model: 'frontier', system: 'SYS', input: { a: 1 }, ...overrides };
}

describe('forceCheapModels', () => {
  it('pins every stage and phase to the cheap model', () => {
    const cheap = forceCheapModels(agents);
    for (const cfg of Object.values(cheap)) {
      expect(cfg.models).toEqual({ produce: 'cheap', self_review: 'cheap', simplify: 'cheap' });
    }
  });

  it('preserves the rest of each stage recipe (io, allowedTools, phases)', () => {
    const cheap = forceCheapModels(agents);
    // tdd's I/O (opensPr) and tool grant must survive the model override.
    expect(cheap.tdd!.io).toEqual(agents.tdd!.io);
    expect(cheap.tdd!.allowedTools).toEqual(agents.tdd!.allowedTools);
    // Review stages keep their produce-only recipe.
    expect(cheap.code_review!.phases).toEqual(agents.code_review!.phases);
  });

  it('does not mutate the input config', () => {
    const before = JSON.stringify(agents);
    forceCheapModels(agents);
    expect(JSON.stringify(agents)).toBe(before);
  });
});

describe('buildHarnessRegistry', () => {
  const base = { repo: 'o/r', baseBranch: 'main', workingRoot: '/tmp/work' };

  it('registers exactly the known harness ids (drift guard against a new id with no executor)', () => {
    // A run's `harness` is validated against HARNESS_IDS (isHarnessId), then resolved here. If the two
    // drift, an admitted run would escalate to needs_human for want of an executor — assert they match.
    expect(new Set(buildHarnessRegistry(base).available())).toEqual(new Set<string>(HARNESS_IDS));
  });

  it('gives Cursor its own profile and withholds Claude-shaped flags (--permission-mode)', () => {
    const registry = buildHarnessRegistry({ ...base, permissionMode: 'acceptEdits', frontierModel: 'sonnet' });

    const claude = registry.for('claude-code') as SubprocessStageExecutor;
    const cursor = registry.for('cursor') as SubprocessStageExecutor;

    // The Claude executor carries the Claude-shaped daemon flags…
    const claudeArgs = claude.buildArgs(req());
    expect(claudeArgs).toContain('--permission-mode');
    expect(claudeArgs).toContain('acceptEdits');
    expect(claudeArgs).toContain('--append-system-prompt'); // Claude profile shape

    // …while the Cursor executor gets neither the flag nor Claude's argv shape.
    const cursorArgs = cursor.buildArgs(req());
    expect(cursorArgs).not.toContain('--permission-mode');
    expect(cursorArgs).not.toContain('--append-system-prompt');
    expect(cursorArgs).not.toContain('--allowedTools');
    expect(cursorArgs).toContain('--force'); // Cursor profile shape
  });

  it('resolves the logical frontier model per harness — Claude honors frontierModel, Cursor its own map', () => {
    const registry = buildHarnessRegistry({ ...base, frontierModel: 'sonnet' });
    const claude = registry.for('claude-code') as SubprocessStageExecutor;
    const cursor = registry.for('cursor') as SubprocessStageExecutor;

    expect(claude.resolveModel('frontier')).toBe('sonnet'); // the daemon override
    expect(cursor.resolveModel('frontier')).toBe('sonnet-4.5'); // CURSOR_MODEL_MAP, not the Claude override
  });
});

describe('buildRealRunner', () => {
  function repo() {
    return new Repository(openDb(':memory:'));
  }

  it('builds an Agent Runner from the real config without spawning anything', () => {
    const runner = buildRealRunner(repo(), agents, { repo: 'o/r', baseBranch: 'main', workingRoot: '/tmp/work' });
    expect(runner).toBeInstanceOf(AgentRunner);
  });

  it('accepts the optional source/auth/model overrides (local repo, clone url, model)', () => {
    const runner = buildRealRunner(repo(), agents, {
      repo: 'o/r',
      baseBranch: 'main',
      workingRoot: '/tmp/work',
      localRepo: '/home/me/o-r',
      cloneUrl: 'git@github.com:o/r.git',
      frontierModel: 'sonnet',
      permissionMode: 'acceptEdits',
    });
    expect(runner).toBeInstanceOf(AgentRunner);
  });

  it('throws a clear error when no repo is given (e.g. real resume without --repo)', () => {
    expect(() => buildRealRunner(repo(), agents, { repo: '', baseBranch: 'main', workingRoot: '/tmp/work' })).toThrowError(
      /needs a repo/,
    );
  });
});
