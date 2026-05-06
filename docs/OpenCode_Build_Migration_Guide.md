# OpenCode 项目 WSL 迁移与跨平台构建指南

本文档详细记录了将 OpenCode 项目从 Windows 环境迁移到 WSL (Ubuntu 22.04)、解决在此过程中遇到的各种构建与环境问题，并最终成功构建出 Linux、macOS 和 Windows 多平台发布包的全过程。

---

## 1. 我们做了什么？(What did we do?)

在本次构建和代码修改中，我们主要完成了以下工作：

1. **修复了 Token 计算累加的 Bug**：
   - 修改了 `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` 和其他 UI 组件，解决了在多步 TUI 对话中 token 计数在每步结束后被错误重置为 0 的问题，使得 Token 能够正确持续累加。

2. **实现版本号自定义与硬编码替换**：
   - 默认情况下 `@opencode-ai/script` 会在模块初始化时自动读取 `package.json` 中的版本号。
   - 为了能在构建命令中动态指定版本号（如 `1.14.25-smark`），我们新建了 `packages/opencode/script/version-env.ts`。
   - 修改了 `build.ts`，在第一行优先引入 `import "./version-env"`，从而在模块评估前将环境变量 `OPENCODE_VERSION` 设置好，成功将版本号变更为 `1.14.25-smark`。

3. **支持跨平台精准构建 (新增 `--os` 参数)**：
   - 原本的 `build.ts` 只支持 `--single`（仅构建当前操作系统）或者全量构建所有 12 个目标平台（耗时极长）。
   - 我们在 `build.ts` 中引入了 `osFilter` 逻辑，允许通过传入 `--os=darwin`、`--os=win32` 或 `--os=linux` 来精准构建特定操作系统的二进制包。

4. **优化 Bash 输出压缩流水线以节省 LLM Token 成本**：
   - 实施了四阶段（Phase 1-4）优化，包括 Secret Redaction (API Key 脱敏)、虚拟终端 ANSI 解析、时间戳与哈希模板化近重复压缩，以及基于 Rolling Hash 的多行块压缩加速。
   - 实现了专门的命令适配器（npm, pytest, Docker, tsc），在命令执行后提取结构化摘要。
   - 优化了诊断队列（分为 first、fatal、recent 三组），并且仅在命令失败时才输出诊断附录。

5. **优化 TUI 终端界面体验 (滚动条与工具折叠)**：
   - 在 TUI 侧为 `Edit`、`Write`、`ApplyPatch` 添加了类似于 Bash 工具的交互。当内容修改超过 20 行时，默认收缩并只显示前 10 行，点击提示即可展开，避免长篇代码刷屏。
   - 修复了 TUI 中滚动条默认隐藏的问题，将配置修改为 `scrollbar_enabled` 默认开启，并调整了颜色 (`theme.textMuted`) 确保与主题适配，修复了滚动条与侧边栏之间的空隙。

6. **成功构建全平台产物 (并提取到了 `dist/` 目录)**：
   - 编写了一键编译打包脚本 `wsl_build.sh`。
   - **Linux**: `opencode_1.14.25-smark_amd64.deb` (包含 x64 平台二进制文件) 以及 `opencode-linux-x64-1.14.25-smark.tar.gz`。
   - **macOS**: `opencode-darwin-arm64-1.14.25-smark.tar.gz` 和 `opencode-darwin-x64-1.14.25-smark.tar.gz`。
   - **Windows**: `opencode-windows-arm64-1.14.25-smark.zip` 和 `opencode-windows-x64-1.14.25-smark.zip`。

---

## 2. 之前遇到了什么问题？如何解决的？(Issues & Solutions)

在将 Windows 代码放入 WSL 并在 Linux 下执行构建时，我们遇到了几个非常棘手的阻碍：

### 问题 1：`bun install` 永久卡住 / 无限挂起
- **现象**：在 WSL 中直接运行 `bun install` 会在 `[12/121] Resolving dependencies` 或下载阶段卡住几十分钟。
- **原因**：Bun 默认会执行海量 Workspace 内部包（如 app、storybook 等）的 `postinstall` 生命周期脚本，在跨文件系统（WSL 读取 Windows 目录）或者网络波动时极易死锁。
- **解决**：使用纯净安装命令并忽略脚本执行：`bun install --ignore-scripts --no-progress`，该命令能在 1 分钟内完成全量依赖树解析和下载。

### 问题 2：`.bun/install/cache/` 缓存内出现 0 字节文件
- **现象**：安装依赖后，构建时抛出类似 `Failed to parse package.json` 的错误，发现 `node_modules` 中诸如 `minipass`, `ignore-walk`, `minimatch` 等部分模块的 `package.json` 大小为 0 字节。
- **原因**：这通常是因为 Bun 从某些国内 CDN（如 npmmirror）下载 tarball 时硬链接写入失败导致的。
- **解决**：编写了一个 Shell 脚本 `fix_bun_pkgs.sh`，直接通过 `curl` 从官方 `registry.npmjs.org` 下载受损包的 `.tgz`，解压并覆盖覆盖破损的目录，从而修复了依赖树。

### 问题 3：CRLF (Windows 换行符) 导致 `.patch` 补丁应用失败
- **现象**：运行需要打补丁的包时（如 `@npmcli/agent`），抛出 `error: patch failed`。
- **原因**：在 Windows 上用 Git clone 的代码，`patches/` 目录下的 `.patch` 文件变成了 `CRLF`（回车换行），而 Linux 下的 `patch` 工具只能识别 `LF`。
- **解决**：使用 `sed -i 's/\r$//' patches/*.patch` 移除了所有补丁文件中的 Windows 回车符。

### 问题 4：缺失特定平台的原生依赖 `@parcel/watcher`
- **现象**：构建 macOS 和 Windows 版本时，报错找不到 `@parcel/watcher-darwin-arm64` 等原生 C++ 扩展包。
- **原因**：Linux 环境下默认只安装了 Linux 版本的 watcher。
- **解决**：使用 `bun add @parcel/watcher-darwin-arm64@2.5.1` 或借助 Bun 缓存手动拷贝对应的交叉编译原生包到 `node_modules/@parcel/` 目录下。

---

## 3. 下次如何将项目迁移到新的 WSL 或 Ubuntu 系统？

如果你需要在一个**全新的 Ubuntu / WSL 系统**中重新构建该项目，请严格按照以下步骤操作：

### 步骤 1：准备基础环境
确保系统中已安装必要的工具：
```bash
sudo apt update
sudo apt install -y curl unzip zip build-essential rsync file dpkg-dev
# 安装 Bun (推荐 1.3.13 或以上版本)
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
```

### 步骤 2：拷贝/同步源码 (切断与 Windows 文件系统的联系)
**【极其重要】**不要直接在 `/mnt/c/` 或 `/mnt/f/` 这种 Windows 挂载盘里执行 `bun install`。跨系统的 I/O 性能极差且极易导致文件系统锁死。
请将代码拷贝到 Linux 原生文件系统（如 `~/opencode`）下：
```bash
# 假设 Windows 源码在 /mnt/f/ML/PythonAIProject/Claude-Code/opencode
rsync -av --exclude "node_modules" --exclude "dist" --exclude ".git" /mnt/f/ML/PythonAIProject/Claude-Code/opencode ~/opencode
cd ~/opencode
```

### 步骤 3：修复 Windows 换行符 (CRLF -> LF)
清理 `.patch` 文件和 shell 脚本的换行符：
```bash
find . -type f -name "*.patch" -exec sed -i 's/\r$//' {} +
find . -type f -name "*.sh" -exec sed -i 's/\r$//' {} +
```

### 步骤 4：安装依赖
执行纯净且跳过脚本的安装：
```bash
bun install --ignore-scripts --no-progress
```
*如果在这一步依然遇到 0 字节文件报错，请使用之前编写的 `fix_bun_pkgs.sh` 进行针对性修复。*

### 步骤 5：安装平台原生拓展 (跨平台构建必须)
如果你需要构建 Linux 之外的系统（如 macOS 或 Windows），必须补全对应的 C++ 原生包：
```bash
cd packages/opencode
# 安装 macOS watcher
bun add @parcel/watcher-darwin-arm64@2.5.1 @parcel/watcher-darwin-x64@2.5.1 --no-progress
# 安装 Windows watcher
bun add @parcel/watcher-win32-arm64@2.5.1 @parcel/watcher-win32-x64@2.5.1 --no-progress
```

---

## 4. 后续开发：修改代码后如何重新构建？

基于目前已经修改好的 `build.ts`，你可以非常方便地选择要打包的操作系统。

### 前提
每次修改 TypeScript 源码后（例如修改了 UI 或是修复了 Bug），无需其他特殊操作，只要进入 `packages/opencode` 即可使用 `build.ts` 重新编译出单一的可执行二进制文件。

### 场景 A：我想重新构建 Linux (Ubuntu) 用的二进制
```bash
cd ~/opencode/packages/opencode
# 构建 Linux 版本 (包含 x64 和 arm64)
bun run script/build.ts --version=1.14.19-smark --os=linux --skip-install --skip-embed-web-ui
```
> **生成 `.deb` 安装包：**
> 编译完毕后，二进制文件会在 `dist/opencode-linux-x64/bin/opencode`。
> 将该二进制放到 `debian/usr/bin/` 结构下，然后运行 `dpkg-deb --build debian opencode_1.14.19-smark_amd64.deb` 即可（参考根目录的 `make_deb.sh`）。

### 场景 B：我想重新构建 macOS 用的版本
```bash
cd ~/opencode/packages/opencode
# 必须使用 --os=darwin 安装依赖，获取 macOS 原生的 .dylib 绑定（如 @opentui 的 native 包）
bun install --os=darwin --no-progress || true
# --os=darwin 会自动匹配 M芯片(arm64) 和 Intel(x64) 并触发交叉编译
bun run script/build.ts --version=1.14.25-smark --os=darwin --skip-embed-web-ui

# 打包产物为 tar.gz
cd dist/opencode-darwin-arm64/bin/
tar -czf opencode-darwin-arm64.tar.gz opencode
```

### 场景 C：我想重新构建 Windows 用的 `.exe` 版本
```bash
cd ~/opencode/packages/opencode
# 安装 Windows 的原生绑定
bun install --os=win32 --no-progress || true
# 构建 Windows
bun run script/build.ts --version=1.14.25-smark --os=win32 --skip-embed-web-ui

# 打包产物为 zip (需要预先 apt install zip)
cd dist/opencode-windows-x64/bin/
zip opencode-windows-x64.zip opencode.exe
```

---

## 5. 如何使用全自动化构建脚本 (推荐)？

为了简化上述流程，我们在项目根目录编写了 `wsl_build.sh`。该脚本可实现从 **代码同步 -> 修复换行符 -> 依赖安装 -> 原生拓展编译 -> 交叉编译各系统平台 -> 压缩打包** 的全自动流程。

### 使用方法

你无需进入 WSL 的命令行环境，直接在 Windows 中通过 PowerShell 调用该脚本即可：

```powershell
wsl bash /mnt/f/ML/PythonAIProject/Claude-Code/wsl_build.sh
```

### 产物提取

编译打包完成后，由于脚本中设置了输出目录 `OUT_DIR="/mnt/f/ML/PythonAIProject/Claude-Code/dist"`，所有产物将会自动汇总并导出到 Windows 的 `./dist` 文件夹下。

**包含的免 sudo（绿色版）和安装版包如下**：
- `opencode-windows-x64-1.14.25-smark.zip`
- `opencode-windows-arm64-1.14.25-smark.zip`
- `opencode-darwin-x64-1.14.25-smark.tar.gz`
- `opencode-darwin-arm64-1.14.25-smark.tar.gz`
- `opencode-linux-x64-1.14.25-smark.tar.gz` （Linux 免安装绿色版，解压直接运行）
- `opencode_1.14.25-smark_amd64.deb` （Ubuntu / Debian 系统的可安装包）

---

### 常见疑问解答：
- **`--skip-embed-web-ui`**：如果你没有修改 Web UI 侧的代码（不需要内嵌前端应用），带上这个参数可以大幅度提升编译速度并避免报错。
- **关于 `--skip-install` 与跨平台原生依赖**：
  - 构建 Linux 版本时，可以使用 `--skip-install`。
  - **但在构建 macOS 和 Windows 版本时，绝对不要使用 `--skip-install`**。如果在跨平台交叉编译时跳过安装，打包出来的二进制文件中就会嵌入 Linux 的原生绑定库（如 `@opentui` 的 `.so` 而不是 `.dylib`），导致在目标系统运行报错：`Symbol "setClearOnShutdown" not found in "...dylib"`。
  - 必须在构建对应系统前运行 `bun install --os=darwin --no-progress || true` 等命令，拉取目标系统的原生包。
- **如何验证修改是否生效**：在 Linux 下编译完后，可以直接运行 `./dist/opencode-linux-x64/bin/opencode --version` 测试，如果输出的不仅是 `1.14.25-smark` 并且你的功能生效，就可以执行打包和分发了。