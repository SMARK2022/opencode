import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { resolveReviewAnchorMessageID } from "../../../src/routes/session/index"

// #551：reviewID 深链锚点解析——纯函数直测（autoReviewMetadata/isVisibleAssistantPart 先例）。
// 生产链形状（permission/reviewer/service.ts recordReviewerRequest/runReviewerAgent）：
// request 是合成 user 消息（text part 携顶层 permissionReviewerRequest+reviewID metadata，不写 parentID）；
// reviewer assistant 决策壳的 parentID === request.id；reviewing 期决策 part 尚未落盘。
// 主路径：request → 同 parent 的最新 assistant（返回区）；无决策（reviewing）退到 request 本身。
// 次选：tool part 的 state.metadata.reviewID（decision 元数据不写顶层 part.metadata）。
describe("resolveReviewAnchorMessageID", () => {
  const msg = (id: string, role: string, parentID?: string) => ({ id, role, parentID })

  test("completed review anchors the reviewer assistant whose parentID is the request", () => {
    // 真实形状：R（request user，无 parentID）→ A（assistant 决策壳，parentID=R.id）。
    const messages = [
      msg("m_request", "user"),
      msg("m_decision", "assistant", "m_request"),
    ]
    const partsOf = (messageID: string) =>
      messageID === "m_request" ? [{ type: "text", metadata: { permissionReviewerRequest: true, reviewID: "rev_1" } }] : []
    expect(resolveReviewAnchorMessageID(messages, partsOf, "rev_1")).toBe("m_decision")
  })

  test("reviewing review falls back to the request message instead of missing", () => {
    // reviewing 期：决策 part 未落盘、无 assistant 壳——answer missing 语义是锚定 request，不是贴底。
    const messages = [msg("m_request", "user")]
    const partsOf = (messageID: string) =>
      messageID === "m_request" ? [{ type: "text", metadata: { permissionReviewerRequest: true, reviewID: "rev_2" } }] : []
    expect(resolveReviewAnchorMessageID(messages, partsOf, "rev_2")).toBe("m_request")
  })

  test("protocol retry takes the last visible request and its own assistant", () => {
    // 协议重试：旧轮被 hide，可见的最后 request 是最终轮；assistant 挂在各自 request 下。
    const messages = [
      msg("m_request_1", "user"),
      msg("m_decision_1", "assistant", "m_request_1"),
      msg("m_request_2", "user"),
      msg("m_decision_2", "assistant", "m_request_2"),
    ]
    const partsOf = (messageID: string) =>
      messageID === "m_request_1" || messageID === "m_request_2"
        ? [{ type: "text", metadata: { permissionReviewerRequest: true, reviewID: "rev_3" } }]
        : []
    expect(resolveReviewAnchorMessageID(messages, partsOf, "rev_3")).toBe("m_decision_2")
  })

  test("residual transcript with only decision tool metadata anchors the tool message", () => {
    // 次选：request part 丢失（残缺数据），decision 的 reviewID 在 tool state.metadata。
    const messages = [msg("m_request", "user"), msg("m_tool", "assistant", "m_request")]
    const partsOf = (messageID: string) => {
      if (messageID === "m_tool") return [{ type: "tool", state: { metadata: { reviewID: "rev_4" } } }]
      return []
    }
    expect(resolveReviewAnchorMessageID(messages, partsOf, "rev_4")).toBe("m_tool")
    expect(resolveReviewAnchorMessageID(messages, partsOf, "rev_missing")).toBeUndefined()
  })

  test("non-request parts carrying metadata never satisfy the request predicate", () => {
    // request 判定要求 text part——tool part 顶层 metadata 命中不得伪装成 request 主路径。
    const messages = [msg("m_tool_only", "user")]
    const partsOf = () => [{ type: "tool", metadata: { permissionReviewerRequest: true, reviewID: "rev_5" } }]
    expect(resolveReviewAnchorMessageID(messages, partsOf, "rev_5")).toBeUndefined()
  })
})

// #551：纯解析与静态接线之外，真实点击/可见帧由auto-review-render的现有夹具验证。
describe("auto review deep link wiring contract", () => {
  const source = readFileSync(
    path.join(import.meta.dir, "..", "..", "..", "src", "routes", "session", "index.tsx"),
    "utf8",
  )
  const routeSource = readFileSync(
    path.join(import.meta.dir, "..", "..", "..", "src", "context", "route.tsx"),
    "utf8",
  )

  test("SessionRoute carries an optional reviewID anchor", () => {
    expect(routeSource).toContain("reviewID?: string")
  })

  test("navigate from review rows carries the reviewID", () => {
    expect(source).toContain('navigate({ type: "session", sessionID: review.sessionID, reviewID: review.reviewID })')
  })

  test("session-open scroll is anchored before bottom snap", () => {
    // 统一滚动入口：锚点存在→child.y 对位；miss/无锚点→贴底。
    expect(source).toContain("function applySessionOpenScroll()")
    expect(source).toContain("function scheduleSessionOpenScroll()")
    expect(source).toContain("scrollBy(child.y - scroll.y - 1)")
    // 两个贴底路径都改走统一入口；undo/prompt on_submit 的 toBottom 保持原语义。
    expect(source).toContain("if (route.sessionID === sessionID) scheduleSessionOpenScroll()")
    // useRouteData("session") 已收窄为 SessionRoute——effect 依赖直接读字段。
    expect(source).toContain("createEffect(on(() => ({ sessionID: route.sessionID, reviewID: route.reviewID }), scheduleSessionOpenScroll))")
  })

  test("assistant messages expose a scroll-child id for anchor lookup", () => {
    // 复用前序消息布局的稳定id与layoutGroups，不额外套wrapper改变几何。
    expect(source).toContain('<box id={props.message.id} flexShrink={0}')
  })
})
