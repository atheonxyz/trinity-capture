---
name: trinity-connect
description: Pair this Codex App or CLI installation with Trinity capture
---

Connect this Codex installation with the short-lived pairing code the user provided.

1. Run `codex plugin list --json`. If it fails because the `trinity` marketplace
   no longer loads, run `codex plugin marketplace remove trinity` and retry.
2. If no installed plugin is named `trinity-capture`, inspect
   `codex plugin marketplace list --json`:
   - If `trinity` is absent, run
     `codex plugin marketplace add https://github.com/atheonxyz/trinity-capture.git`.
   - If `trinity` exists, run `codex plugin marketplace upgrade trinity`.
   Then run `codex plugin add trinity-capture@trinity`.
3. Run `codex plugin list --json` again and find the installed path for the plugin
   named `trinity-capture`, regardless of marketplace. Stop with a clear error if
   it is still absent.
4. Ask to run the next command outside the Codex sandbox. It needs network access to
   exchange the code and writes the device credential under `~/.codex`; never print
   the pairing code.
5. Set `TRINITY_CAPTURE_DATA` to
   `${CODEX_HOME:-$HOME/.codex}/plugins/data/trinity-capture-trinity`, then run
   `node "<installedPath>/dist/codex-connect.js" <pairing-code>` with that environment.
6. Run `node "<installedPath>/dist/codex-connect.js" --status` separately and report
   the output as-is. When connected, tell the user to start a new Codex task so its
   capture hooks load from the beginning of the session.
