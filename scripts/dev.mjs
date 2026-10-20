import { spawn } from "node:child_process";
import { createServer } from "vite";

const server = await createServer({ configFile: "vite.config.ts" });
await server.listen();
server.printUrls();

const port = server.config.server.port;
const electronBin = process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/.bin/electron";
const child = spawn(electronBin, ["."], {
  stdio: "inherit",
  env: (() => { const env = { ...process.env, LIVE2D_DEV_URL: "http://localhost:" + port, LIVE2D_PORT: "47100" }; delete env.ELECTRON_RUN_AS_NODE; return env; })(),
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
