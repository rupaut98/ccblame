import { describe, expect, it } from "bun:test";
import { bar, groupSubs } from "../src/browse.js";
import { emptyUsage, type Invocation } from "../src/types.js";

// count the visible bar cells, ignoring the surrounding ANSI color codes
const cellCount = (s: string) => [...s].filter((c) => c === "█" || c === "░").length;

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
    startedAt: 0,
    tokens: emptyUsage(),
    cost: 1,
    unpricedModel: false,
    workflowId: null,
    workflowName: null,
    ...over,
  };
}

describe("groupSubs", () => {
  it("groups by key, sums cost, keeps members, costliest group first", () => {
    const groups = groupSubs(
      [
        inv({ project: "p1", cost: 1 }),
        inv({ project: "p2", cost: 5 }),
        inv({ project: "p1", cost: 2 }),
      ],
      (i) => [i.project, i.project],
    );
    expect(groups.map((g) => g.key)).toEqual(["p2", "p1"]); // p2=$5 outranks p1=$3
    expect(groups[1]!.cost).toBe(3);
    expect(groups[1]!.invs).toHaveLength(2);
  });

  it("sort:'writes' ranks by re-priming%, not absolute cost", () => {
    const prime = (frac: number) => ({ ...emptyUsage(), cache5m: frac });
    const groups = groupSubs(
      [
        inv({ project: "big", cost: 100, tokens: prime(1) }), // tiny re-priming%
        inv({ project: "leaky", cost: 5, tokens: prime(1_000_000) }), // high re-priming%
      ],
      (i) => [i.project, i.project],
      "writes",
    );
    expect(groups[0]!.key).toBe("leaky"); // worst offender first, despite lower spend
  });
});

describe("bar", () => {
  it("never throws and always renders exactly `width` cells", () => {
    for (const [c, p, m] of [
      [0, 0, 0],
      [1, 5, 1], // prime > cost (clamps, no negative repeat)
      [10, 10, 10],
      [3, 1, 10],
    ] as const) {
      expect(cellCount(bar(c, p, m))).toBe(10);
    }
  });
});
