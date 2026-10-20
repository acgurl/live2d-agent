#!/usr/bin/env node
/**
 * Live2D Agent - one-command setup.
 *
 * Reads live2d.config.json (or --config <file>), resolves the model catalog
 * live2d.models.json, installs npm dependencies if needed, downloads Cubism
 * Core from the configured official CDN, downloads and installs the selected
 * catalog models, builds the app, optionally installs the agent skill, applies
 * the default model and launches the desktop pet.
 *
 * Usage: npm run setup [options]
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyDefaultModel,
  installModel,
  listInstalledModels,
  loadMainConfig,
  loadModelCatalog,
  resolveModelSelection,
  sha256File,
} from "./lib/models.mjs";

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
  "  --config <file>       Main setup config (default: live2d.config.json)",
  "  --catalog <file>      Override models.file (default: live2d.models.json)",
  "  --model <id>          Install only this catalog model and make it the default",
  "  --models <ids>        Install these catalog models (default added if missing)",
  "  --force               Re-download Core/model archives and reinstall models",
  "  --no-deps             Do not run npm install (dependencies must already exist)",
  "  --no-build            Skip npm run build",
  "  --no-launch           Do not start the desktop app after setup",
  "  --no-core             Skip Core installation",
  "  --no-model            Skip model installation",
  "  --no-verify           Skip SHA-256/size verification for downloads",
  "  --accept-license      Accept the Live2D Core license for this run",
  "  --core-url <url>      Override core.url",
  "  --skill-dest <dir>    Install the Agent Skill into this skills directory",
  "  -h, --help            Show this help",
  "",
  "The installation defaults live in two editable files:",
  "  live2d.config.json  - Core URL, catalog path, default model, install list",
  "  live2d.models.json  - reusable model definitions keyed by model id",
  "",
  "Examples:",
  "  npm run setup                                  install models.install and launch",
  "  npm run setup -- --model hiyori                install only hiyori",
  "  npm run setup -- --models hiyori,hiyori-free   install two catalog models",
  "  npm run setup -- --force                       re-download and reinstall",
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
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [script, ...args], { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(path.basename(script) + " exited with " + (code ?? signal)));
    });
  });
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const options = {
    help: false,
    config: path.join(APP_ROOT, "live2d.config.json"),
    catalog: null,
    model: null,
    models: null,
    force: false,
    noDeps: false,
    noBuild: false,
    noLaunch: false,
    noCore: false,
    noModel: false,
    noVerify: false,
    acceptLicense: false,
    coreUrl: null,
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
      case "--catalog": options.catalog = value(); break;
      case "--model": options.model = value(); break;
      case "--models": options.models = value(); break;
      case "--force": options.force = true; break;
      case "--no-deps": options.noDeps = true; break;
      case "--no-build": options.noBuild = true; break;
      case "--no-launch": options.noLaunch = true; break;
      case "--no-core": options.noCore = true; break;
      case "--no-model": options.noModel = true; break;
      case "--no-verify": options.noVerify = true; break;
      case "--accept-license": options.acceptLicense = true; break;
      case "--core-url": options.coreUrl = value(); break;
      case "--skill-dest": options.skillDest = value(); break;
      default: throw new Error("Unknown option: " + raw);
    }
  }
  return options;
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

async function installSelectedModels(configPath, config, options) {
  const catalog = await loadModelCatalog(configPath, config, { catalogFile: options.catalog });
  const selection = resolveModelSelection(config, catalog, {
    model: options.model,
    models: options.models,
    ensureDefault: true,
  });
  console.log("Model catalog: " + catalog.file);
  if (catalog.legacy) {
    console.log("  note: using the legacy inline model from live2d.config.json; move it to live2d.models.json when convenient.");
  }
  console.log("Models to install: " + selection.installIds.join(", "));
  const results = [];
  for (const spec of selection.installSpecs) {
    results.push(
      await installModel(spec, {
        modelsDir: MODELS_DIR,
        cacheDir: CACHE_DIR,
        appRoot: APP_ROOT,
        force: options.force,
        noVerify: options.noVerify,
        log: console.log,
      }),
    );
  }
  const installed = results.filter((result) => result.installed).length;
  if (installed === 0) console.log("All selected models are already installed.");
  return { catalog, selection, results };
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

async function switchActiveModel(id) {
  try {
    await runNode(path.join(APP_ROOT, "dist", "cli.mjs"), ["--timeout", "30000", "model", "load", id]);
  } catch (error) {
    console.warn("warning: could not switch the running app to model " + id + ": " + (error instanceof Error ? error.message : String(error)));
  }
}

async function printSummary(selection) {
  const installed = await listInstalledModels(MODELS_DIR);
  console.log("");
  console.log("Setup complete.");
  console.log("  Core:  " + CORE_FILE);
  if (installed.length === 0) {
    console.log("  Models: (none installed)");
  } else {
    console.log("  Models (" + installed.length + ") in " + MODELS_DIR + ":");
    for (const model of installed) {
      const marker = selection && model.id === selection.defaultId ? "*" : " ";
      console.log("    " + marker + " " + model.id.padEnd(20) + model.displayName + "  (" + model.entry + ")");
    }
    if (selection) console.log("  Default model: " + selection.defaultId);
  }
  console.log("  Start with: npm start (or the app is already running)");
  console.log("  Switch a running app with: live2d model load <id>");
  console.log("  Check status with: node dist/cli.mjs status --json");
}

async function main() {
  const initialCwd = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const configPath = path.resolve(initialCwd, options.config);
  if (options.catalog) options.catalog = path.resolve(initialCwd, options.catalog);
  process.chdir(APP_ROOT);
  const config = await loadMainConfig(configPath);

  console.log("Live2D Agent setup");
  console.log("  repo:   " + APP_ROOT);
  console.log("  config: " + configPath);
  console.log("  runtime:" + " " + RUNTIME_DIR);
  console.log("");

  await ensureDependencies(config, options);
  await installCore(config, options);

  let selection = null;
  if (options.noModel) {
    console.log("Skipping model installation (--no-model).");
  } else {
    const installed = await installSelectedModels(configPath, config, options);
    selection = installed.selection;
  }

  await buildProject(config, options);
  await installSkill(config, options);

  if (selection) {
    await applyDefaultModel(RUNTIME_DIR, selection.defaultId);
    console.log("Default model set to:", selection.defaultId);
  }

  await launchApp(config, options);

  if (selection && !options.noLaunch && config.setup.launch !== false) {
    await switchActiveModel(selection.defaultId);
  }

  await printSummary(selection);
}

main().catch((error) => {
  console.error("");
  console.error("setup failed: " + (error instanceof Error ? error.message : String(error)));
  if (process.env.LIVE2D_DEBUG) console.error(error);
  process.exitCode = 1;
});