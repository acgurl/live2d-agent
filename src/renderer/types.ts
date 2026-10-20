import type { AppConfig, ModelConfig } from "../shared/config";
import type { Command, CommandResponse, ModelSummary, PublicState } from "../shared/protocol";

export interface BridgeBootstrap {
  config: AppConfig;
  activeModel: { id: string; displayName: string; entry: string; config: ModelConfig } | null;
  models: ModelSummary[];
  coreExists: boolean;
  coreUrl: string;
  appVersion: string;
}

export interface CommandPayload {
  id: string;
  command: Command | InternalModelLoad;
  timeoutMs?: number;
}

export interface InternalModelLoad {
  type: "model.load";
  id: string;
  entry: string;
  modelConfig: ModelConfig;
}

export interface ScreenshotPayload {
  id: string;
  action: "prepare" | "done";
}

export interface DragPayload {
  phase: "start" | "move" | "end";
  screenX: number;
  screenY: number;
}

export interface BridgeApi {
  getBootstrap(): Promise<BridgeBootstrap>;
  onCommand(callback: (payload: CommandPayload) => void): () => void;
  onScreenshot(callback: (payload: ScreenshotPayload) => void): () => void;
  sendReady(payload: { state: PublicState; capabilities: PublicState["capabilities"] }): void;
  sendState(payload: { state: PublicState }): void;
  sendResult(payload: { id: string; response: CommandResponse }): void;
  sendLog(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown): void;
  sendScreenshotReady(id: string): void;
  dragWindow(payload: DragPayload): void;
}

declare global {
  interface Window {
    live2dBridge?: BridgeApi;
    Live2DCubismCore?: unknown;
  }
}
