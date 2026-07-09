/**
 * Issue intake — the **pure** decision core of continuous mode (Milestone 11 — repo auto-pickup).
 *
 * Given a watched repo's open issues and the runs that already exist for them, it decides which single
 * issue (if any) to admit next. All the policy lives here as a total function of its inputs — no
 * network, no store, no clock — so every rule (the in-flight cap, dedup, and the safety guards from
 * issue #3) is unit-testable in isolation. The impure {@link ./issue-intake-poller.IssueIntakePoller}
 * supplies the inputs (via the GitHub adapter + the store) and acts on the decision.
 *
 * The guards exist because an open issue is an **untrusted input**: anyone can file one. So by default
 * the loop only picks up issues that are (1) filed by the project owner, (2) unassigned, and (3) not
 * marked `[WIP]` — with an explicit **override label** the owner can add to opt any single issue in
 * regardless. This keeps a stranger's issue from becoming an injection/cost vector while still letting
 * the owner say "yes, work this one" with one label.
 */

import type { RunStatus } from '../store/repository';

/** The default override label — the owner adds it to an issue to bypass the intake guards (issue #3). */
export const DEFAULT_WATCH_LABEL = 'agent help wanted';

/** One open issue as the intake decision sees it (a projection of {@link ../integration/github.RepoIssue}). */
export interface IntakeIssue {
  ref: string;
  number: number;
  title: string;
  body: string;
  author: string;
  assignees: string[];
  labels: string[];
}

/** The knobs the decision is parameterized on, resolved per repo by the poller. */
export interface IntakePolicy {
  /** The repo owner login — the only author whose issues are auto-picked without the override label. */
  owner: string;
  /** The label that bypasses every guard; matched case-insensitively. */
  overrideLabel: string;
  /** Max runs a repo may have in flight at once; the sequential default is `1`. Clamped to `>= 1`. */
  inFlightCap: number;
}

/** An open issue the loop declined to pick up this pass, with a human-readable why (for logging). */
export interface IntakeSkip {
  ref: string;
  number: number;
  reason: string;
}

/** What one repo's intake pass concluded — the issues to admit this pass, plus visibility into the rest. */
export interface IntakePlan {
  /** The issues to admit **this pass**, oldest-first (issue number asc), up to `cap - inFlight` free
   *  slots (agents-fsm#10 — parallel pickup). Empty when the cap is full, nothing is new, or nothing
   *  eligible. At the default cap of 1 this holds at most one entry (today's sequential behaviour). */
  starts: Array<{ issueRef: string; issueNumber: number }>;
  /** How many of the repo's open issues already hold a slot (a non-`stopped` run). */
  inFlight: number;
  /** The resolved (clamped) in-flight cap. */
  cap: number;
  /** New issues rejected by the guards this pass — never admitted, so surfaced here for the operator. */
  skipped: IntakeSkip[];
}

/** `[WIP]` anywhere in the title or body marks an issue as not-ready — case-insensitive, brackets literal. */
const WIP_RE = /\[wip\]/i;

/**
 * Decide the next issue to admit for one watched repo.
 *
 * @param openIssues       the repo's currently-open issues (any order; sorted here for determinism).
 * @param runStatusByRef   latest run status per **lowercased** issue ref — an issue absent from the map
 *                         has no run yet. Issues that already have a run are never re-picked (dedup),
 *                         and a non-`stopped` run counts against the in-flight cap.
 * @param policy           the owner / override-label / cap knobs.
 *
 * Fills up to `free = cap - inFlight` slots per pass, oldest-first (agents-fsm#10 — parallel pickup).
 * With the default cap of 1 this admits at most one issue per pass — one non-`stopped` run holds the
 * slot and the next issue is admitted only once that run's issue closes (a merge) or is stopped.
 */
export function decideIntake(
  openIssues: IntakeIssue[],
  runStatusByRef: Map<string, RunStatus>,
  policy: IntakePolicy,
): IntakePlan {
  const cap = Math.max(1, Math.trunc(policy.inFlightCap));
  let inFlight = 0;
  const candidates: IntakeIssue[] = [];
  for (const issue of openIssues) {
    const status = runStatusByRef.get(issue.ref.toLowerCase());
    if (status !== undefined) {
      // Already has a run: it holds a slot unless it was stopped (abandoned). Either way it is never a
      // fresh candidate — dedup keeps a finished/stopped-but-still-open issue from being picked up again.
      if (status !== 'stopped') inFlight += 1;
      continue;
    }
    candidates.push(issue);
  }

  const plan: IntakePlan = { starts: [], inFlight, cap, skipped: [] };
  const free = cap - inFlight;
  if (free <= 0) return plan; // slots full — no candidate is even evaluated; wait for a merge/stop to free one

  // Oldest first (issue number asc): deterministic, and it works the backlog in the order it was filed.
  candidates.sort((a, b) => a.number - b.number);
  for (const issue of candidates) {
    const reason = ineligibleReason(issue, policy);
    if (reason === null) {
      plan.starts.push({ issueRef: issue.ref, issueNumber: issue.number });
      // Stop once the free slots are filled; the remaining candidates simply wait for a future pass
      // (neither started nor skipped — they are still eligible, just held back by the cap).
      if (plan.starts.length === free) break;
    } else {
      plan.skipped.push({ ref: issue.ref, number: issue.number, reason });
    }
  }
  return plan;
}

/** Why `issue` may not be auto-picked (a loggable reason), or `null` when it clears every guard. */
function ineligibleReason(issue: IntakeIssue, policy: IntakePolicy): string | null {
  // The override label is the owner's explicit opt-in — it bypasses all three content guards.
  if (issue.labels.some((l) => l.toLowerCase() === policy.overrideLabel.toLowerCase())) return null;

  const hint = `add the "${policy.overrideLabel}" label to pick it up anyway`;
  if (issue.author.toLowerCase() !== policy.owner.toLowerCase()) {
    return `filed by @${issue.author}, not the project owner @${policy.owner} — ${hint}`;
  }
  if (issue.assignees.length > 0) {
    return `already assigned to ${issue.assignees.map((a) => `@${a}`).join(', ')} — ${hint}`;
  }
  if (WIP_RE.test(issue.title) || WIP_RE.test(issue.body)) {
    return `marked [WIP] — ${hint}`;
  }
  return null;
}

/** The repo owner login — the first path segment of a canonical `owner/name` ref (case preserved). */
export function ownerOf(repoRef: string): string {
  return repoRef.split('/')[0] ?? repoRef;
}
