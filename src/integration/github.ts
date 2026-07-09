/**
 * Git/GitHub adapter (Layer 5 — see README §3.3).
 *
 * The single interface through which the orchestrator reads issues, manages the run's
 * local working tree, and opens/updates PRs and comments. Agents never touch git or
 * GitHub directly — they edit files in the working tree the adapter checks out, and the
 * orchestrator drives every git/GitHub side effect through this seam (README §3.3 Layer 5).
 *
 * "Built for fakes" (README §3.3 Layer 5): this interface ships with an in-memory fake
 * ({@link ./github-fake}) that the whole pipeline runs against with zero network calls,
 * and a real CLI-backed adapter ({@link ./github-cli}) whose network-touching methods sit
 * behind an explicit flag. Both satisfy the same interface, so swapping them never touches
 * the engine, loop, runner, or store.
 *
 * Two concerns live behind the one interface, split by where the side effect lands:
 *  - **GitHub API** (`readIssue`, `openPr`, `updatePr`, `postComment`) — network in the real
 *    adapter; the agents may *write* these fields, the engine/Scheduler only ever *read* the
 *    structured ones (README §3.5).
 *  - **Local working tree + git** (`prepareWorkingTree`, `commitAndPush`, `readDiff`) — the
 *    daemon's local clone where agents edit files and run tests (README §3.3 Layer 5). These
 *    are local git operations, so they are fully testable without a network.
 */

/** A GitHub issue, the input to a run. */
export interface Issue {
  /** Stable reference, e.g. `owner/repo#42`. */
  ref: string;
  number: number;
  title: string;
  body: string;
  /** `closed` is the dependency-satisfaction signal (Milestone 9 / README §3.5): a fleet PR's
   *  `Closes #N` closes the issue at merge, and a human closes human-managed ones. */
  state: 'open' | 'closed';
}

/**
 * One **open** issue as the watch / auto-pickup loop sees it (Milestone 11 — continuous mode).
 * Richer than {@link Issue}: it carries the `author`, `assignees`, and `labels` the eligibility guards
 * filter on (only pick up owner-filed, unassigned, non-`[WIP]` issues unless an override label is
 * present — see `loop/issue-intake`). `readIssue`, which drives an already-started run, needs none of
 * these, so they live on this list-only type instead of bloating the core {@link Issue}.
 */
export interface RepoIssue {
  /** Stable reference, e.g. `owner/repo#42`. */
  ref: string;
  number: number;
  title: string;
  body: string;
  /** GitHub login of whoever filed the issue — compared against the repo owner by the owner-only guard. */
  author: string;
  /** Assignee logins — a non-empty list means someone already owns it, so the intake loop leaves it alone. */
  assignees: string[];
  /** Label names — the configured override label bypasses the guards; the rest are ignored here. */
  labels: string[];
}

/**
 * Scope filter for {@link GitHub.listOpenIssues} (issue #11 — continuous mode). Each field, when a
 * non-empty string, restricts the fetched set; fields are AND-combined (match all set fields).
 * `null`/`undefined`/absent = that dimension is unconstrained. Milestone is resolved inside the
 * adapter, so {@link RepoIssue} is unchanged.
 */
export interface IssueFilter {
  label?: string | null;
  milestone?: string | null;
}

/**
 * A repo or issue the operator might start a run on — what the dashboard's new-run autocomplete shows.
 * Sourced from the logged-in user's own repos + their open issues in the real adapter (the user-scoped
 * `GitHubCliAccount`), and from the fake's seeded issues in tests.
 *
 * `kind` discriminates the two: an `issue` has a full `owner/repo#N` `ref` (start it directly); a `repo`
 * has a bare `owner/repo` `ref` (picking it narrows the type-ahead to that repo's issues). `number` is
 * `0` and `title` is the description for a `repo`.
 */
export interface Suggestion {
  kind: 'repo' | 'issue';
  /** Stable reference: `owner/repo#42` for an issue, `owner/repo` for a repo. */
  ref: string;
  /** `owner/repo` the suggestion belongs to. */
  repo: string;
  number: number;
  title: string;
}

/** A pull request, the durable home for the run's code + a status mirror (README §3.5). */
export interface PullRequest {
  number: number;
  branch: string;
  base: string;
  title: string;
  body: string;
  /** `merged` is the hard "dependency satisfied" signal the Scheduler keys off (README §3.5). */
  state: 'open' | 'closed' | 'merged';
  url: string;
  /** GitHub's computed mergeability against base: `conflicting` is what the PR Feedback Poller keys off
   *  to surface/auto-resolve merge conflicts on a finished run's PR. `unknown` = GitHub is still
   *  computing (transient) — treat as "no signal", never as a conflict. Absent on adapters/paths that
   *  don't fetch it. */
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
}

/** The outcome of merging the latest `origin/<base>` into a run's branch in its working tree. */
export interface BaseSync {
  /** `up_to_date` = branch already contains base; `merged` = a merge commit was created cleanly;
   *  `conflict` = the merge stopped on conflicts — **left in progress** (markers in the tree) so a
   *  resolver can finish it via {@link GitHub.finishBaseMerge} or discard it via
   *  {@link GitHub.abortBaseMerge}. Callers must do one or the other before anything else touches
   *  the tree — a half-merged tree wedges the next checkout. */
  result: 'up_to_date' | 'merged' | 'conflict';
  /** The unmerged paths when `result` is `conflict`; empty otherwise. */
  conflictFiles: string[];
}

/** A review/PR comment the orchestrator posted. */
export interface Comment {
  id: number;
  prNumber: number;
  body: string;
}

/**
 * A comment on a **pull request** thread. The PR sibling of {@link IssueComment}: it carries
 * `author` and `createdAt` so the PR Feedback Poller can tell a human reviewer's comment apart from
 * the orchestrator's own review comments and anchor a deterministic high-water mark (see the PR
 * Feedback Poller). A PR is an issue under the hood on GitHub, so these come from the same REST
 * `issues/<n>/comments` endpoint {@link Comment}s are posted to.
 */
export interface PrComment {
  id: number;
  prNumber: number;
  /** GitHub login of the comment's author — the bot's login vs. a human reviewer, for feedback detection. */
  author: string;
  body: string;
  /** ISO-8601 creation timestamp, as GitHub reports it. */
  createdAt: string;
}

/**
 * A comment on an **issue** (as opposed to a PR). Triage uses these for its human-in-the-loop:
 * it posts clarifying questions as an issue comment and the reply poller reads the thread to detect
 * a human's answer. Unlike {@link Comment} it carries `author` and `createdAt`, the fields that let
 * the poller tell the agent's own question apart from the human's reply (see the Reply Poller).
 */
export interface IssueComment {
  id: number;
  issueNumber: number;
  /** GitHub login of the comment's author — the agent's bot login vs. a human, for reply detection. */
  author: string;
  body: string;
  /** ISO-8601 creation timestamp, as GitHub reports it. */
  createdAt: string;
}

/** The run's checked-out local working tree — where the harness runs (README §3.3 Layer 5). */
export interface WorkingTree {
  /** Absolute path to the checkout; passed to the Stage Executor as its `workingDir`. */
  path: string;
  branch: string;
  base: string;
}

/** A commit reference, the locator stored for a code artifact (README §3.3 Layer 1 `artifacts`). */
export interface CommitRef {
  sha: string;
}

export interface OpenPrInput {
  branch: string;
  base: string;
  title: string;
  body: string;
}

export interface UpdatePrInput {
  prNumber: number;
  title?: string;
  body?: string;
}

/**
 * Outcome of an auto-merge attempt (agents-fsm#15). A discriminated result, never a throw for the
 * expected "not mergeable" case: `merged:false` is a normal, first-class outcome the loop escalates on.
 * `merged:true` includes the already-merged case (idempotent under ledger replay).
 */
export type MergeResult =
  | { merged: true }
  | { merged: false; reason: string; mergeable?: PullRequest['mergeable'] };

export interface MergePrInput {
  prNumber: number;
  /** The PR's own base — merge into this and never stack (no-stacked-PRs discipline). */
  base: string;
  /** Merge strategy. Only `'merge'` (a merge commit) is used today; typed narrow to leave room. */
  method?: 'merge';
  /** Delete the (disposable per-run) branch after a successful merge. Default true at the call site. */
  deleteBranch?: boolean;
}

export interface UpdateIssueInput {
  number: number;
  title?: string;
  body?: string;
}

export interface CreateIssueInput {
  title: string;
  body: string;
}

export interface PrepareWorkingTreeInput {
  /** The run the working tree belongs to; the adapter derives a per-run checkout path from it. */
  runId: number;
  /** The run's working branch (created off `base` if it does not yet exist). */
  branch: string;
  /** The base branch the work targets and is diffed against. */
  base: string;
}

export interface CommitAndPushInput {
  /** The working tree to commit from (the `path` returned by {@link GitHub.prepareWorkingTree}). */
  workingDir: string;
  branch: string;
  message: string;
}

export interface ReadDiffInput {
  workingDir: string;
  base: string;
  branch: string;
}

/**
 * The one adapter seam. The real implementation talks to GitHub + git; the fake keeps it
 * all in memory. The orchestrator depends only on this interface.
 */
export interface GitHub {
  /** Read an issue by reference (e.g. `owner/repo#42`). */
  readIssue(issueRef: string): Promise<Issue>;

  /**
   * Every **open** issue in the repo, for the watch / auto-pickup loop (Milestone 11 — continuous mode).
   * Carries the author/assignees/labels the eligibility guards need. The real adapter maps `gh issue
   * list --state open`; the fake returns its seeded open issues. Returns `[]` when the repo has none.
   * Only the Issue Intake Poller calls this — never a run's hot path.
   *
   * An optional {@link IssueFilter} (issue #11) *scopes* the fetched set to a label and/or milestone,
   * AND-combined — applied here at fetch time so the pure intake decision keeps receiving an
   * already-scoped set and {@link RepoIssue} stays unchanged (milestone is resolved internally). Called
   * with no argument (or an all-`null` filter) it behaves exactly as before — every open issue.
   */
  listOpenIssues(filter?: IssueFilter): Promise<RepoIssue[]>;

  /**
   * Rewrite an issue's title and/or body. Triage uses this to improve a vague issue into a
   * well-scoped spec before handing it to `plan` (README §0 triage). Returns the updated issue.
   */
  updateIssue(input: UpdateIssueInput): Promise<Issue>;

  /**
   * Open a brand-new issue, e.g. one of the smaller issues triage split a too-large issue into.
   * Returns the created issue with its assigned number and `ref` so the orchestrator can record or
   * retarget to it.
   */
  createIssue(input: CreateIssueInput): Promise<Issue>;

  /**
   * Post a comment on an **issue** (not a PR). Triage posts its clarifying questions and its
   * split/sign-off notes here; the human replies in the same thread. Returns the created comment,
   * including the `author` + `id` the reply poller anchors on.
   */
  postIssueComment(input: { issueNumber: number; body: string }): Promise<IssueComment>;

  /** The issue's comments, oldest first — what the reply poller scans to detect a human's answer. */
  listIssueComments(issueNumber: number): Promise<IssueComment[]>;

  /**
   * Ensure the run's local clone exists and the working branch is checked out, creating the
   * branch off `base` when new. This is also where "create a branch" happens (README §3.1:
   * the branch is created when `plan` begins); the working tree and branch are one primitive.
   */
  prepareWorkingTree(input: PrepareWorkingTreeInput): Promise<WorkingTree>;

  /**
   * Discard the run's local working tree so the next {@link prepareWorkingTree} re-clones fresh.
   * The Scheduler Poller calls this when waking a dependency-`blocked` run (Milestone 9 / README
   * §3.1 base-branch discipline): the tree was created off *pre-merge* base at triage, and a fresh
   * clone branches off up-to-date base. Safe because everything durable is already on the remote —
   * a pushed branch is restored by the next prepare, never reset (README §2 idempotency), exactly
   * the lost-tree path crash recovery already exercises. Idempotent: dropping a missing tree is a
   * no-op.
   */
  dropWorkingTree(runId: number): Promise<void>;

  /**
   * Freshen the operator's local checkout after a run's PR merges (Milestone 12 — "local directory"
   * source mode): fetch the remote and fast-forward the `base` branch **only when it is the checked-out
   * branch and the working tree is clean**, so future `git worktree`s branch off up-to-date base and the
   * operator's own `main` stays current — never disturbing their in-progress work. A no-op for the
   * clone-on-run source mode (there is no shared local checkout to sync).
   */
  syncBaseBranch(base: string): Promise<void>;

  /** Stage all changes in the working tree, commit them, and push the branch. */
  commitAndPush(input: CommitAndPushInput): Promise<CommitRef>;

  /**
   * Merge the latest `origin/<base>` into the run's branch in its working tree (the between-stage base
   * sync). Fetches first, so "up to date" means against the remote's current base, not a stale ref.
   * On `conflict` the merge is deliberately **left in progress** (conflict markers in the tree, the
   * unmerged paths reported) so a resolver agent can edit the files; the caller must then either
   * {@link finishBaseMerge} or {@link abortBaseMerge} — never leave the tree mid-merge.
   */
  syncBranchWithBase(runId: number, base: string): Promise<BaseSync>;

  /**
   * Conclude an in-progress base merge after conflicts were (supposedly) resolved: **mechanically
   * verify** no file still carries conflict markers — the resolver's self-report is never trusted —
   * then stage everything, create the merge commit, and push the branch (so the PR's conflict status
   * clears). Returns the offending files instead when verification fails, leaving the merge in
   * progress for {@link abortBaseMerge}.
   */
  finishBaseMerge(runId: number, branch: string): Promise<{ ok: true } | { ok: false; unresolved: string[] }>;

  /** Discard an in-progress base merge (`git merge --abort`), restoring the pre-sync tree. Idempotent:
   *  a no-op when no merge is in progress, so callers can always abort defensively before escalating. */
  abortBaseMerge(runId: number): Promise<void>;

  /**
   * Commit (never push) any uncommitted changes in the run's working tree — the daemon's graceful
   * shutdown calls this for each stage it interrupted, so the agent's in-progress edits survive the
   * restart as a `wip` commit on the run branch instead of sitting uncommitted in a tree someone might
   * clean. Local-only on purpose: pushing WIP would ping PR watchers/feedback pollers with half-done
   * work. Idempotent + best-effort friendly: a missing tree or a clean tree is a no-op (returns false);
   * returns true when a savepoint commit was created.
   */
  savepointWorkingTree(runId: number, message: string): Promise<boolean>;

  /**
   * Remove the pipeline's `.agent/` scratch artifacts (`.agent/plan.md`, `.agent/interface.md`, and
   * anything else under `.agent/`) from the run's branch tip and push, so the PR's net contribution to
   * `main` carries no scratch files and back-to-back runs never conflict on those fixed paths (agents-fsm#21).
   *
   * The runner calls this exactly once, at the terminal `code_review` approval (approve → `done`), i.e.
   * AFTER every stage that reads the artifacts has run. Removing them from the branch tip is a one-sided
   * delete against a `main` that never had them, so neither the between-stage base sync nor the GitHub PR
   * merge can 3-way-conflict on `.agent/**`.
   *
   * Contract:
   *  - Operates on the run's own working tree (derived from `runId`, like the other tree methods).
   *  - Idempotent + no-op-safe: when `.agent/` is already gone (re-entry, a second PR-feedback approval,
   *    or it was never created) it makes NO commit and returns `null`. It STILL pushes HEAD (a harmless
   *    no-op when up to date) so a removal commit stranded by a crash between commit and push is
   *    recovered on the resume re-run — the push is unconditional, exactly like {@link commitAndPush}.
   *  - Local-tree mutation + push through the same seam as `commitAndPush`; the runner never shells git.
   *  - The removal commit is authored by the daemon identity (it, not the agent, makes it), matching
   *    `savepointWorkingTree` / `finishBaseMerge`.
   *
   * @returns the `CommitRef` of the removal commit, or `null` when there was nothing to strip.
   */
  stripAgentArtifacts(runId: number, branch: string, message: string): Promise<CommitRef | null>;

  /**
   * The diff of the working branch against its base (`base...branch`) — what `code_review`
   * reads. Branch-relative rather than PR-numbered so it needs no network and is a property
   * of the code, not of the PR record.
   */
  readDiff(input: ReadDiffInput): Promise<string>;

  /** The open PR for a branch, or `null` if none. Lets `tdd` be find-or-create rather than
   * only `pr_number`-guarded, closing the crash/resume window between `openPr` and persisting
   * the number (so recovery never opens a duplicate PR). */
  findOpenPrForBranch(branch: string): Promise<PullRequest | null>;

  /** Open a PR for the run's branch. Callers ensure idempotency by checking the run's
   * recorded `pr_number` (and `findOpenPrForBranch`) first (README §2 "stage actions are idempotent"). */
  openPr(input: OpenPrInput): Promise<PullRequest>;

  /**
   * Read a PR by number — chiefly for its `state` (open/closed/merged). The PR Feedback Poller
   * calls this each tick to stop watching a run once its PR is merged or closed.
   */
  getPr(prNumber: number): Promise<PullRequest>;

  /** Update an existing PR (the idempotent path when the run already has a PR). */
  updatePr(input: UpdatePrInput): Promise<PullRequest>;

  /**
   * Merge a PR into its base (agents-fsm#15 auto-merge). **Never forces**: on any non-mergeable/failed
   * merge (conflict, base moved, required checks unsatisfied, permission) it returns
   * `{ merged:false, reason, mergeable? }` and leaves the PR open — it must not `--force`/`--admin`.
   * An already-merged PR returns `{ merged:true }` (idempotent under ledger replay). Merges into the
   * PR's recorded base only; never stacks.
   */
  mergePr(input: MergePrInput): Promise<MergeResult>;

  /**
   * Replace the PR's `af:`-prefixed labels with the given set, leaving human labels alone — the
   * §3.5 state mirror (`af:<state>`, Milestone 9). A **derived view**, best-effort by contract:
   * callers fire-and-forget and log failures; it must never gate a transition.
   */
  setPrLabels(prNumber: number, labels: string[]): Promise<void>;

  /** Post a comment on a PR (review feedback). */
  postComment(input: { prNumber: number; body: string }): Promise<Comment>;

  /**
   * The PR's comment thread, oldest first — what the PR Feedback Poller scans for a human reviewer's
   * `feedback:`-marked comment after a run has finished. Carries `author`/`createdAt` (unlike
   * {@link Comment}) so the bot's own comments are distinguishable from a human's.
   */
  listPrComments(prNumber: number): Promise<PrComment[]>;
}

/** Thrown by adapters when a referenced GitHub object does not exist. */
export class GitHubNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubNotFoundError';
  }
}
