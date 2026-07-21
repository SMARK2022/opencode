import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Session as SessionNs } from "@/session/session"
import { SessionGoal } from "@/session/goal"
import { MessageID, SessionID } from "@/session/schema"
import { GoalTool, type GoalTurnContext } from "@/tool/goal"
import { Truncate } from "@/tool/truncate"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Log from "@opencode-ai/core/util/log"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

// 测试 layer 组装：GoalTool 依赖 Agent + Truncate，
// SessionGoal 依赖 Bus + DB，Session 依赖 Bus + Storage + SyncEvent + BackgroundJob
const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Truncate.defaultLayer,
    SessionGoal.layer.pipe(Layer.provide(Bus.layer)),
    SessionNs.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

// 构建工具执行上下文的辅助函数
function makeCtx(sessionID: SessionID, goalSvc: SessionGoal.Interface, goalTurn?: GoalTurnContext) {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [] as any[],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    extra: { goalSvc, ...(goalTurn ? { goalTurn } : {}) },
  }
}

const setupGoalTool = Effect.fn("test.setupGoalTool")(function* (objective?: string) {
  const goalSvc = yield* SessionGoal.Service
  const session = yield* (yield* SessionNs.Service).create({})
  const def = yield* (yield* GoalTool).init()
  if (objective) yield* goalSvc.set(session.id, { objective })
  return { goalSvc, session, def }
})

// [local-smark] GoalTool read gate 行为测试：
// 验证模型必须先 operate=read 才能写 terminal status，
// 验证 reason 和 blocked streak 通过 Tool 正确传播，
// 验证 active recovery 通过 Tool 正确拒绝或成功

it.instance(
  "read operation returns no goal message when no goal exists",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool()

      const result = yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc))
      expect(result.output).toContain("No goal")
    }),
  { git: true },
)

it.instance(
  "read operation returns goal info and writes snapshot to goalTurn",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test objective")

      // goalTurn 初始无 read snapshot
      const goalTurn: GoalTurnContext = {
        id: "turn1",
        userInitiated: true,
      }
      const result = yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, goalTurn))

      // read 返回 Goal 信息，并建立 transition 所需的 trusted snapshot。
      expect(result.output).toContain("test objective")
      expect(result.output).toContain("active")

      // trusted snapshot 被写入 goalTurn，供后续 transition 校验
      expect(goalTurn.read).toBeDefined()
      expect(goalTurn.read!.status).toBe("active")
    }),
  { git: true },
)

it.instance(
  "transition without prior read explains how to establish the read gate",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test")

      // goalTurn 无 read snapshot → transition 必须失败
      const goalTurn: GoalTurnContext = { id: "turn1", userInitiated: true }
      const result = yield* def.execute(
        { operate: "complete", reason: "done" },
        makeCtx(session.id, goalSvc, goalTurn),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        // Tool wrapper 把执行失败转为 defect；模型最终看到的正是 squash 后的消息。
        const error = Cause.squash(result.cause) as Error
        expect(error.message).toContain("operate `read`")
        expect(error.message).toContain("retry with operate and reason")
      }
    }),
  { git: true },
)

it.instance(
  "complete after read succeeds and persists reason",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test")

      // 先显式 read 建立 snapshot，随后同一 Goal turn 才允许 transition。
      const goalTurn: GoalTurnContext = { id: "turn1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, goalTurn))

      // 再 complete
      const result = yield* def.execute(
        { operate: "complete", reason: "all done" },
        makeCtx(session.id, goalSvc, goalTurn),
      )
      expect(result.output).toContain("complete")
      expect(result.output).toContain("all done")

      // 验证持久化
      const goal = yield* goalSvc.get(session.id)
      if (Option.isSome(goal)) {
        expect(goal.value.status).toBe("complete")
        expect(goal.value.reason).toBe("all done")
      }
    }),
  { git: true },
)

it.instance(
  "missing terminal reason explains how to retry the operation",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test")

      const turn: GoalTurnContext = { id: "turn1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn))
      const result = yield* def.execute(
        { operate: "complete" },
        makeCtx(session.id, goalSvc, turn),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        // 模型需要同时知道拒绝原因和下一次合法调用，不接受只有名词短语的错误。
        const error = Cause.squash(result.cause) as Error
        expect(error.message).toContain("non-empty reason")
        expect(error.message).toContain("retry with operate complete")
      }
    }),
  { git: true },
)

it.instance(
  "stale objective rejection tells the model to read again",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("original")
      const turn: GoalTurnContext = { id: "turn1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn))
      yield* goalSvc.set(session.id, { objective: "revised" })

      const result = yield* def.execute(
        { operate: "complete", reason: "finished original" },
        makeCtx(session.id, goalSvc, turn),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        // stale rejection 不能只说 mismatch；模型必须知道重新读取 revised Goal 后再决策。
        const error = Cause.squash(result.cause) as Error
        expect(error.message).toContain("objective has been edited")
        expect(error.message).toContain("Call operate read again")
      }
    }),
  { git: true },
)

it.instance(
  "blocked streak through tool: two consecutive turns",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test")

      // Turn 1: read then blocked → pending
      const turn1: GoalTurnContext = { id: "t1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn1))
      const r1 = yield* def.execute(
        { operate: "blocked", reason: "stuck on X" },
        makeCtx(session.id, goalSvc, turn1),
      )
      expect(r1.output).toContain("attempt 1")
      // 首轮必须明确保持 active、继续 BFS 探索和发现路径后继续，而不是只重复计数。
      expect(r1.output).toContain("The Goal stays active")
      expect(r1.output).toContain("breadth-first pass")
      expect(r1.output).toContain("adjacent producer, consumer, test, or configuration path")
      expect(r1.output).toContain("one different search, test, or focused check")
      expect(r1.output).toContain("If any branch yields a viable path, continue working")
      expect(r1.output).toContain("next eligible Goal turn")
      expect(r1.output).toContain("same trimmed reason")
      expect(r1.output).toContain("hard, uncertain, or incomplete")
      expect(r1.output.length).toBeLessThan(2000)
      // runtime result、wire description 和 continuation prompt 是三个独立 carrier，
      // 测试必须同时保护，避免模型在不同可见面收到互相矛盾的 blocked contract。
      // goal.txt 是模型调用工具前的另一可见面，不能与首次 Tool result 使用不同 contract。
      expect(def.description).toContain("two consecutive eligible Goal turns")
      expect(def.description).toContain("same trimmed reason")
      expect(def.description).toContain("keeps the Goal active")
      expect(def.description).toContain("viable path")
      expect(def.description).toContain("adjacent producers/consumers/tests/configuration")

      // 新 turn 必须重新 read；复用 t1 snapshot 会掩盖 read-per-turn gate 是否真实生效。
      const turn2: GoalTurnContext = { id: "t2", previousID: "t1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn2))
      const r2 = yield* def.execute(
        { operate: "blocked", reason: "stuck on X" },
        makeCtx(session.id, goalSvc, turn2),
      )
      expect(r2.output).toContain("blocked")
      expect(r2.output).toContain("stuck on X")

      // 验证持久化
      const goal = yield* goalSvc.get(session.id)
      if (Option.isSome(goal)) expect(goal.value.status).toBe("blocked")
    }),
  { git: true },
)

it.instance(
  "same-turn changed reason replaces the Tool blocked baseline",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test")

      const turn1: GoalTurnContext = { id: "t1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn1))
      yield* def.execute({ operate: "blocked", reason: "blocker A" }, makeCtx(session.id, goalSvc, turn1))
      const changed = yield* def.execute(
        { operate: "blocked", reason: "blocker B" },
        makeCtx(session.id, goalSvc, turn1),
      )
      expect(changed.output).toContain("attempt 1 of 2")

      // 新 baseline 是 B；下一 turn 再用已撤回的 A 只能重新开始，不能 terminal。
      const turn2: GoalTurnContext = { id: "t2", previousID: "t1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn2))
      const oldReason = yield* def.execute(
        { operate: "blocked", reason: "blocker A" },
        makeCtx(session.id, goalSvc, turn2),
      )
      expect(oldReason.output).toContain("attempt 1 of 2")
      const goal = yield* goalSvc.get(session.id)
      if (Option.isSome(goal)) expect(goal.value.status).toBe("active")
    }),
  { git: true },
)

it.instance(
  "active recovery through tool from model terminal",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test")

      // Turn 1: complete
      const turn1: GoalTurnContext = { id: "t1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn1))
      // active 不是可幂等“恢复”的成功分支；拒绝必须把模型导回当前 objective，
      // 否则模型只知道没有 terminal，却不知道合法动作是继续执行而非再次调用工具。
      const already = yield* def.execute({ operate: "active" }, makeCtx(session.id, goalSvc, turn1)).pipe(Effect.exit)
      expect(Exit.isFailure(already)).toBe(true)
      if (Exit.isFailure(already)) {
        const error = Cause.squash(already.cause) as Error
        expect(error.message).toContain("already active")
        expect(error.message).toContain("Continue working toward the current objective")
      }
      yield* def.execute(
        { operate: "complete", reason: "done" },
        makeCtx(session.id, goalSvc, turn1),
      )

      // Turn 2: read then active recovery
      const turn2: GoalTurnContext = { id: "t2", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn2))
      const result = yield* def.execute(
        { operate: "active" },
        makeCtx(session.id, goalSvc, turn2),
      )
      expect(result.output).toContain("resumed")
    }),
  { git: true },
)

it.instance(
  "active recovery same turn through tool is rejected",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test")

      // Same turn: complete then active → reject
      const turn1: GoalTurnContext = { id: "t1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn1))
      yield* def.execute(
        { operate: "complete", reason: "done" },
        makeCtx(session.id, goalSvc, turn1),
      )

      // terminal 写入后同一 turn 重新 read，确保本断言到达 recovery actor/turn guard，
      // 而不是被旧 active snapshot 的 status-CAS 提前拒绝。
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn1))
      const result = yield* def.execute(
        { operate: "active" },
        makeCtx(session.id, goalSvc, turn1),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const error = Cause.squash(result.cause) as Error
        expect(error.message).toContain("same turn")
        expect(error.message).toContain("Wait for a new user message")
      }
    }),
  { git: true },
)

it.instance(
  "user-produced terminal cannot be re-marked or recovered through the tool",
  () =>
    Effect.gen(function* () {
      yield* Effect.forEach(["complete", "blocked"] as const, (operation) =>
        Effect.gen(function* () {
          const { goalSvc, session, def } = yield* setupGoalTool("test")
          yield* goalSvc.set(session.id, { status: "complete", reason: "user done" })

          const turn1: GoalTurnContext = { id: `remark-${operation}`, userInitiated: true }
          yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn1))
          // terminal re-mark 必须在写 reason/audit/provenance 前失败，否则模型能洗白 user ownership。
          const remark = yield* def.execute(
            { operate: operation, reason: "model claim" },
            makeCtx(session.id, goalSvc, turn1),
          ).pipe(Effect.exit)
          expect(Exit.isFailure(remark)).toBe(true)
          if (Exit.isFailure(remark)) {
            const error = Cause.squash(remark.cause) as Error
            expect(error.message).toContain("only valid for an active goal")
            expect(error.message).toContain("wait for the user to resume")
          }

          const persisted = yield* goalSvc.get(session.id)
          expect(Option.getOrUndefined(persisted)?.reason).toBe("user done")
          // 新真实用户 turn 仍不能 active，证明 re-mark 没有写入 model terminal_turn_id。
          const turn2: GoalTurnContext = { id: `recover-${operation}`, userInitiated: true }
          yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn2))
          const recovery = yield* def.execute(
            { operate: "active" },
            makeCtx(session.id, goalSvc, turn2),
          ).pipe(Effect.exit)
          expect(Exit.isFailure(recovery)).toBe(true)
          if (Exit.isFailure(recovery)) {
            const error = Cause.squash(recovery.cause) as Error
            expect(error.message).toContain("marked as complete or blocked by the user")
            expect(error.message).toContain("user must resume")
          }
        }),
      )
    }),
  { git: true },
)
