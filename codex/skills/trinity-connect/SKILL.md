---
name: trinity-connect
description: Pair this Codex CLI installation with Trinity capture
---

Run the pairing exchange, then confirm it actually landed — a Codex plugin skill's shell
command has no direct access to this device's secured plugin storage, so success is never
assumed from the first command's output alone.

1. Run `node "${PLUGIN_ROOT}/dist/codex-connect.js" <pairing-code>` with the pairing code
   the user gave you (from the Trinity dashboard's IDE integrations page).
2. Run `node "${PLUGIN_ROOT}/dist/codex-connect.js" --status` as its own, separate shell
   command to read back whether the pairing was confirmed.
3. Report the status command's output to the user as-is. Do not take any further action.
