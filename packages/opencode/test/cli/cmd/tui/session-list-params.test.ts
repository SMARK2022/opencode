import { describe, expect, test } from "bun:test"
import {
  resolveSessionListSource,
  sessionListEmptyLabel,
  SESSION_LIST_BROWSE_LIMIT,
  SESSION_LIST_LOOKBACK_MS,
  SESSION_LIST_SEARCH_LIMIT,
} from "../../../../src/cli/cmd/tui/util/session-list-params"

describe("session list params", () => {
  // 半年 lookback / 浏览 1600 / 搜索 400：产品阈值，防止 A/B 再漂移
  test("exports Path A/B lookback and limits", () => {
    expect(SESSION_LIST_LOOKBACK_MS).toBe(180 * 24 * 60 * 60 * 1000)
    expect(SESSION_LIST_BROWSE_LIMIT).toBe(1600)
    expect(SESSION_LIST_SEARCH_LIMIT).toBe(400)
  })

  test("empty query forces browse even when searchResults are stale", () => {
    const browse = [{ id: "a" }]
    const stale = [{ id: "search-hit" }]
    expect(resolveSessionListSource({ query: "", searchResults: stale, browse })).toEqual({
      source: "browse",
      sessions: browse,
    })
  })

  // 活跃搜索 loading（undefined）不得 ?? 回 browse，避免「无命中前闪现其他会话」
  test("active search uses empty list while searchResults are loading", () => {
    const browse = [{ id: "a" }]
    expect(resolveSessionListSource({ query: "needle", searchResults: undefined, browse })).toEqual({
      source: "search",
      sessions: [],
    })
  })

  test("active search with empty hits stays on search source", () => {
    const browse = [{ id: "a" }]
    expect(resolveSessionListSource({ query: "needle", searchResults: [], browse })).toEqual({
      source: "search",
      sessions: [],
    })
  })

  test("empty label is Not Found only for non-empty query", () => {
    expect(sessionListEmptyLabel("")).toBeUndefined()
    expect(sessionListEmptyLabel("lsp fix")).toBe("Not Found lsp fix")
  })
})
