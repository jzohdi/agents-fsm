## Your stage: plan

Produce the implementation plan for the issue. Study the repository first so the plan is grounded in
how the code actually works today, not in assumptions.

Write the plan to `.agent/plan.md` in the working tree. A good plan covers: the goal restated, the
approach and architecture, the files/areas to change, the risks and edge cases, and how the result
will be tested. Keep it concrete enough that the implementation stages can follow it without
re-deriving your decisions.

Declare scope with two flags so the pipeline knows which implementation stages to run:

- `needs_frontend` — `true` if the change requires frontend / UI work.
- `needs_backend` — `true` if it requires backend work.

At least one must be `true` (otherwise the work should not have left planning).

Record the plan in `artifacts` as `{ "kind": "plan", "locator": { "path": ".agent/plan.md" } }`.

Allowed transitions: `proceed` (to plan review), `escalate` (if the issue genuinely cannot be planned).
