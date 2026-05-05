# OpenCode VS Code Bridge

VS Code bridge for OpenCode IDE integration, notebook tools, and workspace context.

Extension ID: `SMARK2022.opencode-ide-bridge`

## Prerequisites

This extension requires the OpenCode CLI to be installed and available on your system. The extension starts a local VS Code bridge; the OpenCode CLI uses that bridge to read editor context and run notebook operations.

## Features

- Quick launch: use `Cmd+Esc` on macOS or `Ctrl+Esc` on Windows/Linux to open OpenCode in a split terminal.
- New session: use `Cmd+Shift+Esc` on macOS or `Ctrl+Shift+Esc` on Windows/Linux to start a new OpenCode terminal session.
- Context awareness: shares the active editor or notebook with OpenCode through the local bridge registry.
- File references: use `Cmd+Option+K` on macOS or `Ctrl+Alt+K` on Windows/Linux to insert an `@file#Lx-Ly` reference into the OpenCode terminal.
- Notebook tools: exposes local notebook summary, source, run, edit, output, and environment endpoints for OpenCode.

## Security Model

- The bridge listens only on `127.0.0.1`.
- `/health` is unauthenticated for liveness checks.
- Notebook endpoints require `Authorization: Bearer <token>`.
- Requests with an `Origin` header are rejected to block browser cross-site access.
- The bridge token is not printed to the VS Code output log.
- The local registry file is written under the OpenCode IDE registry directory and is intended for local OpenCode processes only.

## Local VSIX Install

Build and package from this directory:

```powershell
bun run check-types
bun run lint
bun run package
npx @vscode/vsce package
```

Install the generated package:

```powershell
code --install-extension .\SMARK2022.opencode-ide-bridge-1.14.31.vsix --force
```

## Development

1. Open `sdks/vscode` directly in VS Code.
2. Run `bun install` inside `sdks/vscode`.
3. Press `F5` to launch an extension development host.
4. Use `Developer: Reload Window` in the development host after rebuilding.
