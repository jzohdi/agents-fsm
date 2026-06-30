import { describe, expect, it } from 'vitest';

import { parseIssueRef, parseRepoRef } from './refs';

describe('parseRepoRef', () => {
  it('passes through the canonical owner/repo form', () => {
    expect(parseRepoRef('jzohdi/tmux-speedrun')).toBe('jzohdi/tmux-speedrun');
  });

  it('strips the GitHub host from a browser URL', () => {
    expect(parseRepoRef('https://github.com/jzohdi/tmux-speedrun')).toBe('jzohdi/tmux-speedrun');
    expect(parseRepoRef('http://www.github.com/jzohdi/tmux-speedrun/')).toBe('jzohdi/tmux-speedrun');
    expect(parseRepoRef('github.com/jzohdi/tmux-speedrun')).toBe('jzohdi/tmux-speedrun');
  });

  it('ignores trailing path, .git, query, and fragment decoration', () => {
    expect(parseRepoRef('https://github.com/jzohdi/tmux-speedrun/issues/31')).toBe('jzohdi/tmux-speedrun');
    expect(parseRepoRef('https://github.com/jzohdi/tmux-speedrun.git')).toBe('jzohdi/tmux-speedrun');
    expect(parseRepoRef('git@github.com:jzohdi/tmux-speedrun.git')).toBe('jzohdi/tmux-speedrun');
    expect(parseRepoRef('jzohdi/tmux-speedrun#31')).toBe('jzohdi/tmux-speedrun');
  });

  it('throws on input with no owner/repo', () => {
    expect(() => parseRepoRef('not-a-repo')).toThrow(/owner\/repo/);
    expect(() => parseRepoRef('https://github.com/jzohdi')).toThrow(/owner\/repo/);
    expect(() => parseRepoRef('')).toThrow();
  });
});

describe('parseIssueRef', () => {
  it('parses the canonical owner/repo#N form', () => {
    expect(parseIssueRef('jzohdi/tmux-speedrun#31')).toEqual({
      repo: 'jzohdi/tmux-speedrun',
      number: 31,
      ref: 'jzohdi/tmux-speedrun#31',
    });
  });

  it('parses a pasted issue URL', () => {
    expect(parseIssueRef('https://github.com/jzohdi/tmux-speedrun/issues/31')).toEqual({
      repo: 'jzohdi/tmux-speedrun',
      number: 31,
      ref: 'jzohdi/tmux-speedrun#31',
    });
  });

  it('parses a pull-request URL the same way', () => {
    expect(parseIssueRef('https://github.com/o/r/pull/7')).toMatchObject({ repo: 'o/r', number: 7, ref: 'o/r#7' });
  });

  it('throws when there is a repo but no issue number', () => {
    expect(() => parseIssueRef('jzohdi/tmux-speedrun')).toThrow(/issue number/);
    expect(() => parseIssueRef('https://github.com/jzohdi/tmux-speedrun')).toThrow(/issue number/);
  });

  it('throws when there is no repo', () => {
    expect(() => parseIssueRef('#31')).toThrow(/owner\/repo/);
  });
});
