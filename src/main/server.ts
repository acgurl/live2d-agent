import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import sirv from "sirv";
import { AgentError, errorPayload } from "../shared/errors";
import type { Logger } from "../shared/log";
import type { AppConfig } from "../shared/config";
import { commandRequestSchema } from "../shared/protocol";
import { CORE_FILE, MODELS_DIR } from "../shared/paths";
import type { Bridge } from "./bridge";
import type { AudioCache } from "./audio";

export interface ServerOptions {
  config: AppConfig;
  token: string;
  bridge: Bridge;
  audio: AudioCache;
  logger: Logger;
  rendererDir: string;
  quit: () => void;
}

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

const JSON_LIMIT = 64 * 1024;
const AUDIO_LIMIT = 10 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".moc3": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const MODEL_EXTENSIONS = new Set([".json", ".moc3", ".png", ".jpg", ".jpeg", ".webp", ".wav", ".mp3", ".ogg"]);

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  await fs.mkdir(options.rendererDir, { recursive: true });
  const preferred = Number(process.env.LIVE2D_PORT ?? options.config.server.port);
  const candidates = Array.from({ length: 10 }, (_, index) => preferred + index).filter((port) => port > 0 && port < 65536);
  let lastError: unknown = null;
  for (const port of candidates) {
    const server = createHttpServer(port, options);
    try {
      await listen(server, port);
      options.logger.info("http server listening", { port });
      return {
        port,
        close: () => new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
      };
    } catch (error) {
      lastError = error;
      server.close();
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new AgentError("INTERNAL", "Could not find a free local port for the Live2D server.", { cause: lastError });
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function createHttpServer(port: number, options: ServerOptions): http.Server {
  const serveRenderer = sirv(options.rendererDir, { dev: false, etag: true, single: false, maxAge: 0 });
  const rateBuckets = new Map<string, { count: number; reset: number }>();
  const token = options.token;

  const isAllowedHost = (req: IncomingMessage): boolean => {
    const host = (req.headers.host ?? "").toLowerCase();
    return host === "127.0.0.1:" + port || host === "localhost:" + port;
  };

  const isAllowedOrigin = (origin: string): boolean => {
    return origin === "http://127.0.0.1:" + port || origin === "http://localhost:" + port;
  };

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    const raw = typeof header === "string" && header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : req.headers["x-live2d-token"];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const rateLimited = (key: string): boolean => {
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.reset <= now) {
      rateBuckets.set(key, { count: 1, reset: now + 1000 });
      return false;
    }
    bucket.count += 1;
    return bucket.count > 120;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isAllowedHost(req)) {
      sendText(res, 403, "Forbidden host");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    const origin = req.headers.origin;
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    if (origin && !isAllowedOrigin(origin)) {
      sendText(res, 403, "Forbidden origin");
      return;
    }

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/health" && req.method === "GET") {
      const state = options.bridge.getState();
      sendJson(res, 200, {
        ok: true,
        version: process.env.npm_package_version ?? "0.1.0",
        pid: process.pid,
        pageReady: options.bridge.isReady(),
        model: state.model?.id ?? null,
        uptimeMs: Math.round(process.uptime() * 1000),
      });
      return;
    }

    if (isApi) {
      if (!authorized(req)) {
        sendError(res, new AgentError("UNAUTHORIZED", "Missing or invalid Live2D token.", { httpStatus: 401 }));
        return;
      }
      if (rateLimited(token)) {
        sendError(res, new AgentError("RATE_LIMITED", "Too many requests; slow down.", { httpStatus: 429 }));
        return;
      }

      if (pathname === "/api/v1/state" && req.method === "GET") {
        sendJson(res, 200, options.bridge.getState());
        return;
      }
      if (pathname === "/api/v1/capabilities" && req.method === "GET") {
        sendJson(res, 200, options.bridge.getCapabilities());
        return;
      }
      if (pathname === "/api/v1/commands" && req.method === "POST") {
        const id = randomUUID();
        try {
          const body = await readBody(req, JSON_LIMIT);
          let parsed: unknown;
          try { parsed = JSON.parse(body.toString("utf8")); } catch { throw new AgentError("BAD_REQUEST", "Request body must be valid JSON."); }
          const request = commandRequestSchema.safeParse(parsed);
          if (!request.success) {
            throw new AgentError("BAD_REQUEST", "Invalid command request.", { details: request.error.issues });
          }
          const response = await options.bridge.dispatch(request.data.command, {
            timeoutMs: request.data.timeoutMs,
            session: request.data.session,
            requestId: request.data.id ?? id,
          });
          sendJson(res, 200, response);
        } catch (error) {
          sendError(res, error, id);
        }
        return;
      }
      if (pathname === "/api/v1/audio" && req.method === "POST") {
        try {
          const body = await readBody(req, AUDIO_LIMIT);
          const result = await options.audio.save(body, String(req.headers["content-type"] ?? ""));
          sendJson(res, 200, result);
        } catch (error) {
          sendError(res, error);
        }
        return;
      }
      if (pathname === "/api/v1/app/quit" && req.method === "POST") {
        sendJson(res, 200, { ok: true });
        setTimeout(() => options.quit(), 100);
        return;
      }
      sendError(res, new AgentError("BAD_REQUEST", "Unknown API route: " + pathname, { httpStatus: 404 }));
      return;
    }

    if (pathname.startsWith("/audio/") && req.method === "GET") {
      const id = pathname.slice("/audio/".length);
      const entry = await options.audio.get(id);
      if (!entry) {
        sendText(res, 404, "Audio not found");
        return;
      }
      res.writeHead(200, { "Content-Type": entry.mime, "Content-Length": entry.bytes, "Cache-Control": "no-store" });
      createReadStream(entry.path).pipe(res);
      return;
    }

    if (pathname === "/core/live2dcubismcore.min.js" && req.method === "GET") {
      try {
        await sendFile(res, CORE_FILE, "text/javascript; charset=utf-8");
      } catch {
        sendText(res, 404, "Cubism Core is not installed. Run: npm run setup:core");
      }
      return;
    }

    if (pathname.startsWith("/models/") && req.method === "GET") {
      try {
        await serveModelFile(res, pathname.slice("/models/".length));
      } catch (error) {
        if (error instanceof AgentError) sendText(res, error.httpStatus, error.message);
        else sendText(res, 404, "Model asset not found");
      }
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      try {
        await fs.access(path.join(options.rendererDir, "index.html"));
        serveRenderer(req, res, () => sendText(res, 404, "Renderer not built. Run: npm run build"));
      } catch {
        sendText(res, 200, setupHtml());
      }
      return;
    }

    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    serveRenderer(req, res, () => sendText(res, 404, "Not found"));
  };

  return http.createServer((req, res) => {
    void handler(req, res).catch((error) => {
      options.logger.error("http handler failed", errorPayload(error));
      if (!res.headersSent) sendError(res, error);
      else res.end();
    });
  });

  async function serveModelFile(res: ServerResponse, relative: string): Promise<void> {
    const parts = relative.split("/").filter(Boolean);
    if (parts.length < 2) throw new AgentError("BAD_REQUEST", "Invalid model asset path.");
    const id = parts[0];
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") throw new AgentError("BAD_REQUEST", "Invalid model id.");
    const base = path.join(MODELS_DIR, id);
    const target = path.resolve(base, parts.slice(1).join("/"));
    const rel = path.relative(base, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new AgentError("BAD_REQUEST", "Model asset path escapes the model directory.");
    const ext = path.extname(target).toLowerCase();
    if (!MODEL_EXTENSIONS.has(ext)) throw new AgentError("BAD_REQUEST", "Model asset extension is not allowed: " + ext);
    let realBase: string;
    let realTarget: string;
    try {
      realBase = await fs.realpath(base);
      realTarget = await fs.realpath(target);
    } catch {
      throw new AgentError("BAD_REQUEST", "Model asset not found.", { httpStatus: 404 });
    }
    const realRel = path.relative(realBase, realTarget);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) throw new AgentError("BAD_REQUEST", "Model asset resolves outside the model directory.");
    await sendFile(res, realTarget, MIME[ext] ?? "application/octet-stream");
  }
}

async function sendFile(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new AgentError("BAD_REQUEST", "Not a file.");
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": stat.size, "Cache-Control": "no-store" });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new AgentError(limit === AUDIO_LIMIT ? "AUDIO_TOO_LARGE" : "BAD_REQUEST", "Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), "Cache-Control": "no-store" });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  res.end(text);
}

function sendError(res: ServerResponse, error: unknown, id?: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = errorPayload(error);
  const status = error instanceof AgentError ? error.httpStatus : 500;
  sendJson(res, status, { v: 1, id: id ?? "unknown", ok: false, error: payload });
}

function setupHtml(): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Live2D Agent</title>",
    "<style>body{font-family:system-ui,Segoe UI,sans-serif;background:#15161c;color:#e8e8ef;padding:32px;line-height:1.6}code{background:#252735;padding:2px 6px;border-radius:4px}</style>",
    "</head><body><h1>Live2D Agent</h1>",
    "<p>The renderer has not been built yet.</p>",
    "<p>Run <code>npm run build</code> in the project directory, then restart the app.</p>",
    "</body></html>",
  ].join("");
}
