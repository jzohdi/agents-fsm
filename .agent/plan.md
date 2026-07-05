# Plan — Eliminate `.agent/` artifact merge conflicts between back-to-back runs (agents-fsm#21)

## Goal (restated)

Back-to-back runs against the same repo must not produce merge conflicts caused by the pipeline's
own scratch artifacts, `.agent/plan.md` and `.agent/interface.md`. Merging one run's PR must not set
up the next run's PR (or its between-stage base sync) to conflict on those files. The artifacts must
remain readable **on the branch during a run** so later stages (run in fresh worktrees) can hand off
through them — they only need to stop causing cross-run conflicts at/after merge, and they do **not**
need to persist in `main`.

## Why the conflict happens today

- Every producing stage writes its artifact to a **fixed path** (`.agent/plan.md`, `.agent/interface.md`)
  and the runner commits the whole tree via `commitAndPush` → `git add -A`
  (`src/integration/github-cli.ts` `commitAndPush`, `src/agent/runner.ts` `applyStageEffects`).
- Those files therefore land in `main` when a run's PR merges. The next run branches off `main`
  (now carrying run A's artifacts) and writes its **own different** artifacts at the same paths.
  (This is directly observable: this very run's branch arrived carrying a stale `.agent/plan.md` from
  a previous, unrelated run — issue #6.)
- Two independent, real-git merge points then conflict on those paths:
  1. **The between-stage base sync** (`runner.ts` `syncWithBase` → `github-cli.ts` `syncBranchWithBase`,
     which merges `origin/<base>` into the run branch before every non-triage stage). This is where the
     noise usually fires first: `manual` policy parks the run `needs_human`; `auto` policy burns a
     resolver invocation — on *nearly every* back-to-back change.
  2. **The GitHub PR merge** into `main` (done by a human/operator), if `main` moved after the run's
     last base sync.
- These are pure noise: the files are the orchestrator's scratch, not user code.

## Chosen approach: strip `.agent/` from the branch tip at the terminal `code_review` approval

Keep the **fixed artifact paths** exactly as they are (so mid-run handoff is untouched), but ensure
the artifacts never reach `main`: when `code_review` **approves** (the only transition that leads to
`done`), the runner adds one final commit on the branch that removes the entire `.agent/` scratch
directory, then pushes. The PR's net contribution to `main` therefore contains **no `.agent/` files**.

Why this fully removes the conflict at *both* merge points, deterministically and without depending on
any merge-driver support:

- `.agent/` files exist **only on live run branches**, never in `main`.
- The between-stage base sync merges `origin/<base>` (= `main`, which never has `.agent/` files) into a
  branch that added them only on its own side → a one-sided add → **no 3-way conflict**, ever.
- The GitHub PR merge is `main` (no `.agent/`) × branch-tip (stripped, no `.agent/`) → **no conflict**.
- `main` stays clean (no accumulation of scratch), matching the issue's "do not need to persist in main".

This is the same architectural pattern the existing merge-conflict handling already uses: a
loop/runner-owned side effect layered on top of an untouched FSM (cf. the `resolve_conflicts`
pseudo-stage and the base-sync step). **`src/fsm/` is not touched.**

### Why not the other candidate directions

- **`.gitattributes merge=union`/`ours` for `.agent/**`**: rejected. It would auto-resolve the *local*
  base sync, but GitHub's server-side PR merge does not reliably honor custom merge drivers, so
  acceptance criterion #1 (clean *sequential PR merges*) could not be guaranteed or unit-tested;
  `union` also produces semantically garbage concatenated artifacts, and the files would still
  accumulate in `main`.
- **Run-scoped artifact subpaths** (`.agent/runs/<runId>/…`): also conflict-free, but it requires
  threading the run id into every stage prompt that writes/reads the artifacts (brittle — the agent
  picks the path from prompt text), and it makes the scratch files **accumulate forever** in `main`,
  the opposite of the issue's stated preference. Stripping keeps the simple fixed paths and leaves
  `main` clean.

## Changes

### 1. New adapter capability: strip the scratch artifacts (`src/integration/github.ts` + impls)
- Add one method to the `GitHub` interface, e.g.
  `stripAgentArtifacts(runId: number, branch: string, message: string): Promise<CommitRef | null>`.
- **Real impl (`github-cli.ts`)**: in the run's working tree run
  `git rm -r -f --ignore-unmatch .agent` (idempotent — a no-op when the dir is already gone), then
  commit **only if something was staged** (reuse the `status --porcelain` guard already in
  `commitAndPush`), authored by the `DAEMON_IDENTITY` (the daemon, not the agent, makes this commit),
  and `git push origin <branch>`. Return the new `CommitRef`, or `null` when there was nothing to
  remove (already stripped / never created). Keep all tree+git mutation behind the adapter — the runner
  never shells git itself.
- **Fake impl (`github-fake.ts`)**: record the request (e.g. push to a `strippedArtifacts: Array<{runId,
  branch}>` recorder, mirroring the existing `savepoints`/`finishedMerges`/`abortedMerges` lists) and
  return a synthesized `CommitRef`, so runner-level tests can assert the strip fired exactly when
  expected.

### 2. Runner: fire the strip on terminal code-review approval (`src/agent/runner.ts`)
- In `applyStageEffects`, the review branch currently only posts PR comments. Extend it so that a
  **review stage that has an open PR and is approving** also strips the artifacts before handing off:
  gate on `io.kind === 'review'` **and** `run.prNumber !== null` **and**
  `envelope.requestedTransition === 'approve'`. In the default pipeline this matches **only**
  `code_review`'s approve→`done` edge (plan_review has no PR; `request_changes` is excluded so the
  artifacts survive for the frontend/backend re-run they feed).
- Call `github.stripAgentArtifacts(run.id, prep.branch!, <message>)` after the comment loop, and record
  a log line (mirroring the base-sync `recordLog`) noting the scratch was cleaned. Do **not** add a new
  artifact record — the removal is the point. Return the (possibly comment-enriched) envelope unchanged.
- Idempotency: safe on re-entry / a second approval (a PR-feedback cycle) because `git rm
  --ignore-unmatch` + commit-if-changed is a no-op once already stripped.

### 3. Path assumptions / `recordArtifact` locators
- Paths are unchanged, so `recordArtifact` locators, prompt path references
  (`prompts/stages/plan.md`, `interface_design.md`, `tdd.md`, `code_review.md`), and `executor.ts`
  golden-path locators need **no changes**. The artifacts still resolve to `.agent/plan.md` /
  `.agent/interface.md` throughout the run; the only new behavior is their removal from the branch
  tip at the very end. (Called out explicitly to close the issue's "update path assumptions" item:
  nothing to update because the paths stay fixed.)

### 4. Docs
- Update the README/operating-guide note on artifact storage/merge behavior: state that `.agent/`
  artifacts are branch-local scratch that are stripped from the branch tip at `code_review` approval,
  so they never land in `main` and never cause cross-run conflicts, while remaining readable during
  the run. Natural anchors: the "Artifacts are the shared memory" note (README §3.3, ~line 134) and/or
  the merge-conflict-handling section that documents the base sync.

## Files to change

- `src/integration/github.ts` — add `stripAgentArtifacts` to the `GitHub` interface (+ any shared types).
- `src/integration/github-cli.ts` — real implementation (`git rm -r -f --ignore-unmatch .agent`,
  commit-if-changed, push).
- `src/integration/github-fake.ts` — fake implementation + a recorder for assertions.
- `src/agent/runner.ts` — invoke the strip on terminal code-review approval in `applyStageEffects`.
- `README.md` — artifact storage/merge note.
- Tests: `src/integration/github-cli.test.ts`, `src/agent/runner.test.ts` (and/or
  `src/loop/event-loop.test.ts`), plus `src/integration/github-fake.test.ts` if it covers new methods.

## Risks & edge cases

- **Only strip on approve, never on `request_changes`.** Stripping before a frontend/backend re-run
  would delete artifacts those stages still read. The `requestedTransition === 'approve'` gate handles
  this; add an explicit test that `request_changes` does **not** strip.
- **Never strip in `plan_review`.** It approves to `interface_design`, which needs `.agent/plan.md`.
  The `run.prNumber !== null` gate excludes it (no PR yet); assert this in a test.
- **code_review still sees the artifacts.** The strip runs in `applyStageEffects`, i.e. *after* the
  review agent has run, so the reviewer can still read `.agent/plan.md` / `.agent/interface.md` from
  the tree. The removal only affects what the PR merges. (The reviewer's `git diff origin/<base>...HEAD`
  will still show the artifacts as added while it runs — harmless and unchanged from today.)
- **PR-feedback re-entry after merge.** `main` has no `.agent/` files; a re-opened run re-runs from
  `plan`, regenerating them on the branch (base sync is a one-sided add → no conflict), and strips them
  again at the next approval. Consistent and idempotent.
- **Push failure / partial strip.** The strip is one commit+push through the same seam as
  `commitAndPush`; a failure surfaces as an effects error and escalates like any other git side effect
  (existing `effectsError` path). No merge is involved, so the tree is never left mid-merge.
- **Concurrent runs (M8).** During overlap neither run's artifacts are in `main` yet; a base sync only
  pulls `main`, never a sibling's open branch, so there is nothing to conflict on until a PR merges —
  and by then that PR was stripped.
- **Non-default pipelines** that route a PR-bearing review stage's approval somewhere other than `done`
  would also strip; acceptable because approval means the PR is finalized, and the gate can be tightened
  to `code_review` specifically if a future config needs it.

## How it will be tested

- **Real-git sequential-merge test** (`github-cli.test.ts`, using the existing offline temp-repo
  harness): create `main`; branch A, add `.agent/plan.md` + real code, call `stripAgentArtifacts`,
  merge A into `main` — assert clean and that `main` has no `.agent/`. Then branch B off the updated
  `main`, add its own `.agent/plan.md` + code, `stripAgentArtifacts`, merge B into `main` — assert
  **no conflict** and no manual resolution. This directly proves acceptance criterion #1.
- **`stripAgentArtifacts` unit tests** (real git): removes `.agent/` and commits+pushes when present;
  returns `null` / makes no commit when already absent (idempotent); leaves non-`.agent` files
  untouched.
- **Runner tests** (fake adapter): `code_review` approve → strip fired once with the run's branch;
  `code_review` `request_changes` → **no** strip; `plan_review` approve → **no** strip; a PR-feedback
  re-entry that approves again → strip is idempotent.
- Full `npm test` + lint to confirm no regressions in the base-sync / conflict-policy suites (which
  stay as-is per the issue's out-of-scope note).

## Scope flags

- `needs_backend: true` — all changes are in the Node/TS orchestrator (adapters, runner, tests, docs).
- `needs_frontend: false` — no dashboard/UI change.
