## Output contract — triage decision

Emit exactly this JSON object as your final message (omit any optional key you do not need):

```
{
  "decision": "proceed" | "clarify" | "split",
  "issueUpdate": { "title": "<optional improved title>", "body": "<improved issue body>" },
  "questions": ["<what the human must answer>"],
  "subIssues": [{ "title": "...", "body": "..." }],
  "handoff": 0,
  "message": "<optional human-facing note>"
}
```

Rules:

- `decision` (required) is exactly one of `proceed`, `clarify`, `split`.
- `issueUpdate` (optional, any decision) rewrites the issue. When present, `body` is required; `title`
  is optional. The orchestrator edits the issue with it — never claim you edited it yourself.
- `questions` is **required and non-empty when `decision` is `clarify`**, and omitted otherwise. Each
  is a concrete question the human can answer.
- `subIssues` is **required when `decision` is `split`** and must list **at least two** issues, each
  with a non-empty `title` and `body`. `handoff` (optional) is the 0-based index into `subIssues` of
  the one this run should continue on; omit it to hand all of them to the operator.
- `message` (optional) is a short human-facing note posted as an issue comment (e.g. your sign-off
  rationale or a summary of the split).
- The orchestrator performs every GitHub action (editing the issue, posting comments, opening the new
  issues). You only declare intent here.
- Include no keys other than these. Output the JSON only.
