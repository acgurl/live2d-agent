import fs from "node:fs/promises";
import { Command, CommanderError } from "commander";
import { Live2DClient, type AudioUploadResult, type HealthInfo, type ScreenshotResult } from "../shared/client";
import { AgentError, errorPayload } from "../shared/errors";
import { LOG_FILE, RUNTIME_DIR } from "../shared/paths";
import type {
  Capabilities,
  Command as ApiCommand,
  CommandResponse,
  ModelSummary,
  PublicState,
  TtsVoice,
  WindowState,
} from "../shared/protocol";
import { readRuntime, type RuntimeInfo } from "../shared/runtime";
import { APP_VERSION, PROTOCOL_VERSION } from "../shared/version";

type Globals = {
  json?: boolean;
  timeout?: string;
  url?: string;
  token?: string;
  start?: boolean;
};

interface ModelListResult {
  models?: ModelSummary[];
  active?: ModelSummary | null;
}

interface SayOptions {
  tts?: boolean;
  voice?: string;
  audio?: string;
  ttl?: string;
  wait?: boolean;
}

const program = new Command();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* Output and exit codes                                                       */
/* -------------------------------------------------------------------------- */

function globals(): Globals {
  return program.opts<Globals>();
}

function jsonMode(): boolean {
  return Boolean(globals().json);
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function printHuman(text: string): void {
  process.stdout.write(text + "\n");
}

function diagnostic(message: string): void {
  process.stderr.write(message + "\n");
}

function output(jsonValue: unknown, humanText: string): void {
  if (jsonMode()) writeJson(jsonValue);
  else printHuman(humanText);
}

const CAPABILITY_CODES = new Set<string>([
  "NOT_READY",
  "CORE_MISSING",
  "MODEL_MISSING",
  "MODEL_LOAD_FAILED",
  "MODEL_INVALID",
  "UNSUPPORTED_MODEL",
  "UNKNOWN_EXPRESSION",
  "UNKNOWN_MOTION",
  "UNKNOWN_PARAMETER",
  "OUT_OF_RANGE",
  "FEATURE_UNAVAILABLE",
  "AUDIO_UNSUPPORTED",
  "AUDIO_TOO_LARGE",
  "TTS_UNAVAILABLE",
  "WINDOW_HIDDEN",
]);

function exitCodeFor(error: unknown): number {
  const code = errorPayload(error).code;
  switch (code) {
    case "APP_NOT_RUNNING":
      return 2;
    case "TIMEOUT":
      return 3;
    case "BAD_REQUEST":
      return 5;
    case "UNAUTHORIZED":
    case "RATE_LIMITED":
    case "BUSY":
    case "INTERNAL":
      return 6;
    default:
      return CAPABILITY_CODES.has(code) ? 4 : 6;
  }
}

function badArg(message: string): never {
  throw new AgentError("BAD_REQUEST", message);
}

function printHint(details: unknown): void {
  if (!details || typeof details !== "object") return;
  const hint = (details as Record<string, unknown>).hint;
  if (typeof hint === "string" && hint.length > 0) diagnostic("hint: " + hint);
}

function reportError(error: unknown): number {
  const payload = errorPayload(error);
  if (jsonMode()) writeJson({ ok: false, error: payload });
  diagnostic("error (" + payload.code + "): " + payload.message);
  printHint(payload.details);
  return exitCodeFor(error);
}

function jsonModeFromArgv(): boolean {
  return process.argv.slice(2).includes("--json");
}

/* -------------------------------------------------------------------------- */
/* Argument parsing helpers                                                    */
/* -------------------------------------------------------------------------- */

function parseIntegerOption(raw: string | undefined, flag: string, limits: { min?: number; max?: number; fallback?: number } = {}): number {
  if (raw === undefined) {
    if (limits.fallback !== undefined) return limits.fallback;
    badArg(flag + " is required.");
  }
  const text = String(raw).trim();
  if (!/^[-+]?\d+$/.test(text)) badArg(flag + " must be an integer.");
  const value = Number(text);
  if (!Number.isSafeInteger(value)) badArg(flag + " must be a safe integer.");
  if (limits.min !== undefined && value < limits.min) badArg(flag + " must be at least " + limits.min + ".");
  if (limits.max !== undefined && value > limits.max) badArg(flag + " must be at most " + limits.max + ".");
  return value;
}

function parseNumberArgument(raw: string, label: string, min: number, max: number): number {
  const text = String(raw).trim();
  if (text.length === 0) badArg(label + " is required.");
  const value = Number(text);
  if (!Number.isFinite(value)) badArg(label + " must be a finite number.");
  if (value < min || value > max) badArg(label + " must be between " + min + " and " + max + ".");
  return value;
}

function parseTtl(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return parseIntegerOption(raw, "--ttl", { min: 0, max: 3_600_000 });
}

function resolveTimeout(fallback = 30_000): number {
  const raw = globals().timeout;
  if (raw === undefined) return fallback;
  return parseIntegerOption(raw, "--timeout", { min: 100, max: 120_000 });
}

function pageWaitTimeout(): number {
  const raw = globals().timeout;
  return raw === undefined ? 15_000 : resolveTimeout(15_000);
}

/* -------------------------------------------------------------------------- */
/* Connection helpers                                                          */
/* -------------------------------------------------------------------------- */

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : "http://" + trimmed;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    badArg("--url is not a valid URL: " + input);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    badArg("--url must use http or https.");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

function portFromBaseUrl(baseUrl: string): number {
  const parsed = new URL(baseUrl);
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

async function connectClient(options: { timeoutMs?: number } = {}): Promise<Live2DClient> {
  const current = globals();
  const timeoutMs = options.timeoutMs ?? resolveTimeout();
  const rawUrl = current.url?.trim();
  const token = current.token?.trim();
  if (rawUrl || token) {
    const discovered = await Live2DClient.discover();
    const base: RuntimeInfo | null = discovered?.info ?? (await readRuntime());
    if (rawUrl && !token && !base) {
      badArg("--token is required when --url is used and no running app was discovered.");
    }
    const baseUrl = rawUrl ? normalizeBaseUrl(rawUrl) : base!.baseUrl;
    const authToken = token ?? base?.token;
    if (!authToken) badArg("A token is required; pass --token or start the app with: live2d ensure");
    const info: RuntimeInfo = {
      v: 1,
      baseUrl,
      port: base?.port ?? portFromBaseUrl(baseUrl),
      token: authToken,
      pid: base?.pid ?? 0,
      startedAt: base?.startedAt ?? new Date().toISOString(),
      version: base?.version ?? APP_VERSION,
      appRoot: base?.appRoot ?? process.cwd(),
    };
    if (base?.electron !== undefined) info.electron = base.electron;
    if (base?.packaged !== undefined) info.packaged = base.packaged;
    const client = new Live2DClient(info);
    const health = await client.health(Math.min(timeoutMs, 3_000));
    if (!health?.ok) {
      throw new AgentError("APP_NOT_RUNNING", "No Live2D app answered at " + baseUrl, {
        details: { hint: "Start the app with: live2d ensure" },
      });
    }
    return client;
  }
  return Live2DClient.connect({ autoStart: current.start !== false, timeoutMs });
}

async function awaitPageReady(client: Live2DClient, timeoutMs: number): Promise<PublicState> {
  const deadline = Date.now() + timeoutMs;
  let last: PublicState | null = null;
  while (Date.now() < deadline) {
    try {
      last = await client.state();
    } catch {
      last = null;
    }
    if (last?.pageReady) return last;
    await sleep(150);
  }
  throw new AgentError("TIMEOUT", "The Live2D page did not become ready within " + timeoutMs + "ms.", {
    details: { pageReady: last?.pageReady ?? false, hint: "Inspect the app log with: live2d logs" },
  });
}

async function stateOf(client: Live2DClient, response: CommandResponse): Promise<PublicState> {
  return response.state ?? (await client.state());
}

/* -------------------------------------------------------------------------- */
/* Human-readable formatting                                                   */
/* -------------------------------------------------------------------------- */

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return Math.round(ms) + "ms";
  const seconds = ms / 1000;
  if (seconds < 60) return (seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))) + "s";
  const minutes = Math.floor(seconds / 60);
  return minutes + "m " + Math.round(seconds % 60) + "s";
}

function formatRemaining(expiresAt: number): string {
  const remaining = expiresAt - Date.now();
  return remaining > 0 ? formatDuration(remaining) + " left" : "expired";
}

function formatModel(model: ModelSummary | null): string {
  return model ? model.id + " (" + model.displayName + ")" : "none";
}

function describeWindow(window: WindowState): string {
  return (
    window.width +
    "x" +
    window.height +
    " at " +
    window.x +
    "," +
    window.y +
    " | " +
    (window.visible ? "visible" : "hidden") +
    " | " +
    (window.alwaysOnTop ? "always on top" : "normal") +
    (window.clickThrough ? " | click-through" : "")
  );
}

function describeExpression(state: PublicState): string {
  const expression = state.expression;
  if (!expression) return "none";
  const suffix = expression.expiresAt ? " (" + formatRemaining(expression.expiresAt) + ")" : "";
  return expression.name + " (index " + expression.index + ")" + suffix;
}

function describeSpeech(state: PublicState): string {
  const speech = state.speech;
  if (!speech || !speech.speaking) return "idle";
  const modes = [speech.tts ? "tts" : null, speech.audio ? "audio" : null].filter((mode): mode is string => mode !== null);
  const bubble = speech.bubble ? " bubble: " + JSON.stringify(speech.bubble) : "";
  return "speaking" + (modes.length > 0 ? " (" + modes.join(", ") + ")" : "") + bubble;
}

function describeFeatures(features: Capabilities["features"]): string {
  return Object.entries(features)
    .map(([key, value]) => key + "=" + (value ? "yes" : "no"))
    .join(" ");
}

function describeGroups(groups: Capabilities["groups"]): string {
  const parts = [
    "lipSync=[" + groups.lipSync.join(", ") + "]",
    "eyeBlink=[" + groups.eyeBlink.join(", ") + "]",
    "hitAreas=[" + groups.hitAreas.join(", ") + "]",
  ];
  return parts.join(" | ");
}

function humanEnsure(client: Live2DClient, health: HealthInfo, state: PublicState, waitedMs: number): string {
  const capabilities = state.capabilities;
  return [
    "Live2D app is ready.",
    "  App:    pid " + health.pid + ", " + client.info.baseUrl + ", uptime " + formatDuration(health.uptimeMs),
    "  Model:  " + formatModel(state.model) + " — " + capabilities.expressions.length + " expressions, " + capabilities.motions.length + " motions, " + capabilities.parameters.length + " parameters",
    "  Window: " + describeWindow(state.window),
    "Ready in " + formatDuration(waitedMs) + ".",
  ].join("\n");
}

function humanStatus(client: Live2DClient, health: HealthInfo, state: PublicState): string {
  const capabilities = state.capabilities;
  const lines: string[] = [];
  lines.push("Live2D Agent " + health.version + " — running");
  lines.push("  App:          pid " + health.pid + ", " + client.info.baseUrl + ", up " + formatDuration(health.uptimeMs));
  lines.push("  Page:         " + (state.pageReady ? "ready" : "not ready"));
  lines.push("  Model:        " + formatModel(state.model));
  if (state.model) {
    lines.push(
      "  Capabilities: " +
        capabilities.expressions.length +
        " expressions, " +
        capabilities.motions.length +
        " motions, " +
        capabilities.parameters.length +
        " parameters" +
        (capabilities.coreVersion ? ", core " + capabilities.coreVersion : ""),
    );
  }
  lines.push("  Expression:   " + describeExpression(state));
  lines.push(
    "  Motions:      " +
      (state.motions.length > 0
        ? state.motions.map((motion) => motion.group + " #" + motion.index + (motion.finished ? " (finished)" : "")).join(", ")
        : "none"),
  );
  lines.push("  Speech:       " + describeSpeech(state));
  lines.push(
    "  Overrides:    " +
      (state.overrides.length > 0
        ? state.overrides
            .map((override) => override.id + "=" + formatNumber(override.value) + (override.expiresAt ? " (" + formatRemaining(override.expiresAt) + ")" : ""))
            .join(", ")
        : "none"),
  );
  lines.push("  Window:       " + describeWindow(state.window));
  lines.push("  FPS:          " + state.fps);
  lines.push("  Voices:       " + state.ttsVoices.length);
  if (state.modelError) lines.push("  Model error:  " + state.modelError.code + ": " + state.modelError.message);
  if (state.lastError) lines.push("  Last error:   " + state.lastError.code + ": " + state.lastError.message);
  return lines.join("\n");
}

function humanCaps(state: PublicState): string {
  const capabilities = state.capabilities;
  const lines: string[] = [];
  lines.push("Model: " + formatModel(state.model));
  lines.push("Core:  " + (capabilities.coreVersion ?? "unknown"));
  lines.push("Features: " + describeFeatures(capabilities.features));
  lines.push("Groups:   " + describeGroups(capabilities.groups));
  lines.push(
    "Expressions (" +
      capabilities.expressions.length +
      "): " +
      (capabilities.expressions.length > 0
        ? capabilities.expressions.map((expression) => expression.index + ":" + expression.name).join(", ")
        : "none"),
  );
  lines.push(
    "Motions (" +
      capabilities.motions.length +
      "): " +
      (capabilities.motions.length > 0
        ? capabilities.motions.map((motion) => motion.group + "#" + motion.index + (motion.name ? " " + motion.name : "")).join(", ")
        : "none"),
  );
  lines.push("Parameters: " + capabilities.parameters.length);
  return lines.join("\n");
}

function humanExpressions(state: PublicState): string {
  const expressions = state.capabilities.expressions;
  if (!state.model) return "No model is loaded. Install one and run: live2d model load <id>";
  if (expressions.length === 0) return "Model " + formatModel(state.model) + " has no expressions.";
  const lines = ["Model: " + formatModel(state.model), "Expressions (" + expressions.length + "):"];
  for (const expression of expressions) lines.push("  " + String(expression.index).padStart(3) + "  " + expression.name);
  return lines.join("\n");
}

function humanMotions(state: PublicState): string {
  const motions = state.capabilities.motions;
  if (!state.model) return "No model is loaded. Install one and run: live2d model load <id>";
  if (motions.length === 0) return "Model " + formatModel(state.model) + " has no motions.";
  const lines = ["Model: " + formatModel(state.model), "Motions (" + motions.length + "):"];
  for (const motion of motions) {
    lines.push(
      "  " + motion.group.padEnd(24, " ") + " " + String(motion.index).padStart(2, " ") + "  " + motion.name + (motion.loop ? "  loop" : ""),
    );
  }
  return lines.join("\n");
}

function humanParams(state: PublicState): string {
  const capabilities = state.capabilities;
  if (!state.model) return "No model is loaded. Install one and run: live2d model load <id>";
  const overrides = new Map(state.overrides.map((override) => [override.id, override]));
  const lines = ["Model: " + formatModel(state.model), "Parameters (" + capabilities.parameters.length + "):"];
  const shown = capabilities.parameters.slice(0, 200);
  for (const parameter of shown) {
    const override = overrides.get(parameter.id);
    let line = "  " + parameter.id.padEnd(30, " ") + " " + formatNumber(parameter.min) + " .. " + formatNumber(parameter.max);
    if (override) line += "   value " + formatNumber(override.value) + (override.expiresAt ? " (" + formatRemaining(override.expiresAt) + ")" : "");
    lines.push(line);
  }
  if (capabilities.parameters.length > shown.length) {
    lines.push("  ... " + (capabilities.parameters.length - shown.length) + " more (use --json for the full list)");
  }
  if (overrides.size > 0) {
    lines.push(
      "Overrides: " +
        state.overrides
          .map((override) => override.id + "=" + formatNumber(override.value) + (override.expiresAt ? " (" + formatRemaining(override.expiresAt) + ")" : ""))
          .join(", "),
    );
  }
  return lines.join("\n");
}

function humanModelList(models: ModelSummary[], active: ModelSummary | null): string {
  if (models.length === 0) return "No Live2D models are installed. Run: npm run setup:model";
  const width = Math.min(30, Math.max(8, ...models.map((model) => model.id.length)));
  const lines = ["Models (" + models.length + "):"];
  for (const model of models) {
    const marker = active && active.id === model.id ? "*" : " ";
    lines.push("  " + marker + " " + model.id.padEnd(width, " ") + "  " + model.displayName + (model.entry ? "  (" + model.entry + ")" : ""));
  }
  return lines.join("\n");
}

function humanVoices(voices: TtsVoice[]): string {
  if (voices.length === 0) return "No system TTS voices are available; use --audio with a recorded file instead.";
  const lines = ["TTS voices (" + voices.length + "):"];
  for (const voice of voices) {
    lines.push("  " + (voice.default ? "*" : " ") + " " + voice.name + " (" + voice.lang + ")" + (voice.default ? " [default]" : ""));
  }
  return lines.join("\n");
}

function truncate(text: string, length = 80): string {
  return text.length <= length ? text : text.slice(0, length - 1) + "…";
}

function humanSay(text: string | undefined, options: { tts: boolean; voice?: string; audio?: AudioUploadResult; wait: boolean; ttlMs?: number; waitedMs: number }): string {
  const lines: string[] = [];
  if (options.audio) lines.push("Playing uploaded audio " + options.audio.id + " (" + options.audio.bytes + " bytes).");
  if (text && text.trim().length > 0) {
    const modes = [options.tts ? "tts" : null, options.voice ? "voice " + options.voice : null].filter((mode): mode is string => mode !== null);
    lines.push('Said "' + truncate(text.trim()) + '"' + (modes.length > 0 ? " (" + modes.join(", ") + ")" : "") + ".");
  }
  if (options.wait) lines.push("Speech finished in " + formatDuration(options.waitedMs) + ".");
  if (options.ttlMs !== undefined) lines.push("Speech bubble hides after " + formatDuration(options.ttlMs) + ".");
  return lines.join("\n");
}

function humanVersion(payload: {
  version: string;
  protocol: number;
  node: string;
  platform: string;
  arch: string;
  runtimeDir: string;
  app: { running: boolean; baseUrl: string; pid: number; version: string; appRoot: string; packaged: boolean } | null;
}): string {
  const lines = [
    "live2d " + payload.version + " (protocol " + payload.protocol + ")",
    "node " + payload.node + " " + payload.platform + " " + payload.arch,
    "runtime: " + payload.runtimeDir,
  ];
  if (payload.app) {
    lines.push(
      "app: " +
        (payload.app.running ? "running" : "not responding") +
        " at " +
        payload.app.baseUrl +
        " (pid " +
        payload.app.pid +
        ", version " +
        payload.app.version +
        (payload.app.packaged ? ", packaged" : "") +
        ")",
    );
  } else {
    lines.push("app: not running");
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

function addCommands(): void {
  program
    .name("live2d")
    .description("Control the local Live2D desktop companion from the command line.")
    .version(APP_VERSION, "-V, --version", "output the CLI version")
    .option("--json", "print machine-readable JSON on stdout (diagnostics go to stderr)")
    .option("--timeout <ms>", "control request timeout in milliseconds")
    .option("--url <url>", "override the app base URL (default: from the runtime file)")
    .option("--token <token>", "override the auth token (default: from the runtime file)")
    .option("--no-start", "do not auto-start the desktop app");
  program.exitOverride();

  program
    .command("ensure")
    .description("Start the app if needed and wait until the page and a Live2D model are ready")
    .action(async () => {
      const budget = resolveTimeout(45_000);
      const started = Date.now();
      const client = await connectClient({ timeoutMs: budget });
      const health = await client.health(Math.min(budget, 5_000));
      if (!health?.ok) {
        throw new AgentError("APP_NOT_RUNNING", "The Live2D app is not responding.", {
          details: { url: client.info.baseUrl, hint: "Start the app with: live2d ensure" },
        });
      }
      let state = await client.state();
      while (!(state.pageReady && state.model) && Date.now() - started < budget) {
        await sleep(250);
        state = await client.state();
      }
      if (!(state.pageReady && state.model)) {
        if (state.pageReady) {
          let models: ModelSummary[] = [];
          try {
            const listed = await client.command({ type: "model.list" });
            const result = listed.result as ModelListResult | undefined;
            models = result?.models ?? [];
          } catch {
            models = [];
          }
          throw new AgentError("MODEL_MISSING", "The app is ready but no Live2D model is loaded.", {
            details: {
              models: models.map((model) => model.id),
              hint: "Install a model (npm run setup:model), then run: live2d model load <id>",
            },
          });
        }
        throw new AgentError("TIMEOUT", "The Live2D page did not become ready within " + budget + "ms.", {
          details: { hint: "Inspect the app log with: live2d logs" },
        });
      }
      const waitedMs = Date.now() - started;
      output(
        {
          ok: true,
          app: { baseUrl: client.info.baseUrl, pid: health.pid, version: health.version, uptimeMs: health.uptimeMs },
          model: state.model,
          capabilities: {
            expressions: state.capabilities.expressions.length,
            motions: state.capabilities.motions.length,
            parameters: state.capabilities.parameters.length,
            coreVersion: state.capabilities.coreVersion,
            features: state.capabilities.features,
          },
          window: state.window,
          waitedMs,
        },
        humanEnsure(client, health, state, waitedMs),
      );
    });

  program
    .command("status")
    .description("Show app, page, model, window and capability status")
    .action(async () => {
      const client = await connectClient();
      const health = await client.health(5_000);
      if (!health?.ok) {
        throw new AgentError("APP_NOT_RUNNING", "The Live2D app is not responding.", { details: { url: client.info.baseUrl } });
      }
      const state = await client.state();
      output(
        {
          ok: true,
          health,
          runtime: {
            baseUrl: client.info.baseUrl,
            pid: health.pid,
            version: health.version,
            appRoot: client.info.appRoot,
            packaged: Boolean(client.info.packaged),
          },
          state,
        },
        humanStatus(client, health, state),
      );
    });

  program
    .command("caps")
    .description("Print the loaded model's expressions, motions, parameters, groups and features")
    .action(async () => {
      const client = await connectClient();
      const state = await awaitPageReady(client, pageWaitTimeout());
      if (!state.model) diagnostic("warning: no model is loaded yet; capabilities are empty.");
      output({ ok: true, model: state.model, capabilities: state.capabilities }, humanCaps(state));
    });

  program
    .command("expressions")
    .description("List available expressions (name and index)")
    .action(async () => {
      const client = await connectClient();
      const state = await awaitPageReady(client, pageWaitTimeout());
      output({ ok: true, model: state.model, expressions: state.capabilities.expressions }, humanExpressions(state));
    });

  program
    .command("motions")
    .description("List available motions (group, index, name, loop)")
    .action(async () => {
      const client = await connectClient();
      const state = await awaitPageReady(client, pageWaitTimeout());
      output({ ok: true, model: state.model, motions: state.capabilities.motions }, humanMotions(state));
    });

  program
    .command("expression <value>")
    .description("Apply an expression by name or numeric index")
    .option("--ttl <ms>", "revert to the default expression after this many milliseconds")
    .action(async (value: string, options: { ttl?: string }) => {
      const ttlMs = parseTtl(options.ttl);
      const expression: string | number = /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
      const client = await connectClient();
      await awaitPageReady(client, pageWaitTimeout());
      const command: ApiCommand = { type: "expression.set", expression };
      if (ttlMs !== undefined) command.ttlMs = ttlMs;
      const response = await client.command(command, { timeoutMs: resolveTimeout() });
      const state = await stateOf(client, response);
      const applied = state.expression;
      output(
        { ok: true, expression: applied, revision: state.revision, result: response.result ?? null },
        applied
          ? 'Applied expression "' + applied.name + '" (index ' + applied.index + ')' + (ttlMs !== undefined ? " for " + formatDuration(ttlMs) : "") + "."
          : 'Applied expression "' + value + '"' + (ttlMs !== undefined ? " for " + formatDuration(ttlMs) : "") + ".",
      );
    });

  program
    .command("motion <group>")
    .description("Play a motion from a motion group")
    .option("--index <n>", "motion index inside the group (default: group default)")
    .option("--wait", "wait until the motion finishes")
    .option("--priority <priority>", "idle, normal or force", "normal")
    .action(async (group: string, options: { index?: string; wait?: boolean; priority?: string }) => {
      const index = options.index === undefined ? undefined : parseIntegerOption(options.index, "--index", { min: 0 });
      const priority = (options.priority ?? "normal").trim();
      if (priority !== "idle" && priority !== "normal" && priority !== "force") {
        badArg("--priority must be one of: idle, normal, force.");
      }
      const wait = Boolean(options.wait);
      const timeoutMs = resolveTimeout();
      const command: ApiCommand = { type: "motion.play", group };
      if (index !== undefined) command.index = index;
      command.priority = priority;
      if (wait) {
        command.wait = true;
        command.timeoutMs = timeoutMs;
      }
      const client = await connectClient();
      await awaitPageReady(client, pageWaitTimeout());
      const response = await client.command(command, { timeoutMs });
      const state = await stateOf(client, response);
      output(
        {
          ok: true,
          motion: { group, index: index ?? null, priority, wait, timeoutMs },
          motions: state.motions,
          result: response.result ?? null,
        },
        wait
          ? 'Motion "' + group + '"' + (index !== undefined ? " #" + index : "") + " finished."
          : 'Playing motion "' + group + '"' + (index !== undefined ? " #" + index : "") + " (priority " + priority + ").",
      );
    });

  program
    .command("param <id> <value>")
    .description("Set one Live2D parameter value")
    .option("--ttl <ms>", "release the override after this many milliseconds")
    .action(async (id: string, value: string, options: { ttl?: string }) => {
      if (id.length === 0 || id.length > 128) badArg("Parameter id must be between 1 and 128 characters.");
      const numeric = parseNumberArgument(value, "value", Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
      const ttlMs = parseTtl(options.ttl);
      const client = await connectClient();
      await awaitPageReady(client, pageWaitTimeout());
      const command: ApiCommand = { type: "parameter.set", values: { [id]: numeric } };
      if (ttlMs !== undefined) command.ttlMs = ttlMs;
      const response = await client.command(command, { timeoutMs: resolveTimeout() });
      const state = await stateOf(client, response);
      const override = state.overrides.find((entry) => entry.id === id);
      output(
        {
          ok: true,
          parameter: { id, value: numeric, ttlMs: ttlMs ?? null },
          override: override ?? null,
          overrides: state.overrides,
        },
        "Set parameter " + id + " = " + formatNumber(numeric) + (ttlMs !== undefined ? " (ttl " + formatDuration(ttlMs) + ")" : "") + ".",
      );
    });

  program
    .command("params")
    .description("List parameter ranges and current overrides")
    .action(async () => {
      const client = await connectClient();
      const state = await awaitPageReady(client, pageWaitTimeout());
      const overrides = new Map(state.overrides.map((override) => [override.id, override]));
      const parameters = state.capabilities.parameters.map((parameter) => {
        const override = overrides.get(parameter.id);
        return override
          ? { id: parameter.id, min: parameter.min, max: parameter.max, value: override.value, expiresAt: override.expiresAt }
          : { id: parameter.id, min: parameter.min, max: parameter.max };
      });
      output({ ok: true, model: state.model, parameters, overrides: state.overrides }, humanParams(state));
    });

  program
    .command("look <x> <y>")
    .description("Point the model's gaze at normalized coordinates (-1..1)")
    .option("--ttl <ms>", "release the gaze after this many milliseconds")
    .action(async (x: string, y: string, options: { ttl?: string }) => {
      const targetX = parseNumberArgument(x, "x", -1, 1);
      const targetY = parseNumberArgument(y, "y", -1, 1);
      const ttlMs = parseTtl(options.ttl);
      const client = await connectClient();
      await awaitPageReady(client, pageWaitTimeout());
      const command: ApiCommand = { type: "gaze.set", x: targetX, y: targetY };
      if (ttlMs !== undefined) command.ttlMs = ttlMs;
      await client.command(command, { timeoutMs: resolveTimeout() });
      output(
        { ok: true, gaze: { x: targetX, y: targetY, ttlMs: ttlMs ?? null } },
        "Gaze set to (" + formatNumber(targetX) + ", " + formatNumber(targetY) + ")" + (ttlMs !== undefined ? " (ttl " + formatDuration(ttlMs) + ")" : "") + ".",
      );
    });

  program
    .command("say [text]")
    .description("Show a speech bubble, optionally with TTS or a recorded audio file")
    .option("--tts", "speak the text with the system TTS voice")
    .option("--voice <name>", "TTS voice name (implies --tts)")
    .option("--audio <file>", "upload and play a local .wav, .mp3 or .ogg file")
    .option("--ttl <ms>", "hide the speech bubble after this many ms (does not block the command)")
    .option("--wait", "wait until speech playback finishes")
    .action(async (text: string | undefined, options: SayOptions) => {
      const trimmed = text?.trim() ?? "";
      const audioPath = options.audio;
      if (trimmed.length === 0 && audioPath === undefined) badArg("Provide text, --audio <file>, or both.");
      if (trimmed.length > 2000) badArg("text must be at most 2000 characters.");
      const ttlMs = parseTtl(options.ttl);
      const tts = Boolean(options.tts) || options.voice !== undefined;
      const wait = Boolean(options.wait);
      const client = await connectClient();
      await awaitPageReady(client, pageWaitTimeout());
      const started = Date.now();
      let audio: AudioUploadResult | undefined;
      if (audioPath !== undefined) audio = await client.uploadAudio(audioPath);
      const timeoutMs = resolveTimeout(wait ? 60_000 : 30_000);
      const command: ApiCommand = { type: "speech.say" };
      if (trimmed.length > 0) command.text = trimmed;
      if (tts) command.tts = true;
      if (options.voice !== undefined) command.voice = options.voice;
      if (audio) command.audioUrl = audio.url;
      if (ttlMs !== undefined) command.bubbleTtlMs = ttlMs;
      if (wait) {
        command.wait = true;
        command.timeoutMs = timeoutMs;
      }
      const response = await client.command(command, { timeoutMs });
      const state = await stateOf(client, response);
      const waitedMs = Date.now() - started;
      output(
        {
          ok: true,
          speech: state.speech,
          tts,
          voice: options.voice ?? null,
          wait,
          audio: audio ?? null,
          bubbleTtlMs: ttlMs ?? null,
          waitedMs,
          result: response.result ?? null,
        },
        humanSay(trimmed.length > 0 ? trimmed : undefined, { tts, voice: options.voice, audio, wait, ttlMs, waitedMs }),
      );
    });

  const modelCommand = program.command("model").description("List installed models or load one by id");
  modelCommand
    .command("list")
    .description("List installed Live2D models")
    .action(async () => {
      const client = await connectClient();
      const response = await client.command({ type: "model.list" }, { timeoutMs: resolveTimeout() });
      const result = (response.result ?? {}) as ModelListResult;
      const models = result.models ?? [];
      const active = result.active ?? null;
      output({ ok: true, models, active }, humanModelList(models, active));
    });
  modelCommand
    .command("load <id>")
    .description("Load an installed model by id")
    .action(async (id: string) => {
      if (!/^[A-Za-z0-9._-]+$/.test(id) || id.length > 128) {
        badArg("Model id may only contain letters, digits, dot, underscore and dash (max 128 characters).");
      }
      const client = await connectClient();
      await awaitPageReady(client, pageWaitTimeout());
      const response = await client.command({ type: "model.load", id }, { timeoutMs: resolveTimeout() });
      const state = await stateOf(client, response);
      output({ ok: true, model: state.model, revision: state.revision, result: response.result ?? null }, "Loaded model " + formatModel(state.model) + ".");
    });

  program
    .command("window")
    .description("Move, resize or reconfigure the pet window")
    .option("--x <px>", "window x position in pixels")
    .option("--y <px>", "window y position in pixels")
    .option("--width <px>", "window width in pixels (200..4000)")
    .option("--height <px>", "window height in pixels (200..4000)")
    .option("--always-on-top", "keep the window above other windows")
    .option("--no-always-on-top", "allow other windows above the pet")
    .option("--click-through", "ignore mouse input on the window")
    .option("--no-click-through", "restore mouse input on the window")
    .option("--visible", "show the window")
    .option("--hidden", "hide the window")
    .action(async (options: { x?: string; y?: string; width?: string; height?: string; alwaysOnTop?: boolean; clickThrough?: boolean; visible?: boolean; hidden?: boolean }) => {
      const command: Extract<ApiCommand, { type: "window.set" }> = { type: "window.set" };
      let touched = false;
      if (options.x !== undefined) {
        command.x = parseIntegerOption(options.x, "--x");
        touched = true;
      }
      if (options.y !== undefined) {
        command.y = parseIntegerOption(options.y, "--y");
        touched = true;
      }
      if (options.width !== undefined) {
        command.width = parseIntegerOption(options.width, "--width", { min: 200, max: 4000 });
        touched = true;
      }
      if (options.height !== undefined) {
        command.height = parseIntegerOption(options.height, "--height", { min: 200, max: 4000 });
        touched = true;
      }
      if (options.alwaysOnTop !== undefined) {
        command.alwaysOnTop = options.alwaysOnTop;
        touched = true;
      }
      if (options.clickThrough !== undefined) {
        command.clickThrough = options.clickThrough;
        touched = true;
      }
      if (options.visible !== undefined) {
        command.visible = options.visible;
        touched = true;
      }
      if (options.hidden) {
        command.visible = false;
        touched = true;
      }
      if (!touched) {
        badArg("Provide at least one window option: --x, --y, --width, --height, --always-on-top/--no-always-on-top, --click-through/--no-click-through, --visible or --hidden.");
      }
      const client = await connectClient();
      const response = await client.command(command, { timeoutMs: resolveTimeout() });
      const state = await stateOf(client, response);
      output({ ok: true, window: state.window }, "Window: " + describeWindow(state.window) + ".");
    });

  program
    .command("screenshot")
    .description("Capture the pet window as a PNG file")
    .option("--out <file>", "write the PNG to this path (default: the app's screenshot directory)")
    .action(async (options: { out?: string }) => {
      const client = await connectClient();
      await awaitPageReady(client, pageWaitTimeout());
      const shot: ScreenshotResult = await client.screenshot(options.out);
      output(
        { ok: true, screenshot: shot },
        "Screenshot saved: " + shot.path + " (" + shot.width + "x" + shot.height + ", " + shot.bytes + " bytes).",
      );
    });

  program
    .command("reset")
    .description("Reset expression, motions, parameter overrides and bubbles")
    .action(async () => {
      const client = await connectClient();
      await awaitPageReady(client, pageWaitTimeout());
      const response = await client.command({ type: "reset" }, { timeoutMs: resolveTimeout() });
      const state = await stateOf(client, response);
      output(
        { ok: true, model: state.model, expression: state.expression, overrides: state.overrides, motions: state.motions, revision: state.revision },
        "Reset the Live2D scene. Model: " + formatModel(state.model) + "; expressions and overrides cleared.",
      );
    });

  program
    .command("stop")
    .description("Stop the desktop app if it is running")
    .action(async () => {
      const existing = await Live2DClient.discover();
      if (!existing) {
        output({ ok: true, running: false, alreadyStopped: true }, "The Live2D app is not running.");
        return;
      }
      await existing.stop();
      output(
        { ok: true, running: false, alreadyStopped: false, baseUrl: existing.info.baseUrl, pid: existing.info.pid },
        "Live2D app stopped.",
      );
    });

  program
    .command("voices")
    .description("List available system TTS voices")
    .action(async () => {
      const client = await connectClient();
      const state = await awaitPageReady(client, pageWaitTimeout());
      output({ ok: true, voices: state.ttsVoices }, humanVoices(state.ttsVoices));
    });

  program
    .command("logs")
    .description("Print the tail of the desktop app log")
    .option("--lines <n>", "number of trailing lines to print", "100")
    .action(async (options: { lines?: string }) => {
      const lines = parseIntegerOption(options.lines, "--lines", { min: 1, max: 10_000, fallback: 100 });
      let raw = "";
      try {
        raw = await fs.readFile(LOG_FILE, "utf8");
      } catch {
        raw = "";
      }
      const all = raw.split(/\r?\n/);
      while (all.length > 0 && all[all.length - 1] === "") all.pop();
      const tail = all.slice(-lines);
      output(
        { ok: true, path: LOG_FILE, totalLines: all.length, lines: tail },
        "Log: " + LOG_FILE + "\n" + (tail.length > 0 ? tail.join("\n") : "(no log lines yet)"),
      );
    });

  program
    .command("version")
    .description("Print CLI, protocol and app runtime versions")
    .action(async () => {
      const runtime = await readRuntime();
      let running = false;
      if (runtime) {
        const client = new Live2DClient(runtime);
        running = Boolean((await client.health(1_500))?.ok);
      }
      const app = runtime
        ? {
            running,
            baseUrl: runtime.baseUrl,
            pid: runtime.pid,
            version: runtime.version,
            appRoot: runtime.appRoot,
            packaged: Boolean(runtime.packaged),
          }
        : null;
      const payload = {
        ok: true,
        version: APP_VERSION,
        protocol: PROTOCOL_VERSION,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        runtimeDir: RUNTIME_DIR,
        app,
      };
      output(payload, humanVersion(payload));
    });
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  addCommands();
  if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    return 0;
  }
  try {
    await program.parseAsync(process.argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version" || error.code === "commander.help") {
        return 0;
      }
      const message = error.message.replace(/^error:\s*/, "");
      if (jsonModeFromArgv()) {
        writeJson({ ok: false, error: { code: "BAD_REQUEST", message } });
      }
      return 5;
    }
    return reportError(error);
  }
}

void main()
  .then((code) => {
    // Do not call process.exit(): on Windows it can race with fetch keep-alive
    // handles and abort with a libuv assertion. Setting exitCode exits naturally.
    process.exitCode = code;
  })
  .catch((error) => {
    diagnostic("fatal: " + (error instanceof Error ? (error.stack ?? error.message) : String(error)));
    process.exitCode = 6;
  });
