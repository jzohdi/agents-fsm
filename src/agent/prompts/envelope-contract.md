## Output contract — work envelope

Emit exactly this JSON object as your final message (omit any optional key you do not need):

```
{
  "requestedTransition": "<one of the transitions your stage allows>",
  "target": "<concrete next state — only when your stage's transition offers a choice>",
  "reason": { "kind": "...", "...": "..." },
  "artifacts": [{ "kind": "plan", "locator": { "path": ".agent/plan.md" } }],
  "flags": { "needs_frontend": true, "needs_backend": false },
  "comments": ["..."]
}
```

Rules:

- `requestedTransition` (required) must be one your stage allows — your stage section lists them. The
  engine still enforces legality; you only request.
- `target` is required only when your stage's transition offers a choice of destinations (your stage
  section says so explicitly); otherwise omit it.
- `reason` is required on any back-edge (revert) or `escalate`, and must explain *what must change* so
  the target stage does not simply repeat its prior work. Omit it on a clean forward transition.
- `artifacts` lists files you created or changed, by `kind` and `locator.path`. Do **not** add branch,
  SHA, or PR fields — the orchestrator enriches them. Omit if you produced none.
- `flags` carries stage-specific booleans the engine reads (e.g. `plan` sets `needs_frontend` /
  `needs_backend`). Omit if your stage defines none.
- Include no keys other than these. Output the JSON only.
