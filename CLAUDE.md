# Agent instructions

This public repository contains Trinity's installable coding-agent capture clients.
Do not add credentials, customer data, internal infrastructure details, or proprietary
dependencies.

`AGENTS.md` and `CLAUDE.md` are byte-identical copies of this file. Edit one, copy it
over the other.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build:plugin          # regenerate claude-code/dist/
pnpm build:codex           # regenerate codex/dist/
pnpm build:plugin-cursor   # regenerate cursor/dist/
```

## Structure

- `src/` owns the shared capture core plus one `<product>-hook.ts` (Dialect table +
  hook entrypoint) and, where a product's skill layer can't reach its own data
  directory directly, one `<product>-connect.ts` per product.
- `claude-code/`, `codex/`, and `cursor/` are the three self-contained packaged plugins.
  Their marketplace manifests are separate because each host has its own plugin ecosystem.
- `test/` covers the capture core, per-product packaging (dist execution, marketplace
  listing, uninstall self-containment), per-product connect flows, privacy boundaries,
  and each product's env-gated live-backend smoke test.

## Invariants

- No daemon: every hook invocation is a short-lived process.
- Never forward local absolute paths, tool call bodies, or PII (Cursor's captured
  stream also carries `user_email`, which is never forwarded). Use an allowlist per
  event, never a strip list.
- Store an event in the local outbox before attempting network I/O.
- Unmatched repositories never send session events.
- Every product's `dist/` is committed. Regenerate the relevant one after changing
  `src/`, and keep the generated diff in the same commit; CI diffs all three.
- Every product's marketplace entry and plugin manifest versions must agree.
- Keep production runtime dependencies at zero unless explicitly approved.
- A product whose plugin skill/command layer cannot reach its secured data directory
  directly (Codex: skills run without `PLUGIN_DATA`, only hook commands get it) pairs
  through a pending-file → data-directory promotion instead of writing credentials
  straight from the skill; the promoted credential file and the directory holding a
  pending record are always mode 0600 / 0700.
- Cursor events whose `workspace_roots` name anything other than one repository are
  dropped whole, never guessed at. Cursor credentials live in the platform's secured
  per-user application-data directory because the host supplies no plugin data path.
