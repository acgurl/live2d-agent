# live2d CLI reference

This is the detailed command reference for the `live2d` CLI. The short version
lives in [../SKILL.md](../SKILL.md); model files are covered in
[models.md](models.md) and failures in [troubleshooting.md](troubleshooting.md).

## Invocation

Preferred stable launcher (created by `npm run install:skill`):

```bat
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" <command> [options]
```

POSIX launcher created by the same installer:

```sh
"$HOME/.live2d-agent/bin/live2d" <command> [options]
```

Fallback when the launcher is missing but the skill was built:

```bat
node "%USERPROFILE%\.claude\skills\live2d-pet\scripts\live2d.mjs" <command> [options]
```

The launcher runs `<appRoot>/dist/cli.mjs` with Electron in Node mode
(`ELECTRON_RUN_AS_NODE=1`) when Electron is available, and falls back to
`node`. The CLI is a thin client of the desktop app; it does not render Live2D
itself.

## Global options

Global options can be placed before or after the command (for example
`live2d status --json` and `live2d --json status` are both valid).

| Option | Meaning |
| --- | --- |
| `--json` | Print one JSON document on stdout. Diagnostics still go to stderr. |
| `--timeout <ms>` | Control-request timeout. Bounds: 100..120000. Defaults are per command. |
| `--url <url>` | Override the app base URL. Requires `--token` unless a running app is discovered. |
| `--token <token>` | Override the auth token (normally read from `runtime.json`). |
| `--no-start` | Never auto-start the app; fail with `APP_NOT_RUNNING` instead. |
| `-h, --help` | Help for the program or a subcommand. |
| `-V, --version` | Print the CLI package version. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 2 | App not running (or could not be started). |
| 3 | Timeout. |
| 4 | Capability/model validation error (`CORE_MISSING`, `MODEL_MISSING`, `UNKNOWN_EXPRESSION`, `OUT_OF_RANGE`, ...). |
| 5 | Bad arguments / unknown command / invalid option value. |
| 6 | Internal error, `UNAUTHORIZED`, `RATE_LIMITED` or `BUSY`. |

In `--json` mode failures print:

```json
{
  "ok": false,
  "error": {
    "code": "APP_NOT_RUNNING",
    "message": "The Live2D desktop app is not running.",
    "details": { "hint": "Run: live2d ensure" }
  }
}
```

The human-readable diagnostic goes to stderr as `error (CODE): message` plus an
optional `hint:` line.

## Discovery and auto-start

1. The CLI reads `~/.live2d-agent/runtime.json` (or
   `$LIVE2D_AGENT_HOME/runtime.json`) and calls `GET /health`.
2. If the app is not running and auto-start is enabled, it reads
   `~/.live2d-agent/install.json` and starts Electron with the recorded app
   root; without `install.json` it looks for Electron under the current repo.
3. It waits up to ~20 seconds for `/health`, then shows the app log tail on
   failure.
4. Commands that need the renderer first wait for `pageReady` (15 seconds by
   default, controlled by `--timeout`).

`live2d stop`, `live2d logs` and `live2d version` never auto-start the app.
`version` and `logs` work without a running app.

## Commands

### ensure

Start the app if needed and wait until the renderer and a model are ready
(up to 45 seconds by default). Use this before any expressive command.

```bat
live2d ensure
live2d ensure --json
```

JSON result:

```json
{
  "ok": true,
  "app": { "baseUrl": "http://127.0.0.1:47100", "pid": 1234, "version": "0.1.0", "uptimeMs": 1234 },
  "model": { "id": "hiyori", "displayName": "hiyori", "entry": "Hiyori.model3.json" },
  "capabilities": { "expressions": 8, "motions": 10, "parameters": 42, "coreVersion": "...", "features": {} },
  "window": {},
  "waitedMs": 1234
}
```

If the page is ready but no model is installed, it exits with `MODEL_MISSING`
(exit 4) and includes the installed model ids when available.

### status

Show app health, page readiness, model, expression, motions, speech, overrides,
window, FPS, voice count and errors. Does not wait for the page.

```bat
live2d status
live2d status --json
```

JSON shape: `{ ok, health, runtime: { baseUrl, pid, version, appRoot, packaged }, state }`,
where `state` is the full `PublicState` documented in the project's
`docs/protocol.md`.

### caps

Print the capabilities of the loaded model: expressions, motions, parameter
ranges, groups (LipSync/EyeBlink/HitAreas), feature flags and Cubism Core
version. Waits for the page.

```bat
live2d caps --json
```

Use names/ids from this output for every other command.

### expressions / motions

```bat
live2d expressions --json
live2d motions --json
```

- `expressions`: `[{ name, index }]`
- `motions`: `[{ group, index, name, loop }]`

### expression

Apply an expression by name or numeric index.

```bat
live2d expression happy
live2d expression 3
live2d expression happy --ttl 5000
```

- `--ttl <ms>`: release the expression after the TTL (0..3600000) and return
  to the model's default expression. Use it for transient reactions.
- Unknown names fail with `UNKNOWN_EXPRESSION` (exit 4).

### motion

Play a motion from a motion group.

```bat
live2d motion TapBody
live2d motion TapBody --index 0
live2d motion TapBody --index 2 --priority force --wait
```

- `--index <n>`: zero-based motion index inside the group (default: let the SDK
  choose).
- `--priority <idle|normal|force>`: motion priority, default `normal`.
- `--wait`: wait for the motion to finish (request timeout 30 seconds).
- Unknown group fails with `UNKNOWN_MOTION` (exit 4).

### param / params

```bat
live2d params --json
live2d param ParamAngleX 20 --ttl 4000
```

- `param <id> <value>`: set one parameter to a finite number. Values are clamped
  by the renderer to the model range; out-of-range values still report
  `OUT_OF_RANGE` when clearly invalid.
- `--ttl <ms>`: release the override after the TTL. Without `--ttl` the override
  persists until `reset` or released by the app.
- `params` lists every model parameter with min/max and any active override.

### look

Point the gaze using normalized screen coordinates (x, y in -1..1).

```bat
live2d look 0.5 -0.2
live2d look -1 0 --ttl 3000
```

Uses `gaze.set`; gaze may be overridden by automatic gaze-follow behaviour.

### say

Show a speech bubble, optionally with system TTS and/or a recorded audio file.

```bat
live2d say "Good morning!" --ttl 6000
live2d say "Good morning!" --tts --ttl 6000
live2d say "Good morning!" --voice "Microsoft Zira Desktop" --ttl 6000
live2d say --audio "C:\voice\line.wav" --ttl 6000
live2d say "Hello" --audio "C:\voice\line.mp3" --wait
```

- Text is limited to 2000 characters; either text or `--audio` is required.
- `--tts`: use the system speech synthesis voice.
- `--voice <name>`: choose a TTS voice by exact name (implies `--tts`). List
  voices with `live2d voices --json`.
- `--audio <file>`: upload a local `.wav`, `.mp3` or `.ogg` file (max 10 MB).
  The file is cached by the app for 10 minutes and served under `/audio/<id>`.
- `--ttl <ms>`: keep the bubble visible for this long after speech (or after
  it appears for bubble-only messages), then hide it. The command returns
  immediately; pass `--wait` only when you need to wait for speech playback.
- `--wait`: wait for playback to finish (up to 60 seconds by default).
- Lip-sync quality depends on the model's LipSync group; models without one may
  show simplified mouth motion.

### model

```bat
live2d model list --json
live2d model load hiyori
```

- `model list`: installed model ids, display names and entry files plus the
  active model.
- `model load <id>`: validates the model directory and switches the scene. The
  loaded id is persisted in `config.json`.
- Model ids may contain letters, digits, dot, underscore and dash (max 128).

### window

```bat
live2d window --x 1200 --y 400
live2d window --width 480 --height 800
live2d window --always-on-top
live2d window --no-always-on-top
live2d window --click-through
live2d window --no-click-through
live2d window --visible
live2d window --hidden
```

- Pixel bounds are clamped by the app to sane ranges (width/height 200..4000).
- `--visible` shows the window; `--hidden` hides it.
- `--always-on-top` / `--no-always-on-top` and `--click-through` /
  `--no-click-through` toggle those modes. A click-through window cannot be
  clicked directly, so turn it off from the CLI or the tray menu.
- At least one option is required, otherwise exit 5.

### screenshot

```bat
live2d screenshot
live2d screenshot --out "C:\Users\me\Pictures\pet.png"
```

Captures the renderer window (not the whole screen) as a PNG, exactly as it is
currently rendered — hide the bubble first (for example with `reset`) if you do
not want it in the image. The default output is
`~/.live2d-agent/screenshots/<timestamp>-<id>.png`. A hidden window fails with
`WINDOW_HIDDEN`; run `window --visible` first.

JSON: `{ ok, screenshot: { path, width, height, bytes } }`.

### reset

```bat
live2d reset
```

Clears the active expression, stops motions, releases parameter overrides and
hides the bubble. Run it at the end of ad-hoc interactions.

### stop

Stops the app through `POST /api/v1/app/quit` and waits up to 5 seconds. Safe to
call when the app is not running (`alreadyStopped: true`). Does not auto-start.

### voices

```bat
live2d voices --json
```

Lists system TTS voices from the renderer. Empty list means TTS is unavailable;
use `say --audio`.

### logs

```bat
live2d logs
live2d logs --lines 250
```

Prints the tail of `~/.live2d-agent/logs/app.log`. The JSON form returns
`{ path, totalLines, lines }`. This command reads the file directly, so it works
when the app is down.

### version

```bat
live2d version
live2d version --json
```

Prints CLI version, protocol version, Node version, platform/arch, runtime
directory and app runtime info when `runtime.json` exists. Does not require the
app to be running.

## Environment variables

| Variable | Effect |
| --- | --- |
| `LIVE2D_AGENT_HOME` | Override the runtime directory (default `%USERPROFILE%\.live2d-agent`). CLI and app must agree. |
| `LIVE2D_PORT` | Preferred HTTP port for the app (default 47100; the app tries up to 10 consecutive ports). |
| `LIVE2D_APP_ROOT` | Repository root used when auto-starting without `install.json`. |
| `LIVE2D_DEBUG` | Verbose app logging. |
| `LIVE2D_DEV_URL` | Dev server URL for the renderer (development only). |
| `ELECTRON_RUN_AS_NODE` | Set to `1` by the launcher so Electron runs the CLI as Node. The app clears it for the GUI child process; do not set it globally. |

## Runtime files

| File | Purpose |
| --- | --- |
| `runtime.json` | Base URL, port, token, pid, version, app root; written on app start, removed on quit. Mode 0600 where supported. |
| `install.json` | App root + Electron path used by the CLI to auto-start the app. |
| `config.json` | Persisted window, render, behaviour, bubble and speech settings plus the active model id. |
| `logs/app.log` | JSON-lines application log. |
| `screenshots/`, `audio/`, `models/`, `core/` | Screenshots, uploaded audio cache, installed models, Cubism Core. |

## Recommended agent sequence

```bat
live2d ensure --json
live2d caps --json                      rem read exact IDs once
live2d expression <name> --ttl 5000
live2d motion <group> --index <n>
live2d say "<short line>" --ttl 5000
live2d reset
```

Do not repeat steps in a loop. If the user wants a persistent mood, leave the
expression/parameters in place and say so instead of resetting.

## MCP equivalence

When the `live2d` MCP server is configured (see the project's
`docs/protocol.md` for the transport and `scripts/install-skill.mjs` for
ready-made snippets), the tools expose the same operations and error codes:

| Tool | Main arguments |
| --- | --- |
| `live2d_status` | none |
| `live2d_capabilities` | none |
| `live2d_expression` | `expression` (name or index), `ttlMs` |
| `live2d_motion` | `group`, `index`, `priority`, `wait`, `timeoutMs` |
| `live2d_say` | `text`, `tts`, `voice`, `audioPath`, `wait`, `bubble` |
| `live2d_params` | list; or `id`, `value`, `ttlMs` to set or read one |
| `live2d_model` | none to list; `id` to load |
| `live2d_screenshot` | none; returns an image block + file path |
| `live2d_reset` | none |
| `live2d_window` | `x`, `y`, `width`, `height`, `alwaysOnTop`, `clickThrough`, `visible` |

The server auto-starts the app and returns `isError` results with the same error
codes as the CLI.
