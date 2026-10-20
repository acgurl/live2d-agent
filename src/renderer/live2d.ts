import { Application } from "pixi.js";
import { Config, Live2DSprite, Priority } from "easy-live2d";
import type { ModelConfig } from "../shared/config";
import type { Capabilities, ExpressionInfo, ModelGroups, MotionInfo, ParameterInfo } from "../shared/protocol";
import { RendererError, clamp, errorMessage, withTimeout } from "./errors";

export interface ModelRef {
  id: string;
  displayName: string;
  entry: string;
}

export interface StageModelData {
  model: ModelRef;
  modelConfig: ModelConfig;
  capabilities: Capabilities;
}

export interface HitInfo {
  hitAreaName: string;
  x: number;
  y: number;
}

export type StageHitHandler = (hit: HitInfo) => void;

export interface RenderOptions {
  scale: number;
  opacity: number;
  idleMotion: boolean;
}

export interface UserTransform {
  scale: number;
  opacity: number;
}

export type MotionPriority = "idle" | "normal" | "force";

export interface MotionStartOptions {
  group: string;
  index?: number;
  priority: MotionPriority;
  onFinished?: () => void;
}

export interface MotionStartResult {
  started: boolean;
  group: string;
  index: number;
}

export interface ParameterRange {
  min: number;
  max: number;
}

interface RawParameterModel {
  getParameterCount(): number;
  getParameterId(index: number): { getString(): string } | string;
  getParameterMinimumValue(index: number): number;
  getParameterMaximumValue(index: number): number;
}

interface ParameterOverridesLike {
  _byId?: Map<string, unknown>;
  _byIndex?: Map<number, unknown>;
}

interface SpriteInternals {
  _model?: {
    getModel?: () => RawParameterModel | null;
    _parameterOverrides?: ParameterOverridesLike;
    _expressionManager?: { stopAllMotions?: () => void };
    _motionManager?: { stopAllMotions?: () => void };
  } | null;
}

interface Model3MotionEntry {
  File?: string;
}

interface Model3Group {
  Target?: string;
  Name?: string;
  Ids?: string[];
}

interface Model3HitArea {
  Id?: string;
  Name?: string;
}

interface Model3Json {
  FileReferences?: { Motions?: Record<string, Model3MotionEntry[]> };
  Groups?: Model3Group[];
  HitAreas?: Model3HitArea[];
}

export const GAZE_PARAMETER_IDS = [
  "ParamAngleX",
  "ParamAngleY",
  "ParamEyeBallX",
  "ParamEyeBallY",
  "ParamBodyAngleX",
  "ParamBodyAngleY",
];

const MOTION_LOOP_CACHE_LIMIT = 80;

export function coreAvailable(): boolean {
  return readCubismCore() !== null;
}

export function readCoreVersion(): string | null {
  const core = readCubismCore();
  if (!core) return null;
  try {
    const raw = core.Version?.csmGetVersion?.();
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
    return ((raw >>> 24) & 0xff) + "." + ((raw >>> 16) & 0xff) + "." + ((raw >>> 8) & 0xff);
  } catch {
    return null;
  }
}

function readCubismCore(): { Version?: { csmGetVersion?: () => number } } | null {
  const core = (window as unknown as { Live2DCubismCore?: { Version?: { csmGetVersion?: () => number } } }).Live2DCubismCore;
  return core ?? null;
}

export function emptyCapabilities(coreVersion: string | null): Capabilities {
  return {
    modelId: null,
    displayName: null,
    expressions: [],
    motions: [],
    parameters: [],
    groups: { lipSync: [], eyeBlink: [], hitAreas: [] },
    features: {
      tts: true,
      audioLipSync: false,
      screenshot: true,
      multiModel: true,
      gaze: false,
      clickThrough: true,
      expressions: false,
      motions: false,
      parameters: false,
    },
    coreVersion,
  };
}

/**
 * Owns the Pixi Application and the easy-live2d Live2DSprite.
 *
 * The stage canvas is transparent; the model is fitted by aspect into the
 * host element, centred horizontally and aligned to the bottom.
 */
export class Live2DStage {
  private app: Application | null = null;
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private sprite: Live2DSprite | null = null;
  private data: StageModelData | null = null;
  private hitHandler: StageHitHandler | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private renderOptions: RenderOptions = { scale: 1, opacity: 1, idleMotion: true };
  private userTransform: UserTransform = { scale: 1, opacity: 1 };
  private parameterIndex = new Map<string, number>();
  private gazeIds: string[] = [];
  private mouthIds: string[] = [];
  private readonly coreVersion: string | null;

  constructor() {
    this.coreVersion = readCoreVersion();
  }

  get initialized(): boolean {
    return this.app !== null;
  }

  get hasModel(): boolean {
    return this.sprite !== null && this.data !== null;
  }

  async init(canvas: HTMLCanvasElement, host: HTMLElement): Promise<void> {
    this.canvas = canvas;
    this.host = host;
    Config.MouseFollow = false;
    Config.MotionSound = false;
    Config.DebugLogEnable = false;
    const app = new Application();
    try {
      await app.init({
        canvas,
        resizeTo: host,
        preference: "webgl",
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
      });
    } catch (error) {
      try {
        app.destroy();
      } catch {
        // ignore partial initialisation
      }
      throw new RendererError("FEATURE_UNAVAILABLE", "The Live2D renderer could not start WebGL 2: " + errorMessage(error));
    }
    this.app = app;
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(host);
  }

  setHitHandler(handler: StageHitHandler | null): void {
    this.hitHandler = handler;
  }

  setRenderOptions(options: Partial<RenderOptions>): void {
    this.renderOptions = { ...this.renderOptions, ...options };
    if (this.data) this.applyIdleMotion(this.data.modelConfig);
    this.fit();
  }

  getRenderOptions(): RenderOptions {
    return { ...this.renderOptions };
  }

  setUserTransform(transform: Partial<UserTransform>): void {
    this.userTransform = { ...this.userTransform, ...transform };
    this.fit();
  }

  getUserTransform(): UserTransform {
    return { ...this.userTransform };
  }

  getCoreVersion(): string | null {
    return this.coreVersion;
  }

  getModelData(): StageModelData | null {
    return this.data;
  }

  getCapabilities(): Capabilities {
    return this.data?.capabilities ?? emptyCapabilities(this.coreVersion);
  }

  getMouthIds(): string[] {
    return this.mouthIds.slice();
  }

  getGazeIds(): string[] {
    return this.gazeIds.slice();
  }

  getParameterRange(id: string): ParameterRange | null {
    const sprite = this.sprite;
    if (!sprite) return null;
    const range = sprite.getParameterValueRangeById(id);
    return range ? { min: range.min, max: range.max } : null;
  }

  async loadModel(model: ModelRef, modelConfig: ModelConfig, timeoutMs = 30_000): Promise<void> {
    const app = this.app;
    if (!app) throw new RendererError("NOT_READY", "The Live2D stage has not been initialized.");
    this.applyIdleMotion(modelConfig);
    const { modelUrl, baseUrl } = buildModelUrls(model.id, model.entry);
    const sprite = new Live2DSprite({ modelPath: modelUrl, draggable: false });
    sprite.anchor.set(0.5, 1);
    sprite.alpha = this.effectiveOpacity();
    sprite.onLive2D("hit", (hit) => {
      this.hitHandler?.({ hitAreaName: hit.hitAreaName, x: hit.x, y: hit.y });
    });
    app.stage.addChild(sprite);

    let data: StageModelData;
    let indexMap: Map<string, number>;
    let gazeIds: string[];
    let mouthIds: string[];
    try {
      await withTimeout(sprite.ready, Math.max(1000, timeoutMs), "Timed out while loading the Live2D model.", { model: model.id });
      const modelJson = await readModelJson(modelUrl);
      const parameters: ParameterInfo[] = [];
      indexMap = new Map<string, number>();
      const raw = getRawModel(sprite);
      if (raw) {
        let count = 0;
        try {
          count = raw.getParameterCount();
        } catch {
          count = 0;
        }
        for (let index = 0; index < count; index += 1) {
          try {
            const handle = raw.getParameterId(index);
            const id = typeof handle === "string" ? handle : handle.getString();
            if (typeof id !== "string" || id.length === 0) continue;
            const min = raw.getParameterMinimumValue(index);
            const max = raw.getParameterMaximumValue(index);
            parameters.push({ id, min, max });
            indexMap.set(id, index);
          } catch {
            // skip parameters that the Core refuses to expose
          }
        }
      }
      const expressions: ExpressionInfo[] = sprite.getExpressions().map((expression, index) => ({ name: expression.name, index }));
      const motions: MotionInfo[] = sprite.getMotions().map((motion) => ({
        group: motion.group,
        index: motion.no,
        name: motion.name,
        loop: /idle/i.test(motion.group),
      }));
      const groups = readGroups(modelJson);
      await fetchMotionLoops(motions, modelJson, baseUrl);
      gazeIds = GAZE_PARAMETER_IDS.filter((id) => indexMap.has(id));
      const lipSyncIds = groups.lipSync.filter((id) => indexMap.has(id));
      mouthIds = lipSyncIds.length > 0
        ? lipSyncIds
        : Array.from(indexMap.keys()).filter((id) => /mouthopen/i.test(id));
      const capabilities: Capabilities = {
        modelId: model.id,
        displayName: model.displayName,
        expressions,
        motions,
        parameters,
        groups,
        features: {
          tts: true,
          audioLipSync: lipSyncIds.length > 0,
          screenshot: true,
          multiModel: true,
          gaze: gazeIds.length > 0,
          clickThrough: true,
          expressions: expressions.length > 0,
          motions: motions.length > 0,
          parameters: parameters.length > 0,
        },
        coreVersion: this.coreVersion,
      };
      data = { model, modelConfig, capabilities };
    } catch (error) {
      if (sprite.parent) app.stage.removeChild(sprite);
      try {
        sprite.destroy();
      } catch {
        // ignore cleanup failures
      }
      throw new RendererError("MODEL_LOAD_FAILED", "The Live2D model '" + model.id + "' could not be loaded: " + errorMessage(error), {
        model: model.id,
        reason: errorMessage(error),
      });
    }

    const previous = this.sprite;
    this.sprite = sprite;
    this.data = data;
    this.parameterIndex = indexMap;
    this.gazeIds = gazeIds;
    this.mouthIds = mouthIds;
    if (previous && previous !== sprite) {
      if (previous.parent) app.stage.removeChild(previous);
      try {
        previous.destroy();
      } catch {
        // ignore cleanup failures
      }
    }
    this.fit();
  }

  fit(): void {
    const sprite = this.sprite;
    const host = this.host;
    if (!sprite || !host) return;
    const modelSize = sprite.getModelCanvasSize();
    if (!modelSize || modelSize.width <= 0 || modelSize.height <= 0) return;
    const width = host.clientWidth || this.canvas?.clientWidth || 1;
    const height = host.clientHeight || this.canvas?.clientHeight || 1;
    const modelConfig = this.data?.modelConfig ?? {};
    const baseScale = Math.min(width / modelSize.width, height / modelSize.height);
    const scale = baseScale * this.renderOptions.scale * (modelConfig.scale ?? 1) * this.userTransform.scale;
    sprite.anchor.set(0.5, 1);
    sprite.scale.set(scale);
    const offsetX = modelConfig.offsetX ?? 0;
    const offsetY = modelConfig.offsetY ?? 0;
    sprite.position.set(width / 2 + offsetX * width * 0.5, height - offsetY * height * 0.5);
    sprite.alpha = this.effectiveOpacity();
  }

  setExpression(expressionId: string): void {
    const sprite = this.requireSprite();
    sprite.setExpression({ expressionId });
  }

  setExpressionByIndex(index: number): void {
    const sprite = this.requireSprite();
    sprite.setExpression({ index });
  }

  stopExpressions(): void {
    const internals = this.sprite as unknown as SpriteInternals | null;
    internals?._model?._expressionManager?.stopAllMotions?.();
  }

  async startMotion(options: MotionStartOptions): Promise<MotionStartResult> {
    const sprite = this.requireSprite();
    const motions = this.data?.capabilities.motions ?? [];
    const candidates = motions.filter((motion) => motion.group === options.group);
    if (candidates.length === 0) {
      throw new RendererError("UNKNOWN_MOTION", "Unknown Live2D motion group: " + options.group, { group: options.group });
    }
    const index = options.index ?? candidates[Math.floor(Math.random() * candidates.length)].index;
    if (!candidates.some((motion) => motion.index === index)) {
      throw new RendererError("UNKNOWN_MOTION", "Unknown motion index " + index + " in group " + options.group, { group: options.group, index });
    }
    let handle: unknown = null;
    try {
      handle = await sprite.startMotion({
        group: options.group,
        no: index,
        priority: priorityValue(options.priority),
        onFinished: () => {
          options.onFinished?.();
        },
      });
    } catch (error) {
      throw new RendererError("UNKNOWN_MOTION", "The Live2D motion could not be started: " + errorMessage(error), {
        group: options.group,
        index,
      });
    }
    const started = handle !== null && handle !== undefined && handle !== -1;
    return { started, group: options.group, index };
  }

  stopMotions(): void {
    const internals = this.sprite as unknown as SpriteInternals | null;
    internals?._model?._motionManager?.stopAllMotions?.();
  }

  async playVoice(audioUrl: string): Promise<void> {
    const sprite = this.requireSprite();
    await sprite.playVoice({ voicePath: audioUrl, immediate: true });
  }

  stopVoice(): void {
    this.sprite?.stopVoice();
  }

  setParameter(id: string, value: number): void {
    this.sprite?.setParameterValueById(id, value);
  }

  setTransientParameter(id: string, value: number): void {
    this.sprite?.setParameterValueById(id, value);
  }

  /**
   * Clears the persistent override for one parameter. Operates on the
   * easy-live2d internal override maps behind a feature guard so a library
   * upgrade that removes them degrades to a no-op instead of throwing.
   */
  clearParameterOverride(id: string): boolean {
    const overrides = getOverrides(this.sprite);
    if (!overrides) return false;
    let cleared = false;
    if (overrides._byId instanceof Map) {
      cleared = overrides._byId.delete(id) || cleared;
    }
    const index = this.parameterIndex.get(id);
    if (index !== undefined && overrides._byIndex instanceof Map) {
      cleared = overrides._byIndex.delete(index) || cleared;
    }
    return cleared;
  }

  clearAllParameterOverrides(): boolean {
    const overrides = getOverrides(this.sprite);
    if (!overrides) return false;
    overrides._byId?.clear();
    overrides._byIndex?.clear();
    return true;
  }

  renderOnce(): void {
    try {
      this.app?.render();
    } catch {
      // ignore a failed render during teardown
    }
  }

  getFps(): number {
    return this.app?.ticker.FPS ?? 0;
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    const app = this.app;
    this.app = null;
    if (this.sprite) {
      try {
        if (this.sprite.parent) app?.stage.removeChild(this.sprite);
        this.sprite.destroy();
      } catch {
        // ignore cleanup failures
      }
      this.sprite = null;
    }
    this.data = null;
    if (app) {
      try {
        app.destroy(true, { children: true });
      } catch {
        // ignore cleanup failures
      }
    }
  }

  private requireSprite(): Live2DSprite {
    if (!this.sprite) throw new RendererError("NOT_READY", "No Live2D model is loaded.");
    return this.sprite;
  }

  private effectiveOpacity(): number {
    return clamp(this.renderOptions.opacity * this.userTransform.opacity, 0, 1);
  }

  private applyIdleMotion(modelConfig: ModelConfig): void {
    Config.MotionGroupIdle = this.renderOptions.idleMotion ? (modelConfig.idleGroup ?? "Idle") : "";
  }
}

function priorityValue(priority: MotionPriority): number {
  if (priority === "force") return Priority.Force;
  if (priority === "idle") return Priority.Idle;
  return Priority.Normal;
}

function getRawModel(sprite: Live2DSprite): RawParameterModel | null {
  const internals = sprite as unknown as SpriteInternals;
  const model = internals._model;
  if (!model || typeof model.getModel !== "function") return null;
  try {
    return model.getModel() ?? null;
  } catch {
    return null;
  }
}

function getOverrides(sprite: Live2DSprite | null): ParameterOverridesLike | null {
  if (!sprite) return null;
  const internals = sprite as unknown as SpriteInternals;
  const overrides = internals._model?._parameterOverrides;
  return overrides ?? null;
}

function buildModelUrls(id: string, entry: string): { modelUrl: string; baseUrl: string } {
  const safeId = encodeURIComponent(id);
  const safeEntry = entry
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const modelUrl = "/models/" + safeId + "/" + safeEntry;
  return { modelUrl, baseUrl: modelUrl.slice(0, modelUrl.lastIndexOf("/") + 1) };
}

async function readModelJson(url: string): Promise<Model3Json | null> {
  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) return null;
    return (await response.json()) as Model3Json;
  } catch {
    return null;
  }
}

function readGroups(json: Model3Json | null): ModelGroups {
  const groups: ModelGroups = { lipSync: [], eyeBlink: [], hitAreas: [] };
  if (!json) return groups;
  for (const group of json.Groups ?? []) {
    if (!group || group.Target !== "Parameter" || !Array.isArray(group.Ids)) continue;
    const ids = group.Ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    if (group.Name === "LipSync") groups.lipSync = ids;
    else if (group.Name === "EyeBlink") groups.eyeBlink = ids;
  }
  for (const area of json.HitAreas ?? []) {
    if (typeof area?.Name === "string" && area.Name.length > 0) groups.hitAreas.push(area.Name);
  }
  return groups;
}

async function fetchMotionLoops(motions: MotionInfo[], json: Model3Json | null, baseUrl: string): Promise<void> {
  const files = json?.FileReferences?.Motions;
  if (!files) return;
  const base = new URL(baseUrl, window.location.href);
  const limited = motions.slice(0, MOTION_LOOP_CACHE_LIMIT);
  await Promise.all(limited.map(async (motion) => {
    const file = files[motion.group]?.[motion.index]?.File;
    if (typeof file !== "string" || file.length === 0) return;
    try {
      const response = await fetch(new URL(file, base).toString(), { cache: "force-cache" });
      if (!response.ok) return;
      const parsed = (await response.json()) as { Meta?: { Loop?: unknown } };
      motion.loop = Boolean(parsed.Meta?.Loop);
    } catch {
      // Keep the heuristic loop value.
    }
  }));
}
