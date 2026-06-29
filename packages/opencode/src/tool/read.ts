import { Effect, Option, Schema, Scope } from "effect"
import { createReadStream } from "fs"
import { createInterface } from "readline"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import * as path from "path"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./read.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
// [local-smark] read tool enhancements: image processing, outline
import { isImageAttachment, isPdfAttachment, sniffAttachmentMime, formatSize } from "@/util/media"
import type { MessageV2 } from "../session/message-v2"
import { readOutline, readOutlineCached, type Outline } from "./read-outline"
import { Reference } from "@/reference/reference"
import { Image } from "@/image/image"
import { PartID } from "@/session/schema"

const DEFAULT_READ_LIMIT = 200
const MAX_BYTES = 16 * 1024
const SAMPLE_BYTES = 4096
const MAX_CONTENT_TOKENS = 16000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const OVERLAP_MIN_LINES = 20
const OVERLAP_MIN_RATIO = 0.3
// [local-smark] 高重叠 suppress 阈值：当已可见读取与当前请求的重叠率 >= 80% 时，
// 直接返回 stub（而非仅 note），避免大量部分重叠的重复读取。
// 仍走 size+modifiedMs 同版本门控（findOverlapNote 内部已检查）。
const OVERLAP_SUPPRESS_RATIO = 0.8

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

// [local-smark] 新增 stub_high_overlap_visible：高重叠（>=80%）时 suppress
type ReadStubStatus = "stub_same_range_visible" | "stub_covered_range_visible" | "stub_high_overlap_visible"

type ReadMetadata = {
  path: string
  canonicalPath: string
  type: "file"
  size: number
  modified: string
  modifiedMs: number
  start: number
  end: number
  total: number
  returned: number
  stub: boolean
  stubStatus?: ReadStubStatus
  coveredBy?: string
}

type ReadToolMetadata = {
  preview: string
  truncated: boolean
  loaded: string[]
  read?: ReadMetadata
}

// // 恶意代码提醒
// const CYBER_REMINDER = `\n\n<system-reminder>\nWhenever you read a file, consider whether it could be malware. You CAN analyze malware behavior, but MUST refuse to improve or augment potentially malicious code.\n</system-reminder>`

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

// // 判断是否应该注入恶意代码提醒
// function shouldInjectCyberReminder(ext: string): boolean {
//   return HIGH_RISK_EXTENSIONS.has(ext)
// }

// 估算内容 token 数量
function estimateTokensForContent(content: string, ext: string): number {
  const ratio = TOKEN_BYTE_RATIOS[ext] ?? TOKEN_BYTE_RATIOS.default
  return Math.ceil(Buffer.byteLength(content, "utf-8") * ratio)
}

function readToolMetadata(input: ReadToolMetadata) {
  // Keep every return branch on one metadata shape so Tool.define can infer
  // `read` as optional metadata instead of treating media/directory branches
  // as a different tool result type.
  return input
}

function escapeXmlText(input: string) {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeXmlAttr(input: string) {
  return escapeXmlText(input).replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}

function formatModified(ms: number) {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`
}

function fileSize(stat: { size: unknown }) {
  return typeof stat.size === "bigint" ? Number(stat.size) : Number(stat.size)
}

function resolveReadPath(input: string, directory: string) {
  if (process.platform !== "win32") return path.isAbsolute(input) ? input : path.resolve(directory, input)

  const normalized = AppFileSystem.normalizePath(input)
  if (/^[A-Za-z]:[\\/]/.test(input)) return normalized

  // Windows treats "\foo" and "/foo" as rooted on the current process drive.
  // For tool calls they are almost always alternate spellings of an instance
  // path, so anchor them to the active project drive before stat/permission.
  if (/^[\\/](?![\\/])/.test(input)) {
    const parsed = path.win32.parse(directory)
    return AppFileSystem.normalizePath(path.win32.join(parsed.root, input.slice(1)))
  }

  return AppFileSystem.normalizePath(path.resolve(directory, input))
}

function canonicalReadPath(filepath: string) {
  const normalized = AppFileSystem.normalizePath(filepath).replaceAll("\\", "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function modifiedMs(stat: { mtime: Option.Option<Date> }) {
  return Math.floor(
    stat.mtime.pipe(
      Option.map((time) => time.getTime()),
      Option.getOrElse(() => 0),
    ),
  )
}

function isReadMetadata(input: unknown): input is ReadMetadata {
  if (!input || typeof input !== "object") return false
  const item = input as Record<string, unknown>
  return (
    item.type === "file" &&
    typeof item.path === "string" &&
    typeof item.canonicalPath === "string" &&
    typeof item.size === "number" &&
    typeof item.modified === "string" &&
    typeof item.modifiedMs === "number" &&
    typeof item.start === "number" &&
    typeof item.end === "number" &&
    typeof item.total === "number" &&
    typeof item.returned === "number" &&
    typeof item.stub === "boolean"
  )
}

function collectVisibleReads(messages: MessageV2.WithParts[], canonicalPath: string) {
  const reads: ReadMetadata[] = []
  for (const msg of messages) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "read") continue
      if (part.state.status !== "completed") continue
      if (part.state.time.compacted) continue

      // Use metadata rather than parsing XML so the visible-context decision
      // stays stable even if the human-facing formatting changes later.
      const meta = part.state.metadata?.read
      if (!isReadMetadata(meta)) continue
      if (meta.stub) continue
      if (meta.canonicalPath !== canonicalPath) continue
      reads.push(meta)
    }
  }
  return reads
}

function findReadStub(visibleReads: ReadMetadata[], current: ReadMetadata) {
  // Only suppress output when a non-stub read for the same file version is
  // still visible in the active context. Compacted history and modified files
  // fall through to a normal read.
  const sameVersion = visibleReads.filter((read) => read.size === current.size && read.modifiedMs === current.modifiedMs)
  const sameRange = sameVersion.find((read) => read.start === current.start && read.end === current.end)
  if (sameRange) return { status: "stub_same_range_visible" as const }

  const covering = sameVersion.find((read) => read.start <= current.start && read.end >= current.end)
  if (covering) {
    return { status: "stub_covered_range_visible" as const, coveredBy: `${covering.start}-${covering.end}` }
  }
  return undefined
}

function findOverlapNote(visibleReads: ReadMetadata[], current: ReadMetadata) {
  let best: { start: number; end: number; lines: number } | undefined
  for (const read of visibleReads) {
    if (read.size !== current.size || read.modifiedMs !== current.modifiedMs) continue
    const start = Math.max(read.start, current.start)
    const end = Math.min(read.end, current.end)
    if (start > end) continue
    const lines = end - start + 1
    if (!best || lines > best.lines) best = { start, end, lines }
  }

  if (!best) return undefined
  const requested = Math.max(1, current.end - current.start + 1)
  if (best.lines < OVERLAP_MIN_LINES) return undefined
  if (best.lines / requested < OVERLAP_MIN_RATIO) return undefined
  return `${best.start}-${best.end}`
}

function renderContentLines(file: Awaited<ReturnType<typeof lines>>) {
  return file.raw
    .map((line, i) => {
      // Keep source text verbatim. Only structural wrapper fields are escaped;
      // content lines must match what edit/write would operate on.
      if (line.length <= MAX_LINE_LENGTH) return `${i + file.offset}: ${line}`
      return `${i + file.offset}: ${line.slice(0, MAX_LINE_LENGTH)} (line truncated to ${MAX_LINE_LENGTH} chars)`
    })
    .join("\n")
}

function renderReadOutput(input: {
  path: string
  size: number
  modified: string
  start: number
  end: number
  total: number
  returned: number
  outline?: Outline
  overlap?: string
  content: string
  more?: { offset: number; reason: "line_limit" | "byte_limit" }
}) {
  const output = [
    `<path>${escapeXmlText(input.path)}</path>`,
    `<type>file</type>`,
    `<file size="${input.size}" modified="${escapeXmlAttr(input.modified)}" />`,
    `<range start="${input.start}" end="${input.end}" total="${input.total}" returned="${input.returned}" />`,
  ]

  if (input.outline?.items.length) {
    output.push(`<outline truncated="${input.outline.truncated ? "true" : "false"}">`)
    output.push(input.outline.items.join("\n"))
    output.push("</outline>")
  }

  if (input.overlap) output.push(`<note type="overlap" ranges="${input.overlap}" />`)
  output.push("<content>", input.content, "</content>")
  if (input.more) output.push(`<more offset="${input.more.offset}" reason="${input.more.reason}" />`)
  return output.join("\n")
}

function renderReadStub(input: {
  path: string
  size: number
  modified: string
  start: number
  end: number
  total: number
  status: ReadStubStatus
  coveredBy?: string
}) {
  // 可见覆盖范围的末行：被覆盖时取外部已读区间的 end，否则即本次请求的 end。
  // 用于推导下一段未读内容的起始 offset，给模型一个明确的"往哪读"指令，
  // 避免模型把 stub 误解为读取失败而重复请求同一范围（见诊断：连续 13 次 stub 死循环）。
  const visibleEnd = input.coveredBy ? Number(input.coveredBy.split("-")[1]) : input.end
  // 下一段未读内容的起始行 = 可见末行 + 1。这是打破"重复读同范围"循环的关键锚点。
  const nextOffset = visibleEnd + 1
  // 上界钳制：当可见范围已覆盖到文件末尾（visibleEnd >= total）时再给 offset 会指向
  // EOF 之后的空区间，误导模型发起必失败的 read。此时文案改为声明已达末尾，彻底关闭
  // offset 出口、仅保留 grep 兜底，消除"还能继续读"的错觉。
  const reachedEof = visibleEnd >= input.total
  // offset 出口：未到末尾时给出精确跳读指令；到末尾时退化为 pub grep 兜底，
  // 使第二行在任何分支下都提供至少一个可执行动作，不留空指令。
  const offsetExit = reachedEof
    ? "No unread lines remain (end of file reached); use grep to locate symbols."
    : `Use offset=${nextOffset} for unread lines, or grep to locate symbols.`
  // 两行高信息量文案。findReadStub 已经过 size+modifiedMs 同版本门控，故可断言
  // "上下文里的内容是最新版本"——这直接消除模型对"是否过期需重读"的疑虑，避免它
  // 把 stub 误读为"内容陈旧、需刷新"而重复请求同一范围（诊断：连续 13 次 stub 死循环）。
  // coveredBy 在 stub_covered_range_visible 分支恒非空（findReadStub 仅此时赋值），
  // 但类型为可选，这里用兜底字符串防御性守卫，避免未来调用方缺省值渗入文案输出 "undefined"。
  const coverage = input.coveredBy ?? `${input.start}-${input.end}`
  const message =
    input.status === "stub_same_range_visible"
      ? `Lines ${input.start}-${input.end} are the latest version and already in context; do NOT re-read.\n${offsetExit}`
      : `Lines ${input.start}-${input.end} covered by visible read ${coverage} (latest version, file unchanged); do NOT re-read.\n${offsetExit}`
  return [
    `<path>${escapeXmlText(input.path)}</path>`,
    `<type>file</type>`,
    `<file size="${input.size}" modified="${escapeXmlAttr(input.modified)}" />`,
    `<range start="${input.start}" end="${input.end}" total="${input.total}" returned="0" />`,
    `<stub status="${input.status}"${input.coveredBy ? ` covered_by="${input.coveredBy}"` : ""}>`,
    message,
    "</stub>",
  ].join("\n")
}

const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

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
    description: "The maximum number of lines to read (defaults to 200)",
  }),
})

export const ReadTool = Tool.define(
  "read",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const reference = yield* Reference.Service
    const image = yield* Image.Service
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
      yield* lsp.touchFile(filepath).pipe(Effect.ignore, Effect.forkIn(scope))
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

    // [local-smark] 根据二进制文件扩展名返回 type-specific 替代建议。
    // 帮助模型知道用什么工具读取，避免盲目重试 read 工具。
    // 数据库文件建议 bun:sqlite，压缩文件建议先解压，其他建议 strings/hexdump。
    function getBinaryFileSuggestion(ext: string): string | undefined {
      const map: Record<string, string> = {
        ".gz": "Decompress with gunzip or bun -e with zlib first, then read.",
        ".tar": "Extract with tar -xf first, then read individual files.",
        ".zip": "Extract with unzip first, then read individual files.",
        ".7z": "Extract with 7z first, then read individual files.",
        ".db": "Use bun -e with bun:sqlite to query this database.",
        ".vscdb": "Use bun -e with bun:sqlite to query this database.",
        ".sqlite": "Use bun -e with bun:sqlite to query this database.",
        ".exe": "Use strings or hexdump via bash to inspect binary content.",
        ".dll": "Use strings or hexdump via bash to inspect binary content.",
        ".so": "Use strings or hexdump via bash to inspect binary content.",
        ".wasm": "Use strings or hexdump via bash to inspect binary content.",
        ".class": "Use javap -c via bash to disassemble Java bytecode.",
        ".jar": "Extract with jar -xf or unzip first, then read individual files.",
        ".doc": "Use python-docx or convert to text via libreoffice --headless.",
        ".docx": "Use python-docx or unzip to read XML content.",
        ".pyc": "Use python -m dis or uncompyle6 to decompile.",
      }
      return map[ext]
    }

    const run = Effect.fn("ReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const instance = yield* InstanceState.context
      const filepath = resolveReadPath(params.filePath, instance.directory)

      // 设备文件保护 - 阻止可能导致进程挂起的设备文件
      if (isBlockedDevicePath(filepath)) {
        return yield* Effect.fail(
          new Error(`Cannot read '${filepath}': this device file would block or produce infinite output.`),
        )
      }

      yield* reference.ensure(filepath)
      const title = path.relative(instance.worktree, filepath)

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]) || (yield* reference.contains(filepath)),
        kind: stat?.type === "Directory" ? "directory" : "file",
        // Tool-origin evidence lets Auto review this external_directory gate
        // without treating path-only requests as enough authorization context.
        metadata: { action_kind: "tool", tool: "read", operation: "read" },
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
            `<path>${escapeXmlText(filepath)}</path>`,
            `<type>directory</type>`,
            `<directory entries="${items.length}" />`,
            `<content>`,
            sliced.join("\n"),
            `</content>`,
            truncated ? `<more offset="${offset + sliced.length}" reason="entry_limit" />` : undefined,
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
          metadata: readToolMetadata({
            preview: sliced.slice(0, 20).join("\n"),
            truncated,
            loaded: [] as string[],
          }),
        }
      }

      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)
      const size = fileSize(stat)
      const versionMs = modifiedMs(stat)
      const modified = formatModified(versionMs)
      const sample = yield* readSample(filepath, size, SAMPLE_BYTES)

      const mime = sniffAttachmentMime(sample, AppFileSystem.mimeType(filepath))
      const isImage = SUPPORTED_IMAGE_MIMES.has(mime)

      if (isImage || isPdfAttachment(mime)) {
        const bytes = yield* fs.readFile(filepath)

        // 图片走 Image.Service，确保 read、粘贴和 tool-result 共享同一套尺寸与预算边界。
        if (isImageAttachment(mime)) {
          const input = {
            id: PartID.ascending(),
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "file" as const,
            mime,
            url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
          }
          const attachment = yield* image.normalize(
            input,
            // `read` results enter the model immediately, so keep its payload near the existing image token cap.
            { tokenBudget: 1600 },
          ).pipe(
            // If the native resizer cannot load, preserve the old read behavior: attach the original bytes instead of failing.
            Effect.catchIf(
              (error) => error instanceof Image.ResizerUnavailableError,
              () => Effect.succeed(input),
            ),
          )
          const msg = `Image read successfully (${formatSize(bytes.length)} → compressed for model)`
          return {
            title,
            output: msg,
            metadata: readToolMetadata({
              preview: msg,
              truncated: false,
              loaded: loaded.map((item) => item.filepath),
            }),
            attachments: [
              {
                type: "file" as const,
                mime: attachment.mime,
                url: attachment.url,
              },
            ],
          }
        }

        // PDF 保持原样
        const msg = isPdfAttachment(mime) ? "PDF read successfully" : "Image read successfully"
        return {
          title,
          output: msg,
          metadata: readToolMetadata({
            preview: msg,
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
          }),
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
        // [local-smark] 根据文件扩展名提供 type-specific 替代建议，
        // 帮助模型知道用什么工具读取而非盲目重试。
        const ext = path.extname(filepath).toLowerCase()
        const suggestion = getBinaryFileSuggestion(ext)
        return yield* Effect.fail(new Error(
          `Cannot read binary file: ${filepath}` +
          (suggestion ? `\n${suggestion}` : ""),
        ))
      }

      const file = yield* Effect.promise(() =>
        lines(filepath, { limit: params.limit ?? DEFAULT_READ_LIMIT, offset: params.offset || 1 }),
      )
      if (file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
        return yield* Effect.fail(
          new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`),
        )
      }

      const start = file.offset
      const end = file.raw.length === 0 ? file.offset - 1 : file.offset + file.raw.length - 1
      const canonicalPath = canonicalReadPath(filepath)
      const current: ReadMetadata = {
        path: filepath,
        canonicalPath,
        type: "file",
        size,
        modified,
        modifiedMs: versionMs,
        start,
        end,
        total: file.count,
        returned: file.raw.length,
        stub: false,
      }
      const visibleReads = collectVisibleReads(ctx.messages, canonicalPath)
      const stub = findReadStub(visibleReads, current)
      if (stub) {
        const read = { ...current, returned: 0, stub: true, stubStatus: stub.status, coveredBy: stub.coveredBy }
        const output = renderReadStub({
          path: filepath,
          size,
          modified,
          start,
          end,
          total: file.count,
          status: stub.status,
          coveredBy: stub.coveredBy,
        })
        return {
          title,
          output,
          metadata: readToolMetadata({
            preview: output,
            truncated: false,
            loaded: [] as string[],
            read,
          }),
        }
      }

      // [local-smark] 高重叠 suppress：当已可见读取与当前请求的重叠率 >= 80% 时，
      // 直接返回 stub 而非仅 note。这减少了大量部分重叠的重复读取（如偏移微调的重复读）。
      // 仍走 size+modifiedMs 同版本门控（findOverlapNote 内部已检查）。
      // stub 文案复用 renderReadStub 的 nextOffset 逻辑，告诉模型哪段已可见、往哪读。
      const overlapRange = findOverlapNote(visibleReads, current)
      if (overlapRange) {
        // 计算实际重叠比例
        const [overlapStart, overlapEnd] = overlapRange.split("-").map(Number)
        const overlapLines = overlapEnd - overlapStart + 1
        const requestedLines = Math.max(1, end - start + 1)
        if (overlapLines / requestedLines >= OVERLAP_SUPPRESS_RATIO) {
          const read = { ...current, returned: 0, stub: true, stubStatus: "stub_high_overlap_visible" as const, coveredBy: overlapRange }
          const visibleEnd = overlapEnd
          const nextOffset = visibleEnd + 1
          const reachedEof = visibleEnd >= file.count
          const offsetExit = reachedEof
            ? "No unread lines remain (end of file reached); use grep to locate symbols."
            : `Use offset=${nextOffset} for unread lines, or grep to locate symbols.`
          const message = `Lines ${start}-${end} have ${Math.round((overlapLines / requestedLines) * 100)}% overlap with visible read ${overlapRange} (latest version, file unchanged); do NOT re-read.\n${offsetExit}`
          const output = [
            `<path>${escapeXmlText(filepath)}</path>`,
            `<type>file</type>`,
            `<file size="${size}" modified="${escapeXmlAttr(modified)}" />`,
            `<range start="${start}" end="${end}" total="${file.count}" returned="0" />`,
            `<stub status="stub_high_overlap_visible" covered_by="${overlapRange}">`,
            message,
            "</stub>",
          ].join("\n")
          return {
            title,
            output,
            metadata: readToolMetadata({
              preview: output,
              truncated: false,
              loaded: [] as string[],
              read,
            }),
          }
        }
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

      const truncated = file.more || file.cut
      const output = renderReadOutput({
        path: filepath,
        size,
        modified,
        start,
        end,
        total: file.count,
        returned: file.raw.length,
        // [local-smark] 使用 readOutlineCached 替代 readOutline，
        // 按 canonicalPath+size+modifiedMs 缓存 outline，避免每次 read 重新扫描文件
        outline: yield* Effect.promise(() => readOutlineCached(filepath, file.count, file.offset, size, versionMs)),
        overlap: findOverlapNote(visibleReads, current),
        content: renderContentLines(file),
        more: truncated ? { offset: end + 1, reason: file.cut ? "byte_limit" : "line_limit" } : undefined,
      })

      yield* warm(filepath)

      let finalOutput = output

      if (loaded.length > 0) {
        finalOutput += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
      }

      // // 恶意代码安全提醒 - 仅对高风险扩展名注入
      // if (shouldInjectCyberReminder(ext)) {
      //   finalOutput += CYBER_REMINDER
      // }

      return {
        title,
        output: finalOutput,
        metadata: readToolMetadata({
          preview: file.raw.slice(0, 20).join("\n"),
          truncated,
          loaded: loaded.map((item) => item.filepath),
          read: current,
        }),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

// [local-smark] Custom lines reader with byte-cap for read tool
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

      if (cut) {
        more = true
        continue
      }

      const line = text
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES) {
        cut = true
        more = true
        continue
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
