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
  })

  test("delivers unscoped events once (no double-path)", () => {
    // #164：无 project 字段时放行一次
    expect(shouldDeliverScopedEvent({ directory: "/workspace" }, "proj-a")).toBe(true)
  })
})
