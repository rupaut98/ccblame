# ccblame

**git blame for your Claude Code spend — which subagent burned the budget?**

[![npm version](https://img.shields.io/npm/v/ccblame.svg)](https://www.npmjs.com/package/ccblame)
[![npm downloads](https://img.shields.io/npm/dm/ccblame.svg)](https://www.npmjs.com/package/ccblame)
[![CI](https://github.com/rupaut98/ccblame/actions/workflows/ci.yml/badge.svg)](https://github.com/rupaut98/ccblame/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/ccblame.svg)](./LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://github.com/rupaut98/ccblame/blob/main/package.json)

![ccblame demo](https://raw.githubusercontent.com/rupaut98/ccblame/main/demo/demo.gif)

`ccblame` reads your local `~/.claude` transcripts and tells you *which subagent, which project, and which workflow* actually spent the money — not just a daily total. It runs entirely on your machine and never sends data anywhere.

```
npx ccblame
```

```
$47.32 total Claude Code spend
  main thread $12.05 (25%)   ·   38 subagents $35.27 (75%)
▸ of which context re-priming (cache writes): $18.90 (54% of subagent spend)

  #  AGENT              TASK                     MODEL     IN     OUT   PRIME   READ    COST    %
  1  code-reviewer      audit auth module        opus-4-8  4.1k   9.8k  180.0k  1.2M   $6.40  18%
  2  general-purpose    research pricing APIs     opus-4-8  2.0k   3.1k  120.0k  890.0k  $4.10  12%
  3  test-runner        run and fix suite         sonnet-5  8.2k   1.4k   60.0k  2.1M   $2.05   6%
  …
  ────────────────────────────
  subagents subtotal  $35.27
```

---

## The problem

You kick off a workflow before lunch. It fans out a handful of subagents — a reviewer, a couple of researchers, a test-runner — and each of *those* spawns more. You've got a `/loop` running in one session, a scheduled task in another, a GitHub Action answering PRs. You come back and your weekly quota is halfway gone.

**Which one did that?**

Here's the part that makes it expensive and invisible at the same time: **every subagent starts with a cold cache.** When Claude Code caches context, a cache *write* costs 1.25×–2× the base input rate, while a cache *read* is ~0.1× ([prompt-caching docs](https://code.claude.com/docs/en/prompt-caching)). A subagent doesn't inherit the parent's warm cache — it re-primes context from scratch on its first turn, paying the write premium every single spawn. Spawn a lot of agents and you're paying that re-priming tax over and over.

That tax is real but nobody shows it to you. Anthropic's own numbers make the shape clear: their multi-agent research system used [**~15× more tokens than chat**](https://www.anthropic.com/engineering/multi-agent-research-system) (agents ~4×). The weekly rate limits added in 2025 exist specifically because people leave agents running continuously. But when the bill lands, you can't see *who spent it*.

## Why the existing tools don't answer this

Claude Code and the ecosystem give you plenty of **totals** — and almost no **attribution**.

| | Daily/session totals | Per-model split | **Per-subagent $** | **Spawn tree** | **Re-priming tax** |
|---|:---:|:---:|:---:|:---:|:---:|
| Claude Code `/cost` | ✓ | ✓ | ✗ | ✗ | shows cache-write tokens, not as a spawn cost |
| Claude Code `/usage` | ✓ | — | flat % by *category* | ✗ | ✗ |
| statusline | ✓ | — | ✗ (can undercount subagents) | ✗ | ✗ |
| ccusage | ✓ | ✓ | ✗ | ✗ | ✗ |
| sniffly / cccost / ccost | ✓ | ✓ (some) | ✗ | ✗ | ✗ |
| **ccblame** | ✓ | ✓ | **✓** | **✓** | **✓** |

`/usage` gets closest — it buckets recent usage by skills/subagents/plugins as a **percentage of the whole**, but it's a flat category number: no dollars, no individual agent, no tree. ccusage is excellent at daily/session/model reporting and shows cache-write tokens as a column — but it never asks *which subagent* those tokens belonged to.

And this isn't an oversight you should wait on Anthropic to fix: the feature request **"Per-Subagent Token Usage Tracking" was closed as [not planned](https://github.com/anthropics/claude-code/issues/22625)** ("there's no way to measure how many tokens each agent consumed"). ccblame is that missing view.

## What you get

**A ranked table** of every subagent invocation, costliest first. `PRIME` is the re-priming tax (cache-write tokens); `READ` is the cheap cache reuse; `%` is each agent's share of subagent spend.

**A headline** that splits your total into main-thread vs. subagent spend, and calls out how much of the subagent spend was pure context re-priming:

```
▸ of which context re-priming (cache writes): $18.90 (54% of subagent spend)
```

**A spawn tree** (`--tree`) — the parent→child hierarchy, each node carrying its own cost and its subtree's cost, so you can see which *branch* is heavy, not just which leaf.

**Breakdowns** (`--by`) across the dimensions that actually answer "who?":

```
ccblame --by project     # which project is burning the budget
ccblame --by workflow    # which workflow run cost what
ccblame --by type        # which agent type (reviewer? researcher?) is expensive
ccblame --by model       # opus vs sonnet spend
ccblame --by day         # spend over time
```

**Interactive drill-down** (`ccblame browse`) if you have [`fzf`](https://github.com/junegunn/fzf) — pivot through days, sessions, and agents live. No fzf? It falls back to the plain table.

![ccblame browse — interactive drill-down](https://raw.githubusercontent.com/rupaut98/ccblame/main/demo/browse.gif)

## Install

```bash
npx ccblame          # zero install — just run it
bunx ccblame         # same, via bun
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
ccblame --since 2026-06-01       # date range (YYYY-MM-DD or RFC3339)
ccblame --json                   # machine-readable, full dataset
ccblame browse                   # interactive drill-down (needs fzf)
```

`--top N` trims the *displayed* table only — `--json` always emits the full dataset, and every total stays full-population so the numbers reconcile with your real spend.

## How the re-priming tax is computed

Each usage line records cache-write tokens in two TTL buckets — ephemeral 5-minute and 1-hour. ccblame sums those two into `PRIME` (the write cost a spawn pays to load context) and keeps `cacheRead` separate (the cheap reuse). The headline prices the write tokens in dollars and reports them as a share of subagent spend. That's the number no other tool isolates: not "how many cache tokens," but "how much did re-priming subagents cost you."

## Privacy

ccblame reads token-accounting and routing metadata only — usage counts, model names, ids, timestamps, and agent labels. **It never reads or emits the content of your messages, prompts, tool calls, or results.** It reads `~/.claude` (or `$CLAUDE_CONFIG_DIR`) locally and makes no network calls. The help text says it plainly:

```
Reads ~/.claude (or $CLAUDE_CONFIG_DIR) locally. Never sends data anywhere.
```

Unpriced models are marked loudly (`?`) and counted as `$0`, so a total is always a floor, never a silent undercount.

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
      "cost_usd": 6.40,
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
