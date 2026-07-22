export * as TaskTool from "./task"

import { ToolFailure } from "@opencode-ai/llm"
import { ConfigProvider, DateTime, Effect, Layer, Schema, Scope } from "effect"
import { AgentV2 } from "../agent"
import { BackgroundJob } from "../background-job"
import { Config } from "../config"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { makeLocationNode } from "../effect/app-node"
import type { LocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SubagentPermissions } from "../permission/subagent"
import { SessionV2 } from "../session"
import { SessionStore } from "../session/store"
import { FileEvidence } from "../session/file-evidence"
import { Location } from "../location"
import { SystemContext } from "../system-context"
import { SystemContextRegistry } from "../system-context/registry"
import { Tools } from "./tools"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { TaskPrompt } from "./task-prompt"
import { ensureTaskResumeVisible, formatTaskIdNotice } from "../util/output-notice"

export const name = "task"
export const description = TaskPrompt.description
export const Input = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The complete task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "Agent type from the available agents in system context" }),
  task_id: Schema.String.pipe(Schema.optional).annotate({ description: "Resume this returned task_id only when continuing the same subagent conversation" }),
  command: Schema.String.pipe(Schema.optional),
  inspected_files: Schema.optional(Schema.Literals(["none", "summary"])).annotate({
    description: "Controls whether to pass parent session's inspected file list to the subagent. 'none': no file list (default for resume). 'summary': compact file path + range table (default for new subagents).",
  }),
  background: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Run independent work in the background; completion is delivered automatically. Requires experimental background subagents." }),
})
export const Output = Schema.Struct({ task_id: Schema.String, state: Schema.Literals(["running", "completed"]), output: Schema.String, notice: Schema.optional(Schema.String) })

export const layer = Layer.effectDiscard(Effect.gen(function* () {
  const tools = yield* Tools.Service
  const agents = yield* AgentV2.Service
  const sessions = yield* SessionV2.Service
  const events = yield* EventV2.Service
  const store = yield* SessionStore.Service
  const permission = yield* PermissionV2.Service
  const background = yield* BackgroundJob.Service
  const config = yield* Config.Service
  const location = yield* Location.Service
  const contexts = yield* SystemContextRegistry.Service
  const scope = yield* Scope.Scope
  const environment = yield* ConfigProvider.ConfigProvider
  // 使用进程环境provider的同一值，测试和嵌入调用可局部提供而不改全局环境。
  const enabled = environment.load(["OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"]).pipe(Effect.flatMap(value =>
    value === undefined ? environment.load(["OPENCODE_EXPERIMENTAL"]) : Effect.succeed(value)),
    Effect.map(value => value?._tag === "Value" && ["1", "true"].includes(value.value.toLowerCase())))

  // Agent配置可重载；列表作为现有Context Source逐轮观察，不冻结在工具初始化时。
  const available = agents.all().pipe(Effect.map(items => items.filter(item => !item.hidden && item.mode !== "primary")))
  yield* contexts.register({
    key: SystemContext.Key.make("core/task-agents"),
    load: Effect.succeed(SystemContext.make({
      key: SystemContext.Key.make("core/task-agents"), codec: Schema.toCodecJson(Schema.String),
      load: available.pipe(Effect.map(items => ["Available task agents:", ...items.map(item => `- ${item.id}: ${item.description ?? ""}`)].join("\n"))),
      baseline: String, update: (_previous, current) => current,
      removed: () => "Task agent guidance removed",
    })),
  })
  yield* tools.register({ [name]: Tool.make({
    description: `${description}\n\nBackground mode returns immediately and delivers completion automatically. Do not sleep or poll; continue non-overlapping work.`,
    input: Input, output: Output,
    toModelOutput: ({ output }) => [{ type: "text", text: `task_id: ${output.task_id}\n${output.notice ? `${output.notice}\n` : ""}<task_${output.state === "running" ? "status" : "result"}>\n${output.output}\n</task_${output.state === "running" ? "status" : "result"}>` }],
    execute: (input, context) => Effect.gen(function* () {
      const agent = (yield* available).find(item => item.id === input.subagent_type)
      if (!agent) return yield* new ToolFailure({ message: `Unknown agent type: ${input.subagent_type} is not a valid agent type` })
      yield* permission.assert({
        action: name, resources: [agent.id], save: ["*"], sessionID: context.sessionID, agent: context.agent,
        metadata: { description: input.description, subagent_type: agent.id },
        source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
      })
      if (input.background && !(yield* enabled)) return yield* new ToolFailure({ message: "Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true" })
      const parent = yield* sessions.get(context.sessionID)
      const cfg = yield* config.entries()
      const maxDepth = Config.latest(cfg, "subagent_depth") ?? 1
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= maxDepth) return yield* new ToolFailure({ message: `Subagent depth limit reached (${maxDepth}). Increase "subagent_depth" to allow nested subagents.` })
      // 沿旧 brand 的 ses 前缀构造候选；只有完整26位裸body补一次前缀，不做模糊查找。
      const candidate = input.task_id?.startsWith("ses") ? input.task_id
        : input.task_id?.length === 26 ? `ses_${input.task_id}` : undefined
      const existing = candidate ? yield* store.get(SessionV2.ID.make(candidate)) : undefined
      // 恢复必须仍属于本父会话与Location，不把任意其他Session当作委派目标。
      if (existing && (existing.parentID !== parent.id || existing.location.directory !== location.directory || existing.location.workspaceID !== location.workspaceID))
        return yield* new ToolFailure({ message: `Unknown task_id: ${input.task_id}` })
      // 未命中才新建并告知独立上下文；越界命中继续拒绝，DB defect及中断也不能当miss。
      const notice = input.task_id && !existing ? formatTaskIdNotice({ provided: input.task_id }) : undefined
      const history = yield* sessions.context(parent.id)
      const assistant = history.findLast(item => item.type === "assistant" && item.id === context.assistantMessageID)
      const model = agent.model ?? (assistant?.type === "assistant" ? assistant.model : parent.model)
      const parentPermission = yield* store.permissions(parent.id)
      const parentAgent = yield* agents.get(context.agent)
      if (!parentAgent) return yield* new ToolFailure({ message: `Unknown parent agent: ${context.agent}` })
      // 原生调用只做字段适配，父子交集及具体deny由共享source算法承担。
      const childPermission: PermissionV2.Ruleset = [
        ...SubagentPermissions.derive({
          parentAgentPermission: parentAgent.permissions,
          parentSessionPermission: parentPermission,
          subagentPermission: agent.permissions,
        }),
        ...(cfg.flatMap(entry => entry.type === "document" && entry.info.experimental?.primary_tools !== undefined ? [entry.info.experimental.primary_tools] : []).at(-1) ?? []).map(action => ({ action: action === "write" || action === "apply_patch" ? "edit" : action, resource: "*", effect: "deny" as const })),
      ]
      const child = yield* Effect.uninterruptible(Effect.gen(function* () {
        const child = existing ?? (yield* sessions.create({
          parentID: parent.id, title: `${input.description} (@${agent.id} subagent)`,
          location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
          agent: agent.id, model, permissions: childPermission,
        }))
        // 身份在分配后立即持久交付，取消不能落在create与父工具快照之间。
        yield* events.publish(SessionEvent.Tool.Progress, {
          sessionID: parent.id, timestamp: yield* DateTime.now,
          assistantMessageID: context.assistantMessageID, callID: context.toolCallID,
          structured: { task_id: child.id }, content: [],
        })
        return child
      }))
      // 摘录冻结于本次父历史，排队的extension不能改采稍后的其他调用上下文。
      // 默认跟实际恢复结果，非法ID导致新建仍须带父已读摘要。
      const parentContext = (input.inspected_files ?? (existing ? "none" : "summary")) === "summary"
        ? FileEvidence.parentSummary(history.flatMap(message => message.type === "assistant" ? message.content.flatMap(part =>
          part.type === "tool" && part.name === "read" && part.provider?.executed !== true && part.time.pruned === undefined && part.state.status === "completed"
            ? [part.state.structured.read] : []) : []), location.project.directory) : undefined
      const prompt = parentContext ? `${input.prompt}\n\n<parent_context>\n${parentContext}\n</parent_context>` : input.prompt
      const runTask = Effect.gen(function* () {
        // extension在旧段结束后才执行；本次审批身份不能提前改变仍活跃的旧provider轮。
        if (existing) {
          // extension真正开始后才替换旧权限；入队时不能改掉仍运行的上一段。
          yield* sessions.setPermissions({ sessionID: child.id, permissions: childPermission })
          const current = yield* sessions.get(child.id)
          if (current.agent !== agent.id) yield* sessions.switchAgent({ sessionID: child.id, agent: agent.id })
          if (model) yield* sessions.switchModel({ sessionID: child.id, model })
        }
        yield* sessions.prompt({ sessionID: child.id, prompt: { text: prompt }, resume: false })
        // 两轮共用真实runner及错误检查；每轮重读前像，不能误认上轮旧助手文本。
        const runOnce = Effect.gen(function* () {
          const before = (yield* sessions.context(child.id)).findLast(item => item.type === "assistant")?.id
          yield* sessions.resume(child.id).pipe(Effect.onInterrupt(() => sessions.interrupt(child.id)))
          const latest = (yield* sessions.context(child.id)).findLast(item => item.type === "assistant")
          if (latest?.type !== "assistant" || latest.id === before) return ""
          if (latest.error) return yield* new ToolFailure({ message: `Subagent failed (task_id: ${child.id}): ${latest.error.message}` })
          const failed = latest.content.findLast(item => item.type === "tool" && item.state.status === "error")
          if (failed?.type === "tool" && failed.state.status === "error")
            return yield* new ToolFailure({ message: `Subagent failed (task_id: ${child.id}): ${failed.state.error.message}` })
          return latest.content.filter(item => item.type === "text").map(item => item.text).join("\n")
        })
        let text = yield* runOnce
        if (!text.trim()) {
          // 只提醒一次，不重派Task/授权或改变子会话身份；取消仍由既有Effect链退出。
          yield* events.publish(SessionEvent.Synthetic, { sessionID: child.id, messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            text: "No text output was produced in your previous turn. Please provide a text response to the task above." })
          text = yield* runOnce
        }
        return text
      }).pipe(
        // 父级通知与前台结果共用同一次成功文本归一；错误/取消不会被改成空成功。
        Effect.map(text => !text.trim() ? "Subagent produced no output (may have been aborted or lacked required tools). You may resume this task with the task_id above to continue." : text.length > 32_000 ? `${text.slice(0, 32_000)}\n...[truncated]` : text),
        Effect.mapError(error => error instanceof ToolFailure ? error : new ToolFailure({ message: `Subagent failed (task_id: ${child.id})`, error })))
      const notify = () => background.wait({ id: child.id }).pipe(Effect.flatMap(result => {
        if (!result.info || result.info.status === "running" || result.info.status === "cancelled") return Effect.void
        // 完成消息走父Session的durable admission与advisory wake，不递归运行V1或轮询进度。
        return sessions.prompt({ sessionID: parent.id, prompt: { text: `<task id="${child.id}" state="${result.info.status}">\n${result.info.output ?? result.info.error ?? ""}\n</task>` } }).pipe(Effect.asVoid)
      }), Effect.catch(error => Effect.logError("Failed to deliver background task result", error)), Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
      const running = { task_id: child.id, state: "running" as const, notice, output: "The task is working in the background. You will be notified automatically when it finishes. DO NOT sleep, poll, or duplicate this task's work. Continue non-overlapping work." }
      // 子任务可能在start返回前运行；先保证挂接取消责任，再恢复前台等待的可中断性。
      return yield* Effect.uninterruptibleMask(restore => Effect.gen(function* () {
      if (yield* background.extend({ id: child.id, run: restore(runTask) })) return running
      const info = yield* background.start({ id: child.id, type: name, title: input.description,
        metadata: { parentSessionId: parent.id, sessionId: child.id, ...(input.background ? { background: true } : {}) },
        run: restore(runTask), onPromote: notify(),
      })
      if (input.background) { yield* notify(); return running }
      // 前台与既有promotion复用同一个job；取消父调用只取消其实际拥有的子任务。
      return yield* restore(Effect.raceFirst(background.wait({ id: info.id }).pipe(Effect.map(result => result.info)), background.waitForPromotion(info.id))).pipe(
        Effect.flatMap((result): Effect.Effect<typeof Output.Type, ToolFailure> => {
          if (result?.metadata?.background === true) return Effect.succeed(running)
          if (result?.status === "error" || result?.status === "cancelled") return new ToolFailure({ message: ensureTaskResumeVisible(result.error ?? "Task cancelled", child.id) })
          return Effect.succeed({ task_id: child.id, state: "completed" as const, notice, output: result?.output ?? "" })
        }),
        Effect.onInterrupt(() => background.cancel(child.id).pipe(Effect.andThen(sessions.interrupt(child.id)))),
      )
      }))
    }).pipe(Effect.mapError(error => error instanceof ToolFailure ? error : new ToolFailure({ message: PermissionV2.autoDeniedMessage(error) ?? `Unable to execute task: ${input.description}`, error }))),
  }) }).pipe(Effect.orDie)
}))

export const node: LocationNode<never> = makeLocationNode({
  name: "tool/task", layer,
  deps: [ToolRegistry.node, AgentV2.node, SessionV2.node, SessionStore.node, PermissionV2.node, BackgroundJob.node, Config.node, Location.node, SystemContextRegistry.node, EventV2.node],
})
