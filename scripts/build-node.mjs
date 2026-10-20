import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
};

await Promise.all([
  build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main.cjs", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.cjs", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/cli/index.ts"], outfile: "dist/cli.mjs", format: "esm", banner: { js: "#!/usr/bin/env node" } }),
  build({ ...common, entryPoints: ["src/mcp/index.ts"], outfile: "dist/mcp.mjs", format: "esm", banner: { js: "#!/usr/bin/env node" } }),
]);
