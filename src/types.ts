export interface Usage {
  input: number;
  output: number;
  cache5m: number; // ephemeral 5m cache *writes*
  cache1h: number; // ephemeral 1h cache *writes*
  cacheRead: number;
}

/** One accepted assistant usage line from a subagent transcript, after dedup. */
export interface UsageLine {
  msgId: string;
  requestId: string;
  model: string;
  isSidechain: boolean;
  fast: boolean;
  ts: number; // epoch ms
  usage: Usage;
  slug: string | null;
  attributionAgent: string | null;
}

/** One subagent invocation = one agent-<id>.jsonl + its .meta.json sidecar. */
export interface Invocation {
  kind: "subagent" | "main"; // "main" = a session's orchestrator thread (not a subagent)
  agentId: string;
  agentType: string; // meta.agentType (or attributionAgent / "‹unknown agent›")
  description: string;
  slug: string | null;
  model: string;
  toolUseId: string | null; // parent join key
  parentAgentId: string | null; // null => spawned by the main session
  depth: number; // 1 = spawned by main session
  sessionId: string;
  project: string; // encoded project dir name
  projectLabel: string; // human-ish
  startedAt: number; // epoch ms of first line
  tokens: Usage;
  cost: number;
  unpricedModel: boolean; // true => no price row found, cost is a floor not a total
  // Workflow-spawned subagents only; recovered from the run manifest.
  workflowId: string | null; // wf_<id>, the run this agent belongs to
  workflowName: string | null;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheRead: 0 };
}

export function addUsage(a: Usage, b: Usage): void {
  a.input += b.input;
  a.output += b.output;
  a.cache5m += b.cache5m;
  a.cache1h += b.cache1h;
  a.cacheRead += b.cacheRead;
}

export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cache5m + u.cache1h + u.cacheRead;
}
