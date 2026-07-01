/**
 * User-scoped GitHub discovery for the new-run autocomplete (Layer 5, sibling of {@link GitHubCli}).
 *
 * Unlike {@link GitHubCli} — which is bound to one repo and services a run's side effects — this adapter
 * is **repo-less**: it answers "who am I, which repos are mine, what's open in them" for the logged-in
 * `gh` user. That's exactly what the dashboard's type-ahead needs, and it's why the daemon no longer has
 * to be pinned to a repo at startup just to power suggestions.
 *
 * Scope (chosen with the user): repos the user **owns** plus repos in **orgs they belong to**
 * (`affiliation=owner,organization_member`), and **all open issues** across those repos. Results are
 * cached with a short TTL and filtered in-process, so type-ahead is instant after the first hit and a
 * `gh` round-trip isn't paid per keystroke.
 *
 * Every `gh` call is best-effort: a failure (unauthenticated, offline, a search hiccup) yields an empty
 * list rather than breaking the dashboard — the same contract as {@link GitHubCli.suggestIssues}.
 */

import type { Suggestion } from './github';
import { defaultExec, type ExecFn } from './github-cli';

/** The one method the Orchestrator depends on to power `GET /suggestions` (the fake also implements it). */
export interface SuggestionSource {
  /** Repos + open issues matching `query` (empty → a useful default set). Repos first, then issues. */
  suggest(query: string): Promise<Suggestion[]>;
}

export interface GitHubCliAccountOptions {
  /** The `gh` binary. Defaults to `gh`. */
  ghCommand?: string;
  /** Injectable child-process runner (for tests). Defaults to the shared `child_process` wrapper. */
  exec?: ExecFn;
  /** Clock (for tests). Defaults to `Date.now`. */
  now?: () => number;
  /** How long the repo/issue cache is fresh before the next `suggest` refetches. Default 2 min. */
  ttlMs?: number;
  /** Per-`gh`-call timeout in ms — bounds a hung call so it can't wedge the (single-flight) cache. Default 10s. */
  timeoutMs?: number;
  /** Max repos to fetch (GitHub caps a page at 100). Default 100. */
  repoLimit?: number;
  /** Max open issues to fetch across all owners. Default 200. */
  issueLimit?: number;
  /** Max repo rows returned from a single `suggest`. Default 8. */
  repoResults?: number;
  /** Max issue rows returned from a single `suggest`. Default 25. */
  issueResults?: number;
}

interface RawRepo {
  full_name?: string;
  description?: string | null;
}

interface RawOrg {
  login?: string;
}

interface RawSearchIssue {
  repository?: { nameWithOwner?: string };
  number?: number;
  title?: string;
}

/** Cached discovery snapshot: the user's repos and their open issues, plus when they were fetched. */
interface Snapshot {
  repos: Suggestion[];
  issues: Suggestion[];
  fetchedAt: number;
}

export class GitHubCliAccount implements SuggestionSource {
  private readonly ghCommand: string;
  private readonly exec: ExecFn;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly callTimeoutMs: number;
  private readonly repoLimit: number;
  private readonly issueLimit: number;
  private readonly repoResults: number;
  private readonly issueResults: number;

  /** The logged-in user + their org logins — the "owners" we search. Resolved once, then reused. */
  private owners?: string[];
  private snapshot?: Snapshot;
  /** Single-flight guard: concurrent keystrokes await one refresh instead of spawning a `gh` storm. */
  private refreshing?: Promise<void>;

  constructor(options: GitHubCliAccountOptions = {}) {
    this.ghCommand = options.ghCommand ?? 'gh';
    this.exec = options.exec ?? defaultExec;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 120_000;
    this.callTimeoutMs = options.timeoutMs ?? 10_000;
    this.repoLimit = options.repoLimit ?? 100;
    this.issueLimit = options.issueLimit ?? 200;
    this.repoResults = options.repoResults ?? 8;
    this.issueResults = options.issueResults ?? 25;
  }

  async suggest(query: string): Promise<Suggestion[]> {
    await this.ensureFresh();
    const snap = this.snapshot;
    if (!snap) return [];
    const q = query.trim().toLowerCase();
    const match = (s: Suggestion): boolean => !q || s.ref.toLowerCase().includes(q) || s.title.toLowerCase().includes(q);
    const repos = snap.repos.filter(match).slice(0, this.repoResults);
    const issues = snap.issues.filter(match).slice(0, this.issueResults);
    return [...repos, ...issues]; // repos first so picking one can narrow the type-ahead to its issues
  }

  /** Refetch the repo/issue snapshot if it's missing or past its TTL, coalescing concurrent callers. */
  private async ensureFresh(): Promise<void> {
    if (this.snapshot && this.now() - this.snapshot.fetchedAt < this.ttlMs) return;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    await this.refreshing;
  }

  private async refresh(): Promise<void> {
    const owners = await this.resolveOwners();
    const [repos, issues] = await Promise.all([this.fetchRepos(), this.fetchIssues(owners)]);
    this.snapshot = { repos, issues, fetchedAt: this.now() };
  }

  /** The logged-in user's login + their org logins (both best-effort). Resolved once and memoized. */
  private async resolveOwners(): Promise<string[]> {
    if (this.owners) return this.owners;
    let login = '';
    try {
      login = (await this.gh(['api', 'user', '--jq', '.login'])).trim();
    } catch {
      return []; // unauthenticated / offline — no owner to scope discovery to
    }
    const owners = login ? [login] : [];
    try {
      const orgs = JSON.parse(await this.gh(['api', 'user/orgs'])) as RawOrg[];
      for (const o of orgs) if (o.login && !owners.includes(o.login)) owners.push(o.login);
    } catch {
      /* no org read scope / offline — the user's own repos are still discoverable */
    }
    // Only memoize once we actually know the user; a transient auth failure shouldn't pin an empty list.
    if (owners.length > 0) this.owners = owners;
    return owners;
  }

  /** Repos the user owns or belongs to via an org, newest-touched first. */
  private async fetchRepos(): Promise<Suggestion[]> {
    try {
      const path = `user/repos?affiliation=owner,organization_member&sort=updated&per_page=${this.repoLimit}`;
      const raw = JSON.parse(await this.gh(['api', path])) as RawRepo[];
      return raw
        .filter((r): r is RawRepo & { full_name: string } => typeof r.full_name === 'string')
        .map((r) => ({ kind: 'repo' as const, ref: r.full_name, repo: r.full_name, number: 0, title: r.description ?? '' }));
    } catch {
      return [];
    }
  }

  /** All open issues across the user's owners (one `gh search` with repeated `--owner`). */
  private async fetchIssues(owners: string[]): Promise<Suggestion[]> {
    if (owners.length === 0) return [];
    try {
      const args = ['search', 'issues', '--state', 'open', '--limit', String(this.issueLimit), '--json', 'repository,number,title'];
      for (const o of owners) args.push('--owner', o);
      const raw = JSON.parse(await this.gh(args)) as RawSearchIssue[];
      return raw
        .filter((i) => i.repository?.nameWithOwner && typeof i.number === 'number')
        .map((i) => ({
          kind: 'issue' as const,
          ref: `${i.repository!.nameWithOwner}#${i.number}`,
          repo: i.repository!.nameWithOwner!,
          number: i.number!,
          title: i.title ?? `Issue ${i.number}`,
        }));
    } catch {
      return [];
    }
  }

  /** Run a `gh` command, returning stdout. Throws on a non-zero exit, a spawn failure, or a timeout —
   *  callers treat any of those as "no data", so a hung `gh` can't wedge the single-flight cache. */
  private async gh(args: string[]): Promise<string> {
    const { code, stdout, stderr } = await this.exec(this.ghCommand, args, { timeoutMs: this.callTimeoutMs });
    if (code !== 0) throw new Error(`gh ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`);
    return stdout;
  }
}
