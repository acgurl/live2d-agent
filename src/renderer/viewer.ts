import type { AppConfig, ModelConfig } from "../shared/config";
import type { ErrorCode } from "../shared/errors";
import type {
  ActiveMotion,
  Capabilities,
  Command,
  ExpressionInfo,
  LastError,
  ModelSummary,
  ParameterOverride,
  PublicState,
  SpeechState,
  TtsVoice,
} from "../shared/protocol";
import type { BridgeApi, BridgeBootstrap, CommandPayload, InternalModelLoad } from "./types";
import type { Bubble } from "./bubble";
import type { TtsController } from "./tts";
import type { Live2DStage, ModelRef } from "./live2d";
import { emptyCapabilities } from "./live2d";
import { InteractionController, resolveHitAction } from "./interaction";
import { RendererError, clamp, errorMessage, isAbortError, sleep, toErrorPayload, withTimeout } from "./errors";

export interface ViewerNotify {
  show(title: string, message: string): void;
  hide(): void;
}

export interface ViewerDeps {
  bridge: BridgeApi;
  config: AppConfig;
  stage: Live2DStage | null;
  stageWrap: HTMLElement;
  bubble: Bubble;
  tts: TtsController;
  notify: ViewerNotify;
}

export interface ViewerFatalError {
  code: ErrorCode;
  message: string;
}

interface OverrideEntry {
  value: number;
  expiresAt: number | null;
  quiet: boolean;
}

type ExpressionSetCommand = Extract<Command, { type: "expression.set" }>;
type MotionPlayCommand = Extract<Command, { type: "motion.play" }>;
type ParameterSetCommand = Extract<Command, { type: "parameter.set" }>;
type ParameterReleaseCommand = Extract<Command, { type: "parameter.release" }>;
type GazeSetCommand = Extract<Command, { type: "gaze.set" }>;
type TransformSetCommand = Extract<Command, { type: "transform.set" }>;
type SpeechSayCommand = Extract<Command, { type: "speech.say" }>;

const HOVER_GAZE_TTL_MS = 250;
const STATE_DEBOUNCE_MS = 60;
const MOTION_HISTORY_LIMIT = 8;
const NO_MODEL_MESSAGE = "No Live2D model was found.\n\nAdd a model folder under ~/.live2d-agent/models. It must contain a .model3.json file plus its .moc3, textures, motions and optional expression files. Then restart the app (or send the model.load command).";
const MODEL_HELP = "Check that ~/.live2d-agent/models contains the model3.json and every file it references, then retry.";

/**
 * Central renderer controller: owns PublicState, dispatches renderer commands
 * and coordinates the stage, bubble, TTS, interactions and state reporting.
 */
export class Viewer {
  private readonly bridge: BridgeApi;
  private readonly config: AppConfig;
  private readonly stage: Live2DStage | null;
  private readonly stageWrap: HTMLElement;
  private readonly bubble: Bubble;
  private readonly tts: TtsController;
  private readonly notify: ViewerNotify;

  private interaction: InteractionController | null = null;
  private started = false;
  private ready = false;
  private revision = 0;
  private model: ModelSummary | null = null;
  private modelConfig: ModelConfig = {};
  private modelError: LastError | null = null;
  private capabilities: Capabilities;
  private expression: PublicState["expression"] = null;
  private motions: ActiveMotion[] = [];
  private overrides = new Map<string, OverrideEntry>();
  private overrideTimers = new Map<string, number>();
  private expressionTimer: number | null = null;
  private speaking = false;
  private speechFlags = { tts: false, audio: false };
  private speechBubbleTtlMs: number | null = null;
  private fps = 0;
  private ttsVoices: TtsVoice[] = [];
  private lastError: LastError | null = null;
  private stateTimer: number | null = null;
  private fpsTimer: number | null = null;
  private loadChain: Promise<void> = Promise.resolve();

  constructor(deps: ViewerDeps) {
    this.bridge = deps.bridge;
    this.config = deps.config;
    this.stage = deps.stage;
    this.stageWrap = deps.stageWrap;
    this.bubble = deps.bubble;
    this.tts = deps.tts;
    this.notify = deps.notify;
    this.capabilities = emptyCapabilities(this.stage?.getCoreVersion() ?? null);
  }

  /** Boots the renderer, loads the active model (if any) and reports ready. */
  async start(activeModel: BridgeBootstrap["activeModel"], fatalError?: ViewerFatalError): Promise<void> {
    if (fatalError) {
      this.modelError = { code: fatalError.code, message: fatalError.message, at: Date.now() };
    }
    this.bubble.configure(this.config.bubble);
    this.bubble.onChange = () => this.scheduleState();
    this.tts.onVoicesChanged = (voices) => {
      this.ttsVoices = voices;
      this.scheduleState();
    };
    this.ttsVoices = this.tts.currentVoices;
    if (this.stage) {
      this.stage.setRenderOptions({
        scale: this.config.render.scale,
        opacity: this.config.render.opacity,
        idleMotion: this.config.behavior.idleMotion,
      });
      this.stage.setUserTransform({ scale: 1, opacity: 1 });
      this.stage.setHitHandler((hit) => this.handleHit(hit.hitAreaName));
    }
    this.interaction = new InteractionController(
      this.stageWrap,
      {
        dragWindow: (payload) => this.bridge.dragWindow(payload),
        gaze: (x, y) => this.applyHoverGaze(x, y),
        releaseGaze: () => this.releaseGaze(),
      },
      {
        gazeEnabled: () => this.config.behavior.gazeFollow && this.stage !== null && this.stage.hasModel,
        dragEnabled: () => true,
      },
    );
    this.interaction.attach();

    if (this.stage && !fatalError) {
      if (activeModel) {
        try {
          await this.loadModelInternal(
            { id: activeModel.id, displayName: activeModel.displayName, entry: activeModel.entry },
            activeModel.config,
            30_000,
          );
          this.notify.hide();
        } catch (error) {
          this.recordModelError(error);
          this.notify.show("Live2D model failed to load", this.modelErrorMessage(error));
        }
      } else {
        this.notify.show("No Live2D model installed", NO_MODEL_MESSAGE);
      }
    }

    this.ready = true;
    this.started = true;
    this.fpsTimer = window.setInterval(() => {
      const fps = Math.round(this.stage?.getFps() ?? 0);
      if (fps !== this.fps) {
        this.fps = fps;
        this.scheduleState();
      }
    }, 1000);
    this.revision += 1;
    this.bridge.sendReady({ state: this.snapshot(), capabilities: this.capabilities });
  }

  /** Called by main.ts for every renderer command payload. */
  async handleCommand(payload: CommandPayload): Promise<void> {
    const { id, command } = payload;
    try {
      const result = await this.execute(command);
      this.bridge.sendResult({ id, response: { v: 1, id: "", ok: true, result, state: this.snapshot() } });
    } catch (error) {
      const body = toErrorPayload(error);
      this.lastError = { code: body.code, message: body.message, at: Date.now() };
      this.bridge.sendResult({ id, response: { v: 1, id: "", ok: false, error: body, state: this.snapshot() } });
      this.bridge.sendLog("warn", "renderer command failed", { command: (command as { type?: string }).type, error: body });
    } finally {
      this.scheduleState();
    }
  }

  /** Called when the document visibility changes. */
  visibilityChanged(): void {
    this.scheduleState();
  }

  /** Called on window resize / device pixel ratio change. */
  handleResize(): void {
    this.stage?.fit();
    this.scheduleState();
  }

  /** Called right before a screenshot is captured. */
  prepareCapture(): void {
    this.stage?.renderOnce();
  }

  dispose(): void {
    if (this.stateTimer !== null) window.clearTimeout(this.stateTimer);
    this.stateTimer = null;
    if (this.fpsTimer !== null) window.clearInterval(this.fpsTimer);
    this.fpsTimer = null;
    this.clearExpressionTimer();
    this.clearOverrideTimers();
    this.interaction?.detach();
    this.interaction = null;
  }

  snapshot(): PublicState {
    const now = Date.now();
    const bubbleText = this.bubble.visible ? this.bubble.text : null;
    let speech: SpeechState | null = null;
    if (this.speaking || bubbleText) {
      speech = {
        speaking: this.speaking,
        bubble: bubbleText,
        tts: this.speaking && this.speechFlags.tts,
        audio: this.speaking && this.speechFlags.audio,
      };
    }
    const overrides: ParameterOverride[] = [];
    for (const [id, entry] of this.overrides) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
      overrides.push({ id, value: entry.value, expiresAt: entry.expiresAt });
    }
    const expression = this.expression && (this.expression.expiresAt === null || this.expression.expiresAt > now)
      ? { ...this.expression }
      : null;
    return {
      revision: this.revision,
      pageReady: this.ready,
      model: this.model,
      modelError: this.modelError,
      capabilities: this.capabilities,
      expression,
      motions: this.motions.map((motion) => ({ ...motion })),
      overrides,
      speech,
      window: {
        x: 0,
        y: 0,
        width: this.config.window.width,
        height: this.config.window.height,
        visible: this.config.window.visible,
        alwaysOnTop: this.config.window.alwaysOnTop,
        clickThrough: this.config.window.clickThrough,
        displayScale: 1,
      },
      visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
      fps: this.fps,
      ttsVoices: this.ttsVoices,
      lastError: this.lastError,
    };
  }

  private scheduleState(): void {
    if (!this.started) return;
    if (this.stateTimer !== null) return;
    this.stateTimer = window.setTimeout(() => {
      this.stateTimer = null;
      this.revision += 1;
      this.bridge.sendState({ state: this.snapshot() });
    }, STATE_DEBOUNCE_MS);
  }

  private execute(command: Command | InternalModelLoad): Promise<unknown> {
    if (isInternalModelLoad(command)) return this.cmdModelLoad(command);
    switch (command.type) {
      case "expression.set":
        return Promise.resolve(this.cmdExpressionSet(command));
      case "expression.release":
        return Promise.resolve(this.cmdExpressionRelease());
      case "motion.play":
        return this.cmdMotionPlay(command);
      case "motion.stop":
        return Promise.resolve(this.cmdMotionStop());
      case "parameter.set":
        return Promise.resolve(this.cmdParameterSet(command));
      case "parameter.release":
        return Promise.resolve(this.cmdParameterRelease(command));
      case "gaze.set":
        return Promise.resolve(this.cmdGazeSet(command));
      case "transform.set":
        return Promise.resolve(this.cmdTransformSet(command));
      case "speech.say":
        return this.cmdSpeechSay(command);
      case "bubble.hide":
        return Promise.resolve(this.cmdBubbleHide());
      case "reset":
        return this.cmdReset();
      case "model.list":
      case "window.set":
      case "screenshot.capture":
        return Promise.resolve({ ignored: true, reason: "handled by the main process" });
      case "model.load":
        return Promise.resolve({ ignored: true, reason: "model.load is resolved by the main process" });
      default: {
        const exhaustive: never = command;
        return Promise.reject(new RendererError("BAD_REQUEST", "Unknown renderer command: " + JSON.stringify(exhaustive)));
      }
    }
  }

  private async loadModelInternal(model: ModelRef, modelConfig: ModelConfig, timeoutMs: number): Promise<void> {
    const stage = this.requireStage();
    this.clearModelState();
    await stage.loadModel(model, modelConfig, timeoutMs);
    this.modelConfig = modelConfig;
    this.model = { id: model.id, displayName: model.displayName, entry: model.entry };
    this.capabilities = this.decorateCapabilities(stage.getCapabilities());
    this.modelError = null;
    this.lastError = null;
    stage.setUserTransform({ scale: 1, opacity: 1 });
    stage.setRenderOptions({
      scale: this.config.render.scale,
      opacity: this.config.render.opacity,
      idleMotion: this.config.behavior.idleMotion,
    });
    this.applyDefaultExpression();
    this.scheduleState();
  }

  private async cmdModelLoad(payload: InternalModelLoad): Promise<unknown> {
    const model: ModelRef = {
      id: payload.id,
      displayName: payload.modelConfig.displayName ?? payload.id,
      entry: payload.entry,
    };
    try {
      await this.enqueueLoad(() => this.loadModelInternal(model, payload.modelConfig, 30_000));
    } catch (error) {
      this.recordModelError(error);
      this.notify.show("Live2D model failed to load", this.modelErrorMessage(error));
      throw error;
    }
    this.notify.hide();
    return { model: this.model, capabilities: this.capabilities };
  }

  private cmdExpressionSet(command: ExpressionSetCommand): unknown {
    const stage = this.requireStageModel();
    const expressions = this.capabilities.expressions;
    let info: ExpressionInfo | undefined;
    if (typeof command.expression === "string") {
      const wanted = command.expression;
      info = expressions.find((expression) => expression.name === wanted)
        ?? expressions.find((expression) => expression.name.toLowerCase() === wanted.toLowerCase());
    } else {
      info = expressions.find((expression) => expression.index === command.expression);
    }
    if (!info) {
      throw new RendererError("UNKNOWN_EXPRESSION", "Unknown Live2D expression: " + String(command.expression), {
        expression: command.expression,
        available: expressions.map((expression) => expression.name),
      });
    }
    stage.setExpression(info.name);
    this.clearExpressionTimer();
    const ttl = command.ttlMs ?? 0;
    this.expression = { name: info.name, index: info.index, expiresAt: ttl > 0 ? Date.now() + ttl : null };
    if (ttl > 0) {
      this.expressionTimer = window.setTimeout(() => {
        this.expressionTimer = null;
        this.releaseExpression(true);
        this.scheduleState();
      }, ttl);
    }
    this.scheduleState();
    return { expression: this.expression };
  }

  private cmdExpressionRelease(): unknown {
    this.requireStageModel();
    this.releaseExpression(true);
    this.scheduleState();
    return { expression: this.expression, released: true };
  }

  private async cmdMotionPlay(command: MotionPlayCommand): Promise<unknown> {
    const stage = this.requireStageModel();
    const motions = this.capabilities.motions;
    const groupMotions = motions.filter((motion) => motion.group === command.group);
    if (groupMotions.length === 0) {
      throw new RendererError("UNKNOWN_MOTION", "Unknown Live2D motion group: " + command.group, {
        group: command.group,
        availableGroups: Array.from(new Set(motions.map((motion) => motion.group))),
      });
    }
    const index = command.index ?? groupMotions[Math.floor(Math.random() * groupMotions.length)].index;
    if (!groupMotions.some((motion) => motion.index === index)) {
      throw new RendererError("UNKNOWN_MOTION", "Unknown motion index " + index + " in group " + command.group, {
        group: command.group,
        index,
        available: groupMotions.map((motion) => motion.index),
      });
    }
    const priority = command.priority ?? "normal";
    const entry: ActiveMotion = { group: command.group, index, startedAt: Date.now(), finished: false };
    this.pushMotion(entry);
    let resolveFinished: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const started = await stage.startMotion({
      group: command.group,
      index,
      priority,
      onFinished: () => {
        entry.finished = true;
        resolveFinished();
        this.scheduleState();
      },
    });
    if (!started.started) entry.finished = true;
    this.scheduleState();
    const result = { motion: { group: entry.group, index: entry.index, priority, started: started.started } };
    if (!command.wait || !started.started) return result;
    const timeoutMs = command.timeoutMs ?? 15_000;
    const timedOut = await Promise.race([finished.then(() => false), sleep(timeoutMs).then(() => true)]);
    if (timedOut) {
      throw new RendererError("TIMEOUT", "The Live2D motion did not finish within " + timeoutMs + "ms.", {
        group: command.group,
        index,
      });
    }
    return { ...result, finished: true };
  }

  private cmdMotionStop(): unknown {
    this.requireStageModel();
    this.stage?.stopMotions();
    let stopped = 0;
    for (const motion of this.motions) {
      if (!motion.finished) {
        motion.finished = true;
        stopped += 1;
      }
    }
    this.scheduleState();
    return { stopped };
  }

  private cmdParameterSet(command: ParameterSetCommand): unknown {
    const stage = this.requireStageModel();
    const resolved: Array<{ id: string; value: number }> = [];
    const ttl = command.ttlMs ?? 0;
    for (const [id, raw] of Object.entries(command.values)) {
      const range = stage.getParameterRange(id);
      if (!range) {
        throw new RendererError("UNKNOWN_PARAMETER", "Unknown Live2D parameter: " + id, { id });
      }
      let value = raw;
      if (command.clamp !== false) {
        value = clamp(value, range.min, range.max);
      } else if (value < range.min || value > range.max) {
        throw new RendererError("OUT_OF_RANGE", "Parameter " + id + " must be between " + range.min + " and " + range.max + ".", {
          id,
          value,
          min: range.min,
          max: range.max,
        });
      }
      resolved.push({ id, value });
    }
    for (const parameter of resolved) {
      this.setOverride(parameter.id, parameter.value, ttl > 0 ? ttl : null, false);
    }
    this.scheduleState();
    return {
      applied: resolved,
      expiresAt: ttl > 0 ? Date.now() + ttl : null,
    };
  }

  private cmdParameterRelease(command: ParameterReleaseCommand): unknown {
    this.requireStageModel();
    const ids = command.ids ?? Array.from(this.overrides.keys());
    const released: string[] = [];
    for (const id of ids) {
      if (this.releaseOverride(id, false)) released.push(id);
    }
    this.scheduleState();
    return { released };
  }

  private cmdGazeSet(command: GazeSetCommand): unknown {
    const stage = this.requireStageModel();
    const ids = stage.getGazeIds();
    if (ids.length === 0) {
      throw new RendererError("FEATURE_UNAVAILABLE", "The loaded model has no gaze parameters.", { expected: ["ParamAngleX", "ParamEyeBallX"] });
    }
    this.writeGaze(command.x, command.y, command.ttlMs ?? null, false);
    this.scheduleState();
    return { gaze: { x: command.x, y: command.y }, ids };
  }

  private cmdTransformSet(command: TransformSetCommand): unknown {
    const stage = this.requireStage();
    const current = stage.getUserTransform();
    const scale = clamp(command.scale ?? current.scale, 0.1, 4);
    const opacity = clamp(command.opacity ?? current.opacity, 0, 1);
    stage.setUserTransform({ scale, opacity });
    this.scheduleState();
    return { scale, opacity };
  }

  private async cmdSpeechSay(command: SpeechSayCommand): Promise<unknown> {
    const text = (command.text ?? "").trim();
    const audioUrl = command.audioUrl;
    const wantTts = command.tts ?? this.config.speech.tts;
    if (text.length === 0 && audioUrl === undefined) {
      throw new RendererError("BAD_REQUEST", "speech.say requires text or audioUrl.");
    }
    if (audioUrl !== undefined) {
      this.requireStageModel();
      if (!audioUrl.startsWith("/audio/")) {
        throw new RendererError("BAD_REQUEST", "audioUrl must point at an uploaded /audio/ asset.", { audioUrl });
      }
    }
    const wantsTts = audioUrl === undefined && wantTts && text.length > 0;
    if (wantsTts && !this.tts.available) {
      throw new RendererError("TTS_UNAVAILABLE", "Speech synthesis is not available in the Live2D window.");
    }
    const wantBubble = command.bubble !== false && text.length > 0 && this.config.bubble.enabled;
    const bubbleTtlMs = command.bubbleTtlMs ?? this.config.bubble.ttlMs;
    this.speechBubbleTtlMs = bubbleTtlMs;
    if (wantBubble) this.bubble.show(text, { autoHideMs: wantsTts || audioUrl !== undefined ? 0 : bubbleTtlMs });
    const flags = { tts: wantsTts, audio: audioUrl !== undefined };
    this.speaking = true;
    this.speechFlags = flags;
    this.scheduleState();
    const run = () => this.performSpeech(command, text, audioUrl, wantsTts);
    const result = { text, tts: flags.tts, audio: flags.audio, bubble: wantBubble };
    if (command.wait) {
      try {
        await run();
      } catch (error) {
        if (!isAbortError(error)) throw error;
      } finally {
        this.finishSpeech();
      }
      return { ...result, finished: true };
    }
    void run()
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        const body = toErrorPayload(error);
        this.lastError = { code: body.code, message: body.message, at: Date.now() };
        this.bridge.sendLog("warn", "speech failed", { error: body });
      })
      .finally(() => this.finishSpeech());
    return { ...result, finished: false };
  }

  private async performSpeech(command: SpeechSayCommand, text: string, audioUrl: string | undefined, wantTts: boolean): Promise<void> {
    if (audioUrl !== undefined) {
      const stage = this.requireStageModel();
      try {
        await withTimeout(stage.playVoice(audioUrl), command.timeoutMs ?? 60_000, "Audio playback did not finish in time.", { audioUrl });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new RendererError("AUDIO_UNSUPPORTED", "The audio file could not be played: " + errorMessage(error), { audioUrl });
      }
      return;
    }
    if (wantTts && text.length > 0) {
      const mouth = this.config.speech.ttsMouth && this.stage && this.stage.hasModel
        ? { stage: this.stage, ids: this.stage.getMouthIds() }
        : null;
      await this.tts.speak({
        text,
        voiceName: command.voice ?? this.config.speech.voice,
        rate: command.rate ?? this.config.speech.rate,
        pitch: command.pitch ?? this.config.speech.pitch,
        mouth,
      });
      return;
    }
    await Promise.race([this.bubble.whenIdle(), sleep(command.timeoutMs ?? 5000)]);
  }

  private cmdBubbleHide(): unknown {
    this.bubble.hide();
    this.scheduleState();
    return { hidden: true };
  }

  private async cmdReset(): Promise<unknown> {
    this.tts.cancel();
    this.bubble.hide();
    this.clearExpressionTimer();
    this.clearOverrideTimers();
    this.overrides.clear();
    this.motions = [];
    this.expression = null;
    this.speaking = false;
    this.speechFlags = { tts: false, audio: false };
    this.speechBubbleTtlMs = null;
    const stage = this.stage;
    if (stage) {
      stage.stopMotions();
      stage.stopVoice();
      stage.stopExpressions();
      stage.clearAllParameterOverrides();
      stage.setUserTransform({ scale: 1, opacity: 1 });
      stage.setRenderOptions({
        scale: this.config.render.scale,
        opacity: this.config.render.opacity,
        idleMotion: this.config.behavior.idleMotion,
      });
      if (stage.hasModel) this.applyDefaultExpression();
    }
    this.scheduleState();
    return { reset: true };
  }

  private handleHit(hitAreaName: string): void {
    try {
      if (!this.stage || !this.stage.hasModel) return;
      if (this.interaction?.hitsSuppressed()) return;
      const action = resolveHitAction(hitAreaName, this.modelConfig, this.capabilities);
      if (action.expression !== null) {
        const info = this.capabilities.expressions.find((expression) => expression.name === action.expression);
        if (info) {
          this.stage.setExpression(info.name);
          this.expression = { name: info.name, index: info.index, expiresAt: null };
        }
      }
      const motion = action.motion;
      if (motion) {
        const groupMotions = this.capabilities.motions.filter((candidate) => candidate.group === motion.group);
        const index = motion.index ?? (groupMotions.length > 0 ? groupMotions[Math.floor(Math.random() * groupMotions.length)].index : -1);
        if (index >= 0 && groupMotions.some((candidate) => candidate.index === index)) {
          const entry: ActiveMotion = { group: motion.group, index, startedAt: Date.now(), finished: false };
          this.pushMotion(entry);
          void this.stage.startMotion({
            group: motion.group,
            index,
            priority: "normal",
            onFinished: () => {
              entry.finished = true;
              this.scheduleState();
            },
          }).then((started) => {
            if (!started.started) entry.finished = true;
            this.scheduleState();
          }).catch((error: unknown) => {
            entry.finished = true;
            this.bridge.sendLog("warn", "hit motion failed", { error: errorMessage(error) });
          });
        }
      }
      if (action.say !== null) this.bubble.show(action.say);
      this.scheduleState();
    } catch (error) {
      this.bridge.sendLog("warn", "hit action failed", { error: errorMessage(error) });
    }
  }

  private applyHoverGaze(x: number, y: number): void {
    if (!this.config.behavior.gazeFollow) return;
    if (!this.stage || !this.stage.hasModel) return;
    this.writeGaze(x, y, HOVER_GAZE_TTL_MS, true);
  }

  private releaseGaze(): void {
    const stage = this.stage;
    if (!stage) return;
    let changed = false;
    for (const id of stage.getGazeIds()) {
      const entry = this.overrides.get(id);
      if (entry && entry.quiet) {
        this.releaseOverride(id, false);
        changed = true;
      }
    }
    if (changed) this.scheduleState();
  }

  private writeGaze(x: number, y: number, ttlMs: number | null, quiet: boolean): void {
    const stage = this.requireStage();
    for (const id of stage.getGazeIds()) {
      const existing = this.overrides.get(id);
      if (quiet && existing && !existing.quiet) continue;
      const range = stage.getParameterRange(id);
      if (!range) continue;
      const axis = id.endsWith("X") ? x : y;
      const maxAbs = Math.max(Math.abs(range.min), Math.abs(range.max));
      const value = clamp(axis * maxAbs, range.min, range.max);
      this.setOverride(id, value, ttlMs, quiet);
    }
  }

  private setOverride(id: string, value: number, ttlMs: number | null, quiet: boolean): void {
    const stage = this.stage;
    if (!stage) return;
    stage.setParameter(id, value);
    const now = Date.now();
    const expiresAt = ttlMs !== null && ttlMs > 0 ? now + ttlMs : null;
    const existing = this.overrides.get(id);
    if (existing) {
      existing.value = value;
      existing.expiresAt = expiresAt;
      existing.quiet = quiet && existing.quiet;
    } else {
      this.overrides.set(id, { value, expiresAt, quiet });
    }
    const timer = this.overrideTimers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.overrideTimers.delete(id);
    }
    if (expiresAt !== null) {
      this.overrideTimers.set(id, window.setTimeout(() => {
        this.overrideTimers.delete(id);
        this.releaseOverride(id, true);
      }, Math.max(0, expiresAt - now) + 10));
    }
  }

  private releaseOverride(id: string, schedule: boolean): boolean {
    const timer = this.overrideTimers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.overrideTimers.delete(id);
    }
    const existed = this.overrides.delete(id);
    this.stage?.clearParameterOverride(id);
    if (existed && schedule) this.scheduleState();
    return existed;
  }

  private pushMotion(entry: ActiveMotion): void {
    this.motions.push(entry);
    if (this.motions.length <= MOTION_HISTORY_LIMIT) return;
    const finishedIndex = this.motions.findIndex((motion) => motion.finished);
    if (finishedIndex >= 0) this.motions.splice(finishedIndex, 1);
    else this.motions.shift();
  }

  private releaseExpression(applyDefault: boolean): void {
    this.clearExpressionTimer();
    this.expression = null;
    const stage = this.stage;
    if (stage && stage.hasModel) {
      stage.stopExpressions();
      if (applyDefault) this.applyDefaultExpression();
    }
  }

  private applyDefaultExpression(): void {
    const stage = this.stage;
    if (!stage) return;
    const name = this.modelConfig.defaultExpression ?? this.config.behavior.defaultExpression;
    if (!name) {
      this.expression = null;
      return;
    }
    const info = this.capabilities.expressions.find((expression) => expression.name === name)
      ?? this.capabilities.expressions.find((expression) => expression.name.toLowerCase() === name.toLowerCase());
    if (!info) {
      this.expression = null;
      return;
    }
    stage.setExpression(info.name);
    this.expression = { name: info.name, index: info.index, expiresAt: null };
  }

  private clearExpressionTimer(): void {
    if (this.expressionTimer !== null) {
      window.clearTimeout(this.expressionTimer);
      this.expressionTimer = null;
    }
  }

  private clearOverrideTimers(): void {
    for (const timer of this.overrideTimers.values()) window.clearTimeout(timer);
    this.overrideTimers.clear();
  }

  private clearModelState(): void {
    this.tts.cancel();
    this.bubble.hide();
    this.clearExpressionTimer();
    this.clearOverrideTimers();
    this.overrides.clear();
    this.motions = [];
    this.expression = null;
    this.speaking = false;
    this.speechFlags = { tts: false, audio: false };
    this.speechBubbleTtlMs = null;
  }

  private finishSpeech(): void {
    this.speaking = false;
    this.speechFlags = { tts: false, audio: false };
    if (this.speechBubbleTtlMs !== null) {
      this.bubble.autoHideIn(this.speechBubbleTtlMs);
      this.speechBubbleTtlMs = null;
    }
    this.scheduleState();
  }

  private decorateCapabilities(capabilities: Capabilities): Capabilities {
    return {
      ...capabilities,
      features: {
        ...capabilities.features,
        tts: this.tts.available,
        screenshot: true,
        multiModel: true,
        clickThrough: true,
      },
    };
  }

  private recordModelError(error: unknown): void {
    const body = toErrorPayload(error);
    this.modelError = { code: body.code, message: body.message, at: Date.now() };
    this.lastError = this.modelError;
  }

  private modelErrorMessage(error: unknown): string {
    return errorMessage(error) + "\n\n" + MODEL_HELP;
  }

  private requireStage(): Live2DStage {
    if (!this.stage) {
      throw new RendererError("NOT_READY", "The Live2D stage is not available.");
    }
    return this.stage;
  }

  private requireStageModel(): Live2DStage {
    const stage = this.requireStage();
    if (!stage.hasModel) {
      throw new RendererError("NOT_READY", "No Live2D model is loaded.");
    }
    return stage;
  }

  private enqueueLoad<T>(task: () => Promise<T>): Promise<T> {
    const run = this.loadChain.then(task, task);
    this.loadChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

function isInternalModelLoad(value: Command | InternalModelLoad): value is InternalModelLoad {
  return value.type === "model.load" && typeof (value as InternalModelLoad).entry === "string";
}
