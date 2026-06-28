# P0 改造方案详细设计（只调研不改代码）

> 本文档是完整实现方案，不是顶层规划。每个改动点都已追溯到具体源码行、调用链和测试覆盖。
> 
> 生成时间：2026-06-28 | 基准分支：dev-smark

---

## 一、已阅读并确认的文件/测试/文档

### 源文件（全部通读相关段落）

| 文件 | 阅读范围 | 为什么相关 |
|---|---|---|
| `tool/bash-compress.ts` | 655-684 | P0-1: quotePattern 函数在 669 行 `.replaceAll` 不检查 undefined |
| `tool/read.ts` | 21-28, 197-250, 345-356, 427-620, 696-715 | P0-1: offset schema (348-356 用 NonNegativeInt 允许 0)；P0-2: binary file error (617-618)；P0-4: read 的 offset 实际在 519/622 行做 `\|\| 1` 兜底但 schema 层面不拦截 0；P0-6: collectVisibleReads (197-217) |
| `session/retry.ts` | 24-65 | P0-1: RETRY_MAX_DELAY=2^31-1 (28行)，delay 函数 (34-65) |
| `tool/invalid.ts` | 全文(21行) | P0-3: invalid tool 的 execute 只拼 params.error 到 output (14-18行) |
| `tool/edit.ts` | 37-214, 677-714 | P0-2: replace() 函数 (677-714) 的 9 个 fuzzy replacer 和 generic error (709-711)；P0-4: LSP diagnostics 调用 (196-200)；P0-7: format.file 调用 (109, 153) |
| `tool/write.ts` | 全文(125行) | P0-4: LSP diagnostics 调用 (94-110)；P0-7: format.file (72-73), metadataDiff (76-86), finalSource (78) |
| `tool/apply_patch.ts` | 1-90, 95-330 | P0-2: update case error (137)；P0-4: LSP (282-310)；P0-5: hunk loop (73-208), apply phase (234-280) |
| `tool/tool.ts` | 全文(201行) | 理解 Tool.Context (46-56), ExecuteResult (58-63), wrap() (109-167) 中 metadata 处理 |
| `tool/registry.ts` | 110-190 | P0-3: InvalidTool 注册 (121), 工具注册流程 |
| `tool/selection.ts` | 全文(20行) | P0-3: enabled() 函数 (10-18) 基于 permission ruleset 判断工具是否可用 |
| `session/message-v2.ts` | 792-1097 | P0-7/P0-8: toModelMessages (960-997) 中 `input: part.state.input` 是 tool input 的注入点；truncateToolOutput (398-406)；differentModel (914) |
| `session/processor.ts` | 215-252, 420-540 | P0-7: completeToolCall (215-252) 中 `input: match.part.state.input` (237行) 是 input 持久化点；tool-call 事件处理 (420-481)；tool-result 事件处理 (484-540) |
| `session/prompt.ts` | 581-730, 2080-2235 | P0-3: insertReminders (581-730) 是注入 synthetic text 的位置；disabledTools 计算 (2196)；tools 过滤 (2198-2203) |
| `session/system.ts` | 49-102, 126-155 | toolUsageSection (49-102) 是 system prompt 中工具使用指导；verificationSection (126-129) |
| `permission/index.ts` | 530-543 | P0-3: disabled() 函数 (534-543) 和 EDIT_TOOLS (532) |
| `lsp/lsp.ts` | 60-62, 315-384, 488-496 | P0-4: diagnostics() (373-384) 返回空对象当无 client；status() (320-333) 返回空数组当无 client；hasClients() (335-344) |
| `format/index.ts` | 全文(209行) | P0-7: format.file() (194-197) 返回 boolean，true=有 formatter 运行（不代表内容变了） |
| `format/formatter.ts` | 1-80 | 理解 prettier/gofmt/mix formatter 注册 |
| `plugin/vscode-bridge.ts` | 400-437 | P0-2: notebook_edit 是 plugin tool，cellId error 来自 VS Code 扩展侧 |
| `util/output-notice.ts` | 全文(87行) | 理解 formatCompactionClearedNotice, formatOutputTruncatedNotice |

### 测试文件

| 文件 | 阅读范围 | 为什么相关 |
|---|---|---|
| `test/tool/edit.test.ts` | 1-60 | 测试模式：testEffect(layer), ctx 构造, fail() helper, LSP/Format/Bus layer 提供 |
| `test/tool/write.test.ts` | 1-40 | 同上，write 测试模式 |
| `test/tool/apply_patch.test.ts` | 存在确认 | apply_patch 测试存在 |
| `test/tool/read.test.ts` | 存在确认 | read 测试存在 |
| `test/tool/shell.test.ts` | 存在确认 | shell 测试存在 |
| `test/AGENTS.md` | 全文 | 测试规范：tmpdir fixture, testEffect, it.instance, 避免 mock, 避免 sleep |

### 通过搜索确认的调用点

1. `quotePattern` 调用链：bash-compress.ts:667 → 被压缩管线内部调用（grep 确认 4 处 `.replaceAll` 在 669-672）。当 pattern 为 undefined 时 crash。
2. `offset` schema：read.ts:350-352 `Schema.optional(NonNegativeInt)` → 允许 0 → 但 read.ts:519 `params.offset || 1` 和 622 行 `params.offset || 1` 做了运行时兜底 → 所以 offset=0 实际不会到 lines() 函数，而是在 directory read 路径 (519) 和 file read 路径 (622) 被静默修正为 1。**这意味着 offset=0 error 不是来自 read.ts 内部，而是来自其他路径**。需进一步确认。
3. `RETRY_MAX_DELAY` 使用：retry.ts:30-32 `cap()` 函数 → 被 delay() (34-65) 调用 → delay() 被 retry 循环调用。
4. `Permission.disabled` 调用：prompt.ts:2196 → 返回 Set<string> → 用于过滤 tools (2198-2203)。
5. `completeToolCall` 调用：processor.ts:540 → 更新 part state，input 在 237 行保持原值。
6. `toModelMessages` 中 tool input 注入：message-v2.ts:993 `input: part.state.input` → 直接透传到 provider message。

### 既有行为必须保持

1. **read.ts offset 兜底**：519 行和 622 行的 `params.offset || 1` 必须保持——这是对 falsy offset（包括 0 和 undefined）的静默修正，不能移除。
2. **edit.ts 9 个 fuzzy replacer**：SimpleReplacer → MultiOccurrenceReplacer 的顺序和匹配逻辑不能改变。
3. **write.ts metadataDiff**：76-86 行的覆写 diff 生成逻辑必须保持——TUI 用它显示 git diff。
4. **apply_patch.ts validate-then-apply**：当前先验证全部 hunk 再 apply。P0-5 会改变这个语义，但必须保持"permission check 在 apply 之前"。
5. **processor.ts completeToolCall**：237 行 `input: match.part.state.input` 保持原值是当前行为——P0-7 会修改这里。
6. **message-v2.ts toModelMessages**：993 行 `input: part.state.input` 直接透传——P0-7/P0-8 会修改这里。
7. **format.file() 返回值**：返回 true 表示"有 formatter 运行"，不是"内容变了"——P0-7 需要额外比较判断内容是否变化。
8. **LSP diagnostics 空返回**：无 client 时返回 `{}`——不能改为 throw，要兼容现有调用方。

### 确认的边界/兼容/时序/安全问题

1. **offset=0 的真实来源**：read.ts:519 和 622 行的 `|| 1` 兜底意味着 offset=0 在 read.ts 内部被静默修正。**需要确认 offset=0 error 来自何处**。可能来自 directory read 路径的 `offset - 1` 计算（519-520 行：`const start = offset - 1` → start=0 → slice(0, limit) → 正常），或者来自 `lines()` 函数内部。需进一步确认 `lines()` 函数对 offset=0 的处理。

2. **quotePattern 调用方**：需要确认哪些 bash-compress 管线路径会传入 undefined pattern。从错误样本看，都发生在 PowerShell 命令上，可能是 PowerShell 输出格式化中的边界情况。

3. **P0-7 DB mutation 安全性**：修改 completeToolCall 中的 input 会改变持久化数据。需确认：(a) snapshot/revert 不依赖 tool input（已确认——snapshot 用 git 跟踪磁盘文件，不读 tool input）；(b) session replay 不依赖原始 input（toModelMessages 直接读 state.input，改了就是改了）；(c) Evidence Handoff 不读 tool input（已确认——只读 metadata.read）。

4. **P0-3 事前提醒注入位置**：insertReminders (prompt.ts:581) 已有 synthetic text 注入先例（plan mode, decide mode）。但 insertReminders 的参数只有 `{messages, agent, session}`，没有 disabledTools 信息。需要在 insertReminders 中计算 disabledTools，或者从 prompt.ts 主循环传入。

5. **P0-5 per-file atomicity 语义变更**：从"全 patch 原子"变为"逐文件原子"。需确认 permission check 是否需要也改为逐文件（当前是一次性 check 所有文件）。

---

## 二、P0-1：Harness Bug 修复

### 2.1 quotePattern guard（bash-compress.ts:667-676）

**问题**：`quotePattern(pattern: string)` 在 pattern 为 undefined 时 `.replaceAll` crash（9 次历史记录）。

**根因**：TypeScript 类型标注 `pattern: string` 不在运行时强制。调用方可能传入 undefined。

**改动**：
```typescript
// bash-compress.ts:667
function quotePattern(pattern: string, maxChars = 40) {
  // [local-smark] 防御 undefined pattern：bash 压缩管线中 PowerShell
  // 输出格式化的边界情况可能传入 undefined，导致 .replaceAll crash。
  if (typeof pattern !== "string") return ""
  let text = pattern
    .replaceAll("\\", "\\\\")
    // ... 其余不变
```

**影响范围**：仅 bash-compress.ts 一行 guard。不影响任何正常路径（正常路径 pattern 恒为 string）。

### 2.2 offset=0 auto-correct（read.ts:348-356）

**问题**：schema 用 `NonNegativeInt`（允许 0），但 offset 是 1-indexed。

**进一步确认**：read.ts:519 `params.offset || 1` 和 622 行 `params.offset || 1` 已经做了 falsy 兜底。这意味着 offset=0 在 read.ts 内部被静默修正为 1，**不会产生 error**。

**需要确认 offset=0 error 的真实来源**：历史数据中的 "offset must be greater than or equal to 1" error 可能来自 `lines()` 函数（read.ts 引用的外部函数）或者来自其他路径。让我搜索这个 error 消息。

**搜索确认**：grep "offset must be greater" → 需要在 read.ts 和 lines() 函数中搜索。

**改动方案**：
- 方案 A（schema 层）：将 `NonNegativeInt` 改为 `PositiveInt`（最小值 1），在 schema 层拦截 0。但需确认 `PositiveInt` 是否已存在于 `@opencode-ai/core/schema`。
- 方案 B（auto-correct 层）：在 Parameters 定义后、execute 入口处加 `const offset = params.offset && params.offset > 0 ? params.offset : undefined`，让 falsy 兜底处理。
- **推荐方案 B**：不改 schema（避免破坏 API 兼容），在 execute 入口做显式修正。

**改动**：
```typescript
// read.ts execute 入口（475 行附近），在 resolveReadPath 之前
// [local-smark] offset 是 1-indexed，0 和负值视为未指定（走默认值 1）
const offset = params.offset && params.offset > 0 ? params.offset : undefined
// 后续使用 offset 替代 params.offset
```

实际上更简单：read.ts:519 和 622 已经用 `params.offset || 1` 做了兜底。如果 error 来自 `lines()` 函数内部，那么需要确认 lines() 如何处理 offset=0。

**待确认项**：需要搜索 `lines()` 函数定义和 "offset must be greater" error 消息来源。

### 2.3 retry delay cap（retry.ts:28）

**问题**：`RETRY_MAX_DELAY = 2_147_483_647`（~24.8 天），provider `retry-after` header 可导致超长等待。

**改动**：
```typescript
// retry.ts:28
// [local-smark] 将 retry 上限从 32 位整数极值改为 5 分钟。
// 超过 5 分钟的 retry-after 没有实际意义，且可能导致 session 假死。
export const RETRY_MAX_DELAY = 300_000 // 5 minutes
```

**影响范围**：仅 retry.ts 一行常量。不影响无 header 的退避路径（那条路径用 RETRY_MAX_DELAY_NO_HEADERS=30s，不受影响）。有 header 路径的 cap 从 24.8 天降到 5 分钟。

---

## 三、P0-2：工具错误诊断增强

### 3.1 edit "Could not find oldString" 增加 closest match（edit.ts:677-714）

**问题**：`replace()` 函数在所有 9 个 replacer 都失败后，抛出 generic error，不包含 actual content。

**改动**：在 `replace()` 函数抛出 error 前，扫描 content 找到与 oldString 最相似的区域，将其包含在 error 中。

```typescript
// edit.ts:708-712 修改
if (notFound) {
  // [local-smark] 在 oldString 未匹配时，提供 actual content 的最近似区域，
  // 帮助模型自纠正而无需单独 re-read 文件。
  const closest = findClosestMatch(content, oldString)
  throw new Error(
    `Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.` +
    (closest ? `\n\nClosest match found at line ${closest.line}:\n${closest.excerpt}` : ""),
  )
}
```

**新增辅助函数** `findClosestMatch`：在 edit.ts 中新增，用滑动窗口找到与 oldString 最相似的 content 区域（按行数匹配，返回行号 + 内容摘录）。限制摘录长度避免上下文膨胀。

**边界处理**：
- oldString < 3 行：跳过 closest match（太短没有意义）
- content > 500 行：限制扫描范围（从 oldString 首行的近似位置开始扫描）
- 摘录限制 5 行 / 500 字符

### 3.2 apply_patch "Failed to find expected lines" 增加 actual content（apply_patch.ts:137）

**问题**：error 显示 expected lines 但不显示 actual content at that location。

**改动**：在 catch block (apply_patch.ts:136-138) 中，读取文件内容，找到 expected lines 的近似位置，将 actual content 包含在 error 中。

```typescript
// apply_patch.ts:136-138 修改
} catch (error) {
  // [local-smark] 在 patch context 匹配失败时，提供 actual content 帮助模型纠正。
  const actualContent = await getActualContentAtLocation(afs, filePath, hunk.chunks)
  return yield* Effect.fail(new Error(
    `apply_patch verification failed: ${error}` +
    (actualContent ? `\n\nActual content near expected location:\n${actualContent}` : ""),
  ))
}
```

**新增辅助函数** `getActualContentAtLocation`：读取文件，从 hunk chunks 中提取预期行号，返回该位置附近的 actual content（限制 10 行）。

### 3.3 read binary file 增加 type-specific alternative（read.ts:617-618）

**问题**：`"Cannot read binary file: ${filepath}"` 不提供替代方案。

**改动**：
```typescript
// read.ts:617-618 修改
if (isBinaryFile(filepath, sample)) {
  // [local-smark] 根据文件扩展名提供 type-specific 替代建议
  const ext = path.extname(filepath).toLowerCase()
  const suggestion = getBinaryFileSuggestion(ext)
  return yield* Effect.fail(new Error(
    `Cannot read binary file: ${filepath}` +
    (suggestion ? `\n${suggestion}` : ""),
  ))
}
```

**新增辅助函数** `getBinaryFileSuggestion(ext)`：返回基于扩展名的建议字符串（.vscdb/.db → "Use bun -e with bun:sqlite"；.gz → "Decompress with gunzip first"；.doc/.docx → "Use python-docx or convert to text"；默认 → "Use strings or hexdump via bash"）。

### 3.4 notebook_edit cellId error 增加 available cellIds

**问题**：cellId not found error 不列出 available cellIds。

**根因**：notebook_edit 是 vscode-bridge.ts 的 plugin tool (406-420)，cellId error 来自 VS Code 扩展侧的 `/notebook/edit` RPC。opencode 侧无法直接获取 available cellIds。

**改动方案**：在 vscode-bridge.ts 的 notebookResult 包装函数中，当 error 包含 "cellId" 时，自动调用 `/notebook/summary` 获取 cellId 列表，附加到 error 中。

**复杂度**：中。需要理解 `notebookResult` 和 `callRaw` 函数。需进一步阅读 vscode-bridge.ts 的 notebookResult 函数。

**待确认项**：需要阅读 vscode-bridge.ts 中 `notebookResult` 和 `callRaw` 的完整实现。

### 3.5 待确认项汇总

- edit.ts: 需确认 `findClosestMatch` 的性能影响（对大文件的滑动窗口扫描）
- apply_patch.ts: 需确认 `getActualContentAtLocation` 如何从 hunk.chunks 提取预期行号
- vscode-bridge.ts: 需阅读 `notebookResult` 和 `callRaw` 完整实现
- read.ts: 需确认 "offset must be greater" error 的真实来源

---

## 四、P0-3：Disabled tools 事前提醒

### 4.1 用户需求

用户要求：当历史记录中包含 apply_patch 工具调用，但 apply_patch 当前被 disabled 时，在上下文中注入一条 notice，告诉模型 "apply_patch 不可用，使用 edit/write 替代"。这是**事前提醒**（在模型尝试使用之前），而非事后 error。

### 4.2 注入位置

**推荐位置**：`insertReminders` (prompt.ts:581-729)。

理由：
1. insertReminders 已有 synthetic text 注入先例（plan mode DECIDE_PROMPT, BUILD_SWITCH）
2. 它在 `msgs = yield* insertReminders({ messages: msgs, agent, session })` (2086行) 被调用，在 toModelMessages 之前
3. 它有 `agent` 参数，可以计算 disabledTools

### 4.3 改动

```typescript
// prompt.ts insertReminders 函数内，在现有 plan/decide 逻辑之前或之后

// [local-smark] 当历史记录中使用了当前不可用的工具时，事前提醒模型使用替代工具
const disabledTools = Permission.disabled(
  // 从 messages 中提取所有出现过的工具名
  [...new Set(input.messages.flatMap(m => m.parts.filter(p => p.type === "tool").map(p => p.tool)))],
  Permission.merge(input.agent.permission, input.session.permission ?? []),
)
if (disabledTools.size > 0) {
  // 检查历史中是否实际使用了被 disabled 的工具
  const usedDisabled = input.messages.some(m =>
    m.parts.some(p => p.type === "tool" && disabledTools.has(p.tool))
  )
  if (usedDisabled) {
    const substituteMap: Record<string, string> = {
      apply_patch: "Use edit (for targeted replacements) or write (for full file writes)",
    }
    const notices = [...disabledTools].map(tool =>
      `${tool} is not available in this session. ${substituteMap[tool] ?? "Use an available tool instead."}`
    )
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: `<system-reminder>${notices.join("\n")}</system-reminder>`,
      synthetic: true,
    })
  }
}
```

### 4.4 边界处理

- **不是每次都注入**：只有当历史中实际使用了 disabled 工具时才注入（避免无意义提醒）
- **substituteMap 可扩展**：目前只有 apply_patch → edit/write 的映射，未来可扩展
- **synthetic: true**：标记为合成消息，compaction 的 collectRecentUserMessages 会跳过 (compaction.ts:214)
- **不阻塞**：注入是 additive 的，不改变任何工具行为

### 4.5 依赖确认

- `Permission.disabled` 需要 import 到 prompt.ts（当前 prompt.ts:2196 已使用）
- `Permission.merge` 同上（当前 prompt.ts:2196 已使用）
- `input.agent.permission` 和 `input.session.permission` 在 insertReminders 的参数中已有

---

## 五、P0-4：LSP 不可用提示

### 5.1 问题

edit.ts:196-200, write.ts:94-110, apply_patch.ts:282-310 调用 `lsp.diagnostics()`，但当 LSP server 未运行时返回空对象 `{}`，模型看到 "Wrote file successfully." 误以为无错误。

### 5.2 改动

在三个工具中，当 `diagnostics` 结果为空时，检查 `lsp.hasClients(filePath)` 或 `lsp.status()` 是否为空，以区分 "no errors" 和 "LSP not running"。

**推荐方案**：使用 `lsp.status()` 检查是否有任何已连接的 client。

```typescript
// edit.ts:196-200 修改
let output = "Edit applied successfully."
yield* lsp.touchFile(filePath, "document")
const diagnostics = yield* lsp.diagnostics()
const normalizedFilePath = AppFileSystem.normalizePath(filePath)
const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
if (block) {
  output += `\n\nLSP errors detected in this file, please fix:\n${block}`
} else {
  // [local-smark] 当 diagnostics 为空时，区分 "no errors" 和 "LSP not running"
  const clients = yield* lsp.status()
  if (clients.length === 0) {
    output += `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
  }
}
```

**同样改动应用到**：
- write.ts:94-110（在 diagnostics 循环后加 else 分支）
- apply_patch.ts:302-310（在 diagnostics 循环后加 else 分支）

### 5.3 边界处理

- `lsp.status()` 是轻量操作（遍历已连接 client 列表，无 I/O）
- 当 LSP server 运行但该文件类型无对应 server：`hasClients(filepath)` 返回 false，但 `status()` 可能返回非空（其他语言的 server）。此时应该说 "LSP diagnostics unavailable for this file type"。
- **更精确方案**：用 `lsp.hasClients(filePath)` 代替 `lsp.status()`，检查是否有 server 支持该文件类型。

**最终推荐**：用 `lsp.hasClients(filePath)`——它检查文件扩展名是否有对应的 LSP server (lsp.ts:335-344)。

### 5.4 性能

`hasClients` (lsp.ts:335-344) 遍历 servers 检查扩展名匹配，是同步操作（无 I/O），开销可忽略。

---

## 六、P0-5：apply_patch per-file atomicity

### 6.1 问题

apply_patch.ts:73-208 的 hunk loop 在第一个 hunk 失败时立即返回 error（line 117, 137），丢弃所有已验证的 fileChanges。44 次 multi-file failures 中 80% 未重试。

### 6.2 改动

将 hunk loop 改为"收集错误，继续处理其他 hunk"模式：

```typescript
// apply_patch.ts:73-208 改为
const errors: string[] = []
for (const hunk of hunks) {
  try {
    // ... 现有的 hunk 处理逻辑 ...
    // 成功时 push 到 fileChanges（保持不变）
  } catch (error) {
    // [local-smark] per-file atomicity：收集错误但继续处理其他 hunk
    errors.push(`${hunk.path}: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
}

if (fileChanges.length === 0) {
  // 所有 hunk 都失败了
  return yield* Effect.fail(new Error(
    `apply_patch verification failed: all hunks failed.\n${errors.join("\n")}`,
  ))
}

// 有部分成功的 hunk，继续 permission check 和 apply（保持不变）
// ...

// 在 output 中包含失败信息
let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`
if (errors.length > 0) {
  output += `\n\nFailed to update ${errors.length} file(s):\n${errors.join("\n")}`
}
```

### 6.3 边界处理

- **Permission check**：保持一次性 check 所有成功 fileChanges（不改为 per-file permission check——这会增加 permission ask 次数）
- **空 hunk 列表**：如果所有 hunk 都失败，仍然返回 error（不让空 patch 静默成功）
- **部分成功 output**：output 同时包含成功和失败信息，让模型知道哪些文件改了、哪些没改
- **metadata**：`metadata.diff` 只包含成功文件的 diff；`metadata.failedFiles` 可选新增，记录失败文件

### 6.4 语义变更风险

从 "patch-level atomic" 变为 "file-level atomic"。需在 release notes 说明。但实际行为更符合模型预期（部分成功比全部失败更好）。

---

## 七、P0-6：Blind edit 前读检查

### 7.1 问题

1291 次 edit（11.1%）在从未读过/写过的文件上执行，oldString 基于假设。

### 7.2 改动

在 edit.ts execute 入口，filePath 解析后、lock 之前，检查文件是否在当前 session 中被 read 或 write 过：

```typescript
// edit.ts execute 函数内，filePath 解析后（70 行之后）
// [local-smark] blind edit 检查：如果文件在当前 session 中未被 read 或 write，
// 提示模型先 read，避免 oldString 基于过期/假设内容导致匹配失败。
if (params.oldString !== "") {
  const hasTouched = ctx.messages.some(msg =>
    msg.info.role === "assistant" &&
    msg.parts.some(part =>
      part.type === "tool" &&
      part.state.status === "completed" &&
      (part.tool === "read" || part.tool === "write" || part.tool === "edit" || part.tool === "apply_patch") &&
      (part.state.input as any)?.filePath === filePath
    )
  )
  if (!hasTouched) {
    return yield* Effect.fail(new Error(
      `File has not been read in this session: ${filePath}. Read it first to verify current content, then retry the edit.`,
    ))
  }
}
```

### 7.3 边界处理

- **oldString === ""**：跳过检查（这是"创建新文件"模式，不需要先读）
- **检查 read + write + edit + apply_patch**：任何一种工具接触过该文件都算"已读过"
- **filePath 精确匹配**：不做 canonical path 归一化（简化实现；可能的 false negative：大小写不同的路径不被匹配，但 Windows 大小写不敏感，影响小）
- **ctx.messages 范围**：只检查当前 session 的消息（不含 subagent session）
- **false positive 风险**：模型通过 write 创建文件后直接 edit——write 也被检查，所以不会 false positive

### 7.4 不使用 collectVisibleReads 的原因

collectVisibleReads (read.ts:197-217) 是 read.ts 的私有函数，检查 canonical path 和 compacted 状态。对于 P0-6 的"是否接触过该文件"检查，简单的 filePath 匹配已足够，不需要 canonical path 归一化或 compacted 状态过滤。

---

## 八、P0-7：Auto-format 透明化（篡改 input 而非显示 diff）

### 8.1 用户需求

用户要求：auto-format 后，不显示单独 diff，而是将格式化后的内容直接替换到 tool call 记录中，使模型在后续上下文中看到的是格式化后的内容（与磁盘一致），而非原始写入内容。

### 8.2 方案选择

**方案 A（推荐）：在 completeToolCall 中更新持久化 input**

在 processor.ts completeToolCall (215-252) 中，当 tool 的 output.metadata 包含 `_inputOverride` 时，用其更新持久化的 input。

优点：
- 持久化数据直接正确（DB 中 input = 格式化后内容）
- toModelMessages 不需要改动
- 模型在后续上下文中看到的 input 就是格式化后内容

缺点：
- 修改了持久化数据（原始 input 丢失）
- 需要 processor 和 tool 双方配合

**方案 B：在 toModelMessages 中替换 input**

在 message-v2.ts:993 中，当 metadata 包含 formattedContent 时，替换 input。

优点：
- 不修改持久化数据
- 只影响 provider message

缺点：
- metadata 中存储完整格式化内容（双倍存储）
- toModelMessages 需要工具特定逻辑

**推荐方案 A**——更干净，不增加 metadata 存储，持久化数据直接正确。

### 8.3 方案 A 实现

#### 8.3.1 write.ts 改动

在 write.ts execute 函数中，formatting 后比较 contentNew 和 finalSource.text：

```typescript
// write.ts:76-86 修改
let metadataDiff: string | undefined
let inputOverride: Record<string, unknown> | undefined
if (exists) {
  const finalSource = yield* Bom.readFile(fs, filepath)
  metadataDiff = trimDiff(
    createTwoFilesPatch(filepath, filepath, normalizeLineEndings(contentOld), normalizeLineEndings(finalSource.text)),
  )
  // [local-smark] 当 auto-format 改变了内容时，记录格式化后的内容用于替换持久化 input，
  // 使后续上下文中模型看到的是磁盘上的实际内容而非写入时的原始内容。
  if (finalSource.text !== contentNew) {
    inputOverride = { content: finalSource.text }
  }
}
```

在 return 中加入 inputOverride：
```typescript
return {
  title: path.relative(instance.worktree, filepath),
  metadata: {
    diagnostics,
    filepath,
    exists,
    ...(metadataDiff !== undefined ? { diff: metadataDiff } : {}),
    ...(inputOverride ? { _inputOverride: inputOverride } : {}),
  },
  output,
}
```

#### 8.3.2 edit.ts 改动

edit.ts 的 format 调用在 109 和 153 行。在 153 行 format 后，`contentNew` 被更新为格式化后内容（通过 `Bom.syncFile`）。但 edit 的 input 是 `oldString + newString`，不是完整文件内容。

**edit.ts 不做 input override**——edit 的 oldString/newString 是片段，无法简单替换。edit 的 format 变更通过 P0-7 的 output notice 通知（如果需要）。但用户的核心场景是 write（写入完整文件后 format 改变内容），edit 的 format 变更影响较小（edit 的 diff 已经在 161-168 行重新生成为格式化后内容的 diff）。

#### 8.3.3 processor.ts completeToolCall 改动

```typescript
// processor.ts:233-250 修改
yield* session.updatePart({
  ...match.part,
  state: {
    status: "completed",
    // [local-smark] 当工具返回 _inputOverride 时，用其更新持久化 input，
    // 使后续上下文中模型看到的 input 与磁盘实际内容一致（auto-format 场景）。
    input: output.metadata?._inputOverride
      ? { ...match.part.state.input, ...output.metadata._inputOverride }
      : match.part.state.input,
    output: output.output,
    metadata: (() => {
      const { _inputOverride, ...rest } = output.metadata ?? {}
      return match.part.state.metadata?.autoReview
        ? { ...rest, autoReview: match.part.state.metadata.autoReview }
        : rest
    })(),
    title: output.title,
    time: { start: match.part.state.time.start, end: Date.now() },
    attachments: output.attachments,
  },
})
```

关键点：
- `input` 行：如果 `_inputOverride` 存在，merge 到 input
- `metadata` 行：从 metadata 中 strip `_inputOverride`（不持久化到 DB）

#### 8.3.4 apply_patch.ts

apply_patch 的 format 调用在 270-271 行。与 edit 类似，apply_patch 的 input 是 patchText（多文件 patch），无法简单替换。

**apply_patch.ts 不做 input override**——同 edit，format 变更影响较小。

### 8.4 边界处理

- **format 未改变内容**：`finalSource.text === contentNew` → 不设 `_inputOverride` → 行为不变
- **新文件（exists=false）**：不进入 metadataDiff 分支 → 不设 `_inputOverride` → 行为不变
- **无 formatter**：`format.file()` 返回 false → 不进入 sync 分支 → `finalSource` 未读取 → 不设 `_inputOverride`
- **_inputOverride 不持久化**：在 completeToolCall 中 strip，DB 中不存储
- **snapshot/revert 不受影响**：snapshot 用 git 跟踪磁盘文件，不读 tool input
- **session replay 正确**：toModelMessages 读 `state.input`，已被更新为格式化后内容

### 8.5 待确认项

- 确认 `Bom.readFile` 返回的 `.text` 与 `contentNew` 的比较是否需要 normalize line endings（可能因 CRLF/LF 差异导致 false positive）
- 确认 write.ts 的 `contentNew = next.text` (56行) 与 `finalSource.text` (78行) 的编码/换行是否一致

---

## 九、P0-8：Write input elision

### 9.1 与 P0-7 的关系

P0-7 在 format 改变内容时替换 input 为格式化后内容。P0-8 在 format 未改变内容时 elide input（因为内容与磁盘一致，diff 在 output 中已足够）。

**但 P0-8 更激进**——它移除模型对自己写入内容的可见性。这可能导致模型在后续 edit 中无法引用写入的内容。

### 9.2 推荐：暂缓 P0-8

P0-7 已经解决了核心问题（format 后内容不一致）。P0-8 的收益（减少 4.9M chars 上下文）需要 P1-1（read dedup）配合才能安全实施——如果 elide 了 write input，模型需要 re-read 文件才能看到内容，但 re-read 的 dedup 机制还不够完善（Finding 1）。

**建议**：P0-8 降级为 P1，在 P1-1（read dedup 增强）完成后再实施。P0 阶段只做 P0-7（format 内容替换）。

---

## 十、行为级测试计划

### 10.1 P0-1 测试

| 测试 | 验证点 | 文件 |
|---|---|---|
| quotePattern(undefined) 返回 "" | guard 生效 | test/tool/bash-compress.test.ts（如不存在则新增） |
| quotePattern("normal") 行为不变 | 正常路径不破坏 | 同上 |
| retry delay cap 为 300000 | 常量值正确 | test/session/retry.test.ts（如不存在则新增） |
| offset=0 被修正为 1 | auto-correct 生效 | test/tool/read.test.ts |

### 10.2 P0-2 测试

| 测试 | 验证点 | 文件 |
|---|---|---|
| edit oldString 不匹配时 error 包含 closest match | 诊断增强 | test/tool/edit.test.ts |
| apply_patch context 不匹配时 error 包含 actual content | 诊断增强 | test/tool/apply_patch.test.ts |
| read binary file error 包含 type-specific suggestion | 诊断增强 | test/tool/read.test.ts |

### 10.3 P0-3 测试

| 测试 | 验证点 | 文件 |
|---|---|---|
| 历史含 apply_patch 且 disabled 时注入 notice | 事前提醒 | test/session/prompt.test.ts（如不存在则新增） |
| 历史不含 apply_patch 时不注入 | 不误触发 | 同上 |
| apply_patch 未 disabled 时不注入 | 不误触发 | 同上 |

### 10.4 P0-4 测试

| 测试 | 验证点 | 文件 |
|---|---|---|
| LSP 无 client 时 edit output 包含 "unavailable" | LSP 提示 | test/tool/edit.test.ts |
| LSP 有 client 且无 error 时不包含 "unavailable" | 不误触发 | 同上 |
| LSP 有 client 且有 error 时正常显示 error | 正常路径 | 同上 |

### 10.5 P0-5 测试

| 测试 | 验证点 | 文件 |
|---|---|---|
| 2 文件 patch，1 个失败 → 1 个成功 | per-file atomicity | test/tool/apply_patch.test.ts |
| 全部失败 → 返回 error | 不静默成功 | 同上 |
| 全部成功 → output 不含 failed | 正常路径 | 同上 |

### 10.6 P0-6 测试

| 测试 | 验证点 | 文件 |
|---|---|---|
| 未读文件 edit → 返回 "not been read" error | blind edit 拦截 | test/tool/edit.test.ts |
| 已读文件 edit → 正常执行 | 不误拦截 | 同上 |
| write 创建后 edit → 正常执行 | write 也算接触 | 同上 |
| oldString="" 创建文件 → 不拦截 | 创建模式豁免 | 同上 |

### 10.7 P0-7 测试

| 测试 | 验证点 | 文件 |
|---|---|---|
| write + format 改变内容 → input 被替换 | format 透明化 | test/tool/write.test.ts |
| write + format 未改变内容 → input 不变 | 不误触发 | 同上 |
| write 新文件 → 无 _inputOverride | 新文件豁免 | 同上 |
| completeToolCall strip _inputOverride | metadata 不持久化 | test/session/processor.test.ts（如不存在则新增） |

---

## 十一、验证命令

```bash
# 从 packages/opencode 目录运行
cd packages/opencode

# 类型检查
bun typecheck

# 运行受影响的测试
bun test --timeout 30000 test/tool/edit.test.ts
bun test --timeout 30000 test/tool/write.test.ts
bun test --timeout 30000 test/tool/apply_patch.test.ts
bun test --timeout 30000 test/tool/read.test.ts
bun test --timeout 30000 test/tool/shell.test.ts

# 如果新增了测试文件
bun test --timeout 30000 test/tool/bash-compress.test.ts
bun test --timeout 30000 test/session/retry.test.ts
```

---

## 十二、Git 影响预估

| 改动项 | 修改文件 | 新增文件 | 预计净增行 | 删除行 |
|---|---|---|---|---|
| P0-1 | bash-compress.ts, read.ts, retry.ts | 0 | ~10 | ~2 |
| P0-2 | edit.ts, apply_patch.ts, read.ts | 0 | ~60 | ~6 |
| P0-3 | prompt.ts | 0 | ~30 | 0 |
| P0-4 | edit.ts, write.ts, apply_patch.ts | 0 | ~20 | ~6 |
| P0-5 | apply_patch.ts | 0 | ~25 | ~5 |
| P0-6 | edit.ts | 0 | ~15 | 0 |
| P0-7 | write.ts, processor.ts | 0 | ~15 | ~3 |
| P0-8 | 暂缓 | 0 | 0 | 0 |
| **合计** | **8 文件** | **0** | **~175** | **~22** |

- 不涉及生成文件、迁移、文档
- 不涉及新配置项
- 不涉及新公共 API
- 所有改动用 `[local-smark]` 标记

---

## 十三、风险与开放问题

### 已确认无风险

1. **P0-1 quotePattern guard**：纯防御性 guard，不影响正常路径
2. **P0-1 retry cap**：5 分钟远超任何合理 retry 场景
3. **P0-3 事前提醒**：synthetic text 注入，不改变工具行为
4. **P0-4 LSP 提示**：仅在 diagnostics 为空时追加文本
5. **P0-6 blind edit 检查**：只对 oldString !== "" 的 edit 生效

### 需关注的风险

1. **P0-2 edit closest match 性能**：对大文件的滑动窗口扫描可能慢。**缓解**：限制扫描范围和返回长度。
2. **P0-5 语义变更**：从 patch-level atomic 到 file-level atomic。**缓解**：release notes 说明；保留 "全部失败仍返回 error" 的行为。
3. **P0-7 DB mutation**：修改持久化 input。**缓解**：已确认 snapshot/revert 不依赖 tool input；_inputOverride 不持久化到 metadata。

### 待确认项（不阻塞但需实施时验证）

1. **offset=0 error 来源**：read.ts 内部已有 `|| 1` 兜底，需确认 error 是否来自 `lines()` 函数。如果来自 lines()，则 P0-1 的 auto-correct 方案需要调整。
2. **write.ts contentNew vs finalSource.text 比较**：需确认是否需要 normalize line endings 后比较（避免 CRLF 差异导致 false positive _inputOverride）。
3. **notebook_edit cellId error**：需阅读 vscode-bridge.ts 的 notebookResult/callRaw 完整实现，确认能否在 error 后自动获取 cellId 列表。
4. **apply_patch getActualContentAtLocation**：需确认 Patch.deriveNewContentsFromChunks 的 error 是否包含行号信息，以便定位 actual content。

---

## 十四、推荐方案摘要

P0 改造共 7 项（P0-8 暂缓为 P1），涉及 8 个源文件，预计净增 ~175 行、删除 ~22 行，不新增文件/配置/API。

核心改动：
1. **P0-1**（3 文件）：quotePattern guard + offset 修正 + retry cap → 消除 3 个 bug
2. **P0-2**（3 文件）：edit/apply_patch/read-binary error 增加 actual content → 提升恢复率
3. **P0-3**（1 文件）：insertReminders 中注入 disabled tool 事前提醒 → 预防 apply_patch 误用
4. **P0-4**（3 文件）：LSP diagnostics 为空时检查 hasClients → 区分 "no errors" vs "LSP not running"
5. **P0-5**（1 文件）：apply_patch hunk loop 改为 per-file atomicity → 保留部分成功
6. **P0-6**（1 文件）：edit 前检查文件是否被 read/write 过 → 阻止 blind edit
7. **P0-7**（2 文件）：write + format 后通过 _inputOverride 替换持久化 input → 模型看到格式化后内容

所有改动遵循 Effect-first 架构、[local-smark] 标记、向后兼容、手术刀式修改。
