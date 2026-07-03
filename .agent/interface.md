# Interface - Gate automatic issue pickup for watched repositories

Issue: `jzohdi/agents-fsm#3`

This specification defines the contracts the TDD and implementation stages must build against. The
change is backend-scoped: the automatic watch/intake path gets eligibility guards and override-label
configuration, while manual run creation through `POST /runs` / `Orchestrator.start` remains unchanged.

## Module Boundaries

- Pure intake policy lives in `src/loop/issue-intake.ts`. It must not read the store, call GitHub,
  log, start runs, or depend on time.
- The impure polling driver lives in `src/loop/issue-intake-poller.ts`. It resolves watched repos,
  fetches open issues, reads existing run state, logs skips, and starts selected runs through the
  existing `RunStarter.start({ issueRef })` path.
- GitHub issue-list adapters expose only the data the policy needs on `RepoIssue`; `readIssue()` stays
  the lean manual/run input path and is not extended for intake-only fields.
- Repository/API settings expose the per-repo override label as an optional watch setting.
- No frontend API or dashboard change is required for acceptance; custom labels are configured through
  `POST /repos/watch`.

## Intake Policy - `src/loop/issue-intake.ts`

Export the default override label:

```ts
export const DEFAULT_WATCH_LABEL = 'agent help wanted';
```

Expose the issue projection consumed by the pure decision function:

```ts
export interface IntakeIssue {
  ref: string;          // canonical "owner/repo#123"
  number: number;
  title: string;
  body: string;         // empty string when GitHub returns null/undefined
  author: string;       // GitHub login
  assignees: string[];  // GitHub logins
  labels: string[];     // label names
}
```

Expose the per-repo policy resolved by the poller:

```ts
export interface IntakePolicy {
  owner: string;         // canonical repo owner login, compared case-insensitively
  overrideLabel: string; // label that bypasses all guards, matched case-insensitively
  inFlightCap: number;   // clamped to at least 1 by decideIntake
}
```

Expose skipped issues and the decision result:

```ts
export interface IntakeSkip {
  ref: string;
  number: number;
  reason: string;
}

export interface IntakePlan {
  start: { issueRef: string; issueNumber: number } | null;
  inFlight: number;
  cap: number;
  skipped: IntakeSkip[];
}
```

Decision function signature:

```ts
export function decideIntake(
  openIssues: IntakeIssue[],
  runStatusByRef: Map<string, RunStatus>,
  policy: IntakePolicy,
): IntakePlan
```

Decision invariants:

- `openIssues` may arrive in any order; new candidates must be evaluated by ascending `number`.
- `runStatusByRef` keys are lowercased issue refs. Any issue with an existing map entry is never a
  fresh candidate, including `stopped` runs.
- Existing non-`stopped` runs count toward `inFlight`. `stopped` runs do not count toward the cap, but
  still deduplicate the issue.
- If `inFlight >= cap`, `start` is `null` and guard skips for fresh issues do not need to be produced
  for that pass.
- At most one issue is selected per call. The first eligible candidate becomes `start`; later candidates
  are not inspected in that pass.
- Owner comparison is case-insensitive.
- Override-label comparison is case-insensitive and bypasses all guards.
- `[WIP]` matching is case-insensitive and requires the literal bracketed marker in either title or
  body. Plain `wip` without brackets is not a match.
- Guard order for non-overridden candidates is owner, assigned, WIP. The returned reason identifies the
  concrete guard and includes the override-label hint.
- `cap` in the result is `Math.max(1, Math.trunc(policy.inFlightCap))`.

Skip reason contract:

- Non-owner author: includes the actual author, expected owner, and `add the "<label>" label`.
- Assigned issue: includes the assignee logins and `add the "<label>" label`.
- WIP issue: includes `marked [WIP]` and `add the "<label>" label`.

Owner helper:

```ts
export function ownerOf(repoRef: string): string
```

`ownerOf` returns the first path segment of canonical `owner/name`, preserving case.

## Poller - `src/loop/issue-intake-poller.ts`

The poller continues to depend on the existing run-admission seam:

```ts
export interface RunStarter {
  start(input: { issueRef: string }): { id: number };
}
```

Pass summary:

```ts
export interface IntakePass {
  reposScanned: number;
  started: number;
  skipped: number;
}
```

`IssueIntakePoller.checkOnce(): Promise<IntakePass>` must:

- Iterate `Repository.listRepos()` in stored order and scan only rows with `repo.watch === true`.
- Skip watched repos whose `sourceMode === null`; enabling watch should already reject this, but the
  poller remains defensive.
- Resolve the adapter with `resolver.for(repo.repoRef)` per scanned repo.
- Call `github.listOpenIssues()` and pass the returned issues directly into `decideIntake`.
- Build `runStatusByRef` from `Repository.listRuns({ repo: repo.repoRef })`, using the newest row per
  lowercased `issueRef`.
- Resolve policy as `{ owner: ownerOf(repo.repoRef), overrideLabel: repo.watchLabel ?? DEFAULT_WATCH_LABEL, inFlightCap: 1 }`.
- For every `plan.skipped`, increment `pass.skipped` and log one operator-visible skip message:
  `[issue-intake] skipping <ref>: <reason>`.
- Deduplicate skip logs across poll ticks while the same `<ref>:<reason>` remains current, and log again
  if the skip disappears and later recurs.
- If `plan.start` is present, call only `starter.start({ issueRef })`; do not create runs directly.
- After a successful automatic start, record a run log with message
  `auto-picked from <repoRef> backlog (watched repo, continuous mode)` and data
  `{ kind: 'issue_intake', issueRef, issueNumber }`.
- Isolate failures per repo: an adapter/list/start failure logs and lets the pass continue to other repos.

Manual start invariant:

- Do not add owner/assignee/WIP/label guards to `Orchestrator.start`, `POST /runs`, dashboard new-run
  controls, or `GitHub.readIssue`. Manual run creation remains the explicit override path.

## GitHub Adapter - `src/integration/github.ts`

Keep `Issue` unchanged:

```ts
export interface Issue {
  ref: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
}
```

Expose intake-only fields on the list projection:

```ts
export interface RepoIssue {
  ref: string;
  number: number;
  title: string;
  body: string;
  author: string;
  assignees: string[];
  labels: string[];
}
```

Adapter contract:

```ts
export interface GitHub {
  readIssue(issueRef: string): Promise<Issue>;
  listOpenIssues(): Promise<RepoIssue[]>;
  // existing members unchanged
}
```

`listOpenIssues()` returns open issues only. The fake and real adapters must agree on field semantics:

- `ref` is canonical `<repo>#<number>`.
- `body` is always a string; null/missing GitHub bodies map to `''`.
- `author` is a login string. If the real API omits it, map to a stable placeholder such as `unknown`
  rather than throwing inside the adapter.
- `assignees` and `labels` default to empty arrays.

`GitHubCli.listOpenIssues()` must request:

```text
gh issue list --repo <repo> --state open --json number,title,body,author,assignees,labels --limit 200
```

`FakeGitHub.seedIssue(ref, issue)` supports:

```ts
{
  number: number;
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  author?: string;
  assignees?: string[];
  labels?: string[];
}
```

Fake seeding defaults should make a plain seeded issue eligible: open state, empty body, author equal to
the ref owner, no assignees, no labels. `FakeGitHub.listOpenIssues()` returns seeded open issues only.

## Repository Settings - `src/store/repository.ts`

`Repo` includes the existing continuous-watch fields:

```ts
export interface Repo {
  repoRef: string;
  watch: boolean;
  watchLabel: string | null; // null means DEFAULT_WATCH_LABEL
  sourceMode: RepoSourceMode | null;
  // existing fields unchanged
}
```

Watch setter contract:

```ts
setRepoWatch(repoRef: string, watch: boolean, label?: string | null): void
```

Semantics:

- `label === undefined`: update only `watch`; leave `watch_label` unchanged.
- `label === null`: set `watch_label` to `NULL`, meaning use `DEFAULT_WATCH_LABEL`.
- `typeof label === 'string'`: persist that custom override label exactly.
- Lookup is case-insensitive by `repo_ref`.
- `upsertRepo()` must not reset `watch` or `watch_label` when re-enrolling a repo.

Schema/migration contract:

- `repos.watch INTEGER NOT NULL DEFAULT 0`
- `repos.watch_label TEXT`
- Existing databases receive both columns through an additive, idempotent migration.
- No secrets or tokens are added to repo settings.

## Orchestrator/API

`Orchestrator.setRepoWatch` accepts the label:

```ts
setRepoWatch(input: { repoRef: string; watch: boolean; label?: string | null }): Repo
```

Behavior:

- `repoRef` is required and normalized through `parseRepoRef`; malformed refs are `400`.
- Unknown enrolled repo is `404`.
- Turning watch on requires `existing.sourceMode !== null`; otherwise `400`.
- Turning watch off is always allowed for an enrolled repo.
- Passes `label` through to `Repository.setRepoWatch` with the exact omitted/null/string semantics above.
- Returns the updated `Repo`.

HTTP route:

```http
POST /repos/watch
Content-Type: application/json

{
  "repoRef": "owner/repo",
  "watch": true,
  "label": "agent help wanted"
}
```

Validation:

- `"watch"` is required and must be boolean.
- `"repoRef"` is required and must be string.
- `"label"` may be omitted, `null`, or string. Any other type returns `400` with a clear message.
- Response is the updated `Repo` JSON.

No `POST /runs` request/response shape changes.

## Documentation Contract

`README.md` continuous-mode/operator documentation should state:

- Watched repos only auto-pick eligible open issues.
- Default eligibility requires owner-filed, unassigned, and no literal `[WIP]` in title/body.
- The configured override label bypasses those guards; default is `agent help wanted`.
- `POST /repos/watch` accepts an optional `label` field, with `null` resetting to the default.
- Skipped issues are logged with reasons and an override-label hint.
- Manual run creation is unchanged and remains explicit.

## Test Surface

Focused tests should cover:

- `decideIntake`: eligible admission, oldest-first selection, cap behavior, existing-run dedup including
  stopped runs, owner-only guard, assigned guard, `[WIP]` title/body guard, default override label,
  custom override label, case-insensitive owner/label/WIP matching, and skip reason text.
- `IssueIntakePoller`: watched-only scanning, source-mode defensive skip, per-repo adapter isolation,
  run start through `RunStarter`, status map using newest run per issue, skip logging de-duplication,
  relogging after a skip disappears and recurs, and activity-log recording for auto-picked runs.
- `GitHubCli.listOpenIssues()`: command arguments and mapping for author, assignees, labels, null body,
  and canonical refs.
- `FakeGitHub.listOpenIssues()`: returns open issues only and preserves seeded author/assignee/label data.
- Repository/schema: `watchLabel` round-trip, omitted label preserves existing value, `null` resets to
  default/null, custom label persists, and re-enroll does not reset watch settings.
- Orchestrator/server: `/repos/watch` accepts custom label/null/omitted, rejects invalid label payloads,
  requires configured source before enabling watch, and leaves manual `/runs` behavior unchanged.

Implementation verification should run `npm test`, `npm run typecheck`, and `npm run lint`. Dashboard
checks are only required if frontend files are unexpectedly touched.
