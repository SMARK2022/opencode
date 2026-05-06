<!-- #96 VSIX打包：可复现手册；注释均域匹配且互不重复 -->
# OpenCode IDE Bridge — VSIX Packaging Guide

## Overview
<!-- 「Overview」：engines.vscode 过新会导致旧 IDE 拒绝安装 -->

Extension ID: `SMARK2022.opencode-ide-bridge`

This VS Code extension provides an HTTP bridge server that connects the OpenCode CLI daemon to VS Code's notebook and workspace APIs. It runs on `127.0.0.1:<random port>` and requires Bearer token authentication for all tool endpoints except `/health`.

## Prerequisites
<!-- 「Prerequisites」：打包前 typecheck/package 再 vsce -->

- Node.js >= 20.x
- Bun >= 1.3.0 (at `C:\Users\Lenovo\.bun\bin\bun.exe` on Windows, or on `PATH` for other platforms)
- VS Code CLI (`code`) on PATH
- Dependencies installed: `bun install` from `sdks/vscode/`

## Extension Metadata
<!-- 「Extension Metadata」：publisher 与扩展 ID 前缀必须一致 -->

| Field | Value |
|-------|-------|
| `name` | `opencode-ide-bridge` |
| `displayName` | `OpenCode IDE Bridge` |
| `publisher` | `SMARK2022` |
| `version` | `1.14.31` |
| `engines.vscode` | `^1.94.0` |
| `main` | `./dist/extension.js` |
| `license` | `MIT` |
| `categories` | `Other` |
| `homepage` | `https://github.com/anomalyco/opencode` |

## Build & Package
<!-- 「Build & Package」：vsce 输出路径必须等于 install-extension 实参；推荐 dist/ 并 gitignore -->

All commands run from `sdks/vscode/`.

### 1. Type Check
<!-- 「1. Type Check」：.vscodeignore 排除 test/fixtures -->

```powershell
# powershell：仅 Windows 主机
bun run check-types
```

### 2. Lint
<!-- 「2. Lint」：打包前 lint/typecheck 失败不得继续 vsce -->

```powershell
bun run lint
```

### 3. Production Build (esbuild, minified, CJS, vscode external)
<!-- 「3. Production Build (esbuild, minified, CJS, vscode external)」：Show Running Extensions 确认激活 -->

```powershell
bun run package
```

This runs `check-types && lint && node esbuild.js --production`.

### 4. List VSIX Contents (preview)
<!-- 「4. List VSIX Contents (preview)」：预发布与正式版版本策略分离 -->

```powershell
npx @vscode/vsce ls
```

### 5. Package VSIX
<!-- 「5. Package VSIX」：生产 VSIX 默认不带 source map -->

```powershell
$env:PATH="C:\Users\Lenovo\.bun\bin;$env:PATH"
npx --yes --package @vscode/vsce -- vsce package -o "SMARK2022.opencode-ide-bridge-1.14.31.vsix"
```

The `vscode:prepublish` script runs `bun run package` automatically before `vsce package`.

### One-Command Shortcut
<!-- 「One-Command Shortcut」：贡献点变更后同步 README 命令表 -->

```powershell
bun run vsix
```

## VSIX Artifact Structure
<!-- 「VSIX Artifact Structure」：回滚：uninstall 后清缓存再装旧包 -->

```
SMARK2022.opencode-ide-bridge-1.14.31.vsix
├─ [Content_Types].xml
├─ extension.vsixmanifest
└─ extension/
   ├─ LICENSE.txt
   ├─ package.json
   ├─ readme.md
   ├─ dist/
   │  └─ extension.js        (minified CJS bundle)
   └─ images/
      ├─ icon.png            (extension icon)
      ├─ button-dark.svg     (toolbar button, dark theme)
      └─ button-light.svg    (toolbar button, light theme)
```

### Excluded from VSIX (`.vscodeignore`)
<!-- 「Excluded from VSIX (`.vscodeignore`)」：激活后应出现 bridge output channel -->

- `.vscode/`, `.vscode-test/`, `out/`, `node_modules/`, `src/`, `script/`
- `.gitignore`, `.yarnrc`, `.env`, `.env.*`, `*.log`, `*.vsix`
- `bun.lock`, `esbuild.js`, `**/tsconfig.json`, `**/eslint.config.mjs`, `**/*.map`, `**/*.ts`

## Installation
<!-- 「Installation」：--force 覆盖同 ID 不迁移设置；安装后 Reload Window -->

### Local VSIX Install
<!-- 「Local VSIX Install」：scripts.vsix 的 dist 输出是安装契约 -->

```powershell
code --install-extension .\SMARK2022.opencode-ide-bridge-1.14.31.vsix --force
```

### From VS Code UI
<!-- 「From VS Code UI」：扩展 ID 与 publisher SMARK2022 绑定 -->

1. Open Extensions panel (`Ctrl+Shift+X`)
2. Click `...` → `Install from VSIX...`
3. Select the `.vsix` file

## Security Model
<!-- 「Security Model」：本地 VSIX 无 marketplace 签名流程；勿写入真实 token -->

| Check | Status |
|-------|--------|
| Listens only on `127.0.0.1` | Yes |
| `/health` unauthenticated | Yes |
| Notebook endpoints require `Bearer <token>` | Yes |
| Rejects `Origin` header (blocks browser CORS) | Yes |
| Token not printed to VS Code output log | Yes (redacted) |
| Registry file mode `0o600` | Yes |
| Registry directory mode `0o700` | Yes |

## Publishing
<!-- 「Publishing」：勿把 node_modules 打进 VSIX -->

### Marketplace (VS Code)
<!-- 「Marketplace (VS Code)」：打包机 Node major 与开发机对齐 -->

1. Create publisher at [https://marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
2. Create Azure DevOps PAT with `Marketplace: Manage` scope
3. Login and publish:

```powershell
npx @vscode/vsce login SMARK2022
npx @vscode/vsce publish
```

### Open VSX (optional, for VSCodium / Cursor / Gitpod)
<!-- 「Open VSX (optional, for VSCodium / Cursor / Gitpod)」：中文用户目录偶发兼容问题优先 ASCII 路径 -->

1. Create account at [https://open-vsx.org](https://open-vsx.org)
2. Sign Publisher Agreement, generate access token
3. Create namespace and publish:

```powershell
npx ovsx create-namespace SMARK2022 -p <OPENVSX_TOKEN>
npx ovsx publish .\SMARK2022.opencode-ide-bridge-1.14.31.vsix -p <OPENVSX_TOKEN>
```

## CLI Integration
<!-- 「CLI Integration」：源码归档/CLI 集成与 VSIX 安装路径策略不同，勿混用命令 -->

The OpenCode CLI auto-installs this extension via:

`packages/opencode/src/ide/index.ts:54`

```typescript
const p = await Process.run([cmd, "--install-extension", "SMARK2022.opencode-ide-bridge"], { ... })
```

Supported IDE commands: `code`, `code-insiders`, `windsurf`, `cursor`, `codium`.

## Source Files (Not Packaged)
<!-- 「Source Files (Not Packaged)」：在 sdks/vscode 执行打包，勿在 monorepo 根误跑 vsce -->

```
sdks/vscode/src/
├── extension.ts           Entry point, lifecycle, terminal commands
├── bridge.ts              HTTP server, routing, auth, file-locking
├── bridge-registry.ts     File-based bridge registry (heartbeat + manifest)
├── util.ts                Shared helpers (JSON, URI, text formatting)
└── notebook/
    ├── commands.ts        Interactive bridge testing command
    ├── edit.ts            Cell insert/edit/delete
    ├── env.ts             Kernel/environment operations (info/configure/restart/save)
    ├── format.ts          Summary text formatting
    ├── output.ts          Artifact-first cell output export
    ├── resolve.ts         File-path to notebook resolution
    ├── run.ts             Cell execution (single + range)
    ├── source.ts          Paginated virtual source text
    └── summary.ts         Notebook structure overview
```
