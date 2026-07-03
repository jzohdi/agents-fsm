/**
 * Unit tests for the local-checkout validator (Milestone 12). The filesystem checks use a real temp dir
 * (cheap), while `git remote get-url origin` is exercised through an injected {@link ExecFn} so the
 * origin-mismatch cases need no real git remotes.
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ExecFn, ExecResult } from './github-cli';
import { validateLocalCheckout } from './local-checkout';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A temp directory, optionally with a `.git` entry so it reads as a git checkout. */
function tempDir(withGit: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'af-checkout-'));
  dirs.push(dir);
  if (withGit) mkdirSync(join(dir, '.git'));
  return dir;
}

/** An {@link ExecFn} that returns `origin` for `git remote get-url origin`, or a non-zero exit. */
function originExec(origin: string | null): ExecFn {
  return async (_file, args): Promise<ExecResult> => {
    if (args.includes('remote') && args.includes('get-url')) {
      return origin === null ? { code: 1, stdout: '', stderr: 'error: No such remote' } : { code: 0, stdout: `${origin}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

describe('validateLocalCheckout', () => {
  it('accepts a git checkout whose origin resolves to the linked repo (https and ssh remotes)', async () => {
    const dir = tempDir(true);
    expect(await validateLocalCheckout(dir, 'owner/repo', originExec('https://github.com/owner/repo.git'))).toEqual({ ok: true });
    expect(await validateLocalCheckout(dir, 'owner/repo', originExec('git@github.com:owner/repo.git'))).toEqual({ ok: true });
    // Repo refs are case-insensitive.
    expect(await validateLocalCheckout(dir, 'Owner/Repo', originExec('https://github.com/owner/repo'))).toEqual({ ok: true });
  });

  it('rejects a directory that is a checkout of a different repo (the wrong-directory guard)', async () => {
    const dir = tempDir(true);
    const result = await validateLocalCheckout(dir, 'owner/repo', originExec('https://github.com/someone/else.git'));
    expect(result).toEqual({ ok: false, reason: 'that directory is a checkout of someone/else, not owner/repo' });
  });

  it('rejects a missing directory, a non-git directory, and one with no origin remote', async () => {
    expect(await validateLocalCheckout('/no/such/place/at/all', 'owner/repo', originExec('x'))).toMatchObject({ ok: false });
    expect((await validateLocalCheckout('/no/such/place/at/all', 'owner/repo', originExec('x')) as { reason: string }).reason).toMatch(/no such directory/);

    const notGit = tempDir(false);
    expect((await validateLocalCheckout(notGit, 'owner/repo', originExec('x')) as { reason: string }).reason).toMatch(/not a git repository/);

    const noOrigin = tempDir(true);
    expect((await validateLocalCheckout(noOrigin, 'owner/repo', originExec(null)) as { reason: string }).reason).toMatch(/no "origin" remote/);
  });

  it('rejects an empty path and an origin that is not a GitHub repo url', async () => {
    expect((await validateLocalCheckout('   ', 'owner/repo', originExec('x')) as { reason: string }).reason).toMatch(/no directory/);
    const dir = tempDir(true);
    expect((await validateLocalCheckout(dir, 'owner/repo', originExec('not-a-url')) as { reason: string }).reason).toMatch(/could not read a GitHub repo/);
  });
});
