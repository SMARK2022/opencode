<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="../../packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="../../packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="../../packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Open source AI Coding Agent — SMARK enhanced branch</p>
<p align="center">
  <a href="https://github.com/anomalyco/opencode/tree/dev"><img alt="Upstream dev branch" src="https://img.shields.io/badge/upstream-dev-6b7280?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="Upstream npm version" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square&label=upstream%20npm" /></a>
  <a href="https://github.com/SMARK2022/opencode/tree/dev-smark"><img alt="SMARK branch" src="https://img.shields.io/badge/SMARK%20branch-dev--smark-0969da?style=flat-square" /></a>
  <a href="https://github.com/SMARK2022/opencode/releases"><img alt="Current SMARK version" src="https://img.shields.io/badge/current-1.15.7-f97316?style=flat-square" /></a>
</p>

<p align="center">
  <a href="../../README.md">简体中文</a> |
  <a href="README.en.md">English</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](../../packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

> **About this branch**: This is OpenCode's `dev-smark` enhanced branch (current version `1.15.7`, CLI release tag `v1.15.7-smark`). It is based on upstream `dev` and focuses on TUI interaction, session management, token statistics, Windows/PowerShell compatibility, VS Code Notebook integration, network proxy support, and installation experience.

> **Database migration notice**: The SMARK branch includes custom database schema changes and migrations. Before switching from upstream `dev`, the main branch, or another original branch, create a manual backup of your local `opencode.db`; after migration, the database may not migrate or roll back cleanly to upstream or original branches. This project is not responsible for schema-format compatibility issues in your local database context data.

---

## Quick Install

Use the installer from the SMARK branch releases page. By default it installs the latest release and writes the install directory to existing shell profiles.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Verify after installation:

```bash
opencode --version
which opencode
```

If the current shell has not refreshed PATH, reopen the terminal or source the profile shown in the install log.

### Specify Install Directory

User-level installs are recommended in `~/.local/bin`. The environment variable must be passed to the `bash` process that runs the installer, not only to `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

For troubleshooting, download the script first and then run it:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Do not write it this way:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

That only passes `OPENCODE_INSTALL_DIR` to `curl`, not to the `bash` process that actually runs the installer.

### Specify Version

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

This is the complete form: `bash -s --` tells `bash` to read the installer from stdin and pass `--version 1.15.7-smark` as installer arguments. The version may be `1.15.7-smark` or the release tag form `v1.15.7-smark`.

### Installer Behavior

| Scenario | Behavior |
| --- | --- |
| Default install directory | `$OPENCODE_INSTALL_DIR`, then `$XDG_BIN_DIR`, then `$HOME/.opencode/bin` |
| Same version already at target path | Reinstall and overwrite, useful for refreshing damaged or stale binaries |
| Same version elsewhere in PATH | Print a notice only; do not block install to the requested directory |
| PATH writing | By default update all existing supported profiles and avoid duplicate entries |
| sudo | Refuse `sudo` startup by default; system installs must pass `--allow-sudo` explicitly |
| macOS quarantine | Try to remove the `com.apple.quarantine` attribute after install |
| checksum | Verify downloaded assets when the release provides `checksums.txt` |

### PATH And Shell Profiles

The installer detects and updates existing profiles: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*`, and `~/.config/fish/config.fish`.

| Need | Command |
| --- | --- |
| Do not modify PATH | `bash /tmp/opencode-install --no-modify-path` |
| Write only one profile | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Choose profile interactively | `bash /tmp/opencode-install --interactive` |
| Install to system directory | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

If you want `~/.local/bin/opencode` to take priority over `/usr/local/bin/opencode`, make sure your profile orders PATH like this:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Other Install Methods

These methods use the upstream package-manager ecosystem. If you need the SMARK branch build, prefer the GitHub release installer above.

| Platform | Command | Notes |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | You can also use `bun`, `pnpm`, or `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap, usually updated quickly |
| macOS/Linux | `brew install opencode` | Official Homebrew formula, may lag |
| Windows | `scoop install opencode` | Scoop package |
| Windows | `choco install opencode` | Chocolatey package |
| Arch Linux | `sudo pacman -S opencode` | Stable package |
| Arch Linux | `paru -S opencode-bin` | Latest AUR binary package |
| Any system | `mise use -g opencode` | Manage tool versions with mise |
| Nix | `nix run nixpkgs#opencode` | Can also run the development version from GitHub |

---

## Quick Start

```bash
cd <your-project>
opencode
```

After startup, describe a task directly, such as "explain this module architecture", "fix this error", or "add tests for this feature". In the TUI, use `Tab` to switch agents and use built-in tools to read/write files, run commands, inspect diffs, and manage sessions.

| Action | Description |
| --- | --- |
| `Tab` | Switch between available agents |
| Session list | View history and search titles and message content |
| Diff preview | Show git diff style changes before and after file writes |
| Manual compaction | Proactively compact context in long sessions to free token space |
| Shell tool | Supports cancellation, output compression, and PowerShell output normalization |

---

## Desktop App

The SMARK `dev-smark` branch currently publishes CLI releases only, not desktop app installers. For the desktop app (BETA), use [opencode.ai/download](https://opencode.ai/download) and upstream release notes as the source of truth; do not treat the SMARK CLI release page as a desktop installer source.

---

## Core Features

This branch is not just a pile of features; it turns common development pain points into observable, recoverable, cross-platform workflows.

| Area | Problem Solved | What You Will See |
| --- | --- | --- |
| TUI interaction | Long output, streaming messages, hard-to-read diffs | Live rendering, collapsible reasoning, diff preview, instant status updates |
| Session management | Long sessions lose context and are costly to recover | Session search, path filters, manual compaction, interrupt recovery, Session Warping |
| Token statistics | Hard to know what consumes context | Input/output tokens, tool results, attachments, request overhead breakdowns |
| Tool system | File and shell output can pollute context | Structured Read output, Shell output compression, Write auto diff |
| Voice transcription | Audio or voice notes need a clear text-entry path | Optional MCP can transcribe voice audio and feed the transcript back into context |
| Provider | Multi-account, endpoint, and model setup is complex | Provider aliases, client version override, ClaudeCode provider |
| VSCode | Notebook scenarios cannot be operated reliably by CLI agents | Cell summary, read, edit, run, output read, kernel management |
| Windows | PowerShell, encoding, paths, and CRLF are error-prone | CLIXML decoding, UTF-8 fixes, path normalization, CRLF preservation |
| Network proxy | Provider, plugin, and fetch proxy logic is scattered | NetworkProxy handles HTTP_PROXY, HTTPS_PROXY, NO_PROXY consistently |
| Daemon | Multi-instance, locks, health checks, and clients are complex | Server Lock, health checks, HttpApi, PTY WebSocket tickets |

### TUI And Interaction Experience

| Capability | Details |
| --- | --- |
| Streaming output | Assistant messages and reasoning chunks render incrementally, with elapsed time shown while streaming |
| Reasoning display | Long reasoning can be collapsed to reduce screen usage |
| Diff preview | File overwrites automatically generate a git diff style view with added/deleted line counts |
| Session list | Shows recent message summaries and supports searching by title and message content |
| Layout stability | More reliable scrollbars, terminal width handling, and CJK character width handling |
| Shell mode | Provides cancel button, custom icon, example placeholder, and live completion status |

### Session And Context Management

| Capability | Details |
| --- | --- |
| Session recovery | Hidden messages, undo operations, pending-message checks, and error recovery are more robust |
| Interrupt control | Records interrupt counts and confirmation time; parent session interrupts propagate to subtasks |
| Path compatibility | Windows global session paths are normalized; session storage uses relative paths |
| Manual compaction | Users can trigger optimized compaction; compaction selection is asynchronous and reports errors |
| Git context | Automatically injects current branch, status, recent commits, and related data with a config switch |

### Token And Cost Visibility

| Entry | Usage | Display |
| --- | --- | --- |
| TUI Context usage | Run `/context` in a session or choose `Context usage` from the command palette | Shows current context window, model, used/available tokens, and Prompt/Conversation/Window category grid |
| Context usage footer | Bottom of the TUI panel | With session usage, shows `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; without cumulative usage, shows `Used`, `Free`, `Usable`, `Buffer` |
| Session list cost column | `opencode session list --cost` or `opencode session list -c` | Adds `Cost` and `Tokens` columns to session list to find cost hotspots quickly |
| Single-session details | `opencode session info -s <Session_ID>` | Shows `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` by provider/model |
| Global stats | `opencode stats --models` | Summarizes total cost, daily average cost, average tokens, tool usage, and model usage |

Internal stats prefer request usage data and fall back to message metadata for older sessions. TUI Context usage also estimates instruction, skills, tool definitions, attachments, tool results, and compaction summary usage in the context window.

### Tool System

| Tool | Enhancement |
| --- | --- |
| Read | Metadata, stub, default read line count, byte limits, device-file protection |
| Grep/Ripgrep | Limits maximum files and result counts, with clear errors for overly broad searches |
| Shell | bash, PowerShell, and cmd use shell-aware prompts separately |
| Write | Automatically generates a diff when overwriting files so users can confirm the actual change |
| Permission | Parent-agent permissions are filtered before passing to subtasks; tool availability checks are stricter |

### Optional MCP Integration

If you need ChatGPT Web assistance, consider connecting [chatgpt-browser-agent-smark](https://github.com/SMARK2022/chatgpt-browser-agent-smark). It reuses a logged-in ChatGPT browser session through a local MCP bridge, making it suitable for ChatGPT ask, image generation, and voice transcription from OpenCode; installation, authorization, and browser-state handling remain governed by that project's README.

### Provider And Models

| Capability | Description |
| --- | --- |
| Provider aliases | Configure multiple accounts or endpoints for the same underlying provider |
| Client version override | Adapt custom providers, compatibility proxies, and special API endpoints |
| ClaudeCode provider | Supports API Key, Base URL, and dynamic authentication modes |
| Cloudflare AI Gateway | Routing fixes; tool streaming is disabled by default for non-Anthropic models |

### VS Code Notebook Integration

Before using Notebook tools, install the VS Code extension [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). The extension version remains `1.15.5` and can continue to work with SMARK CLI `1.15.7`; it does not need an upgrade for this CLI README update. The extension creates a local authenticated bridge between VS Code/Jupyter Notebook and the OpenCode CLI; without it installed or connected, the CLI cannot reliably read, edit, or run notebook cells.

After startup, the extension opens a local bridge on `127.0.0.1:<random port>` and writes a heartbeat manifest to `~/.local/state/opencode/ide/<uuid>.json`. OpenCode automatically selects the matching VS Code bridge by workspace and notebook path. In remote SSH, WSL, or container setups, the CLI must run on the same side that can access the bridge.

| Tool | Purpose |
| --- | --- |
| `vscode_notebook_summary` | Get stable `#VSC-*` IDs, display index, type, language, execution state, output summary, dirty state, and runtime info for notebook cells |
| `vscode_notebook_source` | Read notebook source with 1-based global virtual line numbers; returned content is limited to 16KB by default |
| `vscode_notebook_edit` | Insert, edit, or delete cells; supports exact `oldCode/newCode` string replacement and code/markdown type switching |
| `vscode_notebook_run` | Run one code cell or a stable-ID range through VS Code/Jupyter; range execution stops on failure or timeout |
| `vscode_notebook_output` | Read text, image, HTML, JSON, and other outputs; large outputs are written to `.opencode/cache/notebook-outputs/` and returned as artifact paths |
| `vscode_notebook_env` | Inspect kernel/runtime, trigger kernel selection, restart kernel, or save a notebook when explicitly requested by the user |

Recommended flow: use `vscode_notebook_summary` to get the current cell ID, `vscode_notebook_source` to read the target cell, `vscode_notebook_run` to validate after editing, and `vscode_notebook_output` to inspect results. Do not treat display index `cN` as a stable long-term reference; after inserts, deletes, or type switches, use the new `#VSC-*` ID returned by the tool or run summary again.

### Cross-Platform Support

| Platform Issue | Handling |
| --- | --- |
| Windows encoding | Auto-detect UTF-8/UTF-16LE and repair pipe mojibake |
| PowerShell | CLIXML decoding, stderr normalization, UTF-8 output repair |
| Path differences | Normalize casing, separators, and global session paths |
| Line endings | Preserve original CRLF/LF style when applying patches |
| WSL | Maintain migration and cross-platform build guides |

---

## Agents

OpenCode includes multiple built-in primary agents that can be switched with `Tab`. The default agent can be overridden with `default_agent`; subagents are mainly invoked by task dispatch or `@agent`.

| Agent | Type | Permission Model | Best For |
| --- | --- | --- | --- |
| `build` | primary | Default development mode; runs tools according to configured permissions, allows question confirmation and entering plan | Implementing features, fixing bugs, running tests, end-to-end delivery |
| `interactive` | primary | More conservative interactive mode; `bash`, notebook execution, and notebook environment operations ask by default | Tasks needing confirmation for key commands or lower risk of accidental operations |
| `auto` | primary | Enabled only when selected explicitly; `bash`, `edit`, and shell external directory access enter auto permission review | Automatically reviewing shell/edit risk without changing default build behavior accidentally |
| `decide` | primary | Disables tools and makes a one-shot judgment from limited recent context | Lower-cost one-off decisions, tradeoffs, and next-step choices with a high-performance model |
| `plan` | primary | Disallows edit tools and notebook changes; allows writing plan files and exiting plan | Code analysis, planning, risk review, pre-execution design |
| `general` | subagent | General subagent; forbids `todowrite`, otherwise follows merged permission config | Complex search, multi-step research, parallelizable support tasks |
| `explore` | subagent | Allows only search, read, list, web query, and similar exploration tools | Quickly locating files, symbols, call chains, config, and docs |
| `scout` | subagent, experimental | Targets external docs and dependency source; allows managed repo cache reads | Inspecting third-party library implementation, cloning dependency source, researching external API behavior |

`title`, `summary`, and `compaction` are hidden system agents for title generation, summaries, and compaction flows, not daily manual switching targets. Learn more about [Agents](https://opencode.ai/docs/agents).

---

## Documentation

| Resource | Link |
| --- | --- |
| Official docs | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Contributing guide | [CONTRIBUTING.md](../../CONTRIBUTING.md) |

---

## FAQ

### How is this different from Claude Code?

The capability target is similar, but OpenCode focuses on open source, terminal-first usage, provider independence, client/server architecture, and an extensible tool system. The SMARK branch further strengthens Windows/PowerShell, VS Code Notebook, token visibility, network proxy support, and installation experience.

### Who is this branch for?

If you often develop in the terminal, need auditable agent behavior, or use AI coding agents in Windows/PowerShell or VS Code Notebook scenarios, this branch provides a more complete experience than upstream defaults.

### Why does the installer not use sudo by default?

User-level installation is safer and easier to manage. The installer writes to a user directory by default and refuses implicit sudo. Only use `sudo env ... --allow-sudo` when you explicitly install into a system directory such as `/usr/local/bin`; also consider `--no-modify-path` to avoid root modifying user profiles.

### What if an old opencode already exists on the system?

The installer only trusts the target install path. Even if `/usr/local/bin/opencode` already has the same version, specifying `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` still installs to `~/.local/bin/opencode` and will not be blocked by an old binary in PATH.

---

## Contributing

Read the [contributing guide](../../CONTRIBUTING.md) before submitting a PR. If your own project name uses `opencode`, state in its README that it is not an official OpenCode team project and is not affiliated with the OpenCode team.

---

## Community

**Join our community** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
