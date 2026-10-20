# Protocol

Two local protocols are involved:

1. **HTTP JSON API** between the CLI/MCP server and the Electron app.
2. **Electron IPC** between the main process and the renderer.

MCP is a third surface: a stdio MCP server that wraps the HTTP API.

Protocol version: `1` (`PROTOCOL_VERSION` in `src/shared/version.ts`). Requests
and responses both carry `"v": 1`; unknown versions are rejected by validation.

## Discovery: runtime files

### `runtime.json`

Written by the app at startup (atomic write, mode 0600 where supported) and
removed on quit:

```json
{
  "v": 1,
  "baseUrl": "http://127.0.0.1:47100",
  "port": 47100,
  "token": "<64 hex characters>",
  "pid": 12345,
  "startedAt": "2026-01-01T00:00:00.000Z",
  "version": "0.1.0",
  "appRoot": "C:\\path\\to\\live2d_to_agent",
  "electron": "C:\\path\\to\\electron.exe",
  "packaged": false
}
```

A client may use the file only if `v === 1`, `baseUrl` and `token` are strings,
the pid is alive (when present), and `GET /health` answers `ok: true`.

### `install.json`

Written by the app and by `npm run install:skill`; used for auto-start:

```json
{
  "appRoot": "C:\\path\\to\\live2d_to_agent",
  "electron": "C:\\path\\to\\node_modules\\electron\\dist\\electron.exe",
  "packaged": false,
  "version": "0.1.0",
  "installedAt": "2026-01-01T00:00:00.000Z"
}
```

## HTTP API

- Base URL: `http://127.0.0.1:<port>` (never `0.0.0.0`).
- Default port 47100; if busy, the app tries the next 9 ports. `LIVE2D_PORT`
  overrides the starting port.
- All API routes are under `/api/`; failures return JSON
  `{ v, id, ok: false, error: { code, message, details? } }`.
- Response bodies are `no-store`.

### Host and origin checks

Every request must have `Host: 127.0.0.1:<port>` or `localhost:<port>`
(otherwise 403 plain text). If an `Origin` header is present it must be one of
`http://127.0.0.1:<port>` or `http://localhost:<port>` (plus the dev origin when
`LIVE2D_DEV_URL` is set), otherwise 403.

### Authentication

`/health` is unauthenticated (still host/origin restricted). All `/api/`
routes require one of:

- `Authorization: Bearer <token>`
- `X-Live2D-Token: <token>`

The token is the random 32-byte (64 hex chars) value from `runtime.json`.
Comparison is constant-time. Missing/invalid → `401 UNAUTHORIZED`.

### Limits

- JSON body: 64 KiB (`/api/v1/commands`), 10 MiB for audio uploads.
- Rate limit: 120 requests per second per token → `429 RATE_LIMITED`.
- Request timeout is enforced per command by the bridge; long motions/speech can
  use their `timeoutMs` field.

### Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | no | Liveness/readiness summary. |
| GET | `/api/v1/state` | yes | Full `PublicState`. |
| GET | `/api/v1/capabilities` | yes | `Capabilities` of the loaded model. |
| POST | `/api/v1/commands` | yes | Execute one command. |
| POST | `/api/v1/audio` | yes | Upload WAV/MP3/OGG audio. |
| POST | `/api/v1/app/quit` | yes | Ask the app to quit (responds first). |
| GET | `/audio/<uuid>` | no | Serve cached uploaded audio (10-minute TTL). |
| GET | `/core/live2dcubismcore.min.js` | no | Serve the installed Cubism Core. |
| GET | `/models/<id>/<path>` | no | Serve model assets (extension allowlist, traversal/symlink checks). |
| GET | `/`, `/index.html`, assets | no | Serve the built renderer (`dist/renderer`). |

`/health` response:

```json
{
  "ok": true,
  "version": "0.1.0",
  "pid": 12345,
  "pageReady": true,
  "model": "hiyori",
  "uptimeMs": 12345
}
```

## Command endpoint

### Request

```json
{
  "v": 1,
  "id": "optional-client-id",
  "session": "optional-session",
  "timeoutMs": 30000,
  "command": { "type": "expression.set", "expression": "happy", "ttlMs": 5000 }
}
```

| Field | Rules |
| --- | --- |
| `v` | `1` (default 1). |
| `id` | optional string 1..64; echoed in the response. Generated if omitted. |
| `session` | optional string max 64. |
| `timeoutMs` | optional integer 100..120000. Overrides the bridge's default. |
| `command` | One of the command objects below (strict: unknown fields are rejected). |

### Response

```json
{
  "v": 1,
  "id": "generated-or-request-id",
  "ok": true,
  "result": {},
  "state": { "revision": 42 }
}
```

On failure the server returns the HTTP status mapped from the error code (for
example 400 `BAD_REQUEST`, 504 `TIMEOUT`) with:

```json
{
  "v": 1,
  "id": "generated-or-request-id",
  "ok": false,
  "error": { "code": "UNKNOWN_EXPRESSION", "message": "...", "details": {} }
}
```

`state` is included on success (renderer commands may omit it in the bridge
response; clients should fall back to `GET /api/v1/state`).

### Commands

All fields are validated by `src/shared/protocol.ts` (zod).

| Type | Fields | Result / behavior |
| --- | --- | --- |
| `expression.set` | `expression`: name 1..128 or integer index ≥ 0; `ttlMs`?: 0..3600000 | Apply expression; TTL releases it. |
| `expression.release` | — | Clear the active expression. |
| `motion.play` | `group`: 1..128; `index`?: int ≥ 0; `priority`?: `idle\|normal\|force`; `wait`?: bool; `timeoutMs`?: 100..120000 | Play motion; `wait` resolves when finished. |
| `motion.stop` | — | Stop motions. |
| `parameter.set` | `values`: record of 1..128-char ids to finite numbers; `ttlMs`?: 0..3600000; `clamp`?: bool | Set overrides; TTL releases them. |
| `parameter.release` | `ids`?: array of up to 128 ids | Release all or listed overrides. |
| `gaze.set` | `x`, `y`: -1..1; `ttlMs`?: 0..3600000 | Point the gaze. |
| `transform.set` | `scale`?: 0.1..4; `opacity`?: 0..1 | Display transform. |
| `speech.say` | `text`?: ≤2000; `tts`?: bool; `voice`?: ≤256; `rate`?: 0.5..2; `pitch`?: 0..2; `audioUrl`?: must start `/audio/`; `bubble`?: bool; `bubbleTtlMs`?: 0..3600000; `wait`?: bool; `timeoutMs`?: 100..120000 | Bubble/TTS/audio speech; requires text or `audioUrl`. |
| `bubble.hide` | — | Hide the bubble. |
| `model.list` | — | `{ models: ModelSummary[], active: ModelSummary \| null }` (handled in main). |
| `model.load` | `id`: `[A-Za-z0-9._-]{1,128}` | Validate + load model; persists the active id (handled in main). |
| `window.set` | `x`/`y`: int; `width`/`height`: 200..4000; `alwaysOnTop`/`clickThrough`/`visible`: bool; at least one field | Update window (handled in main). |
| `screenshot.capture` | `settleMs`?: 0..2000; `includeBubble`?: bool (reserved) | Capture PNG as currently rendered (handled in main). |
| `reset` | — | Clear expression, motions, overrides, bubble. |

### `PublicState`

`GET /api/v1/state` and command responses use:

```ts
interface PublicState {
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
```

Supporting types:

```ts
interface ModelSummary { id: string; displayName: string; entry: string; }
interface LastError { code: string; message: string; at: number; }
interface ActiveMotion { group: string; index: number; startedAt: number; finished: boolean; }
interface ParameterOverride { id: string; value: number; expiresAt: number | null; }
interface SpeechState { speaking: boolean; bubble: string | null; tts: boolean; audio: boolean; }
interface WindowState {
  x: number; y: number; width: number; height: number;
  visible: boolean; alwaysOnTop: boolean; clickThrough: boolean; displayScale: number;
}
interface TtsVoice { name: string; lang: string; default: boolean; }
```

### `Capabilities`

```ts
interface Capabilities {
  modelId: string | null;
  displayName: string | null;
  expressions: { name: string; index: number }[];
  motions: { group: string; index: number; name: string; loop: boolean }[];
  parameters: { id: string; min: number; max: number }[];
  groups: { lipSync: string[]; eyeBlink: string[]; hitAreas: string[] };
  features: {
    tts: boolean; audioLipSync: boolean; screenshot: boolean; multiModel: boolean;
    gaze: boolean; clickThrough: boolean; expressions: boolean; motions: boolean; parameters: boolean;
  };
  coreVersion: string | null;
}
```

## Audio upload

`POST /api/v1/audio`:

- `Content-Type`: `audio/wav`, `audio/mpeg` or `audio/ogg` (MP3 aliases
  accepted); optional `X-File-Name` (URL-encoded).
- Body: raw bytes ≤ 10 MiB. Magic bytes are validated (RIFF/WAVE, OggS, ID3/MP3
  frame sync).
- Response: `{ "id": "<uuid>", "url": "/audio/<uuid>", "bytes": 12345 }`.
- Uploads live in `~/.live2d-agent/audio/` and expire after 10 minutes;
  `GET /audio/<uuid>` returns 404 afterwards. Only UUID-shaped ids are served.

## Screenshot flow (HTTP ↔ IPC)

1. `POST /api/v1/commands` with `screenshot.capture`.
2. Main sends `live2d:screenshot { id, action: "prepare" }`; the renderer renders
   one frame and replies `renderer:screenshot-ready { id }` (3-second timeout).
3. Main waits `settleMs` (default 80ms) and calls `capturePage()`.
4. Main writes a PNG to `~/.live2d-agent/screenshots/<timestamp>-<id>.png` and
   sends `live2d:screenshot { id, action: "done" }`.
5. Result: `{ path, width, height, bytes }`. A hidden window returns
   `WINDOW_HIDDEN`.

## Electron IPC protocol

The renderer only sees the preload bridge. Channel payloads:

### Renderer → main (send)

| Channel | Payload | Meaning |
| --- | --- | --- |
| `renderer:ready` | `{ state?, capabilities? }` | Renderer finished bootstrapping. |
| `renderer:state` | `{ state }` | Unsolicited state update. |
| `renderer:result` | `{ id, response }` | Response to a command. |
| `renderer:log` | `{ level, message, meta? }` | Forwarded to the main logger. |
| `renderer:screenshot-ready` | `{ id }` | Renderer prepared the frame. |
| `window:drag` | `{ phase: "start"\|"move"\|"end", screenX, screenY }` | Move the window from pointer input. |

### Main → renderer (send)

| Channel | Payload | Meaning |
| --- | --- | --- |
| `live2d:command` | `{ id, command, timeoutMs }` | Execute a command; answer on `renderer:result`. |
| `live2d:screenshot` | `{ id, action: "prepare"\|"done" }` | Screenshot coordination. |

### Renderer → main (invoke)

| Channel | Payload → Result | Meaning |
| --- | --- | --- |
| `live2d:bootstrap` | none → `BridgeBootstrap` | Config, models, active model, Core info. |

`BridgeBootstrap`:

```ts
{
  config: AppConfig;
  activeModel: { id: string; displayName: string; entry: string; config: ModelConfig } | null;
  models: ModelSummary[];
  coreExists: boolean;
  coreUrl: string;          // "/core/live2dcubismcore.min.js"
  appVersion: string;
}
```

IPC messages are accepted only when `event.sender` is the app window's
`webContents` and the sender frame URL matches an allowed origin
(`http://127.0.0.1:<port>`, `http://localhost:<port>`, or the dev URL origin).
Untrusted senders are ignored (handlers may throw `UNAUTHORIZED`).

## MCP server

- Transport: stdio (`StdioServerTransport`), server name `live2d-pet`, version
  `0.1.0`.
- Auto-starts the app on the first tool call (30-second app start timeout,
  20-second page-ready timeout).
- Every tool returns text content + `structuredContent`; errors set
  `isError: true` with `{ ok: false, error: { code, message, details? } }`.
- `live2d_screenshot` returns an `image` content block (base64 PNG) plus a text
  block with the saved path and dimensions.

| Tool | Input schema |
| --- | --- |
| `live2d_status` | none |
| `live2d_capabilities` | none |
| `live2d_expression` | `expression`: string 1..128 or int ≥ 0; `ttlMs`?: 0..3600000 |
| `live2d_motion` | `group`: 1..128; `index`?: int; `priority`?: idle/normal/force; `wait`?: bool; `timeoutMs`?: 100..120000 |
| `live2d_say` | `text`?: ≤2000; `tts`?: bool; `voice`?: ≤256; `audioPath`?: local file; `wait`?: bool; `bubble`?: bool |
| `live2d_params` | optional `id` (1..128), `value` (number), `ttlMs` (0..3600000) |
| `live2d_model` | optional `id` (regex above) to load; omit to list |
| `live2d_screenshot` | none |
| `live2d_reset` | none |
| `live2d_window` | `x`, `y`, `width` (200..4000), `height` (200..4000), `alwaysOnTop`, `clickThrough`, `visible` — at least one |

CLI/MCP client config snippets are printed by `npm run install:skill` and
documented in the README.

## Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `APP_NOT_RUNNING` | 400 (CLI exit 2) | App not reachable/startable. |
| `NOT_READY` | 400 | Renderer not ready or went away. |
| `CORE_MISSING` / `MODEL_MISSING` / `MODEL_LOAD_FAILED` / `MODEL_INVALID` / `UNSUPPORTED_MODEL` | 400 | Model/Core setup problem. |
| `UNKNOWN_EXPRESSION` / `UNKNOWN_MOTION` / `UNKNOWN_PARAMETER` | 400 | Unknown id/name/index. |
| `OUT_OF_RANGE` / `FEATURE_UNAVAILABLE` / `AUDIO_UNSUPPORTED` / `AUDIO_TOO_LARGE` / `TTS_UNAVAILABLE` / `WINDOW_HIDDEN` | 400 | Capability/validation failure. |
| `BAD_REQUEST` | 400 | Malformed request/arguments. |
| `UNAUTHORIZED` | 401 | Missing/invalid token. |
| `RATE_LIMITED` | 429 | Too many requests. |
| `BUSY` | 409 | Conflicting operation. |
| `TIMEOUT` | 504 | Command/renderer timeout. |
| `INTERNAL` | 500 | Unexpected error. |

The CLI maps these to exit codes 2/3/4/5/6 (see the skill's
`references/commands.md`).

## Versioning

- `v` is part of every request/response and must be `1`.
- Additive changes (new optional fields, new commands, new state fields) keep
  `v: 1`; clients must ignore unknown state fields and treat unknown command
  types as unsupported.
- Breaking changes require a new protocol version and a matching update to the
  CLI, MCP server and skill docs.
