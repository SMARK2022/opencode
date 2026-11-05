/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { directory, json, mount, wait } from "./sync-fixture"

test("Session accounting follows live text, reasoning and usage without mixing requests", async () => {
  const sessionID = "ses_accounting"
  const h = await mount(undefined, { type: "session", sessionID })
  const assistant: AssistantMessage = {
    id: "msg_accounting_assistant", sessionID, role: "assistant", parentID: "msg_accounting_user",
    agent: "build", mode: "build", modelID: "test", providerID: "test",
    path: { cwd: directory, root: directory }, time: { created: 2 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  let sequence = 0
  const publish = (part: Part) => h.emit({
    directory, project: "proj_test",
    payload: { id: `evt_accounting_${++sequence}`, type: "message.part.updated", properties: { sessionID, part, time: 2 } },
  })
  try {
    h.sync.set("message", sessionID, [
      { id: assistant.parentID, sessionID, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test", modelID: "test" } },
      assistant,
    ])
    // 观察共享公共入口的实时数值；40 字符在尚无校准样本时对应 10 token。
    publish({ id: "prt_accounting_text", sessionID, messageID: assistant.id, type: "text", text: "x".repeat(40) })
    await wait(() => h.sync.data.part[assistant.id]?.length === 1)
    expect(h.sync.session.accounting(sessionID).request.totalOutput).toBe(10)
    publish({ id: "prt_accounting_reason", sessionID, messageID: assistant.id, type: "reasoning", text: "y".repeat(20), time: { start: 1 } })
    await wait(() => h.sync.data.part[assistant.id]?.length === 2)
    // 推理也参与流式估算，历史 request 的选择不能借用其他 parent 的输出。
    expect(h.sync.session.accounting(sessionID, 100).step.output).toBe(15)
    expect(h.sync.session.accounting(sessionID, 100, "missing").request.totalOutput).toBe(0)
    publish({
      // finish ID 在正文 ID 之后，fixture 复刻生产 Part 排序而非依赖事件到达顺序。
      id: "prt_accounting_zfinish", sessionID, messageID: assistant.id, type: "step-finish", reason: "stop", cost: 0.25,
      tokens: { input: 17, output: 7, reasoning: 3, cache: { read: 5, write: 2 } },
    })
    h.emit({ directory, project: "proj_test", payload: {
      id: `evt_accounting_${++sequence}`, type: "message.updated",
      properties: { sessionID, info: { ...assistant, time: { created: 2, completed: 3 } } },
    } })
    await wait(() => h.sync.data.message[sessionID]?.some((message) => message.role === "assistant" && message.time.completed === 3) === true)
    // provider 确认后，pure input、含缓存 input、推理合计及 cost 各自保持原口径。
    expect(h.sync.session.accounting(sessionID).request).toEqual({
      input: 24, output: 10, totalInput: 24, totalInputPure: 17, totalOutput: 10, cost: 0.25,
    })
  } finally {
    h.app.renderer.destroy()
  }
})

test("Session accounting combines same-source off-page facts and replaces them on force sync", async () => {
  const sessionID = "ses_accounting_page"
  const parentID = "msg_accounting_page_user"
  const assistant: AssistantMessage = {
    id: "msg_accounting_page_assistant", sessionID, role: "assistant", parentID,
    agent: "build", mode: "build", modelID: "test", providerID: "test",
    path: { cwd: directory, root: directory }, time: { created: 4, completed: 5 }, cost: 0.3,
    tokens: { input: 11, output: 3, reasoning: 2, cache: { read: 5, write: 7 } },
  }
  let outside = { input: 46, inputPure: 22, output: 10, cost: 0.30000000000000004 }
  // 单页故意没有 user，锁定原窗口截断问题，而不是只测试 user/assistant 都在页内的普通情况。
  const h = await mount((url) => {
    if (url.pathname === "/tui/accounting") return json({ [parentID]: outside })
    if (url.pathname === `/session/${sessionID}`) return json({
      id: sessionID, directory, projectID: "proj_test", slug: sessionID, version: "1", title: sessionID, time: { created: 1, updated: 1 },
    })
    if (url.pathname.endsWith("/message")) return json([{ info: assistant, parts: [{
      id: "prt_accounting_page_finish", sessionID, messageID: assistant.id, type: "step-finish", reason: "stop", cost: 0.3,
      tokens: assistant.tokens,
    }] }])
    if (url.pathname.endsWith("/goal")) return json({ goal: null })
    if (url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff")) return json([])
  }, { type: "session", sessionID })
  try {
    h.sync.session.accounting(sessionID)
    await h.sync.session.sync(sessionID)
    // parent user 不在可见页，仍按服务端确认的本 Session 归属选择 request；浮点累计保持原顺序。
    expect(h.sync.session.accounting(sessionID).request).toEqual({
      input: 23, output: 5, totalInput: 69, totalInputPure: 33, totalOutput: 15, cost: 0.6000000000000001,
    })
    outside = { input: 2, inputPure: 2, output: 1, cost: 0 }
    // 第二份响应比第一份更小，可同时发现旧基线残留和把新响应当 delta 相加的错误。
    await h.sync.session.sync(sessionID, { force: true })
    // 权威页替换时基线也替换，而非把新的页外数字再加到旧基线上。
    expect(h.sync.session.accounting(sessionID, undefined, parentID).request.totalInputPure).toBe(13)
    h.route.navigate({ type: "home" })
    await Promise.resolve()
    h.route.navigate({ type: "session", sessionID })
    await h.sync.session.sync(sessionID)
    // 离开后的派生 owner 随正文释放，重新进入不复用已经替换的旧贡献。
    await wait(() => h.sync.session.accounting(sessionID, undefined, parentID).request.totalOutput === 6)
    // 等待的是新 owner 的公共统计结果，不以私有缓存大小或 helper 调用次数证明释放。
    expect(h.sync.session.accounting(sessionID, undefined, parentID).request.totalOutput).toBe(6)
  } finally {
    h.app.renderer.destroy()
  }
})

test("Session accounting keeps the full baseline when SSE evicts a Message during its first read", async () => {
  const sessionID = "ses_accounting_race"
  const parentID = "msg_accounting_race_user"
  const row = (index: number) => {
    const info: AssistantMessage = {
      id: `msg_race_${index}`, sessionID, role: "assistant", parentID,
      agent: "build", mode: "build", modelID: "test", providerID: "test",
      path: { cwd: directory, root: directory }, time: { created: index + 2, completed: index + 3 }, cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const part: Part = { id: `prt_race_${index}`, sessionID, messageID: info.id, type: "step-finish", reason: "stop", cost: 0, tokens: info.tokens }
    return { info, parts: [part] }
  }
  // 固定 300 条真实窗口，下一条 SSE 必然触发淘汰，不依赖机器速度或 sleep 猜测交错。
  const rows = Array.from({ length: 300 }, (_, index) => row(index))
  const entered = Promise.withResolvers<void>()
  const first = Promise.withResolvers<Response>()
  let requested = false
  const h = await mount((url) => {
    if (url.pathname === "/tui/accounting") {
      if (!requested) {
        requested = true
        entered.resolve()
        return first.promise
      }
      // 新窗口已把首个 Message 移到页外，权威基线从 10 变成 11。
      return json({ [parentID]: { input: 11, inputPure: 11, output: 11, cost: 0 } })
    }
    if (url.pathname === `/session/${sessionID}`) return json({
      id: sessionID, directory, projectID: "proj_test", slug: sessionID, version: "1", title: sessionID, time: { created: 1, updated: 1 },
    })
    if (url.pathname.endsWith("/message")) return json(rows)
    if (url.pathname.endsWith("/goal")) return json({ goal: null })
    if (url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff")) return json([])
  }, { type: "session", sessionID })
  let pending: Promise<void> | undefined
  try {
    h.sync.session.accounting(sessionID)
    pending = h.sync.session.sync(sessionID)
    await entered.promise
    // 第一份 HTTP 仍挂起时添加新 Assistant 和 finish，复刻真实持久事件顺序。
    const next = row(300)
    h.emit({ directory, project: "proj_test", payload: {
      id: "evt_race_message", type: "message.updated", properties: { sessionID, info: next.info },
    } })
    h.emit({ directory, project: "proj_test", payload: {
      id: "evt_race_part", type: "message.part.updated", properties: { sessionID, part: next.parts[0], time: 303 },
    } })
    await wait(() => h.sync.data.part[next.info.id]?.length === 1)
    // 旧响应只包含淘汰前的十条历史；它不能覆盖新窗口，也不能被丢弃后永久遗漏十条。
    first.resolve(json({ [parentID]: { input: 10, inputPure: 10, output: 10, cost: 0 } }))
    await pending
    // 独立字面量：原有 310 个 step 再加新到的 1 个；不按 helper 调用次数推断正确性。
    expect(h.sync.session.accounting(sessionID, undefined, parentID).request.totalInputPure).toBe(311)
    expect(h.sync.session.accounting(sessionID, undefined, parentID).request.totalOutput).toBe(311)
  } finally {
    // 红测失败也先释放悬停响应，防止后台 Promise 污染其他 renderer fixture。
    first.resolve(json({}))
    await pending?.catch(() => undefined)
    h.app.renderer.destroy()
  }
})
