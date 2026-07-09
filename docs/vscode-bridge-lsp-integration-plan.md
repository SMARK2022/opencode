# VSCode Bridge LSP 集成方案

> 基于 vscode-mcp-server (juehang/vscode-mcp-server) 的调研，评估将其 LSP 桥接方式融入我们的 sdk/vscode 扩展。

---

## 一、vscode-mcp-server 分析

### 架构
- VSCode 扩展内嵌 MCP server（express HTTP + `@modelcontextprotocol/sdk` StreamableHTTPServerTransport）
- 监听 `localhost:3000/mcp`，MCP 客户端通过 HTTP 连接
- 默认禁用，用户通过状态栏切换

### LSP 能力来源（核心借鉴点）
vscode-mcp-server 不安装任何 LSP 服务器，而是直接调用 VSCode 内置 API：

| 工具 | VSCode API | 说明 |
| --- | --- | --- |
| get_diagnostics_code | `vscode.languages.getDiagnostics(uri?)` | 获取 VSCode 已计算的诊断 |
| search_symbols_code | `vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)` | 工作区符号搜索 |
| get_symbol_definition_code | `vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position)` | hover/定义信息 |
| get_document_symbols_code | `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)` | 文档符号层次 |

VSCode 通过扩展市场安装的 LSP 扩展（TypeScript、Python、Go、Rust、C/C++ 等）已提供完整 LSP 能力。vscode-mcp-server 只是把这些能力通过 MCP 暴露给外部 AI agent。

### 优势
- **零安装**：不需要安装任何 LSP 服务器二进制
- **全语言覆盖**：支持所有 VSCode 扩展支持的语言
- **实时诊断**：VSCode 内部管理 LSP 生命周期，诊断是现成的

### 局限
- **依赖 VSCode 运行**：VSCode 必须打开且扩展激活
- **文件需打开**：`getDiagnostics(uri)` 对未打开的文件可能返回空
- **MCP 协议**：引入 `@modelcontextprotocol/sdk` 依赖

---

## 二、我们的 sdk/vscode 现有架构

### 已有基础设施（可直接复用）

| 组件 | 文件 | 说明 |
| --- | --- | --- |
| HTTP bridge server | `sdks/vscode/src/bridge.ts` | `127.0.0.1:<random port>`，Bearer token 认证，已有 `/health` `/manifest` `/notebook/*` 端点 |
| Bridge registry | `sdks/vscode/src/bridge-registry.ts` | 注册到 `~/.local/state/opencode/ide/<uuid>.json`，manifest 含 `capabilities` 字段 |
| Bridge 发现 | `packages/opencode/src/ide/vscode-bridge.ts` | `discoverBridges()` / `resolveBridge()` / `callBridge()` — opencode 端发现和调用 bridge |
| Bridge 插件 | `packages/opencode/src/plugin/vscode-bridge.ts` | 已注册 notebook 工具插件，通过 `callRaw()` 调用 bridge |

### manifest capabilities 当前值
```ts
capabilities: {
  notebook: true,
  notebookRun: true,
  notebookEdit: true,
  notebookOutputArtifacts: true,
  notebookSource: true,
  lmToolsProxy: false,
}
```
**没有 `lsp` 能力**。添加 `lsp: true` 后，opencode 端就知道这个 bridge 支持 LSP。

### bridge 调用流程（已有）
```
opencode agent → plugin/vscode-bridge.ts callRaw()
  → ide/vscode-bridge.ts callBridge()
    → resolveBridge() 发现 bridge
    → fetch(`http://127.0.0.1:${port}${endpoint}`, POST, Bearer token)
      → sdks/vscode/src/bridge.ts routeRequest()
        → 处理函数
```

---

## 三、融合可行性评估

### 可行性：高
1. **已有 HTTP bridge**：不需要新建 server，只需添加端点
2. **已有认证机制**：Bearer token，安全
3. **已有发现机制**：registry + resolveBridge，opencode 端已能发现 bridge
4. **已有插件模式**：notebook 工具是现成的参考实现
5. **不需要 MCP SDK**：直接用现有 HTTP bridge，不引入 `@modelcontextprotocol/sdk` 依赖

### 对比 vscode-mcp-server 的优势
| 方面 | vscode-mcp-server | 我们的方案 |
| --- | --- | --- |
| 传输 | MCP streamable HTTP | 现有 bridge HTTP（更简单） |
| 发现 | 手动配置 `localhost:3000` | 自动 registry 发现 |
| 认证 | 无 | Bearer token |
| 依赖 | `@modelcontextprotocol/sdk` + express | 无新增依赖（已有 `node:http`） |
| 集成 | 独立 MCP 客户端 | opencode 原生 LSP Service |

---

## 四、推荐方案

### 核心思路
在现有 bridge HTTP server 上添加 LSP 端点，opencode 端 LSP Service 优先使用 bridge 获取诊断和 LSP 查询。无 bridge 时回退到内置 LSP（spawn 服务器）。

### 两端改动

#### A. VSCode 扩展端（sdks/vscode）— 添加 LSP 端点

**新增文件**：`sdks/vscode/src/lsp.ts`

LSP 端点处理函数，借鉴 vscode-mcp-server 但适配我们的 bridge 模式：

```ts
import * as vscode from "vscode"
import * as path from "path"

// 确保文件在 VSCode 中打开，触发 LSP 诊断计算。
// openTextDocument 对未打开的文件从磁盘读取最新内容；
// 对已打开的 clean 文件返回内存文档，VSCode file watcher 会异步检测外部修改并 reload。
// 对 dirty 文件返回内存文档（可能 stale），这是 VSCode 的固有限制。
async function ensureOpen(filePath: string): Promise<vscode.Uri> {
  const uri = vscode.Uri.file(filePath)
  await vscode.workspace.openTextDocument(uri)
  return uri
}

// [B2 修复] 等待 VSCode 为指定 uri 计算诊断。
// 使用 onDidChangeDiagnostics 事件监听诊断刷新，而非轮询 length>0
// （length>0 会在干净文件上等满超时，在有旧诊断时返回 stale）。
// 事件触发说明 VSCode 完成了诊断计算（包括"从有到无"的情况）。
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
        // 诊断已刷新，延迟 50ms 让后续计算完成
        setTimeout(finish, 50)
      }
    })
    const timer = setTimeout(finish, timeoutMs)
  })
}

// [B1 修复] touch 端点：ensureOpen + 等待诊断刷新
export async function lspTouch(args: { filePath: string }) {
  const uri = await ensureOpen(args.filePath)
  await awaitDiagnosticsRefresh(uri)
  return { ok: true }
}

// 诊断格式化：返回绝对路径（fsPath），与 opencode 内置 LSP 的 normalized path 对齐
// [B4 修复] opencode 端 bridgeDiagnosticsToMap 会再做 normalizePath
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

export async function lspDiagnostics(args: { filePath?: string }) {
  if (args.filePath) {
    const uri = await ensureOpen(args.filePath)
    await awaitDiagnosticsRefresh(uri)
    const diags = vscode.languages.getDiagnostics(uri)
    return { diagnostics: diags.map((d) => formatDiag(d, uri.fsPath)) }
  }
  // 全工作区诊断
  const all = vscode.languages.getDiagnostics()
  return {
    diagnostics: all.flatMap(([uri, diags]) => diags.map((d) => formatDiag(d, uri.fsPath))),
  }
}

// [B6 修复] 统一 VSCode API 返回类型：Location | Location[] | DefinitionLink[] → Location[]
function normalizeLocations(result: unknown): Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> {
  if (!result) return []
  const items = Array.isArray(result) ? result : [result]
  return items.flatMap((item): Array<{ uri: string; range: any }> => {
    if (!item || typeof item !== "object") return []
    // Location: { uri, range }
    if ("uri" in item && "range" in item) {
      return [{ uri: (item as any).uri.toString?.() ?? String((item as any).uri), range: formatRange((item as any).range) }]
    }
    // DefinitionLink: { targetUri, targetRange }
    if ("targetUri" in item && "targetRange" in item) {
      return [{ uri: (item as any).targetUri.toString?.() ?? String((item as any).targetUri), range: formatRange((item as any).targetRange) }]
    }
    return []
  })
}

function formatRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }) {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

function formatHover(hover: vscode.Hover) {
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
  const contentsStr = contents.map((c) => (typeof c === "string" ? c : "value" in c ? c.value : String(c)))
  return {
    contents: contentsStr,
    ...(hover.range ? { range: formatRange(hover.range) } : {}),
  }
}

function formatDocumentSymbol(sym: vscode.DocumentSymbol): any {
  return {
    name: sym.name,
    ...(sym.detail ? { detail: sym.detail } : {}),
    kind: sym.kind,
    range: formatRange(sym.range),
    selectionRange: formatRange(sym.selectionRange),
  }
}

function formatSymbolInfo(sym: vscode.SymbolInformation): any {
  return {
    name: sym.name,
    kind: sym.kind,
    location: {
      uri: sym.location.uri.toString(),
      range: formatRange(sym.location.range),
    },
    ...(sym.containerName ? { containerName: sym.containerName } : {}),
  }
}

export async function lspHover(args: { filePath: string; line: number; character: number }) {
  const uri = await ensureOpen(args.filePath)
  const result = await vscode.commands.executeCommand<vscode.Hover | vscode.Hover[] | undefined>(
    "vscode.executeHoverProvider", uri, new vscode.Position(args.line, args.character)
  )
  const hovers = result ? (Array.isArray(result) ? result : [result]) : []
  return { hovers: hovers.map(formatHover) }
}

export async function lspDefinition(args: { filePath: string; line: number; character: number }) {
  const uri = await ensureOpen(args.filePath)
  const result = await vscode.commands.executeCommand<unknown>(
    "vscode.executeDefinitionProvider", uri, new vscode.Position(args.line, args.character)
  )
  return { definitions: normalizeLocations(result) }
}

export async function lspReferences(args: { filePath: string; line: number; character: number }) {
  const uri = await ensureOpen(args.filePath)
  const result = await vscode.commands.executeCommand<unknown>(
    "vscode.executeReferenceProvider", uri, new vscode.Position(args.line, args.character)
  )
  return { references: normalizeLocations(result) }
}

export async function lspDocumentSymbol(args: { filePath: string }) {
  const uri = await ensureOpen(args.filePath)
  const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined>(
    "vscode.executeDocumentSymbolProvider", uri
  )
  const symbols = result ?? []
  // DocumentSymbol 和 SymbolInformation 都可能有，统一处理
  return {
    symbols: symbols.map((s) =>
      "range" in s && "selectionRange" in s
        ? formatDocumentSymbol(s as vscode.DocumentSymbol)
        : formatSymbolInfo(s as vscode.SymbolInformation),
    ),
  }
}

export async function lspWorkspaceSymbol(args: { query: string }) {
  const result = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
    "vscode.executeWorkspaceSymbolProvider", args.query
  )
  return { symbols: (result ?? []).slice(0, 10).map(formatSymbolInfo) }
}
```

**修改文件**：`sdks/vscode/src/bridge.ts`

在 `routeRequest()` 中添加 LSP 路由：
```ts
case "/lsp/touch":
  return await lspTouch(body)
case "/lsp/diagnostics":
  return await lspDiagnostics(body)
case "/lsp/hover":
  return await lspHover(body)
case "/lsp/definition":
  return await lspDefinition(body)
case "/lsp/references":
  return await lspReferences(body)
case "/lsp/document-symbol":
  return await lspDocumentSymbol(body)
case "/lsp/workspace-symbol":
  return await lspWorkspaceSymbol(body)
```

LSP 路由是只读的（不修改 notebook/kernel），应加入 `READONLY_ROUTES` 避免不必要的 withFileLock 串行化：
```ts
const READONLY_ROUTES = new Set([
  "/notebook/summary", "/notebook/source", "/notebook/output", "/notebook/cell-output",
  "/lsp/touch", "/lsp/diagnostics", "/lsp/hover", "/lsp/definition",
  "/lsp/references", "/lsp/document-symbol", "/lsp/workspace-symbol",
])
```

**修改文件**：`sdks/vscode/src/bridge-registry.ts`

manifest capabilities 添加 `lsp: true`：
```ts
capabilities: {
  notebook: true,
  // ... 现有 ...
  lsp: true,
}
```

#### B. opencode 端（packages/opencode）— LSP Service bridge backend（方案 A）

**设计原则**：对 agent 透明，不新增工具。LSP Service 各方法优先尝试 bridge，失败静默回退到内置 LSP。

**修改文件**：`packages/opencode/src/ide/vscode-bridge.ts`

`BridgeRef` 添加 `capabilities`，让调用方能检查 `bridge.capabilities?.lsp`：

```ts
// 行 52，从：
export type BridgeRef = Pick<BridgeEntry, "id" | "port" | "token"> & {
  host: string
  score?: number
  source: "env" | "registry"
}
// 改为：
export type BridgeRef = Pick<BridgeEntry, "id" | "port" | "token" | "capabilities"> & {
  host: string
  score?: number
  source: "env" | "registry"
}
```

`resolveBridge` 返回值添加 `capabilities`：

```ts
// 行 165-172，在 bridge 对象中添加：
const bridge = {
  id: best.entry.id,
  host: best.entry.host ?? "127.0.0.1",
  port: best.entry.port,
  token: best.entry.token,
  capabilities: best.entry.capabilities,  // 新增
  score: best.score,
  source: "registry",
} satisfies BridgeRef
```

**修改文件**：`packages/opencode/src/lsp/lsp.ts`

添加 bridge 集成辅助函数 + 各方法改造：

```ts
import * as VscodeBridge from "@/ide/vscode-bridge"

// [local-smark] 尝试发现支持 LSP 的 VSCode bridge。
// resolveBridge 有 5s 缓存（RESOLVE_CACHE_MS），高频调用不会重复发现。
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

// [local-smark] 通过 bridge 调用 LSP 端点。失败返回 undefined（触发回退）。
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

// [B4 修复] 将 bridge 诊断格式转换为内置 LSP 的 Record<string, Diagnostic[]> 格式。
// bridge 返回绝对路径（fsPath），这里用 AppFileSystem.normalizePath 规范化，
// 与 write.ts/edit.ts/apply_patch.ts 的查找 key 对齐（Windows 小写盘符/symlink 问题）。
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
    // [B4] 对 key 做 normalizePath，与 write/edit/apply_patch 的查找 key 对齐
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
// [B1 修复] touchFile: 有 bridge 时不跳过，通过 bridge /lsp/touch 端点
// 调用 ensureOpen + awaitDiagnosticsRefresh，触发 VSCode 打开文件并计算诊断。
// 这对 write/edit/apply_patch 后获取最新诊断至关重要 — VSCode 只为已打开的
// 文件计算诊断，必须先 ensureOpen。
const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
  const bridge = yield* resolveLspBridge(input)
  if (bridge) {
    // [N1] 检查返回值：bridge HTTP 调用失败时回退到内置 LSP
    const touched = yield* callLspBridge("/lsp/touch", { filePath: input }, input)
    if (touched) return
  }
  log.info("touching file", { file: input })
  const clients = yield* getClients(input)
  // ... 现有内置 LSP 逻辑不变
})

// diagnostics: 优先 bridge，回退内置
const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
  const bridge = yield* resolveLspBridge()
  if (bridge) {
    const result = yield* callLspBridge("/lsp/diagnostics", {})
    const mapped = bridgeDiagnosticsToMap(result)
    if (mapped) return mapped
  }
  // ... 现有内置 LSP 逻辑不变
})

// hover/definition/references/implementation: 优先 bridge，回退内置
// [B7 修复] bridge 返回包装对象 {hovers:[...]}，需提取 bare array 与 tool 层对齐
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
// definition/references/implementation 同理，提取 .definitions / .references
```

// documentSymbol: 优先 bridge，回退内置
const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
  const file = fileURLToPath(uri)
  const bridge = yield* resolveLspBridge(file)
  if (bridge) {
    const result = yield* callLspBridge("/lsp/document-symbol", { filePath: file }, file)
    if (result) return (result as { symbols?: unknown[] }).symbols ?? []
  }
  // ... 现有内置 LSP 逻辑不变
})

// workspaceSymbol: 优先 bridge，回退内置
const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
  const bridge = yield* resolveLspBridge()
  if (bridge) {
    const result = yield* callLspBridge("/lsp/workspace-symbol", { query })
    if (result) return (result as { symbols?: unknown[] }).symbols ?? []
  }
  // ... 现有内置 LSP 逻辑不变
})

// hasClients: 有 bridge 时返回 true
const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
  const bridge = yield* resolveLspBridge(file)
  if (bridge) return true
  // ... 现有内置 LSP 逻辑不变
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
  // ... 现有内置 LSP 逻辑不变
})
```

---

## 五、行为变化

### 有 VSCode bridge 时
1. **write/edit/apply_patch 后的诊断**：从 VSCode 获取（而不是内置 LSP）
2. **lsp 工具的 hover/definition/references/...**：从 VSCode 获取
3. **不需要安装 LSP 服务器**：VSCode 扩展已安装
4. **不需要 `"lsp": true` 配置**：bridge 自动发现

### 无 VSCode bridge 时（纯终端使用）
1. 回退到内置 LSP（spawn 服务器）
2. 需要 `"lsp": true` 配置
3. 需要安装 LSP 服务器二进制

### 渐进回退流程
```
agent 调用 lsp.diagnostics()
  → tryBridge("/lsp/diagnostics")
    → resolveBridge() 成功？
      → YES: fetch bridge → 返回 VSCode 诊断
      → NO: 回退到内置 LSP → runAll(clients) → 返回内置诊断
```

---

## 六、预计修改的文件

| 文件 | 改动类型 | 预估行数 |
| --- | --- | --- |
| `sdks/vscode/src/lsp.ts` | 新增 | ~200 行（含 formatter + normalizeLocations + awaitDiagnosticsRefresh） |
| `sdks/vscode/src/bridge.ts` | 修改 | ~20 行（路由 + READONLY_ROUTES + import） |
| `sdks/vscode/src/bridge-registry.ts` | 修改 | ~1 行（capabilities） |
| `packages/opencode/src/ide/vscode-bridge.ts` | 修改 | ~3 行（BridgeRef + resolveBridge） |
| `packages/opencode/src/lsp/lsp.ts` | 修改 | ~110 行（resolveLspBridge + callLspBridge + bridgeDiagnosticsToMap + touchFile/diagnostics/hover/definition/references/documentSymbol/workspaceSymbol/status/hasClients 改造） |
| 测试（新增/修改） | — | ~120 行 |
| **合计** | 6 个文件 | ~454 行 |

---

## 七、风险与开放问题

### 风险
1. **VSCode 诊断延迟**：VSCode 异步计算诊断。`awaitDiagnosticsRefresh` 使用 `onDidChangeDiagnostics` 事件等待（2s 超时），比轮询 `length>0` 更可靠。但干净文件（无诊断）可能不触发事件，等满 2s 超时。write/edit 后大多数文件有诊断（刚引入的错误），事件会快速触发。**中风险**。
2. **Dirty 文档限制（B3 已知限制）**：如果文件在 VSCode 中打开且 dirty（有未保存编辑），`openTextDocument` 返回内存文档（不从磁盘重读），诊断基于旧内容。VSCode 不允许强制 reload dirty 文档。这是 VSCode 的固有限制。对于 clean/未打开文件，`openTextDocument` 从磁盘读取最新内容。**已知限制，文档化**。
3. **bridge 发现延迟**：`resolveBridge` 有 5s 缓存（单槽，key 含 filePath）。LSP 操作中 filePath 变化频繁，缓存命中率不高。但 `discoverBridges` 是 readdir + JSON 解析，很快（<10ms）。**低风险**。
4. **bridge 不可用时的回退**：`callLspBridge` 失败后回退到内置 LSP，但内置 LSP 可能未配置（`lsp` 默认禁用）。**需要默认启用 LSP 或在回退时静默跳过**。
5. **VSCode 扩展兼容性**：`vscode.execute*Provider` 命令是 VSCode 内置 API，稳定。`onDidChangeDiagnostics` 事件也是稳定的公开 API。**低风险**。

### B5 说明
`status()` 有 bridge 时返回 `[{id:"vscode",status:"connected"}]`。B1 修复后，`touchFile` 通过 bridge `/lsp/touch` 端点 `ensureOpen` + `awaitDiagnosticsRefresh`，确保 VSCode 为文件计算诊断。因此 write/edit/apply_patch 后 `diagnostics()` 返回空 = 文件无错误（不是诊断缺失），`status()` 返回 connected 不显示 unavailable 提示是正确行为。仅 B3 的 dirty 文档场景可能导致 stale 诊断，作为已知限制。

### 开放问题
1. **是否需要默认启用内置 LSP**：如果有 bridge，不需要内置 LSP。如果没有 bridge，需要内置 LSP。是否把内置 LSP 默认启用作为回退？（与之前的"默认启用 LSP"方案结合）
2. **诊断格式统一**：VSCode 诊断格式和内置 LSP 诊断格式需要统一，确保 write/edit/apply_patch 的 `Diagnostic.report()` 能处理两种来源。
3. **touchFile 语义**：有 bridge 时 touchFile 走 bridge `/lsp/touch`（ensureOpen + awaitDiagnosticsRefresh）。write/edit 后 VSCode 会基于新内容重新计算诊断。
4. **并发**：VSCode 扩展中的 LSP 操作是异步的，需要确保 bridge 端正确处理并发请求。现有 `withFileLock` 可以复用。LSP 路由加入 `READONLY_ROUTES` 避免不必要串行化。
5. **implementation/callHierarchy 无 bridge 端点**：`implementation`/`prepareCallHierarchy`/`incomingCalls`/`outgoingCalls` 暂无 bridge 端点。调用时 bridge 404 → `callLspBridge` 返回 undefined → 回退到内置 LSP。行为正确（graceful fallback），但 agent 在有 bridge 时这些操作走内置 LSP（可能 disabled）。可后续补全端点。
6. **diagnostics() 不传 filePath 给 resolveLspBridge**：`touchFile` 传 filePath，`diagnostics()` 不传。多 VSCode 窗口打开同一 cwd 时，可能解析到不同 bridge。单窗口场景不受影响。可后续优化。
7. **hasClients 有 bridge 时对所有文件类型返回 true**：VSCode 可能没有某语言的 LSP 扩展，但 `hasClients` 仍返回 true。后续操作（如 hover）会走 bridge 返回空结果。agent 看到 "No results found" 而非 "LSP not available"。可后续优化为检查 VSCode 是否有对应语言的扩展。

---

## 八、与 vscode-mcp-server 的关键差异

| 方面 | vscode-mcp-server | 我们的方案 |
| --- | --- | --- |
| 协议 | MCP streamable HTTP | 现有 bridge HTTP |
| 发现 | 手动配置端口 | 自动 registry 发现 |
| 认证 | 无 | Bearer token |
| 依赖 | `@modelcontextprotocol/sdk` + express | 无新增 |
| 集成深度 | 独立 MCP 工具 | opencode LSP Service 透明集成 |
| 回退 | 无（必须 VSCode 运行） | 渐进回退到内置 LSP |
| 文件操作 | 有（read/write/list/move/rename） | 不需要（opencode 已有） |

---

## 九、推荐方案摘要

**在现有 bridge HTTP 上添加 LSP 端点，opencode LSP Service 优先使用 bridge，无 bridge 时回退到内置 LSP。**

### 核心价值
- **解决 LSP disabled 问题**：VSCode 已安装 LSP 扩展，不需要 opencode 自己安装
- **自包含**：不需要系统 PATH 中的二进制
- **全语言覆盖**：支持所有 VSCode 扩展支持的语言
- **对 agent 透明**：不新增工具，诊断自动来自 VSCode

### 改动范围
6 个文件，约 286 行。无新增依赖。

### 不做的
- 内嵌 MCP server（不引入 `@modelcontextprotocol/sdk`）
- 文件操作端点（opencode 已有 read/write/edit）
- shell 执行端点（opencode 已有 bash 工具）

### 与之前方案的关系
此方案与"默认启用 LSP"方案互补：
- **有 VSCode 时**：通过 bridge 获取 LSP，不需要安装服务器
- **无 VSCode 时**：默认启用内置 LSP，自动安装服务器
- 两者结合，实现"全场景 LSP 可用"
