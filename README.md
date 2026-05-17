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
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
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

<!-- TODO: 替换为实际的 TUI 主界面截图 -->
[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

> **关于本分支**：这是 OpenCode 的 `dev-smark` 增强分支（当前版本 `1.14.42-smark`），在上游 `dev` 分支基础上进行了大量功能增强和跨平台适配，涵盖 TUI 交互、会话管理、Token 统计、Windows 兼容、VSCode 集成、网络代理等多个维度。

---

## 目录

- [安装](#安装)
- [桌面应用程序](#桌面应用程序)
- [核心特性](#核心特性)
  - [终端界面 (TUI) 增强](#终端界面-tui-增强)
  - [会话管理与生命周期](#会话管理与生命周期)
  - [Token 统计与上下文管理](#token-统计与上下文管理)
  - [工具系统增强](#工具系统增强)
  - [Provider 与模型管理](#provider-与模型管理)
  - [VSCode 深度集成](#vscode-深度集成)
  - [跨平台与 Windows 支持](#跨平台与-windows-支持)
  - [网络代理与连接管理](#网络代理与连接管理)
  - [守护进程与服务架构](#守护进程与服务架构)
  - [构建与 CI/CD](#构建与-cicd)
- [Agents](#agents)
- [文档](#文档)
- [常见问题 (FAQ)](#常见问题-faq)
- [社区](#社区)

---

## 安装

```bash
# 直接安装 (支持版本指定)
curl -fsSL https://opencode.ai/install | bash

# 指定版本安装
OPENCODE_VERSION=1.14.42 curl -fsSL https://opencode.ai/install | bash

# 软件包管理器
npm i -g opencode-ai@latest        # 也可使用 bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS 和 Linux（推荐，始终保持最新）
brew install opencode              # macOS 和 Linux（官方 brew formula，更新频率较低）
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # 任意系统
nix run nixpkgs#opencode           # 或用 github:anomalyco/opencode 获取最新 dev 分支
```

> [!TIP]
> 安装前请先移除 0.1.x 之前的旧版本。安装脚本已增强错误处理和环境变量配置支持。

### 安装目录

安装脚本按照以下优先级决定安装路径：

1. `$OPENCODE_INSTALL_DIR` - 自定义安装目录
2. `$XDG_BIN_DIR` - 符合 XDG 基础目录规范的路径
3. `$HOME/bin` - 如果存在或可创建的用户二进制目录
4. `$HOME/.opencode/bin` - 默认备用路径

```bash
# 示例
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

---

## 桌面应用程序

OpenCode 也提供桌面版应用（BETA）。可直接从 [发布页](https://github.com/anomalyco/opencode/releases) 或 [opencode.ai/download](https://opencode.ai/download) 下载。

| 平台                  | 下载文件                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows (x64)         | `opencode-desktop-windows-x64.exe` |
| Windows (arm64)       | `opencode-desktop-windows-arm64.exe` |
| Linux                 | `.deb`、`.rpm` 或 `.AppImage`      |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

---

## 核心特性

### 终端界面 (TUI) 增强

本分支对 TUI 进行了全面的交互体验升级，使终端操作更加流畅和信息丰富。

<!-- TODO: 插入 TUI 主界面交互截图，展示流式输出和状态栏 -->

**流式输出与实时渲染**

- 流式消息处理：助手消息和推理部分实时渲染，支持动态内容更新
- 流式处理期间显示实时耗时计时器
- 文本部分渲染逻辑优化，支持增量流式处理
- 推理部分可展开预览，避免长推理链占据过多屏幕空间

<!-- TODO: 插入流式输出效果截图 -->

**差异预览与变更展示**

- 预览差异功能：在 TUI 中以 git diff 格式展示文件变更
- 差异视图增强：添加行统计信息（增/删行数），优化显示逻辑
- 文件覆盖时自动生成 diff，直观展示变更内容

<!-- TODO: 插入 diff 预览界面截图 -->

**会话列表与对话管理**

- 会话列表支持内容预览（显示最近 2 行消息摘要）
- 会话搜索功能：支持通过标题或消息内容过滤会话
- DialogSelect 组件支持预览行，优化选项展示
- 会话标题自动生成与验证

<!-- TODO: 插入会话列表预览截图 -->

**滚动与布局优化**

- 滚动条渲染逻辑优化，提升大文本浏览体验
- 滚动视图组件增强，支持动态展开和收缩
- macOS 和 Windows 终端宽度处理逻辑优化，支持用户覆盖设置
- CJK 字符渲染修复：强制使用 Unicode 宽度表解决 macOS 上中日韩字符对齐问题

**组件与交互改进**

- BlockTool 组件可折叠逻辑优化，使用响应式信号提升性能
- Prompt 组件重构：添加 `renderBefore` 属性，支持自定义边框处理
- Shell 模式 UI：带取消按钮、自定义图标和示例占位符
- 工具完成状态实时更新显示
- 编辑器上下文集成：支持 Zed 编辑器多选区上下文

---

### 会话管理与生命周期

<!-- TODO: 插入会话管理流程图或状态图 -->

**会话状态与恢复**

- 会话助手状态管理增强，支持错误恢复机制
- 隐藏消息处理：支持撤销操作并在数据库中保留隐藏消息
- 会话初始化逻辑优化，防止异步消息加载导致的模型选择重置
- 待处理消息状态检查优化

**中断与控制**

- 中断处理功能：支持会话中断计数和确认时间追踪
- 子任务会话取消传播：确保父会话中断时子会话正确终止
- Shell 命令取消加固，防止僵尸进程

**会话路径与跨平台**

- 会话路径处理：支持 Windows 全局会话路径的规范化和兼容性
- 按路径过滤会话，支持禁用路径过滤的配置选项
- 会话存储相对路径，提升可移植性

**压缩与优化**

- 手动压缩功能：支持用户主动触发会话压缩
- 压缩选择处理改为异步，添加加载提示和错误处理
- 压缩摘要分隔符清理，优化压缩后的上下文质量
- Session Warping：支持跨工作区会话跳转

**Git 上下文集成**

- 添加与 Claude Code 一致的 git 上下文处理逻辑
- 自动获取当前分支、状态、最近提交等信息注入系统提示词
- 支持配置选项控制 git 上下文的启用/禁用

---

### Token 统计与上下文管理

本分支实现了精确的 Token 统计系统，让用户对每次请求的资源消耗一目了然。

<!-- TODO: 插入 Token 统计面板截图，展示输入/输出/breakdown 信息 -->

**精确 Token 统计**

- Token Accounting 系统：实现精确的 token 统计和分类
- 输入字符和令牌估算功能，支持从服务端获取实时估算
- 请求体字符数和估算 token 信息展示
- 流式处理期间从 `step-start` 事件提供 breakdown 信息

**上下文使用面板**

- 上下文使用面板：展示指令、技能、工具调用、工具结果的独立分类
- 输入信号节流优化，提升面板渲染性能
- 附件对输入字符的影响纳入计算
- 工具输出字符估算，完整反映上下文占用

**输入输出流量统计**

- 总输入输出统计，包含 `tool_delta` 的 token 计算
- 用户输入和请求开销估算
- 无助手消息时正确显示零值
- Token 流动状态的响应式管理（`createTokenFlowPulse`）

**输出压缩**

- Shell 输出压缩：自动检测并压缩重复输出内容
- 高熵行压缩：智能识别并压缩日志等高熵内容
- Bash 输出压缩配置化，支持用户自定义阈值

---

### 工具系统增强

<!-- TODO: 插入工具调用界面截图 -->

**Read 工具重构**

- 完整重构 read 工具：通过元数据处理和存根逻辑增强上下文管理
- 默认读取行数提升至 400 行，输出字节限制调整至 24KB
- 保留 XML 敏感内容，优化输出结构确保内容一致性
- 设备文件保护和恶意代码提醒

**Grep/Ripgrep 增强**

- 添加最大文件和结果限制，防止过于广泛的搜索导致性能问题
- 搜索结果 schema 迁移至 Effect，提升类型安全
- 过于广泛的搜索自动报错提示

**Shell 工具重构**

- Shell 感知提示词：针对 bash、pwsh/powershell、cmd 分别优化提示
- 输出压缩选项：自动压缩重复的终端输出
- PowerShell CLIXML 输出解码和规范化
- 工具输出截断限制可配置化

**Write 工具增强**

- 文件覆盖时自动生成 diff，以 git diff 格式展示变更

**工具管理与权限**

- 工具管理功能增强，优化权限合并逻辑
- 父代理权限过滤：子任务会话继承并过滤父代理权限
- 工具可用性检查更新
- 工具完成状态实时更新

**系统提示词增强**

- 环境详情注入：操作系统、Shell、平台信息
- Git 命令安全协议和多工具并行使用建议
- 工具使用指导优化，提升 Agent 工具调用准确性

---

### Provider 与模型管理

<!-- TODO: 插入 Provider 配置界面截图 -->

**Provider 别名系统**

- 别名支持：允许多个 provider 独立管理身份验证和模型继承
- 同一底层 provider 可配置多个别名实例，各自维护独立的 API Key

**版本覆盖**

- 支持自定义 provider 的客户端版本覆盖
- 灵活控制 SDK 版本以适配不同 API 端点

**ClaudeCode Provider**

- 添加 claudecode provider 支持，集成 API 密钥和基本 URL 配置
- 支持动态鉴权模式切换

**网络与兼容性**

- 移除 HttpClient 依赖，优化模型服务层
- Cloudflare AI Gateway 路由修复
- 非 Anthropic 模型默认关闭 tool streaming
- User-Agent 头标识客户端版本

---

### VSCode 深度集成

本分支实现了完整的 VSCode 笔记本（Notebook）操作能力，使 AI Agent 能够直接操作 Jupyter Notebook。

<!-- TODO: 插入 VSCode Notebook 操作截图 -->

**笔记本操作全套工具**

- `notebook_summary`：获取笔记本单元格概览（ID、类型、执行状态、输出摘要）
- `notebook_source`：读取笔记本源代码（分页虚拟文档，全局行号）
- `notebook_run`：执行代码单元格（支持单个/范围执行，超时控制）
- `notebook_edit`：编辑单元格（插入、修改、删除，精确字符串匹配替换）
- `notebook_output`：读取单元格输出（文本内联、图片/HTML 写入缓存）
- `notebook_env`：内核管理（info/configure/restart/save）

**VSCode Bridge 架构**

- Bridge Registry：支持多 VSCode 实例的桥接选择
- 文件锁机制序列化笔记本请求，防止并发冲突
- `bridgeUriToPath` 函数处理不同 URI 格式
- 扩展 ID 更新和许可证文件添加

**IDE 插件 SDK 重构**

- 整个 IDE 侧插件 SDK 结构重构
- 笔记本相关权限选项集成到 Agent 配置
- 增强单元格 ID 解析和错误处理

---

### 跨平台与 Windows 支持

本分支对 Windows 平台进行了全面适配，确保在 Windows 环境下的稳定运行。

<!-- TODO: 插入 Windows 终端运行截图 -->

**文本编码处理**

- 自动文本解码器：支持 UTF-8 和 UTF-16LE 编码的自动检测与解码
- 多种文本编码支持，包括自动检测和显式编码策略
- Windows 管道读取乱码问题修复

**行结束符与路径**

- 行结束符处理：补丁应用时保留原始行结束符（CRLF/LF）
- 目录规范化：优化 Windows 路径比较（大小写不敏感、分隔符统一）
- 会话路径规范化：支持 Windows 全局会话路径兼容

**PowerShell 支持**

- PowerShell CLIXML 输出解码和规范化，确保输出为纯文本
- PowerShell stderr 字节保持不变并进行规范化
- PowerShell UTF-8 输出编码修复
- Shell 感知提示词针对 PowerShell 专门优化

**构建与运行时**

- Windows 构建架构支持（x64/arm64）
- VSIX 打包逻辑优化，避免 Windows 环境中的 npm 路径问题
- Husky 脚本 Windows Bun 命令路径修复
- 插件加载路径 Windows 兼容

**WSL 支持**

- WSL 迁移与跨平台构建指南文档

---

### 网络代理与连接管理

<!-- TODO: 插入网络代理配置示意图 -->

**NetworkProxy 模块**

- 引入 NetworkProxy 核心模块，统一管理所有出站请求的代理配置
- 支持插件和 provider 的 fetch 请求代理
- 全局 fetch 安装，确保所有网络请求经过代理层
- npm 配置中的超时设置优化

**代理路由**

- 代理路由逻辑优化，智能判断请求是否需要代理
- TTL 常量调整，优化连接复用
- 环境变量代理处理逻辑增强（`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`）
- 全局 fetch 被 mock 时仍能正确路由的保障

---

### 守护进程与服务架构

<!-- TODO: 插入守护进程架构图 -->

**Daemon 生命周期管理**

- 守护进程启动和服务器选举超时常量
- 心跳���制优化，确保活动管理的可靠性
- 服务器锁处理（Server Lock），防止多实例冲突
- 实例处置逻辑修复，确保正确关闭

**HttpApi 架构迁移**

- 完整的 HttpApi 桥接层：将所有路由从 Hono 迁移至 Effect HttpApi
- 原生 Bun.serve + WebSocket 升级的 HttpApi 监听器
- OpenAPI 规范自动生成，与 Hono 输出保持一致性校验
- PTY WebSocket 认证票据机制

**Effect 架构重构**

- CLI 命令全面迁移至 `effectCmd` 模式
- InstanceContext 自动释放
- AppRuntime.runPromise 桥接逐步移除
- 服务层 Effect-native 端到端重构

---

### 构建与 CI/CD

**多平台构建**

- GitHub Actions 工作流：支持 Linux、macOS、Windows 三平台构建
- 自动触发构建（dev-smark push）
- 版本自动提取和资产上传
- 操作系统过滤功能优化目标构建

**安装脚本增强**

- 支持 `OPENCODE_VERSION` 环境变量指定安装版本
- 增强错误处理和输出信息
- `--version` 参数支持

---

## Agents

OpenCode 内置多种 Agent，可用 `Tab` 键快速切换：

- **build** — 默认模式，具备完整权限，适合开发工作
- **plan** — 只读模式，适合代码分析与探索
  - 默认拒绝修改文件
  - 运行 bash 命令前会询问
  - 便于探索未知代码库或规划改动

另外还包含以下子 Agent：

- **general** — 用于复杂搜索和多步任务，可在消息中输入 `@general` 调用
- **interactive** — 交互式代理，增强权限管理
- **review** — 审查代理，专注代码审查场景

了解更多 [Agents](https://opencode.ai/docs/agents) 相关信息。

---

## 文档

更多配置说明请查看我们的 [**官方文档**](https://opencode.ai/docs)。

---

## 常见问题 (FAQ)

### 这和 Claude Code 有什么不同？

功能上很相似，关键差异：

- **100% 开源**。
- **不绑定特定提供商**。推荐使用 [OpenCode Zen](https://opencode.ai/zen) 的模型，但也可搭配 Claude、OpenAI、Google 甚至本地模型。
- **内置 LSP 支持**。
- **聚焦终端界面 (TUI)**。OpenCode 由 Neovim 爱好者和 [terminal.shop](https://terminal.shop) 的创建者打造，持续探索终端的极限。
- **客户端/服务器架构**。可在本机运行，同时用移动设备远程驱动。TUI 只是众多潜在客户端之一。
- **完整的 Windows 支持**。包括 PowerShell 原生支持、路径规范化、编码自动检测等。
- **VSCode Notebook 集成**。AI Agent 可直接操作 Jupyter Notebook 单元格。
- **精确 Token 统计**。实时展示输入/输出 token 消耗和分类明细。

### 本分支 (dev-smark) 相比上游有什么额外优势？

- 全面的 Windows/PowerShell 跨平台适配
- 精确的 Token 统计与上下文使用面板
- VSCode Notebook 完整操作能力
- 网络代理统一管理
- 增强的会话管理（中断处理、路径过滤、手动压缩）
- Shell 输出智能压缩
- 流式渲染与差异预览优化
- 多平台 CI/CD 自动��建

---

## 参与贡献

如有兴趣贡献代码，请在提交 PR 前阅读 [贡献指南](./CONTRIBUTING.md)。

---

## 社区

**加入我们的社区** [飞书](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
