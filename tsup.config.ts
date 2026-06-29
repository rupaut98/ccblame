import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node18",
  bundle: true,
  minify: true,
  clean: true,
  // single self-contained file with a shebang -> npx fetches/runs one file, no dep tree to resolve
  banner: { js: "#!/usr/bin/env node" },
  noExternal: [/.*/],
});
