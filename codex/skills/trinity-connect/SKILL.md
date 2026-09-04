---
name: trinity-connect
description: Pair this Codex App or CLI installation with Trinity capture
---

Connect this Codex installation with the short-lived pairing code the user provided.

1. Resolve `<pluginRoot>` from this skill's installed path. This file is at
   `<pluginRoot>/skills/trinity-connect/SKILL.md`; confirm that
   `<pluginRoot>/dist/codex-connect.js` exists before continuing.
2. Resolve this installed Trinity plugin's actual identity from the native
   `codex plugin list --json` output by matching `<pluginRoot>`. Keep package
   selectors for install/update decisions only; the connector target is the
   installed identity, not a desired package name.
3. Ask to run the next command outside the Codex sandbox. It needs network access to
   exchange the code and writes the device credential under `~/.codex`; never print
   the pairing code.
4. If `TRINITY_CAPTURE_DATA` or `PLUGIN_DATA` is present in the pairing shell,
   run `node "<pluginRoot>/dist/codex-connect.js" <pairing-code>` so the
   connector keys the handoff to that data directory basename. If neither is
   present, run `node "<pluginRoot>/dist/codex-connect.js" <pairing-code> <installed-plugin-id>`.
5. If the command exits successfully, setup is complete. On a fresh install the
   credential may be pending until the next task's SessionStart hook promotes it;
   that is expected and should not be polled in this setup task.
6. Reply with exactly these two lines and no extra diagnostics, version numbers,
   paths, hook details, credential details, pairing-code guidance, or reload wording:

```text
Trinity is paired.
Start a new Codex task in the repository where you want to work. Capture starts automatically.
```
