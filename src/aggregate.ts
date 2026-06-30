import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { priceUsage } from "./cost.js";
import { type Discovery, discover } from "./discover.js";
import { dedup, extractAgentSpawnIds, parseUsageLines } from "./parse.js";
import {
  addUsage,
  emptyUsage,
  type Invocation,
  totalTokens,
  type Usage,
  type UsageLine,
} from "./types.js";

export interface Dataset {
  invocations: Invocation[];
  cleanupPeriodDays: number | null;
  unpricedModels: Set<string>;
  configDirs: string[];
}

const projectLabel = (project: string): string =>
  project.replace(/^-+/, "").split("-").slice(-2).join("-") || project;

function readMeta(path: string): { agentType?: string; description?: string; toolUseId?: string } {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

interface WfInfo {
  workflowId: string;
  workflowName: string | null;
  label: string;
}
interface Manifest {
  workflowName?: string;
  workflowProgress?: { type?: string; agentId?: string; label?: string }[];
}

/**
 * Map each workflow agentId → its run name/label from <session>/workflows/wf_*.json.
 * Privacy: reads only agentId/label/workflowName — never the manifest's prompt/result/summary content.
 */
function buildWorkflowMap(manifestPaths: string[]): Map<string, WfInfo> {
  const map = new Map<string, WfInfo>();
  for (const path of manifestPaths) {
    let m: Manifest;
    try {
      m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    } catch {
      continue;
    }
    const workflowId = basename(path).replace(/\.json$/, "");
    const workflowName = typeof m.workflowName === "string" ? m.workflowName : null;
    for (const e of m.workflowProgress ?? []) {
      if (e?.type !== "workflow_agent" || typeof e.agentId !== "string") continue;
      map.set(e.agentId, {
        workflowId,
        workflowName,
        label: typeof e.label === "string" ? e.label : "",
      });
    }
  }
  return map;
}

export function buildDataset(disc: Discovery = discover()): Dataset {
  const { pairs, mainSessions, cleanupPeriodDays, configDirs } = disc;

  // Every Agent tool_use id -> agentId of the transcript that spawned it (null = main session).
  const spawnOwner = new Map<string, string | null>();
  for (const ms of mainSessions)
    for (const id of extractAgentSpawnIds(ms.path)) spawnOwner.set(id, null);
  for (const p of pairs)
    for (const id of extractAgentSpawnIds(p.jsonlPath)) spawnOwner.set(id, p.agentId);

  const wfByAgent = buildWorkflowMap(disc.manifests);
  const unpricedModels = new Set<string>();
  const invocations: Invocation[] = [];

  for (const p of pairs) {
    const meta = readMeta(p.metaPath);
    const s = summarize(dedup(parseUsageLines(p.jsonlPath)), unpricedModels);
    if (!s) continue;
    const toolUseId = typeof meta.toolUseId === "string" ? meta.toolUseId : null;
    const wf = wfByAgent.get(p.agentId);
    invocations.push({
      kind: "subagent",
      agentId: p.agentId,
      agentType: meta.agentType || s.first.attributionAgent || "‹unknown agent›",
      description: wf?.label || meta.description || "", // manifest label fills the stub meta's blank
      toolUseId,
      parentAgentId: toolUseId ? (spawnOwner.get(toolUseId) ?? null) : null,
      depth: 1, // filled below
      sessionId: p.sessionId,
      project: p.project,
      projectLabel: projectLabel(p.project),
      workflowId: wf?.workflowId ?? null,
      workflowName: wf?.workflowName ?? null,
      ...summaryFields(s),
    });
  }

  // A session's main thread is disjoint from its subagent files (parents carry no isSidechain
  // usage), so adding it reconciles the grand total with ccusage, not just the subagent slice.
  for (const ms of mainSessions) {
    const s = summarize(dedup(parseUsageLines(ms.path)), unpricedModels);
    if (!s) continue;
    invocations.push({
      kind: "main",
      agentId: `main:${ms.sessionId}`,
      agentType: "(main thread)",
      description: ms.sessionId.slice(0, 8),
      toolUseId: null,
      parentAgentId: null,
      depth: 0,
      sessionId: ms.sessionId,
      project: ms.project,
      projectLabel: projectLabel(ms.project),
      workflowId: null,
      workflowName: null,
      ...summaryFields(s),
    });
  }

  computeDepths(invocations);
  return { invocations, cleanupPeriodDays, unpricedModels, configDirs };
}

interface Summary {
  tokens: Usage;
  cost: number;
  model: string;
  unpricedModel: boolean;
  startedAt: number;
  first: UsageLine;
}

/** Sum + price a transcript's deduped usage lines; null if it has none. */
function summarize(lines: UsageLine[], unpriced: Set<string>): Summary | null {
  if (lines.length === 0) return null;
  const tokens = emptyUsage();
  const perModel = new Map<string, number>(); // dominant model = most tokens
  let cost = 0;
  let unpricedModel = false;
  let startedAt = Number.POSITIVE_INFINITY;
  for (const l of lines) {
    addUsage(tokens, l.usage);
    const priced = priceUsage(l.usage, l.model, l.fast);
    cost += priced.cost;
    if (priced.unpriced) {
      unpricedModel = true;
      unpriced.add(l.model);
    }
    perModel.set(l.model, (perModel.get(l.model) ?? 0) + totalTokens(l.usage));
    startedAt = Math.min(startedAt, l.ts);
  }
  const model = [...perModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
  return { tokens, cost, model, unpricedModel, startedAt, first: lines[0]! };
}

function summaryFields(s: Summary) {
  return {
    slug: s.first.slug,
    model: s.model,
    startedAt: s.startedAt,
    tokens: s.tokens,
    cost: s.cost,
    unpricedModel: s.unpricedModel,
  };
}

/** depth 1 = spawned by main session; otherwise parent.depth + 1 (chains are shallow). */
function computeDepths(invs: Invocation[]): void {
  const byId = new Map(invs.map((i) => [i.agentId, i]));
  const depthOf = (i: Invocation, seen: Set<string>): number => {
    if (!i.parentAgentId || seen.has(i.agentId)) return 1;
    const parent = byId.get(i.parentAgentId);
    if (!parent) return 1; // parent not in our set -> treat as a root
    seen.add(i.agentId);
    return depthOf(parent, seen) + 1;
  };
  for (const i of invs) i.depth = depthOf(i, new Set());
}

export interface Group {
  key: string;
  label: string;
  cost: number; // total = main + sub
  mainCost: number;
  subCost: number;
  count: number; // every invocation
  subCount: number; // just the subagents
  tokens: Usage;
  unpriced: boolean;
}

type KeyFn = (i: Invocation) => [string, string];

function groupBy(invs: Invocation[], keyFn: KeyFn): Group[] {
  const map = new Map<string, Group>();
  for (const i of invs) {
    const [key, label] = keyFn(i);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        label,
        cost: 0,
        mainCost: 0,
        subCost: 0,
        count: 0,
        subCount: 0,
        tokens: emptyUsage(),
        unpriced: false,
      };
      map.set(key, g);
    }
    g.cost += i.cost;
    if (i.kind === "main") g.mainCost += i.cost;
    else {
      g.subCost += i.cost;
      g.subCount += 1;
    }
    g.count += 1;
    addUsage(g.tokens, i.tokens);
    g.unpriced ||= i.unpricedModel;
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

const dayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/** ISO-ish week label anchored to the Monday of the week (UTC). */
function weekKey(ts: number): string {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

const dayKeyFn: KeyFn = (i) => [dayKey(i.startedAt), dayKey(i.startedAt)];
const weekKeyFn: KeyFn = (i) => {
  const k = weekKey(i.startedAt);
  return [k, `week of ${k}`];
};
const sessionKeyFn: KeyFn = (i) => [i.sessionId, `${i.sessionId.slice(0, 8)} · ${i.projectLabel}`];
const typeKeyFn: KeyFn = (i) => [i.agentType, i.agentType];
const projectKeyFn: KeyFn = (i) => [i.project, i.projectLabel];
const modelKeyFn: KeyFn = (i) => [i.model, i.model];

export const groupByType = (invs: Invocation[]): Group[] => groupBy(invs, typeKeyFn);
export const groupByDay = (invs: Invocation[]): Group[] => groupBy(invs, dayKeyFn);
export const groupByWeek = (invs: Invocation[]): Group[] => groupBy(invs, weekKeyFn);
export const groupBySession = (invs: Invocation[]): Group[] => groupBy(invs, sessionKeyFn);
export const groupByProject = (invs: Invocation[]): Group[] => groupBy(invs, projectKeyFn);
export const groupByModel = (invs: Invocation[]): Group[] => groupBy(invs, modelKeyFn);

export interface TreeNode {
  inv: Invocation;
  children: TreeNode[];
  subtreeCost: number;
}

/** Build spawn forest: roots have no in-set parent; children link via parentAgentId. */
export function buildTree(invs: Invocation[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(
    invs.map((i) => [i.agentId, { inv: i, children: [], subtreeCost: 0 }]),
  );
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.inv.parentAgentId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const fill = (n: TreeNode): number => {
    n.subtreeCost = n.inv.cost + n.children.reduce((s, c) => s + fill(c), 0);
    n.children.sort((a, b) => b.subtreeCost - a.subtreeCost);
    return n.subtreeCost;
  };
  for (const r of roots) fill(r);
  return roots.sort((a, b) => b.subtreeCost - a.subtreeCost);
}
