import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("skills/live2d-pet/scripts", { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  logLevel: "info",
  banner: { js: "#!/usr/bin/env node" },
};

await Promise.all([
  build({ ...common, entryPoints: ["src/cli/index.ts"], outfile: "skills/live2d-pet/scripts/live2d.mjs" }),
  build({ ...common, entryPoints: ["src/mcp/index.ts"], outfile: "skills/live2d-pet/scripts/live2d-mcp.mjs" }),
]);
