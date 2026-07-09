/**
 * System-prompt composition tests (Milestone 4b — plans/milestone-4.md §3.4).
 *
 * Loads the *real* bundled prompt files and asserts the composition rule: base + stage role +
 * phase instructions (for self_review / simplify) + the matching output contract (verdict for
 * self_review, envelope otherwise). Also guards the invariant that every stage with an agent recipe
 * in the default config has a role prompt — so adding a stage to the FSM without its prompt fails a
 * test instead of a paid run.
 */

import { describe, expect, it } from 'vitest';

import { loadDefaultConfig } from '../fsm/config';
import { createSystemPromptFn } from './prompts';

// Distinctive headings from each prompt file, used to assert what a composed prompt contains.
const BASE = 'automated software-delivery pipeline';
const ENVELOPE_CONTRACT = 'Output contract — work envelope';
const VERDICT_CONTRACT = 'Output contract — review verdict';
const TRIAGE_CONTRACT = 'Output contract — triage decision';
const SELF_REVIEW = 'This phase: self-review (correctness)';
const SIMPLIFY = 'This phase: fix and simplify';

describe('createSystemPromptFn — composition', () => {
  const systemPrompt = createSystemPromptFn();

  it('produce = base + stage role + envelope contract (no phase or verdict text)', () => {
    const prompt = systemPrompt('plan', 'produce');
    expect(prompt).toContain(BASE);
    expect(prompt).toContain('## Your stage: plan');
    expect(prompt).toContain(ENVELOPE_CONTRACT);
    expect(prompt).not.toContain(VERDICT_CONTRACT);
    expect(prompt).not.toContain(SELF_REVIEW);
    expect(prompt).not.toContain(SIMPLIFY);
  });

  it('self_review = base + stage role + self-review phase + verdict contract', () => {
    const prompt = systemPrompt('plan', 'self_review');
    expect(prompt).toContain(BASE);
    expect(prompt).toContain('## Your stage: plan');
    expect(prompt).toContain(SELF_REVIEW);
    expect(prompt).toContain(VERDICT_CONTRACT);
    expect(prompt).not.toContain(ENVELOPE_CONTRACT);
    expect(prompt).not.toContain(SIMPLIFY);
  });

  it('simplify = base + stage role + simplify phase + envelope contract', () => {
    const prompt = systemPrompt('frontend', 'simplify');
    expect(prompt).toContain('## Your stage: frontend');
    expect(prompt).toContain(SIMPLIFY);
    expect(prompt).toContain(ENVELOPE_CONTRACT);
    expect(prompt).not.toContain(VERDICT_CONTRACT);
    expect(prompt).not.toContain(SELF_REVIEW);
  });

  it('composes a distinct role per stage', () => {
    expect(systemPrompt('triage', 'produce')).toContain('## Your stage: triage');
    expect(systemPrompt('code_review', 'produce')).toContain('## Your stage: code review');
  });

  it('gives triage its own decision contract, not the work envelope or verdict', () => {
    const prompt = systemPrompt('triage', 'produce');
    expect(prompt).toContain(TRIAGE_CONTRACT);
    expect(prompt).not.toContain(ENVELOPE_CONTRACT);
    expect(prompt).not.toContain(VERDICT_CONTRACT);
  });

  it('composes chat as base + the chat phase, with its own inline contract (no envelope/verdict)', () => {
    const prompt = systemPrompt('chat', 'produce');
    expect(prompt).toContain(BASE);
    expect(prompt).toContain('Phase: operator chat');
    expect(prompt).toContain('"response"');
    expect(prompt).not.toContain(ENVELOPE_CONTRACT);
    expect(prompt).not.toContain(VERDICT_CONTRACT);
  });

  it('composes advise as base + the advise phase, with its own inline contract (no envelope/verdict)', () => {
    const prompt = systemPrompt('advise', 'produce');
    expect(prompt).toContain(BASE);
    expect(prompt).toMatch(/advisor/i); // the read-only escalation-resolution advisor role
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"options"');
    expect(prompt).not.toContain(ENVELOPE_CONTRACT);
    expect(prompt).not.toContain(VERDICT_CONTRACT);
  });

  it('throws for a stage with no role prompt (fail fast, never a half-formed prompt)', () => {
    expect(() => systemPrompt('no_such_stage', 'produce')).toThrowError(/No stage prompt for "no_such_stage"/);
  });

  it('has a role prompt for every stage that has an agent recipe', () => {
    const systemPromptFn = createSystemPromptFn();
    const { agents } = loadDefaultConfig();
    for (const stage of Object.keys(agents)) {
      expect(() => systemPromptFn(stage, 'produce'), `missing prompt for stage "${stage}"`).not.toThrow();
    }
  });
});

// Operator-provided context injection (jzohdi/agents-fsm#5). `createSystemPromptFn` takes an optional
// trailing `operatorContext` string — an already-labeled block from `composeOperatorContext`. When
// non-empty it is spliced in as its own section positioned so the load-bearing output contract stays
// LAST (INV-CONTRACT-LAST); when absent/empty the composed prompt is byte-identical to today
// (INV-STABLE-PROMPTS). `prompts.ts` treats the arg as an opaque section, so the tests pass a marker.
describe('createSystemPromptFn — operator-context injection (agents-fsm#5)', () => {
  const systemPrompt = createSystemPromptFn();
  // A stand-in for `composeOperatorContext`'s output: heading + delimited body. prompts.ts is agnostic
  // to the exact text, so a distinctive marker is enough to assert placement.
  const OP = '## Operator-provided context\n\nOPERATOR_MARKER standing guidance';

  it('splices operator context as a delimited section BEFORE the envelope contract for a real stage', () => {
    const prompt = systemPrompt('plan', 'produce', OP);
    expect(prompt).toContain('OPERATOR_MARKER');
    expect(prompt).toContain(ENVELOPE_CONTRACT);
    // The contract remains the final load-bearing instruction: operator text sits before it.
    expect(prompt.indexOf('OPERATOR_MARKER')).toBeLessThan(prompt.indexOf(ENVELOPE_CONTRACT));
    // And after the base + role, so it reads as an extension of the role, not a preamble.
    expect(prompt.indexOf('## Your stage: plan')).toBeLessThan(prompt.indexOf('OPERATOR_MARKER'));
    // It is its own section, fenced by the section separator (a horizontal rule).
    expect(prompt).toContain('\n\n---\n\n## Operator-provided context');
  });

  it('keeps the verdict contract last for a self_review phase, operator text before it', () => {
    const prompt = systemPrompt('plan', 'self_review', OP);
    expect(prompt).toContain('OPERATOR_MARKER');
    expect(prompt).toContain(VERDICT_CONTRACT);
    expect(prompt.indexOf('OPERATOR_MARKER')).toBeLessThan(prompt.indexOf(VERDICT_CONTRACT));
  });

  it('keeps triage’s own decision contract last, operator text before it', () => {
    const prompt = systemPrompt('triage', 'produce', OP);
    expect(prompt).toContain('OPERATOR_MARKER');
    expect(prompt).toContain(TRIAGE_CONTRACT);
    expect(prompt.indexOf('OPERATOR_MARKER')).toBeLessThan(prompt.indexOf(TRIAGE_CONTRACT));
  });

  it('injects into chat BEFORE its inline contract (the phase section carries its own contract)', () => {
    const prompt = systemPrompt('chat', 'produce', OP);
    expect(prompt).toContain('OPERATOR_MARKER');
    expect(prompt).toContain('"response"');
    // chat/advise carry their own output contract inside the phase section — operator text goes before it.
    expect(prompt.indexOf('OPERATOR_MARKER')).toBeLessThan(prompt.indexOf('Phase: operator chat'));
  });

  it('appends operator context to resolve_conflicts (no output contract — degrades to last)', () => {
    const prompt = systemPrompt('resolve_conflicts', 'produce', OP);
    expect(prompt).toContain('OPERATOR_MARKER');
    // No envelope/verdict contract here, so "before the contract" becomes "at the very end".
    expect(prompt.trimEnd().endsWith('OPERATOR_MARKER standing guidance')).toBe(true);
  });

  it('is byte-identical to today when operator context is absent or empty (INV-STABLE-PROMPTS)', () => {
    for (const stage of ['plan', 'triage', 'chat', 'advise', 'resolve_conflicts']) {
      const baseline = systemPrompt(stage, 'produce');
      expect(systemPrompt(stage, 'produce', undefined)).toBe(baseline);
      expect(systemPrompt(stage, 'produce', '')).toBe(baseline);
    }
  });
});
