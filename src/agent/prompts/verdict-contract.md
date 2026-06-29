## Output contract — review verdict

You are reviewing, not producing. Emit exactly this JSON object as your final message:

```
{
  "acceptable": true,
  "notes": { "kind": "...", "issues": ["..."] }
}
```

Rules:

- `acceptable` is `true` only if the work is correct and ready to hand off with no blocking issues.
- When `acceptable` is `false`, `notes` is **required** and must state every blocking problem
  concretely enough that the fix phase can act on it without guessing.
- Include no keys other than these. Output the JSON only.
