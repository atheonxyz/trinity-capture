---
name: trinity-connect
description: Pair this Codex CLI installation with Trinity capture
---

Connect this Codex installation with the short-lived pairing code the user provided.

1. Run `codex plugin list --json` and find the `installedPath` for
   `trinity-capture@trinity`. Stop with a clear error if it is not installed.
2. Ask to run the next command outside the Codex sandbox. It needs network access to
   exchange the code and writes the device credential under `~/.codex`; never print
   the pairing code.
3. Run `node "<installedPath>/dist/codex-connect.js" <pairing-code>`.
4. Run `node "<installedPath>/dist/codex-connect.js" --status` as a separate command.
   If it still says pending, wait one second and retry status up to five times while
   the PostToolUse hook promotes the credential into the plugin data directory.
5. Report the final status output as-is.
