<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">开源的 AI Coding Agent — SMARK 增强分支</p>
<p align="center">
  <a href="https://github.com/anomalyco/opencode/tree/dev"><img alt="Upstream dev branch" src="https://img.shields.io/badge/upstream-dev-6b7280?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="Upstream npm version" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square&label=upstream%20npm" /></a>
  <a href="https://github.com/SMARK2022/opencode/tree/dev-smark"><img alt="SMARK branch" src="https://img.shields.io/badge/SMARK%20branch-dev--smark-0969da?style=flat-square" /></a>
  <a href="https://github.com/SMARK2022/opencode/releases"><img alt="Current SMARK version" src="https://img.shields.io/badge/current-1.15.6-f97316?style=flat-square" /></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> |
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

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

> **关于本分支**：这是 OpenCode 的 `dev-smark` 增强分支（当前版本 `1.15.6`，CLI release tag 为 `v1.15.6-smark`）。它基于上游 `dev` 分支，重点增强 TUI 交互、会话管理、Token 统计、Windows/PowerShell 兼容、VSCode Notebook 集成、网络代理与安装体验。

---

## 快速安装

推荐使用 SMARK 分支发布页中的安装脚本。默认会安装最新 release，并把安装目录写入已有的 shell profile。

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

安装后验证：

```bash
opencode --version
which opencode
```

如果当前 shell 还没有刷新 PATH，可以重新打开终端，或按安装日志提示 source 对应的 profile。

### 指定安装目录

用户级安装推荐放到 `~/.local/bin`。注意环境变量必须传给右侧执行 installer 的 `bash`，不要只传给 `curl`。

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

更适合排查问题的写法是先下载脚本，再执行：

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

不要这样写：

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

这种写法只会把 `OPENCODE_INSTALL_DIR` 传给 `curl`，不会传给真正运行安装脚本的 `bash`。

### 指定版本

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.6-smark
```

这条命令是完整写法：`bash -s --` 表示让 `bash` 从 stdin 读取 installer，并把后面的 `--version 1.15.6-smark` 作为 installer 参数传入。版本参数可以写 `1.15.6-smark`，也可以写 release tag 形式的 `v1.15.6-smark`。

### 安装脚本行为

| 场景 | 行为 |
| --- | --- |
| 默认安装目录 | `$OPENCODE_INSTALL_DIR`，然后 `$XDG_BIN_DIR`，最后 `$HOME/.opencode/bin` |
| 目标路径已有同版本 | 重新覆盖安装，用于刷新损坏或过期的二进制 |
| PATH 里其他位置已有同版本 | 只打印提示，不阻止安装到指定目录 |
| PATH 写入 | 默认更新所有已存在的受支持 profile，且不会重复写入 |
| sudo | 默认拒绝 `sudo` 启动；系统级安装需要显式传 `--allow-sudo` |
| macOS quarantine | 安装后自动尝试移除 `com.apple.quarantine` 属性 |
| checksum | 如果 release 提供 `checksums.txt`，会校验下载资产 |

### PATH 与 shell profile

安装脚本会识别并更新这些已存在的 profile：`.bashrc`、`.bash_profile`、`.profile`、`.zshrc`、`.zprofile`、`.zshenv`、`~/.config/bash/*`、`~/.config/zsh/*`、`~/.config/fish/config.fish`。

| 需求 | 命令 |
| --- | --- |
| 不修改 PATH | `bash /tmp/opencode-install --no-modify-path` |
| 只写入指定 profile | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| 交互选择 profile | `bash /tmp/opencode-install --interactive` |
| 系统目录安装 | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

如果你希望 `~/.local/bin/opencode` 优先于 `/usr/local/bin/opencode`，请确保 profile 里的 PATH 顺序类似这样：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 其他安装方式

这些方式适合使用上游包管理生态。若你需要 SMARK 分支版本，请优先使用上面的 GitHub release installer。

| 平台 | 命令 | 说明 |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | 也可使用 `bun`、`pnpm`、`yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | 上游 tap，通常更新较快 |
| macOS/Linux | `brew install opencode` | Homebrew 官方 formula，可能滞后 |
| Windows | `scoop install opencode` | Scoop 包 |
| Windows | `choco install opencode` | Chocolatey 包 |
| Arch Linux | `sudo pacman -S opencode` | 稳定包 |
| Arch Linux | `paru -S opencode-bin` | AUR 最新二进制包 |
| 任意系统 | `mise use -g opencode` | 通过 mise 管理工具版本 |
| Nix | `nix run nixpkgs#opencode` | 也可使用 GitHub 源运行开发版本 |

---

## 快速开始

```bash
cd <your-project>
opencode
```

启动后可以直接描述任务，例如“解释这个模块的架构”、“修复这个报错”、“给这个功能补测试”。TUI 内使用 `Tab` 切换 Agent，使用内置工具读写文件、运行命令、查看 diff、管理会话。

| 操作 | 说明 |
| --- | --- |
| `Tab` | 在可用 Agent 之间切换 |
| 会话列表 | 查看历史会话、搜索标题和消息内容 |
| Diff 预览 | 写文件前后展示 git diff 风格变更 |
| 手动压缩 | 长会话中主动压缩上下文，释放 token 空间 |
| Shell 工具 | 支持取消、输出压缩、PowerShell 输出规范化 |

---

## 桌面应用程序

SMARK `dev-smark` 分支当前只发布 CLI，不发布桌面应用安装包。需要桌面版（BETA）时，请以 [opencode.ai/download](https://opencode.ai/download) 和上游 release 说明为准；不要把 SMARK CLI release 页面当作 desktop 安装包来源。

---

## 核心特性

这个分支的重点不是简单堆功能，而是把真实开发中的高频痛点做成可观察、可恢复、可跨平台的工作流。

| 方向 | 解决的问题 | 你会看到的变化 |
| --- | --- | --- |
| TUI 交互 | 长输出、流式消息、diff 难读 | 实时渲染、可折叠推理、差异预览、状态即时更新 |
| 会话管理 | 长会话易丢上下文，恢复成本高 | 会话搜索、路径过滤、手动压缩、中断恢复、Session Warping |
| Token 统计 | 不知道上下文被什么消耗 | 输入/输出 token、工具结果、附件、请求开销分项展示 |
| 工具系统 | 文件读写和 shell 输出容易污染上下文 | Read 输出结构化、Shell 输出压缩、Write 自动 diff |
| Provider | 多账号、多端点、多模型配置复杂 | Provider 别名、客户端版本覆盖、ClaudeCode provider |
| VSCode | Notebook 场景无法被 CLI Agent 可靠操作 | 单元格概览、读取、编辑、执行、输出读取、内核管理 |
| Windows | PowerShell、编码、路径、CRLF 容易出错 | CLIXML 解码、UTF-8 修复、路径规范化、CRLF 保留 |
| 网络代理 | provider、插件、fetch 代理逻辑分散 | NetworkProxy 统一处理 HTTP_PROXY、HTTPS_PROXY、NO_PROXY |
| 守护进程 | 多实例、锁、健康检查、客户端连接复杂 | Server Lock、健康检查、HttpApi、PTY WebSocket 票据 |

### TUI 与交互体验

| 能力 | 细节 |
| --- | --- |
| 流式输出 | 助手消息和推理片段增量渲染，流式处理期间显示耗时 |
| 推理展示 | 长推理可折叠预览，减少屏幕占用 |
| 差异预览 | 文件覆盖时自动生成 git diff 风格视图，并显示增删行统计 |
| 会话列表 | 展示最近消息摘要，支持按标题和消息内容搜索 |
| 布局稳定性 | 滚动条、终端宽度、CJK 字符宽度处理更可靠 |
| Shell 模式 | 提供取消按钮、自定义图标、示例占位符和实时完成状态 |

### 会话与上下文管理

| 能力 | 细节 |
| --- | --- |
| 会话恢复 | 隐藏消息、撤销操作、待处理消息检查和错误恢复逻辑更稳 |
| 中断控制 | 记录中断次数和确认时间，父会话中断会传播到子任务 |
| 路径兼容 | Windows 全局会话路径规范化，会话存储使用相对路径 |
| 手动压缩 | 用户可以主动触发压缩，压缩选择异步处理并带错误提示 |
| Git 上下文 | 自动注入当前分支、状态、最近提交等信息，可配置开关 |

### Token 与成本可见性

| 入口 | 使用方式 | 展示内容 |
| --- | --- | --- |
| TUI Context usage | 在会话中执行 `/context`，或从命令面板选择 `Context usage` | 展示当前上下文窗口、模型、已用/可用 token、Prompt/Conversation/Window 分类网格 |
| Context usage footer | TUI 面板底部 | 有会话用量时显示 `Input`、`Output`、`Reason`、`Cache W/R`、`Cost`；无累计用量时显示 `Used`、`Free`、`Usable`、`Buffer` |
| 会话列表成本列 | `opencode session list --cost` 或 `opencode session list -c` | 在 session list 中追加 `Cost` 和 `Tokens` 列，便于按会话快速定位成本热点 |
| 单会话明细 | `opencode session info -s <Session_ID>` | 按 provider/model 展示 `Calls`、`Input`、`Cache Write`、`Cache Read`、`Output`、`Cost` |
| 全局统计 | `opencode stats --models` | 汇总总成本、日均成本、平均 token、工具使用和模型用量 |

内部统计会优先读取 request usage 数据；较旧会话没有 request usage 时，会回退到消息元数据。TUI 的 Context usage 还会估算 instruction、skills、tool definitions、附件、工具结果和 compaction summary 对上下文窗口的占用。

### 工具系统

| 工具 | 增强点 |
| --- | --- |
| Read | 元数据、stub、默认读取行数、字节限制、设备文件保护 |
| Grep/Ripgrep | 最大文件数和结果数限制，搜索过宽时给出明确错误 |
| Shell | bash、PowerShell、cmd 分别使用 shell 感知提示词 |
| Write | 覆盖文件时自动生成 diff，帮助用户确认实际修改 |
| 权限 | 父代理权限会过滤传递给子任务，工具可用性检查更严格 |

### Provider 与模型

| 能力 | 说明 |
| --- | --- |
| Provider 别名 | 同一底层 provider 可配置多个账号或端点 |
| 客户端版本覆盖 | 适配自定义 provider、兼容代理和特殊 API 端点 |
| ClaudeCode provider | 支持 API Key、Base URL 和动态鉴权模式 |
| Cloudflare AI Gateway | 路由修复，非 Anthropic 模型默认关闭 tool streaming |

### VS Code Notebook 集成

使用 Notebook 工具前，请先安装 VS Code 扩展 [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge)。当前扩展版本保持 `1.15.5`，可继续配合 SMARK CLI `1.15.6` 使用，不需要随本次 CLI README 更新而升级。该扩展负责在 VS Code/Jupyter Notebook 与 OpenCode CLI 之间建立本地鉴权 bridge；未安装或未连接时，CLI 无法可靠读取、编辑或执行 notebook 单元格。

扩展启动后会在 `127.0.0.1:<random port>` 开本地 bridge，并把带心跳的 manifest 写到 `~/.local/state/opencode/ide/<uuid>.json`。OpenCode 会按 workspace 与 notebook 路径自动选择匹配的 VS Code bridge；远程 SSH、WSL 或容器场景下，CLI 需要运行在能访问该 bridge 的同一侧环境。

| 工具 | 用途 |
| --- | --- |
| `vscode_notebook_summary` | 获取 notebook cell 的稳定 `#VSC-*` ID、显示序号、类型、语言、执行状态、输出摘要、dirty 状态和 runtime 信息 |
| `vscode_notebook_source` | 以 1-based 全局虚拟行号分页读取 notebook 源码，返回内容默认限制在 16KB 内 |
| `vscode_notebook_edit` | 插入、修改、删除 cell，支持 `oldCode/newCode` 精确字符串替换，也支持 code/markdown 类型切换 |
| `vscode_notebook_run` | 通过 VS Code/Jupyter 执行单个代码 cell 或稳定 ID 范围，范围执行遇到失败或超时会停止 |
| `vscode_notebook_output` | 读取文本、图片、HTML、JSON 等输出；大输出会写入 `.opencode/cache/notebook-outputs/` 并返回 artifact 路径 |
| `vscode_notebook_env` | 查看 kernel/runtime，触发 kernel 选择，重启 kernel，或在用户明确要求时保存 notebook |

推荐流程：先用 `vscode_notebook_summary` 获取当前 cell ID，再用 `vscode_notebook_source` 读取目标 cell，修改后用 `vscode_notebook_run` 验证，最后用 `vscode_notebook_output` 查看结果。不要把显示序号 `cN` 当成长期稳定引用；插入、删除或类型切换后应使用工具返回的新 `#VSC-*` ID 或重新 summary。

### 跨平台支持

| 平台问题 | 处理方式 |
| --- | --- |
| Windows 编码 | 自动检测 UTF-8/UTF-16LE，修复管道乱码 |
| PowerShell | CLIXML 解码、stderr 规范化、UTF-8 输出修复 |
| 路径差异 | 大小写、分隔符、全局会话路径统一规范化 |
| 行结束符 | 补丁应用时保留 CRLF/LF 原始风格 |
| WSL | 维护迁移与跨平台构建指南 |

---

## Agents

OpenCode 内置多种 primary agent，可用 `Tab` 快速切换。默认 agent 可通过 `default_agent` 配置覆盖；子 agent 主要通过任务派发或 `@agent` 方式调用。

| Agent | 类型 | 权限模型 | 适合场景 |
| --- | --- | --- | --- |
| `build` | primary | 默认开发模式，按配置权限执行工具，允许问题确认和进入 plan | 实现功能、修复 bug、运行测试、端到端交付 |
| `interactive` | primary | 更保守的交互模式；`bash`、notebook 执行和 notebook 环境操作默认询问 | 需要用户确认关键命令、希望降低误操作风险的开发任务 |
| `auto` | primary | 显式选择才启用；`bash`、`edit` 和 shell 外部目录访问进入 auto permission review | 希望自动审查 shell/编辑风险，同时避免默认 build 行为被意外改变的场景 |
| `decide` | primary | 禁用工具，只基于有限近期上下文输出一次性判断 | 使用高性能模型做相对低成本的单次决策、方案取舍、下一步判断 |
| `plan` | primary | 禁止编辑工具和 notebook 变更，允许写入 plan 文件并退出 plan | 代码分析、方案制定、风险梳理、执行前规划 |
| `general` | subagent | 通用子代理，禁止 `todowrite`，其余遵循合并后的权限配置 | 复杂搜索、多步骤研究、可并行拆解的辅助任务 |
| `explore` | subagent | 只允许搜索、读取、列表、web 查询等探索工具 | 快速定位文件、符号、调用链、配置和文档 |
| `scout` | subagent，实验性 | 面向外部文档和依赖源码，允许 managed repo cache 读取 | 查询第三方库实现、克隆依赖源码、研究外部 API 行为 |

`title`、`summary`、`compaction` 是隐藏的系统 agent，用于标题生成、摘要和压缩流程，不是日常手动切换对象。了解更多 [Agents](https://opencode.ai/docs/agents) 相关信息。

---

## 文档

| 资源 | 链接 |
| --- | --- |
| 官方文档 | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| 贡献指南 | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## 常见问题

### 这和 Claude Code 有什么不同？

功能定位相近，但 OpenCode 的重点是开源、终端优先、provider 无关、客户端/服务器架构和可扩展工具系统。SMARK 分支在此基础上进一步强化 Windows/PowerShell、VSCode Notebook、Token 可见性、网络代理和安装体验。

### 这个分支适合谁？

如果你经常在终端里开发、需要可审计的 Agent 行为、需要在 Windows/PowerShell 或 VSCode Notebook 场景中使用 AI coding agent，这个分支会比上游默认体验更完整。

### 为什么安装脚本不默认使用 sudo？

用户级安装更安全，也更容易管理。安装脚本默认写入用户目录，并拒绝隐式 sudo。只有你明确要安装到 `/usr/local/bin` 这类系统目录时，才需要 `sudo env ... --allow-sudo`，并建议同时使用 `--no-modify-path` 避免 root 修改用户 profile。

### 如果系统里已经有旧的 opencode，会怎样？

安装脚本只以目标安装路径为准。即使 `/usr/local/bin/opencode` 已有同版本，只要你指定 `OPENCODE_INSTALL_DIR="$HOME/.local/bin"`，脚本仍会安装到 `~/.local/bin/opencode`，不会被 PATH 上的旧二进制拦截。

---

## 参与贡献

提交 PR 前请阅读 [贡献指南](./CONTRIBUTING.md)。如果你在自己的项目名中使用 `opencode`，请在 README 中说明该项目并非 OpenCode 团队官方项目，也不与 OpenCode 团队存在关联。

---

## 社区

**加入我们的社区** [飞书](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
