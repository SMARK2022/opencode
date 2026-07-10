<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="docs/readme/README.zh.md">简体中文</a> |
  <a href="docs/readme/README.zht.md">繁體中文</a> |
  <a href="docs/readme/README.ko.md">한국어</a> |
  <a href="docs/readme/README.de.md">Deutsch</a> |
  <a href="docs/readme/README.es.md">Español</a> |
  <a href="docs/readme/README.fr.md">Français</a> |
  <a href="docs/readme/README.it.md">Italiano</a> |
  <a href="docs/readme/README.da.md">Dansk</a> |
  <a href="docs/readme/README.ja.md">日本語</a> |
  <a href="docs/readme/README.pl.md">Polski</a> |
  <a href="docs/readme/README.ru.md">Русский</a> |
  <a href="docs/readme/README.bs.md">Bosanski</a> |
  <a href="docs/readme/README.ar.md">العربية</a> |
  <a href="docs/readme/README.no.md">Norsk</a> |
  <a href="docs/readme/README.br.md">Português (Brasil)</a> |
  <a href="docs/readme/README.th.md">ไทย</a> |
  <a href="docs/readme/README.tr.md">Türkçe</a> |
  <a href="docs/readme/README.uk.md">Українська</a> |
  <a href="docs/readme/README.bn.md">বাংলা</a> |
  <a href="docs/readme/README.gr.md">Ελληνικά</a> |
  <a href="docs/readme/README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

> **Database migration notice**: The SMARK branch includes custom database schema changes and migrations. Before switching from upstream `dev`, the main branch, or another original branch, create a manual backup of your local `opencode.db`; after migration, the database may not migrate or roll back cleanly to upstream or original branches. This project is not responsible for schema-format compatibility issues in your local database context data.

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```


### VS Code Notebook 集成

使用 Notebook 工具前，请安装 VS Code 扩展 [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge)。仓库内扩展版本为 `1.19.13`，推荐配合 SMARK CLI `1.19.15-smark`；两者独立版本化，Marketplace 可能仍显示旧版 `1.19.12` 直至新构建发布。该扩展在 VS Code 与 OpenCode CLI 之间建立本地鉴权 bridge；未安装或未连接时，CLI 无法可靠读取、编辑或执行 notebook 单元格。

扩展启动后会在 `127.0.0.1:<random port>` 开本地 bridge，并把带心跳的 manifest 写到 `~/.local/state/opencode/ide/<uuid>.json`。OpenCode 会按 workspace 与 notebook 路径自动选择匹配的 VS Code bridge；远程 SSH、WSL 或容器场景下，CLI 需要运行在能访问该 bridge 的同一侧环境。

V1 和 V2 的 LSP 功能固定禁用，统一提示 unavailable；扩展不启用语言诊断、跳转或符号查询，CLI 也不使用内置 LSP 或语言服务回退。Notebook 操作和文件编辑后的 formatter 最终内容及 diff 反馈仍然可用；unavailable 不能视为诊断通过或代替完整项目 typecheck。

| 工具 | 用途 |
| --- | --- |
| `vscode_notebook_summary` | 获取 notebook cell 的稳定 `#VSC-*` ID、显示序号、类型、语言、执行状态、输出摘要、dirty 状态和 runtime 信息 |
| `vscode_notebook_source` | 以 1-based 全局虚拟行号分页读取 notebook 源码，返回内容默认限制在 16KB 内 |
| `vscode_notebook_edit` | 插入、修改、删除 cell，支持 `oldCode/newCode` 精确字符串替换，也支持 code/markdown 类型切换 |
| `vscode_notebook_run` | 通过 VS Code/Jupyter 执行单个代码 cell 或稳定 ID 范围，范围执行遇到失败或超时会停止 |
| `vscode_notebook_output` | 读取文本、图片、HTML、JSON 等输出；大输出会写入 `.opencode/cache/notebook-outputs/` 并返回 artifact 路径 |
| `vscode_notebook_env` | 查看 kernel/runtime，选择、重启或停止 kernel，并在用户明确要求时创建或保存 notebook |

推荐流程：先用 `vscode_notebook_summary` 获取当前 cell ID，再用 `vscode_notebook_source` 读取目标 cell，修改后用 `vscode_notebook_run` 验证，最后用 `vscode_notebook_output` 查看结果。不要把显示序号 `cN` 当成长期稳定引用；插入、删除或类型切换后应使用工具返回的新 `#VSC-*` ID 或重新 summary。

### Optional MCP Integration

If you need ChatGPT Web assistance, consider connecting [chatgpt-browser-agent-smark](https://github.com/SMARK2022/chatgpt-browser-agent-smark). It reuses a logged-in ChatGPT browser session through a local MCP bridge, making it suitable for ChatGPT ask, image generation, and voice transcription from OpenCode. This branch records that project as the `thirdparty/chatgpt-browser-agent` submodule; after a fresh checkout, run `git submodule update --init --recursive thirdparty/chatgpt-browser-agent`, then run `npm ci` inside that directory. Login, authorization, and browser-state handling remain governed by that project's README.

### Session Management

| Capability | Description |
|---|---|
| Session search | Search history sessions by keyword and narrow the scope with path filters |
| Manual compaction | Trigger an optimized compaction on demand; compaction selection is asynchronous and reports errors while keeping a context summary |
| Interrupt recovery | Interrupt counts and confirmation time are recorded; parent-session interrupts propagate to subtasks |
| Session Warping | Long sessions keep advancing across contexts without a rebuild |

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
