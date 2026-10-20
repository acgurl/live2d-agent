import { z } from "zod";
import { ERROR_CODES } from "./errors";

const ttlMs = z.number().int().min(0).max(3_600_000);
const timeoutMs = z.number().int().min(100).max(120_000);
const finiteNumber = z.number().refine((value) => Number.isFinite(value), "must be a finite number");
const priority = z.enum(["idle", "normal", "force"]);

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("expression.set"), expression: z.union([z.string().min(1).max(128), z.number().int().min(0)]), ttlMs: ttlMs.optional() }).strict(),
  z.object({ type: z.literal("expression.release") }).strict(),
  z.object({ type: z.literal("motion.play"), group: z.string().min(1).max(128), index: z.number().int().min(0).optional(), priority: priority.optional(), wait: z.boolean().optional(), timeoutMs: timeoutMs.optional() }).strict(),
  z.object({ type: z.literal("motion.stop") }).strict(),
  z.object({ type: z.literal("parameter.set"), values: z.record(z.string().min(1).max(128), finiteNumber), ttlMs: ttlMs.optional(), clamp: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("parameter.release"), ids: z.array(z.string().min(1).max(128)).max(128).optional() }).strict(),
  z.object({ type: z.literal("gaze.set"), x: z.number().min(-1).max(1), y: z.number().min(-1).max(1), ttlMs: ttlMs.optional() }).strict(),
  z.object({ type: z.literal("transform.set"), scale: z.number().min(0.1).max(4).optional(), opacity: z.number().min(0).max(1).optional() }).strict(),
  z.object({
    type: z.literal("speech.say"),
    text: z.string().max(2000).optional(),
    tts: z.boolean().optional(),
    voice: z.string().max(256).optional(),
    rate: z.number().min(0.5).max(2).optional(),
    pitch: z.number().min(0).max(2).optional(),
    audioUrl: z.string().max(2048).optional(),
    bubble: z.boolean().optional(),
    bubbleTtlMs: ttlMs.optional(),
    wait: z.boolean().optional(),
    timeoutMs: timeoutMs.optional(),
  }).strict().refine((value) => (value.text !== undefined && value.text.trim().length > 0) || value.audioUrl !== undefined, "text or audioUrl is required").refine((value) => value.audioUrl === undefined || value.audioUrl.startsWith("/audio/"), "audioUrl must be an uploaded audio URL"),
  z.object({ type: z.literal("bubble.hide") }).strict(),
  z.object({ type: z.literal("model.list") }).strict(),
  z.object({ type: z.literal("model.load"), id: z.string().regex(/^[A-Za-z0-9._-]+$/).max(128) }).strict(),
  z.object({
    type: z.literal("window.set"),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().min(200).max(4000).optional(),
    height: z.number().int().min(200).max(4000).optional(),
    alwaysOnTop: z.boolean().optional(),
    clickThrough: z.boolean().optional(),
    visible: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).some((key) => key !== "type"), "at least one window property is required"),
  z.object({ type: z.literal("screenshot.capture"), settleMs: z.number().int().min(0).max(2000).optional(), includeBubble: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("reset") }).strict(),
]);

export type Command = z.infer<typeof commandSchema>;
export type CommandType = Command["type"];

export const commandRequestSchema = z.object({
  v: z.literal(1).default(1),
  id: z.string().min(1).max(64).optional(),
  command: commandSchema,
  timeoutMs: timeoutMs.optional(),
  session: z.string().max(64).optional(),
}).strict();

export type CommandRequest = z.infer<typeof commandRequestSchema>;

export interface ErrorBody {
  code: (typeof ERROR_CODES)[number];
  message: string;
  details?: unknown;
}

export interface CommandResponse {
  v: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ErrorBody;
  state?: PublicState;
}

export interface ExpressionInfo {
  name: string;
  index: number;
}

export interface MotionInfo {
  group: string;
  index: number;
  name: string;
  loop: boolean;
}

export interface ParameterInfo {
  id: string;
  min: number;
  max: number;
}

export interface ModelSummary {
  id: string;
  displayName: string;
  entry: string;
}

export interface ModelGroups {
  lipSync: string[];
  eyeBlink: string[];
  hitAreas: string[];
}

export interface CapabilityFeatures {
  tts: boolean;
  audioLipSync: boolean;
  screenshot: boolean;
  multiModel: boolean;
  gaze: boolean;
  clickThrough: boolean;
  expressions: boolean;
  motions: boolean;
  parameters: boolean;
}

export interface Capabilities {
  modelId: string | null;
  displayName: string | null;
  expressions: ExpressionInfo[];
  motions: MotionInfo[];
  parameters: ParameterInfo[];
  groups: ModelGroups;
  features: CapabilityFeatures;
  coreVersion: string | null;
}

export interface ActiveMotion {
  group: string;
  index: number;
  startedAt: number;
  finished: boolean;
}

export interface ParameterOverride {
  id: string;
  value: number;
  expiresAt: number | null;
}

export interface SpeechState {
  speaking: boolean;
  bubble: string | null;
  tts: boolean;
  audio: boolean;
}

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  displayScale: number;
}

export interface TtsVoice {
  name: string;
  lang: string;
  default: boolean;
}

export interface LastError {
  code: string;
  message: string;
  at: number;
}

export interface PublicState {
  revision: number;
  pageReady: boolean;
  model: ModelSummary | null;
  modelError: LastError | null;
  capabilities: Capabilities;
  expression: { name: string; index: number; expiresAt: number | null } | null;
  motions: ActiveMotion[];
  overrides: ParameterOverride[];
  speech: SpeechState | null;
  window: WindowState;
  visibility: "visible" | "hidden" | "minimized";
  fps: number;
  ttsVoices: TtsVoice[];
  lastError: LastError | null;
}

export const EMPTY_CAPABILITIES: Capabilities = {
  modelId: null,
  displayName: null,
  expressions: [],
  motions: [],
  parameters: [],
  groups: { lipSync: [], eyeBlink: [], hitAreas: [] },
  features: {
    tts: true,
    audioLipSync: true,
    screenshot: true,
    multiModel: true,
    gaze: true,
    clickThrough: true,
    expressions: false,
    motions: false,
    parameters: false,
  },
  coreVersion: null,
};

export function createEmptyState(partial?: Partial<PublicState>): PublicState {
  return {
    revision: 0,
    pageReady: false,
    model: null,
    modelError: null,
    capabilities: EMPTY_CAPABILITIES,
    expression: null,
    motions: [],
    overrides: [],
    speech: null,
    window: { x: 0, y: 0, width: 420, height: 720, visible: true, alwaysOnTop: true, clickThrough: false, displayScale: 1 },
    visibility: "visible",
    fps: 0,
    ttsVoices: [],
    lastError: null,
    ...partial,
  };
}
