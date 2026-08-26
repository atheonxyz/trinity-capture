# Trinity capture plugins

The client half of Trinity's IDE session ingestion: a shared TypeScript core plus one
plugin per coding product. Claude Code ships in Phase 1; Codex and Cursor ship in
Phase 3. Distribution is internal/sideload only for every plugin here, not a public
marketplace listing. Each product's own plugin directory (`claude-code/`, `codex/`,
`cursor/`) is self-contained, so removing it leaves nothing dangling elsewhere.

## Setup (Claude Code)

Requires Node 20 or newer. Check with `node --version` before installing.

1. Install the `trinity-capture` plugin with
   `/plugin marketplace add https://github.com/atheonxyz/trinity-capture.git` (the
   repository's `.claude-plugin/marketplace.json` names the plugin), then
   `/plugin install trinity@trinity`.
2. In any project, run `/trinity:connect <code>` with the pairing code
   shown on your Trinity dashboard's IDE integrations page.
   This exchanges the code for a device token and writes it to the plugin's own data
   directory — never into the repo, never into shell history.
3. That's it. The plugin captures sessions automatically for every repository in its
   local allowlist. Unmatched repositories make no requests. Run
   `/trinity:connect`
   again without a code to refresh policy for newly selected repositories.

`TRINITY_BASE_URL` overrides the dashboard origin
`/trinity:connect` exchanges the pairing code against, for pointing a
local build at a non-production backend.

## Setup (Cursor)

Phase 3 ships Cursor **internal/sideload only**: Cursor's official Marketplace requires
submitted plugins to be open source and human-reviewed, which conflicts with this
private repo. Publishing there is a separate, later release decision.

0. Prerequisite: Node >= 20 (`cursor-connect.js` checks this itself and errors loudly
   below it). Confirm with `node --version`.
1. Install the plugin from a local checkout of this repo (Cursor loads either plugin
   format from `~/.cursor/plugins/local`): symlink or copy this repository's `cursor/`
   directory in, e.g. `ln -s $(pwd)/cursor ~/.cursor/plugins/local/trinity-capture`. A
   team marketplace import (Dashboard → Plugins → Import from Repo, for admins) against
   this repository's `.cursor-plugin/marketplace.json` also works once the repo is
   reachable to the importing account.
2. Connect this device from a terminal — Cursor's plugin commands have no proven
   equivalent of Claude Code's `!command` shell execution, so this ships as a plain CLI
   script rather than a speculative slash command:
   `node ~/.cursor/plugins/local/trinity-capture/dist/cursor-connect.js <code>` with the
   pairing code shown on your Trinity dashboard's IDE integrations page. This writes a
   mode-0600 `DeviceConfig`, syncs the repository allowlist, and reports success only
   when both are ready under a mode-0700 directory — never into the repo, never into
   shell history, and never into a Cursor plugin variable (those are dashboard-entered
   and would replace this pairing UX).
3. That's it. The plugin captures `cursor-agent` CLI sessions automatically for every
   repository one of your projects has selected, the same allowlist and fail-closed rules
   as Claude Code below, plus one Cursor-specific rule: an event whose `workspace_roots`
   names more than one repository is dropped whole rather than guessed (see Multi-root
   fail-closed below).

`TRINITY_CAPTURE_DATA` overrides where credentials/policy/outbox live (default: the
platform's secured per-user application-data directory — see Credential home below).
`TRINITY_BASE_URL` behaves exactly as it does for Claude Code.
## Setup (Codex CLI)

0. Prerequisite: Node >= 20 — `codex-connect.js` checks this itself and errors loudly
   below it. Confirm with `node --version` before installing.
1. Install the `trinity-capture` plugin from this repository's `codex/` directory
   (its own manifest is `codex/.codex-plugin/plugin.json`; the repo root's
   `.agents/plugins/marketplace.json` names it for a marketplace-style add where Codex's
   plugin tooling supports one — see your Codex CLI's own plugin docs for the exact
   install command, since this is an internal/sideload distribution, not a public
   marketplace listing). Start a new Codex session and approve the six Trinity hooks
   once; Codex deliberately skips newly installed hooks until you trust them.
2. In any project, run the `trinity-connect` skill with the pairing code shown on your
   Trinity dashboard's IDE integrations page. Codex plugin **skills** run without the
   plugin root or `PLUGIN_DATA` env vars a hook **command** gets, and its exchange needs
   network plus access to `~/.codex`. It therefore resolves its installed path with
   `codex plugin list --json` and asks to run the exchange outside the sandbox. Then it:
   - exchanges the pairing code and writes the result to a mode-0600 pending record
     under `$CODEX_HOME/trinity-capture/pending-device.json` (`$CODEX_HOME` defaults to
     `~/.codex`);
   - the very next `PostToolUse` hook — a hook command, which does get `PLUGIN_DATA` —
     atomically promotes that pending record into `PLUGIN_DATA/config.json` and removes
     it;
   - the skill then re-checks status (a second, separate command) and reports success
     only once the pending record is gone, i.e. once a trusted hook invocation actually
     promoted it. If hooks are disabled or untrusted for a session, the pending record
     stays put — still secured — until a later trusted invocation promotes it; running
     any Codex tool call and re-checking status confirms this.
3. Start a new Codex session. Its SessionStart hook fetches the allowlist, then the
   plugin captures sessions automatically for every repository one of
   your projects has selected, the same fail-closed rules as Claude Code's setup above.

`TRINITY_BASE_URL` and `CODEX_HOME` both override their defaults the same way as
elsewhere in this document.

### Fallback: manual hook configuration

If a given Codex build's plugin layer proves too immature to install through (spec
§4.6), the hook script still works wired up by hand:

1. Add a `codex-hook` stanza to `~/.codex/hooks.json` invoking
   `node <path-to-this-repo>/codex/dist/codex-hook.js <EventName>` for each of
   `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`
   (see `codex/hooks/hooks.json` for the exact shape to copy, substituting a literal
   path for `${PLUGIN_ROOT}`).
2. Set `TRINITY_CAPTURE_DATA` to a directory you own (mode 0700) in the environment
   Codex CLI runs with — the dialect checks this override before `PLUGIN_DATA`
   (`codex-hook.ts`'s `dataDir`), since a manually-configured hook has no plugin
   framework to supply `PLUGIN_DATA` at all.
3. Run `TRINITY_CAPTURE_DATA=<that dir> node codex/dist/codex-connect.js <code>` once to
   pair the device directly — with `TRINITY_CAPTURE_DATA` set, this fallback still
   writes the pending record under `$CODEX_HOME/trinity-capture/`, but you can also just
   pre-seed `<that dir>/config.json` with `{"token","ingestUrl","deviceId"}` from the
   dashboard's raw device credentials if you'd rather skip the pairing exchange
entirely.

## Architecture

```
trinity-capture/
├── src/
│   ├── config.ts         DeviceConfig + Policy: load/save from a dialect's dataDir
│   ├── gate.ts           routeFor(): the fail-closed allowlist check
│   ├── outbox.ts         appendEvent()/drain(): local queue, batched send
│   ├── send.ts           sendBatch()/refreshPolicy(): the wire calls, network-bounded
│   ├── observe.ts        gitRemoteOf()/workspaceObserved(): local git metadata
│   ├── hook-core.ts      runHook(): the shared engine every dialect's entry calls
│   ├── claude-hook.ts    the Claude Code Dialect table + its hook entrypoint
│   ├── connect.ts        exchange(): the shared pairing-code exchange
│   ├── codex-hook.ts     the Codex Dialect table + its hook entrypoint
│   ├── codex-connect.ts  Codex's pending→PLUGIN_DATA pairing entrypoint
│   ├── cursor-hook.ts    the Cursor Dialect table + multi-root fail-closed entrypoint
│   └── cursor-connect.ts the manual Cursor pairing entrypoint
├── claude-code/
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json     registers the five lifecycle hooks
│   ├── commands/connect.md
│   └── dist/                the COMMITTED build the installed plugin executes
├── codex/
│   ├── .codex-plugin/plugin.json
│   ├── hooks/hooks.json      registers the six lifecycle hooks
│   ├── skills/trinity-connect/SKILL.md
│   └── dist/                 the COMMITTED build the installed plugin executes
├── cursor/
│   ├── .cursor-plugin/plugin.json    names hooks/hooks.json
│   ├── hooks/hooks.json               registers the eight observed hook kinds
│   └── dist/                          the COMMITTED build the installed plugin executes
├── .agents/plugins/marketplace.json   Codex marketplace manifest
└── .cursor-plugin/marketplace.json    Cursor marketplace manifest
```

Each product's `dist/` is committed on purpose: an installed plugin runs whatever sits
at `${PLUGIN_ROOT}/dist` (Claude Code: `${CLAUDE_PLUGIN_ROOT}`), with no build step of
its own. `pnpm build:plugin`, `pnpm build:codex`, and `pnpm build:plugin-cursor`
regenerate them from `src/` (plain ESM, no bundler, no runtime dependencies). Each
`tsconfig.*-plugin.json` lists only the source files its product references, so adding
one dialect never silently changes another product's dist. The packaging tests execute
the committed binaries directly, so a stale or missing build fails the suite.

Every hook invocation is a fresh, short-lived process — there is no daemon and nothing
runs between hook events. Each product gets one thin `Dialect` table (vendor field
extraction, its payload allowlist, its data directory, and two predicates —
`isSessionStart`, `drainsOn` — over its own event vocabulary) that `hook-core.ts`'s
`runHook()` drives: it checks the gate, filters the payload to the capture level, appends
it to the local outbox, and, only when `drainsOn(event)` says so, drains the outbox to
the backend. Claude Code runs its ordinary hooks asynchronously. Codex and Cursor do not
support async command hooks, so their handlers stay synchronous and use network only at
their lifecycle drain points, under the inline budget below. Whether a given event drains
at all is each dialect's own call, not a shared rule. One
synthesized event, `workspace.observed`, supplements the native ones at whatever event
`isSessionStart` names for that dialect: bounded, deterministic git metadata (branch,
HEAD SHA, dirty flag, diffstat, changed files) that the server can never read directly.

Turn identity is plugin-minted, correlated by the vendor's own turn id rather than
arrival order: the first turn-scoped event carrying an unseen vendor turn id (preferably
`UserPromptSubmit`, but any later one if the vendor's own dialect never emits a
prompt-submit hook) mints a fresh uuid into its own write-once file under
`turnkeys/<tool>-<session>/<vendorTurnId>` — never a shared per-session map, so two
racing hook processes can never lose an update to each other. Every other event carrying
that same vendor turn id resolves the same file, whatever order they arrive in. Events a
dialect reports no vendor turn id for (inherently order-ambiguous) fall back to a
separate `latest` file instead (`SessionStart` and `workspace.observed` carry no turn key
at all). The server treats the key as an untrusted hint and falls back to
open-turn-by-ordinal when it is absent.

## Network bounds

Every fetch — batch sends, policy refreshes, and pairing-code exchange — carries a
5 second `AbortSignal.timeout`, so a hanging server can never stall a hook indefinitely.
Claude Code's detached hooks keep the open, multi-batch drain. Codex and Cursor hooks
run synchronously, set `drainInline: true`, and drain at most one batch per call under a
2 second wall-clock budget. Codex drains on `Stop` and `SessionEnd`; Cursor drains on
`afterAgentResponse` and `sessionEnd`. Mid-turn tool/file hooks append locally and return.

## Capture levels

Phase 1 supports exactly one capture level, `metadata`, for every project:

- Prompts (`prompt`) and assistant responses (`last_assistant_message`) are sent in
  full — they're the session's substance.
- Everything else rides an ALLOWLIST, never a strip list: per event, only known-safe
  keys observed on a real captured hook stream are forwarded (`tool_name`,
  `tool_use_id`, `duration_ms`, session/timing ids). Tool call bodies never travel,
  whatever the vendor calls them today or tomorrow (`tool_input`, `tool_response`, the
  older `tool_output`) — and neither does any field the allowlist has not heard of,
  which is what keeps reasoning/thinking-named fields out by construction.

A `full-bodies` level (bounded, redacted tool call bodies, opt-in per project) is a
designed extension, not implemented yet.

## Credential home (Cursor)

Claude Code and Codex both receive a plugin-scoped writable directory from the host
(`CLAUDE_PLUGIN_DATA`, and Codex's `PLUGIN_DATA` for its own hook commands). Cursor's
docs and its captured hook stream expose no equivalent: a hook command only ever
receives `CURSOR_PLUGIN_ROOT` (the plugin's own read-only install directory) and a
handful of session-scoped variables, never a writable per-plugin data path. Credentials
therefore live in the secured per-user application-data location a desktop app would
use instead, resolved by `cursorDialect.dataDir` in `src/cursor-hook.ts`:

| Platform | Directory |
| --- | --- |
| Override (any platform) | `$TRINITY_CAPTURE_DATA` |
| macOS | `~/Library/Application Support/Trinity Capture/cursor` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/trinity-capture/cursor` |
| Windows | `%LOCALAPPDATA%\Trinity Capture\cursor` |

`cursor-connect.js` creates this directory at mode `0700` and writes `config.json` at
mode `0600` (Windows relies on `%LOCALAPPDATA%` already being scoped to the current user
by ACLs; POSIX `chmod` has no meaning there and is skipped). Cursor plugin *variables*
(the `variables` field in `plugin.json`) are deliberately not used for this: they are
dashboard-entered and would replace the pairing flow above with a manual paste of a
long-lived token.

## Multi-root fail-closed (Cursor)

Every captured Cursor hook event carries `workspace_roots`, an array, rather than the
single `cwd` string Claude Code's and Codex's hooks carry. The captured MVP dialect only
ever observed a single entry, and no field in it says which of several roots a
multi-root event would be about — so `cursor-hook.ts`'s entrypoint drops any event whose
`workspace_roots` does not contain exactly one non-empty repository root, before it ever reaches the
gate or the outbox, and records the drop in `status.json` (`reason: "multi_root"`) for a
paired device. Guessing (the first entry, or falling back to the process's own cwd)
would risk silently attributing a session to the wrong repository, which this design
treats as strictly worse than dropping the event. Multi-root workspace support is a
later, ledgered extension.

## Fail-closed guarantees

- **No config, no send.** A device that was never paired (`loadConfig` returns `null`)
  makes zero network requests, for any hook, ever.
- **No policy, no send.** A missing or expired (15-minute TTL) capture-policy document
  fails every gate check closed — not just for a specific repo, for everything.
- **Unmatched repo, no request.** A git remote that doesn't normalize to an allowlisted
  `canonicalRepo` or one of its aliases never queues a session event or contacts
  Trinity from that hook. `/trinity:connect` without a code refreshes policy for an
  already-paired device.
- **Absolute paths never leave the machine.** The raw hook payload's `cwd` and
  `transcript_path` are always stripped before send; only the repo-relative cwd travels.
- **The outbox survives failure.** Every event is written to disk before any network
  I/O. A request-level failure (network error, 401/403/429/5xx) retains the entire
  outbox for retry; only a definitive per-item outcome (`stored`, `duplicate`, or
  `rejected_permanent`) deletes an event.
- **The outbox cannot wedge.** An event over 256 KiB serialized (the server's per-item
  cap) is dropped at append. Batches are assembled under a ~3 MiB byte budget as well
  as the 100-event cap, so a 413 means a genuinely poisoned batch — it is bisected
  until the poisoned event stands alone, and that one event is dropped. The outbox
  evicts its oldest events beyond 16 MiB or 2,000 items, and events retried for over
  7 days are dropped too. Every such drop is recorded in the plugin
  data dir's `status.json` (most recent 100), never silently. A `policy_stale` item
  outcome triggers one immediate policy refresh so the next drain retries against a
  current document.
- **Every hook path exits 0.** Nothing the plugin does — a malformed payload, a network
  failure, a bug — is allowed to surface as an error in the IDE.
- **A multi-root Cursor event captures nothing.** See Multi-root fail-closed above.

## Dev commands

```bash
pnpm install
pnpm typecheck             # tsc -b
pnpm test                  # run pnpm typecheck first: node --test executes dist-test/
pnpm build:plugin          # regenerate the committed claude-code/dist/ from src/
pnpm build:codex           # regenerate the committed codex/dist/ from src/
pnpm build:plugin-cursor   # regenerate the committed cursor/dist/ from src/
```

No runtime dependencies: Node stdlib only (`fs`, `crypto`, `child_process`, the
built-in `fetch`). `typescript`/`@types/node` are the only dev dependencies.

### e2e smoke

`test/e2e.test.ts` is skipped unless `TRINITY_E2E_URL` is set. The backend has no
OAuth-free login, so pairing a device end-to-end also needs a live person session and a
project that has already selected the fixture's repository
(`github.com/acme/claude-code-fixture`) — there is no way to get one through the plugin
alone, so a one-off seed step provides it:

```bash
# 1. Start a real backend against a dedicated database (never a shared one):
cd backend
MCP_API_KEY=... SANDBOX_API_TOKEN=... \
GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... GOOGLE_OAUTH_STATE_SECRET=... \
GITHUB_OAUTH_CLIENT_ID=... GITHUB_OAUTH_CLIENT_SECRET=... \
POSTGRES_URL="postgres://<role>@127.0.0.1:5433/<dedicated-db>?sslmode=disable" \
go run ./cmd/server

# 2. Seed an org/user/project/member + the selected fixture repo, and mint a session
#    token (a scratch, uncommitted Go program — see the Task 7.3 report for the source):
POSTGRES_URL="postgres://<role>@127.0.0.1:5433/<dedicated-db>?sslmode=disable" \
go run ./cmd/e2eseed
# → {"orgId":"...","projectId":"...","userId":"...","sessionToken":"...", ...}

# 3. Run the smoke from the repository root:
TRINITY_E2E_URL=http://localhost:3000 \
TRINITY_E2E_SESSION_TOKEN=<sessionToken> \
TRINITY_E2E_PROJECT_ID=<projectId> \
TRINITY_E2E_USER_ID=<userId> \
TRINITY_E2E_POSTGRES_URL="postgres://<role>@127.0.0.1:5433/<dedicated-db>?sslmode=disable" \
pnpm test
```

The smoke pairs a device (`POST /devices/code` then `connect.ts`'s real `exchange()`),
fetches the capture policy through `send.ts`'s real `refreshPolicy()`, replays the
`claude_code_session.jsonl` fixture (bundled under `test/testdata/`, byte-identical to
the backend's Task 5.1 adapter fixture) through the real `outbox.ts`/`send.ts` path, and
polls the dashboard's sessions endpoint for the projected result.

`test/e2e-cursor.test.ts` is Cursor's twin, gated on the same five `TRINITY_E2E_*`
variables and skipped the same way. It pairs a `tool: "cursor"` device through
`cursor-connect.ts`'s real `connectCursor()`, then replays the **raw** captured
`cursor_session.jsonl` stream (unlike `claude_code_session.jsonl`, this fixture is the
raw hook envelope, not wire-shaped — see the field-mapping table below) through
`cursor-hook.ts`'s real `runCursorHook()`, which is the dialect and `hook-core.ts`
together — the same pipeline a real Cursor install runs, not just the wire layer. It
reuses the same seeded project/repo as the Claude Code smoke above; a
`cursor-fixture`-specific seed is a possible backend-side follow-up, not required for
this to pass.

### Cursor dialect field mapping

Pinned against the empirically captured `cursor-agent 2026.08.11-e8db854` CLI hook
stream (`test/testdata/cursor_session.jsonl`, SHA-256
`494d36e51c4c2fb8f76691089f0ef611432ec76c7767fcd04b5d4588a8e435ac`) and against the
backend's own decoder of that same raw fixture
(`trinity/backend/internal/store/coding/cursor.go`'s `projectCursor` +
`cursor_test.go`'s `loadCursorFixture`) — this table is the contract between the two;
`test/cursor-hook.test.ts`'s "full captured fixture" test is the executable proof on
this side.

| `hook_event_name` | Registered hook | Backend applier | Forwarded fields | Notes |
| --- | --- | --- | --- | --- |
| `sessionStart` | yes | `applySessionStart` | `hook_event_name`, `conversation_id`, `generation_id`, `model` | `sessionId` = `conversation_id`; `vendorTurnId` = null (session-scoped, despite carrying `generation_id`) |
| `beforeSubmitPrompt` | yes | `applyPromptSubmitted` | `hook_event_name`, `conversation_id`, `generation_id`, `prompt` | preferred turn-key mint point; the fixture's first turn has none — `preToolUse` (its first turn-scoped event) mints instead (lazy mint) |
| `preToolUse` | yes | quarantine | `hook_event_name`, `conversation_id`, `generation_id` | genuinely captured, never forwards `tool_input` |
| `beforeReadFile` | yes | quarantine | `hook_event_name`, `conversation_id`, `generation_id` | genuinely captured, never forwards `content` or `file_path` |
| `postToolUse` | yes | `applyToolUsed` | `hook_event_name`, `conversation_id`, `generation_id`, `tool_name`, `tool_use_id` | never forwards `tool_input`/`tool_output` |
| `afterAgentResponse` | yes (drains) | `applyTurnStopped` | `hook_event_name`, `conversation_id`, `generation_id`, `text` | this dialect's Stop-equivalent — the sibling `stop` event carries no text |
| `stop` | yes | quarantine | `hook_event_name`, `conversation_id`, `generation_id` | carries `status`/`loop_count`/token counts, never forwarded |
| `sessionEnd` | yes (drains) | `applySessionEnded` | `hook_event_name`, `conversation_id`, `generation_id`, `reason` | `vendorTurnId` = null (session-scoped) |

`workspace_roots` and `user_email` are never forwarded on any kind (an absolute local
path and PII respectively); `afterAgentThought` is never even hooked, so its reasoning
text can never reach the allowlist in the first place.

`test/e2e-codex.test.ts` is the same idea for Codex, gated on the same five
`TRINITY_E2E_*` env vars and seed step above, but pairs a `tool: "codex"` device and
replays `test/testdata/codex_session.jsonl` through the REAL `codexDialect` +
`hook-core.ts`'s `runHook()` rather than a hand-built envelope — that fixture is
raw-hook-shaped (the vendor's own field names, not a pre-built `CaptureEvent`), so
there's no envelope to hand `appendEvent()` directly the way the Claude Code smoke does.
It expects a project that has selected `github.com/acme/codex-fixture` (matching the
Trinity repo's own `codex_test.go` fixture naming) and a backend build carrying the Codex
decoder.
