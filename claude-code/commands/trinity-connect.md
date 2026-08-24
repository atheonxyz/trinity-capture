---
description: Pair this Claude Code installation with Trinity capture
argument-hint: [pairing-code]
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/connect.js" $1`

Report the command's output to the user as-is. Do not take any further action.
