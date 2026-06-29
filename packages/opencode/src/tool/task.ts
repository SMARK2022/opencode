import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { SessionStatus } from "@/session/status"
import { Config } from "@/config/config"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Cause, Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"

// [local-smark] 从父 session 的 messages 提取已读文件列表，
// 生成紧凑的 markdown 表格作为子 agent 的 parent_context。
// 不做 fs.stat（避免 I/O），stale 由子 agent 的 read size+modifiedMs 门控处理。
// 上限 20 个文件（与 Evidence Handoff EVIDENCE_FILE_LIMIT 一致）。
function buildParentInspectedFilesSummary(messages: MessageV2.WithParts[]): string | undefined {
  const files = new Map<string, { path: string; ranges: string[]; lastRead: number }>()
  let seq = 0
  for (const msg of messages) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.tool !== "read") continue
      if (part.state.status !== "completed") continue
      if (part.state.time.compacted) continue
      seq++
      const meta = part.state.metadata?.read
      if (!meta || typeof meta !== "object") continue
      const m = meta as Record<string, unknown>
      const canonicalPath = typeof m.canonicalPath === "string" ? m.canonicalPath : ""
      const filePath = typeof m.path === "string" ? m.path : ""
      if (!filePath) continue
      if (m.stub === true) continue
      const start = typeof m.start === "number" ? m.start : 0
      const end = typeof m.end === "number" ? m.end : 0
      const existing = files.get(canonicalPath || filePath)
      if (existing) {
        existing.ranges.push(`${start}-${end}`)
        existing.lastRead = seq
      } else {
        files.set(canonicalPath || filePath, { path: filePath, ranges: [`${start}-${end}`], lastRead: seq })
      }
    }
  }
  if (files.size === 0) return undefined
  const sorted = [...files.values()].sort((a, b) => b.lastRead - a.lastRead).slice(0, 20)
  const lines = [
    "### Parent Session Inspected Files",
    "| path | ranges |",
    "|---|---|",
    ...sorted.map((f) => {
      // [local-smark] 显示相对路径而非 basename，避免多包仓库中同名文件歧义
      const rel = f.path.split(/[\\/]/).slice(-3).join("/")
      return `| ${rel} | ${f.ranges.join(", ")} |`
    }),
  ]
  if (files.size > 20) lines.push(`Omitted: ${files.size - 20} files due to budget.`)
  return lines.join("\n")
}

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  loop(input: SessionPrompt.LoopInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "",
  "",
  [
    "Background mode: background=true launches the subagent asynchronously.",
    "Use task_status(task_id=..., wait=false) to poll, or wait=true to block until done.",
  ].join(" "),
].join("\n")

const BaseParameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
})

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  background: Schema.optional(Schema.Boolean).annotate({
    description: "When true, launch the subagent in the background and return immediately",
  }),
  // [local-smark] 控制是否传递父 session 的已读文件列表给子 agent。
  // 'summary': 传递文件路径+range 表格（新 subagent 默认）。
  // 'none': 不传递（resume 默认，子 session 已有自己的 read 历史）。
  inspected_files: Schema.optional(Schema.Literals(["none", "summary"])).annotate({
    description:
      "Controls whether to pass parent session's inspected file list to the subagent. 'none': no file list (default for resume). 'summary': compact file path + range table (default for new subagents).",
  }),
})

function output(sessionID: SessionID, text: string) {
  return [
    `task_id: ${sessionID} (for resuming to continue this task if needed)`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}

function backgroundOutput(sessionID: SessionID) {
  return [
    `task_id: ${sessionID} (for polling this task with task_status)`,
    "state: running",
    "",
    "<task_result>",
    "Background task started. Continue your current work and call task_status when you need the result.",
    "</task_result>",
  ].join("\n")
}

function backgroundMessage(input: {
  sessionID: SessionID
  description: string
  state: "completed" | "error"
  text: string
}) {
  const tag = input.state === "completed" ? "task_result" : "task_error"
  const title =
    input.state === "completed"
      ? `Background task completed: ${input.description}`
      : `Background task failed: ${input.description}`
  return [title, `task_id: ${input.sessionID}`, `state: ${input.state}`, "", `<${tag}>`, input.text, `</${tag}>`].join(
    "\n",
  )
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const flags = yield* RuntimeFlags.Service

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

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }
      // `permission-reviewer` is a reserved protocol agent, not a user-callable
      // subagent. Check the requested key as well as `hidden` so project config
      // cannot unhide it and route normal task execution through the reviewer.
      if (params.subagent_type === "permission-reviewer" && ctx.extra?.allowHiddenAgent !== true) {
        return yield* Effect.fail(new Error(`Agent type is not available: ${params.subagent_type}`))
      }
      // `bypassAgentCheck` is used for internally materialized task parts, but it
      // must not expose hidden implementation agents to normal task routing. A
      // separate allowHiddenAgent flag would be required for a future internal path.
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

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parent = yield* sessions.get(ctx.sessionID)
      // The current tool context is the actual delegation source. Persisted
      // session.agent can be absent or stale on resumed sessions, so it is only a
      // fallback and must not override this turn's parent permission ceilings.
      const parentAgentName = ctx.agent || parent.agent
      const parentAgent = parentAgentName
        ? yield* agent.get(parentAgentName).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const primaryToolPermission = cfg.experimental?.primary_tools?.map((item) => ({
        pattern: "*",
        action: "allow" as const,
        permission: item,
      })) ?? []
      const nextPermission = Permission.compact([
        // primary_tools may grant a subagent additional tool capability, but any
        // parent/session ceiling derived below must remain last-match-wins.
        ...primaryToolPermission,
        ...deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          parentAgent,
          subagent: next,
        }),
      ])
      const nextSession = session
        ? { ...session, agent: next.name, permission: nextPermission }
        : yield* sessions.create({
            parentID: ctx.sessionID,
            title: params.description + ` (@${next.name} subagent)`,
            // Store the real executing subagent for audit and later prompt
            // defaults; permission derivation still uses ctx.agent for the
            // current delegation source.
            agent: next.name,
            permission: nextPermission,
          })
      if (session) {
        // Resuming a task_id is a fresh delegation from the current parent. Do
        // not keep stale child permission rules; recompute the overlay from the
        // current parent agent/session and the requested subagent.
        yield* sessions.setPermission({ sessionID: session.id, permission: nextPermission })
      }

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
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
      const runCancel = yield* EffectBridge.make()

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)

        // [local-smark] 根据 inspected_files 参数传递父 session 的已读文件列表。
        // 新 subagent 默认 "summary"，resume 默认 "none"（子 session 已有自己的 read 历史）。
        // 从 ctx.messages 提取 read tool parts 的文件路径和 range，
        // 不做 fs.stat（避免 I/O），stale 由子 agent 的 read size+modifiedMs 门控处理。
        const inspectedFilesMode = params.inspected_files ?? (params.task_id ? "none" : "summary")
        const parentContext = inspectedFilesMode !== "none" && ctx.messages.length > 0
          ? buildParentInspectedFilesSummary(ctx.messages)
          : undefined

        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: next.name,
          tools: {
            ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
            ...(next.permission.some((rule) => rule.permission === id) ? {} : { task: false }),
            ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          },
          parts: parentContext
            ? [...parts, { type: "text" as const, text: `<parent_context>\n${parentContext}\n</parent_context>` } as const]
            : parts,
        })
        let text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
        // [local-smark] 空结果验证：子 agent 未产出任何文本时返回提示，
        // 返回裸字符串由调用方统一包裹，避免 <task_result> 双重嵌套。
        if (!text || text.trim().length === 0) {
          text = "Subagent produced no output (may have been aborted or lacked required tools)."
        }
        // [local-smark] result 截断预算：32KB（约 8K tokens），防止大结果撑爆父上下文
        const TASK_RESULT_MAX_CHARS = 32_000
        if (text.length > TASK_RESULT_MAX_CHARS) {
          text = text.slice(0, TASK_RESULT_MAX_CHARS) + "\n...[truncated]"
        }
        return text
      })

      const resumeWhenIdle: (input: { userID: MessageID; state: "completed" | "error" }) => Effect.Effect<void> =
        Effect.fn("TaskTool.resumeWhenIdle")(function* (input: { userID: MessageID; state: "completed" | "error" }) {
          const latest = yield* sessions
            .findMessage(ctx.sessionID, (item) => item.info.role === "user")
            .pipe(Effect.orDie)
          if (Option.isNone(latest)) return
          if (latest.value.info.id !== input.userID) return
          if ((yield* status.get(ctx.sessionID)).type !== "idle") {
            yield* Effect.sleep("300 millis")
            return yield* resumeWhenIdle(input)
          }
          yield* bus.publish(TuiEvent.ToastShow, {
            title: input.state === "completed" ? "Background task complete" : "Background task failed",
            message:
              input.state === "completed"
                ? `Background task "${params.description}" finished. Resuming the main thread.`
                : `Background task "${params.description}" failed. Resuming the main thread.`,
            variant: input.state === "completed" ? "success" : "error",
            duration: 5000,
          })
          yield* ops
            .loop({ sessionID: ctx.sessionID })
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
        })

      const continueIfIdle = Effect.fn("TaskTool.continueIfIdle")(function* (input: {
        userID: MessageID
        state: "completed" | "error"
      }) {
        yield* resumeWhenIdle(input).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        const message = yield* ops.prompt({
          sessionID: ctx.sessionID,
          noReply: true,
          agent: currentParent.agent ?? ctx.agent,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: backgroundMessage({
                sessionID: nextSession.id,
                description: params.description,
                state,
                text,
              }),
            },
          ],
        })
        yield* continueIfIdle({ userID: message.info.id, state })
      })

      const existing = yield* background.get(nextSession.id)
      if (existing?.status === "running") {
        return yield* Effect.fail(
          new Error(`Task ${nextSession.id} is already running. Use task_status to check progress.`),
        )
      }

      if (runInBackground) {
        const info = yield* background.start({
          id: nextSession.id,
          type: id,
          title: params.description,
          metadata,
          run: runTask().pipe(
            Effect.tap((text) => inject("completed", text).pipe(Effect.ignore)),
            Effect.catchCause((cause) =>
              (Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : inject("error", errorText(Cause.squash(cause))).pipe(Effect.ignore)
              ).pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          ),
        })

        return {
          title: params.description,
          metadata: {
            ...metadata,
            jobId: info.id,
          },
          output: backgroundOutput(nextSession.id),
        }
      }

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
            const text = yield* runTask()
            return {
              title: params.description,
              metadata,
              output: output(nextSession.id, text),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) yield* cancel
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
      description: flags.experimentalBackgroundSubagents ? DESCRIPTION + BACKGROUND_DESCRIPTION : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
