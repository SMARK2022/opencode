import { expect, test } from "bun:test"
import type { Part, Session as SessionInfo, UserMessage } from "@opencode-ai/sdk/v2"
import { formatTranscript } from "../../src/util/transcript"

const session: SessionInfo = {
  id: "ses_export",
  slug: "export",
  projectID: "proj_test",
  directory: "/tmp/export",
  title: "export",
  version: "1.0.0",
  time: { created: 1, updated: 2 },
}

test("formatTranscript renders the full daemon message list including messages outside the render window", () => {
  // #254：export 命令改为 daemon 全量读取后，formatTranscript 直接消费 SDK 的
  // { info, parts }[] 形态——本测试锁定该数据契约与导出内容的完整性
  // #254：old message 模拟渲染窗口（200 条）之外的历史——export 改为 daemon 全量
  // 读取的核心价值就是让这类消息进入导出，而不是复用本地窗口快照
  const messages = [
    {
      info: {
        id: "msg_old", sessionID: session.id, role: "user", time: { created: 1 },
        agent: "build", model: { providerID: "provider", modelID: "model" },
      } satisfies UserMessage, // #254：created 顺序即导出顺序——旧消息必须排在窗口消息之前
      parts: [{
        id: "part_old", sessionID: session.id, messageID: "msg_old", type: "text",
        text: "old message only available from daemon full export",
      } satisfies Extract<Part, { type: "text" }>],
    },
    {
      info: {
        id: "msg_recent", sessionID: session.id, role: "user", time: { created: 2 },
        agent: "build", model: { providerID: "provider", modelID: "model" },
      } satisfies UserMessage,
      parts: [{
        id: "part_recent", sessionID: session.id, messageID: "msg_recent", type: "text",
        text: "recent message in TUI render window",
      } satisfies Extract<Part, { type: "text" }>],
    },
  ]

  // #254：thinking/toolDetails/assistantMetadata 三开关沿用 DialogExportOptions 的用户选择，
  // providers 来自 sync store——与生产命令层的第三参完全同形
  const out = formatTranscript(session, messages, { thinking: true, toolDetails: true, assistantMetadata: true })
  // #254：窗口外与窗口内消息都必须出现——导出完整性按消息 id 逐一锁定
  expect(out).toContain("old message only available from daemon full export")
  expect(out).toContain("recent message in TUI render window")
})

test("formatTranscript renders an empty daemon list without throwing", () => {
  // #254：空数组是合法 daemon 响应（会话无可见消息），产出仅含元数据头；
  // data 缺失才是异常形态，由命令层显式 throw 沿用失败 toast
  const out = formatTranscript(session, [], { thinking: false, toolDetails: false, assistantMetadata: false })
  // #254：data 缺失才是异常形态（命令层显式 throw）；空数组必须安静地产出元数据头
  expect(out).toContain("# export")
  expect(out).toContain("**Session ID:** ses_export")
})
