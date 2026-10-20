# Security

This document describes the security model of Live2D Agent: what is protected,
what is not, and how to operate the app safely. It is a local desktop companion,
not a server product.

## Scope and threat model

The app assumes a single human user on a Windows desktop. Assets worth
protecting:

- control of the pet (expressions, speech, screenshots, window, quit),
- the per-run HTTP token in `runtime.json`,
- local files: installed models, Cubism Core, screenshots, uploaded audio,
  config and logs,
- the user's desktop session (a screenshot captures only the pet window).

Potential attackers considered:

1. **A local process running as the same user** — can read the runtime directory
   and therefore the token; this is not preventable without OS-level isolation.
2. **A web page in a browser on the same machine** — could try to reach the
   loopback port (CSRF/DNS-rebinding style attacks). Mitigated by host/origin
   checks, a bearer token that a browser cannot read, and CORS-less responses.
3. **A malicious or corrupted Live2D model/Core file** — models are data parsed
   by Cubism Core/WebGL and are not sandboxed by this app; only install models
   from sources you trust.
4. **A network attacker** — out of scope: the server binds `127.0.0.1` only. Do
   not expose it through port forwarding, proxies or firewall rules.

## HTTP server controls

### Loopback binding

The server binds `127.0.0.1`, never `0.0.0.0` or `::`. It starts at
`LIVE2D_PORT`/`config.server.port` (default 47100) and tries up to 10
consecutive ports. The actual URL is published in `runtime.json`.

### Host and Origin validation

Every request is rejected unless `Host` is `127.0.0.1:<port>` or
`localhost:<port>`. If an `Origin` header is present it must match one of those
origins (plus the configured dev origin when `LIVE2D_DEV_URL` is set). Rejections
are plain-text 403 responses. This blocks DNS-rebinding and cross-site requests
from ordinary browser pages.

### Bearer token

- A new random 32-byte token (64 hex characters) is generated on every start.
  It is not derived from machine identifiers and is never written to the log.
- Stored in `runtime.json`, which is written atomically with mode `0o600` where
  the platform supports it. On Windows, Node's `chmod` is limited; protection
  relies on the ACLs of the user profile directory. Do not move the runtime
  directory to a shared location.
- Removed when the app quits; stale files are ignored if the pid is dead or
  `/health` fails.
- Compared with `crypto.timingSafeEqual` to avoid timing leaks.
- Required for every `/api/` route via `Authorization: Bearer <token>` or
  `X-Live2D-Token`. `/health`, static renderer assets, `/core`, model assets and
  `/audio/<uuid>` are unauthenticated but still host/origin restricted. They
  contain no token and are only reachable from localhost.
- Anyone who can read `runtime.json` can control the pet. Treat it as a secret;
  the CLI/MCP read it automatically, so users should never need to copy it.

### Limits and validation

- JSON bodies are capped at 64 KiB; audio at 10 MiB.
- Requests are rate-limited to about 120 per second per token
  (`429 RATE_LIMITED`).
- All commands and requests are validated with strict zod schemas; unknown
  fields, invalid ranges and unknown commands are rejected (`BAD_REQUEST`).
- TTLs are capped (max 1 hour), window sizes clamped (200..4000 px), text capped
  (2000 characters), motion/speech timeouts capped (120 seconds).

### File serving safety

- **Cubism Core** is served from one fixed path (`core/live2dcubismcore.min.js`)
  and nothing else.
- **Models**: the model id must match `[A-Za-z0-9._-]+`; the requested path is
  resolved against the model directory, rejected if it escapes (including after
  `realpath`), and served only for a small extension allowlist (`.json`,
  `.moc3`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.wav`, `.mp3`, `.ogg`).
  Model `model3.json` references are validated on load: relative only, no `..`,
  must resolve inside the model directory, must exist.
- **Audio**: uploads must pass MIME + magic-byte checks, are stored under UUID
  names, served only for UUID-shaped ids, and expire after 10 minutes.
- **Renderer**: only files from `dist/renderer` are served; unknown paths get 404.

### Screenshot boundary

Screenshots capture the renderer's own window via Electron `capturePage()`, not
the desktop. They are written under `~/.live2d-agent/screenshots/`. A hidden
window returns `WINDOW_HIDDEN` rather than capturing something else.

## Electron and renderer hardening

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- The renderer only gets a small preload API (`window.live2dBridge`): bootstrap,
  command/screenshot listeners, state/result/log senders, drag. No filesystem,
  shell or arbitrary IPC is exposed.
- Navigation is blocked (`will-navigate`), new windows are denied, and all
  permission requests are denied.
- DevTools are disabled unless `LIVE2D_DEV_URL` or `LIVE2D_DEVTOOLS=1` is set.
- The window is frameless/transparent and not resizable beyond sane limits; it
  has no browser chrome.
- IPC messages are only accepted from the app window's `webContents` and an
  allowed frame origin. Other senders are ignored; the bootstrap handler throws
  `UNAUTHORIZED`.
- The renderer never uses `innerHTML` for user/model text (the bubble uses
  `textContent`), reducing injection risk from model metadata or speech text.

## Data handling and privacy

- No telemetry, analytics, crash reporting or remote API calls are implemented.
  All state stays on the local machine.
- Model/Core files, logs, screenshots and uploaded audio live under the runtime
  directory and are never uploaded.
- TTS uses the operating system's speech engine via Chromium
  `speechSynthesis`. Whether a given OS voice is synthesized locally or by a
  cloud-backed engine depends on the installed OS voice; this app only passes
  text to the system API.
- Logs contain app state and error details, not the auth token.
- Deleting the runtime directory removes all local app data (models and Core
  must then be reinstalled).

## Development-only settings

These are privileged and should not be used in normal operation:

- `LIVE2D_DEV_URL` — loads the renderer from a dev server and adds that origin
  to the allowed origin list. Only point it at a server you control.
- `LIVE2D_DEVTOOLS=1` — enables DevTools in the window.
- `LIVE2D_DEBUG` — verbose logging (may include model paths).
- `LIVE2D_AGENT_HOME` — relocates the runtime directory; keep it in a location
  protected by your user account.
- `LIVE2D_APP_ROOT` — used by the client to find the repo when auto-starting;
  do not point it at untrusted code.
- `LIVE2D_PORT` — changes the listening port; the host check uses the actual
  port, but avoid exposing the app through port forwarding.

## Known limitations

- **Same-user local processes are trusted.** A malicious local process can read
  `runtime.json` and use the token. OS user isolation is the boundary.
- **Windows file permissions are best-effort.** `runtime.json` is written with
  mode 0600, but Windows ACL semantics differ; keep the profile directory
  private and use a non-shared machine.
- **Loopback is not a firewall.** Other local users may be able to reach the
  port; the token still applies, but do not run on multi-user machines you do
  not trust.
- **Models and Core are third-party code/data.** Structural validation cannot
  prove safety. Cubism Core is proprietary Live2D software, not part of this
  repository, and every user obtains it under Live2D's terms.
- **No packaged sandboxing.** This version runs from source in Electron; it does
  not provide OS-level sandboxing or code signing. If you distribute a build,
  add signing/notarization and review Electron's security guidance.
- **The app can quit itself or move/hide its window via the API.** Any holder of
  the token can do this; that is intended for the local agent workflow.

## Hardening checklist

1. Keep the runtime directory inside your user profile and do not share it.
2. Never copy `runtime.json`/the token into prompts, logs or commits.
3. Do not port-forward the app or run it on an untrusted/shared desktop.
4. Install models/Core only from trusted sources; keep their license files.
5. Keep Electron/Node dependencies updated (`npm ci` from a reviewed lockfile).
6. Use `--no-start` or stop the app when it is not needed.
7. Remove test screenshots/audio you no longer need; they may contain personal
   content.
8. Audit third-party license obligations before redistributing a build.

## Reporting

If you find a security issue, avoid posting a working exploit publicly. Report
it privately to the project maintainers with reproduction steps, affected
versions, and the impact. Do not include your auth token or personal paths.
