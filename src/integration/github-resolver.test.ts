/**
 * Per-repo adapter resolution tests (Milestone 8 Phase A). The single-repo wrap, the type guard, and
 * the enrolled resolver's lookup + memoization + clear unenrolled error.
 */

import { describe, expect, it } from 'vitest';

import { openDb } from '../store/db';
import { Repository, type Repo } from '../store/repository';
import { FakeGitHub } from './github-fake';
import { EnrolledRepoResolver, isRepoResolver, singleRepoResolver, type RepoContext } from './github-resolver';

describe('singleRepoResolver', () => {
  it('returns the same fixed context for any ref, and invalidate is a harmless no-op', () => {
    const context: RepoContext = { github: new FakeGitHub(), baseBranch: 'develop' };
    const resolver = singleRepoResolver(context);
    expect(resolver.for('any/repo')).toBe(context);
    expect(resolver.for('other/repo')).toBe(context);
    expect(() => resolver.invalidate('any/repo')).not.toThrow();
  });
});

describe('isRepoResolver', () => {
  it('distinguishes a resolver from a bare GitHub adapter', () => {
    expect(isRepoResolver(singleRepoResolver({ github: new FakeGitHub(), baseBranch: 'main' }))).toBe(true);
    expect(isRepoResolver(new FakeGitHub())).toBe(false);
  });
});

describe('EnrolledRepoResolver', () => {
  function setup() {
    const repo = new Repository(openDb(':memory:'));
    repo.upsertRepo({ repoRef: 'acme/web', workingRoot: './w/web', baseBranch: 'develop' });
    repo.upsertRepo({ repoRef: 'acme/api', workingRoot: './w/api' }); // baseBranch defaults to main
    const built: string[] = []; // records each (repoRef) a fresh adapter was built for
    const resolver = new EnrolledRepoResolver(
      (ref) => repo.getRepo(ref),
      (row: Repo) => {
        built.push(row.repoRef);
        return new FakeGitHub({ repoRef: row.repoRef });
      },
    );
    return { repo, resolver, built };
  }

  it('builds the adapter from the row and carries the row’s base branch', () => {
    const { resolver } = setup();
    expect(resolver.for('acme/web').baseBranch).toBe('develop');
    expect(resolver.for('acme/api').baseBranch).toBe('main');
  });

  it('memoizes one adapter per repo and resolves distinct repos to distinct adapters', () => {
    const { resolver, built } = setup();
    const web1 = resolver.for('acme/web').github;
    const web2 = resolver.for('acme/web').github;
    const api = resolver.for('acme/api').github;

    expect(web1).toBe(web2); // same instance reused
    expect(web1).not.toBe(api); // a different repo gets a different adapter
    expect(built).toEqual(['acme/web', 'acme/api']); // each built exactly once
  });

  it('looks up (and caches) case-insensitively', () => {
    const { resolver, built } = setup();
    const lower = resolver.for('acme/web').github;
    const upper = resolver.for('ACME/WEB').github;
    expect(upper).toBe(lower);
    expect(built).toEqual(['acme/web']); // not built twice for the casing variant
  });

  it('throws an actionable error for an unenrolled repo', () => {
    const { resolver } = setup();
    expect(() => resolver.for('ghost/repo')).toThrow(/not enrolled: ghost\/repo/);
  });

  it('invalidate drops the cache so a re-enrolled repo rebuilds from the updated row', () => {
    const { repo, resolver, built } = setup();
    expect(resolver.for('acme/web').baseBranch).toBe('develop'); // resolves + caches

    repo.upsertRepo({ repoRef: 'acme/web', workingRoot: './w/web', baseBranch: 'main' }); // re-enroll
    expect(resolver.for('acme/web').baseBranch).toBe('develop'); // still the cached adapter

    resolver.invalidate('acme/web');
    expect(resolver.for('acme/web').baseBranch).toBe('main'); // rebuilt from the new row
    expect(built).toEqual(['acme/web', 'acme/web']); // built once, then once more after invalidate
  });
});
