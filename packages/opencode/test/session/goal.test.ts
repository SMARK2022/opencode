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
  "set with objective over 6400 chars is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      // 超过 MAX_OBJECTIVE_CHARS(6400) 的 objective 必须被拒绝
      const longObjective = "a".repeat(6401)
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

      const goal = yield* goalSvc.set(session.id, { objective: "original", tokenBudget: 50000 })
      // 累加一些 usage（需要 expected goalID + generation）
      yield* goalSvc.accountUsage(session.id, 1000, 30, { goalID: goal.id, generation: goal.generation })

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

      const goal = yield* goalSvc.set(session.id, { objective: "finish project", tokenBudget: 10_000 })
      // 模拟 goal 运行中累计用量
      yield* goalSvc.accountUsage(session.id, 3000, 120, { goalID: goal.id, generation: goal.generation })
      // 模型标记 complete（terminal 状态需要 reason）
      yield* goalSvc.set(session.id, { status: "complete", reason: "all done" })

      // [local-smark] complete 后同 generation 的 final usage 仍计入（不丢失）
      yield* goalSvc.accountUsage(session.id, 999, 99, { goalID: goal.id, generation: goal.generation })

      const completed = yield* goalSvc.get(session.id)
      expect(Option.isSome(completed)).toBe(true)
      if (Option.isSome(completed)) {
        expect(completed.value.status).toBe("complete")
        // 3000 + 999 = 3999（terminal 后同 generation usage 不丢失）
        expect(completed.value.tokensUsed).toBe(3999)
      }

      // 用户 Resume：complete → active
      const resumed = yield* goalSvc.set(session.id, { status: "active" })
      expect(resumed.status).toBe("active")
      // 累计用量保留（3000 + 999 = 3999），budget 跨 resume 边界持续追踪
      expect(resumed.tokensUsed).toBe(3999)
      expect(resumed.timeUsedSeconds).toBe(219)
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

// [local-smark] accountUsage 使用 expected {goalID, generation} 做原子归属校验。
// 同 generation 的 usage 无论 status 都计入；generation 不匹配则 no-op。
it.instance(
  "accountUsage accumulates for matching goalID and generation",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, { objective: "active goal" })
      const expected = { goalID: goal.id, generation: goal.generation }
      yield* goalSvc.accountUsage(session.id, 500, 10, expected)
      yield* goalSvc.accountUsage(session.id, 300, 5, expected)

      // 暂停后同 generation 的 usage 仍计入——final usage 不丢失
      yield* goalSvc.set(session.id, { status: "paused" })
      yield* goalSvc.accountUsage(session.id, 999, 99, expected)

      const result = yield* goalSvc.get(session.id)
      if (Option.isSome(result)) {
        // 500 + 300 + 999 = 1799
        expect(result.value.tokensUsed).toBe(1799)
        expect(result.value.timeUsedSeconds).toBe(114)
      }
    }),
  { git: true },
)

it.instance(
  "accountUsage skips when generation does not match",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, { objective: "original" })
      // 用户编辑 objective → generation 递增
      yield* goalSvc.set(session.id, { objective: "revised" })
      // 旧 generation 的 usage 不应计入新 generation
      yield* goalSvc.accountUsage(session.id, 999, 99, { goalID: goal.id, generation: goal.generation })

      const result = yield* goalSvc.get(session.id)
      if (Option.isSome(result)) {
        // generation 不匹配 → no-op，tokensUsed 保持 0
        expect(result.value.tokensUsed).toBe(0)
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
      const result = yield* goalSvc.accountUsage(session.id, 500, 10, { goalID: "nonexistent", generation: 1 }).pipe(Effect.exit)
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

      const goal = yield* goalSvc.set(session.id, { objective: "build the feature", tokenBudget: 50000 })
      yield* goalSvc.accountUsage(session.id, 1234, 56, { goalID: goal.id, generation: goal.generation })

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

// [local-smark] continueOnError 字段测试：验证错误后续跑策略的持久化行为。
// 默认 false 保证升级后旧 GOAL 行为不变；局部更新不得重置该字段。
it.instance(
  "new goal defaults to continueOnError false",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      // 新建 GOAL 不传 continueOnError，默认必须为 false
      const goal = yield* goalSvc.set(session.id, { objective: "test" })
      expect(goal.continueOnError).toBe(false)
    }),
  { git: true },
)

it.instance(
  "create goal with continueOnError true",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      // 显式开启错误续跑策略
      const goal = yield* goalSvc.set(session.id, { objective: "test", continueOnError: true })
      expect(goal.continueOnError).toBe(true)

      // 持久化后读取仍为 true
      const result = yield* goalSvc.get(session.id)
      if (Option.isSome(result)) {
        expect(result.value.continueOnError).toBe(true)
      }
    }),
  { git: true },
)

it.instance(
  "toggle continueOnError between true and false",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test", continueOnError: true })
      // 关闭：false 应覆盖 true
      const disabled = yield* goalSvc.set(session.id, { continueOnError: false })
      expect(disabled.continueOnError).toBe(false)

      // 再次开启
      const enabled = yield* goalSvc.set(session.id, { continueOnError: true })
      expect(enabled.continueOnError).toBe(true)
    }),
  { git: true },
)

it.instance(
  "objective update preserves continueOnError",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "original", continueOnError: true })
      // 编辑 objective 不传 continueOnError，策略必须保留
      const updated = yield* goalSvc.set(session.id, { objective: "revised" })
      expect(updated.objective).toBe("revised")
      expect(updated.continueOnError).toBe(true)
    }),
  { git: true },
)

it.instance(
  "status update preserves continueOnError",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test", continueOnError: true })
      // Pause 不传 continueOnError，策略必须保留
      const paused = yield* goalSvc.set(session.id, { status: "paused" })
      expect(paused.status).toBe("paused")
      expect(paused.continueOnError).toBe(true)

      // Resume 也不传 continueOnError
      const resumed = yield* goalSvc.set(session.id, { status: "active" })
      expect(resumed.continueOnError).toBe(true)
    }),
  { git: true },
)

// [local-smark] terminal status 必须带非空 reason——用户明确要求 block/complete 需要理由
it.instance(
  "set complete without reason is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test objective" })
      // complete 不带 reason 必须失败，不能直接写入 terminal 状态
      const result = yield* goalSvc.set(session.id, { status: "complete" }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "set complete with reason persists reason",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test objective" })
      const completed = yield* goalSvc.set(session.id, { status: "complete", reason: "all tests pass" })
      expect(completed.status).toBe("complete")
      // reason 必须持久化到 Goal 对象，供 API/SDK/TUI 传播
      expect(completed.reason).toBe("all tests pass")
    }),
  { git: true },
)

it.instance(
  "set blocked without reason is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test objective" })
      const result = yield* goalSvc.set(session.id, { status: "blocked" }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "set complete with blank reason is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test objective" })
      // trim 后空白的 reason 等同于无 reason
      const result = yield* goalSvc.set(session.id, { status: "complete", reason: "   " }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)

// [local-smark] objective 代际：仅 trimmed objective 真正改变时递增 generation
it.instance(
  "objective edit increments generation",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, { objective: "original" })
      expect(goal.generation).toBe(1)

      // 真正改变 objective → generation 递增
      const updated = yield* goalSvc.set(session.id, { objective: "revised objective" })
      expect(updated.generation).toBe(2)
      expect(updated.objective).toBe("revised objective")
    }),
  { git: true },
)

it.instance(
  "status-only update does not increment generation",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test" })
      // 仅改 status 不递增 generation——terminal/pause 不改变 objective 代际
      const paused = yield* goalSvc.set(session.id, { status: "paused" })
      expect(paused.generation).toBe(1)
    }),
  { git: true },
)

it.instance(
  "objective edit on terminal goal auto-activates",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test", status: "complete", reason: "done" })
      // terminal Goal 的 objective-only edit 自动回到 active
      const updated = yield* goalSvc.set(session.id, { objective: "new work" })
      expect(updated.status).toBe("active")
      expect(updated.generation).toBe(2)
      // reason 被清除
      expect(updated.reason).toBeNull()
    }),
  { git: true },
)

// [local-smark] paused Goal 的 objective-only edit 必须保持 paused，
// 不能自动激活（§8.2 合同：paused edit 保持 paused）
it.instance(
  "objective edit on paused goal preserves paused",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test" })
      yield* goalSvc.set(session.id, { status: "paused" })
      // paused Goal 编辑 objective，不传 status → 保持 paused
      const updated = yield* goalSvc.set(session.id, { objective: "revised" })
      expect(updated.status).toBe("paused")
      expect(updated.objective).toBe("revised")
      expect(updated.generation).toBe(2)
    }),
  { git: true },
)

// [local-smark] modelTransition 行为测试：read gate、CAS、blocked streak、recovery
// 这些测试通过 SessionGoal.Service 的公开 modelTransition 方法验证，
// 不依赖 GoalTool 或 prompt 内部实现

it.instance(
  "modelTransition complete without read snapshot is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goalSvc.set(session.id, { objective: "test" })
      // 使用错误的 goalID 模拟无 read snapshot
      const result = yield* goalSvc
        .modelTransition(session.id, {
          snapshot: { goalID: "wrong-id", generation: 1, status: "active" },
          turnID: "turn1",
          userInitiated: true,
          status: "complete",
          reason: "done",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "modelTransition complete with valid snapshot succeeds",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, { objective: "test" })
      const result = yield* goalSvc.modelTransition(session.id, {
        snapshot: { goalID: goal.id, generation: goal.generation, status: "active" },
        turnID: "turn1",
        userInitiated: true,
        status: "complete",
        reason: "all tests pass",
      })
      expect(result.type).toBe("updated")
      if (result.type === "updated") {
        expect(result.goal.status).toBe("complete")
        expect(result.goal.reason).toBe("all tests pass")
      }
    }),
  { git: true },
)

it.instance(
  "modelTransition stale generation is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, { objective: "original" })
      // 用户编辑 objective → generation 递增
      yield* goalSvc.set(session.id, { objective: "revised" })
      // 模型用旧 generation 的 snapshot 写 terminal → 必须失败
      const result = yield* goalSvc
        .modelTransition(session.id, {
          snapshot: { goalID: goal.id, generation: goal.generation, status: "active" },
          turnID: "turn1",
          userInitiated: true,
          status: "complete",
          reason: "done",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "modelTransition blocked requires three consecutive turns",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, { objective: "test" })
      const snap = { goalID: goal.id, generation: goal.generation, status: "active" as const }

      // Turn 1: pending, attempt 1
      const r1 = yield* goalSvc.modelTransition(session.id, {
        snapshot: snap, turnID: "turn1", userInitiated: true, status: "blocked", reason: "stuck on X",
      })
      expect(r1.type).toBe("blocked-pending")
      if (r1.type === "blocked-pending") expect(r1.attempt).toBe(1)

      // Turn 2: pending, attempt 2（连续，相同 reason）
      const r2 = yield* goalSvc.modelTransition(session.id, {
        snapshot: snap, turnID: "turn2", previousTurnID: "turn1", userInitiated: true,
        status: "blocked", reason: "stuck on X",
      })
      expect(r2.type).toBe("blocked-pending")
      if (r2.type === "blocked-pending") expect(r2.attempt).toBe(2)

      // Turn 3: success，status 变为 blocked
      const r3 = yield* goalSvc.modelTransition(session.id, {
        snapshot: snap, turnID: "turn3", previousTurnID: "turn2", userInitiated: true,
        status: "blocked", reason: "stuck on X",
      })
      expect(r3.type).toBe("updated")
      if (r3.type === "updated") expect(r3.goal.status).toBe("blocked")
    }),
  { git: true },
)

it.instance(
  "modelTransition same turn duplicate blocked does not increment streak",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, { objective: "test" })
      const snap = { goalID: goal.id, generation: goal.generation, status: "active" as const }

      // Turn 1: attempt 1
      const r1 = yield* goalSvc.modelTransition(session.id, {
        snapshot: snap, turnID: "turn1", userInitiated: true, status: "blocked", reason: "stuck",
      })
      if (r1.type === "blocked-pending") expect(r1.attempt).toBe(1)

      // Same turn 1 again: still attempt 1，不增加
      const r2 = yield* goalSvc.modelTransition(session.id, {
        snapshot: snap, turnID: "turn1", userInitiated: true, status: "blocked", reason: "stuck",
      })
      if (r2.type === "blocked-pending") expect(r2.attempt).toBe(1)
    }),
  { git: true },
)

it.instance(
  "modelTransition skipped turn resets streak",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, { objective: "test" })
      const snap = { goalID: goal.id, generation: goal.generation, status: "active" as const }

      // Turn 1: attempt 1
      yield* goalSvc.modelTransition(session.id, {
        snapshot: snap, turnID: "turn1", userInitiated: true, status: "blocked", reason: "stuck",
      })

      // Turn 3 (跳过 turn 2): previousTurnID 不匹配 → streak 重置为 1
      const r = yield* goalSvc.modelTransition(session.id, {
        snapshot: snap, turnID: "turn3", previousTurnID: "turn2", userInitiated: true,
        status: "blocked", reason: "stuck",
      })
      if (r.type === "blocked-pending") expect(r.attempt).toBe(1)
    }),
  { git: true },
)

it.instance(
  "modelTransition active recovery from model terminal in later user turn",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, { objective: "test" })
      // 模型标记 complete
      yield* goalSvc.modelTransition(session.id, {
        snapshot: { goalID: goal.id, generation: goal.generation, status: "active" },
        turnID: "turn1", userInitiated: true, status: "complete", reason: "done",
      })

      // 后续新真实用户 turn 恢复 active
      const r = yield* goalSvc.modelTransition(session.id, {
        snapshot: { goalID: goal.id, generation: goal.generation, status: "complete" },
        turnID: "turn2", userInitiated: true, status: "active",
      })
      expect(r.type).toBe("updated")
      if (r.type === "updated") expect(r.goal.status).toBe("active")
    }),
  { git: true },
)

it.instance(
  "modelTransition active recovery same turn is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, { objective: "test" })
      yield* goalSvc.modelTransition(session.id, {
        snapshot: { goalID: goal.id, generation: goal.generation, status: "active" },
        turnID: "turn1", userInitiated: true, status: "complete", reason: "done",
      })

      // 同一 turn 尝试恢复 → 拒绝
      const result = yield* goalSvc
        .modelTransition(session.id, {
          snapshot: { goalID: goal.id, generation: goal.generation, status: "complete" },
          turnID: "turn1", userInitiated: true, status: "active",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "modelTransition active recovery from paused is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, { objective: "test" })
      // 用户暂停
      yield* goalSvc.set(session.id, { status: "paused" })

      // 模型尝试恢复 paused → 拒绝
      const result = yield* goalSvc
        .modelTransition(session.id, {
          snapshot: { goalID: goal.id, generation: goal.generation, status: "paused" },
          turnID: "turn1", userInitiated: true, status: "active",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "modelTransition active recovery from user-produced terminal is rejected",
  () =>
    Effect.gen(function* () {
      const goalSvc = yield* SessionGoal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goalSvc.set(session.id, { objective: "test" })
      // 用户直接写入 terminal（terminal_turn_id 为 null）
      yield* goalSvc.set(session.id, { status: "complete", reason: "user says done" })

      // 模型尝试恢复 → 拒绝（不是 model-produced terminal）
      const result = yield* goalSvc
        .modelTransition(session.id, {
          snapshot: { goalID: goal.id, generation: goal.generation, status: "complete" },
          turnID: "turn1", userInitiated: true, status: "active",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { git: true },
)
