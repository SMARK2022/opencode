import { expect, test } from "bun:test"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import { selection } from "../src/session/info"
import { SessionSchema } from "../src/session/schema"

test.each(["ses_projection_a", "ses_projection_b"])("binds request history to one Session identity: %s", (value) => {
  const id = SessionSchema.ID.make(value)
  const query = new SQLiteSyncDialect().sqlToQuery(selection(id).request)
  // 相关外层列会把同一历史CTE重复展开；真实参数是此性能回归的边界。
  expect(query.params.length).toBeGreaterThan(0)
  expect(query.params.every((parameter) => parameter === id)).toBe(true)
  expect(query.sql).not.toContain('"session"."id"')
})

test("keeps one prepared statement shape across Session identities", () => {
  const dialect = new SQLiteSyncDialect()
  const first = dialect.sqlToQuery(selection(SessionSchema.ID.make("ses_projection_a")).request)
  const second = dialect.sqlToQuery(selection(SessionSchema.ID.make("ses_projection_b")).request)
  expect(first.sql).toBe(second.sql)
  expect(first.params).not.toEqual(second.params)
})
