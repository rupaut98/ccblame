# cc-agentcost — PR Review Rules

Reviewing a **privacy-first, zero-runtime-dependency CLI** that attributes Claude Code cost
per subagent by parsing the user's **local** `~/.claude` transcripts. The whole pitch is "reads
your transcripts locally, never reads your prompts, never phones home, costs nothing to run."
Review like the senior engineer who owns this in production. These rules outrank any default
urge to be agreeable, exhaustive, or stylistic.

## Discipline

- **Comment only on `+` lines** (added/modified). Read callers, imports, and sibling helpers for
  context, but the finding must land on a changed line. Don't comment on pre-existing or deleted
  code unless a deletion breaks a contract.
- **Look for what's missing**, not just what's wrong: a new `spawnSync` with no ENOENT fallback, a
  new `readdirSync`/`JSON.parse` over `~/.claude` with no guard, a new parsed field that reaches
  into message *content*, a `--top`/filter path that desyncs counts from totals.
- **Cite `file:line` that proves every finding.** No inferences from names. Before posting, try to
  refute it — re-read the surrounding code, check whether an existing guard/helper already handles
  it. Can't confirm with a specific `file:line` → drop it. Pass `confirmed=true` on inline comments.

## Severity (label every comment)

- **🔴 Important** — violates a repo invariant below, or otherwise breaks correctness/privacy:
  leaks transcript content, misreports cost, crashes/hangs the scan, adds a runtime dep or a
  network call. Blocks merge.
- **🟡 Nit** — minor correctness/robustness smell, not provably a bug. Never blocking.
- **🟣 Pre-existing** — real bug this PR didn't introduce. Summary mention only; never inline.

## Noise control

- **Skip anything biome / tsc / the build already catch**: formatting, import order, naming,
  `any`, unused vars, type errors. Skip missing docs/comments, test _quantity_, TODOs. No praise.
- **Cap nits at 3** ("plus N similar" in the summary). On **re-review** (your prior comments are
  present), suppress nits — report only new 🔴 issues.
- Skip lockfiles, generated files, `dist/`, `*.md`, `test/fixtures/`, `node_modules/`.
- **Summary** opens with a tally — `**X Important, Y nits**` or `**No blocking issues found.**` —
  then ≤3 sentences. Post inline comments for specific issues; one top-level summary via
  `gh pr comment`. Only post GitHub comments — don't return review text as a chat message.

---

## Repo invariants (violations are 🔴 unless noted)

### 1. Privacy — transcript message bodies are never read or emitted

The transcript readers may touch **only** token accounting and routing metadata: `message.usage`,
`message.model`, ids (`message.id`, `requestId`, tool_use `id`/`name`), timestamps, and the small
routing fields (`isSidechain`, `speed`/`version`, `slug`, `attributionAgent`). Manifest/meta
readers may take **only** `agentId`/`label`/`workflowName` and `agentType`/`description`/`toolUseId`.

- **Flag any new read of `message.content`, a tool_use `input`, or a manifest/result `prompt`/
  `summary`/`result` field** — in parsing OR in output (`render.ts`, `toJSON`/`groupsToJSON`).
- Whitelisted fields that already surface (`description`, `label`, `agentType`, `slug`, `model`,
  ids, `cost`, `tokens`) are fine; a *new* surfaced field, especially anything derived from
  message content text, is 🔴.
- See the asserting comments in `parse.ts` (`parseUsageLines`, `extractAgentSpawnIds`) and
  `aggregate.ts` (`buildWorkflowMap`, `readMeta`) — they state the boundary explicitly; a PR that
  widens it must be challenged.

**Why:** the headline promise ("parses locally, never reads your prompts") becomes a lie.

### 2. Zero runtime dependencies

`package.json` `dependencies` must stay `{}`. UI libs (`picocolors`, `cli-table3`) live in
`devDependencies` and are bundled by tsdown so the published package ships zero runtime deps.

- **Flag any addition to `dependencies`**, or any `import` of a package not already devDeps-bundled.
- See `tsdown.config.ts` (bundles devDeps in) and `package.json`.

### 3. Cost reconciliation — main + sub = grand, totals stay full-population

Aggregations include the main thread so the grand total reconciles with ccusage. Enforce:

- `total_cost_usd == main_thread_cost_usd + subagent_cost_usd`; per-group `cost == mainCost + subCost`.
- **Counts and totals must describe the same population.** `--top` and filters trim *displayed
  rows*, not the totals/denominators — but a JSON document must be internally consistent:
  `subagent_count` must match the emitted `subagents[]` length, and grouped `total_cost_usd` must
  equal the sum of the emitted `groups[]`. Flag any path where a sliced list is emitted alongside a
  full-population count or total (the classic `--top --json` desync).
- Percentage/footer denominators must match the rows shown (a filtered dimension like `--by
  workflow` uses its own total, not the global grand total).

**Why:** totals stop matching ccusage; averages/percentages computed off the JSON are wrong.

### 4. Dedup correctness

Claude Code rewrites each assistant turn several times; `dedup()` collapses them.

- The dedup key is `(msgId, requestId)` joined by a **plain printable separator** (a single space).
  A NUL byte once crept in here — flag any non-printable/empty/ambiguous separator.
- `better()` must prefer **non-sidechain → more tokens → the speed-carrying line**, in that order.
  Changing the tie-break order mis-attributes tokens.
- See `parse.ts` `dedup`/`better`; covered by `test/parse.test.ts`.

### 5. Pricing honesty — unpriced is loud, never a silent $0

An unpriced model must yield `cost: 0` **and** `unpriced: true`, and be surfaced (the `⚠ no
pricing` warning + the red `?` flag). `<synthetic>` is free-not-unpriced.

- Flag any change that lets an unknown model contribute `$0` **without** setting `unpriced` / firing
  the warning — that turns an undercount into a number users trust.
- Pricing lives in `pricing.json` keyed by family; the resolver collapses version/date suffixes.
  Rate changes must cite a source. (Do **not** flag flat-vs-tiered structure as a bug — that's a
  deliberate product decision, not an invariant.)
- See `cost.ts` (`priceUsage`, `resolveFamily`) and the warning in `cli.ts` / flag in `render.ts`.

### 6. Spawn safety — every external binary tolerates ENOENT

`browse` shells out to `fzf`, `less`, and clipboard tools. None are guaranteed on PATH.

- Every `spawnSync` of an external binary must check `error.code === "ENOENT"` and **degrade
  gracefully** (fzf missing → plain table; less missing → print text). Clipboard writes run through
  a `pbcopy || xclip || wl-copy` fallback chain with `2>/dev/null`.
- Flag any new `spawnSync`/`exec` that assumes the binary exists. See `spawnMissing` in `browse.ts`.

**Why:** on a machine without these tools the CLI throws instead of falling back.

### 7. Filesystem robustness — reads over `~/.claude` can't crash or hang the scan

The tool walks an arbitrary user directory tree it doesn't control.

- Every `statSync`/`readdirSync`/`readFileSync`/`JSON.parse` over `~/.claude` must be guarded
  (try/catch or a `*Or`-style helper) so one malformed/unreadable/permission-denied file is skipped,
  not fatal.
- Directory recursion must be **symlink-/cycle-safe** (don't follow symlinked dirs into a loop).
- Flag a new `readdirSync`/`JSON.parse` with no guard, or new recursion with no cycle protection.
  See the guard helpers in `discover.ts` and `parse.ts` (`readLines`).

### 8. No network, no stray writes

The tool only **reads** `~/.claude` and writes solely to a `mkdtemp` scratch dir (for fzf preview
files), removed in a `finally`.

- **Flag any** `fetch`/`http`/`https`/`net` import, telemetry, analytics ping, or any write into
  `~/.claude` (or anywhere outside the scratch dir). The HELP text promises "Never sends data
  anywhere" — keep it true.
- See the `mkdtempSync`/`writeFileSync`/`rmSync(...finally)` confinement in `browse.ts`.

### 9. Keep CI green

`biome check` (lint), `tsc --noEmit` (typecheck), `bun test`, and `tsdown` (build) must all pass.
Flag changes that obviously break one (e.g. a new export with no type, a test left failing, an API
rename not propagated). See `.github/workflows/ci.yml`.
