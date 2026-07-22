import { describe, expect, test } from "bun:test"
import { createDialogSessionListQuery, loadDialogSessionList, matchesDialogSessionSearch, visibleSessions } from "../../src/component/dialog-session-list"

describe("dialog session list", () => {
  test("retains body matches without admitting unrelated pinned sessions", () => {
    const session = { id: "body-match", title: "Deployment notes" }
    // 标题不含搜索词时，已由服务端正文匹配的会话也必须出现在结果中。
    expect(matchesDialogSessionSearch(session, "needle", [session])).toBe(true)
    expect(matchesDialogSessionSearch(session, "needle", [])).toBe(false)
    expect(matchesDialogSessionSearch(session, "deployment", [])).toBe(true)
  })

  test("requests root sessions for the default browse list", () => {
    // #306：精确匹配无 start 的浏览请求，防止搜索窗口泄漏到历史浏览。
    expect(createDialogSessionListQuery({ filter: { path: "packages/tui" } })).toEqual({
      roots: true,
      limit: 1600,
      path: "packages/tui",
    })
  })

  test("requests root sessions for search results", () => {
    expect(createDialogSessionListQuery({ search: " deploy ", filter: { scope: "project" } })).toEqual({
      roots: true,
      start: expect.any(Number),
      // #529：搜索窗口扩到半年、limit 100→400（与 util/session-list-params 同源）。
      limit: 400,
      search: "deploy",
      scope: "project",
    })
  })

  test("keeps the cache usable while the root request is pending", async () => {
    let resolve!: (result: { data: string[] }) => void
    const pending = loadDialogSessionList<string>({
      filter: {},
      list: () => new Promise((done) => (resolve = done)),
    })

    expect(await Promise.race([pending, Promise.resolve("pending")])).toBe("pending")
    resolve({ data: ["root"] })
    expect(await pending).toEqual(["root"])
  })

  test("falls back when the root request returns an error response", async () => {
    expect(await loadDialogSessionList({ filter: {}, list: async () => ({}) })).toBeUndefined()
  })

  test("falls back when the root request rejects", async () => {
    expect(
      await loadDialogSessionList({
        filter: {},
        list: () => Promise.reject(new Error("offline")),
      }),
    ).toBeUndefined()
  })

  // #529：服务端搜索是唯一判定权威——跨字段命中（title 含 alpha、content 含 beta）
  // 的返回集必须直通显示，客户端不得二次过滤；token 过滤只约束本地注入的 extra。
  // 本用例锁定 R1 审计 B-0529-01 修复后的显示面合同（服务端直通 + extra token 收窄）。
  test("keeps cross-field server hits visible while filtering locally injected extras by title tokens", () => {
    const serverHit = { id: "s1", title: "alpha-holder" }
    const extraUnrelated = { id: "p1", title: "totally unrelated" }
    const extraMatched = { id: "p2", title: "alpha and beta title" }
    expect(
      visibleSessions({
        result: [serverHit],
        extra: [extraUnrelated, extraMatched],
        deleted: new Set(),
        query: "alpha beta",
      }),
    ).toEqual([serverHit, extraMatched])
    // 浏览态（空 query）：extra 全量注入，服务端结果同样不过滤
    expect(
      visibleSessions({
        result: [serverHit],
        extra: [extraUnrelated],
        deleted: new Set(),
        query: "   ",
      }),
    ).toEqual([serverHit, extraUnrelated])
    // 已删除会话在两源中都被排除
    expect(
      visibleSessions({
        result: [serverHit],
        extra: [extraMatched],
        deleted: new Set(["s1"]),
        query: "alpha beta",
      }),
    ).toEqual([extraMatched])
  })
})
