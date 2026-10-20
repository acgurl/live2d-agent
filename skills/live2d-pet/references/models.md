# Models and model configuration

The desktop app renders Live2D Cubism 5 models with PixiJS and
`easy-live2d`. Models are **never bundled** with this repository: each user
installs models they are allowed to use. The official Hiyori sample is provided
by Live2D under its own terms; commercial or fan-made models have their own
licenses.

## Where models live

```
%USERPROFILE%\.live2d-agent\models\<model-id>\
    <any-name>.model3.json      <- required, at the top level
    <any-name>.moc3            <- referenced by FileReferences.Moc
    <textures>                 <- referenced by FileReferences.Textures
    ...
```

- Override the runtime root with `LIVE2D_AGENT_HOME`; then models live under
  `$LIVE2D_AGENT_HOME/models`.
- The app discovers every direct child directory of `models/` that has a
  top-level `*.model3.json`; hidden directories (leading dot) and temp
  directories are ignored.
- Model ids must match `[A-Za-z0-9._-]+` (max 128 characters) and cannot be
  `.` or `..`.

## Minimum requirements

The app validates a model before listing or loading it
(`src/main/models.ts`). A model is rejected when any of these fail:

1. A `.model3.json` file exists directly in the model directory.
2. The JSON parses and has a `FileReferences` object.
3. `FileReferences.Moc` is a non-empty relative path to an existing file
   (normally a `.moc3`).
4. `FileReferences.Textures` is a non-empty array of relative paths to existing
   files.
5. Optional references (`Physics`, `Pose`, `UserData`, `DisplayInfo`,
   `Expressions[].File`, `Motions.<group>[].File`) point to existing files.
6. No reference is absolute, contains `://`, or contains a `..` path segment;
   every reference must resolve (including through symlinks) inside the model
   directory.

At runtime the app only serves these file extensions from a model directory:
`.json`, `.moc3`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.wav`, `.mp3`,
`.ogg`. Anything else is not exposed to the renderer.

Minimal `<id>.model3.json`:

```json
{
  "Version": 3,
  "FileReferences": {
    "Moc": "model.moc3",
    "Textures": ["textures/texture_00.png"],
    "Physics": "model.physics3.json",
    "Pose": "model.pose3.json",
    "Expressions": [
      { "Name": "happy", "File": "expressions/happy.exp3.json" }
    ],
    "Motions": {
      "Idle": [
        { "File": "motions/idle.motion3.json" },
        { "File": "motions/tap.motion3.json" }
      ]
    }
  }
}
```

The exact expression names, motion groups, indices and parameter IDs come from
this file and the `.moc3`; the app reports them through `live2d caps --json`.
Never invent IDs.

## Declaring models in the repository

The repository keeps installation defaults in two editable files. They are read
only by the setup scripts; the running app does not read them.

- `live2d.config.json` — Core settings, the catalog path, the default model id
  and the list of models to install.
- `live2d.models.json` — a map of model id to model definition. One file can
  define any number of models.

`live2d.models.json`:

```json
{
  "version": 1,
  "models": {
    "hiyori": {
      "displayName": "Hiyori",
      "url": "https://example.com/hiyori.zip",
      "variant": "hiyori_pro",
      "scale": 1.2
    },
    "hiyori-free": {
      "displayName": "Hiyori (Free)",
      "url": "https://example.com/hiyori.zip",
      "variant": "hiyori_free",
      "scale": 1.2
    }
  }
}
```

`live2d.config.json` selects from that catalog:

```json
{
  "version": 1,
  "core": { "url": "https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js", "acceptLicense": true },
  "models": {
    "file": "live2d.models.json",
    "default": "hiyori",
    "install": ["hiyori", "hiyori-free"]
  },
  "setup": { "skillDest": "~/.live2d-agent/skills" }
}
```

| Catalog field | Required | Meaning |
| --- | --- | --- |
| `displayName` | no | Name shown by `model list`; defaults to the id. |
| `url` | no | Model zip URL. May be omitted only when the model is already installed. |
| `variant` | no | Directory prefix inside the zip (for example `hiyori_pro`). |
| `scale` | no | Display scale, 0.1..4. |
| `sha256`, `size` | no | Download integrity checks. |
| `offsetX`, `offsetY` | no | Display offsets, -1..1. |
| `idleGroup` | no | Motion group used for idle behaviour. |
| `defaultExpression` | no | Expression applied on load/reset. |
| `bubbleAnchor` | no | `{ "x": 0..1, "y": 0..1 }` speech-bubble anchor. |
| `hitActions` | no | Tap/hit reactions (same shape as `live2d-agent.json`). |

Behavior:

- `npm run setup` installs `models.install` (and adds `models.default` if it is
  missing from that list), writes each entry's display fields to
  `models/<id>/live2d-agent.json`, then writes `models.default` to the runtime
  `config.json`. A later `model load <id>` persists the user's choice; running
  setup again restores `models.default`.
- Multiple catalog entries may share one `url`; the zip is downloaded once and
  each `variant` is installed separately.
- `npm run setup -- --model <id>` installs only that model and makes it the
  default. `npm run setup -- --models a,b` installs exactly those.
- `npm run setup:models` installs catalog models without rebuilding, and
  `npm run setup:models -- --list` prints the catalog and installed state.
- A legacy single inline `model` object in `live2d.config.json` is still accepted
  by setup, but new projects should use `live2d.models.json`.

## Installing a model

Two installation paths are available: catalog download (above), or a model
directory you already own:

```bat
npm run setup:model -- --from "D:\Live2D\MyModel"
npm run setup:model -- --from "D:\Live2D\MyModel" --id my-model
npm run setup:model -- --from "D:\Live2D\MyModel" --force
```

Options:

| Option | Meaning |
| --- | --- |
| `--from <dir\|file>` | Model directory, or its `.model3.json` file. |
| `--id <id>` | Target id; default is the source directory name normalized to `[A-Za-z0-9._-]`. |
| `--entry <file>` | Choose one `.model3.json` when a directory has several. |
| `--sample hiyori` | Guide-only sample setup. Never downloads or bundles. If `models/hiyori` exists it reports it ready. |
| `--from-sample-dir <dir>` | Local CubismWebSamples checkout or resources directory used with `--sample` (also `LIVE2D_SAMPLES_DIR`). |
| `--force` | Replace an existing model with the same id. |

The script validates the source, copies it into a temporary directory, validates
the copy, then atomically renames it to `models/<id>`. It refuses symbolic links
inside the model folder (copy the real files first). It never fetches models from
the network.

### Hiyori sample

```bat
npm run setup:model -- --sample hiyori
```

This prints the official source and license links and tells the user where to
put the model. If the repo already has Hiyori under `models/hiyori`, it reports
it ready. To copy from an existing local checkout:

```bat
npm run setup:model -- --sample hiyori --from-sample-dir "D:\CubismWebSamples"
```

Official sample source: <https://github.com/Live2D/CubismWebSamples>
(`Samples/Resources/Hiyori`).

## Optional per-model settings: `live2d-agent.json`

Place a `live2d-agent.json` next to the `.model3.json` to tune how a model is
displayed and how tap/hit areas react. All fields are optional and validated by
`modelConfigSchema` in `src/shared/config.ts`.

```json
{
  "displayName": "Hiyori",
  "scale": 1.1,
  "offsetX": 0.0,
  "offsetY": -0.05,
  "idleGroup": "Idle",
  "defaultExpression": "neutral",
  "bubbleAnchor": { "x": 0.5, "y": 0.1 },
  "hitActions": {
    "Head": {
      "motion": { "group": "TapHead", "index": 0 },
      "expression": "happy",
      "say": "Hey! That tickles."
    },
    "Body": {
      "motion": { "group": "TapBody", "index": 1 }
    }
  }
}
```

| Field | Type / range | Effect |
| --- | --- | --- |
| `displayName` | string, max 128 | Name shown by `model list`. |
| `scale` | 0.1..4 | Model display scale. |
| `offsetX`, `offsetY` | -1..1 | Display offset (normalized). |
| `idleGroup` | string | Motion group used for idle behaviour. |
| `defaultExpression` | string | Expression applied on load/reset. |
| `bubbleAnchor` | `{ x: 0..1, y: 0..1 }` | Speech bubble anchor. |
| `hitActions` | record of hit-area name to action | Tap/hit reaction. |
| `hitActions.*.motion` | `{ group, index? }` | Motion to play. |
| `hitActions.*.expression` | string | Expression to apply. |
| `hitActions.*.say` | string, max 280 | Bubble line. |

Hit-area names come from the model's `HitAreas` group (see
`capabilities.groups.hitAreas`). The renderer also has a default `TapBody`
fallback when no configured action matches.

## Capabilities

`live2d caps --json` returns:

- `expressions`: names and zero-based indices.
- `motions`: every motion as `{ group, index, name, loop }`.
- `parameters`: every parameter the model exposes as `{ id, min, max }`.
- `groups`: `lipSync`, `eyeBlink`, `hitAreas` parameter/hit group names.
- `features`: which features this model/renderer supports (TTS, audio lip-sync,
  screenshot, multi-model, gaze, click-through, expressions, motions,
  parameters).
- `coreVersion`: reported by Cubism Core.

Use these exact values. Expression names are case-sensitive when passed by name.

## Multiple models and persistence

```bat
live2d model list --json
live2d model load <id>
```

- Only installed model directories appear in `model list`; a model declared in
  `live2d.models.json` but absent from `models.install` is not installed.
- Use `npm run setup:models -- --list` to compare the catalog with installed
  models, and `npm run setup:models -- --models <id>` to add one without a full
  rebuild.
- The active model id is stored in `config.json`; the app restores it on the
  next launch.
- If the configured model is missing, the app chooses another installed model
  and updates the config.
- Loading a model stops current motions/expressions and resets overrides.
- `model load` returns `MODEL_MISSING`, `MODEL_INVALID`, `MODEL_LOAD_FAILED` or
  `UNSUPPORTED_MODEL` on failure; inspect the app log with `live2d logs`.

## Licensing and repository hygiene

- Models and samples are **not** part of this repository. `.gitignore` excludes
  `models/` and `vendor/`; the runtime directory is outside the repo.
- Do not commit models, textures, motion files or Cubism Core.
- The official sample models are covered by the Live2D Sample Model Terms:
  <https://www.live2d.com/eula/live2d-sample-model-terms_en.html>
  and the Free Material License:
  <https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html>.
- Cubism Core itself is Live2D proprietary software; see the project's
  `THIRD_PARTY_LICENSES.md`.
- When installing a third-party model, keep its license/credit file in the
  model directory and make sure the model's terms allow desktop use,
  modification and screenshots.
