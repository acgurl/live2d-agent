#!/usr/bin/env node
/**
 * Shared Live2D model catalog and installer helpers.
 *
 * Used by:
 *   - scripts/setup.mjs          (one-command setup)
 *   - scripts/setup-models.mjs   (install catalog models without a full rebuild)
 *
 * The repository keeps installation defaults in two editable files:
 *   live2d.config.json  -> core URL, catalog path, default model, install list
 *   live2d.models.json  -> reusable model definitions keyed by model id
 *
 * Models are installed under <runtime>/models/<id>. The runtime directory is
 * controlled by LIVE2D_AGENT_HOME (default: ~/.live2d-agent).
 */

import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const MODEL_ID_RE = /^[A-Za-z0-9._-]+$/;

const MODEL_CONFIG_KEYS = [
  "displayName",
  "scale",
  "offsetX",
  "offsetY",
  "idleGroup",
  "defaultExpression",
  "bubbleAnchor",
  "hitActions",
];

const CATALOG_ENTRY_KEYS = new Set(["displayName", "url", "variant", "scale", "sha256", "size", "offsetX", "offsetY", "idleGroup", "defaultExpression", "bubbleAnchor", "hitActions"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function assertModelId(id, label = "model id") {
  if (typeof id !== "string" || !MODEL_ID_RE.test(id) || id === "." || id === ".." || id.length > 128) {
    throw new Error(label + " must match [A-Za-z0-9._-]+ (max 128 characters): " + JSON.stringify(id));
  }
  return id;
}

async function readJsonFile(file, label) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    throw new Error("Cannot read " + label + " " + file + ": " + messageOf(error), { cause: error });
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error("Invalid JSON in " + label + " " + file + ": " + messageOf(error), { cause: error });
  }
}

/**
 * Read and validate the main live2d.config.json installation config.
 */
export async function loadMainConfig(file) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    throw new Error("Cannot read setup config " + file + ". Run from the repository root or pass --config.", { cause: error });
  }
  let config;
  try {
    config = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error("Invalid JSON in " + file + ": " + messageOf(error), { cause: error });
  }
  if (!isPlainObject(config)) throw new Error(file + " must contain a JSON object.");
  if (config.version !== 1) throw new Error("Unsupported setup config version; expected version 1.");
  if (!isPlainObject(config.core)) throw new Error("live2d.config.json: core must be an object.");
  if (config.models !== undefined) {
    if (!isPlainObject(config.models)) throw new Error("live2d.config.json: models must be an object.");
    if (config.models.file !== undefined && (typeof config.models.file !== "string" || config.models.file.trim().length === 0)) {
      throw new Error("live2d.config.json: models.file must be a non-empty string.");
    }
    if (config.models.default !== undefined) assertModelId(config.models.default, "live2d.config.json models.default");
    if (config.models.install !== undefined) {
      if (!Array.isArray(config.models.install) || config.models.install.length === 0) {
        throw new Error("live2d.config.json: models.install must be a non-empty array of model ids.");
      }
      for (const id of config.models.install) assertModelId(id, "live2d.config.json models.install");
    }
  }
  if (config.model !== undefined && typeof config.model !== "string" && !isPlainObject(config.model)) {
    throw new Error("live2d.config.json: model must be a model id string or a legacy model object.");
  }
  if (!isPlainObject(config.setup)) config.setup = {};
  return config;
}

function optionalString(value, field, maxLength = 256) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(field + " must be a non-empty string of at most " + maxLength + " characters.");
  }
  return value;
}

function optionalScale(value) {
  if (value === undefined) return undefined;
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 4) throw new Error("scale must be a number between 0.1 and 4.");
  return scale;
}

function optionalOffset(value, field) {
  if (value === undefined) return undefined;
  const offset = Number(value);
  if (!Number.isFinite(offset) || offset < -1 || offset > 1) throw new Error(field + " must be a number between -1 and 1.");
  return offset;
}

/**
 * Validate and normalize one catalog entry.
 * @param {string} id
 * @param {unknown} input
 * @param {string} source
 */
export function normalizeModelSpec(id, input, source = "model catalog") {
  assertModelId(id, source + " id");
  if (!isPlainObject(input)) throw new Error(source + ' entry "' + id + '" must be an object.');
  for (const key of Object.keys(input)) {
    if (!CATALOG_ENTRY_KEYS.has(key)) {
      throw new Error(source + ' entry "' + id + '" has an unknown field "' + key + '". Allowed: ' + [...CATALOG_ENTRY_KEYS].join(", "));
    }
  }

  const spec = { id };
  const displayName = optionalString(input.displayName, source + " " + id + ".displayName", 128);
  if (displayName !== undefined) spec.displayName = displayName;

  if (input.url !== undefined) {
    const url = optionalString(input.url, source + " " + id + ".url", 2048);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(source + " " + id + ".url is not a valid URL: " + url);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(source + " " + id + ".url must use http or https: " + url);
    }
    spec.url = url;
  }

  if (input.variant !== undefined) {
    const variant = optionalString(input.variant, source + " " + id + ".variant", 256).replace(/\\/g, "/").replace(/\/+$/, "");
    if (variant.split("/").includes("..")) throw new Error(source + " " + id + ".variant must not contain '..'.");
    spec.variant = variant;
  }

  const scale = optionalScale(input.scale);
  if (scale !== undefined) spec.scale = scale;
  const offsetX = optionalOffset(input.offsetX, source + " " + id + ".offsetX");
  if (offsetX !== undefined) spec.offsetX = offsetX;
  const offsetY = optionalOffset(input.offsetY, source + " " + id + ".offsetY");
  if (offsetY !== undefined) spec.offsetY = offsetY;

  if (input.sha256 !== undefined) {
    if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.sha256)) {
      throw new Error(source + " " + id + ".sha256 must be 64 hexadecimal characters.");
    }
    spec.sha256 = input.sha256.toLowerCase();
  }
  if (input.size !== undefined) {
    if (!Number.isInteger(input.size) || input.size <= 0) throw new Error(source + " " + id + ".size must be a positive integer.");
    spec.size = input.size;
  }

  const idleGroup = optionalString(input.idleGroup, source + " " + id + ".idleGroup", 128);
  if (idleGroup !== undefined) spec.idleGroup = idleGroup;
  const defaultExpression = optionalString(input.defaultExpression, source + " " + id + ".defaultExpression", 128);
  if (defaultExpression !== undefined) spec.defaultExpression = defaultExpression;

  if (input.bubbleAnchor !== undefined) {
    if (!isPlainObject(input.bubbleAnchor)) throw new Error(source + " " + id + ".bubbleAnchor must be an object.");
    for (const key of Object.keys(input.bubbleAnchor)) {
      if (key !== "x" && key !== "y") throw new Error(source + " " + id + ".bubbleAnchor has an unknown field: " + key);
    }
    const anchor = { x: Number(input.bubbleAnchor.x), y: Number(input.bubbleAnchor.y) };
    if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || anchor.x < 0 || anchor.x > 1 || anchor.y < 0 || anchor.y > 1) {
      throw new Error(source + " " + id + ".bubbleAnchor.x/y must be numbers between 0 and 1.");
    }
    spec.bubbleAnchor = anchor;
  }

  if (input.hitActions !== undefined) {
    if (!isPlainObject(input.hitActions)) throw new Error(source + " " + id + ".hitActions must be an object.");
    spec.hitActions = input.hitActions;
  }

  return spec;
}

/**
 * Validate a live2d.models.json document.
 * @param {unknown} raw
 * @param {string} source
 */
export function normalizeCatalog(raw, source = "live2d.models.json") {
  if (!isPlainObject(raw)) throw new Error(source + " must contain a JSON object.");
  if (raw.version !== 1) throw new Error(source + " version must be 1.");
  if (!isPlainObject(raw.models)) throw new Error(source + " must contain a models object.");
  const ids = Object.keys(raw.models);
  if (ids.length === 0) throw new Error(source + " must define at least one model under models.");
  const models = {};
  for (const id of ids) {
    models[id] = normalizeModelSpec(id, raw.models[id], source);
  }
  return { version: 1, models };
}

function legacyInlineModel(config) {
  if (!isPlainObject(config.model)) return null;
  const raw = { ...config.model };
  const id = raw.id;
  delete raw.id;
  assertModelId(id, "live2d.config.json model.id");
  return normalizeModelSpec(id, raw, "live2d.config.json model");
}

/**
 * Load the model catalog referenced by the main config.
 *
 * models.file (and --catalog) is resolved relative to the config file, so a
 * config copied to another directory keeps working when both files travel
 * together.
 */
export async function loadModelCatalog(configPath, config, options = {}) {
  const modelsBlock = isPlainObject(config.models) ? config.models : {};
  const configuredFile = options.catalogFile ?? modelsBlock.file ?? "live2d.models.json";
  const file = path.isAbsolute(configuredFile)
    ? configuredFile
    : path.resolve(path.dirname(configPath), configuredFile);

  if (!(await exists(file))) {
    // Legacy inline model is only a fallback when the config does not point at
    // a catalog explicitly.
    const legacy = options.catalogFile == null && modelsBlock.file == null ? legacyInlineModel(config) : null;
    if (legacy) {
      return { version: 1, file: configPath, legacy: true, models: { [legacy.id]: legacy } };
    }
    throw new Error(
      "Model catalog not found: " +
        file +
        ". Create live2d.models.json (see README.md) or set models.file in " +
        path.basename(configPath) +
        ".",
    );
  }

  const raw = await readJsonFile(file, "model catalog");
  const catalog = normalizeCatalog(raw, file);
  return { ...catalog, file };
}

function normalizeIdList(value, label) {
  if (typeof value === "string") {
    value = value.split(",");
  }
  if (!Array.isArray(value)) throw new Error(label + " must be an array of model ids or a comma-separated string.");
  const ids = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error(label + " contains a non-string model id.");
    const id = raw.trim();
    if (id.length === 0) continue;
    assertModelId(id, label + " id");
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) throw new Error(label + " must contain at least one model id.");
  return ids;
}

/**
 * Decide which catalog models to install and which one the app should load.
 */
export function resolveModelSelection(config, catalog, options = {}) {
  const modelsBlock = isPlainObject(config.models) ? config.models : {};
  const configuredDefault =
    (typeof modelsBlock.default === "string" ? modelsBlock.default : undefined) ??
    (typeof config.model === "string" ? config.model : undefined);
  const catalogIds = Object.keys(catalog.models);
  if (catalogIds.length === 0) throw new Error("The model catalog is empty.");

  if (options.model && options.models != null) {
    throw new Error("Use either --model or --models, not both.");
  }

  const overrideModel = typeof options.model === "string" ? options.model.trim() : undefined;
  const defaultId = overrideModel || configuredDefault || catalogIds[0];
  if (!catalog.models[defaultId]) {
    throw new Error('Default model "' + defaultId + '" is not defined in ' + catalog.file + ". Available: " + catalogIds.join(", "));
  }

  let requested;
  if (overrideModel) {
    requested = [defaultId];
  } else if (options.models != null) {
    requested = normalizeIdList(options.models, "--models");
  } else if (Array.isArray(modelsBlock.install)) {
    requested = normalizeIdList(modelsBlock.install, "models.install");
  } else {
    requested = [defaultId];
  }

  for (const id of requested) {
    if (!catalog.models[id]) {
      throw new Error('Model "' + id + '" is not defined in ' + catalog.file + ". Available: " + catalogIds.join(", "));
    }
  }
  if (options.ensureDefault && !requested.includes(defaultId)) requested.unshift(defaultId);

  return {
    defaultId,
    installIds: requested,
    defaultSpec: catalog.models[defaultId],
    installSpecs: requested.map((id) => catalog.models[id]),
  };
}

export function cacheKeyForUrl(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
}

export async function writeModelConfig(modelDir, spec) {
  // Preserve manual live2d-agent.json tweaks that the catalog does not mention.
  let output = {};
  try {
    const existing = JSON.parse((await fs.readFile(path.join(modelDir, "live2d-agent.json"), "utf8")).replace(/^\uFEFF/, ""));
    if (isPlainObject(existing)) output = existing;
  } catch {
    // no existing config
  }
  for (const key of MODEL_CONFIG_KEYS) {
    if (spec[key] !== undefined) output[key] = spec[key];
  }
  await fs.mkdir(modelDir, { recursive: true });
  await fs.writeFile(path.join(modelDir, "live2d-agent.json"), JSON.stringify(output, null, 2) + "\n");
  return output;
}

async function hasModel(modelDir) {
  try {
    const entries = await fs.readdir(modelDir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".model3.json"));
  } catch {
    return false;
  }
}

export async function listInstalledModels(modelsDir) {
  let entries;
  try {
    entries = await fs.readdir(modelsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const models = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(modelsDir, entry.name);
    const files = await fs.readdir(dir).catch(() => []);
    const modelFile = files.filter((name) => name.toLowerCase().endsWith(".model3.json")).sort()[0];
    if (!modelFile) continue;
    let displayName = entry.name;
    try {
      const config = JSON.parse((await fs.readFile(path.join(dir, "live2d-agent.json"), "utf8")).replace(/^\uFEFF/, ""));
      if (isPlainObject(config) && typeof config.displayName === "string" && config.displayName.trim().length > 0) {
        displayName = config.displayName.trim();
      }
    } catch {
      // optional
    }
    models.push({ id: entry.name, displayName, entry: modelFile });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

export async function applyDefaultModel(runtimeDir, modelId) {
  assertModelId(modelId);
  const file = path.join(runtimeDir, "config.json");
  let config = {};
  try {
    const parsed = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    if (isPlainObject(parsed)) config = parsed;
  } catch {
    // first run or unreadable config: create a minimal one
  }
  config.model = modelId;
  await fs.mkdir(runtimeDir, { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n");
  await fs.rename(tmp, file);
}

function selectModelEntry(entries, variant) {
  const models = entries.filter(([name]) => name.toLowerCase().endsWith(".model3.json"));
  if (models.length === 0) throw new Error("The archive contains no .model3.json file.");
  let candidates = models;
  if (variant) {
    const root = String(variant).replace(/\/+$/, "") + "/";
    candidates = models.filter(([name]) => name.startsWith(root));
    if (candidates.length === 0) {
      const variants = [...new Set(models.map(([name]) => name.split("/")[0]))];
      throw new Error("Model variant " + variant + " was not found. Available variants: " + variants.join(", "));
    }
  }
  candidates.sort((a, b) => a[0].length - b[0].length);
  return candidates[0][0];
}

async function extractPrefix(entries, prefix, dest) {
  let count = 0;
  for (const [name, data] of entries) {
    if (!name.startsWith(prefix)) continue;
    const relative = name.slice(prefix.length);
    if (relative.length === 0 || relative.endsWith("/")) continue;
    if (relative.split("/").includes("..")) throw new Error("Archive entry escapes the model directory: " + name);
    const target = path.join(dest, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(data));
    count += 1;
  }
  if (count === 0) throw new Error("The selected model directory is empty.");
}

function findReadme(entries, entry, variant) {
  const variantRoot = variant ? String(variant).replace(/\/+$/, "") + "/" : entry.split("/")[0] + "/";
  const exact = entries.find(([name]) => name.toLowerCase() === (variantRoot + "readme.txt").toLowerCase());
  if (exact) return exact;
  return entries.find(([name]) => name.toLowerCase().endsWith("readme.txt")) ?? null;
}

function printProgress(received, total) {
  if (total > 0) {
    const percent = Math.min(100, Math.round((received / total) * 100));
    process.stdout.write("\r  " + (received / 1024 / 1024).toFixed(1) + " / " + (total / 1024 / 1024).toFixed(1) + " MB (" + percent + "%)   ");
  } else {
    process.stdout.write("\r  " + (received / 1024 / 1024).toFixed(1) + " MB   ");
  }
}

async function download(url, dest, expectedHash, expectedSize, noVerify, log) {
  if (await exists(dest)) {
    let usable = noVerify || !expectedHash;
    if (!usable) usable = (await sha256File(dest)) === expectedHash;
    if (usable && !noVerify && expectedSize) {
      const stat = await fs.stat(dest);
      usable = stat.size === expectedSize;
    }
    if (usable) {
      log("Using cached download: " + dest);
      return;
    }
    log("Cached download does not match the configured checksum; downloading again.");
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  const part = dest + ".part";
  log("Downloading " + url);
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error("Download failed: HTTP " + response.status + " " + response.statusText);
  const total = Number(response.headers.get("content-length") ?? 0);
  const handle = await fs.open(part, "w");
  const hash = createHash("sha256");
  let received = 0;
  let lastPrint = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      hash.update(value);
      received += value.length;
      if (received - lastPrint >= 4 * 1024 * 1024) {
        lastPrint = received;
        printProgress(received, total);
      }
    }
  } catch (error) {
    await handle.close();
    await fs.rm(part, { force: true });
    throw error;
  }
  await handle.close();
  printProgress(received, total);
  process.stdout.write("\n");

  const actual = hash.digest("hex");
  if (!noVerify && expectedSize && received !== expectedSize) {
    await fs.rm(part, { force: true });
    throw new Error("Downloaded size mismatch: expected " + expectedSize + " bytes, got " + received + ".");
  }
  if (!noVerify && expectedHash && actual !== expectedHash) {
    await fs.rm(part, { force: true });
    throw new Error("Downloaded SHA-256 mismatch: expected " + expectedHash + ", got " + actual + ".");
  }
  await fs.rename(part, dest);
  log("Download verified: " + dest);
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(path.basename(script) + " exited with " + (code ?? signal)));
    });
  });
}

async function ensureCachedArchive(spec, cacheDir) {
  const dest = path.join(cacheDir, "model-" + cacheKeyForUrl(spec.url) + ".zip");
  if (await exists(dest)) return dest;
  const legacy = path.join(cacheDir, spec.id + ".zip");
  if (!(await exists(legacy))) return dest;
  await fs.mkdir(cacheDir, { recursive: true });
  try {
    await fs.rename(legacy, dest);
  } catch {
    if (!(await exists(dest))) await fs.copyFile(legacy, dest);
    await fs.rm(legacy, { force: true }).catch(() => undefined);
  }
  return dest;
}

/**
 * Download (or reuse) a model archive, unpack the selected variant and install
 * it through setup-model.mjs.
 */
export async function installModel(spec, options) {
  const { modelsDir, cacheDir, appRoot, force = false, noVerify = false, log = console.log } = options;
  const modelDir = path.join(modelsDir, spec.id);

  if (!force && (await hasModel(modelDir))) {
    await writeModelConfig(modelDir, spec);
    log("Model already installed: " + spec.id + " (" + modelDir + ")");
    return { id: spec.id, dir: modelDir, installed: false, entry: null };
  }

  if (!spec.url) {
    throw new Error(
      'Model "' +
        spec.id +
        '" is not installed and has no url in the catalog. Add url to live2d.models.json or install it manually with npm run setup:model.',
    );
  }

  const zipPath = await ensureCachedArchive(spec, cacheDir);
  await download(spec.url, zipPath, spec.sha256, spec.size, noVerify, log);

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "live2d-setup-"));
  try {
    let unzipSync;
    try {
      ({ unzipSync } = await import("fflate"));
    } catch (error) {
      throw new Error("fflate is not installed; run npm install.", { cause: error });
    }
    const files = unzipSync(new Uint8Array(await fs.readFile(zipPath)));
    const entries = Object.entries(files).map(([name, data]) => [name.replace(/\\/g, "/"), data]);
    const entry = selectModelEntry(entries, spec.variant);
    const prefix = entry.slice(0, entry.lastIndexOf("/") + 1);
    const runtimeDir = path.join(temp, "runtime");
    await extractPrefix(entries, prefix, runtimeDir);
    log("Installing model " + spec.id + " from " + entry);
    await runNode(path.join(appRoot, "scripts", "setup-model.mjs"), ["--from", runtimeDir, "--id", spec.id, "--force"]);
    await writeModelConfig(modelDir, spec);
    const readme = findReadme(entries, entry, spec.variant);
    if (readme) await fs.writeFile(path.join(modelDir, "ReadMe.txt"), Buffer.from(readme[1]));
    log("Model installed: " + modelDir);
    return { id: spec.id, dir: modelDir, installed: true, entry };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
