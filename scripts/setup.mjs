#!/usr/bin/env node
/**
 * Live2D Agent - one-command setup.
 *
 * Reads live2d.config.json (or --config <file>), installs npm dependencies if
 * needed, downloads Cubism Core from the configured official CDN, downloads and
 * unpacks the configured default model, builds the app, optionally installs the
 * agent skill, and launches the desktop pet.
 *
 * Usage: npm run setup [options]
 */

import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const IS_WIN = process.platform === "win32";
const NODE = process.execPath;
const HOME_OVERRIDE = process.env.LIVE2D_AGENT_HOME?.trim();
const RUNTIME_DIR = HOME_OVERRIDE && HOME_OVERRIDE.length > 0 ? path.resolve(HOME_OVERRIDE) : path.join(os.homedir(), ".live2d-agent");
const CORE_FILE = path.join(RUNTIME_DIR, "core", "live2dcubismcore.min.js");
const MODELS_DIR = path.join(RUNTIME_DIR, "models");
const CACHE_DIR = path.join(RUNTIME_DIR, "cache");

const HELP = [
  "Live2D Agent - one-command setup",
  "",
  "Usage:",
  "  npm run setup [options]",
  "  node scripts/setup.mjs [options]",
  "",
  "Options:",
  "  --config <file>       Setup config (default: live2d.config.json)",
  "  --force               Re-download Core/model and reinstall the model",
  "  --no-deps             Do not run npm install (dependencies must already exist)",
  "  --no-build            Skip npm run build",
  "  --no-launch           Do not start the desktop app after setup",
  "  --no-core             Skip Core installation",
  "  --no-model            Skip model installation",
  "  --no-verify           Skip SHA-256/size verification for downloads",
  "  --accept-license      Accept the Live2D Core license for this run",
  "  --core-url <url>      Override core.url",
  "  --model-url <url>     Override model.url",
  "  --id <id>             Override model.id (target folder)",
  "  --variant <name>      Override model.variant (e.g. hiyori_pro)",
  "  --scale <number>      Override model.scale (0.1..4)",
  "  --skill-dest <dir>    Install the Agent Skill into this skills directory",
  "  -h, --help            Show this help",
  "",
  "The default config is live2d.config.json in the repository root. It controls",
  "the Core URL, the default model URL/variant/scale, and whether setup installs",
  "dependencies, builds, launches, or installs the skill. Edit that file instead",
  "of hard-coding values.",
].join("\n");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
      env: { ...process.env, ...options.env },
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(command + " exited with " + (code ?? signal)));
    });
  });
}

function quoteWinArg(value) {
  return /[\s"]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value;
}

function runNpm(args) {
  const execPath = process.env.npm_execpath;
  if (execPath && /\.(c?js)$/i.test(execPath)) return run(NODE, [execPath, ...args]);
  if (IS_WIN) {
    const cmd = process.env.ComSpec || "cmd.exe";
    const line = ["npm", ...args].map(quoteWinArg).join(" ");
    return run(cmd, ["/d", "/s", "/c", line]);
  }
  return run("npm", args);
}

function runNode(script, args) {
  return run(NODE, [script, ...args]);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function parseArgs(argv) {
  const options = {
    help: false,
    config: path.join(APP_ROOT, "live2d.config.json"),
    force: false,
    noDeps: false,
    noBuild: false,
    noLaunch: false,
    noCore: false,
    noModel: false,
    noVerify: false,
    acceptLicense: false,
    coreUrl: null,
    modelUrl: null,
    id: null,
    variant: null,
    scale: null,
    skillDest: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf("=");
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);
    const value = () => {
      if (inline !== null) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(name + " requires a value");
      return argv[i];
    };
    switch (name) {
      case "-h":
      case "--help": options.help = true; break;
      case "--config": options.config = value(); break;
      case "--force": options.force = true; break;
      case "--no-deps": options.noDeps = true; break;
      case "--no-build": options.noBuild = true; break;
      case "--no-launch": options.noLaunch = true; break;
      case "--no-core": options.noCore = true; break;
      case "--no-model": options.noModel = true; break;
      case "--no-verify": options.noVerify = true; break;
      case "--accept-license": options.acceptLicense = true; break;
      case "--core-url": options.coreUrl = value(); break;
      case "--model-url": options.modelUrl = value(); break;
      case "--id": options.id = value(); break;
      case "--variant": options.variant = value(); break;
      case "--scale": options.scale = Number(value()); break;
      case "--skill-dest": options.skillDest = value(); break;
      default: throw new Error("Unknown option: " + raw);
    }
  }
  return options;
}

async function loadConfig(file) {
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
    throw new Error("Invalid JSON in " + file + ": " + (error instanceof Error ? error.message : String(error)));
  }
  if (!config || config.version !== 1) throw new Error("Unsupported setup config version; expected version 1.");
  if (!config.core || typeof config.core !== "object") throw new Error("live2d.config.json: core must be an object.");
  if (!config.model || typeof config.model !== "object") throw new Error("live2d.config.json: model must be an object.");
  if (!config.setup || typeof config.setup !== "object") config.setup = {};
  const id = config.model.id;
  if (!/^[A-Za-z0-9._-]+$/.test(String(id ?? "")) || id === "." || id === "..") {
    throw new Error("live2d.config.json: model.id must match [A-Za-z0-9._-]+");
  }
  if (config.model.scale !== undefined) {
    const scale = Number(config.model.scale);
    if (!Number.isFinite(scale) || scale < 0.1 || scale > 4) throw new Error("live2d.config.json: model.scale must be 0.1..4");
  }
  return config;
}

async function ensureDependencies(config, options) {
  const nodeModules = path.join(APP_ROOT, "node_modules");
  const required = ["electron", "esbuild", "vite", "fflate"];
  const missing = [];
  for (const name of required) {
    if (!(await exists(path.join(nodeModules, name, "package.json")))) missing.push(name);
  }
  if (missing.length > 0) {
    if (options.noDeps || config.setup.installDependencies === false) {
      throw new Error("Missing npm dependencies (" + missing.join(", ") + "). Run: npm install");
    }
    console.log("Installing npm dependencies (this can take a few minutes)...");
    await runNpm(["install", "--include=dev", "--no-audit", "--no-fund"]);
  }
  for (const name of required) {
    if (!(await exists(path.join(nodeModules, name, "package.json")))) {
      throw new Error("Dependency " + name + " is still missing after npm install.");
    }
  }

  const electronBin = path.join(nodeModules, "electron", "dist", IS_WIN ? "electron.exe" : "electron");
  if (!(await exists(electronBin))) {
    const installer = path.join(nodeModules, "electron", "install.js");
    if (!(await exists(installer))) throw new Error("Electron package is incomplete: " + installer + " is missing.");
    console.log("Downloading the Electron runtime...");
    await runNode(installer, []);
  }
  if (!(await exists(electronBin))) throw new Error("Electron runtime is missing after install: " + electronBin);

  const esbuildBin = path.join(nodeModules, "@esbuild", process.platform + "-" + process.arch, IS_WIN ? "esbuild.exe" : "esbuild");
  if (!(await exists(esbuildBin))) {
    const installer = path.join(nodeModules, "esbuild", "install.js");
    if (await exists(installer)) await runNode(installer, []);
  }
  try {
    await import("fflate");
  } catch {
    throw new Error("fflate is not installed; run npm install.");
  }
}

async function installCore(config, options) {
  if (options.noCore) return;
  const core = config.core;
  const expectedHash = options.noVerify ? null : (typeof core.sha256 === "string" ? core.sha256.toLowerCase() : null);
  if ((await exists(CORE_FILE)) && !options.force) {
    if (!expectedHash) {
      console.log("Cubism Core already installed:", CORE_FILE);
      return;
    }
    const actual = await sha256File(CORE_FILE);
    if (actual === expectedHash) {
      console.log("Cubism Core already installed and verified:", CORE_FILE);
      return;
    }
    console.log("Existing Cubism Core hash does not match config; reinstalling.");
  }
  const setupCore = path.join(APP_ROOT, "scripts", "setup-core.mjs");
  if (typeof core.from === "string" && core.from.trim().length > 0) {
    const from = path.isAbsolute(core.from) ? core.from : path.resolve(APP_ROOT, core.from);
    await runNode(setupCore, ["--from", from, "--force"]);
  } else {
    const url = options.coreUrl ?? core.url;
    if (typeof url !== "string" || url.length === 0) throw new Error("live2d.config.json: core.url is required (or set core.from).");
    const accepted = options.acceptLicense || core.acceptLicense === true;
    if (!accepted) {
      throw new Error("core.acceptLicense is false. Accept the Live2D Proprietary Software License Agreement and set core.acceptLicense=true, pass --accept-license, or use core.from.");
    }
    console.log("Installing Cubism Core from the configured official CDN...");
    await runNode(setupCore, ["--download", "--url", url, "--accept-license", "--force"]);
  }
  if (expectedHash) {
    const actual = await sha256File(CORE_FILE);
    if (actual !== expectedHash) {
      throw new Error("Cubism Core SHA-256 mismatch. Expected " + expectedHash + ", got " + actual + ". Update live2d.config.json or pass --no-verify.");
    }
  }
  console.log("Cubism Core installed:", CORE_FILE);
}

async function hasModel(modelDir) {
  try {
    const entries = await fs.readdir(modelDir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith(".model3.json"));
  } catch {
    return false;
  }
}

async function writeModelConfig(modelDir, model) {
  const output = {};
  for (const key of ["displayName", "scale", "offsetX", "offsetY", "idleGroup", "defaultExpression"]) {
    if (model[key] !== undefined && model[key] !== null) output[key] = model[key];
  }
  await fs.mkdir(modelDir, { recursive: true });
  await fs.writeFile(path.join(modelDir, "live2d-agent.json"), JSON.stringify(output, null, 2) + "\n");
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

async function download(url, dest, expectedHash, expectedSize, noVerify) {
  if (await exists(dest)) {
    if (noVerify) {
      console.log("Using cached download:", dest);
      return;
    }
    if (!expectedHash || (await sha256File(dest)) === expectedHash.toLowerCase()) {
      console.log("Using cached download:", dest);
      return;
    }
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const part = dest + ".part";
  console.log("Downloading " + url);
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
  if (expectedSize && received !== expectedSize) {
    await fs.rm(part, { force: true });
    throw new Error("Downloaded size mismatch: expected " + expectedSize + " bytes, got " + received + ".");
  }
  if (!noVerify && expectedHash && actual !== expectedHash.toLowerCase()) {
    await fs.rm(part, { force: true });
    throw new Error("Downloaded SHA-256 mismatch: expected " + expectedHash + ", got " + actual + ". Update live2d.config.json or pass --no-verify.");
  }
  await fs.rename(part, dest);
  console.log("Download verified:", dest);
}

async function installModel(config, options) {
  if (options.noModel) return;
  const model = config.model;
  const id = options.id ?? model.id;
  if (!/^[A-Za-z0-9._-]+$/.test(String(id)) || id === "." || id === "..") throw new Error("Invalid model id: " + id);
  const modelDir = path.join(MODELS_DIR, id);
  const scale = options.scale ?? model.scale;
  if (scale !== undefined && (!Number.isFinite(scale) || scale < 0.1 || scale > 4)) throw new Error("model.scale must be 0.1..4");
  if (!options.force && (await hasModel(modelDir))) {
    await writeModelConfig(modelDir, { ...model, displayName: model.displayName ?? id, scale });
    console.log("Model already installed:", modelDir);
    return;
  }
  const url = options.modelUrl ?? model.url;
  if (typeof url !== "string" || url.length === 0) throw new Error("live2d.config.json: model.url is required (or install a model manually).");
  const expectedHash = options.noVerify ? null : model.sha256;
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const zipPath = path.join(CACHE_DIR, id + ".zip");
  await download(url, zipPath, expectedHash, model.size, options.noVerify);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "live2d-setup-"));
  try {
    const { unzipSync } = await import("fflate");
    const files = unzipSync(new Uint8Array(await fs.readFile(zipPath)));
    const entries = Object.entries(files).map(([name, data]) => [name.replace(/\\/g, "/"), data]);
    const entry = selectModelEntry(entries, options.variant ?? model.variant);
    const prefix = entry.slice(0, entry.lastIndexOf("/") + 1);
    const runtimeDir = path.join(temp, "runtime");
    await extractPrefix(entries, prefix, runtimeDir);
    console.log("Installing model " + id + " from " + entry);
    await runNode(path.join(APP_ROOT, "scripts", "setup-model.mjs"), ["--from", runtimeDir, "--id", id, "--force"]);
    await writeModelConfig(modelDir, { ...model, displayName: model.displayName ?? id, scale });
    const readme = findReadme(entries, entry, options.variant ?? model.variant);
    if (readme) await fs.writeFile(path.join(modelDir, "ReadMe.txt"), Buffer.from(readme[1]));
    console.log("Model installed:", modelDir);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function buildProject(config, options) {
  if (options.noBuild || config.setup.build === false) return;
  console.log("Building the app...");
  await runNpm(["run", "build"]);
  for (const file of ["dist/main.cjs", "dist/preload.cjs", "dist/renderer/index.html", "dist/cli.mjs", "dist/mcp.mjs"]) {
    if (!(await exists(path.join(APP_ROOT, file)))) throw new Error("Build did not produce " + file);
  }
}

async function installSkill(config, options) {
  const dest = options.skillDest ?? config.setup.skillDest;
  if (!dest) return;
  console.log("Installing the live2d-pet skill into " + dest);
  await runNode(path.join(APP_ROOT, "scripts", "install-skill.mjs"), ["--dest", dest, "--force"]);
}

async function launchApp(config, options) {
  if (options.noLaunch || config.setup.launch === false) return;
  console.log("Starting the desktop pet...");
  await runNode(path.join(APP_ROOT, "dist", "cli.mjs"), ["ensure", "--json"]);
}

async function main() {
  const initialCwd = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const configPath = path.resolve(initialCwd, options.config);
  process.chdir(APP_ROOT);
  const config = await loadConfig(configPath);

  console.log("Live2D Agent setup");
  console.log("  repo:   " + APP_ROOT);
  console.log("  config: " + configPath);
  console.log("  runtime:" + " " + RUNTIME_DIR);
  console.log("");

  await ensureDependencies(config, options);
  await installCore(config, options);
  await installModel(config, options);
  await buildProject(config, options);
  await installSkill(config, options);
  await launchApp(config, options);

  console.log("");
  console.log("Setup complete.");
  console.log("  Core:  " + CORE_FILE);
  console.log("  Model: " + path.join(MODELS_DIR, options.id ?? config.model.id));
  if (options.noLaunch || config.setup.launch === false) console.log("  Start the app with: npm start");
  if (!(options.skillDest ?? config.setup.skillDest)) console.log("  Install the agent skill with: npm run install:skill -- --dest <skills-dir>");
  console.log("  Check status with: node dist/cli.mjs status --json");
}

main().catch((error) => {
  console.error("");
  console.error("setup failed: " + (error instanceof Error ? error.message : String(error)));
  if (process.env.LIVE2D_DEBUG) console.error(error);
  process.exitCode = 1;
});
