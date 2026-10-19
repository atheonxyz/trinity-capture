# Trinity Capture

Trinity Capture connects Claude Code, Codex, Cursor, Gemini CLI, and GitHub Copilot CLI sessions to [Trinity](https://usetrinity.ai), where teams can follow coding work alongside the rest of their project context.

The clients are deliberately small:

- No daemon or background service of their own. The one long-lived process is the bundled MCP server, which the host starts and stops with the plugin.
- No repository configuration or committed hooks.
- No uploads from repositories that are not enabled in Trinity.
- No tool input or output bodies, reasoning text, absolute local paths, or vendor account email fields.
- A local outbox retries transient delivery failures without blocking the coding agent.

Installing a plugin also gives the coding agent Trinity's tools over the paired workspace: reads, and writes that act as the paired person. There is no further setup and no secret is written into any host configuration file. See [Agent tools](#agent-tools).

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

In an enabled repository, a session opens with bounded Trinity task context for the branch. Claude Code refreshes that context from the first prompt when the branch names nothing and after a branch switch. `/trinity:task [what you are working on]` asks at any point.

### Codex

Install [Trinity](https://chatgpt.com/plugins/plugins_6a8fe5b3cef48191bf833140a688aa76)
in the Codex App, or use `/plugins` in Codex CLI. Generate a Codex setup prompt
in Trinity and paste it into Codex. Setup checks the installed capture hooks,
asks for approval if needed, and saves the pairing. The native Codex process needs
write access to its own state directory even for the hook check; setup requests
approved execution access if the workspace sandbox blocks that initialization. You can also run
`$trinity-connect <code>` for an installed plugin.

Approve the specific Trinity capture hooks when setup asks. Existing approvals
are reused; changed hook definitions require a new approval. Setup preserves
other plugins and deliberately disabled hooks. Once setup finishes, start a new
Codex task in an enabled repository. No additional pairing code is needed.

In an enabled repository, Codex receives the same bounded task context at
`SessionStart`, from the first prompt when the branch names nothing, and after a
branch switch. The context uses Codex's native `additionalContext` hook output.

### Gemini CLI

Gemini CLI installs an extension from a GitHub URL only when its manifest sits at the
repository root, and this repository holds one plugin per host, so install the
`gemini` directory from a clone:

1. Run `git clone https://github.com/atheonxyz/trinity-capture.git`.
2. Run `gemini extensions install ./trinity-capture/gemini` and accept the prompt.
3. Generate a Gemini CLI pairing code from Trinity, start Gemini CLI, and run
   `/trinity:connect <code>`. Gemini asks before it runs the connect script. You can
   also run `node ~/.gemini/extensions/trinity-capture/dist/gemini-connect.js <code>`
   in a terminal.
4. Exit Gemini CLI and start a new session in an enabled repository.

The extension registers its hooks in `gemini/hooks/hooks.json`. Gemini CLI hands each
hook the session id, the prompt at `BeforeAgent`, the tool name at `AfterTool`, and the
turn's final reply at `AfterAgent`. In an enabled repository, a session opens with the
same bounded task context as Claude Code, refreshed from the first prompt when the
branch names nothing, through Gemini's `hookSpecificOutput.additionalContext`.
Gemini CLI does not wait for `SessionEnd`, so that event is only queued and leaves
with the next turn.

### GitHub Copilot CLI

1. Run `copilot plugin marketplace add atheonxyz/trinity-capture`, then
   `copilot plugin install trinity-capture@trinity`. You can also install the plugin
   directly with `copilot plugin install atheonxyz/trinity-capture:copilot`.
2. Generate a Copilot CLI pairing code from Trinity, start Copilot CLI, and ask it to
   connect Trinity with that code. The bundled `trinity-connect` skill finds the
   installed plugin and runs its connect script. You can also run
   `node ~/.copilot/installed-plugins/trinity/trinity-capture/dist/copilot-connect.js <code>`
   in a terminal.
3. Exit Copilot CLI and start a new session in an enabled repository.

Copilot CLI hands each hook the session id, the prompt at `userPromptSubmitted`, and
the tool name at `postToolUse`. Its turn-end hook, `agentStop`, carries no reply text,
only the path of a local transcript file whose format Copilot does not document, so
the plugin captures no assistant reply for Copilot CLI and never reads or sends that
file or its path. Task context arrives once, at `sessionStart`, through Copilot's
`additionalContext`; Copilot drops the output of a prompt hook, so the plugin makes no
prompt-time read. If you run Copilot CLI with its session sandbox on, grant the
credential directory below in `sandbox.userPolicy` so the hooks can reach it.

## Update an existing installation

The task handoff release uses these plugin versions:

| Host | Version | After updating |
| --- | --- | --- |
| Claude Code | `0.2.13` | Exit Claude Code and start a new session. |
| Codex | `0.3.17` | Check the updated hooks, then start a new task. |
| Cursor | `0.3.10` | Reload Cursor and start a new Agent conversation. |
| Gemini CLI | `0.1.0` | Pull the clone, run `gemini extensions update trinity-capture`, then start a new session. |
| GitHub Copilot CLI | `0.1.0` | Run `copilot plugin update trinity-capture`, then start a new session. |

Update through the installation's existing source and verify the installed version.
Each host's catalog publishes separately; a version in this repository does not mean
it is already available in that catalog. Preserve the existing plugin identity, data
directory, and saved pairing. Updating does not require a new pairing code or another
Trinity setup flow.

For Codex, run the installed plugin's
`node "<pluginRoot>/dist/codex-hook-setup.js" check <codex-executable>` after updating,
using the same host and `CODEX_HOME`. Follow the hook-check steps in
[the connection skill](codex/skills/trinity-connect/SKILL.md), including any required
execution access. Reuse valid approvals; if the check returns `approval_required`,
show the changed hook definitions and obtain explicit user approval before running
the helper's `approve` command. Stop if hooks are disabled or blocked. Once the check
returns `ready`, keep the saved pairing and start a new task; do not exchange a code.

You can ask your coding agent:

> Update my existing Trinity Capture plugin through its current installation source
> to at least Claude Code 0.2.13, Codex 0.3.17, or Cursor 0.3.10, as appropriate for my
> host. Preserve its identity, data directory, and saved pairing, and verify the
> installed version. For Codex, check the updated hooks and ask me to approve changed
> definitions. Tell me the final restart or new-session step.

## Task context

With the current backend, automatic context includes up to three likely tasks with
their titles, status, and priority. The lookup uses the enabled repository and branch,
plus a prompt when the host supports it. Claude Code and Codex refresh as described
above; Cursor fetches at session start only. Lookups do not change tasks, and a failed
lookup does not stop capture.

A task a person sends to this machine from Trinity opens their next session there
with its brief and any note on what to focus on, in place of the likely tasks. Each
handoff is delivered once, to the first session that asks for context.

The plugin can also render due dates, milestone signals, recent activity, and open
resolutions when an enriched backend returns them. Updating the plugin alone does
not enable those richer fields.

## Agent tools

Each plugin bundles an MCP server named `trinity`. Once the machine is paired, the
coding agent can call Trinity's tools. Installing the plugin is the whole setup; no
host configuration file ever holds a Trinity secret.

The read tools read the workspace the device is paired with and change nothing:

- `get_task` reads one task by its code, issue, pull request, or tracker key.
- `find_tasks` searches the tasks of the paired person's projects.
- `get_task_context` gathers what Trinity knows about one task in one call.
- `read_source` reads a source a task points to, such as a Slack thread.
- `get_milestone` reads one milestone and its tasks.
- `list_milestones` lists the milestones of the paired person's projects.

The write tools act as the paired person, inside the projects they are a member of:

- `start_task` declares the task this session works on. It attaches the session and moves a to-do task to in progress, started at the session's start.
- `report_progress` records one line of what is happening now on a task.
- `ask_blocker` posts a question in the task's originating Slack thread and opens an obligation for the person who asked.
- `link_pull_request` attaches a pull request the agent opened to the task.
- `propose_task` creates a task for work the agent found that nobody tracks.
- `finish_task` marks a task ready for review, blocked, or done where no pull request is expected.

Trinity refuses a write while the workspace is read-only for billing or while Trinity
is being updated.

The server is a small proxy. It answers the MCP handshake locally, so the host
connects even when the machine is offline or not yet paired, and forwards each tool
request as one HTTPS request to the paired Trinity server's agent-tools address,
authenticated with the saved device credential. That address is what Trinity sent
at pairing or in the capture policy; the plugin never derives it, and it must share
the origin the device ingests to. The saved connection is re-read on every request,
so a new pairing or a rotated credential takes effect without restarting the host.

Each host loads it from the plugin itself:

- Claude Code reads `.mcp.json` at the plugin root and passes the plugin's data directory to the server.
- Codex reads `.mcp.json` at the plugin root and runs the server from the plugin directory; the server finds its data directory from its own install path.
- Cursor reads `mcp.json` at the plugin root, named by the plugin manifest.
- Gemini CLI reads the `mcpServers` entry of `gemini-extension.json`.
- GitHub Copilot CLI reads `mcp.json` at the plugin root.

Before pairing, or when the paired Trinity server has not yet offered an
agent-tools address, the tool list is empty and a call reports that Trinity is not
connected on this machine. A revoked or replaced device credential makes a call
report that the device needs to be paired again. A network failure fails the one
call after a bounded wait. None of this affects capture.

## What leaves your device

Capture is allowlist-first. The plugin reads the current Git remote locally and stays silent unless it matches a repository enabled in one of your Trinity projects.

Pairing sends your machine's hostname and a Trinity-specific machine identity. The identity is an HMAC-SHA256 digest derived locally from the operating system's machine identifier, so the raw OS identifier is never sent, logged, or stored by the plugin. Capture uploads include the saved Trinity device credential returned by pairing, but do not recompute or resend the OS machine identity.

The machine identity identifies an OS installation, not a physical device. Reinstalling the OS, resetting a VM, or regenerating `/etc/machine-id` can produce a new identity for the same hardware. Cloned disks or VM images can share an identity until they are regenerated. Trinity uses this value for pairing continuity and device deduplication; it is not hardware attestation or fraud protection.

For a matching repository, Trinity receives:

- The prompt and assistant response for each turn. GitHub Copilot CLI sends the prompt only, because its hooks carry no reply.
- The coding tool, model, branch, HEAD commit, dirty state, and bounded diff statistics.
- Tool names and, where the host supplies them, call identifiers, never tool arguments or results.
- Session lifecycle timestamps and completion reasons.
- In Claude Code and Codex, once per session or branch, the tasks the session likely relates to: a read-only request carrying the repository, branch, and, when supported, the first prompt. Gemini CLI reads the same way. Cursor and GitHub Copilot CLI make the same read at session start, where their hook contracts can inject context, but do not make an unsupported prompt-time read. The response can include task identity, status, priority, due and milestone signals, recent task activity, and open resolutions; the agent receives a bounded rendering marked as workspace data rather than instructions.
- The Trinity tool calls the coding agent chooses to make: the tool name and the arguments the agent supplies, sent with the device credential to the paired Trinity server only. For a read that is a task code or a search phrase. For a write it is what the agent wrote: a task code, a progress line, a question, a pull request number, or a proposed task's title and description. Trinity stores what a write records, as the paired person's action. The answer is shown to the agent and stored nowhere on the device. The proxy sends nothing else from the session.

Trinity does not receive unmatched repository identities, absolute paths, environment variables, tool bodies, reasoning text, transcript files or their paths, or Cursor's `user_email` field. See [PRIVACY.md](PRIVACY.md) for the complete disclosure.

## How it works

Each host invokes a short-lived Node.js hook process. The shared core:

1. Resolves the plugin's private data directory.
2. Loads the signed-in device credential and cached capture policy, refreshing the policy on any event once its TTL has passed (a failed refresh is retried at most once a minute until the next session start).
3. Resolves the current Git remote locally.
4. Fails closed unless the policy is fresh and the repository is allowlisted.
5. Pulls bounded task context only on host events whose hook contract can inject it.
6. Filters the native hook payload through an event-specific allowlist.
7. Appends the event to the local outbox before attempting delivery.

Turn keys are minted locally and stored one file per vendor turn ID, so concurrent hook processes cannot overwrite one another. Network calls have bounded timeouts. Cursor, Codex, Gemini CLI, and GitHub Copilot CLI use bounded synchronous drains at lifecycle boundaries, and none of them waits on a session-end event; Claude Code uses detached hooks where supported.

The MCP server is the one long-lived process: the host starts it with the plugin and ends it with the plugin. It holds no state of its own, re-reads the saved credential and agent-tools address for every request, and relays each tool call to Trinity as a single bounded HTTPS request.

## Credential storage

Claude Code and Codex provide plugin-specific data directories. Cursor does not, and Gemini CLI and GitHub Copilot CLI do not offer one that their connect scripts can also reach, so Trinity Capture uses the operating system's per-user application-data location, one directory per host (`cursor`, `gemini`, or `copilot`):

| Platform | Credential directory |
| --- | --- |
| macOS | `~/Library/Application Support/Trinity Capture/<host>` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/trinity-capture/<host>` |
| Windows | `%LOCALAPPDATA%\Trinity Capture\<host>` |

On POSIX systems, directories are mode `0700` and credential files are mode `0600`. `TRINITY_CAPTURE_DATA` overrides this location for development.

## Local development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build:plugin
pnpm build:codex
pnpm build:plugin-cursor
pnpm build:gemini
pnpm build:copilot
```

The generated `claude-code/dist`, `codex/dist`, `cursor/dist`, `gemini/dist`, and `copilot/dist` directories are committed because installed plugins execute them directly. CI rebuilds all five and fails if committed output is stale.

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
