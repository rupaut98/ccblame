import pricing from "./pricing.json" with { type: "json" };
import type { Usage } from "./types.js";

// ponytail: Claude Code "fast"/priority pricing multiplier is unverified and current transcripts
// carry no speed flag, so this is effectively dormant. Set the real factor here once confirmed.
const FAST_MULTIPLIER = 1;

interface Rate {
  input: number;
  output: number;
  cache5m: number;
  cache1h: number;
  cacheRead: number;
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
    (usage.input * r.input +
      usage.output * r.output +
      usage.cache5m * r.cache5m +
      usage.cache1h * r.cache1h +
      usage.cacheRead * r.cacheRead) /
    1e6;
  return { cost: cost * (fast ? FAST_MULTIPLIER : 1), unpriced: false };
}
