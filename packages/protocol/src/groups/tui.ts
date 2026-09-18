import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

// 两代在二进制解码前提供同一限额服务，凭据错误仍是明确的502。
export class VoiceUpload extends HttpApiMiddleware.Service<VoiceUpload>()("@opencode/VoiceUpload") {}
export class VoiceError extends Schema.ErrorClass<VoiceError>("VoiceError")({ message: Schema.String }, { httpApiStatus: 502 }) {}

export const TuiGroup = HttpApiGroup.make("server.tui")
  .add(
    // 组合服务器同时挂载V1与Native API；保留旧TUI路径，Native入口使用独立命名空间。
    HttpApiEndpoint.post("tui.voiceTranscribe", "/api/tui/voice/transcribe", {
      query: { directory: Schema.optional(Schema.String) },
      payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "audio/wav" })),
      success: Schema.Struct({ text: Schema.String }),
      error: VoiceError,
    })
      .middleware(VoiceUpload)
      .annotateMerge(OpenApi.annotations({
        identifier: "v2.tui.voiceTranscribe",
        summary: "Transcribe a TUI voice recording",
        description: "Upload one WAV recording and return its daemon-side transcription.",
      })),
  )
  .annotateMerge(OpenApi.annotations({ title: "tui", description: "TUI daemon operations." }))
