import fs from "node:fs/promises";
import { INSTALL_FILE, RUNTIME_FILE } from "./paths";

export interface RuntimeInfo {
  v: 1;
  baseUrl: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  version: string;
  appRoot: string;
  electron?: string;
  packaged?: boolean;
}

export async function readRuntime(): Promise<RuntimeInfo | null> {
  try {
    const raw = await fs.readFile(RUNTIME_FILE, "utf8");
    const parsed = JSON.parse(raw) as RuntimeInfo;
    if (!parsed || parsed.v !== 1 || typeof parsed.baseUrl !== "string" || typeof parsed.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeRuntime(info: RuntimeInfo): Promise<void> {
  const tmp = RUNTIME_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, RUNTIME_FILE);
}

export async function clearRuntime(): Promise<void> {
  try { await fs.unlink(RUNTIME_FILE); } catch { /* ignore */ }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export interface InstallInfo {
  appRoot: string;
  electron: string;
  packaged: boolean;
  version: string;
  installedAt: string;
}

export async function readInstall(): Promise<InstallInfo | null> {
  try {
    const raw = await fs.readFile(INSTALL_FILE, "utf8");
    const parsed = JSON.parse(raw) as InstallInfo;
    if (!parsed || typeof parsed.appRoot !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeInstall(info: InstallInfo): Promise<void> {
  const tmp = INSTALL_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(info, null, 2) + "\n");
  await fs.rename(tmp, INSTALL_FILE);
}
