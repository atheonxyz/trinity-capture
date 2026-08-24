# Agent instructions

This repository contains Trinity's installable coding-agent capture clients. It is
private today but should remain safe to open-source later: do not add credentials,
customer data, internal infrastructure details, or proprietary dependencies.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build:plugin
```

## Structure

- `src/` owns the shared capture core and Claude Code entrypoints.
- `claude-code/` is the packaged plugin installed by Claude Code.
- `.claude-plugin/marketplace.json` makes the repository installable as a marketplace.
- `test/` covers the capture core, packaging, privacy boundaries, and the env-gated
  live-backend smoke test.

## Invariants

- No daemon: every hook invocation is a short-lived process.
- Never forward local absolute paths or tool call bodies.
- Store an event in the local outbox before attempting network I/O.
- Unmatched repositories never send session events.
- `claude-code/dist/` is committed. Regenerate it after changing `src/`, and keep the
  generated diff in the same commit.
- The marketplace entry and plugin manifest versions must agree.
- Keep production runtime dependencies at zero unless explicitly approved.
