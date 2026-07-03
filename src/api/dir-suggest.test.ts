/**
 * Unit tests for the directory-path completions (Milestone 12 UI). Uses a real temp directory tree —
 * the function is a thin wrapper over readdir, so real-fs evidence is cheap and higher fidelity than
 * a mocked fs.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { suggestDirs } from './dir-suggest';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A temp tree: alpha/, beta/, Brave/, .hidden/, a file, and a symlink to a directory. */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'af-dirs-'));
  roots.push(root);
  for (const d of ['alpha', 'beta', 'Brave', '.hidden']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'not-a-dir.txt'), 'x');
  symlinkSync(join(root, 'alpha'), join(root, 'linked'));
  return root;
}

describe('suggestDirs', () => {
  it('lists a directory\'s children on a trailing slash — dirs and dir-symlinks only, hidden excluded', () => {
    const root = makeTree();
    expect(suggestDirs(`${root}/`)).toEqual([join(root, 'alpha'), join(root, 'beta'), join(root, 'Brave'), join(root, 'linked')].sort((a, b) => a.localeCompare(b)));
  });

  it('filters by the last segment as a case-insensitive prefix', () => {
    const root = makeTree();
    expect(suggestDirs(join(root, 'b'))).toEqual([join(root, 'beta'), join(root, 'Brave')].sort((a, b) => a.localeCompare(b)));
    expect(suggestDirs(join(root, 'alp'))).toEqual([join(root, 'alpha')]);
  });

  it('shows hidden directories only when the prefix itself starts with a dot', () => {
    const root = makeTree();
    expect(suggestDirs(join(root, '.h'))).toEqual([join(root, '.hidden')]);
    expect(suggestDirs(`${root}/`)).not.toContain(join(root, '.hidden'));
  });

  it('expands ~ to the (injectable) home directory, and starts there for an empty query', () => {
    const root = makeTree();
    expect(suggestDirs('~/alp', root)).toEqual([join(root, 'alpha')]);
    expect(suggestDirs('', root)).toContain(join(root, 'beta'));
    expect(suggestDirs('~', root)).toContain(join(root, 'beta'));
  });

  it('returns [] for a relative path, a nonexistent base, and an unreadable query — never throws', () => {
    expect(suggestDirs('relative/path')).toEqual([]);
    expect(suggestDirs('/no/such/base/anywhere/x')).toEqual([]);
  });
});
