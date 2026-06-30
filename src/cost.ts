import pricing from "./pricing.json" with { type: "json" };
import type { Usage } from "./types.js";

// ponytail: Claude Code "fast"/priority pricing multiplier is unverified and current transcripts
// carry no speed flag, so this is effectively dormant. Set the real factor here once confirmed.
const FAST_MULTIPLIER = 1;
const TIER = 200_000;

interface Rate {
  input: number;
  output: number;
  cache5m: number;
  cache1h: number;
  cacheRead: number;
  inputAbove?: number;
  outputAbove?: number;
  cache5mAbove?: number;
  cache1hAbove?: number;
  cacheReadAbove?: number;
}

const FAMILIES = pricing as unknown as Record<string, Rate>;

/** Map a model id to a price family, tolerating date/version suffixes and new point releases. */
export function resolveFamily(model: string): string | null {
  const m = model.toLowerCase();
  if (m === "<synthetic>") return "<synthetic>";
  if (m.includes("fable") || m.includes("mythos")) return "fable"; // same pricing
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return null;
}

function tiered(tokens: number, base: number, above: number | undefined): number {
  const hi = above ?? base;
  if (tokens <= TIER || hi === base) return (tokens / 1e6) * base;
  return (TIER / 1e6) * base + ((tokens - TIER) / 1e6) * hi;
}

export interface Priced {
  cost: number;
  unpriced: boolean; // true => no price row; cost is 0 and the model should be surfaced loudly
}

export function priceUsage(usage: Usage, model: string, fast: boolean): Priced {
  const fam = resolveFamily(model);
  if (fam === "<synthetic>") return { cost: 0, unpriced: false };
  if (!fam) return { cost: 0, unpriced: true };
  const r = FAMILIES[fam]!;
  const cost =
    tiered(usage.input, r.input, r.inputAbove) +
    tiered(usage.output, r.output, r.outputAbove) +
    tiered(usage.cache5m, r.cache5m, r.cache5mAbove) +
    tiered(usage.cache1h, r.cache1h, r.cache1hAbove) +
    tiered(usage.cacheRead, r.cacheRead, r.cacheReadAbove);
  return { cost: cost * (fast ? FAST_MULTIPLIER : 1), unpriced: false };
}
