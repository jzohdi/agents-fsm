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

  /** Stage all changes in the working tree, commit them, and push the branch. */
  commitAndPush(input: CommitAndPushInput): Promise<CommitRef>;

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
