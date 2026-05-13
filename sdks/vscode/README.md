<!-- #141：本批仅协同升号，禁止回写 1.14.x -->
# OpenCode IDE Bridge

<!-- #97：品牌升级为 IDE Bridge，与 package displayName 对齐 -->
<!-- #141：vsix 与 opencode 主版本同号协同升号 -->
Local HTTP bridge extension for [OpenCode](https://opencode.ai) IDE. Connects the OpenCode CLI daemon to VS Code's notebook, Jupyter kernel, and editor context APIs so the CLI can inspect and drive notebooks without remote LM tool proxies.

Extension ID: `SMARK2022.opencode-ide-bridge`

## Prerequisites

<!-- #97：CLI 与扩展版本需匹配，否则 registry 心跳协议可能不兼容 -->
This extension requires the [OpenCode CLI](https://opencode.ai) to be installed on your system. It starts a local bridge server on VS Code activation; the OpenCode CLI uses that bridge to read editor context and run notebook operations.

## What This Extension Does

| Capability | Description |
|------------|-------------|
| **Bridge Server** | Starts an HTTP server on `127.0.0.1:<random port>` on VS Code startup with Bearer-token authentication for all tool endpoints (except `/health`). |
| **Notebook Operations** | Exposes summary, source, run, edit, output, and env endpoints. The OpenCode CLI calls these to inspect and modify notebooks. |
| **Jupyter Kernel Management** | `/notebook/env` supports `info`, `configure`, `restart`, and `save`. |
| **Bridge Registry** | Writes a heartbeat manifest under the OpenCode IDE registry directory for CLI discovery. |
| **Terminal Integration** | Commands and keybindings to launch or focus an OpenCode terminal session. |
| **File Reference Insertion** | Sends `@relative/path#Lx-Ly` references into the OpenCode terminal. |
| **Context Sharing** | Publishes active text editor and notebook URIs in the bridge registry manifest. |

## Commands

<!-- #97：命令 title 必须与 package.json contributes.commands 一致 -->
| Command ID | Title | Keybinding | Description |
|------------|-------|------------|-------------|
| `opencode.openTerminal` | Open or Focus OpenCode Terminal | `Ctrl+Esc` | Focus existing OpenCode terminal, or create one in a split view. |
| `opencode.openNewTerminal` | Open New OpenCode Terminal | `Ctrl+Shift+Esc` | Always start a new OpenCode terminal session. |
| `opencode.addFilepathToTerminal` | Insert File Reference into OpenCode | `Ctrl+Alt+K` | Insert `@file#Lx-Ly` for the active editor selection. |
| `opencode.showBridgeLog` | Show OpenCode Bridge Log | — | Open the extension output channel. |
| `opencode.notebookBridgeTools` | OpenCode: Test Notebook Bridge Tools | — | Palette tool for manual notebook bridge operations. |

On macOS, replace `Ctrl` with `Cmd` and `Alt` with `Option`.

## HTTP Endpoints

<!-- #97：HTTP 面是 CLI 契约；路径变更必须同步插件与文档 -->
<!-- #97：cell-output 为 output 兼容别名，须与 bridge 路由一致 -->
The bridge server exposes these endpoints on `http://127.0.0.1:<port>`:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | none | Liveness check |
| `GET` | `/manifest` | Bearer | Bridge capability/manifest snapshot |
| `POST` | `/notebook/summary` | Bearer | Notebook structure, cells, execution state |
| `POST` | `/notebook/source` | Bearer | Virtual source document with pagination |
| `POST` | `/notebook/run` | Bearer | Run one cell or a cell-id range |
| `POST` | `/notebook/edit` | Bearer | Insert, delete, or replace cells |
| `POST` | `/notebook/output` | Bearer | Artifact-first cell output export |
| `POST` | `/notebook/cell-output` | Bearer | Alias of `/notebook/output` (compat) |
| `POST` | `/notebook/env` | Bearer | Environment ops: info / configure / restart / save |

## Architecture

<!-- #97：架构说明帮助排障，不改变运行时绑定 -->
```
VS Code Extension Host
  └─ bridge HTTP (127.0.0.1)
       ├─ notebook/* handlers
       ├─ registry heartbeat writer
       └─ terminal / file-reference commands
OpenCode CLI / daemon
  └─ polls registry, calls Bearer-protected endpoints
```

## Security Model

<!-- #97：安全模型仍限 127.0.0.1 + Bearer，品牌改名不改威胁模型 -->
- Listen only on `127.0.0.1`.
- `/health` is unauthenticated; all notebook endpoints require `Authorization: Bearer <token>`.
- Requests with an `Origin` header are rejected to block browser cross-site access.
- Bridge token is not printed to the VS Code output log.
- Registry file is local-only (permissions typically `0o600` where applicable).

## Local VSIX Install

<!-- #97：安装路径与 package.scripts.vsix 的 dist 输出对齐 -->
Build and package from `sdks/vscode`:

```powershell
bun run check-types
bun run lint
bun run package
bun run vsix
```

Install the generated package (path matches `scripts.vsix` output):

```powershell
code --install-extension .\dist\SMARK2022.opencode-ide-bridge-1.19.9.vsix --force
```

## Development

<!-- #97：F5 开发宿主与正式 VSIX 安装路径不同，勿混用诊断步骤 -->
1. Open `sdks/vscode` directly in VS Code.
2. Run `bun install` inside `sdks/vscode`.
3. Press `F5` to launch an extension development host.
4. Use `Developer: Reload Window` after rebuilding.

## Open Source

<!-- #97：homepage 指向 anomalyco/opencode，与 package.json homepage 字段一致 -->
Maintained on the SMARK fork of OpenCode. Homepage: https://github.com/anomalyco/opencode
