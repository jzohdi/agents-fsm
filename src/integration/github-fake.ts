/**
 * In-memory {@link GitHub} fake (Layer 5 — README §3.3 "Built for fakes").
 *
 * A faithful behavioral double, not a git simulator: it models issues, working trees,
 * PRs, comments, and commits in memory so the whole pipeline runs end-to-end with zero
 * network calls and zero cost (README §3.3 Layer 5). Tests seed issues and diffs and then
 * assert on the PRs/comments/commits the orchestrator produced.
 *
 * It deliberately mirrors the real adapter's observable contract (auto-incrementing PR and
 * comment ids, branch-relative diffs, idempotent working-tree preparation) so code that
 * passes against the fake behaves the same against {@link ./github-cli}.
 */

import {
  GitHubNotFoundError,
  type BaseSync,
  type Comment,
  type CommitAndPushInput,
  type CommitRef,
  type CreateIssueInput,
  type GitHub,
  type Issue,
  type IssueComment,
  type OpenPrInput,
  type PrComment,
  type PrepareWorkingTreeInput,
  type RepoIssue,
  type Suggestion,
  type PullRequest,
  type ReadDiffInput,
  type UpdateIssueInput,
  type UpdatePrInput,
  type WorkingTree,
} from './github';

interface SeedIssue {
  number: number;
  title?: string;
  body?: string;
  /** Defaults to `open`; seed `closed` to simulate an already-landed dependency (README §3.5). */
  state?: Issue['state'];
  /** Login of the filer, for the intake owner-guard (Milestone 11). Defaults to the ref's owner segment. */
  author?: string;
  /** Assignee logins, for the intake assigned-guard. Defaults to none. */
  assignees?: string[];
  /** Label names, for the intake override-label bypass. Defaults to none. */
  labels?: string[];
}

/** The fake's stored issue: the public {@link Issue} plus the intake-only fields {@link RepoIssue} exposes. */
interface StoredIssue extends Issue {
  author: string;
  assignees: string[];
  labels: string[];
}

interface CommitEntry {
  sha: string;
  message: string;
}

export interface FakeGitHubOptions {
  /** Root the synthetic working-tree paths hang off (purely a string; nothing touches disk). */
  workingRoot?: string;
  /**
   * When true, `readIssue` returns a synthetic issue for any unseeded ref instead of rejecting.
   * A convenience for pipeline tests that drive many runs and don't care about issue content;
   * the strict default (reject unknown, like the real API) stays the norm.
   */
  autoSeedIssues?: boolean;
  /** Repo new issues (`createIssue`) belong to; their `ref` is `${repoRef}#${number}`. Default `demo/repo`. */
  repoRef?: string;
  /** Login attributed to comments the orchestrator posts — the "agent" author the poller filters out. Default `agent-fleet[bot]`. */
  botLogin?: string;
  /** Injectable clock for deterministic comment timestamps in tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * In-memory GitHub/git double. Construct it, optionally seed issues and diffs, then hand it
 * anywhere a {@link GitHub} is expected.
 */
export class FakeGitHub implements GitHub {
  private readonly issues = new Map<string, StoredIssue>();
  private readonly prs: PullRequest[] = [];
  /** PR comments (newest last), across all PRs; filtered by PR number on read. Carries author +
   *  createdAt so the PR Feedback Poller can distinguish the bot's comments from a human reviewer's. */
  private readonly prComments: PrComment[] = [];
  /** Issue comments (newest last), across all issues; filtered by issue number on read. */
  private readonly issueComments: IssueComment[] = [];
  /** Commits recorded per working-tree path (newest last). */
  private readonly commits = new Map<string, CommitEntry[]>();
  /** Explicit diff overrides keyed by `base...branch`; falls back to a synthesized summary. */
  private readonly diffs = new Map<string, string>();
  /** Working trees by run id, so repeated preparation is idempotent. */
  private readonly workingTrees = new Map<number, WorkingTree>();
  /** Labels per PR number (the `af:<state>` mirror + any human labels a test seeds). */
  private readonly prLabelsByNumber = new Map<number, Set<string>>();
  private readonly workingRoot: string;
  private readonly autoSeedIssues: boolean;
  private readonly repoRef: string;
  private readonly botLogin: string;
  private readonly now: () => number;
  private prCounter = 0;
  private commentCounter = 0;
  private commitCounter = 0;
  private issueCounter = 0;

  constructor(options: FakeGitHubOptions = {}) {
    this.workingRoot = options.workingRoot ?? '/tmp/agent-fleet-fake';
    this.autoSeedIssues = options.autoSeedIssues ?? false;
    this.repoRef = options.repoRef ?? 'demo/repo';
    this.botLogin = options.botLogin ?? 'agent-fleet[bot]';
    this.now = options.now ?? Date.now;
  }

  // --- test seeding -----------------------------------------------------------

  /** Seed an issue so {@link readIssue} resolves it. Returns `this` for chaining. */
  seedIssue(ref: string, issue: SeedIssue): this {
    this.issues.set(ref, {
      ref,
      number: issue.number,
      title: issue.title ?? `Issue ${issue.number}`,
      body: issue.body ?? '',
      state: issue.state ?? 'open',
      // Default the author to the ref's owner segment so a plain `seedIssue` reads as owner-filed — the
      // common case the intake owner-guard admits (tests override it to exercise the guard).
      author: issue.author ?? (ref.split('/')[0] || 'owner'),
      assignees: issue.assignees ?? [],
      labels: issue.labels ?? [],
    });
    this.issueCounter = Math.max(this.issueCounter, issue.number);
    return this;
  }

  /**
   * Close an issue — the test-side stand-in for the real-world dependency-clearing signal (a human
   * merging the `Closes #N` PR, or closing the issue by hand — README §3.5). Not on the {@link GitHub}
   * interface: the orchestrator never closes issues itself.
   */
  closeIssue(number: number): void {
    this.requireIssueByNumber(number).state = 'closed';
  }

  /**
   * Seed a comment on an issue (newest last). Tests use this to simulate a **human reply** to the
   * agent's clarifying questions — pass an `author` other than the bot login (the default here) so
   * the reply poller recognizes it as a human's answer.
   */
  seedIssueComment(issueNumber: number, comment: { author: string; body: string; createdAt?: string }): IssueComment {
    const created: IssueComment = {
      id: ++this.commentCounter,
      issueNumber,
      author: comment.author,
      body: comment.body,
      createdAt: comment.createdAt ?? new Date(this.now()).toISOString(),
    };
    this.issueComments.push(created);
    return { ...created };
  }

  /** The bot login this fake attributes to orchestrator-posted comments (test introspection). */
  agentLogin(): string {
    return this.botLogin;
  }

  /** Seed an explicit diff for a `base...branch` range (otherwise it is synthesized from commits). */
  seedDiff(input: { base: string; branch: string; diff: string }): this {
    this.diffs.set(rangeKey(input.base, input.branch), input.diff);
    return this;
  }

  /** All PRs opened so far (test introspection). */
  listPrs(): PullRequest[] {
    return this.prs.map((pr) => ({ ...pr }));
  }

  /** All PR comments posted so far, as bare {@link Comment}s (test introspection). */
  listComments(): Comment[] {
    return this.prComments.map((c) => ({ id: c.id, prNumber: c.prNumber, body: c.body }));
  }

  /**
   * Seed a comment on a PR (newest last). Tests use this to simulate a **human reviewer** leaving
   * feedback on an open PR — pass an `author` other than the bot login and a body starting with the
   * feedback marker (e.g. `feedback: …`) so the PR Feedback Poller treats it as actionable.
   */
  seedPrComment(prNumber: number, comment: { author: string; body: string; createdAt?: string }): PrComment {
    const created: PrComment = {
      id: ++this.commentCounter,
      prNumber,
      author: comment.author,
      body: comment.body,
      createdAt: comment.createdAt ?? new Date(this.now()).toISOString(),
    };
    this.prComments.push(created);
    return { ...created };
  }

  /** Total commits recorded so far (test introspection, e.g. to assert a review stage made none). */
  commitCount(): number {
    return this.commitCounter;
  }

  /** Force a PR's state, e.g. to simulate a human merging a dependency (README §3.5). */
  setPrState(prNumber: number, state: PullRequest['state']): void {
    this.requirePr(prNumber).state = state;
  }

  /** Force a PR's computed mergeability, e.g. to simulate base moving under a finished run's PR. */
  setPrMergeable(prNumber: number, mergeable: NonNullable<PullRequest['mergeable']>): void {
    this.requirePr(prNumber).mergeable = mergeable;
  }

  /**
   * Seed a PR with an explicit number + state (test / preview affordance; parallels {@link seedIssue}).
   * Used when a PR must already exist without going through `openPr` — e.g. the dashboard preview, whose
   * runs are seeded straight into the store. Idempotent on the number; bumps the auto-number counter so a
   * later `openPr` never collides.
   */
  seedPr(number: number, pr: { branch: string; base?: string; state?: PullRequest['state']; title?: string; body?: string }): PullRequest {
    const existing = this.prs.find((p) => p.number === number);
    if (existing) return { ...existing };
    const created: PullRequest = {
      number,
      branch: pr.branch,
      base: pr.base ?? 'main',
      title: pr.title ?? `PR #${number}`,
      body: pr.body ?? '',
      state: pr.state ?? 'open',
      url: `https://github.test/pr/${number}`,
    };
    this.prs.push(created);
    this.prCounter = Math.max(this.prCounter, number);
    return { ...created };
  }

  // --- GitHub API -------------------------------------------------------------
  //
  // Every interface method is `async` so a thrown error (e.g. a missing-PR `requirePr`)
  // always surfaces as a rejected promise, never a synchronous throw.

  async readIssue(issueRef: string): Promise<Issue> {
    const issue = this.issues.get(issueRef);
    if (issue) return toIssue(issue);
    if (this.autoSeedIssues) {
      const m = /#(\d+)/.exec(issueRef);
      const number = m ? Number(m[1]) : 1;
      return { ref: issueRef, number, title: `Issue ${number}`, body: '', state: 'open' };
    }
    throw new GitHubNotFoundError(`issue not found: ${issueRef}`);
  }

  /**
   * Seeded issues whose ref or title contains `query` (case-insensitive), newest first. Not part of the
   * {@link GitHub} run-adapter contract — it exists so mock mode can drive the new-run autocomplete from
   * the fake's seeded issues (via `fakeSuggestionSource` in `build-runner`), the counterpart to the
   * real, user-scoped {@link ./github-account.GitHubCliAccount}.
   */
  async suggestIssues(query: string): Promise<Suggestion[]> {
    const q = query.trim().toLowerCase();
    return [...this.issues.values()]
      .filter((i) => !q || i.ref.toLowerCase().includes(q) || i.title.toLowerCase().includes(q))
      .sort((a, b) => b.number - a.number)
      .slice(0, 25)
      .map((i) => ({ kind: 'issue' as const, ref: i.ref, repo: i.ref.split('#')[0] ?? i.ref, number: i.number, title: i.title }));
  }

  async updateIssue(input: UpdateIssueInput): Promise<Issue> {
    const issue = this.requireIssueByNumber(input.number);
    if (input.title !== undefined) issue.title = input.title;
    if (input.body !== undefined) issue.body = input.body;
    return toIssue(issue);
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const number = ++this.issueCounter;
    const ref = `${this.repoRef}#${number}`;
    // Attributed to the bot: a fleet-created issue (e.g. a triage split) is filed by the app's account.
    const issue: StoredIssue = { ref, number, title: input.title, body: input.body, state: 'open', author: this.botLogin, assignees: [], labels: [] };
    this.issues.set(ref, issue);
    return toIssue(issue);
  }

  async listOpenIssues(): Promise<RepoIssue[]> {
    return [...this.issues.values()]
      .filter((i) => i.state === 'open')
      .sort((a, b) => a.number - b.number)
      .map((i) => ({ ref: i.ref, number: i.number, title: i.title, body: i.body, author: i.author, assignees: [...i.assignees], labels: [...i.labels] }));
  }

  async postIssueComment(input: { issueNumber: number; body: string }): Promise<IssueComment> {
    // Mirror the real adapter: a comment is authored by the orchestrator's bot login, which is what
    // the reply poller filters out when it looks for a *human's* reply.
    return this.seedIssueComment(input.issueNumber, { author: this.botLogin, body: input.body });
  }

  async listIssueComments(issueNumber: number): Promise<IssueComment[]> {
    return this.issueComments.filter((c) => c.issueNumber === issueNumber).map((c) => ({ ...c }));
  }

  async findOpenPrForBranch(branch: string): Promise<PullRequest | null> {
    const pr = this.prs.find((p) => p.branch === branch && p.state === 'open');
    return pr ? { ...pr } : null;
  }

  async getPr(prNumber: number): Promise<PullRequest> {
    return { ...this.requirePr(prNumber) };
  }

  async openPr(input: OpenPrInput): Promise<PullRequest> {
    const number = ++this.prCounter;
    const pr: PullRequest = {
      number,
      branch: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      state: 'open',
      url: `https://github.test/pr/${number}`,
    };
    this.prs.push(pr);
    return { ...pr };
  }

  async updatePr(input: UpdatePrInput): Promise<PullRequest> {
    const pr = this.requirePr(input.prNumber);
    if (input.title !== undefined) pr.title = input.title;
    if (input.body !== undefined) pr.body = input.body;
    return { ...pr };
  }

  async setPrLabels(prNumber: number, labels: string[]): Promise<void> {
    this.requirePr(prNumber);
    const current = this.prLabelsByNumber.get(prNumber) ?? new Set<string>();
    const kept = [...current].filter((l) => !l.startsWith('af:')); // human labels survive the swap
    this.prLabelsByNumber.set(prNumber, new Set([...kept, ...labels]));
  }

  /** The PR's current labels (test introspection for the `af:<state>` mirror). */
  prLabels(prNumber: number): string[] {
    return [...(this.prLabelsByNumber.get(prNumber) ?? new Set<string>())].sort();
  }

  async postComment(input: { prNumber: number; body: string }): Promise<Comment> {
    this.requirePr(input.prNumber); // reject comments on a non-existent PR, like the real API
    // Recorded like the real API: authored by the orchestrator's bot login, which is what the PR
    // Feedback Poller relies on the human reviewer's `feedback:` marker to distinguish it from.
    const created = this.seedPrComment(input.prNumber, { author: this.botLogin, body: input.body });
    return { id: created.id, prNumber: created.prNumber, body: created.body };
  }

  async listPrComments(prNumber: number): Promise<PrComment[]> {
    return this.prComments.filter((c) => c.prNumber === prNumber).map((c) => ({ ...c }));
  }

  // --- working tree + git -----------------------------------------------------

  async prepareWorkingTree(input: PrepareWorkingTreeInput): Promise<WorkingTree> {
    // Idempotent: preparing twice for the same run returns the same tree (README §2
    // "stage actions are idempotent" — back-edges re-run earlier stages).
    const existing = this.workingTrees.get(input.runId);
    if (existing) return { ...existing };
    const tree: WorkingTree = {
      path: `${this.workingRoot}/run-${input.runId}`,
      branch: input.branch,
      base: input.base,
    };
    this.workingTrees.set(input.runId, tree);
    return { ...tree };
  }

  async dropWorkingTree(runId: number): Promise<void> {
    // Forget the tree so the next prepareWorkingTree "re-clones" — mirrors the real adapter's
    // rm -rf. Idempotent on a missing tree, like the real `force` remove.
    this.workingTrees.delete(runId);
  }

  /** Records each requested base so a test can assert the merge-sync fired; no filesystem here. */
  readonly syncedBases: string[] = [];
  async syncBaseBranch(base: string): Promise<void> {
    this.syncedBases.push(base);
  }

  async commitAndPush(input: CommitAndPushInput): Promise<CommitRef> {
    const sha = `fakesha${(++this.commitCounter).toString().padStart(8, '0')}`;
    const list = this.commits.get(input.workingDir) ?? [];
    list.push({ sha, message: input.message });
    this.commits.set(input.workingDir, list);
    return { sha };
  }

  // --- between-stage base sync (merge-conflict handling) -----------------------

  /** Queued results for the next `syncBranchWithBase` calls (FIFO); empty → `up_to_date`. A test seeds
   *  one `conflict` to simulate base moving under a run at exactly one stage boundary. */
  private readonly baseSyncQueue: BaseSync[] = [];
  /** Every base-sync request, for asserting the between-stage sync actually fired (and where). */
  readonly baseSyncCalls: Array<{ runId: number; base: string }> = [];
  /** What `finishBaseMerge` reports; a test sets `{ ok: false, unresolved }` to simulate a resolver
   *  that left conflict markers behind (the mechanical verification failing). */
  finishBaseMergeResult: { ok: true } | { ok: false; unresolved: string[] } = { ok: true };
  /** Recorded `finishBaseMerge` / `abortBaseMerge` calls (assert resolve-vs-abort ordering). */
  readonly finishedMerges: Array<{ runId: number; branch: string }> = [];
  readonly abortedMerges: number[] = [];

  /** Seed the outcome of the next base sync (FIFO with {@link baseSyncQueue}). */
  queueBaseSync(sync: BaseSync): void {
    this.baseSyncQueue.push(sync);
  }

  async syncBranchWithBase(runId: number, base: string): Promise<BaseSync> {
    this.baseSyncCalls.push({ runId, base });
    return this.baseSyncQueue.shift() ?? { result: 'up_to_date', conflictFiles: [] };
  }

  async finishBaseMerge(runId: number, branch: string): Promise<{ ok: true } | { ok: false; unresolved: string[] }> {
    this.finishedMerges.push({ runId, branch });
    return this.finishBaseMergeResult;
  }

  async abortBaseMerge(runId: number): Promise<void> {
    this.abortedMerges.push(runId);
  }

  /** Records each shutdown savepoint request so a test can assert graceful shutdown committed WIP. */
  readonly savepoints: Array<{ runId: number; message: string }> = [];
  async savepointWorkingTree(runId: number, message: string): Promise<boolean> {
    // Mirrors the real adapter's no-op contract: nothing to save without a prepared tree.
    if (!this.workingTrees.has(runId)) return false;
    this.savepoints.push({ runId, message });
    return true;
  }

  async readDiff(input: ReadDiffInput): Promise<string> {
    const override = this.diffs.get(rangeKey(input.base, input.branch));
    if (override !== undefined) return override;
    // Deterministic synthesized diff from the recorded commits, so a test that committed
    // can still read something stable back without seeding an explicit diff.
    const messages = (this.commits.get(input.workingDir) ?? []).map((c) => `+ ${c.message}`);
    return messages.join('\n');
  }

  // --- helpers ----------------------------------------------------------------

  private requirePr(prNumber: number): PullRequest {
    const pr = this.prs.find((p) => p.number === prNumber);
    if (!pr) throw new GitHubNotFoundError(`PR not found: #${prNumber}`);
    return pr;
  }

  private requireIssueByNumber(number: number): StoredIssue {
    for (const issue of this.issues.values()) if (issue.number === number) return issue;
    throw new GitHubNotFoundError(`issue not found: #${number}`);
  }
}

function rangeKey(base: string, branch: string): string {
  return `${base}...${branch}`;
}

/** Project a stored issue down to the public {@link Issue} shape, dropping the intake-only fields so
 *  `readIssue`/`updateIssue`/`createIssue` never leak them (they belong to {@link RepoIssue}). */
function toIssue(stored: StoredIssue): Issue {
  return { ref: stored.ref, number: stored.number, title: stored.title, body: stored.body, state: stored.state };
}
