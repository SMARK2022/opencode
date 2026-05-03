import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { asc, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import stepUsageMigration from "@opencode-ai/core/database/migration/20260623000000_session_step_usage"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { RequestUsageTable, RequestUsageAssistantTable } from "@opencode-ai/core/session/request-usage.sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Location } from "@opencode-ai/core/location"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])
const sessionID = SessionV2.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content: [], time }))
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

describe("SessionProjector", () => {
  it.effect("keeps native request ownership and rolls back incomplete ledger updates", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      // 使用真实 projector、事务和外键；不在测试里复制请求聚合算法。
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: "test",
        directory: "/project", title: "test", version: "test" }).run()
      const first = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_usage_first"),
        sessionID, prompt: Prompt.make({ text: "first" }), delivery: "steer" })
      const firstRequestID = SessionV1.MessageID.make(first.id)
      const usage = SessionRequestUsage.make(db)
      // admit-only 必须已有零用量请求，尚未产生可见用户消息或助手归属。
      expect(yield* usage.get({ sessionID, requestID: firstRequestID })).toMatchObject({ source: "prompt", assistantCount: 0, cost: 0 })
      expect(yield* db.select().from(SessionMessageTable).all()).toEqual([])
      const second = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_usage_second"),
        sessionID, prompt: Prompt.make({ text: "second" }), delivery: "steer" })
      const requestID = SessionV1.MessageID.make(second.id)
      // 两个真实 admission 一次 promote，不能只修最终输入而留下前一行永久 running。
      yield* SessionInput.promoteSteers(db, events, sessionID, second.admittedSeq)
      const assistantMessageID = SessionMessage.ID.make("msg_usage_assistant")
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, timestamp: created, agent: "resolved", model })
      // 后来接纳的 queue 不能抢走已经开始的 turn，结束时只读冻结的助手归属。
      const queued = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_usage_queued"),
        sessionID, prompt: Prompt.make({ text: "later" }), delivery: "queue" })
      const tokens = { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }
      const settlement = { sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(0), finish: "stop", cost: 0.5, tokens }
      yield* events.publish(SessionEvent.Step.Ended, settlement)
      expect(yield* usage.get({ sessionID, requestID })).toMatchObject({ agent: "resolved", assistantCount: 1,
        stepCount: 1, cost: 0.5, tokens: { ...tokens, total: 20 }, status: "completed", time: { completed: 0 } })
      expect(yield* usage.get({ sessionID, requestID: firstRequestID })).toMatchObject({ rootRequestID: requestID,
        status: "completed", assistantCount: 0, stepCount: 0, cost: 0, tokens: { total: 0 } })
      expect(yield* usage.list({ sessionID, before: 0 })).toEqual([])
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(queued.id) })).toMatchObject({
        rootRequestID: queued.id, status: "running", assistantCount: 0, cost: 0 })
      // 同一助手修订覆盖快照，request 与 #9 Session 累计都不能把两次结算相加。
      yield* events.publish(SessionEvent.Step.Ended, { ...settlement, cost: 0.75 })
      expect(yield* usage.get({ sessionID, requestID })).toMatchObject({ assistantCount: 1, stepCount: 1, cost: 0.75 })
      expect(yield* db.select().from(SessionTable).get()).toMatchObject({ cost: 0.75, tokens_input: 2, tokens_reasoning: 4 })
      // 模拟最终请求回写失败，验证前面的助手 upsert 真正回滚，而非只有接口声明为原子。
      yield* db.run(sql`CREATE TRIGGER reject_request_update BEFORE UPDATE ON request_usage BEGIN SELECT RAISE(ABORT, 'ledger failure'); END`)
      const exit = yield* usage.recordAssistant({ sessionID, requestID,
        assistant: { id: SessionV1.MessageID.make(assistantMessageID), agent: "resolved", providerID: model.providerID,
          modelID: model.id, time: { created: 0, completed: 10 } },
        usage: { count: 1, costMicros: 900000, tokens: { ...tokens, total: 20 } },
      }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(yield* db.select().from(RequestUsageAssistantTable).get()).toMatchObject({ cost_micros: 750000 })
      expect(yield* usage.get({ sessionID, requestID })).toMatchObject({ cost: 0.75 })
      yield* db.run(sql`DROP TRIGGER reject_request_update`)
      // 中断通过事件标志区分 error；已结算 usage 仍保留，不把 provider 消耗退款。
      yield* events.publish(SessionEvent.Step.Failed, { sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(11),
        aborted: true, error: { type: "unknown", message: "interrupted" } })
      expect(yield* usage.get({ sessionID, requestID })).toMatchObject({ status: "aborted", cost: 0.75, error: "interrupted" })
      expect(yield* usage.get({ sessionID, requestID: firstRequestID })).toMatchObject({
        status: "aborted", error: "interrupted", cost: 0, tokens: { total: 0 } })
      // 重放 Failed→Ended 的补结算顺序，不能将 aborted 降成 UnknownError 或重复收费。
      yield* events.publish(SessionEvent.Step.Ended, { ...settlement, timestamp: DateTime.makeUnsafe(11), cost: 0.75 })
      expect(yield* usage.get({ sessionID, requestID })).toMatchObject({ status: "aborted", cost: 0.75,
        assistantCount: 1, stepCount: 1, tokens: { ...tokens, total: 20 }, error: "interrupted" })
      expect(yield* usage.assistants({ sessionID, requestID })).toMatchObject([{ status: "aborted", cost: 0.75, stepCount: 1 }])
      expect(yield* usage.get({ sessionID, requestID: firstRequestID })).toMatchObject({ status: "aborted", cost: 0 })
      expect(yield* db.select().from(SessionTable).get()).toMatchObject({ cost: 0.75, tokens_input: 2, tokens_reasoning: 4 })
      expect((yield* db.select().from(SessionMessageTable).all()).find(row => row.id === assistantMessageID)?.data).toMatchObject({
        finish: "error", error: { type: "unknown", message: "interrupted" }, tokens,
      })
      // 压缩失败结算也有独立请求和根请求；失败不能投影成成功摘要。
      const compactID = SessionMessage.ID.make("msg_usage_compaction")
      yield* events.publish(SessionEvent.Compaction.Started, { sessionID, messageID: compactID,
        timestamp: DateTime.makeUnsafe(12), reason: "auto", model })
      yield* events.publish(SessionEvent.Compaction.Failed, { sessionID, messageID: compactID, timestamp: DateTime.makeUnsafe(13),
        error: { type: "unknown", message: "summary failed" }, usage: { tokens, cost: 0, stepCount: 1 } })
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(compactID) })).toMatchObject({
        source: "system_compaction", rootRequestID: requestID, status: "error", stepCount: 1 })
      expect((yield* db.select().from(SessionMessageTable).all()).some(row => row.type === "compaction")).toBe(false)
      // 后续 steer 属于新的提升批次，不得把旧的零用量成员重新归属到新助手。
      const future = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_usage_future"),
        sessionID, prompt: Prompt.make({ text: "future" }), delivery: "steer" })
      yield* SessionInput.promoteSteers(db, events, sessionID, future.admittedSeq)
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: SessionMessage.ID.make("msg_usage_future_assistant"),
        timestamp: DateTime.makeUnsafe(14), agent: "resolved", model })
      yield* events.publish(SessionEvent.Step.Ended, { ...settlement, assistantMessageID: SessionMessage.ID.make("msg_usage_future_assistant"),
        timestamp: DateTime.makeUnsafe(15), cost: 0 })
      // 新的零美元事件按零记录；旧批次错误和未提升 queue 均不能被这次终态清除。
      expect(yield* usage.get({ sessionID, requestID: firstRequestID })).toMatchObject({ rootRequestID: requestID, status: "aborted", cost: 0 })
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(future.id) })).toMatchObject({ status: "completed", cost: 0 })
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(queued.id) })).toMatchObject({ status: "running", cost: 0 })
      // 删除 Session 由 SQL 外键清理两张明细表，与 Drizzle 定义和迁移契约一致。
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
      expect(yield* db.select().from(RequestUsageTable).all()).toEqual([])
      expect(yield* db.select().from(RequestUsageAssistantTable).all()).toEqual([])
    }),
  )

  it.effect("projects native settlements into public Session totals exactly once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const sessions = yield* SessionV2.Service
      // 只建立会话容器，助手必须由真实 Started 事件产生，避免手工行掩盖 projector 缺口。
      yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* database.db.insert(SessionTable).values({
        id: sessionID, project_id: Project.ID.global, slug: "usage", directory: "/project", title: "usage", version: "test",
      }).run()
      // 请求由真实 Prompted 事件归属，不能在测试中给 native 助手伪造 parentID。
      yield* events.publish(SessionEvent.Prompted, {
        sessionID, messageID: SessionMessage.ID.make("msg_native_request"), timestamp: created,
        prompt: Prompt.make({ text: "request" }), delivery: "steer",
      })
      // admission 与 promotion 的边界由现有 projector 持久化，测试不另建 SQL 归属算法。
      // 每轮给五项不同的非零计数，能发现只累加最后一轮、遗漏 reasoning 或合并 cache 的错误。
      const records = yield* Effect.forEach([1, 2], (factor) => Effect.gen(function* () {
        const assistantMessageID = SessionMessage.ID.make(`msg_native_usage_${factor}`)
        const inputEstimate = { input: 777, bodyChars: 3108, confirmed: false, charsPerToken: 4,
          contextLimit: factor === 1 ? 2000 : 8000,
          inputBreakdown: { system: 2000, instructions: 108, skills: 0, tools: 200,
            messages: { userText: 500, assistantText: 100, reasoning: 50, toolInput: 50, toolOutput: 100, attachments: 0, total: 800 } } }
        // 首包前估算使用真实请求身份，不创建助手，也不重置历史确认累计。
        yield* events.publish(SessionEvent.RequestEstimated, {
          sessionID, messageID: SessionMessage.ID.make("msg_native_request"), timestamp: DateTime.makeUnsafe(factor),
          model, inputEstimate,
        })
        expect((yield* sessions.get(sessionID)).request).toMatchObject({
          messageID: "msg_native_request", input: factor === 1 ? 0 : 14, output: factor === 1 ? 0 : 4,
          stepInput: 0, stepOutput: 0, estimatedInput: 777,
        })
        expect((yield* sessions.get(sessionID)).request?.assistantID).toBeUndefined()
        expect((yield* sessions.get(sessionID)).request?.model).toEqual({ providerID: model.providerID, modelID: model.id, contextLimit: factor === 1 ? 2000 : 8000 })
        // 此刻还没有本轮Started助手，get/list仍须从RequestEstimated持久事件得到同一carrier，不能靠消息窗口补值。
        expect((yield* sessions.get(sessionID)).request?.inputEstimate).toEqual(inputEstimate)
        expect((yield* sessions.list({ project: Project.ID.global })).find(item => item.id === sessionID)?.request?.inputEstimate).toEqual(inputEstimate)
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(factor), agent: "build", model,
          inputEstimate,
        })
        // 第二个原生助手没有 tokens；首轮 14 输入和 4 输出仍是本请求的在途基数。
        expect((yield* sessions.get(sessionID)).request).toMatchObject({ assistantID: assistantMessageID, stepInput: 0, stepOutput: 0 })
        expect((yield* sessions.get(sessionID)).request?.pendingInput).toBe(factor === 1 ? undefined : 18)
        // Started 估算不改变任何确认累计或费用；get/list 共用 canonical 投影。
        expect((yield* sessions.get(sessionID)).request?.estimatedInput).toBe(777)
        expect((yield* sessions.list({ project: Project.ID.global })).find(item => item.id === sessionID)?.request?.estimatedInput).toBe(777)
        const ended = yield* events.publish(SessionEvent.Step.Ended, {
          sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(factor + 1), finish: "stop", cost: factor / 4,
          tokens: { input: factor * 2, output: factor * 3, reasoning: factor, cache: { read: factor * 5, write: factor * 7 } },
        })
        // replay 使用原 durable ID/seq/version，重新 publish 一个新事件不属于重复重放测试。
        if (!ended.durable) return yield* Effect.die("Native settlement must be durable")
        return {
          id: ended.id, aggregateID: ended.durable.aggregateID, seq: ended.durable.seq,
          type: EventV2.versionedType(ended.type, ended.durable.version),
          data: Schema.encodeSync(SessionEvent.Step.Ended.data)(ended.data),
        }
      }))
      const expected = { cost: 0.75, tokens: { input: 6, output: 9, reasoning: 3, cache: { read: 15, write: 21 } } }
      // 验证公开 get/list，而非只读 message.tokens；本次缺陷恰好发生在消息和会话行之间。
      expect(yield* sessions.get(sessionID)).toMatchObject(expected)
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)).toMatchObject(expected)
      // native 两轮请求必须累计五项，V1 parts 表为空也不能得到零。
      expect((yield* sessions.get(sessionID)).request).toMatchObject({
        messageID: "msg_native_request", input: 42, output: 12, cost: 0.75,
        assistantID: "msg_native_usage_2", model: { providerID: "provider", modelID: "model" },
        // 最后 native step 与两轮请求累计不同，验证 #14 没把请求总量显示成 step。
        stepInput: 28, stepOutput: 8,
        // 此确认值不依赖任何 V1 step-finish，也不依赖 TUI 消息窗口。
      })
      expect((yield* sessions.get(sessionID)).request?.pendingInput).toBeUndefined()
      expect((yield* sessions.get(sessionID)).request?.estimatedInput).toBeUndefined()
      // 确认停止 provisional input，但字段证明与冻结预算仍随同一末步投影保留。
      expect((yield* sessions.get(sessionID)).request?.inputEstimate).toMatchObject({ confirmed: true, bodyChars: 3108, charsPerToken: 4, inputBreakdown: { system: 2000 } })
      const selected = ModelV2.Ref.make({
        providerID: model.providerID, id: ModelV2.ID.make("other-alias"), variant: ModelV2.VariantID.make("later"),
      })
      // 真实切换 producer 创建独立消息，不能覆盖已有用户与请求身份。
      yield* sessions.switchModel({ sessionID, model: selected })
      expect((yield* sessions.get(sessionID)).model?.id).toBe(selected.id)
      expect((yield* sessions.get(sessionID)).model?.variant).toBe(ModelV2.VariantID.make("later"))
      expect((yield* sessions.messages({ sessionID, order: "asc" })).at(-1)).toMatchObject({ type: "model-switched", model: selected })
      expect(yield* sessions.message({ sessionID, messageID: SessionMessage.ID.make("msg_native_request") })).toMatchObject({ type: "user", text: "request" })
      expect((yield* sessions.get(sessionID)).request?.model).toEqual({ providerID: model.providerID, modelID: model.id, contextLimit: 8000 })
      expect((yield* sessions.list({ project: Project.ID.global })).find(item => item.id === sessionID)?.request?.model?.contextLimit).toBe(8000)
      expect((yield* sessions.get(sessionID)).tokens).toEqual(expected.tokens)
      // 这里检查公开 get 的投影，不在断言里重复实现事件到请求的归属计算。
      // 重放已经落盘的两次结算，保留现有 sequencer 的去重边界，不在投影中另建标记。
      for (const record of records) yield* events.replay(record)
      expect(yield* sessions.get(sessionID)).toMatchObject(expected)
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)).toMatchObject(expected)
      // updater 可覆盖旧助手的结算；修订应该替换第一轮，不能在两轮总量上再叠加完整用量。
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID, assistantMessageID: SessionMessage.ID.make("msg_native_usage_1"),
        timestamp: DateTime.makeUnsafe(4), finish: "stop", cost: 1,
        tokens: { input: 6, output: 9, reasoning: 3, cache: { read: 15, write: 21 } },
      })
      const corrected = { cost: 1.5, tokens: { input: 10, output: 15, reasoning: 5, cache: { read: 25, write: 35 } } }
      expect(yield* sessions.get(sessionID)).toMatchObject(corrected)
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)).toMatchObject(corrected)
      // 此会话没有 V1 part，用旧的仅 part 回填会得到零；模拟未安装修正的旧 native 数据库。
      yield* database.db.run(sql`DELETE FROM migration WHERE id = ${stepUsageMigration.id}`)
      yield* database.db.update(SessionTable).set({
        tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
      }).where(eq(SessionTable.id, sessionID)).run()
      yield* DatabaseMigration.applyOnly(database.db, [stepUsageMigration])
      // 同一回填仅恢复五项 token，不能以修复旧 native 计数为由重写已有费用。
      expect(yield* sessions.get(sessionID)).toMatchObject(corrected)
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)).toMatchObject(corrected)
      // stage 仅设边界，公开 commit 才删第二轮；保留修订后的第一轮并保持已花费用。
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID, timestamp: DateTime.makeUnsafe(5),
        revert: { messageID: SessionMessage.ID.make("msg_native_usage_1"), diff: "", files: [] },
      })
      yield* sessions.revert.commit(sessionID)
      const reverted = { cost: 1.5, tokens: { input: 6, output: 9, reasoning: 3, cache: { read: 15, write: 21 } } }
      expect(yield* sessions.get(sessionID)).toMatchObject(reverted)
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)).toMatchObject(reverted)
      // 删除后重放旧结算仍由 sequencer 去重，不能复活已删消息或重新加回 token。
      for (const record of records) yield* events.replay(record)
      yield* sessions.revert.commit(sessionID)
      expect(yield* sessions.get(sessionID)).toMatchObject(reverted)
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)).toMatchObject(reverted)
      // revert 删除第二轮后请求费用只取保留助手，会话已花费用仍不退款。
      expect((yield* sessions.get(sessionID)).request).toMatchObject({ input: 42, output: 12, cost: 1 })
      yield* events.publish(SessionEvent.PromptAdmitted, {
        sessionID, messageID: SessionMessage.ID.make("msg_waiting_request"), timestamp: DateTime.makeUnsafe(6),
        prompt: Prompt.make({ text: "waiting" }), delivery: "queue",
      })
      // 尚未 promoted 的最新 admission 是独立零值请求，不能消费旧助手。
      expect((yield* sessions.get(sessionID)).request).toMatchObject({
        messageID: "msg_waiting_request", input: 0, output: 0, cost: 0,
        // 新 admission 没有回复时 step 也必须为零，不能沿用最后一次旧结算。
        stepInput: 0, stepOutput: 0,
        // 保留 assistantID 缺省，避免把“无回复”与“已有未结算回复”混为一类。
      })
      expect((yield* sessions.get(sessionID)).request?.assistantID).toBeUndefined()
      expect((yield* sessions.get(sessionID)).cost).toBe(1.5)
      // 旧助手迟到结算不改变请求身份；只比较 admission/promotion，不比较 Ended 序号。
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID, assistantMessageID: SessionMessage.ID.make("msg_native_usage_1"),
        timestamp: DateTime.makeUnsafe(7), finish: "stop", cost: 1,
        tokens: { input: 6, output: 9, reasoning: 3, cache: { read: 15, write: 21 } },
      })
      expect((yield* sessions.get(sessionID)).request).toMatchObject({
        messageID: "msg_waiting_request", input: 0, output: 0, cost: 0,
      })
      // get/list 同用一个 SQL owner，等待请求没有模型，也没有可借用的助手。
      expect((yield* sessions.get(sessionID)).request?.assistantID).toBeUndefined()
      expect((yield* sessions.get(sessionID)).request?.model).toBeUndefined()
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)?.request).toEqual((yield* sessions.get(sessionID)).request)
      // 真实 V1 turn 更换助手；旧 native 的确认不得混入新 V1 请求的上下文。
      const userID = SessionV1.MessageID.ascending()
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: {
        id: userID, sessionID, role: "user", time: { created: 8 }, agent: "build",
        model: { providerID: model.providerID, modelID: model.id },
      } })
      const legacy: SessionV1.Assistant = { id: SessionV1.MessageID.ascending(), sessionID, role: "assistant", parentID: userID,
        agent: "build", mode: "build", modelID: model.id, providerID: model.providerID,
        path: { cwd: "/project", root: "/project" }, cost: 0,
        tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 5, write: 7 } }, time: { created: 9, completed: 10 } }
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: legacy })
      const finish: SessionV1.StepFinishPart = { id: SessionV1.PartID.ascending(), sessionID, messageID: legacy.id,
        type: "step-finish", reason: "stop", cost: 0, tokens: legacy.tokens }
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, part: finish,
        time: 10 })
      // 第二次确认改变上下文基数，下一轮不能使用请求累计 54 或最早一轮 18。
      const prior = { ...legacy, id: SessionV1.MessageID.ascending(), tokens: { input: 4, output: 6, reasoning: 2, cache: { read: 10, write: 14 } }, time: { created: 10, completed: 11 } }
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: prior })
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, part: { ...finish, id: SessionV1.PartID.ascending(), messageID: prior.id, tokens: prior.tokens },
        time: 11 })
      const next = { ...legacy, id: SessionV1.MessageID.ascending(), tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 12 } }
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: next })
      // 新助手无 parts 时也必须得到上一轮 36，不能借用其他请求或全部轮次。
      expect((yield* sessions.get(sessionID)).request).toMatchObject({
        messageID: userID, assistantID: next.id, input: 42, output: 12, stepInput: 0, stepOutput: 0, pendingInput: 36,
      })
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)?.request).toEqual((yield* sessions.get(sessionID)).request)
      // V1 元数据先到，tokens 仍为零；真实请求体估算不进入确认 input=42。
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: { ...next,
        inputEstimate: { input: 777, bodyChars: 3108, confirmed: false } } })
      expect((yield* sessions.get(sessionID)).request).toMatchObject({ input: 42, output: 12, estimatedInput: 777 })
      // fixture 后续零 step-finish 必须直接遮掉 provisional input，不能等待完成时间。
      // 零 step-finish 是确认边界，不得因为累计仍非零就保留上一轮估算。
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, part: { ...finish, id: SessionV1.PartID.ascending(), messageID: next.id, tokens: next.tokens },
        time: 12 })
      expect((yield* sessions.get(sessionID)).request).toMatchObject({ input: 42, output: 12, stepInput: 0, stepOutput: 0 })
      expect((yield* sessions.get(sessionID)).request?.pendingInput).toBeUndefined()
      expect((yield* sessions.get(sessionID)).request?.estimatedInput).toBeUndefined()
      // completed=0 同样是终态；展示输入不能恢复到先前非零上下文。
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: { ...next, time: { created: 12, completed: 0 } } })
      expect((yield* sessions.get(sessionID)).request?.pendingInput).toBeUndefined()
      // 新用户立即换请求范围，上一请求的确认不得成为它的在途基数。
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: {
        id: SessionV1.MessageID.ascending(), sessionID, role: "user", time: { created: 13 }, agent: "build", model: { providerID: model.providerID, modelID: model.id },
      } })
      expect((yield* sessions.get(sessionID)).request?.pendingInput).toBeUndefined()
      expect((yield* sessions.get(sessionID)).request).toMatchObject({ input: 0, output: 0, stepInput: 0, stepOutput: 0 })
      expect((yield* sessions.get(sessionID)).request?.assistantID).toBeUndefined()
      // 原生零确认没有 V1 part，必须依靠 tokens 是否存在而不是数字真值。
      const zeroRequest = SessionMessage.ID.make("msg_zero_estimate")
      const zeroAssistant = SessionMessage.ID.make("msg_zero_estimate_assistant")
      const inputEstimate = { input: 777, bodyChars: 3108, confirmed: false }
      yield* events.publish(SessionEvent.Prompted, { sessionID, messageID: zeroRequest,
        timestamp: DateTime.makeUnsafe(14), prompt: Prompt.make({ text: "zero" }), delivery: "steer" })
      yield* events.publish(SessionEvent.RequestEstimated, { sessionID, messageID: zeroRequest,
        timestamp: DateTime.makeUnsafe(15), model, inputEstimate })
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: zeroAssistant,
        timestamp: DateTime.makeUnsafe(16), agent: "build", model, inputEstimate })
      yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID: zeroAssistant,
        timestamp: DateTime.makeUnsafe(17), finish: "stop", cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
      expect((yield* sessions.get(sessionID)).request).toMatchObject({ input: 0, output: 0, stepInput: 0, stepOutput: 0 })
      expect((yield* sessions.get(sessionID)).request?.estimatedInput).toBeUndefined()
      // 空成功只闭合现有请求，估算事件不制造零用量助手或额外 provider turn。
      const emptyRequest = SessionMessage.ID.make("msg_empty_estimate")
      yield* events.publish(SessionEvent.Prompted, { sessionID, messageID: emptyRequest,
        timestamp: DateTime.makeUnsafe(18), prompt: Prompt.make({ text: "empty" }), delivery: "steer" })
      yield* events.publish(SessionEvent.RequestEstimated, { sessionID, messageID: emptyRequest,
        timestamp: DateTime.makeUnsafe(19), model, inputEstimate })
      yield* events.publish(SessionEvent.PromptCompleted, { sessionID, messageID: emptyRequest,
        timestamp: DateTime.makeUnsafe(20), requestIDs: [emptyRequest] })
      expect((yield* sessions.get(sessionID)).request?.assistantID).toBeUndefined()
      expect((yield* sessions.get(sessionID)).request?.estimatedInput).toBeUndefined()
      expect((yield* sessions.get(sessionID)).request?.model).toBeUndefined()
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("projects moved sessions without the transitional context epoch table", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      yield* db.run(sql`DROP TABLE session_context_epoch`)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/project/subdir") }),
      })

      expect(yield* db.select({ directory: SessionTable.directory }).from(SessionTable).get()).toEqual({
        directory: "/project/subdir",
      })
    }),
  )

  it.effect("projects staged, cleared, and committed reverts", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      const boundary = SessionMessage.ID.make("msg_boundary")
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(boundary, 1), assistantRow(SessionMessage.ID.make("msg_later"), 2)])
        .run()
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        revert: { messageID: boundary, snapshot: Snapshot.ID.make("tree"), diff: "patch", files: [] },
      })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toMatchObject({
        messageID: boundary,
        snapshot: "tree",
        files: [],
      })
      yield* events.publish(SessionEvent.RevertEvent.Cleared, { sessionID, timestamp: DateTime.makeUnsafe(2) })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toBeNull()
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        revert: { messageID: boundary, files: [] },
      })
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(4),
      })
      expect(
        (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all()).map((row) => row.id),
      ).toEqual([boundary])
    }),
  )

  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_first"),
          timestamp: created,
          prompt: Prompt.make({ text: "first" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_z") },
      )
      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_second"),
          timestamp: created,
          prompt: Prompt.make({ text: "second" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_a") },
      )

      const sessions = yield* SessionV2.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("marks an inbox row promoted with the Prompted event sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_admitted")
      const admitted = yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })
      if (!admitted) return yield* Effect.die("Prompt admission failed")

      const event = yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: admitted.timeCreated,
        messageID: id,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })

      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: event.durable?.seq })
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        agent: "build",
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        model,
      })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        text: "synthetic context",
      })
      yield* events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        callID: "shell-1",
        command: "pwd",
      })
      yield* events.publish(SessionEvent.Shell.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        callID: "shell-1",
        output: "/project",
      })
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        text: "partial",
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, SessionEvent.Compaction.Delta.type))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
        text: "summary",
        recent: "recent context",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        output: "/project",
        time: { completed: DateTime.makeUnsafe(1) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "summary",
        recent: "recent context",
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: DateTime.toEpochMillis(created),
      })
    }),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_creator_collision")

      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: id, timestamp: created, text: "keep me" })
      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          timestamp: created,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("does not revive a stale incomplete in-memory assistant projection", () =>
    Effect.gen(function* () {
      const stale = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_stale"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created },
      })
      const completed = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_completed"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
      })

      expect(
        yield* SessionMessageUpdater.memory({ messages: [stale, completed] }).getCurrentAssistant(),
      ).toBeUndefined()
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        time: { completed: DateTime.makeUnsafe(1) },
      })
    }),
  )

  it.effect("does not revive a stale incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-stale",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: "build",
          model,
          content: [SessionMessage.AssistantText.make({ type: "text", id: "text-stale", text: "" })],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )
})
