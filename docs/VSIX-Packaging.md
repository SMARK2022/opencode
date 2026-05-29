# OpenCode IDE Bridge VSIX Packaging Guide

## Overview

This document describes how to build, inspect, install, and publish the SMARK OpenCode VS Code extension.

| Field | Value |
| --- | --- |
| Extension ID | `SMARK2022.opencode-ide-bridge` |
| Package path | `sdks/vscode` |
| Source repository | `https://github.com/SMARK2022/opencode` |
| Source branch | `dev-smark` |
| CLI compatibility | `opencode 1.15.5-smark` or newer |
| Version source | `sdks/vscode/package.json` |
| VSIX name | `dist/SMARK2022.opencode-ide-bridge-<version>.vsix` |

The extension starts a local bridge on `127.0.0.1:<random port>` and lets the SMARK OpenCode CLI call VS Code notebook and workspace APIs through authenticated localhost endpoints.

## Prerequisites

- Node.js 20 or newer.
- Bun matching the repository `packageManager` field.
- VS Code CLI `code` on `PATH` if you want command-line install testing.
- Dependencies installed from `sdks/vscode`, not only from the repository root.
- Marketplace publish access for publisher `SMARK2022` if publishing.
- Optional Open VSX token in `OPENVSX_TOKEN` if publishing to Open VSX.

## Clean Build

Run all commands from `sdks/vscode`.

```bash
bun install
bun run check-types
bun run lint
bun run package
```

`bun run package` runs typecheck, lint, and a production esbuild bundle into `dist/extension.js`.

## Create A VSIX

Use the repository script:

```bash
bun run vsix
```

The script builds first, then runs `@vscode/vsce package --no-dependencies` and writes:

```text
dist/SMARK2022.opencode-ide-bridge-<version>.vsix
```

The package intentionally avoids `vscode:prepublish`. `vsce` runs that hook through an internal `npm run vscode:prepublish` child process, which can fail in Windows/Bun environments when `npm` is not available in the nested process environment.

## Inspect The VSIX

List packaged files before publishing:

```bash
bun x @vscode/vsce ls
```

The expected payload is compact:

```text
extension/
|-- LICENSE.txt
|-- package.json
|-- readme.md
|-- dist/
|   `-- extension.js
`-- images/
    |-- icon.png
    |-- button-dark.svg
    `-- button-light.svg
```

Excluded files are controlled by `sdks/vscode/.vscodeignore`. Source files, test output, local dependencies, build scripts, TypeScript config, lint config, source maps, logs, and nested VSIX files are not packaged.

## Install Locally

After `bun run vsix`, install the generated file:

```bash
code --install-extension "dist/SMARK2022.opencode-ide-bridge-<version>.vsix" --force
```

From the VS Code UI:

1. Open Extensions with `Ctrl+Shift+X`.
2. Open the `...` menu.
3. Choose `Install from VSIX...`.
4. Select `dist/SMARK2022.opencode-ide-bridge-<version>.vsix`.

## Functional Smoke Test

After installing locally:

1. Open a workspace in VS Code.
2. Run `OpenCode: Show Bridge Log` and confirm the bridge is listening on `127.0.0.1`.
3. Run `Open or Focus OpenCode Terminal` and confirm an `opencode` terminal starts.
4. Open a notebook and ask OpenCode to call `vscode_notebook_summary`.
5. If the notebook has executable cells, call `vscode_notebook_run` on one safe cell.
6. If the cell has outputs, call `vscode_notebook_output` and confirm artifacts appear under `.opencode/cache/notebook-outputs/`.

## Security Checks

| Check | Expected result |
| --- | --- |
| Local binding | Bridge listens only on `127.0.0.1`. |
| Health endpoint | `/health` is unauthenticated. |
| Tool endpoints | Notebook endpoints and `/manifest` require `Bearer <token>`. |
| Cross-origin requests | Requests with an `Origin` header are rejected. |
| Token logging | Output logs redact the token. |
| Registry directory | Uses `0o700` on non-Windows systems. |
| Registry file | Uses `0o600` on non-Windows systems. |
| Save/edit permissions | CLI plugin still asks through OpenCode permission gates. |

## Publishing

The publish script packages from the current `package.json` version and publishes that exact VSIX.

```bash
bun run script/publish
```

Marketplace-only manual flow:

```bash
bun x @vscode/vsce login SMARK2022
bun run vsix
bun x @vscode/vsce publish --packagePath "dist/SMARK2022.opencode-ide-bridge-<version>.vsix"
```

Open VSX manual flow:

```bash
bun x ovsx create-namespace SMARK2022 -p "$OPENVSX_TOKEN"
bun x ovsx publish "dist/SMARK2022.opencode-ide-bridge-<version>.vsix" -p "$OPENVSX_TOKEN"
```

Do not publish before the CLI release and README compatibility statement are aligned.

## Versioning

Use `sdks/vscode/package.json` as the source of truth for the extension version. The current extension version is ordinary semver (`1.15.5`) so Marketplace tooling accepts it, while the README documents compatibility with the SMARK CLI release (`1.15.5-smark`).

The helper `script/release` prints the next `vscode-v<version>` tag suggestion. It does not create or push tags. Create tags manually after the package version, README, packaging guide, and changelog are updated.

## CLI Integration

The SMARK OpenCode CLI installs this extension ID when users choose IDE integration:

```ts
await Process.run([cmd, "--install-extension", "SMARK2022.opencode-ide-bridge"], { ... })
```

Supported IDE commands are `code`, `code-insiders`, `windsurf`, `cursor`, and `codium`.

## Source Layout

```text
sdks/vscode/src/
|-- extension.ts           Entry point, lifecycle, terminal commands
|-- bridge.ts              HTTP server, routing, auth, per-filePath mutex
|-- bridge-registry.ts     Registry heartbeat and manifest writer
|-- util.ts                Shared JSON, URI, and formatting helpers
`-- notebook/
    |-- commands.ts        Interactive bridge testing command
    |-- edit.ts            Cell insert/edit/delete and language changes
    |-- env.ts             Kernel info/configure/restart/save
    |-- format.ts          Summary text formatting
    |-- output.ts          Artifact-first cell output export
    |-- resolve.ts         File-path to notebook resolution
    |-- run.ts             Cell execution through VS Code/Jupyter
    `-- summary.ts         Notebook structure overview
```
