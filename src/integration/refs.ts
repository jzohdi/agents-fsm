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

/** A GitHub login / repo-name segment: letters, digits, `.`, `_`, `-` — but never `.` or `..`, which
 *  would turn `repos/<owner>/<repo>/…` API paths into traversals (`.github` is a valid name). */
const NAME = /^(?!\.\.?$)[\w.-]+$/;

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
  // A GitHub login never starts with `-`; refusing it keeps an owner from ever reading as an option.
  if (!NAME.test(owner) || !NAME.test(repo) || owner.startsWith('-')) {
    throw new Error(`cannot parse an "owner/repo" from ${JSON.stringify(input)}`);
  }
  return `${owner}/${repo}`;
}

/** A remote's user or host name: starts with a letter or digit, so it never reads as an ssh option. */
const REMOTE_NAME = /^[A-Za-z0-9][\w.-]*$/;
/** scp-style `user@host:path` (git's own short form); the path may not start with `-` either. */
const SCP_REMOTE = /^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][A-Za-z0-9.-]*:(?!-)\S+$/;

/**
 * True for a network Git remote an API caller may enroll: `https://…`, `ssh://…` or `user@host:path`.
 * Local paths, `file://`, `ext::` and anything that could read as a `git` or `ssh` option are refused,
 * and so are credentials in the URL — an ssh password, or any `https://` user part, which is how a token
 * rides (`https://<token>@github.com/…`): secrets live in the environment, never in the repos table
 * (which `GET /repos` returns). An `ssh://` user name (`git@`) is fine.
 */
export function isRemoteCloneUrl(url: string): boolean {
  if (/[\s\x00-\x1f\x7f]/.test(url)) return false; // whitespace or control characters
  if (!url.startsWith('https://') && !url.startsWith('ssh://')) return SCP_REMOTE.test(url);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // e.g. a port above 65535
  }
  return (
    REMOTE_NAME.test(parsed.hostname) &&
    (parsed.username === '' || (parsed.protocol === 'ssh:' && REMOTE_NAME.test(parsed.username))) &&
    parsed.password === '' &&
    parsed.pathname.length > 1
  );
}

/**
 * True for a plausible branch name: starts with a letter or digit, uses only letters, digits, `.`, `_`,
 * `/` and `-`, and avoids the forms `git check-ref-format` rejects (`..`, `//`, a component starting
 * with `.` or ending in `.lock`, a trailing `/` or `.`). It also refuses names git resolves to something
 * other than a branch: `HEAD`, `FETCH_HEAD`-style names and full `refs/…` paths. Stricter than git, so
 * it can never be read as an option.
 */
export function isValidBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9][\w./-]*$/.test(name) &&
    !/\.\.|\/\/|\/\.|\.lock\//.test(name) &&
    !/(\/|\.|\.lock)$/.test(name) &&
    !/^(\w*_)?HEAD$|^refs\//.test(name)
  );
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
