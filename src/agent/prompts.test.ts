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
