# SMARK OpenCode IDE Bridge

Local VS Code extension for the SMARK OpenCode fork. It connects the OpenCode CLI to VS Code language, workspace, and notebook APIs through a localhost HTTP bridge protected by a per-session Bearer token.

| Field | Value |
| --- | --- |
| Extension ID | `SMARK2022.opencode-ide-bridge` |
| Publisher | `SMARK2022` |
| Repository extension version | `1.15.10` |
| Recommended CLI | `opencode 1.15.10-smark` |
| Source | https://github.com/SMARK2022/opencode/tree/dev-smark/sdks/vscode |

The CLI and extension are versioned independently. Marketplace may continue to show `1.15.5` until this repository build is published.

## What It Adds

The upstream VS Code extension mainly opens an `opencode` terminal. This SMARK extension keeps that terminal workflow and adds a bridge that lets OpenCode reuse VS Code language providers and work with notebooks directly.

| Capability | What it does |
| --- | --- |
| Terminal launch | Opens or focuses an `opencode` terminal from VS Code. |
| File references | Inserts `@relative/path#Lx-Ly` into the active OpenCode terminal through VS Code terminal input. |
| Bridge discovery | Publishes a heartbeat manifest so the CLI can find the active VS Code window and workspace. |
| Language intelligence | Reuses providers registered in the current VS Code window for diagnostics, hover, definitions, references, and symbols. |
| Notebook inspection | Returns cell IDs, source ranges, execution state, output MIME types, dirty state, and runtime metadata. |
| Notebook editing | Inserts, edits, deletes, and changes notebook cell language or kind through VS Code notebook APIs. |
| Notebook execution | Runs one cell or a stable-ID range through VS Code's native notebook execution command. |
| Output artifacts | Writes images, HTML, JSON, and large text outputs to artifact files and returns compact summaries. |
| Notebook lifecycle | Inspects, configures, restarts, or stops kernels and explicitly creates or saves notebooks when requested. |

## Prerequisites

- Install the SMARK OpenCode CLI from https://github.com/SMARK2022/opencode/releases.
- Install this extension as `SMARK2022.opencode-ide-bridge`.
- For language intelligence, enable a VS Code language extension that registers the required provider for the target language.
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
Run the range between the stable #VSC-* cell IDs returned by the summary, then show me the output artifacts.
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
| `vscode_notebook_env` | Inspect kernel state, configure, restart, or stop a kernel, and create or save a notebook when explicitly requested. |

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

Set `OPENCODE_IDE_REGISTRY_DIR` to override this location. The CLI scans the registry, checks live bridge health, scores matching workspaces, and uses the best matching bridge for language and notebook operations.

Each registry manifest includes:

| Field | Meaning |
| --- | --- |
| `host`, `port`, `token` | Local bridge connection details. |
| `workspaceFolders` | VS Code workspace folders used for matching notebook paths. |
| `active.textEditor` | Active text editor URI, when present. |
| `active.notebook` | Active notebook URI, when present. |
| `capabilities` | Bridge feature flags, including language (`lsp`) and notebook support. |

## Language Intelligence

The bridge does not bundle language servers. It calls providers registered by enabled language extensions in the current VS Code window, so availability depends on the target language and provider. OpenCode uses the bridge for these operations:

| Operation | VS Code-backed behavior |
| --- | --- |
| Touch | Reveals a preserve-focus preview when a strong diagnostics refresh needs VS Code to activate the document. |
| Diagnostics | Reads diagnostics currently published by VS Code, optionally scoped to one file; the CLI aggregate path requests all published diagnostics. |
| Hover | Returns hover contents at a position. |
| Definition | Returns definition locations for a symbol. |
| References | Returns references for a symbol. |
| Document symbols | Returns symbols from one document. |
| Workspace symbols | Searches symbols registered for the current workspace. |

For supported operations, OpenCode falls back to its built-in LSP when the bridge request fails. Diagnostics also falls back when its response structure is invalid; for other successful responses, a missing result field may currently be interpreted as empty. A valid empty result does not trigger fallback and does not by itself prove that the entire project passes type checking. Implementation lookup and prepare/incoming/outgoing call hierarchy are not bridge endpoints and continue to use the built-in LSP.

Opening a document with `vscode.workspace.openTextDocument` does not reveal it. A strong diagnostics refresh may call the touch endpoint, which uses a preview editor with `preserveFocus: true`; this preserves focus but can still add a preview tab.

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
| `POST` | `/notebook/env` | Bearer | Kernel info/configure/restart/stop and notebook create/save operations. |
| `POST` | `/lsp/touch` | Bearer | Activate a document and wait briefly for diagnostics. |
| `POST` | `/lsp/diagnostics` | Bearer | Return diagnostics for one file when scoped, or all currently published diagnostics when omitted. |
| `POST` | `/lsp/hover` | Bearer | Return hover results at a position. |
| `POST` | `/lsp/definition` | Bearer | Return definition locations at a position. |
| `POST` | `/lsp/references` | Bearer | Return reference locations at a position. |
| `POST` | `/lsp/document-symbol` | Bearer | Return symbols for a document. |
| `POST` | `/lsp/workspace-symbol` | Bearer | Search workspace symbols by query. |

## Security Model

| Check | Implementation |
| --- | --- |
| Localhost only | The bridge binds to `127.0.0.1`, not an external interface. |
| Per-session token | A random token is generated every time the bridge starts. |
| Bearer auth | Every tool endpoint except `/health` requires `Authorization: Bearer <token>`. |
| Browser hardening | Requests with an `Origin` header are rejected. |
| Token logging | Logs print `<redacted>` instead of the token. |
| Registry permissions | Registry directories use `0o700` and manifest files use `0o600` on non-Windows systems. |
| Write permissions | Notebook edits, saves, and creates go through OpenCode permission gates; save/create also require the general `edit` gate. |

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
| Language providers | Results depend on providers registered by enabled VS Code language extensions; the bridge does not install a server. |
| Empty diagnostics | An empty response is valid but is not a replacement for a complete project typecheck. |
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
|-- lsp.ts                 VS Code language-provider and diagnostics adapter
|-- util.ts                Shared JSON, URI, and formatting helpers
`-- notebook/
    |-- summary.ts         Notebook structure overview
    |-- source.ts          Paginated virtual source text
    |-- edit.ts            Cell insert/edit/delete and language changes
    |-- run.ts             Cell execution through VS Code/Jupyter
    |-- output.ts          Artifact-first output export
    |-- env.ts             Kernel info/configure/restart/stop and create/save
    |-- commands.ts        Interactive development test command
    |-- format.ts          Summary text and cell ID formatting
    `-- resolve.ts         Notebook and cell resolution
```

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `No live VS Code bridge found` | Ensure VS Code is open, this extension is enabled, and the workspace is open in VS Code. Run `Show OpenCode Bridge Log`. |
| `No live VS Code bridge workspace matches filePath` | Reuse the exact notebook path returned by `vscode_notebook_summary`; check WSL/Remote path boundaries. |
| Language result is empty | Confirm the target file belongs to the open workspace and an enabled language extension registers that provider. An empty result can be valid. |
| Diagnostics stay unavailable | Open the bridge log, verify `capabilities.lsp`, and confirm the CLI and extension host run on the same side of Remote SSH, WSL, or a container. |
| Kernel configure returns `needs-selection` | Select a kernel in the VS Code notebook toolbar, then run configure again. |
| Kernel configure returns `selected` | Proceed to run a code cell; Jupyter often starts the kernel on first execution. |
| Output artifacts are missing | Ensure a workspace folder is open; artifacts require `.opencode/cache/notebook-outputs/` under a workspace. |
| Typecheck fails locally | Run `bun install` inside `sdks/vscode`; this package is independent from the root workspace install. |

## Source And License

This extension is maintained in the SMARK OpenCode fork at https://github.com/SMARK2022/opencode/tree/dev-smark/sdks/vscode. It is based on OpenCode and remains MIT licensed. See [LICENSE](./LICENSE).
