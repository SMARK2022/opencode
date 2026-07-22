import { describe, expect, test } from "bun:test"
import {
  resolveSessionListSource,
  sessionListEmptyLabel,
  SESSION_LIST_BROWSE_LIMIT,
  SESSION_LIST_LOOKBACK_MS,
  SESSION_LIST_SEARCH_LIMIT,
} from "../../src/util/session-list-params"

describe("session list params", () => {
  // #529：半年 lookback / 浏览 1600 / 搜索 400：产品阈值，防止 A/B 再漂移
  test("exports Path A/B lookback and limits", () => {
    expect(SESSION_LIST_LOOKBACK_MS).toBe(180 * 24 * 60 * 60 * 1000)
    expect(SESSION_LIST_BROWSE_LIMIT).toBe(1600)
    expect(SESSION_LIST_SEARCH_LIMIT).toBe(400)
  })

  // #529：query 清空后 createResource 的 stale searchResults 不得再参与合流
  test("empty query forces browse even when searchResults are stale", () => {
    const browse = [{ id: "a" }]
    const stale = [{ id: "search-hit" }]
    expect(resolveSessionListSource({ query: "", searchResults: stale, browse })).toEqual({
      source: "browse",
      sessions: browse,
    })
  })

  // #529：活跃搜索 loading（undefined）不得 ?? 回 browse，避免「无命中前闪现其他会话」
  test("active search uses empty list while searchResults are loading", () => {
    const browse = [{ id: "a" }]
    expect(resolveSessionListSource({ query: "needle", searchResults: undefined, browse })).toEqual({
      source: "search",
      sessions: [],
    })
  })

  // #529：搜索 0 命中必须停在 search 源（Not Found 语义），不能静默回退浏览
  test("active search with empty hits stays on search source", () => {
    const browse = [{ id: "a" }]
    expect(resolveSessionListSource({ query: "needle", searchResults: [], browse })).toEqual({
      source: "search",
      sessions: [],
    })
  })

  // #529：仅搜索路径展示 Not Found；浏览路径返回 undefined 沿用 DialogSelect 默认文案
  test("empty label is Not Found only for non-empty query", () => {
    expect(sessionListEmptyLabel("")).toBeUndefined()
    expect(sessionListEmptyLabel("lsp fix")).toBe("Not Found lsp fix")
  })
})
