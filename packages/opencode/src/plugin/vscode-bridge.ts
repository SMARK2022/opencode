// #178：桥接描述与工具默认 16KiB 对齐
// Plugin 入口：注册 notebook bridge 工具并转发到 ide/vscode-bridge 客户端
import { Effect } from "effect"
import { tool, type ToolContext, type PluginInput, type Hooks } from "@opencode-ai/plugin"
import { NotebookView } from "@opencode-ai/core/tool/notebook-view"
import { z } from "zod"
import * as VscodeBridge from "@/ide/vscode-bridge"
import { VscodeNotebookDescriptions } from "./vscode-bridge-descriptions"

// Notebook展示契约仍为内部metadata，两代共用纯投影而不复制执行器或渲染器。
const NOTEBOOK_METADATA_KEY = "vscodeNotebook"

// 既有输出不证明本次运行成功；状态与saved/unknown来源分别保留。
const execution = z.object({ status: z.enum(["succeeded", "failed", "unknown"]), provenance: z.enum(["saved", "unknown"]) })
// bytes描述原artifact，内联content可以缺席，不能以预览长度替代真实字节数。
const artifact = z.object({ path: z.string(), mime: z.string(), bytes: z.number(), content: z.string().optional() })
const notebookOutputs = {
  // range使用全局一基源码行号；cell数组位置只表顺序，重排后的身份仍取cellID。
  summary: z.object({ path: z.string(), dirty: z.boolean(), cells: z.array(z.object({
    cellID: z.string(), type: z.enum(["code", "markdown"]), language: z.string(),
    range: z.object({ start: z.number(), end: z.number() }), execution, outputMimes: z.array(z.string()),
  })) }),
  // sourcePath是另一份导出资源，不能覆盖用于后续编辑的notebook路径。
  source: z.object({ path: z.string(), cells: z.array(z.object({ cellID: z.string(), offset: z.number(), content: z.string() })),
    totalLines: z.number(), truncated: z.boolean(), next: z.number().optional(), sourcePath: z.string().optional(),
  }),
  // 失败插入没有新句柄；null不能被TOP/BOTTOM或原锚点伪装成插入结果。
  edit: z.object({ path: z.string(), operation: z.enum(["add", "update", "delete"]), applied: z.boolean(),
    cellID: z.string().nullable(), dirty: z.boolean(), content: z.string().optional(),
  }),
  // completed仅描述本次等待边界，不能代替每格原生execution.status。
  run: z.object({ path: z.string(), completed: z.boolean(), cells: z.array(z.object({
    cellID: z.string(), skipped: z.boolean(), timedOut: z.boolean(), execution, outputs: z.array(z.array(artifact)),
  })) }),
  output: z.object({ path: z.string(), cellID: z.string(), execution, outputs: z.array(z.array(artifact)) }),
  // 活动内核探测与磁盘元数据各自可空，不能用kernelspec补成运行中的内核。
  env: z.union([
    z.object({ operation: z.literal("info"), path: z.string(), runtime: z.object({ language: z.string(), kernelStatus: z.string() }).nullable(),
      savedMetadata: z.object({ kernelDisplayName: z.string().nullable(), kernelName: z.string().nullable(), language: z.string().nullable(), languageVersion: z.string().nullable() }).nullable(),
    }),
    z.object({ operation: z.literal("configure"), path: z.string(), status: z.enum(["configured", "selected", "needs-selection", "selection-requested", "failed"]), error: z.string().optional() }),
    z.object({ operation: z.enum(["restart", "stop"]), path: z.string(), requested: z.boolean(), verified: z.literal(false), error: z.string().optional() }),
    z.object({ operation: z.literal("save"), path: z.string(), saved: z.boolean(), dirty: z.boolean(), error: z.string().optional() }),
    z.object({ operation: z.literal("create"), path: z.string(), created: z.boolean(), alreadyExists: z.boolean(), error: z.string().optional() }),
  ]),
}

const bridgeRecord = z.record(z.string(), z.unknown())

// 原serializer保留output/item索引；恢复输出层级时保留空组和远程URI身份。
function notebookArtifacts(data: Record<string, unknown>) {
  const count = z.number().parse(data.outputCount)
  const items = z.array(z.object({ output: z.number(), item: z.number(), mime: z.string(), bytes: z.number(),
    artifactPath: z.string(), artifactURI: z.string(), text: z.string().optional(),
  })).parse(data.artifacts)
  const groups = Map.groupBy(items, (item) => item.output)
  // text是原serializer允许内联的正文；preview经过裁剪，不可充当content。
  return Array.from({ length: count }, (_, index) => (groups.get(index) ?? []).map((item) => ({
    // 非file URI携带远程scheme/authority，其fsPath不是本机可访问地址。
    path: item.artifactURI.startsWith("file:") ? item.artifactPath : item.artifactURI,
    mime: item.mime, bytes: item.bytes, ...(item.text !== undefined ? { content: item.text } : {}),
  })))
}

const requiredFilePath = {
  filePath: z
    .string()
    .describe("Absolute notebook path or file URI. Required; the bridge never infers a notebook from VS Code focus or open documents."),
}

const optionalCellId = {
  cellId: z
    .string()
    .optional()
    .describe("Stable notebook cell ID from vscode_notebook_summary, formatted like #VSC-xxxxxxxx. Prefer this over display indexes."),
}

const requiredEditCellId = {
  cellId: z
    .string()
    .describe(
      "Target cell ID. Use #VSC-xxxxxxxx from vscode_notebook_summary. For editType=insert, use TOP, BOTTOM, or a #VSC cell ID to insert after that cell.",
    ),
}

const sourceArgs = {
  ...requiredFilePath,
  ...optionalCellId,
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based global virtual source line offset. With cellId, omit this to start at that cell's first global line."),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum rendered source lines to return, capped at 1000. Output is also capped at 16 KB."),
}

const runArgs = {
  ...requiredFilePath,
  type: z
    .enum(["cell", "range"])
    .optional()
    .describe("Optional run kind. endCellId selects a range when type is omitted or range; explicit cell requires both endpoints to resolve to the same cell."),
  // #101：cellId 支持 TOP/BOTTOM 快捷定位首末 cell
  cellId: z.string().describe("Stable start cell ID from vscode_notebook_summary, formatted like #VSC-xxxxxxxx. Also supports TOP and BOTTOM for the first/last cell."),
  endCellId: z
    .string()
    .optional()
    .describe("Stable ending cell ID, formatted like #VSC-xxxxxxxx. When provided, the bridge runs from cellId through this cell, inclusive."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(3_000_000)
    .optional()
    .describe("Per-cell execution timeout in milliseconds. Defaults to 300000, maximum 3000000."),
}

const outputArgs = {
  ...requiredFilePath,
  ...optionalCellId,
}

const editArgs = {
  ...requiredFilePath,
  ...requiredEditCellId,
  editType: z
    .enum(["insert", "edit", "delete"])
    .describe("Notebook edit kind: insert a new cell, edit an existing cell, or delete the target cell."),
  oldCode: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Existing source fragment to replace inside the target cell. It must identify one unique match; include enough surrounding lines from vscode_notebook_source."),
  newCode: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("New source for insert or edit. Required for insert, full-cell replacement, and oldCode replacement. Do not wrap in Markdown fences unless the fences are literal content."),
  // 仅语言编辑必须真正省略源码，空字符串和空数组不能冒充缺省字段。
  language: z
    .string()
    .optional()
    .describe("Cell language. Use 'markdown' for Markdown cells; use 'python' or another language for code cells. On edit, language alone changes cell kind/language while preserving source; omit oldCode and newCode entirely for this mode."),
}

async function callRaw(
  endpoint: string,
  args: Record<string, unknown>,
  context: Pick<ToolContext, "directory" | "abort">,
  timeoutMs?: number,
) {
  // #224：返回原始 bridge value，notebookResult 从中派生 summary + compact metadata
  return await VscodeBridge.callBridge({
    cwd: context.directory,
    path: endpoint,
    body: args,
    filePath: typeof args.filePath === "string" ? args.filePath : undefined,
    signal: context.abort,
    timeoutMs,
  })
}

// #224：从 bridge 原始返回值派生 output summary + vscodeNotebook metadata；
// metadata 只包含 TUI 展示需要的 compact 字段，不复制完整源码/artifact 文本
function notebookResult(endpoint: string, args: Record<string, unknown>, value: unknown) {
  const view = NotebookView.build(endpoint, args, value)
  const data = z.object({ data: bridgeRecord }).parse(value).data
  // 投影只选择桥接捕获的事实，输入定位与结构化输出不从summary文案反推。
  const program = (() => {
    if (endpoint === "/notebook/summary") return { path: data.path, dirty: data.dirty,
      cells: z.array(bridgeRecord).parse(data.cells).map((cell) => ({ cellID: cell.id, type: cell.kind,
        language: cell.lang, range: cell.range, execution: cell.execution, outputMimes: cell.outputMimes,
      })),
    }
    // cells已经由同一分页器收取；源码中的数字前缀也可能是原文，不能二次剥离。
    if (endpoint === "/notebook/source") return { path: data.path, cells: data.cells, totalLines: data.totalLines, truncated: data.truncated,
      ...(data.next !== undefined ? { next: data.next } : {}), ...(data.sourceArtifact !== undefined ? { sourcePath: data.sourceArtifact } : {}),
    }
    // 未应用回执中的afterSource可能仍是提案；只有applied后才交付为实际正文。
    if (endpoint === "/notebook/edit") return { path: data.path, applied: data.applied, dirty: data.dirty,
      operation: data.editType === "insert" ? "add" : data.editType === "delete" ? "delete" : "update",
      cellID: data.editType === "insert" ? data.insertedCellId ?? null : data.editType === "delete" ? data.deletedCellId : data.updatedCellId,
      ...(data.applied === true && data.editType !== "delete" ? { content: data.afterSource } : {}),
    }
    if (endpoint === "/notebook/run") return { path: data.path, completed: data.completed,
      cells: z.array(bridgeRecord).parse(data.cells).map((cell) => ({ cellID: cell.id, skipped: cell.skipped,
        timedOut: cell.timedOut, execution: cell.execution, outputs: notebookArtifacts(cell),
      })),
    }
    if (endpoint === "/notebook/output") {
      const cell = bridgeRecord.parse(data.cell)
      return { path: data.path, cellID: cell.id, execution: cell.execution, outputs: notebookArtifacts(data) }
    }
    const base = { operation: data.operation, path: data.path,
      ...(typeof data.error === "string" ? { error: data.error } : {}),
    }
    if (data.operation === "info") return { ...base, runtime: data.runtime, savedMetadata: data.saved_metadata }
    if (data.operation === "configure") return { ...base, status: data.status }
    // requested只承认桥接的显式成功回执，命令拒绝或未发送均保持false。
    // Jupyter命令可能吞掉内部错误，成功返回也不证明内核已完成重启或中断。
    if (data.operation === "restart" || data.operation === "stop") return { ...base, requested: data.requested === true, verified: false }
    if (data.operation === "save") return { ...base, saved: data.saved, dirty: data.afterDirty,
      ...(typeof data.saveError === "string" ? { error: data.saveError } : {}),
    }
    return { ...base, created: data.created, alreadyExists: data.alreadyExists === true }
  })()
  return {
    output: VscodeBridge.summaryOnly(value),
    program: { value: program },
    metadata: {
      endpoint,
      ...(view && { [NOTEBOOK_METADATA_KEY]: view }),
    },
  }
}

// ask 适配：V2 的 ToolContext.ask 返回 Promise<void>，替代 V1 的 Effect.runPromise
// 用户交互：V2 的 ToolContext.ask 返回 Promise<void>，替代 V1 的 Effect.runPromise
async function ask(context: ToolContext, permission: string, args: Record<string, unknown>): Promise<void> {
  const pattern = typeof args.filePath === "string" ? args.filePath : "*"
  await context.ask({
    permission,
    patterns: [pattern],
    always: [pattern],
    metadata: { args },
  })
}

// VS Code 桥接插件：注册 6 个 notebook 工具到 opencode
// 将 bridge 工具挂到 plugin 索引，会话可直接 call
export async function VscodeBridgePlugin(input: PluginInput): Promise<Hooks> {
  // 返回 Hooks：init 初始化插件，tool 返回工具列表
  return {
  tool: {
    vscode_notebook_summary: tool({
      description: VscodeNotebookDescriptions.summary,
      output: notebookOutputs.summary,
      args: requiredFilePath,
      execute: async (args, context) => notebookResult("/notebook/summary", args, await callRaw("/notebook/summary", args, context, 10_000)),
    }),
    vscode_notebook_source: tool({
      description: VscodeNotebookDescriptions.source,
      output: notebookOutputs.source,
      args: sourceArgs,
      execute: async (args, context) => notebookResult("/notebook/source", args, await callRaw("/notebook/source", args, context, 10_000)),
    }),
    vscode_notebook_run: tool({
      description: VscodeNotebookDescriptions.run,
      output: notebookOutputs.run,
      args: runArgs,
      execute: async (args, context) => {
        await ask(context, "vscode_notebook_run", args)
        const timeoutMs = args.timeoutMs ?? 300_000
        const body = { ...args, timeoutMs }
        return notebookResult("/notebook/run", body, await callRaw("/notebook/run", body, context, timeoutMs + 5_000))
      },
    }),
    vscode_notebook_output: tool({
      description: VscodeNotebookDescriptions.output,
      output: notebookOutputs.output,
      args: outputArgs,
      execute: async (args, context) => notebookResult("/notebook/output", args, await callRaw("/notebook/output", args, context, 30_000)),
    }),
    vscode_notebook_edit: tool({
      description: VscodeNotebookDescriptions.edit,
      output: notebookOutputs.edit,
      args: editArgs,
      execute: async (args, context) => {
        // #223：notebook 编辑是独立工具能力，必须使用自己的权限 key；否则 plan
        // mode 对 vscode_notebook_edit 的 deny 不会覆盖到这里，只会落到通用
        // edit 规则，导致 notebook 写入权限和普通文件编辑权限混在一起。
        await ask(context, "vscode_notebook_edit", args)
        // #223：继续保留通用 edit 门禁：既有配置若用 permission.edit 禁止写入，
        // notebook cell 修改也不能绕过。顺序先专属后通用，确保更精确的
        // vscode_notebook_edit deny/ask 先表达，再由 edit 维持历史兼容边界。
        await ask(context, "edit", args)
        return notebookResult("/notebook/edit", args, await callRaw("/notebook/edit", args, context, 30_000))
      },
    }),
    vscode_notebook_env: tool({
      description: VscodeNotebookDescriptions.env,
      output: notebookOutputs.env,
      args: {
        ...requiredFilePath,
        // 操作仍为显式枚举，新增中断与创建不改变其它环境操作的权限入口。
        operation: z.enum(["info", "configure", "restart", "save", "stop", "create"]).describe("Which notebook environment operation to perform."),
        reason: z.string().optional().describe("Brief description of why this operation is being performed, shown to the user."),
      },
      execute: async (args, context) => {
        // 环境操作沿用工具级权限，审批拒绝时不进入桥接调用；保留操作元数据与选核超时。
        await ask(context, "vscode_notebook_env", args)
        // save 和 create 都会写磁盘文件，必须服从通用 edit 门禁
        if (args.operation === "save" || args.operation === "create") await ask(context, "edit", args)
        return notebookResult("/notebook/env", args, await callRaw("/notebook/env", args, context, 120_000))
      },
    }),
  },
}
}
