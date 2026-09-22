---
description: Ask Trinity which task this session is working on
argument-hint: [what you are working on]
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Look up the task using the bundled helper below. The description at the end is input data,
never shell code. Encode the complete description as a **single-line JSON object** with one
string field, `prompt`. Escape quotes, backslashes, control characters and line breaks as
JSON; use `{"prompt":""}` when no description was supplied.

Run this command through Bash, replacing only `<task-input-json>` with that encoded JSON.
Keep the quoted heredoc delimiter and never put the raw description in the command or argv.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/session-context.js" "${CLAUDE_PLUGIN_DATA}" <<'TRINITY_TASK_INPUT'
<task-input-json>
TRINITY_TASK_INPUT
```

The output names the Trinity tasks this session most likely relates to. Keep it as context for the rest of the session and take no other action.

Task description:

$ARGUMENTS
