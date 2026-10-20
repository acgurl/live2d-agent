import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyDefaultModel,
  cacheKeyForUrl,
  loadMainConfig,
  loadModelCatalog,
  normalizeCatalog,
  normalizeModelSpec,
  resolveModelSelection,
  writeModelConfig,
} from "../../scripts/lib/models.mjs";

const entry = {
  displayName: "Hiyori",
  url: "https://example.com/hiyori.zip",
  variant: "hiyori_pro",
  scale: 1.2,
};

describe("model catalog", () => {
  it("normalizes multiple models keyed by id", () => {
    const catalog = normalizeCatalog({ version: 1, models: { hiyori: entry, free: { ...entry, displayName: "Free", variant: "hiyori_free" } } });
    expect(Object.keys(catalog.models)).toEqual(["hiyori", "free"]);
    expect(catalog.models.hiyori.id).toBe("hiyori");
    expect(catalog.models.hiyori.variant).toBe("hiyori_pro");
    expect(catalog.models.free.displayName).toBe("Free");
  });

  it("rejects unknown catalog fields and invalid values", () => {
    expect(() => normalizeModelSpec("bad", { ...entry, url: "ftp://example.com/a.zip" })).toThrow(/http or https/);
    expect(() => normalizeModelSpec("bad", { ...entry, scale: 9 })).toThrow(/between 0.1 and 4/);
    expect(() => normalizeModelSpec("bad", { ...entry, sha256: "nope" })).toThrow(/sha256/);
    expect(() => normalizeModelSpec("bad", { ...entry, unknown: true })).toThrow(/unknown field/);
    expect(() => normalizeModelSpec("../bad", entry)).toThrow(/id must match/);
  });

  it("rejects malformed catalog documents", () => {
    expect(() => normalizeCatalog({ version: 2, models: { a: entry } })).toThrow(/version must be 1/);
    expect(() => normalizeCatalog({ version: 1, models: {} })).toThrow(/at least one model/);
    expect(() => normalizeCatalog({ version: 1 })).toThrow(/models object/);
  });
});

describe("model selection", () => {
  const catalog = {
    file: "C:\\repo\\live2d.models.json",
    models: {
      hiyori: { id: "hiyori", ...entry },
      free: { id: "free", ...entry, displayName: "Free" },
    },
  };

  it("uses models.default and models.install", () => {
    const config = { models: { default: "free", install: ["hiyori", "free"] } };
    const selection = resolveModelSelection(config, catalog);
    expect(selection.defaultId).toBe("free");
    expect(selection.installIds).toEqual(["hiyori", "free"]);
    expect(selection.installSpecs.map((spec) => spec.id)).toEqual(["hiyori", "free"]);
  });

  it("falls back to the first catalog model", () => {
    const selection = resolveModelSelection({}, catalog);
    expect(selection.defaultId).toBe("hiyori");
    expect(selection.installIds).toEqual(["hiyori"]);
  });

  it("honors --models and --model overrides", () => {
    const config = { models: { default: "hiyori", install: ["hiyori", "free"] } };
    const byList = resolveModelSelection(config, catalog, { models: "free" });
    expect(byList.defaultId).toBe("hiyori");
    expect(byList.installIds).toEqual(["free"]);

    const byModel = resolveModelSelection(config, catalog, { model: "free" });
    expect(byModel.defaultId).toBe("free");
    expect(byModel.installIds).toEqual(["free"]);

    const withDefault = resolveModelSelection(config, catalog, { models: "free", ensureDefault: true });
    expect(withDefault.installIds).toEqual(["hiyori", "free"]);
  });

  it("rejects unknown model ids", () => {
    expect(() => resolveModelSelection({ models: { default: "missing" } }, catalog)).toThrow(/not defined/);
    expect(() => resolveModelSelection({ models: { install: ["missing"] } }, catalog)).toThrow(/not defined/);
    expect(() => resolveModelSelection({ models: { default: "hiyori" } }, catalog, { model: "hiyori", models: "free" })).toThrow(/either --model or --models/);
  });
});

describe("catalog loading", () => {
  it("loads models.file relative to the main config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live2d-catalog-"));
    try {
      const configFile = path.join(dir, "live2d.config.json");
      await fs.writeFile(configFile, JSON.stringify({ version: 1, core: { url: "https://example.com/core.js" }, models: { file: "catalog.json", default: "a" } }));
      await fs.writeFile(path.join(dir, "catalog.json"), JSON.stringify({ version: 1, models: { a: entry } }));
      const config = await loadMainConfig(configFile);
      const catalog = await loadModelCatalog(configFile, config);
      expect(catalog.file).toBe(path.join(dir, "catalog.json"));
      expect(catalog.models.a.variant).toBe("hiyori_pro");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a legacy inline model when the catalog file is absent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live2d-catalog-"));
    try {
      const configFile = path.join(dir, "live2d.config.json");
      await fs.writeFile(
        configFile,
        JSON.stringify({ version: 1, core: { url: "https://example.com/core.js" }, model: { id: "legacy", url: "https://example.com/model.zip" } }),
      );
      const config = await loadMainConfig(configFile);
      const catalog = await loadModelCatalog(configFile, config);
      expect(catalog.legacy).toBe(true);
      expect(Object.keys(catalog.models)).toEqual(["legacy"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing catalog with a useful message", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live2d-catalog-"));
    try {
      const configFile = path.join(dir, "live2d.config.json");
      await fs.writeFile(configFile, JSON.stringify({ version: 1, core: { url: "https://example.com/core.js" } }));
      const config = await loadMainConfig(configFile);
      await expect(loadModelCatalog(configFile, config)).rejects.toThrow(/Model catalog not found/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("model cache and runtime config", () => {
  it("derives a stable cache key from the model URL", () => {
    expect(cacheKeyForUrl("https://example.com/a.zip")).toHaveLength(16);
    expect(cacheKeyForUrl("https://example.com/a.zip")).toBe(cacheKeyForUrl("https://example.com/a.zip"));
    expect(cacheKeyForUrl("https://example.com/a.zip")).not.toBe(cacheKeyForUrl("https://example.com/b.zip"));
  });

  it("writes only defined display fields and preserves manual tweaks", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live2d-model-config-"));
    try {
      await fs.writeFile(path.join(dir, "live2d-agent.json"), JSON.stringify({ displayName: "Mine", hitActions: { Head: { say: "hi" } } }));
      await writeModelConfig(dir, { id: "custom", scale: 1.1, offsetY: -0.05 });
      const config = JSON.parse(await fs.readFile(path.join(dir, "live2d-agent.json"), "utf8"));
      expect(config).toEqual({ displayName: "Mine", hitActions: { Head: { say: "hi" } }, scale: 1.1, offsetY: -0.05 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("updates the active model without wiping other runtime settings", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live2d-runtime-"));
    try {
      await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ version: 1, model: "old", window: { width: 300 } }));
      await applyDefaultModel(dir, "hiyori-free");
      const config = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8"));
      expect(config.model).toBe("hiyori-free");
      expect(config.window.width).toBe(300);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
