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

  /** Update an existing PR (the idempotent path when the run already has a PR). */
  updatePr(input: UpdatePrInput): Promise<PullRequest>;

  /** Post a comment on a PR (review feedback). */
  postComment(input: { prNumber: number; body: string }): Promise<Comment>;
}

/** Thrown by adapters when a referenced GitHub object does not exist. */
export class GitHubNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubNotFoundError';
  }
}
