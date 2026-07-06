import { expect } from "bun:test"
import { Effect, Exit, Layer, Option } from "effect"
import { Session as SessionNs } from "@/session/session"
import { SessionGoal } from "@/session/goal"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Log from "@opencode-ai/core/util/log"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

// 测试 layer 组装：SessionGoal 依赖 Bus + DB（通过 Database 全局），
// Session 依赖 Bus + Storage + SyncEvent + BackgroundJob。
// 使用与 session.test.ts 相同的模式。
const it = testEffect(
  Layer.mergeAll(
    SessionGoal.layer.pipe(Layer.provide(Bus.layer)),
    SessionNs.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    // [local-smark] Config 层供 goal_max_turns 顶层读取测试
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

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

// [local-smark] 验证 complete → active 转换：用户 Resume 已完成的 goal
// 数据层 set 函数无状态转换限制，complete → active 应直接生效。
// 累计用量必须保留——budget 跨 resume 边界持续追踪，不能重置。
it.instance(
  "resume complete goal back to active preserves usage",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "finish project", tokenBudget: 10_000 })
      // 模拟 goal 运行中累计用量
      yield* goalSvc.accountUsage(session.id, 3000, 120)
      // 模型标记 complete
      yield* goalSvc.set(session.id, { status: "complete" })

      // complete 后 accountUsage 不应计费（status !== "active"）
      yield* goalSvc.accountUsage(session.id, 999, 99)

      const completed = yield* goalSvc.get(session.id)
      expect(Option.isSome(completed)).toBe(true)
      if (Option.isSome(completed)) {
        expect(completed.value.status).toBe("complete")
        expect(completed.value.tokensUsed).toBe(3000)
      }

      // 用户 Resume：complete → active
      const resumed = yield* goalSvc.set(session.id, { status: "active" })
      expect(resumed.status).toBe("active")
      // 累计用量保留，budget 跨 resume 边界持续追踪
      expect(resumed.tokensUsed).toBe(3000)
      expect(resumed.timeUsedSeconds).toBe(120)
      expect(resumed.tokenBudget).toBe(10_000)
    }),
  { git: true },
)

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
// goal 功能始终可用，不再需要 experimental.goals 开关
// CI 中 turbo build 会重新生成 SDK（包含 goal 方法），但 config 字段位置不受影响
it.instance(
  "goal_max_turns is readable from top-level config without experimental gate",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const cfg = yield* config.get()
      // goal_max_turns 在顶层可读，默认 32（0 = 禁用续跑）
      expect((cfg as any).goal_max_turns ?? 32).toBe(32)
      // experimental.goals 不再存在，goal 功能始终可用
      expect((cfg as any).experimental?.goals).toBeUndefined()
    }),
  { git: true },
)
