import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { SCREENSHOT_DIR } from "../shared/paths";
import { AgentError } from "../shared/errors";
import type { Logger } from "../shared/log";
import type { ScreenshotResult } from "../shared/client";

export interface ScreenshotBridge {
  prepareScreenshot(id: string): Promise<void>;
  finishScreenshot(id: string): void;
}

export interface CaptureOptions {
  win: BrowserWindow;
  bridge: ScreenshotBridge;
  logger: Logger;
  includeBubble?: boolean;
  settleMs?: number;
}

export async function captureScreenshot(options: CaptureOptions): Promise<ScreenshotResult> {
  const { win, bridge, logger } = options;
  if (win.isDestroyed() || !win.isVisible()) {
    throw new AgentError("WINDOW_HIDDEN", "The Live2D window is hidden; show it before taking a screenshot.", {
      details: { hint: "Run: live2d window --visible" },
    });
  }
  const id = randomUUID();
  await bridge.prepareScreenshot(id);
  try {
    const settleMs = Math.max(0, options.settleMs ?? 80);
    await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) throw new AgentError("INTERNAL", "Screenshot capture returned an empty image.");
    const png = image.toPNG();
    if (png.length === 0) throw new AgentError("INTERNAL", "Screenshot capture returned empty PNG data.");
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    const file = path.join(SCREENSHOT_DIR, Date.now() + "-" + id.slice(0, 8) + ".png");
    await fs.writeFile(file, png);
    const size = image.getSize();
    logger.info("screenshot captured", { file, width: size.width, height: size.height, bytes: png.length });
    return { path: file, width: size.width, height: size.height, bytes: png.length };
  } finally {
    bridge.finishScreenshot(id);
  }
}

export { SCREENSHOT_DIR };
