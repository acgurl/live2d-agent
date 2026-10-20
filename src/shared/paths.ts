import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = process.env.LIVE2D_AGENT_HOME?.trim();
export const RUNTIME_DIR = home && home.length > 0 ? path.resolve(home) : path.join(os.homedir(), ".live2d-agent");
export const MODELS_DIR = path.join(RUNTIME_DIR, "models");
export const CORE_DIR = path.join(RUNTIME_DIR, "core");
export const CORE_FILE = path.join(CORE_DIR, "live2dcubismcore.min.js");
export const BIN_DIR = path.join(RUNTIME_DIR, "bin");
export const LOG_DIR = path.join(RUNTIME_DIR, "logs");
export const SCREENSHOT_DIR = path.join(RUNTIME_DIR, "screenshots");
export const AUDIO_DIR = path.join(RUNTIME_DIR, "audio");
export const INSTALL_FILE = path.join(RUNTIME_DIR, "install.json");
export const RUNTIME_FILE = path.join(RUNTIME_DIR, "runtime.json");
export const CONFIG_FILE = path.join(RUNTIME_DIR, "config.json");
export const LOG_FILE = path.join(LOG_DIR, "app.log");

export function ensureRuntimeDirsSync(): void {
  for (const dir of [RUNTIME_DIR, MODELS_DIR, CORE_DIR, BIN_DIR, LOG_DIR, SCREENSHOT_DIR, AUDIO_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function ensureRuntimeDirs(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await Promise.all([RUNTIME_DIR, MODELS_DIR, CORE_DIR, BIN_DIR, LOG_DIR, SCREENSHOT_DIR, AUDIO_DIR].map((dir) => mkdir(dir, { recursive: true })));
}
