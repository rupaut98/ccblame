import pricing from "./pricing.json" with { type: "json" };
import type { Usage } from "./types.js";

// ponytail: no verified fast/priority multiplier yet — dormant.
const FAST_MULTIPLIER = 1;

export interface Rate {
  input: number;
  output: number;
  cache5m: number;
  cache1h: number;
  cacheRead: number;
}

interface PriceData {
  _meta: { lastUpdated: string; [k: string]: unknown };
  families: Record<string, Rate>;
  models: Record<string, Rate>;
}

const DATA = pricing as unknown as PriceData;
const MODELS = DATA.models;
const FAMILIES = DATA.families;

export const pricingSnapshot = (): string => DATA._meta.lastUpdated;

export type Resolved = { key: string; rate: Rate } | { synthetic: true } | null;

// An id not in the snapshot resolves to null (unpriced) — never a nearest-version guess.
export function resolveRate(model: string): Resolved {
  // [1m] tier prices above 200k, which the flat schema can't apply; base rate is the honest floor.
  const m = model
    .trim()
    .toLowerCase()
    .replace(/\[\d+m\]$/, "");
  if (m === "<synthetic>" || m === "") return { synthetic: true };

  const exact = MODELS[m];
  if (exact) return { key: m, rate: exact };

  const base = m.replace(/-\d{8}$/, "");
  const dated = base !== m ? MODELS[base] : undefined;
  if (dated) return { key: base, rate: dated };

  const fam = FAMILIES[m]; // bare family alias only; never a versioned id
  if (fam) return { key: m, rate: fam };

  return null;
}

export interface Priced {
  cost: number;
  unpriced: boolean;
}

export function priceUsage(usage: Usage, model: string, fast: boolean): Priced {
  const res = resolveRate(model);
  if (res === null) return { cost: 0, unpriced: true };
  if ("synthetic" in res) return { cost: 0, unpriced: false };
  const r = res.rate;
  const cost =
    (usage.input * r.input +
      usage.output * r.output +
      usage.cache5m * r.cache5m +
      usage.cache1h * r.cache1h +
      usage.cacheRead * r.cacheRead) /
    1e6;
  return { cost: cost * (fast ? FAST_MULTIPLIER : 1), unpriced: false };
}

// Coarse guard on generated pricing (USD/M): catches a unit flip, fat-finger, or silent $0. The PR diff is the real gate.
export function anchorProblems(
  families: Record<string, Rate>,
  models: Record<string, Rate> = {},
): string[] {
  const problems: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 0.02 + 1e-9;
  const outRatio = (r: Rate) => r.output >= 3 * r.input && r.output <= 8 * r.input;
  // Fixed Anthropic cache multipliers on the base input: 5m write 1.25×, 1h write 2×, read 0.1×.
  const ratioProblems = (fam: string, r: Rate): string[] => {
    const out: string[] = [];
    if (!outRatio(r)) out.push(`${fam} output ${r.output} not 3–8× input ${r.input}`);
    if (!near(r.cache5m, 1.25 * r.input)) out.push(`${fam} cache5m ${r.cache5m} ≠ 1.25× input`);
    if (!near(r.cache1h, 2 * r.input)) out.push(`${fam} cache1h ${r.cache1h} ≠ 2× input`);
    if (!near(r.cacheRead, 0.1 * r.input)) out.push(`${fam} cacheRead ${r.cacheRead} ≠ 0.1× input`);
    return out;
  };
  const bounds: Record<string, [number, number]> = {
    opus: [2, 25],
    sonnet: [1, 15],
    haiku: [0.2, 6],
  };
  for (const [fam, [lo, hi]] of Object.entries(bounds)) {
    const r = families[fam];
    if (!r) {
      problems.push(`missing family: ${fam}`);
      continue;
    }
    if (!(r.input >= lo && r.input <= hi))
      problems.push(`${fam} input ${r.input} outside [${lo},${hi}] /M`);
    problems.push(...ratioProblems(fam, r));
  }
  // fable is optional (LiteLLM may not list it) — validate only when present, no monotonicity chain.
  if (families.fable) {
    if (!(families.fable.input >= 1 && families.fable.input <= 50))
      problems.push(`fable input ${families.fable.input} outside [1,50] /M`);
    problems.push(...ratioProblems("fable", families.fable));
  }
  const o = families.opus?.input;
  const s = families.sonnet?.input;
  const h = families.haiku?.input;
  if (o != null && s != null && o < s) problems.push(`opus input < sonnet input (${o} < ${s})`);
  if (s != null && h != null && s < h) problems.push(`sonnet input < haiku input (${s} < ${h})`);
  // Per-model: finite/positive + output-ratio only, NOT cache ratios — legacy models like
  // claude-3-haiku predate the fixed multipliers and would false-fail (the human-diff gate's job).
  for (const [modelKey, r] of Object.entries(models)) {
    for (const [k, v] of Object.entries(r)) {
      if (!Number.isFinite(v) || v < 0) problems.push(`${modelKey}.${k} not finite/≥0: ${v}`);
    }
    if (!(r.input > 0)) problems.push(`${modelKey} input not > 0: ${r.input}`);
    if (!outRatio(r)) problems.push(`${modelKey} output ${r.output} not 3–8× input ${r.input}`);
  }
  return problems;
}
