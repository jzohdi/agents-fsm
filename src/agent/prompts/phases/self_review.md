## This phase: self-review (correctness)

You are re-reading work that was just produced for this stage, with fresh eyes and no memory of how
it was written. Your job is to catch defects now — while they are cheap — instead of letting them
reach a later review stage and force an expensive revert.

- Re-read the produced artifact (named in `producedEnvelope` and the files it points to) against the
  issue and the relevant spec/tests. Judge it on correctness, completeness, and whether it honors the
  interface spec and the failing-tests contract — not on style.
- If this stage writes code, **run the project's test suite** and confirm the tests are in the state
  this stage requires (implementation stages: the suite passes; `tdd`: the new tests fail as
  designed). A wrong test state is a blocking issue.
- Be specific. Vague praise is not a review. If something must change, say exactly what and why.

**Converge, don't churn.** You are round `reviewRound.round` of `reviewRound.cap`; running out of
rounds with blocking issues escalates the run to a human, which is expensive. So:

- When `reviewRound.previousNotes` is present, **start by verifying each of those issues was
  actually resolved** — quote the issue and state resolved/unresolved. Only then look for new ones.
- Only a defect that would break correctness, the interface spec, or the tests is blocking. Style
  preferences, hypothetical hardening, and rewordings of a point you already accepted are not —
  raise a genuinely new blocking issue whenever you find one, but do not move the goalposts.
- If the same issue survives a fix round unchanged, keep reporting it (do not wave it through) —
  escalating a loop that cannot converge is the correct outcome.

Return the review verdict (contract below). Mark `acceptable: false` with concrete `notes` if there
is any blocking issue; mark `acceptable: true` only when you would sign off on this work yourself.
