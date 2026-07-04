import { expect } from "bun:test"
import { Effect, Exit, Layer, Option } from "effect"
import { Session as SessionNs } from "@/session/session"
import { SessionGoal } from "@/session/goal"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Config } from "@/config/config"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

// #364：测试 layer 组装：SessionGoal 依赖 EventV2Bridge + Database，
// Session 依赖 InstanceStore 等，使用与 session.test.ts 相同的模式。
// [local-smark] Config 层供 goal_max_turns 顶层读取测试；TestConfig 提供
// 空配置桩（get 返回 {}），goal_max_turns 缺省回退到 10 的断言因此成立。
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

// #364：新建 goal 默认 active，usage 归零，id 非空
it.instance(
  "set goal creates active goal with objective",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, {
        objective: "write a complete test suite",
      })

      // 新建 goal 默认为 active，usage 归零
      expect(goal.status).toBe("active")
      expect(goal.objective).toBe("write a complete test suite")
      expect(goal.tokensUsed).toBe(0)
      expect(goal.timeUsedSeconds).toBe(0)
      expect(goal.id).toBeTruthy()
    }),
  { git: true },
)

// #364：无 goal 时 get 返回 None 而非报错
it.instance(
  "get returns None when no goal exists",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const result = yield* goalSvc.get(session.id)
      expect(Option.isNone(result)).toBe(true)
    }),
  { git: true },
)

// #364：有 goal 时 get 返回 Some 且 objective 一致
it.instance(
  "get returns Some when goal exists",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "fix the bug" })
      const result = yield* goalSvc.get(session.id)
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.objective).toBe("fix the bug")
      }
    }),
  { git: true },
)

// #364：空白 objective 必须被拒绝
it.instance(
  "set with empty objective is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const result = yield* goalSvc.set(session.id, { objective: "   " }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)

// #364：超过 4000 字符的 objective 必须被拒绝
it.instance(
  "set with objective over 4000 chars is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      // 超过 MAX_OBJECTIVE_CHARS(4000) 的 objective 必须被拒绝
      const longObjective = "a".repeat(4001)
      const result = yield* goalSvc.set(session.id, { objective: longObjective }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)

// #364：0 和负数 budget 均非法，仅正数或 null 合法
it.instance(
  "set with non-positive tokenBudget is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      // 0 和负数 budget 均非法；只有正数或 null（清除）合法
      const result = yield* goalSvc
        .set(session.id, { objective: "test", tokenBudget: 0 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)

      const result2 = yield* goalSvc
        .set(session.id, { objective: "test", tokenBudget: -100 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result2)).toBe(true)
    }),
  { git: true },
)

// #364：无 goal 时仅传 status 不能创建，必须报错
it.instance(
  "update status without existing goal fails",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      // 没有 goal 时仅传 status 不能创建，必须报错
      const result = yield* goalSvc.set(session.id, { status: "paused" }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)

// #364：编辑 objective 不重置 usage/budget/goal_id
it.instance(
  "set objective on existing goal preserves usage",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "original", tokenBudget: 50000 })
      // 累加一些 usage
      yield* goalSvc.accountUsage(session.id, 1000, 30)

      // 编辑 objective 不应重置 usage / budget / goal_id
      const updated = yield* goalSvc.set(session.id, { objective: "revised objective" })
      expect(updated.objective).toBe("revised objective")
      expect(updated.tokensUsed).toBe(1000)
      expect(updated.timeUsedSeconds).toBe(30)
      expect(updated.tokenBudget).toBe(50000)
    }),
  { git: true },
)

// #364：仅更新 status 时 objective 保持不变
it.instance(
  "set status on existing goal updates only status",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test objective" })
      const updated = yield* goalSvc.set(session.id, { status: "paused" })
      expect(updated.status).toBe("paused")
      expect(updated.objective).toBe("test objective")
    }),
  { git: true },
)

// #364：clear 删除 goal，再次 clear 返回 false
it.instance(
  "clear removes the goal",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "temp goal" })

      const cleared = yield* goalSvc.clear(session.id)
      expect(cleared).toBe(true)

      // 再次 clear 返回 false（无行可删）
      const clearedAgain = yield* goalSvc.clear(session.id)
      expect(clearedAgain).toBe(false)

      const result = yield* goalSvc.get(session.id)
      expect(Option.isNone(result)).toBe(true)
    }),
  { git: true },
)

// #364：paused goal 不累积 usage，防止后台静默增长
it.instance(
  "accountUsage only accumulates for active goals",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "active goal" })
      yield* goalSvc.accountUsage(session.id, 500, 10)
      yield* goalSvc.accountUsage(session.id, 300, 5)

      // 暂停后计费不应累积——防止 paused goal 在后台静默增长 usage
      yield* goalSvc.set(session.id, { status: "paused" })
      yield* goalSvc.accountUsage(session.id, 999, 99)

      const result = yield* goalSvc.get(session.id)
      if (Option.isSome(result)) {
        expect(result.value.tokensUsed).toBe(800)
        expect(result.value.timeUsedSeconds).toBe(15)
      }
    }),
  { git: true },
)

// #364：无 goal 时计费静默跳过，不报错
it.instance(
  "accountUsage on non-existent goal is a no-op",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      // 不存在 goal 时计费不应报错，静默跳过
      const result = yield* goalSvc.accountUsage(session.id, 500, 10).pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(true)
    }),
  { git: true },
)

// #364：null 语义为清除预算，变为 unbounded
it.instance(
  "set with tokenBudget null clears budget",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test", tokenBudget: 50000 })
      // null 语义：清除预算限制，变为 unbounded
      const updated = yield* goalSvc.set(session.id, { tokenBudget: null })
      expect(updated.tokenBudget).toBeNull()
    }),
  { git: true },
)

// #364：正数 budget 更新生效
it.instance(
  "set with tokenBudget as number updates budget",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test" })
      const updated = yield* goalSvc.set(session.id, { tokenBudget: 100000 })
      expect(updated.tokenBudget).toBe(100000)
    }),
  { git: true },
)

// #364：再次 set objective 更新现有 goal 而非新建第二条
it.instance(
  "one session has at most one goal",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal1 = yield* goalSvc.set(session.id, { objective: "first goal" })
      // 再次 set objective 会更新现有 goal，而不是创建第二条
      const goal2 = yield* goalSvc.set(session.id, { objective: "second goal" })
      expect(goal2.objective).toBe("second goal")
      // goal_id 不变（是更新而非新建）
      expect(goal2.id).toBe(goal1.id)

      // DB 中只有一条记录
      const result = yield* goalSvc.get(session.id)
      expect(Option.isSome(result)).toBe(true)
    }),
  { git: true },
)

// #364：续跑 prompt 包含目标、用量、预算与剩余额度
it.instance(
  "continuationPrompt contains objective and usage",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "build the feature", tokenBudget: 50000 })
      yield* goalSvc.accountUsage(session.id, 1234, 56)

      const result = yield* goalSvc.get(session.id)
      if (Option.isSome(result)) {
        const prompt = SessionGoal.continuationPrompt(result.value)
        // 验证续跑 prompt 包含目标、用量、预算等关键信息
        // Codex 对齐：无 Time elapsed，有 Tokens remaining
        expect(prompt).toContain("<session-goal-continuation>")
        expect(prompt).toContain("build the feature")
        expect(prompt).toContain("Tokens used: 1234")
        expect(prompt).toContain("Token budget: 50000")
        expect(prompt).toContain("Tokens remaining: 48766")
        expect(prompt).toContain("call the goal tool with status")
      }
    }),
  { git: true },
)

// #364：XML 特殊字符必须转义，防止 prompt injection
it.instance(
  "continuationPrompt escapes XML special characters in objective",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      // 包含 XML 特殊字符的 objective，验证转义
      // 防止 prompt injection：用户输入的 <>& 必须被转义
      yield* goalSvc.set(session.id, { objective: "fix <script> & <style> tags" })
      const result = yield* goalSvc.get(session.id)
      if (Option.isSome(result)) {
        const prompt = SessionGoal.continuationPrompt(result.value)
        // 原始 < > & 必须被转义，防止注入
        expect(prompt).toContain("&lt;script&gt;")
        expect(prompt).toContain("&amp;")
        // 不应出现未转义的标签
        expect(prompt).not.toContain("<script>")
        expect(prompt).not.toContain("<style>")
      }
    }),
  { git: true },
)

// #364：删除 session 后 goal 经 FK cascade 自动删除
it.instance(
  "clearing session cascades to goal",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "will be deleted" })

      // 删除 session 后 goal 应通过 FK cascade 自动删除
      yield* sessions.remove(session.id)
      const result = yield* goalSvc.get(session.id)
      expect(Option.isNone(result)).toBe(true)
    }),
  { git: true },
)

// [local-smark] 验证 goal_max_turns 从顶层 config 读取，不在 experimental 下
// goal 功能不再需要 experimental.goals 开关，始终可用
it.instance(
  "goal_max_turns is readable from top-level config without experimental gate",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const cfg = yield* config.get()
      // goal_max_turns 在顶层可读，默认 10（TestConfig 空桩下回退到默认值）
      const maxTurns = (cfg as any).goal_max_turns ?? 10
      expect(maxTurns).toBe(10)
      // experimental.goals 不再存在，goal 功能始终可用
      expect((cfg as any).experimental?.goals).toBeUndefined()
    }),
  { git: true },
)

// [local-smark] 验证 goal HTTP API 端到端行为
// SDK 未重新生成 goalSet/goalClear 方法，这些方法在运行时为 undefined
// 确认 SDK Session2 类上不存在 goalSet/goalClear/goal 方法
it.live(
  "SDK Session2 class does not have goal methods (regression guard)",
  () =>
    Effect.gen(function* () {
      const { createOpencodeClient } = yield* Effect.promise(() => import("@opencode-ai/sdk/v2"))
      const client = createOpencodeClient({ baseUrl: "http://localhost:0" })
      // SDK 未重新生成，goalSet/goalClear/goal 应为 undefined
      // 如果 SDK 重新生成后这些方法存在，测试会失败，提醒移除 fetch 直接调用
      expect((client.session as any).goalSet).toBeUndefined()
      expect((client.session as any).goalClear).toBeUndefined()
      expect((client.session as any).goal).toBeUndefined()
    }),
)

// [local-smark] 验证 dialog-goal.tsx 不依赖 SDK 方法
// dialog-goal.tsx 应使用 fetch 直接调用 HTTP 端点，而非 sdk.client.session.goalSet
it.live(
  "dialog-goal.tsx uses fetch not SDK method for goal API calls",
  () =>
    Effect.gen(function* () {
      const fs = yield* Effect.promise(() => import("fs/promises"))
      const path = yield* Effect.promise(() => import("path"))
      // 目标仓库中 dialog-goal 位于 packages/tui，相对 packages/opencode 的
      // 测试 cwd 需要向上两级再进入 tui 包（source 路径已迁移）
      const content = yield* Effect.promise(() =>
        fs.readFile(
          path.join(process.cwd(), "../tui/src/component/dialog-goal.tsx"),
          "utf-8",
        ),
      )
      // 不应包含 as any 调用 SDK goal 方法的模式
      expect(content).not.toContain("(sdk.client.session as any).goalSet")
      expect(content).not.toContain("(sdk.client.session as any).goalClear")
      // 应包含 fetch 直接调用
      expect(content).toContain("sdk.fetch")
    }),
)
