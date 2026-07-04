# Plan - Gate automatic issue pickup for watched repositories

Issue: `jzohdi/agents-fsm#3`

## Goal

Continuous watch mode must stop treating every open issue in a watched repository as safe work. The
Issue Intake Poller should automatically start a run only for eligible issues:

- filed by the repository owner,
- unassigned,
- not marked with the literal `[WIP]` marker in the title or body,
- or explicitly opted in with an override label.

Manual run creation must keep using the existing explicit `POST /runs` / dashboard start path and must
not be gated by these automatic-intake guards.

## PR Feedback Re-plan

This run is revising an existing PR after reviewer feedback that the branch did not clearly gate
automatic pickup by the six issue-eligibility requirements. The implementation stage should treat the
following as the acceptance checklist for resolving that feedback, not as optional polish:

- automatic intake must evaluate owner, assignee, `[WIP]`, and override-label state before calling
  `RunStarter.start`;
- non-owner, assigned, and `[WIP]` issues must produce skip decisions and operator-visible log text;
- the configured override label, defaulting to `agent help wanted`, must bypass every guard;
- manual start paths must remain outside this policy.

## Current State

- Continuous mode already has a pure decision core in `src/loop/issue-intake.ts` and an impure polling
  driver in `src/loop/issue-intake-poller.ts`.
- Watched repositories are stored on `repos.watch`; the repo row also has `watch_label`, exposed as
  `Repo.watchLabel` in `src/store/repository.ts`.
- The API route `POST /repos/watch` already accepts an optional `label` field, so per-repo override
  label configuration can stay backend/API-scoped. The dashboard watch button can remain an on/off
  control for this issue.
- The GitHub adapter surface already separates run issue reads from watch-list reads:
  `GitHub.listOpenIssues()` returns author, assignees, and labels on `RepoIssue`, while
  `readIssue()` remains the lean run input path.
- The real CLI adapter can fetch the needed fields with `gh issue list --json
  number,title,body,author,assignees,labels`; the fake adapter can seed the same fields for tests.

## Approach

Keep the policy in a small, deterministic function and keep side effects in the poller:

1. Implement or preserve `decideIntake(openIssues, runStatusByRef, policy)` in
   `src/loop/issue-intake.ts`.
   - This is the required gate for issue #3; do not rely on GitHub search filters, labels alone, or
     tests that only cover sequential pickup.
   - Sort new candidates by issue number so automatic pickup is deterministic and oldest-first.
   - Deduplicate issues that already have any run row; non-`stopped` runs count against the in-flight
     cap, while `stopped` frees the slot but does not allow the same open issue to be re-picked.
   - Apply the guards only to automatic candidates with no existing run.
   - Treat the override label as a bypass for all guards, matched case-insensitively.
   - Use `agent help wanted` as `DEFAULT_WATCH_LABEL`.
   - Return skipped issues with human-readable reasons that include the concrete guard and the label
     hint operators can use to override.

2. Wire the poller in `src/loop/issue-intake-poller.ts`.
   - Scan only `repo.watch === true` repositories and continue skipping repos with no configured
     working-directory source.
   - Resolve the owner from the canonical repo ref's first path segment, and resolve the override label
     as `repo.watchLabel ?? DEFAULT_WATCH_LABEL`.
   - Build the latest status map from existing runs for that repo and pass it to `decideIntake`.
   - Only call `RunStarter.start` for `plan.start`; guarded issues must never reach the existing run
     admission path unless they have the override label.
   - Start at most one selected issue through the existing `RunStarter.start({ issueRef })` path so
     manual run admission, duplicate-run checks, enrollment checks, and cost ceiling behavior remain
     unchanged.
   - Log skipped issues as `[issue-intake] skipping <ref>: <reason>`, de-duplicated across ticks while
     the skip remains current, and record an activity log on runs that were auto-picked.

3. Ensure the store and API keep the override label configurable per repository.
   - Keep `repos.watch_label` in `src/store/schema.sql` and the additive migration in
     `src/store/migrations.ts`.
   - Keep `Repo.watchLabel` mapping and `Repository.setRepoWatch(repoRef, watch, label?)`, where
     omitted means "leave existing label unchanged" and `null` means "reset to the default label".
   - Keep `Orchestrator.setRepoWatch` validating enrolled/configured repos before turning watch on.
   - Keep `POST /repos/watch` accepting `{ repoRef, watch, label? }` and validating that `label` is a
     string, `null`, or omitted.

4. Keep manual run creation unchanged.
   - Do not add these guards to `Orchestrator.start`, `POST /runs`, the new-run dashboard bar, or
     `GitHub.readIssue`.
   - The guards live only in the watch/intake path.

5. Update operator documentation if needed.
   - `README.md` should explain the automatic-intake guards, the default override label, the `label`
     field on `POST /repos/watch`, and that skipped issues are logged with reasons.

## Files and Areas

- `src/loop/issue-intake.ts` - pure eligibility and in-flight decision logic.
- `src/loop/issue-intake-poller.ts` - watched repo scan, owner/label policy resolution, skip logging,
  and run start call.
- `src/integration/github.ts` - `RepoIssue` shape and `GitHub.listOpenIssues()` contract.
- `src/integration/github-cli.ts` - real `gh issue list` field mapping.
- `src/integration/github-fake.ts` - fake issue seeding and list projection for tests.
- `src/store/schema.sql`, `src/store/migrations.ts`, `src/store/repository.ts` - per-repo watch label
  persistence and mapping.
- `src/api/orchestrator.ts`, `src/api/server.ts` - `POST /repos/watch` validation and label plumbing.
- Tests in `src/loop/issue-intake.test.ts`, `src/loop/issue-intake-poller.test.ts`,
  `src/store/repository.test.ts`, `src/api/orchestrator.test.ts`, `src/api/server.test.ts`, and adapter
  tests where applicable.
- `README.md` - operator-facing continuous mode notes.

No frontend changes are required for the acceptance criteria: the existing dashboard watch toggle can
continue toggling watch state, while custom override labels are configured through the API. If a later
product request asks for label editing in the dashboard, that should be a separate frontend change.

## Risks and Edge Cases

- Owner comparison should be case-insensitive because GitHub owner/repo refs are effectively
  case-insensitive.
- `[WIP]` matching should be case-insensitive but require the literal bracketed marker; do not reject
  unrelated text like "wip" without brackets.
- The override label should bypass all guards, including non-owner authors, assigned issues, and WIP
  issues.
- Skip logging must not spam every poll tick, but it should log again if an issue stops being skipped
  and later becomes skipped again.
- A repo with a large open backlog may be page-limited by the GitHub CLI adapter; keep the page bound
  explicit and deterministic, and let later ticks handle more issues as the slot clears.
- Do not store secrets or GitHub tokens in repo settings; the new setting is only a label string.
- Avoid SQL teardown in tests. Use in-memory stores and seeded fakes rather than destructive database
  cleanup.

## Testing Plan

- Unit-test `decideIntake` for eligible admission, deterministic oldest-first selection, one issue per
  pass, in-flight cap behavior, deduplication against existing runs, owner-only guard, assigned guard,
  `[WIP]` title/body guard, and override-label bypass including custom/case-insensitive labels.
- Poller tests with the real in-memory repository plus `FakeGitHub` should verify watched-only scans,
  automatic start through `RunStarter`, sequential behavior across passes, skip logging de-duplication,
  relogging after a skip disappears and recurs, and multi-repo adapter isolation.
- Store/API tests should verify `watchLabel` round-trips, re-enrolling a repo does not reset watch
  settings, `POST /repos/watch` accepts a custom label, rejects invalid payloads, and still requires a
  configured working directory before enabling watch.
- Adapter tests should verify `GitHubCli.listOpenIssues()` maps `author`, `assignees`, and `labels`,
  and `FakeGitHub.listOpenIssues()` returns the same fields while excluding closed issues.
- Run `npm test`, `npm run typecheck`, and `npm run lint` after implementation. If dashboard code is
  touched unexpectedly, also run `npm run check:dashboard`.

## Scope Flags

- `needs_backend: true` - all required behavior is in intake policy, poller, GitHub adapter mapping,
  repository/API settings, tests, and docs.
- `needs_frontend: false` - custom label configuration is available through the existing backend API;
  no UI behavior is required to satisfy the issue.
