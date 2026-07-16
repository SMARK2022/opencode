# OpenCode IDE Bridge VSIX Packaging Guide

## Overview

This document describes how to build, inspect, install, and publish the SMARK OpenCode VS Code extension.

| Field | Value |
| --- | --- |
| Extension ID | `SMARK2022.opencode-ide-bridge` |
| Package path | `sdks/vscode` |
| Source repository | `https://github.com/SMARK2022/opencode` |
| Source branch | `dev-smark` |
| Repository extension version | `1.15.11` |
| Recommended CLI | `opencode 1.15.11-smark` |
| Default version source | `sdks/vscode/package.json` |
| Local VSIX name | `dist/SMARK2022.opencode-ide-bridge-<version>.vsix` |
| CI/GitHub Release VSIX name | `dist/opencode-vscode-<version>.vsix` |

The extension starts a local bridge on `127.0.0.1:<random port>` and lets the SMARK OpenCode CLI call VS Code language, notebook, and workspace APIs through authenticated localhost endpoints. The CLI and extension are versioned independently.

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
bun install --frozen-lockfile
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

The `build-vsix.yml` workflow uses `dist/opencode-vscode-<version>.vsix` for its workflow artifact and GitHub prerelease asset. The payload is the same extension, but publishing commands must use the filename of the artifact you actually downloaded.

The package intentionally avoids `vscode:prepublish`. `vsce` runs that hook through an internal `npm run vscode:prepublish` child process, which can fail in Windows/Bun environments when `npm` is not available in the nested process environment.

## Inspect The VSIX

List packaged files before publishing:

```bash
bun x @vscode/vsce@^3 ls
```

Inspect the public manifest and Marketplace overview in the generated archive as well:

```bash
unzip -p "dist/SMARK2022.opencode-ide-bridge-<version>.vsix" extension/package.json
unzip -p "dist/SMARK2022.opencode-ide-bridge-<version>.vsix" extension/readme.md
```

The expected payload is compact:

```text
extension/
├── LICENSE.txt
├── package.json
├── readme.md
├── dist/
│   └── extension.js
└── images/
    ├── icon.png
    ├── button-dark.svg
    └── button-light.svg
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
4. Open a source file supported by an enabled VS Code language extension and request hover or definition at a known symbol.
5. Edit a file with a known diagnostic and confirm the post-edit LSP summary reports the current VS Code snapshot; an empty result means no diagnostics were found in that snapshot.
6. Open a notebook and ask OpenCode to call `vscode_notebook_summary`.
7. If the notebook has executable cells, call `vscode_notebook_run` on one safe cell.
8. If the cell has outputs, call `vscode_notebook_output` and confirm artifacts appear under `.opencode/cache/notebook-outputs/`.

## Security Checks

| Check | Expected result |
| --- | --- |
| Local binding | Bridge listens only on `127.0.0.1`. |
| Health endpoint | `/health` is unauthenticated. |
| Tool endpoints | Language, Notebook, and `/manifest` endpoints require `Bearer <token>`. |
| Cross-origin requests | Requests with an `Origin` header are rejected. |
| Token logging | Output logs redact the token. |
| Registry directory | Uses `0o700` on non-Windows systems. |
| Registry file | Uses `0o600` on non-Windows systems. |
| Create/save/edit permissions | CLI plugin still asks through OpenCode permission gates; notebook create and save also require the general `edit` gate. |

## Publishing

`bun run vsix` is the supported local packaging entry point. Marketplace and Open VSX publishing remain explicit manual operations; the repository root `script/release` and `script/publish.ts` are not VS Code extension release commands. In particular, `script/publish.ts` rewrites package versions across the repository and must not be used to publish this independently versioned extension.

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

If publishing an artifact downloaded from the GitHub prerelease, substitute its actual `dist/opencode-vscode-<version>.vsix` filename. Do not assume local and CI artifact names are interchangeable paths.

The legacy `sdks/vscode/script/publish` script derives its version from the latest local `vscode-v*` tag and immediately publishes to both registries. The legacy `sdks/vscode/script/release` script force-fetches tags, creates a new tag, and pushes all tags. Neither is the supported flow documented here: do not run them for a manifest-driven release or when the CI workflow may create the same tag.

Do not publish before the extension manifest, README, and recommended CLI statement are aligned.

## Versioning

Use `sdks/vscode/package.json` as the canonical version source for local packaging and push-triggered builds. The repository extension version is ordinary semver (`1.15.11`) so Marketplace tooling accepts it; the recommended CLI is `1.15.11-smark`, but the two packages remain independently versioned.

Pushes to `dev-smark` that change `sdks/vscode/**` run `.github/workflows/build-vsix.yml`. By default it reads the manifest version, writes `dist/opencode-vscode-<version>.vsix`, and creates or updates the `vscode-v<version>` GitHub prerelease. A manual `workflow_dispatch.version` leaves the repository manifest and README unchanged but overrides the manifest version inside the packaged VSIX, so use it only for an intentional temporary rebuild and expect the packaged README version statement to remain unchanged. The workflow does not publish Marketplace or Open VSX.

The repository root `script/release` currently targets a `publish.yml` workflow that is absent from this checkout. It is not an extension tag helper. Do not substitute either root release script for the local VSIX and manual publishing flow documented above.

## CLI Integration

The SMARK OpenCode CLI installs this extension ID when users choose IDE integration:

```ts
await Process.run([cmd, "--install-extension", "SMARK2022.opencode-ide-bridge"], { ... })
```

Supported IDE commands are `code`, `code-insiders`, `windsurf`, `cursor`, and `codium`.

## Source Layout

```text
sdks/vscode/src/
├── extension.ts           Entry point, lifecycle, terminal commands
├── bridge.ts              HTTP server, routing, auth, per-filePath mutex
├── bridge-registry.ts     Registry heartbeat and manifest writer
├── lsp.ts                 VS Code language-provider and diagnostics adapter
├── util.ts                Shared JSON, URI, and formatting helpers
└── notebook/
    ├── commands.ts        Interactive bridge testing command
    ├── edit.ts            Cell insert/edit/delete and language changes
    ├── env.ts             Kernel info/configure/restart/stop and create/save
    ├── format.ts          Summary text formatting
    ├── output.ts          Artifact-first cell output export
    ├── resolve.ts         File-path to notebook resolution
    ├── run.ts             Cell execution through VS Code/Jupyter
    ├── source.ts          Paginated virtual notebook source
    └── summary.ts         Notebook structure overview
```
