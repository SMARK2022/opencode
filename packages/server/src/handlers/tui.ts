import { Effect, FileSystem, Layer } from "effect"
import { HttpIncomingMessage } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { transcribeVoiceUpload } from "@opencode-ai/core/voice"
import { VoiceError, VoiceUpload } from "@opencode-ai/protocol/groups/tui"
import { Api } from "../api"

export const TuiHandler = HttpApiBuilder.group(Api, "server.tui", (handlers) =>
  handlers.handle("tui.voiceTranscribe", ({ payload }) =>
    Effect.callback<{ text: string }, VoiceError>((resume, signal) => {
      // 与V1调用同一操作；取消后仍等待临时文件、进程和配置锁原地收尾。
      const operation = transcribeVoiceUpload(payload, signal)
      void operation.then(
        (value) => resume(Effect.succeed(value)),
        (error) =>
          resume(Effect.fail(new VoiceError({ message: error instanceof Error ? error.message : String(error) }))),
      )
      // 不以abort即返回冒充操作完成，避免下一请求抢在锁或WAV清理之前开始。
      return Effect.promise(() =>
        operation.then(
          () => undefined,
          () => undefined,
        ),
      )
    }),
  ),
).pipe(
  Layer.provide(
    Layer.succeed(
      VoiceUpload,
      VoiceUpload.of((effect) =>
        // 限额作用于解码过程，不先把任意大的上传装进内存再拒绝。
        effect.pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(50 * 1024 * 1024))),
      ),
    ),
  ),
)
