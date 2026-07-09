/**
 * Operator-context composer tests (jzohdi/agents-fsm#5, Layer 1–3 assembly).
 *
 * The pure composer `composeOperatorContext({ global, stage, issue })` assembles the three operator
 * context layers into one labeled, delimited block. These lock the invariants the interface pins:
 *   - INV-ORDER  — surviving layers appear in global → stage → issue order.
 *   - INV-EMPTY  — a null / '' / whitespace-only layer contributes nothing (no stray separators, no
 *                  empty wrapper); all three empty ⇒ '' (callers inject nothing).
 *   - the block carries the stable `## Operator-provided context` heading + label so agents (and the
 *     prompt-injection point) can locate operator guidance and distinguish it from the core contract.
 *   - each layer is trimmed before it is placed.
 *
 * Also pins the setting-key constants + the per-stage allow-list co-located in `harness.ts`.
 */

import { describe, expect, it } from 'vitest';

import { CONTEXT_GLOBAL_SETTING_KEY, CONTEXT_STAGE_TYPES, contextStageKey } from './harness';
import { OPERATOR_CONTEXT_HEADING, composeOperatorContext } from './operator-context';

describe('composeOperatorContext', () => {
  it('exports the stable heading marker', () => {
    expect(OPERATOR_CONTEXT_HEADING).toBe('## Operator-provided context');
  });

  it('joins all three layers in global → stage → issue order under the labeled heading (INV-ORDER)', () => {
    const out = composeOperatorContext({ global: 'GLOBAL_BASE', stage: 'STAGE_RULE', issue: 'ISSUE_NOTE' });

    // The block starts with the marker heading and carries the operator label.
    expect(out.startsWith(OPERATOR_CONTEXT_HEADING)).toBe(true);
    expect(out).toContain('Standing guidance');

    // Every layer is present, and strictly in broadest-to-narrowest order.
    expect(out).toContain('GLOBAL_BASE');
    expect(out).toContain('STAGE_RULE');
    expect(out).toContain('ISSUE_NOTE');
    expect(out.indexOf('GLOBAL_BASE')).toBeLessThan(out.indexOf('STAGE_RULE'));
    expect(out.indexOf('STAGE_RULE')).toBeLessThan(out.indexOf('ISSUE_NOTE'));
  });

  it('omits empty / whitespace / null layers cleanly, keeping the survivors in order (INV-EMPTY)', () => {
    const out = composeOperatorContext({ global: 'GLOBAL_BASE', stage: '   ', issue: null });

    expect(out).toContain(OPERATOR_CONTEXT_HEADING);
    expect(out).toContain('GLOBAL_BASE');
    // A dropped layer leaves no marker and no stray blank-run artifacts.
    expect(out).not.toContain('STAGE_RULE');
    expect(out).not.toMatch(/\n{3,}/); // separators never stack where a layer was omitted

    // A middle-only survivor still composes (order holds with the ends dropped).
    const middle = composeOperatorContext({ global: '', stage: 'STAGE_RULE', issue: '' });
    expect(middle).toContain(OPERATOR_CONTEXT_HEADING);
    expect(middle).toContain('STAGE_RULE');
    expect(middle).not.toContain('GLOBAL_BASE');
  });

  it('returns the empty string when every layer is empty (INV-EMPTY — inject nothing)', () => {
    expect(composeOperatorContext({})).toBe('');
    expect(composeOperatorContext({ global: null, stage: undefined, issue: '' })).toBe('');
    expect(composeOperatorContext({ global: '   ', stage: '\n\t ', issue: '' })).toBe('');
  });

  it('trims each layer before placing it', () => {
    const out = composeOperatorContext({ global: '   padded_global   ', stage: null, issue: null });
    expect(out).toContain('padded_global');
    expect(out).not.toContain('   padded_global   '); // the surrounding whitespace is gone
  });
});

describe('operator-context setting keys (harness.ts)', () => {
  it('pins the global base settings key', () => {
    expect(CONTEXT_GLOBAL_SETTING_KEY).toBe('context_global');
  });

  it('derives a per-stage settings key namespaced by stage', () => {
    expect(contextStageKey('frontend')).toBe('context_stage:frontend');
    expect(contextStageKey('code_review')).toBe('context_stage:code_review');
  });

  it('offers per-stage context only for the canonical FSM stages (INV-STAGES)', () => {
    expect([...CONTEXT_STAGE_TYPES].sort()).toEqual(
      ['backend', 'code_review', 'frontend', 'interface_design', 'plan', 'plan_review', 'tdd', 'triage'].sort(),
    );
    // Pseudo-stages are deliberately excluded from the per-stage surface.
    expect(CONTEXT_STAGE_TYPES).not.toContain('chat');
    expect(CONTEXT_STAGE_TYPES).not.toContain('advise');
    expect(CONTEXT_STAGE_TYPES).not.toContain('resolve_conflicts');
  });
});
