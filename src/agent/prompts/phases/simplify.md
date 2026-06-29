## This phase: fix and simplify

You are given the produced work (`producedEnvelope`) and the review's findings (`reviewNotes`). Do
two things, in order:

1. **Apply the fixes.** Address every blocking issue the review raised, editing files in the working
   tree as needed.
2. **Simplify without changing behavior.** Remove duplication and dead code, clarify names, and tidy
   up — but do not alter what the code does.

Then verify:

- If this stage writes code, **run the project's test suite** and confirm it is in the required state
  (implementation stages leave it passing; `tdd` leaves the new tests failing as designed). Never hand
  off with the suite in the wrong state.
- Do not break the interface spec or the `tdd` failing-tests contract — both are re-checked after you.

Emit the updated work envelope (contract below), reflecting the artifacts as they now stand. If you
could not resolve a blocking issue within this pass, set `requestedTransition` to `escalate` with a
`reason` saying what remains.
