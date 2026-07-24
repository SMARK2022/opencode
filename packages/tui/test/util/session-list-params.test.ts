import { describe, expect, test } from "bun:test"
import {
  appendScanHits,
  isSessionSearchLoading,
  mergeDisplayHits,
  resolveDisplayHits,
  resolveProgressiveSessionListSource,
  resolveSessionListSource,
  sessionListEmptyLabel,
  shouldStopSearchScan,
  SESSION_LIST_BROWSE_LIMIT,
  SESSION_LIST_CONTENT_BATCH,
  SESSION_LIST_CONTENT_DELAY_MS,
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
  // 该用例保留旧 resolveSessionListSource 合同——progressive 迁移后兼容路径仍受测。
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
  // progressive 的 complete 空集合同与此同构：hits=[] 仍停在 search 源。
  test("active search with empty hits stays on search source", () => {
    const browse = [{ id: "a" }]
    expect(resolveSessionListSource({ query: "needle", searchResults: [], browse })).toEqual({
      source: "search",
      sessions: [],
    })
  })

  // #529/#544：仅搜索路径展示 Not Found；无 loading phase 时保持旧语义
  test("empty label is Not Found only for non-empty query without loading phase", () => {
    expect(sessionListEmptyLabel("")).toBeUndefined()
    expect(sessionListEmptyLabel("lsp fix")).toBe("Not Found lsp fix")
  })

  // #544：progressive 常量与首屏延迟是产品阈值，防止 TUI/服务端 batch 再漂移
  // batch=50 与服务端 searchScanByProject 默认候选窗一致；delay 吸收慢打改词。
  test("exports progressive scan batch and delay thresholds", () => {
    expect(SESSION_LIST_CONTENT_BATCH).toBe(50)
    expect(SESSION_LIST_CONTENT_DELAY_MS).toBe(250)
  })

  // #544 INV-01：awaiting_first/partial 显示 Searching…；仅 complete 空结果才 Not Found
  // 修复用户看到的「搜了几秒一直 Not Found」假空态
  test("empty label is Searching while progressive search is incomplete", () => {
    expect(sessionListEmptyLabel("CJK", "awaiting_first")).toBe("Searching…")
    expect(sessionListEmptyLabel("CJK", "partial")).toBe("Searching…")
    expect(sessionListEmptyLabel("CJK", "complete")).toBe("Not Found CJK")
  })

  // #544：partial 有 hits 时仍 source=search，绝不回 browse 闪现其它会话
  // 断言含 phase 回传：调用方据 phase 区分 loading 与 complete 展示。
  test("progressive source stays on search with hits during partial", () => {
    const browse = [{ id: "b", time: { updated: 1 } }]
    const hits = [{ id: "h", time: { updated: 2 } }]
    expect(
      resolveProgressiveSessionListSource({
        query: "CJK",
        phase: "partial",
        hits,
        browse,
      }),
    ).toEqual({ source: "search", sessions: hits, phase: "partial" })
  })

  // #544：Spinner 绑定——仅非空 query 且 phase≠complete 时 loading
  test("isSessionSearchLoading is false for browse and complete", () => {
    expect(isSessionSearchLoading("", "awaiting_first")).toBe(false)
    expect(isSessionSearchLoading("q", "complete")).toBe(false)
    expect(isSessionSearchLoading("q", "partial")).toBe(true)
    expect(isSessionSearchLoading("q", "awaiting_first")).toBe(true)
  })

  // #544 INV-09：early-stop 计数禁止混入 titleHits，否则 complete 偏离 list LIMIT
  test("shouldStopSearchScan ignores title and uses scan length only", () => {
    expect(shouldStopSearchScan(0)).toBe(false)
    expect(shouldStopSearchScan(SESSION_LIST_SEARCH_LIMIT)).toBe(true)
    expect(shouldStopSearchScan(SESSION_LIST_SEARCH_LIMIT - 1)).toBe(false)
  })

  // #544：partial 展示可叠 title∪scan；cap 仅影响 UI，不定义 complete 权威集合
  test("mergeDisplayHits unions title overlay with scan and caps by recency", () => {
    const title = [
      { id: "old-title", time: { updated: 100 } },
      { id: "mid", time: { updated: 200 } },
    ]
    const scan = [
      { id: "new-scan", time: { updated: 300 } },
      { id: "mid", time: { updated: 200 } },
    ]
    const merged = mergeDisplayHits(title, scan, 2)
    expect(merged.map((item) => item.id)).toEqual(["new-scan", "mid"])
  })

  // #544：append 保持 scan 页 recency 顺序，并在 cap 处截断以触发 early-stop
  // 重复 id（翻页边界重放）必须被 seen 过滤，否则 cap 计数虚高提前停扫。
  test("appendScanHits preserves order and caps", () => {
    const base = [{ id: "a" }, { id: "b" }]
    const next = appendScanHits(base, [{ id: "b" }, { id: "c" }], 3)
    expect(next.map((item) => item.id)).toEqual(["a", "b", "c"])
    expect(appendScanHits(base, [{ id: "c" }, { id: "d" }], 3).map((item) => item.id)).toEqual(["a", "b", "c"])
  })

  // #544 INV-12：scan 失败 complete 仍保留 title 首屏；success complete 只信 scan
  test("resolveDisplayHits keeps title overlay on error complete only", () => {
    const title = [{ id: "t1", time: { updated: 2 } }]
    const scan = [{ id: "s1", time: { updated: 1 } }]
    expect(
      resolveDisplayHits({ phase: "complete", terminal: "success", titleHits: title, scanFullHits: scan }).map(
        (item) => item.id,
      ),
    ).toEqual(["s1"])
    expect(
      resolveDisplayHits({ phase: "complete", terminal: "error", titleHits: title, scanFullHits: [] }).map(
        (item) => item.id,
      ),
    ).toEqual(["t1"])
  })
})
