---
name: trinity-connect
description: Pair this Codex App or CLI installation with Trinity capture
---

Connect this Codex installation using the user's short-lived pairing code.

1. Resolve `<pluginRoot>` from this installed skill at
   `<pluginRoot>/skills/trinity-connect/SKILL.md`. Use the Codex executable for
   this host from PATH or the running app's resources.
2. Before starting the helper, use the host's permission flow to obtain any needed
   approval for this exact setup command to run with write access to `CODEX_HOME`.
   The helper's check does not approve hooks or submit a pairing code, but the
   native Codex process initializes its own SQLite state there. A workspace-only
   sandbox may deny that initialization. Use approved access outside that sandbox
   when needed, preserving the same host and `CODEX_HOME`; never switch homes,
   change global permission rules, bypass approval, or retry after a denial without
   the required user approval. Keep this approved execution context for the helper
   and pairing commands.
   Run `node "<pluginRoot>/dist/codex-hook-setup.js" check <codex-executable>`.
   It identifies this installed plugin and reports its capture-hook readiness.
   Stop on a missing, disabled, policy-blocked, or unsupported hook configuration.
3. If the result is `approval_required`, show the returned hook definitions and
   ask the user once whether to trust these Trinity capture hooks. Explain that
   they capture prompts and replies only in repositories enabled in Trinity.
   Wait for an explicit affirmative response. The original install request and
   automatic command approval are not hook consent. If the user declines, stop.
   After approval, run
   `node "<pluginRoot>/dist/codex-hook-setup.js" approve <fingerprint> <codex-executable>`
   with the fingerprint from that check. Require a `ready` result before pairing.
   Never edit trust records, copy trust from another plugin, bypass hook trust, or
   approve changed definitions without asking the user again.
4. Preserve the host's `CODEX_HOME`, `TRINITY_CAPTURE_DATA`, and `PLUGIN_DATA`.
   If a data directory variable is present, run
   `node "<pluginRoot>/dist/codex-connect.js" <pairing-code>`.
   Otherwise pass the `pluginId` returned by the hook check as the second argument:
   `node "<pluginRoot>/dist/codex-connect.js" <pairing-code> <pluginId>`.
   Pass all values as separate subprocess arguments. Never print the pairing code
   or credentials. Use the supplied Trinity server for this pairing process only.
5. A successful connector exit means pairing is saved. The next task's trusted
   SessionStart hook promotes the pending credential. Do not exchange the code
   again, manufacture a confirmation, upload a test conversation, or import old
   sessions. If pairing was already saved in this setup, preserve it and finish
   the hook check without another exchange.
6. Only after the hook check is ready and pairing is saved, reply:

```text
Trinity is paired.
Start a new Codex task in the repository where you want to work. Capture starts automatically.
```

If setup cannot finish, state the specific blocker and one recovery action.
