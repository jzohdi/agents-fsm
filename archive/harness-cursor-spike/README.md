# Archive spike — Cursor as a selectable harness

Throwaway reconnaissance kept as living evidence for the design plan
[`plans/harness-abstraction.md`](../../plans/harness-abstraction.md). **Do not delete** — it records the
API-shape facts that plan was built on. It is not product code.

## What it proves

- **`cursor-result-parsing.test.ts`** (runs offline, part of `npm test`): feeds the *existing* Claude Code
  `parseHarnessOutput` a stdout stream shaped like Cursor's documented `--output-format stream-json` output
  and asserts:
  1. Cursor's terminal `type:"result"` event parses into the same structured envelope → **the result
     parser is reusable across harnesses** (the crux of "adding Cursor is easy, not a rewrite").
  2. Cursor's result event has **no `usage`/`total_cost_usd`** → tokens `0`, cost `undefined`. This is the
     documented gap: the run-budget guard and the M8 global cost ceiling go blind for Cursor runs.
  3. A Cursor error result still classifies as a `HarnessError` → error handling is reusable.

- **`cursor-live-probe.test.ts`** (auto-skips unless `cursor-agent` is on PATH): spawns the real Cursor CLI
  with `-p … --output-format stream-json --force`, dumps the actual event `type`s + parsed result, and
  asserts the existing parser reads it. Use this to confirm the real event families (and finalize the
  Cursor `summarize`/auth matchers) on a machine with the Cursor CLI installed.

## Running

```bash
# offline proof (always runs):
npx vitest run archive/harness-cursor-spike/

# live proof (needs the Cursor CLI):
#   1) install cursor-agent, then: cursor-agent login   (or export CURSOR_API_KEY=…)
#   2) npx vitest run archive/harness-cursor-spike/cursor-live-probe.test.ts
```

## Sources

- Cursor CLI — Using Headless CLI: https://cursor.com/docs/cli/headless
- Cursor CLI — Output format: https://cursor.com/docs/cli/reference/output-format
- Cursor CLI — Parameters: https://cursor.com/docs/cli/reference/parameters
