import Table from "cli-table3";
import pc from "picocolors";
import type { Group, TreeNode } from "./aggregate.js";
import { type Invocation, totalTokens } from "./types.js";

const WIDE = (process.stdout.columns ?? 100) >= 100;

export const money = (n: number): string => `$${n.toFixed(2)}`;

export function tokensShort(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";

const modelShort = (m: string): string => m.replace(/^claude-/, "").replace(/-\d{8}$/, "");

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

const cacheTotal = (i: Invocation): number =>
  i.tokens.cache5m + i.tokens.cache1h + i.tokens.cacheRead;
const flag = (i: Invocation): string => (i.unpricedModel ? pc.red("?") : "");

/** Ranked table of subagent invocations, costliest first; row 1 highlighted. */
export function renderTable(invs: Invocation[], grand: number): string {
  const head = WIDE
    ? ["#", "AGENT", "TASK", "MODEL", "IN", "OUT", "CACHE", "COST", "%"]
    : ["#", "AGENT", "TASK", "COST", "%"];
  const table = new Table({
    head: head.map((h) => pc.dim(h)),
    style: { head: [], border: [] },
    colAligns: WIDE
      ? ["right", "left", "left", "left", "right", "right", "right", "right", "right"]
      : ["right", "left", "left", "right", "right"],
  });

  invs.forEach((i, idx) => {
    const wideCols = WIDE
      ? [
          modelShort(i.model),
          tokensShort(i.tokens.input),
          tokensShort(i.tokens.output),
          tokensShort(cacheTotal(i)),
        ]
      : [];
    const cells = [
      String(idx + 1),
      i.agentType + flag(i),
      truncate(i.description, WIDE ? 30 : 24),
      ...wideCols,
      money(i.cost),
      pct(i.cost, grand),
    ];
    table.push(idx === 0 ? cells.map((c, ci) => (ci === 0 ? c : pc.bold(pc.yellow(c)))) : cells);
  });

  return table.toString();
}

/** Total Claude Code spend split into main thread vs subagents, plus the costliest subagent. */
export function renderHeadline(
  grand: number,
  mainCost: number,
  subCost: number,
  subCount: number,
  topSub: Invocation | undefined,
): string {
  const head = `${pc.bold(pc.green(money(grand)))} ${pc.dim("total Claude Code spend")}`;
  const split =
    `  ${pc.dim("main thread")} ${pc.bold(money(mainCost))} ${pc.dim(`(${pct(mainCost, grand)})`)}` +
    `   ${pc.dim("·")}   ${pc.bold(`${subCount} subagent${subCount === 1 ? "" : "s"}`)} ${pc.bold(money(subCost))} ${pc.dim(`(${pct(subCost, grand)})`)}`;
  if (!topSub) return `${head}\n${split}`;
  const line = `${pc.yellow("▸")} ${pc.dim("costliest subagent:")} ${pc.bold(topSub.agentType)}${
    topSub.description ? ` ${pc.dim(`"${truncate(topSub.description, 38)}"`)}` : ""
  }  ${pc.bold(money(topSub.cost))} ${pc.dim(`(${pct(topSub.cost, subCost)} of subagents)`)}`;
  return `${head}\n${split}\n${line}`;
}

/**
 * Group aggregates. split=true (day/week/session) breaks cost into main vs subagent columns,
 * leading with the subagent total since that's the tool's subject; plain (by-type, --expand) shows
 * one cost column and lets the indented label carry the hierarchy.
 */
export function renderGroups(
  groups: Group[],
  grand: number,
  firstCol: string,
  split: boolean,
): string {
  const head = split
    ? WIDE
      ? [firstCol, "SUBAGENTS", "TOKENS", "MAIN", "SUB", "TOTAL", "%"]
      : [firstCol, "SUB", "TOTAL"]
    : [firstCol, "COUNT", "TOKENS", "COST", "AVG", "%"];
  const colAligns = head.map((_, i) => (i === 0 ? "left" : "right")) as ("left" | "right")[];
  const table = new Table({
    head: head.map((h) => pc.dim(h)),
    style: { head: [], border: [] },
    colAligns,
  });

  for (const g of groups) {
    const label = g.label + (g.unpriced ? pc.red(" ?") : "");
    const sub = pc.bold(pc.green(money(g.subCost)));
    const total = pc.bold(money(g.cost));
    if (!split) {
      table.push([
        label,
        String(g.count),
        tokensShort(totalTokens(g.tokens)),
        total,
        pc.dim(money(g.cost / g.count)),
        pct(g.cost, grand),
      ]);
    } else if (WIDE) {
      table.push([
        label,
        String(g.subCount),
        tokensShort(totalTokens(g.tokens)),
        pc.dim(money(g.mainCost)),
        sub,
        total,
        pct(g.cost, grand),
      ]);
    } else {
      table.push([label, sub, total]);
    }
  }
  return table.toString();
}

/** Spawn forest, indented by depth, each node carrying its own + subtree cost. */
export function renderTree(roots: TreeNode[], grand: number): string {
  const lines: string[] = [];
  const walk = (node: TreeNode, prefix: string, isLast: boolean, isRoot: boolean): void => {
    const branch = isRoot ? "" : isLast ? "└─ " : "├─ ";
    const i = node.inv;
    const label = `${pc.bold(i.agentType)}${i.description ? pc.dim(` "${truncate(i.description, 32)}"`) : ""}`;
    const self = money(i.cost);
    const sub = node.children.length > 0 ? pc.dim(` [subtree ${money(node.subtreeCost)}]`) : "";
    lines.push(
      `${pc.dim(prefix + branch)}${label}  ${pc.dim(modelShort(i.model))}  ${pc.bold(self)} ${pc.dim(
        `(${pct(i.cost, grand)})`,
      )}${sub}`,
    );
    const childPrefix = prefix + (isRoot ? "" : isLast ? "   " : "│  ");
    node.children.forEach((c, idx) => {
      walk(c, childPrefix, idx === node.children.length - 1, false);
    });
  };
  roots.forEach((r, idx) => {
    walk(r, "", idx === roots.length - 1, true);
  });
  return lines.join("\n");
}

export function renderFooter(label: string, amount: number): string {
  return `${pc.dim("─".repeat(28))}\n${pc.dim(label)}  ${pc.bold(pc.green(money(amount)))}`;
}

export function toJSON(subInvs: Invocation[], mainCost: number, subCost: number) {
  return {
    total_cost_usd: mainCost + subCost,
    main_thread_cost_usd: mainCost,
    subagent_cost_usd: subCost,
    subagent_count: subInvs.length,
    subagents: subInvs.map((i) => ({
      agent_id: i.agentId,
      agent_type: i.agentType,
      description: i.description,
      slug: i.slug,
      model: i.model,
      session_id: i.sessionId,
      project: i.project,
      depth: i.depth,
      parent_agent_id: i.parentAgentId,
      started_at: new Date(i.startedAt).toISOString(),
      tokens: i.tokens,
      cost_usd: i.cost,
      unpriced_model: i.unpricedModel,
    })),
  };
}
