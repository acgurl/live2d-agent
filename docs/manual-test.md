# Manual test checklist

Use this checklist before calling a release usable. It covers the packaging and
documentation work as well as the app/CLI/MCP/skill surfaces. Tests are manual
unless noted; no test framework is required.

> Conventions: commands are shown for Windows PowerShell. Run them from the
> repository root. For isolated tests, override the runtime directory and keep
> the same value for the app and the CLI in the same shell:
>
> ```powershell
> $env:LIVE2D_AGENT_HOME = Join-Path $env:TEMP "live2d-agent-manual"
> ```
>
> Delete that directory afterwards to simulate a fresh machine.

## 0. Prerequisites

- [ ] Windows 11, Node.js 22.12+ (`node --version`), npm.
- [ ] `npm ci` completes and `node_modules/electron/dist/electron.exe` exists.
- [ ] A Cubism 5 SDK for Web R5 / Core 6.x file (defines `MocVersion_53`) is
      available locally (or network access for `--download`).
- [ ] A valid Live2D model directory with a top-level `.model3.json` (Hiyori or
      your own) is available.

## 0.1 One-command setup (`npm run setup`)

- [ ] `node --check scripts/setup.mjs` exits 0.
- [ ] `node --check scripts/setup-models.mjs` and `node --check
      scripts/lib/models.mjs` exit 0.
- [ ] `node scripts/setup.mjs --help` exits 0 and documents `--config`,
      `--catalog`, `--model`, `--models`, `--force`, `--no-deps`,
      `--no-build`, `--no-launch`, `--no-core`, `--no-model`,
      `--no-verify`, `--core-url`, `--skill-dest`.
- [ ] `node scripts/setup-models.mjs --help` exits 0 and documents `--list`,
      `--model`, `--models`, `--catalog`, `--no-default`.
- [ ] In a clean `LIVE2D_AGENT_HOME`, `npm run setup -- --no-build --no-launch`
      creates `<runtime>/core/live2dcubismcore.min.js` and every model listed in
      `models.install` (default `hiyori` and `hiyori-free`), each with a
      top-level `.model3.json`; `<runtime>/config.json` has `model` equal to
      `models.default`.
- [ ] Re-running setup without `--force` skips the verified Core and installed
      models; `--force` re-downloads/reinstalls them.
- [ ] Editing a catalog entry (`scale`, `displayName`) and re-running setup
      updates `<model>/live2d-agent.json` without a download.
- [ ] `npm run setup -- --model hiyori-free` installs only `hiyori-free` and
      makes it the default; `npm run setup -- --models hiyori` installs only
      `hiyori`.
- [ ] `npm run setup:models -- --list` prints both catalog models and their
      installed state; `npm run setup:models -- --models hiyori-free` installs
      without rebuilding.
- [ ] Two catalog models sharing one `url` download the zip once (a single
      `cache/model-*.zip`).
- [ ] A wrong `core.sha256`/catalog model `sha256` fails with a SHA-256
      mismatch; `--no-verify` overrides it (test only with trusted sources).
- [ ] `setup.skillDest` installs the skill and creates the stable launchers;
      `--skill-dest <dir>` overrides it.
## 1. Syntax and build

- [ ] `node --check scripts/setup-core.mjs` exits 0.
- [ ] `node --check scripts/setup-model.mjs` exits 0.
- [ ] `node --check scripts/install-skill.mjs` exits 0.
- [ ] `node --check scripts/setup.mjs` exits 0.
- [ ] `node --check scripts/setup-models.mjs` and `node --check
      scripts/lib/models.mjs` exit 0.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run lint` exits 0 (or only pre-existing warnings are reported).
- [ ] `npm run build` exits 0 and creates:
  - `dist/renderer/index.html`
  - `dist/main.cjs`, `dist/preload.cjs`
  - `dist/cli.mjs`, `dist/mcp.mjs`
  - `skills/live2d-pet/scripts/live2d.mjs`, `live2d-mcp.mjs`

## 2. setup-core.mjs

- [ ] `node scripts/setup-core.mjs --help` exits 0 and lists `--from`,
      `--download`, `--accept-license`, `--force`, license URLs and the target
      path.
- [ ] Fresh runtime dir + no args: exits 1, prints the Cubism 5 SDK for Web R5
      download URL and the two proprietary-license URLs; creates nothing.
- [ ] `node scripts/setup-core.mjs --download` without `--accept-license`
      exits 1 and refuses to download.
- [ ] `node scripts/setup-core.mjs --download --accept-license` (network)
      installs `<runtime>/core/live2dcubismcore.min.js`, reports
      `MocVersion_53` / Core 6.x, prints license URLs and the "do not bundle/
      redistribute" reminder. Re-running without `--force` exits 1. (Network
      failures must print the manual SDK download instructions, not crash.)
- [ ] Invalid input (HTML/JSON/small file) passed to `--from` exits 1 with a
      validation error.
- [ ] An older Cubism Core (for example 5.1.0, `MocVersion_50`; the old
      `sdk-web/cubismcore` CDN build) passed to `--from` exits 1 with a
      "requires Cubism 5 SDK for Web R5 / Core 6.x (MocVersion_53)" message.
- [ ] `--from <real core>` copies the file; the app serves it at
      `/core/live2dcubismcore.min.js` (check with the app running and
      `curl.exe -s -o NUL -w "%{http_code}" <base>/core/live2dcubismcore.min.js`,
      expect 200).
- [ ] No Core file is present in the repository or `git status`.

## 3. setup-model.mjs

Use a fixture directory with `MyModel/MyModel.model3.json`, a `.moc3`, a
texture and optional motions/expressions.

- [ ] `node scripts/setup-model.mjs --help` exits 0 and documents `--from`,
      `--id`, `--entry`, `--sample hiyori`, `--from-sample-dir`, `--force`.
- [ ] `--from <fixture>` installs to `<runtime>/models/<id>`, prints file count,
      expression/motion/texture counts, and exits 0.
- [ ] Re-running the same install exits 1 with an "already exists" message;
      `--force` replaces it and exits 0.
- [ ] `--id custom.id` installs under that id; an invalid id exits 1 with a
      clear message.
- [ ] A directory with no top-level `.model3.json` exits 1 and suggests the
      nested directory.
- [ ] A model with `..` or an absolute path in `FileReferences` exits 1 with a
      path validation error; nothing is copied.
- [ ] A directory with two `.model3.json` files exits 1 and mentions
      `--entry`; `--entry <file>` succeeds.
- [ ] Model folder containing a symbolic link is rejected with a clear error.
- [ ] `--sample hiyori` with no local sample exits 1 and prints the
      CubismWebSamples URL, Sample Model Terms and Free Material License links;
      it does not download anything.
- [ ] With `models/hiyori` already present, `--sample hiyori` exits 0 and
      reports it ready.
- [ ] `--sample hiyori --from-sample-dir <CubismWebSamples>` copies Hiyori and
      exits 0.
- [ ] `git status` shows no model files in the repository.

## 3.1 setup-models.mjs

- [ ] `npm run setup:models -- --list` exits 0, prints every catalog id,
      display name, variant and installed state.
- [ ] `npm run setup:models -- --models hiyori-free` installs only that model;
      the other catalog models are untouched.
- [ ] `npm run setup:models -- --model hiyori` installs only `hiyori` and
      writes `model: "hiyori"` to the runtime `config.json`.
- [ ] `--no-default` installs without changing `config.json`.
- [ ] An unknown id in `--models` exits 1 and lists the available ids.
- [ ] A missing catalog file exits 1 with a hint to create
      `live2d.models.json` or set `models.file`.
- [ ] Re-running without `--force` reports "already installed"; `--force`
      reinstalls.

## 4. install-skill.mjs

- [ ] `node scripts/install-skill.mjs --help` exits 0.
- [ ] Missing `--dest` exits 2 with an example.
- [ ] `--dest <temp>/skills` exits 0 (after `npm run build`), creates:
  - `<runtime>/install.json` with `appRoot`, `electron`, `packaged: false`,
    `version`, `installedAt`;
  - `<runtime>/bin/live2d.cmd`, `live2d-mcp.cmd` (CRLF, Electron-as-Node with
    node fallback) and POSIX `live2d`, `live2d-mcp`;
  - `<temp>/skills/live2d-pet/` with `SKILL.md` and `references/`.
- [ ] Re-running without `--force` exits 1; with `--force` succeeds.
- [ ] The printed MCP block (one config for Claude Desktop/Cursor), the Claude
      Code command and the direct-node fallback reference the generated
      `live2d-mcp.cmd` / real app root; the JSON block parses.
- [ ] Printed skill destinations include `<dest>/live2d-pet` and the user-level
      Claude Code path.
- [ ] `"<runtime>\bin\live2d.cmd" version` runs and prints JSON with `--json`.
- [ ] `node "<temp>/skills/live2d-pet/scripts/live2d.mjs" version` also works
      after `npm run build`.

## 5. Skill documentation

- [ ] `SKILL.md` starts with YAML frontmatter; parse it (for example with a
      small `node -e` script) and confirm:
  - `name: live2d-pet`
  - description mentions Live2D, desktop pet, expressions, motions, speech and
    screenshots.
- [ ] SKILL.md contains the stable launcher
      `%USERPROFILE%\.live2d-agent\bin\live2d.cmd` and the
      `node <skill>/scripts/live2d.mjs` fallback.
- [ ] Golden rules are present: status first, exact IDs from capabilities, no
      command spam, TTL for transient changes, reset at the end.
- [ ] Recipes, command table and error-recovery table are present and every
      referenced `references/*.md` exists.
- [ ] No invented command or flag appears in the skill: cross-check every
      command against `dist/cli.mjs --help` and `live2d <command> --help`.

## 6. App launch

- [ ] `npm start` opens a transparent, always-on-top pet window and a tray icon;
      no console errors.
- [ ] `<runtime>/runtime.json` exists, mode is user-only where supported, and
      `logs/app.log` contains boot/runtime-ready lines.
- [ ] `GET /health` returns `ok: true` with the loaded model and `pageReady:
      true`.
- [ ] Missing Core (move `core/` away, restart) shows the setup overlay/message
      instead of a crash; restore the file and restart.
- [ ] Missing model (empty `models/`) shows the "no model" overlay/message; run
      `npm run setup:model` and `live2d model load <id>`.
- [ ] Second launch focuses the existing instance (single-instance lock).
- [ ] Tray menu: show/hide, always-on-top, click-through, reset, open models/logs,
      quit all work.
- [ ] Closing the window hides it but keeps the tray app running; tray Quit exits
      and removes `runtime.json`.

## 7. CLI matrix

With the app running (use the stable launcher or `node dist/cli.mjs`):

- [ ] `version` and `version --json` show CLI/protocol/runtime info.
- [ ] `ensure` and `ensure --json` report a ready model and exit 0.
- [ ] `status` / `status --json` include health, runtime and full state.
- [ ] `caps --json` includes expressions, motions, parameters, groups, features
      and coreVersion.
- [ ] `expressions --json` and `motions --json` match the model.
- [ ] `expression <name>` and `expression <index>` apply; an unknown name exits
      4 with `UNKNOWN_EXPRESSION`.
- [ ] `motion <group> --index 0` plays; `--wait` blocks until finished;
      `--priority idle|normal|force` is accepted; unknown group exits 4.
- [ ] `param <id> <value> --ttl 1000` sets and releases; `params --json`
      reflects the override; unknown id exits 4.
- [ ] `look 0.5 -0.2 --ttl 1000` works; out-of-range value exits 5.
- [ ] `say "hello" --ttl 1500` returns immediately, shows the bubble, then
      hides it after 1.5 s; `--tts` speaks when voices exist; `--audio <wav>`
      plays; invalid audio exits 4.
- [ ] `voices --json` lists voices or an empty array.
- [ ] `screenshot --out <path>` creates a non-empty PNG with the reported
      dimensions; JSON includes the path.
- [ ] `model list --json` lists installed models; `model load <id>` switches and
      persists; a bad id exits 4.
- [ ] `window --x 100 --y 100 --visible` moves/shows; `--hidden` hides;
      `--always-on-top`/`--no-always-on-top` and `--click-through`/
      `--no-click-through` toggle those flags; no options exits 5.
- [ ] `reset` clears expressions/overrides/bubble and exits 0.
- [ ] `logs --lines 20` prints the log tail.
- [ ] `stop` stops the app; `stop` again exits 0 with `alreadyStopped`.
- [ ] After stopping: `status --no-start` exits 2; `ensure` auto-starts the app.
- [ ] `--json` failures print `{ ok: false, error }` on stdout and diagnostics
      on stderr; exit codes match 0/2/3/4/5/6.

## 8. HTTP API and security

Read the runtime values in PowerShell:

```powershell
$rt = Get-Content "$env:LIVE2D_AGENT_HOME\runtime.json" -Raw | ConvertFrom-Json
$base = $rt.baseUrl
$token = $rt.token
```

- [ ] `Invoke-RestMethod "$base/health"` succeeds without a token.
- [ ] `curl.exe -s -o NUL -w "%{http_code}" "$base/api/v1/state"` returns 401.
- [ ] With `-H "Authorization: Bearer $token"`, `/api/v1/state` and
      `/api/v1/capabilities` return 200 JSON.
- [ ] `curl.exe -s -o NUL -w "%{http_code}" -H "Origin: http://evil.example" "$base/health"`
      returns 403.
- [ ] `curl.exe -s -o NUL -w "%{http_code}" -H "Host: evil.example" "$base/health"`
      returns 403.
- [ ] Path traversal on models, e.g.
      `curl.exe -s -o NUL -w "%{http_code}" "$base/models/hiyori/..%2f..%2fconfig.json"`
      returns 400 (never the file).
- [ ] `GET /audio/not-a-uuid` returns 404.
- [ ] Audio upload rejects non-audio content and files >10 MB (400/413-style
      error code `AUDIO_UNSUPPORTED`/`AUDIO_TOO_LARGE`).
- [ ] A hidden window screenshot via CLI returns exit 4 `WINDOW_HIDDEN`; show
      the window and retry.
- [ ] No token appears in `logs/app.log` (search the token string).
- [ ] After quitting the app, `runtime.json` is removed/ignored and the CLI exits
      2 with `--no-start`.

## 9. MCP server

- [ ] `node dist/mcp.mjs` starts and prints a "ready" line on stderr, then waits
      on stdin (Ctrl+C to stop).
- [ ] Configure the server in a client (or MCP Inspector) using the printed
      snippet; restart the client.
- [ ] Tool list contains `live2d_status`, `live2d_capabilities`,
      `live2d_expression`, `live2d_motion`, `live2d_say`, `live2d_params`,
      `live2d_model`, `live2d_screenshot`, `live2d_reset`, `live2d_window`.
- [ ] `live2d_status` auto-starts the app and returns model/page info.
- [ ] `live2d_expression` with an invalid name returns `isError: true` and an
      `UNKNOWN_EXPRESSION` error payload.
- [ ] `live2d_screenshot` returns an image content block plus the saved path.
- [ ] No tool call leaves the pet in a changed state after `live2d_reset`.

## 10. Agent skill end-to-end

- [ ] Install the skill into a real skills directory and restart the agent.
- [ ] Ask the agent to "greet me with the Live2D pet". It should:
  run `ensure`, read `caps`, use exact IDs, apply one expression/motion, speak
  once, and reset at the end.
- [ ] Ask for a screenshot; the agent calls `screenshot --out` (or MCP) and
      reports the path.
- [ ] Ask to remove a transient change; the agent uses `reset` instead of
      spamming commands.
- [ ] Stop the app and repeat: the launcher auto-starts it.

## 11. Windows-specific checks

- [ ] With `ELECTRON_RUN_AS_NODE=1` set in the shell, `live2d.cmd ensure` starts
      the GUI correctly (the app clears the variable for the GUI child; the
      launcher only sets it for the CLI process).
- [ ] Paths with spaces in `LIVE2D_AGENT_HOME` work through all launchers.
- [ ] The generated `.cmd` files work from `cmd.exe` and PowerShell.
- [ ] The tray icon renders and the window can be dragged by the model area.
- [ ] Click-through can be disabled from the tray after CLI enables it.

## 12. Cleanup

- [ ] `live2d stop`.
- [ ] Confirm no Electron process remains.
- [ ] Remove test data (`$env:LIVE2D_AGENT_HOME`) and any temp skills dir.
- [ ] Confirm `git status` is clean of generated/runtime files; only intended
      documentation/script changes are present.

## Acceptance summary

Packaging/doc work is accepted when:

1. All three scripts run with `--help` and with their documented flags.
2. Core and models are never bundled; license guidance is printed and accurate.
3. `install-skill` creates `install.json`, stable launchers and a complete skill
   copy, and prints working MCP snippets.
4. SKILL.md has valid frontmatter and only documents commands/flags that exist.
5. README instructions work from a clean `npm ci` checkout with user-provided
   Core and model.
6. No source, `package.json` or build scripts were modified by the docs task.
