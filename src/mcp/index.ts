import fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Live2DClient, type AudioUploadResult } from "../shared/client";
import { AgentError, errorPayload } from "../shared/errors";
import type { Command as ApiCommand, CommandResponse, ModelSummary, PublicState } from "../shared/protocol";
import { APP_VERSION } from "../shared/version";

const APP_START_TIMEOUT_MS = 30_000;
const PAGE_READY_TIMEOUT_MS = 20_000;
const TOOL_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* Client lifecycle                                                            */
/* -------------------------------------------------------------------------- */

let cachedClient: Live2DClient | null = null;
let connecting: Promise<Live2DClient> | null = null;

async function getClient(): Promise<Live2DClient> {
  if (cachedClient) {
    const health = await cachedClient.health(1_500);
    if (health?.ok) return cachedClient;
    cachedClient = null;
  }
  if (!connecting) {
    connecting = Live2DClient.connect({ autoStart: true, timeoutMs: APP_START_TIMEOUT_MS })
      .then((client) => {
        cachedClient = client;
        return client;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

async function waitPageReady(target: Live2DClient, timeoutMs: number): Promise<PublicState> {
  const deadline = Date.now() + timeoutMs;
  let last: PublicState | null = null;
  while (Date.now() < deadline) {
    try {
      last = await target.state();
    } catch {
      last = null;
    }
    if (last?.pageReady) return last;
    await sleep(200);
  }
  throw new AgentError("TIMEOUT", "The Live2D page did not become ready within " + timeoutMs + "ms.", {
    details: { pageReady: last?.pageReady ?? false, hint: "Read the app log with the live2d CLI: live2d logs" },
  });
}

async function readyClient(): Promise<Live2DClient> {
  const target = await getClient();
  await waitPageReady(target, PAGE_READY_TIMEOUT_MS);
  return target;
}

async function stateOf(target: Live2DClient, response: CommandResponse): Promise<PublicState> {
  return response.state ?? (await target.state());
}

/* -------------------------------------------------------------------------- */
/* Tool result helpers                                                         */
/* -------------------------------------------------------------------------- */

function toolResult(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function toolError(error: unknown): CallToolResult {
  const payload = errorPayload(error);
  return {
    isError: true,
    content: [{ type: "text", text: "Error (" + payload.code + "): " + payload.message }],
    structuredContent: { ok: false, error: payload },
  };
}

async function guard(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    return toolError(error);
  }
}

function truncate(text: string, length = 80): string {
  return text.length <= length ? text : text.slice(0, length - 1) + "…";
}

function modelLabel(model: ModelSummary | null): string {
  return model ? model.id + " (" + model.displayName + ")" : "no model";
}

function featureSummary(features: PublicState["capabilities"]["features"]): string {
  return Object.entries(features)
    .map(([key, value]) => key + "=" + (value ? "yes" : "no"))
    .join(" ");
}

/* -------------------------------------------------------------------------- */
/* Tool registration                                                           */
/* -------------------------------------------------------------------------- */

function registerTools(server: McpServer): void {
  server.registerTool(
    "live2d_status",
    {
      title: "Live2D status",
      description:
        "Check whether the Live2D desktop pet is running, which model is loaded, and its current expression, speech and window state. Call this first; if the app is not running it is started automatically.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const target = await getClient();
        const health = await target.health(3_000);
        if (!health?.ok) {
          throw new AgentError("APP_NOT_RUNNING", "The Live2D app is not responding.", { details: { url: target.info.baseUrl } });
        }
        const state = await target.state();
        const capabilities = state.capabilities;
        const text = state.model
          ? "Running (pid " +
            health.pid +
            "). Model " +
            modelLabel(state.model) +
            "; page " +
            (state.pageReady ? "ready" : "not ready") +
            "; " +
            capabilities.expressions.length +
            " expressions, " +
            capabilities.motions.length +
            " motions, " +
            capabilities.parameters.length +
            " parameters; window " +
            state.window.width +
            "x" +
            state.window.height +
            "."
          : "Running (pid " +
            health.pid +
            ") but no Live2D model is loaded; page " +
            (state.pageReady ? "ready" : "not ready") +
            ". Install a model and use live2d_model.";
        return toolResult(text, {
          ok: true,
          running: true,
          version: health.version,
          pid: health.pid,
          pageReady: state.pageReady,
          model: state.model,
          expression: state.expression,
          speech: state.speech,
          window: state.window,
          fps: state.fps,
          counts: {
            expressions: capabilities.expressions.length,
            motions: capabilities.motions.length,
            parameters: capabilities.parameters.length,
          },
          lastError: state.lastError,
        });
      }),
  );

  server.registerTool(
    "live2d_capabilities",
    {
      title: "Live2D capabilities",
      description:
        "List the loaded model's exact expression names/indexes, motion groups/indexes, parameter ranges and feature support. Read this before applying expressions or motions so IDs are exact.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const target = await readyClient();
        const state = await target.state();
        const capabilities = state.capabilities;
        const expressionList = capabilities.expressions.slice(0, 20).map((expression) => expression.index + ":" + expression.name);
        const groups = Array.from(new Set(capabilities.motions.map((motion) => motion.group))).slice(0, 20);
        const lines = [
          "Model: " + modelLabel(state.model),
          "Cubism core: " + (capabilities.coreVersion ?? "unknown"),
          "Expressions (" + capabilities.expressions.length + "): " + (expressionList.join(", ") || "none"),
          "Motion groups (" + groups.length + "): " + (groups.join(", ") || "none"),
          "Parameters: " + capabilities.parameters.length,
          "Features: " + featureSummary(capabilities.features),
        ];
        return toolResult(lines.join("\n"), { ok: true, model: state.model, capabilities });
      }),
  );

  server.registerTool(
    "live2d_expression",
    {
      title: "Set Live2D expression",
      description:
        "Apply a facial expression by exact name (string) or index (number) from live2d_capabilities. Optional ttlMs reverts the expression automatically.",
      annotations: { idempotentHint: true },
      inputSchema: {
        expression: z.union([z.string().min(1).max(128), z.number().int().min(0)]).describe("Expression name or numeric index"),
        ttlMs: z.number().int().min(0).max(3_600_000).optional().describe("Revert to the default expression after this many milliseconds"),
      },
    },
    async (args) =>
      guard(async () => {
        const target = await readyClient();
        const command: ApiCommand = { type: "expression.set", expression: args.expression };
        if (args.ttlMs !== undefined) command.ttlMs = args.ttlMs;
        const response = await target.command(command, { timeoutMs: TOOL_TIMEOUT_MS });
        const state = await stateOf(target, response);
        const applied = state.expression;
        return toolResult(
          applied
            ? 'Expression "' + applied.name + '" (index ' + applied.index + ") applied" + (args.ttlMs !== undefined ? " for " + args.ttlMs + "ms" : "") + "."
            : 'Expression "' + args.expression + '" applied' + (args.ttlMs !== undefined ? " for " + args.ttlMs + "ms" : "") + ".",
          { ok: true, expression: applied, revision: state.revision },
        );
      }),
  );

  server.registerTool(
    "live2d_motion",
    {
      title: "Play Live2D motion",
      description:
        "Play a motion from a group in live2d_capabilities. Set wait=true to block until the motion finishes; priority may be idle, normal or force.",
      inputSchema: {
        group: z.string().min(1).max(128).describe("Motion group name from live2d_capabilities (e.g. TapBody)"),
        index: z.number().int().min(0).max(100_000).optional().describe("Motion index inside the group; omit for the group default"),
        priority: z.enum(["idle", "normal", "force"]).optional().describe("Motion priority (default normal)"),
        wait: z.boolean().optional().describe("Wait until the motion finishes before returning"),
        timeoutMs: z.number().int().min(100).max(120_000).optional().describe("Maximum wait time in milliseconds when wait is true"),
      },
    },
    async (args) =>
      guard(async () => {
        const priority = args.priority ?? "normal";
        const command: ApiCommand = { type: "motion.play", group: args.group, priority };
        if (args.index !== undefined) command.index = args.index;
        if (args.wait) {
          command.wait = true;
          if (args.timeoutMs !== undefined) command.timeoutMs = args.timeoutMs;
        }
        const target = await readyClient();
        const timeoutMs = args.wait ? (args.timeoutMs ?? TOOL_TIMEOUT_MS) : TOOL_TIMEOUT_MS;
        const response = await target.command(command, { timeoutMs });
        const state = await stateOf(target, response);
        const label = '"' + args.group + '"' + (args.index !== undefined ? " #" + args.index : "");
        return toolResult(
          args.wait ? "Motion " + label + " finished." : "Playing motion " + label + " (priority " + priority + ").",
          { ok: true, motion: { group: args.group, index: args.index ?? null, priority, wait: Boolean(args.wait) }, motions: state.motions },
        );
      }),
  );

  server.registerTool(
    "live2d_say",
    {
      title: "Say text / play audio",
      description:
        "Show a speech bubble with optional system TTS, or upload and play a local .wav/.mp3/.ogg file. Set wait=true to return after speech playback finishes.",
      inputSchema: {
        text: z.string().max(2000).optional().describe("Text to show in the bubble"),
        tts: z.boolean().optional().describe("Speak the text with the system TTS voice"),
        voice: z.string().max(256).optional().describe("TTS voice name (implies tts)"),
        audioPath: z.string().min(1).max(4096).optional().describe("Local path to a .wav/.mp3/.ogg file to upload and play"),
        wait: z.boolean().optional().describe("Wait until speech playback finishes"),
        bubble: z.boolean().optional().describe("Show the text bubble (default true)"),
      },
    },
    async (args) =>
      guard(async () => {
        const text = args.text?.trim();
        if (!text && args.audioPath === undefined) {
          throw new AgentError("BAD_REQUEST", "Provide text or audioPath.");
        }
        const target = await readyClient();
        const started = Date.now();
        let audio: AudioUploadResult | undefined;
        if (args.audioPath !== undefined) audio = await target.uploadAudio(args.audioPath);
        const command: ApiCommand = { type: "speech.say" };
        if (text) command.text = text;
        if (args.tts || args.voice) command.tts = true;
        if (args.voice !== undefined) command.voice = args.voice;
        if (audio) command.audioUrl = audio.url;
        if (args.bubble !== undefined) command.bubble = args.bubble;
        if (args.wait) {
          command.wait = true;
          command.timeoutMs = 60_000;
        }
        const response = await target.command(command, { timeoutMs: args.wait ? 65_000 : TOOL_TIMEOUT_MS });
        const state = await stateOf(target, response);
        const parts: string[] = [];
        if (audio) parts.push("Playing uploaded audio " + audio.id + " (" + audio.bytes + " bytes).");
        if (text) {
          const modes = [args.tts || args.voice ? "tts" : null, args.voice ? "voice " + args.voice : null].filter(
            (mode): mode is string => mode !== null,
          );
          parts.push('Said "' + truncate(text) + '"' + (modes.length > 0 ? " (" + modes.join(", ") + ")" : "") + ".");
        }
        if (args.wait) parts.push("Speech finished in " + (Date.now() - started) + "ms.");
        return toolResult(parts.join("\n"), {
          ok: true,
          speech: state.speech,
          tts: Boolean(args.tts || args.voice),
          voice: args.voice ?? null,
          wait: Boolean(args.wait),
          audio: audio ?? null,
        });
      }),
  );

  server.registerTool(
    "live2d_params",
    {
      title: "Live2D parameters",
      description:
        "List parameter ranges and current overrides. Provide id and value together to set one parameter, or id alone to read one parameter.",
      annotations: { idempotentHint: true },
      inputSchema: {
        id: z.string().min(1).max(128).optional().describe("Parameter id (e.g. ParamAngleX)"),
        value: z.number().optional().describe("New value for id; requires id"),
        ttlMs: z.number().int().min(0).max(3_600_000).optional().describe("Release the override after this many milliseconds"),
      },
    },
    async (args) =>
      guard(async () => {
        if (args.id === undefined && args.value !== undefined) {
          throw new AgentError("BAD_REQUEST", "Parameter id is required when value is provided.");
        }
        const target = await readyClient();
        if (args.id !== undefined && args.value !== undefined) {
          const command: ApiCommand = { type: "parameter.set", values: { [args.id]: args.value } };
          if (args.ttlMs !== undefined) command.ttlMs = args.ttlMs;
          const response = await target.command(command, { timeoutMs: TOOL_TIMEOUT_MS });
          const state = await stateOf(target, response);
          const override = state.overrides.find((entry) => entry.id === args.id);
          return toolResult(
            "Set parameter " + args.id + " = " + args.value + (args.ttlMs !== undefined ? " (ttl " + args.ttlMs + "ms)" : "") + ".",
            { ok: true, parameter: { id: args.id, value: args.value, ttlMs: args.ttlMs ?? null }, override: override ?? null, overrides: state.overrides },
          );
        }
        if (args.id !== undefined) {
          const state = await target.state();
          const info = state.capabilities.parameters.find((parameter) => parameter.id === args.id);
          if (!info) {
            throw new AgentError("UNKNOWN_PARAMETER", 'Unknown parameter "' + args.id + '". Call live2d_capabilities for valid ids.');
          }
          const override = state.overrides.find((entry) => entry.id === args.id);
          return toolResult(
            "Parameter " + info.id + ": range " + info.min + ".." + info.max + (override ? ", current " + override.value : ", not overridden") + ".",
            { ok: true, parameter: override ? { ...info, value: override.value, expiresAt: override.expiresAt } : { ...info } },
          );
        }
        const state = await target.state();
        const overrides = new Map(state.overrides.map((override) => [override.id, override]));
        const parameters = state.capabilities.parameters.map((parameter) => {
          const override = overrides.get(parameter.id);
          return override
            ? { id: parameter.id, min: parameter.min, max: parameter.max, value: override.value, expiresAt: override.expiresAt }
            : { id: parameter.id, min: parameter.min, max: parameter.max };
        });
        const overridden = state.overrides.map((override) => override.id + "=" + override.value);
        return toolResult(
          "Model " +
            modelLabel(state.model) +
            ": " +
            parameters.length +
            " parameters" +
            (overridden.length > 0 ? "; overridden: " + overridden.slice(0, 10).join(", ") : "; no overrides") +
            ".",
          { ok: true, model: state.model, parameters, overrides: state.overrides },
        );
      }),
  );

  server.registerTool(
    "live2d_model",
    {
      title: "Live2D model",
      description: "List installed Live2D models. Provide an id to load that model.",
      annotations: { idempotentHint: true },
      inputSchema: {
        id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._-]+$/)
          .optional()
          .describe("Model id to load; omit to list installed models"),
      },
    },
    async (args) =>
      guard(async () => {
        if (args.id !== undefined) {
          const target = await readyClient();
          const response = await target.command({ type: "model.load", id: args.id }, { timeoutMs: 35_000 });
          const state = await stateOf(target, response);
          return toolResult("Loaded model " + modelLabel(state.model) + ".", { ok: true, model: state.model, revision: state.revision });
        }
        const target = await getClient();
        const response = await target.command({ type: "model.list" }, { timeoutMs: TOOL_TIMEOUT_MS });
        const result = (response.result ?? {}) as { models?: ModelSummary[]; active?: ModelSummary | null };
        const models = result.models ?? [];
        const active = result.active ?? null;
        const text =
          models.length === 0
            ? "No Live2D models are installed. Run npm run setup:model to install a model."
            : "Models (" +
              models.length +
              "): " +
              models.map((model) => model.id + (active && active.id === model.id ? " (active)" : "")).join(", ");
        return toolResult(text, { ok: true, models, active });
      }),
  );

  server.registerTool(
    "live2d_screenshot",
    {
      title: "Live2D screenshot",
      description: "Capture the pet window as a PNG image. Returns the image plus the saved file path; use it to verify the pet visually.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const target = await readyClient();
        const shot = await target.screenshot();
        let data: Buffer;
        try {
          data = await fs.readFile(shot.path);
        } catch (error) {
          throw new AgentError("INTERNAL", "Screenshot was captured but could not be read from " + shot.path, { cause: error });
        }
        return {
          content: [
            { type: "image", data: data.toString("base64"), mimeType: "image/png" },
            { type: "text", text: "Screenshot saved to " + shot.path + " (" + shot.width + "x" + shot.height + ", " + shot.bytes + " bytes)." },
          ],
          structuredContent: { ok: true, path: shot.path, width: shot.width, height: shot.height, bytes: shot.bytes },
        };
      }),
  );

  server.registerTool(
    "live2d_reset",
    {
      title: "Reset Live2D scene",
      description: "Reset the pet: clear the active expression, stop motions, release parameter overrides and hide the bubble.",
      annotations: { idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const target = await readyClient();
        const response = await target.command({ type: "reset" }, { timeoutMs: TOOL_TIMEOUT_MS });
        const state = await stateOf(target, response);
        return toolResult("Reset the Live2D scene. Model: " + modelLabel(state.model) + "; expressions and overrides cleared.", {
          ok: true,
          model: state.model,
          expression: state.expression,
          overrides: state.overrides,
          motions: state.motions,
          revision: state.revision,
        });
      }),
  );

  server.registerTool(
    "live2d_window",
    {
      title: "Configure Live2D window",
      description:
        "Move, resize or configure the pet window. Provide at least one property. Coordinates are screen pixels; width/height are 200..4000.",
      annotations: { idempotentHint: true },
      inputSchema: {
        x: z.number().int().optional().describe("Window x position in pixels"),
        y: z.number().int().optional().describe("Window y position in pixels"),
        width: z.number().int().min(200).max(4000).optional().describe("Window width in pixels"),
        height: z.number().int().min(200).max(4000).optional().describe("Window height in pixels"),
        alwaysOnTop: z.boolean().optional().describe("Keep the window above other windows"),
        clickThrough: z.boolean().optional().describe("Ignore mouse input on the window"),
        visible: z.boolean().optional().describe("Show or hide the window"),
      },
    },
    async (args) =>
      guard(async () => {
        const command: Extract<ApiCommand, { type: "window.set" }> = { type: "window.set" };
        let touched = false;
        if (args.x !== undefined) {
          command.x = args.x;
          touched = true;
        }
        if (args.y !== undefined) {
          command.y = args.y;
          touched = true;
        }
        if (args.width !== undefined) {
          command.width = args.width;
          touched = true;
        }
        if (args.height !== undefined) {
          command.height = args.height;
          touched = true;
        }
        if (args.alwaysOnTop !== undefined) {
          command.alwaysOnTop = args.alwaysOnTop;
          touched = true;
        }
        if (args.clickThrough !== undefined) {
          command.clickThrough = args.clickThrough;
          touched = true;
        }
        if (args.visible !== undefined) {
          command.visible = args.visible;
          touched = true;
        }
        if (!touched) {
          throw new AgentError("BAD_REQUEST", "Provide at least one of: x, y, width, height, alwaysOnTop, clickThrough, visible.");
        }
        const target = await getClient();
        const response = await target.command(command, { timeoutMs: TOOL_TIMEOUT_MS });
        const state = await stateOf(target, response);
        return toolResult(
          "Window: " +
            state.window.width +
            "x" +
            state.window.height +
            " at " +
            state.window.x +
            "," +
            state.window.y +
            " | " +
            (state.window.visible ? "visible" : "hidden") +
            " | " +
            (state.window.alwaysOnTop ? "always on top" : "normal") +
            (state.window.clickThrough ? " | click-through" : ""),
          { ok: true, window: state.window },
        );
      }),
  );
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "live2d-pet", version: APP_VERSION },
    {
      instructions: [
        "Control a local Live2D desktop companion (a desktop pet window on this machine).",
        "The app starts automatically on the first tool call. Call live2d_status first, then live2d_capabilities to learn exact expression, motion and parameter ids.",
        "Use live2d_screenshot to verify the result visually. Prefer live2d_reset when done to leave the pet in a clean state.",
        "Everything is local-only: the app listens on 127.0.0.1 and requires a token from the runtime file.",
      ].join(" "),
    },
  );
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[live2d-mcp] ready v" + APP_VERSION + " (stdio)\n");
}

void main().catch((error) => {
  const payload = errorPayload(error);
  process.stderr.write("[live2d-mcp] fatal: (" + payload.code + ") " + payload.message + "\n");
  process.exit(1);
});
