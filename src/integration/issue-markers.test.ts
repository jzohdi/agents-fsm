import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { canonicalDeps, defaultScheduling, parseMarker, sameScheduling, upsertMarker, type SchedulingDecl } from './issue-markers';

const FULL_BLOCK = ['<!-- agent-orchestrator:v1', 'depends_on: [42, 57]', 'priority: 10', 'order_key: "2026Q3-auth-03"', '-->'].join(
  '\n',
);

function decl(overrides: Partial<SchedulingDecl> = {}): SchedulingDecl {
  return { ...defaultScheduling(), ...overrides };
}

describe('parseMarker — the §3.5 block, field by field', () => {
  const cases: Array<[string, string, SchedulingDecl | null]> = [
    ['no block → null (means default)', 'Just a plain issue body.', null],
    ['empty block → all defaults', '<!-- agent-orchestrator:v1\n-->', decl()],
    ['full block', FULL_BLOCK, decl({ dependsOn: [42, 57], priority: 10, orderKey: '2026Q3-auth-03' })],
    ['fields are each optional', '<!-- agent-orchestrator:v1\npriority: 3\n-->', decl({ priority: 3 })],
    [
      'trailing # comments (the README §3.5 example carries them)',
      '<!-- agent-orchestrator:v1\ndepends_on: [42, 57]   # issues merged first\npriority: 10   # higher first\norder_key: "a#b"  # note the # inside quotes\n-->',
      decl({ dependsOn: [42, 57], priority: 10, orderKey: 'a#b' }),
    ],
    ['explicit empty deps', '<!-- agent-orchestrator:v1\ndepends_on: []\n-->', decl()],
    ['deps canonicalized (sorted, de-duplicated)', '<!-- agent-orchestrator:v1\ndepends_on: [57, 42, 57]\n-->', decl({ dependsOn: [42, 57] })],
    ['negative priority is a valid integer', '<!-- agent-orchestrator:v1\npriority: -2\n-->', decl({ priority: -2 })],
    ['malformed deps degrade to default, priority still applies', '<!-- agent-orchestrator:v1\ndepends_on: [42, x]\npriority: 5\n-->', decl({ priority: 5 })],
    ['zero/negative issue numbers are malformed', '<!-- agent-orchestrator:v1\ndepends_on: [0, 42]\n-->', decl()],
    ['malformed priority degrades, deps still apply', '<!-- agent-orchestrator:v1\ndepends_on: [7]\npriority: high\n-->', decl({ dependsOn: [7] })],
    ['unquoted order_key is malformed', '<!-- agent-orchestrator:v1\norder_key: loose\n-->', decl()],
    ['order_key JSON escapes round in', '<!-- agent-orchestrator:v1\norder_key: "a\\"b"\n-->', decl({ orderKey: 'a"b' })],
    ['unknown lines are ignored', '<!-- agent-orchestrator:v1\nfuture_field: 9\npriority: 1\n-->', decl({ priority: 1 })],
    ['a different sentinel is not our block', '<!-- agent-orchestrator:v2\npriority: 9\n-->', null],
    ['block embedded in prose parses', `Intro text.\n\n${FULL_BLOCK}\n\nOutro text.`, decl({ dependsOn: [42, 57], priority: 10, orderKey: '2026Q3-auth-03' })],
  ];

  it.each(cases)('%s', (_name, body, expected) => {
    expect(parseMarker(body)).toEqual(expected);
  });
});

describe('upsertMarker — idempotent, prose-preserving writes', () => {
  it('appends a block to a body without one, after a blank line', () => {
    const out = upsertMarker('The issue text.', decl({ dependsOn: [3] }));
    expect(out.startsWith('The issue text.\n\n<!-- agent-orchestrator:v1\n')).toBe(true);
    expect(parseMarker(out)).toEqual(decl({ dependsOn: [3] }));
  });

  it('writes a bare block into an empty body', () => {
    const out = upsertMarker('', decl({ priority: 2 }));
    expect(parseMarker(out)).toEqual(decl({ priority: 2 }));
    expect(out.startsWith('<!-- agent-orchestrator:v1')).toBe(true);
  });

  it('replaces an existing block in place, leaving surrounding prose untouched', () => {
    const body = `Intro.\n\n${FULL_BLOCK}\n\nOutro.`;
    const out = upsertMarker(body, decl({ dependsOn: [9], priority: 1, orderKey: 'z' }));
    expect(out.startsWith('Intro.\n\n')).toBe(true);
    expect(out.endsWith('\n\nOutro.')).toBe(true);
    expect(parseMarker(out)).toEqual(decl({ dependsOn: [9], priority: 1, orderKey: 'z' }));
  });

  it('double-upsert is byte-identical (idempotent under triage re-runs)', () => {
    const d = decl({ dependsOn: [42, 57], priority: 10, orderKey: '2026Q3-auth-03' });
    const once = upsertMarker('Body.', d);
    expect(upsertMarker(once, d)).toBe(once);
  });

  it('canonicalizes on write: unsorted/duplicate deps and a fractional priority', () => {
    const out = upsertMarker('', { dependsOn: [57, 42, 57], priority: 10.9, orderKey: '' });
    expect(parseMarker(out)).toEqual(decl({ dependsOn: [42, 57], priority: 10 }));
  });

  it('round-trips any declaration, including hostile order_keys (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 9999 }), { maxLength: 8 }),
        fc.integer({ min: -100, max: 100 }),
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 200 }),
        (deps, priority, orderKey, prose) => {
          const written = upsertMarker(prose, { dependsOn: deps, priority, orderKey });
          const parsed = parseMarker(written);
          expect(parsed).not.toBeNull();
          expect(sameScheduling(parsed!, { dependsOn: canonicalDeps(deps), priority, orderKey })).toBe(true);
          // And a second write of the parsed value changes nothing.
          expect(upsertMarker(written, parsed!)).toBe(written);
        },
      ),
    );
  });
});
