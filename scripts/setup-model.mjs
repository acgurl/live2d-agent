#!/usr/bin/env node
/**
 * Live2D Agent - model setup helper.
 *
 * Copies a Live2D model you already own into the runtime models directory:
 *   <runtime>/models/<id>/
 *
 * This repository NEVER bundles Live2D models. Sample models (for example
 * Hiyori) are provided by Live2D under their own license; download them
 * yourself from the official Cubism sample distribution and make sure your use
 * complies with Live2D's terms.
 *
 * The app expects a .model3.json file at the model directory root, and all file
 * references inside it must be relative paths that stay inside the directory.
 *
 * Runtime: LIVE2D_AGENT_HOME or %USERPROFILE%\.live2d-agent (same as src/shared/paths.ts)
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const HOME_OVERRIDE = process.env.LIVE2D_AGENT_HOME?.trim();
const RUNTIME_DIR = HOME_OVERRIDE && HOME_OVERRIDE.length > 0 ? path.resolve(HOME_OVERRIDE) : path.join(os.homedir(), ".live2d-agent");
const MODELS_DIR = path.join(RUNTIME_DIR, "models");

const SAMPLE_TERMS_EN = "https://www.live2d.com/eula/live2d-sample-model-terms_en.html";
const SAMPLE_TERMS_CN = "https://www.live2d.com/eula/live2d-sample-model-terms_cn.html";
const FREE_MATERIAL_EN = "https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html";
const FREE_MATERIAL_CN = "https://www.live2d.com/eula/live2d-free-material-license-agreement_cn.html";
const CUBISM_SAMPLES = "https://github.com/Live2D/CubismWebSamples";

const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const HELP = [
  "Live2D Agent - install a Live2D model",
  "",
  "Usage:",
  "  node scripts/setup-model.mjs --from <dir> [--id <id>] [--force]",
  "  node scripts/setup-model.mjs --sample hiyori [--from-sample-dir <dir>]",
  "  npm run setup:model -- --from <dir>",
  "",
  "Options:",
  "  --from <dir|file>       Model directory (or the model3.json file) to install.",
  "  --id <id>               Model id (letters, digits, dot, underscore, dash).",
  "                          Default: the source directory name, normalized.",
  "  --entry <file>          Pick one model3.json when the directory has several.",
  "  --sample <name>         Guide-only sample setup. Currently: hiyori.",
  "                          If the model is not available locally, prints the",
  "                          official download source and license links. Never",
  "                          downloads or bundles a model automatically.",
  "  --from-sample-dir <dir> Local CubismWebSamples checkout/Resources folder",
  "                          used by --sample (or set LIVE2D_SAMPLES_DIR).",
  "  --force                 Replace an existing model with the same id.",
  "  -h, --help              Show this help.",
  "",
  "Install target:",
  "  " + MODELS_DIR + "/<id>",
  "",
  "Requirements: a .model3.json at the top level of the model directory, a",
  ".moc3 file, at least one texture, and all references must stay inside the",
  "model directory. Models and samples are NOT part of this repository; you are",
  "responsible for their licenses.",
  "",
  "Sample model terms:",
  "  " + SAMPLE_TERMS_EN,
  "Free Material License:",
  "  " + FREE_MATERIAL_EN,
].join("\n");

function fail(message, code = EXIT_ERROR) {
  console.error("setup:model: " + message);
  process.exitCode = code;
}

function parseArgs(argv) {
  const options = {
    help: false,
    from: null,
    id: null,
    entry: null,
    sample: null,
    fromSampleDir: null,
    force: false,
    errors: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const equal = arg.indexOf("=");
    const name = equal === -1 ? arg : arg.slice(0, equal);
    const inlineValue = equal === -1 ? null : arg.slice(equal + 1);
    const nextValue = () => {
      if (inlineValue !== null) return inlineValue;
      if (i + 1 >= argv.length) {
        options.errors.push(name + " requires a value");
        return null;
      }
      i += 1;
      return argv[i];
    };
    switch (name) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--from": {
        const value = nextValue();
        if (value !== null) options.from = value;
        break;
      }
      case "--id": {
        const value = nextValue();
        if (value !== null) options.id = value;
        break;
      }
      case "--entry": {
        const value = nextValue();
        if (value !== null) options.entry = value;
        break;
      }
      case "--sample": {
        const value = nextValue();
        if (value !== null) options.sample = value;
        break;
      }
      case "--from-sample-dir": {
        const value = nextValue();
        if (value !== null) options.fromSampleDir = value;
        break;
      }
      case "--force":
        options.force = true;
        break;
      default:
        options.errors.push("unknown option: " + arg);
    }
  }
  return options;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
}

function normalizeId(raw) {
  return String(raw)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function assertValidId(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === ".." || id.length > 128) {
    throw new Error("invalid model id '" + id + "': use 1-128 characters from A-Z, a-z, 0-9, dot, underscore or dash");
  }
}

function normalizeRef(ref, field) {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new Error("model3.json field " + field + " must be a non-empty string");
  }
  if (ref.includes("://") || path.isAbsolute(ref) || /^[A-Za-z]:/.test(ref) || ref.startsWith("\\")) {
    throw new Error("model3.json field " + field + " must be a relative path: " + ref);
  }
  const normalized = ref.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw new Error("model3.json field " + field + " escapes the model directory: " + ref);
  }
  return normalized;
}

async function assertFileInside(baseReal, ref, field) {
  const target = path.resolve(baseReal, ref);
  const rel = path.relative(baseReal, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("model3.json field " + field + " escapes the model directory: " + ref);
  }
  let real;
  try {
    real = await fs.realpath(target);
  } catch {
    throw new Error("missing file for model3.json field " + field + ": " + ref);
  }
  const realRel = path.relative(baseReal, real);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error("model3.json field " + field + " resolves outside the model directory: " + ref);
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) {
    throw new Error("model3.json field " + field + " is not a file: " + ref);
  }
  return stat.size;
}

async function validateModelDir(dir, entry) {
  const entryPath = path.join(dir, entry);
  let raw;
  try {
    raw = await fs.readFile(entryPath, "utf8");
  } catch {
    throw new Error("cannot read " + entry + " in " + dir);
  }
  let json;
  try {
    json = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(entry + " is not valid JSON: " + (error instanceof Error ? error.message : String(error)));
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(entry + " must contain a JSON object");
  }
  const refs = json.FileReferences;
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) {
    throw new Error(entry + " is missing FileReferences");
  }
  const baseReal = await fs.realpath(dir);
  const moc = normalizeRef(refs.Moc, "FileReferences.Moc");
  const mocBytes = await assertFileInside(baseReal, moc, "FileReferences.Moc");

  const textures = refs.Textures;
  if (!Array.isArray(textures) || textures.length === 0) {
    throw new Error(entry + " must reference at least one texture under FileReferences.Textures");
  }
  const textureBytes = [];
  for (let i = 0; i < textures.length; i += 1) {
    const ref = normalizeRef(textures[i], "FileReferences.Textures[" + i + "]");
    textureBytes.push(await assertFileInside(baseReal, ref, "FileReferences.Textures[" + i + "]"));
  }

  let expressions = 0;
  if (refs.Expressions !== undefined) {
    if (!Array.isArray(refs.Expressions)) {
      throw new Error(entry + ": FileReferences.Expressions must be an array");
    }
    for (let i = 0; i < refs.Expressions.length; i += 1) {
      const expression = refs.Expressions[i];
      if (!expression || typeof expression !== "object") continue;
      if (expression.File !== undefined) {
        const ref = normalizeRef(expression.File, "FileReferences.Expressions[" + i + "].File");
        await assertFileInside(baseReal, ref, "FileReferences.Expressions[" + i + "].File");
      }
      expressions += 1;
    }
  }

  const motionGroups = [];
  let motions = 0;
  if (refs.Motions !== undefined) {
    if (!refs.Motions || typeof refs.Motions !== "object" || Array.isArray(refs.Motions)) {
      throw new Error(entry + ": FileReferences.Motions must be an object");
    }
    for (const [group, list] of Object.entries(refs.Motions)) {
      if (!Array.isArray(list)) continue;
      motionGroups.push(group);
      for (let i = 0; i < list.length; i += 1) {
        const motion = list[i];
        if (!motion || typeof motion !== "object") continue;
        if (motion.File !== undefined) {
          const ref = normalizeRef(motion.File, "FileReferences.Motions." + group + "[" + i + "].File");
          await assertFileInside(baseReal, ref, "FileReferences.Motions." + group + "[" + i + "].File");
        }
        motions += 1;
      }
    }
  }

  for (const field of ["Physics", "Pose", "UserData", "DisplayInfo"]) {
    if (refs[field] !== undefined) {
      const ref = normalizeRef(refs[field], "FileReferences." + field);
      await assertFileInside(baseReal, ref, "FileReferences." + field);
    }
  }

  return {
    entry,
    moc,
    textures: textures.length,
    expressions,
    motions,
    motionGroups,
    bytes: mocBytes + textureBytes.reduce((sum, value) => sum + value, 0),
  };
}

async function findTopLevelEntries(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".model3.json"))
    .map((entry) => entry.name)
    .sort();
}

async function resolveSource(fromPath, entryOption) {
  const resolved = path.resolve(fromPath);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error("--from path not found: " + resolved);
  }
  if (stat.isFile()) {
    if (!resolved.toLowerCase().endsWith(".model3.json")) {
      throw new Error("--from file must be a .model3.json file: " + resolved);
    }
    const dir = path.dirname(resolved);
    return { dir, entry: path.basename(resolved) };
  }
  if (!stat.isDirectory()) {
    throw new Error("--from path is neither a directory nor a .model3.json file: " + resolved);
  }
  const candidates = await findTopLevelEntries(resolved);
  if (candidates.length === 0) {
    const nested = [];
    const children = await fs.readdir(resolved, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const childCandidates = await findTopLevelEntries(path.join(resolved, child.name)).catch(() => []);
      if (childCandidates.length > 0) nested.push(child.name + "/" + childCandidates[0]);
    }
    throw new Error(
      "no top-level .model3.json in " + resolved +
        (nested.length > 0 ? ". Did you mean --from " + path.join(resolved, nested[0].split("/")[0]) + "?" : "")
    );
  }
  if (entryOption) {
    if (!candidates.includes(entryOption)) {
      throw new Error("--entry " + entryOption + " is not one of: " + candidates.join(", "));
    }
    return { dir: resolved, entry: entryOption };
  }
  if (candidates.length > 1) {
    throw new Error("multiple top-level .model3.json files found (" + candidates.join(", ") + "); pick one with --entry <file>");
  }
  return { dir: resolved, entry: candidates[0] };
}

async function copyTree(sourceRoot, targetRoot) {
  const stats = { files: 0, bytes: 0 };
  const walk = async (relative) => {
    const sourceDir = path.join(sourceRoot, relative);
    const targetDir = path.join(targetRoot, relative);
    await fs.mkdir(targetDir, { recursive: true });
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const source = path.join(sourceRoot, childRelative);
      const target = path.join(targetRoot, childRelative);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) {
        throw new Error("model directory contains a symbolic link (" + source + "); copy the real files first");
      }
      if (stat.isDirectory()) {
        await walk(childRelative);
      } else if (stat.isFile()) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
        stats.files += 1;
        stats.bytes += stat.size;
      }
    }
  };
  await walk("");
  return stats;
}

function printSampleGuides() {
  console.log("");
  console.log("Official sample models (not bundled and never downloaded automatically):");
  console.log("  CubismWebSamples: " + CUBISM_SAMPLES);
  console.log("  Path inside the repo: Samples/Resources/Hiyori");
  console.log("");
  console.log("Live2D licenses for sample models:");
  console.log("  Sample Model Terms (EN): " + SAMPLE_TERMS_EN);
  console.log("  Sample Model Terms (CN): " + SAMPLE_TERMS_CN);
  console.log("  Free Material License (EN): " + FREE_MATERIAL_EN);
  console.log("  Free Material License (CN): " + FREE_MATERIAL_CN);
  console.log("");
  console.log("After downloading, either copy it to:");
  console.log("  " + path.join(MODELS_DIR, "hiyori"));
  console.log("or run:");
  console.log("  npm run setup:model -- --from <path-to>/Hiyori");
  console.log("If you keep a local CubismWebSamples checkout, point --from-sample-dir at it:");
  console.log("  npm run setup:model -- --sample hiyori --from-sample-dir <path-to>/CubismWebSamples");
}

async function sampleMode(options) {
  const name = String(options.sample).trim().toLowerCase();
  if (name !== "hiyori") {
    fail("unsupported sample '" + options.sample + "'. This project only knows the Hiyori sample; use --from for other models.", EXIT_USAGE);
    return;
  }
  const target = path.join(MODELS_DIR, "hiyori");
  const existing = await findTopLevelEntries(target).catch(() => []);
  if (existing.length > 0) {
    console.log("Hiyori is already installed:");
    console.log("  " + target);
    console.log("  entry: " + existing[0]);
    printSampleGuides();
    return;
  }

  const samplesRoot = options.fromSampleDir ?? process.env.LIVE2D_SAMPLES_DIR?.trim();
  if (samplesRoot) {
    const root = path.resolve(samplesRoot);
    const candidates = [
      path.join(root, "hiyori"),
      path.join(root, "Hiyori"),
      path.join(root, "Samples", "Resources", "Hiyori"),
      path.join(root, "Resources", "Hiyori"),
      path.join(root, "Samples", "Resources", "hiyori"),
    ];
    if (await findTopLevelEntries(root).catch(() => []).then((entries) => entries.length > 0)) {
      candidates.unshift(root);
    }
    let source = null;
    for (const candidate of candidates) {
      const entries = await findTopLevelEntries(candidate).catch(() => []);
      if (entries.length > 0) {
        source = candidate;
        break;
      }
    }
    if (!source) {
      fail("could not find a Hiyori model (a top-level .model3.json) under: " + root);
      printSampleGuides();
      return;
    }
    console.log("Found a local Hiyori sample at:");
    console.log("  " + source);
    const id = options.id ?? "hiyori";
    await installModel(source, id, options.force, null);
    return;
  }

  console.log("The Hiyori sample is not installed and this project does not download or bundle models.");
  printSampleGuides();
  process.exitCode = EXIT_ERROR;
}

async function installModel(sourceDir, requestedId, force, entryOption) {
  let temp = null;
  try {
    const source = await resolveSource(sourceDir, entryOption);
    const id = requestedId ?? normalizeId(path.basename(source.dir));
    assertValidId(id);
    const info = await validateModelDir(source.dir, source.entry);
    const target = path.join(MODELS_DIR, id);

    let targetExists = true;
    try {
      const stat = await fs.stat(target);
      targetExists = stat.isDirectory();
    } catch {
      targetExists = false;
    }
    if (targetExists && !force) {
      fail("model id '" + id + "' already exists at " + target + " (use --force to replace it)");
      return;
    }

    temp = path.join(MODELS_DIR, ".tmp-" + id + "-" + process.pid + "-" + Date.now());
    console.log("Installing model:");
    console.log("  source: " + source.dir);
    console.log("  entry:  " + source.entry);
    console.log("  id:     " + id);
    console.log("  target: " + target);
    await fs.mkdir(MODELS_DIR, { recursive: true });
    const copied = await copyTree(source.dir, temp);
    await validateModelDir(temp, source.entry);
    if (targetExists) await fs.rm(target, { recursive: true, force: true });
    await fs.rename(temp, target);
    temp = null;
    console.log("");
    console.log("Installed model '" + id + "' (" + copied.files + " files, " + formatBytes(copied.bytes) + "):");
    console.log("  " + target);
    console.log("  expressions: " + info.expressions + ", motions: " + info.motions + (info.motionGroups.length > 0 ? " (" + info.motionGroups.join(", ") + ")" : "") + ", textures: " + info.textures);
    console.log("");
    console.log("Next steps:");
    console.log("  - If the app is running: live2d model list && live2d model load " + id);
    console.log("  - Otherwise start it with: live2d ensure (or npm start)");
    console.log("");
    console.log("Models are not part of this repository; keep the model's own license/credits.");
    if (id === "hiyori") printSampleGuides();
  } catch (error) {
    if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.errors.length > 0) {
    for (const message of options.errors) console.error("setup:model: " + message);
    console.error("Run with --help for usage.");
    process.exitCode = EXIT_USAGE;
    return;
  }

  console.log("Live2D Agent - model setup");
  console.log("App root:    " + APP_ROOT);
  console.log("Runtime dir: " + RUNTIME_DIR);
  console.log("Models dir:  " + MODELS_DIR);
  console.log("");

  if (options.sample) {
    if (options.from) {
      fail("choose either --from <dir> or --sample <name>, not both.", EXIT_USAGE);
      return;
    }
    await sampleMode(options);
    return;
  }

  if (options.from) {
    if (options.fromSampleDir) {
      fail("--from-sample-dir is only used with --sample.", EXIT_USAGE);
      return;
    }
    await installModel(options.from, options.id, options.force, options.entry);
    return;
  }

  if (options.id || options.entry || options.fromSampleDir) {
    fail("--id, --entry and --from-sample-dir require --from or --sample.", EXIT_USAGE);
    return;
  }

  console.log("Installed models:");
  const entries = await fs.readdir(MODELS_DIR, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const files = await findTopLevelEntries(path.join(MODELS_DIR, entry.name)).catch(() => []);
    if (files.length === 0) {
      console.log("  " + entry.name + " (no top-level .model3.json; ignored by the app)");
      continue;
    }
    count += 1;
    console.log("  " + entry.name + " -> " + files[0]);
  }
  if (count === 0) console.log("  (none)");
  console.log("");
  console.log("Install a model:");
  console.log("  npm run setup:model -- --from <model-directory> [--id <id>]");
  console.log("Sample guidance:");
  console.log("  npm run setup:model -- --sample hiyori");
  console.log("");
  console.log("This repository never bundles models. Sample models are provided by Live2D");
  console.log("under their own license:");
  console.log("  " + SAMPLE_TERMS_EN);
}

main().catch((error) => {
  console.error("setup:model: unexpected failure: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = EXIT_ERROR;
});
