# ccblame

**git blame for your Claude Code spend — which subagent burned the budget?**

[![npm version](https://img.shields.io/npm/v/ccblame.svg)](https://www.npmjs.com/package/ccblame)
[![npm downloads](https://img.shields.io/npm/dm/ccblame.svg)](https://www.npmjs.com/package/ccblame)
[![CI](https://github.com/rupaut98/ccblame/actions/workflows/ci.yml/badge.svg)](https://github.com/rupaut98/ccblame/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/ccblame.svg)](./LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://github.com/rupaut98/ccblame/blob/main/package.json)

![ccblame demo](https://raw.githubusercontent.com/rupaut98/ccblame/main/demo/demo.gif)

`ccblame` reads your local `~/.claude` transcripts and tells you *which subagent, project, and workflow* actually spent the money — not just a daily total. It runs entirely on your machine and never sends data anywhere.

```
npx ccblame
```

## The problem

You kick off a workflow before lunch. It fans out subagents — a reviewer, a couple of researchers, a test-runner — and each of *those* spawns more. A `/loop` in one session, a scheduled task in another, a GitHub Action answering PRs. You come back and your weekly quota is halfway gone. **Which one did that?**

Here's what makes it expensive *and* invisible: **every subagent starts with a cold cache.** A cache *write* costs 1.25×–2× the base input rate; a cache *read* is ~0.1× ([prompt-caching docs](https://code.claude.com/docs/en/prompt-caching)). A subagent doesn't inherit the parent's warm cache — it re-primes context from scratch, paying the cache-write premium on every spawn (a multi-turn agent recoups part of it via cheap reads on later turns, but the cold-start write repeats each time). Anthropic's own multi-agent research system used [~15× more tokens than chat](https://www.anthropic.com/engineering/multi-agent-research-system). That cost is real, and no tool shows you *who* paid it.

## Why the existing tools don't answer this

They give you plenty of **totals** — and almost no **attribution**.

| | Daily/session totals | Per-model split | **Per-subagent $** | **Spawn tree** | **Re-priming (cache writes)** |
|---|:---:|:---:|:---:|:---:|:---:|
| Claude Code `/cost` | ✓ | ✓ | ✗ | ✗ | shows cache-write tokens, not as a spawn cost |
| Claude Code `/usage` | ✓ | — | flat % by *category* | ✗ | ✗ |
| statusline | ✓ | — | ✗ (can undercount subagents) | ✗ | ✗ |
| ccusage | ✓ | ✓ | ✗ | ✗ | ✗ |
| sniffly / cccost / ccost | ✓ | ✓ (some) | ✗ | ✗ | ✗ |
| **ccblame** | ✓ | ✓ | **✓** | **✓** | **✓** |

`/usage` gets closest, but it's a flat category *percentage* — no dollars, no individual agent, no tree. ccusage nails daily/session/model totals and shows cache-write tokens as a column, but never asks *which subagent* they belonged to. And this isn't Anthropic's to fix soon: the feature request **"Per-Subagent Token Usage Tracking" was closed as [not planned](https://github.com/anthropics/claude-code/issues/22625)** ("there's no way to measure how many tokens each agent consumed"). ccblame is that missing view.

## What you get

- **Ranked table** — every subagent invocation, costliest first. `PRIME` is the re-priming cost (cache-write tokens), `READ` is the cheap cache reuse, `%` is each agent's share of subagent spend.
- **Headline** — total split into main-thread vs. subagent spend, with the re-priming (cache-write) share called out: `▸ context re-priming (cache writes): $18.90 (54% of subagent spend)`.
- **Spawn tree** (`--tree`) — the parent→child hierarchy, each node carrying its own cost *and* its subtree's, so you see which *branch* is heavy, not just which leaf.
- **Breakdowns** (`--by type | workflow | project | model | day`) — the dimensions that answer "who?".
- **Interactive drill-down** (`ccblame browse`, needs [`fzf`](https://github.com/junegunn/fzf)) — pivot through days, sessions, and agents live. No fzf? It falls back to the plain table.

![ccblame browse — interactive drill-down](https://raw.githubusercontent.com/rupaut98/ccblame/main/demo/browse.gif)

## Install

```bash
npx ccblame              # zero install — just run it
bunx ccblame             # same, via bun
npm install -g ccblame   # if you want it on PATH
```

Needs Node ≥ 18.3. Zero runtime dependencies — the whole thing is one bundled file.

## Usage

```bash
ccblame                          # ranked subagent table + headline
ccblame --tree                   # spawn hierarchy with per-node cost
ccblame --by project             # group by project
ccblame --by workflow --top 10   # 10 costliest workflow runs
ccblame --project payer-policies # scope to one project (substring match)
ccblame --workflow wf_abc        # scope to one workflow run (prefix match)
ccblame --since 2026-06-01       # on/after a date (YYYY-MM-DD or RFC3339)
ccblame --until 2026-06-30       # on/before a date (pairs with --since)
ccblame --json                   # machine-readable, full dataset
ccblame browse                   # interactive drill-down (needs fzf)
```

Date boundaries for `--since`/`--until` and `--by day` are **UTC**. `--top N` trims the *displayed* table only — `--json` and every total stay full-population, so the numbers reconcile with your real spend.

The dollar figures are an **estimate reconciled from your local logs** (main-thread + subagent spend always sums to the grand total), not a copy of your billed Anthropic invoice. Unpriced or unknown models are flagged loudly (`?`) and counted as `$0`, so a total is always a floor — never a silent undercount.

## How re-priming cost is computed

Each usage line records cache-write tokens in two TTL buckets — ephemeral 5-minute and 1-hour. ccblame sums those into `PRIME` (the write cost a spawn pays to load context) and keeps `READ` (`cacheRead`) separate. The headline prices those write tokens and reports them as a share of subagent spend — the number no other tool isolates: not "how many cache tokens," but "how much did re-priming subagents cost you."

It's an **upper bound**: a subagent that runs several turns reads part of that written cache back cheaply ([caching breaks even after ~1–2 reads](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)), so not every write dollar is lost. But the cold-start write repeats on *every* spawn — and that per-spawn re-priming is exactly the cost multi-agent workflows quietly rack up.

## Privacy

ccblame reads token-accounting and routing metadata only — usage counts, model names, ids, timestamps, and agent labels. **It never reads or emits the content of your messages, prompts, tool calls, or results.** It reads `~/.claude` (or `$CLAUDE_CONFIG_DIR`) locally and makes no network calls:

```
Reads ~/.claude (or $CLAUDE_CONFIG_DIR) locally. Never sends data anywhere.
```

## JSON

`--json` emits the complete dataset for scripting:

```json
{
  "total_cost_usd": 47.32,
  "main_thread_cost_usd": 12.05,
  "subagent_cost_usd": 35.27,
  "subagent_count": 38,
  "subagents": [
    {
      "agent_type": "code-reviewer",
      "description": "audit auth module",
      "model": "claude-opus-4-8",
      "project": "…",
      "depth": 1,
      "parent_agent_id": "…",
      "tokens": { "input": 4100, "output": 9800, "cache5m": 180000, "cache1h": 0, "cacheRead": 1200000 },
      "cost_usd": 1.99,
      "unpriced_model": false
    }
  ]
}
```

`--by <dim> --json` emits grouped output (`by`, `total_cost_usd`, `groups[]`) with the same reconciliation guarantees.

## Development

```bash
bun test          # tests
bun run lint      # biome
bun run typecheck # tsc
bun run build     # tsdown → dist/cli.mjs
```

## License

MIT
