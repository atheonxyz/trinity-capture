# Trinity capture plugins

The client half of Trinity's IDE session ingestion: a shared TypeScript core plus one
plugin per coding product. Claude Code ships in Phase 1; Codex ships in Phase 3 (this
package); Cursor is designed (see the design doc) but not yet built.

Distribution is internal/sideload only for every plugin here — a local plugin-dir
install or project-level hook config, not a public marketplace listing. Each product's
own plugin directory (`claude-code/`, `codex/`) is self-contained: everything an install
needs lives under it, so removing that one directory leaves nothing dangling elsewhere.

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

## Setup (Codex CLI)

0. Prerequisite: Node >= 20 — `codex-connect.js` checks this itself and errors loudly
   below it. Confirm with `node --version` before installing.
1. Install the `trinity-capture` plugin from this repository's `codex/` directory
   (its own manifest is `codex/.codex-plugin/plugin.json`; the repo root's
   `.codex-plugin/marketplace.json` names it for a marketplace-style add where Codex's
   plugin tooling supports one — see your Codex CLI's own plugin docs for the exact
   install command, since this is an internal/sideload distribution, not a public
   marketplace listing).
2. In any project, run the `trinity-connect` skill with the pairing code shown on your
   Trinity dashboard's IDE integrations page. Codex plugin **skills** run without the
   `PLUGIN_DATA` env var a hook **command** gets (empirically confirmed against
   codex-cli 0.149.0-alpha.4.3 — only hook commands receive it), so the skill cannot
   write this device's credential file directly. Instead it:
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
3. That's it. The plugin captures sessions automatically for every repository one of
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
│   ├── config.ts        DeviceConfig + Policy: load/save from a dialect's dataDir
│   ├── gate.ts           routeFor(): the fail-closed allowlist check
│   ├── outbox.ts         appendEvent()/drain(): local queue, batched send
│   ├── send.ts           sendBatch()/refreshPolicy(): the wire calls, network-bounded
│   ├── observe.ts        gitRemoteOf()/workspaceObserved(): local git metadata
│   ├── hook-core.ts      runHook(): the shared engine every dialect's entry calls
│   ├── claude-hook.ts    the Claude Code Dialect table + its hook entrypoint
│   ├── connect.ts        exchange(): the pairing-code exchange every /trinity-connect shares
│   ├── codex-hook.ts     the Codex Dialect table + its hook entrypoint
│   └── codex-connect.ts  the Codex trinity-connect skill's entrypoint (pending→PLUGIN_DATA)
├── claude-code/
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json     registers the five lifecycle hooks
│   ├── commands/connect.md
│   └── dist/                the COMMITTED build the installed plugin executes
└── codex/
    ├── .codex-plugin/plugin.json
    ├── hooks/hooks.json      registers the six lifecycle hooks (PreToolUse included)
    ├── skills/trinity-connect/SKILL.md
    └── dist/                 the COMMITTED build the installed plugin executes
```

Each product's `dist/` is committed on purpose: an installed plugin runs whatever sits
at `${PLUGIN_ROOT}/dist` (Claude Code: `${CLAUDE_PLUGIN_ROOT}`), with no build step of
its own. `pnpm build:plugin` / `pnpm build:codex` regenerate them from `src/` (plain ESM,
no bundler, no runtime dependencies) — rerun the relevant one and commit the output
whenever `src/` changes. Each `tsconfig.*-plugin.json` lists only the source files that
product's own hooks.json references, so one product's dist never bundles another's —
adding a new dialect's files to `src/` never silently changes an existing dist.
`test/packaging.test.ts` / `test/codex-packaging.test.ts` execute the committed
`claude-hook.js` / `codex-hook.js` directly, so a stale or missing dist fails the suite.

Every hook invocation is a fresh, short-lived process — there is no daemon and nothing
runs between hook events. Each product gets one thin `Dialect` table (vendor field
extraction, its payload allowlist, its data directory, and two predicates —
`isSessionStart`, `drainsOn` — over its own event vocabulary) that `hook-core.ts`'s
`runHook()` drives: it checks the gate, filters the payload to the capture level, appends
it to the local outbox, and, only when `drainsOn(event)` says so, drains the outbox to
the backend. Claude Code's `drainsOn` skips `SessionEnd`, the one hook its own
`hooks.json` runs synchronously, to respect its tight timeout budget; Codex documents
every hook as async-capable, so `codexDialect.drainsOn` returns true unconditionally —
whether a given event drains at all is each dialect's own call, not a shared rule. One
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

Every fetch — batch sends, policy refreshes, `/trinity-connect`'s exchange — carries a
5 second `AbortSignal.timeout`, so a hanging server can never stall a hook indefinitely.
An async-capable product (Claude Code: 4 of its 5 hooks run detached; Codex: every hook
documents async support) sets `drainInline: false` and keeps the open, multi-batch drain
above. A dialect whose hooks run synchronously instead (`drainInline: true`) drains at
most one batch per call, bounded by a 2 second wall-clock budget taken at hook entry —
each fetch it starts is aborted at whatever remains of that budget, and the send is
skipped entirely once the budget is already spent.

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

## Dev commands

```bash
pnpm install
pnpm typecheck      # tsc -b
pnpm test           # run pnpm typecheck first: node --test executes dist-test/
pnpm build:plugin   # regenerate the committed claude-code/dist/ from src/
pnpm build:codex    # regenerate the committed codex/dist/ from src/
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

`test/e2e-codex.test.ts` is the same idea for Codex, gated on the same five
`TRINITY_E2E_*` env vars and seed step above, but pairs a `tool: "codex"` device and
replays `test/testdata/codex_session.jsonl` through the REAL `codexDialect` +
`hook-core.ts`'s `runHook()` rather than a hand-built envelope — that fixture is
raw-hook-shaped (the vendor's own field names, not a pre-built `CaptureEvent`), so
there's no envelope to hand `appendEvent()` directly the way the Claude Code smoke does.
It expects a project that has selected `github.com/acme/codex-fixture` (matching the
Trinity repo's own `codex_test.go` fixture naming) and a backend built from a checkout
carrying the codex decoder — until PR T2 merges to Trinity's `main`, that means starting
the backend from `.worktrees/ide-codex` in step 1 above instead.
