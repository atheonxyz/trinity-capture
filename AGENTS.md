# Agent instructions

This repository contains Trinity's installable coding-agent capture clients. It is
private today but should remain safe to open-source later: do not add credentials,
customer data, internal infrastructure details, or proprietary dependencies.

`AGENTS.md` and `CLAUDE.md` are byte-identical copies of this file. Edit one, copy it
over the other.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build:plugin          # regenerate claude-code/dist/
pnpm build:plugin-cursor   # regenerate cursor/dist/
```

## Structure

- `src/` owns the shared capture core plus every product's own entrypoint
  (`claude-hook.ts`/`connect.ts` for Claude Code, `cursor-hook.ts`/`cursor-connect.ts`
  for Cursor).
- `claude-code/` is the packaged plugin installed by Claude Code.
- `cursor/` is the packaged plugin sideloaded/installed by Cursor.
- `.claude-plugin/marketplace.json` and `.cursor-plugin/marketplace.json` make the
  repository installable as a marketplace for each product respectively — two separate
  manifests, one per IDE's own plugin ecosystem.
- `test/` covers the capture core, packaging, privacy boundaries, and the env-gated
  live-backend smoke tests (`e2e.test.ts` for Claude Code, `e2e-cursor.test.ts` for
  Cursor).

## Invariants

- No daemon: every hook invocation is a short-lived process.
- Never forward local absolute paths, tool call bodies, or PII (Cursor's captured
  stream also carries `user_email` — never forwarded).
- Store an event in the local outbox before attempting network I/O.
- Unmatched repositories never send session events.
- `claude-code/dist/` and `cursor/dist/` are committed. Regenerate the relevant one
  after changing `src/`, and keep the generated diff in the same commit.
- Each product's marketplace entry and its own plugin manifest versions must agree.
- Keep production runtime dependencies at zero unless explicitly approved.
- A Cursor event whose `workspace_roots` names more than one repository is dropped
  whole (never guessed at) — see README's Multi-root fail-closed section.
- Cursor has no `CLAUDE_PLUGIN_DATA`/`PLUGIN_DATA` equivalent: credentials live in the
  platform's secured per-user application-data directory (`TRINITY_CAPTURE_DATA`
  overridable), created 0700 with the credential file 0600 — see README's Credential
  home section.
