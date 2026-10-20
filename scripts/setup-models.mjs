#!/usr/bin/env node
/**
 * Install one or more models from live2d.models.json without rebuilding the
 * app. The full one-command setup (scripts/setup.mjs) calls the same helpers.
 *
 * Usage:
 *   npm run setup:models
 *   npm run setup:models -- --models hiyori,hiyori-free
 *   npm run setup:models -- --model hiyori-free
 *   npm run setup:models -- --list
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDefaultModel,
  installModel,
  listInstalledModels,
  loadMainConfig,
  loadModelCatalog,
  resolveModelSelection,
} from "./lib/models.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const HOME_OVERRIDE = process.env.LIVE2D_AGENT_HOME?.trim();
const RUNTIME_DIR = HOME_OVERRIDE && HOME_OVERRIDE.length > 0 ? path.resolve(HOME_OVERRIDE) : path.join(os.homedir(), ".live2d-agent");
const MODELS_DIR = path.join(RUNTIME_DIR, "models");
const CACHE_DIR = path.join(RUNTIME_DIR, "cache");

const HELP = [
  "Live2D Agent - install models from the catalog",
  "",
  "Usage:",
  "  npm run setup:models [options]",
  "  node scripts/setup-models.mjs [options]",
  "",
  "Options:",
  "  --config <file>     Main setup config (default: live2d.config.json)",
  "  --catalog <file>    Override models.file (default: live2d.models.json)",
  "  --model <id>        Install only this model and make it the default",
  "  --models <ids>      Install exactly these models (comma-separated)",
  "  --force             Re-download the archive and reinstall",
  "  --no-verify         Skip SHA-256/size verification for downloads",
  "  --no-default        Do not change the active/default model",
  "  --list              List the catalog and installed state, install nothing",
  "  -h, --help          Show this help",
  "",
  "The catalog is live2d.models.json; the default model and install list live in",
  "live2d.config.json (models.default and models.install).",
].join("\n");

function parseArgs(argv) {
  const options = {
    help: false,
    config: path.join(APP_ROOT, "live2d.config.json"),
    catalog: null,
    model: null,
    models: null,
    force: false,
    noVerify: false,
    noDefault: false,
    list: false,
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
      case "--no-verify": options.noVerify = true; break;
      case "--no-default": options.noDefault = true; break;
      case "--list": options.list = true; break;
      default: throw new Error("Unknown option: " + raw);
    }
  }
  return options;
}

function printCatalog(catalog, config, installedIds) {
  const ids = Object.keys(catalog.models);
  const width = Math.min(28, Math.max(8, ...ids.map((id) => id.length)));
  const defaultId = config.models && typeof config.models.default === "string" ? config.models.default : null;
  console.log("Model catalog: " + catalog.file);
  console.log("Models (" + ids.length + "):");
  for (const id of ids) {
    const spec = catalog.models[id];
    const installed = installedIds.has(id) ? "installed" : "not installed";
    const suffix = id === defaultId ? "  (default)" : "";
    console.log(
      "  " +
        id.padEnd(width) +
        "  " +
        (spec.displayName ?? id).padEnd(20) +
        "  " +
        (spec.variant ?? "-").padEnd(18) +
        "  " +
        installed +
        suffix,
    );
  }
  console.log("");
  console.log("Install list: " + (Array.isArray(config.models?.install) ? config.models.install.join(", ") : defaultId ?? "(first model)"));
}

function printInstalled(models, defaultId) {
  console.log("");
  console.log("Installed models in " + MODELS_DIR + ":");
  if (models.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const model of models) {
    const marker = model.id === defaultId ? "*" : " ";
    console.log("  " + marker + " " + model.id.padEnd(20) + model.displayName + "  (" + model.entry + ")");
  }
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
  const catalog = await loadModelCatalog(configPath, config, { catalogFile: options.catalog });
  const installed = await listInstalledModels(MODELS_DIR);
  const installedIds = new Set(installed.map((model) => model.id));

  console.log("Live2D Agent - model catalog installer");
  console.log("  repo:    " + APP_ROOT);
  console.log("  config:  " + configPath);
  console.log("  runtime: " + RUNTIME_DIR);
  console.log("");

  if (options.list) {
    printCatalog(catalog, config, installedIds);
    return;
  }

  const selection = resolveModelSelection(config, catalog, {
    model: options.model,
    models: options.models,
    ensureDefault: options.models === null,
  });

  console.log("Installing models: " + selection.installIds.join(", "));
  for (const spec of selection.installSpecs) {
    await installModel(spec, {
      modelsDir: MODELS_DIR,
      cacheDir: CACHE_DIR,
      appRoot: APP_ROOT,
      force: options.force,
      noVerify: options.noVerify,
      log: console.log,
    });
  }

  const updated = await listInstalledModels(MODELS_DIR);
  const defaultInstalled = updated.some((model) => model.id === selection.defaultId);
  if (!options.noDefault && defaultInstalled) {
    await applyDefaultModel(RUNTIME_DIR, selection.defaultId);
    console.log("");
    console.log("Default model: " + selection.defaultId + " (used on the next app launch)");
  } else if (!options.noDefault && !defaultInstalled) {
    console.log("");
    console.log("Default model remains " + selection.defaultId + " (not installed by this command).");
  }

  printInstalled(updated, selection.defaultId);
  console.log("");
  console.log("Switch a running app with: live2d model load <id>");
}

main().catch((error) => {
  console.error("");
  console.error("setup:models failed: " + (error instanceof Error ? error.message : String(error)));
  if (process.env.LIVE2D_DEBUG) console.error(error);
  process.exitCode = 1;
});
