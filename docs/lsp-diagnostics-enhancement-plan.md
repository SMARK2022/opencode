# LSP 诊断增强方案

> 只调研，不改代码。本方案基于穷尽式探索产出，待 subagent 审计通过后再实施。

---

## 一、已阅读的文件、测试和文档及相关性

### LSP 核心模块（`packages/opencode/src/lsp/`）
| 文件 | 行数 | 为什么相关 |
| --- | --- | --- |
| `lsp.ts` | 512 | LSP Service 定义层。提供 `touchFile`/`diagnostics`/`hover`/`definition` 等 Interface，是所有 LSP 调用的中枢。诊断增强的核心入口。 |
| `client.ts` | 707 | LSP 客户端实现。包含 push+pull 诊断、去重、防抖、超时（3s/5s/10s/45s）、动态注册、`waitForDiagnostics`。诊断数据流的底层实现。 |
| `diagnostic.ts` | 29 | 诊断格式化。`report()` 只显示 severity=1（ERROR），每文件最多 20 条。write/edit/apply_patch 复用此函数。 |
| `server.ts` | 2064 | 23 个内置 LSP 服务器定义。诊断能力取决于 server 是否成功 spawn。 |
| `language.ts` | 124 | 扩展名→languageId 映射。`didOpen` 中 `LANGUAGE_EXTENSIONS[ext] ?? "plaintext"`。 |
| `launch.ts` | 21 | 进程启动封装。 |

### LSP 工具和调用点（`packages/opencode/src/tool/`）
| 文件 | 为什么相关 |
| --- | --- |
| `lsp.ts` | agent-facing LSP 工具。9 个 operation，**无 diagnostics operation**。本次增强的主要修改点。 |
| `lsp.txt` | 工具描述文本。需同步更新。 |
| `write.ts:126-150` | 写文件后 `touchFile(document)` + `diagnostics()` + `report`。含 `[local-smark]` 增强：空诊断时用 `status()` 区分"LSP 未运行"。 |
| `edit.ts:229-245` | 同 write.ts 模式。含 `[local-smark]` 增强。 |
| `apply_patch.ts:317-360` | 同 write.ts 模式。含 `[local-smark]` 增强。 |
| `read.ts:446-448` | `warm()` 只做 `touchFile` + `Effect.ignore` + `forkIn`。**不显示诊断**。upstream PR #30226 已改为 `Effect.ignoreCause`，我们未回移。 |

### 配置和 session 层
| 文件 | 为什么相关 |
| --- | --- |
| `config/lsp.ts` | LSP 配置 schema。字段：`command`/`extensions`/`disabled`/`env`/`initialization`。无 `languageId`、无 timeout 配置。 |
| `config/config.ts:230` | `lsp` 字段接入主配置。 |
| `config/permission.ts:77` | `lsp` permission rule。 |
| `session/prompt.ts:380,1657-1668` | session 层使用 LSP（`documentSymbol` 用于 URL range 解析）。 |

### 测试
| 文件 | 为什么相关 |
| --- | --- |
| `test/lsp/client.test.ts` | 493 行。测试 push/pull 诊断、document/full 模式、identifier 并行、workspace 诊断、防抖。诊断逻辑的行为级测试基础。 |
| `test/lsp/index.test.ts` | 230 行。测试 spawn 隔离、experimentalLspTy、custom LSP 配置、`lsp.updated` 事件。 |
| `test/lsp/lifecycle.test.ts` | 184 行。测试 init/status/hasClients/diagnostics 幂等性。`Diagnostic.pretty()` 格式化测试。 |
| `test/lsp/launch.test.ts` | 22 行。Windows spawn 测试。 |
| `test/tool/lsp.test.ts` | 186 行。**lsp 工具的测试**。mock LSP.Service，验证 permission metadata 和 title。本次修改的测试基础。 |
| `test/fixture/lsp/fake-lsp-server.js` | 249 行。fake LSP server，支持 push/pull 诊断、动态注册、delay。可用于 diagnostics operation 的集成测试。 |

### 外部调研（已确认）
| 来源 | 关键结论 |
| --- | --- |
| upstream `anomalyco/opencode` dev 分支 `tool/lsp.ts` | 与本地几乎一致（仅 `FSUtil` vs `AppFileSystem` import 差异）。**无 diagnostics operation**。 |
| upstream `lsp/diagnostic.ts` | 与本地**完全一致**。 |
| upstream `tool/read.ts` warm 函数 | 已用 `Effect.ignoreCause`（PR #30226）。我们仍用 `Effect.ignore`。 |
| Issue #16569 | 请求暴露诊断为工具 + read 自动显示。**关闭为 not planned**。无 PR。 |
| Issue #32030 | 1.17.4 "lsp_* tools"。确认是外部 MCP 插件（`lsp-tools-mcp`/`oh-my-openagent`），**非官方核心拆分**。 |
| Issue #742 / #13326 | 3s 诊断超时太短。PR #13306 提出可配置超时但**未合并**。1.15.7→1.17.4 超时常量**未变**。 |
| Issue #5259 / PR #5480 | 诊断输出无限。PR #5480 限制每文件 20 条 ERROR，**已在 1.15.7 基线中**（commit aedb555 PRESENT）。 |
| Issue #6310 | `metadata.diagnostics` 仍存储完整 workspace map。**未解决**。 |
| Issue #16353 | `LSP.diagnostics()` 不按 workspace 过滤。**关闭为 not planned**。 |
| Issue #23663 | custom server 缺 `languageId` 字段。**关闭为 not planned**。 |
| PR #23771 | pull diagnostics 支持。**已在 1.15.7 基线中**（代码存在，squash 导致 ancestor 检查 ABSENT）。 |
| PR #30226 | read warm-up defect containment（`ignore`→`ignoreCause`）。v1.16.0。**未回移**。 |
| PR #28761 | JDTLS Maven 多模块 root。v1.17.0。**未回移**（Java 专用）。 |
| ChatGPT 深度调研 | 确认官方 v1.15.7→v1.17.4 无 diagnostics operation、无 read 自动诊断、无超时配置。lsp_* 工具来自外部 MCP。 |

---

## 二、通过搜索确认的调用点、引用点和旧逻辑

### `lsp.diagnostics()` 调用点（5 处）
- `tool/write.ts:127` — 写后收集诊断 + report
- `tool/edit.ts:230` — 编辑后收集诊断 + report
- `tool/apply_patch.ts:322` — patch 后收集诊断 + report
- `tool/lsp.ts` — **无调用**（工具不暴露 diagnostics operation）
- `cli/cmd/debug/lsp.ts:24` — CLI `opencode debug lsp diagnostics`

### `lsp.touchFile()` 调用点（5 处）
- `tool/write.ts:126` — `touchFile(filepath, "document")`
- `tool/edit.ts:229` — `touchFile(filePath, "document")`
- `tool/apply_patch.ts:320` — `touchFile(target, "document")`
- `tool/read.ts:447` — `touchFile(filepath)` 无 diagnostics 模式（仅 warm）
- `tool/lsp.ts:80` — `touchFile(file, "document")`
- `cli/cmd/debug/lsp.ts:23` — `touchFile(args.file, "full")`

### `[local-smark]` 既有增强（3 处，必须保持一致）
- `write.ts:142-150` — 空诊断时 `status()` 检查，追加"LSP diagnostics unavailable"
- `edit.ts:236-244` — 同上
- `apply_patch.ts:352-359` — 同上

### lsp 工具 operation 列表引用
- `tool/lsp.ts:11-21` — operations 数组定义
- `tool/lsp.ts:50-55` — meta 构建（workspaceSymbol/documentSymbol/其他 三分支）
- `tool/lsp.ts:66-72` — detail/title 构建（同三分支）
- `tool/lsp.ts:82-103` — execute switch（9 个 case）
- `test/tool/lsp.test.ts` — 测试中所有调用都传 `line`/`character`（即使 documentSymbol/workspaceSymbol 不需要）

---

## 三、必须保持的既有行为

1. **单 `lsp` 工具架构**：不拆分为 `lsp_diagnostics`/`lsp_goto_definition` 等多工具。保持 `operation` 参数分派。
2. **`touchFile(file, "document")` 在所有 operation 前执行**：确保 LSP server 已打开文件并触发诊断。
3. **`hasClients(file)` 前置检查**：无匹配 server 时抛 `"No LSP server available for this file type."`。
4. **permission 机制**：所有 operation 走 `permission: "lsp"` + `patterns: ["*"]` + `always: ["*"]`。
5. **`[local-smark]` 空诊断 status() 检查**：write/edit/apply_patch 中的既有增强必须保持，新的 diagnostics operation 应保持一致。
6. **`Diagnostic.report()` 只显示 ERROR + 每文件 20 条上限**：write/edit/apply_patch 的输出格式不变。
7. **诊断超时常量不变**：`DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000` 等保持与 upstream 一致。
8. **`line`/`character` 在 schema 中保持必填**：与现有 documentSymbol/workspaceSymbol 模式一致（它们也不需要但必填）。模型已习惯此模式。
9. **read.ts warm 保持 fire-and-forget**：`touchFile` + `forkIn(scope)`，不阻塞 read，不显示诊断。

---

## 四、已确认的边界、兼容、时序和安全问题

### 边界
- **diagnostics operation 只返回当前文件诊断**：`lsp.diagnostics()` 返回所有文件的所有诊断（`Record<string, Diagnostic[]>`），但 diagnostics operation 只提取 `AppFileSystem.normalizePath(file)` 对应的条目。不泄漏其他文件诊断（缓解 Issue #16353 的子问题）。
- **单文件诊断数量**：单文件通常不会爆炸。但极端情况（如 Lua LSP）可能返回大量诊断。当前不加 slice 限制，与现有 operation（hover/definition 等返回完整 JSON）一致。如需限制可后续迭代。
- **诊断数据来源**：`lsp.diagnostics()` 只读取 `pushDiagnostics` + `pullDiagnostics` 缓存（Map 读取），不发起新请求。`touchFile(file, "document")` 才触发诊断请求。所以 diagnostics operation 的流程是：touchFile 触发 → diagnostics 读取缓存。

### 兼容
- **schema 变更**：operations 数组新增 `"diagnostics"`。line/character 保持必填（不改 schema 形状）。现有测试不受影响。
- **lsp.txt 变更**：新增 diagnostics 描述。不影响现有 operation 描述。
- **SDK 无影响**：`operations` 数组是 tool 参数 schema（发给 LLM 的工具描述），不进入 HTTP API 类型。SDK 的 `ToolListItem.parameters` 为 `Schema.Unknown`，operations 变化不反映在生成的 SDK 类型中。

### 时序
- **touchFile(document) 等待最多 5s**：`waitForDocumentDiagnostics` 的超时是 `DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000`。diagnostics operation 会继承此等待。如果 LSP server 初始化慢，operation 可能需要 5s。这是可接受的（和其他 operation 一致）。
- **warm 与 diagnostics operation 的关系**：read 的 warm 是 fire-and-forget 的 touchFile（不等待诊断）。如果 agent 先 read 再 diagnostics，warm 可能已经触发了诊断，diagnostics operation 的 touchFile 会再次触发（didChange 而非 didOpen），等待时间更短。

### 安全
- **permission**：diagnostics operation 走和其他 operation 相同的 `permission: "lsp"` 流程。
- **外部目录**：`assertExternalDirectoryEffect(ctx, file)` 已在所有 operation 前执行，diagnostics 也不例外。
- **文件存在性检查**：`fs.existsSafe(file)` 已在 hasClients 之前执行。

---

## 五、曾经不确定的地方及最终确认方式

1. **官方是否拆分了 lsp 工具为 lsp_* 多工具？**
   - 不确定来源：Issue #32030 提到 1.17.4 有 "lsp_* tools"。
   - 确认方式：gh api 获取 upstream dev 分支 `tool/lsp.ts`，确认仍是单 `Tool.define("lsp", ...)` + operation 分派。ChatGPT 调研确认 lsp_* 来自外部 MCP `lsp-tools-mcp`。
   - 结论：**官方未拆分**。

2. **PR #23771 (pull diagnostics) 是否在本地基线中？**
   - 不确定来源：`git merge-base --is-ancestor 8cade05 HEAD` 返回 ABSENT。
   - 确认方式：读取 `client.ts`，确认 `requestDocumentDiagnostics`/`waitForDocumentDiagnostics`/`waitForFullDiagnostics` 等函数存在。
   - 结论：**代码存在**，ABSENT 是 squash 导致的 ancestor 检查失效。

3. **line/character 是否应改为 optional？**
   - 不确定来源：diagnostics operation 不需要 line/character。
   - 确认方式：审查现有 documentSymbol/workspaceSymbol（也不需要但必填），审查测试（都传 line/character），审查模型调用习惯。
   - 结论：**保持必填**。与现有模式一致，最小改动，不引入运行时检查。

4. **diagnostics operation 是否需要 status() 区分"LSP 未运行"？**
   - 不确定来源：smark 在 write/edit/apply_patch 中做了此区分。
   - 确认方式：审查 `hasClients` vs `status()` 的语义差异（hasClients 检查配置，status() 检查已连接 client；server 可能配置但 broken）。
   - 结论：**需要**。diagnostics operation 在结果为空时调用 `status()`，与 smark 既有增强一致。

5. **read 是否应自动显示诊断？**
   - 不确定来源：Issue #16569 建议此功能。
   - 确认方式：评估风险（拖慢 read、增加 token 消耗、诊断可能不 ready）。官方拒绝此功能。
   - 结论：**不做**。read 保持 fire-and-forget warm。agent 可通过 diagnostics operation 主动查询。

6. **是否需要回移 PR #28761 (JDTLS Maven root)？**
   - 不确定来源：upstream 在 v1.17.0 合并了此 PR。
   - 确认方式：审查 server.ts JDTLS 定义，评估是否需要 Java Maven 多模块支持。
   - 结论：**不在本次范围**。Java 专用，与本需求（诊断增强）无直接关系。可后续单独回移。

---

## 六、推荐的最小实现方案

### 方案概述
两项改动：
1. **回移 PR #30226**：read.ts warm `Effect.ignore` → `Effect.ignoreCause`（1 行，隔离 LSP warmup defect）。
2. **添加 `diagnostics` operation**：让 agent 能主动查询任意文件的 LSP 诊断，而不需要修改文件。

### 为什么比其他方案更符合现有设计

| 方案 | 改动量 | 价值 | 风险 | 是否推荐 |
| --- | --- | --- | --- | --- |
| 只回移 PR #30226 | 1 行 | 低（仅 defect 隔离） | 极低 | 不充分 |
| 回移 + diagnostics operation | ~60 行 | 高（填补 agent 无法主动查诊断的缺口） | 低 | **推荐** |
| 回移 + diagnostics + read 自动诊断 | ~100 行 | 高但风险增加 | 中（拖慢 read、token 消耗） | 不推荐（官方已拒绝） |
| 回移 + diagnostics + 超时配置化 | ~120 行 | 高但引入新配置项 | 中（新抽象） | 不推荐（过度） |
| 拆分 lsp_* 多工具 | ~300 行 | 高但大重构 | 高（破坏现有架构） | 不推荐（官方未做） |

推荐方案符合现有设计：
- **复用单工具 + operation 分派架构**：不拆分工具，不新增 Tool.define。
- **复用 `touchFile(document)` + `diagnostics()` 流程**：与 write/edit/apply_patch 一致。
- **复用 `[local-smark]` status() 检查**：diagnostics operation 空结果时走相同逻辑。
- **复用 `hasClients` 前置检查 + permission 流程**：与其他 operation 一致。
- **手术刀式**：只改 4 个文件（read.ts 1 行 + lsp.ts ~30 行 + lsp.txt ~3 行 + lsp.test.ts ~30 行）。

---

## 七、预计修改/新增/删除的文件

### 1. `packages/opencode/src/tool/read.ts`（修改 1 行）
回移 PR #30226：
```ts
// 行 447，从：
yield* lsp.touchFile(filepath).pipe(Effect.ignore, Effect.forkIn(scope))
// 改为：
// [local-smark] 回移 PR #30226：用 ignoreCause 隔离后台 LSP warmup defect，
// 避免 read 成功后异步预热中的 Die 逸出到 scope。
yield* lsp.touchFile(filepath).pipe(Effect.ignoreCause, Effect.forkIn(scope))
```

### 2. `packages/opencode/src/tool/lsp.ts`（修改 ~30 行）

**a. operations 数组添加 "diagnostics"：**
```ts
const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "diagnostics",
] as const
```

**b. meta 构建（diagnostics 与 documentSymbol 同分支，只需 filePath）：**
```ts
const meta =
  args.operation === "workspaceSymbol"
    ? { operation: args.operation }
    : args.operation === "documentSymbol" || args.operation === "diagnostics"
      ? { operation: args.operation, filePath: file }
      : { operation: args.operation, filePath: file, line: args.line, character: args.character }
```

**c. detail/title 构建（diagnostics 与 documentSymbol 同分支，用 relPath）：**
```ts
const detail =
  args.operation === "workspaceSymbol"
    ? ""
    : args.operation === "documentSymbol" || args.operation === "diagnostics"
      ? relPath
      : `${relPath}:${args.line}:${args.character}`
```

**d. execute switch 添加 diagnostics case：**
```ts
case "diagnostics":
  return Effect.gen(function* () {
    const all = yield* lsp.diagnostics()
    return all[AppFileSystem.normalizePath(file)] ?? []
  })
```

**e. 统一 return 之前，diagnostics 空结果时 status() 检查（复用 smark 增强模式）：**
```ts
// [local-smark] diagnostics 空结果时区分"无错误"和"LSP 未运行"，
// 与 write/edit/apply_patch 的 status() 检查保持一致。
if (args.operation === "diagnostics" && result.length === 0) {
  const clients = yield* lsp.status()
  if (clients.length === 0) {
    return {
      title,
      metadata: { result },
      output: "LSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.",
    }
  }
}

return {
  title,
  metadata: { result },
  output: result.length === 0 ? `No results found for ${args.operation}` : JSON.stringify(result, null, 2),
}
```

### 3. `packages/opencode/src/tool/lsp.txt`（修改 ~3 行）
在 Supported operations 列表中添加：
```
- diagnostics: Get LSP diagnostics (errors, warnings) for a file
```
在 All operations require 部分后添加说明：
```
For diagnostics, line and character are not used but must be provided (use 1).
```

### 4. `packages/opencode/test/tool/lsp.test.ts`（修改 ~60 行）

需更新共享 mock，使 `status` 和 `diagnostics` 可按测试变体返回不同值。当前 mock 是 `Layer.succeed` 固定返回，改为可变闭包：

```ts
// mock 状态容器（替代固定 Layer.succeed）
const mockState = {
  statusResult: [] as LSP.Status[],
  diagnosticsResult: {} as Record<string, LSPClient.Diagnostic[]>,
}
const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    // ... 其他方法不变 ...
    status: () => Effect.sync(() => mockState.statusResult),
    diagnostics: () => Effect.sync(() => mockState.diagnosticsResult),
    // ...
  }),
)
```

测试用例：

```ts
it.live("omits cursor details for diagnostics", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        mockState.statusResult = []
        mockState.diagnosticsResult = {}
        const file = path.join(dir, "test.ts")
        yield* put(file)

        const { items, next } = asks()
        const result = yield* run({ operation: "diagnostics", filePath: file, line: 1, character: 1 }, next)
        const req = items.find((item) => item.permission === "lsp")

        expect(req).toBeDefined()
        expect(req!.metadata).toEqual({ operation: "diagnostics", filePath: file })
        expect(result.title).toBe("diagnostics test.ts")
        // status() 返回空 → "LSP diagnostics unavailable"
        expect(result.output).toContain("LSP diagnostics unavailable")
      }),
    { git: true },
  ),
)

it.live("diagnostics reports clean when LSP running but no issues", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        mockState.statusResult = [{ id: "typescript", name: "typescript", root: ".", status: "connected" }]
        mockState.diagnosticsResult = {}
        const file = path.join(dir, "test.ts")
        yield* put(file)

        const { next } = asks()
        const result = yield* run({ operation: "diagnostics", filePath: file, line: 1, character: 1 }, next)

        expect(result.output).toBe("No results found for diagnostics")
      }),
    { git: true },
  ),
)

it.live("diagnostics returns JSON when issues exist", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        mockState.statusResult = [{ id: "typescript", name: "typescript", root: ".", status: "connected" }]
        const file = path.join(dir, "test.ts")
        yield* put(file)
        const normalized = (yield* AppFileSystem.Service).normalizePath(file)
        mockState.diagnosticsResult = {
          [normalized]: [
            { severity: 1, message: "Type error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
          ],
        }

        const { next } = asks()
        const result = yield* run({ operation: "diagnostics", filePath: file, line: 1, character: 1 }, next)

        const parsed = JSON.parse(result.output)
        expect(parsed).toHaveLength(1)
        expect(parsed[0].message).toBe("Type error")
      }),
    { git: true },
  ),
)
```

### SDK 影响
**无影响**。`operations` 数组是 tool 参数 schema（发给 LLM 的工具描述），不进入 HTTP API 类型。SDK 的 `ToolListItem.parameters` 为 `Schema.Unknown`，operations 变化不反映在生成的 SDK 类型中。无需运行 `build.ts`。

---

## 八、正常路径、错误路径、并发/退出/清理/安全边界

### 正常路径
1. agent 调用 `lsp` 工具，`operation: "diagnostics"`，`filePath: "src/foo.ts"`，`line: 1`，`character: 1`。
2. 解析 file 为绝对路径 → `assertExternalDirectoryEffect` → permission ask。
3. `fs.existsSafe(file)` 检查文件存在。
4. `lsp.hasClients(file)` 检查有匹配的 LSP server。
5. `lsp.touchFile(file, "document")` 打开文件 + 等待 document 诊断（最多 5s）。
6. `lsp.diagnostics()` 读取所有 client 的缓存诊断（Map 读取，无副作用）。
7. 提取 `AppFileSystem.normalizePath(file)` 对应的 `Diagnostic[]`。
8. 返回 `{ title: "diagnostics src/foo.ts", metadata: { result }, output: JSON.stringify(result, null, 2) }`。

### 错误路径
- **文件不存在**：`fs.existsSafe` 返回 false → `throw new Error("File not found: ...")`。与其他 operation 一致。
- **无 LSP server**：`hasClients` 返回 false → `throw new Error("No LSP server available for this file type.")`。与其他 operation 一致。
- **LSP server 启动失败（broken）**：`hasClients` 返回 true（有配置），`touchFile` 的 `getClients` 内部 spawn 失败会加入 `broken` Set，诊断为空。`diagnostics()` 返回空。`status()` 返回空 → 输出 "No LSP server running. Diagnostics unavailable."。
- **LSP server 初始化超时**：`touchFile` 的 `waitForDocumentDiagnostics` 超时 5s 后返回。诊断可能为空或部分。`diagnostics()` 返回已有的。不抛错。
- **permission 被拒绝**：`ctx.ask` 抛错，Effect 链中断。与其他 operation 一致。

### 并发
- **多次 diagnostics operation 并发**：`touchFile` 内部 `getClients` 有 `spawning` Map 去重，同一 server+root 的 spawn 只执行一次。`diagnostics()` 是纯 Map 读取，线程安全。
- **diagnostics 与 write/edit 并发**：`touchFile` 的 `notify.open` 对已打开文件发 `didChange`，version 递增。诊断会基于最新 version。无竞态。

### 退出/清理
- **diagnostics operation 不持有资源**：不 spawn 进程、不订阅事件、不打开文件句柄。无需额外清理。
- **LSP client 的生命周期由 LSP Service 管理**：`InstanceState` 的 `addFinalizer` 在 instance disposed 时 `shutdown` 所有 client。diagnostics operation 不影响此生命周期。

### 安全边界
- **外部目录**：`assertExternalDirectoryEffect` 防止访问 instance 外的文件。
- **permission**：diagnostics operation 走 `permission: "lsp"`，用户可配置规则限制。
- **诊断数据不包含文件内容**：Diagnostic 只包含 range/message/severity/code/source，不包含源码。无信息泄漏。

---

## 九、行为级测试计划

### 先写的测试（TDD）
1. **diagnostics permission metadata**：验证 `metadata = { operation: "diagnostics", filePath: file }`（不含 line/character）。
2. **diagnostics title**：验证 `title = "diagnostics test.ts"`。
3. **diagnostics 空结果 + LSP 未运行**：mock `status()` 返回 `[]`，验证输出含 "No LSP server running"。
4. **diagnostics 空结果 + LSP 运行中**：mock `status()` 返回非空，验证输出 "No results found for diagnostics"。
5. **diagnostics 有结果**：mock `diagnostics()` 返回 `{ [normalizedPath]: [{ severity: 1, message: "...", range: ... }] }`，验证输出为 JSON。

### 当前实现下会暴露的缺口
- 当前 lsp.ts 工具无 diagnostics operation，测试 1-5 会因 schema 验证失败（operation 不在枚举中）而报错。
- 当前 mock 的 `diagnostics: () => Effect.succeed({})` 无法测试"有结果"场景，需更新 mock。

### 实现后如何验证
- 运行 `bun test test/tool/lsp.test.ts` 验证工具层测试。
- 运行 `bun test test/lsp/` 验证 LSP 模块测试不受影响。
- 运行 `bun typecheck` 验证类型。
- 手动验证：`opencode debug lsp diagnostics <file>` 仍正常（不受影响，走 CLI 路径）。

---

## 十、建议运行的验证命令

```bash
# 类型检查（从 package 目录运行）
cd packages/opencode && bun typecheck

# LSP 模块测试
cd packages/opencode && bun test test/lsp/

# lsp 工具测试
cd packages/opencode && bun test test/tool/lsp.test.ts

# read 工具测试（验证 ignoreCause 不破坏）
cd packages/opencode && bun test test/tool/read.test.ts
```

---

## 十一、预估 git 文件数、增删行数

| 文件 | 新增行 | 删除行 | 说明 |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/read.ts` | 2 | 1 | ignore→ignoreCause + 注释 |
| `packages/opencode/src/tool/lsp.ts` | ~20 | ~6 | diagnostics operation |
| `packages/opencode/src/tool/lsp.txt` | ~2 | 0 | diagnostics 描述 |
| `packages/opencode/test/tool/lsp.test.ts` | ~55 | ~5 | diagnostics 测试 + mock 可变化 |
| **手动改动合计** | ~79 | ~12 | 4 个文件 |

净增约 67 行。无迁移、无新文档（本方案文档除外）、无 SDK 生成文件变化。

---

## 十二、真实风险与开放问题

### 风险
1. **模型对 diagnostics operation 的采用率**：agent 可能不知道何时该用 diagnostics operation。需要 lsp.txt 描述清晰。低风险。
2. **诊断输出大小**：单文件诊断通常可控，但极端情况（如 Lua LSP 返回大量诊断）可能消耗 token。当前不加 slice 限制，与现有 operation 一致。如需限制可后续迭代。低风险。
3. **SDK 类型变化**：operations 数组变化不影响 SDK 类型（`parameters: Schema.Unknown`）。无需重新生成。无风险。（subagent 审计确认）
4. **`Effect.ignoreCause` 回移**：从 `Effect.ignore` 改为 `Effect.ignoreCause`。`ignoreCause` 捕获所有 cause（包括 Die），而 `ignore` 只捕获 fail。这意味着 LSP warmup 中的 Die 会被静默吞掉。这是 PR #30226 的意图（defect 不应逸出到 read scope）。但如果 LSP 有严重的 Die（如内存损坏），会被隐藏。极低风险（warmup 是 best-effort）。

### 开放问题
1. **是否需要 `languageId` 配置支持（Issue #23663）？** 本次不做。custom server 的 `didOpen` 仍发 `"plaintext"` 作为 languageId。如需支持，需改 `config/lsp.ts` + `client.ts`。与诊断增强无直接关系。
2. **是否需要诊断超时配置化（Issue #742/#13326）？** 本次不做。超时常量保持与 upstream 一致。如需配置化，需改 `config/lsp.ts` + `client.ts`，引入新配置项。
3. **是否需要 metadata 层诊断限流（Issue #6310）？** 本次不做。`metadata.diagnostics` 仍存储当前文件的完整 Diagnostic[]。单文件通常可控。
4. **是否回移 PR #28761 (JDTLS Maven root)？** 不在本次范围。Java 专用，可后续单独回移。

---

## 十三、推荐方案摘要

**两项改动，4 个文件，净增约 67 行：**

1. **回移 PR #30226**（read.ts 1 行）：`Effect.ignore` → `Effect.ignoreCause`，隔离 LSP warmup defect，防止后台预热异常逸出到 read scope。

2. **添加 `diagnostics` operation**（lsp.ts + lsp.txt + lsp.test.ts）：在现有单 `lsp` 工具架构内新增 `diagnostics` operation，让 agent 能主动查询任意文件的 LSP 诊断（不需要修改文件）。复用 `touchFile(document)` + `diagnostics()` 流程，复用 `[local-smark]` status() 空诊断检查模式。保持 `line`/`character` 必填（与 documentSymbol/workspaceSymbol 一致）。

**不做的：** read 自动显示诊断（官方已拒绝）、超时配置化（过度）、拆分 lsp_* 多工具（大重构）、languageId 支持（与诊断增强无关）、JDTLS Maven root（Java 专用，单独回移）。
