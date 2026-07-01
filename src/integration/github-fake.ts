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
  type Comment,
  type CommitAndPushInput,
  type CommitRef,
  type CreateIssueInput,
  type GitHub,
  type Issue,
  type IssueComment,
  type OpenPrInput,
  type PrepareWorkingTreeInput,
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
  private readonly issues = new Map<string, Issue>();
  private readonly prs: PullRequest[] = [];
  private readonly comments: Comment[] = [];
  /** Issue comments (newest last), across all issues; filtered by issue number on read. */
  private readonly issueComments: IssueComment[] = [];
  /** Commits recorded per working-tree path (newest last). */
  private readonly commits = new Map<string, CommitEntry[]>();
  /** Explicit diff overrides keyed by `base...branch`; falls back to a synthesized summary. */
  private readonly diffs = new Map<string, string>();
  /** Working trees by run id, so repeated preparation is idempotent. */
  private readonly workingTrees = new Map<number, WorkingTree>();
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
    });
    this.issueCounter = Math.max(this.issueCounter, issue.number);
    return this;
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

  /** All comments posted so far (test introspection). */
  listComments(): Comment[] {
    return this.comments.map((c) => ({ ...c }));
  }

  /** Total commits recorded so far (test introspection, e.g. to assert a review stage made none). */
  commitCount(): number {
    return this.commitCounter;
  }

  /** Force a PR's state, e.g. to simulate a human merging a dependency (README §3.5). */
  setPrState(prNumber: number, state: PullRequest['state']): void {
    this.requirePr(prNumber).state = state;
  }

  // --- GitHub API -------------------------------------------------------------
  //
  // Every interface method is `async` so a thrown error (e.g. a missing-PR `requirePr`)
  // always surfaces as a rejected promise, never a synchronous throw.

  async readIssue(issueRef: string): Promise<Issue> {
    const issue = this.issues.get(issueRef);
    if (issue) return { ...issue };
    if (this.autoSeedIssues) {
      const m = /#(\d+)/.exec(issueRef);
      const number = m ? Number(m[1]) : 1;
      return { ref: issueRef, number, title: `Issue ${number}`, body: '' };
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
    return { ...issue };
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const number = ++this.issueCounter;
    const ref = `${this.repoRef}#${number}`;
    const issue: Issue = { ref, number, title: input.title, body: input.body };
    this.issues.set(ref, issue);
    return { ...issue };
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

  async postComment(input: { prNumber: number; body: string }): Promise<Comment> {
    this.requirePr(input.prNumber); // reject comments on a non-existent PR, like the real API
    const comment: Comment = { id: ++this.commentCounter, prNumber: input.prNumber, body: input.body };
    this.comments.push(comment);
    return { ...comment };
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

  async commitAndPush(input: CommitAndPushInput): Promise<CommitRef> {
    const sha = `fakesha${(++this.commitCounter).toString().padStart(8, '0')}`;
    const list = this.commits.get(input.workingDir) ?? [];
    list.push({ sha, message: input.message });
    this.commits.set(input.workingDir, list);
    return { sha };
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

  private requireIssueByNumber(number: number): Issue {
    for (const issue of this.issues.values()) if (issue.number === number) return issue;
    throw new GitHubNotFoundError(`issue not found: #${number}`);
  }
}

function rangeKey(base: string, branch: string): string {
  return `${base}...${branch}`;
}
