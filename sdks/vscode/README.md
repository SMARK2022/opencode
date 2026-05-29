# SMARK OpenCode IDE Bridge

Local VS Code extension for the SMARK OpenCode fork. It connects the OpenCode CLI to VS Code workspace and notebook APIs through a localhost HTTP bridge protected by a per-session Bearer token.

| Field | Value |
| --- | --- |
| Extension ID | `SMARK2022.opencode-ide-bridge` |
| Publisher | `SMARK2022` |
| Extension version | `1.15.5` |
| Compatible CLI | `opencode 1.15.5-smark` or newer |
| Source | https://github.com/SMARK2022/opencode/tree/dev-smark/sdks/vscode |

## What It Adds

The upstream VS Code extension mainly opens an `opencode` terminal. This SMARK extension keeps that terminal workflow and adds a bridge that lets OpenCode work with VS Code notebooks directly.

| Capability | What it does |
| --- | --- |
| Terminal launch | Opens or focuses an `opencode` terminal from VS Code. |
| File references | Inserts `@relative/path#Lx-Ly` into the active OpenCode terminal through VS Code terminal input. |
| Bridge discovery | Publishes a heartbeat manifest so the CLI can find the active VS Code window and workspace. |
| Notebook inspection | Returns cell IDs, source ranges, execution state, output MIME types, dirty state, and runtime metadata. |
| Notebook editing | Inserts, edits, deletes, and changes notebook cell language or kind through VS Code notebook APIs. |
| Notebook execution | Runs one cell or a stable-ID range through VS Code's native notebook execution command. |
| Output artifacts | Writes images, HTML, JSON, and large text outputs to artifact files and returns compact summaries. |
| Kernel operations | Inspects, configures, restarts, and explicitly saves notebooks when requested. |

## Prerequisites

- Install the SMARK OpenCode CLI from https://github.com/SMARK2022/opencode/releases.
- Install this extension as `SMARK2022.opencode-ide-bridge`.
- For `.ipynb` work, install the VS Code Jupyter extension `ms-toolsai.jupyter`.
- For Python notebooks, install the VS Code Python extension `ms-python.python` and configure a kernel.
- Run OpenCode from the same local environment as the VS Code extension host. Remote SSH, WSL, or container workspaces need the CLI on the same side as the bridge.

## Quick Start

1. Open your project folder in VS Code.
2. Install this extension from Marketplace or from a local VSIX.
3. Run `Open or Focus OpenCode Terminal` from the command palette, or press `Ctrl+Esc` on Windows/Linux and `Cmd+Esc` on macOS.
4. Open a notebook in VS Code if you want notebook tools.
5. In OpenCode, ask it to inspect the notebook; it should call `vscode_notebook_summary` first.

Example prompts:

```text
Inspect this notebook and summarize the cells before making changes.
```

```text
Run cells c3 through c5, then show me the output artifacts.
```

```text
Change the selected setup cell to markdown without changing its source.
```

## Commands

| Command ID | Title | Keybinding | Description |
| --- | --- | --- | --- |
| `opencode.openTerminal` | Open or Focus OpenCode Terminal | `Ctrl+Esc` | Focuses an existing `opencode` terminal or creates one in a split view. |
| `opencode.openNewTerminal` | Open New OpenCode Terminal | `Ctrl+Shift+Esc` | Always creates a new `opencode` terminal. Also appears as the editor toolbar button. |
| `opencode.addFilepathToTerminal` | Insert File Reference into OpenCode | `Ctrl+Alt+K` | Sends an `@file#Lx-Ly` reference for the active editor into the active OpenCode terminal. |
| `opencode.showBridgeLog` | Show OpenCode Bridge Log | none | Opens the extension output channel for bridge startup and request logs. |
| `opencode.notebookBridgeTools` | OpenCode: Test Notebook Bridge Tools | none | Development helper for manually exercising notebook endpoints. |

On macOS, use `Cmd` instead of `Ctrl`, and `Option` instead of `Alt`.

## Notebook Tools

OpenCode registers these tools when the SMARK CLI loads its built-in VS Code bridge plugin. Use the exact names below when discussing or configuring permissions.

| Tool | Purpose |
| --- | --- |
| `vscode_notebook_summary` | Inspect a notebook and return stable `#VSC-*` cell handles, display indexes, source ranges, execution state, outputs, dirty state, and runtime metadata. |
| `vscode_notebook_source` | Read notebook source as a paginated virtual document with 1-based global line numbers. |
| `vscode_notebook_edit` | Insert, edit, delete, or change the kind/language of notebook cells using stable cell IDs and string-match edits. |
| `vscode_notebook_run` | Execute a single code cell or a range of code cells in VS Code/Jupyter. |
| `vscode_notebook_output` | Export cell outputs as compact summaries plus artifact file paths. |
| `vscode_notebook_env` | Inspect kernel state, configure a kernel, restart a kernel, or save a notebook when explicitly requested. |

Recommended notebook flow:

| Step | Tool | Why |
| --- | --- | --- |
| 1 | `vscode_notebook_summary` | Get current cell IDs and avoid relying on shifting display indexes. |
| 2 | `vscode_notebook_source` | Read only the relevant cell or page of source. |
| 3 | `vscode_notebook_edit` | Apply a precise cell-level edit. |
| 4 | `vscode_notebook_run` | Validate the changed code cell or range. |
| 5 | `vscode_notebook_output` | Review text, image, HTML, JSON, or large output artifacts. |
| 6 | `vscode_notebook_env` | Use `save` only when the user explicitly wants the notebook persisted. |

## Bridge Discovery

On startup, the extension starts an HTTP server on `127.0.0.1:<random port>`. It writes a registry file every 5 seconds under:

```text
~/.local/state/opencode/ide/<uuid>.json
```

Set `OPENCODE_IDE_REGISTRY_DIR` to override this location. The CLI scans the registry, checks live bridge health, scores matching workspaces, and uses the best matching bridge for notebook tools.

Each registry manifest includes:

| Field | Meaning |
| --- | --- |
| `host`, `port`, `token` | Local bridge connection details. |
| `workspaceFolders` | VS Code workspace folders used for matching notebook paths. |
| `active.textEditor` | Active text editor URI, when present. |
| `active.notebook` | Active notebook URI, when present. |
| `capabilities` | Bridge feature flags, including notebook support. |

## HTTP Endpoints

The OpenCode CLI uses these bridge endpoints internally. Normal users should prefer OpenCode tools instead of calling the endpoints by hand.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | No | Liveness check. |
| `GET` | `/manifest` | Bearer | Current bridge manifest with token redacted. |
| `POST` | `/notebook/summary` | Bearer | Notebook structure and compact cell map. |
| `POST` | `/notebook/source` | Bearer | Paginated source view with global virtual line numbers. |
| `POST` | `/notebook/edit` | Bearer | Insert, edit, or delete cells. |
| `POST` | `/notebook/run` | Bearer | Execute a cell or range. |
| `POST` | `/notebook/output` | Bearer | Export outputs as artifacts. |
| `POST` | `/notebook/cell-output` | Bearer | Alias for `/notebook/output`. |
| `POST` | `/notebook/env` | Bearer | Kernel info, configure, restart, and save operations. |

## Security Model

| Check | Implementation |
| --- | --- |
| Localhost only | The bridge binds to `127.0.0.1`, not an external interface. |
| Per-session token | A random token is generated every time the bridge starts. |
| Bearer auth | Every tool endpoint except `/health` requires `Authorization: Bearer <token>`. |
| Browser hardening | Requests with an `Origin` header are rejected. |
| Token logging | Logs print `<redacted>` instead of the token. |
| Registry permissions | Registry directories use `0o700` and manifest files use `0o600` on non-Windows systems. |
| Write permissions | Notebook edits and notebook saves still go through OpenCode permission gates. |

## Output Artifacts

Notebook outputs can be larger than a safe tool response. The bridge writes full artifacts under:

```text
.opencode/cache/notebook-outputs/
```

Small text may be inlined in the tool response. Images, HTML, JSON, binary output, and large text are summarized with an artifact path. Projects that do not want these files tracked should ignore `.opencode/cache/`.

## Limits And Important Behavior

| Topic | Behavior |
| --- | --- |
| Cell IDs | `#VSC-*` IDs are stable for existing cells in the current VS Code session. Insert/delete can shift display indexes, so prefer cell IDs. |
| Type changes | Changing a cell between code and markdown replaces the VS Code cell document and returns a new cell ID. |
| Source paging | `vscode_notebook_source` caps output at 16 KB and supports `offset`/`limit` pagination. |
| Run ranges | Range execution is sequential and stops on the first failed or timed-out code cell. |
| Kernel configure | A selected kernel may not become active until the first code cell executes. `selected` is a valid configure result. |
| Save | `vscode_notebook_env` with `operation: "save"` should only be used after explicit user intent. |

## Local VSIX Install

From `sdks/vscode`:

```bash
bun install
bun run vsix
```

The VSIX is written to:

```text
dist/SMARK2022.opencode-ide-bridge-<version>.vsix
```

Install it with:

```bash
code --install-extension "dist/SMARK2022.opencode-ide-bridge-<version>.vsix" --force
```

The `vsix` script builds first and then packages with `@vscode/vsce --no-dependencies`. The package intentionally avoids `vscode:prepublish`; nested `npm run vscode:prepublish` calls can fail in some Windows/Bun environments when `npm` is not on `PATH`.

## Development

Run these commands from `sdks/vscode`:

```bash
bun install
bun run check-types
bun run lint
bun run package
```

For extension host debugging:

1. Open `sdks/vscode` directly in VS Code.
2. Run `bun install` in `sdks/vscode`.
3. Press `F5` to launch an extension development host.
4. Use `Developer: Reload Window` in the development host after rebuilding.

## Source Layout

```text
VS Code Extension Host
|-- extension.ts           Activation, lifecycle, terminal commands
|-- bridge.ts              HTTP server, routing, auth, per-filePath mutex
|-- bridge-registry.ts     Registry heartbeat and manifest writer
|-- util.ts                Shared JSON, URI, and formatting helpers
`-- notebook/
    |-- summary.ts         Notebook structure overview
    |-- source.ts          Paginated virtual source text
    |-- edit.ts            Cell insert/edit/delete and language changes
    |-- run.ts             Cell execution through VS Code/Jupyter
    |-- output.ts          Artifact-first output export
    |-- env.ts             Kernel info/configure/restart/save
    |-- commands.ts        Interactive development test command
    |-- format.ts          Summary text and cell ID formatting
    `-- resolve.ts         Notebook and cell resolution
```

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `No live VS Code bridge found` | Ensure VS Code is open, this extension is enabled, and the workspace is open in VS Code. Run `Show OpenCode Bridge Log`. |
| `No live VS Code bridge workspace matches filePath` | Reuse the exact notebook path returned by `vscode_notebook_summary`; check WSL/Remote path boundaries. |
| Kernel configure returns `needs-selection` | Select a kernel in the VS Code notebook toolbar, then run configure again. |
| Kernel configure returns `selected` | Proceed to run a code cell; Jupyter often starts the kernel on first execution. |
| Output artifacts are missing | Ensure a workspace folder is open; artifacts require `.opencode/cache/notebook-outputs/` under a workspace. |
| Typecheck fails locally | Run `bun install` inside `sdks/vscode`; this package is independent from the root workspace install. |

## Source And License

This extension is maintained in the SMARK OpenCode fork at https://github.com/SMARK2022/opencode/tree/dev-smark/sdks/vscode. It is based on OpenCode and remains MIT licensed. See [LICENSE](./LICENSE).
