# Trinity Capture

Trinity Capture connects Claude Code, Codex, and Cursor sessions to [Trinity](https://usetrinity.ai), where teams can follow coding work alongside the rest of their project context.

The clients are deliberately small:

- No daemon or background service.
- No repository configuration or committed hooks.
- No uploads from repositories that are not enabled in Trinity.
- No tool input or output bodies, reasoning text, absolute local paths, or vendor account email fields.
- A local outbox retries transient delivery failures without blocking the coding agent.

## Install

Requires Node >= 20.

### Cursor

1. In Cursor, run `/add-plugin trinity-capture`.
2. Run `/trinity-connect`.
3. Approve the named Cursor device in the Trinity browser tab that opens.

Cursor waits for the browser approval, stores its credential in the operating system's per-user application-data directory, downloads the repository allowlist, and reports when setup is complete.

### Claude Code

#### Claude Desktop

1. Open the [Claude Plugin Directory](https://claude.com/plugins), find **Trinity**, and select **Install**.
2. Start a new Claude Code session so the plugin is available.
3. Generate a Claude Code pairing code from Trinity, then run `/trinity:connect <code>`.
4. Exit Claude Code and start a new session in an enabled repository.

#### Claude CLI

1. Run `claude plugin install trinity-capture@claude-plugins-official` in your terminal.
2. Start Claude Code.
3. Generate a Claude Code pairing code from Trinity, then run `/trinity:connect <code>`.
4. Exit Claude Code and start a new session in an enabled repository.

### Codex

#### Codex App

1. Open [Trinity](https://chatgpt.com/plugins/plugins_6a8fe5b3cef48191bf833140a688aa76) and select **Install**.
2. Start a new Codex task and approve the Trinity hooks when prompted.
3. Generate a Codex pairing code from Trinity, then run `$trinity-connect <code>`.
4. Start a new Codex task in an enabled repository.

#### Codex CLI

1. Start Codex and run `/plugins`.
2. Find **Trinity**, select **Install**, then start a new Codex session.
3. Approve the Trinity hooks when prompted.
4. Generate a Codex pairing code from Trinity, then run `$trinity-connect <code>`.
5. Start a new Codex session in an enabled repository.

## What leaves your device

Capture is allowlist-first. The plugin reads the current Git remote locally and stays silent unless it matches a repository enabled in one of your Trinity projects.

For a matching repository, Trinity receives:

- The prompt and assistant response for each turn.
- The coding tool, model, branch, HEAD commit, dirty state, and bounded diff statistics.
- Tool names and call identifiers, never tool arguments or results.
- Session lifecycle timestamps and completion reasons.

Trinity does not receive unmatched repository identities, absolute paths, environment variables, tool bodies, reasoning text, or Cursor's `user_email` field. See [PRIVACY.md](PRIVACY.md) for the complete disclosure.

## How it works

Each host invokes a short-lived Node.js hook process. The shared core:

1. Resolves the plugin's private data directory.
2. Loads the signed-in device credential and cached capture policy.
3. Resolves the current Git remote locally.
4. Fails closed unless the policy is fresh and the repository is allowlisted.
5. Filters the native hook payload through an event-specific allowlist.
6. Appends the event to the local outbox before attempting delivery.

Turn keys are minted locally and stored one file per vendor turn ID, so concurrent hook processes cannot overwrite one another. Network calls have bounded timeouts. Cursor and Codex use bounded synchronous drains at lifecycle boundaries; Claude Code uses detached hooks where supported.

## Credential storage

Claude Code and Codex provide plugin-specific data directories. Cursor does not, so Trinity Capture uses the operating system's per-user application-data location:

| Platform | Cursor credential directory |
| --- | --- |
| macOS | `~/Library/Application Support/Trinity Capture/cursor` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/trinity-capture/cursor` |
| Windows | `%LOCALAPPDATA%\Trinity Capture\cursor` |

On POSIX systems, directories are mode `0700` and credential files are mode `0600`. `TRINITY_CAPTURE_DATA` overrides this location for development.

## Local development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build:plugin
pnpm build:codex
pnpm build:plugin-cursor
```

The generated `claude-code/dist`, `codex/dist`, and `cursor/dist` directories are committed because installed plugins execute them directly. CI rebuilds all three and fails if committed output is stale.

To test Cursor locally, copy the plugin directory and reload Cursor:

```bash
mkdir -p ~/.cursor/plugins/local
cp -R cursor ~/.cursor/plugins/local/trinity-capture
```

The environment-gated integration tests require:

- `TRINITY_E2E_URL`
- `TRINITY_E2E_SESSION_TOKEN`
- `TRINITY_E2E_PROJECT_ID`
- `TRINITY_E2E_USER_ID`
- `TRINITY_E2E_POSTGRES_URL`

## Contributing and support

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Report vulnerabilities according to [SECURITY.md](SECURITY.md).
- Get product and setup help through [SUPPORT.md](SUPPORT.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

Trinity names and brand assets are excluded from the code license. See [TRADEMARKS.md](TRADEMARKS.md).
