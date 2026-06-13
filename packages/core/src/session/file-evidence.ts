export * as FileEvidence from "./file-evidence"

import path from "path"
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

export const kind = "compaction_evidence_handoff"

export const render = Effect.fn("FileEvidence.render")(function* (
  receipts: readonly unknown[], fs: FSUtil.Interface, worktree: string,
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
    const ranges = [...(files.get(key)?.ranges ?? []), { start: read.start, end: read.end }]
      .sort((a, b) => a.start - b.start || a.end - b.end)
      .reduce<{ start: number; end: number }[]>((result, range) => {
        const last = result.at(-1)
        if (!last || range.start > last.end + 1) result.push({ ...range })
        else last.end = Math.max(last.end, range.end)
        return result
      }, [])
    // 删除再插入让Map顺序代表最近读取，避免文件修改时间影响证据优先级。
    files.delete(key)
    files.set(key, { ...read, canonicalPath: absolute, ranges })
  }
  if (files.size === 0) return undefined
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
    "## Evidence Handoff", "", "### Inspected Files",
    "| path | ranges | total | modified | status |", "|---|---:|---:|---|---|", ...rows,
    ...(files.size > visible.length ? [`Omitted: ${files.size - visible.length} inspected files due to evidence budget.`] : []),
    "", "### Lost Context Notice", "- Use current evidence before repeating reads or commands.",
    "- Treat stale evidence as advisory only.",
  ].join("\n")
})

function cell(value: string) {
  // 文件名可含表格分隔符和换行，转义后仍保持一条证据记录。
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ")
}

function formatModified(ms: number) {
  // 与Read输出使用同一种本地时间，不把UTC字符串与历史凭证混比。
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
