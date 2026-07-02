/**
 * Issue intake decision tests (Milestone 11 — the pure core of continuous mode). Every rule is a
 * function of (open issues, existing runs, policy): the sequential in-flight cap, dedup against runs
 * that already exist, the issue #3 safety guards (owner-only / unassigned / non-`[WIP]`), and the
 * override-label bypass. No store, no network — just the decision.
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

describe('decideIntake — admission', () => {
  it('admits the single eligible issue when the repo has no runs', () => {
    const plan = decideIntake([issue(1)], runs(), policy());
    expect(plan.start).toEqual({ issueRef: 'acme/web#1', issueNumber: 1 });
    expect(plan.inFlight).toBe(0);
  });

  it('admits the oldest eligible issue first (deterministic, backlog order)', () => {
    const plan = decideIntake([issue(7), issue(3), issue(5)], runs(), policy());
    expect(plan.start).toMatchObject({ issueNumber: 3 });
  });

  it('admits exactly one issue per pass even when several are eligible', () => {
    const plan = decideIntake([issue(1), issue(2)], runs(), policy());
    expect(plan.start).toMatchObject({ issueNumber: 1 });
  });
});

describe('decideIntake — in-flight cap (sequential)', () => {
  it('admits nothing while a non-stopped run holds the slot (cap 1)', () => {
    const plan = decideIntake([issue(1), issue(2)], runs([['acme/web#1', 'running']]), policy());
    expect(plan.start).toBeNull();
    expect(plan.inFlight).toBe(1);
  });

  it('counts a done run (PR not yet merged, issue still open) as in flight — holds the slot', () => {
    const plan = decideIntake([issue(1), issue(2)], runs([['acme/web#1', 'done']]), policy());
    expect(plan.start).toBeNull();
    expect(plan.inFlight).toBe(1);
  });

  it('counts needs_human as in flight — a broken issue parks the queue rather than skipping ahead', () => {
    const plan = decideIntake([issue(1), issue(2)], runs([['acme/web#1', 'needs_human']]), policy());
    expect(plan.start).toBeNull();
  });

  it('lets a higher cap admit while runs are in flight', () => {
    const plan = decideIntake([issue(1), issue(2), issue(3)], runs([['acme/web#1', 'running']]), policy({ inFlightCap: 2 }));
    expect(plan.start).toMatchObject({ issueNumber: 2 });
    expect(plan.inFlight).toBe(1);
  });
});

describe('decideIntake — dedup', () => {
  it('never re-picks an issue that already has a run', () => {
    const plan = decideIntake([issue(1)], runs([['acme/web#1', 'running']]), policy());
    expect(plan.start).toBeNull();
  });

  it('a stopped run frees the slot but its issue is not re-picked; the next new issue is', () => {
    const plan = decideIntake([issue(1), issue(2)], runs([['acme/web#1', 'stopped']]), policy());
    expect(plan.inFlight).toBe(0); // stopped doesn't hold the slot
    expect(plan.start).toMatchObject({ issueNumber: 2 }); // ...but #1 (stopped) is skipped
  });

  it('matches the run map case-insensitively (refs are case-insensitive)', () => {
    const plan = decideIntake([issue(1, { ref: 'Acme/Web#1' })], runs([['acme/web#1', 'running']]), policy());
    expect(plan.start).toBeNull();
  });
});

describe('decideIntake — safety guards (issue #3)', () => {
  it('skips an issue filed by someone other than the project owner', () => {
    const plan = decideIntake([issue(1, { author: 'stranger' })], runs(), policy());
    expect(plan.start).toBeNull();
    expect(plan.skipped[0]).toMatchObject({ number: 1 });
    expect(plan.skipped[0]!.reason).toContain('not the project owner');
  });

  it('skips an already-assigned issue', () => {
    const plan = decideIntake([issue(1, { assignees: ['someone'] })], runs(), policy());
    expect(plan.start).toBeNull();
    expect(plan.skipped[0]!.reason).toContain('already assigned');
  });

  it('skips a [WIP] issue by title or body (case-insensitive)', () => {
    expect(decideIntake([issue(1, { title: '[WIP] refactor' })], runs(), policy()).start).toBeNull();
    expect(decideIntake([issue(1, { body: 'still [wip], do not touch' })], runs(), policy()).start).toBeNull();
  });

  it('picks the first eligible issue, skipping guarded ones ahead of it', () => {
    const plan = decideIntake(
      [issue(1, { author: 'stranger' }), issue(2, { assignees: ['x'] }), issue(3)],
      runs(),
      policy(),
    );
    expect(plan.start).toMatchObject({ issueNumber: 3 });
    expect(plan.skipped).toHaveLength(2);
  });
});

describe('decideIntake — override label bypass', () => {
  it('picks up a non-owner issue that carries the override label', () => {
    const plan = decideIntake([issue(1, { author: 'stranger', labels: [DEFAULT_WATCH_LABEL] })], runs(), policy());
    expect(plan.start).toMatchObject({ issueNumber: 1 });
  });

  it('picks up an assigned [WIP] issue when the override label is present', () => {
    const plan = decideIntake(
      [issue(1, { author: 'stranger', assignees: ['x'], title: '[WIP] x', labels: ['agent help wanted'] })],
      runs(),
      policy(),
    );
    expect(plan.start).toMatchObject({ issueNumber: 1 });
  });

  it('matches the override label case-insensitively and honors a custom label', () => {
    const plan = decideIntake([issue(1, { author: 'stranger', labels: ['Fleet: Go'] })], runs(), policy({ overrideLabel: 'fleet: go' }));
    expect(plan.start).toMatchObject({ issueNumber: 1 });
  });
});

describe('ownerOf', () => {
  it('is the first path segment of a canonical ref', () => {
    expect(ownerOf('acme/web')).toBe('acme');
    expect(ownerOf('Big-Org/some.repo')).toBe('Big-Org');
  });
});
