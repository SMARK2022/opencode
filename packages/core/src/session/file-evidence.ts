export * as FileEvidence from "./file-evidence"

import path from "path"
import { createHash } from "crypto"
import { mergeRanges } from "../util/range"
import { Effect, Option, Schema } from "effect"
import { FSUtil } from "../fs-util"

const Receipt = Schema.Struct({
  path: Schema.String,
  canonicalPath: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
  total: Schema.Number,
  modified: Schema.String,
  size: Schema.optional(Schema.Number),
  modifiedMs: Schema.optional(Schema.Number),
  stub: Schema.optional(Schema.Boolean),
})

export interface SearchReceipt {
  readonly tool: "grep" | "glob"
  readonly pattern: string
  readonly path: string
  readonly matches: number
  readonly partial?: boolean
}

export interface CommandReceipt {
  readonly command: string
  readonly cwd?: string
  readonly workdir?: string
  readonly exit?: number
}

export const kind = "compaction_evidence_handoff"

export const render = Effect.fn("FileEvidence.render")(function* (
  receipts: readonly unknown[], fs: FSUtil.Interface, worktree: string,
  context: { readonly searches?: readonly SearchReceipt[]; readonly commands?: readonly CommandReceipt[]; readonly directory?: string; readonly compactionCount?: number } = {},
) {
  const files = new Map<string, typeof Receipt.Type & { ranges: { start: number; end: number }[] }>()
  // 两代只转换真实已完成Read凭证，合并/预算/stat仍只有一个owner。
  for (const receipt of receipts) {
    const parsed = Schema.decodeUnknownOption(Receipt)(receipt)
    if (Option.isNone(parsed) || parsed.value.stub) continue
    const read = parsed.value
    // 按真实路径合并多次读取；Windows的大小写和分隔符不构成不同文件版本。
    const absolute = path.resolve(worktree, read.canonicalPath)
    const key = process.platform === "win32" ? absolute.toLowerCase() : absolute
    const ranges = mergeRanges([...(files.get(key)?.ranges ?? []), { start: read.start, end: read.end }])
    // 删除再插入让Map顺序代表最近读取，避免文件修改时间影响证据优先级。
    files.delete(key)
    files.set(key, { ...read, canonicalPath: absolute, ranges })
  }
  const searches = new Map<string, SearchReceipt>()
  for (const search of context.searches ?? []) {
    if (!search.pattern) continue
    // 完整pattern参与去重，展示截短不能合并两个不同的查询。
    const key = JSON.stringify([search.tool, search.pattern, search.path])
    searches.delete(key)
    searches.set(key, search)
  }
  const commands = new Map<string, { command: string; cwd: string; exit: string }>()
  for (const receipt of context.commands ?? []) {
    if (!receipt.command.trim()) continue
    const cwd = path.resolve(context.directory ?? worktree, receipt.cwd ?? receipt.workdir ?? ".")
    let normalized = receipt.command.trim()
    // 环境赋值只影响去重键；原文仍展示并独立脱敏，不筛选管道或命令链。
    while (true) {
      const match = normalized.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/)
      if (!match) break
      normalized = normalized.slice(match[0].length).trimStart()
    }
    const key = `${process.platform === "win32" ? cwd.toLowerCase() : cwd}\0${normalized}`
    commands.delete(key)
    commands.set(key, { command: receipt.command, cwd, exit: receipt.exit === undefined ? "unknown" : String(receipt.exit) })
  }
  if (files.size === 0 && searches.size === 0 && commands.size === 0) return undefined
  // 先裁剪再stat，单次压缩最多访问20个磁盘路径；不回读文件内容。
  const visible = [...files.values()].toReversed().slice(0, 20)
  const rows = yield* Effect.forEach(visible, (file) =>
    fs.stat(file.canonicalPath).pipe(
      Effect.map((stat) => {
        if (stat.type !== "File") return { modified: "-", status: "deleted" }
        const modifiedMs = Option.getOrUndefined(Option.map(stat.mtime, (time) => Math.floor(time.getTime())))
        if (modifiedMs === undefined) return { modified: "-", status: "stale" }
        // 旧会话缺少版本字段时只能标stale，工具写事件也不能代替当前磁盘事实。
        return { modified: formatModified(modifiedMs), status:
          file.size !== undefined && file.modifiedMs !== undefined &&
          Number(stat.size) === file.size && modifiedMs === file.modifiedMs ? "current" : "stale" }
      }),
      // NotFound才是删除；权限等预期stat错误不阻止摘要完成，也不伪装成current。
      Effect.catch((error) => Effect.succeed({ modified: "-", status: error.reason._tag === "NotFound" ? "deleted" : "stale" })),
      Effect.map((state) => {
        const relative = path.relative(worktree, path.resolve(worktree, file.path))
        const name = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file.path
        const ranges = file.ranges.slice(0, 8).map((range) => `${range.start}-${range.end}`).join(", ")
        const omitted = file.ranges.length - Math.min(file.ranges.length, 8)
        return `| ${cell(name.replaceAll("\\", "/"))} | ${ranges}${omitted ? `, ...(+${omitted})` : ""} | ${file.total} | ${state.modified} | ${state.status} |`
      }),
    ),
  )
  return [
    "## Evidence Handoff",
    ...(rows.length ? ["", "### Inspected Files", "| path | ranges | total | modified | status |", "|---|---:|---:|---|---|", ...rows] : []),
    ...(files.size > visible.length ? [`Omitted: ${files.size - visible.length} inspected files due to evidence budget.`] : []),
    ...(commands.size ? ["", "### Executed Commands", "| command | cwd | exit |", "|---|---|---:|", ...[...commands.values()].toReversed().slice(0, 10).map(item => {
      const relative = path.relative(worktree, item.cwd)
      const cwd = !relative.startsWith("..") && !path.isAbsolute(relative) ? relative || "." : item.cwd
      return `| ${commandDisplay(item.command)} | ${cell(cwd.replaceAll("\\", "/"))} | ${item.exit} |`
    })] : []),
    ...(commands.size > 10 ? [`Omitted: ${commands.size - 10} executed commands due to evidence budget.`] : []),
    // 数量与完整性是独立事实，保留source原话而非把权限遗漏伪装成更多匹配。
    ...(searches.size ? ["", "### Search History", "| tool | pattern | path | matches |", "|---|---|---|---:|", ...[...searches.values()].toReversed().slice(0, 10).map(search => `| ${search.tool} | ${cell(search.pattern.slice(0, 60))} | ${cell(search.path)} | ${search.matches}${search.partial ? " (incomplete)" : ""} |`)] : []),
    ...(searches.size > 10 ? [`Omitted: ${searches.size - 10} searches due to evidence budget.`] : []),
    "", "### Lost Context Notice", "- Use current evidence before repeating reads or commands.",
    "- Treat stale evidence as advisory only.",
    `- This is compaction #${context.compactionCount ?? 1}. Summary fidelity may be degraded; verify critical facts by re-reading.`,
  ].join("\n")
})

function cell(value: string) {
  // 文件名可含表格分隔符和换行，转义后仍保持一条证据记录。
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ")
}

function commandDisplay(input: string) {
  // 沿用source凭据模式；截断前脱敏，短标记只区分被缩短的公开命令。
  const redacted = input
    .replace(/(authorization:\s*bearer\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)=)("[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
    .replace(/(--(?:api[_-]?key|token|password|secret)=)("[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
    .replace(/(--(?:api[_-]?key|token|password|secret)\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
    .replace(/\s+/g, " ").trim()
  const clean = cell(redacted)
  if (clean.length <= 120) return clean
  return `${clean.slice(0, 102).trimEnd()}... [cmd:${createHash("sha256").update(clean).digest("hex").slice(0, 8)}]`
}

function formatModified(ms: number) {
  // 与Read输出使用同一种本地时间，不把UTC字符串与历史凭证混比。
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function parentSummary(receipts: readonly unknown[], worktree: string) {
  const parse = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String, canonicalPath: Schema.optional(Schema.String), start: Schema.Number, end: Schema.Number, stub: Schema.optional(Schema.Unknown) }))
  const files = new Map<string, { path: string; ranges: { start: number; end: number }[] }>()
  for (const value of receipts) {
    const parsed = parse(value)
    // same/covered/high overlap的stub:true都未交付正文；旧字符串标记仍保留已读事实。
    if (Option.isNone(parsed) || parsed.value.stub === true) continue
    const read = parsed.value
    const key = read.canonicalPath || read.path
    const ranges = mergeRanges([...(files.get(key)?.ranges ?? []), { start: read.start, end: read.end }])
    const display = files.get(key)?.path ?? read.path
    // 此表仅传父级已见位置，不读盘或把历史时间伪装成当前新鲜度证明。
    files.delete(key)
    files.set(key, { path: display, ranges })
  }
  if (!files.size) return undefined
  return [
    "### Parent Session Inspected Files", "| path | ranges |", "|---|---|",
    ...[...files.values()].toReversed().slice(0, 20).map(file => {
      // 以真实工作树计算路径，不截尾三段；外部或跨盘路径仍完整保留。
      const absolute = path.resolve(worktree, file.path)
      const relative = path.relative(worktree, absolute)
      const name = !relative.startsWith("..") && !path.isAbsolute(relative) ? relative || "." : absolute
      const shown = file.ranges.slice(0, 8).map(range => `${range.start}-${range.end}`).join(", ")
      const omitted = Math.max(0, file.ranges.length - 8)
      return `| ${cell(name.replaceAll("\\", "/"))} | ${shown}${omitted ? `, ...(+${omitted})` : ""} |`
    }),
    ...(files.size > 20 ? [`Omitted: ${files.size - 20} files due to budget.`] : []),
  ].join("\n")
}
