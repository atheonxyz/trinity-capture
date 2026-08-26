# Contributing

Contributions are welcome.

## Development

1. Install Node.js 20 or newer and pnpm 9.
2. Run `pnpm install`.
3. Add or update tests before changing behavior.
4. Run `pnpm typecheck` and `pnpm test`.
5. Rebuild every affected committed plugin distribution.

Keep the capture boundary conservative:

- Add fields to an event allowlist only when the backend consumes them and their privacy impact is understood.
- Unmatched repositories must remain completely silent.
- Store events locally before attempting network delivery.
- Do not add runtime dependencies without discussing the tradeoff first.
- Keep `AGENTS.md` and `CLAUDE.md` identical.

Pull requests should explain the user-visible behavior, privacy impact, and verification performed.
