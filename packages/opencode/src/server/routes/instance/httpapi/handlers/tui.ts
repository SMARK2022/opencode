import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { Session } from "@/session/session"
import { Effect, FileSystem, Layer } from "effect"
import { HttpIncomingMessage } from "effect/unstable/http"
import { randomUUID } from "crypto"
import { SessionActivity } from "@/session/activity"
import { nextTuiRequest, submitTuiResponse, transcribeVoiceUpload } from "@/server/shared/tui-control"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { getEndpointStatus } from "@/server/shared/tui-endpoint-status"
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
    const events = yield* EventV2Bridge.Service
    const session = yield* Session.Service
    const publishCommand = (command: typeof TuiEvent.CommandExecute.data.Type.command | undefined) =>
      events.publish(TuiEvent.CommandExecute, { command } as typeof TuiEvent.CommandExecute.data.Type)

    const appendPrompt = Effect.fn("TuiHttpApi.appendPrompt")(function* (ctx: {
      payload: typeof TuiEvent.PromptAppend.data.Type
    }) {
      yield* events.publish(TuiEvent.PromptAppend, ctx.payload)
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
      payload: typeof TuiEvent.ToastShow.data.Type
    }) {
      yield* events.publish(TuiEvent.ToastShow, ctx.payload)
      return true
    })

    const publish = Effect.fn("TuiHttpApi.publish")(function* (ctx: { payload: typeof TuiPublishPayload.Type }) {
      if (ctx.payload.type === TuiEvent.PromptAppend.type)
        yield* events.publish(TuiEvent.PromptAppend, ctx.payload.properties)
      if (ctx.payload.type === TuiEvent.CommandExecute.type)
        yield* events.publish(TuiEvent.CommandExecute, ctx.payload.properties)
      if (ctx.payload.type === TuiEvent.ToastShow.type)
        yield* events.publish(TuiEvent.ToastShow, ctx.payload.properties)
      if (ctx.payload.type === TuiEvent.SessionSelect.type)
        yield* events.publish(TuiEvent.SessionSelect, ctx.payload.properties)
      return true
    })

    const selectSession = Effect.fn("TuiHttpApi.selectSession")(function* (ctx: {
      payload: typeof TuiEvent.SessionSelect.data.Type
    }) {
      if (!ctx.payload.sessionID.startsWith("ses")) return yield* new HttpApiError.BadRequest({})
      yield* SessionError.mapStorageNotFound(session.get(ctx.payload.sessionID))
      yield* events.publish(TuiEvent.SessionSelect, ctx.payload)
      return true
    })

    const providerEndpointStatus = Effect.fn("TuiHttpApi.providerEndpointStatus")(function* (ctx: {
      query: typeof ProviderEndpointStatusQuery.Type
    }) {
      // #258：这里刻意只接受可规范化的 HTTP(S) origin。TUI 传入的是当前模型的
      // provider endpoint；daemon 返回自身网络环境下的 route/latency，避免
      // 多 TUI 进程各自读取 env proxy 后出现显示和真实请求不一致。
      const status = yield* Effect.promise(() => getEndpointStatus(ctx.query.url))
      if (!status) return yield* new HttpApiError.BadRequest({})
      // #258：normalizeEndpoint 返回 undefined（非 http/https URL）时统一 400——不泄漏内部解析细节
      return status
    })

    const controlNext = Effect.fn("TuiHttpApi.controlNext")(function* () {
      return yield* Effect.promise(() => nextTuiRequest())
    })

    const controlResponse = Effect.fn("TuiHttpApi.controlResponse")(function* (ctx: { payload: unknown }) {
      submitTuiResponse(ctx.payload)
      return true
    })

    // 两代共用文件与转录事务；V1仅保留其空闲回收所需的activity生命周期。
    const voiceTranscribe = (ctx: { payload: Uint8Array }) =>
      Effect.callback<{ text: string }, VoiceError>((resume, signal) => {
        const release = SessionActivity.begin(`voice:${randomUUID()}`)
        const operation = transcribeVoiceUpload(ctx.payload, signal).finally(release)
        // Promise 结果只交付一次；取消 finalizer 继续等待这份 operation，而非另起任务。
        void operation.then(
          (value) => resume(Effect.succeed(value)),
          (error) => resume(Effect.fail(new VoiceError({ message: error instanceof Error ? error.message : String(error) }))),
        )
        // 客户端 close 先 abort signal；finalizer 等待原操作收尾，文件和 activity 与工作同寿命。
        return Effect.promise(() => operation.then(() => undefined, () => undefined))
      })

    return handlers
      .handle("voiceTranscribe", voiceTranscribe)
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
).pipe(
  Layer.provide(
    Layer.succeed(
      VoiceUpload,
      VoiceUpload.of((effect) =>
        // 50MiB 与现有 MCP WAV 限额相同，大小限制作用于解码而非事后检查。
        effect.pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(50 * 1024 * 1024))),
      ),
    ),
  ),
)
