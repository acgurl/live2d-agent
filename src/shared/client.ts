import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgentError, errorFromPayload } from "./errors";
import { INSTALL_FILE, LOG_FILE } from "./paths";
import { readInstall, readRuntime, isProcessAlive, type InstallInfo, type RuntimeInfo } from "./runtime";
import type { Capabilities, Command, CommandResponse, PublicState } from "./protocol";

export interface HealthInfo {
  ok: boolean;
  version: string;
  pid: number;
  pageReady: boolean;
  model: string | null;
  uptimeMs: number;
}

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
  bytes: number;
}

export interface AudioUploadResult {
  id: string;
  url: string;
  bytes: number;
}

export interface ConnectOptions {
  autoStart?: boolean;
  timeoutMs?: number;
  port?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Live2DClient {
  readonly info: RuntimeInfo;

  constructor(info: RuntimeInfo) {
    this.info = info;
  }

  static async discover(): Promise<Live2DClient | null> {
    const info = await readRuntime();
    if (!info) return null;
    if (info.pid && !isProcessAlive(info.pid)) return null;
    const client = new Live2DClient(info);
    const health = await client.health();
    return health?.ok ? client : null;
  }

  static async connect(options: ConnectOptions = {}): Promise<Live2DClient> {
    const existing = await Live2DClient.discover();
    if (existing) return existing;
    if (options.autoStart === false) {
      throw new AgentError("APP_NOT_RUNNING", "The Live2D desktop app is not running.", { details: { hint: "Run: live2d ensure" } });
    }
    await spawnApp(options.port);
    const deadline = Date.now() + (options.timeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      const client = await Live2DClient.discover();
      if (client) return client;
      await sleep(250);
    }
    const tail = await readLogTail();
    throw new AgentError("APP_NOT_RUNNING", "The Live2D desktop app did not become ready in time.", {
      details: { log: LOG_FILE, logTail: tail, hint: "Check the app log, then run: live2d ensure" },
    });
  }

  async health(timeoutMs = 1500): Promise<HealthInfo | null> {
    try {
      const response = await fetch(this.info.baseUrl + "/health", { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      return (await response.json()) as HealthInfo;
    } catch {
      return null;
    }
  }

  async request<T>(pathname: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", "Bearer " + this.info.token);
    headers.set("Accept", "application/json");
    const response = await fetch(this.info.baseUrl + pathname, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      const error = parsed && typeof parsed === "object" && "error" in parsed ? (parsed as { error?: { code?: string; message?: string; details?: unknown } }).error : undefined;
      if (error?.code && error.message) {
        throw errorFromPayload({ code: error.code as never, message: error.message, details: error.details });
      }
      throw new AgentError("INTERNAL", "HTTP " + response.status + " from " + pathname + (text ? ": " + text.slice(0, 500) : ""));
    }
    return parsed as T;
  }

  async state(): Promise<PublicState> {
    return this.request<PublicState>("/api/v1/state");
  }

  async capabilities(): Promise<Capabilities> {
    return this.request<Capabilities>("/api/v1/capabilities");
  }

  async command(command: Command, options: { timeoutMs?: number; session?: string; id?: string } = {}): Promise<CommandResponse> {
    const response = await this.request<CommandResponse>("/api/v1/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, id: options.id, command, timeoutMs: options.timeoutMs, session: options.session }),
    }, (options.timeoutMs ?? 30_000) + 5_000);
    if (!response.ok) {
      if (response.error) throw errorFromPayload(response.error);
      throw new AgentError("INTERNAL", "Command failed without an error body.");
    }
    return response;
  }

  async uploadAudio(filePath: string): Promise<AudioUploadResult> {
    const absolute = path.resolve(filePath);
    let data: Buffer;
    try {
      data = await fs.readFile(absolute);
    } catch (error) {
      throw new AgentError("BAD_REQUEST", "Cannot read audio file: " + absolute, { cause: error });
    }
    const mime = audioMimeFor(absolute);
    if (!mime) {
      throw new AgentError("AUDIO_UNSUPPORTED", "Unsupported audio extension (expected .wav, .mp3 or .ogg): " + absolute);
    }
    const response = await fetch(this.info.baseUrl + "/api/v1/audio", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + this.info.token,
        "Content-Type": mime,
        "X-File-Name": encodeURIComponent(path.basename(absolute)),
      },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      const error = parsed && typeof parsed === "object" && "error" in parsed ? (parsed as { error?: { code?: string; message?: string; details?: unknown } }).error : undefined;
      if (error?.code && error.message) throw errorFromPayload({ code: error.code as never, message: error.message, details: error.details });
      throw new AgentError("AUDIO_UNSUPPORTED", "Audio upload failed: HTTP " + response.status);
    }
    return parsed as AudioUploadResult;
  }

  async screenshot(outPath?: string, options: { includeBubble?: boolean; settleMs?: number } = {}): Promise<ScreenshotResult> {
    const response = await this.command({ type: "screenshot.capture", includeBubble: options.includeBubble, settleMs: options.settleMs }, { timeoutMs: 20_000 });
    const result = response.result as ScreenshotResult;
    if (outPath) {
      const target = path.resolve(outPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(result.path, target);
      return { ...result, path: target };
    }
    return result;
  }

  async stop(): Promise<void> {
    try {
      await this.request("/api/v1/app/quit", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 5000);
    } catch {
      // The process may already be gone.
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!(await this.health(500))) return;
      await sleep(200);
    }
  }
}

function audioMimeFor(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".wav": return "audio/wav";
    case ".mp3": return "audio/mpeg";
    case ".ogg": return "audio/ogg";
    default: return null;
  }
}

function findRepoRoot(): string | null {
  const candidates = [process.env.LIVE2D_APP_ROOT, process.cwd()].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    try {
      const stat = statSync(path.join(root, "package.json"));
      if (stat.isFile() && existsSync(path.join(root, "dist", "main.cjs"))) return root;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function resolveLaunch(): Promise<{ bin: string; args: string[] }> {
  const install: InstallInfo | null = await readInstall();
  if (install?.electron) {
    try {
      await fs.access(install.electron);
      return { bin: install.electron, args: install.packaged ? [] : [install.appRoot] };
    } catch {
      // fall through to the repository checkout
    }
  }
  const root = findRepoRoot();
  if (root) {
    const electron = process.platform === "win32"
      ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
      : path.join(root, "node_modules", ".bin", "electron");
    try {
      await fs.access(electron);
      return { bin: electron, args: [root] };
    } catch {
      // fall through
    }
  }
  throw new AgentError("APP_NOT_RUNNING", "Cannot find the Live2D desktop app to start.", {
    details: { installFile: INSTALL_FILE, hint: "Run npm run install:skill (or npm run setup) from the project first." },
  });
}

export async function spawnApp(port?: number): Promise<void> {
  const launch = await resolveLaunch();
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (port) env.LIVE2D_PORT = String(port);
  const child = spawn(launch.bin, launch.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
}

export async function readLogTail(maxBytes = 6000): Promise<string> {
  try {
    const stat = await fs.stat(LOG_FILE);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(LOG_FILE, "r");
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, stat.size - start));
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}
