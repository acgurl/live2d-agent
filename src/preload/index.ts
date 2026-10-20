import { contextBridge, ipcRenderer } from "electron";

type CommandPayload = { id: string; command: unknown; timeoutMs?: number };
type ScreenshotPayload = { id: string; action: "prepare" | "done" };

const bridge = {
  getBootstrap: () => ipcRenderer.invoke("live2d:bootstrap"),
  onCommand: (callback: (payload: CommandPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CommandPayload) => callback(payload);
    ipcRenderer.on("live2d:command", listener);
    return () => ipcRenderer.removeListener("live2d:command", listener);
  },
  onScreenshot: (callback: (payload: ScreenshotPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ScreenshotPayload) => callback(payload);
    ipcRenderer.on("live2d:screenshot", listener);
    return () => ipcRenderer.removeListener("live2d:screenshot", listener);
  },
  sendReady: (payload: unknown) => ipcRenderer.send("renderer:ready", payload),
  sendState: (payload: unknown) => ipcRenderer.send("renderer:state", payload),
  sendResult: (payload: unknown) => ipcRenderer.send("renderer:result", payload),
  sendLog: (level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) => ipcRenderer.send("renderer:log", { level, message, meta }),
  sendScreenshotReady: (id: string) => ipcRenderer.send("renderer:screenshot-ready", { id }),
  dragWindow: (payload: { phase: "start" | "move" | "end"; screenX: number; screenY: number }) => ipcRenderer.send("window:drag", payload),
};

contextBridge.exposeInMainWorld("live2dBridge", bridge);
