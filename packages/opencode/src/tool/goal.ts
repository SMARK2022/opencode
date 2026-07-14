import * as Tool from "./tool"
import DESCRIPTION from "./goal.txt"
import type { SessionGoal } from "@/session/goal"
import { Effect, Option, Schema } from "effect"

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
// 无 mark → get 模式：返回当前 goal 的状态、objective、用量、预算和代际
// 有 mark → transition 模式：需要先 get 建立 read snapshot
// complete/blocked 需要 reason；active 用于从 model-produced terminal 恢复
export const Parameters = Schema.Struct({
  mark: Schema.optional(Schema.Literals(["complete", "blocked", "active"] as const)).annotate({
    description:
      "Mark the goal as `complete` when the objective is achieved. Mark it as `blocked` only when the same blocker remains after two consecutive eligible Goal turns using the same trimmed reason. Mark as `active` to resume a model-produced terminal goal in a later user turn. Omit to get the current goal status.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description:
      "Required when marking `complete` or `blocked`. A concise explanation of why the goal is being marked. Ignored for `active`.",
  }),
})

// goal 工具的执行上下文需要 SessionGoal.Service 和当前 Goal turn context，
// 通过 ctx.extra 传入（与 TaskTool 的 promptOps 模式一致）
export interface GoalToolExtra {
  goalSvc: SessionGoal.Interface
  // SessionPrompt 在每次 eligible Goal turn 创建并注入的受信上下文
  goalTurn?: GoalTurnContext
}

// 省略 mark 被刻意保留为读取动作；若拆成第二个工具，trusted snapshot 无法留在同一 Tool context。
// transition 必须先 get 建立 read snapshot——防止模型不看 GOAL 就直接终态化。
// 不允许模型 pause/resume/clear/改预算——这些由用户或系统控制。
export const GoalTool = Tool.define(
  "goal",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: { mark?: "complete" | "blocked" | "active"; reason?: string }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const extra = ctx.extra as GoalToolExtra | undefined
        if (!extra?.goalSvc) {
          return yield* Effect.fail(new Error("goal tool requires goalSvc in ctx.extra"))
        }

        // 无 mark 参数 → get 模式：返回当前 goal 的完整信息
        if (params.mark === undefined) {
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

        // 有 mark 参数 → transition 模式
        // read gate：必须先 get 建立 trusted snapshot，防止模型不看 GOAL 就终态化
        if (!extra.goalTurn?.read) {
          return yield* Effect.fail(
            new Error(
              "You must call the goal tool with no arguments to read the current goal before marking it. Read the current goal, then retry the transition with mark and reason.",
            ),
          )
        }

        const result = yield* extra.goalSvc.modelTransition(ctx.sessionID, {
          snapshot: extra.goalTurn.read,
          turnID: extra.goalTurn.id,
          previousTurnID: extra.goalTurn.previousID,
          userInitiated: extra.goalTurn.userInitiated,
          status: params.mark,
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

        // blocked-pending：第一次 blocked 必须给出四类具体探索动作，并固定下一 turn 的 exact reason。
        return {
          title: "Goal blocked (pending)",
          metadata: {},
          output: `Blocked attempt ${result.attempt} of ${result.required}. Before marking as blocked, re-read relevant files, search with different patterns, split the problem into smaller verifiable steps, and check for overlooked dependencies or constraints. If you still cannot proceed with the available information, call mark blocked again in the next eligible Goal turn with the same trimmed reason to confirm the blocker is persistent.`,
        }
      }).pipe(Effect.orDie),
  }),
)
