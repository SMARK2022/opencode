import { describe, expect, test } from "bun:test"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2/client"
import { mergePartSnapshot, mergePartSnapshots } from "./part-merge"

function running(output: string, progressVersion?: unknown): ToolPart {
  return {
    id: "part_shell",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_shell",
    tool: "bash",
    state: {
      status: "running",
      input: { command: "build" },
      time: { start: 1 },
      metadata: { output, description: "", ...(progressVersion === undefined ? {} : { progressVersion }) },
    },
  }
}

function completed(output: string): ToolPart {
  return {
    ...running(output, 2),
    state: {
      status: "completed",
      input: { command: "build" },
      time: { start: 1, end: 2 },
      title: "",
      metadata: { output, description: "" },
      output,
    },
  }
}

describe("part snapshot merge", () => {
  test("accepts a legacy running shell snapshot when no local Part exists", () => {
    const legacy = running("legacy")
    // 首次恢复没有本地版本可比较；拒绝 legacy 会让新 client 永久缺少最近 checkpoint。
    expect(mergePartSnapshot(undefined, legacy)).toBe(legacy)
  })

  test("normalizes invalid running shell versions to legacy v0", () => {
    const current = running("live", 1)
    // 这些值都可能来自 optional/open metadata 或非 JSON live input；它们必须共享
    // 一个 v0 兼容语义，不能让 app SSE 与 HTTP adapter 各自猜默认值。
    for (const version of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
      expect(mergePartSnapshot(current, running("stale", version))).toBe(current)
    }
    expect(mergePartSnapshot(current, running("new", 2))).toMatchObject({
      state: { status: "running", metadata: { output: "new", progressVersion: 2 } },
    })
  })

  test("keeps terminal dominance in both arrival orders", () => {
    const terminal = completed("done")
    // terminal 后到时无条件胜出；terminal 已存在时，任何 running HTTP/SSE
    // snapshot 都不得把同一 Tool Part 恢复为执行中。
    expect(mergePartSnapshot(running("live", 3), terminal)).toBe(terminal)
    expect(mergePartSnapshot(terminal, running("late", 4))).toBe(terminal)
  })

  test("merges an HTTP Part page through the same per-Part contract", () => {
    const current = running("live", 1)
    // mixed page 同时验证 Tool 走版本合同、text Part 仍按既有 page merge 保留。
    const text = {
      id: "part_text",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "server",
    } satisfies Part
    const merged = mergePartSnapshots([current], [running("legacy"), text])
    expect(merged).toEqual([current, text])
  })
})
