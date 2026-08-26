# Agent instructions

This repository contains Trinity's installable coding-agent capture clients. It is
private today but should remain safe to open-source later: do not add credentials,
customer data, internal infrastructure details, or proprietary dependencies.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build:plugin   # regenerates claude-code/dist/
pnpm build:codex    # regenerates codex/dist/
```

## Structure

- `src/` owns the shared capture core plus one `<product>-hook.ts` (Dialect table +
  hook entrypoint) and, where a product's skill layer can't reach its own data
  directory directly, one `<product>-connect.ts` per product.
- `claude-code/` is the packaged plugin installed by Claude Code;
  `.claude-plugin/marketplace.json` makes the repository installable as a marketplace
  for it.
- `codex/` is the packaged plugin for Codex CLI; `.codex-plugin/marketplace.json` is
  its own equivalent. Each product's marketplace/manifest pair and `tsconfig.*-plugin.json`
  are separate — one product's `dist/` never bundles another's.
- `test/` covers the capture core, per-product packaging (dist execution, marketplace
  listing, uninstall self-containment), per-product connect flows, privacy boundaries,
  and each product's env-gated live-backend smoke test.

## Invariants

- No daemon: every hook invocation is a short-lived process.
- Never forward local absolute paths or tool call bodies, whatever the vendor calls
  them (allowlist per event, never a strip list).
- Store an event in the local outbox before attempting network I/O.
- Unmatched repositories never send session events.
- Every product's `dist/` is committed. Regenerate the relevant one after changing
  `src/`, and keep the generated diff in the same commit; CI diffs both.
- Every product's marketplace entry and plugin manifest versions must agree.
- Keep production runtime dependencies at zero unless explicitly approved.
- A product whose plugin skill/command layer cannot reach its secured data directory
  directly (Codex: skills run without `PLUGIN_DATA`, only hook commands get it) pairs
  through a pending-file → data-directory promotion instead of writing credentials
  straight from the skill; the promoted credential file and the directory holding a
  pending record are always mode 0600 / 0700.
