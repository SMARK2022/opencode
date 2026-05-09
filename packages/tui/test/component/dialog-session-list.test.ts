import { describe, expect, test } from "bun:test"
import { createDialogSessionListQuery, loadDialogSessionList, matchesDialogSessionSearch } from "../../src/component/dialog-session-list"

describe("dialog session list", () => {
  test("retains body matches without admitting unrelated pinned sessions", () => {
    const session = { id: "body-match", title: "Deployment notes" }
    // 标题不含搜索词时，已由服务端正文匹配的会话也必须出现在结果中。
    expect(matchesDialogSessionSearch(session, "needle", [session])).toBe(true)
    expect(matchesDialogSessionSearch(session, "needle", [])).toBe(false)
    expect(matchesDialogSessionSearch(session, "deployment", [])).toBe(true)
  })

  test("requests root sessions for the default browse list", () => {
    expect(createDialogSessionListQuery({ filter: { path: "packages/tui" } })).toEqual({
      roots: true,
      limit: 100,
      path: "packages/tui",
    })
  })

  test("requests root sessions for search results", () => {
    expect(createDialogSessionListQuery({ search: " deploy ", filter: { scope: "project" } })).toEqual({
      roots: true,
      limit: 30,
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
})
