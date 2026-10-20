import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  base: "/",
  build: {
    outDir: resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/core": "http://127.0.0.1:47100",
      "/models": "http://127.0.0.1:47100",
      "/audio": "http://127.0.0.1:47100",
    },
  },
});
