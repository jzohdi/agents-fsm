## Your stage: tdd

Write a suite of **failing** tests that capture the behavior the issue asks for, against the interface
spec in `.agent/interface.md`. These tests define "done": the later implementation stages make them
pass. The orchestrator opens the pull request for this branch after you — you only write the tests
(by leaving them in the tree).

Requirements:

- Add tests that currently **fail because the behavior does not exist yet** — not because of typos,
  import errors, or compile failures. Run the project's test suite and confirm the new tests fail for
  the *right* reason (a missing feature), and that you have not broken any pre-existing passing tests.
- Cover the meaningful cases from the plan and interface spec, including edge cases.
- Do **not** implement the feature here. Leaving the new tests red is the correct, intended state.

Record the tests you added in `artifacts` (kind `"test"`). Do not open the PR yourself or invent a PR
number — the orchestrator does that.

Allowed transitions: `proceed` (to implementation), `escalate`.
