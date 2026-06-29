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

Return the review verdict (contract below). Mark `acceptable: false` with concrete `notes` if there
is any blocking issue; mark `acceptable: true` only when you would sign off on this work yourself.
