import { describe, expect, it } from "bun:test";
import { type Group, groupByDay } from "../src/aggregate.js";
import { emptyUsage, type Invocation } from "../src/types.js";

function inv(over: Partial<Invocation>): Invocation {
  return {
    kind: "subagent",
    agentId: "a",
    agentType: "general-purpose",
    description: "",
    slug: null,
    model: "claude-opus-4-8",
    toolUseId: null,
    parentAgentId: null,
    depth: 1,
    sessionId: "sess-1",
    project: "p",
    projectLabel: "p",
    startedAt: Date.UTC(2026, 5, 12, 10),
    tokens: emptyUsage(),
    cost: 1,
    unpricedModel: false,
    ...over,
  };
}

const D1 = Date.UTC(2026, 5, 12, 10);
const D2 = Date.UTC(2026, 5, 13, 10);
const sample: Invocation[] = [
  inv({ kind: "main", agentId: "m1", sessionId: "s1", startedAt: D1, cost: 8 }),
  inv({ agentId: "a1", sessionId: "s1", agentType: "fork", startedAt: D1, cost: 2 }),
  inv({ agentId: "a2", sessionId: "s1", agentType: "fork", startedAt: D1, cost: 1 }),
  inv({ kind: "main", agentId: "m2", sessionId: "s2", startedAt: D2, cost: 5 }),
  inv({ agentId: "a3", sessionId: "s2", agentType: "Explore", startedAt: D2, cost: 4 }),
];

describe("groupBy split totals", () => {
  it("main + sub reconciles to the group total, subCount counts only subagents", () => {
    for (const g of groupByDay(sample)) {
      expect(g.mainCost + g.subCost).toBeCloseTo(g.cost, 9);
    }
    const d1 = groupByDay(sample).find((g) => g.key === "2026-06-12") as Group;
    expect(d1.mainCost).toBe(8);
    expect(d1.subCost).toBe(3);
    expect(d1.subCount).toBe(2); // the two forks, not the main thread
  });
});
