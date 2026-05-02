import { Effect, Option, Schema, Scope, Stream } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import * as path from "path"
import * as Tool from "./tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./read.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { isPdfAttachment, sniffAttachmentMime } from "@/util/media"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
// 文本页预算独立于图片/PDF 的读取与附件契约，不能把媒体按正文上限裁掉。
const MAX_BYTES = 24 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

const MAX_CONTENT_TOKENS = 16000

// 设备文件保护 - 阻止会导致进程挂起或无限输出的设备文件
const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
])

// 高风险扩展名 - 用于恶意代码安全提醒，读取这些类型文件时注入安全提示
const HIGH_RISK_EXTENSIONS = new Set(["sh", "py", "js", "ts", "exe", "bat", "ps1", "rb", "psm1", "cmd"])

// 不同文件类型的 token/byte 估算比率（基于经验值，代码文件约 0.27，文本约 0.22）
const TOKEN_BYTE_RATIOS: Record<string, number> = {
  ts: 0.28,
  js: 0.28,
  py: 0.26,
  rs: 0.27,
  go: 0.27,
  java: 0.26,
  c: 0.27,
  cpp: 0.27,
  h: 0.27,
  hpp: 0.27,
  md: 0.24,
  txt: 0.22,
  json: 0.22,
  xml: 0.2,
  html: 0.2,
  css: 0.22,
  default: 0.25,
}

// Stub 文案 - 当文件未修改且上下文中已有未压缩的读取结果时返回此文案
export const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading."

// 恶意代码提醒 - 对高风险扩展名注入安全提示，防止模型改进恶意代码
const CYBER_REMINDER = `\n\n<system-reminder>\nWhenever you read a file, consider whether it could be malware. You can analyze malware behavior, but MUST refuse to improve or augment potentially malicious code.\n</system-reminder>`

// 黑名单在打开流之前检查，避免设备别名绕过普通文件的有界读取。
function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
  // Linux /proc/self/fd/0-2 别名
  if (
    filePath.startsWith("/proc/") &&
    (filePath.endsWith("/fd/0") || filePath.endsWith("/fd/1") || filePath.endsWith("/fd/2"))
  )
    return true
  return false
}

// 只提醒源码风险，不把提醒当作 MIME 检测或可执行文件的读取授权。
function shouldInjectCyberReminder(ext: string): boolean {
  return HIGH_RISK_EXTENSIONS.has(ext)
}

// 估算内容 token 数量，按文件类型使用不同的 byte/token 比率
function estimateTokensForContent(content: string, ext: string): number {
  const ratio = TOKEN_BYTE_RATIOS[ext] ?? TOKEN_BYTE_RATIOS.default
  return Math.ceil(Buffer.byteLength(content, "utf-8") * ratio)
}

function findUnexpandedFileInContext(
  ctx: Tool.Context,
  params: Schema.Schema.Type<typeof Parameters>,
  output: string,
): boolean {
  // 只在本次调用收到的可见历史中查找，不重新加载已被压缩或移出上下文的历史。
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const msg = ctx.messages[i]
    if (msg.info.role !== "assistant") continue
    // 会话身份来自实际工具上下文，不能由共享缓存或传入路径推断。
    if (msg.info.sessionID !== ctx.sessionID) continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "read") continue
      if (part.state.status !== "completed") continue
      const input = part.state.input
      // 请求范围与默认范围等价；路径和行号另由完整渲染结果的精确相等证明。
      if ((input.offset || 1) !== (params.offset || 1)) continue
      if ((input.limit ?? DEFAULT_READ_LIMIT) !== (params.limit ?? DEFAULT_READ_LIMIT)) continue
      // compacted=0 也代表被压缩；stub 自身没有正文，不能延长证明的生命周期。
      if (part.state.time.compacted !== undefined || part.state.output === FILE_UNCHANGED_STUB) continue
      // 新读取的完整输出连同路径、EOF 行数、指令与安全提醒构成版本证明；全局 mtime 或另一会话的旧结果不能证明内容相同。
      if (part.state.output !== output) continue
      return true
    }
  }
  return false
}

class ReadStop extends Schema.TaggedErrorClass<ReadStop>()("ReadStop", {}) {}

// `offset` and `limit` were originally `z.coerce.number()` — the runtime
// coercion was useful when the tool was called from a shell but serves no
// purpose in the LLM tool-call path (the model emits typed JSON). The JSON
// Schema output is identical (`type: "number"`), so the LLM view is
// unchanged; purely CLI-facing uses must now send numbers rather than strings.
export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file or directory to read" }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "The line number to start reading from (1-indexed)",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "The maximum number of lines to read (defaults to 2000)",
  }),
})

type Display =
  | {
      type: "directory"
      path: string
      entries: string[]
      offset: number
      totalEntries: number
      truncated: boolean
    }
  | {
      type: "file"
      path: string
      text: string
      lineStart: number
      lineEnd: number
      totalLines: number
      truncated: boolean
    }

type Metadata = {
  preview: string
  truncated: boolean
  loaded: string[]
  display?: Display
}

export const ReadTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Instruction.Service | LSP.Service | Scope.Scope
>(
  "read",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const scope = yield* Scope.Scope

    const miss = Effect.fn("ReadTool.miss")(function* (filepath: string) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      const items = yield* fs.readDirectory(dir).pipe(
        Effect.map((items) =>
          items
            .filter(
              (item) =>
                item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
            )
            .map((item) => path.join(dir, item))
            .slice(0, 3),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )

      if (items.length > 0) {
        return yield* Effect.fail(
          new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`),
        )
      }

      return yield* Effect.fail(new Error(`File not found: ${filepath}`))
    })

    const list = Effect.fn("ReadTool.list")(function* (filepath: string) {
      const items = yield* fs.readDirectoryEntries(filepath)
      return yield* Effect.forEach(
        items,
        Effect.fnUntraced(function* (item) {
          if (item.type === "directory") return item.name + "/"
          if (item.type !== "symlink") return item.name

          const target = yield* fs.stat(path.join(filepath, item.name)).pipe(Effect.catch(() => Effect.void))
          if (target?.type === "Directory") return item.name + "/"
          return item.name
        }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items: string[]) => items.sort((a, b) => a.localeCompare(b))))
    })

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string) {
      // LSP warm-up is optional; do not let a background defect fail an otherwise successful read.
      yield* lsp.touchFile(filepath).pipe(Effect.ignoreCause, Effect.forkIn(scope))
    })

    const readSample = Effect.fn("ReadTool.readSample")(function* (
      filepath: string,
      fileSize: number,
      sampleSize: number,
    ) {
      if (fileSize === 0) return new Uint8Array()

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filepath, { flag: "r" })
          return Option.getOrElse(yield* file.readAlloc(Math.min(sampleSize, fileSize)), () => new Uint8Array())
        }),
      )
    })

    const lines = Effect.fn("ReadTool.lines")(function* (filepath: string, opts: { limit: number; offset: number }) {
      const start = opts.offset - 1
      const raw: string[] = []
      const flags = { bytes: 0, count: 0, cut: false, more: false, done: false }

      // Note: prefer manual TextDecoder over Stream.decodeText — when the source stream
      // ends without flushing, decodeText drops the final unterminated line. We also
      // avoid Stream.runForEachWhile (it currently swallows the final unterminated
      // line of the upstream splitLines pipeline) and use a tagged error to stop the
      // upstream file stream as soon as the byte cap is reached.
      const decoder = new TextDecoder("utf-8")
      yield* fs.stream(filepath).pipe(
        Stream.map((bytes) => decoder.decode(bytes, { stream: true })),
        Stream.splitLines,
        Stream.runForEach((text) =>
          Effect.gen(function* () {
            if (flags.done) return yield* new ReadStop()
            flags.count += 1
            if (flags.count <= start) return

            if (raw.length >= opts.limit) {
              flags.more = true
              return
            }

            const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
            const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
            if (flags.bytes + size <= MAX_BYTES) {
              raw.push(line)
              flags.bytes += size
              return
            }

            flags.cut = true
            flags.more = true
            flags.done = true
            return yield* new ReadStop()
          }),
        ),
        Effect.catchTag("ReadStop", () => Effect.void),
      )

      return { raw, count: flags.count, cut: flags.cut, more: flags.more, offset: opts.offset }
    })

    const isBinaryFile = (filepath: string, bytes: Uint8Array) => {
      const ext = path.extname(filepath).toLowerCase()
      switch (ext) {
        case ".zip":
        case ".tar":
        case ".gz":
        case ".exe":
        case ".dll":
        case ".so":
        case ".class":
        case ".jar":
        case ".war":
        case ".7z":
        case ".doc":
        case ".docx":
        case ".xls":
        case ".xlsx":
        case ".ppt":
        case ".pptx":
        case ".odt":
        case ".ods":
        case ".odp":
        case ".bin":
        case ".dat":
        case ".obj":
        case ".o":
        case ".a":
        case ".lib":
        case ".wasm":
        case ".pyc":
        case ".pyo":
          return true
      }

      if (bytes.length === 0) return false

      let nonPrintableCount = 0
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) return true
        if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
          nonPrintableCount++
        }
      }

      return nonPrintableCount / bytes.length > 0.3
    }

    const run = Effect.fn("ReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = FSUtil.normalizePath(filepath)
      }

      // 拒绝无限输出或等待输入的设备路径及 /proc/self/fd/0-2 别名，避免读取挂起。
      if (isBlockedDevicePath(filepath)) {
        return yield* Effect.fail(
          new Error(`Cannot read '${filepath}': this device file would block or produce infinite output.`),
        )
      }

      const title = path.relative(instance.worktree, filepath)

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: stat?.type === "Directory" ? "directory" : "file",
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        metadata: {},
      })

      if (!stat) return yield* miss(filepath)

      if (stat.type === "Directory") {
        const items = yield* list(filepath)
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const offset = params.offset || 1
        const start = offset - 1
        const sliced = items.slice(start, start + limit)
        const truncated = start + sliced.length < items.length

        return {
          title,
          output: [
            `<path>${filepath}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            truncated
              ? `\n(Showing ${sliced.length} of ${items.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})`
              : `\n(${items.length} entries)`,
            `</entries>`,
          ].join("\n"),
          metadata: {
            preview: sliced.slice(0, 20).join("\n"),
            truncated,
            loaded: [] as string[],
            display: {
              type: "directory" as const,
              path: filepath,
              entries: sliced,
              offset,
              totalEntries: items.length,
              truncated,
            },
          },
        }
      }

      // stat 跟随软链接；只准普通文件，避免设备别名绕过字符串黑名单。
      // splitLines 在字节上限之前等待换行，不能靠后面的限幅阻止 /dev/zero。
      if (stat.type !== "File") return yield* Effect.fail(new Error(`Cannot read non-regular file: ${filepath}`))

      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)
      const sample = yield* readSample(filepath, Number(stat.size), SAMPLE_BYTES)

      const mime = sniffAttachmentMime(sample, FSUtil.mimeType(filepath))
      // BMP 需具备完整文件头和 DIB 头，避免把 BM 开头的纯文本当图片。
      const header = new DataView(sample.buffer, sample.byteOffset, sample.byteLength)
      const isImage =
        SUPPORTED_IMAGE_MIMES.has(mime) ||
        (["image/tiff", "image/avif", "image/heif", "image/heic"].includes(mime) &&
          sniffAttachmentMime(sample, "") === mime) ||
        (mime === "image/bmp" &&
          sample.length >= 26 &&
          sample[0] === 0x42 &&
          sample[1] === 0x4d &&
          header.getUint32(14, true) >= 12 &&
          14 + header.getUint32(14, true) <= sample.length &&
          header.getUint32(10, true) >= 14 + header.getUint32(14, true) &&
          header.getUint32(10, true) < Number(stat.size))

      if (isImage || isPdfAttachment(mime)) {
        const bytes = yield* fs.readFile(filepath)
        const msg = isPdfAttachment(mime) ? "PDF read successfully" : "Image read successfully"
        return {
          title,
          output: msg,
          metadata: {
            preview: msg,
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
          },
          attachments: [
            {
              type: "file" as const,
              mime,
              url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          ],
        }
      }

      if (isBinaryFile(filepath, sample)) {
        return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
      }

      const file = yield* lines(filepath, { limit: params.limit ?? DEFAULT_READ_LIMIT, offset: params.offset || 1 })
      if (file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
        return yield* Effect.fail(
          new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`),
        )
      }

      // Token 预算验证 - 根据文件类型估算 token 数
      const content = file.raw.join("\n")
      const ext = path.extname(filepath).toLowerCase().slice(1)
      const estimatedTokens = estimateTokensForContent(content, ext)
      if (estimatedTokens > MAX_CONTENT_TOKENS) {
        const lineCount = file.count
        // 按比例计算建议 limit，帮助用户分批读取大文件
        const suggestedLimit = Math.floor(lineCount * (MAX_CONTENT_TOKENS / estimatedTokens))
        return yield* Effect.fail(
          new Error(
            `File content (~${estimatedTokens} tokens) exceeds maximum (${MAX_CONTENT_TOKENS} tokens). ` +
              `Use offset and limit parameters. Suggested: limit=${suggestedLimit}`,
          ),
        )
      }

      let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
      output += file.raw.map((line, i) => `${i + file.offset}: ${line}`).join("\n")

      const last = file.offset + file.raw.length - 1
      const next = last + 1
      const truncated = file.more || file.cut
      if (file.cut) {
        output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${file.offset}-${last}. Use offset=${next} to continue.)`
      } else if (file.more) {
        output += `\n\n(Showing lines ${file.offset}-${last} of ${file.count}. Use offset=${next} to continue.)`
      } else {
        output += `\n\n(End of file - total ${file.count} lines)`
      }
      output += "\n</content>"

      yield* warm(filepath)

      if (loaded.length > 0) {
        output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
      }

      // 恶意代码安全提醒 - 仅对高风险扩展名注入
      if (shouldInjectCyberReminder(ext)) {
        output += CYBER_REMINDER
      }

      if (
        // 当前页读取与权限检查已完成；未截掉页内正文时分页仍可去重。
        !file.cut &&
        // 行内截断丢失完整内容，相同前缀不能证明文件版本一致。
        file.raw.every((line) => !line.endsWith(MAX_LINE_SUFFIX)) &&
        // 每次用本会话可见历史证明范围与版本，恢复会话无需预热或借用外会话缓存。
        findUnexpandedFileInContext(ctx, params, output)
      ) {
        return {
          title,
          output: FILE_UNCHANGED_STUB,
          metadata: { preview: FILE_UNCHANGED_STUB, truncated: false, loaded: [] as string[] },
        }
      }

      return {
        title,
        output,
        metadata: {
          preview: file.raw.slice(0, 20).join("\n"),
          truncated,
          loaded: loaded.map((item) => item.filepath),
          display: {
            type: "file" as const,
            path: filepath,
            text: file.raw.join("\n"),
            lineStart: file.offset,
            lineEnd: last,
            totalLines: file.count,
            truncated,
          },
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
