import * as Tool from "./tool"
import DESCRIPTION from "./goal.txt"
import type { SessionGoal } from "@/session/goal"
import { Effect, Option, Schema } from "effect"

// 该值是 SessionPrompt 消费的结构化 transition 信号，避免把 TUI/模型可见文案
// 当成跨 assistant step 的控制协议。
export const GOAL_BLOCKED_PENDING_TRANSITION = "blocked-pending" as const
// metadata 保持可选，使 read、complete 和真正 blocked 等既有结果不获得展示副作用。
type GoalToolMetadata = { goal_transition?: typeof GOAL_BLOCKED_PENDING_TRANSITION }

// Goal turn 受信上下文：由 SessionPrompt 创建并在同一 eligible turn 的
// provider steps 间复用。GoalTool get 写入 read snapshot，write 读取校验。
// 模型不能通过工具参数伪造 snapshot 值。
export interface GoalTurnContext {
  // 当前 eligible Goal turn 的 user MessageID
  id: string
  // 前一个 eligible Goal turn 的 user MessageID
  previousID?: string
  // 当前 turn 是否由真实用户发起（Goal continuation 为 false）
  userInitiated: boolean
  // get 写入受信 read snapshot；write 必须发现此字段才允许 transition
  read?: { goalID: string; generation: number; status: SessionGoal.Status }
}

// goal 工具参数：
// operate=read → 返回当前 goal 的状态、objective、用量、预算和代际
// 其他 operate → transition 模式：需要先 read 建立 snapshot
// complete/blocked 需要 reason；active 用于从 model-produced terminal 恢复
export const Parameters = Schema.Struct({
  operate: Schema.Literals(["read", "complete", "blocked", "active"] as const).annotate({
    description:
      "Use `read` to get the current goal before any transition. Use `complete` when the objective is achieved. Use `blocked` only when the same blocker remains after two consecutive eligible Goal turns using the same trimmed reason. The first blocked call keeps the Goal active: re-check relevant evidence breadth-first, continue if any branch yields a viable path, and only confirm the same blocker in the next eligible turn. Do not block merely because work is hard, uncertain, or incomplete. Use `active` to resume a model-produced terminal goal in a later user turn.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description:
      "Required when operate is `complete` or `blocked`. A concise explanation of why the goal is being marked. Ignored for `read` and `active`.",
  }),
})

// goal 工具的执行上下文需要 SessionGoal.Service 和当前 Goal turn context，
// 通过 ctx.extra 传入（与 TaskTool 的 promptOps 模式一致）
export interface GoalToolExtra {
  goalSvc: SessionGoal.Interface
  // SessionPrompt 在每次 eligible Goal turn 创建并注入的受信上下文
  goalTurn?: GoalTurnContext
}

// 显式 read 避免 provider 把可选字段错误展示成必填后，模型无法表达读取动作。
// transition 必须先 operate=read 建立 snapshot——防止模型不看 GOAL 就直接终态化。
// 不允许模型 pause/resume/clear/改预算——这些由用户或系统控制。
export const GoalTool = Tool.define<typeof Parameters, GoalToolMetadata, never, "goal">(
  "goal",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: { operate: "read" | "complete" | "blocked" | "active"; reason?: string }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const extra = ctx.extra as GoalToolExtra | undefined
        if (!extra?.goalSvc) {
          return yield* Effect.fail(new Error("goal tool requires goalSvc in ctx.extra"))
        }

        // read 是唯一读取动作，不再依赖 provider 对空对象/可选字段的展示语义。
        if (params.operate === "read") {
          const goalOpt = yield* extra.goalSvc.get(ctx.sessionID)
          if (Option.isNone(goalOpt)) {
            return {
              title: "Goal",
              metadata: {},
              output: "No goal is currently set for this session.",
            }
          }
          const goal = goalOpt.value
          // 将 trusted snapshot 写入 goalTurn context，供后续 transition 校验。
          // 模型不能通过参数伪造这些值——它们来自 service 的权威读取。
          if (extra.goalTurn) {
            extra.goalTurn.read = {
              goalID: goal.id,
              generation: goal.generation,
              status: goal.status,
            }
          }
          const remaining = goal.tokenBudget != null
            ? Math.max(0, goal.tokenBudget - goal.tokensUsed)
            : null
          return {
            title: "Goal",
            metadata: {},
            output: JSON.stringify({
              goal: {
                objective: goal.objective,
                status: goal.status,
                generation: goal.generation,
                reason: goal.reason ?? null,
              },
              tokensUsed: goal.tokensUsed,
              tokenBudget: goal.tokenBudget ?? "unbounded",
              remainingTokens: remaining ?? "unbounded",
              timeUsedSeconds: goal.timeUsedSeconds,
            }, null, 2),
          }
        }

        // 其他 operate → transition 模式
        // read gate：必须先 operate=read 建立 trusted snapshot，防止模型不看 GOAL 就终态化
        if (!extra.goalTurn?.read) {
          return yield* Effect.fail(
            new Error(
              "You must call the goal tool with operate `read` before changing the goal. Read the current goal, then retry with operate and reason.",
            ),
          )
        }

        const result = yield* extra.goalSvc.modelTransition(ctx.sessionID, {
          snapshot: extra.goalTurn.read,
          turnID: extra.goalTurn.id,
          previousTurnID: extra.goalTurn.previousID,
          userInitiated: extra.goalTurn.userInitiated,
          status: params.operate,
          reason: params.reason,
        })

        // 根据 transition 结果返回明确的模型可读输出
        if (result.type === "updated") {
          const goal = result.goal
          if (goal.status === "complete") {
            return {
              title: "Goal complete",
              metadata: {},
              output: `Goal marked as complete: ${goal.reason}. The session loop will end after this turn.`,
            }
          }
          if (goal.status === "blocked") {
            return {
              title: "Goal blocked",
              metadata: {},
              output: `Goal marked as blocked: ${goal.reason}. The session loop will end after this turn. The user can resume the goal later.`,
            }
          }
          // active recovery 成功
          return {
            title: "Goal resumed",
            metadata: {},
            output: `Goal resumed to active. Continue working toward the objective.`,
          }
        }

        // blocked-pending：第一次调用只启动 audit，必须明确保持 active、继续探索和 exact reason 边界。
        // 文案只指导模型下一步，不改变 modelTransition 的持久化 ownership 或 two-turn threshold。
        return {
          title: "Goal blocked (pending)",
          // 只有第一轮 pending 需要下一条 continuation 复查，terminal blocked 不会进入此分支。
          metadata: { goal_transition: GOAL_BLOCKED_PENDING_TRANSITION },
          output: [
            `Blocked attempt ${result.attempt} of ${result.required}. The Goal stays active; do not confirm it as blocked yet. Re-check the blocker with a breadth-first pass:`,
            "1. Restate the exact blocker and the Goal requirement it prevents.",
            "2. Re-read the most relevant files and inspect one adjacent producer, consumer, test, or configuration path that could change the conclusion.",
            "3. Run one different search, test, or focused check, and split the blocker into a smaller verifiable question.",
            "4. If any branch yields a viable path, continue working and do not call blocked again.",
            'If the same blocker still prevents meaningful progress after this exploration, call operate "blocked" in the next eligible Goal turn with the same trimmed reason. Do not mark the Goal blocked merely because the work is hard, uncertain, or incomplete.',
          ].join("\n"),
        }
      }).pipe(Effect.orDie),
  }),
)
