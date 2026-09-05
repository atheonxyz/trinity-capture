# Privacy

Trinity Capture is designed to keep unrelated work local.

## Data processed

During pairing and capture uploads, the plugin sends your machine's hostname and its saved device identifier when available. Trinity uses them to name and reconnect the machine. The hostname appears alongside your sessions and is visible to teammates who can view your IDE activity.

For repositories enabled in Trinity, the plugin may send:

- User prompts and assistant responses.
- Coding tool, model, session and turn identifiers, and timestamps.
- Repository-relative working directory, branch, HEAD commit, dirty state, bounded diff statistics, and changed file names.
- Tool names and call identifiers.
- Session lifecycle and completion metadata.

## Data not sent

The plugin does not send:

- Any event from a repository that does not match the locally cached Trinity allowlist.
- The identity of an unmatched repository.
- Absolute filesystem paths.
- Tool input, tool output, shell output, file contents, or reasoning text.
- Environment variables or stored credentials.
- Cursor's `user_email` field.

## Local storage

The plugin stores a revocable device credential, a short-lived repository allowlist, turn correlation keys, delivery status, and a bounded retry outbox in a per-user application-data directory. On POSIX systems, credential directories use mode `0700` and files use mode `0600`.

Queued events expire after seven days. The outbox is capped at 2,000 events or 16 MiB and records local drops in `status.json`.

## Control and deletion

You can revoke a device from Trinity at any time. Revocation immediately prevents future policy and ingest requests. Removing the plugin stops capture. Local plugin data can be removed separately from the operating system's application-data directory documented in [README.md](README.md#credential-storage).

Questions about data handling can be sent to hi@usetrinity.ai.
