import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Session as SessionNs } from "@/session/session"
import { SessionGoal } from "@/session/goal"
import { MessageID, SessionID } from "@/session/schema"
import { GoalTool, type GoalTurnContext } from "@/tool/goal"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

// 测试 layer 组装：目标架构使用 LayerNode.group + AppNodeBuilder。
// SessionGoal 依赖 EventV2Bridge + Database；GoalTool 依赖 Agent + Truncate
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionGoal.node,
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Config.node,
      Truncate.node,
      Agent.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
      [Config.node, TestConfig.layer()],
    ],
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

// setupGoalTool：一次组装 svc/session/def，消除各用例的重复 bootstrap 样板
const setupGoalTool = Effect.fn("test.setupGoalTool")(function* (objective?: string) {
  const goalSvc = yield* SessionGoal.Service
  const session = yield* (yield* SessionNs.Service).create({})
  const def = yield* (yield* GoalTool).init()
  if (objective) yield* goalSvc.set(session.id, { objective })
  return { goalSvc, session, def }
})

// 无 goal 时 get 返回明确的 no-goal 消息而非报错——首次读取是正常流程
it.instance(
  "get returns no goal message when no goal exists",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool()
      const result = yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc))
      expect(result.output).toContain("No goal")
    }),
  { git: true },
)

// get 的核心副作用：把权威 {goalID, generation, status} 写入 goalTurn.read，
// 模型不能通过参数伪造这些值；后续 transition 的合法性完全依赖这三个权威值
it.instance(
  "get returns goal info and writes read snapshot to goalTurn",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test objective")
      const goalTurn: GoalTurnContext = { id: "turn1", userInitiated: true }
      const result = yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, goalTurn))

      expect(result.output).toContain("test objective")
      expect(result.output).toContain("active")
      // trusted snapshot 被写入 goalTurn，供后续 transition 校验
      expect(goalTurn.read).toBeDefined()
      expect(goalTurn.read!.status).toBe("active")
    }),
  { git: true },
)

// read gate：transition 必须先 get 建立快照，防止模型不看 GOAL 直接终态化
it.instance(
  "transition without prior read explains how to establish the read gate",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test")
      const goalTurn: GoalTurnContext = { id: "turn1", userInitiated: true }
      const result = yield* def
        .execute({ operate: "complete", reason: "done" }, makeCtx(session.id, goalSvc, goalTurn))
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        // Tool wrapper 把执行失败转为 defect；模型最终看到的正是 squash 后的消息。
        const error = Cause.squash(result.cause) as Error
        expect(error.message).toContain("with operate \`read\` before changing the goal")
        expect(error.message).toContain("retry with operate and reason")
      }
    }),
  { git: true },
)

// 模型需要同时知道拒绝原因和下一次合法调用，不接受只有名词短语的错误。
it.instance(
  "missing terminal reason explains how to retry the mark",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test")
      const turn: GoalTurnContext = { id: "turn1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn))
      const result = yield* def.execute({ operate: "complete" }, makeCtx(session.id, goalSvc, turn)).pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const error = Cause.squash(result.cause) as Error
        expect(error.message).toContain("non-empty reason")
        expect(error.message).toContain("retry with operate complete")
      }
    }),
  { git: true },
)

// stale rejection 不能只说 mismatch；模型必须知道重新读取 revised Goal 后再决策。
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
        const error = Cause.squash(result.cause) as Error
        expect(error.message).toContain("objective has been edited")
        expect(error.message).toContain("Call operate read again")
      }
    }),
  { git: true },
)

// 两轮阈值：首轮 pending 输出必须包含四类探索动作并固定下一 turn 的 exact reason；
// goal.txt 是模型调用前的另一可见面，不能与首次 Tool result 使用不同 contract。
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
      // 首轮不能只是计数；四项动作分别保护证据遗漏、搜索盲区、问题粒度和依赖约束。
      expect(r1.output).toContain("re-read relevant files")
      expect(r1.output).toContain("search with different patterns")
      expect(r1.output).toContain("smaller verifiable steps")
      expect(r1.output).toContain("overlooked dependencies or constraints")
      expect(r1.output).toContain("next eligible Goal turn")
      expect(r1.output).toContain("same trimmed reason")
      expect(def.description).toContain("two consecutive eligible Goal turns")
      expect(def.description).toContain("same trimmed reason")
      expect(def.description).toContain("re-read relevant files")
      expect(def.description).toContain("overlooked dependencies or constraints")

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

// 同一 Goal turn 改 reason 表示模型修正了 blocker 判断；新 baseline 替换旧理由，
// 下一 turn 再用已撤回的 A 只能重新开始，不能 terminal。
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

// active 不是可幂等“恢复”的成功分支；拒绝必须把模型导回当前 objective。
it.instance(
  "active recovery through tool from model terminal",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test")
      // Turn 1: complete
      const turn1: GoalTurnContext = { id: "t1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn1))
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
      // Turn 2: active recovery
      const turn2: GoalTurnContext = { id: "t2", previousID: "t1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn2))
      const result = yield* def.execute({ operate: "active" }, makeCtx(session.id, goalSvc, turn2))
      expect(result.output).toContain("resumed")
      const goal = yield* goalSvc.get(session.id)
      if (Option.isSome(goal)) expect(goal.value.status).toBe("active")
    }),
  { git: true },
)

// terminal 写入后同一 turn 重新 get，确保断言到达 recovery actor/turn guard，
// 而不是被旧 active snapshot 的 status-CAS 提前拒绝。
it.instance(
  "active recovery same turn through tool is rejected",
  () =>
    Effect.gen(function* () {
      const { goalSvc, session, def } = yield* setupGoalTool("test")
      const turn1: GoalTurnContext = { id: "t1", userInitiated: true }
      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn1))
      yield* def.execute({ operate: "complete", reason: "done" }, makeCtx(session.id, goalSvc, turn1))

      yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn1))
      const result = yield* def
        .execute({ operate: "active" }, makeCtx(session.id, goalSvc, turn1))
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const error = Cause.squash(result.cause) as Error
        expect(error.message).toContain("same turn")
        expect(error.message).toContain("Wait for a new user message")
      }
    }),
  { git: true },
)

// terminal re-mark 必须在写 provenance 前失败，否则模型能洗白 user ownership；
// 新真实用户 turn 仍不能 active，证明 re-mark 没有写入 model terminal_turn_id。
it.instance(
  "user-produced terminal cannot be re-marked or recovered through the tool",
  () =>
    Effect.gen(function* () {
      yield* Effect.forEach(["complete", "blocked"] as const, (mark) =>
        Effect.gen(function* () {
          const { goalSvc, session, def } = yield* setupGoalTool("test")
          yield* goalSvc.set(session.id, { status: "complete", reason: "user done" })

          const turn1: GoalTurnContext = { id: `remark-${mark}`, userInitiated: true }
          yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn1))
          const remark = yield* def
            .execute({ operate: mark, reason: "model claim" }, makeCtx(session.id, goalSvc, turn1))
            .pipe(Effect.exit)
          expect(Exit.isFailure(remark)).toBe(true)
          if (Exit.isFailure(remark)) {
            const error = Cause.squash(remark.cause) as Error
            expect(error.message).toContain("only valid for an active goal")
            expect(error.message).toContain("wait for the user to resume")
          }

          const persisted = yield* goalSvc.get(session.id)
          expect(Option.getOrUndefined(persisted)?.reason).toBe("user done")
          const turn2: GoalTurnContext = { id: `recover-${mark}`, userInitiated: true }
          yield* def.execute({ operate: "read" }, makeCtx(session.id, goalSvc, turn2))
          const recovery = yield* def
            .execute({ operate: "active" }, makeCtx(session.id, goalSvc, turn2))
            .pipe(Effect.exit)
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
