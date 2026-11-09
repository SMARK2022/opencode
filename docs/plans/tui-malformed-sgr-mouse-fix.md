# TUI prompt 畸形 SGR mouse 报告注入修复方案

## 根因

某些终端 / IDE / 触摸屏在坐标不可用时向 stdin 发送畸形 SGR mouse 报告，例如：

```
ESC[<64;NaN;NaNM
```

标准 SGR mouse 格式为 `ESC[<button;x;yM`（或小写 `m` 表示释放），三个字段均为十进制整数。当字段值变成 `NaN`（JavaScript 数值字符串化结果），OpenTUI 0.3.4 `StdinParser` 的 `csi_sgr_mouse` 状态机在遇到第一个大写 `N`（ASCII 0x4E，落在 CSI final byte 范围 0x40–0x7E）时，将其当作 CSI final byte 结束当前序列，发出 `emitKeyOrResponse("csi", "\x1b[<64;N")`。剩余字节 `aN;NaNM` 进入 ground 状态，逐字符变成普通 key event。`TextareaRenderable.handleKeyPress()` 对无修饰键直接 `insertText(key.sequence)`，残片因此真实进入 prompt EditBuffer。

连续三条畸形报告 `ESC[<64;NaN;NaNM` × 2 + `ESC[<64;NaN;NaNm` × 1 正好产生用户看到的 `aN;NaNMaN;NaNMaN;NaNm`。

### 复现证据

直接调用 OpenTUI `StdinParser`（`bun -e`）：

```
输入: "\x1b[<64;NaN;NaNM"
输出: 8 个 key event，可打印部分 = "aN;NaNM"
```

通过真实 PTY 启动完整 alternate-screen TUI，向 stdin 注入上述三条报告，renderer 输出中包含：

```
ESC[38;2;238;238;238m ESC[48;2;30;30;30m aN;NaNMaN;NaNMaN;NaNm ESC[0m
```

异常文本被正常 fg/bg 样式包裹，证明它进入了 Textarea EditBuffer 并被正常渲染。

### 已排除的路径

- **颜色 SGR**：OpenTUI Zig `RGBA` 对非有限值归零，`u8` 通道无法输出字符串 `"NaN"`。
- **动画 / spinner**：`createFadeIn` 和 `createColors` 数学均有限。
- **token footer**：无法解释分号和 `M/m` 终止符。
- **resize / SIGWINCH**：可暴露异常但不能生成 `NaN`。
- **`opencode run` split-footer**：用户明确使用完整 TUI。
- **raw stdout 覆盖**：PTY 复现中异常文本被 Textarea 样式包裹，证明进入 EditBuffer。
- **OpenTUI 0.4.3**：parser 逻辑相同，未修复此问题。

## 已阅读文件

### 源码

| 文件 | 为什么相关 |
|------|-----------|
| `packages/opencode/src/cli/cmd/tui/app.tsx:122-143` | `rendererConfig()` 是 OpenCode 配置 OpenTUI renderer 的唯一入口，`prependInputHandlers` 在此注入 |
| `packages/opencode/src/cli/cmd/tui/app.tsx:215-292` | `createCliRenderer()` 调用和 renderer 生命周期 |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:1766-1834` | Textarea props 和 `onContentChange` |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:110-112` | `fadeColor()` 颜色辅助函数 |
| `packages/opencode/src/cli/cmd/tui/util/signal.ts:38-69` | `createFadeIn()` 动画 |
| `packages/opencode/src/cli/cmd/tui/ui/spinner.ts:199-244` | spinner 颜色派生 |
| `packages/opencode/src/cli/cmd/tui/context/theme.tsx:198-301` | 主题颜色解析 |
| `packages/opencode/src/cli/cmd/tui/context/local.tsx:46-103` | Agent 颜色解析 |
| `packages/opencode/src/cli/cmd/tui/keymap.tsx:123-152` | keymap 注册 |
| `packages/opencode/src/util/color.ts` | raw ANSI 颜色构造（有 hex 校验） |
| `packages/opencode/src/token/accounting.ts` | token 统计（无 NaN 进入 ANSI 路径） |

### OpenTUI 0.3.4 实现

| 文件 | 为什么相关 |
|------|-----------|
| `node_modules/@opentui/core/index-54s7pk0d.js:7698-7842` | `csi_sgr_mouse` 状态机——bug 所在 |
| `node_modules/@opentui/core/index-54s7pk0d.js:24260-24310` | `dispatchSequenceHandlers` 和 `handleStdinEvent`——handler 注入点 |
| `node_modules/@opentui/core/index-54s7pk0d.js:24324-24348` | `setupInput()`——`prependedInputHandlers` 注册顺序 |
| `node_modules/@opentui/core/index-0nvgrgam.js:5437-5465` | `TextareaRenderable.handleKeyPress()`——`insertText(key.sequence)` |
| `node_modules/@opentui/core/renderer.d.ts:45` | `prependInputHandlers?: ((sequence: string) => boolean)[]` 类型声明 |
| `node_modules/@opentui/core/lib/stdin-parser.d.ts` | `StdinParser` 公共接口 |
| `node_modules/@opentui/core/testing.d.ts` | `testRender` 测试接口 |

### 测试

| 文件 | 为什么相关 |
|------|-----------|
| `packages/opencode/test/cli/cmd/tui/spinner.test.tsx` | 现有 `testRender` + intrinsic 注册测试模式 |
| `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx` | 现有 Prompt + provider 测试模式 |
| `packages/opencode/test/cli/cmd/tui/prompt-interrupt.test.ts` | Prompt 行为测试模式 |
| `packages/opencode/test/fixture/tui-runtime.ts` | TUI 测试 fixture |

### 配置

| 文件 | 为什么相关 |
|------|-----------|
| `packages/opencode/src/cli/cmd/tui/config/tui-schema.ts:89` | `mouse` 配置字段 |
| `packages/opencode/src/cli/cmd/tui/app.tsx:123` | `OPENCODE_DISABLE_MOUSE` flag |
| `.opencode/tui.json` | 项目 TUI 配置（smoke plugin disabled） |

## 已确认的调用链

```
terminal / IDE 发送畸形 SGR mouse 报告
  → process.stdin "data" 事件
  → CliRenderer.stdinListener
  → StdinParser.push(data)
  → csi_sgr_mouse 状态遇到 N（0x4E）
  → isMouseSgrSequence 失败（final byte 不是 M/m）
  → emitKeyOrResponse("csi", "\x1b[<64;N")
  → 剩余字节 aN;NaNM 进入 ground 状态
  → 逐字符 emitKeyOrResponse
  → CliRenderer.handleStdinEvent(key)
  → dispatchSequenceHandlers(event.raw)   ← prependInputHandlers 在此调用
  → (当前无 handler 拦截)
  → KeyHandler.processParsedKey(event.key)
  → TextareaRenderable.handleKeyPress(key)
  → insertText(key.sequence)
  → Prompt onContentChange
  → store.prompt.input 被污染
```

## 必须保持的既有行为

1. 合法 SGR mouse 报告（全数字字段）继续作为 mouse event 处理。
2. 正常键盘输入、Kitty keyboard、bracketed paste 不受影响。
3. 用户直接键入或粘贴 `aN;NaNm`、`Number.isNaN` 等文本完整保留。
4. `mouse` 配置和 `OPENCODE_DISABLE_MOUSE` 行为不变。
5. 主题、Agent 颜色、spinner、动画不变。
6. Prompt textarea、extmark、autocomplete、history、stash、undo/redo、submit 不变。
7. renderer 创建、退出清理、keymap 注册顺序不变。

## 推荐方案

### 位置

`packages/opencode/src/cli/cmd/tui/app.tsx` 的 `rendererConfig()` 函数。

### 机制

在 `rendererConfig()` 返回的配置对象中增加 `prependInputHandlers`，注册一个实例级闭包 handler。handler 使用 `CliRendererConfig.prependInputHandlers` 接口（OpenTUI 已有），在 `dispatchSequenceHandlers` 中被调用，位于 KeyHandler 和 Textarea 之前。

### handler 状态机

handler 维护一个简单的恢复状态：

```
idle → 检测到畸形 SGR mouse 前缀 → recovery
recovery → 逐字符消费合法 mouse report 字符 → 遇到 M/m → idle (完成)
recovery → 遇到非法字符 → idle (放行当前字符)
```

#### 进入条件

仅当 `sequence` 匹配以下模式时进入 recovery：

```
/\x1b\[<[;\d]*N$/
```

即：以真实 ESC 开头，紧跟 `[<`，后跟零或多个数字和分号，以大写 `N` 结尾。这精确匹配 OpenTUI parser 从畸形 SGR mouse 报告拆出的第一个 key event。

#### Recovery 中接受的字符

仅接受 SGR mouse report 中合法的字符：

- `a` — "NaN" 的第二个字符
- `N` — "NaN" 的第三个字符
- `;` — 字段分隔符
- `0-9` — 数字（合法字段值）
- `M` 或 `m` — 终止符（完成 recovery）

#### 退出条件

- 遇到 `M` 或 `m`：recovery 完成，复位到 idle，返回 `true`（消费）。
- 遇到不在上述集合中的字符（包括 ESC）：退出 recovery，返回 `false`（放行当前字符）。
- 消费字符超过 50 个（安全上限）：退出 recovery，返回 `false`。

#### 安全保证

- 不扫描 Prompt 文本内容。
- 不以 `/NaN/` 或 `/aN;NaNm/` 过滤用户输入。
- 只有真实 ESC 开头的 SGR mouse introducer 才能触发 recovery。
- 普通键入 `aN;NaNm` 不带 ESC 前缀，完全不触发。
- bracketed paste 中的同形文本不触发（paste 走不同路径）。
- 不使用 timer、不保存全局状态、不修改 stdin stream。

### 为什么比其他方案更符合现有设计

| 方案 | 文件数 | 问题 |
|------|--------|------|
| **prependInputHandlers（推荐）** | 2 | 复用现有接口，最小修改面 |
| patch node_modules | 3+ | 引入 patch 文件和 lockfile 变更 |
| 包装 process.stdin | 2 | blast radius 过大，影响所有输入 |
| 升级 OpenTUI | 2+ | 0.4.3 未修复此问题 |
| Prompt 文本过滤 | 2 | 误删合法输入，且太晚 |
| 关闭 mouse | 1 | 破坏现有交互 |

## 预计修改

### 1. `packages/opencode/src/cli/cmd/tui/app.tsx`（修改）

- 在 `rendererConfig()` 附近新增内部函数 `createMalformedSgrMouseGuard()`。
- 函数返回 `(sequence: string) => boolean` 闭包。
- 闭包状态：`recovery: boolean` 和 `consumed: number`。
- 在 `rendererConfig()` 返回对象中增加 `prependInputHandlers: [createMalformedSgrMouseGuard()]`。
- 中文注释解释：某些终端输出 NaN 坐标、OpenTUI 在首个 N 处分裂 CSI、handler 消费已确认的 mouse packet 尾部。

### 2. `packages/opencode/test/cli/cmd/tui/malformed-sgr-mouse.test.tsx`（新增）

使用 `testRender` + `prependInputHandlers` + textarea，通过 `renderer.stdin.emit("data", ...)` 注入：

- `ESC[<64;NaN;NaNM` 不进入 textarea。
- `ESC[<64;NaN;NaNm` 不进入 textarea。
- 三条连续报告不产生 `aN;NaNMaN;NaNMaN;NaNm`。
- 合法 `ESC[<64;12;8M` 继续作为 mouse event。
- 直接键入 `aN;NaNm` 原样进入 textarea。
- 恢复中遇到非法字符立即放行。

## 正常路径

```
合法 mouse: ESC[<64;12;8M
→ StdinParser mouse event
→ handler 不参与（mouse event 不经过 sequenceHandlers）
→ renderer mouse dispatch
```

```
普通文本: aN;NaNm
→ key events
→ handler 未进入 recovery（无 ESC 前缀）
→ Textarea 正常插入
```

## 错误路径

```
畸形 mouse: ESC[<64;NaN;NaNM
→ parser 拆为 ESC[<64;N + aN;NaNM
→ handler 识别 ESC[<64;N 前缀 → recovery
→ 逐字符消费 aN;NaNM
→ M 终止 → recovery 完成
→ 不进入 Textarea
```

```
恢复中遇到非法字符:
→ 退出 recovery
→ 当前字符正常分发
```

## 并发 / 退出 / 清理 / 安全

- handler 状态仅存在于闭包，每个 renderer 实例独立。
- 不创建 interval、timeout、listener 或 subprocess。
- renderer destroy 后闭包自然释放。
- 不改变 `onBeforeExit`、`TuiPluginRuntime.dispose()`、`TuiAudio.dispose()` 顺序。
- 不检查用户业务文本内容。
- 不扩大 plugin 权限或终端控制能力。

## 测试计划

### 红测（先写）

注入 `ESC[<64;NaN;NaNM` + `ESC[<64;NaN;NaNM` + `ESC[<64;NaN;NaNm`，断言 `textarea.plainText === ""`。当前实现下会得到 `"aN;NaNMaN;NaNMaN;NaNm"`。

### 兼容测试

- 合法 mouse report 不进入文本。
- 直接输入同形普通文本保留。
- 恢复中遇到非法字符放行。
- `M` 和 `m` 两种终止符。

## 验证命令

```bash
cd packages/opencode
bun test test/cli/cmd/tui/malformed-sgr-mouse.test.tsx
bun test test/cli/cmd/tui/
bun typecheck
```

## 变更规模

- 修改文件：1（`app.tsx`）
- 新增测试文件：1
- 生产代码增加：约 30-40 行
- 测试增加：约 70-90 行
- 无迁移、无生成文件、无文档、无依赖变更

## 风险与开放问题

- 具体哪个终端版本生成 `NaN` 坐标尚未被公开 issue 确认。不影响修复：应用不能假设终端永远输出合法 SGR mouse。
- 建议后续向 OpenTUI 上游提交修复，让 `csi_sgr_mouse` 在遇到非法字符时丢弃整个协议单元。上游修复后可删除本地 handler。
