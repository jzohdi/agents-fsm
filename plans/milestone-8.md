# Milestone 8 — Multi-repo support (design + plan)

> Progress: **Phase A done; Phase B — B1 + B2 done**, suite green at **419 passing / 1 skipped**.
> - **B1 — worker pool + within-run serialization:** `claimNextEvent` gained a `NOT EXISTS … status =
>   'processing'` guard, so the pool is **parallel across runs, serial within a run** (a run with a stage
>   in flight is skipped until it finalizes; the follow-up event is enqueued inside the commit txn, so
>   the guard holds it back). `EventLoop.drain(concurrency)` is the bounded pump — up to N overlapping
>   `runStage` calls, resolves when idle + all workers settle, a `FatalExecutorError` rejects it after
>   in-flight stages finish (serial `runUntilIdle` kept for the one-shot CLI + Reply Poller). Orchestrator
>   gained a `concurrency` option (default **1** → existing tests stay serial); the daemon resolves the
>   global cap from `--concurrency` → `FLEET_CONCURRENCY` → **4** (`build-runner.resolveConcurrency`).
>   Tests: claim within-run/cross-run serialization, pool parallelism + cap + per-run-serial witness +
>   fatal-rejects (loop), two-repo concurrent drain (orchestrator), `--concurrency` parsing.
> - **B2 — per-run worktrees / per-repo roots + concurrent crash recovery:** **no production code** — the
>   per-repo working roots (each repo's adapter is built from its `repos` row's `workingRoot`) and per-run
>   trees (`prepareWorkingTree` keys `<workingRoot>/run-<id>` on the *global* run id) already existed from
>   Phase A + M3, and idempotency is run-scoped (event-keyed transitions; the outbox ledger is keyed
>   `(run_id, key)` UNIQUE). B2 **proves** it holds under the pool: `src/integration/concurrent-recovery.test.ts`
>   extends the M2 post-commit and M7 outbox crash-recovery tests to several runs across two repos
>   recovered + drained concurrently — no duplicate/lost events, no duplicate transitions (golden path
>   each), one PR per run on its own adapter with distinct per-run branches, and split sub-issues/comments
>   created exactly once per run. Both passed first try, confirming the design was concurrency-safe by
>   construction.
> - **B1 audit hardening** (found during the B2 code audit, in the committed `drain`): (1) a synchronous
>   `claimNextEvent` throw fired from a worker-completion `pump()` used to escape into the voided worker
>   promise and **hang the drain forever** — now caught and treated like a worker failure (abort + reject,
>   matching serial `runUntilIdle`); (2) the concurrency clamp `Math.max(1, Math.floor(x))` was not
>   NaN-safe (`Math.max(1, NaN) === NaN` → dispatch nothing; `Infinity` bypassed the cap) — `drain` is now
>   the single authoritative clamp (non-finite / < 1 → serial 1), and the Orchestrator no longer
>   double-clamps. Both covered by new loop tests.
>
> **Next: B3** (rate-limit-aware executor retry + optional global cost ceiling).
>
> _Earlier:_ **A1 + A2 + A3-backend done** at 403 passing / 1 skipped.
> - **A1 — store:** `repos` registry table + migration 3 (`LATEST_VERSION → 3`, `repo_ref COLLATE NOCASE`,
>   on-disk retrofit verified), `upsertRepo`/`getRepo`/`listRepos`, and `listRuns({ status?, repo? })`.
> - **A2 — resolver crux:** `src/integration/github-resolver.ts` (`RepoResolver`, `singleRepoResolver`,
>   `EnrolledRepoResolver` — memoized, with `invalidate`). The Agent Runner and Reply Poller resolve the
>   adapter + base branch per `run.repoRef` (accept `GitHub | RepoResolver`, so single-repo callers/tests
>   are unchanged). `build-runner` enrolls the bound `--repo` at boot and builds a registry-backed
>   resolver, threaded to the runner and poller. **The single-adapter binding is gone.**
> - **A3-backend:** Orchestrator single-repo start guard → **resolver-based enrollment check**;
>   `GET/POST /repos` (enroll defaults working root to `--work`, re-enroll invalidates the resolver cache);
>   repo-filtered `GET /runs?repo=` and `GET /stream?repo=` (case-insensitive). End-to-end multi-repo
>   proven (`src/integration/multi-repo.test.ts`).
> - **A3-dashboard:** repo tabs strip (`RepoTabs.svelte`) — selector + overview in one, counts from a pure
>   `repoOverviewModel(runs)`; active tab filters the board **client-side** (SSE stays global); trailing
>   **+** enrolls a repo (`POST /repos`). Verified live in the browser (multi-repo seed).
>
> **✅ Phase A is complete and shippable** at **405 passing / 1 skipped**. Phase B (parallel execution)
> is the next milestone chunk. Deliberately not done: an enrolled-but-no-runs repo shows no tab (tabs
> derive from runs; the enroll banner confirms it, and filing a run makes the tab appear) — a KISS
> tradeoff that also sidesteps enrolled-vs-run casing reconciliation.

> Scope: builds on M0–M7. M8 is the first post-MVP
> milestone. It splits into two independent phases — **Phase A** (repo as a first-class dimension,
> serial, low risk) is shippable on its own; **Phase B** (parallel execution) is the real work.
> The MVP foundation was kept multi-repo-ready on purpose (README §1, §3.3): runs already carry a
> per-run `repo_ref`, the state model is run-scoped, the FSM is pure, and `events` already support an
> atomic status-gated claim. So M8 is *additive plumbing*, not a retrofit of the engine.

## 1. Goal and scope (README §5 Milestone 8)

Run more than one repository through the same fleet. The README's framing is the design's spine:
**the hard part is concurrency, not the repo count.** Two phases, deliberately decoupled so Phase A
delivers multi-repo with *zero* new concurrency risk and Phase B can land later:

- **Phase A — repo as a first-class dimension** (small, additive, low risk). A `repos` table, a FK
  from the `runs.repo_ref` that already exists, a `repo` argument on `start`, repo-scoped filtering
  of runs/telemetry/stream, and a repo selector in the dashboard. **Execution stays serial** — the
  loop simply pulls events from runs in *any* repo. A clean first stopping point.
- **Phase B — parallel execution** (moderate). Replace the serial drain with a bounded worker pool,
  per-run git worktrees, a global concurrency cap, rate-limit handling, and an optional global cost
  ceiling. The at-least-once + idempotent-handler design (Layer 3) and the M7 outbox already hold
  under concurrency — that is the usually-hard part, mostly pre-solved.

**The one non-obvious truth this plan is built around:** today the whole daemon is bound to a
*single* repo not in the data model but in the **wiring** — `build-runner.ts` constructs **one**
`GitHub` adapter (real `GitHubCli` or `FakeGitHub`) for one `repo` + `workingRoot`, and the
`AgentRunner` holds it as `private readonly github`. The `runs.repo_ref` column is already per-run,
but every run is serviced by that one adapter, and the `Orchestrator.start` `configuredRepo` guard
*enforces* the single repo. **Phase A's real work is making the adapter (and working root) resolve
per `run.repoRef`** — the schema, the FK, and the filtering are the easy 40%.

**Out of scope** (unchanged): multi-issue dependency ordering (M9 — the Scheduler), the Agent SDK
executor (M10), continuous repo auto-pickup (M11), exactly-once delivery (we keep at-least-once).
Per-repo FSM config / per-repo secrets are *optional* within Phase B, not required to ship it.

**Neither phase touches the pure FSM engine or its test suite** — a stated M8 invariant. The engine
sees `(config, state, result, counters)`; repos and workers are below it.

---

## 2. Phase A — repo as a first-class dimension

### 2.1 What is actually single-repo today (the constraint to lift)

| Surface | Today | Phase A |
|---|---|---|
| `runs.repo_ref` | already per-run (`owner/repo` TEXT) | unchanged value; gains a FK to `repos` |
| GitHub adapter | **one** per daemon, bound to one repo+`workingRoot` (`build-runner.ts`) | **resolved per `run.repoRef`** |
| `AgentRunner.github` | a single injected `GitHub` | a resolver the runner consults per run |
| `Orchestrator.start` | `configuredRepo` guard refuses other repos | accepts any *enrolled* repo |
| `listRuns(status?)` | filter by status only | + optional `repo` filter |
| SSE stream | `?runId=` filter | + `?repo=` filter |
| Dashboard | one repo, implicit | repo selector / multi-repo overview |

The working-tree lifecycle is *already* run-scoped: `GitHubCli.prepareWorkingTree({ runId, branch,
base })` clones `<workingRoot>/run-<id>`. What is repo-scoped (and currently global) is `workingRoot`
itself, the `repo`/`cloneUrl`, and the token — exactly the columns the `repos` table will own.

### 2.2 The `repos` table + FK (migration 3)

A row per enrolled repository. Secrets stay **env-only, never in SQLite** (the M7 §9 rule) — the
table stores a *token reference* (an env var name), not the token.

```sql
CREATE TABLE IF NOT EXISTS repos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_ref    TEXT    NOT NULL UNIQUE,            -- canonical `owner/name` (parseRepoRef)
  clone_url   TEXT,                               -- defaults to https://github.com/<repo_ref>.git
  local_repo  TEXT,                               -- optional fast local clone source (GitHubCli.localRepo)
  working_root TEXT   NOT NULL,                   -- where this repo's per-run trees are cloned
  base_branch TEXT    NOT NULL DEFAULT 'main',
  token_ref   TEXT,                               -- env var NAME holding the token (e.g. GITHUB_TOKEN); never the secret
  archived_at TEXT,                               -- enrolled repos can be retired without deleting history
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_ref ON repos(repo_ref);
```

- **FK from `runs`.** SQLite cannot add a FK to an existing table in place, and `runs.repo_ref` is a
  *string*, not `repos.id`. Keep `runs.repo_ref` as the string key (no destructive table rebuild) and
  make the relationship `runs.repo_ref → repos.repo_ref`. Enforce it at the **application layer**
  (`startRun` requires the repo be enrolled) rather than a hard SQL FK, since a hard FK would force the
  12-step table rebuild for zero added safety. This matches the migration doctrine in
  `migrations.ts` ("keep migrations additive… cannot change a CHECK in place").
- **Migration 3** (`create repos`): `CREATE TABLE/INDEX IF NOT EXISTS`, idempotent, bumps
  `LATEST_VERSION → 3`. Mirror it in `schema.sql`. Verify on a real on-disk DB (`user_version → 3`,
  table added, existing runs preserved) — the same bar migrations 1 & 2 met.
- **Backfill:** on a single-repo DB upgrading to M8, enroll the daemon's `--repo` as the first row so
  existing runs resolve. A one-time `INSERT OR IGNORE` from `args.repo` at daemon boot (not in the
  migration — the migration has no access to CLI args).

### 2.3 The crux: per-repo adapter resolution

Introduce a **`GitHubResolver`** (working name) — a small factory that returns the right `GitHub`
adapter for a `repoRef`, caching one instance per repo:

```ts
// src/integration/github-resolver.ts (new)
export interface GitHubResolver {
  for(repoRef: string): GitHub;   // throws if the repo is not enrolled
}
```

- **Real mode:** builds a `GitHubCli({ repo, workingRoot, cloneUrl, localRepo, … })` per enrolled
  repo from its `repos` row, memoized. `buildRealGitHub` already takes exactly this config shape.
- **Mock mode:** a single shared `FakeGitHub` keyed by repo, or a per-repo fake — the fake already
  takes `repoRef`. Its in-memory seeded issues must stay shared per repo (the M3 note in
  `build-runner.ts` about sharing the one fake instance still applies, now *per repo*).

**Wiring change in `AgentRunner`:** replace the single `private readonly github: GitHub` with the
resolver; at the top of `runStage` resolve `const github = this.resolver.for(run.repoRef)` and use
that local throughout (the five side-effecting calls, `prepareWorkingTree`, `commitAndPush`,
`openPr`, etc. all already go through one `this.github` — it becomes one `github` local). This is a
**mechanical, single-seam change**: nothing above the runner learns about repos.

> **Decision to confirm before coding:** resolver-in-runner (recommended — one runner, picks the
> adapter per run) vs. runner-per-repo + a loop that dispatches to the matching runner. The resolver
> is less moving machinery and keeps the loop repo-agnostic, which is also what Phase B's worker pool
> wants (workers share one resolver). Recommending the resolver.

The **Reply Poller** (`src/loop/reply-poller.ts`) also holds the one shared `github` today; it
becomes resolver-driven too (poll each `awaiting_input` run against *its* repo's adapter).

### 2.4 Start command, filtering, stream

- **`Orchestrator.start`**: drop the hard single-repo `configuredRepo` guard; replace with an
  **enrollment check** — the issue's repo must be an enrolled `repos` row (else a 400 telling the
  operator to enroll it). `start({ issueRef, repoRef? })` already threads `repoRef`; it now validates
  against the registry instead of a single bound repo.
- **Repo enrollment surface:** a minimal `POST /repos` (enroll) + `GET /repos` (list) + archive, and
  CLI flags so the one-shot path can enroll-on-start. (The full per-repo *control* surface — pause a
  repo, backlog view — is M11; Phase A needs just enroll/list so a second repo can run.)
- **`listRuns`**: add an optional `repo` filter alongside the existing `status` filter (a `WHERE
  repo_ref = ?` clause). `GET /runs?repo=owner/name[&status=]`.
- **SSE stream**: add `?repo=` to the existing `?runId=` filter in `stream.ts` / the broadcaster, so
  a dashboard scoped to one repo only receives that repo's transitions/activity/status events. Events
  already carry the run; filtering is a predicate on `run.repoRef`.

### 2.5 Dashboard: repo selector / multi-repo overview

The render layer already surfaces `repo: r.repoRef` on every run card (`render.ts` `runCardModel`).
Phase A adds:

- A **repo selector** (all-repos / per-repo) that scopes the pipeline board and the SSE subscription.
- A **multi-repo overview**: per-repo counts (active / needs_human / resolved) — a pure view-model in
  `render.ts` (`repoOverviewModel(runs) → RepoSummary[]`), unit-tested by the root suite, rendered as
  a header strip. Keep all grouping logic pure in `render.ts`; `.svelte` stays a thin renderer (the
  M6/M7 discipline).
- The new-run box gains a repo picker (from `GET /repos`); the existing issue autocomplete
  (`GET /suggestions`) becomes repo-scoped.

### 2.6 Phase A tests

- **Repository**: `createRepo` / `getRepo` / `listRepos`; `listRuns({ repo })` filters correctly;
  migration-3 retrofit on an on-disk DB (no data loss, `user_version → 3`).
- **Resolver**: returns a distinct adapter per repo, memoizes, throws on an unenrolled repo.
- **Runner**: a run on repo A and a run on repo B each hit *their own* adapter (assert via two fakes /
  a spy resolver) — the regression test that the single-adapter binding is gone.
- **Orchestrator**: `start` for an enrolled repo succeeds; for an unenrolled repo → 400; `listRuns`
  and the stream filter by repo.
- **Loop (serial, multi-repo)**: two runs in different repos both drive to `done` on one serial loop,
  interleaved, with the correct per-repo side effects — proving "the loop simply pulls events from
  runs in any repo" with zero concurrency.
- **Render**: `repoOverviewModel` (counts per repo, empty, single repo).

---

## 3. Phase B — parallel execution

The real work. **The FSM engine and its tests are untouched.** Everything here is in the loop, the
store claim, the worktree machinery, and the caps.

### 3.1 Bounded worker pool (replace the serial drain)

Today `EventLoop` drains one event at a time (`claimNextEvent` → `applyEvent` → repeat). Phase B runs
a pool of N workers, each looping `claim → apply`. The key safety properties already exist or are
small additions:

- **Atomic claim is already done.** `claimNextEvent` is a single `UPDATE … WHERE status='pending' …
  RETURNING` joined to `runs.status='running'` — two workers calling it concurrently can never get the
  same row (SQLite serializes the writes). The README's "claim events atomically" requirement is
  *already satisfied by the M0 SQL*; Phase B just calls it from N workers.
- **Within-run serialization (new).** Stages of the *same* run must stay serial even when the pool is
  parallel across runs (they share a working tree and a state cursor). Add a `WHERE NOT EXISTS (SELECT
  1 FROM events e2 WHERE e2.run_id = events.run_id AND e2.status='processing')` clause to the claim, so
  a run with an in-flight stage is skipped until it finishes. This makes the pool **parallel across
  runs, serial within a run** — the exact concurrency model the README wants. `hasProcessingEvent`
  already encodes this predicate for the operator-command path; the claim gains the same guard.
- **Recovery is unchanged in spirit.** `recoverProcessingEvents` resets *all* `processing` → `pending`
  on a clean startup. Under a pool this must run only at boot (no live worker holds a `processing`
  row), which is already how it is called (once, in `recover()`).

### 3.2 Per-run git worktrees

`prepareWorkingTree` already isolates per run (`<workingRoot>/run-<id>`), so two runs **never share a
tree** — the hard same-repo-parallelism requirement is largely met by existing M3/M4 machinery. Phase
B's additions:

- Per-repo `working_root` (from the `repos` row, §2.2) so repo A and repo B clone into separate roots.
- Confirm cleanup/reuse semantics under parallelism (a crashed run's tree is re-cloned on resume — the
  M3 crash-recovery test already covers a lost working tree being re-cloned).
- Cross-repo parallelism is *free* once same-repo works (different repos are already isolated) — build
  the worktree machinery once, get both, exactly as the README notes.

### 3.3 Global caps, rate limits, cost ceiling

- **Global concurrency cap**: the pool size N (config/flag). Independent of per-run serialization.
- **Rate-limit handling in the Stage Executor / harness**: N parallel agents mean N× rate pressure.
  Backoff/retry already lives *inside* the executor seam (Layer 5) — extend it to honor GitHub/Anthropic
  rate-limit signals rather than bubbling them as `executor_error`.
- **Optional global cost ceiling** on top of the per-run budget guard: N parallel agents mean N× spend.
  A pre-dispatch check in the loop (sum of `cost_used` across active runs vs. a ceiling) that parks new
  dispatch — reusing the existing budget-guard plumbing, just aggregated.

### 3.4 Optional (Phase B tail): per-repo FSM config / secrets

If repos span different orgs: a per-repo `fsm_config_version` / config path and per-repo `token_ref`
(already a column). Not required to ship Phase B; called out so the schema doesn't need a later change.

### 3.5 Phase B tests (README-mandated)

- **Contention**: two workers never process the same event (hammer `claimNextEvent` from concurrent
  workers; assert each event applied exactly once) — and never two events of the same run at once.
- **Concurrent crash recovery**: extend the M2/M7 crash-recovery test to the pool — kill mid-flight
  with several runs in progress across repos; on restart assert **no duplicate or lost events**, no
  duplicate transitions (event-keyed), no duplicate comments/sub-issues (the M7 outbox holds under
  concurrency).
- **Global cap**: never more than N stages execute concurrently.
- **Cost ceiling**: dispatch parks when the aggregate ceiling is hit, resumes when it clears.

---

## 4. File layout (new / touched)

```
# Phase A
src/store/schema.sql                + repos table & index
src/store/migrations.ts             + migration 3 (create repos), LATEST_VERSION → 3
src/store/repository.ts             + createRepo/getRepo/listRepos; listRuns repo filter
src/store/repository.test.ts        + repos CRUD, run repo-filter, migration-3 retrofit
src/integration/github-resolver.ts  NEW: GitHubResolver (per-repo adapter factory, memoized)
src/integration/github-resolver.test.ts NEW
src/agent/runner.ts                 resolve github per run.repoRef (single-seam change)
src/loop/reply-poller.ts            resolver-driven polling per run's repo
src/build-runner.ts                 build a resolver instead of one adapter; boot-time enroll of --repo
src/api/orchestrator.ts             start: enrollment check (drop single-repo guard); listRuns repo arg
src/api/server.ts                   GET/POST /repos; /runs?repo=; /stream?repo=
src/api/stream.ts                   repo predicate on the broadcaster
dashboard/src/lib/render.ts         + repoOverviewModel(); repo on run cards (already present)
dashboard/src/lib/render.test.ts    + repoOverviewModel tests
dashboard/src/lib/*.svelte          repo selector + multi-repo overview strip (thin renderers)
README.md                           §9 operating guide: enroll repos; status/M8 entry

# Phase B
src/loop/event-loop.ts              worker pool; per-run serialization; global cap; cost ceiling
src/store/repository.ts             claim: skip runs with an in-flight event (within-run serial)
src/agent/executor.ts / subprocess-executor.ts  rate-limit-aware retry/backoff
src/integration/*recovery*          concurrent crash-recovery + contention tests
```

## 5. Definition of done

**Phase A:**
- A second repo can be enrolled and a run started against it; runs on different repos are serviced by
  the correct per-repo adapter (no single-adapter binding remains).
- Runs / telemetry / SSE stream filter by repo; the dashboard scopes to a selected repo and shows a
  multi-repo overview.
- Execution stays serial — no new concurrency machinery. Two interleaved cross-repo runs both reach
  `done`.
- Migration 3 upgrades an on-disk DB without data loss; the bundled `--repo` is auto-enrolled.

**Phase B:**
- A bounded worker pool runs agents in parallel across runs/repos, serial within a run, never
  exceeding the global cap.
- Contention and concurrent crash-recovery tests pass: no event processed twice, none lost, no
  duplicate transition / comment / sub-issue / PR.
- Optional global cost ceiling parks dispatch when exceeded.

**Both:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run check:dashboard` all green; the
dashboard builds; the pure FSM engine and its test suite are unchanged.

## 6. Sequencing

Phase A is shippable before Phase B starts; within each, the store comes first so the suite stays
green at every checkpoint.

1. **A1 — store**: `repos` table + migration 3 + repo CRUD + `listRuns` repo filter (+ tests).
2. **A2 — resolver + runner**: `GitHubResolver`, resolver-driven `AgentRunner` + Reply Poller, the
   `build-runner.ts` rewire (+ resolver/runner tests). *This is the crux — the single-adapter binding
   is gone after A2.*
3. **A3 — API + dashboard**: enrollment check, `/repos`, repo-filtered `/runs` and `/stream`, repo
   selector + overview, README §9 enroll guide. **Ship Phase A.**
4. **B1 — within-run-serial claim + worker pool**: the parallel loop, global cap (+ contention test).
5. **B2 — worktree/repo roots + concurrent crash recovery** (+ the extended recovery test).
6. **B3 — rate-limit handling + optional global cost ceiling** (+ caps tests).

Each step keeps `npm test` green, so the milestone is shippable at A3 and again at B3.
