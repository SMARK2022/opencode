import { expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMemento } from "@opencode-ai/core/session/compaction-memento"
import { Token } from "@opencode-ai/core/util/token"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { DateTime } from "effect"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  // 验证真实共享提示词的两个恢复分区，避免只更新 agent 文本却遗漏 V2 使用的模板。
  expect(prompt).toContain("## Files & Code")
  expect(prompt).toContain("## Errors & Fixes")
  expect(prompt).toContain("- Respond in the same language as the conversation.")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
  expect(prompt).toContain("- Respond in the same language as the conversation.")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
  // 检查真实shell与已完成工具序列化；只省略交付文本，不改持久消息或媒体策略。
  const text = "x".repeat(2_006)
  const created = DateTime.makeUnsafe(0)
  const shell = SessionMessage.Shell.make({
    id: SessionMessage.ID.make("msg_notice_shell"), type: "shell", callID: "shell-notice",
    command: "pwd", output: text, time: { created, completed: created },
  })
  const assistant = SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_notice_assistant"), type: "assistant", agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content: [SessionMessage.AssistantTool.make({
      type: "tool", id: "notice-tool", name: "read", time: { created, completed: created },
      state: SessionMessage.ToolStateCompleted.make({ status: "completed", input: {}, structured: {}, content: [{ type: "text", text }] }),
    })],
    time: { created, completed: created },
  })
  for (const message of [shell, assistant]) {
    const result = SessionCompaction.serialize(message)
    expect(result).toContain(`${"x".repeat(2_000)}\n[... compaction truncated 6 chars]`)
    expect(result).not.toContain("[truncated]")
    expect(result).not.toContain("compaction_cleared")
  }
  expect(shell.output).toBe(text)
  expect(SessionCompaction.serialize({ ...shell, output: "short" })).toBe("[Shell]: pwd\nshort")
})

test("recent user memento budgets the full envelope and preserves newest literal instructions", () => {
  const messages = [
    { id: "msg_old", text: "old prefix " + "x".repeat(100_000) + " old suffix" },
    { id: "msg_latest", text: '最新原话\n"exact"' },
  ]
  const selected = SessionMemento.collect(messages, 400)
  const replay = SessionMemento.format(selected)
  // 最新优先采集、最终原序；超长的较早指令只保留前缀并明确标记预算截断。
  expect(selected.map(message => message.id)).toEqual(["msg_old", "msg_latest"])
  expect(replay).toStartWith("<recent-user-messages>\nRecent user instructions preserved verbatim for continuity. They may overlap with the retained transcript tail.")
  expect(replay).toContain('最新原话\n"exact"')
  expect(replay).toContain('id="msg_old" truncated="true"')
  expect(replay).toContain("old prefix")
  expect(replay).not.toContain("old suffix")
  // 标签、intro和截断标记同样计费；零预算与空文本不产出空信封。
  expect(Token.estimate(replay)).toBeLessThanOrEqual(400)
  expect(SessionMemento.collect(messages, 0)).toEqual([])
  expect(SessionMemento.collect([{ id: "msg_empty", text: "  " }], 400)).toEqual([])
})
