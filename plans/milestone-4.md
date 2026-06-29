# Milestone 4 — Real agents (design + plan)

> Status: **M4a done** (orchestration plumbing on fakes + stub); **M4b code-complete** (real prompts,
> the `SystemPromptFn` loader, CLI real mode, and an offline real-prompt e2e — 204 tests passing,
> +1 flag-gated real run skipped by default). The only remaining M4b item is the operator running
> the flag-gated, token-spending end-to-end run against tmux-speedrun (§6), which needs the
> operator-created issue and live `gh`/API auth — it is not part of `npm test`. This document records
> the decisions and task breakdown for M4. It assumes the README is the source of truth for the
> overall architecture; it only covers what is new or undecided for M4. Keep it current as M4 lands.

## 1. Goal and scope

Replace the stub agents with **real** ones: write the per-stage and per-phase prompts, wire the
real Claude Code subprocess executor and the GitHub adapter into the Agent Runner, and run the
full pipeline against a real repository and issue.

**Test repository for the first real run:** https://github.com/jzohdi/tmux-speedrun

### In scope
- Per-stage system prompts (one role per FSM state) and per-phase prompts (self-review rubric,
  cleanup/simplify), plus the envelope-contract instructions all agents must obey.
- Wiring the **working-tree lifecycle** and GitHub side effects into the Agent Runner:
  read issue, prepare the tree, commit/push, open the PR (idempotently), post review comments.
- Bounded retry on malformed agent output, then escalate (README §3.3 Layer 4).
- Structured escalation on git/GitHub failure plus a minimal CLI `resume` so a parked run can be
  fixed and continued (§3.10).
- A real, flag-gated end-to-end run against tmux-speedrun.

### Out of scope (deferred, with the milestone that owns it)
- Triage writing the machine-readable scheduling block into the issue body → **M9** (Scheduler).
  M4 triage only routes (proceed / needs-more / split-as-escalation).
- The HTTP/WS API and dashboard, and the full pause/stop/revert control surface → **M5/M6**.
  M4 ships only the minimal `resume` the real run needs.
- Auto-merge → never in MVP; `done` is merge-ready, a human merges.
- Orchestrator-level "re-run the repo's tests after cleanup" guard → not needed; the agent runs
  the tests itself (§3.7).

## 2. What M3 already left in place

So this document is self-contained — the seams M4 builds on already exist and are tested:

- `StageExecutor` seam (`src/agent/executor.ts`) with `StubExecutor` and the real
  `SubprocessStageExecutor` (`src/agent/subprocess-executor.ts`). Request carries optional
  `workingDir` and `allowedTools`.
- `GitHub` adapter (`src/integration/github.ts`): `readIssue`, `prepareWorkingTree`,
  `commitAndPush`, `readDiff`, `openPr`, `updatePr`, `postComment` — with `FakeGitHub`
  (everyday test double) and the real `GitHubCli` (`git` + `gh`).
- `AgentRunner` (`src/agent/runner.ts`) runs the phase recipe and already takes a
  `systemPrompt: SystemPromptFn` option (currently a placeholder) and a `resolveWorkingDir`
  option (a seam M4 will fulfil properly).
- The output contract (`src/agent/envelope.ts`): `parseEnvelope` / `parseReviewVerdict`.
- The loop↔executor composition is proven offline by `src/integration/loop-subprocess.test.ts`.

## 3. Key design decisions

### 3.1 The Agent Runner owns the working-tree lifecycle and GitHub side effects

README §3.3 Layer 4 already assigns "build the agent's input from durable artifacts," "check the
run's recorded state so the action is idempotent (`tdd` updates an existing PR…)," and "validate
and persist the agent's structured output" to the Agent Runner. So the git/GitHub work that
**brackets** each agent invocation belongs in the runner, not the loop.

- The runner gains a `GitHub` dependency (injected; `FakeGitHub` in tests, `GitHubCli` for real).
- The **Event Loop stays almost unchanged**: it still asks the engine for the next state, commits
  the transition, merges flags, records `envelope.artifacts`, and enqueues the follow-up event.
  The runner enriches `envelope.artifacts` with real locators (branch/sha/PR) before returning,
  so the loop's persistence path is untouched.
- The runner calls `setRunBranch` (when it first creates the branch) and `setRunPr` (when it
  opens the PR) directly — these are run-row updates, not artifacts.
- This also fulfils the M3 `resolveWorkingDir` placeholder: the runner prepares the tree and
  passes `tree.path` to the executor as `workingDir`, so that option can be removed.

**Rationale:** smallest change that honors the documented layering; keeps the loop about
event/transition mechanics and the runner about "run one stage end to end."

### 3.2 Per-stage I/O is declared, not hardcoded

Stages differ in their git/GitHub effects. Rather than match stage names in the runner, declare a
tiny per-stage descriptor in the agent recipe (`StageAgentConfig`), defaulting sensibly:

```jsonc
// in default-config.json "agents"
"triage":      { "io": { "kind": "triage" } },
"tdd":         { "io": { "kind": "produce", "opensPr": true } },
"plan_review": { "phases": ["produce"], "io": { "kind": "review" } },
"code_review": { "phases": ["produce"], "io": { "kind": "review" } }
// every other stage defaults to { "kind": "produce" }
```

`kind` is one of:

| kind | working tree | input to agent | agent edits files | after a handoff |
|------|--------------|----------------|-------------------|-----------------|
| `triage` | none (no branch yet) | issue title + body | no | nothing — just routes |
| `produce` | ensure tree (create branch first time) | issue; artifacts already in the tree (read via file tools) | yes | `commitAndPush`; if `opensPr` and no PR yet → `openPr` + `setRunPr`; record artifacts |
| `review` | ensure tree (read-only tools) | artifacts in the tree via file tools; **plus the injected branch diff for `code_review`** | no | post comments from the envelope; no commit |

This descriptor is part of the version-pinned config, so a reconfigured FSM declares the effects
of any new stage. It folds into the existing recipe for cohesion (all "how this stage runs").

Note the two `review` stages differ in *what* they read: `plan_review` reads `.agent/plan.md`
directly via the harness's read-only file tools, while `code_review` also gets the computed branch
diff injected (§3.6) — so the runner injects a diff only for code review, not all review stages.

### 3.3 Working-tree lifecycle and idempotency

- **Branch** is created when the run first reaches a `produce`/`review` stage (i.e. `plan`),
  named `agent/run-<id>` (unique — one run per issue). Recorded via `setRunBranch`.
- **Base branch** is per-repo config (e.g. `main`); the branch is created off `origin/<base>`.
- **PR** is opened at `tdd` only when `run.pr_number` is null; recorded via `setRunPr`.
- **Updating the PR is just pushing.** Once a PR tracks the branch, later `produce` stages
  (`frontend`/`backend`) and `tdd` back-edge re-runs simply `commitAndPush`; GitHub reflects the
  new commits automatically. `updatePr` (metadata) is available but not part of the basic flow.
- Every operation is idempotent by construction: `prepareWorkingTree` (M3: local → remote →
  base resolution), `commitAndPush` (no-op when nothing staged), `openPr` (guarded by
  `pr_number`). Back-edge re-runs and crash recovery never duplicate a PR, branch, or commit.
- **PR open is find-or-create, not just `pr_number`-guarded.** There is a crash/resume window
  between `openPr` succeeding and `setRunPr` persisting the number. So at `tdd`, when `run.pr_number`
  is unset, the runner first asks the adapter whether an open PR already exists for the branch and
  adopts it; only otherwise does it open one. This needs a small `findOpenPrForBranch(branch)` on
  the `GitHub` interface (the real adapter already does `gh pr view <branch>`; the fake adds the
  lookup). Without it, a resume after that window would try to open a second PR and fail.
- **Working root** is a stable configured dir (e.g. `./.agent-work`, gitignored), not the OS temp
  dir, so trees survive a daemon restart. (M3's recovery path still handles a lost tree.)
- **Artifacts:** the agent's envelope declares what it wrote (kind + path); the runner enriches
  each ref with `branch` + the commit `sha` after push, and adds the `pr` artifact (number/url)
  it created. Agents never invent PR numbers or SHAs.

### 3.4 Prompt architecture

- **Append, don't override.** Use `--append-system-prompt` (already what the executor does) so the
  agent keeps Claude Code's tool-use competence; we append only the stage role + output contract.
- **Prompts are files, composed by a real `SystemPromptFn`.** Lay them out under
  `src/agent/prompts/`:
  - `stages/<stage>.md` — the role/instructions for that FSM state.
  - `phases/self_review.md` — the correctness rubric (parameterized by stage where needed).
  - `phases/simplify.md` — the cleanup/simplify instructions.
  - `envelope-contract.md` — the exact JSON the agent must emit as its final message.
  `SystemPromptFn(stage, phase)` composes: stage role + phase instructions + the matching output
  contract (envelope for produce/simplify, verdict for self_review). Loaded once at startup.
- **Prompts are code, not config.** They are version-controlled with the source and are **not**
  part of the FSM config hash. Consequence: a prompt edit can affect an in-flight run on a
  back-edge re-run. Accepted for the MVP (prompts evolve slowly, runs are short); hashing prompts
  into the pinned version is a possible later hardening. Recorded here so it is a decision, not a
  surprise.
- The envelope contract instruction is the single most important prompt: "your final message must
  be exactly this JSON and nothing else." Validation stays strict (`envelope.ts`); we never coerce.

### 3.5 Bounded retry on malformed output

README §3.3 Layer 4: on invalid/missing output the runner "retries the call a bounded number of
times … if the output still fails schema validation, escalate to `needs_human` with the raw
output." Today the runner escalates immediately (M3 left retry as a TODO). M4 adds it:

- A small `malformedRetryCap` (configurable, default 1–2) on the runner.
- On a phase whose output fails `parseEnvelope`/`parseReviewVerdict`, re-invoke that phase up to
  the cap (LLM nondeterminism often yields valid JSON on a retry), then escalate
  (`malformed_output`) with the raw output attached. Transport failures (the executor *throws*)
  remain the executor's own retry/backoff concern (Layer 5) — this is only for schema failures.
- Each retry still records its `agent_runs` row (now including the M3 `success: false` failure
  rows), so the cost of retries is visible in telemetry.

### 3.6 Diff handling for review stages

For `code_review`, the runner reads the diff via `github.readDiff({ workingDir, base, branch })`
once and includes it in the agent input (deterministic, and the review agent needs only read-only
tools — no `Bash(git diff)` grant). `plan_review` needs no diff; it reads `.agent/plan.md` via file
tools. Note a **size cap**: if the diff is very large, truncate with a marker and lean on the
agent's file-reading tools for detail; a smarter chunking strategy is a later concern, not MVP.

### 3.7 The agent verifies its own tests (decided)

README wants the `tdd` failing-tests contract and interface spec re-checked after the simplify
pass. There were three ways to do it: trust the agent blindly, have the *orchestrator* run the
repo's tests, or have the **agent** run the tests as part of its own work. We take the middle one.

**Decision:** the agent owns running the tests. We keep the produce → self-review → simplify
sequence, and Claude Code (the harness) already has the ability to run a project's test suite — so
each producing agent runs the tests itself and confirms it did not break anything before handing
off. The orchestrator does **not** run tests, and there is no per-repo `testCommand` config; the
agent discovers and runs the project's tests (e.g. `npm test`, `cargo test`) like any engineer.

This makes two things load-bearing, both handled in M4:
- **Tool allow-list.** Producing stages must include a test-running tool (e.g. `Bash`) in their
  `allowedTools` (§3.2), or the agent cannot verify. Review stages stay read-only.
- **Prompts.** The self-review and simplify prompts (§3.4) explicitly require running the tests
  after any change and confirming the contract holds: implementation stages leave the suite
  passing; the `tdd` stage leaves the new tests failing-as-designed. If the agent cannot get the
  tests into the expected state within its bounded loop, the stage escalates to `needs_human`
  (the existing internal-review-cap path) — never a silent hand-off.

### 3.8 Secrets and configuration

- `ANTHROPIC_API_KEY` — consumed by the `claude` harness from the environment (we never call the
  model API directly).
- GitHub auth — the `gh` CLI's own auth (`gh auth login` or `GH_TOKEN`). The adapter shells out to
  `gh`, so no token lives in our process or SQLite.
- Both come from the environment / a local `.env` (gitignored), never committed, never in SQLite
  (README §3.3 Layer 5).
- **Run/repo config** the CLI (and later the API) needs: repo slug (`jzohdi/tmux-speedrun`), base
  branch (`main`), working root (`./.agent-work`), and the issue number. For the MVP single repo
  this is a small config object / CLI flags; the multi-repo `repos` table is M8.

### 3.9 Model defaults

Keep the M3 defaults — producing/critiquing phases use the `frontier` logical model, the simplify
pass uses `cheap`; the subprocess executor maps `frontier→opus`, `cheap→haiku`. Tune per stage in
`default-config.json` `agents.models` only if a real run shows it is needed. No new mechanism.

### 3.10 Failure handling, escalation, and resume (decided)

A real run *will* hit transient failures (a rejected push, an expired token, a GitHub hiccup). We
handle them gracefully and make the run **recoverable**, not restart-from-scratch.

- **Catch and label, don't crash.** Git/GitHub failures in the runner are caught and turned into a
  structured escalation — the runner returns an `escalate` outcome with a labeled reason (e.g.
  `{ kind: 'git_error', op: 'push', detail }`) instead of a bare throw. The loop parks the run in
  `needs_human` and the exact cause is written into the transition log.
- **"Wait for a human" already works.** A `needs_human` run holds no executor — the dispatch gate
  (M3) leaves its events parked until the run is `running` again. So the system genuinely waits.
- **Notify.** For the MVP the notification is the transition log plus the loop's `onTransition`
  stream, which the CLI prints. A real push/email/desktop notification channel is M5/M6.
- **Resume where we left off (new in M4).** A CLI `resume <runId>` command lets the operator, after
  fixing the cause, continue from the stage that failed. It finds the escalation transition's
  `from_state` (the stage that was running), appends a manual transition back to it with status
  `running` and a **round-counter reset** (a fresh budget of rounds, per README §3.3 Layer 6), then
  enqueues an advance event. The loop re-dispatches that stage — safely, because every side effect
  is idempotent (§3.3): no duplicate branch, PR, or commit. Full pause/stop/revert and
  resume-from-any-state arrive with the API + dashboard (M5/M6); this is the minimal
  recover-and-continue the real run needs, and it shares the underlying repo logic the API will reuse.

## 4. Phasing

Split M4 so the deterministic plumbing is rock-solid before spending real tokens:

- **M4a — Orchestration plumbing (fakes + stub, fully unit-tested).** §3.1–3.3, §3.5, §3.6, §3.10
  wired with `FakeGitHub` and `StubExecutor`. No prompts, no money. Proves the working-tree
  lifecycle, idempotency, retry, structured git-failure escalation, and `resume` with deterministic
  tests.
- **M4b — Real prompts + real run.** §3.4 prompts (with the §3.7 test-verification instructions)
  and the real `SubprocessStageExecutor` + `GitHubCli`, then the flag-gated end-to-end run against
  tmux-speedrun.

## 5. Task breakdown (ordered; each step testable)

**M4a — done.** All steps below landed (`src/agent/runner.ts` lifecycle, `StageIo` config,
`findOpenPrForBranch`, malformed-retry, `resume`), covered by `runner-lifecycle.test.ts`, the
updated runner/event-loop suites, and config/adapter tests.
1. Add the `io` descriptor to `StageAgentConfig` (zod schema, `recipeFor`, validation that
   `opensPr` only appears on a `produce` stage). Add per-stage `allowedTools` to
   `default-config.json` — producing stages get edit + a test-running tool (§3.7), review stages
   read-only. Update `default-config.json` `io`.
2. Add `findOpenPrForBranch(branch)` to the `GitHub` interface, `FakeGitHub`, and `GitHubCli`
   (§3.3); inject `GitHub` into `AgentRunner`; add per-run config (base branch, branch name,
   working root).
3. Implement the per-stage I/O in the runner: `triage` (read issue), `produce` (prepare tree →
   run phases → commit/push → find-or-open PR if flagged → enrich artifacts), `review` (prepare
   tree → inject diff for `code_review` → run phases → post comments). Replace `resolveWorkingDir`
   with the prepared tree. Catch git/GitHub failures and return a structured `escalate` (§3.10).
4. Add bounded malformed-output retry (§3.5).
5. Add the `resume <runId>` CLI command and its repo support (§3.10): manual transition back to the
   escalated-from stage, counter reset, enqueue an advance event.
6. Tests (FakeGitHub + StubExecutor): branch created once at `plan` and reused; PR found-or-opened
   once at `tdd` and not duplicated on a `tdd` back-edge or after a simulated open/persist crash;
   commit/push per producing stage; review stage posts comments and does not commit; triage touches
   no tree; artifact locators carry branch/sha/PR; malformed → retry → escalate; a git failure →
   structured `needs_human` escalation; `resume` continues the parked run to `done`; the full
   pipeline reaches `done`. Extend `loop-subprocess.test.ts` to drive the whole lifecycle through
   `FakeGitHub`.

**M4b** (steps 7–9 done; step 10 is the operator-run live pass)
7. **Done.** Prompts authored under `src/agent/prompts/` (`base.md`, `envelope-contract.md`,
   `verdict-contract.md`, `phases/{self_review,simplify}.md`, `stages/<stage>.md`) with the §3.7
   test-verification instructions; the real `SystemPromptFn` loader is `createSystemPromptFn`
   (`src/agent/prompts.ts`) — eager, fail-fast, composing base + stage role + phase instructions +
   the matching contract (verdict for `self_review`, envelope otherwise). `triage` and `code_review`
   carry the most logic.
8. **Done.** The real-mode wiring lives in one shared, testable factory (`src/real-run.ts`,
   `buildRealRunner`): `SubprocessStageExecutor` + `GitHubCli` + the real prompts, plus the §6
   cost-control `forceCheapModels` override. The CLI (`src/cli.ts`) exposes it as `--real` with
   `--repo`/`--base`/`--work`/`--cheap`; default stays stub/fake. The gated e2e reuses the same
   factory so the wiring can't drift.
9. **Done.** Internal-sequence test: a self-review that finds and fixes a **seeded defect**, asserting
   the simplify-corrected envelope (not produce's) is handed off (`runner.test.ts`); the cap→escalate
   path was already covered. An offline real-prompt e2e (`real-prompts-e2e.test.ts`) drives the loop
   with the real prompts + real executor over a fake harness, asserting a well-formed composed prompt
   on every invocation and a run to `done`.
10. **Pending operator action.** The flag-gated live run (§6) is wired as `real-e2e.test.ts`
    (`RUN_REAL_E2E=1`, skipped by default) and runnable via the CLI `--real`; it awaits the
    operator-created tmux-speedrun issue and live auth, and spends tokens, so it is not run here.

## 6. Real end-to-end run (tmux-speedrun)

A real run costs tokens, and creates a real branch + PR — so it is **not** part of `npm test`.

- **The first issue (operator-provided):** the repo owner will create an issue on
  `jzohdi/tmux-speedrun` for **improving the home page with some UI/UX changes**, before the run,
  and provide its number. This is the first full end-to-end target. (A UI/UX change is a good first
  test: it exercises the `frontend` stage and produces a visible, reviewable PR.)
- **Preconditions:** `gh auth status` is logged in with push access to `jzohdi/tmux-speedrun`;
  `ANTHROPIC_API_KEY` set; the home-page issue exists and its number is known.
- **Harness permissions:** producing stages need the harness to edit files and run the tests
  autonomously. The per-stage `--allowedTools` grant (Edit/Write/Bash) should suffice in headless
  `-p` mode; if the first run shows the harness still refusing to act, widen the policy via
  `SubprocessStageExecutor`'s `extraArgs` escape hatch (e.g. `--permission-mode acceptEdits`) — kept
  out of the CLI for now rather than guessing the exact flag before the first run proves what is
  needed (§3.2 tool allow-list, §3.7).
- **Procedure:** run the CLI in real mode against the repo + issue number, e.g.
  `npm start -- 'jzohdi/tmux-speedrun#<n>' --real --base main --work ./.agent-work --db ./.agent-work/run.db`
  (a file `--db` makes the run resumable); watch it advance to `done`; inspect the opened PR and the
  committed artifacts (`.agent/plan.md`, `.agent/interface.md`, tests, code) and the review comments.
  The same flow is also runnable as a gated vitest (`RUN_REAL_E2E=1 E2E_ISSUE=… npm test`), which
  asserts a terminal state and a PR on `done`.
- **Gating:** a `RUN_REAL_E2E=1`-style flag (mirrors `RUN_REAL_HARNESS` / `RUN_REAL_GITHUB`).
- **Cleanup:** because the MVP does not auto-merge, the run stops at merge-ready; the human
  inspects, then closes the PR / deletes the branch (or merges if the change is genuinely good).
- **Cost control:** start with the cheap model for all phases on the first run to shake out
  plumbing, then switch to the real model defaults.

## 7. Decisions made

The four open questions are now resolved (operator sign-off):

1. **Prompt strategy → append.** Use `--append-system-prompt`; keep Claude Code's tool-use
   competence and layer the stage role + output contract on top (§3.4).
2. **Cleanup verification → the agent runs the tests.** Keep produce → self-review → simplify; the
   agent verifies the test contract itself via the harness's test-running ability. No orchestrator
   test-runner, no `testCommand`. Producing stages get a test tool in their allow-list and the
   prompts make verification explicit (§3.7).
3. **Git/GitHub failures → structured escalation + resume.** Catch failures, label them, park the
   run in `needs_human` with the cause in the log, and provide a CLI `resume` so the operator fixes
   the cause and continues from where it left off (§3.10).
4. **First real issue → home-page UI/UX, operator-created.** The repo owner creates the issue on
   tmux-speedrun before the run and supplies its number (§6).

## 8. Definition of done

- M4a: the full lifecycle runs to `done` on `FakeGitHub` + `StubExecutor` with all the step-5
  tests green; idempotency (no duplicate PR/branch/commit) proven, including a `tdd` back-edge.
- M4b: prompts authored; a real run against tmux-speedrun reaches `done` with a coherent PR, plan,
  interface spec, failing-then-passing tests, and review comments; malformed-output and
  cap→escalate paths verified on stubs.
- `npm run typecheck`, `npm run lint`, and `npm test` stay green; real-cost paths stay flag-gated.
