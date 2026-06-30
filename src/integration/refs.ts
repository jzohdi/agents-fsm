/**
 * Repo / issue reference normalization (Layer 5 input hygiene).
 *
 * Operators name repos and issues in whatever form is at hand — `owner/repo`, a browser URL
 * (`https://github.com/owner/repo/issues/31`), or an `scp`-style clone URL (`git@github.com:owner/repo.git`).
 * The `gh api repos/<repo>/…` paths the adapter builds require the **canonical `owner/repo`** form, so a
 * pasted URL produces a broken path ("unsupported protocol scheme"). These pure helpers normalize any of
 * those inputs to the canonical form once, at the edges (the adapter constructor + the start commands),
 * so the rest of the system only ever sees `owner/repo` and `owner/repo#N`.
 */

/** A GitHub login / repo-name segment: letters, digits, `.`, `_`, `-`. */
const NAME = /^[\w.-]+$/;

/** Strip scheme, host, and `git@github.com:` / `.git` decoration, leaving the `owner/repo/...` path. */
function stripHost(input: string): string {
  return input
    .trim()
    .replace(/^git@github\.com:/i, '') // scp-style clone URL
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // any scheme://
    .replace(/^www\./i, '')
    .replace(/^github\.com\//i, ''); // bare host
}

/**
 * Normalize a repo reference to canonical `owner/repo`. Accepts `owner/repo`, full GitHub URLs (with or
 * without a trailing `/issues/N`, `/pull/N`, `.git`, query, or fragment), and `git@github.com:owner/repo.git`.
 * Throws on input that has no recognizable `owner/repo`.
 */
export function parseRepoRef(input: string): string {
  const parts = stripHost(input).split('/');
  const owner = (parts[0] ?? '').split(/[#?]/)[0]!;
  const repo = (parts[1] ?? '').split(/[#?]/)[0]!.replace(/\.git$/i, '');
  if (!NAME.test(owner) || !NAME.test(repo)) {
    throw new Error(`cannot parse an "owner/repo" from ${JSON.stringify(input)}`);
  }
  return `${owner}/${repo}`;
}

export interface ParsedIssueRef {
  /** Canonical `owner/repo`. */
  repo: string;
  number: number;
  /** Canonical `owner/repo#N`. */
  ref: string;
}

/**
 * Normalize an issue reference to `{ repo, number, ref }`. Accepts `owner/repo#N`, an issue/PR URL
 * (`https://github.com/owner/repo/issues/31`), and the same forms `parseRepoRef` takes plus a number.
 * Throws when no repo or no issue number can be found.
 */
export function parseIssueRef(input: string): ParsedIssueRef {
  const repo = parseRepoRef(input);
  // Prefer an explicit /issues/N or /pull/N path segment, else a #N fragment.
  const match = /\/(?:issues|pull)\/(\d+)/i.exec(input) ?? /#(\d+)\b/.exec(input);
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`cannot parse an issue number from ${JSON.stringify(input)}`);
  }
  return { repo, number, ref: `${repo}#${number}` };
}
