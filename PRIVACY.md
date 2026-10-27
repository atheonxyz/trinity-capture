# Privacy

Trinity Capture is designed to keep unrelated work local.

## Data processed

During pairing, the plugin sends your machine's hostname and a Trinity-specific machine identity. The identity is an HMAC-SHA256 digest derived locally from the operating system's machine identifier. The raw OS identifier is never sent, logged, stored, or written to plugin configuration. Capture uploads use the saved Trinity device credential returned by pairing and do not recompute or resend the OS machine identity. Every request made with that credential also names the plugin's version, as its manifest states it, so Trinity can tell when the machine should update.

This identity follows the OS installation, not guaranteed physical hardware. Reinstalling the OS, resetting a VM, or regenerating `/etc/machine-id` can create a new identity on the same hardware. Cloned disks or VM images can share one until they are regenerated. Trinity uses it for pairing continuity and device deduplication; it is not hardware attestation or fraud protection.

For repositories enabled in Trinity, the plugin may send:

- User prompts and assistant responses. GitHub Copilot CLI's hooks carry no assistant response, only the path of a local transcript file, so for Copilot CLI the plugin sends prompts alone and never reads that file or sends its path.
- Coding tool, model, session and turn identifiers, and timestamps.
- Repository-relative working directory, branch, HEAD commit, dirty state, bounded diff statistics, and changed file names.
- Tool names and, where the host supplies them, call identifiers. Gemini CLI and GitHub Copilot CLI supply none.
- Session lifecycle and completion metadata.
- A bounded read-only request for the tasks the session likely relates to. Claude Code, Codex, and Gemini CLI send the repository, branch, and first prompt when the branch alone names nothing; Cursor and GitHub Copilot CLI send the repository and branch at session start because their prompt hooks cannot inject context. These fields are already covered above. The response can contain task identity, status, priority, due and milestone signals, recent task activity, and open resolutions from the person's Trinity workspace. It can also carry a task the person sent to this machine from Trinity, with its brief and their note; the plugin receives that handoff and sends back only the server's own identifier for it, to say it was shown. It is shown to the coding agent as context and stored nowhere.

Through the bundled MCP server, the plugin also sends the Trinity tool calls the coding agent chooses to make: the tool name and the arguments the agent supplies, together with the device credential, to the paired Trinity server only. For a read tool the arguments are a task code or a search phrase. For a write tool they are what the agent wrote: a task code, a progress line, a question, a pull request number, or a proposed task's title and description. A write acts as the paired person inside their projects, and Trinity stores what it records. Each answer is workspace data shown to the coding agent and stored nowhere on the device.

## Data not sent

The plugin does not send:

- Any event from a repository that does not match the locally cached Trinity allowlist.
- The identity of an unmatched repository.
- Absolute filesystem paths.
- Tool input, tool output, shell output, file contents, or reasoning text.
- Environment variables or stored credentials.
- Cursor's `user_email` field.
- Session transcript files or their paths, which Gemini CLI and GitHub Copilot CLI hand to every hook.
- The raw macOS platform UUID, Windows MachineGuid, or Linux `/etc/machine-id`.
- Anything from the session through the MCP server: it relays only the tool calls the coding agent makes, never prompts, file contents, paths, or other tool bodies.

## Local storage

The plugin stores a revocable device credential, a short-lived repository allowlist, turn correlation keys, delivery status, and a bounded retry outbox in a per-user application-data directory. On POSIX systems, credential directories use mode `0700` and files use mode `0600`.

Queued events expire after seven days. The outbox is capped at 2,000 events or 16 MiB and records local drops in `status.json`.

Re-pairing moves the previous connection's queued events and session tracking into a local `retired/` directory. They are kept on disk but are no longer uploaded. Capture resumes in a new session; the machine's history already stored in Trinity remains available.

## Control and deletion

You can revoke a device from Trinity at any time. Revocation immediately prevents future policy and ingest requests and refuses the device's agent-tool calls. Removing the plugin stops capture and the tools. Local plugin data can be removed separately from the operating system's application-data directory documented in [README.md](README.md#credential-storage).

Questions about data handling can be sent to hi@usetrinity.ai.
