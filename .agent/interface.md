# Interface — Continuous mode: label/milestone filter to scope the watched backlog (jzohdi/agents-fsm#11)

This pins the exact types, signatures, columns, and invariants the `tdd` and implementation stages
build against. It follows `.agent/plan.md`: the scope filter is applied **at fetch time** (in the
GitHub adapter's `listOpenIssues`), so the pure `decideIntake` core and the `RepoIssue` type are
**unchanged**. Two new nullable per-repo config columns carry the filter; the existing `watch_label`
override is untouched and semantically distinct.

Naming is fixed across layers:
- Storage columns: `watch_filter_label`, `watch_filter_milestone` (both `TEXT` nullable).
- `Repo`/`RepoRow` fields: `watchFilterLabel`, `watchFilterMilestone` (`string | null`).
- API body / orchestrator input keys: `filterLabel`, `filterMilestone` (`string | null | undefined`).
- Adapter filter object keys: `label`, `milestone` (`string | null | undefined`).

`null`/absent everywhere means **no filter** (behaviour unchanged — scan all open issues).

---

## Core invariants (the contract every layer upholds)

1. **Scope-before-guards.** The filter is applied when *fetching* the candidate set; `decideIntake`
   still receives an already-scoped `RepoIssue[]` and runs the existing guards on it unchanged. A
   non-matching open issue is **filtered out before the guards** — it is never a candidate and never
   counted as a guarded "skip".
2. **Match-all (AND).** When both filter fields are set, only issues matching **both** are admitted.
   When one is set, only that one constrains. When neither is set, all open issues pass (unchanged).
3. **Orthogonal to the override.** The scope filter and the `watch_label` guard-bypass override are
   independent. The override only affects the guards *within* the already-scoped set; it can never
   pull a non-matching issue back in.
4. **Normalize empty→null at one boundary.** Empty/whitespace-only filter values normalize to `null`
   (= not set) in `Orchestrator.setRepoWatch`, so a blank dashboard input clears the filter and never
   degenerates into `--label ''`. Layers below the orchestrator store/pass values verbatim.
5. **Additive & backward-compatible.** New nullable columns; a migrated pre-existing DB backfills to
   `NULL`. `listOpenIssues()` called with no argument behaves exactly as today (the poller is the only
   caller that passes a filter).

---

## Layer 1 — storage

### `src/store/schema.sql`
Append two nullable columns to the `repos` table, **after** `conflict_policy` (last), matching the
db-drift-guard convention that a fresh schema equals a migrated one:

```sql
watch_filter_label     TEXT,   -- scope the watched backlog to this label (NULL = no label filter); distinct from watch_label (guard-bypass override)
watch_filter_milestone TEXT    -- scope the watched backlog to this milestone (NULL = no milestone filter)
```

### `src/store/migrations.ts`
Add **migration version 15**, name `add repos watch filter columns` (current max is 14; keep versions
gap-free and names unique — the guarded invariants). Additive nullable columns:

```ts
{
  version: 15,
  name: 'add repos watch filter columns',
  apply: (db) => {
    addColumnIfMissing(db, 'repos', 'watch_filter_label', 'TEXT');
    addColumnIfMissing(db, 'repos', 'watch_filter_milestone', 'TEXT');
  },
}
```

Pre-existing DBs backfill to `NULL` (no filter → unchanged); a fresh DB already has them from schema.sql.

### `src/store/repository.ts`

- `RepoRow` — add `watch_filter_label: string | null;` and `watch_filter_milestone: string | null;`.
- `Repo` — add (with doc comments noting they *scope* the backlog, distinct from the `watchLabel`
  override; only meaningful while `watch` is on):
  ```ts
  /** Continuous mode scope filter (issue #11): only consider open issues carrying this label.
   *  `null` = no label filter. Distinct from {@link watchLabel} (the guard-bypass override). */
  watchFilterLabel: string | null;
  /** Continuous mode scope filter (issue #11): only consider open issues in this milestone.
   *  `null` = no milestone filter. */
  watchFilterMilestone: string | null;
  ```
- `mapRepo` — map both columns straight through (`watchFilterLabel: r.watch_filter_label`,
  `watchFilterMilestone: r.watch_filter_milestone`).
- `setRepoWatch` — extend to a **trailing optional `filter` param** so each column is independently
  left / cleared / set, and the single existing positional-`label` caller stays readable:

  ```ts
  setRepoWatch(
    repoRef: string,
    watch: boolean,
    label?: string | null,
    filter?: { filterLabel?: string | null; filterMilestone?: string | null },
  ): void
  ```

  Semantics per column (mirrors the existing `label` convention): **key absent → leave column as-is;
  `null` → clear to NULL; string → set**. Build the `UPDATE` SET-list dynamically from which of
  `watch`/`label`/`filterLabel`/`filterMilestone` are present (parameterized; `watch` is always
  written). `watch` is always updated; `watch_label` written only when `label !== undefined`;
  `watch_filter_label` only when `filter?.filterLabel !== undefined`; `watch_filter_milestone` only
  when `filter?.filterMilestone !== undefined`. All under `WHERE repo_ref = ? COLLATE NOCASE`.

  Backward compatibility: existing calls `setRepoWatch(ref, watch)` and `setRepoWatch(ref, watch, label)`
  behave exactly as before (filter columns untouched).

---

## Layer 5 — GitHub adapter

### `src/integration/github.ts`
- Add an exported filter type:
  ```ts
  /** Scope filter for {@link GitHub.listOpenIssues} (issue #11 — continuous mode). Each field, when a
   *  non-empty string, restricts the fetched set; fields are AND-combined. `null`/`undefined`/absent =
   *  that dimension is unconstrained. Milestone is resolved inside the adapter, so {@link RepoIssue} is
   *  unchanged. */
  export interface IssueFilter {
    label?: string | null;
    milestone?: string | null;
  }
  ```
- Change the `GitHub.listOpenIssues` signature to accept the optional filter (update its doc comment
  to note the AND semantics and that `RepoIssue` is unchanged):
  ```ts
  listOpenIssues(filter?: IssueFilter): Promise<RepoIssue[]>;
  ```
- **`RepoIssue` is NOT changed.** Milestone membership is resolved internally by each adapter.

### `src/integration/github-cli.ts`
`listOpenIssues(filter?: IssueFilter)` appends flags to the existing `gh issue list` argv **only when
the corresponding field is a non-empty string** (trim-check), preserving `--state open`, the
`--json number,title,body,author,assignees,labels` projection, and `--limit 200`:
- `filter?.label` non-empty → push `'--label', filter.label`.
- `filter?.milestone` non-empty → push `'--milestone', filter.milestone`.
`gh` AND-combines the flags, giving match-all for free. No filter → argv identical to today.

### `src/integration/github-fake.ts`
- `SeedIssue` — add `milestone?: string | null;` (doc: "Milestone name, for the intake milestone
  scope filter (issue #11). Defaults to none.").
- `StoredIssue` — add `milestone: string | null;`.
- `seedIssue` — default `milestone: issue.milestone ?? null`.
- `listOpenIssues(filter?: IssueFilter)` — after the existing `state === 'open' && repo` filter, and
  before the sort/map, additionally keep only issues where:
  - if `filter?.label` is a non-empty string: the issue's `labels` include it (**case-insensitive**
    membership — consistent with how the override label is matched).
  - if `filter?.milestone` is a non-empty string: the issue's `milestone` **equals** it
    (**case-insensitive**; a `null` milestone never matches a set filter).
  Each applied only when its field is set → **match all set fields (AND)**. No filter → returns all
  open repo issues exactly as today. The mapped `RepoIssue` shape is unchanged (no `milestone` field).

---

## Loop — intake

### `src/loop/issue-intake-poller.ts`
- `checkRepo` gains the repo's filter. Thread it from `checkOnce` (which already iterates `repo`
  objects) into `checkRepo`. Minimal shape: pass the two filter values (or the whole `repo`) through.
  Build the adapter filter and pass it to `listOpenIssues`:
  ```ts
  const filter: IssueFilter = { label: repo.watchFilterLabel, milestone: repo.watchFilterMilestone };
  const openIssues = await github.listOpenIssues(filter);
  ```
  Passing `{ label: null, milestone: null }` (both unset) MUST behave identically to no filter — the
  adapter treats `null` as unconstrained.
- `decideIntake`, the guard/skip logic, `announceSkip`, and `src/loop/issue-intake.ts` are **unchanged**.
- Optional (non-essential, allowed): include the active filter in the per-repo log line.

### `src/loop/issue-intake.ts`
**No change.** The pure core stays scoped-set-in.

---

## API

### `src/api/orchestrator.ts`
Extend `setRepoWatch` input and normalize:
```ts
setRepoWatch(input: {
  repoRef: string;
  watch: boolean;
  label?: string | null;
  filterLabel?: string | null;
  filterMilestone?: string | null;
}): Repo
```
- Existing behaviour (ref parse, 404 if unenrolled, source-configured guard when turning watch on)
  is unchanged. **No new guard** — a filter is valid regardless of `watch`/source state.
- **Normalize each filter field before persisting**: `undefined` → pass through as `undefined`
  (leave column as-is); a string → `trim()`, and an empty result → `null` (clear); `null` → `null`.
  Define a small helper (e.g. `normalizeFilter(v) => v === undefined ? undefined : (v?.trim() || null)`).
- Forward to `this.repo.setRepoWatch(ref, input.watch, input.label, { filterLabel, filterMilestone })`
  with the normalized values. Update the doc comment to distinguish the scoping filter from the
  override label.

### `src/api/server.ts` — `POST /repos/watch`
In the existing handler, additionally read and validate `filterLabel` and `filterMilestone` with the
**same shape/validation as `label`** (each must be `string | null | undefined`, else `400`):
```ts
const filterLabel = body.filterLabel;
if (filterLabel !== undefined && filterLabel !== null && typeof filterLabel !== 'string')
  return sendError(res, new ApiError(400, '"filterLabel" must be a string, null, or omitted'));
const filterMilestone = body.filterMilestone;
if (filterMilestone !== undefined && filterMilestone !== null && typeof filterMilestone !== 'string')
  return sendError(res, new ApiError(400, '"filterMilestone" must be a string, null, or omitted'));
```
Pass both (cast `as string | null | undefined`) to `orch.setRepoWatch(...)`. Update the route comment.
The endpoint returns the updated `Repo` (now carrying `watchFilterLabel`/`watchFilterMilestone`).

**Round-trip contract:** `POST /repos/watch { repoRef, watch, filterLabel, filterMilestone }` →
persisted columns → the returned `Repo` and subsequent `GET /repos` reflect the (normalized) values;
an empty-string field is returned as `null`.

---

## Dashboard

### `dashboard/src/lib/types.ts` — `Repo`
Add (matching the server `Repo`):
```ts
/** Continuous mode scope filter (issue #11): only pick up open issues with this label; `null` = no
 *  label filter. Distinct from {@link watchLabel} (the guard-bypass override). */
watchFilterLabel: string | null;
/** Continuous mode scope filter (issue #11): only pick up open issues in this milestone; `null` = none. */
watchFilterMilestone: string | null;
```

### `dashboard/src/lib/render.ts` — `RepoLedgerRow` + `repoLedgerModel`
- Add to `RepoLedgerRow`: `watchFilterLabel: string | null;` and `watchFilterMilestone: string | null;`.
- `blank()` defaults: both `null`.
- In `repoLedgerModel`, populate from `repo` in the enrolled-repo branch:
  `watchFilterLabel: repo.watchFilterLabel ?? null, watchFilterMilestone: repo.watchFilterMilestone ?? null`
  (older daemons that don't send the fields default to `null` — no filter).

### `dashboard/src/lib/store.svelte.ts`
- Keep `setRepoWatch(repoRef, watch)` as-is for the plain toggle — it POSTs `{ repoRef, watch }` and
  **omits** the filter keys, so the store's "absent key → leave as-is" semantics never clobber the
  filter.
- Add:
  ```ts
  export async function setRepoWatchFilter(
    repoRef: string,
    filterLabel: string | null,
    filterMilestone: string | null,
  ): Promise<void>
  ```
  It POSTs `/repos/watch` with the row's **current** `watch` value (the endpoint requires `watch`)
  plus `filterLabel`/`filterMilestone`, then `loadRepos()` and shows a banner. Read the current
  `watch` from the loaded repos state (mirror how existing repo-config setters resolve current state);
  it must not toggle `watch`.

### `dashboard/src/lib/Home.svelte`
Next to the existing **Watch** control, add a compact scope-filter control (styled consistently with
`af-hwatch`/`af-hconflict`): a chip/summary showing the active scope (e.g. `label:bug · milestone:v2`,
or "all issues" when both unset) that expands to two inputs (label, milestone) with an apply action
calling `setRepoWatchFilter`. Empty inputs clear the corresponding filter (normalized server-side).
Only meaningful for an enrolled repo (like Watch).

### `dashboard/src/app.css`
Minimal styles for the new control, reusing existing tokens.

---

## Docs

### `README.md`
Update §5 "Milestone 11": move the label/milestone filter from *Still open* into *Shipped* (leaving
the configurable cap > 1 as the remaining open item); add a sentence to operating-guide §9.10
describing the scope filter and how it differs from the `watch_label` override.

---

## Test contract (what `tdd` writes failing tests against)

1. **Intake poller — `src/loop/issue-intake-poller.test.ts` (required):** extend the `setup()` fixture
   to accept `filterLabel?`/`filterMilestone?` and pass them through `setRepoWatch`. With a **label
   filter** set, seed a matching-and-eligible issue and a non-matching-but-otherwise-eligible issue;
   assert only the matching one becomes a candidate run (`pass.started === 1` for it) and the
   non-matching one is neither started nor counted as a guarded skip (`pass.skipped` unaffected by it).
   Companion cases: a **milestone filter** only, and **both set** (must match all).
2. **Adapter — `src/integration/github-fake.test.ts`:** `listOpenIssues({ label })`, `({ milestone })`,
   and both, return only matching open issues; case-insensitive; `listOpenIssues()` (no arg) returns
   all open issues unchanged.
3. **Store — `src/store/repository.test.ts`:** `setRepoWatch` round-trips the filter columns
   (set / leave-as-is when key absent / clear-to-`null`); a pre-existing DB migrated to v15 gains both
   columns as `NULL`.
4. **API — `src/api/server.test.ts` / `orchestrator.test.ts`:** `POST /repos/watch` with
   `filterLabel`/`filterMilestone` persists and returns them on the `Repo`; an empty/whitespace string
   normalizes to `null`; a non-string/non-null value is `400`; the plain watch toggle does not clobber
   an existing filter.
5. **Dashboard — `dashboard/src/lib/render.test.ts`:** `repoLedgerModel` surfaces
   `watchFilterLabel`/`watchFilterMilestone` on the ledger row.

Run `npm test` + `npm run build` (dashboard) before finishing; keep the working tree clean (no
generated artifacts, no incidental lockfile churn).
