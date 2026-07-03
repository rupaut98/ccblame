import { describe, expect, it } from "bun:test";
import { anchorProblems, priceUsage, type Rate, resolveRate } from "../src/cost.js";
import pricing from "../src/pricing.json" with { type: "json" };
import { emptyUsage } from "../src/types.js";

const key = (model: string) => {
  const r = resolveRate(model);
  return r === null ? null : "synthetic" in r ? "<synthetic>" : r.key;
};

describe("resolveRate", () => {
  it("matches exact ids, dated aliases, and versioned minors distinctly", () => {
    expect(key("claude-opus-4-5")).toBe("claude-opus-4-5"); // exact
    expect(key("claude-opus-4-5-20251101")).toBe("claude-opus-4-5"); // dated alias → base
    expect(key("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(key("claude-opus-4-1")).toBe("claude-opus-4-1"); // distinct minor, NOT folded into opus-4-8
    expect(key("CLAUDE-OPUS-4-5")).toBe("claude-opus-4-5"); // case-normalized
    expect(key("claude-opus-4-8[1m]")).toBe("claude-opus-4-8"); // 1M-context tier marker stripped
    expect(key("claude-haiku-4-5")).toBe("claude-haiku-4-5"); // current background model, from LiteLLM
    expect(key("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5"); // dated → base
  });

  it("gives up (unpriced) rather than guessing a nearest version", () => {
    expect(key("claude-opus-4-9")).toBeNull(); // newer than snapshot — the invariant-5 case
    expect(key("claude-opus-4-5-v2")).toBeNull(); // non-8-digit suffix ≠ dated alias
    expect(key("claude-opus-4")).toBeNull(); // bare-but-versionless family stem, not a key
    expect(key("claude-3-5-sonnet-20241022")).toBeNull(); // EOL, not in LiteLLM → unpriced, not guessed
    expect(key("claude-fable-6")).toBeNull(); // unknown fable point-release → unpriced, not the fable rate
    expect(key("claude-mythos-5")).toBeNull(); // Glasswing-only, not a Claude Code surface → unpriced, not guessed
    expect(key("gpt-5")).toBeNull(); // non-Anthropic
  });

  it("handles fable and synthetic", () => {
    expect(key("claude-fable-5")).toBe("claude-fable-5"); // exact, from LiteLLM
    expect(key("<synthetic>")).toBe("<synthetic>");
    expect(key("")).toBe("<synthetic>");
  });

  it("falls back to the flagship rate only for a bare family alias", () => {
    expect(key("opus")).toBe("opus");
    expect(key("haiku")).toBe("haiku");
    expect(key("fable")).toBe("fable"); // bare fable alias resolves via the family fallback
  });
});

describe("priceUsage", () => {
  it("prices each opus token class at the published rate", () => {
    const u = { ...emptyUsage(), input: 1_000_000 }; // 1M opus input @ $5/MTok
    expect(priceUsage(u, "claude-opus-4-8", false).cost).toBeCloseTo(5, 6);
  });

  it("prices an older, pricier model at ITS own rate, not the flagship", () => {
    const u = { ...emptyUsage(), input: 1_000_000 }; // opus-4-1 input is $15/MTok, not $5
    expect(priceUsage(u, "claude-opus-4-1", false).cost).toBeCloseTo(15, 6);
  });

  it("prices the 1M-context flagship variant, not $0", () => {
    const u = { ...emptyUsage(), input: 1_000_000 };
    expect(priceUsage(u, "claude-opus-4-8[1m]", false)).toEqual({ cost: 5, unpriced: false });
  });

  it("prices the current background model (haiku-4-5) straight from LiteLLM", () => {
    const u = { ...emptyUsage(), input: 1_000_000 }; // haiku-4-5 input is $1/MTok
    expect(priceUsage(u, "claude-haiku-4-5", false)).toEqual({ cost: 1, unpriced: false });
  });

  it("leaves a deprecated 3.5 model unpriced, not guessed", () => {
    const u = { ...emptyUsage(), input: 1_000_000 };
    expect(priceUsage(u, "claude-3-5-haiku-20241022", false)).toEqual({ cost: 0, unpriced: true });
  });

  it("prices a real summed invocation", () => {
    const u = { input: 3000, output: 2000, cache5m: 100_000, cache1h: 0, cacheRead: 500_000 };
    // 0.015 + 0.05 + 0.625 + 0.25
    expect(priceUsage(u, "claude-opus-4-8", false).cost).toBeCloseTo(0.94, 6);
  });

  it("flags unknown / newer-than-snapshot models instead of charging a guessed price", () => {
    const r = priceUsage({ ...emptyUsage(), input: 1_000_000 }, "claude-opus-4-9", false);
    expect(r).toEqual({ cost: 0, unpriced: true });
  });

  it("treats <synthetic> as free, not unpriced", () => {
    const r = priceUsage({ ...emptyUsage(), input: 1_000_000 }, "<synthetic>", false);
    expect(r).toEqual({ cost: 0, unpriced: false });
  });
});

describe("anchorProblems", () => {
  const snapshot = pricing as unknown as {
    families: Record<string, Rate>;
    models: Record<string, Rate>;
  };

  it("passes the committed snapshot (families + models)", () => {
    expect(anchorProblems(snapshot.families, snapshot.models)).toEqual([]);
  });

  it("catches a per-token↔per-million unit flip", () => {
    const flipped = { opus: rate(5e-6), sonnet: rate(3e-6), haiku: rate(1e-6) };
    expect(anchorProblems(flipped)).not.toEqual([]);
  });

  it("catches an inverted family order (values otherwise in-band)", () => {
    const inverted = { opus: rate(2), sonnet: rate(5), haiku: rate(1) }; // only monotonicity is violated
    expect(anchorProblems(inverted)).toEqual([
      expect.stringContaining("opus input < sonnet input"),
    ]);
  });

  it("catches a broken cache multiplier (5m or 1h)", () => {
    expect(
      anchorProblems({ opus: { ...rate(5), cache5m: 99 }, sonnet: rate(3), haiku: rate(1) }),
    ).not.toEqual([]);
    expect(
      anchorProblems({ opus: { ...rate(5), cache1h: 99 }, sonnet: rate(3), haiku: rate(1) }),
    ).not.toEqual([]);
  });

  it("validates the fable family when present but tolerates it missing", () => {
    const base = { opus: rate(5), sonnet: rate(3), haiku: rate(1) };
    expect(anchorProblems(base)).toEqual([]); // fable absent (LiteLLM may drop it) — not a problem
    expect(anchorProblems({ ...base, fable: rate(10) })).toEqual([]); // present + valid
    expect(anchorProblems({ ...base, fable: { ...rate(10), cacheRead: 99 } })).not.toEqual([]); // present + broken
  });

  it("catches a per-model input/output swap", () => {
    const models = { "claude-x": { ...rate(3), input: 15, output: 3 } };
    expect(anchorProblems({ opus: rate(5), sonnet: rate(3), haiku: rate(1) }, models)).not.toEqual(
      [],
    );
  });

  it("catches a silent $0 in a per-model row", () => {
    const models = { "claude-x": { ...rate(3), input: 0 } };
    expect(anchorProblems({ opus: rate(5), sonnet: rate(3), haiku: rate(1) }, models)).not.toEqual(
      [],
    );
  });
});

function rate(input: number): Rate {
  return {
    input,
    output: input * 5,
    cache5m: input * 1.25,
    cache1h: input * 2,
    cacheRead: input * 0.1,
  };
}
