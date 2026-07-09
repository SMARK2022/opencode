# LSP 诊断系统完整增强方案

> 本文档整合所有调研、实验和设计，作为 LSP 模块增强的唯一方案文档。
> 待 subagent 审计通过后，撤回 sdks/vscode 中的实验代码。

---

## 一、问题概述

用户反馈"很多情况下 LSP 显示 disabled"，LSP 诊断系统未能正常工作。需要全面调研并设计增强方案，涵盖：
1. LSP 启用门槛（默认禁用、二进制依赖）
2. VSCode Bridge 作为 LSP backend（利用 VSCode 已有 LSP 生态）
3. 诊断信息返回方式（附加给编辑工具 vs 独立工具）
4. 超时/等待机制（showTextDocument、awaitDiagnosticsRefresh）
5. 不完整编辑的诊断干扰

---

## 二、调研发现

### 2.1 本地代码调研

#### LSP 模块结构（`packages/opencode/src/lsp/`）
| 文件 | 职责 |
| --- | --- |
| `lsp.ts` (512行) | LSP Service 层。`touchFile`/`diagnostics`/`hover`/`definition` 等 Interface。`if (!cfg.lsp)` 判断默认禁用。 |
| `client.ts` (707行) | LSP 客户端。push+pull 诊断、去重、防抖(150ms)、超时(3s/5s/10s/45s)。 |
| `diagnostic.ts` (29行) | `report()` 只显示 severity=1(ERROR)，每文件最多 20 条。 |
| `server.ts` (2064行) | 37 个内置 LSP 服务器。10 个用 `Npm.which()`，12 个无自动安装。 |
| `language.ts` (124行) | 扩展名→languageId 映射。 |

#### 诊断使用点（5 处）
| 调用点 | 模式 |
| --- | --- |
| `write.ts:126-150` | touchFile(document) → diagnostics() → report。含 `[local-smark]` status() 检查。 |
| `edit.ts:229-245` | 同 write.ts。 |
| `apply_patch.ts:317-360` | 同 write.ts，多文件。 |
| `read.ts:447` | warm (touchFile + ignore + fork)，不显示诊断。 |
| `tool/lsp.ts:80` | touchFile(document) 然后执行操作。无 diagnostics operation。 |

#### LSP disabled 的四个原因
1. **全局默认禁用**：`lsp: Schema.optional`，不设置 = `undefined` = 禁用。PR #23416 试图默认启用被官方拒绝。
2. **二进制未安装**：12 个服务器无自动安装（deno/oxlint/ty/prisma/dart/ocaml/gleam/clojure/nix/haskell/julia/terraform）。
3. **项目识别条件未满足**：TypeScript 需 `Module.resolve("typescript/lib/tsserver.js")`。
4. **UI 统一显示 disabled**：不区分原因。

### 2.2 upstream 调研

| PR/Issue | 状态 | 关键结论 |
| --- | --- | --- |
| PR #23416 | Closed | 试图默认启用 LSP，被拒绝"LSP intentionally disabled by default" |
| PR #18308 | Merged | `@npmcli/arborist` 替换 Bun，已在本地基线中 |
| PR #30226 | Merged (v1.16.0) | read.ts warm `ignore`→`ignoreCause`，未回移 |
| PR #14228 | Open | 插件注册 LSP，未合并 |
| Issue #23566 | Open | 文档暗示 LSP 默认启用但实际禁用 |

### 2.3 VSCode Copilot 调研

通过分析 VSCode 内置 Copilot 扩展（`/Applications/Visual Studio Code.app/.../extensions/copilot/`）和 ChatGPT 深度调研：

| 问题 | Copilot 做法 | 证据强度 |
| --- | --- | --- |
| 如何获取诊断 | `vscode.languages.getDiagnostics()` 直接调用，有 `ILanguageDiagnosticsService` 包装 | 代码确认 |
| 是否主动打开文件 | **不主动打开**。先获取诊断，后 `openTextDocument` 用于渲染上下文 | 代码确认 |
| 诊断形态 | **两者都有**：独立工具(`read/problems`/`get_diagnostics`) + 编辑后自动诊断 | 文档+代码确认 |
| 超时/等待 | pull 立即读取；push 200ms debounce；`waitForNewDiagnostics` 默认 5s 等第一个事件 | 机制确认 |
| 不完整编辑伪错误 | **无专门方案**。只有 severity/range/数量(50条)/虚拟文档过滤 | 确认缺失 |
| Tree-sitter | 不替代 LSP。用于 AST/结构/分块，诊断仍来自 VSCode API | 代码确认 |

### 2.4 VSCode Bridge 基础设施

我们 `sdks/vscode` 已有完整的 bridge 机制：
- `bridge.ts`：HTTP server on `127.0.0.1:<random port>`，Bearer token 认证
- `bridge-registry.ts`：manifest 含 `capabilities` 字段，注册到 `~/.local/state/opencode/ide/`
- `ide/vscode-bridge.ts`：`discoverBridges()`/`resolveBridge()`/`callBridge()` — opencode 端发现和调用
- `plugin/vscode-bridge.ts`：notebook 工具插件通过 `callRaw()` 调用 bridge

---

## 三、实验验证

### 实验1：不完整编辑的诊断干扰

**场景**：Python 文件有 3 个错误，只修复 1 个。

**结果**：
- baseline：5 个诊断（Ruff 2 + Pylance 3）
- 修复错误1后：3 个诊断（错误1消失，错误2/3保留）
- 全部修复后：0 个诊断

**结论**：诊断准确反映当前文件状态，**无伪错误**。不完整编辑的错误是真实的中间状态错误。

### 实验2：多文件依赖不完整编辑

**场景**：`multi_a.py` 导入 `multi_b.py` 中的函数。重命名 `multi_b.py` 中的函数，不更新 `multi_a.py`。

**结果**：
- `multi_a.py`：1 个诊断（`"calculate"是未知的导入符号`）— 真实错误
- `multi_b.py`：0 个诊断
- 更新 `multi_a.py` 后：0 个诊断

**结论**：多文件依赖的中间状态错误**是真实的**，不是伪错误。会干扰模型，但这是预期行为。

### 实验3：超时/等待机制

**场景**：测定 `showTextDocument` 后诊断计算的时间线。

**结果**：
| 场景 | touch 返回时间 | touch 后诊断可用 |
| --- | --- | --- |
| 新文件（首次 touch） | 0.5s | 立即可用 |
| 已打开文件（再次 touch） | 2.0s（等满超时） | 立即可用 |

**关键发现**：
1. `showTextDocument` 是触发 Pylance 诊断计算的**必需条件**。`openTextDocument` 不够。
2. 新文件 `onDidChangeDiagnostics` 事件在 ~0.5s 内触发。
3. 已打开文件（诊断无变化）不触发事件，等满 2s 超时。
4. touch 后诊断**立即可用**，`lspDiagnostics` 不需要再次 `ensureOpen + awaitDiagnosticsRefresh`。
5. `executeHoverProvider`/`executeDocumentSymbolProvider` 等**不需要** `showTextDocument`，`openTextDocument` 足够。

### 实验4：LSP 端点全面验证

在 `archived/` workspace 中测试所有 LSP 端点：

| 端点 | 结果 | 说明 |
| --- | --- | --- |
| `/lsp/touch` | ✅ | ensureOpen + awaitDiagnosticsRefresh |
| `/lsp/diagnostics` | ✅ | 4 个错误全部检测到（Pylance + Ruff 多来源） |
| `/lsp/hover` | ✅ | 返回函数签名 `def add(a: int, b: int) -> int` |
| `/lsp/definition` | ✅ | 返回定义位置 |
| `/lsp/references` | ✅ | 返回定义处 + 调用处 |
| `/lsp/document-symbol` | ✅ | 返回 21 个符号（TypeScript）/ 3 个符号（Python） |
| `/lsp/workspace-symbol` | ✅ | 搜索 `add` 返回匹配符号 |

---

## 四、诊断附加 vs 独立工具权衡分析

### 4.1 三种模式对比

| 方面 | A. 附加给编辑工具（当前） | B. 独立工具 | C. 两者都有（Copilot） |
| --- | --- | --- | --- |
| 模型可控性 | 模型被动接收，不可跳过 | 模型主动调用，可能不调用 | 两者都支持 |
| 不完整编辑干扰 | 高（每次编辑后都看到中间状态错误） | 中（模型可选择时机） | 中 |
| token 消耗 | 每次编辑固定消耗 | 按需消耗 | 叠加 |
| 实时性 | 高（编辑后立即） | 低（需模型决定） | 高 |
| 模型忽略风险 | 无（在输出中） | 有（不调用工具） | 无 |

### 4.2 用户关切

用户指出：
1. "作为工具暴露给模型使用的话，理论来说会增加相应的调查成本，因为这个工具模型并不可控"
2. "如果作为信息附加给编辑工具的话，那么假设相应的编辑是一个不完整编辑，譬如说它只编辑了一部分，那么可能会导致大量完整的错误"
3. "这个是不是会干扰相应的模型进行后续的编辑"

### 4.3 分析

**附加给编辑工具的干扰问题**：
- 实验1和实验2证明：不完整编辑的诊断是**真实错误**（不是伪错误）
- 但这些错误**确实会干扰模型** — 模型可能认为编辑失败，尝试修复中间状态错误
- opencode 的 apply_patch 是**一次性应用所有修改**，然后统一获取诊断。所以多文件编辑的中间状态问题不严重
- write/edit 是单文件操作，编辑后获取诊断。如果模型在做多步编辑，每步都会看到诊断

**独立工具的模型不可控问题**：
- 如果模型不调用诊断工具，就得不到诊断信息
- 模型可能在需要诊断时不知道调用工具
- 但模型可以按需调用，避免不必要的 token 消耗

### 4.4 推荐

**保持附加给编辑工具的模式（方案A）**，不添加独立诊断工具。理由：
1. opencode 现有模式是附加式的，smark 已增强（status() 检查）
2. 确保 agent 始终看到诊断（不会遗漏）
3. 避免模型不可控的风险
4. apply_patch 一次性应用所有修改后获取诊断，中间状态干扰最小
5. Copilot 的独立工具模式适合 IDE 场景（用户可以主动调用），opencode 是 CLI 场景（agent 自主决策）

**不添加 diagnostics operation 到 lsp 工具**。理由：
- 增加工具调用成本（模型需要学习何时调用）
- 与 write/edit/apply_patch 的附加诊断重复
- 模型可能不调用，导致诊断遗漏

---

## 五、推荐方案

### 核心方案：VSCode Bridge LSP Backend + 默认启用 + 保持附加模式

三项改动，互补解决 LSP disabled 和诊断增强问题：

1. **VSCode Bridge LSP Backend**（方案A）：在现有 bridge HTTP 上添加 LSP 端点，LSP Service 优先通过 bridge 获取 VSCode 的 LSP 能力。对 agent 透明。
2. **默认启用 LSP**：无 bridge 时回退到内置 LSP，默认启用（`if (!cfg.lsp)` → `if (cfg.lsp === false)`）。
3. **保持诊断附加给编辑工具**：不添加独立诊断工具，保持 write/edit/apply_patch 后显示诊断的现有模式。

### 5.1 VSCode 扩展端（sdks/vscode）

#### 新增文件：`sdks/vscode/src/lsp.ts`

```ts
import * as vscode from "vscode"

// showTextDocument 是触发 Pylance 等 LSP 扩展诊断计算的必需条件。
// openTextDocument 只在 VSCode 内部打开文档，不触发诊断计算。
// preview + preserveFocus 不抢占用户焦点。
async function ensureOpen(filePath: string): Promise<vscode.Uri> {
  const uri = vscode.Uri.file(filePath)
  const doc = await vscode.workspace.openTextDocument(uri)
  try {
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true })
  } catch {
    // showTextDocument 失败时 openTextDocument 仍提供基本文档访问
  }
  return uri
}

// 等待 VSCode 为指定 uri 计算诊断。使用 onDidChangeDiagnostics 事件。
// 新文件约 0.5s 触发事件；已打开文件（诊断无变化）等满超时。
// 超时后返回当前诊断（可能为空或 stale），调用方自行判断。
async function awaitDiagnosticsRefresh(uri: vscode.Uri, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false
    const finish = () => {
      if (resolved) return
      resolved = true
      disposable.dispose()
      clearTimeout(timer)
      resolve()
    }
    const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => u.toString() === uri.toString())) {
        setTimeout(finish, 50)
      }
    })
    const timer = setTimeout(finish, timeoutMs)
  })
}

// 仅打开文档（不 showTextDocument），用于 hover/definition 等不需要诊断的操作
async function ensureOpenLight(filePath: string): Promise<vscode.Uri> {
  const uri = vscode.Uri.file(filePath)
  await vscode.workspace.openTextDocument(uri)
  return uri
}

function formatRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }) {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

function formatDiag(d: vscode.Diagnostic, fsPath: string) {
  const severityMap = ["Error", "Warning", "Information", "Hint"]
  return {
    file: fsPath,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    severity: severityMap[d.severity] ?? "Error",
    message: d.message,
    ...(d.source ? { source: d.source } : {}),
  }
}

function normalizeLocations(result: unknown): Array<{ uri: string; range: ReturnType<typeof formatRange> }> {
  if (!result) return []
  const items = Array.isArray(result) ? result : [result]
  return items.flatMap((item): Array<{ uri: string; range: ReturnType<typeof formatRange> }> => {
    if (!item || typeof item !== "object") return []
    if ("uri" in item && "range" in item) {
      const loc = item as vscode.Location
      return [{ uri: loc.uri.toString(), range: formatRange(loc.range) }]
    }
    if ("targetUri" in item && "targetRange" in item) {
      const link = item as vscode.DefinitionLink
      return [{ uri: link.targetUri.toString(), range: formatRange(link.targetRange) }]
    }
    return []
  })
}

function formatHover(hover: vscode.Hover) {
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
  const contentsStr = contents.map((c) => (typeof c === "string" ? c : "value" in c ? c.value : String(c)))
  return {
    contents: contentsStr,
    ...(hover.range ? { range: formatRange(hover.range) } : {}),
  }
}

// touch: showTextDocument + awaitDiagnosticsRefresh — 触发诊断计算
export async function lspTouch(args: { filePath: string }) {
  const uri = await ensureOpen(args.filePath)
  await awaitDiagnosticsRefresh(uri)
  return { ok: true }
}

// diagnostics: 只读取，不 ensureOpen，不等待（依赖之前 touch）
// 如果文件没 touch 过，getDiagnostics 可能返回空
export async function lspDiagnostics(args: { filePath?: string }) {
  if (args.filePath) {
    const uri = vscode.Uri.file(args.filePath)
    const diags = vscode.languages.getDiagnostics(uri)
    return { diagnostics: diags.map((d) => formatDiag(d, uri.fsPath)) }
  }
  const all = vscode.languages.getDiagnostics()
  return {
    diagnostics: all.flatMap(([uri, diags]) => diags.map((d) => formatDiag(d, uri.fsPath))),
  }
}

// hover/definition/references: openTextDocument（不需要 showTextDocument）+ executeCommand
export async function lspHover(args: { filePath: string; line: number; character: number }) {
  const uri = await ensureOpenLight(args.filePath)
  const result = await vscode.commands.executeCommand<vscode.Hover | vscode.Hover[] | undefined>(
    "vscode.executeHoverProvider", uri, new vscode.Position(args.line, args.character),
  )
  const hovers = result ? (Array.isArray(result) ? result : [result]) : []
  return { hovers: hovers.map(formatHover) }
}

export async function lspDefinition(args: { filePath: string; line: number; character: number }) {
  const uri = await ensureOpenLight(args.filePath)
  const result = await vscode.commands.executeCommand<unknown>(
    "vscode.executeDefinitionProvider", uri, new vscode.Position(args.line, args.character),
  )
  return { definitions: normalizeLocations(result) }
}

export async function lspReferences(args: { filePath: string; line: number; character: number }) {
  const uri = await ensureOpenLight(args.filePath)
  const result = await vscode.commands.executeCommand<unknown>(
    "vscode.executeReferenceProvider", uri, new vscode.Position(args.line, args.character),
  )
  return { references: normalizeLocations(result) }
}

export async function lspDocumentSymbol(args: { filePath: string }) {
  const uri = await ensureOpenLight(args.filePath)
  const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined>(
    "vscode.executeDocumentSymbolProvider", uri,
  )
  const symbols = result ?? []
  return {
    symbols: symbols.map((s) => {
      if ("selectionRange" in s) {
        const ds = s as vscode.DocumentSymbol
        return {
          name: ds.name, kind: ds.kind, range: formatRange(ds.range),
          selectionRange: formatRange(ds.selectionRange),
          ...(ds.detail ? { detail: ds.detail } : {}),
        }
      }
      const si = s as vscode.SymbolInformation
      return {
        name: si.name, kind: si.kind,
        location: { uri: si.location.uri.toString(), range: formatRange(si.location.range) },
        ...(si.containerName ? { containerName: si.containerName } : {}),
      }
    }),
  }
}

export async function lspWorkspaceSymbol(args: { query: string }) {
  const result = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
    "vscode.executeWorkspaceSymbolProvider", args.query,
  )
  return {
    symbols: (result ?? []).slice(0, 10).map((s) => ({
      name: s.name, kind: s.kind,
      location: { uri: s.location.uri.toString(), range: formatRange(s.location.range) },
      ...(s.containerName ? { containerName: s.containerName } : {}),
    })),
  }
}
```

#### 修改文件：`sdks/vscode/src/bridge.ts`

1. 添加 import：
```ts
import { lspTouch, lspDiagnostics, lspHover, lspDefinition, lspReferences, lspDocumentSymbol, lspWorkspaceSymbol } from "./lsp"
```

2. `READONLY_ROUTES` 添加 LSP 路由：
```ts
const READONLY_ROUTES = new Set([
  "/notebook/summary", "/notebook/source", "/notebook/output", "/notebook/cell-output",
  "/lsp/touch", "/lsp/diagnostics", "/lsp/hover", "/lsp/definition",
  "/lsp/references", "/lsp/document-symbol", "/lsp/workspace-symbol",
])
```

3. `routeRequest()` 添加路由：
```ts
case "/lsp/touch":
  return await lspTouch(body as { filePath: string })
case "/lsp/diagnostics":
  return await lspDiagnostics(body as { filePath?: string })
case "/lsp/hover":
  return await lspHover(body as { filePath: string; line: number; character: number })
case "/lsp/definition":
  return await lspDefinition(body as { filePath: string; line: number; character: number })
case "/lsp/references":
  return await lspReferences(body as { filePath: string; line: number; character: number })
case "/lsp/document-symbol":
  return await lspDocumentSymbol(body as { filePath: string })
case "/lsp/workspace-symbol":
  return await lspWorkspaceSymbol(body as { query: string })
```

#### 修改文件：`sdks/vscode/src/bridge-registry.ts`

capabilities 添加 `lsp: true`：
```ts
capabilities: {
  notebook: true,
  notebookRun: true,
  notebookEdit: true,
  notebookOutputArtifacts: true,
  notebookSource: true,
  lmToolsProxy: false,
  lsp: true,
},
```

### 5.2 opencode 端（packages/opencode）

#### 修改文件：`packages/opencode/src/ide/vscode-bridge.ts`

`BridgeRef` 添加 `capabilities`：
```ts
export type BridgeRef = Pick<BridgeEntry, "id" | "port" | "token" | "capabilities"> & {
  host: string
  score?: number
  source: "env" | "registry"
}
```

`resolveBridge` 返回值添加 `capabilities`：
```ts
const bridge = {
  id: best.entry.id,
  host: best.entry.host ?? "127.0.0.1",
  port: best.entry.port,
  token: best.entry.token,
  capabilities: best.entry.capabilities,
  score: best.score,
  source: "registry",
} satisfies BridgeRef
```

#### 修改文件：`packages/opencode/src/lsp/lsp.ts`

添加 bridge 集成：

```ts
import * as VscodeBridge from "@/ide/vscode-bridge"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

// 尝试发现支持 LSP 的 VSCode bridge。resolveBridge 有 5s 缓存。
// 失败返回 undefined，调用方回退到内置 LSP。
const resolveLspBridge = Effect.fnUntraced(function* (filePath?: string) {
  const ctx = yield* InstanceState.context
  return yield* Effect.promise(async () => {
    try {
      const bridge = await VscodeBridge.resolveBridge({ cwd: ctx.directory, filePath })
      if (!bridge.capabilities?.lsp) return undefined
      return bridge
    } catch {
      return undefined
    }
  })
})

// 通过 bridge 调用 LSP 端点。失败返回 undefined（触发回退）。
const callLspBridge = Effect.fnUntraced(function* (
  endpoint: string,
  body: Record<string, unknown>,
  filePath?: string,
) {
  const ctx = yield* InstanceState.context
  return yield* Effect.promise(async () => {
    try {
      return await VscodeBridge.callBridge({ cwd: ctx.directory, path: endpoint, body, filePath })
    } catch {
      return undefined
    }
  })
})

// 将 bridge 诊断格式转换为内置 LSP 的 Record<string, Diagnostic[]> 格式。
// 对 key 做 normalizePath，与 write/edit/apply_patch 的查找 key 对齐。
function bridgeDiagnosticsToMap(result: unknown): Record<string, LSPClient.Diagnostic[]> | undefined {
  if (!result || typeof result !== "object") return undefined
  const diags = (result as { diagnostics?: unknown[] }).diagnostics
  if (!Array.isArray(diags)) return undefined
  const severityMap: Record<string, number> = { Error: 1, Warning: 2, Information: 3, Hint: 4 }
  const results: Record<string, LSPClient.Diagnostic[]> = {}
  for (const d of diags) {
    if (!d || typeof d !== "object") continue
    const item = d as { file?: string; line?: number; column?: number; severity?: string; message?: string; source?: string }
    if (!item.file || typeof item.line !== "number" || typeof item.column !== "number") continue
    const diagnostic: LSPClient.Diagnostic = {
      range: {
        start: { line: item.line - 1, character: item.column - 1 },
        end: { line: item.line - 1, character: item.column },
      },
      message: item.message ?? "",
      severity: severityMap[item.severity ?? "Error"] ?? 1,
      ...(item.source ? { source: item.source } : {}),
    }
    const normalizedFile = AppFileSystem.normalizePath(item.file)
    const arr = results[normalizedFile] ?? []
    arr.push(diagnostic)
    results[normalizedFile] = arr
  }
  return results
}
```

各方法改造（保持现有内置 LSP 逻辑作为回退）：

```ts
// [local-smark] 默认启用 LSP：未配置时视为 true，仅 false 显式禁用。
if (cfg.lsp === false) {
  log.info("all LSPs are disabled")
} else {
  // ... 现有加载逻辑 ...
  // [local-smark] cfg.lsp 为 undefined 时跳过自定义配置遍历
  if (cfg.lsp && cfg.lsp !== true) {
    // ... 自定义配置 ...
  }
}

// touchFile: 有 bridge 时走 bridge /lsp/touch（ensureOpen + awaitDiagnosticsRefresh）
const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
  const bridge = yield* resolveLspBridge(input)
  if (bridge) {
    const touched = yield* callLspBridge("/lsp/touch", { filePath: input }, input)
    if (touched) return
  }
  log.info("touching file", { file: input })
  const clients = yield* getClients(input)
  // ... 现有内置 LSP 逻辑不变 ...
})

// diagnostics: 优先 bridge，回退内置
const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
  const bridge = yield* resolveLspBridge()
  if (bridge) {
    const result = yield* callLspBridge("/lsp/diagnostics", {})
    const mapped = bridgeDiagnosticsToMap(result)
    if (mapped) return mapped
  }
  // ... 现有内置 LSP 逻辑不变 ...
})

// hover: 优先 bridge，回退内置。提取 bare array 与 tool 层对齐。
const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
  const bridge = yield* resolveLspBridge(input.file)
  if (bridge) {
    const result = yield* callLspBridge("/lsp/hover", {
      filePath: input.file, line: input.line, character: input.character,
    }, input.file)
    if (result) return (result as { hovers?: unknown[] }).hovers ?? []
  }
  return yield* run(input.file, (client) =>
    client.connection.sendRequest("textDocument/hover", {
      textDocument: { uri: pathToFileURL(input.file).href },
      position: { line: input.line, character: input.character },
    }).catch(() => null),
  )
})
// definition/references 同理，提取 .definitions / .references

// documentSymbol: 优先 bridge，回退内置
const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
  const file = fileURLToPath(uri)
  const bridge = yield* resolveLspBridge(file)
  if (bridge) {
    const result = yield* callLspBridge("/lsp/document-symbol", { filePath: file }, file)
    if (result) return (result as { symbols?: unknown[] }).symbols ?? []
  }
  // ... 现有内置 LSP 逻辑不变 ...
})

// workspaceSymbol: 优先 bridge，回退内置
const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
  const bridge = yield* resolveLspBridge()
  if (bridge) {
    const result = yield* callLspBridge("/lsp/workspace-symbol", { query })
    if (result) return (result as { symbols?: unknown[] }).symbols ?? []
  }
  // ... 现有内置 LSP 逻辑不变 ...
})

// hasClients: 有 bridge 时返回 true
const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
  const bridge = yield* resolveLspBridge(file)
  if (bridge) return true
  // ... 现有内置 LSP 逻辑不变 ...
})

// status: 有 bridge 时返回 VSCode 状态
const status = Effect.fn("LSP.status")(function* () {
  const bridge = yield* resolveLspBridge()
  if (bridge) {
    return [{
      id: "vscode",
      name: "VSCode",
      root: ".",
      status: "connected" as const,
    }]
  }
  // ... 现有内置 LSP 逻辑不变 ...
})
```

#### 回移 PR #30226：read.ts warm `Effect.ignore` → `Effect.ignoreCause`

```ts
// packages/opencode/src/tool/read.ts 行 447
// 从：
yield* lsp.touchFile(filepath).pipe(Effect.ignore, Effect.forkIn(scope))
// 改为：
yield* lsp.touchFile(filepath).pipe(Effect.ignoreCause, Effect.forkIn(scope))
```

---

## 六、正常路径、错误路径、并发/安全边界

### 正常路径（有 VSCode bridge 时）
1. opencode 启动 → LSP Service 初始化 → `cfg.lsp` 为 `undefined` → 默认启用
2. agent write/edit → `touchFile(filepath, "document")` → `resolveLspBridge` 发现 bridge → `callLspBridge("/lsp/touch", {filePath})` → bridge `ensureOpen` (showTextDocument) + `awaitDiagnosticsRefresh` (0.5-2s)
3. `diagnostics()` → `resolveLspBridge` → `callLspBridge("/lsp/diagnostics", {})` → bridge `getDiagnostics()` → 返回诊断
4. `Diagnostic.report()` 格式化 → 附加到 write/edit 输出

### 正常路径（无 VSCode bridge 时）
1. opencode 启动 → LSP Service 初始化 → `cfg.lsp` 为 `undefined` → 默认启用
2. agent write/edit → `touchFile` → `resolveLspBridge` 失败 → 回退到内置 LSP → `getClients` → spawn LSP server → `didOpen` + `waitForDiagnostics`
3. `diagnostics()` → `resolveLspBridge` 失败 → 回退到内置 LSP → `runAll` → 读取缓存诊断

### 错误路径
- **bridge HTTP 调用失败**：`callLspBridge` 返回 undefined → 回退到内置 LSP
- **bridge 端 ensureOpen 失败**（文件不存在）：`callLspBridge` 返回错误 → `callLspBridge` catch 返回 undefined → 回退
- **bridge 端 showTextDocument 失败**：try-catch 回退到 openTextDocument
- **LSP server spawn 失败**：server 加入 broken Set → hasClients 跳过

### 并发
- **多次 touchFile 并发**：`getClients` 有 `spawning` Map 去重；bridge `openTextDocument` 幂等
- **touchFile + diagnostics 并发**：touchFile 走 bridge `/lsp/touch`（POST），diagnostics 走 bridge `/lsp/diagnostics`（POST），HTTP server 并发处理
- **LSP 路由在 READONLY_ROUTES 中**：不串行化，避免不必要的 withFileLock

### 安全边界
- **认证**：bridge Bearer token，与 notebook 端点相同
- **外部目录**：`assertExternalDirectoryEffect` 在 lsp 工具中已检查
- **资源控制**：`disableLspDownload` 仍控制内置 LSP 下载；`"lsp": false` 仍可禁用

---

## 七、行为级测试计划

### 先写的测试
1. **默认启用验证**：无 config 时 hasClients(.ts) 返回 true
2. **显式禁用验证**：`config: { lsp: false }` 时 hasClients 返回 false
3. **bridge touchFile**：有 bridge 时 touchFile 走 bridge，不调用 getClients
4. **bridge diagnostics**：有 bridge 时 diagnostics 返回 bridge 诊断
5. **bridge 回退**：无 bridge 时回退到内置 LSP
6. **bridgeDiagnosticsToMap 路径对齐**：key 经过 normalizePath
7. **hover/definition 提取 bare array**：`{hovers:[...]}` → `[...]`

### 实现后验证
```bash
cd packages/opencode && bun typecheck
cd packages/opencode && bun test test/lsp/
cd packages/opencode && bun test test/tool/lsp.test.ts
cd packages/opencode && bun test test/tool/read.test.ts
cd sdks/vscode && node esbuild.js  # 编译扩展
```

---

## 八、预估 git 文件数、增删行数

| 文件 | 改动类型 | 预估行数 |
| --- | --- | --- |
| `sdks/vscode/src/lsp.ts` | 新增 | ~180 行 |
| `sdks/vscode/src/bridge.ts` | 修改 | ~20 行 |
| `sdks/vscode/src/bridge-registry.ts` | 修改 | ~1 行 |
| `packages/opencode/src/ide/vscode-bridge.ts` | 修改 | ~3 行 |
| `packages/opencode/src/lsp/lsp.ts` | 修改 | ~120 行 |
| `packages/opencode/src/lsp/diagnostic.ts` | 修改 | ~2 行（MAX_PER_FILE 20→5） |
| `packages/opencode/src/tool/write.ts` | 修改 | ~15 行（移除其他文件显示 + 提示 + metadata 精简） |
| `packages/opencode/src/tool/edit.ts` | 修改 | ~5 行（提示 + metadata 精简） |
| `packages/opencode/src/tool/apply_patch.ts` | 修改 | ~10 行（提示 + metadata 精简） |
| `packages/opencode/src/tool/read.ts` | 修改 | ~2 行（ignoreCause） |
| 测试 | 新增/修改 | ~120 行 |
| **合计** | 11 个文件 | ~478 行 |

无新增依赖、无迁移、无 SDK 生成文件变化。

---

## 九、真实风险与开放问题

### 风险
1. **VSCode 诊断延迟**：新文件 ~0.5s，已打开文件等满 2s 超时。write/edit 后加 0.5-2s 延迟。与内置 LSP 的 5s 超时一致。**中风险**。
2. **Dirty 文档限制**：VSCode 中已打开且 dirty 的文件不从磁盘重读，诊断基于旧内容。**已知限制**。
3. **与官方分叉**：默认启用 LSP 与官方设计不同。**已知风险**。
4. **implementation/callHierarchy 无 bridge 端点**：回退到内置 LSP（可能 disabled）。**可后续补全**。
5. **diagnostics() 不传 filePath**：多 VSCode 窗口时可能解析到不同 bridge。**单窗口不受影响**。

### 开放问题
1. **oxlint 自动安装**：可通过 `Npm.which()` 但当前未用。**后续迭代**。
2. **诊断作为独立工具**：本次不添加，保持附加模式。如果未来需要可再评估。
3. **bridge 端 awaitDiagnosticsRefresh 超时优化**：当前 2s，可考虑根据文件是否首次打开动态调整。**后续优化**。

---

## 十一、诊断显示优化

### 11.1 当前机制详细分析

#### 截断机制
| 参数 | 当前值 | 位置 | 说明 |
| --- | --- | --- | --- |
| `MAX_PER_FILE` | 20 | `diagnostic.ts:3` | 每文件最多显示 20 条 **ERROR** (severity=1) |
| `MAX_PROJECT_DIAGNOSTICS_FILES` | 5 | `write.ts:19` | write.ts 最多显示 5 个"其他文件" |
| severity 过滤 | 仅 ERROR(1) | `diagnostic.ts:21` | Warning(2)/Info(3)/Hint(4) 全部丢弃 |

#### 附加范围（各工具差异）
| 工具 | 当前文件 | 其他文件 | 范围 |
| --- | --- | --- | --- |
| write.ts | ✅ 显示错误 | ✅ 最多 5 个其他文件 | **workspace-wide** |
| edit.ts | ✅ 显示错误 | ❌ 不显示 | 仅当前文件 |
| apply_patch.ts | ✅ 每个修改文件 | ❌ 不显示 | 仅修改的文件 |

#### 输出格式
```
Wrote file successfully.

LSP errors detected in this file, please fix:
<diagnostics file="/path/to/file.ts">
ERROR [10:5] Type 'string' is not assignable to type 'number'
ERROR [20:12] Cannot find name 'undefinedVar'
... and 15 more
</diagnostics>

LSP errors detected in other files:
<diagnostics file="/path/to/other.ts">
ERROR [5:1] Cannot find module './missing'
</diagnostics>
```

#### metadata 存储
- write.ts/edit.ts/apply_patch.ts 都在 `metadata.diagnostics` 中存储**完整未过滤**的诊断（所有文件、所有 severity）
- 这是 `lsp.diagnostics()` 的原始返回值，可能很大（Issue #6310）

### 11.2 问题分析

1. **20 条错误过多**：大量错误通常意味着编辑不完整或方向错误。模型看到 20 条错误可能陷入"逐条修复"循环，而非重新审视编辑策略。
2. **write.ts 显示其他文件**：大型工作区中其他文件可能有大量预存错误，与当前编辑无关，干扰模型判断。
3. **无"不完整编辑"提示**：模型不知道错误可能是多文件编辑的中间状态，可能过度反应。
4. **metadata 存储过大**：完整诊断写入 session，大型工作区可能导致 session 膨胀。

### 11.3 优化方案

#### 改动 1：降低 MAX_PER_FILE（20 → 5）

**文件**：`packages/opencode/src/lsp/diagnostic.ts`

```ts
// 从：
const MAX_PER_FILE = 20
// 改为：
// [local-smark] 降低每文件诊断上限：5 条足以指示"有问题"，
// 超过 5 条通常意味着编辑不完整或方向错误，模型应重新审视策略而非逐条修复。
const MAX_PER_FILE = 5
```

**理由**：
- 5 条错误足以让模型判断编辑是否正确
- 减少 token 消耗（从最多 20 条降到 5 条）
- 超过 5 条时 `... and N more` 提示模型问题较多

#### 改动 2：write.ts 统一为仅显示当前文件（移除"其他文件"显示）

**文件**：`packages/opencode/src/tool/write.ts`

```ts
// 从（行 126-141）：
let output = "Wrote file successfully."
yield* lsp.touchFile(filepath, "document")
const diagnostics = yield* lsp.diagnostics()
const normalizedFilepath = AppFileSystem.normalizePath(filepath)
let projectDiagnosticsCount = 0
for (const [file, issues] of Object.entries(diagnostics)) {
  const current = file === normalizedFilepath
  if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
  const block = LSP.Diagnostic.report(current ? filepath : file, issues)
  if (!block) continue
  if (current) {
    output += `\n\nLSP errors detected in this file, please fix:\n${block}`
    continue
  }
  projectDiagnosticsCount++
  output += `\n\nLSP errors detected in other files:\n${block}`
}

// 改为：
let output = "Wrote file successfully."
yield* lsp.touchFile(filepath, "document")
const diagnostics = yield* lsp.diagnostics()
const normalizedFilepath = AppFileSystem.normalizePath(filepath)
const currentIssues = diagnostics[normalizedFilepath] ?? []
const block = LSP.Diagnostic.report(filepath, currentIssues)
if (block) {
  output += `\n\nLSP errors detected in this file:\n${block}`
  output += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete. Focus on errors in the file you just edited.`
}
```

**理由**：
- 与 edit.ts/apply_patch.ts 统一：仅显示当前文件诊断
- 其他文件的错误可能是预存的，与当前编辑无关
- 跨文件错误（如 import 错误）会体现在当前文件的诊断中
- 完整诊断仍在 metadata 中保留

**同时移除**：`const MAX_PROJECT_DIAGNOSTICS_FILES = 5`（不再需要）

#### 改动 3：edit.ts 添加"不完整编辑"提示

**文件**：`packages/opencode/src/tool/edit.ts`

```ts
// 在 block 存在时（行 233），从：
if (block) {
  output += `\n\nLSP errors detected in this file, please fix:\n${block}`
}
// 改为：
if (block) {
  output += `\n\nLSP errors detected in this file:\n${block}`
  output += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete.`
}
```

#### 改动 4：apply_patch.ts 添加"不完整编辑"提示

**文件**：`packages/opencode/src/tool/apply_patch.ts`

```ts
// 在 lspFoundErrors 后（行 351 之后），添加：
if (lspFoundErrors) {
  output += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete. Focus on errors in files you just edited.`
}
```

#### 改动 5：精简 metadata.diagnostics（仅存储当前/修改文件）

**文件**：`packages/opencode/src/tool/write.ts`

```ts
// 从：
metadata: {
  diagnostics,  // 完整 workspace 诊断
  ...
}
// 改为：
metadata: {
  diagnostics: { [normalizedFilepath]: currentIssues },  // 仅当前文件
  ...
}
```

**文件**：`packages/opencode/src/tool/edit.ts`

```ts
// 从：
metadata: {
  diagnostics,  // 完整 workspace 诊断
  ...
}
// 改为：
metadata: {
  diagnostics: { [normalizedFilePath]: diagnostics[normalizedFilePath] ?? [] },  // 仅当前文件
  ...
}
```

**文件**：`packages/opencode/src/tool/apply_patch.ts`

```ts
// 从：
metadata: {
  diagnostics,  // 完整 workspace 诊断
  ...
}
// 改为：
metadata: {
  diagnostics: Object.fromEntries(
    fileChanges
      .filter((c) => c.type !== "delete")
      .map((c) => {
        const target = c.movePath ?? c.filePath
        return [AppFileSystem.normalizePath(target), diagnostics[AppFileSystem.normalizePath(target)] ?? []]
      })
  ),  // 仅修改的文件
  ...
}
```

**理由**：减少 session 存储膨胀（Issue #6310）。完整诊断可通过 `lsp.diagnostics()` 工具按需获取。

### 11.4 关于"中断工具"的分析

用户提出是否需要增加一个"中断工具"来辅助分析文件依赖。

**分析**：
- LSP 工具已有 `findReferences`/`goToDefinition` 操作，可分析文件依赖
- 如果 LSP 不可用，新工具同样不可用（返回空）
- 增加工具增加模型学习成本和 token 消耗
- 当前附加模式已提供编辑后诊断反馈

**结论**：**不添加中断工具**。现有 LSP 工具的 `findReferences`/`goToDefinition` 已足够分析依赖。如果模型需要了解依赖关系，可主动调用这些操作。

### 11.5 优化后的输出样式

```
Wrote file successfully.

LSP errors detected in this file:
<diagnostics file="src/foo.ts">
ERROR [10:5] Type 'string' is not assignable to type 'number'
ERROR [20:12] Cannot find name 'undefinedVar'
... and 3 more
</diagnostics>

Note: If this is part of a multi-step edit, some errors may be expected until all changes are complete.
```

**变化**：
1. `please fix:` 移除 — 不强制要求修复，让模型自主判断
2. 添加 `Note:` 提示 — 告知模型中间状态错误是正常的
3. 最多 5 条（从 20 降低）
4. 不再显示"其他文件"诊断（write.ts 统一）

### 11.6 跨文件依赖诊断说明

**问题**：VSCode 只打开了一个文件，这个文件是否会受到其他依赖的影响？

**回答**：是的，LSP 会进行跨文件分析。

- **TypeScript/Pylance 等语言服务器**：在打开文件 A 时，会解析其 import 语句，加载依赖文件 B 的类型信息
- **如果 B 有错误**：A 的诊断会包含"Cannot find module './b'"或"Import 'foo' cannot be resolved"等错误
- **如果 B 被修改**：A 的诊断会反映 B 的最新状态（只要 B 在同一 workspace 中）
- **实验验证**（实验2）：重命名 `multi_b.py` 中的函数后，`multi_a.py` 正确报告了 `"calculate"是未知的导入符号`

**结论**：跨文件依赖诊断是 LSP 的标准能力，不需要额外工具。当前方案通过 `lsp.diagnostics()` 返回的诊断已包含跨文件错误。

---

## 十三、诊断频率与显示策略

### 13.1 当前机制

#### 多 tool call 执行方式
- `llm.ts:100`：`concurrency: "unbounded"` — 同一 message 中多个 tool call **并行执行**
- `edit.ts:24-32`：文件级 Semaphore 锁，串行化同一文件的多次 edit
- **每个 edit/write 独立调用 `touchFile` + `diagnostics()` 并显示诊断**
- 如果模型在同一 message 中编辑同一文件 3 次，每次 edit 都会显示诊断（中间状态错误）

#### 问题
1. **每个 edit 都显示全部诊断**：包括预存错误，模型可能误认为"编辑失败"（opencode issue #9102 已报告此问题）
2. **同一文件多次编辑**：前几次 edit 的诊断反映中间状态，只有最后一次反映最终状态
3. **诊断与编辑结果语义混合**：`LSP errors detected in this file, please fix:` 容易被模型解读为编辑操作本身失败

### 13.2 Copilot / Codex / Claude Code 对比

| 工具 | 诊断频率 | 诊断内容 | 语义分离 | 证据强度 |
| --- | --- | --- | --- | --- |
| **Copilot** | per-edit（autoFix） | **仅新引入的错误**（delta） | ✅ 编辑结果与诊断分离 | 高（官方文档+代码） |
| **Codex CLI** | 无原生 LSP | N/A（agent 自主运行 linter） | N/A | 高（确认缺失） |
| **Claude Code** | per-edit + on-demand | `<new-diagnostics>` 增量推送 | ✅ 独立结构 | 高（issue+代码） |
| **Aider** | per-edit lint | lint 结果（非 LSP） | ✅ lint 是独立步骤 | 高 |
| **opencode（当前）** | per-edit | **全部 ERROR 诊断** | ❌ 混在编辑输出中 | 高 |

#### Copilot 的关键设计
- `github.copilot.chat.agent.autoFix` 设置（默认启用）
- 官方描述："如果 agent mode 中的**一次文件编辑**引入了新的错误" — 触发单位是**单次编辑**
- 但关注的是 **new errors introduced by a file edit**，不是全部错误
- 另有独立的 `Get Problems` / `read/problems` 工具供模型按需查询

#### Codex CLI 的关键发现
- **无原生 LSP 诊断附加机制**（issue #8745 仍在请求）
- 有通用 `PostToolUse` hook，可外接 LSP 诊断
- 默认是 agent-decided/on-demand（模型自主运行编译器/linter/test）

### 13.3 推荐策略：增量 per-edit

**核心原则**：每次编辑后只显示**本次编辑新引入的错误**，不重复显示预存错误。

#### 改动设计

**diagnostic.ts** 新增 `reportDelta` 函数：

```ts
// [local-smark] 增量诊断：只显示本次编辑新引入的错误。
// baseline 是编辑前的诊断快照，current 是编辑后的诊断。
// 通过 message+range+severity 匹配来判断是否为"新"错误。
export function reportDelta(file: string, current: LSPClient.Diagnostic[], baseline: LSPClient.Diagnostic[] = []) {
  const baselineKeys = new Set(baseline.map(diagKey))
  const newErrors = current
    .filter((d) => d.severity === 1)
    .filter((d) => !baselineKeys.has(diagKey(d)))
  if (newErrors.length === 0) return ""
  const limited = newErrors.slice(0, MAX_PER_FILE)
  const more = newErrors.length - MAX_PER_FILE
  const suffix = more > 0 ? `\n... and ${more} more` : ""
  return `<new-diagnostics file="${file}">\n${limited.map(pretty).join("\n")}${suffix}\n</new-diagnostics>`
}

function diagKey(d: LSPClient.Diagnostic): string {
  return JSON.stringify({
    msg: d.message,
    line: d.range.start.line,
    col: d.range.start.character,
    code: d.code,
    source: d.source,
  })
}
```

**write.ts / edit.ts / apply_patch.ts** 改造：

```ts
// 编辑前保存 baseline 诊断（必须在 edit.ts Semaphore 锁内采集，确保同文件串行）
const beforeDiagnostics = (yield* lsp.diagnostics())[normalizedFilepath] ?? []

// ... 执行编辑 ...

// 编辑后获取新诊断
yield* lsp.touchFile(filepath, "document")
const afterDiagnostics = yield* lsp.diagnostics()
const currentIssues = afterDiagnostics[normalizedFilepath] ?? []

// 只显示新引入的错误
const block = LSP.Diagnostic.reportDelta(filepath, currentIssues, beforeDiagnostics)
if (block) {
  output += `\n\nNew LSP errors introduced by this edit:\n${block}`
  output += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete.`
} else {
  // [local-smark] delta 空 ≠ LSP 验证通过：LSP 未运行时 baseline 和 current 都为空，
  // delta 必然为空。须用 status() 确认 LSP 确实在运行，否则模型获得虚假"类型安全"信号。
  const clients = yield* lsp.status()
  if (clients.length === 0) {
    output += `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
  }
  // 仅当 LSP 在运行且 delta 空，才真正静默（编辑成功且无新错误）
}
```

**apply_patch 多文件场景**：patch 应用前一次性捕获所有目标文件的 baseline 快照，patch 应用后 touchFile 全部目标 → 再一次 `diagnostics()` → 逐文件算 delta：

```ts
// patch 应用前：一次 diagnostics() 获取所有目标文件的 baseline
const beforeAll = yield* lsp.diagnostics()
const baselines = new Map<string, LSPClient.Diagnostic[]>()
for (const change of fileChanges) {
  if (change.type === "delete") continue
  const target = change.movePath ?? change.filePath
  baselines.set(AppFileSystem.normalizePath(target), beforeAll[AppFileSystem.normalizePath(target)] ?? [])
}

// ... 应用 patch ...

// patch 应用后：touchFile 所有目标，再一次 diagnostics()，逐文件算 delta
for (const change of fileChanges) {
  if (change.type === "delete") continue
  const target = change.movePath ?? change.filePath
  yield* lsp.touchFile(target, "document")
}
const afterAll = yield* lsp.diagnostics()

let lspFoundNewErrors = false
for (const change of fileChanges) {
  if (change.type === "delete") continue
  const target = change.movePath ?? change.filePath
  const normalized = AppFileSystem.normalizePath(target)
  const block = LSP.Diagnostic.reportDelta(target, afterAll[normalized] ?? [], baselines.get(normalized) ?? [])
  if (block) {
    lspFoundNewErrors = true
    const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
    output += `\n\nNew LSP errors introduced in ${rel}:\n${block}`
  }
}
if (lspFoundNewErrors) {
  output += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete.`
} else {
  const clients = yield* lsp.status()
  if (clients.length === 0) {
    output += `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
  }
}
```

**输出样式变化**：

改前（当前）：
```
Edit applied successfully.

LSP errors detected in this file, please fix:
<diagnostics file="src/foo.ts">
ERROR [10:5] Type 'string' is not assignable to type 'number'
ERROR [20:12] Cannot find name 'undefinedVar'
ERROR [30:1] Existing pre-existing error
</diagnostics>
```

改后（增量）：
```
Edit applied successfully.

New LSP errors introduced by this edit:
<new-diagnostics file="src/foo.ts">
ERROR [10:5] Type 'string' is not assignable to type 'number'
</new-diagnostics>

Note: If this is part of a multi-step edit, some errors may be expected until all changes are complete.
```

或无新错误时：
```
Edit applied successfully.
```
（无诊断输出，干净简洁）

#### 关键变化
1. **`please fix:` → `introduced by this edit`**：明确诊断是编辑引入的，不是编辑失败
2. **全部错误 → 仅新引入错误**：不重复显示预存错误，减少噪音
3. **无新错误时无输出**：编辑成功且无新错误 = 最干净的结果
4. **`<diagnostics>` → `<new-diagnostics>`**：标签区分增量 vs 全量
5. **`<diagnostics>` → `<new-diagnostics>`**：标签区分增量 vs 全量
6. **delta 空时仍检查 `status()`**：LSP 未运行时 baseline 和 current 都为空 → delta 必然为空。必须用 `status()` 确认 LSP 在运行，否则模型获得虚假"类型安全"信号（保留 smark 增强）。仅当 LSP 在运行且 delta 空，才真正静默。
7. **迁移后删除 `report()`**：`reportDelta` 替代后，`report()` 成为死码（仅 write/edit/apply_patch 调用，迁移后无调用点）。

#### 已知局限
- **行号漂移**：在错误位置上方增删行会导致预存错误行号变化，`diagKey` 的 line 不匹配 → 误报为"新错误"（false positive）。这严格优于现状（现状显示全部预存错误），属可接受容忍范围。
- **跨文件干扰**：并行编辑不同文件但共享同一 LSP server 时，`diagnostics()` 全局快照可能包含其他 edit 引入的跨文件错误，被当前 edit 的 delta 误归因。这是 LSP 固有限制，当前"显示全部"代码同样存在。

#### 证据归因修正
方案原文 "llm.ts:100 concurrency: unbounded" 指的是启动期配置拉取并行，不是 tool 执行并行。tool 并行源于 AI SDK 对每个 tool `execute()` 回调的并发调用（prompt.ts:878）。同文件串行化由 edit.ts:24-32 Semaphore 保证。

### 13.4 关于"最后一次编辑才显示"的分析

**用户问题**：同一文件多次编辑，是否只在最后一次显示诊断？

**分析**：
- Copilot 是 per-edit，每次编辑都触发诊断，但只显示 delta
- 纯 per-turn（只在最后显示）的问题：语法错误反馈太晚，模型可能在错误基础上继续编辑
- **推荐**：保持 per-edit，但用 delta 模式 — 每次只显示新引入的错误
  - 第一次 edit 引入 2 个错误 → 显示 2 个
  - 第二次 edit 修复了 1 个，引入 0 个 → 无诊断输出（干净）
  - 第三次 edit 引入 1 个错误 → 显示 1 个
  - 最终状态：1 个错误（从 delta 可推断）

**同文件多次编辑的时序**：
- edit.ts 有 Semaphore 锁串行化同文件编辑 → 不会并行冲突
- 每次编辑前获取 baseline，编辑后获取 current → delta 准确
- 但 `lsp.diagnostics()` 的 baseline 可能在并行编辑中被其他文件的编辑影响 → 需要只取当前文件的 baseline

### 13.5 metadata 优化

```ts
// [local-smark] metadata.diagnostics 统一存储新错误数组（delta），
// 不是全部当前错误。TUI getDiagnostics() 从此字段读取并 filter(severity=1).slice(0,3)，
// 因此只显示新引入的错误。diagnosticSummary 供 TUI 渲染紧凑状态行。
// 详见 Section 15.2「metadata 统一语义」。
metadata: {
  diagnostics: { [normalizedFilepath]: newErrors },  // 新错误数组
  diagnosticSummary: { newCount, existingCount },     // 摘要供 TUI
  ...
}
```

### 13.6 不做的

- **不添加 edit group / transaction 机制**：过于复杂，增加抽象层。delta 模式已解决中间状态噪音问题。
- **不添加 turn-end full validation**：opencode 已有 `bun typecheck` 提示（smark 增强），模型可自主运行。
- **不切换到 per-turn**：纯 per-turn 反馈太晚，delta per-edit 是更好的平衡。

---

## 十五、TUI 渲染与已存在错误数显示

### 15.1 当前 TUI 渲染机制

通过调研 `packages/ui/src/components/message-part.tsx`：

| 工具 | DiagnosticsDisplay | 数据来源 | 显示条件 |
| --- | --- | --- | --- |
| write | ✅ 有（line 2021） | `metadata.diagnostics[filePath]`，过滤 severity=1，取前 3 条 | `diagnostics.length > 0` |
| edit | ✅ 有（line 1960） | 同 write | 同 write |
| apply_patch | ❌ 无 | — | — |

**当前 `DiagnosticsDisplay` 组件**（line 112-131）：
- 只在 `diagnostics.length > 0` 时渲染
- 每条诊断一行：`[Error] [line:col] message`
- 无新错误时完全不显示

**问题**：
1. 无新错误但有已存在错误时，TUI 不显示任何信息 — 用户/模型无法知道文件是否有预存错误
2. apply_patch 不渲染诊断
3. output 文本中的 `<new-diagnostics>` 块被 Markdown 渲染为原始文本，与 DiagnosticsDisplay 结构化渲染重复

### 15.2 设计：已存在错误数显示

#### diagnostic.ts 新增 `deltaSummary()` 函数

```ts
// [local-smark] 增量诊断摘要：返回新错误数和已存在错误数，
// 供 metadata 传递给 TUI 渲染使用（不进入 model output）。baseline 过滤逻辑与 reportDelta 完全一致
// （不预先过滤 baseline severity，使同位置 warning→error 升级归为已存在而非新错误）。
export function deltaSummary(
  current: LSPClient.Diagnostic[],
  baseline: LSPClient.Diagnostic[] = [],
): { newCount: number; existingCount: number } {
  const baselineKeys = new Set(baseline.map(diagKey))
  const allErrors = current.filter((d) => d.severity === 1)
  const newCount = allErrors.filter((d) => !baselineKeys.has(diagKey(d))).length
  return {
    newCount,
    existingCount: allErrors.length - newCount,
  }
}
```

#### write.ts / edit.ts 输出逻辑更新

```ts
const delta = LSP.Diagnostic.deltaSummary(currentIssues, beforeIssues)
const block = LSP.Diagnostic.reportDelta(filepath, currentIssues, beforeIssues)
// [local-smark] 计算新错误数组（供 TUI DiagnosticsDisplay 渲染）
const newErrors = currentIssues
  .filter((d) => d.severity === 1)
  .filter((d) => !new Set(beforeIssues.map(LSP.Diagnostic.diagKey)).has(LSP.Diagnostic.diagKey(d)))
if (block) {
  output += `\n\nNew LSP errors introduced by this edit:\n${block}`
  output += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete.`
} else {
  // [local-smark] 无新错误时不向模型 output 注入已存在错误数，
  // 避免诱导模型修复预存错误（scope creep）。已存在错误数仅通过
  // metadata.diagnosticSummary 传递给 TUI 渲染紧凑摘要。
  const clients = yield* lsp.status()
  if (clients.length === 0) {
    output += `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
  }
  // LSP 运行且 0 新错误 = 干净，不输出任何诊断信息
}
```

#### metadata 统一语义

```ts
metadata: {
  // [local-smark] metadata.diagnostics 存储新错误数组（delta），不是全部当前错误。
  // TUI getDiagnostics() 从此字段读取并 filter(severity=1).slice(0,3)，
  // 因此只显示新引入的错误，不会把预存错误冒充为新错误。
  diagnostics: { [normalizedFilepath]: newErrors },
  // 诊断摘要供 TUI 渲染紧凑状态行（✓ 0 new · N existing）
  diagnosticSummary: delta,
}
```

#### apply_patch.ts 输出逻辑更新

```ts
// 逐文件计算 delta 和摘要，聚合 newCount/existingCount
let lspFoundNewErrors = false
let totalNew = 0
let totalExisting = 0
const allNewErrors: Record<string, LSPClient.Diagnostic[]> = {}
for (const change of fileChanges) {
  if (change.type === "delete") continue
  const target = change.movePath ?? change.filePath
  const normalized = AppFileSystem.normalizePath(target)
  const currentIssues = afterAll[normalized] ?? []
  const fileBaseline = baselines.get(normalized) ?? []
  const delta = LSP.Diagnostic.deltaSummary(currentIssues, fileBaseline)
  totalNew += delta.newCount
  totalExisting += delta.existingCount
  // 计算新错误数组供 metadata
  const baselineKeys = new Set(fileBaseline.map(diagKey))
  const fileNewErrors = currentIssues.filter((d) => d.severity === 1).filter((d) => !baselineKeys.has(diagKey(d)))
  allNewErrors[normalized] = fileNewErrors
  const block = LSP.Diagnostic.reportDelta(target, currentIssues, fileBaseline)
  if (block) {
    lspFoundNewErrors = true
    const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
    output += `\n\nNew LSP errors introduced in ${rel}:\n${block}`
  }
}
if (lspFoundNewErrors) {
  output += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete.`
} else {
  // [local-smark] 无新错误时不向模型 output 注入已存在错误数（TUI-only）
  const clients = yield* lsp.status()
  if (clients.length === 0) {
    output += `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
  }
}

// metadata：diagnostics 存储新错误数组，diagnosticSummary 存储聚合摘要
metadata: {
  diff: totalDiff,
  files,
  diagnostics: allNewErrors,  // 仅新错误
  diagnosticSummary: { newCount: totalNew, existingCount: totalExisting },
}
```

### 15.3 设计：TUI DiagnosticsDisplay 增强

#### 增强后的 DiagnosticsDisplay 组件

```tsx
function DiagnosticsDisplay(props: {
  diagnostics: Diagnostic[]
  summary?: { newCount: number; existingCount: number }
}): JSX.Element {
  const i18n = useI18n()
  const hasNew = () => props.diagnostics.length > 0
  const hasExistingOnly = () => !hasNew() && props.summary && props.summary.existingCount > 0

  return (
    <Show when={hasNew() || hasExistingOnly()}>
      <div data-component="diagnostics">
        {/* 有新错误时显示详情（最多 3 条） */}
        <Show when={hasNew()}>
          <For each={props.diagnostics}>
            {(diagnostic) => (
              <div data-slot="diagnostic">
                <span data-slot="diagnostic-label">{i18n.t("ui.messagePart.diagnostic.error")}</span>
                <span data-slot="diagnostic-location">
                  [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
                </span>
                <span data-slot="diagnostic-message">{diagnostic.message}</span>
              </div>
            )}
          </For>
        </Show>
        {/* 无新错误但有已存在错误时显示紧凑摘要 */}
        <Show when={hasExistingOnly()}>
          <div data-slot="diagnostic-summary">
            {/* 一行摘要：✓ 0 new · N existing */}
            <span data-slot="diagnostic-summary-clean">✓</span>
            <span data-slot="diagnostic-summary-text">
              {" "}0 new · {props.summary!.existingCount} existing
            </span>
          </div>
        </Show>
      </div>
    </Show>
  )
}
```

**显示规则**：

| 场景 | TUI 显示 | 说明 |
| --- | --- | --- |
| 有新错误 | 最多 3 条 `[Error] [line:col] message` | 当前行为不变 |
| 0 新错误，N 已存在 | `✓ 0 new · N existing` | **新增**：一行紧凑摘要 |
| 0 错误，LSP 运行 | 不显示任何内容 | 干净，无噪音 |
| 0 错误，LSP 未运行 | 不显示（output 文本有提示） | TUI 不重复 |

#### apply_patch 添加 DiagnosticsDisplay

在 apply_patch 的 TUI 渲染中（`message-part.tsx` apply_patch 注册块），在文件列表后添加：

```tsx
// 在 BasicTool 的 children 末尾添加
const diagnostics = createMemo(() => {
  // apply_patch 可能修改多个文件，聚合所有修改文件的诊断
  const diags: Diagnostic[] = []
  const summary = { newCount: 0, existingCount: 0 }
  if (props.metadata.diagnostics) {
    for (const [, fileDiags] of Object.entries(props.metadata.diagnostics)) {
      for (const d of fileDiags) {
        if (d.severity === 1 && diags.length < 3) diags.push(d)
      }
    }
  }
  if (props.metadata.diagnosticSummary) {
    summary.newCount = props.metadata.diagnosticSummary.newCount ?? 0
    summary.existingCount = props.metadata.diagnosticSummary.existingCount ?? 0
  }
  return { diags, summary }
})

// 在 BasicTool children 末尾：
<DiagnosticsDisplay diagnostics={diagnostics().diags} summary={diagnostics().summary} />
```

#### edit/write 传递 summary

在 edit 和 write 的 TUI 渲染中，将 `diagnosticSummary` 从 metadata 传递给 `DiagnosticsDisplay`：

```tsx
// edit (line 1884 附近)
const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
const diagnosticSummary = createMemo(() => props.metadata.diagnosticSummary)

// line 1960
<DiagnosticsDisplay diagnostics={diagnostics()} summary={diagnosticSummary()} />
```

### 15.4 输出样式示例

**有新错误时**（model output + TUI）：
```
Edit applied successfully.

New LSP errors introduced by this edit:
<new-diagnostics file="src/foo.ts">
ERROR [10:5] Type 'string' is not assignable to type 'number'
</new-diagnostics>

Note: If this is part of a multi-step edit, some errors may be expected until all changes are complete.
```
TUI DiagnosticsDisplay:
```
Error [10:5] Type 'string' is not assignable to type 'number'
```

**无新错误但有已存在错误时**：
```
Edit applied successfully.
```
（model output 干净，不注入已存在错误数。TUI DiagnosticsDisplay 显示紧凑摘要）
TUI DiagnosticsDisplay:
```
✓ 0 new · 3 existing
```

**无任何错误，LSP 运行中**：
```
Edit applied successfully.
```
TUI DiagnosticsDisplay: （不显示）

**LSP 未运行**：
```
Edit applied successfully.

LSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.
```
TUI DiagnosticsDisplay: （不显示，output 文本已有提示）

### 15.5 改动文件汇总

| 文件 | 改动 |
| --- | --- |
| `packages/opencode/src/lsp/diagnostic.ts` | 新增 `deltaSummary()` 函数 |
| `packages/opencode/src/tool/write.ts` | 无新错误时显示已存在错误数 + metadata 增加 diagnosticSummary |
| `packages/opencode/src/tool/edit.ts` | 同 write.ts |
| `packages/opencode/src/tool/apply_patch.ts` | 同 write.ts（多文件聚合） |
| `packages/ui/src/components/message-part.tsx` | 增强 DiagnosticsDisplay + apply_patch 添加诊断渲染 + edit/write 传递 summary |

**五项改动，11 个文件，约 530 行：**

1. **VSCode Bridge LSP Backend**（方案A）：在现有 bridge HTTP 上添加 LSP 端点，LSP Service 优先通过 bridge 获取 VSCode 的 LSP 能力。对 agent 透明，无 bridge 时回退到内置 LSP。

2. **默认启用 LSP**：`if (!cfg.lsp)` → `if (cfg.lsp === false)`。无 bridge 时内置 LSP 默认启用。

3. **回移 PR #30226**：read.ts warm `Effect.ignore` → `Effect.ignoreCause`。

4. **诊断显示优化**（Section 11）：MAX_PER_FILE 20→5，write.ts 统一为仅当前文件，添加"不完整编辑"提示，精简 metadata。

5. **增量诊断策略**（Section 13）：编辑后只显示**新引入的错误**（delta），不重复显示预存错误。借鉴 Copilot 的 "new errors introduced by a file edit" 语义。
   - `diagnostic.ts` 新增 `reportDelta()` 函数
   - write/edit/apply_patch 编辑前保存 baseline，编辑后只报告 delta
   - 无新错误时无诊断输出（干净简洁）
   - 输出标签从 `<diagnostics>` 改为 `<new-diagnostics>`
   - 措辞从 `please fix:` 改为 `introduced by this edit`

**不做的**：
- 不添加独立诊断工具（保持附加模式，避免模型不可控）
- 不添加中断工具（LSP 已有 references/definition 操作）
- 不添加 edit group / transaction 机制（delta 模式已解决中间状态噪音）
- 不切换到 per-turn（纯 per-turn 反馈太晚）
- 不为 12 个无自动安装的服务器添加安装逻辑
- 不回移 PR #14228（插件注册 LSP）

---

## 十六、推荐方案摘要（最终更新）

**六项改动，12 个文件，约 600 行：**

1. **VSCode Bridge LSP Backend**（方案A）：在现有 bridge HTTP 上添加 LSP 端点，LSP Service 优先通过 bridge 获取 VSCode 的 LSP 能力。对 agent 透明，无 bridge 时回退到内置 LSP。

2. **默认启用 LSP**：`if (!cfg.lsp)` → `if (cfg.lsp === false)`。无 bridge 时内置 LSP 默认启用。

3. **回移 PR #30226**：read.ts warm `Effect.ignore` → `Effect.ignoreCause`。

4. **诊断显示优化**（Section 11）：MAX_PER_FILE 20→5，write.ts 统一为仅当前文件，精简 metadata。

5. **增量诊断策略**（Section 13）：编辑后只显示新引入的错误（delta），不重复显示预存错误。`diagnostic.ts` 新增 `reportDelta()` + `deltaSummary()`。

6. **TUI 渲染与已存在错误数显示**（Section 15）：
   - 无新错误但有已存在错误时，已存在错误数仅经 metadata.diagnosticSummary 传 TUI 渲染（`✓ 0 new · N existing`），不注入 model output
   - TUI `DiagnosticsDisplay` 增强为三种状态：新错误详情 / `✓ 0 new · N existing` 紧凑摘要 / 不显示
   - apply_patch 添加 DiagnosticsDisplay（当前缺失）
   - metadata 增加 `diagnosticSummary` 供 TUI 渲染
