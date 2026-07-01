# Contributing

Thanks for helping out. ccblame is a small, zero-runtime-dependency TypeScript CLI.

## Setup

```bash
bun install
bun run dev        # run against your own ~/.claude
```

## Before opening a PR

```bash
bun test
bun run lint
bun run typecheck
bun run build
```

All four must pass — CI runs the same.

## Ground rules

- Keep `dependencies` in `package.json` empty. UI libs stay in `devDependencies` (bundled at build).
- Never read or emit the content of transcript messages/prompts/tool calls — only token and routing metadata. See `CLAUDE.md` and `.github/review-rules.md` for the full invariants.
- Keep changes small and focused; one concern per PR.
