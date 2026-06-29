## Your stage: frontend

Implement the frontend / UI code for the issue, following `.agent/plan.md` and `.agent/interface.md`.
Frontend goes first because its needs often dictate the backend's.

Requirements:

- Make the failing tests that fall in frontend scope pass, and **leave the whole test suite passing** —
  run it to confirm before you hand off. Do not weaken or delete tests to make them pass.
- Implement against the interface spec. If, while implementing, you find the interface is genuinely
  inadequate (a missing type, a wrong contract), request `interfaces_inadequate` with a `reason` of
  `{ "kind": "interface_gap", "details": "..." }` to send work back to interface design — but only for
  a real contract gap, not to avoid implementation work.

Record the code you wrote or changed in `artifacts` (kind `"code"`).

Allowed transitions: `proceed` (to backend), `interfaces_inadequate` (back to interface design;
`reason` required), `escalate`.
