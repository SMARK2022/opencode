# OpenCode IDE Bridge

Local HTTP bridge extension for [OpenCode](https://opencode.ai) IDE. Connects the OpenCode CLI daemon to VS Code's notebook, Jupyter kernel, and workspace APIs over `127.0.0.1` with Bearer-token authentication.

Extension ID: `SMARK2022.opencode-ide-bridge`

## Prerequisites

This extension requires the [OpenCode CLI](https://opencode.ai) to be installed on your system. It starts a local bridge server on VS Code startup; the OpenCode CLI discovers the bridge via a file-based registry and uses it to read editor context and run notebook operations.

## What This Extension Does

| Capability | Description |
|------------|-------------|
| **Bridge Server** | Starts an HTTP server on `127.0.0.1:<random port>` on VS Code startup with Bearer-token authentication for all tool endpoints. |
| **Notebook Operations** | Exposes 7 endpoints: summary, source, run, edit, output, cell-output, env. The OpenCode CLI calls these to inspect and manipulate Jupyter notebooks directly inside VS Code. |
| **Jupyter Kernel Management** | The `/notebook/env` endpoint supports `info`, `configure`, `restart`, and `save` operations — inspecting or restarting kernels without leaving the OpenCode session. |
| **Bridge Registry** | Writes a heartbeat manifest to `~/.local/state/opencode/ide/<uuid>.json` every 5 seconds. The OpenCode CLI polls this registry to discover active bridges and their capabilities. |
| **Terminal Integration** | Registers VS Code commands and keybindings to launch or focus an OpenCode terminal session, optionally forwarding the current file and selection. |
| **File Reference Insertion** | Sends `@relative/path#Lx-Ly` references into the OpenCode terminal — either via the TUI append-prompt API when available, or as raw terminal text. |
| **Context Sharing** | Publishes the active text editor and notebook URIs in the bridge registry manifest, so the OpenCode CLI always knows which file you're working on. |

## Commands

| Command ID | Title | Keybinding | Description |
|------------|-------|------------|-------------|
| `opencode.openTerminal` | Open or Focus OpenCode Terminal | `Ctrl+Esc` | Focuses the existing OpenCode terminal, or creates one in a split view if none is running. |
| `opencode.openNewTerminal` | Open New OpenCode Terminal | `Ctrl+Shift+Esc` | Always starts a new OpenCode terminal session in a split view. Also available via the editor toolbar button. |
| `opencode.addFilepathToTerminal` | Insert File Reference into OpenCode | `Ctrl+Alt+K` | Sends an `@file#Lx-Ly` reference for the active editor into the OpenCode terminal. Uses the TUI append-prompt API when available. |
| `opencode.showBridgeLog` | Show OpenCode Bridge Log | — | Opens the extension output channel to inspect bridge startup, request logs, and errors. |
| `opencode.notebookBridgeTools` | OpenCode: Test Notebook Bridge Tools | — | Interactive command-palette tool for manually testing each notebook endpoint during development. |

On macOS, replace `Ctrl` with `Cmd` and `Alt` with `Option`.

## HTTP Endpoints

The bridge server exposes these endpoints on `http://127.0.0.1:<port>`:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Liveness check. Returns `{ ok: true, service: "opencode-vscode-bridge" }`. |
| GET | `/manifest` | Bearer | Returns the bridge manifest (port, capabilities, workspace folders, active file/notebook). |
| POST | `/notebook/summary` | Bearer | Notebook structure overview: cell count, types, execution states, languages, output summaries. |
| POST | `/notebook/source` | Bearer | Paginated virtual source text for a notebook with 1-based global line numbers. |
| POST | `/notebook/run` | Bearer | Execute a single cell or range of cells by `#VSC-xxxx` cell ID. |
| POST | `/notebook/edit` | Bearer | Insert, edit, or delete cells using string-matching (`oldCode`/`newCode`) to avoid index-shift bugs. |
| POST | `/notebook/output` | Bearer | Export cell outputs as artifacts (images, HTML, JSON, or large text written to `.opencode/cache/notebook-outputs/`). |
| POST | `/notebook/cell-output` | Bearer | Alias for `/notebook/output`. |
| POST | `/notebook/env` | Bearer | Kernel/environment operations: `info` (probe kernel), `configure` (trigger kernel selection), `restart` (restart Jupyter kernel), `save` (persist notebook to disk). |

## Security Model

| Check | Implementation |
|-------|----------------|
| Listens only on `127.0.0.1` | `BRIDGE_HOST = "127.0.0.1"`, no external network exposure |
| `/health` is unauthenticated | Allows liveness probes without a token |
| All tool endpoints require `Bearer <token>` | Header check: `Authorization === "Bearer ${token}"` |
| Rejects cross-origin requests | Blocks any request with an `Origin` header |
| Token is never logged | Output channel prints `<redacted>` |
| Registry file permissions | Manifest written with mode `0o600`, directory `0o700` |
| Token scoped per session | New random UUID token generated on each bridge start |

## Local VSIX Install

Build and package from the `sdks/vscode` directory:

```powershell
bun run check-types
bun run lint
bun run package
npm exec --yes --package @vscode/vsce -- vsce package --no-dependencies -o "dist/SMARK2022.opencode-ide-bridge-1.14.32.vsix"
```

Or use the bundled shortcut:

```powershell
bun run vsix
```

The shortcut builds first, then packages directly into `dist/`. It intentionally does not use `vscode:prepublish`, because `vsce` runs that hook through an internal `npm run vscode:prepublish` child process, which can lose `npm` from `PATH` in some Windows/Bun terminal environments.

Install:

```powershell
code --install-extension .\dist\SMARK2022.opencode-ide-bridge-1.14.32.vsix --force
```

## Architecture

```
VS Code Extension Host
├── extension.ts           Activation, lifecycle, terminal management
├── bridge.ts              HTTP server, routing, auth, per-filePath mutex
├── bridge-registry.ts     File-based registry (heartbeat every 5s, manifest)
├── util.ts                Shared helpers (JSON parsing, URI conversion, formatting)
└── notebook/
    ├── summary.ts         Notebook structure overview
    ├── source.ts          Paginated virtual source text
    ├── run.ts             Cell execution (single + range)
    ├── edit.ts            Cell insert/edit/delete (string-matching edits)
    ├── output.ts          Artifact-first cell output export
    ├── env.ts             Kernel/environment operations (info/configure/restart/save)
    ├── commands.ts        Interactive bridge testing command
    ├── format.ts          Summary text formatting
    └── resolve.ts         File-path to notebook document resolution
```

## Open Source

This extension is part of the [OpenCode](https://github.com/anomalyco/opencode) project, licensed under the MIT License. See [LICENSE](./LICENSE) for details.

## Development

1. Open `sdks/vscode` directly in VS Code (do not open from the repository root).
2. Run `bun install` inside `sdks/vscode`.
3. Press `F5` to launch an extension development host.
4. After rebuilding, use `Developer: Reload Window` in the development host to pick up changes.
5. Run `bun run test` to execute the extension test suite.
