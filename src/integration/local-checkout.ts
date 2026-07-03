/**
 * Local-checkout validation (Milestone 12 — the "local directory" source mode).
 *
 * When an operator points a repo at a directory on their machine (so the fleet can service runs via
 * `git worktree` instead of cloning from GitHub), we must confirm the directory is *actually a checkout
 * of the linked repo* — otherwise a run would silently operate on the wrong codebase (the failure this
 * whole feature exists to prevent). This is a pure, offline check: the path is a git repo and its
 * `origin` remote resolves to the same `owner/repo` as the enrolled ref.
 *
 * The child-process runner is the same injectable {@link ExecFn} the adapter uses, so the check is
 * unit-testable without touching a real filesystem or git.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ExecFn } from './github-cli';
import { parseRepoRef } from './refs';

/** The outcome of {@link validateLocalCheckout}: `ok`, or a human-readable `reason` the UI shows. */
export type CheckoutValidation = { ok: true } | { ok: false; reason: string };

/**
 * Whether `dir` is a git checkout whose `origin` remote is the GitHub repo `expectedRepoRef`
 * (canonical `owner/repo`, matched case-insensitively). Returns an actionable `reason` on any
 * mismatch so the operator sees *why* the directory was rejected.
 */
export async function validateLocalCheckout(
  dir: string,
  expectedRepoRef: string,
  exec: ExecFn,
  gitCommand = 'git',
): Promise<CheckoutValidation> {
  const trimmed = dir.trim();
  if (!trimmed) return { ok: false, reason: 'no directory was provided' };
  if (!existsSync(trimmed)) return { ok: false, reason: `no such directory: ${trimmed}` };
  if (!existsSync(join(trimmed, '.git'))) {
    return { ok: false, reason: `${trimmed} is not a git repository (no .git found)` };
  }

  const result = await exec(gitCommand, ['-C', trimmed, 'remote', 'get-url', 'origin'], {});
  if (result.code !== 0) {
    return { ok: false, reason: `${trimmed} has no "origin" remote — point it at ${expectedRepoRef} first` };
  }

  let actual: string;
  try {
    actual = parseRepoRef(result.stdout.trim());
  } catch {
    return { ok: false, reason: `could not read a GitHub repo from origin (${result.stdout.trim() || 'empty'})` };
  }
  if (actual.toLowerCase() !== parseRepoRef(expectedRepoRef).toLowerCase()) {
    return { ok: false, reason: `that directory is a checkout of ${actual}, not ${expectedRepoRef}` };
  }
  return { ok: true };
}
