# Interface — Strip `.agent/` scratch artifacts at terminal code-review approval (agents-fsm#21)

This spec pins down the contract the `tdd` and implementation stages build against. It follows the
chosen approach in `.agent/plan.md`: keep the **fixed artifact paths** (`.agent/plan.md`,
`.agent/interface.md`) exactly as-is so mid-run handoff is untouched, and add **one new adapter
method** that the runner fires on the single terminal `code_review` → `done` approval to remove the
`.agent/` scratch directory from the branch tip, so those files never reach `main` and never cause
cross-run conflicts.

`src/fsm/` is **not** touched. No artifact paths change. `recordArtifact` locators, prompt path
references, and `executor.ts` golden-path locators are unchanged (see §5).

---

## 1. New adapter method: `GitHub.stripAgentArtifacts`

Add exactly one method to the `GitHub` interface in `src/integration/github.ts`, alongside the other
local-git seam methods (`savepointWorkingTree`, `syncBranchWithBase`, …).

### Signature

```ts
/**
 * Remove the pipeline's `.agent/` scratch artifacts (`.agent/plan.md`, `.agent/interface.md`, and
 * anything else under `.agent/`) from the run's branch tip and push, so the PR's net contribution to
 * `main` carries no scratch files and back-to-back runs never conflict on those fixed paths (agents-fsm#21).
 *
 * The runner calls this exactly once, at the terminal `code_review` approval (approve → `done`), i.e.
 * AFTER every stage that reads the artifacts has run. Removing them from the branch tip is a one-sided
 * delete against a `main` that never had them, so neither the between-stage base sync nor the GitHub PR
 * merge can 3-way-conflict on `.agent/**`.
 *
 * Contract:
 *  - Operates on the run's own working tree (derived from `runId`, like the other tree methods).
 *  - Idempotent + no-op-safe: when `.agent/` is already gone (re-entry, a second PR-feedback approval,
 *    or it was never created) it makes NO commit and returns `null`. It STILL pushes HEAD (a harmless
 *    no-op when up to date) so a removal commit stranded by a crash between commit and push is
 *    recovered on the resume re-run — the push is unconditional, exactly like `commitAndPush`.
 *  - Local-tree mutation + push through the same seam as `commitAndPush`; the runner never shells git.
 *  - The removal commit is authored by the daemon identity (it, not the agent, makes it), matching
 *    `savepointWorkingTree` / `finishBaseMerge`.
 *
 * @returns the `CommitRef` of the removal commit, or `null` when there was nothing to strip.
 */
stripAgentArtifacts(runId: number, branch: string, message: string): Promise<CommitRef | null>;
```

- **Parameters**: `runId` (the adapter derives the tree path from it, mirroring
  `savepointWorkingTree(runId, …)` / `syncBranchWithBase(runId, …)`); `branch` (the run's working
  branch, for the push refspec — the runner passes `prep.branch!`); `message` (commit message).
- **Return**: `Promise<CommitRef | null>`. `CommitRef` is the existing `{ sha: string }`. `null`
  means nothing was removed (idempotent no-op).
- **Does not throw** on "already stripped" — that path returns `null`. Real git/network failures
  surface as thrown errors exactly like `commitAndPush` (handled by the runner's existing
  effects-error path — see §4).

No changes to any other `GitHub` method or shared type. No new interface types are required (`CommitRef`
already exists).

---

## 2. Real implementation — `src/integration/github-cli.ts`

Add the method to `GitHubCli`. Use the existing private helpers: `this.runTreePath(runId)`,
`this.git(...)`, and the module-level `DAEMON_IDENTITY` constant.

Required behavior — **structurally identical to `commitAndPush`** (github-cli.ts:352-362): the
`status --porcelain` guard decides only whether to **commit** and what to **return**; the **push is
unconditional**, exactly as `commitAndPush` always `rev-parse HEAD` + pushes after its commit-if-staged
guard:

```ts
async stripAgentArtifacts(runId: number, branch: string, message: string): Promise<CommitRef | null> {
  const path = this.runTreePath(runId);
  // Remove the whole scratch dir. `--ignore-unmatch` makes `git rm` a no-op (exit 0, nothing staged)
  // when `.agent/` is already absent, so re-entry / a second approval is safe.
  await this.git(['rm', '-r', '-f', '--ignore-unmatch', '.agent'], path);
  // Commit only when the rm actually staged a deletion.
  const status = await this.git(['status', '--porcelain'], path);
  const stripped = status.trim().length > 0;
  if (stripped) {
    await this.git([...DAEMON_IDENTITY, 'commit', '-m', message], path);
  }
  // ALWAYS push HEAD — mirror commitAndPush. This is the crash-recovery window: if a PRIOR attempt
  // committed the removal but died before pushing (push failure → effectsError → gitError → escalate;
  // on human resume applyStageEffects re-runs), this call finds `.agent/` already gone so status is
  // clean and `stripped` is false — yet the removal commit is stranded on local HEAD while origin's
  // branch tip still carries `.agent/`. Skipping the push here would let `.agent/plan.md` /
  // `.agent/interface.md` reach `main` at PR merge, silently defeating the feature (violates invariant
  // #4). Pushing an already-up-to-date HEAD is a harmless no-op, so pushing unconditionally is safe.
  const sha = (await this.git(['rev-parse', 'HEAD'], path)).trim();
  await this.git(['push', 'origin', branch], path);
  // Return the removal CommitRef only when THIS call staged the deletion; `null` on the clean/no-op
  // path (nothing removed this call — whether never-created, already-stripped, or crash-recovery push).
  return stripped ? { sha } : null;
}
```

Invariants the implementation must uphold:
- **Only `.agent/` is removed.** `git rm -r .agent` stages nothing outside that directory; files
  elsewhere in the tree are untouched.
- **No commit when nothing staged.** The `status --porcelain` guard makes the second call skip the
  commit and return `null` (idempotent as to commits).
- **Push is unconditional.** HEAD is always pushed, exactly like `commitAndPush`, so a removal commit
  stranded by a crash between commit and push is recovered on the resume re-run. Pushing an
  already-up-to-date HEAD is a no-op — it never errors on the clean path.
- **Daemon-authored commit.** Use `DAEMON_IDENTITY` so it succeeds even in a tree with no configured
  `user.name`/`user.email`.

## 3. Fake implementation — `src/integration/github-fake.ts`

Add the method to the fake plus a public recorder for assertions, mirroring the existing
`savepoints` / `finishedMerges` / `abortedMerges` lists:

```ts
/** Recorded `stripAgentArtifacts` calls — assert the strip fired exactly when expected (agents-fsm#21). */
readonly strippedArtifacts: Array<{ runId: number; branch: string }> = [];

async stripAgentArtifacts(runId: number, branch: string, message: string): Promise<CommitRef | null> {
  this.strippedArtifacts.push({ runId, branch });
  return { sha: /* a synthesized deterministic sha, e.g. `strip-${runId}` */ };
}
```

- Every call is recorded (so a runner test asserts count + branch). The fake always returns a
  synthesized `CommitRef` (there is no in-memory `.agent/` model to gate on) — the runner-level tests
  assert on the recorder, not on the return value.
- Keep the synthesized sha deterministic (derive from `runId`/`branch`, no clock/random) to match the
  fake's existing style.

---

## 4. Runner integration — `src/agent/runner.ts` `applyStageEffects`

Extend the **review branch** of `applyStageEffects` (currently ~lines 770–783, the `io.kind === 'review'`
block that posts PR comments). After the comment-posting loop, fire the strip **only** on a terminal
approving review that has an open PR:

**Gate (all three required):**
1. `io.kind === 'review'` — already the enclosing branch.
2. `run.prNumber !== null` — excludes `plan_review` (no PR yet → never strips before `interface_design`,
   which still needs `.agent/plan.md`).
3. `envelope.requestedTransition === 'approve'` — excludes `request_changes`, so the artifacts survive
   the frontend/backend re-run they feed. In the default pipeline this matches **only** `code_review`'s
   `approve` → `done` edge (`plan_review` is already excluded by gate #2).

**Action:**
- Call `await github.stripAgentArtifacts(run.id, prep.branch!, <message>)` after the comment loop
  (`prep.branch` is always set by `prepareStage`). Use a clear commit message, e.g.
  `` `chore(run ${run.id}): remove .agent scratch artifacts before merge` ``.
- On a non-`null` return, record a log line (mirror the base-sync `this.repo.recordLog({...})` shape),
  e.g. message `stripped .agent scratch artifacts from <branch> before merge`, `data: { kind:
  'strip_artifacts', stage: run.currentState }`. A `null` return may be logged or silently skipped —
  no log line is also acceptable since nothing changed.
- **Return the same (comment-enriched) envelope** the review branch already returns — do **not** add a
  new artifact record (removal is the point). Preserve the existing
  `appendArtifact(envelope, { kind: 'review', … })` return when comments were posted.

**Structural note (important):** the current review branch has an early
`if (run.prNumber === null || comments.length === 0) return envelope;` that returns before any strip
could run. A `code_review` approval with **zero** comments must still strip. So the strip must be
evaluated on the `run.prNumber !== null && requestedTransition === 'approve'` path **independently of
whether comments exist** — restructure so the "no comments" early-return does not bypass the strip.
The `tdd` tests will assert: *approve with zero comments still strips.*

**Idempotency / re-entry:** safe to fire again on a second approval (a PR-feedback cycle re-approving)
because the adapter's `git rm --ignore-unmatch` + commit-if-changed returns `null` the second time
(it still pushes HEAD, a no-op when already up to date). The same unconditional push is what recovers a
strip that committed locally but crashed before pushing (push failure → `effectsError` → escalate; the
human resume re-runs `applyStageEffects`): the re-run finds status clean, returns `null`, yet pushes the
stranded removal commit so `.agent/` still never reaches `main`. The runner needs no guard of its own;
the M7 ledger is **not** required here (the operation is naturally idempotent), matching how the
base-sync side effect is un-ledgered.

**Do not** touch the produce branch of `applyStageEffects`, `commitAndPush`, `ensurePr`, or the base
sync.

---

## 5. Explicitly unchanged (closes the issue's "update path assumptions" item)

- **Artifact paths stay fixed** at `.agent/plan.md` and `.agent/interface.md`. Therefore:
  - `recordArtifact` locators and the `interface` artifact this stage records
    (`{ kind: 'interface', locator: { path: '.agent/interface.md' } }`) are unchanged.
  - Prompt path references (`prompts/stages/plan.md`, `interface_design.md`, `tdd.md`, `code_review.md`)
    and `src/agent/executor.ts` golden-path locators need **no** change.
  - Mid-run handoff (later stages reading `.agent/*.md` from fresh worktrees) is untouched; the only
    new behavior is the removal from the branch tip at the very end.
- The existing merge-conflict handling (base sync + `conflict_policy` + `resolve_conflicts` resolver
  stage) is out of scope and stays exactly as-is.

---

## 6. Invariants the implementation must uphold (checklist for `tdd`)

1. `stripAgentArtifacts` removes **only** `.agent/**`; all other tracked files are untouched.
2. Present `.agent/` → one daemon-authored removal commit is created + pushed; returns a `CommitRef`.
3. Absent `.agent/` (already stripped / never created) → **no commit**, returns `null` — but HEAD is
   **still pushed** (idempotent no-op). `tdd` must NOT assert "no push when already stripped"; the push
   is unconditional so a stranded removal commit is recovered.
4. **Crash recovery:** a strip that committed the removal locally but failed to push, then re-runs
   (escalate → human resume → `applyStageEffects` re-runs), pushes the stranded commit on the re-run so
   origin's branch tip loses `.agent/`. After a strip, merging the branch into `main` produces **no
   conflict** and `main` contains no `.agent/` files.
5. Two runs' branches (each adding then stripping their own `.agent/plan.md` + real code) merge into
   `main` sequentially with **no manual conflict resolution** — the acceptance-criteria proof.
6. Runner: `code_review` **approve** (PR present) → strip fires exactly once with the run's branch —
   including when there are **zero** review comments.
7. Runner: `code_review` **request_changes** → **no** strip.
8. Runner: `plan_review` **approve** (no PR) → **no** strip.
9. Runner: a PR-feedback re-entry that approves again → strip is idempotent (adapter returns `null`,
   no error).

---

## 7. Files to change (for `tdd` + implementation)

- `src/integration/github.ts` — add `stripAgentArtifacts` to the `GitHub` interface (§1).
- `src/integration/github-cli.ts` — real implementation (§2).
- `src/integration/github-fake.ts` — fake implementation + `strippedArtifacts` recorder (§3).
- `src/agent/runner.ts` — fire the strip on terminal code-review approval in `applyStageEffects` (§4).
- `README.md` — note that `.agent/` artifacts are branch-local scratch stripped at `code_review`
  approval (never land in `main`, never cause cross-run conflicts), while remaining readable during
  the run.
- Tests: `src/integration/github-cli.test.ts` (real-git strip + sequential-merge), `src/agent/runner.test.ts`
  and/or `src/loop/event-loop.test.ts` (gate behavior via the fake), `src/integration/github-fake.test.ts`
  if it covers new adapter methods.
