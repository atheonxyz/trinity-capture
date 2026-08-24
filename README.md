# capture

The client half of Trinity's IDE session ingestion: a shared TypeScript core plus one
plugin per coding product. Claude Code ships in Phase 1; Codex and Cursor are designed
(see the design doc) but not yet built.

## Setup (Claude Code)

1. Install the `trinity-capture` plugin: `/plugin marketplace add <this repo>` (the
   repo-root `.claude-plugin/marketplace.json` names the plugin), then
   `/plugin install trinity-capture@trinity`.
2. In any project, run `/trinity-connect <code>` with the pairing code shown on your
   Trinity dashboard's IDE integrations page (e.g. `/trinity-connect ABCD1234EFGH`).
   This exchanges the code for a device token and writes it to the plugin's own data
   directory — never into the repo, never into shell history.
3. That's it. The plugin captures sessions automatically for every repository one of
   your projects has selected; everything else produces zero network traffic (see
   **Fail-closed guarantees** below).

`TRINITY_BASE_URL` overrides the dashboard origin `/trinity-connect` exchanges the
pairing code against, for pointing a local build at a non-production backend.

## Architecture

```
capture/
├── src/
│   ├── config.ts      DeviceConfig + Policy: load/save from CLAUDE_PLUGIN_DATA
│   ├── gate.ts         routeFor(): the fail-closed allowlist check
│   ├── outbox.ts        appendEvent()/drain(): local queue, batched send
│   ├── send.ts          sendBatch()/refreshPolicy(): the wire calls
│   ├── observe.ts       gitRemoteOf()/workspaceObserved(): local git metadata
│   ├── claude-hook.ts    the plugin entry every Claude Code hook invokes
│   └── connect.ts        the /trinity-connect command
└── claude-code/
    ├── .claude-plugin/plugin.json
    ├── hooks/hooks.json     registers the five lifecycle hooks
    ├── commands/trinity-connect.md
    └── dist/                the COMMITTED build the installed plugin executes
```

`claude-code/dist/` is committed on purpose: an installed plugin runs whatever sits at
`${CLAUDE_PLUGIN_ROOT}/dist`, with no build step of its own. `pnpm build:plugin`
regenerates it from `src/` (plain ESM, no bundler, no runtime dependencies) — rerun it
and commit the output whenever `src/` changes. `test/packaging.test.ts` executes the
committed `claude-hook.js` directly, so a stale or missing dist fails the suite.

Every hook invocation is a fresh, short-lived process — there is no daemon and nothing
runs between hook events. `claude-hook.ts` reads the hook's stdin JSON, checks the gate,
filters the payload to the capture level, appends it to the local outbox, and (except on
`SessionEnd`, which stays append-only and synchronous to respect its tight timeout
budget) drains the outbox to the backend. One synthesized event, `workspace.observed`,
supplements the native ones at `SessionStart`: bounded, deterministic git metadata
(branch, HEAD SHA, dirty flag, diffstat, changed files) that the server can never read
directly.

Turn identity is plugin-minted: every `UserPromptSubmit` mints a fresh uuid, persisted
per session under the plugin data dir (`turnkeys/`), and every later event of that
session carries it as the envelope's `turnKey` until the next prompt replaces it
(`SessionStart` and `workspace.observed` carry none). The server treats it as an
untrusted hint and falls back to open-turn-by-ordinal when it is absent.

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

## Fail-closed guarantees

- **No config, no send.** A device that was never paired (`loadConfig` returns `null`)
  makes zero network requests, for any hook, ever.
- **No policy, no send.** A missing or expired (15-minute TTL) capture-policy document
  fails every gate check closed — not just for a specific repo, for everything.
- **Unmatched repo, no send.** A git remote that doesn't normalize to an allowlisted
  `canonicalRepo` or one of its aliases produces zero network requests for that
  workspace — not even identity. This is what makes a personal or unrelated repository
  safe to open with the plugin installed.
- **Absolute paths never leave the machine.** The raw hook payload's `cwd` and
  `transcript_path` are always stripped before send; only the repo-relative cwd travels.
- **The outbox survives failure.** Every event is written to disk before any network
  I/O. A request-level failure (network error, 401/403/429/5xx) retains the entire
  outbox for retry; only a definitive per-item outcome (`stored`, `duplicate`, or
  `rejected_permanent`) deletes an event.
- **The outbox cannot wedge.** An event over 256 KiB serialized (the server's per-item
  cap) is dropped at append. Batches are assembled under a ~3 MiB byte budget as well
  as the 100-event cap, so a 413 means a genuinely poisoned batch — it is bisected
  until the poisoned event stands alone, and that one event is dropped. Events
  retried for over 7 days are dropped too. Every such drop is recorded in the plugin
  data dir's `status.json` (most recent 100), never silently. A `policy_stale` item
  outcome triggers one immediate policy refresh so the next drain retries against a
  current document.
- **Every hook path exits 0.** Nothing the plugin does — a malformed payload, a network
  failure, a bug — is allowed to surface as an error in the IDE.

## Dev commands

```bash
cd capture
pnpm install
pnpm typecheck      # tsc -b
pnpm test           # run pnpm typecheck first: node --test executes dist-test/
pnpm build:plugin   # regenerate the committed claude-code/dist/ from src/
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

# 3. Run the smoke from capture/:
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
