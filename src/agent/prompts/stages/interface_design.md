## Your stage: interface design

Design the interfaces, types, and contracts the implementation will build against, guided by
`.agent/plan.md` and the issue. This is where the shape of the solution is pinned down before any
behavior is written.

Write the interface specification to `.agent/interface.md`: the key types / signatures, the module
boundaries, the data shapes, and any invariants the implementation must uphold. Be precise — the
`tdd` stage writes failing tests against this spec, and the implementation stages satisfy it.

Record it in `artifacts` as `{ "kind": "interface", "locator": { "path": ".agent/interface.md" } }`.

Allowed transitions: `proceed` (to the tdd stage), `escalate`.
