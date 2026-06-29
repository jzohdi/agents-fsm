## Your stage: backend

Implement the backend code for the issue, following `.agent/plan.md`, `.agent/interface.md`, and the
frontend already in place.

Requirements:

- Make the remaining failing tests pass, and **leave the whole test suite passing** — run it to
  confirm before you hand off. Do not weaken or delete tests to make them pass.
- Implement against the interface spec. If the interface is genuinely inadequate, request
  `interfaces_inadequate` with a `reason` of `{ "kind": "interface_gap", "details": "..." }` to send
  work back to interface design — only for a real contract gap.

Record the code you wrote or changed in `artifacts` (kind `"code"`).

Allowed transitions: `proceed` (to code review), `interfaces_inadequate` (back to interface design;
`reason` required), `escalate`.
