import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CONFIG_FILE } from "./paths";

export const appConfigSchema = z.object({
  version: z.literal(1),
  model: z.string().regex(/^[A-Za-z0-9._-]+$/).max(128).nullable(),
  window: z.object({
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().min(200).max(4000),
    height: z.number().int().min(200).max(4000),
    alwaysOnTop: z.boolean(),
    clickThrough: z.boolean(),
    visible: z.boolean(),
  }),
  render: z.object({
    scale: z.number().min(0.1).max(4),
    opacity: z.number().min(0).max(1),
    bubbleAreaHeight: z.number().int().min(0).max(400),
  }),
  behavior: z.object({
    idleMotion: z.boolean(),
    gazeFollow: z.boolean(),
    autoBlink: z.boolean(),
    defaultExpression: z.string().max(128).nullable(),
  }),
  bubble: z.object({
    enabled: z.boolean(),
    ttlMs: z.number().int().min(0).max(600_000),
    maxChars: z.number().int().min(20).max(2000),
    maxRows: z.number().int().min(1).max(20),
    fontSize: z.number().int().min(10).max(48),
    color: z.string().max(64),
    background: z.string().max(64),
  }),
  speech: z.object({
    tts: z.boolean(),
    voice: z.string().max(256).nullable(),
    rate: z.number().min(0.5).max(2),
    pitch: z.number().min(0).max(2),
    ttsMouth: z.boolean(),
  }),
  server: z.object({
    port: z.number().int().min(1024).max(65535),
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  model: null,
  window: { width: 420, height: 720, alwaysOnTop: true, clickThrough: false, visible: true },
  render: { scale: 1, opacity: 1, bubbleAreaHeight: 140 },
  behavior: { idleMotion: true, gazeFollow: true, autoBlink: true, defaultExpression: null },
  bubble: { enabled: true, ttlMs: 8000, maxChars: 280, maxRows: 3, fontSize: 16, color: "#ffffff", background: "rgba(20, 20, 28, 0.78)" },
  speech: { tts: false, voice: null, rate: 1, pitch: 1, ttsMouth: true },
  server: { port: 47100 },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : (patch as T));
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result as T;
}

export function normalizeConfig(input: unknown): AppConfig {
  return appConfigSchema.parse(deepMerge(DEFAULT_CONFIG, input ?? {}));
}

export async function readConfigFile(file: string = CONFIG_FILE): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return normalizeConfig({});
  }
}

export async function writeConfigFile(config: AppConfig, file: string = CONFIG_FILE): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n");
  await fs.rename(tmp, file);
}

export const hitActionSchema = z.object({
  motion: z.object({ group: z.string().min(1).max(128), index: z.number().int().min(0).optional() }).strict().optional(),
  expression: z.string().max(128).optional(),
  say: z.string().max(280).optional(),
}).strict();

export const modelConfigSchema = z.object({
  displayName: z.string().max(128).optional(),
  scale: z.number().min(0.1).max(4).optional(),
  offsetX: z.number().min(-1).max(1).optional(),
  offsetY: z.number().min(-1).max(1).optional(),
  idleGroup: z.string().max(128).optional(),
  defaultExpression: z.string().max(128).optional(),
  hitActions: z.record(z.string().max(128), hitActionSchema).optional(),
  bubbleAnchor: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict().optional(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

export function normalizeModelConfig(input: unknown): ModelConfig {
  try {
    return modelConfigSchema.parse(input ?? {});
  } catch {
    return {};
  }
}
