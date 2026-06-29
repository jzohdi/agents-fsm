/**
 * Real-run assembly tests (Milestone 4b — plans/milestone-4.md §6).
 *
 * Covers the logic in the real-run wiring that is worth pinning without spending tokens: the §6
 * cost-control cheap-model override (and that it preserves the rest of each stage's recipe), and the
 * empty-repo guard. Building the runner against the real default config also smoke-tests that the
 * executor/adapter/prompt construction does not throw.
 */

import { describe, expect, it } from 'vitest';

import { AgentRunner } from './agent/runner';
import { loadDefaultConfig } from './fsm/config';
import { buildRealRunner, forceCheapModels } from './real-run';
import { openDb } from './store/db';
import { Repository } from './store/repository';

const { agents } = loadDefaultConfig();

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

describe('buildRealRunner', () => {
  function repo() {
    return new Repository(openDb(':memory:'));
  }

  it('builds an Agent Runner from the real config without spawning anything', () => {
    const runner = buildRealRunner(repo(), agents, { repo: 'o/r', baseBranch: 'main', workingRoot: '/tmp/work' });
    expect(runner).toBeInstanceOf(AgentRunner);
  });

  it('throws a clear error when no repo is given (e.g. real resume without --repo)', () => {
    expect(() => buildRealRunner(repo(), agents, { repo: '', baseBranch: 'main', workingRoot: '/tmp/work' })).toThrowError(
      /needs a repo/,
    );
  });
});
