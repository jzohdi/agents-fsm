import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { compareRuns, detectCycles, isSatisfied, type SchedulerRun, type SchedulingKey } from './scheduler';

/** Shorthand: run id 10×issue so tests read as issue graphs but assert on run ids. */
function run(issueNumber: number, dependsOn: number[] = []): SchedulerRun {
  return { runId: issueNumber * 10, issueNumber, dependsOn };
}

function key(priority: number, orderKey = '', issueNumber = 1): SchedulingKey {
  return { priority, orderKey, issueNumber };
}

describe('isSatisfied — every dependency closed', () => {
  const closed = new Set([42, 57]);
  const cases: Array<[string, number[], boolean]> = [
    ['no deps is trivially satisfied', [], true],
    ['all closed', [42, 57], true],
    ['one open', [42, 99], false],
    ['all open', [1, 2], false],
  ];

  it.each(cases)('%s', (_name, deps, expected) => {
    expect(isSatisfied(deps, closed)).toBe(expected);
  });
});

describe('detectCycles — table-driven graphs (README M9: linear chains, diamonds, cycles)', () => {
  const cases: Array<[string, SchedulerRun[], number[][]]> = [
    ['empty set', [], []],
    ['independent runs', [run(1), run(2)], []],
    ['linear chain 1←2←3', [run(1), run(2, [1]), run(3, [2])], []],
    ['diamond 4←{2,3}←1 (shared dep, no cycle)', [run(1), run(2, [1]), run(3, [1]), run(4, [2, 3])], []],
    ['dep on an issue with no active run is a leaf', [run(1, [99]), run(2, [1])], []],
    ['self-dependency is a one-run cycle', [run(1, [1]), run(2)], [[10]]],
    ['two-node cycle', [run(1, [2]), run(2, [1])], [[10, 20]]],
    ['three-node cycle', [run(1, [3]), run(2, [1]), run(3, [2])], [[10, 20, 30]]],
    ['two disjoint cycles, ordered by smallest member', [run(4, [5]), run(5, [4]), run(1, [2]), run(2, [1])], [[10, 20], [40, 50]]],
    ['cycle plus an innocent dependent hanging off it', [run(1, [2]), run(2, [1]), run(3, [1])], [[10, 20]]],
    ['cycle unaffected by extra leaf deps on its members', [run(1, [2, 99]), run(2, [1])], [[10, 20]]],
  ];

  it.each(cases)('%s', (_name, runs, expected) => {
    expect(detectCycles(runs)).toEqual(expected);
  });

  it('is order-insensitive: any permutation of the run list yields the same cycles', () => {
    const runs = [run(1, [2]), run(2, [3]), run(3, [1]), run(4, [1]), run(5)];
    fc.assert(
      fc.property(fc.shuffledSubarray(runs, { minLength: runs.length, maxLength: runs.length }), (shuffled) => {
        expect(detectCycles(shuffled)).toEqual([[10, 20, 30]]);
      }),
    );
  });
});

describe('compareRuns — the total dispatch order (priority desc → order_key asc → issue asc)', () => {
  it('priority beats order_key beats issue number', () => {
    expect(compareRuns(key(5, 'zzz', 99), key(1, 'aaa', 1))).toBeLessThan(0); // higher priority first
    expect(compareRuns(key(1, 'aaa', 99), key(1, 'bbb', 1))).toBeLessThan(0); // then lexicographic key
    expect(compareRuns(key(1, 'aaa', 1), key(1, 'aaa', 2))).toBeLessThan(0); // then issue number
    expect(compareRuns(key(1, 'aaa', 2), key(1, 'aaa', 2))).toBe(0);
  });

  it('absent order_key (the empty string) sorts before any set key', () => {
    expect(compareRuns(key(0, '', 9), key(0, 'a', 1))).toBeLessThan(0);
  });

  it('is a deterministic total order: sorting any shuffle gives one schedule (property)', () => {
    const arbKey = fc.record({
      priority: fc.integer({ min: -5, max: 5 }),
      orderKey: fc.string({ maxLength: 4 }),
      issueNumber: fc.integer({ min: 1, max: 50 }),
    });
    fc.assert(
      fc.property(fc.uniqueArray(arbKey, { selector: (k) => k.issueNumber, maxLength: 12 }), (keys) => {
        const sortedOnce = [...keys].sort(compareRuns);
        const sortedTwice = [...keys].reverse().sort(compareRuns);
        expect(sortedTwice).toEqual(sortedOnce);
      }),
    );
  });

  it('is antisymmetric and consistent (property)', () => {
    const arbKey = fc.record({
      priority: fc.integer({ min: -3, max: 3 }),
      orderKey: fc.string({ maxLength: 3 }),
      issueNumber: fc.integer({ min: 1, max: 20 }),
    });
    fc.assert(
      fc.property(arbKey, arbKey, (a, b) => {
        expect(Math.sign(compareRuns(a, b))).toBe(-Math.sign(compareRuns(b, a)));
      }),
    );
  });
});
