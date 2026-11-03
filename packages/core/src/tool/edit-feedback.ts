export * as EditFeedback from "./edit-feedback"

import path from "path"
import { DateTime } from "effect"
import type { SessionMessage } from "../session/message"
import { ReadPresentation } from "./read-presentation"
import { mergeRanges } from "../util/range"

export type FileTouchHistory = {
  lastReadEnd: number
  lastWriteEnd: number
  lastWriteTool: string
  readRanges: Array<{ start: number; end: number }>
  sameNameRead?: string
}

// Native仅适配正式历史形状；两代时效与区间文案继续由下方同一纯格式器持有。
export function scanFileTouchHistory(
  messages: readonly SessionMessage.Message[],
  filePath: string,
  directory: string,
): FileTouchHistory {
  const canonical = (value: string) => ReadPresentation.canonicalReadPath(path.resolve(directory, value))
  const target = canonical(filePath)
  const targetName = path.basename(filePath).toLowerCase()
  const history: FileTouchHistory = { lastReadEnd: -1, lastWriteEnd: -1, lastWriteTool: "", readRanges: [] }
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (
        part.type !== "tool" ||
        part.state.status !== "completed" ||
        part.provider?.executed ||
        part.time.completed === undefined
      )
        continue
      const end = DateTime.toEpochMillis(part.time.completed)
      if (part.name === "read") {
        const output = part.state.structured
        const meta = output.read
        // 与实际模型投影相同，pruned/stub、媒体或通用裁切结果不能冒充完整可见读取。
        if (
          part.time.pruned !== undefined ||
          !ReadPresentation.isReadRangeMeta(meta) ||
          meta.stub ||
          (meta.returned === 0 && meta.size > 0)
        )
          continue
        if (typeof output.content !== "string" || (output.encoding !== "utf8" && output.type !== "text-page")) continue
        if (
          part.state.outputPaths?.length ||
          part.state.attachments?.length ||
          part.state.content.some((item) => item.type !== "text")
        )
          continue
        const body = ReadPresentation.renderNativeRead({ ...output, content: output.content, read: meta })
        if (
          part.state.content.length > 0 &&
          !part.state.content.some((item) => item.type === "text" && item.text === body)
        )
          continue
        if (meta.canonicalPath === target) {
          history.readRanges.push({ start: meta.start, end: meta.end })
          history.lastReadEnd = Math.max(history.lastReadEnd, end)
        } else if (path.basename(meta.path).toLowerCase() === targetName) history.sameNameRead = meta.path
        continue
      }
      // edit/write沿提交路径识别；完成时钟取max，回放排序不能覆盖更晚事实。
      if (part.name === "edit" || part.name === "write") {
        if (
          typeof part.state.input.path === "string" &&
          canonical(part.state.input.path) === target &&
          end > history.lastWriteEnd
        ) {
          history.lastWriteEnd = end
          history.lastWriteTool = part.name
        }
        continue
      }
      if (part.name !== "apply_patch" || !Array.isArray(part.state.structured.applied)) continue
      const applied: unknown[] = part.state.structured.applied
      // 只认真实成功回执的target，不解析请求patchText推断副作用或漏掉Move两端。
      const touched = applied.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "target" in item &&
          typeof item.target === "string" &&
          canonical(item.target) === target,
      )
      if (touched && end > history.lastWriteEnd) {
        history.lastWriteEnd = end
        history.lastWriteTool = part.name
      }
    }
  }
  return history
}

// 原话只陈述自写与可见读取的先后，不增加re-read要求或改变工具准入。
export function formatStalenessNote(history: FileTouchHistory) {
  if (history.lastWriteEnd <= 0 || history.lastWriteEnd <= history.lastReadEnd) return ""
  return history.lastReadEnd > 0
    ? `\n\nThis file was modified by your own ${history.lastWriteTool} after your last read. Use the result returned by that call (its diff or formatted-changes section) as the current content.`
    : `\n\nThis file was last modified by your own ${history.lastWriteTool} in this session and has not been read since.`
}

// 仅合并实际可见区间；同名异路径保持明确身份，不把近邻文件当成目标已读。
export function formatMismatchHistory(history: FileTouchHistory) {
  let notes = formatStalenessNote(history)
  if (history.readRanges.length > 0) {
    const merged = mergeRanges(history.readRanges)
    notes += `\n\nLines of this file you have read in this session: ${merged.map((range) => `${range.start}-${range.end}`).join(", ")}.`
  }
  if (history.sameNameRead) {
    notes += `\n\nYou previously read a different file with the same name: ${history.sameNameRead}.`
  }
  return notes
}
