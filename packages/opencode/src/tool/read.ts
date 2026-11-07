// 成功后的确认性复读可省略；失败恢复和未读范围仍可正常读取。
import { Effect, Option, Schema, Scope } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import * as path from "path"
import * as Tool from "./tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./read.txt"
import { readOutlineCached, type Outline } from "./read-outline"
// page 和 outline 共用预算与解析器，不重复扫描完整尾部。
import { createAuxiliaryBudget, readTextPage } from "@opencode-ai/core/tool/read-lines"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { isImageAttachment, isPdfAttachment, sniffAttachmentMime } from "@/util/media"
// #277：复用 Image.Service；media 已仅有 MIME 辅助函数，不恢复旧压缩路径。
import { Image } from "@/image/image"
import { PartID } from "@/session/schema"

// 只降低缺省页大小，显式 limit 与既有安全、附件分支不随默认值收紧。
// #142：默认 200 行，配合 range/outline 做定点读取
// #142：默认 200 行与 source 对齐
const DEFAULT_READ_LIMIT = 200
// 文本页预算独立于图片/PDF 的读取与附件契约，不能把媒体按正文上限裁掉。
// #178：正文页降低到16KiB，续读与媒体上限不变。
const MAX_BYTES = 16 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096
// #534：白名单移除——decoder 域内格式统一进入 Image.Service，域外格式（含 fastbidsheet/svg）
// 由 util/media.isImageAttachment 单一谓词排除；是否可解码由真实 backend 决定，read 不再自持白名单。

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

// // 恶意代码提醒 - 对高风险扩展名注入安全提示，防止模型改进恶意代码
// const CYBER_REMINDER = `\n\n<system-reminder>\nWhenever you read a file, consider whether it could be malware. You can analyze malware behavior, but MUST refuse to improve or augment potentially malicious code.\n</system-reminder>`

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

// // 只提醒源码风险，不把提醒当作 MIME 检测或可执行文件的读取授权。
// function shouldInjectCyberReminder(ext: string): boolean {
//   return HIGH_RISK_EXTENSIONS.has(ext)
// }

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
      if (typeof part.metadata?.executeParent === "string") continue
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

// `offset` and `limit` were originally `z.coerce.number()` — the runtime
// coercion was useful when the tool was called from a shell but serves no
// purpose in the LLM tool-call path (the model emits typed JSON). The JSON
// Schema output is identical (`type: "number"`), so the LLM view is
// unchanged; purely CLI-facing uses must now send numbers rather than strings.

import { type ReadRangeMeta, canonicalReadPath, escapeXmlText, escapeXmlAttr, formatModified, isReadRangeMeta, findReadStub, findOverlapNote, renderReadOutput, renderReadStub, computeUnreadRanges } from "@opencode-ai/core/tool/read-presentation"
// 导出既有共享身份规则，失败反馈不能重新定义Windows路径规范化。
export { canonicalReadPath } from "@opencode-ai/core/tool/read-presentation"

// V1 保留自己的消息适配，范围证明和模型呈现与原生读取共用。
function readToolMetadata(input: Metadata) {
  return input
}

function fileSizeOf(stat: { size: unknown }) {
  return Number(stat.size)
}

function modifiedMsOf(stat: { mtime: Option.Option<Date> }) {
  return Math.floor(Option.getOrElse(stat.mtime, () => new Date(0)).getTime())
}

// 可见性仍取自本次会话实际历史，不能以路径缓存代替正文证明。
// 「内容仍在模型上下文中可见」的 part 级判定是本模块的单一协议：completed、
// 未 compacted、非 stub、metadata.read 合法。collectVisibleReads 与 edit 失败诊断
// （INV-04/05）都必须经此判定，复制条件会让两侧对同一历史给出不同答案。
export function visibleReadMeta(part: {
  type?: string
  tool?: string
  metadata?: { executeParent?: unknown }
  state?: { status?: string; time?: { start?: number; end?: number; compacted?: number }; metadata?: { read?: unknown } }
}): ReadRangeMeta | undefined {
  if (part.type !== "tool" || part.tool !== "read") return undefined
  // 子读取正文只交给脚本，数据库记录本身不能证明主模型已看见它。
  if (typeof part.metadata?.executeParent === "string") return undefined
  if (part.state?.status !== "completed" || part.state?.time?.compacted !== undefined) return undefined
  // 元数据是可见性唯一协议；展示XML改变时不应让已压缩或非空零行读取变成可见正文。
  const meta = part.state?.metadata?.read
  if (!isReadRangeMeta(meta) || meta.stub) return undefined
  if (meta.returned === 0 && meta.size > 0) return undefined
  return meta
}

function collectVisibleReads(messages: Array<{ info: { role: string }; parts: any[] }>, canonicalPath: string) {
  const reads: ReadRangeMeta[] = []
  // 逆序扫描：同一文件多次可见读取时，下游区间合并只需关心最新版本；
  // 新→旧遍历让首个命中即可携带最新 size/fp，避免额外排序 pass。
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      const meta = visibleReadMeta(part)
      if (!meta) continue
      if (meta.canonicalPath !== canonicalPath) continue
      reads.push(meta)
    }
  }
  return reads
}


export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file or directory to read" }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "The line number to start reading from (1-indexed)",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "The maximum number of lines to read (defaults to 200)",
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
      totalLinesExact: boolean
      truncated: boolean
    }

type Metadata = {
  preview: string
  truncated: boolean
  loaded: string[]
  // #142：可选区间元数据，供 stub/重叠
  // #142：可选 read 元数据
  read?: ReadRangeMeta
  display?: Display
}

export const ReadTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Instruction.Service | LSP.Service | Image.Service | Scope.Scope
>(
  "read",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    // #277：Image.Service 承担图片附件的尺寸与 token 预算边界
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
          if (item.type === "directory") return { item, label: item.name + "/" }
          if (item.type !== "symlink") return { item, label: item.name }

          // 链接目录的尾斜杠只服务原展示，程序类型仍保留symlink。
          const target = yield* fs.stat(path.join(filepath, item.name)).pipe(Effect.catch(() => Effect.void))
          return { item, label: item.name + (target?.type === "Directory" ? "/" : "") }
        }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items) => items.sort((a, b) => a.label.localeCompare(b.label))))
    })

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string) {
      // [local-smark] 回移 PR #30226：用 ignoreCause 隔离后台 LSP warmup defect，
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
        // #210：tool-origin 证据让 Auto reviewer 基于 read 操作而非仅路径判断 external_directory 门禁
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
        // 同一排序与分页同时服务展示和程序值，保留symlink/other原始类型及全部条目。
        const names = sliced.map((entry) => entry.label)
        const truncated = start + sliced.length < items.length
        // #142：目录条目原文输出，结构标签保持稳定
        const output = [
          `<path>${escapeXmlText(filepath)}</path>`,
          `<type>directory</type>`,
          `<directory entries="${items.length}" />`,
          `<content>`,
          // #142：目录条目也 escape，结构一致
          // #145：目录名不转义，保留 & 等字符
          names.join("\n"),
          `</content>`,
          // #142：目录超限用 entry_limit
          truncated ? `<more offset="${offset + sliced.length}" reason="entry_limit" />` : undefined,
        ]
          .filter(Boolean)
          .join("\n")

        return {
          title,
          output,
          program: { value: { type: "list-page", path: filepath,
            entries: sliced.map(({ item }) => ({ path: path.join(filepath, item.name), type: item.type })),
            offset, totalEntries: items.length, truncated, ...(truncated ? { next: offset + sliced.length } : {}),
          } },
          metadata: readToolMetadata({
            preview: names.slice(0, 20).join("\n"),
            truncated,
            loaded: [] as string[],
            display: {
              type: "directory" as const,
              path: filepath,
              entries: names,
              offset,
              totalEntries: items.length,
              truncated,
            },
          }),
        }
      }

      // stat 跟随软链接；只准普通文件，避免设备别名绕过字符串黑名单。
      // splitLines 在字节上限之前等待换行，不能靠后面的限幅阻止 /dev/zero。
      if (stat.type !== "File") return yield* Effect.fail(new Error(`Cannot read non-regular file: ${filepath}`))

      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)
      // 嵌套读取的目录规则由父 execute 强制交付，独立于脚本选择返回哪些数据。
      const context = ctx.executeParent ? loaded.map((item) => ({
        kind: "instruction" as const, key: item.filepath,
        text: `<system-reminder>\n${item.content}\n</system-reminder>`,
      })) : undefined
      const sample = yield* readSample(filepath, Number(stat.size), SAMPLE_BYTES)

      const mime = sniffAttachmentMime(sample, FSUtil.mimeType(filepath))
      // MIME只分类，完整header/像素检查统一留给Image；坏BMP也应得到省略文本。
      // SVG及fastbidsheet沿目标共享谓词继续作为文本，不恢复独立格式白名单。
      const isImage = isImageAttachment(mime)

      if (isImage || isPdfAttachment(mime)) {
        const bytes = yield* fs.readFile(filepath)
        const content = Buffer.from(bytes).toString("base64")
        // #277：仅图片走统一规整与预算；PDF 保持原始字节及既有成功文案。
        const input = {
          type: "file" as const,
          mime,
          url: `data:${mime};base64,${content}`,
        }
        const attachment = isImage
          ? yield* image
              .normalize(
                {
                  ...input,
                  // #277：内部规整使用本次请求身份，不能借用缓存或其他会话的 ID。
                  id: PartID.ascending(),
                  messageID: ctx.messageID,
                  sessionID: ctx.sessionID,
                },
                { tokenBudget: 1600 },
              ).pipe(Effect.option)
          : Option.some(input)
        // 图片typed失败仅省略该payload；loaded仍记录真实读盘动作，PDF不经过decoder。
        if (Option.isNone(attachment)) {
          const msg = "Image omitted: could not be decoded or resized within the image size limit."
          return {
            title,
            output: msg,
            program: { value: { type: "omitted", path: filepath, content: msg } },
            metadata: readToolMetadata({ preview: msg, truncated: false, loaded: loaded.map((item) => item.filepath) }),
            context,
          }
        }
        const msg = isPdfAttachment(mime) ? "PDF read successfully" : "Image read successfully"
        // proof只标记图片当前MIME/URL；PDF与返回附件身份保持原合同。
        const media = { type: "file" as const, mime: attachment.value.mime, url: attachment.value.url }
        return {
          title,
          output: msg,
          // 程序取得原读取内容；模型附件继续经过既有图片规整和预算。
          program: { value: { type: "file", path: filepath, content, mime, encoding: "base64" } },
          metadata: readToolMetadata({
            preview: msg,
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
          }),
          attachments: [isImage ? Image.markNormalized(media) : media],
          context,
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

      // 每次 execute 仅创建一个预算；Effect 中断同时关闭底层 Node 流。
      const auxiliaryBudget = createAuxiliaryBudget()
      const file = yield* Effect.promise((signal) =>
        readTextPage(filepath, {
          limit: params.limit ?? DEFAULT_READ_LIMIT,
          offset: params.offset || 1,
          budget: auxiliaryBudget,
          signal,
        }),
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
        // 按比例计算建议 limit，帮助用户分批读取大文件
        const suggestedLimit = Math.floor(lineCount * (MAX_CONTENT_TOKENS / estimatedTokens))
        return yield* Effect.fail(
          new Error(
            `File content (~${estimatedTokens} tokens) exceeds maximum (${MAX_CONTENT_TOKENS} tokens). ` +
              `Use offset and limit parameters. Suggested: limit=${suggestedLimit}`,
          ),
        )
      }

      // #142：构造当前读区间元数据供 stub/overlap
      // #142：当前文件 size
const size = fileSizeOf(stat)
      // #142：当前 mtime
const mtimeMs = modifiedMsOf(stat)
      // #142：展示用 modified
const modified = formatModified(mtimeMs)
      // #142：区间起点
const start = file.offset
      // #142：空区间 end 规则
const end = file.raw.length === 0 ? Math.max(0, file.offset - 1) : file.offset + file.raw.length - 1
      // #142：实际返回行数
const returned = file.raw.length
      // #142：truncated 元数据
const truncated = file.more || file.cut
      // #142：构造当前 read 元数据
const current: ReadRangeMeta = {
        path: filepath,
        canonicalPath: canonicalReadPath(filepath),
        type: "file",
        size,
        modified,
        modifiedMs: mtimeMs,
        // 复用已读的 4096B 原始头样本，不新增 I/O，也不回填旧 part。
        fp: Hash.fast(Buffer.from(sample)),
        start,
        end,
        total: file.count,
        totalExact: file.totalExact,
        returned,
        stub: false,
      }
      // #142：可见上下文驱动 stub，优先于 mtime 缓存
      // #142：加载可见 reads
const visibleReads = collectVisibleReads(ctx.messages.filter(message => message.info.sessionID === ctx.sessionID), current.canonicalPath)
      // #142：stub 判定
// JS 的每次调用都需要真实页面；模型可见历史的 stub 仅服务直接读取。
const stub = ctx.executeParent ? undefined : findReadStub(visibleReads, current, file.raw.join("\n").length)
      if (stub) {
        // #142：可见范围 stub，避免重复灌入相同内容
        // covering 的总行数与 EOF 证明必须一起发布，沿用目标已有 totalExact。
        const owner = stub.status === "stub_covered_range_visible" ? stub.covering : current
        const read = {
          ...current,
          total: owner.total,
          totalExact: owner.totalExact,
          returned: 0,
          stub: true as const,
          stubStatus: stub.status,
          coveredBy: "coveredBy" in stub ? stub.coveredBy : undefined,
        }
        let output = renderReadStub({
          path: filepath,
          size,
          modified,
          start,
          end,
          total: owner.total,
          totalExact: owner.totalExact,
          status: stub.status,
          coveredBy: "coveredBy" in stub ? stub.coveredBy : undefined,
          unread: computeUnreadRanges(visibleReads, current),
        })
        // #142：stub 只省略已见正文；新解析的目录规则必须实际交付后才能记入 loaded。
        if (loaded.length > 0) {
          output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
        }
        return {
          title,
          output,
          program: { value: { type: "omitted", path: filepath, content: output } },
          metadata: readToolMetadata({
            preview: output,
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
            read,
          }),
        }
      }

      // #142：异步大纲，失败不应阻断主读取（promise 内自处理）
      // #142：异步 outline
// [local-smark] 使用 readOutlineCached 替代 readOutline，
// 按 canonicalPath+size+modifiedMs 缓存 outline，避免每次 read 重新扫描文件
const outline = yield* Effect.promise((signal) =>
        readOutlineCached(filepath, file.count, file.offset, size, mtimeMs, file.totalExact, auxiliaryBudget, signal),
      )
      // #142：部分重叠仍返回内容，但附 note
      // #142：overlap 判定
const overlap = findOverlapNote(visibleReads, current)
      // #142：渲染主输出
let output = renderReadOutput({
        path: filepath,
        size,
        modified,
        start,
        end,
        total: file.count,
        totalExact: file.totalExact,
        returned,
        raw: file.raw,
        cut: file.cut,
        more: file.more,
        outline,
        overlap,
      })

      yield* warm(filepath)

      if (loaded.length > 0) {
        output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
      }

      // // 恶意代码安全提醒 - 仅对高风险扩展名注入
      // if (shouldInjectCyberReminder(ext)) {
      //   output += CYBER_REMINDER
      // }


      return {
        title,
        output,
        context,
        // next仅在还有后续页时提供；totalLinesExact继续标记有界计数是否完整。
        // 单行裁剪也会truncated，但不一定存在下一页，不能据此伪造续读偏移。
        program: { value: { type: "text-page", path: filepath, content, mime, offset: file.offset,
          totalLines: file.count, totalLinesExact: file.totalExact, truncated,
          ...(file.more ? { next: file.offset + file.raw.length } : {}),
        } },
        metadata: readToolMetadata({
          preview: file.raw.slice(0, 20).join("\n"),
          truncated,
          loaded: loaded.map((item) => item.filepath),
          read: current,
          display: {
            type: "file" as const,
            path: filepath,
            text: file.raw.join("\n"),
            lineStart: file.offset,
            lineEnd: end,
            totalLines: file.count,
            totalLinesExact: file.totalExact,
            truncated,
          },
        }),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      output: Schema.Union([
        Schema.Struct({ type: Schema.Literal("file"), path: Schema.String, content: Schema.String, mime: Schema.String,
          encoding: Schema.Literals(["utf8", "base64"]) }),
        Schema.Struct({ type: Schema.Literal("text-page"), path: Schema.String, content: Schema.String, mime: Schema.String,
          offset: Schema.Number, totalLines: Schema.Number, totalLinesExact: Schema.Boolean, truncated: Schema.Boolean,
          next: Schema.optionalKey(Schema.Number) }),
        Schema.Struct({ type: Schema.Literal("list-page"), path: Schema.String,
          entries: Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.Literals(["file", "directory", "symlink", "other"]) })),
          offset: Schema.Number, totalEntries: Schema.Number, truncated: Schema.Boolean, next: Schema.optionalKey(Schema.Number) }),
        Schema.Struct({ type: Schema.Literal("omitted"), path: Schema.String, content: Schema.String }),
      ]),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
