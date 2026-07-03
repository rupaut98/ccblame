// Regenerate src/pricing.json from LiteLLM. Dev/CI only — never fetched at runtime.
//   bun scripts/gen-pricing.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { anchorProblems, type Rate } from "../src/cost.js";

const URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** per-token → per-million (5e-6 → 5). */
const perM = (x: unknown): number => (typeof x === "number" ? Math.round(x * 1e12) / 1e6 : 0);

/** Version digits, minus a trailing date so it can't dwarf the version number. */
const version = (key: string): number[] =>
  (key.replace(/-\d{8}$/, "").match(/\d+/g) ?? []).map(Number);
const cmpVersion = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

// biome-ignore lint/suspicious/noExplicitAny: upstream LiteLLM schema is untyped JSON
const raw = (await (await fetch(URL)).json()) as Record<string, any>;

const models: Record<string, Rate> = {};
for (const [key, v] of Object.entries(raw)) {
  if (key === "sample_spec") continue;
  if (v?.litellm_provider !== "anthropic") continue;
  if (!/^claude-/.test(key)) continue; // drop "anthropic.claude-…" bedrock keys
  if (key.includes("/") || key.includes(":")) continue; // drop provider/arn dupes
  if (v.mode && v.mode !== "chat") continue;
  const input = perM(v.input_cost_per_token);
  models[key] = {
    input,
    output: perM(v.output_cost_per_token),
    cache5m: perM(v.cache_creation_input_token_cost),
    cache1h: 2 * input, // fixed 2× input; LiteLLM's _above_1hr is missing/junk, so derive it
    cacheRead: perM(v.cache_read_input_token_cost),
  };
}

// Drop a dated key when its base exists — resolveRate aliases dates anyway.
for (const key of Object.keys(models)) {
  const base = key.replace(/-\d{8}$/, "");
  if (base !== key && models[base]) delete models[key];
}

// families = newest flagship per family — the fallback for bare aliases ("opus", "fable", …).
const families: Record<string, Rate> = {};
for (const fam of ["opus", "sonnet", "haiku", "fable"]) {
  const flagship = Object.keys(models)
    .filter((k) => k.includes(fam))
    .sort((a, b) => cmpVersion(version(a), version(b)))
    .at(-1);
  if (flagship) families[fam] = models[flagship]!;
}

const problems = anchorProblems(families, models);
if (problems.length) {
  console.error(`anchor validation failed — refusing to write pricing.json:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
const out = {
  _meta: {
    source: "LiteLLM model_prices_and_context_window.json (anthropic)",
    lastUpdated: new Date().toISOString().slice(0, 10),
    unit: "USD per million tokens",
    note: "Keyed by exact model id; families = newest flagship per family (fallback for bare aliases). cache1h derived as 2× input (Anthropic's fixed 1h rate). LiteLLM >200k long-context tier omitted (ccblame's flat schema can't apply a per-request tier). A model LiteLLM doesn't list is treated as deprecated and left unpriced.",
  },
  families,
  models: sorted,
};

writeFileSync(join(process.cwd(), "src", "pricing.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote src/pricing.json — ${Object.keys(sorted).length} models, ${Object.keys(families).length} families`);
