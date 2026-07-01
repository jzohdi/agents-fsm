/**
 * Real {@link GitHub} adapter (Layer 5 — README §3.3, Milestone 3).
 *
 * Implements the adapter against the actual tools: local `git` for the working tree, commits,
 * and diffs, and the `gh` CLI for the GitHub API (issues, PRs, comments). It satisfies the same
 * interface as {@link ./github-fake.FakeGitHub}, so swapping it in never touches the engine,
 * loop, runner, or store.
 *
 * Split by where the side effect lands (README §3.3 Layer 5):
 *  - **Local git** (`prepareWorkingTree`, `commitAndPush`, `readDiff`) needs no network and is
 *    covered by the offline temp-repo tests.
 *  - **GitHub API** (`readIssue`, `openPr`, `updatePr`, `postComment`) shells out to `gh`,
 *    needs auth + network, and is exercised only behind the `RUN_REAL_GITHUB` flag — the fake
 *    is what the rest of the suite runs against ("Built for fakes").
 *
 * The child-process runner is injectable so command construction can be unit-tested, while the
 * git methods run real `git` for higher-fidelity evidence.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
  type PrComment,
  type PrepareWorkingTreeInput,
  type PullRequest,
  type ReadDiffInput,
  type UpdateIssueInput,
  type UpdatePrInput,
  type WorkingTree,
} from './github';
import { parseRepoRef } from './refs';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable child-process runner: run `file args` in `cwd`, resolve with captured output. `timeoutMs`
 *  (0/undefined = unbounded) kills a hung child — used for the best-effort autocomplete `gh` calls, not
 *  for run operations like `git clone` that can legitimately take a while. */
export type ExecFn = (file: string, args: string[], options: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

export interface GitHubCliOptions {
  /** Target repo as `owner/name`, used for every `gh` call (single MVP repo — README §1). */
  repo: string;
  /** Where per-run working trees are cloned. Each run gets `<workingRoot>/run-<id>`. */
  workingRoot: string;
  /** The GitHub remote each working tree fetches/pushes/PRs against. Defaults to the repo's HTTPS URL. */
  cloneUrl?: string;
  /**
   * A local checkout of the same repo to clone the working tree *from* (fast, offline) instead of
   * cloning over the network. When set, the working clone's `origin` is repointed to {@link cloneUrl}
   * so fetch/push/PR still target GitHub — the local path is only an object source, not the remote.
   */
  localRepo?: string;
  /** The `gh` binary. Defaults to `gh`. */
  ghCommand?: string;
  /** The `git` binary. Defaults to `git`. */
  gitCommand?: string;
  /** Injectable runner (for tests). Defaults to a real `child_process.execFile` wrapper. */
  exec?: ExecFn;
}

/** Raised when a `git`/`gh` command fails (non-zero exit). */
export class GitCommandError extends Error {
  constructor(
    public readonly file: string,
    public readonly args: string[],
    public readonly result: ExecResult,
  ) {
    super(`${file} ${args.join(' ')} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = 'GitCommandError';
  }
}

export class GitHubCli implements GitHub {
  private readonly repo: string;
  private readonly workingRoot: string;
  private readonly cloneUrl: string;
  private readonly localRepo?: string;
  private readonly ghCommand: string;
  private readonly gitCommand: string;
  private readonly exec: ExecFn;

  constructor(options: GitHubCliOptions) {
    // Normalize to canonical `owner/repo` so the `gh api repos/<repo>/…` paths are well-formed even when
    // the operator passed a URL or clone string (`--repo https://github.com/owner/repo`). See ./refs.
    this.repo = parseRepoRef(options.repo);
    this.workingRoot = options.workingRoot;
    this.cloneUrl = options.cloneUrl ?? `https://github.com/${this.repo}.git`;
    this.localRepo = options.localRepo;
    this.ghCommand = options.ghCommand ?? 'gh';
    this.gitCommand = options.gitCommand ?? 'git';
    this.exec = options.exec ?? defaultExec;
  }

  // --- GitHub API (needs network; gated behind RUN_REAL_GITHUB in tests) ------

  async readIssue(issueRef: string): Promise<Issue> {
    return this.viewIssue(issueNumber(issueRef), issueRef);
  }

  async updateIssue(input: UpdateIssueInput): Promise<Issue> {
    const args = ['issue', 'edit', String(input.number), '--repo', this.repo];
    if (input.title !== undefined) args.push('--title', input.title);
    if (input.body !== undefined) args.push('--body', input.body);
    await this.gh(args);
    return this.viewIssue(input.number);
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    // `gh issue create` prints the new issue's URL on stdout; the number is its trailing path segment.
    const stdout = await this.gh(['issue', 'create', '--repo', this.repo, '--title', input.title, '--body', input.body]);
    const number = issueNumberFromUrl(stdout.trim());
    return { ref: `${this.repo}#${number}`, number, title: input.title, body: input.body };
  }

  async postIssueComment(input: { issueNumber: number; body: string }): Promise<IssueComment> {
    // Use the REST API directly so we get the created comment's id, author, and timestamp back —
    // the fields the reply poller anchors on.
    const json = await this.gh(['api', `repos/${this.repo}/issues/${input.issueNumber}/comments`, '-f', `body=${input.body}`]);
    const parsed = JSON.parse(json) as RawIssueComment;
    return mapIssueComment(parsed, input.issueNumber, input.body);
  }

  async listIssueComments(issueNumber: number): Promise<IssueComment[]> {
    const json = await this.gh(['api', `repos/${this.repo}/issues/${issueNumber}/comments?per_page=100`]);
    const parsed = JSON.parse(json) as RawIssueComment[];
    return parsed.map((c) => mapIssueComment(c, issueNumber, c.body ?? ''));
  }

  async findOpenPrForBranch(branch: string): Promise<PullRequest | null> {
    try {
      const pr = await this.viewPrByBranch(branch);
      return pr.state === 'open' ? pr : null; // a closed/merged PR does not block opening a new one
    } catch (err) {
      if (err instanceof GitHubNotFoundError) return null;
      throw err;
    }
  }

  async openPr(input: OpenPrInput): Promise<PullRequest> {
    await this.gh([
      'pr', 'create', '--repo', this.repo,
      '--head', input.branch, '--base', input.base,
      '--title', input.title, '--body', input.body,
    ]);
    return this.viewPrByBranch(input.branch);
  }

  async getPr(prNumber: number): Promise<PullRequest> {
    return this.viewPr(prNumber);
  }

  async updatePr(input: UpdatePrInput): Promise<PullRequest> {
    const args = ['pr', 'edit', String(input.prNumber), '--repo', this.repo];
    if (input.title !== undefined) args.push('--title', input.title);
    if (input.body !== undefined) args.push('--body', input.body);
    await this.gh(args);
    return this.viewPr(input.prNumber);
  }

  async postComment(input: { prNumber: number; body: string }): Promise<Comment> {
    // Use the REST API directly so we get the created comment's id back.
    const json = await this.gh([
      'api', `repos/${this.repo}/issues/${input.prNumber}/comments`,
      '-f', `body=${input.body}`,
    ]);
    const parsed = JSON.parse(json) as { id: number };
    return { id: parsed.id, prNumber: input.prNumber, body: input.body };
  }

  async listPrComments(prNumber: number): Promise<PrComment[]> {
    // A PR is an issue under the hood, so its comment thread comes from the same REST endpoint as
    // issue comments — carrying the id/author/timestamp the PR Feedback Poller anchors on.
    const json = await this.gh(['api', `repos/${this.repo}/issues/${prNumber}/comments?per_page=100`]);
    const parsed = JSON.parse(json) as RawIssueComment[];
    return parsed.map((c) => ({ id: c.id, prNumber, author: c.user?.login ?? 'unknown', body: c.body ?? '', createdAt: c.created_at }));
  }

  // --- local working tree + git (no network) ----------------------------------

  async prepareWorkingTree(input: PrepareWorkingTreeInput): Promise<WorkingTree> {
    const path = join(this.workingRoot, `run-${input.runId}`);

    if (!existsSync(join(path, '.git'))) {
      if (this.localRepo) {
        // Clone fast/offline from a local checkout, then repoint origin at the GitHub remote so
        // fetch/push/PR target GitHub — the local path is only an object source, not the remote.
        await this.git(['clone', this.localRepo, path]);
        await this.git(['remote', 'set-url', 'origin', this.cloneUrl], path);
      } else {
        await this.git(['clone', this.cloneUrl, path]);
      }
    }
    await this.git(['fetch', 'origin'], path);

    if (await this.refExists(path, `refs/heads/${input.branch}`)) {
      // Local branch already here (idempotent re-preparation on a back-edge): keep its work.
      await this.git(['checkout', input.branch], path);
    } else if (await this.refExists(path, `refs/remotes/origin/${input.branch}`)) {
      // The branch was pushed but the local checkout is gone (fresh clone after the working
      // tree was lost, e.g. crash recovery). Restore it from the remote so previously pushed
      // commits are preserved — never reset to base (README §2 idempotency).
      await this.git(['checkout', '-B', input.branch, `origin/${input.branch}`], path);
    } else {
      // Brand-new branch: create it off the up-to-date base.
      await this.git(['checkout', '-B', input.branch, `origin/${input.base}`], path);
    }
    return { path, branch: input.branch, base: input.base };
  }

  async commitAndPush(input: CommitAndPushInput): Promise<CommitRef> {
    await this.git(['add', '-A'], input.workingDir);
    // Only commit when there is something staged, so re-running is a no-op, not an error.
    const status = await this.git(['status', '--porcelain'], input.workingDir);
    if (status.trim().length > 0) {
      await this.git(['commit', '-m', input.message], input.workingDir);
    }
    const sha = (await this.git(['rev-parse', 'HEAD'], input.workingDir)).trim();
    await this.git(['push', '-u', 'origin', input.branch], input.workingDir);
    return { sha };
  }

  async readDiff(input: ReadDiffInput): Promise<string> {
    // Diff the (local, latest-committed) branch against the up-to-date remote base, so it
    // works even when `base` is not the clone's checked-out default branch. (Not used to feed
    // code review — that agent inspects the diff itself via git tools, §3.6 — but kept as an
    // adapter capability the dashboard/API will use to display a run's diff.)
    return this.git(['diff', `origin/${input.base}...${input.branch}`], input.workingDir);
  }

  // --- helpers ----------------------------------------------------------------

  /** View an issue by number, building its `ref` from the configured repo unless one is supplied. */
  private async viewIssue(number: number, ref?: string): Promise<Issue> {
    const json = await this.gh(['issue', 'view', String(number), '--repo', this.repo, '--json', 'number,title,body']);
    const parsed = JSON.parse(json) as { number: number; title: string; body: string };
    return { ref: ref ?? `${this.repo}#${parsed.number}`, number: parsed.number, title: parsed.title, body: parsed.body ?? '' };
  }

  private async viewPr(prNumber: number): Promise<PullRequest> {
    const json = await this.gh([
      'pr', 'view', String(prNumber), '--repo', this.repo,
      '--json', 'number,headRefName,baseRefName,title,body,state,url',
    ]);
    return mapPr(JSON.parse(json) as RawPr);
  }

  private async viewPrByBranch(branch: string): Promise<PullRequest> {
    const json = await this.gh([
      'pr', 'view', branch, '--repo', this.repo,
      '--json', 'number,headRefName,baseRefName,title,body,state,url',
    ]);
    return mapPr(JSON.parse(json) as RawPr);
  }

  private async refExists(path: string, ref: string): Promise<boolean> {
    const result = await this.exec(this.gitCommand, ['-C', path, 'rev-parse', '--verify', '--quiet', ref], {});
    return result.code === 0;
  }

  /** Run a `git` command in `cwd`, returning stdout or throwing {@link GitCommandError}. */
  private async git(args: string[], cwd?: string): Promise<string> {
    const fullArgs = cwd ? ['-C', cwd, ...args] : args;
    const result = await this.exec(this.gitCommand, fullArgs, {});
    if (result.code !== 0) throw new GitCommandError(this.gitCommand, fullArgs, result);
    return result.stdout;
  }

  /** Run a `gh` command, returning stdout or throwing (mapping 404s to GitHubNotFoundError). */
  private async gh(args: string[]): Promise<string> {
    const result = await this.exec(this.ghCommand, args, {});
    if (result.code !== 0) {
      if (/not found|404|no pull requests found/i.test(result.stderr)) {
        throw new GitHubNotFoundError(`gh ${args.join(' ')}: ${result.stderr.trim()}`);
      }
      throw new GitCommandError(this.ghCommand, args, result);
    }
    return result.stdout;
  }
}

interface RawPr {
  number: number;
  headRefName: string;
  baseRefName: string;
  title: string;
  body: string;
  state: string;
  url: string;
}

function mapPr(raw: RawPr): PullRequest {
  return {
    number: raw.number,
    branch: raw.headRefName,
    base: raw.baseRefName,
    title: raw.title,
    body: raw.body ?? '',
    state: raw.state.toLowerCase() === 'merged' ? 'merged' : raw.state.toLowerCase() === 'closed' ? 'closed' : 'open',
    url: raw.url,
  };
}

/** Parse the issue number from a ref like `owner/repo#42` (or a bare `42`). */
export function issueNumber(issueRef: string): number {
  const afterHash = issueRef.includes('#') ? issueRef.slice(issueRef.lastIndexOf('#') + 1) : issueRef;
  const n = Number.parseInt(afterHash, 10);
  if (!Number.isInteger(n)) throw new Error(`cannot parse an issue number from ${JSON.stringify(issueRef)}`);
  return n;
}

/** The raw shape of a GitHub issue-comment object (`gh api .../comments`); extra fields ignored. */
interface RawIssueComment {
  id: number;
  user: { login: string } | null;
  body?: string;
  created_at: string;
}

function mapIssueComment(raw: RawIssueComment, issueNumber: number, body: string): IssueComment {
  return { id: raw.id, issueNumber, author: raw.user?.login ?? 'unknown', body, createdAt: raw.created_at };
}

/** Parse the issue number from a `gh issue create` URL like `https://github.com/o/r/issues/57`. */
export function issueNumberFromUrl(url: string): number {
  const m = /\/(\d+)(?:[?#].*)?\s*$/.exec(url);
  if (!m) throw new Error(`cannot parse an issue number from created-issue output ${JSON.stringify(url)}`);
  return Number(m[1]);
}

/** Default {@link ExecFn}: a promise wrapper over `child_process.execFile` that never rejects on
 * a non-zero exit (we branch on `code` instead), with a large buffer for diffs. Exported so the
 * repo-less {@link ./github-account.GitHubCliAccount} can reuse the same runner. */
export function defaultExec(file: string, args: string[], options: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // `timeout: 0` (the default when `timeoutMs` is undefined) means no limit, so run operations are
    // unaffected; a positive value kills a hung child with SIGTERM (surfaced below as a rejection).
    execFile(file, args, { cwd: options.cwd, timeout: options.timeoutMs ?? 0, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof (error as { code?: unknown }).code !== 'number') {
        reject(error); // spawn failure (binary not on PATH) or a timeout kill (code is null) — not a non-zero exit
        return;
      }
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}
