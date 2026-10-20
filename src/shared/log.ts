import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  filePath: string | null;
}

export function createLogger(name: string, options?: { file?: string; level?: LogLevel; console?: boolean }): Logger {
  const level = options?.level ?? (process.env.LIVE2D_DEBUG ? "debug" : "info");
  const file = options?.file ?? null;
  const toConsole = options?.console ?? true;

  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const stat = fs.statSync(file);
      if (stat.size > 5 * 1024 * 1024) {
        fs.renameSync(file, file + ".1");
      }
    } catch {
      // The file may not exist yet.
    }
  }

  const write = (lvl: LogLevel, message: string, meta?: unknown) => {
    if (LEVEL_WEIGHT[lvl] < LEVEL_WEIGHT[level]) return;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      level: lvl,
      scope: name,
      message,
      ...(meta === undefined ? {} : { meta }),
    });
    if (file) {
      try { fs.appendFileSync(file, line + "\n"); } catch { /* ignore */ }
    }
    if (toConsole) {
      const fn = lvl === "error" ? console.error : lvl === "warn" ? console.warn : console.log;
      fn(line);
    }
  };

  return {
    debug: (m, meta) => write("debug", m, meta),
    info: (m, meta) => write("info", m, meta),
    warn: (m, meta) => write("warn", m, meta),
    error: (m, meta) => write("error", m, meta),
    filePath: file,
  };
}
