/** Tests for the pure Cursor-model refresh helpers (list parsing, inference, merge). */

import { describe, expect, it } from 'vitest';

import { humanizeId, idToModel, mergeModels, parseModelList, providerForId } from './cursor-models-source';
import type { HarnessModel } from './harness-models';

describe('providerForId', () => {
  it('infers the provider from the id prefix', () => {
    expect(providerForId('claude-opus-4-8-high')).toBe('anthropic');
    expect(providerForId('gpt-5.5-extra-high')).toBe('openai');
    expect(providerForId('gemini-3.1-pro')).toBe('google');
    expect(providerForId('grok-4.3')).toBe('xai');
    expect(providerForId('composer-2.5')).toBe('cursor');
    expect(providerForId('glm-5.2-high')).toBe('zai');
    expect(providerForId('kimi-k2.5')).toBe('moonshot');
    expect(providerForId('mystery-9')).toBe('other');
  });
});

describe('humanizeId', () => {
  it('title-cases tokens and upper-cases brand acronyms', () => {
    expect(humanizeId('gpt-6')).toBe('GPT 6');
    expect(humanizeId('glm-6-max')).toBe('GLM 6 Max');
    expect(humanizeId('deepseek-r2')).toBe('Deepseek R2');
  });
});

describe('parseModelList', () => {
  it('extracts real model ids from CLI output, dropping prose, `auto`, and `-fast` variants', () => {
    // Shaped like the `cursor-agent` error/list output: comma-separated with a prose prefix.
    const text = 'Available models: auto, gpt-5.5-high, gpt-5.5-high-fast, claude-opus-4-8-xhigh, composer-2.5, gpt-5.2';
    expect(parseModelList(text)).toEqual(['claude-opus-4-8-xhigh', 'composer-2.5', 'gpt-5.2', 'gpt-5.5-high']);
  });

  it('is a safe no-op when nothing looks like a model id', () => {
    expect(parseModelList('no models here at all')).toEqual([]);
  });

  it('dedupes across newline- or comma-separated output', () => {
    expect(parseModelList('gpt-5.4-high\ngpt-5.4-high\ngrok-4.3')).toEqual(['gpt-5.4-high', 'grok-4.3']);
  });
});

describe('idToModel', () => {
  it('builds a pickable entry with inferred provider/group, and a cheap tier for small/fast variants', () => {
    expect(idToModel('gpt-5.5-high')).toEqual({
      id: 'gpt-5.5-high',
      label: 'GPT 5.5 High',
      provider: 'openai',
      group: 'OpenAI',
      cost: 2,
    });
    expect(idToModel('gpt-5-mini').cost).toBe(1); // small variant → cheap tier
    expect(idToModel('gemini-3.5-flash').cost).toBe(1);
  });
});

describe('mergeModels', () => {
  const curated: HarnessModel[] = [
    { id: 'claude-opus-4-8-high', label: 'Claude Opus 4.8 · High', provider: 'anthropic', group: 'Anthropic', cost: 4, recommended: true },
    { id: 'gpt-5.5-high', label: 'GPT-5.5 · High', provider: 'openai', group: 'OpenAI', cost: 4 },
    { id: 'composer-2.5', label: 'Composer 2.5', provider: 'cursor', group: 'Cursor', cost: 1 },
  ];

  it('preserves curated entries verbatim, adds discovered ones, and drops removed ones', () => {
    // CLI reports: keeps opus + composer, drops gpt-5.5-high, adds a new gpt-6-high.
    const { models, added, removed } = mergeModels(curated, ['claude-opus-4-8-high', 'composer-2.5', 'gpt-6-high']);

    expect(added).toEqual(['gpt-6-high']);
    expect(removed).toEqual(['gpt-5.5-high']);
    // Curated opus keeps its hand-written label + recommended flag (not clobbered by inference).
    expect(models.find((m) => m.id === 'claude-opus-4-8-high')).toMatchObject({ label: 'Claude Opus 4.8 · High', recommended: true });
    expect(models.find((m) => m.id === 'gpt-6-high')).toMatchObject({ provider: 'openai', group: 'OpenAI', cost: 2 });
  });

  it('keeps each provider group contiguous so the picker renders one header per provider', () => {
    const { models } = mergeModels(curated, ['claude-opus-4-8-high', 'gpt-5.5-high', 'composer-2.5', 'claude-sonnet-5-high']);
    const groups = models.map((m) => m.group);
    const seen = new Set<string>();
    let prev = '';
    for (const g of groups) {
      if (g !== prev && seen.has(g!)) throw new Error(`group ${g} is not contiguous: ${groups.join(',')}`);
      seen.add(g!);
      prev = g!;
    }
    expect(models.filter((m) => m.provider === 'anthropic').map((m) => m.id)).toEqual(['claude-opus-4-8-high', 'claude-sonnet-5-high']);
  });
});
