export * as NotebookTools from "./notebook"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { VscodeBridge } from "../ide/vscode-bridge"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { VscodeNotebookDescriptions } from "./notebook-descriptions"

const filePath = Schema.String.annotate({
  description: "Absolute notebook path or file URI. Required; the bridge never infers a notebook from VS Code focus or open documents.",
})
const cellId = Schema.String.annotate({
  description: "Stable notebook cell ID from vscode_notebook_summary, formatted like #VSC-xxxxxxxx. Prefer this over display indexes.",
})

export const SummaryInput = Schema.Struct({ filePath })
export const SourceInput = Schema.Struct({
  filePath,
  cellId: cellId.pipe(Schema.optional),
  // 不给可选分页填值，单格起点与默认400行仍由原生source owner解释。
  offset: PositiveInt.annotate({ description: "1-based global virtual source line offset. With cellId, omit this to start at that cell's first global line." }).pipe(Schema.optional),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(1000)).annotate({ description: "Maximum rendered source lines to return, capped at 1000." }).pipe(Schema.optional),
})
export const RunInput = Schema.Struct({
  filePath,
  // 端点解析和同格别名校验仍归原生owner，CLI声明约束而不复制字符串守卫。
  type: Schema.Literals(["cell", "range"]).annotate({ description: "Optional run kind. endCellId selects a range when type is omitted or range; explicit cell requires both endpoints to resolve to the same cell." }).pipe(Schema.optional),
  // 只补参数广告；首末格解析与范围验证继续共用原生run入口。
  cellId: cellId.annotate({ description: "Stable start cell ID from vscode_notebook_summary, formatted like #VSC-xxxxxxxx. Also supports TOP and BOTTOM for the first/last cell." }),
  endCellId: cellId.annotate({ description: "Stable ending cell ID, formatted like #VSC-xxxxxxxx. When provided, the bridge runs from cellId through this cell, inclusive." }).pipe(Schema.optional),
  timeoutMs: PositiveInt.check(Schema.isLessThanOrEqualTo(3_000_000)).annotate({ description: "Per-cell execution timeout in milliseconds. Defaults to 300000, maximum 3000000." }).pipe(Schema.optional),
})
export const OutputInput = Schema.Struct({ filePath, cellId: cellId.pipe(Schema.optional) })
export const EditInput = Schema.Struct({
  filePath,
  cellId: cellId.annotate({ description: "Target cell ID. Use #VSC-xxxxxxxx from vscode_notebook_summary. For editType=insert, use TOP, BOTTOM, or a #VSC cell ID to insert after that cell." }),
  editType: Schema.Literals(["insert", "edit", "delete"]).annotate({ description: "Notebook edit kind: insert a new cell, edit an existing cell, or delete the target cell." }),
  // 缺省源码与显式空串不同；语言变更不能被CLI悄悄转换成清空单元格。
  oldCode: Schema.Union([Schema.String, Schema.Array(Schema.String)]).annotate({ description: "Existing source fragment to replace inside the target cell. It must identify one unique match; include enough surrounding lines from vscode_notebook_source." }).pipe(Schema.optional),
  newCode: Schema.Union([Schema.String, Schema.Array(Schema.String)]).annotate({ description: "New source for insert or edit. Required for insert, full-cell replacement, and oldCode replacement. Do not wrap in Markdown fences unless the fences are literal content." }).pipe(Schema.optional),
  language: Schema.String.annotate({ description: "Cell language. Use 'markdown' for Markdown cells; use 'python' or another language for code cells. On edit, language alone changes cell kind/language while preserving source." }).pipe(Schema.optional),
})
// 四操作与原生唯一env入口一致，不能在CLI缺省成info而丢弃模型的操作意图。
export const EnvInput = Schema.Struct({
  filePath,
  operation: Schema.Literals(["info", "configure", "restart", "save"]).annotate({ description: "Which notebook environment operation to perform." }),
  reason: Schema.String.annotate({ description: "Brief description of why this operation is being performed, shown to the user." }).pipe(Schema.optional),
})

// 原生data中的格、运行时、MIME与artifact保留未知嵌套字段，不让较窄投影丢掉模型结果。
export const Output = Schema.Struct({
  ran: Schema.Boolean,
  summary: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
  note: Schema.String.pipe(Schema.optional),
})

const layer = Layer.effectDiscard(Effect.gen(function* () {
  const tools = yield* Tools.Service
  const permission = yield* PermissionV2.Service
  const location = yield* Location.Service
  // 只转发同一客户端；不加载SDK模块、创建宿主或自行解释执行结果。
  const call = (endpoint: string, args: Record<string, unknown> & { readonly filePath: string }, context: Tool.Context, timeoutMs: number) =>
    Effect.tryPromise({
      try: signal => VscodeBridge.callBridge({ cwd: location.directory, path: endpoint, body: args, filePath: args.filePath, signal, timeoutMs }),
      catch: error => new ToolFailure({ message: error instanceof Error ? error.message : "VS Code bridge request failed", error }),
    }).pipe(Effect.flatMap(value => Schema.decodeUnknownEffect(Output)(value).pipe(
      Effect.mapError(error => new ToolFailure({ message: `Invalid VS Code bridge response: ${error.message}`, error })),
    )))
  // 审批仍在RPC之前，来源只取canonical调用身份，不借用活动编辑器或旧会话身份。
  const ask = (action: string, args: { readonly filePath: string }, context: Tool.Context) => permission.assert({
    action, resources: [args.filePath], save: [args.filePath], metadata: { args },
    sessionID: context.sessionID, agent: context.agent,
    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
  }).pipe(Effect.mapError(error => new ToolFailure({ message: PermissionV2.autoDeniedMessage(error) ?? `Permission denied: ${action}`, error })))
  // 模型继续接收原生summary正文，完整响应同时经统一settlement保存在structured。
  const common = { output: Output, toModelOutput: ({ output }: { output: typeof Output.Encoded }) => [{ type: "text" as const, text: output.summary }] }
  yield* tools.register({
    vscode_notebook_summary: Tool.make({ ...common, description: VscodeNotebookDescriptions.summary, input: SummaryInput,
      execute: (args, context) => call("/notebook/summary", args, context, 10_000) }),
    vscode_notebook_source: Tool.make({ ...common, description: VscodeNotebookDescriptions.source, input: SourceInput,
      execute: (args, context) => call("/notebook/source", args, context, 10_000) }),
    vscode_notebook_run: Tool.make({ ...common, description: VscodeNotebookDescriptions.run, input: RunInput,
      execute: (args, context) => ask("vscode_notebook_run", args, context).pipe(
        // 只补source规定的run默认，HTTP窗口保留每格期限外的五秒传输余量。
        Effect.andThen(call("/notebook/run", { ...args, timeoutMs: args.timeoutMs ?? 300_000 }, context, (args.timeoutMs ?? 300_000) + 5_000)),
      ) }),
    vscode_notebook_output: Tool.make({ ...common, description: VscodeNotebookDescriptions.output, input: OutputInput,
      execute: (args, context) => call("/notebook/output", args, context, 30_000) }),
    vscode_notebook_edit: Tool.withPermission(Tool.make({ ...common, description: VscodeNotebookDescriptions.edit, input: EditInput,
      // 专属权限先表达Notebook策略，再保留通用edit；两层拒绝均在发现/传输之前。
      execute: (args, context) => ask("vscode_notebook_edit", args, context).pipe(
        Effect.andThen(ask("edit", args, context)),
        Effect.andThen(call("/notebook/edit", args, context, 30_000)),
      ) }), "edit"),
    vscode_notebook_env: Tool.make({ ...common, description: VscodeNotebookDescriptions.env, input: EnvInput,
      // info也遵循同一工具级策略，不增加会绕开配置的operation级权限面。
      execute: (args, context) => ask("vscode_notebook_env", args, context).pipe(Effect.andThen(call("/notebook/env", args, context, 120_000))) }),
  }).pipe(Effect.orDie)
}))

export const node = makeLocationNode({
  name: "tool/notebook",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Location.node],
})
