# OpenCode IDE Bridge — VSIX Packaging Guide

## Overview

Extension ID: `SMARK2022.opencode-ide-bridge`

This VS Code extension provides an HTTP bridge server that connects the OpenCode CLI daemon to VS Code's notebook and workspace APIs. It runs on `127.0.0.1:<random port>` and requires Bearer token authentication for all tool endpoints except `/health`.

## Prerequisites

- Node.js >= 20.x
- Bun >= 1.3.0 (at `C:\Users\Lenovo\.bun\bin\bun.exe` on Windows, or on `PATH` for other platforms)
- VS Code CLI (`code`) on PATH
- Dependencies installed: `bun install` from `sdks/vscode/`

## Extension Metadata

| Field | Value |
|-------|-------|
| `name` | `opencode-ide-bridge` |
| `displayName` | `OpenCode IDE Bridge` |
| `publisher` | `SMARK2022` |
| `version` | `1.14.40` |
| `engines.vscode` | `^1.94.0` |
| `main` | `./dist/extension.js` |
| `license` | `MIT` |
| `categories` | `Other` |
| `homepage` | `https://github.com/anomalyco/opencode` |

## Build & Package

All commands run from `sdks/vscode/`.

### 1. Type Check

```powershell
bun run check-types
```

### 2. Lint

```powershell
bun run lint
```

### 3. Production Build (esbuild, minified, CJS, vscode external)

```powershell
bun run package
```

This runs `check-types && lint && node esbuild.js --production`.

This project intentionally does not define `vscode:prepublish`. `vsce package` runs that hook through an internal `npm run vscode:prepublish` child process. In some Windows/Bun terminal environments that nested child process can lose `npm` from `PATH`, producing:

```text
Executing prepublish script 'npm run vscode:prepublish'...
'npm' is not recognized as an internal or external command,
operable program or batch file.
ERROR  npm failed with exit code 1
```

Instead, run the build explicitly first (`bun run package`), then call `vsce package` with `--no-dependencies`.

### 4. List VSIX Contents (preview)

```powershell
npx @vscode/vsce ls
```

### 5. Package VSIX

```powershell
$env:PATH="C:\Users\Lenovo\.bun\bin;$env:PATH"
npm exec --yes --package @vscode/vsce -- vsce package --no-dependencies -o "dist/SMARK2022.opencode-ide-bridge-1.14.40.vsix"
```

The output file is written under `sdks/vscode/dist/` together with the compiled extension bundle.

### One-Command Shortcut

```powershell
bun run vsix
```

## VSIX Artifact Structure

```
dist/SMARK2022.opencode-ide-bridge-1.14.40.vsix
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

- `.vscode/`, `.vscode-test/`, `out/`, `node_modules/`, `src/`, `script/`
- `.gitignore`, `.yarnrc`, `.env`, `.env.*`, `*.log`, `*.vsix`
- `bun.lock`, `esbuild.js`, `**/tsconfig.json`, `**/eslint.config.mjs`, `**/*.map`, `**/*.ts`

## Installation

### Local VSIX Install

```powershell
code --install-extension .\dist\SMARK2022.opencode-ide-bridge-1.14.40.vsix --force
```

### From VS Code UI

1. Open Extensions panel (`Ctrl+Shift+X`)
2. Click `...` → `Install from VSIX...`
3. Select the `.vsix` file

## Security Model

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

### Marketplace (VS Code)

1. Create publisher at [https://marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
2. Create Azure DevOps PAT with `Marketplace: Manage` scope
3. Login and publish:

```powershell
npx @vscode/vsce login SMARK2022
npx @vscode/vsce publish
```

### Open VSX (optional, for VSCodium / Cursor / Gitpod)

1. Create account at [https://open-vsx.org](https://open-vsx.org)
2. Sign Publisher Agreement, generate access token
3. Create namespace and publish:

```powershell
npx ovsx create-namespace SMARK2022 -p <OPENVSX_TOKEN>
npx ovsx publish .\dist\SMARK2022.opencode-ide-bridge-1.14.40.vsix -p <OPENVSX_TOKEN>
```

## CLI Integration

The OpenCode CLI auto-installs this extension via:

`packages/opencode/src/ide/index.ts:54`

```typescript
const p = await Process.run([cmd, "--install-extension", "SMARK2022.opencode-ide-bridge"], { ... })
```

Supported IDE commands: `code`, `code-insiders`, `windsurf`, `cursor`, `codium`.

## Source Files (Not Packaged)

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
