# Third-party licenses

This project is MIT-licensed (see [LICENSE](LICENSE)). It depends on third-party
packages and interacts with Live2D proprietary software that is **not** part of
this repository. This file is a notice, not a replacement for the upstream
license texts; if there is any conflict, the upstream license governs.

The table below lists the runtime dependency tree from `package.json`
(`dependencies`) as installed in this checkout, including transitive packages.
The Node bundles in `dist/` (main, preload, CLI, MCP) are built with esbuild and
may include only a subset of these packages after tree-shaking and bundling.

## Runtime npm dependencies (bundled into dist)

| Package | Version | License |
| --- | --- | --- |
| `@hono/node-server` | 2.1.5 | MIT |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT |
| `@pixi/colord` | 2.9.6 | MIT |
| `@pixi/sound` | 6.0.1 | MIT |
| `@polka/url` | 1.0.0-next.29 | MIT |
| `@types/earcut` | 3.0.0 | MIT |
| `@webgpu/types` | 0.1.74 | BSD-3-Clause |
| `@xmldom/xmldom` | 0.8.15 | MIT |
| `accepts` | 2.0.0 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `body-parser` | 2.3.0 | MIT |
| `bytes` | 3.1.2 | MIT |
| `call-bind-apply-helpers` | 1.0.2 | MIT |
| `call-bound` | 1.0.4 | MIT |
| `commander` | 15.0.0 | MIT |
| `content-disposition` | 2.0.1 | MIT |
| `content-type` | 1.0.5 | MIT |
| `cookie` | 0.7.2 | MIT |
| `cookie-signature` | 1.2.2 | MIT |
| `cors` | 2.8.6 | MIT |
| `cross-spawn` | 7.0.6 | MIT |
| `debug` | 4.4.3 | MIT |
| `depd` | 2.0.0 | MIT |
| `dunder-proto` | 1.0.1 | MIT |
| `earcut` | 3.2.4 | ISC |
| `easy-live2d` | 1.0.0 | MIT |
| `ee-first` | 1.1.1 | MIT |
| `encodeurl` | 2.0.0 | MIT |
| `es-define-property` | 1.0.1 | MIT |
| `es-errors` | 1.3.0 | MIT |
| `es-object-atoms` | 1.1.2 | MIT |
| `escape-html` | 1.0.3 | MIT |
| `etag` | 1.8.1 | MIT |
| `eventemitter3` | 5.0.4 | MIT |
| `eventsource` | 3.0.7 | MIT |
| `eventsource-parser` | 3.1.1 | MIT |
| `express` | 5.3.0 | MIT |
| `express-rate-limit` | 8.7.1 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-uri` | 3.1.9 | BSD-3-Clause |
| `fflate` | 0.8.3 | MIT |
| `finalhandler` | 2.1.1 | MIT |
| `forwarded` | 0.2.0 | MIT |
| `fresh` | 2.0.0 | MIT |
| `function-bind` | 1.1.2 | MIT |
| `get-intrinsic` | 1.3.0 | MIT |
| `get-proto` | 1.0.1 | MIT |
| `gifuct-js` | 2.1.2 | MIT |
| `gopd` | 1.2.0 | MIT |
| `has-symbols` | 1.1.0 | MIT |
| `hasown` | 2.0.4 | MIT |
| `hono` | 4.13.13 | MIT |
| `http-errors` | 2.0.1 | MIT |
| `iconv-lite` | 0.7.3 | MIT |
| `inherits` | 2.0.4 | ISC |
| `ip-address` | 10.7.4 | MIT |
| `ipaddr.js` | 1.9.1 | MIT |
| `is-promise` | 4.0.0 | MIT |
| `isexe` | 2.0.0 | ISC |
| `ismobilejs` | 1.1.1 | MIT |
| `jose` | 6.2.13 | MIT |
| `js-binary-schema-parser` | 2.0.3 | MIT |
| `json-schema-traverse` | 1.0.0 | MIT |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause |
| `math-intrinsics` | 1.1.0 | MIT |
| `media-typer` | 1.1.1 | MIT |
| `merge-descriptors` | 2.0.0 | MIT |
| `mime-db` | 1.54.0 | MIT |
| `mime-types` | 3.0.2 | MIT |
| `mrmime` | 2.0.1 | MIT |
| `ms` | 2.1.3 | MIT |
| `negotiator` | 1.1.0 | MIT |
| `object-assign` | 4.1.1 | MIT |
| `object-inspect` | 1.13.4 | MIT |
| `on-finished` | 2.4.1 | MIT |
| `once` | 1.4.0 | ISC |
| `parse-svg-path` | 0.2.0 | MIT |
| `parseurl` | 1.3.3 | MIT |
| `path-key` | 3.1.1 | MIT |
| `path-to-regexp` | 8.4.2 | MIT |
| `pixi.js` | 8.22.0 | MIT |
| `pkce-challenge` | 5.0.1 | MIT |
| `proxy-addr` | 2.0.8 | MIT |
| `qs` | 6.16.1 | BSD-3-Clause |
| `range-parser` | 1.3.0 | MIT |
| `raw-body` | 3.0.2 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `router` | 2.2.0 | MIT |
| `safer-buffer` | 2.1.2 | MIT |
| `send` | 1.2.1 | MIT |
| `serve-static` | 2.2.1 | MIT |
| `setprototypeof` | 1.2.0 | ISC |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `side-channel` | 1.1.1 | MIT |
| `side-channel-list` | 1.0.1 | MIT |
| `side-channel-map` | 1.0.1 | MIT |
| `side-channel-weakmap` | 1.0.2 | MIT |
| `sirv` | 3.0.2 | MIT |
| `statuses` | 2.0.2 | MIT |
| `tiny-lru` | 11.4.7 | BSD-3-Clause |
| `toidentifier` | 1.0.1 | MIT |
| `totalist` | 3.0.1 | MIT |
| `type-is` | 2.1.0 | MIT |
| `unpipe` | 1.0.0 | MIT |
| `vary` | 1.1.2 | MIT |
| `which` | 2.0.2 | ISC |
| `wrappy` | 1.0.2 | ISC |
| `zod` | 4.6.7 | MIT |
| `zod-to-json-schema` | 3.25.2 | ISC |

## Development-only dependencies

These are used to build, typecheck or lint the project and are not part of the
runtime application.

| Package | Version | License |
| --- | --- | --- |
| `@types/node` | 26.6.5 | MIT |
| `electron` | 44.9.1 | MIT |
| `esbuild` | 0.28.2 | MIT |
| `oxlint` | 1.89.0 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vite` | 8.3.4 | MIT |
| `vitest` | 5.0.5 | MIT |

## Electron, Chromium and Node.js

- **Electron** is distributed under the MIT license. The Electron binary also
  contains Chromium and other third-party components under their own licenses.
  Full third-party notices are shipped inside the Electron distribution at
  `node_modules/electron/dist/LICENSES.chromium.html` and
  `node_modules/electron/dist/LICENSE`. Any packaged application must include
  those notices.
- **Chromium** is licensed primarily under a BSD-style license with additional
  third-party licenses; see the file above.
- **Node.js** is MIT-licensed; see the Node.js distribution for its bundled
  third-party notices.

## Live2D proprietary components (NOT included)

The following are **not** distributed with this repository and are not covered by
the MIT license. Each user must obtain them from Live2D Inc. under Live2D's
terms:

- **Live2D Cubism Core** (`live2dcubismcore.min.js` / `.js`) is proprietary
  software. Users must download a Cubism 5 SDK for Web R5 build (Core 6.x,
  `MocVersion_53`) from the official package and accept the
  [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)
  ([中文](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html)).
  Publishing content made with the Cubism SDK may additionally require Live2D's
  SDK Release License (publication license). Do not commit or redistribute the
  Core file.
- **Live2D models and sample models** (for example Hiyori) are provided by Live2D
  or third parties under their own terms. The official samples are covered by
  the [Live2D Sample Model Terms](https://www.live2d.com/eula/live2d-sample-model-terms_en.html)
  and the
  [Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html).
  Models are never bundled with this repository.

See [docs/security.md](docs/security.md) and
[skills/live2d-pet/references/models.md](skills/live2d-pet/references/models.md)
for the setup and licensing workflow.

## Other assets

- The tray icon is drawn from an inline data URL in
  `src/main/tray-icon.ts`; no third-party icon files are bundled.
- No fonts, music, voice samples or model textures are included.

## Full license texts

- Runtime package license files are available in each package directory under
  `node_modules/<package>/LICENSE` after `npm ci`.
- SPDX identifiers in the table are provided for convenience. For
  `UNKNOWN` entries, read the package's own `package.json`/`LICENSE`.
- When distributing binaries or a packaged app, include this file, `LICENSE`,
  the applicable upstream license texts, and the Electron/Chromium notices.

_Generated from the dependency tree of package.json version 0.1.0. If dependencies
change, update this file._
