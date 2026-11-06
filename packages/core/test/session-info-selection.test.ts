import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import { CompactionBoundary } from "../src/session/compaction-boundary"
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

test("request and boundary projections stay within indexed ranges", () => {
  using db = new Database(":memory:")
  // 同时提供两条真实索引，避免测试因缺少错误候选计划而虚假通过。
  db.exec(`
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, cold_ref TEXT, cold_key BLOB);
    CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
    CREATE INDEX message_session_parent_time_created_id_idx ON message(session_id, json_extract(data, '$.parentID'), time_created, id);
    CREATE INDEX message_session_compaction_time_created_id_idx ON message(session_id, time_created, id) WHERE json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.summary') = 1 AND coalesce(json_extract(data, '$.finish'), '') != '' AND coalesce(json_type(data, '$.error'), 'null') = 'null';
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
    CREATE INDEX part_message_id_id_idx ON part(message_id, id);
    CREATE INDEX part_session_idx ON part(session_id);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, data TEXT);
    CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id, type, seq);
    CREATE TABLE session_input (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, promoted_seq INTEGER, admitted_seq INTEGER);
    CREATE INDEX session_input_session_promoted_seq_idx ON session_input(session_id, promoted_seq);
    CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, type TEXT, seq INTEGER, data TEXT);
    CREATE INDEX event_aggregate_type_seq_idx ON event(aggregate_id, type, seq);
  `)
  const query = new SQLiteSyncDialect().sqlToQuery(selection(SessionSchema.ID.make("ses_projection_plan")).request)
  const plan = db.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN SELECT ${query.sql}`).all(...query.params.map(String))
  // 验证访问范围而非毫秒阈值，慢 CI 主机不应改变正确性判断。
  expect(plan.filter(row => /SEARCH p USING INDEX part_session_idx/.test(row.detail))).toEqual([])
  expect(plan.filter(row => /SEARCH p USING INDEX part_message_id_id_idx/.test(row.detail)).length).toBeGreaterThanOrEqual(2)
  // a 只是存在性探针；真正读取助手集合的 m 也必须同时按 Session 和 parentID 点查。
  expect(plan.some(row => row.detail.includes("SEARCH m USING INDEX message_session_parent_time_created_id_idx (session_id=? AND <expr>=?)"))).toBe(true)
  // 在同一真实投影上改变生命周期，prepared 数值仍应可读；不是为测试复制 SQL 选择规则。
  const message = db.query("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
  message.run("u", "ses_projection_plan", 1, JSON.stringify({ role: "user" }))
  message.run("a", "ses_projection_plan", 2, JSON.stringify({
    role: "assistant", parentID: "u", time: { created: 2 },
    inputEstimate: { input: 777, bodyChars: 3108, confirmed: false },
  }))
  const estimate = () => db.query<{ estimate: number | null }, string[]>(
    `SELECT json_extract(${query.sql}, '$.estimatedInput') AS estimate`,
  ).get(...query.params.map(String))
  expect(estimate()).toEqual({ estimate: 777 })
  db.exec("UPDATE message SET data = json_set(data, '$.time.completed', 3) WHERE id = 'a'")
  expect(estimate()).toEqual({ estimate: 777 })
  // 零报告与已有估算取最大值，不能把777输入估算清除。
  db.query("INSERT INTO part (id, session_id, message_id, data) VALUES (?, ?, ?, ?)").run(
    "finish", "ses_projection_plan", "a", JSON.stringify({
      type: "step-finish", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )
  // 零记录及完成消息均保留已有估算，直到出现非零用量。
  expect(estimate()).toEqual({ estimate: 777 })
  db.exec("UPDATE message SET data = json_set(data, '$.inputEstimate.confirmed', json('true')) WHERE id = 'a'")
  expect(estimate()).toEqual({ estimate: 777 })
  // 执行历史中的子调用不属于下一次模型请求，不能把末步 1000/10 遮成 pending。
  db.exec("UPDATE part SET data = json_set(data, '$.tokens.input', 1000, '$.tokens.output', 10) WHERE id = 'finish'")
  expect(estimate()).toEqual({ estimate: null })
  db.query("INSERT INTO part (id, session_id, message_id, data) VALUES (?, ?, ?, ?)").run(
    "z-child", "ses_projection_plan", "a", JSON.stringify({ type: "tool", metadata: { executeParent: "call" } }),
  )
  expect(db.query<{ input: number }, string[]>(`SELECT json_extract(${query.sql}, '$.stepInput') AS input`).get(...query.params.map(String))).toEqual({ input: 1000 })
  // 解释真实边界读取器发出的查询，不在测试中复制其业务筛选逻辑。
  const boundaryPlan: string[] = []
  CompactionBoundary.latest(drizzle({ client: db, logger: {
    logQuery(query, params) {
      boundaryPlan.push(...db.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${query}`).all(...params.map(String)).map(row => row.detail))
    },
  } }), SessionSchema.ID.make("ses_projection_plan"))
  expect(boundaryPlan.some(detail => detail.includes("USING INDEX message_session_compaction_time_created_id_idx"))).toBe(true)
})
