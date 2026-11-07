import * as Tool from "./tool"
import { TaskPrompt } from "@opencode-ai/core/tool/task-prompt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Database } from "@opencode-ai/core/database/database"
import { InstanceState } from "@/effect/instance-state"
import { FileEvidence } from "@opencode-ai/core/session/file-evidence"
import { formatTaskIdNotice } from "@/util/output-notice"

// SessionID 的 Schema 生成器使用固定 26 位 body；完整 ID = "ses_" + body，旧 brand 边界不收紧。
const SESSION_ID_BODY_LENGTH = 26

// 只适配V1历史形状，聚合、预算与转义均由两代共用的Core owner承担。
export function buildParentInspectedFilesSummary(messages: SessionV1.WithParts[], worktree: string): string | undefined {
  return FileEvidence.parentSummary(messages.flatMap(message => message.info.role === "assistant"
    ? message.parts.flatMap(part => part.type === "tool" && part.tool === "read" && part.state.status === "completed" && !part.state.time.compacted
      ? [part.state.metadata.read] : [])
    : []), worktree)
}

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

// 子 agent 未产出文本时的温和提醒：仅指出事实并请求文本回应，
// 不限制工具/不覆盖指令/不强加格式——任务要求由主 agent 原始 prompt 已定义。
// 文案是提问而非命令：避免覆盖或与子 agent 的原始任务指令冲突。
const NO_OUTPUT_NUDGE =
  "No text output was produced in your previous turn. Please provide a text response to the task above."

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  // [local-smark] 控制是否传递父 session 的已读文件列表给子 agent。
  // 'summary': 传递文件路径+range 表格（新 subagent 默认）。
  // 'none': 不传递（resume 默认，子 session 已有自己的 read 历史）。
  inspected_files: Schema.optional(Schema.Literals(["none", "summary"])).annotate({
    description:
      "Controls whether to pass parent session's inspected file list to the subagent. 'none': no file list (default for resume). 'summary': compact file path + range table (default for new subagents).",
  }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
  notice?: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    // #507：notice 插在骨架元信息与结果体之间，供模型读，不影响 task_result 解析
    ...(input.notice ? [input.notice] : []),
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      // #200：先解析代理再决定 bypassAgentCheck，hidden 拦截优先于权限审批
      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }
      // #200：permission-reviewer 为保留协议代理，非用户可调用子代理；
      // #200：同时检查请求键与 hidden 标志，防止项目配置解除隐藏后经 reviewer 路由
      // #200：保留名检查在 hidden 检查之前，双重保障即使配置 unhide 仍被拒绝
      if (params.subagent_type === "permission-reviewer" && ctx.extra?.allowHiddenAgent !== true) {
        return yield* Effect.fail(new Error(`Agent type is not available: ${params.subagent_type}`))
      }
      // #200：bypassAgentCheck 用于内部派发片段，但不可暴露 hidden 实现代理；
      // #200：未来内部路径需要独立的 allowHiddenAgent 标志
      if (next.hidden === true && ctx.extra?.allowHiddenAgent !== true) {
        return yield* Effect.fail(new Error(`Agent type is not available: ${params.subagent_type}`))
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      // #507：task_id 是 optional string，不是 SessionID brand。对非 "ses*" raw 直接
      // SessionID.make 会同步抛 brand 错误并中断整次 execute；只能对已过域门闸的候选 make+get。
      const lookupSession = (id: string) =>
        id.startsWith("ses")
          ? sessions.get(SessionID.make(id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : Effect.succeed(undefined)

      const rawTaskID = params.task_id
      const resolved = yield* Effect.gen(function* () {
        if (!rawTaskID) return { mode: "create" as const, reason: "omitted" as const }

        // 候选 1：raw 已是 SessionID 域成员（startsWith "ses"）
        const exact = yield* lookupSession(rawTaskID)
        if (exact) return { mode: "resume" as const, session: exact }

        // 候选 2：用户指定的 26-body 补全（生成器字面量 ses_）；与 brand 边界 "ses" 分工
        // 补全后仍是普通 ses* 候选——miss 不再二次变换（不加前缀/截断），
        // 与乱串同归 invalid_provided，保证 miss 路径单一。
        if (rawTaskID.length === SESSION_ID_BODY_LENGTH && !rawTaskID.startsWith("ses")) {
          const prefixed = yield* lookupSession("ses_" + rawTaskID)
          if (prefixed) return { mode: "resume" as const, session: prefixed }
        }

        // 能用就用；不能用就当错误走创建，不因非法 ID 硬失败
        return { mode: "create" as const, reason: "invalid_provided" as const, provided: rawTaskID }
      })

      // resume 取已命中 session；create 时 session 保持 undefined 以走 sessions.create
      const session = resolved.mode === "resume" ? resolved.session : undefined
      // 仅在“传了但无法命中已有 Session”时提示；省略 task_id 的正常新建不插 notice
      // notice 与 create 绑定：不伪装 resume 成功，只声明独立新上下文
      const invalidTaskIdNotice =
        resolved.mode === "create" && resolved.reason === "invalid_provided"
          ? formatTaskIdNotice({ provided: resolved.provided })
          : undefined
      // 执行代理可能不同于持久化 parent.agent；用 ctx.agent 防止切换代理后继承旧权限。
      const parentAgent = yield* agent.get(ctx.agent)
      const childPermission = deriveSubagentSessionPermission(
        {
          parentSessionPermission: parent.permission ?? [],
          subagent: next,
        },
        parentAgent.permission,
      )
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      // primary_tools 保留既有 deny 语义，仍在派生父限制之后生效。
      const nextPermission = Permission.compact([
        ...childPermission,
        ...childToolDenies.filter(
          (deny) =>
            !childPermission.some(
              (rule) =>
                rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
            ),
        ),
      ])
      // 每次恢复都重算权限；新建与恢复记录同一个实际执行子代理。
      const nextSession = session
        ? { ...session, agent: next.name, permission: nextPermission }
        : yield* sessions.create({
            parentID: ctx.sessionID,
            title: params.description + ` (@${next.name} subagent)`,
            agent: next.name,
            permission: nextPermission,
          })

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      if (session) {
        // setAgentModel 要求本轮模型；连同权限经同一 Session owner 回写，不依赖 promptOps 的副作用。
        yield* sessions.setPermission({ sessionID: session.id, permission: nextPermission })
        yield* sessions.setAgentModel({
          sessionID: session.id,
          agent: next.name,
          model: {
            id: model.modelID,
            providerID: model.providerID,
            variant: next.model ? undefined : variant,
          },
          time: Date.now(),
        })
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)

        // [local-smark] 根据 inspected_files 参数传递父 session 的已读文件列表。
        // 新 subagent 默认 "summary"，resume 默认 "none"（子 session 已有自己的 read 历史）。
        // 从 ctx.messages 提取 read tool parts 的文件路径和 range，
        // 不做 fs.stat（避免 I/O），stale 由子 agent 的 read size+modifiedMs 门控处理。
        // worktree 用于计算相对路径，通过 InstanceState.context 获取（与 read.ts 同款用法）。
        // #507：默认必须跟真实 resolve.mode：resume→none，新建（含非法 task_id 导致的新建）→summary。
        // 不能用 raw params.task_id 真值——假 ID 会伪装成 resume 并丢掉父 inspected 摘要。
        const instance = yield* InstanceState.context
        const inspectedFilesMode =
          params.inspected_files ?? (resolved.mode === "resume" ? "none" : "summary")
        const parentContext = inspectedFilesMode !== "none" && ctx.messages.length > 0
          ? buildParentInspectedFilesSummary(ctx.messages, instance.worktree)
          : undefined

        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: next.model ? undefined : variant,
          agent: next.name,
          parts: parentContext
            ? [...parts, { type: "text" as const, text: `<parent_context>\n${parentContext}\n</parent_context>` }]
            : parts,
        })
        if (result.info.role === "assistant" && result.info.error) {
          const message =
            "message" in result.info.error.data && typeof result.info.error.data.message === "string"
              ? result.info.error.data.message
              : result.info.error.name
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${message}`))
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error") {
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${failed.state.error}`))
        }
        let text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
        // 子 agent 未产出文本时注入一轮温和提醒，让它至少回应任务需求。
        // 不限制工具/不覆盖指令/不强加格式——任务要求由主 agent 原始 prompt 已定义。
        // abort 已发生时跳过 nudge：已 aborted 的 signal 不会再触发 abort 事件，
        // 新 runner 无法被取消，继续 nudge 会浪费 token
        // 双条件：文本为空才值得 nudge；abort 后不再发起新回合（已无法取消）。
        // 空文本判定用 trim()：纯空白输出对主 agent 同样没有信息量。
        if ((!text || text.trim().length === 0) && !ctx.abort.aborted) {
          // synthetic 提醒沿正常持久化与计费路径执行，只在界面隐藏。
          const retry = yield* ops.prompt({
            messageID: MessageID.ascending(),
            sessionID: nextSession.id,
            model: { modelID: model.modelID, providerID: model.providerID },
            variant: next.model ? undefined : variant,
            agent: next.name,
            parts: [{ type: "text" as const, text: NO_OUTPUT_NUDGE, synthetic: true }],
          })
          // 第二轮与首轮遵守同一错误契约，不能把部分文本或空结果当成成功。
          if (retry.info.role === "assistant" && retry.info.error) {
            const message =
              "message" in retry.info.error.data && typeof retry.info.error.data.message === "string"
                ? retry.info.error.data.message
                : retry.info.error.name
            return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${message}`))
          }
          const failed = retry.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
          if (failed?.type === "tool" && failed.state.status === "error") {
            return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${failed.state.error}`))
          }
          // 重读 findLast：nudge 回合的最后一个 text 才是子 agent 的最终答复。
          text = retry.parts.findLast((item) => item.type === "text")?.text ?? ""
        }
        // nudge 仍空（或 abort 跳过了 nudge）时回退静态提示，
        // 引导主 agent 用 task_id 恢复
        if (!text || text.trim().length === 0) {
          // 静态兜底保留原始语义（可能被 abort 或缺工具），仅追加 resume 指引。
          text =
            "Subagent produced no output (may have been aborted or lacked required tools). You may resume this task with the task_id above to continue."
        }
        // [local-smark] result 截断预算：32KB（约 8K tokens），防止大结果撑爆父上下文
        const TASK_RESULT_MAX_CHARS = 32_000
        if (text.length > TASK_RESULT_MAX_CHARS) {
          text = text.slice(0, TASK_RESULT_MAX_CHARS) + "\n...[truncated]"
        }
        return text
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        // #507：inject 是子任务完成后注入父会话的 synthetic 结果文本，不属于创建时回执，
        // 不挂 invalid notice（notice 只随 started/updated/completed 回执出现）。
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          program: { value: { sessionID: nextSession.id, status: "running", content: BACKGROUND_UPDATED } },
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
            // #507：background 回执同样挂 invalid notice（若有），与前台 output 合同一致；
            // extend 更新回执与 started 同属「本次调用回执」，一致性挂载而非语义新增。
            notice: invalidTaskIdNotice,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        // running描述此次后台回执；最终结果继续通过BackgroundJob既有通知交付。
        return {
          title: params.description,
          program: { value: { sessionID: nextSession.id, status: "running", content: BACKGROUND_STARTED } },
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
            // #507：background 启动回执同样挂 invalid notice（若有），与前台 output 合同一致
            notice: invalidTaskIdNotice,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              // 程序正文直接取子任务回复，展示包装与恢复提示继续留在原output中。
              program: { value: { sessionID: nextSession.id, status: "completed", content: result?.output ?? "" } },
              output: renderOutput({
                sessionID: nextSession.id,
                state: "completed",
                text: result?.output ?? "",
                notice: invalidTaskIdNotice,
              }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [TaskPrompt.description, BACKGROUND_DESCRIPTION].join("\n\n")
        : TaskPrompt.description,
      parameters: Parameters,
      output: Schema.Struct({ sessionID: Schema.String, status: Schema.Literals(["running", "completed"]), content: Schema.String }),
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
