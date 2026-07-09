/**
 * Documentation acceptance test for issue #13 ("Per-harness model catalogs for off-default runs — doc
 * cleanup + verify"). The runtime already shipped; this issue's *deliverable* is bringing the README in
 * line with it. These assertions encode the issue's acceptance criteria against the README so the doc
 * change is verified, not just eyeballed:
 *
 *   1. README §9.8 no longer claims off-default per-harness catalogs are "deferred", and it accurately
 *      describes the run inspector loading the run's *own* harness catalog (`GET /models?harness=`).
 *   2. The `#13` "Per-harness model catalogs for off-default runs" line is gone from the "not-yet-built
 *      planned work" roadmap, since the feature is built.
 *
 * These are expected to FAIL until the implementation stage edits the README (the obsolete "deferred"
 * caveat and the stale roadmap entry are still present at test-authoring time).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

// Just the §9.8 "Caveats (accepted for now)" block (up to §9.9). The positive assertion about the
// reworded model-picker caveat scopes to this slice so it can't be satisfied by the §9.8 harness-switching
// paragraph above it, which already mentions `GET /models?harness=<id>` and would otherwise make the check
// pass before any edit. The caveats block does NOT mention that fetch today, so the assertion is red until
// the model-picker caveat is rewritten to describe the run-inspector fetch.
const CAVEATS_9_8 = README.slice(
  README.indexOf('**Caveats (accepted for now):**'),
  README.indexOf('### 9.9'),
);

describe('README §9.8 model-picker caveat (issue #13)', () => {
  it('no longer says per-harness catalogs for off-default runs are deferred', () => {
    expect(README).not.toMatch(/per-harness\s+catalogs\s+for\s+off-default\s+runs\s+are\s+deferred/i);
  });

  it('no longer claims the run-inspector picker appears only for a harness matching the loaded catalog', () => {
    expect(README).not.toMatch(/appears only for a run whose harness matches the\s+loaded catalog/i);
  });

  it('describes the run inspector loading the run\'s own harness catalog via GET /models?harness=', () => {
    // The reworded model-picker caveat must reference the per-run harness-scoped catalog request. Scoped to
    // the §9.8 caveats block, `\?harness=` (with a leading query separator) is red today — the caveat still
    // says the feature is "deferred" and never mentions the fetch — and turns green only when it is rewritten
    // to describe the run inspector loading the run's own harness catalog.
    expect(CAVEATS_9_8).toMatch(/\/models\?harness=/);
  });
});

describe('README roadmap not-yet-built list (issue #13)', () => {
  it('no longer lists "Per-harness model catalogs for off-default runs" as planned work', () => {
    expect(README).not.toMatch(/Per-harness model catalogs for off-default runs/i);
  });

  it('no longer links issue #13 as an unbuilt roadmap item', () => {
    expect(README).not.toMatch(/issues\/13\)/);
  });
});
