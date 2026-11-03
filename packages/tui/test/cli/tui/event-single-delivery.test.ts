import { describe, expect, test } from "bun:test"
import { shouldDeliverScopedEvent } from "../../../src/context/event"

// #164：单次投递 + 作用域判定；防止 part.delta 双写与跨项目泄漏
// #164：函数可单测，不依赖完整 TUI mount
describe("shouldDeliverScopedEvent", () => {
  test("delivers global directory events always", () => {
    // #164：global 目录事件始终投递
    expect(shouldDeliverScopedEvent({ directory: "global" }, "proj-a")).toBe(true)
  })

  test("delivers project-tagged events only for matching project", () => {
    // #165：project 不匹配则丢弃
    expect(shouldDeliverScopedEvent({ directory: "/x", project: "proj-a" }, "proj-a")).toBe(true)
    expect(shouldDeliverScopedEvent({ directory: "/x", project: "proj-b" }, "proj-a")).toBe(false)
    // 仅活动Session突破Project隔离；切换活动身份后必须重新判定，无Session事件仍隔离。
    expect(shouldDeliverScopedEvent({ project: "proj-b", sessionID: "ses-a" }, "proj-a", "ses-a")).toBe(true)
    expect(shouldDeliverScopedEvent({ project: "proj-b", sessionID: "ses-a" }, "proj-a", "ses-b")).toBe(false)
    expect(shouldDeliverScopedEvent({ project: "proj-b", sessionID: "ses-b" }, "proj-a", "ses-b")).toBe(true)
    expect(shouldDeliverScopedEvent({ project: "proj-b" }, "proj-a", "ses-a")).toBe(false)
    expect(shouldDeliverScopedEvent({ project: "proj-b" }, "proj-a", undefined)).toBe(false)
  })

  test("delivers unscoped events once (no double-path)", () => {
    // #164：无 project 字段时放行一次
    expect(shouldDeliverScopedEvent({ directory: "/workspace" }, "proj-a")).toBe(true)
  })

  // #572：对齐 #570 的 active Session admission 合同——project 分支是唯一跨 Project 兑底位置
  test("admits mismatched-project events only through the active session branch", () => {
    // global 事件不受 Project 或活动会话冲突限制，不能落入后面的隔离分支。
    expect(
      shouldDeliverScopedEvent({ directory: "global", project: "proj-b", sessionID: "sess-2" }, "proj-a", "sess-1"),
    ).toBe(true)
    // #572：project 不匹配时唯一放行路径是活动会话 ID 与事件 sessionID 严格相等
    expect(
      shouldDeliverScopedEvent({ directory: "/x", project: "proj-b", sessionID: "sess-1" }, "proj-a", "sess-1"),
    ).toBe(true)
    // #572：sessionID 不匹配或缺失时保持 Project 隔离，不因活动会话存在而放宽
    expect(
      shouldDeliverScopedEvent({ directory: "/x", project: "proj-b", sessionID: "sess-2" }, "proj-a", "sess-1"),
    ).toBe(false)
    expect(shouldDeliverScopedEvent({ directory: "/x", project: "proj-b" }, "proj-a", "sess-1")).toBe(false)
    // #572：无活动会话时跨 Project 兑底必须关闭，防止 undefined === undefined 意外放行
    expect(shouldDeliverScopedEvent({ directory: "/x", project: "proj-b", sessionID: "sess-1" }, "proj-a")).toBe(false)
    // #572：project 匹配的返回先于 Session 判定，保持 #165 的 Project 分支优先级
    expect(
      shouldDeliverScopedEvent({ directory: "/x", project: "proj-a", sessionID: "sess-2" }, "proj-a", "sess-1"),
    ).toBe(true)
  })
})
