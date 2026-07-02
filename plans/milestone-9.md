# Milestone 9 — Multi-issue async + dependency ordering (design + plan)

> Progress: **S1–S5 all done → Milestone 9 COMPLETE.** Suite green (run `npm test` for the count;
> the skips are the flag-gated real-integration tests); typecheck / lint / `check:dashboard` clean;
> `src/fsm/` diff empty, as required.
> - **S1 — pure core:** `issue-markers.ts` (strict field-by-field parse; byte-stable idempotent
>   upsert; the close fence is line-anchored so a `-->` inside a quoted order_key can't truncate the
>   block, and replacement uses a function so `$`-patterns in keys are inert) + `scheduler.ts`
>   (`isSatisfied`, Tarjan `detectCycles` — deterministic output order, self-deps are one-node
>   cycles — and `compareRuns`, which compares order keys as **UTF-8 bytes** to match SQLite BINARY).
> - **S2 — store + gate:** migration 8 `add runs scheduling columns`; `setRunScheduling` clears the
>   latch iff the canonical dep set changed (one atomic CASE); `stampDepsSatisfied`;
>   `findActiveRunByIssue`; `setRunIssueRef` resets scheduling; the claim gained the dependency
>   predicate + the Scheduler ORDER BY (issue number computed from `issue_ref` in SQL). The
>   SQL-vs-`compareRuns` cross-check test pins the two encodings together. No existing test broke.
> - **S3 — declaration write path:** triage envelope `scheduling` (snake_case mirroring the marker
>   fields; zod `.catch` drops malformed fields — advice, never an escalation); the runner splices
>   via `upsertMarker` with **carry + overlay** semantics (a human block survives an agent body
>   rewrite; a partial declaration never wipes other fields) and caches on the run unconditionally
>   at triage-commit, so the gate applies before any poller tick; split-handoff resets the cache.
> - **S4 — the poller (the crux):** `Issue.state` ('closed' = satisfaction signal; unknown reads as
>   open — the safe direction) + `dropWorkingTree` + fake `closeIssue` mutator; loop control methods
>   `parkBlocked`/`wakeBlocked` (status-only, pending event survives) +
>   `escalateDependencyCycle` (discards pending events; `resumeRun` works unchanged);
>   `scheduler-poller.ts` — per-repo evaluation, per-tick memoized issue reads, refresh→cycles→
>   latch→flips, tree drop *before* the wake flip, never parks a run with a stage in flight,
>   per-run error isolation; Orchestrator owns it (`checkDependencies` kicks the pump after wakes) +
>   duplicate-issue 409 on `start`; `POST /scheduler/check`; serve timer on the shared
>   `--poll-interval`. The README gate e2e (`dependency-gate.test.ts`) runs under `drain(3)`:
>   B parks after triage, ignores A's `done`, wakes on issue-close, finishes on a fresh tree,
>   golden sequences exact for all runs.
> - **S5 — mirror + surfaces:** `setPrLabels` (swap `af:*`, keep human labels) + the best-effort
>   `stateLabelMirror` Broadcaster subscriber (fire-and-forget, logged failures); dashboard
>   `waitingOn`/priority badges + RunDetail scheduling line + `dependency_cycle` escalation
>   guidance (all via pure render models); README §9.9 operating guide + §8 status entry.
>
> Deliberate scope notes: dependency workflows need the daemon (the one-shot CLI exits with a
> dependent run parked — documented); the PR-merged fallback for non-default base branches stays
> deferred (§5) with the auto-close caveat documented in §9.9.

> Scope: builds on M0–M8 (all complete). M9 runs **several issues from one repo at once, respecting
> declared dependencies** (README §5 Milestone 9). The concurrency machinery is *not* built here — the
> M8 Phase B worker pool, per-run trees, atomic claim, and global caps are reused as-is. What is
> genuinely new is the **deterministic ordering layer**: a pure Scheduler, the issue marker codec
> (README §3.5), a dispatch gate that parks dependent runs in `blocked` until their dependencies are
> **merged/closed** (not merely `done`), and the wake path. The FSM engine and its tests are untouched
> (`src/fsm/` is frozen, as in M8) — ordering lives entirely beside the engine, never inside it.

## 1. Goal and scope (README §5 Milestone 9)

Run several issues concurrently with ordering **enforced at pickup time** (README §3.3 Layer 3): a
dependent run is never dispatched against unmerged work, and among dispatchable runs the pick order is
**total and deterministic** — `priority` (desc), `order_key` (asc), issue number (asc). Concretely:

- **Scheduler module** (pure, deterministic — "the most test-worthy new component, on par with the FSM
  engine"): dependency satisfaction, cycle detection → `needs_human`, and the run comparator.
- **Issue marker parse/write** (§3.5): the sentinel `<!-- agent-orchestrator:v1 … -->` block, declared
  by `triage` (or a human) in the issue body, parsed only ever deterministically.
- **Dispatch gate + `blocked` status**: ineligible runs park; they wake when a dependency actually
  clears — PR merged / issue closed, a hard external signal — not when its run reaches `done`.
- **Base-branch discipline (§3.1, firm invariant):** a dependent run's implementation work starts only
  after its dependencies are merged, branching off up-to-date base. Since the MVP never auto-merges,
  dependent runs deliberately wait for the human merge.
- **PR linkage + state-label mirror** (§3.5): `Closes #N` + run id in the PR body (verified already
  present in `prBody` — no work), and an `af:<state>` label mirroring the run's FSM state — a
  derived view, best-effort.

**Reused, not rebuilt:** the M8 B1 pool (`EventLoop.drain`, parallel across runs / serial within a
run), the atomic status-gated claim, per-run worktrees, the cost ceiling, and the poller pattern
(Reply Poller / PR Feedback Poller — `checkOnce` pure-ish core + thin timed driver, injected sleep).

**Out of scope:** cross-repo dependencies (markers carry bare issue numbers — same-repo by
construction), webhooks (polled signals, like every other GitHub signal in the MVP), auto-merge,
continuous repo pickup (M11 — it composes this milestone's Scheduler and merged-signal), the Agent
SDK executor (M10), and any `src/fsm/` change.

## 2. The design in one page — where each concern lives

The M8 claim is already the dispatch gate (`claimNextEvent`: single atomic `UPDATE … RETURNING`,
gated on `runs.status = 'running'`, within-run serial guard, cost gate). Repository.ts even marks the
slot: *"the richer deterministic Scheduler (Milestone 9) slots in at this same point."* M9 extends
that claim with two things it can evaluate from **cached local columns** — a dependency predicate and
a deterministic `ORDER BY` — and puts everything that needs the *network* (reading issue markers,
checking whether a dependency's issue is closed) in a poller. The split that keeps it simple:

- **The SQL claim is the correctness gate.** A run with cached unsatisfied dependencies is never
  claimable, no matter what its status says. Airtight under the pool because it is inside the one
  atomic claim statement — no TOCTOU against a comparator applied outside it.
- **The `blocked` status is the visibility mirror.** The Scheduler Poller flips `running ↔ blocked`
  so the operator/dashboard see *why* a run isn't moving. Correctness never depends on the flip
  having happened yet.
- **Satisfaction is a latch, monotone per declaration.** A merged PR stays merged; once every
  dependency clears, the poller stamps `deps_satisfied_at` and never re-checks. The one thing that
  can re-block a run is the declaration itself changing — a human adding a dependency to the issue —
  so `setRunScheduling` clears the stamp whenever the `depends_on` set changes and the poller
  re-verifies. No flapping, and the claim predicate is a cheap column test the rest of the time.
- **`triage` declares, the runner writes, the issue owns.** The triage envelope gains an optional
  structured `scheduling` field; the **runner** splices the sentinel block into the issue body it
  already writes (deterministic formatting — the agent supplies values, never the byte format), and
  caches the parsed declarations on the run row in the same breath. The issue stays the owner (§3.5):
  the poller re-reads it every tick, so a human editing the block wins.

### Dependency satisfaction: issue-closed is the signal

A dependency (an issue number) is satisfied when that **issue is closed**. This is the one hard,
externally verifiable signal that unifies both README cases (§3.5 "PR-merged / issue-closed"):

- A fleet-managed dependency: our PRs carry `Closes #N` (already written by the runner), so GitHub
  closes the issue **at merge into the default branch** — issue-closed *is* PR-merged. A run that is
  merely `done` (merge-ready, PR open) leaves its issue open, so dependents keep waiting for the
  human merge — exactly the README-required distinction.
- A human-managed dependency (no run): the human closes the issue when the work lands.

A human closing an issue *without* merging ("won't fix") deliberately dismisses the dependency —
that reads as correct, and it keeps the check to a single `readIssue` per dependency instead of an
issue→run→PR lookup chain. **Caveat to document (README §9):** auto-close fires only when the PR
merges into the *default* branch; a repo whose `base_branch` isn't the default needs the human to
close the issue on merge. (Decision to confirm before coding; the fallback design is
issue-closed **or** tracked-run-PR-merged via `getPr`, a strict superset we can add later without
schema change.)

## 3. Building blocks

### 3.1 Issue marker codec — `src/integration/issue-markers.ts` (new, pure)

The §3.5 block, exactly as specified:

```
<!-- agent-orchestrator:v1
depends_on: [42, 57]
priority: 10
order_key: "2026Q3-auth-03"
-->
```

- `parseMarker(body) → SchedulingDecl | null` — strict, line-based, hand-rolled (no YAML library):
  `depends_on` a bracketed list of positive integers, `priority` an integer, `order_key` a quoted
  string. Every field optional; absent block or absent field → defaults (`[]`, `0`, `''`). A
  malformed field is ignored field-by-field (defaults apply) — the Scheduler must never crash on
  prose, and a human hand-editing badly degrades to "no declaration," not an escalation.
- `upsertMarker(body, decl) → string` — replace the existing sentinel block or append one; writing
  the same declaration twice is byte-identical (idempotent, safe under back-edge re-runs of triage).
- `SchedulingDecl = { dependsOn: number[]; priority: number; orderKey: string }` — canonicalized:
  `dependsOn` sorted, de-duplicated.

Codec goes in `src/integration/` because it is the GitHub-body encoding concern (the marker's home
is the issue); the Scheduler consumes the parsed struct and never sees markdown.

### 3.2 Pure Scheduler — `src/loop/scheduler.ts` (new, pure)

Knows nothing about GitHub, SQL, or time. Three functions, table-driven-testable like the engine:

```ts
/** Every dependency closed? (The poller supplies which issue numbers are closed.) */
isSatisfied(dependsOn: number[], closedIssues: ReadonlySet<number>): boolean

/** Cycles among active runs' issues (a dep on an issue with no active run is a leaf, not a cycle). */
detectCycles(runs: Array<{ runId: number; issueNumber: number; dependsOn: number[] }>): number[][]

/** The README §3.3 total order: priority desc, order_key asc, issue number asc. */
compareRuns(a: SchedulingKey, b: SchedulingKey): number
```

- `detectCycles` returns each cycle as the list of member run ids (issue numbers are mapped to runs
  by the caller; only issues with an active — non-terminal, non-archived — run participate). A dep on
  an *open issue with no run* is not a cycle: the run simply stays blocked until a human closes the
  issue or starts (and lands) a run for it — the intended behavior.
- **Both `isSatisfied`'s closed-set and `detectCycles`'s run set are per-repo** — dependencies are
  bare issue numbers, which collide across repos, so the caller (the poller) partitions active runs
  by `repoRef` and evaluates each repo's graph independently. Never feed two repos' runs into one
  `detectCycles` call.
- `compareRuns` is the **single source of truth for ordering**; the claim's `ORDER BY` (§3.3) mirrors
  it, and a cross-check test (§6) keeps the two from drifting.

### 3.3 Store — cached scheduling columns + the extended claim (migration)

One additive migration, `add runs scheduling columns` (name-tracked, per the migrations doctrine):

```sql
ALTER TABLE runs ADD COLUMN depends_on        TEXT NOT NULL DEFAULT '[]'; -- canonical JSON int array
ALTER TABLE runs ADD COLUMN priority          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN order_key         TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN deps_satisfied_at TEXT;                       -- NULL until latched
```

These are **cached copies** — the issue owns them (§3.5); the runner (post-triage) and the poller
(every tick) refresh them, and on conflict the issue wins. Mirror in `schema.sql`; retrofit test on
an on-disk DB (the migration-3/4 bar). `Run` gains `dependsOn: number[]`, `priority`, `orderKey`,
`depsSatisfiedAt: string | null`; `Repository` gains `setRunScheduling(runId, decl)` (canonicalizes
`depends_on` to sorted-unique JSON so the `= '[]'` test below is reliable, and **clears
`deps_satisfied_at` whenever the canonical `depends_on` changes** — a human adding a dependency
re-blocks the run until the poller re-verifies) and `stampDepsSatisfied(runId)`.

`claimNextEvent` changes in exactly two places:

```sql
-- gate: a run with unsatisfied cached deps is not dispatchable (correctness, airtight in the claim)
AND (runs.depends_on = '[]' OR runs.deps_satisfied_at IS NOT NULL)
-- order: the Scheduler's total order, then FIFO — replaces the bare ORDER BY events.id
ORDER BY runs.priority DESC,
         runs.order_key ASC,
         CAST(substr(runs.issue_ref, instr(runs.issue_ref, '#') + 1) AS INTEGER) ASC,
         events.id ASC
```

- Issue number is **computed from `issue_ref` in SQL**, not cached — `issue_ref` is canonical
  `owner/repo#N` (normalized by `parseIssueRef` at start), and computing avoids a stale-cache bug
  when a split handoff retargets the run (`setRunIssueRef`).
- Defaults (`0`, `''`) make the new order reduce to *issue number, then event id* for existing
  single-issue flows — near-FIFO. Any test that assumed strict event-id FIFO across runs gets
  reviewed, not papered over (see §9 risks).

### 3.4 The declaration write path — triage contract + runner

- **`triage-contract.md` / envelope:** one new optional key on the triage output —
  `"scheduling": { "depends_on": [42, 57], "priority": 10, "order_key": "2026Q3-auth-03" }`, every
  field optional. `envelope.ts` validates shape (integers, string) and drops invalid fields rather
  than escalating — a declaration is advice, not control flow.
- **Prompt (`prompts/stages/triage` + contract):** the PM declares dependencies/priority only when
  the issue or backlog context makes them evident; omit when unknown; note that a human may edit the
  block in the issue later and the human's edit wins.
- **Runner (`applyTriageDecision`):** fold the marker into the one `updateIssue` it already makes —
  final body = (agent's `issueUpdate.body` or the current body) with `upsertMarker` applied when the
  agent supplied `scheduling`, and any existing block **preserved untouched** when it didn't (never
  strip a human's declaration). Then, unconditionally, `parseMarker(finalBody)` →
  `setRunScheduling(run.id, decl)` — unconditional so a *human's pre-declared* block is cached the
  moment triage commits, poller-independent. Editing an issue to the same text is harmless, so the
  path stays idempotent under replay (the existing triage idempotency note).
- **Split handoff edge:** when triage retargets the run to a child issue (`setRunIssueRef`), reset
  the cached scheduling to defaults in the same call; the child's own body (which triage may have
  written markers into via `subIssues`) is picked up on the next poller tick.

Because the runner caches at triage-commit, the gate applies from the **very next event**: `plan`
can never dispatch ahead of declared-but-unmerged dependencies, even before the poller's first tick.
The only stage that can run pre-satisfaction is `triage` itself — deliberately so: triage is the
stage that *writes* the declarations, reads code but commits nothing, and scoping the issue early is
wanted. (Its working tree is handled at wake — §3.5.)

### 3.5 The Scheduler Poller — `src/loop/scheduler-poller.ts` (new)

The impure driver, shaped exactly like the Reply Poller (`checkOnce` core + thin `poll` loop,
injected `sleep`). It shares the daemon's existing **`--poll-interval`** (the one knob already
driving the Reply and PR Feedback pollers, default 15s, disabled the same way) — no new flag. Owned
by the Orchestrator (the PR Feedback Poller pattern — it needs the resolver + the loop's control
methods); the daemon ticks it. One pass over active (non-terminal, non-archived) runs,
**partitioned by repo** and evaluated via each repo's adapter:

1. **Refresh declarations:** `readIssue(run.issueRef)` → `parseMarker` → `setRunScheduling` when
   changed (the issue wins on conflict, so a human edit takes effect within a tick).
2. **Check satisfaction** for runs with deps and no latch: `readIssue` each dependency (memoized per
   tick per repo — a diamond checks its shared dep once); all `state === 'closed'` →
   `stampDepsSatisfied` (the latch).
3. **Detect cycles** (`detectCycles` over the refreshed cache, one call per repo — §3.2) → escalate
   every member via the new loop control method (below), with a reason naming the cycle so the
   operator knows which markers to fix.
4. **Flip statuses:**
   - `running`, unsatisfied deps, **no stage in flight** (`hasProcessingEvent` false) → park
     `blocked`. The in-flight check avoids racing a mid-stage commit (which would clobber the flip
     back to `running` — the claim predicate keeps correctness either way; the next tick parks it
     visibly). Parking is status-only (like `pause`) — the pending event stays, held by the gate.
   - `blocked`, satisfied → wake: **drop the run's working tree**, then flip `running`. Only
     `blocked` is ever flipped — never `paused`/`needs_human`/`awaiting_input` (those park for
     different reasons and their owners resume them).
5. **Log, don't spam:** each park/wake/escalation writes one `recordLog` line (the Reply Poller's
   audit discipline); no transitions for status flips.

After a pass that woke anything, the caller kicks the drain pump (the established poller contract).

**Wake-time tree drop — the §3.1 base-branch discipline.** Triage already created the run's tree and
branch (prepareStage prepares for every stage), necessarily off *pre-merge* base. Dropping the tree
at wake makes the next `prepareWorkingTree` re-clone fresh base and recreate the branch off it — the
dependent run demonstrably builds *on* its merged dependencies. This is the same "lost tree is
re-cloned on resume" path the M3 crash-recovery test already proves, so it needs no new git
machinery — just an adapter method (§3.6). Safe in general because anything durable is already on
the remote (commits are pushed by `commitAndPush`; a blocked run holds no executor, so no un-pushed
mid-stage edits exist) — verified against `GitHubCli.prepareWorkingTree`: a fresh clone restores a
*pushed* branch from `origin/<branch>` (never resets it — README §2 idempotency) and creates a
genuinely new branch off `origin/<base>` after a fetch. One honest limit: a run that already pushed
commits *before* its dependencies were declared (a human editing the marker mid-run) keeps its
branch as-is on wake — restored, not rebased. Base-freshness is guaranteed for the normal flow,
where deps are declared at triage before anything is pushed.

**New EventLoop control methods** (loop-owned, engine-bypassing — the `reopenForPrFeedback`
precedent; zero `src/fsm/` change):

- `parkBlocked(runId)` / `wakeBlocked(runId)` — status-only flips with the legality checks
  (`running → blocked`, `blocked → running`) living in one place, like `pauseRun`/`resumePausedRun`.
- `escalateDependencyCycle(runId, reason)` — a transaction: `discardPendingEvents` (so a later
  `resume` is driven by exactly one fresh advance event — the `revertRun` discipline), then
  `commitTransition` to the escalation state (`trigger: 'dependency_cycle'`, `eventId: null`,
  `status: 'needs_human'`), then emit. `resumeRun` already works with it unchanged (the escalation's
  `fromState` is the run's current state, so resume returns there); if the markers are still cyclic,
  the next tick re-escalates — operator fixes the issue blocks first.

### 3.6 Adapter additions (both `GitHubCli` and `FakeGitHub`, contract-tested)

- **`Issue.state: 'open' | 'closed'`** — the satisfaction signal. Real: add `state` to the
  `gh issue view --json` field list. Fake: seeded issues default `'open'`; the fake gains a
  test-side `closeIssue(number)` mutator (test infrastructure, not on the `GitHub` interface — the
  orchestrator never closes issues).
- **`dropWorkingTree(runId): Promise<void>`** — real: remove `<workingRoot>/run-<id>`; fake: forget
  the tree. Used only by the wake path.
- **`setPrLabels(prNumber, labels: string[]): Promise<void>`** *(slice S5)* — replace the PR's
  `af:*`-prefixed labels with the given set (leaving human labels alone). Real: `gh` label ensure +
  edit; fake: a map. Used only by the best-effort mirror (§3.7).

### 3.7 API, daemon wiring, and the PR mirror

- **Orchestrator:** owns the `SchedulerPoller` (constructed beside the PR Feedback Poller);
  `checkDependencies()` → `poller.checkOnce()` for the on-demand path; kicks the pump after wakes.
- **`start` hardening:** refuse a second run for an issue that already has an active (non-terminal,
  non-archived) run → 409, backed by a small `Repository.findActiveRunByIssue(issueRef)` lookup
  (none exists today — verified). Single-issue flows never hit this; multi-issue mode makes the
  collision real (two runs racing one issue would fight over the branch and the marker block).
- **Server:** `POST /scheduler/check` — the on-demand "Check now" pattern, fleet-wide rather than
  per-run (unlike `POST /runs/:id/check-pr-feedback`) because cycles and the closed-issue set span
  runs; one pass is one `checkOnce`. Run serialization gains `dependsOn` / `priority` / `orderKey` /
  `depsSatisfiedAt` (read-only — declarations are edited on the issue, per the ownership rule).
- **`serve.ts`:** run the Scheduler Poller loop alongside the Reply Poller on the shared
  `--poll-interval` (no new flag — §3.5).
- **State-label mirror (S5, best-effort):** an `onTransition` subscriber composed in the daemon
  wiring (beside the SSE broadcaster) — when the run has a PR, `setPrLabels(pr, ['af:<toState>'])`.
  Fire-and-forget with a logged failure: it is a **derived view** (§3.5), never load-bearing, and
  must never wedge the loop (the `emit` contract already isolates subscriber errors). The §3.5 PR
  *linkage* needs no work — verified: `prBody` (runner) already writes both `Closes #N` and the run
  id.

### 3.8 Dashboard (thin, read-only)

The M6/M7 discipline — logic in pure `render.ts` view-models, `.svelte` stays a renderer:

- Run card: a `blocked` badge with the wait reason — "waiting on #42, #57" — from the serialized
  `dependsOn`; a small priority badge when non-zero.
- RunDetail: a scheduling line (deps + satisfied-or-not, priority, order key) and the
  `dependency_cycle` escalation reason rendered legibly in the existing needs-human inspector.
- No editing UI: declarations are owned by the issue; the dashboard links to it. (YAGNI until a
  real need shows up.)

## 4. Workflow consequences — flagged, accepted

- **Dependent runs wait for a human merge.** `done` = merge-ready; nothing auto-merges. A dependency
  chain advances one human merge at a time — the point of the no-stacked-PRs rule, not a bug.
- **Triage runs before dependencies clear.** Deliberate (§3.4): the PM pass is what declares the
  deps. Its tree is created off pre-merge base and discarded at wake (§3.5).
- **A parked run's visible status can lag the poller interval** (e.g. deps declared mid-stage). The
  claim predicate gates correctly from the moment the cache is written; only the `blocked` label
  waits for the next tick.
- **An open dependency with no run blocks forever until a human acts** (closes it or runs it to a
  merged PR). Correct by design; the dashboard's "waiting on #N" line tells the operator what to do.
- **Priority ordering is claim-time, not preemptive:** a higher-priority run arriving later never
  interrupts an in-flight stage; it wins the *next* claim. (Same shape as pause: nothing interrupts
  the agent mid-stage.)

## 5. Deferred (YAGNI) — designed-for, not built

- **Cross-repo dependencies** (markers would need `owner/repo#N` refs; the codec and Scheduler
  signatures don't preclude it).
- **Webhook-driven dependency clearing** (the poller's `checkOnce` is the seam a webhook handler
  would call; polling matches the MVP's other GitHub signals).
- **PR-merged fallback for non-default base branches** (§2 caveat — additive if the doc'd caveat
  bites).
- **Editable scheduling in the dashboard** (the issue is the editor today).
- **Priority/aging fairness** (starvation of priority-0 runs under a saturated pool — not a
  single-operator problem yet).

## 6. Tests (README-mandated set + the drift guards)

- **Scheduler (table-driven, the milestone's centerpiece):** linear chains, diamonds, independent
  sets, self-dependency, two-node and longer cycles, cycles with satisfied members, ordering
  determinism (same inputs ⇒ same order; priority beats order_key beats issue number), and
  property-style shuffles (comparator total + antisymmetric over permuted inputs).
- **Marker codec:** parse/upsert round-trip byte-stability, absent block, absent fields, malformed
  fields degrade field-by-field, human prose around the block preserved, idempotent double-upsert.
- **Claim gate + order:** a run with unsatisfied cached deps is never claimed (status `running` or
  not); latch stamped ⇒ claimed; **SQL-vs-comparator cross-check** — generate run sets, assert the
  claim's pick order equals `compareRuns` sort (the drift guard for the two order encodings).
- **Store:** migration retrofit on an on-disk DB (columns added, `'[]'` canonicalization, no data
  loss); `setRunScheduling`/`stampDepsSatisfied`, including the latch-clear — changing `depends_on`
  on a latched run nulls `deps_satisfied_at` (and an unchanged re-write doesn't); split-retarget
  resets scheduling; `findActiveRunByIssue`.
- **Runner (triage):** envelope `scheduling` → marker spliced + cached in one commit; no
  `scheduling` ⇒ existing human block preserved and still cached; invalid fields dropped.
- **Poller:** parks an unsatisfied `running` run (and *not* one with a stage in flight); wakes a
  `blocked` run when the dep issue closes — tree dropped, pump kicked, latch stamped exactly once;
  never touches `paused`/`awaiting_input`/`needs_human`; cycle ⇒ every member escalated with the
  cycle in the reason; human marker edit on the issue wins over the cache within a tick (adding a
  dep to a latched run re-parks it); **per-repo isolation** — two repos with colliding issue
  numbers never cross-satisfy or form a false cycle.
- **The README gate test, end-to-end:** two runs, B depends on A — B parks `blocked` after triage,
  A drives to `done`, B stays parked (done ≠ merged), the fake closes A's issue (the merge signal),
  B wakes off fresh base and drives to `done`.
- **Concurrency regression:** extend `concurrent-recovery.test.ts` with a dependent pair in the
  drained set — the Phase B contention + crash-recovery properties hold with the new claim predicate
  and ORDER BY in place (no duplicate/lost events, blocked runs claim nothing under the pool).
- **Render:** blocked badge / waiting-on view-model; priority badge; cycle reason rendering.
- Suite bar unchanged: `npm run typecheck`, `npm run lint`, `npm test`, `npm run check:dashboard`.

## 7. File-change checklist

```
src/integration/issue-markers.ts        NEW: §3.5 marker codec (parse/upsert), pure
src/integration/issue-markers.test.ts   NEW
src/loop/scheduler.ts                   NEW: pure Scheduler (isSatisfied, detectCycles, compareRuns)
src/loop/scheduler.test.ts              NEW: the table-driven centerpiece
src/loop/scheduler-poller.ts            NEW: impure driver (refresh, latch, cycles, park/wake)
src/loop/scheduler-poller.test.ts       NEW
src/store/migrations.ts                 + 'add runs scheduling columns'
src/store/schema.sql                    + the four columns
src/store/repository.ts                 Run fields; setRunScheduling (clears the latch on change) /
                                        stampDepsSatisfied; findActiveRunByIssue (the 409 lookup);
                                        claim: deps predicate + Scheduler ORDER BY;
                                        setRunIssueRef resets scheduling
src/store/repository.test.ts            + gate/order/migration/canonicalization tests
src/loop/event-loop.ts                  + parkBlocked/wakeBlocked/escalateDependencyCycle (control
                                        methods only; applyEvent untouched)
src/agent/envelope.ts                   + optional triage `scheduling` (validated, droppable)
src/agent/prompts/triage-contract.md    + `scheduling` key + guidance
src/agent/runner.ts                     triage: upsertMarker into updateIssue body; unconditional
                                        parse→cache (PR-body linkage verified — untouched)
src/integration/github.ts               Issue.state; dropWorkingTree; setPrLabels (S5)
src/integration/github-cli.ts           implement the three
src/integration/github-fake.ts          implement + closeIssue test mutator
src/api/orchestrator.ts                 own the poller; checkDependencies(); duplicate-issue 409
src/api/server.ts                       POST /scheduler/check; scheduling fields on run JSON
src/serve.ts                            poller loop (shared --poll-interval; no new flag)
dashboard/src/lib/render.ts             blocked/priority view-models
dashboard/src/lib/*.svelte              badges + RunDetail scheduling line (thin)
README.md                               §9 operating guide: declaring deps, the auto-close caveat,
                                        blocked/wake semantics; M9 status entry
src/fsm/**                              UNTOUCHED (frozen)
```

## 8. Definition of done

- Two dependent issues driven concurrently behave per the invariant: the dependent run parks
  `blocked` after triage, wakes **only** when the dependency's PR merges / issue closes (not at
  `done`), re-clones off up-to-date base, and lands its own PR — no stacked PRs.
- Among dispatchable runs, pickup follows `priority` desc → `order_key` asc → issue number asc,
  deterministically (cross-check test green).
- A dependency cycle escalates every member to `needs_human` with an actionable reason; `resume`
  works after the operator fixes the markers.
- Declarations live in the issue and a human edit wins within a poller tick; triage's declarations
  take effect at its own commit (no poller race for the next stage).
- All M8 Phase B properties still hold with the extended claim (contention + concurrent recovery
  green, including a dependent pair).
- `npm run typecheck` / `lint` / `test` / `check:dashboard` all green; **`src/fsm/` diff is empty.**

## 9. Sequencing (each step ships green)

1. **S1 — pure core:** `issue-markers.ts` + `scheduler.ts` + their table-driven suites. No wiring,
   zero behavior change.
2. **S2 — store + gate:** migration, `Run` fields, store methods, claim predicate + ORDER BY, the
   SQL-vs-comparator cross-check, migration retrofit test. Behavior-preserving for runs without
   declarations (defaults gate nothing) — *except* the claim order refinement; audit any test that
   assumed cross-run event-id FIFO here, deliberately.
3. **S3 — declaration write path:** triage contract + envelope + prompt, runner splice + cache,
   split-retarget reset. Declarations now persist end-to-end but nothing parks yet (no poller) —
   still shippable, since the claim already gates on the cache written here.
4. **S4 — the poller (the crux):** `Issue.state` + `dropWorkingTree` adapter work, loop control
   methods, `scheduler-poller.ts`, orchestrator/server/daemon wiring, duplicate-issue 409, the
   end-to-end gate test + concurrency regression. **M9's behavior is complete here.**
5. **S5 — mirror + surfaces:** `setPrLabels` + the best-effort `af:<state>` mirror, dashboard
   badges/detail, README §9 guide.

## 10. Risks & decisions to confirm before coding

- **Issue-closed as the satisfaction signal** (§2). Simplest hard signal; rides GitHub auto-close
  for the merged-PR case; documented caveat for non-default base branches. Confirm vs. the
  PR-merged-lookup superset (additive later either way).
- **Claim ORDER BY changes the default pick order** (near-FIFO → issue-number-major for undeclared
  runs). Deterministic both before and after, but any test or operator expectation built on strict
  event FIFO across runs surfaces in S2 — review those diffs consciously rather than encoding the
  old order as a priority hack.
- **Two encodings of one order** (SQL vs `compareRuns`). Held together by the cross-check test; any
  future ordering change must touch both or the test fails — that is the point.
- **Poller races a mid-stage status commit.** Sidestepped by design: the poller never parks a run
  with a stage in flight, and the claim predicate — not the status — is the correctness gate (§3.5).
- **Marker parsing of human-edited text.** Degrade field-by-field to defaults, never escalate on
  prose; the codec suite carries the ugly-input table.
- **GitHub read volume** (R runs + D deps per tick, on the shared `--poll-interval`). Memoized per
  tick, and the latch stops dependency reads once satisfied (until the declaration changes) — the
  same order of chattiness as the Reply Poller's per-parked-run cadence, and quiet once latched.
