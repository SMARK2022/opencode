import { Message, type ToolContent } from "@opencode-ai/llm"
import { Effect } from "effect"
import { Image } from "../../image"

// 模型交付复用Location解码策略；原始admission不变，不能因图片规整破坏exact retry。
export const normalizeImages = Effect.fn("SessionRunner.normalizeImages")(function* (
  messages: ReadonlyArray<Message>,
  image: Image.Interface,
) {
  const normalize = (file: ToolContent): Effect.Effect<ToolContent> => {
    if (file.type !== "file" || !file.mime.startsWith("image/") || !file.uri.startsWith("data:"))
      return Effect.succeed(file)
    const marker = file.uri.indexOf(";base64,")
    // 仅消费已在输入中的bytes；不下载远程URI，不额外读取文件或切换decoder。
    return image
      .normalize(file.name ?? "image attachment", {
        ...file,
        encoding: "base64",
        content: marker < 0 ? "" : file.uri.slice(marker + 8),
      })
      .pipe(
        Effect.map((content) => ({
          ...file,
          mime: content.mime,
          uri: `data:${content.mime};base64,${content.content}`,
        })),
        Effect.catch(() =>
          Effect.succeed({
            type: "text" as const,
            text: "Image omitted: could not be decoded or resized within the image size limit.",
          }),
        ),
      )
  }
  // 只替换媒体payload，消息身份、角色、工具调用及其他原话均原样传递。
  return yield* Effect.forEach(messages, (message) =>
    Effect.gen(function* () {
      const content = yield* Effect.forEach(message.content, (part) =>
        Effect.gen(function* () {
          if (part.type === "media" && part.mediaType.startsWith("image/")) {
            const uri =
              typeof part.data === "string"
                ? part.data
                : `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`
            const file = yield* normalize({ type: "file", uri, mime: part.mediaType, name: part.filename })
            return file.type === "text" ? file : { ...part, mediaType: file.mime, data: file.uri }
          }
          // 通用工具和provider已完成结果共用同一逐文件政策，坏图不抹掉其他正文或伪造失败。
          if (part.type === "tool-result" && part.result.type === "content") {
            const files: ReadonlyArray<ToolContent> = part.result.value
            const value = yield* Effect.forEach(files, normalize)
            return { ...part, result: { type: "content" as const, value } }
          }
          return part
        }),
      )
      return Message.make({ ...message, content })
    }),
  )
})
