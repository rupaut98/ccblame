# ccblame

CLI ("git blame for your Claude Code spend") that parses local `~/.claude` transcripts to attribute Claude Code cost per subagent, then ranks spend by subagent / workflow / project / model / day. Zero runtime deps; reads transcripts locally, never reads prompt content, never makes network calls.

## Workflow

Never commit or push automatically. Stage changes, show the proposed commit message, and wait for an explicit go-ahead.

## Commands

- run: `bun src/cli.ts`
- test: `bun test`
- lint: `biome check src test`
- typecheck: `tsc --noEmit`
- build: `tsdown`
- refresh pricing: `bun scripts/gen-pricing.ts` (regenerates `src/pricing.json` from LiteLLM; also runs weekly in CI)

CI runs lint, typecheck, test, and build — keep all four green.

## Modules (`src/`)

- `cli.ts` — arg parsing, command dispatch, HELP text
- `aggregate.ts` — build dataset, group, spawn tree
- `parse.ts` — parse and dedup JSONL usage lines
- `cost.ts` — token usage to USD
- `discover.ts` — find transcript/meta file pairs
- `browse.ts` — interactive fzf drill-down
- `render.ts` — tables, tree, JSON output
- `types.ts`, `pricing.json` — shared types and rate table

## Invariants

Things that break correctness, privacy, or the product promise if violated silently. The full rationale and file:line citations live in `.github/review-rules.md` — read it before touching parsing, cost, or output.

1. Privacy: readers touch only usage, model, ids, timestamps, and routing fields. Never read or emit message content, tool input, prompts, results, or summaries — in parsing or in JSON output.
2. Zero runtime deps: `package.json` dependencies stays `{}`. UI libs are devDeps, bundled at build.
3. Cost reconciles: main + sub = grand total. `--top` and filters trim displayed rows only, never the counts or totals.
4. Dedup key is `` `${msgId} ${requestId}` `` (single space); the `better()` tie-break order is load-bearing.
5. Pricing is honest: an unknown model yields cost 0 plus an unpriced flag and a warning, never a silent $0.
6. Spawn safety: every external binary (fzf, less, clipboard) tolerates ENOENT and degrades.
7. FS reads over `~/.claude` are all guarded; recursion is symlink-safe; writes stay in a scratch dir; no network.
