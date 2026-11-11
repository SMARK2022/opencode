import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"
import type { CodeModeHost } from "./code-mode"
// 两代使用同一可见文本规则；领域数据与原始日志不经此投影清理。
import { sanitizeVisibleText } from "@opencode-ai/core/util/terminal-text"

interface Metadata {
  [key: string]: any
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

/**
 * Raised when the LLM calls a tool with arguments that fail the parameter
 * schema. This is the canonical "rewrite the input" tool error: the typed
 * error class makes it matchable upstream, and its `message` getter produces
 * the model-facing prose that the AI SDK feeds back as the tool result.
 */
export class InvalidArgumentsError extends Schema.TaggedErrorClass<InvalidArgumentsError>()(
  "ToolInvalidArgumentsError",
  {
    tool: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`
  }
}

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  // 两个字段仅由 SessionTools 注入：父持有 Host，子持有真实持久化归属。
  codeMode?: CodeModeHost
  executeParent?: string
  extra?: { [key: string]: unknown }
  messages: SessionV1.WithParts[]
  metadata(input: { title?: string; metadata?: M; delivery?: "durable" | "ephemeral" }): Effect.Effect<void>
  ask(input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
  // 程序值与模型文本使用不同投影；媒体沿宿主附件通道交付。
  // 只有协议 owner 可标记可解析原文；宿主展示正文不因此改变，也不向模型暴露第二份业务值。
  program?: {
    value: unknown
    rawText?: string
    attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
  }
  // 指令由宿主强制交付，脚本的 return 只决定普通聚合数据。
  context?: { kind: "instruction" | "skill"; key: string; text: string }[]
}

export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  description: string
  parameters: Parameters
  // 原 decoder 的来源独立于插件可改的展示 schema；不向启动路径引入解释器依赖。
  readonly runtimeParameters?: Parameters
  jsonSchema?: JSONSchema7
  // 程序值的同一声明服务目录和解码；输入校验仍由 parameters 独立拥有。
  output?: Schema.Decoder<unknown> | JSONSchema7
  // #557：只控制本地 Snapshot/Revert 归因，不能进入 Provider Tool schema；缺失等价于 none。
  worktree?: "none" | "declared" | "ambient"
  /** #514：在 Schema.decode 之前折叠兼容入参（如 edit 的 legacy oldString → edits[]）。 */
  prepareArguments?(args: unknown): unknown
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: unknown): string
}
export type DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> = Omit<Def<Parameters, M>, "id">

export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

export type InferParameters<T> =
  T extends Info<infer P, any>
    ? Schema.Schema.Type<P>
    : T extends Effect.Effect<Info<infer P, any>, any, any>
      ? Schema.Schema.Type<P>
      : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

// #155：metadata 顶层 string 字段逐项清理，未变化的字段保留原引用
function sanitizeMetadata<M extends Metadata>(metadata: M | undefined) {
  if (!metadata) return metadata
  // 仅遍历顶层：嵌套结构由各 tool 自行保证无终端序列，避免递归清理的误伤
  let changed = false
  const next: Record<string, unknown> = { ...metadata }
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== "string") continue
    const safe = sanitizeVisibleText(value)
    if (safe !== value) {
      changed = true
      next[key] = safe
    }
  }
  return changed ? (next as M) : metadata
}

// #155：工具可见输出统一清理入口；streaming metadata 与最终结果共用
function sanitizeResult<M extends Metadata>(result: ExecuteResult<M>) {
  const output = sanitizeVisibleText(result.output)
  const metadata = sanitizeMetadata(result.metadata) ?? result.metadata
  if (output === result.output && metadata === result.metadata) return result
  return { ...result, output, metadata }
}

function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      // 在 init 时捕获实际合同，后续展示换掉 parameters 不影响真实解析来源。
      // 每次 init 只编译一次解码器，避免每次工具调用重新创建同一个解析闭包。
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        // #155：streaming metadata 先消毒再转发，避免终端转义序列先落 UI
        const safeCtx: typeof ctx = {
          ...ctx,
          metadata: (input: { title?: string; metadata?: Metadata }) =>
            ctx.metadata({
              ...input,
              metadata: sanitizeMetadata(input.metadata) ?? input.metadata,
            }),
        }
        // safeCtx 只替换 metadata 回调；ask/abort 等其余 ctx 能力原样透传
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          // #514：prepareArguments 必须先于 Schema.decode：否则无法在 wire 上只暴露 edits[]
          // 的同时兼容 legacy 顶层 oldString/newString。该钩子只做入参折叠，不改变成功语义。
          const prepared = toolInfo.prepareArguments ? toolInfo.prepareArguments(args) : args
          const decoded = yield* decode(prepared).pipe(
            Effect.mapError(
              (error) =>
                new InvalidArgumentsError({
                  tool: id,
                  detail: toolInfo.formatValidationError ? toolInfo.formatValidationError(error) : String(error),
                }),
            ),
          )
          // #155：执行后立即 sanitize（truncate 检查之前），保证 output/metadata 全链干净
          const result = sanitizeResult(yield* execute(decoded as Schema.Schema.Type<Parameters>, safeCtx))
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))
      }
      // initializer 即使提供同名字段也不能覆盖真实 parser 的来源。
      return { ...toolInfo, runtimeParameters: toolInfo.parameters }
    })
}

export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata>(
  info: Info<P, M>,
): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}

export * as Tool from "./tool"
