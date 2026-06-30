import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import { dayKey as day, groupByType } from "./aggregate.js";
import { priceUsage } from "./cost.js";
import {
  modelShort,
  money,
  pct,
  renderFooter,
  renderGroups,
  renderTable,
  truncate,
} from "./render.js";
import type { Invocation } from "./types.js";

// The context re-priming tax for one invocation: just the cache-write tokens, priced.
export const primeOf = (i: Invocation): number =>
  priceUsage(
    { input: 0, output: 0, cache5m: i.tokens.cache5m, cache1h: i.tokens.cache1h, cacheRead: 0 },
    i.model,
    false,
  ).cost;

interface SubGroup {
  key: string;
  label: string;
  invs: Invocation[];
  cost: number;
  prime: number; // summed re-priming tax — the thing browse navigates by
}

type SortMode = "cost" | "tax";

/** Group subagent invocations by a key, summing cost + re-priming tax; sorted by the chosen mode. */
export function groupSubs(
  invs: Invocation[],
  keyFn: (i: Invocation) => [string, string],
  sort: SortMode = "cost",
): SubGroup[] {
  const map = new Map<string, SubGroup>();
  for (const i of invs) {
    const [key, label] = keyFn(i);
    let g = map.get(key);
    if (!g) {
      g = { key, label, invs: [], cost: 0, prime: 0 };
      map.set(key, g);
    }
    g.invs.push(i);
    g.cost += i.cost;
    g.prime += primeOf(i);
  }
  const rows = [...map.values()];
  rows.sort(
    sort === "tax"
      ? (a, b) => b.prime / (b.cost || 1) - a.prime / (a.cost || 1)
      : (a, b) => b.cost - a.cost,
  );
  return rows;
}

// A 10-cell magnitude bar: yellow = re-priming tax, green = productive spend, dim = headroom.
export function bar(cost: number, prime: number, max: number, width = 10): string {
  if (max <= 0) return pc.dim("░".repeat(width));
  const filled = Math.min(width, Math.max(cost > 0 ? 1 : 0, Math.round((cost / max) * width)));
  const tax = Math.min(filled, cost > 0 ? Math.round((prime / cost) * filled) : 0);
  return (
    pc.yellow("█".repeat(tax)) +
    pc.green("█".repeat(filled - tax)) +
    pc.dim("░".repeat(width - filled))
  );
}

const taxLine = (cost: number, prime: number): string =>
  `${pc.yellow("▸")} ${pc.dim("context re-priming:")} ${pc.bold(money(prime))} ${pc.dim(
    `(${pct(prime, cost)} of ${money(cost)})`,
  )}`;

const groupPreview = (g: SubGroup): string =>
  `${taxLine(g.cost, g.prime)}\n\n${renderGroups(groupByType(g.invs), g.cost, "AGENT TYPE", false)}`;

const sessionDetail = (g: SubGroup): string => {
  const ranked = [...g.invs].sort((a, b) => b.cost - a.cost);
  return `${taxLine(g.cost, g.prime)}\n\n${renderTable(ranked, g.cost)}\n${renderFooter("session subtotal", g.cost)}`;
};

const grpDisplay = (g: SubGroup, max: number): string =>
  `${bar(g.cost, g.prime, max)}  ${truncate(g.label, 22).padEnd(22)} ${money(g.cost).padStart(9)}  ${String(g.invs.length).padStart(4)} sub  ${pc.yellow(pct(g.prime, g.cost).padStart(4))}`;

const sessDisplay = (g: SubGroup, max: number): string => {
  const start = Math.min(...g.invs.map((i) => i.startedAt));
  return `${bar(g.cost, g.prime, max)}  ${day(start)}  ${g.key.slice(0, 8)}  ${money(g.cost).padStart(9)}  ${String(g.invs.length).padStart(3)} sub  ${pc.yellow(pct(g.prime, g.cost).padStart(4))}`;
};

interface Dim {
  col: string;
  keyFn: (i: Invocation) => [string, string];
  filter?: (i: Invocation) => boolean;
}

// The live pivot ring (^t cycles through it). project is always non-empty, so it anchors the ring.
const DIMS: Dim[] = [
  { col: "projects", keyFn: (i) => [i.project, i.projectLabel] },
  { col: "days", keyFn: (i) => [day(i.startedAt), day(i.startedAt)] },
  { col: "agent types", keyFn: (i) => [i.agentType, i.agentType] },
  { col: "models", keyFn: (i) => [i.model, modelShort(i.model)] },
  {
    col: "workflows",
    keyFn: (i) => [i.workflowId ?? "", i.workflowName ?? i.workflowId ?? ""],
    filter: (i) => Boolean(i.workflowId),
  },
];

// spawnSync sets error.code to "ENOENT" when the binary isn't on PATH.
const spawnMissing = (err: Error | undefined): boolean =>
  (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

type PickResult = { fzfMissing: true } | { action: "pivot" | "sort" } | { key: string | null };

/** Run one fzf level. Preview reads pre-rendered file <prefix><row-index>; {n} = fzf's input index. */
function pick(opts: {
  rows: { key: string; display: string }[];
  dir: string;
  prefix: string;
  prompt: string;
  header: string;
  pivotable: boolean;
}): PickResult {
  const input = opts.rows.map((r) => `${r.key}\t${r.display}`).join("\n");
  const copy =
    "ctrl-y:execute-silent(printf %s {1} | pbcopy 2>/dev/null || printf %s {1} | xclip -selection clipboard 2>/dev/null || printf %s {1} | wl-copy 2>/dev/null)";
  const r = spawnSync(
    "fzf",
    [
      "--delimiter=\t",
      "--with-nth=2",
      "--ansi",
      "--no-sort",
      `--prompt=${opts.prompt}`,
      `--header=${opts.header}`,
      `--expect=${opts.pivotable ? "ctrl-t,ctrl-s" : "ctrl-s"}`,
      // ctrl-o is the reliable toggle (many terminals send a bare "/" for ctrl-/, which just types
      // into the query); ctrl-/ and ctrl-_ are kept as a bonus for terminals that do send them.
      "--bind=ctrl-o:toggle-preview,ctrl-/:toggle-preview,ctrl-_:toggle-preview",
      "--bind=ctrl-w:change-preview-window(down,65%,wrap|right,55%,wrap|hidden)",
      `--bind=${copy}`,
      "--preview",
      // 2>/dev/null: an empty filter match leaves {n} blank → cat would hit the dir; stay quiet.
      `cat "${join(opts.dir, opts.prefix)}{n}" 2>/dev/null`,
      "--preview-window=down,65%,wrap",
    ],
    { input, stdio: ["pipe", "pipe", "inherit"], encoding: "utf8" },
  );
  if (spawnMissing(r.error)) return { fzfMissing: true };
  if (r.status !== 0) return { key: null }; // esc/ctrl-c → step back up a level
  // --expect prints the pressed key on line 1 (blank for Enter), the selected row on line 2.
  const [actionLine = "", selLine = ""] = (r.stdout ?? "").split("\n");
  const action = actionLine.trim();
  if (action === "ctrl-t") return { action: "pivot" };
  if (action === "ctrl-s") return { action: "sort" };
  return { key: selLine.split("\t")[0] || null };
}

function fzfMissing(): boolean {
  process.stderr.write(
    "browse needs fzf on PATH (e.g. `brew install fzf`) — showing the table instead.\n",
  );
  return false;
}

/**
 * Page the full session table (scrollable; -R keeps ANSI). less reads keys from /dev/tty even with
 * piped stdin. Returns false if no pager on PATH → caller must quit, not relaunch fzf over the output.
 */
function showDetail(text: string): boolean {
  const r = spawnSync("less", ["-R"], { input: text, stdio: ["pipe", "inherit", "inherit"] });
  if (spawnMissing(r.error)) {
    process.stdout.write(`${text}\n`);
    return false;
  }
  return true;
}

/**
 * Interactive fzf drill-down navigated by re-priming tax: top level pivots across
 * project/day/type/model/workflow (^t), ^s sorts cost⇄tax%, drill group → sessions → Enter pages the
 * full table, esc steps up (quits at top). Returns false if fzf is absent so the caller falls back.
 */
export function browse(subs: Invocation[]): boolean {
  if (subs.length === 0) {
    process.stdout.write(
      "No subagent spend in this data — run `cc-agentcost` for the main-thread breakdown.\n",
    );
    return true;
  }
  const globalSub = subs.reduce((s, i) => s + i.cost, 0);
  const globalPrime = subs.reduce((s, i) => s + primeOf(i), 0);
  const banner = `${pc.bold(pc.green(money(globalSub)))} ${pc.dim("subagent spend")} · ${pc.yellow(`${pct(globalPrime, globalSub)} re-priming tax`)}`;

  const dir = mkdtempSync(join(tmpdir(), "cc-agentcost-"));
  let dimIndex = 0;
  let sort: SortMode = "cost";
  const header = (hints: string): string =>
    `${banner}  ${pc.dim(`[sort: ${sort === "tax" ? "tax%" : "cost"}]`)}\n${pc.dim(hints)}`;

  // Level 1: sessions within a chosen group. "back" (esc), "missing" (no fzf), "quit" (no pager).
  const sessions = (group: SubGroup): "back" | "missing" | "quit" => {
    while (true) {
      const rows = groupSubs(group.invs, (i) => [i.sessionId, i.sessionId], sort);
      const max = Math.max(0, ...rows.map((g) => g.cost));
      // Render each session table once: the preview file and the Enter pager show the same text.
      const details = rows.map((g) => sessionDetail(g));
      rows.forEach((_, n) => {
        writeFileSync(join(dir, `sess-${n}`), details[n]!);
      });
      const r = pick({
        rows: rows.map((g) => ({ key: g.key, display: sessDisplay(g, max) })),
        dir,
        prefix: "sess-",
        prompt: `agentcost ▸ ${truncate(group.label, 18)} ▸ `,
        header: header("enter: full table · esc: back · ^s: sort · ^y: copy id · ^o: preview"),
        pivotable: false,
      });
      if ("fzfMissing" in r) return "missing";
      if ("action" in r) {
        sort = sort === "cost" ? "tax" : "cost";
        continue;
      }
      if (r.key === null) return "back";
      const idx = rows.findIndex((x) => x.key === r.key);
      if (idx >= 0 && !showDetail(details[idx]!)) return "quit"; // no pager → bail, keep output on screen
    }
  };

  try {
    while (true) {
      const dim = DIMS[dimIndex]!;
      const pool = dim.filter ? subs.filter(dim.filter) : subs;
      const groups = groupSubs(pool, dim.keyFn, sort);
      const max = Math.max(0, ...groups.map((g) => g.cost));
      groups.forEach((g, n) => {
        writeFileSync(join(dir, `grp-${n}`), groupPreview(g));
      });
      const r = pick({
        rows: groups.map((g) => ({ key: g.key, display: grpDisplay(g, max) })),
        dir,
        prefix: "grp-",
        prompt: `agentcost ▸ ${dim.col} ▸ `,
        header: header("enter: drill · esc: quit · ^t: pivot · ^s: sort · ^y: copy · ^o: preview"),
        pivotable: true,
      });
      if ("fzfMissing" in r) return fzfMissing();
      if ("action" in r) {
        if (r.action === "pivot") {
          do {
            dimIndex = (dimIndex + 1) % DIMS.length;
          } while (DIMS[dimIndex]!.filter && subs.filter(DIMS[dimIndex]!.filter!).length === 0);
        } else sort = sort === "cost" ? "tax" : "cost";
        continue;
      }
      if (r.key === null) return true; // esc at the top → quit
      const g = groups.find((x) => x.key === r.key);
      if (g) {
        const res = sessions(g);
        if (res === "missing") return fzfMissing();
        if (res === "quit") return true; // no pager → output already printed, stop here
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
