---
description: Pair this Claude Code installation with Trinity capture
argument-hint: [pairing-code]
arguments: [pairing_code]
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/connect.js" "$pairing_code"`

Report the command's output to the user as-is. Do not take any further action.
