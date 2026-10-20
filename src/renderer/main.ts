import "pixi.js/unsafe-eval";
import type { AppConfig } from "../shared/config";
import type { BridgeApi, BridgeBootstrap, ScreenshotPayload } from "./types";
import { Bubble } from "./bubble";
import { TtsController } from "./tts";
import { Live2DStage, coreAvailable } from "./live2d";
import { Viewer, type ViewerFatalError } from "./viewer";
import { errorMessage } from "./errors";

interface OverlayHandle {
  show(title: string, message: string): void;
  hide(): void;
}

const CORE_MISSING_MESSAGE = "Live2D Cubism Core was not found.\n\nInstall the official Cubism Core (Cubism 5 SDK for Web R5) with: npm run setup:core\n\nThis writes live2dcubismcore.min.js to ~/.live2d-agent/core/live2dcubismcore.min.js.";

function createOverlay(): OverlayHandle {
  const root = document.getElementById("overlay");
  const body = document.getElementById("overlay-body");
  if (!(root instanceof HTMLElement) || !(body instanceof HTMLElement)) {
    return { show: () => undefined, hide: () => undefined };
  }
  const heading = root.querySelector("h1");
  const titleEl = heading instanceof HTMLElement ? heading : null;
  return {
    show(title: string, message: string): void {
      if (titleEl) titleEl.textContent = title;
      body.textContent = message;
      root.hidden = false;
    },
    hide(): void {
      root.hidden = true;
    },
  };
}

function applyConfig(config: AppConfig): void {
  const style = document.documentElement.style;
  style.setProperty("--bubble-area", config.render.bubbleAreaHeight + "px");
  style.setProperty("--bubble-bg", config.bubble.background);
  style.setProperty("--bubble-color", config.bubble.color);
  style.setProperty("--bubble-font-size", config.bubble.fontSize + "px");
  style.setProperty("--bubble-rows", String(config.bubble.maxRows));
}

function readElements(): {
  stageWrap: HTMLElement;
  canvas: HTMLCanvasElement;
  bubbleRoot: HTMLElement;
  bubbleText: HTMLElement;
} | null {
  const stageWrap = document.getElementById("stage-wrap");
  const canvas = document.getElementById("stage");
  const bubbleRoot = document.getElementById("bubble");
  const bubbleText = document.getElementById("bubble-text");
  if (!(stageWrap instanceof HTMLElement)) return null;
  if (!(canvas instanceof HTMLCanvasElement)) return null;
  if (!(bubbleRoot instanceof HTMLElement)) return null;
  if (!(bubbleText instanceof HTMLElement)) return null;
  return { stageWrap, canvas, bubbleRoot, bubbleText };
}

function handleScreenshot(bridge: BridgeApi, viewer: Viewer, payload: ScreenshotPayload): void {
  if (payload.action === "prepare") {
    document.body.classList.add("capturing");
    viewer.prepareCapture();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        bridge.sendScreenshotReady(payload.id);
      });
    });
    return;
  }
  document.body.classList.remove("capturing");
}

async function boot(): Promise<void> {
  const overlay = createOverlay();
  const bridge = window.live2dBridge;
  if (!bridge) {
    overlay.show(
      "Renderer bridge unavailable",
      "window.live2dBridge is not exposed. Make sure the preload script (preload.cjs) loaded with contextIsolation enabled, then restart the app.",
    );
    return;
  }
  const elements = readElements();
  if (!elements) {
    overlay.show("Renderer markup is incomplete", "index.html is missing #stage-wrap, #stage, #bubble or #bubble-text.");
    return;
  }

  let bootstrap: BridgeBootstrap;
  try {
    bootstrap = await bridge.getBootstrap();
  } catch (error) {
    overlay.show("Cannot read the renderer bootstrap", errorMessage(error));
    return;
  }

  const config = bootstrap.config;
  applyConfig(config);
  const bubble = new Bubble(elements.bubbleRoot, elements.bubbleText, config.bubble);
  const tts = new TtsController();

  let stage: Live2DStage | null = null;
  let fatal: ViewerFatalError | undefined;
  if (!coreAvailable()) {
    overlay.show("Live2D Cubism Core is missing", CORE_MISSING_MESSAGE);
    fatal = { code: "CORE_MISSING", message: CORE_MISSING_MESSAGE };
  } else {
    try {
      stage = new Live2DStage();
      await stage.init(elements.canvas, elements.stageWrap);
    } catch (error) {
      stage = null;
      const message = errorMessage(error);
      overlay.show("Live2D renderer could not start", message);
      fatal = { code: "FEATURE_UNAVAILABLE", message };
    }
  }

  const viewer = new Viewer({
    bridge,
    config,
    stage,
    stageWrap: elements.stageWrap,
    bubble,
    tts,
    notify: {
      show: (title, message) => overlay.show(title, message),
      hide: () => overlay.hide(),
    },
  });

  bridge.onCommand((payload) => {
    void viewer.handleCommand(payload);
  });
  bridge.onScreenshot((payload) => handleScreenshot(bridge, viewer, payload));
  document.addEventListener("visibilitychange", () => viewer.visibilityChanged());
  window.addEventListener("resize", () => viewer.handleResize());
  window.addEventListener("error", (event) => {
    bridge.sendLog("error", "renderer error", { message: event.message, source: event.filename, line: event.lineno });
  });
  window.addEventListener("unhandledrejection", (event) => {
    bridge.sendLog("error", "unhandled rejection", { reason: errorMessage(event.reason) });
  });

  try {
    await viewer.start(bootstrap.activeModel, fatal);
    bridge.sendLog("info", "renderer booted", {
      model: bootstrap.activeModel?.id ?? null,
      coreVersion: stage?.getCoreVersion() ?? null,
      fps: stage?.getFps() ?? 0,
    });
  } catch (error) {
    overlay.show("Renderer failed to start", errorMessage(error));
    bridge.sendLog("error", "renderer start failed", { message: errorMessage(error) });
  }
}

void boot();
