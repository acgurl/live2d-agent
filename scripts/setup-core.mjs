#!/usr/bin/env node
/**
 * Live2D Agent - Cubism Core setup helper.
 *
 * IMPORTANT: this repository NEVER bundles Live2D Cubism Core. Cubism Core is
 * proprietary Live2D software and is distributed by Live2D Inc. under the
 * Live2D Proprietary Software License Agreement. Every user must obtain a Cubism 5 SDK
 * for Web R5 (Core 6.x, MocVersion_53) build themselves and accept Live2D's
 * terms. Older Cubism Web Core builds (for example 5.1.0) are rejected by
 * easy-live2d 1.0.0.
 *
 * This script only installs a Core build that the user already has (--from) or,
 * with explicit consent (--download --accept-license), downloads the official
 * Cubism Core build from Live2D's Cubism SDK for Web CDN.
 *
 * Target: <runtime>/core/live2dcubismcore.min.js
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
const CORE_DIR = path.join(RUNTIME_DIR, "core");
const CORE_FILE = path.join(CORE_DIR, "live2dcubismcore.min.js");

const CORE_URL = "https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js";
const SDK_DOWNLOAD_URL = "https://www.live2d.com/en/sdk/download/web/";
const CORE_MANUAL_URL = "https://docs.live2d.com/en/cubism-sdk-manual/cubism-core/";
const LICENSE_EN = "https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html";
const LICENSE_CN = "https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html";
const OPEN_LICENSE_EN = "https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html";
const SAMPLE_TERMS_EN = "https://www.live2d.com/eula/live2d-sample-model-terms_en.html";

const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const HELP = [
  "Live2D Agent - install Live2D Cubism Core",
  "",
  "Usage:",
  "  node scripts/setup-core.mjs [options]",
  "  npm run setup:core -- [options]",
  "",
  "Options:",
  "  --from <file>       Install a live2dcubismcore.min.js file you already have.",
  "  --download          Download Cubism 5 Web Core 6.x (SDK R5) from Live2D's",
  "                      CDN. Requires --accept-license. The CDN link can change",
  "                      or be blocked; --from is the reliable path (e.g. from",
  "                      the Cubism SDK for Web R5 zip).",
  "  --accept-license    Confirm that you accept the Live2D Proprietary Software",
  "                      License Agreement. Only used with --download.",
  "  --force             Overwrite an existing Core file.",
  "  --url <url>         Advanced: override the download URL (default: official CDN).",
  "  -h, --help          Show this help.",
  "",
  "Install target:",
  "  " + CORE_FILE,
  "",
  "This repository never bundles Cubism Core. Open-source users must download",
  "a Cubism 5 SDK for Web R5 (Core 6.x) build themselves from the official package:",
  "  " + SDK_DOWNLOAD_URL,
  "Official CDN used by --download (convenience only, may change):",
  "  " + CORE_URL,
  "Then run:",
  "  npm run setup:core -- --from <path-to>/live2dcubismcore.min.js",
  "",
  "Do not commit, package or redistribute the Core file: it is Live2D proprietary",
  "software and is not covered by this project's MIT license.",
].join("\n");

function printLicense() {
  console.log("");
  console.log("Live2D Cubism Core license (read before using Cubism Core):");
  console.log("  Live2D Proprietary Software License Agreement (EN):");
  console.log("    " + LICENSE_EN);
  console.log("  Live2D Proprietary Software License Agreement (CN):");
  console.log("    " + LICENSE_CN);
  console.log("  Live2D Open Software License Agreement (EN):");
  console.log("    " + OPEN_LICENSE_EN);
  console.log("  Live2D Sample Model Terms (models only, if you use samples):");
  console.log("    " + SAMPLE_TERMS_EN);
  console.log("  Cubism SDK for Web (package containing Cubism 5 Core R5 / 6.x):");
  console.log("    " + SDK_DOWNLOAD_URL);
  console.log("  Cubism Core manual:");
  console.log("    " + CORE_MANUAL_URL);
}

function fail(message, code = EXIT_ERROR) {
  console.error("setup:core: " + message);
  process.exitCode = code;
}

function parseArgs(argv) {
  const options = { help: false, from: null, download: false, acceptLicense: false, force: false, url: CORE_URL, errors: [] };
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
      case "--download":
        options.download = true;
        break;
      case "--accept-license":
        options.acceptLicense = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--url": {
        const value = nextValue();
        if (value !== null) options.url = value;
        break;
      }
      default:
        options.errors.push("unknown option: " + arg);
    }
  }
  return options;
}

function inspectCoreBuffer(buffer) {
  if (buffer.length < 8 * 1024) {
    return { ok: false, reason: "file is only " + buffer.length + " bytes; a Cubism Core build is much larger" };
  }
  const head = buffer.subarray(0, 256).toString("utf8").trimStart();
  if (head.startsWith("<")) {
    return { ok: false, reason: "file looks like HTML, not a JavaScript Cubism Core build" };
  }
  if (head.startsWith("{") || head.startsWith("[")) {
    return { ok: false, reason: "file looks like JSON, not a JavaScript Cubism Core build" };
  }
  const text = buffer.toString("utf8");
  if (!text.includes("Live2DCubismCore")) {
    return { ok: false, reason: "file does not define Live2DCubismCore" };
  }
  if (/<html[\s>]/i.test(text)) {
    return { ok: false, reason: "file contains an HTML page, not a JavaScript Cubism Core build" };
  }
  if (!text.includes("MocVersion_53")) {
    return {
      ok: false,
      reason: "requires Cubism 5 SDK for Web R5 / Core 6.x (MocVersion_53); this is an older Cubism Web Core build that easy-live2d 1.0.0 cannot load",
    };
  }
  return { ok: true, bytes: buffer.length };
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
}

async function readExistingCore() {
  try {
    const stat = await fs.stat(CORE_FILE);
    if (!stat.isFile()) return null;
    const buffer = await fs.readFile(CORE_FILE);
    return { stat, buffer, check: inspectCoreBuffer(buffer) };
  } catch {
    return null;
  }
}

async function writeCore(buffer, sourceLabel) {
  await fs.mkdir(CORE_DIR, { recursive: true });
  const tmp = path.join(CORE_DIR, ".live2dcubismcore.min.js." + process.pid + ".tmp");
  try {
    await fs.writeFile(tmp, buffer, { mode: 0o644 });
    await fs.rename(tmp, CORE_FILE);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
  const stat = await fs.stat(CORE_FILE);
  console.log("Installed Cubism Core (" + sourceLabel + "):");
  console.log("  " + CORE_FILE);
  console.log("  " + formatBytes(stat.size) + ", defines Live2DCubismCore and MocVersion_53 (Cubism 5 R5 / Core 6.x)");
  console.log("");
  console.log("Restart the app (quit it, then run: live2d ensure) so the renderer loads Core.");
}

async function installFromFile(sourcePath, force) {
  const source = path.resolve(sourcePath);
  let stat;
  try {
    stat = await fs.stat(source);
  } catch {
    fail("--from file not found: " + source);
    return;
  }
  if (!stat.isFile()) {
    fail("--from must point to a file, got: " + source);
    return;
  }
  if (source === path.resolve(CORE_FILE) && !force) {
    const existing = await readExistingCore();
    if (existing?.check.ok) {
      console.log("Cubism Core is already installed at:");
      console.log("  " + CORE_FILE);
      printLicense();
      return;
    }
  }
  const buffer = await fs.readFile(source);
  const check = inspectCoreBuffer(buffer);
  if (!check.ok) {
    fail("--from file is not a usable Cubism Core build: " + check.reason);
    console.error("Expected live2dcubismcore.min.js (or live2dcubismcore.js) from the Cubism 5 SDK for Web R5 package (Core 6.x).");
    printLicense();
    return;
  }
  const existing = await readExistingCore();
  if (existing && existing.check.ok && !force) {
    fail("Cubism Core already exists at " + CORE_FILE + " (use --force to overwrite).");
    return;
  }
  await writeCore(buffer, "copied from " + source);
  printLicense();
}

async function downloadCore(options) {
  if (!options.acceptLicense) {
    fail("--download requires --accept-license. Read the Live2D license terms first.");
    printLicense();
    console.error("");
    console.error("If you accept the Live2D Proprietary Software License Agreement, re-run:");
    console.error("  npm run setup:core -- --download --accept-license");
    return;
  }
  console.log("Downloading Cubism Core from Live2D's official CDN:");
  console.log("  " + options.url);
  console.log("This convenience download is provided by Live2D Inc.; you are responsible for complying with their license.");
  let buffer;
  try {
    const response = await fetch(options.url, {
      redirect: "follow",
      headers: { "User-Agent": "live2d-agent-setup-core" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error("HTTP " + response.status + " " + response.statusText);
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    fail("download failed: " + (error instanceof Error ? error.message : String(error)));
    console.error("");
    console.error("The official CDN link can change or be blocked. Download a Cubism 5 R5 / Core 6.x build manually:");
    console.error("  1. Open " + SDK_DOWNLOAD_URL);
    console.error("  2. Download the Cubism 5 SDK for Web R5 package (it contains Core/live2dcubismcore.min.js).");
    console.error("  3. Run: npm run setup:core -- --from <path-to>/live2dcubismcore.min.js");
    printLicense();
    return;
  }
  const check = inspectCoreBuffer(buffer);
  if (!check.ok) {
    fail("downloaded file is not a usable Cubism Core build: " + check.reason);
    console.error("Download the Cubism 5 SDK for Web R5 (Core 6.x) manually and pass the Core file with --from.");
    printLicense();
    return;
  }
  const existing = await readExistingCore();
  if (existing && existing.check.ok && !options.force) {
    fail("Cubism Core already exists at " + CORE_FILE + " (use --force to download again).");
    return;
  }
  console.log("Download accepted by Live2D CDN (" + formatBytes(buffer.length) + ").");
  await writeCore(buffer, "downloaded from " + options.url);
  console.log("");
  console.log("Reminder: Cubism Core is proprietary Live2D software. This project does NOT bundle or redistribute it.");
  console.log("Anyone who receives this project must obtain a Cubism 5 R5 / Core 6.x build under their own Live2D license.");
  printLicense();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.errors.length > 0) {
    for (const message of options.errors) console.error("setup:core: " + message);
    console.error("Run with --help for usage.");
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (options.from && options.download) {
    fail("choose either --from <file> or --download, not both.", EXIT_USAGE);
    return;
  }

  console.log("Live2D Agent - Cubism Core setup");
  console.log("App root:    " + APP_ROOT);
  console.log("Runtime dir: " + RUNTIME_DIR);
  console.log("Core file:   " + CORE_FILE);
  console.log("");

  const existing = await readExistingCore();
  if (existing && !options.force && !options.from && !options.download) {
    if (existing.check.ok) {
      console.log("Cubism Core is already installed (" + formatBytes(existing.stat.size) + ").");
      console.log("  " + CORE_FILE);
      printLicense();
      return;
    }
    console.log("Existing file is not a usable Cubism Core build: " + existing.check.reason);
    console.log("Replace it with --from <file> (recommended) or --download --accept-license.");
    printLicense();
    process.exitCode = EXIT_ERROR;
    return;
  }

  if (options.from) {
    await installFromFile(options.from, options.force);
    return;
  }
  if (options.download) {
    await downloadCore(options);
    return;
  }

  console.log("Cubism Core is not installed yet. This repository does not include it.");
  console.log("");
  console.log("Get a Cubism 5 SDK for Web R5 (Core 6.x) build from the official package:");
  console.log("  " + SDK_DOWNLOAD_URL);
  console.log("Then install the file you downloaded:");
  console.log("  npm run setup:core -- --from <path-to>/live2dcubismcore.min.js");
  console.log("");
  console.log("Or, after accepting Live2D's license, try the official CDN:");
  console.log("  npm run setup:core -- --download --accept-license");
  printLicense();
  process.exitCode = EXIT_ERROR;
}

main().catch((error) => {
  console.error("setup:core: unexpected failure: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = EXIT_ERROR;
});
