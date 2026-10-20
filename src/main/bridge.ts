import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { AgentError, errorPayload } from "../shared/errors";
import type { Logger } from "../shared/log";
import { createEmptyState, type Capabilities, type Command, type CommandResponse, type ModelSummary, type PublicState, type WindowState } from "../shared/protocol";
import { CORE_FILE } from "../shared/paths";
import type { AppConfig, ModelConfig } from "../shared/config";
import { listModels, resolveModel } from "./models";
import { applyWindowSet, getWindowState } from "./window";
import { captureScreenshot, type ScreenshotBridge } from "./screenshot";

interface PendingCommand {
  resolve: (value: CommandResponse) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface BridgeBootstrap {
  config: AppConfig;
  activeModel: { id: string; displayName: string; entry: string; config: ModelConfig } | null;
  models: ModelSummary[];
  coreExists: boolean;
  coreUrl: string;
  appVersion: string;
}

export interface DispatchOptions {
  timeoutMs?: number;
  session?: string;
  requestId?: string;
}

export interface Bridge extends ScreenshotBridge {
  attach(): void;
  dispatch(command: Command, options?: DispatchOptions): Promise<CommandResponse>;
  getState(): PublicState;
  getCapabilities(): Capabilities;
  isReady(): boolean;
  setWindowState(state: WindowState): void;
  setReady(value: boolean): void;
  bootstrap(): Promise<BridgeBootstrap>;
  shutdown(): void;
}

export interface BridgeOptions {
  getWindow: () => BrowserWindow | null;
  getConfig: () => AppConfig;
  allowedOrigins: () => string[];
  logger: Logger;
  onModelChanged: (id: string) => void;
  onConfigChanged: () => void;
}

interface DragState {
  bounds: { x: number; y: number; width: number; height: number };
  screenX: number;
  screenY: number;
}

export function createBridge(options: BridgeOptions): Bridge {
  const { logger } = options;
  let ready = false;
  let state = createEmptyState();
  const pending = new Map<string, PendingCommand>();
  const screenshotWaiters = new Map<string, { resolve: () => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  let drag: DragState | null = null;
  let attached = false;

  const isTrusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const win = options.getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
    const url = event.senderFrame?.url ?? event.sender.getURL();
    return options.allowedOrigins().some((origin) => url === origin || url.startsWith(origin + "/"));
  };

  const currentWindowState = (): WindowState => {
    const win = options.getWindow();
    if (!win || win.isDestroyed()) return state.window;
    return getWindowState(win, options.getConfig());
  };

  const applyState = (next: PublicState | undefined): void => {
    if (!next) return;
    state = { ...next, pageReady: ready, window: currentWindowState() };
  };

  const respond = (id: string, result: unknown): CommandResponse => ({
    v: 1,
    id,
    ok: true,
    result,
    state: bridge.getState(),
  });

  const sendToRenderer = (command: unknown, options2: DispatchOptions = {}): Promise<CommandResponse> => {
    const win = options.getWindow();
    if (!ready || !win || win.isDestroyed()) {
      return Promise.reject(new AgentError("NOT_READY", "The Live2D page is not ready yet."));
    }
    const id = randomUUID();
    const timeoutMs = options2.timeoutMs !== undefined ? options2.timeoutMs + 5_000 : defaultTimeoutFor(command);
    return new Promise<CommandResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AgentError("TIMEOUT", "The Live2D page did not answer within " + timeoutMs + "ms.", { details: { command: (command as { type?: string }).type } }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      win.webContents.send("live2d:command", { id, command, timeoutMs });
    });
  };

  const bridge: Bridge = {
    attach() {
      if (attached) return;
      attached = true;

      ipcMain.on("renderer:ready", (event, payload: { state?: PublicState; capabilities?: Capabilities } = {}) => {
        if (!isTrusted(event)) return logger.warn("ignored renderer:ready from untrusted frame");
        ready = true;
        applyState(payload.state);
        if (payload.capabilities) state.capabilities = payload.capabilities;
        logger.info("renderer ready", { model: state.model?.id ?? null, pageReady: ready });
      });

      ipcMain.on("renderer:state", (event, payload: { state?: PublicState } = {}) => {
        if (!isTrusted(event)) return;
        applyState(payload.state);
      });

      ipcMain.on("renderer:result", (event, payload: { id?: string; response?: CommandResponse } = {}) => {
        if (!isTrusted(event)) return;
        if (!payload.id || !payload.response) return;
        const entry = pending.get(payload.id);
        if (!entry) return;
        pending.delete(payload.id);
        clearTimeout(entry.timer);
        applyState(payload.response.state);
        entry.resolve(payload.response);
      });

      ipcMain.on("renderer:log", (event, payload: { level?: string; message?: string; meta?: unknown } = {}) => {
        if (!isTrusted(event)) return;
        const level = payload.level === "error" ? "error" : payload.level === "warn" ? "warn" : "info";
        logger[level]("renderer", { message: payload.message, meta: payload.meta });
      });

      ipcMain.on("renderer:screenshot-ready", (event, payload: { id?: string } = {}) => {
        if (!isTrusted(event)) return;
        if (!payload.id) return;
        const waiter = screenshotWaiters.get(payload.id);
        if (!waiter) return;
        screenshotWaiters.delete(payload.id);
        clearTimeout(waiter.timer);
        waiter.resolve();
      });

      ipcMain.on("window:drag", (event, payload: { phase?: "start" | "move" | "end"; screenX?: number; screenY?: number } = {}) => {
        if (!isTrusted(event)) return;
        const win = options.getWindow();
        if (!win || win.isDestroyed()) return;
        if (payload.phase === "start") {
          const bounds = win.getBounds();
          drag = { bounds, screenX: payload.screenX ?? 0, screenY: payload.screenY ?? 0 };
          return;
        }
        if (payload.phase === "move" && drag) {
          const dx = (payload.screenX ?? 0) - drag.screenX;
          const dy = (payload.screenY ?? 0) - drag.screenY;
          win.setPosition(Math.round(drag.bounds.x + dx), Math.round(drag.bounds.y + dy));
          return;
        }
        if (payload.phase === "end") drag = null;
      });

      ipcMain.handle("live2d:bootstrap", async (event): Promise<BridgeBootstrap> => {
        if (!isTrusted(event)) throw new AgentError("UNAUTHORIZED", "Untrusted IPC sender.");
        return bridge.bootstrap();
      });
    },

    async dispatch(command, dispatchOptions = {}) {
      const requestId = dispatchOptions.requestId ?? randomUUID();
      if (command.type === "model.list") {
        return respond(requestId, { models: await listModels(), active: state.model });
      }
      if (command.type === "model.load") {
        const model = await resolveModel(command.id);
        const result = await sendToRenderer({ type: "model.load", id: model.id, entry: model.entry, modelConfig: model.config }, { ...dispatchOptions, timeoutMs: dispatchOptions.timeoutMs ?? 30_000 });
        if (result.ok) options.onModelChanged(model.id);
        return { ...result, id: requestId };
      }
      if (command.type === "window.set") {
        const win = options.getWindow();
        if (!win || win.isDestroyed()) throw new AgentError("NOT_READY", "The Live2D window is not available.");
        const next = applyWindowSet(win, options.getConfig(), command);
        state.window = next;
        state.revision += 1;
        options.onConfigChanged();
        return respond(requestId, next);
      }
      if (command.type === "screenshot.capture") {
        const win = options.getWindow();
        if (!win || win.isDestroyed()) throw new AgentError("NOT_READY", "The Live2D window is not available.");
        const result = await captureScreenshot({ win, bridge, logger, includeBubble: command.includeBubble, settleMs: command.settleMs });
        return respond(requestId, result);
      }
      const result = await sendToRenderer(command, dispatchOptions);
      return { ...result, id: requestId };
    },

    getState() {
      return {
        ...state,
        pageReady: ready,
        capabilities: state.capabilities,
        window: currentWindowState(),
      };
    },

    getCapabilities() {
      return state.capabilities;
    },

    isReady() {
      return ready;
    },

    setWindowState(next) {
      state.window = next;
      state.revision += 1;
    },

    setReady(value) {
      ready = value;
      state.pageReady = value;
      if (!value) {
        for (const [id, entry] of pending) {
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(new AgentError("NOT_READY", "The Live2D page went away."));
        }
      }
    },

    async prepareScreenshot(id) {
      const win = options.getWindow();
      if (!ready || !win || win.isDestroyed()) throw new AgentError("NOT_READY", "The Live2D page is not ready.");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          screenshotWaiters.delete(id);
          reject(new AgentError("TIMEOUT", "The Live2D page did not prepare the screenshot in time."));
        }, 3000);
        screenshotWaiters.set(id, { resolve, reject, timer });
        win.webContents.send("live2d:screenshot", { id, action: "prepare" });
      });
    },

    finishScreenshot(id) {
      const win = options.getWindow();
      if (win && !win.isDestroyed()) win.webContents.send("live2d:screenshot", { id, action: "done" });
    },

    async bootstrap() {
      const config = options.getConfig();
      const models = await listModels();
      let active: BridgeBootstrap["activeModel"] = null;
      const preferred = config.model ? models.find((model) => model.id === config.model) : undefined;
      const chosen = preferred ?? models[0];
      if (chosen) {
        try {
          const resolved = await resolveModel(chosen.id);
          active = { id: resolved.id, displayName: resolved.displayName, entry: resolved.entry, config: resolved.config };
          if (config.model !== resolved.id) {
            config.model = resolved.id;
            options.onConfigChanged();
          }
        } catch (error) {
          logger.warn("active model is invalid", { id: chosen.id, error: errorPayload(error) });
        }
      }
      let coreExists = false;
      try { await fs.access(CORE_FILE); coreExists = true; } catch { coreExists = false; }
      return { config, activeModel: active, models, coreExists, coreUrl: "/core/live2dcubismcore.min.js", appVersion: process.env.npm_package_version ?? "0.1.0" };
    },

    shutdown() {
      ready = false;
      for (const [id, entry] of pending) {
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new AgentError("NOT_READY", "The app is shutting down."));
      }
      for (const [id, waiter] of screenshotWaiters) {
        screenshotWaiters.delete(id);
        clearTimeout(waiter.timer);
        waiter.reject(new AgentError("NOT_READY", "The app is shutting down."));
      }
    },
  };

  return bridge;
}

function defaultTimeoutFor(command: unknown): number {
  const type = (command as { type?: string }).type;
  if (type === "motion.play") {
    const motion = command as { wait?: boolean; timeoutMs?: number };
    return (motion.wait ? (motion.timeoutMs ?? 15_000) : 10_000) + 5_000;
  }
  if (type === "speech.say") {
    const speech = command as { wait?: boolean; timeoutMs?: number };
    return (speech.wait ? (speech.timeoutMs ?? 60_000) : 20_000) + 5_000;
  }
  if (type === "model.load") return 35_000;
  return 20_000;
}
