import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commandRequestSchema, commandSchema } from "../../src/shared/protocol";
import { normalizeConfig } from "../../src/shared/config";
import { validateModelJson } from "../../src/main/models";

describe("command protocol", () => {
  it("accepts a minimal expression command", () => {
    const parsed = commandSchema.parse({ type: "expression.set", expression: "smile" });
    expect(parsed.type).toBe("expression.set");
  });

  it("rejects unknown properties", () => {
    expect(() => commandSchema.parse({ type: "reset", extra: true })).toThrow();
  });

  it("requires text or audio for speech", () => {
    expect(() => commandSchema.parse({ type: "speech.say", tts: true })).toThrow();
    const parsed = commandSchema.parse({ type: "speech.say", text: "hi", tts: true });
    expect(parsed.type).toBe("speech.say");
  });

  it("requires at least one window property", () => {
    expect(() => commandSchema.parse({ type: "window.set" })).toThrow();
    expect(commandSchema.parse({ type: "window.set", visible: false }).type).toBe("window.set");
  });

  it("fills the protocol version", () => {
    const parsed = commandRequestSchema.parse({ command: { type: "reset" } });
    expect(parsed.v).toBe(1);
  });
});

describe("config normalization", () => {
  it("deep-merges partial config with defaults", () => {
    const config = normalizeConfig({ window: { width: 300 } });
    expect(config.window.width).toBe(300);
    expect(config.window.height).toBe(720);
    expect(config.render.scale).toBe(1);
  });
});

describe("model validation", () => {
  it("accepts a minimal model", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live2d-model-"));
    try {
      await fs.writeFile(path.join(dir, "m.moc3"), "moc");
      await fs.writeFile(path.join(dir, "t.png"), "png");
      await fs.writeFile(path.join(dir, "m.model3.json"), JSON.stringify({ Version: 3, FileReferences: { Moc: "m.moc3", Textures: ["t.png"] } }));
      const json = await validateModelJson(dir, "m.model3.json");
      expect(json.Version).toBe(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a model that escapes its directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live2d-model-"));
    try {
      await fs.writeFile(path.join(dir, "..", "escape.moc3"), "moc").catch(() => undefined);
      await fs.writeFile(path.join(dir, "m.model3.json"), JSON.stringify({ Version: 3, FileReferences: { Moc: "../escape.moc3", Textures: ["t.png"] } }));
      await expect(validateModelJson(dir, "m.model3.json")).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
