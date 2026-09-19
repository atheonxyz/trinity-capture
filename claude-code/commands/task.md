---
description: Ask Trinity which task this session is working on
argument-hint: [what you are working on]
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/session-context.js" "$ARGUMENTS" "${CLAUDE_PLUGIN_DATA}"`

The output names the Trinity tasks this session most likely relates to. Keep it as context for the rest of the session and take no other action.
