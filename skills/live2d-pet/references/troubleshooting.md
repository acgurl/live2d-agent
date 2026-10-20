# Troubleshooting

Start with these three commands; they answer most questions:

```bat
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" version
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" status --json
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" logs --lines 200
```

The app log is at `~/.live2d-agent/logs/app.log` (JSON lines). Runtime state is
under `~/.live2d-agent/`; model files are in `models/`, Cubism Core in
`core/live2dcubismcore.min.js`.

## Setup problems

### Cubism Core is missing (`CORE_MISSING`, blank/overlay window)

The repository deliberately does not include Live2D Cubism Core. Install a
Cubism 5 SDK for Web R5 build (Core 6.x, `MocVersion_53`) from the official
package. Older builds such as Core 5.1.0 are rejected by easy-live2d 1.0.0:

```bat
npm run setup:core -- --from "D:\CubismSdkForWeb\Core\live2dcubismcore.min.js"
```

Or, after accepting Live2D's license:

```bat
npm run setup:core -- --download --accept-license
```

The setup script validates that the file defines `MocVersion_53`. Restart the
app afterwards. If the download fails, the CDN link may have moved; download
the SDK manually and use `--from`.

### A model is missing (`MODEL_MISSING`, "no model" overlay)

```bat
npm run setup:model -- --from "D:\Live2D\MyModel"
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" model list
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" model load <id>
```

The app only discovers a `.model3.json` at the top level of a directory under
`models/`. If your archive contains `MyModel/some/subdir/MyModel.model3.json`,
point `--from` at the directory that directly contains the `.model3.json`.

### A model is invalid (`MODEL_INVALID`)

Common causes:

- `FileReferences.Moc` or `FileReferences.Textures` missing/empty.
- A referenced file is missing or has a different case (case-sensitive file
  systems; Windows usually tolerates it).
- A path is absolute or contains `..` (the app rejects references that escape
  the model directory).
- A texture uses an extension outside the allowlist (`.png`, `.jpg`, `.jpeg`,
  `.webp`).

Re-install with `npm run setup:model -- --from <dir> --force` after fixing the
model. See [models.md](models.md).

### "Renderer not built"

The main process serves `dist/renderer`; if it is missing you see a setup page
instead of the model. Run:

```bat
npm ci
npm run build
```

Then restart the app.

### The app does not start

- Confirm dependencies: `npm ci` (Node 22.12+).
- Look at `logs/app.log`; startup failures are logged there and may also appear
  in a native error dialog.
- Try the repo directly: `npm start` (it clears `ELECTRON_RUN_AS_NODE` via
  `scripts/start.mjs`) or `npm run dev` for the Vite dev server.
- If `ELECTRON_RUN_AS_NODE=1` is set globally in your shell, Electron runs as
  Node and the GUI never opens (especially with `npm run dev` or a raw Electron
  command). Clear it before launching:

  ```bat
  set ELECTRON_RUN_AS_NODE=
  ```

  PowerShell: `$env:ELECTRON_RUN_AS_NODE=$null`. The generated launcher sets this
  variable only for the CLI-as-Node process; `npm start` and the app's auto-start
  clear it for the GUI child process. A globally exported value is the usual
  cause of a silent exit.
- Ports: the app binds `127.0.0.1` and tries 10 consecutive ports from
  `LIVE2D_PORT` (default 47100). Use `live2d version` to see the actual URL.

### The launcher is not found

Run the installer again:

```bat
npm run install:skill -- --dest "%USERPROFILE%\.claude\skills" --force
```

Until then, use the skill fallback:
`node <skill-dir>/scripts/live2d.mjs <command>`. The fallback script requires
`npm run build:skill`.

## CLI / API errors

| Code | Likely cause | Fix |
| --- | --- | --- |
| `APP_NOT_RUNNING` | App not started, or `--no-start` used, or `install.json` points at a missing Electron | `live2d ensure`; rerun `npm run install:skill`; check `install.json`. |
| `NOT_READY` | Renderer still loading, crashed, or renderer not built | Wait and retry `ensure`; check `logs`; rebuild. |
| `CORE_MISSING` | `core/live2dcubismcore.min.js` missing/invalid | `npm run setup:core -- --from <file>`. |
| `MODEL_MISSING` | No model installed or id wrong | `model list`, `setup:model`. |
| `MODEL_LOAD_FAILED` | Model file passed validation but the renderer could not load it | Check log for the renderer error; re-export the model from Cubism Editor. |
| `MODEL_INVALID` / `UNSUPPORTED_MODEL` | Broken references, wrong Cubism version, insecure paths | Fix/model re-export; see [models.md](models.md). |
| `UNKNOWN_EXPRESSION` | Name/index not in this model | `expressions --json`, use exact name. |
| `UNKNOWN_MOTION` | Group/index not in this model | `motions --json`. |
| `UNKNOWN_PARAMETER` | Parameter id not exposed by model | `params --json`. |
| `OUT_OF_RANGE` | Gaze outside -1..1, invalid value, index out of range | Use reported ranges. |
| `FEATURE_UNAVAILABLE` | Feature flag false for this model/renderer | `caps --json` → `features`; use another approach. |
| `AUDIO_UNSUPPORTED` | Not WAV/MP3/OGG, or content does not match the MIME type | Convert the file (ffmpeg). |
| `AUDIO_TOO_LARGE` | File over 10 MB | Shorten/compress. |
| `TTS_UNAVAILABLE` | No system speech voices, or OS TTS disabled | `voices --json`; fall back to `say "..."` or `--audio`. |
| `TIMEOUT` | Animation/speech longer than the request timeout | Raise `--timeout` (max 120000) or drop `--wait`. |
| `WINDOW_HIDDEN` | Screenshot while the pet is hidden | `window --visible`, retry once. |
| `UNAUTHORIZED` | Stale token (app restarted) or wrong `--token` | Retry normally; the CLI reads the new `runtime.json`. Remove manual `--token` overrides. |
| `RATE_LIMITED` | More than ~120 requests/second | Slow down; do not loop commands. |
| `BUSY` | Conflicting operation in the renderer | Wait for the current motion/speech, then retry. |
| `BAD_REQUEST` | Invalid CLI argument or API payload | Read the message; `--help` for usage. |
| `INTERNAL` | Unexpected app error | Check `logs`; restart `live2d stop` then `live2d ensure`. |

Exit codes: 0 ok, 2 app not running, 3 timeout, 4 capability/validation,
5 bad arguments, 6 internal/auth. See [commands.md](commands.md).

## Interaction problems

### The pet is invisible

- `live2d window --visible` and check the tray icon.
- A click-through window cannot be clicked; turn it off with
  `live2d window --no-click-through` or the tray menu.
- It may be positioned off-screen; move it with `window --x 100 --y 100`.
- The model may have failed to load; check `status --json` → `modelError`,
  `lastError` and the log.

### The pet does not speak

- Bubble only: `say "text"` (no `--tts`).
- TTS: `voices --json`; empty means the OS has no voices. Windows:
  Settings → Time & language → Speech → Manage voices.
- `--voice` must match an exact voice name.
- Audio: use `.wav`, `.mp3` or `.ogg` under 10 MB and a valid audio file.
- Check whether the model actually has a LipSync group; some models use scripted
  or simplified mouth motion.

### The expression or motion does nothing

- The command returned ok but the model/name may be wrong: re-run
  `caps --json` and use exact IDs.
- An expression can be overridden by an active motion or a default expression.
- A motion may already be playing; wait or use `--priority force` deliberately
  (avoid spam).
- `reset` clears expressions, motions, overrides and the bubble.

### Screenshots are black or empty

- The window must be visible (`WINDOW_HIDDEN` is returned otherwise).
- Transparent windows capture the renderer content, not the desktop; black
  usually means the WebGL context failed — check the log for GPU/WebGL errors.
- Update the GPU driver or try running with the default Electron GPU settings.
- The screenshot includes only the pet window, not the whole screen.

### The pet lags or animations stutter

- Reduce window size (`window --width 360 --height 640`).
- Close other GPU-heavy apps; Live2D uses the GPU via PixiJS/WebGL.
- Check `status --json` → `fps`.
- Models with many high-resolution textures are more expensive; resize textures
  in Cubism Editor.

## Skill and MCP problems

### The agent does not use the skill

- The skill must be in a directory the client scans. Re-run
  `npm run install:skill -- --dest <skills-dir>` (for Claude Code:
  `%USERPROFILE%\.claude\skills`).
- Restart the agent/client after installing (skills are discovered at startup).
- Verify `<dest>/live2d-pet/SKILL.md` exists and starts with YAML frontmatter.
- The agent can always fall back to the CLI directly using the launcher path.

### MCP server does not connect

- Re-run the installer and copy the printed snippet; on Windows Claude Desktop
  needs `"command": "cmd", "args": ["/c", "<...>\live2d-mcp.cmd"]`.
- Test the server by hand: `node <appRoot>/dist/mcp.mjs` should start and wait on
  stdin (Ctrl+C to exit). If it exits immediately, rebuild with `npm run build`.
- Restart the client after editing its config.
- Check the client's MCP logs; a stale `install.json` can break auto-start.
- The MCP server auto-starts the app; make sure Core and a model are installed.

## Resetting state

- `live2d reset` — expression/motions/overrides/bubble.
- `live2d stop` — quit the app (tray/auto-start will relaunch it later).
- Delete `~/.live2d-agent/config.json` to restore default window/behaviour
  settings (the app recreates it).
- Delete `~/.live2d-agent/runtime.json` only if the app is not running; it is
  recreated on start.
- Logs and screenshots can be deleted freely.
- Never delete `core/` or `models/` unless you intend to reinstall them.

## Reporting a bug

Collect:

1. `live2d version --json`
2. `live2d status --json`
3. `live2d logs --lines 300`
4. OS version, GPU, Node/Electron version.
5. Steps to reproduce and the exact command that failed.

Do **not** include the auth token from `runtime.json` or personal file paths you
do not want to share.
