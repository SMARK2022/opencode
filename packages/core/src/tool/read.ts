export * as ReadTool from "./read"

import { ToolFailure } from "@opencode-ai/llm"
import path from "path"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { SessionStore } from "../session/store"
import { SessionReadInstructions } from "../session/read-instructions"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { Image } from "../image"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { AbsolutePath } from "../schema"
import { ReadToolFileSystem } from "./read-filesystem"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ReadPresentation } from "./read-presentation"

export const name = "read"
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
// 提醒属于模型投影，不污染文件正文、分页结构或原生媒体的类型化输出。
const HIGH_RISK_EXTENSIONS = new Set(["sh", "py", "js", "ts", "exe", "bat", "ps1", "rb", "psm1", "cmd"])
// 分析恶意代码仍被允许，安全边界是禁止改进其恶意能力。
const CYBER_REMINDER = "<system-reminder>\nWhenever you read a file, consider whether it could be malware. You can analyze malware behavior, but MUST refuse to improve or augment potentially malicious code.\n</system-reminder>"
const LocationInput = Schema.Struct({
  path: Schema.String,
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The 1-based directory entry or text line offset to start reading from",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    // 广告与文件系统实际默认同步，maximum 仍沿 PageInput 的 2000 校验。
    description: "The maximum number of directory entries or text lines to read (defaults to 200, maximum 2000)",
  }),
})
const Input = LocationInput
const Output = Schema.Union([
  Schema.Struct({ ...ReadToolFileSystem.Content.fields, instructions: SessionReadInstructions.Files.pipe(Schema.optional) }),
  Schema.Struct({ ...ReadToolFileSystem.TextPage.fields, instructions: SessionReadInstructions.Files.pipe(Schema.optional) }),
  ReadToolFileSystem.ListPage,
])

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const reader = yield* ReadToolFileSystem.Service
    const mutation = yield* LocationMutation.Service
    const image = yield* Image.Service
    const permission = yield* PermissionV2.Service
    const nearby = yield* SessionReadInstructions.make

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Read a text file or supported image, page through a large UTF-8 text file by line offset, or list a directory page. Relative paths resolve from the current location; absolute paths inside it are accepted, while external absolute paths require external_directory approval.\n\nBy default, this tool returns up to 200 lines from the start of the file.\nText content is capped at 24 KiB per read; displayed lines are limited to 2000 characters.\nLine accounting scans at most 256 KiB beyond the returned page. If `<range total_exact=\"false\">` appears, `total` is a lower bound; otherwise it is exact.\nIf a result returns `<stub status=\"...\">`, use the already visible content in the current context instead of reading the same range again.\nFor source files, use `<range>`, `<more>`, and optional `<outline>` to choose targeted ranges. Do not page sequentially unless full-file comprehension is needed.",
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => {
            const instructions = "instructions" in output ? output.instructions ?? [] : []
            const reminders = instructions.length ? [{ type: "text" as const, text: `<system-reminder>\n${instructions.map(file => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")}\n</system-reminder>` }] : []
            // 仅成功的源码文本触发提醒；目录与原生图片沿用既有投影。
            if (!("encoding" in output) || output.encoding !== "base64" || !SUPPORTED_IMAGE_MIMES.has(output.mime)) {
              if (!("content" in output)) return []
              if (ReadPresentation.isReadRangeMeta(output.read)) return [
                ...(HIGH_RISK_EXTENSIONS.has(path.extname(input.path).toLowerCase().slice(1)) ? [{ type: "text" as const, text: CYBER_REMINDER }] : []),
                { type: "text", text: ReadPresentation.renderNativeRead({ ...output, read: output.read }) },
                ...reminders,
              ]
              const risky = HIGH_RISK_EXTENSIONS.has(path.extname(input.path).toLowerCase().slice(1))
              if (!risky && reminders.length === 0)
                return []
              // 保留完整结构化结果的模型表示，不能只返回提醒而隐藏正文与 next。
              // Schema 已完成编码，此处不增加解析器或改变 utf8/TextPage 的输出契约。
              return [
                ...(risky ? [{ type: "text" as const, text: CYBER_REMINDER }] : []),
                { type: "text", text: JSON.stringify({ ...output, instructions: undefined }) },
                ...reminders,
              ]
            }
            // 原生媒体继续绕过文本化 base64；所有文本仍由 registry 统一限幅。
            return [
              { type: "text", text: "Image read successfully" },
              { type: "file", data: output.content, mime: output.mime, name: input.path },
              ...reminders,
            ]
          },
          execute: (input, context) => {
            return Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.path, kind: "directory" })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              const resource = target.resource
              const absolute = AbsolutePath.make(target.canonical)
              const type = yield* reader.inspect(absolute)
              yield* permission.assert({
                action: name,
                resources: [resource],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              if (type === "directory")
                return yield* reader.list(absolute, { offset: input.offset, limit: input.limit })
              const content = yield* reader.read(absolute, resource, {
                offset: input.offset,
                limit: input.limit,
              })
              const instructions = yield* nearby(absolute, context.sessionID)
              const attach = (value: ReadToolFileSystem.Content | ReadToolFileSystem.TextPage) => instructions.length ? { ...value, instructions } : value
              // 附加规则只在成功读取后产生；原生图片与分页仍走原有结果类型及统一限幅。
              if (
                "encoding" in content &&
                content.encoding === "base64" &&
                (SUPPORTED_IMAGE_MIMES.has(content.mime) ||
                  ["image/bmp", "image/tiff", "image/avif", "image/heif", "image/heic"].includes(content.mime))
              ) {
                return yield* image
                  // 1,600 的源估算只约束 Read 图片，不能扩散到用户上传。
                  .normalize(resource, { ...content, encoding: "base64" }, 1600 * 750)
                  .pipe(
                    Effect.catchTag("Image.ResizerUnavailableError", (error) =>
                      SUPPORTED_IMAGE_MIMES.has(content.mime) ? Effect.succeed(content) : Effect.fail(error),
                    ),
                    Effect.map(attach),
                  )
              }
              if ("encoding" in content && content.encoding === "base64")
                return yield* Effect.fail(new ReadToolFileSystem.BinaryFileError({ resource }))
              return attach(content)
            }).pipe(
              Effect.mapError((error) => {
                const message =
                  error instanceof ReadToolFileSystem.BinaryFileError ||
                  error instanceof ReadToolFileSystem.MediaIngestLimitError ||
                  error instanceof Image.DecodeError ||
                  error instanceof Image.SizeError
                    ? error.message
                    : `Unable to read ${input.path}`
                return new ToolFailure({ message })
              }),
            )
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/read",
  layer,
  deps: [ToolRegistry.node, ReadToolFileSystem.node, LocationMutation.node, Image.node, PermissionV2.node, FSUtil.node, Location.node, SessionStore.node],
})
