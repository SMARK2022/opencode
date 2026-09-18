import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Session } from "@/session/session"
import { getEndpointStatus } from "@/server/shared/tui-endpoint-status"
import { Effect, FileSystem, Layer } from "effect"
import { HttpIncomingMessage } from "effect/unstable/http"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { SessionActivity } from "@/session/activity"
import { resolveVoiceTarget, transcribeVoiceFile } from "@/server/shared/tui-control"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { nextTuiRequest, submitTuiResponse } from "@/server/shared/tui-control"
import { InstanceHttpApi } from "../api"
import { CommandPayload, ProviderEndpointStatusQuery, TuiPublishPayload, VoiceError, VoiceUpload } from "../groups/tui"
import * as SessionError from "./session-errors"

const commandAliases = {
  session_new: "session.new",
  session_share: "session.share",
  session_interrupt: "session.interrupt",
  session_compact: "session.compact",
  messages_page_up: "session.page.up",
  messages_page_down: "session.page.down",
  messages_line_up: "session.line.up",
  messages_line_down: "session.line.down",
  messages_half_page_up: "session.half.page.up",
  messages_half_page_down: "session.half.page.down",
  messages_first: "session.first",
  messages_last: "session.last",
  agent_cycle: "agent.cycle",
} as const

export const tuiHandlers = HttpApiBuilder.group(InstanceHttpApi, "tui", (handlers) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const session = yield* Session.Service
    const publishCommand = (command: typeof TuiEvent.CommandExecute.properties.Type.command | undefined) =>
      bus.publish(TuiEvent.CommandExecute, { command } as typeof TuiEvent.CommandExecute.properties.Type)

    const appendPrompt = Effect.fn("TuiHttpApi.appendPrompt")(function* (ctx: {
      payload: typeof TuiEvent.PromptAppend.properties.Type
    }) {
      yield* bus.publish(TuiEvent.PromptAppend, ctx.payload)
      return true
    })

    const openHelp = Effect.fn("TuiHttpApi.openHelp")(function* () {
      yield* publishCommand("help.show")
      return true
    })

    const openSessions = Effect.fn("TuiHttpApi.openSessions")(function* () {
      yield* publishCommand("session.list")
      return true
    })

    const openThemes = Effect.fn("TuiHttpApi.openThemes")(function* () {
      yield* publishCommand("session.list")
      return true
    })

    const openModels = Effect.fn("TuiHttpApi.openModels")(function* () {
      yield* publishCommand("model.list")
      return true
    })

    const submitPrompt = Effect.fn("TuiHttpApi.submitPrompt")(function* () {
      yield* publishCommand("prompt.submit")
      return true
    })

    const clearPrompt = Effect.fn("TuiHttpApi.clearPrompt")(function* () {
      yield* publishCommand("prompt.clear")
      return true
    })

    const executeCommand = Effect.fn("TuiHttpApi.executeCommand")(function* (ctx: {
      payload: typeof CommandPayload.Type
    }) {
      // Legacy only publishes known aliases; unknown commands become undefined.
      yield* publishCommand(commandAliases[ctx.payload.command as keyof typeof commandAliases])
      return true
    })

    const showToast = Effect.fn("TuiHttpApi.showToast")(function* (ctx: {
      payload: typeof TuiEvent.ToastShow.properties.Type
    }) {
      yield* bus.publish(TuiEvent.ToastShow, ctx.payload)
      return true
    })

    const publish = Effect.fn("TuiHttpApi.publish")(function* (ctx: { payload: typeof TuiPublishPayload.Type }) {
      if (ctx.payload.type === TuiEvent.PromptAppend.type)
        yield* bus.publish(TuiEvent.PromptAppend, ctx.payload.properties)
      if (ctx.payload.type === TuiEvent.CommandExecute.type)
        yield* bus.publish(TuiEvent.CommandExecute, ctx.payload.properties)
      if (ctx.payload.type === TuiEvent.ToastShow.type) yield* bus.publish(TuiEvent.ToastShow, ctx.payload.properties)
      if (ctx.payload.type === TuiEvent.SessionSelect.type)
        yield* bus.publish(TuiEvent.SessionSelect, ctx.payload.properties)
      return true
    })

    const selectSession = Effect.fn("TuiHttpApi.selectSession")(function* (ctx: {
      payload: typeof TuiEvent.SessionSelect.properties.Type
    }) {
      if (!ctx.payload.sessionID.startsWith("ses")) return yield* new HttpApiError.BadRequest({})
      yield* SessionError.mapStorageNotFound(session.get(ctx.payload.sessionID))
      yield* bus.publish(TuiEvent.SessionSelect, ctx.payload)
      return true
    })

    const providerEndpointStatus = Effect.fn("TuiHttpApi.providerEndpointStatus")(function* (ctx: {
      query: typeof ProviderEndpointStatusQuery.Type
    }) {
      // 这里刻意只接受可规范化的 HTTP(S) origin。TUI 传入的是当前模型的
      // provider endpoint；daemon 返回自身网络环境下的 route/latency，避免
      // 多 TUI 进程各自读取 env proxy 后出现显示和真实请求不一致。
      const status = yield* Effect.promise(() => getEndpointStatus(ctx.query.url))
      if (!status) return yield* new HttpApiError.BadRequest({})
      return status
    })

    const controlNext = Effect.fn("TuiHttpApi.controlNext")(function* () {
      return yield* Effect.promise(() => nextTuiRequest())
    })

    const controlResponse = Effect.fn("TuiHttpApi.controlResponse")(function* (ctx: { payload: unknown }) {
      submitTuiResponse(ctx.payload)
      return true
    })

    return handlers
      // HTTP 只传音频字节；临时文件在 daemon 创建，使远程 attach 与本地 TUI 采用同一路径。
      .handle("voiceTranscribe", ({ payload }) => Effect.callback<{ text: string }, VoiceError>((resume, signal) => {
        const id = randomUUID()
        const file = path.join(os.tmpdir(), "opencode", "voice", `${id}.wav`)
        const operation = (async () => {
          signal.throwIfAborted()
          // activity 覆盖配置解析、等锁及收尾，后台空闲回收以实际操作寿命为准。
          const release = SessionActivity.begin(`voice:${id}`)
          try {
            const target = await resolveVoiceTarget()
            signal.throwIfAborted()
            // 目录与 browser-agent 的默认语音准入一致，路径由本次请求持有。
            await fs.mkdir(path.dirname(file), { recursive: true })
            await fs.writeFile(file, payload)
            signal.throwIfAborted()
            // 字节写入完成后才进入锁内转录，返回前再次检查整轮取消。
            const text = await transcribeVoiceFile(file, target, signal)
            signal.throwIfAborted()
            return { text }
          } finally {
            // 清理归原操作所有，即使删除文件失败也释放本次 activity。
            try { await fs.rm(file, { force: true }) }
            finally { release() }
          }
        })()
        // Promise 结果只交付一次；取消 finalizer 继续等待这份 operation，而非另起任务。
        void operation.then(
          (value) => resume(Effect.succeed(value)),
          (error) => resume(Effect.fail(new VoiceError({ message: error instanceof Error ? error.message : String(error) }))),
        )
        // 客户端 close 先 abort signal；finalizer 等待原操作收尾，文件和 activity 与工作同寿命。
        return Effect.promise(() => operation.then(() => undefined, () => undefined))
      }))
      .handle("appendPrompt", appendPrompt)
      .handle("openHelp", openHelp)
      .handle("openSessions", openSessions)
      .handle("openThemes", openThemes)
      .handle("openModels", openModels)
      .handle("submitPrompt", submitPrompt)
      .handle("clearPrompt", clearPrompt)
      .handle("executeCommand", executeCommand)
      .handle("showToast", showToast)
      .handle("publish", publish)
      .handle("selectSession", selectSession)
      .handle("providerEndpointStatus", providerEndpointStatus)
      .handle("controlNext", controlNext)
      .handle("controlResponse", controlResponse)
  }),
).pipe(Layer.provide(Layer.succeed(VoiceUpload, VoiceUpload.of((effect) =>
  // 50MiB 与现有 MCP WAV 限额相同，大小限制作用于解码而非事后检查。
  effect.pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(50 * 1024 * 1024))),
))))
