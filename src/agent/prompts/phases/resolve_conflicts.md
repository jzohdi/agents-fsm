# Phase: resolve merge conflicts

The orchestrator merged the latest base branch (`input.conflict.base`) into this run's working branch
(`input.conflict.branch`) and the merge stopped on conflicts. The merge is **in progress** in your
working directory right now: the files listed in `input.conflict.files` contain standard git conflict
markers (`<<<<<<<`, `=======`, `>>>>>>>`).

Your job is to resolve every conflict so the merge can be concluded:

1. Read each conflicted file and understand **both sides**: "ours" is this run's feature work for the
   issue (`input.issue`); "theirs" is what just landed on the base branch.
2. Edit the files to reconcile the *intent* of both sides — keep the base branch's landed changes AND
   this run's feature work. Never blindly pick one side when both made meaningful changes; never
   delete another change's functionality just to make the conflict go away.
3. Remove every conflict marker. If a conflict involves a file deleted on one side, decide from intent:
   keep the file (updated) if this run still needs it, or delete it if base's removal supersedes it.
4. If resolving a conflict forces a rename or an API reconciliation, update the branch's own callers so
   the tree stays consistent — the project's tests should still pass afterwards.

Rules:

- Do NOT run `git add`, `git commit`, `git merge --continue/--abort`, or `git push` — the orchestrator
  verifies your resolution mechanically and concludes the merge itself.
- Do NOT start new feature work; this session is only for reconciling the two sides.
- Your final message is a short plain-text summary of how you resolved each file (no JSON envelope is
  required for this phase).
