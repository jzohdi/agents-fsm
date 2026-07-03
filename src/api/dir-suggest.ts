/**
 * Directory-path suggestions for the dashboard's local-checkout picker (Milestone 12 UI).
 *
 * A web page cannot read an absolute path out of the browser's native folder dialog (the sandbox
 * only exposes *relative* paths), so the dashboard can't open Finder and hand us a location. The
 * daemon, however, runs on the operator's machine — so it powers the next-best thing: as the
 * operator types a path, `GET /fs/dirs?q=` returns the matching directories on disk, and the input
 * becomes a click-to-drill folder browser.
 *
 * Read-only and names-only by design: this is an operator-local control-plane daemon (no auth
 * model), so the endpoint must never read file contents or mutate anything — it lists directory
 * names, exactly what the operator's own shell tab-completion shows.
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Max suggestions returned — enough to scan, small enough to render as a dropdown. */
const LIMIT = 12;

/**
 * Directories completing the partial path `query`, absolute, sorted, capped at {@link LIMIT}.
 *
 * Semantics match shell tab-completion: a trailing `/` lists the directory's children; otherwise
 * the last segment is a prefix filter (case-insensitive) on its parent's children. `~`/`~/…`
 * expand to the home directory, and an empty query starts there. Hidden directories are shown only
 * when the prefix itself starts with `.`. Unreadable/nonexistent paths yield `[]`, never a throw.
 * `home` is injectable for tests.
 */
export function suggestDirs(query: string, home: string = homedir()): string[] {
  let q = query.trim();
  if (q === '' || q === '~') q = `${home}/`;
  else if (q.startsWith('~/')) q = join(home, q.slice(2));
  if (!q.startsWith('/')) return []; // only absolute paths make sense to the daemon

  const base = q.endsWith('/') ? q : dirname(q);
  const prefix = q.endsWith('/') ? '' : basename(q);
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || (e.isSymbolicLink() && isDirBehindLink(join(base, e.name)))))
      .map((e) => e.name)
      .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()))
      .filter((n) => prefix.startsWith('.') || !n.startsWith('.'))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, LIMIT)
      .map((n) => join(base, n));
  } catch {
    return []; // nonexistent or unreadable base — no suggestions, no error
  }
}

/** Whether a symlink points at a directory (a `~/code → /Volumes/...` alias should still complete). */
function isDirBehindLink(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // broken link
  }
}
