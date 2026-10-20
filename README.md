# Live2D Agent（Live2D 桌面伙伴）

把 Live2D 模型变成运行在 Windows 桌面上的透明小窗伙伴，并让它可被本地 CLI、MCP
服务器和 Agent Skill 控制。所有通信都只在本机回环地址上进行，不需要云端账号。

> 本仓库**不包含** Live2D Cubism Core，也**不包含任何 Live2D 模型**。默认安装脚本会按
> `live2d.config.json` 把 Core 和默认模型下载到用户目录（`~/.live2d-agent`），不写入
> 仓库。Core 是 Live2D 公司的专有软件，模型各有自己的许可；每位使用者需要遵守相应条款。

## 功能特性

- 透明、无边框、置顶的 Live2D 桌面窗口（Electron + PixiJS 8 + easy-live2d）
- 表情、动作（Motion）、参数、视线控制，支持 TTL 自动恢复
- 系统 TTS 语音 + 气泡字幕；可上传本地 `.wav` / `.mp3` / `.ogg` 音频并做口型
- 窗口移动/缩放、置顶、鼠标穿透、显示/隐藏
- 截图（只截取伙伴窗口，输出 PNG）
- 多模型管理：安装、列出、切换，记住上次使用的模型
- 托盘菜单：显示/隐藏、置顶、鼠标穿透、重置、打开模型/日志目录、退出
- 本地 HTTP 控制 API + CLI + MCP（stdio）服务器 + Agent Skill
- 运行时数据（Core、模型、配置、日志、截图、音频缓存）全部在
  `%USERPROFILE%\.live2d-agent\` 下，不写入仓库

## 环境要求

- **Windows 11**（当前主要支持与验证平台；macOS / Linux 未验证）
- **Node.js >= 22.12.0**（见 `package.json` 的 `engines`）
- npm（随 Node.js 安装）
- 可用的 GPU / WebGL 环境（Electron 使用系统图形栈渲染 Live2D）

## 最快开始（一行命令）

在仓库根目录执行：

```bat
npm run setup
```

这一条命令会：

1. 缺少依赖时自动执行 `npm install`（含 devDependencies，并补装 Electron 运行时）；
2. 按 `live2d.config.json` 从官方 CDN 下载 **Cubism Core 6.x（SDK R5）**；
3. 下载默认模型 zip，自动解压并选择 `hiyori_pro/runtime`，安装到
   `%USERPROFILE%\.live2d-agent\models\hiyori`；
4. 写入模型显示配置（`displayName`、`scale` 等）；
5. 构建 renderer/主进程/CLI/MCP/Skill 脚本；
6. 把 Skill 安装到 `setup.skillDest`（默认 `~/.live2d-agent/skills`）并生成稳定启动器；
7. 启动桌面伙伴（已启动时只做就绪检查）。

重复执行是幂等的：已安装且校验通过的 Core/模型会跳过。想强制重装或更新默认模型：

```bat
npm run setup -- --force
```

顺便把 Agent Skill 装到 Claude Code 用户目录：

```bat
npm run setup -- --skill-dest "%USERPROFILE%\.claude\skills"
```

## 默认安装配置（`live2d.config.json`，可修改）

默认 Core/模型地址、模型变体、缩放和安装行为都写在仓库根目录的
[live2d.config.json](live2d.config.json)，不需要改脚本。修改后重新执行
`npm run setup`；如果模型已存在，加上 `--force` 才会重新下载/安装。

> 仓库里需要你修改的安装配置只有 `live2d.config.json` 一个。
> `tsconfig.json` / `vite.config.ts` / `vitest.config.ts` 是构建工具配置；
> 运行后 `~/.live2d-agent/` 下的 `config.json`（窗口/模型偏好）、`install.json`、
> `runtime.json` 以及模型目录的 `live2d-agent.json`（可选显示微调）都是自动生成的
> 状态文件，不需要手改。

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `core.url` | `https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js` | 官方 Cubism Core 6.x CDN |
| `core.acceptLicense` | `true` | 运行 setup 即表示接受 Live2D Proprietary Software License；设为 `false` 时拒绝自动下载 |
| `model.url` | 项目指定的 Hiyori zip | 默认模型压缩包地址 |
| `model.id` | `hiyori` | 安装目录名，也是 `model load` 的 id |
| `model.displayName` | `Hiyori` | 模型列表显示名 |
| `model.variant` | `hiyori_pro` | zip 内变体；可改为 `hiyori_free` |
| `model.scale` | `1.2` | 默认显示缩放 |
| `setup.skillDest` | `~/.live2d-agent/skills` | 顺便安装 Skill 到该目录；`null` 跳过 |

可选字段（默认不写，需要时再加）：

- `core.sha256` / `model.sha256` / `model.size`：下载完整性校验；
- `setup.installDependencies` / `setup.build` / `setup.launch`：设为 `false` 可跳过对应步骤（默认均为 `true`）；
- `model.idleGroup` / `model.offsetX` / `model.offsetY`：模型动作组和位置微调。

常用覆盖参数（不必改文件）：

```bat
npm run setup -- --model-url "https://example.com/my-model.zip" --id my-model
npm run setup -- --variant hiyori_free
npm run setup -- --core-url "https://.../live2dcubismcore.min.js" --force
npm run setup -- --no-deps --no-build --no-launch
npm run setup -- --skill-dest "%USERPROFILE%\.claude\skills"
```

> 默认模型 URL 由项目维护者指定。对外分发/商用前请确认你有权使用和再分发该 URL
> 指向的模型；也可以把 `model.url` 改成你自己的模型压缩包（需包含 `.model3.json`）。

## 手动安装（高级/自定义）

### 1. 安装依赖

```bat
npm ci
```

### 2. 安装 Live2D Cubism Core（必须，仓库不附带）

从 [Cubism SDK for Web 下载页](https://www.live2d.com/en/sdk/download/web/)
获取 **Cubism 5 SDK for Web R5**（其中 Core 为 6.x，定义 `MocVersion_53`），
解压后找到 `Core/live2dcubismcore.min.js`：

```bat
npm run setup:core -- --from "D:\CubismSdkForWeb\Core\live2dcubismcore.min.js"
```

或在阅读并接受 [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)
后，让脚本从官方 CDN 下载 Cubism 5 R5 / Core 6.x：

```bat
npm run setup:core -- --download --accept-license
```

脚本使用的官方 CDN 为
`https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js`（链接可能变化，
失败时请改用 `--from`）。脚本会校验 Core 必须定义 `MocVersion_53`（Cubism 5 R5 / Core 6.x），拒绝 5.1.0
等旧版 Core，然后安装到 `%USERPROFILE%\.live2d-agent\core\live2dcubismcore.min.js`。
**请勿提交或再分发 Core 文件。**

### 3. 安装一个 Live2D 模型（必须，仓库不附带模型）

```bat
npm run setup:model -- --from "D:\Live2D\MyModel"
```

可选参数：`--id <模型id>`、`--entry <model3.json>`、`--force`。
模型目录根部必须有一个 `.model3.json`，所有引用必须是模型目录内的相对路径。
安装目标是 `%USERPROFILE%\.live2d-agent\models\<id>\`。

官方 Hiyori 示例模型同样不随仓库分发。可以先查看获取方式与许可链接：

```bat
npm run setup:model -- --sample hiyori
```

把 Hiyori 放到 `%USERPROFILE%\.live2d-agent\models\hiyori\`，或使用本地
CubismWebSamples 目录：

```bat
npm run setup:model -- --sample hiyori --from-sample-dir "D:\CubismWebSamples"
```

示例模型受 [Live2D Sample Model Terms](https://www.live2d.com/eula/live2d-sample-model-terms_en.html)
约束，请确认你的使用方式符合条款。

### 4. 构建

```bat
npm run build
```

构建产物：`dist/renderer/`（渲染页）、`dist/main.cjs`、`dist/preload.cjs`、
`dist/cli.mjs`、`dist/mcp.mjs`，以及供 Skill 回退使用的
`skills/live2d-pet/scripts/live2d.mjs` / `live2d-mcp.mjs`。

### 5. 启动桌面伙伴

```bat
npm start
```

开发模式（Vite 热更新 + Electron）：

```bat
npm run dev
```

启动后应出现透明置顶小窗和托盘图标。首次启动如果缺少 Core 或模型，窗口会提示
安装方法；日志在 `%USERPROFILE%\.live2d-agent\logs\app.log`。

## 一条命令接入 Agent

### 安装 Skill 和稳定启动器

```bat
npm run install:skill -- --dest "%USERPROFILE%\.claude\skills"
```

该命令会：

1. 把 `skills/live2d-pet/` 复制到 `<dest>\live2d-pet\`；
2. 写入 `%USERPROFILE%\.live2d-agent\install.json`（appRoot、Electron 路径、
   `packaged: false`、版本），供 CLI 自动启动 App；
3. 创建稳定启动器：
   - Windows：`%USERPROFILE%\.live2d-agent\bin\live2d.cmd` 和 `live2d-mcp.cmd`
   - POSIX：`~/.live2d-agent/bin/live2d` 和 `live2d-mcp`
   启动器优先用 Electron 的 Node 模式（`ELECTRON_RUN_AS_NODE=1`）运行，找不到
   Electron 时回退到 `node`；
4. 打印 Claude Desktop / Claude Code / Cursor 的 MCP 配置片段和 Skill 安装位置。

Skill 文档中的 `node <skill>/scripts/live2d.mjs` 回退需要先运行
`npm run build:skill`（`npm run build` 已包含）；稳定启动器则使用
`dist/cli.mjs`。修改客户端的 MCP 配置后重启客户端。Claude Code 也可以用：

```bat
claude mcp add live2d -- cmd /c "%USERPROFILE%\.live2d-agent\bin\live2d-mcp.cmd"
```

Claude Desktop / Cursor 的 JSON 配置示例（路径按实际生成结果替换）：

```json
{
  "mcpServers": {
    "live2d": {
      "command": "cmd",
      "args": ["/c", "C:\\Users\\<你>\\.live2d-agent\\bin\\live2d-mcp.cmd"]
    }
  }
}
```

### Agent 侧的稳定入口

Skill 文档要求 Agent 优先使用：

```bat
"%USERPROFILE%\.live2d-agent\bin\live2d.cmd" <command>
```

如果启动器不存在，可回退到：

```bat
node "%USERPROFILE%\.claude\skills\live2d-pet\scripts\live2d.mjs" <command>
```

CLI 会自动启动 App（`--no-start` 可禁用），从 `runtime.json` 读取本地 token，
所以 Agent 不需要也不应该接触 token。

## CLI 示例

```bat
set LIVE2D="%USERPROFILE%\.live2d-agent\bin\live2d.cmd"

%LIVE2D% ensure
%LIVE2D% status --json
%LIVE2D% caps --json
%LIVE2D% expressions --json
%LIVE2D% motions --json

%LIVE2D% expression happy --ttl 5000
%LIVE2D% motion TapBody --index 0
%LIVE2D% param ParamAngleX 20 --ttl 4000
%LIVE2D% look 0.5 -0.2 --ttl 3000
%LIVE2D% say "你好！" --tts --ttl 6000
%LIVE2D% screenshot --out "C:\Users\me\Pictures\pet.png"

%LIVE2D% model list
%LIVE2D% model load hiyori
%LIVE2D% window --x 1200 --y 400
%LIVE2D% window --always-on-top
%LIVE2D% reset
%LIVE2D% stop
```

常用命令一览：

| 命令 | 作用 |
| --- | --- |
| `ensure` / `status` | 启动并等待/查看 App、模型与窗口状态 |
| `caps` / `expressions` / `motions` / `params` | 读取模型能力、表情、动作与参数 |
| `expression` / `motion` / `param` / `look` | 应用表情、播放动作、设置参数、设置视线（均支持 `--ttl`） |
| `say` | 气泡、TTS 或本地音频 |
| `model list` / `model load <id>` | 列出/切换模型 |
| `window` / `screenshot` / `reset` | 窗口控制、截图、重置 |
| `voices` | 列出系统 TTS 语音 |
| `logs --lines <n>` | 查看 App 日志 |
| `stop` / `version` | 退出 App / 查看版本 |

全局参数：`--json`、`--timeout <ms>`、`--url`、`--token`、`--no-start`。
退出码：`0` 成功、`2` App 未运行、`3` 超时、`4` 能力/模型错误、
`5` 参数错误、`6` 内部/鉴权错误。完整说明见
[docs/protocol.md](docs/protocol.md) 和
[skills/live2d-pet/references/commands.md](skills/live2d-pet/references/commands.md)。

## 本地安全

- HTTP 服务只监听 `127.0.0.1`，默认端口 47100（被占用时向后尝试 10 个端口）。
- 每次启动生成随机 32 字节 token，写入 `runtime.json`（尽量使用 0600 权限），
  退出时删除；API 请求需要 `Authorization: Bearer <token>`。
- 校验 `Host` / `Origin`，拒绝跨站请求；请求体有大小限制和速率限制。
- 静态资源只从固定的渲染目录、Core 文件、模型目录和音频缓存提供；模型路径做了
  目录穿越与符号链接校验，模型引用只允许相对路径。
- 渲染进程启用 `contextIsolation`、`sandbox`，关闭 `nodeIntegration`，禁止导航、
  弹窗和权限请求。
- 没有遥测、没有远程 API；Core、模型、配置、日志都只在本机。TTS 使用系统语音。
- 不要把端口暴露到局域网/公网，也不要在共享电脑上使用；任何能读取
  `runtime.json` 的本地进程都能控制这个伙伴。

更多细节见 [docs/security.md](docs/security.md)。

## 目录结构

```
src/main/       Electron 主进程：窗口、托盘、HTTP 服务、IPC 桥、截图、模型/音频
src/preload/    安全的 contextBridge 预加载脚本
src/renderer/   PixiJS + easy-live2d 渲染、气泡、TTS、交互
src/cli/        live2d 命令行
src/mcp/        MCP stdio 服务器
src/shared/     协议、配置、路径、运行时文件、客户端、错误、日志
scripts/        setup-core / setup-model / install-skill 与构建脚本
skills/live2d-pet/  Agent Skill（SKILL.md + references）
docs/           架构、协议、安全、手工测试文档
```

## npm scripts

| 命令 | 作用 |
| --- | --- |
| `npm run setup` | **一行命令安装/更新并启动**（依赖、Core、默认模型、构建、启动） |
| `npm start` | 用 Electron 启动桌面伙伴 |
| `npm run dev` | Vite 开发服务器 + Electron |
| `npm run build` | 构建渲染页、主进程/预加载/CLI/MCP、Skill 脚本 |
| `npm run build:skill` | 单独构建 Skill 内的 `scripts/live2d.mjs` / `live2d-mcp.mjs` |
| `npm run setup:core` | 单独安装 Cubism Core（`--from` / `--download --accept-license`） |
| `npm run setup:model` | 安装模型（`--from` / `--sample hiyori`） |
| `npm run install:skill` | 安装 Skill、写 install.json、生成启动器、打印 MCP 配置 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | oxlint 静态检查 |

> 当前版本尚未配置 Electron 安装包分发（`electron-builder` 未加入依赖），
> 请使用源码方式运行。

## 已知限制

- 仅 Windows 11 经过验证；其他平台的窗口行为、托盘、TTS 可能不同。
- 仓库不附带 Core 和模型，首次使用必须按上面的步骤自行安装。
- TTS 依赖操作系统安装的语音；没有语音时请使用气泡或 `--audio`。
- MCP / Skill 的支持情况取决于具体 Agent 客户端；请以客户端文档为准。
- 没有自动更新、云同步或远程控制功能。

## 许可证

- 本项目源码使用 [MIT License](LICENSE)。
- **Live2D Cubism Core** 是 Live2D Inc. 的专有软件，**不在本仓库中**，也不受 MIT
  许可覆盖。使用者必须自行获取 Cubism 5 R5 / Core 6.x 并遵守
  [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)；
  再分发/商用还需遵守 Live2D 的 SDK 发布许可要求。
- **Live2D 模型/示例模型**（如 Hiyori）各有自己的许可，不在本仓库中。示例模型受
  [Live2D Sample Model Terms](https://www.live2d.com/eula/live2d-sample-model-terms_en.html)
  约束。
- 第三方依赖及其许可见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

## 文档

- [docs/architecture.md](docs/architecture.md) — 进程、模块与数据流
- [docs/protocol.md](docs/protocol.md) — HTTP API、IPC 与数据结构
- [docs/security.md](docs/security.md) — 安全模型与威胁边界
- [docs/manual-test.md](docs/manual-test.md) — 手工验收清单
- [skills/live2d-pet/references/troubleshooting.md](skills/live2d-pet/references/troubleshooting.md) — 常见问题
