# VS Code Notebook 工具基础设施增强方案

## 0. 调研基础

### 已阅读的文件

| 文件 | 行数 | 为何相关 |
|---|---|---|
| `sdks/vscode/src/notebook/env.ts` | 959 | env 工具全部实现：info/configure/restart/save，kernel 探测，selectKernel 超时 |
| `sdks/vscode/src/notebook/run.ts` | 238 | run 工具实现：cell 执行、超时等待、范围执行停止逻辑 |
| `sdks/vscode/src/notebook/edit.ts` | 681 | edit 工具实现：insert/edit/delete、string-match、after-source 预览 |
| `sdks/vscode/src/notebook/source.ts` | 238 | source 工具实现：分页读取、cellId 自动扩展 |
| `sdks/vscode/src/notebook/summary.ts` | 81 | summary 工具实现 |
| `sdks/vscode/src/notebook/output.ts` | 136 | output 工具实现：artifact 落盘 |
| `sdks/vscode/src/notebook/resolve.ts` | 53 | notebook/cell 解析（无创建路径） |
| `sdks/vscode/src/notebook/format.ts` | 327 | 共享格式化工具 |
| `sdks/vscode/src/notebook/commands.ts` | 276 | 调试命令面板 |
| `sdks/vscode/src/bridge.ts` | 225 | HTTP bridge：路由、withFileLock、readJson |
| `sdks/vscode/src/util.ts` | 145 | 共享工具函数 |
| `packages/opencode/src/plugin/vscode-bridge.ts` | 437 | CLI 侧工具注册、权限、超时配置 |
| `packages/opencode/src/plugin/vscode-bridge-descriptions.ts` | 53 | tool description |
| `packages/opencode/src/ide/vscode-bridge.ts` | 439 | bridge 客户端、路径规范化 |
| `packages/opencode/src/agent/agent.ts` | 565 | 权限配置（interactive ask, plan deny） |
| `packages/opencode/test/plugin/vscode-notebook-tool-summary.test.ts` | 579 | 唯一 notebook 测试文件（fake vscode module） |
| `packages/opencode/test/plugin/vscode-bridge.test.ts` | 501 | CLI 侧测试（权限、metadata） |
| `packages/opencode/test/ide/vscode-bridge.test.ts` | 194 | bridge 发现测试 |
| hamelnb `jupyter_live_kernel.py` | 2153 | 外部对比：变量检查、kernel 空闲等待、transport 重试安全 |

### 通过搜索确认的调用点

1. **`withFileLock`**（bridge.ts:41-52）：所有 POST 请求按 filePath 序列化。只读操作（summary/source/output）也被阻塞。
2. **`jupyter.interruptkernel`**：代码库中无引用。VS Code Jupyter 扩展提供此命令用于中断 kernel，类似 `jupyter.restartkernel`。
3. **`notebook.cell.execute`**（run.ts:86）：VS Code 命令，启动 cell 执行。返回速度取决于 VS Code 实现——mock 中立即返回，真实环境中通常快速返回（不等执行完成）。
4. **`waitForSingleCell`**（run.ts:207-238）：通过 `onDidChangeNotebookDocument` 监听 cell 执行完成。超时后 resolve(undefined)，但**不取消执行**。
5. **`resolveNotebook`**（resolve.ts:13-20）：尝试在 `notebookDocuments` 中查找，找不到则 `openNotebookDocument`。**无创建路径**——文件不存在时 `openNotebookDocument` 会失败。
6. **env operation 验证**（env.ts:129-133）：`["info", "configure", "restart", "save"]` 数组检查。新增操作只需加到数组。
7. **CLI envArgs**（vscode-bridge.ts:114-115）：`z.enum(["info", "configure", "restart", "save"])`。新增操作需更新 enum。
8. **agent 权限**（agent.ts:165-166, 225-227）：`vscode_notebook_env` 在 interactive 是 ask、plan 是 deny。操作级别无区分，新增操作自动继承。
9. **`readJson`**（bridge.ts:209-225）：`JSON.parse(body)` 失败直接抛原始错误。
10. **`RESTART_CMD = "jupyter.restartkernel"`**（env.ts:109）：restart 命令常量。无 `INTERRUPT_CMD`。

### 必须保持的既有行为

1. **三层响应结构**：`{ ran, summary, data }` — summary 发给模型，data 用于 TUI metadata
2. **notebookHeader 不变量**：每个工具 summary 前两行是 `Notebook: <path>` 和 `<Label>: <fields>`
3. **`withFileLock` 对变更操作的保护**：run/edit/env 变更操作仍需序列化
4. **权限模型**：env 工具在 interactive 是 ask、plan 是 deny（操作级别无区分）
5. **`oldCode: ""` 空字符串**：落入 full-cell replacement（45 次成功使用）
6. **after-source 预览**：edit 响应包含前 10 行 after-source（已修复）
7. **source 自动扩展 limit**：cellId 请求不传 limit 时自动扩展到整个 cell（已修复）
8. **selectKernel 15s 超时**：configure 的 selectKernel 有 Promise.race 超时（已修复）
9. **全局请求队列已移除**：客户端不再全局序列化（已修复）

### 已确认的边界/兼容/时序/安全问题

1. **withFileLock 阻塞只读操作**：50 分钟 run 期间 summary/source/output 被阻塞，agent 无法检查 notebook 状态
2. **run 超时不取消执行**：`waitForSingleCell` 超时后 cell 仍在运行，agent 无法通过工具停止
3. **无 interrupt 能力**：env 只有 restart（更重），没有 stop/interrupt（轻量级中断）
4. **无 notebook 创建**：agent 被迫用 `write` 写入原始 JSON，而非创建结构化 notebook
5. **run 无 kernel 预检**：无 kernel 时 `notebook.cell.execute` 静默失败或打开 picker
6. **restart 不验证**：`jupyter.restartkernel` 内部 `.catch(noop)` 吞错误，返回 "requested" 不确认实际重启
7. **readJson 错误**：`JSON.parse` 失败抛原始错误，6 个数据库案例显示 "JSON Parse error: Unrecognized token"
8. **`notebook.cell.execute` 返回时机**：mock 立即返回，真实 VS Code 通常快速返回（不等执行完成）。`waitForSingleCell` 是真正的等待点。

---

## 1. 问题全量审计（6 个工具 × 5 个维度）

### 维度说明

| 维度 | 含义 |
|---|---|
| 超时 | 工具调用是否有超时？超时后行为？ |
| 阻塞 | 是否被 withFileLock 阻塞？阻塞时长？ |
| 错误恢复 | 错误消息是否可操作？agent 能否恢复？ |
| 缺失能力 | 工具缺少什么关键操作？ |
| 并发安全 | 并发请求是否安全？ |

### 1.1 vscode_notebook_summary

| 维度 | 现状 | 问题 |
|---|---|---|
| 超时 | CLI 10s | ✅ 合理 |
| 阻塞 | 被 withFileLock 阻塞 | ❌ 只读操作不应被 run 阻塞 |
| 错误恢复 | resolveNotebook 失败抛错 | ✅ 可接受 |
| 缺失能力 | — | ✅ 无 |
| 并发安全 | ✅ | — |

### 1.2 vscode_notebook_source

| 维度 | 现状 | 问题 |
|---|---|---|
| 超时 | CLI 10s | ✅ 合理 |
| 阻塞 | 被 withFileLock 阻塞 | ❌ 只读操作不应被 run 阻塞 |
| 错误恢复 | cell not found 带恢复建议 | ✅ 已修复 |
| 缺失能力 | — | ✅ 无 |
| 并发安全 | ✅ | — |

### 1.3 vscode_notebook_run

| 维度 | 现状 | 问题 |
|---|---|---|
| 超时 | 默认 300s/cell，最大 3000s | ⚠️ 超时后 cell 仍在运行，不取消 |
| 阻塞 | 持有 withFileLock 整个执行时长 | ❌ 阻塞同 notebook 的所有操作 |
| 错误恢复 | "timed out (may still be running...)" | ❌ 不可操作，无恢复指引 |
| 缺失能力 | 无 kernel 预检 | ❌ 无 kernel 时静默失败或弹 picker |
| 并发安全 | withFileLock 保护 | ✅ |

### 1.4 vscode_notebook_output

| 维度 | 现状 | 问题 |
|---|---|---|
| 超时 | CLI 30s | ✅ 合理 |
| 阻塞 | 被 withFileLock 阻塞 | ❌ 只读操作不应被 run 阻塞 |
| 错误恢复 | cell not found 带恢复建议 | ✅ 已修复 |
| 缺失能力 | — | ✅ 无 |
| 并发安全 | ✅ | — |

### 1.5 vscode_notebook_edit

| 维度 | 现状 | 问题 |
|---|---|---|
| 超时 | CLI 30s, server 10s sync | ✅ 合理 |
| 阻塞 | 被 withFileLock 阻塞 | ✅ 变更操作应被阻塞 |
| 错误恢复 | oldCode/cell/newCode 错误均带建议 | ✅ 已修复 |
| 缺失能力 | — | ✅ 无 |
| 并发安全 | withFileLock 保护 | ✅ |

### 1.6 vscode_notebook_env

| 维度 | 现状 | 问题 |
|---|---|---|
| 超时 | CLI 120s, selectKernel 15s, probe 30s | ✅ 已修复 |
| 阻塞 | 被 withFileLock 阻塞 | ✅ env 操作应被阻塞（含 kernel 交互） |
| 错误恢复 | configure 5 种状态 + guidance | ✅ 已修复 |
| 缺失能力 | ❌ 无 stop/interrupt；❌ 无 create | **核心缺口** |
| 并发安全 | withFileLock 保护 | ✅ |
| restart 验证 | ❌ 不验证实际重启 | 返回 "requested" 不确认 |

---

## 2. 推荐实现方案

### 方案总览

| # | 优先级 | 改进 | 文件 | 借鉴 |
|---|---|---|---|---|
| 1 | P0 | withFileLock 旁路只读操作 | bridge.ts | — |
| 2 | P0 | env 新增 `stop` 操作（interrupt kernel） | env.ts, vscode-bridge.ts, descriptions.ts, commands.ts | hamelnb `_ensure_kernel_idle` |
| 3 | P0 | env 新增 `create` 操作（创建空白 notebook） | env.ts, vscode-bridge.ts, descriptions.ts, commands.ts | hamelnb "create minimal notebook" |
| 4 | P1 | run 执行前 kernel 预检 | run.ts | hamelnb `_ensure_kernel_idle` |
| 5 | P1 | restart 后轻量级验证 kernel 状态 | env.ts | hamelnb `_wait_for_kernel_idle` |
| 6 | P2 | readJson 错误处理增强 | bridge.ts | — |
| 7 | P0 | 全工具错误路径增加 agent 恢复指引 | run.ts, env.ts, resolve.ts, bridge.ts | — |

### 改进 1: withFileLock 旁路只读操作（P0）

**文件**: `sdks/vscode/src/bridge.ts`

**问题**: `withFileLock`（line 102）序列化所有 POST 请求。50 分钟 run 阻塞 summary/source/output。

**方案**: 定义只读路由集合，只读路由跳过 `withFileLock`。

```ts
// 只读路由不需要 withFileLock：它们只读取 VS Code 文档状态，
// 不修改 notebook 或 kernel 状态，与并发变更操作不冲突。
// run/edit/env 仍需 withFileLock 防止并发变更。
// cell-output 是 output 的别名（bridge.ts:168 case fallthrough），必须同时列入只读集合
const READONLY_ROUTES = new Set(["/notebook/summary", "/notebook/source", "/notebook/output", "/notebook/cell-output"])

// bridge.ts line 102 改为：
const filePath = stringProp(body, "filePath") ?? url.pathname
const handler = () => routeRequest(url.pathname, body, output)
const result = READONLY_ROUTES.has(url.pathname)
  ? await handler()
  : await withFileLock(filePath, handler)
```

**不改变的行为**:
- run/edit/env 仍被 withFileLock 序列化
- 只读操作并发安全（VS Code notebook document 读取线程安全）

### 改进 2: env 新增 `stop` 操作（P0）

**文件**: `sdks/vscode/src/notebook/env.ts` + CLI 侧

**问题**: cell 执行超时后仍在运行，agent 无法通过工具停止。restart 太重（清除所有状态）。

**方案**: 新增 `stop` 操作，调用 `jupyter.interruptkernel` 中断当前执行的 cell。

**env.ts 改动**:

1. 新增常量：
```ts
// interrupt 命令与 restart 类似，由 Jupyter 扩展贡献，可能隐藏在公共命令列表之外
const INTERRUPT_CMD = "jupyter.interruptkernel"
```

2. operation 验证数组更新：`["info", "configure", "restart", "save", "stop"]`

3. switch 新增 case：
```ts
case "stop":
  return await stopNotebookKernel(notebook, reason)
```

4. 新增 `stopNotebookKernel` 函数（模式与 `restartNotebookKernel` 一致）：
```ts
async function stopNotebookKernel(notebook: vscode.NotebookDocument, reason?: string) {
  // 确认 Jupyter 扩展可用 + 命令注册
  // 调用 jupyter.interruptkernel（不需要抑制确认弹窗，interrupt 无弹窗）
  // 返回 { ran: true, summary, data: { operation: "stop", requested, durationMs } }
  // 错误处理：jupyter 缺失 → "failed"；命令未注册 → "failed"；执行异常 → "failed"
}
```

**与 restart 的差异**:
- interrupt 不需要抑制确认弹窗（restart 需要 `jupyter.askForKernelRestart=false`）
- interrupt 不清除 kernel 状态（变量/导入保持）
- interrupt 只停止当前正在执行的 cell
- interrupt 更轻量、更快

**CLI 侧改动**:
- `envArgs.operation` enum 增加 `"stop"`
- `vscode-bridge-descriptions.ts` env description 增加_stop 说明
- `commands.ts` quick-pick 增加 stop 条目

### 改进 3: env 新增 `create` 操作（P0）

**文件**: `sdks/vscode/src/notebook/env.ts` + CLI 侧

**问题**: agent 被迫用 `write` 写入原始 JSON 创建 notebook，而非创建结构化 .ipynb。

**方案**: 新增 `create` 操作，在磁盘上创建最小 .ipynb 文件并用 `openNotebookDocument` 打开。

**env.ts 改动**:

1. operation 验证数组更新：增加 `"create"`

2. switch 新增 case：
```ts
case "create":
  return await createNotebook(notebook, reason, input)
```

注意：`create` 不需要先 `resolveNotebook`（文件还不存在）。handler 入口需要特殊处理：
```ts
// create 操作在文件不存在时创建新 notebook，不能走 resolveNotebook 路径
if (operation === "create") {
  return await createNotebook(filePath, reason)
}
// 其他操作需要先解析已存在的 notebook
const notebook = await resolveNotebook(filePath)
```

3. 新增 `createNotebook` 函数：
```ts
async function createNotebook(filePath: string, reason?: string) {
  const uri = uriFromInput(filePath)
  // 先检查磁盘是否已存在（包括未在 VS Code 中打开的文件），防止静默覆盖用户数据
  try {
    await vscode.workspace.fs.stat(uri)
    // stat 成功说明文件已存在，返回 already-exists 而非覆盖
    return {
      ran: true,
      summary: [
        `Notebook: ${filePath}`,
        `Env: operation=create status=already-exists`,
        `Notebook file already exists. Use vscode_notebook_summary to inspect it.`,
        reason ? `Reason: ${reason}` : "",
      ].filter(Boolean).join("\n"),
      data: { path: filePath, operation: "create", created: false, alreadyExists: true },
    }
  } catch {
    // stat 抛 ENOENT 是预期行为——文件不存在，继续创建
  }
  // 创建最小 .ipynb JSON（nbformat 4.5 标准）
  const minimalNotebook = JSON.stringify({
    cells: [],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 2)
  try {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(minimalNotebook))
    // 打开创建的 notebook
    const notebook = await vscode.workspace.openNotebookDocument(uri)
    return {
      ran: true,
      summary: [
        ...notebookHeader(notebook, "Env", [`operation=create`, `status=created`, `cells=0`]),
        `Notebook created successfully with empty cell list.`,
        `Use vscode_notebook_edit with editType=insert to add cells, or vscode_notebook_env with operation=configure to select a kernel.`,
        reason ? `Reason: ${reason}` : "",
      ].filter(Boolean).join("\n"),
      data: {
        path: filePath,
        operation: "create",
        created: true,
        cellCount: 0,
        durationMs: 0,
      },
    }
  } catch (error) {
    // writeFile/openNotebookDocument 失败（目录不存在、权限不足等）返回结构化错误
    const message = error instanceof Error ? error.message : String(error)
    return {
      ran: true,
      summary: [
        `Notebook: ${filePath}`,
        `Env: operation=create status=failed`,
        `Notebook creation failed: ${message}`,
        reason ? `Reason: ${reason}` : "",
      ].filter(Boolean).join("\n"),
      data: { path: filePath, operation: "create", created: false, error: message },
    }
  }
}
```

**CLI 侧改动**:
- `envArgs.operation` enum 增加 `"create"`
- description 增加 create 说明
- `vscode_notebook_env` 的 `ask` 权限覆盖 create（创建文件是变更操作）
- **CLI 侧 `vscode-bridge.ts:432` 的 edit 门禁必须显式扩展到 create**：`if (args.operation === "save" || args.operation === "create") await ask(context, "edit", args)`——create 创建磁盘文件，与 save 一样是写入操作，必须服从通用 `edit` deny 规则，否则用户禁止 edit 时仍可通过 create 绕过

### 改进 4: run 执行前 kernel 预检（P1）

**文件**: `sdks/vscode/src/notebook/run.ts`

**问题**: 无 kernel 时 `notebook.cell.execute` 静默失败或弹 picker。

**方案**: 执行前检查 kernel 是否活跃。无 kernel 时返回 "no-active-kernel" 引导先 configure。

**run.ts 改动**（line 47-53 之间）:
```ts
// 执行前检查 kernel 是否可用。注意：configure 的 "selected" 状态意味着
// kernel 已选定但未启动——getKernel 此时返回 undefined 是正常的，
// notebook.cell.execute 会在首次执行时启动 kernel。
// 因此预检只在"既无活跃 kernel 又无 kernelspec metadata"时才阻断，
// 避免阻断 configure→run 的正常首跑路径。
const jupyter = vscode.extensions.getExtension("ms-toolsai.jupyter")
if (jupyter) {
  if (!jupyter.isActive) await jupyter.activate()
  const api = jupyter.exports as { kernels?: { getKernel?(uri: vscode.Uri): Promise<unknown> } } | undefined
  const kernel = await api?.kernels?.getKernel?.(notebook.uri)
  if (!kernel) {
    // getKernel 返回 undefined 可能是 "已选定但未启动"（正常）或 "完全未选定"。
    // 检查 notebook metadata 是否有 kernelspec：有则允许继续（kernel 会在执行时启动），
    // 无则阻断并引导 agent 先 configure。
    const meta = notebook.metadata as Record<string, unknown>
    const hasKernelspec = isRecord(meta?.kernelspec) || isRecord(meta?.language_info)
    if (!hasKernelspec) {
      return {
        ran: false,
        summary: [
          ...notebookHeader(notebook, "Run", [
            `target=${quoteForSummary(describeRunTarget(cells))}`,
            `status="no-active-kernel"`,
            `dirty=${notebook.isDirty}`,
            `runtime=${quoteForSummary(runtimeLabel(notebook) ?? "unknown")}`,
          ]),
          "",
          "No active kernel and no kernelspec metadata. Call vscode_notebook_env with operation=configure to select a kernel first, then retry.",
        ].join("\n"),
        data: {
          path: notebook.uri.fsPath || notebook.uri.toString(),
          dirty: notebook.isDirty,
          runtime: runtimeLabel(notebook),
          target: describeRunTarget(cells),
          completed: false,
          stoppedAt: undefined,
          cells: [],
          noActiveKernel: true,
        },
      }
    }
    // kernelspec 存在但 kernel 未启动：继续执行，notebook.cell.execute 会启动 kernel
  }
}
```

**注意**: 此检查不调用 `executeCode`（只调 `getKernel`），不会阻塞。如果 kernel 存在但 busy，`notebook.cell.execute` 会排队。

### 改进 5: restart 后轻量级验证 kernel 状态（P1）

**文件**: `sdks/vscode/src/notebook/env.ts`

**问题**: restart 返回 "requested" 不确认实际重启。

**方案**: restart 命令后，单次轻量级验证 kernel 可访问性（只调 `getKernel` 检查 kernel 存在性，**不调 `executeCode`** 避免探测延迟和过渡期副作用）。

**env.ts 改动**:

1. 新增轻量级 kernel 检查函数（不调用 executeCode，避免 probePythonRuntime 的 30s 延迟）：
```ts
// 轻量级 kernel 可访问性检查：只调 getKernel 不调 executeCode。
// 用于 restart 验证等不需要 Python 运行时详情的场景，
// 避免 probePythonRuntime 在重启过渡期执行代码导致的 30s 延迟和假阳性。
async function isKernelAccessible(uri: vscode.Uri): Promise<boolean> {
  try {
    const ext = vscode.extensions.getExtension(JUPYTER_ID)
    if (!ext) return false
    const api = (ext.isActive ? ext.exports : await ext.activate()) as JupyterLike | undefined
    const kernel = await api?.kernels?.getKernel?.(uri)
    return kernel !== undefined
  } catch {
    return false
  }
}
```

2. restartNotebookKernel 函数内，`return` 前追加验证：
```ts
// restart 后轻量级验证：只检查 kernel 是否仍可访问，不执行探测代码。
// jupyter.restartkernel 内部 .catch(noop) 吞错误，不验证则不知道是否成功。
// 用 isKernelAccessible 而非 getActiveRuntime，避免 executeCode 在重启过渡期的 30s 延迟。
const restartVerified = await isKernelAccessible(notebook.uri)
```

### 改进 6: readJson 错误处理增强（P2）

**文件**: `sdks/vscode/src/bridge.ts`

**问题**: `JSON.parse(body)` 失败抛原始错误，agent 看到 "JSON Parse error: Unrecognized token" 无上下文。

**方案**: 捕获失败，返回包含 body 长度和连接中断提示的友好错误。

**bridge.ts 改动**（line 217-221）:
```ts
try {
  resolve(body ? JSON.parse(body) : {})
} catch (error) {
  reject(new Error(
    `Failed to parse ${body.length} byte request body as JSON. ` +
    `The connection may have been interrupted. ` +
    `Original error: ${error instanceof Error ? error.message : String(error)}`
  ))
}
```

### 改进 7: 全工具错误路径增加 agent 恢复指引（P0）

**文件**: `sdks/vscode/src/notebook/run.ts`, `sdks/vscode/src/notebook/resolve.ts`, `sdks/vscode/src/notebook/env.ts`

**问题**: 多个工具的错误路径返回原始错误消息，agent 不知道下一步该做什么。数据库取证显示 agent 在错误后经常盲目重试而非采取正确的恢复操作。

**方案**: 为所有错误路径补充明确的 agent 恢复指引——告诉 agent 应该调用哪个工具的哪个操作来恢复。

**具体改动**:

1. **run.ts — `notebook.cell.execute` 不可用**（line 49-50）:
```ts
// 旧：throw new Error("VS Code command notebook.cell.execute is not available")
// 新：补充恢复指引
throw new Error(
  "VS Code command notebook.cell.execute is not available. " +
  "Ensure the Jupyter extension (ms-toolsai.jupyter) is installed and activated, " +
  "then call vscode_notebook_env with operation=configure to select a kernel."
)
```

2. **run.ts — 超时消息**（line 101）:
```ts
// 旧：result.exec = "timed out (may still be running, waiting for kernel selection, or failed to start)"
// 新：引导 agent 使用 env stop 中断，env info 检查状态
result.exec = "timed out — the cell may still be running. Use vscode_notebook_env operation=stop to interrupt the kernel, or operation=info to check kernel status."
```

3. **resolve.ts — `resolveNotebook` 文件未找到**（line 19）:
```ts
// resolveNotebook 在文件不存在时 openNotebookDocument 会失败。
// 补充 create 引导，让 agent 知道可以用 env create 创建新 notebook
// 而非用 write 写入原始 JSON。
// 注意：此错误被所有工具共用，消息不能只提某个工具的操作。
throw new Error(
  `Notebook not found: ${filePath}. ` +
  `If this is a new notebook, use vscode_notebook_env with operation=create to create it. ` +
  `Otherwise, check the exact path from vscode_notebook_summary.`
)
```

4. **env.ts — stop 操作无 kernel 运行时的指引**（stopNotebookKernel 内）:
```ts
// interrupt 命令调用后，如果返回结果表示没有 kernel 在运行，
// 补充指引让 agent 知道无需 stop
"Interrupt requested. If no cell was running, this operation is harmless. " +
"Use vscode_notebook_env operation=info to verify kernel status."
```

5. **env.ts — create 操作失败时的指引**（createNotebook catch 块内）:
```ts
// 创建失败时补充指引，帮助 agent 诊断原因
`Notebook creation failed: ${message}. ` +
`Check that the parent directory exists and is writable.`
```

**不改变的行为**:
- 已有恢复指引的错误路径不变（如 oldCode not found、cell not found after type-change）
- 错误的 HTTP 状态码不变（resolveNotebook 失败仍是 bridge 500，因为 throw 在 routeRequest 内）
- 错误的 `ran` / `data` 结构不变

| 操作 | 文件 | 改动行数 |
|---|---|---|
| 修改 | `sdks/vscode/src/bridge.ts` | +8 行（withFileLock 旁路 + readJson 错误） |
| 修改 | `sdks/vscode/src/notebook/env.ts` | +90 行（stop + create + isKernelAccessible + restart 验证 + INTERRUPT_CMD + 错误指引） |
| 修改 | `sdks/vscode/src/notebook/run.ts` | +25 行（kernel 预检 + 超时消息 + execute 不可用指引） |
| 修改 | `sdks/vscode/src/notebook/resolve.ts` | +3 行（文件未找到 create 引导） |
| 修改 | `sdks/vscode/src/notebook/commands.ts` | +20 行（stop/create quick-pick） |
| 修改 | `packages/opencode/src/plugin/vscode-bridge.ts` | +4 行（envArgs enum 更新） |
| 修改 | `packages/opencode/src/plugin/vscode-bridge-descriptions.ts` | +8 行（stop/create 说明） |
| 修改 | `packages/opencode/test/plugin/vscode-notebook-tool-summary.test.ts` | +110 行（新测试） |
| 修改 | `README.md` | +2 行（env 工具表更新） |

**总计**: 9 文件修改，0 新增，净增 ~270 行。无生成文件/迁移/配置项。

---

## 4. 正常/错误/并发/退出/清理/安全路径

### 改进 1: withFileLock 旁路

| 路径 | 处理 |
|---|---|
| 正常 | summary/source/output 直接执行，不经过 withFileLock |
| 并发 | 只读操作并发安全（VS Code document 读取线程安全） |
| 回归 | run/edit/env 仍被 withFileLock 保护，行为不变 |

### 改进 2: env stop

| 路径 | 处理 |
|---|---|
| 正常 | Jupyter 扩展活跃 + interrupt 命令注册 → 调用 → "stopped" |
| 无 Jupyter | 返回 "failed: Jupyter extension not installed" |
| 命令未注册 | 返回 "failed: interrupt command not registered" |
| 命令异常 | 返回 "failed: <error message>" |
| 无 kernel 运行 | interrupt 仍执行（无害），返回 "requested" |
| 并发 | withFileLock 保护（env 操作仍序列化） |
| 权限 | 继承 vscode_notebook_env ask/deny（同 restart） |

### 改进 3: env create

| 路径 | 处理 |
|---|---|
| 正常 | 文件不存在(fs.stat ENOENT) → 创建最小 .ipynb → openNotebookDocument → "created" |
| 文件已存在(磁盘) | fs.stat 成功 → 返回 "already exists: use vscode_notebook_summary" |
| 文件已打开 | notebookDocuments 检查 + fs.stat 检查 → 返回 "already exists" |
| 目录不存在 | writeFile 抛错 → try/catch → 结构化 "failed: <error>" |
| 权限不足 | writeFile 抛错 → try/catch → 结构化 "failed: <error>" |
| openNotebookDocument 失败 | try/catch → 结构化 "failed: <error>"（非 bridge 500） |
| 并发 | withFileLock 保护 |
| 权限 | 继承 vscode_notebook_env ask/deny + 通用 edit 门禁（创建文件是写入操作） |

### 改进 4: run kernel 预检

| 路径 | 处理 |
|---|---|
| 正常 | kernel 活跃 → 继续执行 |
| 无 kernel + 无 kernelspec | 返回 "no-active-kernel" + configure 引导 |
| 无 kernel + 有 kernelspec | 继续执行（notebook.cell.execute 启动 kernel） |
| Jupyter 未安装 | 跳过预检（不阻塞），继续执行 |
| getKernel 异常 | 跳过预检（try/catch），继续执行 |

### 改进 5: restart 验证

| 路径 | 处理 |
|---|---|
| 正常 | restart → isKernelAccessible 确认 kernel 可访问 → "verified" |
| 验证失败 | 不影响 "requested" 结果，附加 "verification failed" |
| 超时 | isKernelAccessible 只调 getKernel（快速返回），不调 executeCode，无 30s 延迟 |

### 改进 6: readJson 错误

| 路径 | 处理 |
|---|---|
| 正常 | JSON.parse 成功 → 不变 |
| 空 body | 返回 {} → 不变 |
| 解析失败 | 返回友好错误（body 长度 + 连接中断提示） |
| request error | request.on("error") → 不变 |

### 改进 7: 全工具错误恢复指引

| 错误场景 | 旧消息 | 新增指引 |
|---|---|---|
| run: notebook.cell.execute 不可用 | "is not available" | "Ensure Jupyter extension installed, then call env configure" |
| run: 超时 | "may still be running..." | "Use env stop to interrupt, or env info to check status" |
| resolveNotebook: 文件未找到 | 原始 VS Code 错误 | "Use env create to create a new notebook, or check path from summary" |
| env stop: 无 kernel 运行 | — | "harmless, use env info to verify" |
| env create: 创建失败 | — | "Check parent directory exists and is writable" |

---

## 5. 行为级测试计划

### 先写的测试（TDD 红灯阶段）

```
test 1: "summary is not blocked by withFileLock during concurrent run"
  - 启动一个阻塞的 run 请求
  - 同时发起 summary 请求
  - 断言 summary 在 run 完成前返回

test 2: "env stop calls jupyter.interruptkernel command"
  - 安装 Jupyter 扩展 mock + interrupt 命令注册
  - 调用 notebookEnv({ filePath, operation: "stop" })
  - 断言 executedCommands 包含 "jupyter.interruptkernel"
  - 断言 data.requested === true

test 3: "env stop returns failed when interrupt command not registered"
  - 安装 Jupyter 扩展但不注册 interrupt 命令
  - 调用 notebookEnv({ filePath, operation: "stop" })
  - 断言 data.status === "failed"

test 4: "env create creates a new notebook file and opens it"
  - 调用 notebookEnv({ filePath: "/tmp/new.ipynb", operation: "create" })
  - 断言文件被创建
  - 断言 data.created === true
  - 断言 data.cellCount === 0

test 5: "env create returns already-exists for existing notebook"
  - 先创建 notebook，再次调用 create
  - 断言 data.created === false
  - 断言 summary 包含 "already exists"

test 6: "run returns no-active-kernel when no kernel and no kernelspec metadata"
  - 不安装 Jupyter 扩展（或 getKernel 返回 undefined）
  - notebook metadata 无 kernelspec/language_info
  - 调用 runNotebook({ filePath, cellId })
  - 断言 data.noActiveKernel === true
  - 断言 summary 包含 "configure"

test 6b: "run proceeds when kernel not started but kernelspec metadata exists"
  - getKernel 返回 undefined（kernel 已选定但未启动）
  - notebook metadata 有 kernelspec
  - 调用 runNotebook({ filePath, cellId })
  - 断言 run 正常执行（不返回 noActiveKernel）

test 7: "run timeout message guides agent to env stop and env info"
  - 设置极短 timeoutMs
  - 模拟 cell 执行不完成
  - 断言 summary 包含 "env stop" 和 "env info"
  - 断言 summary 包含 "timed out"

test 8: "run execute-command-unavailable error includes configure guidance"
  - notebook.cell.execute 不在命令列表中
  - 调用 runNotebook
  - 断言错误消息包含 "Jupyter extension" 和 "configure"

test 9: "restart verifies kernel status after restart"
  - 安装 Jupyter 扩展 + restart 命令
  - 调用 notebookEnv({ filePath, operation: "restart" })
  - 断言 data.requested === true
  - 断言 data.verified 存在

test 10: "readJson returns friendly error for malformed body"
  - 发送 malformed JSON 到 bridge
  - 断言错误消息包含 "Failed to parse" 和 "byte"

test 11: "resolveNotebook error guides to env create"
  - 文件不存在
  - 调用 notebookSummary
  - 断言错误消息包含 "create"
```

### 当前实现下会暴露的缺口

- test 1 失败：summary 被 withFileLock 阻塞
- test 2-3 失败：stop 操作不存在
- test 4-5 失败：create 操作不存在
- test 6 失败：无 kernel 预检
- test 7 失败：超时消息无 env stop/info 引导
- test 8 失败：execute 不可用错误无 configure 引导
- test 9 失败：不验证 restart
- test 10 失败：readJson 返回原始错误
- test 11 失败：resolveNotebook 错误无 create 引导

### 实现后验证

所有 11 个测试通过 + 既有 56 个测试无回归。

---

## 6. 验证命令

```bash
cd packages/opencode
bun test test/plugin/vscode-notebook-tool-summary.test.ts
bun test test/plugin/vscode-bridge.test.ts
bun test test/ide/vscode-bridge.test.ts
bun test test/agent/agent.test.ts
bun typecheck
```

---

## 7. 预估 git 文件数/增删行数

- 修改文件：9 个
- 新增文件：0 个
- 删除文件：0 个
- 净增行数：~270 行
- 净删行数：~5 行（withFileLock 重构）
- 涉及生成文件/迁移/文档：README.md 更新（非生成）

---

## 8. 真实风险与开放问题

### 已确认无风险

1. **withFileLock 旁路**：只读操作（summary/source/output）只读取 VS Code document 状态，不修改 notebook/kernel。VS Code document 读取线程安全。
2. **stop 与 restart 区分**：stop 调用 `jupyter.interruptkernel`（中断当前 cell，保持状态），restart 调用 `jupyter.restartkernel`（重启 kernel，清除状态）。两者命令不同，行为不同。
3. **create 权限**：create 是 env 操作，继承 `vscode_notebook_env` ask/deny。但 create 也创建文件，应额外检查通用 `edit` 门禁（同 save 操作）。
4. **run kernel 预检不阻塞**：只调 `getKernel`（快速返回），不调 `executeCode`（可能阻塞）。
5. **tryInterruptKernel 已移除**：用户明确不要求 run 超时后自动 interrupt。超时消息改为引导 agent 调用 `env stop`。

### 低风险

1. **`jupyter.interruptkernel` 命令名**：基于 VS Code Jupyter 扩展惯例命名（与 `jupyter.restartkernel` 一致）。如果命令名不同，stop 操作会返回 "failed: interrupt command not registered"，agent 可据此判断。
2. **create 最小 .ipynb 格式**：`{ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }` 是标准 nbformat 4.5。VS Code Jupyter 能正确打开。
3. **restart 验证可能假阳性**：`isKernelAccessible` 在 restart 后可能立即返回 true（旧 kernel 尚未完全销毁）。但这是轻量级验证（只检查 kernel 可访问性，不检查状态变化），作为 best-effort 附加信息可接受。

### 无需用户决策的开放问题

1. **create 是否需要 `kernelName` 参数**：当前方案创建空白 metadata。如果需要指定 kernelspec（如 `python3`），可后续添加可选参数。不影响当前方案。
2. **env create 的通用 edit 门禁**：create 创建文件，与 save 类似应服从 `edit` 门禁。在 CLI 侧 `vscode_notebook_env` handler 中，`if (args.operation === "save" || args.operation === "create") await ask(context, "edit", args)`。

---

## 9. 推荐方案摘要

7 项改进，9 个文件，~270 行净增。核心目标：让 agent 能自主管理 notebook 生命周期（创建→配置→执行→中断→重启→保存），且任何错误都能获得明确的恢复指引。

| 改进 | 核心价值 |
|---|---|
| withFileLock 旁路 | 50 分钟 run 期间 agent 仍可检查 notebook 状态 |
| env stop | agent 可中断超时 cell，不必重启整个 kernel |
| env create | agent 创建结构化 notebook，不再写原始 JSON |
| run kernel 预检 | 无 kernel 且无 kernelspec 时引导 configure |
| restart 验证 | 确认 restart 实际生效 |
| readJson 错误 | 6 个 JSON 解析错误获得可诊断的错误消息 |
| 全工具错误指引 | 任何错误都告诉 agent 下一步该调用什么工具/操作 |
