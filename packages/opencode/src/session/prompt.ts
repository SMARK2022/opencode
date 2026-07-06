import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { type Tool as AITool, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { SessionGoal } from "./goal"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, Effect, Exit, Latch, Layer, Option, Scope, Context, Schema, Types, Semaphore } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { eq } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionReminders } from "./reminders"
import { SessionTools } from "./tools"
import { LLMEvent } from "@opencode-ai/llm"
// #159：decide 窗口裁剪用 usable 上限（与 overflow 同一口径）
import { usable } from "./overflow"
// #194：改用 TokenEstimate 统一上传估算
import { TokenEstimate } from "@/token/estimate"
import { formatExecutionNotice } from "@/util/output-notice"

// #159：decide 最近轮目标占用区间（相对 usable）
// LATEST_MIN：最新一轮已≥60% 则不再向历史扩展
// CONTINUE_BELOW：最新一轮<50% 才继续扩
// TARGET：扩到≥70% 即停
// MAX：≥100% 视为溢出，回退 fallback
const DECIDE_LATEST_MIN = 0.6
const DECIDE_CONTINUE_BELOW = 0.5
const DECIDE_TARGET = 0.7
const DECIDE_MAX = 1

// 仅按 agent 名判定，不读 mode/config 别名
function isDecideAgent(agent: Agent.Info) {
  return agent.name === "decide"
}

// 过长 thinking 只保留首尾，避免 decide 上下文被推理占满
// 阈值 400：中段用省略号替换，保留语义锚点
function truncateThinking(text: string) {
  if (text.length <= 400) return text
  return `${text.slice(0, 200)}...${text.slice(-200)}`
}

// 把历史 tool part 压成文本，避免 decide 路径出现 tool-call/tool role
// 按 status 分支输出，保证 completed/error/pending/running 均可读
function formatDecideToolPart(part: SessionV1.ToolPart) {
  const body = (() => {
    switch (part.state.status) {
      case "completed":
        // 完成态：保留 output 供决断参考
        return ["output:", part.state.output]
      case "error":
        // 错误态：保留 error 字符串
        return ["error:", part.state.error]
      case "pending":
        // 挂起态：用 raw 输入串，避免半结构化 input
        return ["raw_input:", part.state.raw]
      case "running":
        // 运行中：仅标题/状态，无完整输出
        return ["status:", part.state.title ?? "running"]
    }
  })()
  return [
    `<tool-context tool="${part.tool}" status="${part.state.status}">`,
    `input: ${JSON.stringify(part.state.input)}`,
    ...body,
    "</tool-context>",
  ].join("\n")
}

// 消毒：reasoning 截断 + tool→synthetic text，供 decide 只读上下文
// 不改写 info，仅映射 parts；synthetic 标记避免 UI 当用户原文
function sanitizeDecideMessages(messages: SessionV1.WithParts[]) {
  return messages.map((msg) => ({
    info: msg.info,
    parts: msg.parts.map((part): SessionV1.Part => {
      // reasoning：截断后仍保留 type=reasoning
      if (part.type === "reasoning") return { ...part, text: truncateThinking(part.text) }
      // tool：降级为 text，阻断模型侧 tool role 重建
      if (part.type === "tool") {
        return {
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "text",
          text: formatDecideToolPart(part),
          synthetic: true,
        }
      }
      // 其余 part 原样透传
      return part
    }),
  }))
}

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatMcpResourceBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}
// [local-smark] 检查历史消息中是否使用了当前被 disabled 的工具，返回事前提醒文本。
// 场景：GPT 模型在历史中用了 apply_patch，切换到 Claude（apply_patch 被 deny）后，
// 新模型看到历史中的 apply_patch 调用可能也尝试使用，但工具不可用会浪费一轮。
// 此函数在 reminders 阶段调用，在模型生成下一轮回复之前注入提醒。
// 纯函数，无副作用，可直接单元测试。
export function disabledToolNotice(
  messages: SessionV1.WithParts[],
  agentPermission: PermissionV1.Ruleset,
  sessionPermission: PermissionV1.Ruleset,
): string | undefined {
  // 从历史消息中提取所有出现过的工具名
  const toolNames = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool") toolNames.add(part.tool)
    }
  }
  const mergedRuleset = Permission.merge(agentPermission, sessionPermission)
  // Permission.disabled 返回在这些工具中被 ruleset deny 的子集；
  // 因为 toolNames 本身来自历史消息，所以 disabled.size > 0 蕴含
  // "历史中确实使用了被 disable 的工具"，无需额外检查
  const disabled = Permission.disabled([...toolNames], mergedRuleset)
  if (disabled.size === 0) return undefined
  // [local-smark] 已知工具的替代建议映射；替代工具可能在当前 ruleset 下也被 deny
  // （如 edit: deny * 会同时禁用 edit/write/apply_patch），需单独检查替代工具的可用性
  const substituteMap: Record<string, string[]> = {
    apply_patch: ["edit", "write"],
  }
  // 检查所有可能的替代工具是否也被 disable
  const allSubstitutes = [...new Set(Object.values(substituteMap).flat())]
  const substituteDisabled = Permission.disabled(allSubstitutes, mergedRuleset)
  const notices = [...disabled].map((tool) => {
    const substitutes = substituteMap[tool]
    if (substitutes) {
      // 过滤掉同样被 disabled 的替代工具，避免建议不可用的工具
      const available = substitutes.filter((s) => !substituteDisabled.has(s))
      if (available.length > 0) {
        return `${tool} is not available in this session. Use ${available.join(" or ")} instead.`
      }
    }
    return `${tool} is not available in this session. Use an available tool instead.`
  })
  return `<system-reminder>${notices.join("\n")}</system-reminder>`
}


export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly compact: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto?: boolean
    overflow?: boolean
  }) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    // #364：goal 服务：用于 break 点检查 active goal 并注入续跑 prompt
    const goalSvc = yield* SessionGoal.Service
    // #173：同 session 并发 cancel 串行，避免双写终态竞态
    const cancelLocks = new Map<SessionID, Semaphore.Semaphore>()
    const database = yield* Database.Service
    const { db } = database
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input).pipe(Effect.catch(Effect.die)),
      } satisfies TaskPromptOps
    })

    // #216：复用取消owner递归收尾子会话，保留冻结ID、runner等待与原子结算順序。
    const cancel: Interface["cancel"] = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      // #173：每 session 一把信号量，合并并发 cancel
      let lock = cancelLocks.get(sessionID)
      if (!lock) {
        // #173：lazy 创建，空闲 session 不占信号量
        lock = Semaphore.makeUnsafe(1)
        cancelLocks.set(sessionID, lock)
      }
      // #173：排队后续 cancel，不丢弃第二次请求
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* Effect.logInfo("cancel", { "session.id": sessionID })
          // 冻结 ID 在同会话锁内完成，不能在 idle 发布后重新扫描新运行的消息。
          // #216：等待runner前固定已有子会话列表，父取消后再沿各自owner终态化。
          const children = yield* sessions.children(sessionID)
          const pending = (yield* sessions.messages({ sessionID }).pipe(Effect.catch(() => Effect.succeed([]))))
            .filter((msg) => msg.info.role === "assistant" && !msg.info.time.completed)
            .map((msg) => msg.info.id)
          yield* state.cancel(sessionID)
          yield* Effect.forEach(pending, (messageID) => abortPendingAssistant(sessionID, messageID).pipe(Effect.ignore), {
            discard: true,
          })
          yield* Effect.forEach(children, (child) => cancel(child.id), { discard: true })
        }),
      )
    })

    const abortPendingAssistant = Effect.fn("SessionPrompt.abortPendingAssistant")(function* (sessionID: SessionID, messageID: MessageID) {
      // 仅重读冻结 ID 的最新快照，processor/ownAssistant 的终态不得被取消前的旧对象覆盖。
      const match = yield* MessageV2.get({ sessionID, messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.option,
      )
      if (Option.isNone(match)) return

      const now = Date.now()
      const assistant = match.value.info
      // 真实 owner 若已完成收尾就保留其 error/finish 与账本提交，不做第二次终态写入。
      if (assistant.role !== "assistant" || assistant.time.completed) return
      assistant.time.completed = now
      assistant.error ??= new SessionV1.AbortedError({ message: "Aborted" }).toObject()
      // 用户取消不是 provider finish，准备窗口只保存 AbortedError/completed，不伪造模型结束原因。
      // 空体残留不占可见时间线，仍沿原子 publishAssistant 提交其账本终态。
      if (match.value.parts.length === 0) assistant.hidden = { time: now, reason: "repair-empty-dangling-assistant" }

      // 只关闭旧消息仍未终态的工具，已成功完成的结果不能因取消被改写成 error。
      yield* Effect.forEach(
        match.value.parts,
        (part) => {
          if (part.type !== "tool") return Effect.void
          if (part.state.status !== "pending" && part.state.status !== "running") return Effect.void
          // 重读 parts 保留运行时已提交的 input 与 metadata，不使用取消前的工具快照。
          // 退出发布沿用同一 durable part 事件，跳过可能阻塞的普通 listener，实时流仍收到终态。
          return events.publish(SessionV1.Event.PartUpdated, {
            sessionID,
            time: now,
            part: structuredClone({
              ...part,
              state: {
                status: "error",
                input: part.state.input,
                // #216：空闲修复与活动processor共用中止信封，reviewing必须变成aborted。
                error: SessionProcessor.TOOL_ABORTED_ERROR,
                metadata: SessionProcessor.interruptedToolMetadata(part.state.status === "running" ? part.state.metadata : undefined),
                // pending 尚无真实 start，使用取消时刻；running 的计时起点保持不变。
                time: {
                  start: part.state.status === "running" ? part.state.time.start : now,
                  end: now,
                },
              },
            } satisfies SessionV1.ToolPart),
          }, { finalizer: true }).pipe(Effect.asVoid, Effect.uninterruptible)
        },
        { discard: true },
      )
      // 工具先终态，再原子提交助手与 recordAssistant；准备窗口退出也不会留下 running 账本。
      yield* SessionProcessor.publishAssistant(assistant, events, true).pipe(Effect.uninterruptible)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      // #139：agent 校验在创建 running part 之前，避免未知 agent 留下粘滞 running 工具
      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }
      const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      // #139：running 后 before+execute 统一保护，setup 失败也终端化可见 tool part
      const result = yield* Effect.gen(function* () {
        yield* plugin.trigger(
          "tool.execute.before",
          { tool: TaskTool.id, sessionID, callID: part.id },
          { args: taskArgs },
        )
        return yield* taskTool.execute(taskArgs, {
          // handleSubtask 必须把父会话当前 agent 名传给 TaskTool，而不是
          // SubtaskPart.agent（子 agent 名）。task.ts 用 ctx.agent 解析
          // parentAgentName 来派生子会话的 permission ceiling：如果传子 agent
          // 名，parentAgent 会被解析为子 agent 自己的 permission，auto 父会话
          // 的 external_directory/bash/edit auto 规则不会出现在 ceilings 中。
          // lastUser.agent 与 Path A（resolveTools 的 input.agent.name）一致，
          // 都来自 createUserMessage 写入的 user message agent 字段。
          agent: lastUser.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies SessionV1.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                // 审计元数据也必须用父 agent 名，与 Path A 的
                // metadata.agent: input.agent.name 保持一致
                metadata: { ...req.metadata, agent: lastUser.agent },
        // #230：prompt 适配层统一写入 agent 标识——工具实现无需各自复制 ctx.agent
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
      })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            // #139：setup/execute 失败路径写入 error，供后续 terminalize
            return Effect.logError("subtask execution failed", {
              error,
              agent: task.agent,
              description: task.description,
            })
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies SessionV1.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies SessionV1.ToolPart)
      }

      // #139：终态提交后记录并吞掉 after 缺陷，中断仍原样传播。
      yield* plugin
        .trigger("tool.execute.after", { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs }, result)
        .pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
            return Effect.logError("tool.execute.after failed", { cause })
          }),
        )

      if (!task.command) return

      const summaryUserMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            // shell 用户消息已解析模型与 agent，不能再次用输入默认值覆盖实际保存的身份。
            const shellReqUsage = Option.getOrUndefined(yield* Effect.serviceOption(SessionRequestUsage.Service))
            if (shellReqUsage) {
              yield* shellReqUsage.begin({ sessionID: input.sessionID, requestID: userMsg.id, rootRequestID: userMsg.id, source: "shell", agent: userMsg.agent, providerID: userMsg.model.providerID, modelID: userMsg.model.modelID, timeCreated: userMsg.time.created })
            }
            const userPart: SessionV1.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: SessionV1.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                // #282：prompt.shell 不经过 ShellTool 的收尾格式化；这里必须直接写入
                // 同一种 notice，保证取消路径不会重新引入旧的 <metadata> 包裹。
                output += "\n\n" + formatExecutionNotice({ severity: "warning", reason: "user_abort" })
              }
              const completed = Date.now()
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                // 手工shell与工具取消共用底层升级机制，仍等待退出和输出收尾。
                forceKillAfter: "500 millis",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          // finish 已保存助手终态；shell 没有 step-finish，也必须区分中断、执行缺陷与成功。
          const shellCompleteUsage = Option.getOrUndefined(yield* Effect.serviceOption(SessionRequestUsage.Service))
          if (shellCompleteUsage) {
            yield* shellCompleteUsage.complete({ sessionID: input.sessionID, requestID: msg.parentID, status: aborted ? "aborted" : Exit.isFailure(exit) ? "error" : "completed", timeCompleted: Date.now() })
          }

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (
        current.agent !== info.agent ||
        current.model?.providerID !== info.model.providerID ||
        current.model?.id !== info.model.modelID ||
        (current.model?.variant === "default" ? undefined : current.model?.variant) !== info.model.variant
      ) {
        yield* sessions.setAgentModel({
          sessionID: input.sessionID,
          agent: info.agent,
          model: {
            id: info.model.modelID,
            providerID: info.model.providerID,
            variant: info.model.variant ?? "default",
          },
          time: info.time.created,
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && typeof c.blob === "string" && c.blob) {
                  const mime = "mimeType" in c && typeof c.mimeType === "string" ? c.mimeType : part.mime
                  const filename = "uri" in c && typeof c.uri === "string" ? c.uri : part.filename
                  const size = mcpResourceBase64Size(c.blob)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
                    })
                    continue
                  }
                  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                    })
                    continue
                  }
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: `data:${mime};base64,${c.blob}`,
                  })
                }
              }
            } else {
              const error = Cause.squash(exit.cause)
              yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              yield* Effect.logInfo("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      // begin 位于用户消息保存之后，读取插件处理及默认模型解析后的真实消息描述。
      const reqUsage = Option.getOrUndefined(yield* Effect.serviceOption(SessionRequestUsage.Service))
      if (reqUsage) {
        yield* reqUsage.begin({ sessionID: input.sessionID, requestID: message.info.id,
        // 压缩调用传入原始请求根身份，其余请求以已保存用户消息为根，保留因果链。
        rootRequestID: input.rootRequestID ?? message.info.id,
        source: input.source ?? "prompt", agent: message.info.agent, providerID: message.info.model.providerID, modelID: message.info.model.modelID, variant: message.info.model.variant, timeCreated: message.info.time.created })
      }
      yield* sessions.touch(input.sessionID)

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        // 子会话的 permission 由 TaskTool 通过 deriveSubagentSessionPermission
        // 派生（含父 agent 的 auto/ask/deny ceiling 和默认 task/todowrite deny）。
        // 这里的 tool override（如 task: false、todowrite: false）必须追加到
        // 已有 permission 之后（last-match-wins），而不是替换整个 ruleset。
        // 替换会擦除 TaskTool 派生的 auto ceiling，导致子会话的
        // external_directory/bash 等权限从 auto 降级到子 agent 自己的默认 ask。
        const merged = Permission.compact([...(session.permission ?? []), ...permissions])
        session.permission = merged
        yield* sessions.setPermission({ sessionID: session.id, permission: merged })
      }

      if (input.noReply === true) {
        // noReply 不启动 provider，零费用请求仍须有终态，不能永远等待不存在的助手。
        if (reqUsage) {
          yield* reqUsage.complete({ sessionID: input.sessionID, requestID: message.info.id, status: "completed" })
        }
        return message
      }
      return yield* loop({ sessionID: input.sessionID })
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    // #242：compact 走与普通 prompt 相同的 runner/cancel 边界，但直调生产者——
    // 持久化 compact 标记只会是已完成边界，不会成为后续 loop 从旧历史拾取的排队命令
    const compact: Interface["compact"] = Effect.fn("SessionPrompt.compact")(function* (input) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      // Runner.ensureRunning 会加入既有 prompt 而非排队新工作；compact 必须显式
      // 拒绝 busy 会话，调用方看到真实 busy 响应而非成功空操作
      yield* state.assertNotBusy(input.sessionID)
      yield* revert.cleanup(session)
      return yield* state.ensureRunning(
        input.sessionID,
        lastAssistant(input.sessionID),
        Effect.gen(function* () {
          yield* compaction.run({
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model,
            auto: input.auto ?? false,
            overflow: input.overflow,
          })
          return yield* lastAssistant(input.sessionID)
        }),
      )
    })

    // #159：从最近 user 起点向后试窗口；ratio 相对 usable，估量用 #194 TokenEstimate
    const selectDecideMessages = Effect.fn("SessionPrompt.selectDecideMessages")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
      systemText: string
    }) {
      const sanitized = sanitizeDecideMessages(input.messages)
      const limit = usable({ cfg: yield* config.get(), model: input.model })
      // limit<=0：无上下文预算时原样返回消毒后全量
      if (limit <= 0) return sanitized

      // 仅从非 compaction 的 user 消息作为窗口起点，自新到旧
      const starts = sanitized
        .map((msg, index) => ({ msg, index }))
        .filter((item) => item.msg.info.role === "user")
        .filter((item) => !item.msg.parts.some((part) => part.type === "compaction"))
        .map((item) => item.index)
        .toReversed()

      let fallback: SessionV1.WithParts[] | undefined
      for (const [position, start] of starts.entries()) {
        const candidate = sanitized.slice(start)
        const modelMessages = yield* MessageV2.toModelMessagesEffect(candidate, input.model)
        // #194：decide mode 用 estimateUploadInput——与 normal prompt 同一估算路径
        const decideEstimate = TokenEstimate.sanitizeModelMessages(modelMessages)
        const ratio =
          TokenEstimate.estimateUploadInput({
            text: [input.systemText, decideEstimate.text].join("\n"),
            attachments: decideEstimate.attachments,
            history: candidate,
            model: input.model,
          }).inputTokens / limit
        // 超满：退回上一个可容纳窗口
        if (ratio >= DECIDE_MAX) return fallback ?? candidate

        fallback = candidate
        // 最新一轮已够用：直接采用，避免无谓扩历史
        if (position === 0 && ratio >= DECIDE_LATEST_MIN) return candidate
        // 最新一轮过小：继续向历史扩展以补上下文
        if (position === 0 && ratio < DECIDE_CONTINUE_BELOW) continue
        // 达到目标占用：停扩，防止再吞旧轮
        if (ratio >= DECIDE_TARGET) return candidate
      }

      // 历史全扫后仍无命中阈值：用最大可容纳或全量消毒
      return fallback ?? sanitized
    })

    const runLoop: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.run")(
      function* (sessionID: SessionID) {
        let requestID: MessageID | undefined
        let existingAssistantID: MessageID | undefined
        // 只在真实 work fiber 结算；加入同一 runner 的调用方取消不能替它关闭请求。
        yield* Effect.addFinalizer((exit) => Effect.gen(function* () {
          const id = requestID
          if (Exit.isSuccess(exit) || id === undefined) return
          const usage = Option.getOrUndefined(yield* Effect.serviceOption(SessionRequestUsage.Service))
          if (!usage) return
          const request = yield* usage.get({ sessionID, requestID: id })
          if (!request || request.assistantCount !== 0 || request.status !== "running") return
          // 旧助手身份在准备前冻结；新助手与账本同事务创建，无需退出时扫描历史。
          if (existingAssistantID !== undefined) return
          const failure = Cause.squash(exit.cause)
          // complete 仅闭合冻结的请求；原 cause 继续退出，确认消费和根身份均不改。
          yield* usage.complete({ sessionID, requestID: id, status: Cause.hasInterrupts(exit.cause) ? "aborted" : "error",
            error: failure instanceof Error ? failure.message : String(failure), timeCompleted: Date.now() })
        }))
        const ctx = yield* InstanceState.context
        let structured: unknown
        let step = 0
        // #364：goal 续跑计数器：独立于 step，
        // 防止 step++ 在 continue 路径被跳过导致无限循环
        let goalTurns = 0
        // [local-smark] nearOverflow 提示：首次达到 85% usable 时注入一次。
        // 当上下文降到 85% 以下时（如模型切换到更大上下文模型）重置标志，
        // 使后续再次达到 85% 时可以重新提示。
        // 提示是 ephemeral 的（仅存在于 messages 数组，不持久化到 DB），
        // 不会泄漏给 compaction 模型污染下一轮干净上下文。
        let nearOverflowNotified = false
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          yield* Effect.logInfo("loop", { "session.id": sessionID, step })

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // Some providers return "stop" even when the assistant message contains
          // tool calls. Keep the loop running so tool results can be sent back to
          // the model, but ignore cleanup-marked interrupted orphans.
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
            ) ?? false

          if (
            lastAssistant?.finish &&
            !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastAssistant.parentID === lastUser.id
          ) {
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
                "session.id": sessionID,
                messageID: lastAssistant.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            // #364：goal 续跑检查：assistant 正常结束后，
            // 如果 session 有 active goal 且未达上限，注入续跑 prompt 并 continue。
            // 续跑 prompt 作为 synthetic user message 注入，保留 synthetic=true
            // 避免 <system-reminder> 包裹和 title 生成干扰。
            // TUI 通过 goalText 渲染为 "↻ Goal continuation" 标签消息。
            // 使用独立 goalTurns 计数器防止无限循环（step++ 在 continue 后跳过）。
            // 仅对主 session（无 parentID）和非 decide agent 生效。
            const cfg = yield* config.get()
            // [local-smark] goal 续跑不再需要 experimental 开关，始终可用；
            // goal_max_turns 已提升为顶层 config 字段（0367）
            const maxGoalTurns = cfg.goal_max_turns ?? 32
            // [0386] 默认 32 轮：与 config schema description 同源；源提交本即 32
            if (
              maxGoalTurns > 0 &&
              !session.parentID &&
              goalTurns < maxGoalTurns
            ) {
              const goalOpt = yield* goalSvc.get(sessionID).pipe(Effect.orDie)
              if (goalOpt._tag === "Some") {
                const goal = goalOpt.value
                // 读取 lastUser 的 agent 以判断是否 decide agent
                const goalAgent = yield* agents.get(lastUser.agent)
                // decide agent 用于路由决策，不参与 goal 续跑
                // maxSteps 限制同样适用于 goal 续跑，防止超出 agent 步数预算
                const maxSteps = goalAgent?.steps ?? Infinity
                if (
                  goal.status === "active" &&
                  goalAgent &&
                  !isDecideAgent(goalAgent) &&
                  step < maxSteps
                ) {
                  goalTurns++
                  // 注入 synthetic user message 作为续跑 prompt
                  // noReply=true 避免递归触发 loop；source="system_continue" 供 request usage 追踪
                  // orDie 将 Image.Error 转为 defect，保持 runLoop 的 error 类型为 never
                  yield* prompt({
                    sessionID,
                    noReply: true,
                    source: "system_continue",
                    agent: lastUser.agent,
                    model: { providerID: lastUser.model.providerID, modelID: lastUser.model.modelID },
                    parts: [{
                      type: "text",
                      synthetic: true,
                      text: SessionGoal.continuationPrompt(goal),
                    }],
                  }).pipe(Effect.orDie)
                  yield* Effect.logInfo("goal continuation", { goalTurns, step })
                  continue
                }
              }
            }
            // max_turns 到达时将 active goal 暂停，避免 UI 误导用户以为 goal 仍在运行。
            // maxGoalTurns=0 表示禁用续跑，不 pause；complete/blocked goal 不 pause。
            // Resume 后 goal 回到 active，用户发送新消息时新 loop 以 goalTurns=0 开始。
            if (maxGoalTurns > 0 && !session.parentID && goalTurns >= maxGoalTurns) {
              const goalOpt = yield* goalSvc.get(sessionID).pipe(Effect.orDie)
              if (goalOpt._tag === "Some" && goalOpt.value.status === "active") {
                yield* goalSvc.set(sessionID, { status: "paused" }).pipe(Effect.orDie)
              }
            }
            yield* Effect.logInfo("exiting loop", { "session.id": sessionID })
            break
          }

          // 本轮选中的 user 在模型/agent/上下文准备前冻结，失败时不重读后来保存的 steer。
          requestID = lastUser.id
          existingAssistantID = lastAssistant?.parentID === lastUser.id ? lastAssistant.id : undefined
          step++
          if (step === 1)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
            continue
          }

          // #140：overflow 改到 assembled prompt 的 estimatedInput 之后，避免 tail 旧用量连环压缩

          const agent = yield* agents.get(lastUser.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          const maxSteps = agent.steps ?? Infinity
          const isLastStep = step >= maxSteps
          msgs = yield* SessionReminders.apply({ messages: msgs, agent, session }).pipe(
            Effect.provideService(RuntimeFlags.Service, flags),
            Effect.provideService(FSUtil.Service, fsys),
            Effect.provideService(Session.Service, sessions),
          )

          const msg: SessionV1.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          const own = yield* SessionProcessor.ownAssistant({ sessionID, requestID: msg.parentID }, { events, db })
          own(msg)
          yield* SessionProcessor.publishAssistant(msg, events)

          const handle = yield* processor
            .create({
              assistantMessage: msg,
              sessionID,
              model,
            })

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
            // [local-smark] 事前提醒：当历史记录中使用了当前被 disable 的工具时，
            // 在用户消息中注入 system-reminder，让模型在生成下一轮回复前就知道
            // 该工具不可用及替代方案。所有 agent 模式共用此循环，注入覆盖全路径。
            const notice = disabledToolNotice(msgs, agent.permission, session.permission ?? [])
            if (notice && lastUserMsg) {
              lastUserMsg.parts.push({
                id: PartID.ascending(),
                messageID: lastUserMsg.info.id,
                sessionID: lastUserMsg.info.sessionID,
                type: "text",
                text: notice,
                synthetic: true,
              } as SessionV1.Part)
            }
            const promptOps = yield* ops()
            // #159：decide 路径工具表恒为空，不 resolve 注册表
            // 空表同时驱动 system 的 WITHOUT any tools 文案
            const decide = isDecideAgent(agent)

            // 非 decide：沿用 SessionTools.resolve 完整权限/插件管线
            const tools: Record<string, AITool> = decide
              ? {}
              : yield* SessionTools.resolve({
                  agent,
                  session,
                  model,
                  processor: handle,
                  bypassAgentCheck,
                  messages: msgs,
                  promptOps,
                  goalSvc,
                }).pipe(
                  Effect.provideService(Plugin.Service, plugin),
                  Effect.provideService(Permission.Service, permission),
                  Effect.provideService(ToolRegistry.Service, registry),
                  Effect.provideService(MCP.Service, mcp),
                  Effect.provideService(Truncate.Service, truncate),
                  Effect.provideService(RuntimeFlags.Service, flags),
                )

            // decide 不挂 StructuredOutput 工具；json_schema 仅非 decide
            if (!decide && lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            // decide 跳过插件 transform，避免外部改写只读上下文
            if (!decide) yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            // decide 跳过 skills/MCP 指令，只保留 env + instructions
            const [skills, env, instructions, mcpInstructions] = yield* Effect.all([
              decide ? Effect.succeed(undefined) : sys.skills(agent),
              sys.environment(model),
              instruction.system().pipe(Effect.orDie),
              decide ? Effect.succeed(undefined) : sys.mcp(agent, session.permission),
            ])
            const system = [
              ...env,
              ...instructions,
              ...(mcpInstructions ? [mcpInstructions] : []),
              ...(skills ? [skills] : []),
            ]
            const format = lastUser.format ?? { type: "text" as const }
            if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
            // 只选择发送窗口，原始历史和 prepared 统计仍由各自 owner 管理。
            const systemText = [(agent.prompt ? [agent.prompt] : SystemPrompt.provider(model)).join("\n"), ...system, lastUser.system ?? ""].join("\n")
            const requestMsgs = decide
              ? yield* selectDecideMessages({ messages: msgs, model, systemText })
              : msgs
            const modelMsgs = yield* MessageV2.toModelMessagesEffect(requestMsgs, model)
            // 复用上一轮真实 prepared 快照作轻量预警；本轮硬溢出仍由 processor 的唯一准备入口判断。
            if (!isLastStep) {
              const prior = msgs.findLast(message => message.info.role === "assistant" && message.info.inputEstimate)?.info
              const estimatedInput = prior?.role === "assistant" ? prior.inputEstimate?.input ?? 0 : 0
              const usableTokens = usable({ cfg: yield* config.get(), model })
              // 模型切换导致占比降低或无上限时复位，下次达到85%可重新提示。
              const threshold = usableTokens > 0 ? Math.floor(usableTokens * 0.85) : 0
              if (usableTokens > 0 && estimatedInput >= threshold) {
                if (!nearOverflowNotified) {
                  modelMsgs.push({ role: "user", content: "Context is approaching the model's limit. To avoid context compaction degrading task quality, prefer targeted reads (small offset/limit) over full-file reads, and narrow grep patterns over broad searches. Do not reduce response quality. If work is still in progress, ignore this and continue per user instructions." })
                  nearOverflowNotified = true
                }
              } else {
                nearOverflowNotified = false
              }
            }
            const result = yield* handle.process({
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              // 只交付已有 source 的原文归属；字符与 token 仍在唯一 prepared 回调计算。
              inputSections: [
                ...instructions.map(text => ({ kind: "instructions" as const, text })),
                ...(lastUser.system ? [{ kind: "instructions" as const, text: lastUser.system }] : []),
                ...(skills ? [{ kind: "skills" as const, text: skills }] : []),
              ],
              system,
              messages: [
                ...modelMsgs,
                ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
              ],
              tools,
              model,
              toolChoice: !decide && format.type === "json_schema" ? "required" : undefined,
            })

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              // Surface any content-filter finish (e.g. Anthropic stop_reason:
              // refusal) as an error. These turns may have produced no visible
              // output at all — previously the session went idle silently — or
              // partial text that was cut off by the provider's filter.
              if (handle.message.finish === "content-filter") {
                handle.message.error = new SessionV1.ContentFilterError({
                  message: "The response was blocked by the provider's content filter",
                }).toObject()
                // 共用助手 owner 原子修订过滤错误，保留确认消费与通知可中断性。
                yield* SessionProcessor.publishAssistant(handle.message, events)
                yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
                return "break" as const
              }
              if (format.type === "json_schema") {
                handle.message.error = new SessionV1.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                // 格式终验沿用同一 owner；已完成助手仍须同步错误到原请求账本。
                yield* SessionProcessor.publishAssistant(handle.message, events)
                return "break" as const
              }
            }

            if (result === "stop") return "break" as const
            // #364：goal token/time 计费：assistant message 完成后，
            // 如果 goal active 则累加本轮 token 消耗和耗时到 goal DB 记录
            if (handle.message.tokens && handle.message.time.completed) {
              const tokenDelta =
                handle.message.tokens.input +
                handle.message.tokens.output +
                handle.message.tokens.reasoning
              const timeDelta = Math.max(
                0,
                Math.floor((handle.message.time.completed - handle.message.time.created) / 1000),
              )
              // 计费DB缺陷保留诊断但不截断provider轮次；ignore不能捕获defect。
              yield* goalSvc.accountUsage(sessionID, tokenDelta, timeDelta).pipe(
                Effect.catchDefect((defect) => Effect.logError("goal accountUsage defect", { defect: String(defect) })),
              )
            }
            if (result === "compact") {
              nearOverflowNotified = false
              // #242：provider overflow 发生在真实 assistant 尝试后——直接对当前会话快照
              // 执行 compaction，不留可重放标记给下一轮 loop
              const compacted = yield* compaction.run({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
              if (compacted === "stop") return "break" as const
            }
            return "continue" as const
          }).pipe(
            Effect.ensuring(instruction.clear(handle.message.id)),
          )
          if (outcome === "break") break
          continue
        }

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        return yield* lastAssistant(sessionID)
      },
      Effect.scoped,
    )

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      return yield* state.ensureRunning(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID))
    })

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
        // 命令复用 prompt 执行，但入口身份仍是 command，不能被默认 prompt 来源覆盖。
        source: "command",
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      loop,
      compact,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  // 根身份保留内部因果关联；HttpApi payload 排除该字段，不能接受客户端伪造根链。
  rootRequestID: Schema.optional(MessageID),
  // 内部调用也使用闭合来源 Schema，存储和公开响应不出现任意新来源字符串。
  source: Schema.optional(SessionRequestUsage.SourceSchema),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    SessionStatus.node,
    Session.node,
    Agent.node,
    Provider.node,
    SessionProcessor.node,
    SessionCompaction.node,
    SessionGoal.node,
    Plugin.node,
    Command.node,
    Config.node,
    Permission.node,
    FSUtil.node,
    MCP.node,
    LSP.node,
    ToolRegistry.node,
    Truncate.node,
    Image.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    SessionRunState.node,
    SessionRevert.node,
    SessionSummary.node,
    SystemPrompt.node,
    LLM.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
  ],
})

export * as SessionPrompt from "./prompt"
