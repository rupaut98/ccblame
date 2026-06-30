import { describe, expect, it } from "bun:test";
import { priceUsage, resolveFamily } from "../src/cost.js";
import { emptyUsage } from "../src/types.js";

describe("resolveFamily", () => {
  it("matches Anthropic families through version/date suffixes", () => {
    expect(resolveFamily("claude-opus-4-8")).toBe("opus");
    expect(resolveFamily("claude-sonnet-4-6")).toBe("sonnet");
    expect(resolveFamily("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(resolveFamily("<synthetic>")).toBe("<synthetic>");
    expect(resolveFamily("gpt-5")).toBeNull();
  });
});

describe("priceUsage", () => {
  it("prices each opus token class at the published rate", () => {
    const u = { ...emptyUsage(), input: 1_000_000 }; // 1M opus input @ $5/MTok
    expect(priceUsage(u, "claude-opus-4-8", false).cost).toBeCloseTo(5, 6);
  });

  it("prices a real summed invocation", () => {
    // input 3000, output 2000, cache5m 100k, cacheRead 500k on opus
    const u = { input: 3000, output: 2000, cache5m: 100_000, cache1h: 0, cacheRead: 500_000 };
    // 0.015 + 0.05 + 0.625 + 0.25
    expect(priceUsage(u, "claude-opus-4-8", false).cost).toBeCloseTo(0.94, 6);
  });

  it("flags unknown models instead of silently charging $0", () => {
    const r = priceUsage({ ...emptyUsage(), input: 1_000_000 }, "some-new-model", false);
    expect(r.cost).toBe(0);
    expect(r.unpriced).toBe(true);
  });

  it("treats <synthetic> as free, not unpriced", () => {
    const r = priceUsage({ ...emptyUsage(), input: 1_000_000 }, "<synthetic>", false);
    expect(r).toEqual({ cost: 0, unpriced: false });
  });
});
