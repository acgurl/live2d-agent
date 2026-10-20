import { BrowserWindow, screen } from "electron";
import path from "node:path";
import type { AppConfig } from "../shared/config";
import type { Logger } from "../shared/log";
import type { WindowState } from "../shared/protocol";

export interface MainWindowHandle {
  win: BrowserWindow;
}

export interface CreateMainWindowOptions {
  config: AppConfig;
  port: number;
  devUrl?: string;
  logger: Logger;
  isQuitting: () => boolean;
  onBoundsChanged: (state: WindowState) => void;
  onClosed: () => void;
  onRendererGone: () => void;
}

export function getWindowState(win: BrowserWindow, config: AppConfig): WindowState {
  const bounds = win.getContentBounds();
  const display = screen.getDisplayMatching(bounds);
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    visible: win.isVisible(),
    alwaysOnTop: win.isAlwaysOnTop(),
    clickThrough: config.window.clickThrough,
    displayScale: display.scaleFactor,
  };
}

export function clampBounds(config: AppConfig): { x: number; y: number; width: number; height: number } {
  const primary = screen.getPrimaryDisplay();
  const width = Math.max(200, Math.min(config.window.width, primary.workArea.width));
  const height = Math.max(200, Math.min(config.window.height, primary.workArea.height));
  const target = config.window.x !== undefined || config.window.y !== undefined
    ? screen.getDisplayNearestPoint({ x: config.window.x ?? primary.workArea.x, y: config.window.y ?? primary.workArea.y })
    : primary;
  const area = target.workArea;
  const defaultX = area.x + area.width - width - 32;
  const defaultY = area.y + area.height - height - 32;
  let x = config.window.x ?? defaultX;
  let y = config.window.y ?? defaultY;
  x = Math.max(area.x, Math.min(area.x + area.width - width, x));
  y = Math.max(area.y, Math.min(area.y + area.height - height, y));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export function applyWindowSet(win: BrowserWindow, config: AppConfig, patch: { x?: number; y?: number; width?: number; height?: number; alwaysOnTop?: boolean; clickThrough?: boolean; visible?: boolean }): WindowState {
  const bounds = win.getContentBounds();
  const display = screen.getDisplayNearestPoint({ x: patch.x ?? bounds.x, y: patch.y ?? bounds.y });
  const area = display.workArea;
  const width = Math.max(200, Math.min(patch.width ?? bounds.width, 4000, area.width));
  const height = Math.max(200, Math.min(patch.height ?? bounds.height, 4000, area.height));
  const x = Math.max(area.x, Math.min(area.x + area.width - width, patch.x ?? bounds.x));
  const y = Math.max(area.y, Math.min(area.y + area.height - height, patch.y ?? bounds.y));
  if (patch.width !== undefined || patch.height !== undefined) {
    win.setContentSize(width, height);
    config.window.width = width;
    config.window.height = height;
  }
  if (patch.x !== undefined || patch.y !== undefined || patch.width !== undefined || patch.height !== undefined) {
    win.setPosition(Math.round(x), Math.round(y));
    config.window.x = Math.round(x);
    config.window.y = Math.round(y);
  }
  if (patch.alwaysOnTop !== undefined) {
    config.window.alwaysOnTop = patch.alwaysOnTop;
    win.setAlwaysOnTop(patch.alwaysOnTop, "screen-saver");
    if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(patch.alwaysOnTop, { visibleOnFullScreen: true });
  }
  if (patch.clickThrough !== undefined) {
    config.window.clickThrough = patch.clickThrough;
    win.setIgnoreMouseEvents(patch.clickThrough, { forward: true });
  }
  if (patch.visible === false) {
    config.window.visible = false;
    win.hide();
  } else if (patch.visible === true) {
    config.window.visible = true;
    win.showInactive();
  }
  return getWindowState(win, config);
}

export function createMainWindow(options: CreateMainWindowOptions): MainWindowHandle {
  const { config, port, devUrl, logger } = options;
  const bounds = clampBounds(config);
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    skipTaskbar: true,
    resizable: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: true,
    alwaysOnTop: config.window.alwaysOnTop,
    title: "Live2D Agent",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: Boolean(process.env.LIVE2D_DEV_URL) || process.env.LIVE2D_DEVTOOLS === "1",
    },
  });

  win.setMenu(null);
  win.setAlwaysOnTop(config.window.alwaysOnTop, "screen-saver");
  win.setIgnoreMouseEvents(config.window.clickThrough, { forward: true });
  if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(config.window.alwaysOnTop, { visibleOnFullScreen: true });

  let boundsTimer: NodeJS.Timeout | null = null;
  const reportBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      if (win.isDestroyed()) return;
      options.onBoundsChanged(getWindowState(win, config));
    }, 150);
  };

  win.on("move", reportBounds);
  win.on("resize", reportBounds);
  win.on("show", reportBounds);
  win.on("hide", reportBounds);
  win.on("closed", () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    options.onClosed();
  });
  win.on("close", (event) => {
    if (!options.isQuitting()) {
      event.preventDefault();
      config.window.visible = false;
      win.hide();
      options.onBoundsChanged(getWindowState(win, config));
    }
  });
  win.on("ready-to-show", () => {
    if (config.window.visible === false) {
      win.hide();
    } else {
      win.show();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    logger.error("preload-error", { preloadPath, error: String(error) });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    logger.error("render-process-gone", details);
    options.onRendererGone();
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logger.error("did-fail-load", { errorCode, errorDescription, validatedURL });
  });
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) logger.warn("renderer-console", { level, message, line, sourceId });
  });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  const url = devUrl && devUrl.length > 0 ? devUrl : "http://127.0.0.1:" + port + "/";
  logger.info("loading window", { url });
  void win.loadURL(url);

  return { win };
}
