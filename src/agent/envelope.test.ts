/**
 * Envelope contract tests (Milestone 2): the agent output boundary. These pin the exact
 * shape the orchestrator trusts, so a drifting agent (or adapter) is rejected, not coerced.
 */

import { describe, expect, it } from 'vitest';

import { parseEnvelope, parseReviewVerdict } from './envelope';

describe('parseEnvelope', () => {
  it('accepts a minimal envelope', () => {
    const r = parseEnvelope({ requestedTransition: 'proceed' });
    expect(r).toEqual({ ok: true, value: { requestedTransition: 'proceed' } });
  });

  it('accepts target, reason, artifacts, and flags', () => {
    const raw = {
      requestedTransition: 'request_changes',
      target: 'backend',
      reason: { note: 'fix it' },
      artifacts: [{ kind: 'pr', locator: { pr: 7 } }],
      flags: { needs_frontend: false },
    };
    const r = parseEnvelope(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(raw);
  });

  it('rejects a missing/empty requestedTransition', () => {
    expect(parseEnvelope({}).ok).toBe(false);
    expect(parseEnvelope({ requestedTransition: '' }).ok).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(parseEnvelope({ requestedTransition: 'proceed', surprise: 1 }).ok).toBe(false);
  });

  it('rejects non-boolean flag values', () => {
    expect(parseEnvelope({ requestedTransition: 'proceed', flags: { needs_frontend: 'yes' } }).ok).toBe(false);
  });

  it('accepts a string array of review comments, and rejects non-strings', () => {
    expect(parseEnvelope({ requestedTransition: 'approve', comments: ['nit', 'fix'] }).ok).toBe(true);
    expect(parseEnvelope({ requestedTransition: 'approve', comments: [{ body: 'x' }] }).ok).toBe(false);
  });

  it('rejects an artifact without a kind', () => {
    expect(parseEnvelope({ requestedTransition: 'proceed', artifacts: [{ locator: {} }] }).ok).toBe(false);
  });

  it('reports a readable error on failure', () => {
    const r = parseEnvelope({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('requestedTransition');
  });
});

describe('parseReviewVerdict', () => {
  it('accepts an acceptable verdict', () => {
    expect(parseReviewVerdict({ acceptable: true })).toEqual({ ok: true, value: { acceptable: true } });
  });

  it('accepts a rejecting verdict with notes', () => {
    const r = parseReviewVerdict({ acceptable: false, notes: 'tighten naming' });
    expect(r.ok).toBe(true);
  });

  it('rejects a missing or non-boolean acceptable', () => {
    expect(parseReviewVerdict({}).ok).toBe(false);
    expect(parseReviewVerdict({ acceptable: 'maybe' }).ok).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(parseReviewVerdict({ acceptable: true, verdict: 'lgtm' }).ok).toBe(false);
  });
});
