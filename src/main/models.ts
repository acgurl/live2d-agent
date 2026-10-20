import fs from "node:fs/promises";
import path from "node:path";
import { MODELS_DIR } from "../shared/paths";
import { normalizeModelConfig, type ModelConfig } from "../shared/config";
import { AgentError } from "../shared/errors";
import type { ModelSummary } from "../shared/protocol";

export interface ResolvedModel extends ModelSummary {
  dir: string;
  entry: string;
  config: ModelConfig;
  json: Record<string, unknown>;
}

function assertModelId(id: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new AgentError("BAD_REQUEST", "Invalid model id: " + id);
  }
}

async function findEntry(dir: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".model3.json")).map((entry) => entry.name).sort();
  return candidates[0] ?? null;
}

function assertRelativeRef(ref: unknown, field: string): string {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new AgentError("MODEL_INVALID", "model3.json field " + field + " must be a non-empty string.");
  }
  if (ref.includes("://") || path.isAbsolute(ref) || ref.startsWith("\\")) {
    throw new AgentError("MODEL_INVALID", "model3.json field " + field + " must be a relative path: " + ref);
  }
  const normalized = ref.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw new AgentError("MODEL_INVALID", "model3.json field " + field + " escapes the model directory: " + ref);
  }
  return normalized;
}

async function assertInside(baseDir: string, ref: string, field: string): Promise<void> {
  const target = path.resolve(baseDir, ref);
  const rel = path.relative(baseDir, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AgentError("MODEL_INVALID", "model3.json field " + field + " escapes the model directory: " + ref);
  }
  try {
    const realBase = await fs.realpath(baseDir);
    const realTarget = await fs.realpath(target);
    const realRel = path.relative(realBase, realTarget);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      throw new AgentError("MODEL_INVALID", "model3.json field " + field + " resolves outside the model directory: " + ref);
    }
    const stat = await fs.stat(realTarget);
    if (!stat.isFile()) {
      throw new AgentError("MODEL_INVALID", "model3.json field " + field + " is not a file: " + ref);
    }
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("MODEL_INVALID", "Missing file for model3.json field " + field + ": " + ref, { cause: error });
  }
}

export async function validateModelJson(dir: string, entry: string): Promise<Record<string, unknown>> {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(await fs.readFile(path.join(dir, entry), "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new AgentError("MODEL_INVALID", "Cannot read model3.json: " + entry, { cause: error });
  }
  const refs = json.FileReferences;
  if (!refs || typeof refs !== "object") {
    throw new AgentError("MODEL_INVALID", "model3.json is missing FileReferences.");
  }
  const fileRefs = refs as Record<string, unknown>;
  const moc = assertRelativeRef(fileRefs.Moc, "FileReferences.Moc");
  await assertInside(dir, moc, "FileReferences.Moc");
  const textures = fileRefs.Textures;
  if (!Array.isArray(textures) || textures.length === 0) {
    throw new AgentError("MODEL_INVALID", "model3.json must reference at least one texture.");
  }
  for (let i = 0; i < textures.length; i++) {
    const ref = assertRelativeRef(textures[i], "FileReferences.Textures[" + i + "]");
    await assertInside(dir, ref, "FileReferences.Textures[" + i + "]");
  }
  if (fileRefs.Physics !== undefined) await assertInside(dir, assertRelativeRef(fileRefs.Physics, "FileReferences.Physics"), "FileReferences.Physics");
  if (fileRefs.Pose !== undefined) await assertInside(dir, assertRelativeRef(fileRefs.Pose, "FileReferences.Pose"), "FileReferences.Pose");
  if (fileRefs.UserData !== undefined) await assertInside(dir, assertRelativeRef(fileRefs.UserData, "FileReferences.UserData"), "FileReferences.UserData");
  if (fileRefs.DisplayInfo !== undefined) await assertInside(dir, assertRelativeRef(fileRefs.DisplayInfo, "FileReferences.DisplayInfo"), "FileReferences.DisplayInfo");
  if (Array.isArray(fileRefs.Expressions)) {
    for (let i = 0; i < fileRefs.Expressions.length; i++) {
      const expression = fileRefs.Expressions[i] as Record<string, unknown> | undefined;
      if (expression?.File !== undefined) {
        await assertInside(dir, assertRelativeRef(expression.File, "FileReferences.Expressions[" + i + "].File"), "FileReferences.Expressions[" + i + "].File");
      }
    }
  }
  if (fileRefs.Motions && typeof fileRefs.Motions === "object") {
    for (const [group, list] of Object.entries(fileRefs.Motions as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (let i = 0; i < list.length; i++) {
        const motion = list[i] as Record<string, unknown> | undefined;
        if (motion?.File !== undefined) {
          await assertInside(dir, assertRelativeRef(motion.File, "FileReferences.Motions." + group + "[" + i + "].File"), "FileReferences.Motions." + group + "[" + i + "].File");
        }
      }
    }
  }
  return json;
}

export async function listModels(): Promise<ModelSummary[]> {
  let entries;
  try {
    entries = await fs.readdir(MODELS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const models: ModelSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(MODELS_DIR, entry.name);
    const modelEntry = await findEntry(dir);
    if (!modelEntry) continue;
    const config = await readModelConfig(dir);
    models.push({ id: entry.name, displayName: config.displayName ?? entry.name, entry: modelEntry });
  }
  models.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return models;
}

export async function readModelConfig(dir: string): Promise<ModelConfig> {
  try {
    const raw = await fs.readFile(path.join(dir, "live2d-agent.json"), "utf8");
    return normalizeModelConfig(JSON.parse(raw.replace(/^\uFEFF/, "")));
  } catch {
    return {};
  }
}

export async function resolveModel(id: string): Promise<ResolvedModel> {
  assertModelId(id);
  const dir = path.join(MODELS_DIR, id);
  const realBase = await fs.realpath(MODELS_DIR).catch(() => MODELS_DIR);
  let realDir: string;
  try {
    realDir = await fs.realpath(dir);
  } catch (error) {
    throw new AgentError("MODEL_MISSING", "Model not found: " + id, { details: { modelsDir: MODELS_DIR }, cause: error });
  }
  const rel = path.relative(realBase, realDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AgentError("MODEL_INVALID", "Model id resolves outside the models directory: " + id);
  }
  const entry = await findEntry(realDir);
  if (!entry) {
    throw new AgentError("MODEL_MISSING", "No .model3.json found in model directory: " + id);
  }
  const json = await validateModelJson(realDir, entry);
  const config = await readModelConfig(realDir);
  const displayName = config.displayName ?? id;
  return { id, displayName, entry, dir: realDir, config, json };
}
