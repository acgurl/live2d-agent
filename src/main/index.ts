import { app, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { APP_VERSION } from "../shared/version";
import { AUDIO_DIR, CONFIG_FILE, ensureRuntimeDirsSync, LOG_FILE, RUNTIME_FILE } from "../shared/paths";
import { readConfigFile, writeConfigFile, type AppConfig } from "../shared/config";
import { createLogger, type Logger } from "../shared/log";
import { writeInstall, writeRuntime } from "../shared/runtime";
import { createBridge, type Bridge } from "./bridge";
import { startServer, type ServerHandle } from "./server";
import { createMainWindow, type MainWindowHandle } from "./window";
import { AudioCache } from "./audio";
import { createTray, type TrayHandle } from "./tray";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.setName("Live2D Agent");

let config: AppConfig;
let logger: Logger;
let bridge: Bridge;
let server: ServerHandle | null = null;
let windowHandle: MainWindowHandle | null = null;
let trayHandle: TrayHandle | null = null;
let quitting = false;
let serverPort = 0;
let saveTimer: NodeJS.Timeout | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  registerLifecycle();
  void app.whenReady().then(bootstrap).catch((error) => {
    logger?.error("startup failed", String(error));
    dialog.showErrorBox("Live2D Agent failed to start", error instanceof Error ? error.stack ?? error.message : String(error));
    app.quit();
  });
}

function registerLifecycle(): void {
  app.on("second-instance", () => showWindow());
  app.on("activate", () => showWindow());
  app.on("window-all-closed", () => {
    // Keep the tray app alive on every platform.
  });
  app.on("before-quit", () => {
    quitting = true;
    bridge?.shutdown();
    saveConfigNow();
  });
  app.on("will-quit", () => {
    try { fs.unlinkSync(RUNTIME_FILE); } catch { /* ignore */ }
    void server?.close();
  });
  process.on("uncaughtException", (error) => {
    logger?.error("uncaughtException", error instanceof Error ? error.stack ?? error.message : String(error));
  });
  process.on("unhandledRejection", (reason) => {
    logger?.error("unhandledRejection", String(reason));
  });
}

async function bootstrap(): Promise<void> {
  ensureRuntimeDirsSync();
  config = await readConfigFile();
  logger = createLogger("main", { file: LOG_FILE });
  logger.info("booting", { version: APP_VERSION, packaged: app.isPackaged, appPath: app.getAppPath() });

  const token = randomBytes(32).toString("hex");
  bridge = createBridge({
    getWindow: () => windowHandle?.win ?? null,
    getConfig: () => config,
    allowedOrigins: () => {
      const origins = ["http://127.0.0.1:" + serverPort, "http://localhost:" + serverPort];
      const dev = process.env.LIVE2D_DEV_URL;
      if (dev) {
        try { origins.push(new URL(dev).origin); } catch { /* ignore */ }
      }
      return origins;
    },
    logger,
    onModelChanged: (id) => { config.model = id; scheduleSave(); },
    onConfigChanged: () => scheduleSave(),
  });
  bridge.attach();

  const audio = new AudioCache(AUDIO_DIR);
  server = await startServer({
    config,
    token,
    bridge,
    audio,
    logger,
    rendererDir: path.join(app.getAppPath(), "dist", "renderer"),
    quit: () => app.quit(),
  });
  serverPort = server.port;

  const runtime = {
    v: 1 as const,
    baseUrl: "http://127.0.0.1:" + serverPort,
    port: serverPort,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: APP_VERSION,
    appRoot: app.getAppPath(),
    electron: process.execPath,
    packaged: app.isPackaged,
  };
  await writeRuntime(runtime);
  await writeInstall({
    appRoot: app.getAppPath(),
    electron: process.execPath,
    packaged: app.isPackaged,
    version: APP_VERSION,
    installedAt: new Date().toISOString(),
  });
  logger.info("runtime ready", { port: serverPort, runtimeFile: RUNTIME_FILE });

  createWindow();
  trayHandle = createTray({
    bridge,
    getConfig: () => config,
    getWindow: () => windowHandle?.win ?? null,
    show: showWindow,
    quit: () => app.quit(),
    logger,
  });
}

function createWindow(): void {
  if (windowHandle && !windowHandle.win.isDestroyed()) return;
  windowHandle = createMainWindow({
    config,
    port: serverPort,
    devUrl: process.env.LIVE2D_DEV_URL,
    logger,
    isQuitting: () => quitting,
    onBoundsChanged: (state) => {
      bridge.setWindowState(state);
      config.window.x = state.x;
      config.window.y = state.y;
      config.window.visible = state.visible;
      scheduleSave();
      trayHandle?.refresh();
    },
    onClosed: () => {
      windowHandle = null;
      bridge?.setReady(false);
    },
    onRendererGone: () => {
      bridge?.setReady(false);
      setTimeout(() => {
        if (!quitting && windowHandle && !windowHandle.win.isDestroyed()) {
          logger.warn("reloading renderer after crash");
          windowHandle.win.reload();
        }
      }, 800);
    },
  });
}

function showWindow(): void {
  if (!app.isReady()) return;
  if (!windowHandle || windowHandle.win.isDestroyed()) {
    createWindow();
    return;
  }
  config.window.visible = true;
  windowHandle.win.show();
  windowHandle.win.focus();
  bridge?.setWindowState({
    ...bridge.getState().window,
    visible: true,
  });
  trayHandle?.refresh();
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void writeConfigFile(config).catch((error) => logger?.warn("config save failed", String(error)));
  }, 400);
}

function saveConfigNow(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!config) return;
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  } catch {
    // best effort during shutdown
  }
}
