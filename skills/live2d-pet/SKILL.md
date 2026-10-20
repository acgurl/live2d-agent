---
name: live2d-pet
description: Control the local Live2D desktop companion (desktop pet) on this computer. Use when the user asks you to make the Live2D pet react, apply or clear expressions, play motions, set parameters or gaze, move or resize the pet window, make the pet speak with speech/TTS or an audio file, take a screenshot of the pet, or list/switch Live2D models.
license: MIT
---

# Live2D Pet

The Live2D pet is a local Electron desktop companion. You control it with the
`live2d` CLI, which talks to the app over a loopback-only HTTP API using a
per-launch token discovered from `~/.live2d-agent/runtime.json`. The CLI
**auto-starts** the app if it is not running. There is no remote service and
nothing leaves the machine.

## Launcher

Use this stable launcher first (it is created by `npm run install:skill` and
survives rebuilds):

```
%USERPROFILE%\.live2d-agent\bin\live2d.cmd
```

Windows examples in this skill assume cmd/PowerShell; always quote the path.

If the launcher does not exist (for example the skill was copied without running
the installer), fall back to the packaged skill script:

```
node <skill-dir>/scripts/live2d.mjs
```

`<skill-dir>` is the directory containing this SKILL.md (for example
`%USERPROFILE%\.claude\skills\live2d-pet`). That script is produced by
`npm run build:skill`.

Before doing anything, resolve the command once:

- Windows cmd: `"%USERPROFILE%\.live2d-agent\bin\live2d.cmd"`
- PowerShell: `& "$env:USERPROFILE\.live2d-agent\bin\live2d.cmd"`
- POSIX: `"$HOME/.live2d-agent/bin/live2d"` (created by the installer when available)

Do not call the HTTP API directly, do not read or print the token, and do not
edit `runtime.json` or `config.json`.

## Golden rules

1. **Status first.** Run `live2d ensure` (or `live2d status --json`) before any
   expressive command. `ensure` starts the app, waits for the renderer and a
   model. If it exits non-zero, report the error and stop; do not guess.
2. **Exact IDs from capabilities.** Get expression names, motion groups, motion
   indices and parameter IDs from `live2d caps --json` (or
   `expressions`/`motions`/`params`). Never invent or guess a name. Numbers are
   accepted where the CLI says "name or index".
3. **No command spam.** One or two expressive actions per user request. Never
   loop motions or re-send the same command. When several effects are wanted,
   combine them into one short sequence, then stop. Use `--wait` only when the
   next step depends on the animation finishing, and never `--wait` on a motion
   whose `loop` flag is true in `motions --json` — it will time out by design.
4. **TTL for transient changes.** Anything you apply just to react (expression,
   gaze, parameter) should expire with `--ttl <ms>` (typically 2000-10000 ms),
   so the pet returns to its idle state on its own. Persistent changes need an
   explicit user request.
5. **Reset at the end.** Finish ad-hoc interactions with `live2d reset` (clears
   expression, motions, parameter overrides and bubble) unless the user asked
   for a lasting change. Do not leave the pet frozen in a strange pose.
6. **Local and quiet.** Keep stdout for results and stderr for diagnostics. Use
   `--json` when you need to parse. Never expose the base URL/token, never try
   to reach the app from another machine.
7. **Respect the window.** If a screenshot fails because the window is hidden,
   run `live2d window --visible` first and retry once. Avoid leaving the pet
   click-through (`--click-through`) unless the user explicitly wants it: they
   cannot interact with it afterwards without the tray menu.

## First contact

```bat
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" ensure
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" caps --json
```

Read `model.id`, `capabilities.expressions[].name`,
`capabilities.motions[].group`/`.index`, and
`capabilities.parameters[].id`/`.min`/`.max` from the JSON.

## Recipes

### Greet the user

```bat
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" ensure
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" expression happy --ttl 5000
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" motion TapBody --index 0
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" say "Hello! I'm here." --ttl 5000
```

Use names from your own `caps` output; the names above are examples only.

### React to good/bad news

```bat
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" expression <expression-name> --ttl 6000
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" say "<one short line>" --ttl 5000
```

### Play a motion (and wait only if needed)

```bat
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" motion <group> --index <n> --priority normal
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" motion <group> --index <n> --wait
```

### Make the pet speak

```bat
rem bubble only
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" say "Nice to meet you." --ttl 6000
rem with system TTS (voice list: live2d voices --json)
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" say "Nice to meet you." --tts --ttl 6000
rem with recorded audio (wav, mp3 or ogg, max 10 MB)
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" say --audio "C:\path\line.wav" --ttl 6000
```

### Take a screenshot

```bat
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" window --visible
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" screenshot --out "C:\path\pet.png"
```

The JSON result contains `screenshot.path`, `width`, `height`, `bytes`. Report
the saved path to the user; attach/show the image when the interface supports it.

### Switch models

```bat
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" model list --json
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" model load <model-id>
```

If the model is not installed, tell the user to run
`npm run setup:model -- --from <dir>`; do not download models yourself.

### Move or resize the pet

```bat
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" window --x 1200 --y 400
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" window --width 480 --height 800
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" window --visible
```

`--always-on-top` / `--no-always-on-top` and `--click-through` /
`--no-click-through` toggle those window modes. Use `--hidden` to hide the pet
and `--visible` to show it again. When the pet is click-through, the tray menu is
the only way to get it back without the CLI.

### Clean up

```bat
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" reset
```

## Command table

`live2d <command> [options]` — global options: `--json`, `--timeout <ms>`,
`--url <url>`, `--token <token>`, `--no-start`.

| Command | What it does | Key options |
| --- | --- | --- |
| `ensure` | Start app if needed, wait for page + model | — |
| `status` | App, page, model, window and capability status | `--json` |
| `caps` | Capabilities: expressions, motions, parameters, groups, features | `--json` |
| `expressions` | List expressions (name + index) | `--json` |
| `motions` | List motions (group, index, name, loop) | `--json` |
| `expression <name\|index>` | Apply an expression | `--ttl <ms>` |
| `motion <group>` | Play a motion from a group | `--index <n>`, `--wait`, `--priority idle\|normal\|force` |
| `param <id> <value>` | Set one parameter | `--ttl <ms>` |
| `params` | Parameter ranges + current overrides | `--json` |
| `look <x> <y>` | Point gaze, normalized -1..1 | `--ttl <ms>` |
| `say [text]` | Bubble, TTS or audio speech | `--tts`, `--voice <name>`, `--audio <file>`, `--ttl <ms>`, `--wait` |
| `model list` | List installed models | `--json` |
| `model load <id>` | Load an installed model | — |
| `window` | Move/resize/show the window | `--x`, `--y`, `--width`, `--height`, `--always-on-top`, `--click-through`, `--visible` |
| `screenshot` | Capture the pet as PNG | `--out <file>` |
| `reset` | Clear expression, motions, overrides, bubble | — |
| `stop` | Quit the app | — |
| `voices` | List system TTS voices | `--json` |
| `logs` | Print the app log tail | `--lines <n>` |
| `version` | CLI/protocol/app versions | `--json` |

Exit codes: `0` success, `2` app not running/not startable, `3` timeout,
`4` capability or model validation error, `5` bad arguments, `6` internal/auth
error. Always inspect stderr on non-zero exit.

## Error recovery

| Symptom / error code | What to do |
| --- | --- |
| `APP_NOT_RUNNING` | Run `live2d ensure`; if it still fails, `live2d logs` and report the log tail. |
| `NOT_READY` | The renderer/page is still starting. Wait a moment and retry `ensure`; do not spam commands. |
| `CORE_MISSING` | Cubism Core is not installed or is an older build. Tell the user to run `npm run setup:core -- --from <file>` with a Cubism 5 R5 / Core 6.x file (Core is never bundled). |
| `MODEL_MISSING` / `MODEL_INVALID` / `MODEL_LOAD_FAILED` | Run `live2d model list`; ask the user to install a model with `npm run setup:model`. Do not fabricate a model id. |
| `UNKNOWN_EXPRESSION` / `UNKNOWN_MOTION` / `UNKNOWN_PARAMETER` | Re-read `live2d caps --json` and use an exact name/index/id. |
| `OUT_OF_RANGE` | Use the parameter min/max from `params --json`; expression indices from `expressions --json`. |
| `TIMEOUT` | Use `--wait` only when needed; raise `--timeout` (max 120000 ms) for long motions/speech; otherwise treat as failure. |
| `WINDOW_HIDDEN` | `live2d window --visible`, then retry the screenshot once. |
| `TTS_UNAVAILABLE` | Run `live2d voices`; if empty, fall back to a bubble (`say "..."`) or `--audio <file>`. |
| `AUDIO_UNSUPPORTED` / `AUDIO_TOO_LARGE` | Use .wav/.mp3/.ogg under 10 MB; convert the file first. |
| `UNAUTHORIZED` / `RATE_LIMITED` / internal | The app may have restarted or been spammed. Run `live2d ensure`, then retry slowly. Do not read tokens manually. |
| `--json` output with `ok: false` | Read `error.code`/`error.message` and follow this table. |

More detail: [commands.md](references/commands.md),
[models.md](references/models.md),
[troubleshooting.md](references/troubleshooting.md).

## MCP alternative

If the user's agent client is configured with the `live2d` MCP server, the same
actions are exposed as `live2d_*` tools: `live2d_status`,
`live2d_capabilities`, `live2d_expression`, `live2d_motion`, `live2d_say`,
`live2d_params`, `live2d_model`, `live2d_screenshot`, `live2d_reset`,
`live2d_window`. Prefer those tools when available; the golden rules and
semantics are identical to the CLI. The server auto-starts the app on first use,
and `live2d_screenshot` returns both an image block and the saved file path.
