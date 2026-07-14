import { expect } from "bun:test"
import { Effect, Exit, Layer, Option } from "effect"
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

// [local-smark] GoalTool read gate 行为测试：
// 验证模型必须先 get 才能写 terminal status，
// 验证 reason 和 blocked streak 通过 Tool 正确传播，
// 验证 active recovery 通过 Tool 正确拒绝或成功

// 无 goal 时 get 返回明确的 no-goal 消息而非报错——首次读取是正常流程
it.instance(
  "get returns no goal message when no goal exists",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})
      const tool = yield* GoalTool
      const def = yield* tool.init()

      const result = yield* def.execute({}, makeCtx(session.id, goalSvc))
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
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const tool = yield* GoalTool
      const def = yield* tool.init()

      const session = yield* sessions.create({})
      yield* goalSvc.set(session.id, { objective: "test objective" })

      // goalTurn 初始无 read snapshot
      const goalTurn: GoalTurnContext = {
        id: "turn1",
        userInitiated: true,
      }
      const result = yield* def.execute({}, makeCtx(session.id, goalSvc, goalTurn))

      // get 返回 goal 信息
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
  "status without prior get is rejected — read gate",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const tool = yield* GoalTool
      const def = yield* tool.init()

      const session = yield* sessions.create({})
      yield* goalSvc.set(session.id, { objective: "test" })

      // goalTurn 无 read snapshot → transition 必须失败
      const goalTurn: GoalTurnContext = { id: "turn1", userInitiated: true }
      const result = yield* def.execute(
        { mark: "complete", reason: "done" },
        makeCtx(session.id, goalSvc, goalTurn),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)

// 合法路径：get 后 complete 持久化 reason，返回的 output 必须含终态语义
it.instance(
  "complete after get succeeds and persists reason",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const tool = yield* GoalTool
      const def = yield* tool.init()

      const session = yield* sessions.create({})
      yield* goalSvc.set(session.id, { objective: "test" })

      // 先 get 建立 read snapshot
      const goalTurn: GoalTurnContext = { id: "turn1", userInitiated: true }
      yield* def.execute({}, makeCtx(session.id, goalSvc, goalTurn))

      // 再 complete
      const result = yield* def.execute(
        { mark: "complete", reason: "all done" },
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

// 工具路径的 streak 语义与 service 一致：三轮同因才 blocked
it.instance(
  "blocked streak through tool: three consecutive turns",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const tool = yield* GoalTool
      const def = yield* tool.init()

      const session = yield* sessions.create({})
      yield* goalSvc.set(session.id, { objective: "test" })

      // Turn 1: get then blocked → pending
      const turn1: GoalTurnContext = { id: "t1", userInitiated: true }
      yield* def.execute({}, makeCtx(session.id, goalSvc, turn1))
      const r1 = yield* def.execute(
        { mark: "blocked", reason: "stuck on X" },
        makeCtx(session.id, goalSvc, turn1),
      )
      expect(r1.output).toContain("attempt 1")

      // Turn 2: get then blocked → pending
      const turn2: GoalTurnContext = { id: "t2", previousID: "t1", userInitiated: true }
      yield* def.execute({}, makeCtx(session.id, goalSvc, turn2))
      const r2 = yield* def.execute(
        { mark: "blocked", reason: "stuck on X" },
        makeCtx(session.id, goalSvc, turn2),
      )
      expect(r2.output).toContain("attempt 2")

      // Turn 3: get then blocked → success
      const turn3: GoalTurnContext = { id: "t3", previousID: "t2", userInitiated: true }
      yield* def.execute({}, makeCtx(session.id, goalSvc, turn3))
      const r3 = yield* def.execute(
        { mark: "blocked", reason: "stuck on X" },
        makeCtx(session.id, goalSvc, turn3),
      )
      expect(r3.output).toContain("blocked")
      expect(r3.output).toContain("stuck on X")

      // 验证持久化
      const goal = yield* goalSvc.get(session.id)
      if (Option.isSome(goal)) expect(goal.value.status).toBe("blocked")
    }),
  { git: true },
)

// 模型 terminal 后在后续真实用户 turn 可恢复：terminal_turn_id 溯源生效
it.instance(
  "active recovery through tool from model terminal",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const tool = yield* GoalTool
      const def = yield* tool.init()

      const session = yield* sessions.create({})
      yield* goalSvc.set(session.id, { objective: "test" })

      // Turn 1: complete
      const turn1: GoalTurnContext = { id: "t1", userInitiated: true }
      yield* def.execute({}, makeCtx(session.id, goalSvc, turn1))
      yield* def.execute(
        { mark: "complete", reason: "done" },
        makeCtx(session.id, goalSvc, turn1),
      )

      // Turn 2: get then active recovery
      const turn2: GoalTurnContext = { id: "t2", userInitiated: true }
      yield* def.execute({}, makeCtx(session.id, goalSvc, turn2))
      const result = yield* def.execute(
        { mark: "active" },
        makeCtx(session.id, goalSvc, turn2),
      )
      expect(result.output).toContain("resumed")
    }),
  { git: true },
)

// 同 turn 恢复等价于模型撤销自己的终态，必须拒绝
it.instance(
  "active recovery same turn through tool is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const tool = yield* GoalTool
      const def = yield* tool.init()

      const session = yield* sessions.create({})
      yield* goalSvc.set(session.id, { objective: "test" })

      // Same turn: complete then active → reject
      const turn1: GoalTurnContext = { id: "t1", userInitiated: true }
      yield* def.execute({}, makeCtx(session.id, goalSvc, turn1))
      yield* def.execute(
        { mark: "complete", reason: "done" },
        makeCtx(session.id, goalSvc, turn1),
      )

      // 同一 turn 尝试恢复 → 失败
      const result = yield* def.execute(
        { mark: "active" },
        makeCtx(session.id, goalSvc, turn1),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)

// 用户终态不可被模型恢复：保留用户对任务命运的最终决定权
it.instance(
  "active recovery from user-produced terminal through tool is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const tool = yield* GoalTool
      const def = yield* tool.init()

      const session = yield* sessions.create({})
      yield* goalSvc.set(session.id, { objective: "test" })
      // 用户直接写入 terminal
      yield* goalSvc.set(session.id, { status: "complete", reason: "user done" })

      // 模型尝试恢复 → 失败
      const turn1: GoalTurnContext = { id: "t1", userInitiated: true }
      yield* def.execute({}, makeCtx(session.id, goalSvc, turn1))
      const result = yield* def.execute(
        { mark: "active" },
        makeCtx(session.id, goalSvc, turn1),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)
