#!/usr/bin/env node
/**
 * Live2D Agent - one-shot installer for agent integrations.
 *
 * What it does:
 *  1. Writes <runtime>/install.json so the CLI can find and auto-start the app.
 *  2. Creates stable launchers in <runtime>/bin:
 *       live2d.cmd / live2d-mcp.cmd (Windows)
 *       live2d / live2d-mcp (POSIX)
 *     The launchers run dist/cli.mjs or dist/mcp.mjs with Electron in Node mode
 *     (ELECTRON_RUN_AS_NODE=1) and fall back to a normal Node.js installation.
 *  3. Copies the skills/live2d-pet folder into the requested skills directory.
 *  4. Prints MCP config snippets for Claude Desktop, Claude Code and Cursor.
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
const BIN_DIR = path.join(RUNTIME_DIR, "bin");
const INSTALL_FILE = path.join(RUNTIME_DIR, "install.json");
const SKILL_SOURCE = path.join(APP_ROOT, "skills", "live2d-pet");
const CLI_TARGET = path.join(APP_ROOT, "dist", "cli.mjs");
const MCP_TARGET = path.join(APP_ROOT, "dist", "mcp.mjs");

const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const HELP = [
  "Live2D Agent - install the agent skill and stable launchers",
  "",
  "Usage:",
  "  node scripts/install-skill.mjs --dest <skills-dir> [options]",
  "  npm run install:skill -- --dest <skills-dir>",
  "",
  "Options:",
  "  --dest <dir>        Skills directory that receives the live2d-pet folder.",
  "                      Examples: ~/.claude/skills, .claude/skills",
  "  --electron <file>   Override the Electron executable written to install.json",
  "                      and used by the generated launchers.",
  "  --force             Replace an existing <dest>/live2d-pet folder.",
  "  -h, --help          Show this help.",
  "",
  "Creates:",
  "  " + INSTALL_FILE,
  "  " + path.join(BIN_DIR, "live2d.cmd") + " / live2d",
  "  " + path.join(BIN_DIR, "live2d-mcp.cmd") + " / live2d-mcp",
  "  <dest>/live2d-pet/SKILL.md",
  "",
  "The generated launchers prefer Electron in Node mode, then Node.js.",
  "Run npm run build (and npm run build:skill for the skill script fallback) first.",
].join("\n");

function fail(message, code = EXIT_ERROR) {
  console.error("install:skill: " + message);
  process.exitCode = code;
}

function parseArgs(argv) {
  const options = { help: false, dest: null, force: false, electron: null, errors: [] };
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
      case "--dest": {
        const value = nextValue();
        if (value !== null) options.dest = value;
        break;
      }
      case "--electron": {
        const value = nextValue();
        if (value !== null) options.electron = value;
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

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function quotePosix(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function toCrlf(text) {
  return text.replace(/\r?\n/g, "\r\n");
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readVersion() {
  try {
    const raw = await fs.readFile(path.join(APP_ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    // fall through
  }
  return "0.0.0";
}

async function resolveElectron(explicit) {
  if (explicit) return path.resolve(explicit);
  const distDir = path.join(APP_ROOT, "node_modules", "electron", "dist");
  const pathFile = path.join(APP_ROOT, "node_modules", "electron", "path.txt");
  const candidates = [];
  try {
    const relative = (await fs.readFile(pathFile, "utf8")).trim();
    if (relative.length > 0) candidates.push(path.join(distDir, relative));
  } catch {
    // keep looking
  }
  candidates.push(
    path.join(distDir, process.platform === "win32" ? "electron.exe" : "electron"),
    path.join(APP_ROOT, "node_modules", ".bin", "electron"),
  );
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return "";
}

function buildCmdLauncher(scriptPath, appRoot, electronPath) {
  const lines = [
    "@echo off",
    "rem Live2D Agent launcher generated by npm run install:skill",
    "setlocal",
    'set "LIVE2D_APP_ROOT=' + appRoot + '"',
    'set "LIVE2D_ELECTRON=' + electronPath + '"',
    'if exist "%LIVE2D_ELECTRON%" (',
    '  set "ELECTRON_RUN_AS_NODE=1"',
    '  "%LIVE2D_ELECTRON%" "' + scriptPath + '" %*',
    "  exit /b",
    ")",
    'node "' + scriptPath + '" %*',
    "exit /b",
  ];
  return toCrlf(lines.join("\n") + "\n");
}

function buildShLauncher(scriptPath, appRoot, electronPath) {
  const lines = [
    "#!/bin/sh",
    "# Live2D Agent launcher generated by npm run install:skill",
    "LIVE2D_APP_ROOT=" + quotePosix(appRoot),
    "LIVE2D_ELECTRON=" + quotePosix(electronPath),
    'if [ -n "$LIVE2D_ELECTRON" ] && [ -x "$LIVE2D_ELECTRON" ]; then',
    '  ELECTRON_RUN_AS_NODE=1 exec "$LIVE2D_ELECTRON" ' + quotePosix(scriptPath) + ' "$@"',
    "fi",
    'if command -v node >/dev/null 2>&1; then',
    '  exec node ' + quotePosix(scriptPath) + ' "$@"',
    "fi",
    'echo "live2d: neither Electron nor Node.js was found; run npm run build and re-run npm run install:skill." >&2',
    "exit 1",
  ];
  return lines.join("\n") + "\n";
}

async function writeFileAtomic(file, data, mode) {
  const tmp = file + "." + process.pid + ".tmp";
  try {
    if (mode === undefined) await fs.writeFile(tmp, data);
    else await fs.writeFile(tmp, data, { mode });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
  if (mode !== undefined) await fs.chmod(file, mode).catch(() => undefined);
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
        throw new Error("skill folder contains a symbolic link (" + source + "); remove it first");
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

async function installSkillCopy(sourceRoot, destRoot, force) {
  const exists = await pathExists(destRoot);
  if (exists && !force) {
    throw new Error("skill already exists at " + destRoot + " (use --force to replace it)");
  }
  await fs.mkdir(path.dirname(destRoot), { recursive: true });
  const temp = destRoot + ".tmp-" + process.pid + "-" + Date.now();
  try {
    const copied = await copyTree(sourceRoot, temp);
    if (exists) await fs.rm(destRoot, { recursive: true, force: true });
    await fs.rename(temp, destRoot);
    return copied;
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function mcpSnippet(launcherPath) {
  const isWindows = process.platform === "win32";
  if (isWindows) {
    return JSON.stringify(
      {
        mcpServers: {
          live2d: {
            command: "cmd",
            args: ["/c", launcherPath],
          },
        },
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      mcpServers: {
        live2d: {
          command: launcherPath,
        },
      },
    },
    null,
    2,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.errors.length > 0) {
    for (const message of options.errors) console.error("install:skill: " + message);
    console.error("Run with --help for usage.");
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (!options.dest) {
    fail("--dest <skills-dir> is required. Example: npm run install:skill -- --dest \"%USERPROFILE%\\.claude\\skills\"", EXIT_USAGE);
    return;
  }

  const version = await readVersion();
  const destRoot = expandHome(options.dest);
  const skillTarget = path.join(destRoot, "live2d-pet");
  const electron = await resolveElectron(options.electron);

  console.log("Live2D Agent - agent skill installer");
  console.log("App root:     " + APP_ROOT);
  console.log("Version:      " + version);
  console.log("Runtime dir:  " + RUNTIME_DIR);
  console.log("Skills dest:  " + destRoot);
  console.log("Electron:     " + (electron || "(not found; launchers will use node)"));
  console.log("");

  if (options.electron && electron && !(await pathExists(electron))) {
    fail("--electron file not found: " + electron);
    return;
  }
  if (!(await pathExists(SKILL_SOURCE))) {
    fail("skill source not found: " + SKILL_SOURCE + " (is this a complete checkout?)");
    return;
  }
  if (!(await pathExists(CLI_TARGET))) {
    console.warn("install:skill: warning: " + CLI_TARGET + " does not exist. Run npm run build before using the launchers.");
  }
  if (!(await pathExists(MCP_TARGET))) {
    console.warn("install:skill: warning: " + MCP_TARGET + " does not exist. Run npm run build before using the MCP server.");
  }

  const installedAt = new Date().toISOString();
  await fs.mkdir(BIN_DIR, { recursive: true });
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await writeFileAtomic(
    INSTALL_FILE,
    JSON.stringify({ appRoot: APP_ROOT, electron, packaged: false, version, installedAt }, null, 2) + "\n",
  );
  console.log("Wrote install info:");
  console.log("  " + INSTALL_FILE);

  const launchers = [
    ["live2d.cmd", buildCmdLauncher(CLI_TARGET, APP_ROOT, electron), undefined],
    ["live2d-mcp.cmd", buildCmdLauncher(MCP_TARGET, APP_ROOT, electron), undefined],
    ["live2d", buildShLauncher(CLI_TARGET, APP_ROOT, electron), 0o755],
    ["live2d-mcp", buildShLauncher(MCP_TARGET, APP_ROOT, electron), 0o755],
  ];
  for (const [name, data, mode] of launchers) {
    const file = path.join(BIN_DIR, name);
    await writeFileAtomic(file, data, mode);
    console.log("Created launcher: " + file);
  }

  try {
    const copied = await installSkillCopy(SKILL_SOURCE, skillTarget, options.force);
    console.log("");
    console.log("Installed skill (" + copied.files + " files, " + formatBytes(copied.bytes) + "):");
    console.log("  " + skillTarget);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const skillScript = path.join(skillTarget, "scripts", "live2d.mjs");
  if (!(await pathExists(skillScript))) {
    console.warn("");
    console.warn("install:skill: warning: " + skillScript + " is missing. Run npm run build:skill so the");
    console.warn("install:skill: skill's documented fallback (node <skill>/scripts/live2d.mjs) works.");
  }

  const launcherCmd = path.join(BIN_DIR, process.platform === "win32" ? "live2d.cmd" : "live2d");
  const mcpLauncher = path.join(BIN_DIR, process.platform === "win32" ? "live2d-mcp.cmd" : "live2d-mcp");
  const claudeDesktopConfig = process.platform === "win32"
    ? path.join(process.env.APPDATA ?? "%APPDATA%", "Claude", "claude_desktop_config.json")
    : path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");

  console.log("");
  console.log("Stable CLI launcher:");
  console.log("  " + launcherCmd);
  console.log("Test it with: \"" + launcherCmd + "\" version");
  console.log("");
  console.log("Agent skill destinations:");
  console.log("  This install:                    " + skillTarget);
  console.log("  Claude Code (user level):        " + path.join(os.homedir(), ".claude", "skills", "live2d-pet"));
  console.log("  Claude Code (project level):     <project>/.claude/skills/live2d-pet");
  console.log("  Other Agent Skills clients:      <their-skills-dir>/live2d-pet");
  console.log("Restart the agent/client after installing so it discovers the skill.");
  console.log("");
  console.log("MCP config (one block for Claude Desktop, Cursor or any MCP client):");
  console.log("  Claude Desktop file: " + claudeDesktopConfig);
  console.log("  Cursor file:         .cursor/mcp.json or ~/.cursor/mcp.json");
  console.log(mcpSnippet(mcpLauncher));
  console.log("");
  if (process.platform === "win32") {
    console.log("Claude Code: claude mcp add live2d -- cmd /c \"" + mcpLauncher + "\"");
  } else {
    console.log("Claude Code: claude mcp add live2d -- " + JSON.stringify(mcpLauncher));
  }
  console.log("");
  console.log("If the launcher cannot run, start the MCP server directly:");
  console.log('  node "' + MCP_TARGET + '"');
  console.log("");
  console.log("Next steps:");
  console.log('  1. "' + launcherCmd + '" version');
  console.log('  2. "' + launcherCmd + '" ensure');
  console.log("  3. Restart or add the MCP server in your agent client.");
  console.log("  4. Ask the agent to use the live2d-pet skill.");
}

main().catch((error) => {
  console.error("install:skill: unexpected failure: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = EXIT_ERROR;
});
