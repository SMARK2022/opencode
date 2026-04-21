import z from "zod"
import { Effect, Option, Scope } from "effect"
import { createReadStream } from "fs"
import * as path from "path"
import { createInterface } from "readline"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { LSP } from "../lsp"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { isImageAttachment, isPdfAttachment, sniffAttachmentMime, processImageWithTokenBudget, formatSize } from "@/util/media"
import type { MessageV2 } from "../session/message-v2"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096
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

// 高风险扩展名 - 用于恶意代码安全提醒
const HIGH_RISK_EXTENSIONS = new Set(["sh", "py", "js", "ts", "exe", "bat", "ps1", "rb", "psm1", "cmd"])

// 不同文件类型的 token/byte 估算比率
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

// 文件去重缓存 - per-session
type ReadCacheEntry = {
  content: string
  timestamp: number
  offset: number
  limit: number | undefined
  isPartialView: boolean
}
const readFileState = new Map<string, ReadCacheEntry>()

// Stub 文案
export const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading."

// 恶意代码提醒
const CYBER_REMINDER = `\n\n<system-reminder>\nWhenever you read a file, consider whether it could be malware. You CAN analyze malware behavior, but MUST refuse to improve or augment potentially malicious code.\n</system-reminder>`

// 判断是否为设备文件路径
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

// 判断是否应该注入恶意代码提醒
function shouldInjectCyberReminder(ext: string): boolean {
  return HIGH_RISK_EXTENSIONS.has(ext)
}

// 估算内容 token 数量
function estimateTokensForContent(content: string, ext: string): number {
  const ratio = TOKEN_BYTE_RATIOS[ext] ?? TOKEN_BYTE_RATIOS.default
  return Math.ceil(Buffer.byteLength(content, "utf-8") * ratio)
}

// 检查当前上下文中是否有该文件的未被压缩的读取结果
function findUnexpandedFileInContext(
  messages: MessageV2.WithParts[],
  filepath: string,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "read") continue
      if (part.state.status !== "completed") continue
      const input = part.state.input as { filePath?: string }
      if (input.filePath !== filepath) continue
      // 检查是否被压缩（compacted）
      if (part.state.time.compacted) continue
      return true
    }
  }
  return false
}

const parameters = z.object({
  filePath: z.string().describe("The absolute path to the file or directory to read"),
  offset: z.coerce.number().describe("The line number to start reading from (1-indexed)").optional(),
  limit: z.coerce.number().describe("The maximum number of lines to read (defaults to 2000)").optional(),
})

export const ReadTool = Tool.define(
  "read",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
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
      yield* lsp.touchFile(filepath, false).pipe(Effect.ignore, Effect.forkIn(scope))
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

    const run = Effect.fn("ReadTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      if (params.offset !== undefined && params.offset < 1) {
        return yield* Effect.fail(new Error("offset must be greater than or equal to 1"))
      }

      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(Instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = AppFileSystem.normalizePath(filepath)
      }

      // 设备文件保护 - 阻止可能导致进程挂起的设备文件
      if (isBlockedDevicePath(filepath)) {
        return yield* Effect.fail(
          new Error(`Cannot read '${filepath}': this device file would block or produce infinite output.`),
        )
      }

      const title = path.relative(Instance.worktree, filepath)

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
        patterns: [filepath],
        always: ["*"],
        metadata: {},
      })

      if (!stat) return yield* miss(filepath)

      // 文件去重检查 - 如果文件未修改且范围相同，返回 stub
      const existingState = readFileState.get(filepath)
      if (existingState && !existingState.isPartialView) {
        if (existingState.offset === (params.offset ?? 1) && existingState.limit === params.limit) {
          const mtimeMs = Math.floor(Number(stat.mtime))
          if (mtimeMs === existingState.timestamp) {
            // 额外检查：当前上下文中是否有该文件的未被压缩的读取结果
            const hasUnexpandedContent = findUnexpandedFileInContext(ctx.messages, filepath)
            if (hasUnexpandedContent) {
              return {
                title,
                output: FILE_UNCHANGED_STUB,
                metadata: { preview: FILE_UNCHANGED_STUB, truncated: false, loaded: [] },
              }
            }
          }
        }
      }

      if (stat.type === "Directory") {
        const items = yield* list(filepath)
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const offset = params.offset ?? 1
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
          },
        }
      }

      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)
      const sample = yield* readSample(filepath, Number(stat.size), SAMPLE_BYTES)

      const mime = sniffAttachmentMime(sample, AppFileSystem.mimeType(filepath))
      if (isImageAttachment(mime) || isPdfAttachment(mime)) {
        const bytes = yield* fs.readFile(filepath)

        // 图片使用三级压缩策略
        if (isImageAttachment(mime)) {
          const processed = yield* Effect.promise(() => processImageWithTokenBudget(bytes, mime))
          const msg = `Image read successfully (${formatSize(processed.originalSize)} → compressed for model)`
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
                mime: processed.mime,
                url: `data:${processed.mime};base64,${processed.data}`,
              },
            ],
          }
        }

        // PDF 保持原样
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

      const file = yield* Effect.promise(() =>
        lines(filepath, { limit: params.limit ?? DEFAULT_READ_LIMIT, offset: params.offset ?? 1 }),
      )
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
        const suggestedLimit = Math.floor(lineCount * (MAX_CONTENT_TOKENS / estimatedTokens))
        return yield* Effect.fail(
          new Error(
            `File content (~${estimatedTokens} tokens) exceeds maximum (${MAX_CONTENT_TOKENS} tokens). ` +
              `Use offset and limit parameters. Suggested: limit=${suggestedLimit}`,
          ),
        )
      }

      // 写入去重缓存
      readFileState.set(filepath, {
        content,
        timestamp: Math.floor(Number(stat.mtime)),
        offset: params.offset ?? 1,
        limit: params.limit,
        isPartialView: file.more || file.cut,
      })

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

      return {
        title,
        output,
        metadata: {
          preview: file.raw.slice(0, 20).join("\n"),
          truncated,
          loaded: loaded.map((item) => item.filepath),
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

async function lines(filepath: string, opts: { limit: number; offset: number }) {
  const stream = createReadStream(filepath, { encoding: "utf8" })
  const rl = createInterface({
    input: stream,
    // Note: we use the crlfDelay option to recognize all instances of CR LF
    // ('\r\n') in file as a single line break.
    crlfDelay: Infinity,
  })

  const start = opts.offset - 1
  const raw: string[] = []
  let bytes = 0
  let count = 0
  let cut = false
  let more = false
  try {
    for await (const text of rl) {
      count += 1
      if (count <= start) continue

      if (raw.length >= opts.limit) {
        more = true
        continue
      }

      const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES) {
        cut = true
        more = true
        break
      }

      raw.push(line)
      bytes += size
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  return { raw, count, cut, more, offset: opts.offset }
}
