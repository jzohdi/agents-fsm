# Plan — Continuous mode: label/milestone filter to scope the watched backlog (jzohdi/agents-fsm#11)

## Goal (restated)

Continuous mode (Milestone 11) currently scans **all** open issues in a watched repo, subject only to
the safety guards (owner-filed, unassigned, not `[WIP]`). Add an **optional per-repo scoping filter** —
a label and/or a milestone — that narrows *which issues are considered candidates at all*, before the
guards run. With no filter set, behaviour is unchanged. This is distinct from the existing
`watch_label` **override**, which *bypasses* the guards for a single issue; the new filter *scopes* the
backlog and does not bypass anything.

Composition rules (from the acceptance criteria):
- A repo can be watched with an optional label filter, an optional milestone filter, or both.
- When a filter is set, only issues matching **all** set filter fields are candidates; non-matching
  open issues are never admitted (even if they would otherwise clear the guards / carry the override).
- The scoping filter and the safety guards compose: a filtered-in issue must still clear the guards
  (or carry the override label) to be picked up.
- The filter round-trips `POST /repos/watch` → `repos` row → poller, and is visible/editable on the
  dashboard watch control.

## Approach & architecture

Follow the design the issue prescribes: **apply the filter at fetch time** (the GitHub adapter's
`listOpenIssues`), so the pure `decideIntake` core keeps receiving an already-scoped candidate set and
stays **completely unchanged**. The existing guards (`ineligibleReason`) then apply on top of the
scoped set exactly as today.

Concretely: the scope filter is fetched with `gh issue list --label <L> --milestone <M>` (both flags
are AND-combined by `gh`, giving the "match all set fields" semantics for free). The fake adapter
mirrors this by filtering its in-memory issues. Milestone therefore never needs to appear on the
`RepoIssue`/core types — the adapter resolves it internally. This keeps the change additive and the
pure decision core untouched (lowest-risk).

New nullable per-repo config: `watch_filter_label` and `watch_filter_milestone`, stored alongside
`watch`/`watch_label` but semantically separate. Empty/whitespace values normalize to `null` (= not
set) at the orchestrator boundary, so clearing an input clears the filter.

### Data flow

```
POST /repos/watch {repoRef, watch, label?, filterLabel?, filterMilestone?}
  → Orchestrator.setRepoWatch  (parse ref, normalize empty→null)
  → Repository.setRepoWatch     (persist watch + optional label + optional filter cols)
  → repos row (watch_filter_label / watch_filter_milestone)
  → IssueIntakePoller.checkRepo reads repo.watchFilterLabel / .watchFilterMilestone
  → github.listOpenIssues({ label, milestone })   ← filter applied HERE (fetch time)
  → decideIntake(scopedIssues, …)                 ← UNCHANGED; guards run on the scoped set
```

## Files / areas to change

### Layer 1 — storage
- **`src/store/schema.sql`** — append two nullable columns to `repos` (after `conflict_policy`, so a
  fresh schema matches a DB retrofitted by the additive migration — the established db-drift-guard
  ordering convention in this file):
  `watch_filter_label TEXT` and `watch_filter_milestone TEXT`, with comments noting they *scope* the
  backlog (distinct from `watch_label`, the guard-bypass override).
- **`src/store/migrations.ts`** — add **migration version 15**, name `add repos watch filter columns`,
  applying `addColumnIfMissing(db, 'repos', 'watch_filter_label', 'TEXT')` and the milestone column.
  Additive nullable columns → pre-existing DBs backfill to `NULL` (no filter → unchanged behaviour);
  a fresh DB already has them from schema.sql. Keep the version gap-free (current max is 14).
- **`src/store/repository.ts`**:
  - `RepoRow` — add `watch_filter_label: string | null`, `watch_filter_milestone: string | null`.
  - `Repo` interface — add `watchFilterLabel: string | null`, `watchFilterMilestone: string | null`
    with doc comments (scopes the backlog; only meaningful while `watch` is on).
  - `mapRepo` — map both columns.
  - `setRepoWatch` — extend to also (optionally) write the two filter columns. Keep the existing
    "omit → leave as-is, `null` → clear, string → set" convention already used for `label`. Signature
    changes from `(repoRef, watch, label?)` to `(repoRef, watch, opts?)` **or** an added trailing
    `filter?` param — pick the minimal shape that keeps the single existing caller (orchestrator)
    readable and lets each column be independently left/cleared/set. Build the `UPDATE` column list
    dynamically from which keys are present (mirrors the current label-present branch).

### Integration — GitHub adapter
- **`src/integration/github.ts`**:
  - Add an `IssueFilter` interface: `{ label?: string | null; milestone?: string | null }`.
  - Change the `GitHub.listOpenIssues` signature to `listOpenIssues(filter?: IssueFilter)`.
    (`RepoIssue` is **not** changed — milestone is resolved inside the adapter.)
- **`src/integration/github-cli.ts`** — `listOpenIssues(filter?)` appends `--label <label>` and/or
  `--milestone <milestone>` to the `gh issue list` argv only when the corresponding field is a
  non-empty string. Keep the existing `--limit 200` paging note.
- **`src/integration/github-fake.ts`**:
  - `SeedIssue` + `StoredIssue` — add an optional `milestone?: string | null` field (default `null`)
    so tests can seed milestone membership.
  - `listOpenIssues(filter?)` — after the existing open/repo filter, additionally keep only issues
    whose labels include `filter.label` (case-insensitive membership, matching how the override label
    is matched) and whose `milestone` equals `filter.milestone` (case-insensitive). Both applied only
    when the respective field is set → **match all set fields** (AND), mirroring `gh`.

### Loop — intake
- **`src/loop/issue-intake-poller.ts`** — in `checkRepo`, build the filter from
  `repo.watchFilterLabel` / `repo.watchFilterMilestone` and pass it to `github.listOpenIssues(filter)`.
  Thread the filter (or the whole `repo`) through from `checkOnce` (which already iterates repos) into
  `checkRepo`. `decideIntake` and the guard/skip logic are untouched. (Optional, non-essential: include
  the active filter in the per-repo log line for operator visibility.)
- **`src/loop/issue-intake.ts`** — **no change** (pure core stays scoped-set-in).

### API
- **`src/api/server.ts`** — in the `POST /repos/watch` handler, additionally read `filterLabel` and
  `filterMilestone` from the body; validate each is `string | null | undefined` (same shape/validation
  as `label`); pass them to `orch.setRepoWatch`. Update the route comment.
- **`src/api/orchestrator.ts`** — `setRepoWatch` accepts `filterLabel?`/`filterMilestone?`, **normalizes**
  each (`trim()`; empty string → `null` to clear; leave `undefined` untouched), and forwards to
  `this.repo.setRepoWatch`. Update the doc comment to distinguish the scoping filter from the override
  label. No new guard needed (a filter is valid regardless of `watch`/source state; the existing
  source-configured guard on turning watch *on* is unchanged).

### Dashboard
- **`dashboard/src/lib/types.ts`** — add `watchFilterLabel: string | null` and
  `watchFilterMilestone: string | null` to `Repo`.
- **`dashboard/src/lib/render.ts`** — add the two fields to `RepoLedgerRow` (+ `blank()` defaults +
  populate from `repo` in `repoLedgerModel`).
- **`dashboard/src/lib/store.svelte.ts`** — extend the watch client. Add
  `setRepoWatchFilter(repoRef, filterLabel, filterMilestone)` that POSTs `/repos/watch` with the row's
  **current** `watch` value plus the filter fields (the endpoint requires `watch`), then `loadRepos()`.
  Keep `setRepoWatch(repoRef, watch)` for the plain toggle (it must not clobber the filter — it omits
  the filter keys, and the store treats absent keys as "leave as-is").
- **`dashboard/src/lib/Home.svelte`** — next to the existing **Watch** button, add a compact filter
  control: a small chip/summary showing the active scope (e.g. `label:bug · milestone:v2`, or "all
  issues" when unset) that expands to two inputs (label, milestone) with an apply action calling
  `setRepoWatchFilter`. Only meaningful for an enrolled+configured repo (like Watch); may be shown
  whenever watched or always-editable for enrolled repos. Keep it visually consistent with the
  existing `af-hwatch`/`af-hconflict` controls.
- **`dashboard/src/app.css`** — minimal styles for the new filter control, reusing existing tokens.

### Docs
- **`README.md`** — update §5 "Milestone 11": move the label/milestone filter from *Still open* into
  *Shipped* (leaving only the configurable cap > 1 open), and add a sentence to operating-guide §9.10
  describing the scope filter and how it differs from the override label.

## Risks & edge cases

- **Filter vs. override are orthogonal.** Scope is applied first (fetch); the override label only
  affects the guards *within* the scoped set. A non-matching issue is never admitted even if it carries
  the override label. Reflected in tests + docs to avoid operator confusion.
- **AND semantics / empty values.** Both `--label` and `--milestone` are combined by `gh` as AND; the
  fake must AND too. Empty-string filter fields must normalize to `null` (no filter) so a blank input
  doesn't degenerate into `--label ''`. Normalize once, at the orchestrator boundary.
- **Case sensitivity.** Match labels/milestone case-insensitively in the fake (consistent with the
  override-label matching). `gh` label matching is exact; document that the operator's value should
  match the GitHub label/milestone name (acceptable — same as any `gh` filter).
- **Non-existent label/milestone.** `gh issue list --label doesNotExist` returns an empty set (not an
  error) → the repo simply admits nothing that pass; the existing per-repo error isolation still covers
  a genuine adapter failure.
- **DB drift / migration ordering.** New columns appended last in schema.sql and added via an additive
  idempotent migration, matching the guarded invariants (gap-free 1..N versions, unique names) and the
  existing convention that a fresh schema equals a migrated one.
- **Backward compatibility.** `listOpenIssues()` called with no argument (any other caller) behaves
  exactly as before; the poller is the only caller that passes a filter.
- **Clean tree.** No generated artifacts; revert any incidental lockfile churn. `.agent/` scratch is
  removed before merge by the pipeline (per repo convention).

## Testing

- **Intake (required):** `src/loop/issue-intake-poller.test.ts` — with a **label filter** set on the
  watched repo, seed a matching-and-eligible issue and a non-matching-but-otherwise-eligible issue;
  assert only the matching one becomes a candidate run and the non-matching one is never admitted (and
  isn't even counted as a guarded "skip", since it's filtered out before the guards). Add a companion
  case for a **milestone filter**, and one for **both set** (must match all). Extend the `setup()`
  fixture to accept `filterLabel`/`filterMilestone`.
- **Adapter:** `src/integration/github-fake.test.ts` — `listOpenIssues({label})`, `({milestone})`, and
  both, return only matching open issues; no filter returns all (unchanged).
- **Store:** `src/store/repository.test.ts` — `setRepoWatch` round-trips the filter columns
  (set / leave-as-is / clear-to-null); a migrated pre-existing DB gains the columns as `NULL`.
- **API:** `src/api/server.test.ts` / `orchestrator.test.ts` — `POST /repos/watch` with
  `filterLabel`/`filterMilestone` persists and returns them on the `Repo`; empty string normalizes to
  `null`; invalid non-string types are `400`.
- **Dashboard:** `dashboard/src/lib/render.test.ts` — `repoLedgerModel` surfaces the filter fields on
  the ledger row.
- Run the full `npm test` suite + `npm run build` (dashboard) before finishing; keep the working tree
  clean.

## Scope flags

- `needs_backend`: **true** — storage/migration, adapter, poller, and API changes.
- `needs_frontend`: **true** — dashboard filter control (types, render, store, Home.svelte, css).
