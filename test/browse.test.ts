import { describe, expect, it } from "bun:test";
import { browseLines } from "../src/browse.js";
import { emptyUsage, type Invocation } from "../src/types.js";

const inv: Invocation = {
  kind: "subagent",
  agentId: "a1",
  agentType: "general-purpose",
  description: "Compare PDF to original",
  slug: null,
  model: "claude-opus-4-8",
  toolUseId: null,
  parentAgentId: null,
  depth: 1,
  sessionId: "abcdef1234567890",
  project: "p",
  projectLabel: "p",
  startedAt: Date.UTC(2026, 5, 24, 12),
  tokens: emptyUsage(),
  cost: 3.45,
  unpricedModel: false,
};

describe("browseLines", () => {
  it("hides sessionId as field 1 and ends each row with the cost", () => {
    const [sid, display] = browseLines([inv]).split("\t");
    expect(sid).toBe("abcdef1234567890"); // field 1 = full sessionId, fed to the preview
    expect(display).toContain("abcdef12"); // displayed row carries the short id...
    expect(display).toContain("2026-06-24"); // ...the day...
    expect(display!.trimEnd().endsWith("$3.45")).toBe(true); // ...and ends with cost
  });
});
