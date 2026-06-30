import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  target: "node18",
  minify: true,
  clean: true,
  // cli-table3 + picocolors live in devDependencies, so tsdown bundles them in ->
  // the published package has zero runtime deps and the fastest npx/bunx cold-start.
  define: { __VERSION__: JSON.stringify(pkg.version) },
});
