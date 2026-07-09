# LSP 诊断 TUI 精修与 read/touch 语义收敛实施文档

> 本文档是本次需求的独立实施文档。它不依赖此前方案结论，按当前仓库现状重新调研并给出最小实现方案。

---

## 1. 本次需求边界

本次需求不是重新设计整个 LSP 系统，而是在已经存在的 LSP 增量诊断链路上修复两个明确问题：

1. TUI 中 LSP 诊断展示过于粗糙：多个 error 不易区分，多行 error 会撑高工具块，长 error 缺少稳定截断，没有错误时缺少明确的高效确认反馈。
2. `read` 工具读取普通文本文件后会触发 `lsp.touchFile(filepath)`，在 VSCode Bridge 后端下会调用 `/lsp/touch`，进而 `showTextDocument` 打开/显示文件；这个副作用不符合 read 的只读语义。

本次方案只覆盖：

- `edit` / `write` / `apply_patch` 工具的 LSP 诊断 TUI 渲染。
- `edit` / `write` / `apply_patch` 工具输出中“LSP 已完成检查且没有错误”的短确认返回。
- `read` warm-up 与 VSCode Bridge strong touch 的语义拆分。

本次方案不覆盖：

- 新增独立 LSP diagnostics 工具。
- 修改 VSCode 扩展的 LSP endpoint 协议。
- 修改 `BasicTool` 全局折叠、高度或动画机制。
- 重新设计 LSP server 自动安装、默认启用或插件注册。
- 修改模型上下文中 `<new-diagnostics>` 的核心增量语义。

---

## 2. 从头调研证据

### 2.1 已阅读的文件、测试和文档

| 文件 | 已确认内容 | 相关性 |
| --- | --- | --- |
| `docs/lsp-complete-enhancement-plan.md` | 旧文档记录了 VSCode Bridge、增量诊断、TUI `diagnosticSummary` 的历史方案；但旧文档中“无任何错误时 TUI 不显示”已不满足本次新需求。 | 确认旧方案边界与需要修正的缺口。 |
| `packages/ui/src/components/message-part.tsx` | `Diagnostic` 接口、`getDiagnostics()`、`DiagnosticsDisplay()` 都在文件顶部；edit/write/apply_patch 都从 metadata 读取 `diagnostics` 与 `diagnosticSummary` 后传入 `DiagnosticsDisplay`。 | TUI 渲染的唯一入口。 |
| `packages/ui/src/components/message-part.css` | `[data-component="diagnostics"]` 当前使用 critical 背景、顶部边框、flex column；单条 message 允许 3 行 clamp。 | 当前丑陋和高度不稳定的直接原因。 |
| `packages/ui/src/components/basic-tool.tsx` / `basic-tool.css` | `BasicTool` 只处理工具 trigger、整体折叠 open/close 和可选动画；内容高度没有针对 diagnostics 的预算控制。 | 确认不应改全局工具容器。 |
| `packages/ui/src/components/diff-changes.tsx` / `.css` | 工具 header 已有高信息密度的 `+N -N` 风格；可借鉴 compact 信息密度，但不复用组件。 | 统一视觉语言。 |
| `packages/ui/src/components/tool-count-label.tsx` / `.css` | 当前组件用于计数动画，依赖 UI 文案差异；对 diagnostics 不是必要抽象。 | 确认不新增动画依赖。 |
| `packages/ui/src/styles/theme.css` | 已有 success / critical / warning / weak / base 等 token。 | 诊断状态色应复用现有主题 token。 |
| `packages/ui/src/components/apply-patch-file.test.ts`、`session-diff.test.ts` | UI 单测倾向测试纯函数/解析行为，而非 DOM 结构细节。 | 决定 UI TDD seam。 |
| `packages/opencode/src/tool/write.ts` | 写入后已捕获 baseline、`touchFile(filepath, "document")`、再次 `diagnostics()`、计算 `reportDelta()` / `newErrors()` / `deltaSummary()`。 | 确认 output 与 metadata 修改点。 |
| `packages/opencode/src/tool/edit.ts` | edit 与 write 相同，但在同文件 Semaphore 锁内执行。 | 确认并行 edit 下 delta 仍按串行文件锁计算。 |
| `packages/opencode/src/tool/apply_patch.ts` | patch 应用后逐文件 strong touch，再聚合 totalNew/totalExisting。 | 确认多文件 clean 文案不能写成 “this file”。 |
| `packages/opencode/src/tool/read.ts` | 普通文本 read 成功后调用 `warm(filepath)`，其内部 `lsp.touchFile(filepath).pipe(Effect.ignoreCause, Effect.forkIn(scope))`。 | read 打开 VSCode 文件的调用源。 |
| `packages/opencode/src/lsp/lsp.ts` | `touchFile(input, diagnostics?)` 有 bridge 时无条件调用 `/lsp/touch`，不区分 read warm 与强诊断。 | read/touch 修复的最小切入点。 |
| `sdks/vscode/src/lsp.ts` | `/lsp/touch` 使用 `openTextDocument` + `showTextDocument` + `awaitDiagnosticsRefresh`；hover/definition/symbol 使用 `ensureOpenLight`。 | 证明 read 打开文件的真实原因。 |
| `packages/opencode/src/tool/lsp.ts` | 显式 lsp tool 在执行 hover/definition 等操作前调用 `touchFile(file, "document")`。 | 显式 LSP 操作仍应触发 strong touch。 |
| `packages/opencode/test/lsp/index.test.ts`、`lifecycle.test.ts` | 现有 LSP 测试覆盖默认启用、touch/spawn、deltaSummary/reportDelta。 | LSP TDD seam。 |
| `packages/opencode/test/ide/vscode-bridge.test.ts` | 可通过 registry fixture 与 HTTP test server 测 bridge discovery/call 行为。 | 如果需要验证 bridge 调用路径，可复用风格。 |

### 2.2 通过搜索确认的调用点和旧逻辑

搜索 `DiagnosticsDisplay|diagnosticSummary|metadata.diagnostics|new-diagnostics` 确认：

- `DiagnosticsDisplay` 只在 `packages/ui/src/components/message-part.tsx` 定义。
- edit/write/apply_patch 是当前唯一结构化 TUI 诊断消费者。
- `metadata.diagnostics` 存储的是新错误数组，`metadata.diagnosticSummary` 存储 `{ newCount, existingCount }`。
- model output 使用 `<new-diagnostics>`，与 TUI metadata 是两条链路。

搜索 `touchFile\(|lsp.touchFile|showTextDocument|openTextDocument` 确认：

- `write.ts`、`edit.ts`、`apply_patch.ts`、`tool/lsp.ts`、`cli/cmd/debug/lsp.ts` 都是强诊断调用，传入 `"document"` 或 `"full"`。
- `read.ts` 是唯一无 diagnostics 参数的 tool 级 warm 调用。
- VSCode Bridge 的 `/lsp/touch` 一定会 `showTextDocument`。
- hover/definition/references/documentSymbol 只需要 `openTextDocument`，不需要 show。

### 2.3 当前不确定点和确认结果

| 不确定点 | 确认方式 | 结论 |
| --- | --- | --- |
| 多行 LSP message 为什么撑高？ | 读取 `message-part.css` diagnostics 样式。 | message 当前允许 3 行 clamp，多个错误叠加会显著撑高。 |
| 是否应改 `BasicTool` 高度？ | 读取 `basic-tool.tsx/css` 与工具内容结构。 | 不应改全局工具容器；应在 diagnostics 内部控制高度预算。 |
| 无错误时是否有数据可判断？ | 读取 write/edit/apply_patch metadata 生成逻辑。 | `diagnosticSummary` 能证明 `newCount=0 && existingCount=0`，但只有 LSP 已运行时才可信。 |
| read 打开 VSCode 是否真实由 touch 导致？ | 读取 `read.ts` warm、`lsp.ts` touch、`sdks/vscode/src/lsp.ts` ensureOpen。 | 是。read 无参 touch 在 bridge 下会走 `/lsp/touch`，然后 `showTextDocument`。 |
| read 是否需要 VSCode 强诊断 touch？ | 对照 read 输出和编辑工具诊断链路。 | 不需要。read warm 的目的只是预热，不应显示/打开文件。 |
| strong touch 是否仍需要 showTextDocument？ | 旧实验和当前 bridge 注释均说明 Pylance 诊断需要 show。 | edit/write/apply_patch/lsp tool 仍必须保留 strong touch。 |
| apply_patch clean 文案是否能写 “this file”？ | 读取 apply_patch 多文件聚合逻辑。 | 不能。apply_patch 可能涉及多个 changed files。 |

---

## 3. 当前职责边界

### 3.1 LSP Service

`packages/opencode/src/lsp/lsp.ts` 是 LSP 服务边界，负责：

- 根据 Project / filePath 找到可用内置 LSP client。
- 在有 VSCode Bridge 且 `capabilities.lsp=true` 时优先走 bridge。
- 提供 `touchFile()`、`diagnostics()`、`hover()`、`definition()`、`references()`、`documentSymbol()`、`workspaceSymbol()` 等统一接口。

必须保持：

- 有 bridge 时 edit/write/apply_patch 的诊断优先通过 bridge。
- bridge 不可用或调用失败时，强诊断路径仍可回退内置 LSP。
- 无 bridge 时 read warm 仍能预热内置 LSP。
- `containsPath` 外部路径保护仍由 `getClients()` 生效。

### 3.2 Tool 层

`write.ts`、`edit.ts`、`apply_patch.ts` 负责：

- 文件修改。
- 修改前后读取 LSP diagnostics。
- 计算本次编辑新引入的 ERROR delta。
- 把 model-facing 文本和 TUI metadata 同时返回。

必须保持：

- 只把新错误详情放入 `<new-diagnostics>`，不重新展示所有既有错误详情。
- LSP 不可用时不能输出“无错误”。
- 并行 edit 同一文件仍依赖现有 Semaphore 串行化，不能绕过。
- apply_patch 多文件统计要按变更文件聚合。

### 3.3 UI 层

`message-part.tsx` / `message-part.css` 负责：

- 根据 tool metadata 渲染 edit/write/apply_patch 的结构化 UI。
- 用 `DiagnosticsDisplay` 展示 LSP 诊断摘要与新错误列表。

必须保持：

- 不改变 tool metadata schema 的核心含义。
- 不改变 model output。
- 不改变 `BasicTool` 折叠行为。
- 不引入新依赖或全局样式副作用。

---

## 4. 现有缺口

### 4.1 多个 error 不易区分

当前 DOM：

```tsx
<div data-component="diagnostics">
  <div data-slot="diagnostic">
    <span>Error</span>
    <span>[line:col]</span>
    <span>{diagnostic.message}</span>
  </div>
</div>
```

问题：

- 每条错误只是普通 flex 行，没有明确的单条边界。
- `Error`、位置、message 混在同一视觉层级里。
- 多条 Pylance 中文多行 message 会形成大段红字。

### 4.2 多行和长 message 导致高度不稳定

当前 CSS：

```css
[data-slot="diagnostic-message"] {
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
}
```

问题：

- 每条错误最多 3 行，3 条错误最多 9 行，再加 diff 后工具块高度显著变化。
- 行数由 LSP provider message 决定，Pylance/Ruff/cSpell 风格不一致。
- CSS clamp 只能视觉裁剪，不提供可测试的稳定文本归一化。

### 4.3 无错误时缺少高效返回

当前行为：

- 如果没有新错误且 LSP 已运行，tool output 只显示 `Edit applied successfully.` 或 `Wrote file successfully.`。
- TUI 在 `newCount=0 && existingCount=0` 时不显示任何 LSP 状态。

问题：

- 模型和用户无法区分“LSP 已检查且无错误”和“LSP 没工作但没有诊断输出”。
- 当前已有 `status()` 检查可区分 LSP unavailable，却没有在可用且 clean 时给短确认。

### 4.4 read 的 warm 与 bridge strong touch 语义耦合

当前 read 调用：

```ts
yield* lsp.touchFile(filepath).pipe(Effect.ignoreCause, Effect.forkIn(scope))
```

当前 bridge touch：

```ts
const uri = await ensureOpen(args.filePath)
await awaitDiagnosticsRefresh(uri)
```

`ensureOpen()` 内部：

```ts
const doc = await vscode.workspace.openTextDocument(uri)
await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true })
```

问题：

- read 是只读上下文工具，不应该改变用户 VSCode 可见编辑器。
- strong touch 是为了 Pylance 等 LSP 计算诊断，适用于 edit/write/apply_patch，而不是 read warm。
- 当前 `touchFile(input, diagnostics?)` 的 `diagnostics` 参数只影响内置 LSP wait 行为，没有影响 bridge 分支。

---

## 5. 推荐最小实现方案

### 5.1 UI：诊断 presenter 与紧凑三态展示

新增一个很小的 UI 纯 helper 文件，例如：

`packages/ui/src/components/diagnostics-display.ts`

职责：

- 输入 raw diagnostics 与 summary。
- 输出 UI 可直接渲染的 presenter 数据。
- 只做纯字符串归一化、截断、计数状态选择。

建议类型：

```ts
export type DiagnosticInput = {
  range: { start: { line: number; character: number } }
  message: string
  severity?: number
}

export type DiagnosticSummary = {
  newCount: number
  existingCount: number
}

export function prepareDiagnosticsDisplay(input: {
  diagnostics: DiagnosticInput[]
  summary?: DiagnosticSummary
  scope: "file" | "changed-files"
})
```

输出状态：

```ts
type PreparedDiagnosticsDisplay =
  | { state: "hidden" }
  | { state: "error"; title: string; rows: Row[]; more: number }
  | { state: "existing"; title: string }
  | { state: "clean"; title: string }
```

状态规则：

1. `summary?.newCount > 0 || diagnostics.length > 0` → `error`。
2. `summary.newCount === 0 && summary.existingCount > 0` → `existing`。
3. `summary.newCount === 0 && summary.existingCount === 0` → `clean`。
4. `summary` 缺失且 `diagnostics.length === 0` → `hidden`。

这里必须坚持：clean 只能由 `summary` 证明，不能由 `diagnostics=[]` 推导。

### 5.2 UI：message 归一化与截断

规则顺序：

1. `normalizeDiagnosticMessage(message)`：
   - `trim()`。
   - 把所有 `\s+` 替换成单个空格。
   - 保留中文、英文、标点和 LSP 原始语义。
2. `truncateDiagnosticMessage(normalized, limit = 160)`：
   - `normalized.length <= limit` 原样返回。
   - 超过则截断到 `limit - 3` 后追加 ASCII `...`。

选择字符级截断而非仅 CSS ellipsis 的原因：

- 可以用单测稳定验证。
- copied text / terminal-ish 渲染也保持短文本。
- CSS ellipsis 仍作为布局二次保护。

### 5.3 UI：视觉设计

`DiagnosticsDisplay` 渲染为紧凑 status block：

错误状态：

```text
LSP · 3 new errors · +2 more
E 23:13  类型“int”和“Literal['one']”不支持运算符“-=” 类型“int”和“Literal['one']”不支持运算符“-”
E 41:24  无法为类“UserManager*”的属性“counter”赋值。 “None”不可分配给“int”
E 72:13  Undefined name `missing_function`
```

既有错误状态：

```text
LSP checked · 0 new · 4 existing
```

完全无错误状态：

```text
LSP checked · no errors in this file
```

apply_patch 多文件 clean：

```text
LSP checked · no errors in changed files
```

CSS 规则：

- `[data-component="diagnostics"]` 加 `data-state="error|existing|clean"`。
- 使用 `border-top` 与当前工具内容衔接，但内部加 header/list 层次。
- 错误态使用 critical token，clean 使用 success token，existing 使用 weak/warning/neutral token。
- list 最大显示 3 条，内部 `max-height` 防御，不让 provider message 撑高整个工具块。
- 每条 row 使用 grid：`badge | location | message`。
- message 单行：`white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0`。
- 不引入动画、不新增 icon 依赖。

### 5.4 最终预期渲染样式

本节描述最终用户在 TUI 中应看到的行为样式。实际颜色由主题 token 决定，不写死颜色值。

#### 5.4.1 新错误态：多条 error 可区分

当本次 edit/write/apply_patch 引入新错误时，诊断块显示在 diff/code 内容下方，整体仍属于当前工具卡片的一部分。

预期结构：

```text
┌───────────────────────────────────────────────────────────────┐
│ LSP · 3 new errors · +2 more                                  │
│ E 23:13  类型“int”和“Literal['one']”不支持运算符“-=” 类型“int”... │
│ E 41:24  无法为类“UserManager*”的属性“counter”赋值。 “None”不可... │
│ E 72:13  Undefined name `missing_function`                    │
└───────────────────────────────────────────────────────────────┘
```

视觉规则：

- `LSP` 是稳定前缀，让用户明确这是语言服务检查结果。
- `3 new errors` 是本次工具调用新引入的错误数，不代表 workspace 全部错误。
- `+2 more` 表示还有 2 条新错误未展开显示；列表仍最多展示 3 条，避免撑高。
- 每条错误都有 `E` badge 和 `line:col`，多条错误之间通过行间距、badge 和位置 pill 区分。
- message 只占一行；Pylance 的第二行解释会被压缩到同一行并按长度截断。

#### 5.4.2 多行 Pylance message 的压缩效果

原始 message：

```text
类型“int”和“Literal['one']”不支持运算符“-=”
  类型“int”和“Literal['one']”不支持运算符“-”
```

渲染前 presenter 归一化为：

```text
类型“int”和“Literal['one']”不支持运算符“-=” 类型“int”和“Literal['one']”不支持运算符“-”
```

如果超过长度上限，则显示为：

```text
类型“int”和“Literal['one']”不支持运算符“-=” 类型“int”和“Literal['one']”不支持运算符“-” 类型...
```

最终 CSS 仍会使用 `text-overflow: ellipsis` 进行宽度保护，所以窄窗口下可能视觉上再出现浏览器级省略号。

#### 5.4.3 既有错误态：不打扰但明确说明

当本次修改没有新增错误，但当前文件仍有既有错误时：

```text
┌──────────────────────────────────────────┐
│ LSP checked · 0 new · 4 existing          │
└──────────────────────────────────────────┘
```

视觉规则：

- 使用 neutral / warning 弱提示，而不是绿色成功态。
- 不显示既有错误详情，避免模型把历史问题误判成当前 edit 失败。
- output 文本同步给模型短确认：`LSP checked: no new errors introduced; 4 existing errors remain.`

#### 5.4.4 完全无错误态：绿色高效确认

当 LSP 已运行，且当前文件没有任何 ERROR：

```text
┌──────────────────────────────────────────┐
│ ✓ LSP checked · no errors in this file    │
└──────────────────────────────────────────┘
```

apply_patch 多文件时：

```text
┌────────────────────────────────────────────┐
│ ✓ LSP checked · no errors in changed files  │
└────────────────────────────────────────────┘
```

视觉规则：

- 使用 success token，形成明确的绿色成功状态。
- 只在 `diagnosticSummary` 明确存在且 `newCount=0 && existingCount=0` 时显示。
- 如果 LSP 不可用，绝不显示绿色状态。
- output 文本同步给模型短确认：`LSP checked: no errors in this file.` 或 `LSP checked: no errors in changed files.`

#### 5.4.5 LSP 不可用态：不渲染绿色

当 LSP 未运行或无 server：

```text
Edit applied successfully.

LSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.
```

TUI 不显示 diagnostics success block。这样可以避免把“没有诊断数据”误渲染成“已经检查且无错误”。

#### 5.4.6 高度预算和收缩行为

诊断块不能按 error 原始行数无限增长。最终高度预算：

- header：1 行。
- error rows：最多 3 行。
- footer/more 信息：内联到 header，例如 `+N more`，不额外占行。
- 容器设置局部 `max-height`，只允许 diagnostics 内部滚动或裁剪，不影响 `BasicTool` 全局折叠。

示例：即使 LSP 返回 20 条新错误，TUI 仍只显示：

```text
LSP · 20 new errors · +17 more
E 7:5    first error...
E 13:9   second error...
E 21:17  third error...
```

这保证 diff 的高度确定后，diagnostics 不会继续把整个工具块撑到不可读。

#### 5.4.7 与现有 OpenCode 视觉语言的对齐

- 信息密度接近 `DiffChanges` 的 `+N -N` 计数风格。
- 字体使用现有 sans/mono token：header 偏 sans，`line:col` 可用 mono/tabular nums。
- 圆角、边框、背景都使用现有 surface/border token，不新增品牌色。
- 不使用大卡片、不使用额外 icon 组件堆叠，避免变成低信息密度控件。

### 5.5 Tool output：无错误时也高效返回

在 `write.ts` / `edit.ts` / `apply_patch.ts` 的 delta 为空分支中补充短确认：

| 场景 | output 建议 |
| --- | --- |
| LSP unavailable | 保持现有 `LSP diagnostics unavailable...` |
| new errors > 0 | 保持现有 `<new-diagnostics>` + multi-step note |
| new errors = 0，existing errors > 0 | `LSP checked: no new errors introduced; N existing errors remain.` |
| new errors = 0，existing errors = 0，单文件 | `LSP checked: no errors in this file.` |
| new errors = 0，existing errors = 0，apply_patch | `LSP checked: no errors in changed files.` |

这样满足“没有任何错误时也应该适当进行一定的高效返回”，同时仍避免输出既有错误详情。

重要边界：

- 必须先确认 `lsp.status()` 非空，才能输出 checked。
- 如果 LSP 不可用，不能用 `deltaSummary={0,0}` 误报 clean。
- existing-only 只输出数量，不输出详情，避免模型被无关旧问题带偏。

### 5.6 LSP 信息附加位置与模型可见输出矩阵

LSP 信息有两条输出链路，必须明确区分：

1. **模型可见 output**：作为 tool result 的 `output` 返回给 Agent。模型会看到这些文本，并据此决定下一步。
2. **TUI 结构化 metadata**：作为 tool result 的 `metadata.diagnostics` / `metadata.diagnosticSummary` 返回给 UI。模型不会直接读取 metadata，UI 用它渲染紧凑诊断块。

#### 5.6.1 附加位置

对 `edit`：

- TUI 位置：`BasicTool` 展开后，`ToolFileAccordion` / diff 内容下方。
- 模型 output 位置：`Edit applied successfully.` 后追加 LSP 段落。
- metadata：`diagnostics` 和可选 `diagnosticSummary` 与 `diff` / `filediff` 同级。

对 `write`：

- TUI 位置：`BasicTool` 展开后，写入文件内容预览下方。
- 模型 output 位置：`Wrote file successfully.` 后追加 LSP 段落。
- metadata：`diagnostics` 和可选 `diagnosticSummary` 与 `filepath` / `exists` / `diff` 同级。

对 `apply_patch`：

- TUI 位置：单文件 patch 时在 diff 下方；多文件 patch 时在文件 accordion 列表下方，作为整个 patch 的聚合诊断块。
- 模型 output 位置：`Success. Updated the following files:` 列表后追加每个文件的新错误段落或 LSP checked 段落。
- metadata：`diagnostics` 按文件 key 存储新错误数组，`diagnosticSummary` 是所有 changed files 的聚合摘要。

#### 5.6.2 状态矩阵

| 状态 | 触发条件 | 模型 output | TUI metadata | TUI 渲染 |
| --- | --- | --- | --- | --- |
| 新增错误 | `newErrors.length > 0` | `New LSP errors introduced by this edit:` + `<new-diagnostics>` + multi-step note | `diagnostics` 存新错误数组；`diagnosticSummary={newCount,existingCount}` | 红色 `LSP · N new errors · +M more`，最多 3 条一行错误 |
| 没有新错误但有既有错误 | `newCount=0 && existingCount>0 && LSP 可用` | `LSP checked: no new errors introduced; N existing errors remain.` | `diagnostics` 为空数组；`diagnosticSummary={0,N}` | 中性/警告色 `LSP checked · 0 new · N existing` |
| 完全无错误 | `newCount=0 && existingCount=0 && LSP 可用` | 单文件：`LSP checked: no errors in this file.`；patch：`LSP checked: no errors in changed files.` | `diagnostics` 为空数组；`diagnosticSummary={0,0}` | 绿色 `✓ LSP checked · no errors in this file/changed files` |
| LSP 不可用 | `lsp.status()` 为空，或 bridge diagnostics 失败后无内置 client | `LSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.` | `diagnostics` 仍可为空；**不传 `diagnosticSummary`** | 不显示 clean/existing 诊断块，避免误报成功 |
| LSP 功能 disabled | 配置 `lsp:false`，或没有任何可用 server/client | 与 LSP 不可用相同，显示 unavailable 文案 | 不传 `diagnosticSummary` | 不显示绿色；如果工具 header 已有成功状态，只代表文件操作成功，不代表 LSP 成功 |

#### 5.6.3 模型输出样例

新增错误：

```text
Edit applied successfully.

New LSP errors introduced by this edit:
<new-diagnostics file="src/foo.ts">
ERROR [23:13] Undefined name `missing_function`
ERROR [41:24] Type "None" is not assignable to "int"
</new-diagnostics>

Note: If this is part of a multi-step edit, some errors may be expected until all changes are complete.
```

没有新错误但有既有错误：

```text
Edit applied successfully.

LSP checked: no new errors introduced; 4 existing errors remain.
```

完全无错误：

```text
Edit applied successfully.

LSP checked: no errors in this file.
```

apply_patch 完全无错误：

```text
Success. Updated the following files:
M src/foo.ts
M src/bar.ts

LSP checked: no errors in changed files.
```

LSP 不可用或 disabled：

```text
Edit applied successfully.

LSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.
```

#### 5.6.4 disabled 与 unavailable 的边界

本次实现不新增单独的 disabled 文案。原因：

- 对 Agent 来说，“配置禁用”“没有 server”“bridge diagnostics 失败”都意味着当前工具调用无法提供可靠 LSP 诊断。
- 现有文案 `LSP diagnostics unavailable` 已覆盖行为语义，比暴露内部 disabled 原因更稳定。
- 如果未来要区分 disabled / missing server / bridge failure，应在 `LSP.status()` 或新的诊断状态 API 中建模，而不是在工具 output 字符串里临时猜测。

因此本次最小方案中：

- `lsp:false` → 模型看到 unavailable。
- 无内置 server、无 bridge → 模型看到 unavailable。
- bridge 可发现但 diagnostics endpoint 失败 → 模型看到 unavailable。
- 只有在 diagnostics 确认可用时，模型才会看到 `LSP checked...`。

### 5.7 read/touch：强诊断 touch 与轻量 warm 分流

只改 `LSP.touchFile(input, diagnostics?)`，不改 `read.ts` 调用点。

推荐逻辑：

```ts
const bridge = yield* resolveLspBridge(input)
if (bridge) {
  if (!diagnostics) return
  const touched = yield* callLspBridge("/lsp/touch", { filePath: input }, input)
  if (touched) return
}
```

语义：

- `touchFile(file)`：轻量 warm。bridge 环境下 no-op，避免 read 打开 VSCode；无 bridge 时保留内置 LSP warm。
- `touchFile(file, "document")` / `touchFile(file, "full")`：强诊断 touch。bridge 环境下继续 `/lsp/touch`，用于 edit/write/apply_patch/lsp/debug。
- bridge strong touch 失败时仍 fall through 内置 LSP，保留当前回退语义。

为什么不改 `sdks/vscode/src/lsp.ts`：

- `/lsp/touch` 当前语义就是“触发 VSCode 诊断计算”，需要 `showTextDocument`。
- read 不需要调用这个 endpoint。
- 新增 `/lsp/warm` 会扩大 bridge API surface，收益不确定。

为什么不改 `read.ts`：

- read 调用 `touchFile(file)` 的语义本来就是 warm。
- 问题是 bridge 后端把 warm 解释成 strong touch。
- 在 LSP Service 层分流更符合模块边界。

---

## 6. 预计文件改动

| 文件 | 类型 | 具体改动 |
| --- | --- | --- |
| `packages/ui/src/components/diagnostics-display.ts` | 新增 | 纯 presenter/helper：归一化、截断、状态选择、行数/剩余计数。 |
| `packages/ui/src/components/diagnostics-display.test.ts` | 新增 | 行为级单测覆盖多行归一化、截断、hidden/error/existing/clean 状态、`+N more`。 |
| `packages/ui/src/components/message-part.tsx` | 修改 | `DiagnosticsDisplay` 改用 presenter；新增 `scope` 参数，edit/write 用 `file`，apply_patch 用 `changed-files`。 |
| `packages/ui/src/components/message-part.css` | 修改 | 重写 diagnostics block 样式，增加 error/existing/clean 状态、单行 row、固定高度预算。 |
| `packages/opencode/src/lsp/lsp.ts` | 修改 | bridge 分支按 `diagnostics` 参数区分 light warm 与 strong diagnostic touch。 |
| `packages/opencode/src/tool/write.ts` | 修改 | delta 为空且 LSP 可用时输出 checked 短确认。 |
| `packages/opencode/src/tool/edit.ts` | 修改 | 同 write。 |
| `packages/opencode/src/tool/apply_patch.ts` | 修改 | 同 write，但文案使用 changed files。 |
| `packages/opencode/test/lsp/index.test.ts` 或新测试文件 | 修改/新增 | bridge + no diagnostics 不调用 `/lsp/touch`；bridge + document diagnostics 仍调用。 |

预计净改动：

- 文件数：8-9 个。
- 代码行：约 +260 / -50。
- 文档：本文档 1 个。
- 生成文件：无。
- 数据库迁移：无。
- VSCode vsix 需要重新构建：不需要，除非后续改 `sdks/vscode`，本方案不改。

---

## 7. 正常路径、错误路径、并发/退出/清理/安全边界

### 7.1 正常路径

edit/write：

1. 修改前 `diagnostics()` 获取 baseline。
2. 修改文件。
3. `touchFile(file, "document")` 触发 strong diagnostics。
4. 修改后 `diagnostics()` 获取 current。
5. `reportDelta()` 输出新错误详情；`deltaSummary()` 输出摘要。
6. TUI 根据 summary 显示 error/existing/clean。
7. output 根据 LSP status 和 summary 给短确认或错误详情。

apply_patch：

1. patch 前一次性获取所有 diagnostics。
2. patch 后逐个 changed file `touchFile(target, "document")`。
3. 聚合 totalNew/totalExisting。
4. TUI 和 output 使用 changed-files 文案。

read：

1. read 正常返回文件内容。
2. `warm(filepath)` 后台 fork `touchFile(filepath)`。
3. 有 bridge 时 `touchFile(filepath)` no-op，不打开 VSCode。
4. 无 bridge 时保持内置 LSP warm。

### 7.2 错误路径

- LSP unavailable：保持现有 unavailable 文案，不显示 clean。
- bridge `/lsp/touch` 失败：strong touch 仍 fall through 内置 LSP；light warm 直接 no-op，不影响 read 成功。
- diagnostics map 缺失当前文件：summary 仍来自 tool 层计算；UI 如果 summary 缺失则 hidden，避免误报。
- Pylance message 含换行/缩进/长文本：presenter 归一化并截断，CSS 二次 ellipsis。
- apply_patch 删除文件：继续跳过 deleted file diagnostics。

### 7.3 并发和时序

- 同文件并行 edit 仍由现有 Semaphore 串行化；本方案不改变锁。
- bridge resolve 有 5s cache；light warm no-op 不新增请求，不增加并发压力。
- strong touch 仍等待 VSCode diagnostics refresh；不改变 2s bridge 等待策略。
- apply_patch 多文件 strong touch 当前是顺序循环；本方案不改并发模型。

### 7.4 退出和清理

- 不新增后台 fiber。
- 不新增 VSCode endpoint。
- 不新增定时器或 DOM subscription。
- read warm 仍 fork 到当前 Scope，退出行为不变。

### 7.5 安全边界

- read 的 external directory、permission、blocked device path、binary/media 分支不变。
- bridge discovery 的 registry 清理策略不变。
- 不执行 shell 字符串、不新增路径解析。
- TUI 只渲染已存在 metadata，不新增 HTML 注入；message 作为 Solid 文本节点渲染。

---

## 8. TDD 计划

### 8.1 UI presenter 测试

文件：`packages/ui/src/components/diagnostics-display.test.ts`

先写失败测试：

1. `normalizes multiline diagnostics into one row`
   - 输入含 `\n`、tab、连续空格的 Pylance message。
   - 期望输出 message 是单行。
2. `truncates long diagnostics with ascii ellipsis`
   - 输入超过 160 字符。
   - 期望长度不超过 160 且以 `...` 结尾。
3. `renders clean state only when summary proves zero errors`
   - `diagnostics=[]` 且无 summary → hidden。
   - `summary={0,0}` → clean。
4. `renders existing-only state without success tone data`
   - `summary={0,4}` → existing，标题包含 `0 new` 和 `4 existing`。
5. `renders error state from summary even if displayed diagnostics are capped`
   - `summary.newCount=8`，diagnostics 传 3 条。
   - 期望 `more=5`。
6. `uses changed-files clean copy for apply_patch scope`
   - scope=`changed-files` 且 summary={0,0}。
   - 期望标题是 changed files，不是 this file。

### 8.2 LSP Service 测试

文件：`packages/opencode/test/lsp/index.test.ts` 或新 `bridge-touch.test.ts`

先写失败测试：

1. `skips bridge touch for light warm without diagnostics`
   - mock bridge resolve 返回 `capabilities.lsp=true`。
   - 调用 `lsp.touchFile(file)`。
   - 断言不调用 `callBridge('/lsp/touch')`，也不 spawn builtin。
2. `uses bridge touch for document diagnostics`
   - mock bridge resolve + callBridge。
   - 调用 `lsp.touchFile(file, "document")`。
   - 断言调用 `/lsp/touch`。
3. `keeps native warm when no bridge is available`
   - bridge resolve 失败或无 bridge。
   - 使用现有 fake server / spawn spy。
   - 调用 `touchFile(file)` 仍触发内置 LSP spawn/open。

### 8.3 Tool output 测试

优先测试 helper 或 tool seam，避免直接断 DOM：

- 如果 output 文案逻辑保持在 tool 文件中，可以在现有 tool 测试 seam 不足时先不单独新增复杂 integration；但至少通过 LSP lifecycle/unit helper 覆盖 summary 分支。
- 若提取小 helper，例如 `formatLspCheckedMessage(scope, summary, available)`，则补纯函数测试。

建议更小实现：

- 在 `packages/opencode/src/lsp/diagnostic.ts` 增加 `checkedMessage(scope, summary)` 或在 tool 内局部函数？
- 若只在三个 tool 内重复 2-3 行，避免新增公共 API。
- 但为了 TDD 可测试性，建议在 `diagnostic.ts` 新增小纯函数：`checked(summary, scope)`，只返回短文案或空字符串。

是否新增该 helper 取决于实现时重复程度；原则是不要为了测试牺牲模块边界。

---

## 9. 验证命令

从 `packages/ui`：

```sh
bun test src/components/diagnostics-display.test.ts
bun typecheck
```

从 `packages/opencode`：

```sh
bun test test/lsp/index.test.ts test/lsp/lifecycle.test.ts
bun typecheck
```

如修改 tool output 且已有相关 tool 测试可定位，则补跑对应测试文件。

不从 repo root 运行测试，遵守仓库约定。

---

## 10. subagent 方案审计结果

已将本方案核心思路交给 subagent 独立审计，审计范围包括：

- UI 改造是否最小。
- `read` light warm 是否应跳过 bridge `/lsp/touch`。
- clean state 是否会误报。
- apply_patch 多文件文案。
- 测试计划是否覆盖用户观察到的问题。

审计结论：无阻塞性意见。

subagent 的非阻塞建议已经纳入本文档：

- `touchFile(file)` bridge no-op 必须用注释说明是 intentional semantic split。
- apply_patch clean 文案使用 `changed files`，不能使用 `this file`。
- clean state 必须严格依赖 summary，不能从空 diagnostics 推导。
- `summary.newCount > diagnostics.length` 要显示剩余数量。
- normalize 必须先于 truncate。
- existing-only 不能渲染成绿色成功态。

---

## 11. 真实风险与开放问题

### 11.1 真实风险

1. **bridge stale 时 light warm no-op 会跳过 native warm**
   - 这是有意取舍。read 的正确性优先于后台 warm；read 不应为了预热打开 VSCode 或 spawn 额外 LSP。
2. **clean output 可能增加模型上下文少量文本**
   - 但这是用户明确要求的高效返回，且只是一行短确认。
3. **existing-only output 是否会引导模型修旧错误**
   - 方案只输出数量，不输出详情，风险低于展示完整既有错误。
4. **CSS 视觉效果仍需实际 TUI 观察**
   - 单测只能覆盖 presenter 行为，最终视觉需用长错误文件再观察。
5. **apply_patch 多文件诊断没有逐条 file label**
   - 当前 metadata 聚合后丢失 per-row 文件名。最小方案不改数据结构；如后续需要，可扩展 presenter 输入。

### 11.2 开放问题

无必须阻塞实现的用户决策。

可选后续增强：

- 为 apply_patch 多文件错误行显示短文件名。
- 给 diagnostics block 增加“展开全部错误”交互。
- 将 clean/existing 状态同步到工具 header action 区，而不只在内容区显示。

这些都不是本次最小实现必需项。

---

## 12. 推荐方案摘要

本次推荐方案是两处手术级收敛：

1. **TUI 诊断展示精修**：新增小型 presenter helper，统一 LSP message 单行化、长度截断、三态状态选择；`DiagnosticsDisplay` 用 compact block 渲染 error/existing/clean，限制高度，不改 `BasicTool`。
2. **read/touch 语义分流**：`touchFile(file)` 在 VSCode Bridge 后端下作为 light warm 直接 no-op，避免 read 打开 VSCode；`touchFile(file, "document"|"full")` 继续 strong touch，保障 edit/write/apply_patch 诊断。

额外满足用户补充要求：

- 当 LSP 已完成检查且没有任何 ERROR 时，tool output 返回一行短确认：`LSP checked: no errors in this file.` 或 `LSP checked: no errors in changed files.`
- 当没有新错误但存在既有错误时，output 只返回数量摘要，不返回旧错误详情。

该方案改动面小、沿用现有 metadata 与 LSP Service 边界，不新增 bridge API、不新增依赖、不改全局工具容器，也不削弱 LSP unavailable 的安全提示。

---

## 13. 修订方案：文件数收敛与 diff+LSP 联合行数预算

> 本节是第一轮实现后的修订。第一轮实现暴露了两个问题：
> 1. 修改文件数达 16 个，远超“不该超过 10 个”的约束。
> 2. LSP 诊断块在 diff 外面独立 `max-height: 112px`，没有和 diff/code 预览共享行数预算；当 diff 8 行 + LSP 8 行时，两者各自不收缩，整体高度仍会翻倍。

### 13.1 当前实现的问题诊断

| 问题 | 根因 | 影响 |
| --- | --- | --- |
| 文件数过多（16 个） | 新增 `diagnostics-display.ts` + `diagnostics-display.test.ts`；`bridgeDiagnostics` 状态、`checkedMessage`、baseline 前移分散在 5 个生产文件 + 4 个测试文件 | git 净增量难以控制，review 负担大 |
| LSP 不参与 diff collapse | `DiagnosticsDisplay` 渲染在 `ToolFileAccordion` **外面**，作为 `BasicTool` 的直接子节点；CSS 给它独立 `max-height: 112px` | diff 8 行 + LSP 8 行 = 16 行可见内容，工具块高度翻倍，没有联合收缩 |
| presenter 外置成独立文件 | `diagnostics-display.ts` 只有 82 行，完全可以内联到 `message-part.tsx` | 多了一个文件和 import 链，违反“不新增不必要抽象” |
| `bridgeDiagnostics` 状态字段 | 在 `State` interface 里加了 `bridgeDiagnostics?: "ok" \| "failed"`，`status()` 和 `diagnostics()` 都要读写 | 扩大了 LSP Service 的内部状态面，且只为了防止 clean 误报 |
| baseline 前移改了 3 个 tool 文件 | write/edit/apply_patch 各改了 baseline 采集位置 | 3 个文件的结构性修改，增加回归风险 |

### 13.2 修订目标

1. **文件数 ≤ 10**（含文档）。
2. **LSP 诊断行数参与 diff/code 预览的联合行数预算**：diff + LSP 共享一个总行数上限，超过时整体收缩（不是 LSP 独立滚动）。
3. **不新增独立 presenter 文件**：归一化/截断/状态选择内联到 `message-part.tsx`。
4. **不新增 `bridgeDiagnostics` 状态字段**：用更简单的方式防止 clean 误报。
5. **不改 baseline 采集位置**：保持现有 write/edit/apply_patch 的诊断采集时序不变，避免结构性回归。

### 13.3 推荐修订方案

#### 13.3.1 文件数收敛

删除 `packages/ui/src/components/diagnostics-display.ts` 和 `packages/ui/src/components/diagnostics-display.test.ts`。

把 presenter 逻辑（`normalizeDiagnosticMessage`、`truncateDiagnosticMessage`、`prepareDiagnosticsDisplay`）作为模块内函数内联到 `message-part.tsx`。

测试改为：
- 如果 `message-part.tsx` 不便导出内部函数做单测，则把 `normalizeDiagnosticMessage` / `truncateDiagnosticMessage` / `prepareDiagnosticsDisplay` 保留为 `message-part.tsx` 内的纯函数，不做导出测试；行为验证改由 LSP lifecycle 测试 + 实际 TUI 观察覆盖。
- 或者只导出一个 `prepareDiagnosticsDisplay` 到 `message-part.tsx` 的 `export`，测试文件仍可保留但不新增独立 .ts 文件。

推荐：**内联不导出，删除独立测试文件**，因为归一化和截断逻辑足够简单（各 1-2 行），行为验证由 LSP lifecycle 测试和实际 TUI 覆盖。

#### 13.3.2 diff + LSP 联合行数预算

**核心改动**：把 `DiagnosticsDisplay` 从 `BasicTool` 的直接子节点，移到 `ToolFileAccordion` 的 `Accordion.Content` **内部**，和 diff/code 预览共享同一个内容容器。

当前结构（有问题）：

```tsx
<BasicTool>
  <ToolFileAccordion path={path()}>
    <div data-component="edit-content">
      <Dynamic component={fileComponent} mode="diff" />
    </div>
  </ToolFileAccordion>
  <DiagnosticsDisplay ... />  // ← 在 accordion 外面，独立高度
</BasicTool>
```

修订结构：

```tsx
<BasicTool>
  <ToolFileAccordion path={path()}>
    <div data-component="edit-content">
      <Dynamic component={fileComponent} mode="diff" />
    </div>
    <DiagnosticsDisplay ... />  // ← 移到 accordion 内部，和 diff 共享容器
  </ToolFileAccordion>
</BasicTool>
```

CSS 修订：

- `[data-component="diagnostics"]` 删除 `max-height: 112px` 和 `overflow-y: auto`。
- 在 `[data-component="edit-content"]` / `[data-component="write-content"]` 上设置联合 `max-height`（例如 `max-height: 320px`，约 16 行预算），`overflow-y: auto`。
- 这样 diff 8 行 + LSP 8 行 = 16 行，如果超过 320px，整个内容区滚动，而不是 LSP 独立撑高。
- diagnostics 的 `border-top` 仍保留，作为 diff 和 LSP 之间的视觉分隔。

为什么不改 `BasicTool`：

- `BasicTool` 控制的是整体折叠（open/close），不是内容区高度。
- 内容区高度预算属于 `edit-content` / `write-content` / `apply-patch-file-diff`，这些已经是工具特定的内容容器。
- 改 `BasicTool` 会影响所有工具（bash、read、grep 等），超出本次需求范围。

#### 13.3.3 apply_patch 的联合预算

apply_patch 多文件时，每个 `Accordion.Item` 的 `Accordion.Content` 内部已经有 `apply-patch-file-diff`。DiagnosticsDisplay 在多文件路径下目前在 accordion 列表外面。

修订方案：

- **单文件 apply_patch**：和 edit/write 一样，把 `DiagnosticsDisplay` 移到 `ToolFileAccordion` 内部。
- **多文件 apply_patch**：DiagnosticsDisplay 保留在 accordion 列表外面（因为它是跨文件聚合诊断），但给它设置 `max-height` 作为局部预算，不让它无限撑高。多文件场景的联合预算由 accordion 列表自身的折叠行为控制（每个文件可单独折叠）。

#### 13.3.4 不新增 `bridgeDiagnostics` 状态字段

当前实现为了防止 clean 误报，在 `State` 里加了 `bridgeDiagnostics?: "ok" | "failed"`，让 `status()` 在 diagnostics 失败后返回空。

修订方案：

- 删除 `bridgeDiagnostics` 字段。
- 改为在 tool 层（write/edit/apply_patch）的 `else` 分支里，用 `lsp.diagnostics()` 的返回值是否包含当前文件来判断 LSP 是否真的产生了诊断数据。
- 如果 `afterDiagnostics` 是空 `{}`（bridge 返回 undefined 后 fallback 到内置 LSP 也为空），且 `lsp.status()` 返回空，则 unavailable。
- 如果 `afterDiagnostics` 非空但当前文件没有诊断条目，且 `lsp.status()` 非空，则 clean。
- 这样不需要在 LSP Service 里新增状态字段，只在 tool 层用已有信息判断。

但这有一个边界：bridge 返回 `{ diagnostics: [] }`（成功但无诊断）vs bridge 返回 `undefined`（失败）。当前 `bridgeDiagnosticsToMap` 在失败时返回 `undefined`，tool 层拿到的 `afterDiagnostics` 会 fallback 到内置 LSP 的空 `{}`。

更简单的修订：

- 在 `diagnostics()` 的 bridge 分支，如果 `bridgeDiagnosticsToMap` 返回 `undefined`，直接 `return {}`（空 map），**不 fallback** 到内置 LSP。因为 bridge 环境下内置 LSP 通常也没有（bridge 存在意味着用户在 VSCode 里，VSCode 的 LSP 扩展就是诊断源）。
- 这样 tool 层只需要检查 `lsp.status()` 是否非空：bridge diagnostics 成功时 status 返回 VSCode connected，失败时 status 也返回空（因为 `bridgeDiagnostics !== "ok"`）。

但这又回到了需要 `bridgeDiagnostics` 字段。

**最终推荐**：保留 `bridgeDiagnostics` 字段，但把它收敛为 `diagnostics()` 内部的局部变量，不放入 `State`。

具体做法：

- `diagnostics()` 在 bridge 分支成功时返回 mapped 结果。
- `diagnostics()` 在 bridge 分支失败时 `return {}`（不 fallback）。
- `status()` 在 bridge 存在时，额外调用一次 `diagnostics()` 来验证是否可用？不行，这会有双重请求。

**更务实的修订**：保留 `bridgeDiagnostics` 在 `State` 里，但把注释写清楚它只服务于 `status()` 的 clean 防误报，不暴露给外部。这是当前实现已经做到的，只是注释不够充分。把这个字段的注释补到位即可，不需要删除。

#### 13.3.5 不改 baseline 采集位置

当前实现把 baseline 从“写入后、touch 前”前移到“写入前”。

修订方案：**回退 baseline 前移**，保持原有采集时序（写入后、touch 前）。

原因：

- baseline 前移是为了解决“VSCode watcher 可能在 `diagnostics()` 调用前已刷新”的时序问题。
- 但这个时序问题在实际使用中很少触发（watcher 刷新通常有延迟），且前移 baseline 会改变 3 个 tool 文件的结构，增加回归风险。
- 如果确实出现 baseline 已包含新错误的情况，delta 会偏小（新错误被归为 existing），但这不会导致 clean 误报（因为 `existingCount > 0` 时不会 clean）。
- 最坏情况是“新错误被归为 existing，output 显示 `0 new · N existing`”，这比“clean 误报”安全得多。

因此回退 baseline 前移，保持原有结构。

### 13.4 修订后预计文件改动

| 文件 | 类型 | 具体改动 |
| --- | --- | --- |
| `packages/ui/src/components/message-part.tsx` | 修改 | 内联 presenter 函数；`DiagnosticsDisplay` 移到 `ToolFileAccordion` 内部；apply_patch 单文件同步移入 |
| `packages/ui/src/components/message-part.css` | 修改 | 删除 diagnostics 独立 `max-height`；在 `edit-content`/`write-content` 上设联合 `max-height` + `overflow-y: auto` |
| `packages/opencode/src/lsp/lsp.ts` | 修改 | bridge touchFile light/strong 分流（2 行）；`bridgeDiagnostics` 状态 + `status()`/`diagnostics()` 防误报（保留，补注释） |
| `packages/opencode/src/lsp/diagnostic.ts` | 修改 | `checkedMessage()` 纯函数（保留） |
| `packages/opencode/src/tool/write.ts` | 修改 | clean/existing output 短确认 + summary 条件传递（保留） |
| `packages/opencode/src/tool/edit.ts` | 修改 | 同 write（保留）；回退 baseline 前移 |
| `packages/opencode/src/tool/apply_patch.ts` | 修改 | 同 write（保留）；回退 baseline 前移 |
| `packages/opencode/test/lsp/index.test.ts` | 修改 | bridge touch light/strong 测试 + bridge diagnostics 失败测试（保留） |
| `packages/opencode/test/lsp/lifecycle.test.ts` | 修改 | `checkedMessage` 测试（保留） |
| `packages/opencode/test/tool/edit.test.ts` | 修改 | unavailable 时不传 summary 断言（保留） |
| `packages/opencode/test/tool/write.test.ts` | 修改 | unavailable 时不传 summary 断言（保留） |
| `docs/lsp-diagnostics-ui-read-touch-implementation-plan.md` | 修改 | 本文档（保留） |

删除的文件：

- `packages/ui/src/components/diagnostics-display.ts`（内联到 message-part.tsx）
- `packages/ui/src/components/diagnostics-display.test.ts`（删除，行为由 lifecycle + TUI 覆盖）

修订后文件数：12 个修改 + 0 个新增 = 12 个。

如果进一步要求 ≤ 10：

- 可以把 `test/tool/edit.test.ts` 和 `test/tool/write.test.ts` 的 unavailable 断言合并到 `test/lsp/lifecycle.test.ts`（因为 `checkedMessage` 已在那里测，unavailable 是其反例）。
- 这样删除 2 个测试文件改动，文件数降到 10。

### 13.5 联合行数预算的具体 CSS 设计

```css
/* edit/write 内容区：diff + LSP 共享行数预算 */
[data-component="edit-content"],
[data-component="write-content"] {
  /* 联合预算：约 16 行 × 20px = 320px。
     diff 和 LSP 诊断在这个容器内共同竞争高度。
     超过时整体滚动，而不是 LSP 独立撑高。 */
  max-height: 320px;
  overflow-y: auto;
  scrollbar-width: none;
  &::-webkit-scrollbar { display: none; }
}

/* diagnostics 不再有独立 max-height */
[data-component="diagnostics"] {
  /* 删除 max-height: 112px 和 overflow-y: auto */
  /* 保留 border-top 作为与 diff 的视觉分隔 */
  flex-shrink: 0; /* 诊断块不被压缩，由容器滚动处理 */
}
```

apply_patch 多文件场景：

```css
/* 多文件 patch 的诊断块保留独立 max-height，因为它在 accordion 外面 */
[data-component="apply-patch-tool"] > [data-component="diagnostics"] {
  max-height: 112px;
  overflow-y: auto;
}
```

### 13.6 修订后的状态矩阵（不变）

状态矩阵和模型输出样例保持 Section 5.6.2 不变。修订只影响：

1. TUI 附加位置（从 accordion 外移到内）。
2. 高度预算方式（从 LSP 独立限高改为 diff+LSP 联合限高）。
3. 文件数收敛（删除 2 个新增文件）。
4. baseline 时序回退（不改采集位置）。

### 13.7 修订后的验证命令

从 `packages/ui`：

```sh
bun typecheck
```

从 `packages/opencode`：

```sh
bun test test/lsp/index.test.ts test/lsp/lifecycle.test.ts test/tool/edit.test.ts test/tool/write.test.ts
bun typecheck
```

### 13.8 修订后的 subagent 审计要点

需要 subagent 重新审计：

1. `DiagnosticsDisplay` 移到 `ToolFileAccordion` 内部后，是否影响 accordion 的展开/折叠行为。
2. 联合 `max-height` 是否会导致短 diff + 短 LSP 时出现不必要的滚动条。
3. 删除 `diagnostics-display.ts` 后，归一化/截断逻辑内联到 `message-part.tsx` 是否影响可读性。
4. 回退 baseline 前移后，是否重新引入“VSCode watcher 抢先刷新”的时序风险。
5. 文件数是否确实 ≤ 10。

### 13.9 修订方案摘要

本次修订的核心是三件事：

1. **把 LSP 诊断从 accordion 外面移到里面**，让 diff 和 LSP 共享同一个 `max-height` 预算，超过时整体滚动而不是各自撑高。
2. **删除独立的 presenter 文件和测试文件**，把逻辑内联到 `message-part.tsx`，减少文件数。
3. **回退 baseline 前移**，保持原有 tool 结构不变，降低回归风险。

`bridgeDiagnostics` 状态字段保留（它是防 clean 误报的必要机制），但补充注释说明其语义边界。`checkedMessage` 纯函数保留。read/touch 分流保留。

修订后文件数目标：≤ 10（含文档）。

### 13.10 subagent 修订方案审计结果

审计结论：**无阻塞性意见**。

最重要的非阻塞建议（已纳入方案）：

1. **不要删除测试文件**：6 个 presenter 边界测试（多行归一化、截断、hidden/clean/existing/error 三态、+N more、changed-files scope）值得保留。改为从 `message-part.tsx` 导出 `prepareDiagnosticsDisplay` 即可，不需要独立 .ts 文件但保留测试。因此文件数为 12（含文档），不强制 ≤ 10，因为牺牲测试组织换文件数不值得。
2. **修正多文件 CSS 选择器**：`[data-component="apply-patch-tool"] > [data-component="diagnostics"]` 的 `>` 直接子选择器不匹配，因为中间隔着 BasicTool 的 DOM 包裹。应改用后代选择器（去掉 `>`）。
3. **补充文档遗漏**：
   - 折叠行为变更：DiagnosticsDisplay 移入 accordion 后，折叠 diff 会同时隐藏诊断块。这是有意的 trade-off：诊断和 diff 共享同一内容区，折叠一个即折叠全部。
   - baseline 回退后 new/existing 标注精度下降：如果 VSCode watcher 抢先把新错误吸收进 baseline，新错误可能被误标为 existing。但这不会导致 clean 误报（existingCount > 0 时不 clean），最坏情况是 output 显示 "0 new · N existing" 而非 "N new errors"。

其他非阻塞确认：

- Kobalte Collapsible 高度动画在子元素设 max-height 后可能过冲，需实现时实测。
- `flex-shrink: 0` 在非 flex 容器上是 no-op，实现时删除。
- 空 diff + 诊断状态、write 新文件、edit create、apply_patch move/delete 路径均无问题。
