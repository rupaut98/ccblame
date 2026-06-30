#!/usr/bin/env node
import { parseArgs } from "node:util";
import pc from "picocolors";
import {
  buildDataset,
  buildTree,
  type Dataset,
  type Group,
  groupByDay,
  groupByModel,
  groupByProject,
  groupByType,
  groupByWorkflow,
} from "./aggregate.js";
import { browse, primeOf } from "./browse.js";
import {
  groupsToJSON,
  renderFooter,
  renderGroups,
  renderHeadline,
  renderTable,
  renderTree,
  toJSON,
} from "./render.js";
import type { Invocation } from "./types.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";

const HELP = `cc-agentcost — per-subagent cost attribution for Claude Code

Usage
  cc-agentcost [command] [options]

Commands
  (default)            ranked table of subagent invocations, costliest first
  browse               interactive subagent drill-down (needs fzf)

Options
  --by <dim>           aggregate by: type | workflow | project | model | day
  --tree               show the spawn hierarchy with per-node cost
  --session <id>       scope to one session (prefix match)
  --workflow <id>      scope to one workflow run (prefix match)
  --project <name>     scope to a project (substring match)
  --since <date>       only invocations on/after (YYYY-MM-DD or RFC3339)
  --until <date>       only invocations on/before
  --top <n>            show only the N costliest
  --json               machine-readable output
  -h, --help           this help
  -v, --version        print version

Reads ~/.claude (or $CLAUDE_CONFIG_DIR) locally. Never sends data anywhere.`;

function parseDate(s: string, endOfDay: boolean): number | null {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s)) return t + 86_400_000 - 1;
  return t;
}

function applyFilters(invs: Invocation[], v: Record<string, unknown>): Invocation[] {
  let out = invs;
  if (typeof v.session === "string") {
    const s = v.session;
    out = out.filter((i) => i.sessionId.startsWith(s));
  }
  if (typeof v.workflow === "string") {
    const w = v.workflow;
    out = out.filter((i) => i.workflowId?.startsWith(w));
  }
  if (typeof v.project === "string") {
    const p = v.project.toLowerCase();
    out = out.filter(
      (i) => i.project.toLowerCase().includes(p) || i.projectLabel.toLowerCase().includes(p),
    );
  }
  if (typeof v.since === "string") {
    const t = parseDate(v.since, false);
    if (t === null) fail(`invalid --since date: ${v.since}`);
    out = out.filter((i) => i.startedAt >= t);
  }
  if (typeof v.until === "string") {
    const t = parseDate(v.until, true);
    if (t === null) fail(`invalid --until date: ${v.until}`);
    out = out.filter((i) => i.startedAt <= t);
  }
  return out;
}

function fail(msg: string): never {
  process.stderr.write(`${pc.red("error")}: ${msg}\n`);
  process.exit(1);
}

function applyTop<T>(rows: T[], top: unknown): T[] {
  if (typeof top !== "string") return rows;
  const n = Number.parseInt(top, 10);
  if (Number.isNaN(n) || n <= 0) fail(`invalid --top: ${top}`);
  return rows.slice(0, n);
}

function warnings(ds: Dataset, out: NodeJS.WriteStream): void {
  if (ds.unpricedModels.size > 0) {
    out.write(
      `${pc.yellow("⚠")} no pricing for ${[...ds.unpricedModels].join(", ")} — ${pc.dim(
        "marked ? ; their cost is counted as $0, so totals are a floor",
      )}\n`,
    );
  }
  const d = ds.cleanupPeriodDays;
  if (d !== null && d < 3650) {
    out.write(
      `${pc.dim(`note: Claude Code keeps transcripts ~${d} days (cleanupPeriodDays); older history is gone. Raise it in ~/.claude/settings.json (e.g. 3650) to keep more.`)}\n`,
    );
  }
}

function main(): void {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        by: { type: "string" },
        tree: { type: "boolean" },
        session: { type: "string" },
        workflow: { type: "string" },
        project: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        top: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    fail((e as Error).message);
  }
  const v = parsed.values as Record<string, unknown>;
  const cmd = parsed.positionals[0];

  if (v.help) return void console.log(HELP);
  if (v.version) return void console.log(VERSION);

  const ds = buildDataset();
  const all = applyFilters(ds.invocations, v);
  const subInvsAll = all.filter((i) => i.kind === "subagent").sort((a, b) => b.cost - a.cost);
  const mainCost = all.reduce((s, i) => (i.kind === "main" ? s + i.cost : s), 0);
  const subCost = subInvsAll.reduce((s, i) => s + i.cost, 0);
  const grand = mainCost + subCost;

  const out = process.stdout;
  if (all.length === 0) {
    if (v.json) return void out.write(`${JSON.stringify(toJSON([], 0, 0), null, 2)}\n`);
    out.write(
      `${pc.yellow("No Claude Code usage found.")}\nLooked in: ${ds.configDirs
        .map((d) => `${d}/projects`)
        .join(", ")}\n`,
    );
    warnings(ds, out);
    return;
  }

  if (cmd === "browse" && browse(subInvsAll)) return; // fzf absent → fall through to the table

  // Aggregations include the main thread so totals reconcile with ccusage. Handled before --json so
  // `--by X --json` emits grouped output instead of silently falling back to the flat subagent list.
  const by = v.by as string | undefined;
  if (by) {
    // type/workflow rows are all one kind (no main thread), so show one cost column (split: false);
    // day/project/model split into main vs subagent.
    const dims: Record<string, { group: () => Group[]; col: string; split: boolean }> = {
      type: { group: () => groupByType(all), col: "AGENT TYPE", split: false },
      workflow: { group: () => groupByWorkflow(all), col: "WORKFLOW", split: false },
      project: { group: () => groupByProject(all), col: "PROJECT", split: true },
      model: { group: () => groupByModel(all), col: "MODEL", split: true },
      day: {
        group: () => groupByDay(all).sort((a, b) => a.key.localeCompare(b.key)),
        col: "DAY",
        split: true,
      },
    };
    const dim = dims[by];
    if (!dim)
      return void fail(
        `unknown --by dimension: ${by} (use type | workflow | project | model | day)`,
      );
    const allGroups = dim.group();
    // Denominator is the dimension's own total: workflow filters out non-workflow spend, so its rows
    // sum below `grand`. --top trims which rows show, not the total they're a percentage of.
    const dimTotal = allGroups.reduce((s, g) => s + g.cost, 0);
    const groups = applyTop(allGroups, v.top);
    if (v.json) {
      // Emit every group so the rows sum to total_cost_usd; --top only trims the printed table.
      out.write(`${JSON.stringify(groupsToJSON(by, dimTotal, allGroups), null, 2)}\n`);
      return;
    }
    if (groups.length === 0) {
      out.write(`${pc.dim(`no ${by} data found in range.`)}\n`);
      warnings(ds, out);
      return;
    }
    out.write(
      `${renderGroups(groups, dimTotal, dim.col, dim.split)}\n${renderFooter("TOTAL", dimTotal)}\n`,
    );
    warnings(ds, out);
    return;
  }

  if (v.json) {
    // JSON is the complete dump (--top only trims the human table); keep counts and totals in sync.
    out.write(`${JSON.stringify(toJSON(subInvsAll, mainCost, subCost), null, 2)}\n`);
    return;
  }

  // Priming tax: the slice of subagent cost spent re-loading context (cache-write tokens).
  const primeCost = subInvsAll.reduce((s, i) => s + primeOf(i), 0);
  const headline = renderHeadline(grand, mainCost, subCost, subInvsAll.length, primeCost);

  if (v.tree) {
    out.write(`${headline}\n\n${renderTree(buildTree(subInvsAll), grand)}\n`);
    warnings(ds, out);
    return;
  }

  // Bound the default to the window so a heavy user doesn't get 1000+ rows; piped output stays whole.
  const subInvs = v.top
    ? applyTop(subInvsAll, v.top)
    : subInvsAll.slice(0, autoBound(subInvsAll.length));
  const hidden = subInvsAll.length - subInvs.length;
  out.write(
    `${headline}\n\n${renderTable(subInvs, subCost)}\n${renderFooter("subagents subtotal", subCost)}\n`,
  );
  if (hidden > 0) {
    out.write(
      pc.dim(
        `showing top ${subInvs.length} of ${subInvsAll.length} subagents — --top N · --by day · browse\n`,
      ),
    );
  }
  warnings(ds, out);
}

/** Fit the table to the terminal on a TTY; show everything when piped (| less, > file). */
function autoBound(total: number): number {
  if (!process.stdout.isTTY) return total;
  return Math.max((process.stdout.rows ?? 40) - 12, 10);
}

main();
