/**
 * Issue intake decision tests (Milestone 11 — the pure core of continuous mode; the configurable
 * in-flight cap of agents-fsm#10). Every rule is a function of (open issues, existing runs, policy):
 * the in-flight cap (now fillable to N free slots per pass, oldest-first), dedup against runs that
 * already exist, the issue #3 safety guards (owner-only / unassigned / non-`[WIP]`), and the
 * override-label bypass. No store, no network — just the decision.
 *
 * Contract (agents-fsm#10): `decideIntake` returns `IntakePlan.starts` — an ordered array of the
 * issues to admit **this pass**, up to `cap - inFlight` free slots — replacing the old single-or-null
 * `start`. A `cap` of 1 admits exactly one (today's sequential behaviour), so the default is unchanged.
 */

import { describe, expect, it } from 'vitest';

import type { RunStatus } from '../store/repository';
import { decideIntake, ownerOf, DEFAULT_WATCH_LABEL, type IntakeIssue, type IntakePolicy } from './issue-intake';

const policy = (over: Partial<IntakePolicy> = {}): IntakePolicy => ({
  owner: 'acme',
  overrideLabel: DEFAULT_WATCH_LABEL,
  inFlightCap: 1,
  ...over,
});

/** An owner-filed, unassigned, non-WIP issue — the eligible baseline; override fields per test. */
const issue = (number: number, over: Partial<IntakeIssue> = {}): IntakeIssue => ({
  ref: `acme/web#${number}`,
  number,
  title: `Issue ${number}`,
  body: '',
  author: 'acme',
  assignees: [],
  labels: [],
  ...over,
});

const runs = (entries: Array<[string, RunStatus]> = []): Map<string, RunStatus> =>
  new Map(entries.map(([ref, status]) => [ref.toLowerCase(), status]));

/** The issue numbers admitted this pass, in the order `starts` lists them. */
const startedNumbers = (plan: { starts?: Array<{ issueNumber: number }> }): number[] =>
  (plan.starts ?? []).map((s) => s.issueNumber);

describe('decideIntake — admission (default sequential cap)', () => {
  it('admits the single eligible issue when the repo has no runs', () => {
    const plan = decideIntake([issue(1)], runs(), policy());
    expect(plan.starts).toEqual([{ issueRef: 'acme/web#1', issueNumber: 1 }]);
    expect(plan.inFlight).toBe(0);
  });

  it('admits the oldest eligible issue first (deterministic, backlog order)', () => {
    const plan = decideIntake([issue(7), issue(3), issue(5)], runs(), policy());
    expect(startedNumbers(plan)).toEqual([3]);
  });

  it('admits exactly one issue per pass at cap 1 even when several are eligible (INV-DEC-DEFAULT)', () => {
    const plan = decideIntake([issue(1), issue(2)], runs(), policy());
    expect(startedNumbers(plan)).toEqual([1]);
  });
});

describe('decideIntake — in-flight cap', () => {
  it('admits nothing while a non-stopped run holds the only slot (cap 1)', () => {
    const plan = decideIntake([issue(1), issue(2)], runs([['acme/web#1', 'running']]), policy());
    expect(plan.starts).toEqual([]);
    expect(plan.inFlight).toBe(1);
  });

  it('counts a done run (PR not yet merged, issue still open) as in flight — holds the slot', () => {
    const plan = decideIntake([issue(1), issue(2)], runs([['acme/web#1', 'done']]), policy());
    expect(plan.starts).toEqual([]);
    expect(plan.inFlight).toBe(1);
  });

  it('counts needs_human as in flight — a broken issue parks the queue rather than skipping ahead', () => {
    const plan = decideIntake([issue(1), issue(2)], runs([['acme/web#1', 'needs_human']]), policy());
    expect(plan.starts).toEqual([]);
  });
});

describe('decideIntake — parallel pickup fill (agents-fsm#10)', () => {
  it('fills exactly `cap` free slots in one pass, oldest-first; the extra waits (INV-DEC-FILL)', () => {
    // cap 3, no runs, four eligible issues → the three lowest are admitted this pass…
    const plan = decideIntake([issue(4), issue(1), issue(3), issue(2)], runs(), policy({ inFlightCap: 3 }));
    expect(startedNumbers(plan)).toEqual([1, 2, 3]);
    expect(plan.cap).toBe(3);
    expect(plan.inFlight).toBe(0);
    // …and the 4th eligible issue is neither started nor skipped — it simply waits for a future pass.
    expect(startedNumbers(plan)).not.toContain(4);
    expect(plan.skipped).toEqual([]);
  });

  it('fills only the remaining free slots when runs already hold some (INV-DEC-PARTIAL)', () => {
    // cap 3, one run in flight (k=1) → free = 2 → admit the two oldest run-less issues.
    const plan = decideIntake(
      [issue(1), issue(2), issue(3), issue(4)],
      runs([['acme/web#1', 'running']]),
      policy({ inFlightCap: 3 }),
    );
    expect(plan.inFlight).toBe(1);
    expect(startedNumbers(plan)).toEqual([2, 3]); // min(cap - inFlight, eligible) = min(2, 3) = 2
  });

  it('admits everything when fewer eligible issues than free slots (INV-DEC-PARTIAL, M < free)', () => {
    const plan = decideIntake([issue(2), issue(5)], runs(), policy({ inFlightCap: 4 }));
    expect(startedNumbers(plan)).toEqual([2, 5]); // min(4, 2) = 2
  });

  it('admits nothing (and evaluates no candidate) once in-flight reaches the cap (INV-DEC-FULL)', () => {
    const plan = decideIntake(
      [issue(1), issue(2), issue(3)],
      runs([['acme/web#1', 'running'], ['acme/web#2', 'done']]),
      policy({ inFlightCap: 2 }),
    );
    expect(plan.inFlight).toBe(2);
    expect(plan.starts).toEqual([]);
    expect(plan.skipped).toEqual([]); // full → no candidate is even considered
  });

  it('clamps a bad cap to >= 1: zero, negative, and fractional (INV-DEC-CLAMP)', () => {
    expect(startedNumbers(decideIntake([issue(1), issue(2)], runs(), policy({ inFlightCap: 0 })))).toEqual([1]);
    expect(startedNumbers(decideIntake([issue(1), issue(2)], runs(), policy({ inFlightCap: -5 })))).toEqual([1]);
    // 2.9 truncates to 2 free slots.
    expect(startedNumbers(decideIntake([issue(1), issue(2), issue(3)], runs(), policy({ inFlightCap: 2.9 })))).toEqual([1, 2]);
  });
});

describe('decideIntake — dedup', () => {
  it('never re-picks an issue that already has a run', () => {
    const plan = decideIntake([issue(1)], runs([['acme/web#1', 'running']]), policy());
    expect(plan.starts).toEqual([]);
  });

  it('a stopped run frees the slot but its issue is not re-picked; the next new issue is', () => {
    const plan = decideIntake([issue(1), issue(2)], runs([['acme/web#1', 'stopped']]), policy());
    expect(plan.inFlight).toBe(0); // stopped doesn't hold the slot
    expect(startedNumbers(plan)).toEqual([2]); // ...but #1 (stopped) is not re-picked
  });

  it('matches the run map case-insensitively (refs are case-insensitive)', () => {
    const plan = decideIntake([issue(1, { ref: 'Acme/Web#1' })], runs([['acme/web#1', 'running']]), policy());
    expect(plan.starts).toEqual([]);
  });
});

describe('decideIntake — safety guards (issue #3)', () => {
  it('skips an issue filed by someone other than the project owner', () => {
    const plan = decideIntake([issue(1, { author: 'stranger' })], runs(), policy());
    expect(plan.starts).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ number: 1 });
    expect(plan.skipped[0]!.reason).toContain('not the project owner');
  });

  it('skips an already-assigned issue', () => {
    const plan = decideIntake([issue(1, { assignees: ['someone'] })], runs(), policy());
    expect(plan.starts).toEqual([]);
    expect(plan.skipped[0]!.reason).toContain('already assigned');
  });

  it('skips a [WIP] issue by title or body (case-insensitive)', () => {
    expect(decideIntake([issue(1, { title: '[WIP] refactor' })], runs(), policy()).starts).toEqual([]);
    expect(decideIntake([issue(1, { body: 'still [wip], do not touch' })], runs(), policy()).starts).toEqual([]);
  });

  it('picks the first eligible issue, skipping guarded ones ahead of it (cap 1)', () => {
    const plan = decideIntake(
      [issue(1, { author: 'stranger' }), issue(2, { assignees: ['x'] }), issue(3)],
      runs(),
      policy(),
    );
    expect(startedNumbers(plan)).toEqual([3]);
    expect(plan.skipped).toHaveLength(2);
  });

  it('guarded issues within the fill window still land in `skipped` while eligible ones fill slots (INV-DEC-SKIP)', () => {
    // cap 2: #1 (stranger) is skipped, #2 and #3 fill the two slots, #4 waits for a future pass.
    const plan = decideIntake(
      [issue(1, { author: 'stranger' }), issue(2), issue(3), issue(4)],
      runs(),
      policy({ inFlightCap: 2 }),
    );
    expect(startedNumbers(plan)).toEqual([2, 3]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({ number: 1 });
  });
});

describe('decideIntake — override label bypass', () => {
  it('picks up a non-owner issue that carries the override label', () => {
    const plan = decideIntake([issue(1, { author: 'stranger', labels: [DEFAULT_WATCH_LABEL] })], runs(), policy());
    expect(startedNumbers(plan)).toEqual([1]);
  });

  it('picks up an assigned [WIP] issue when the override label is present', () => {
    const plan = decideIntake(
      [issue(1, { author: 'stranger', assignees: ['x'], title: '[WIP] x', labels: ['agent help wanted'] })],
      runs(),
      policy(),
    );
    expect(startedNumbers(plan)).toEqual([1]);
  });

  it('matches the override label case-insensitively and honors a custom label', () => {
    const plan = decideIntake([issue(1, { author: 'stranger', labels: ['Fleet: Go'] })], runs(), policy({ overrideLabel: 'fleet: go' }));
    expect(startedNumbers(plan)).toEqual([1]);
  });
});

describe('ownerOf', () => {
  it('is the first path segment of a canonical ref', () => {
    expect(ownerOf('acme/web')).toBe('acme');
    expect(ownerOf('Big-Org/some.repo')).toBe('Big-Org');
  });
});
