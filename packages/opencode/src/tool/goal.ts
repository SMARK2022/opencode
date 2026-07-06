import * as Tool from "./tool"
import DESCRIPTION from "./goal.txt"
import type { SessionGoal } from "@/session/goal"
import { Effect, Option, Schema } from "effect"

// goal 工具参数：status 可选。
// 无 status → get 模式：返回当前 goal 的状态、objective、用量和预算
// 有 status → update 模式：标记 goal complete 或 blocked
// 镜像 Codex 的 get_goal + update_goal 合并为单工具设计
const Parameters = Schema.Struct({
  // 与其他工具一致：每个字段都带 .annotate({ description }) 供 JSON Schema 生成
  status: Schema.optional(Schema.Literals(["complete", "blocked"] as const)).annotate({
    description:
      "Set to `complete` when the objective is achieved, or `blocked` when genuinely stuck after at least three consecutive failed attempts. Omit to get the current goal status.",
  }),
})

// goal 工具的执行上下文需要 SessionGoal.Service，
// 通过 ctx.extra 传入（与 TaskTool 的 promptOps 模式一致）
export interface GoalToolExtra {
  goalSvc: SessionGoal.Interface
}

// goal 工具：支持 get（无参数）和 update（status 参数）两种模式。
// 不允许模型 pause/resume/clear/改预算——这些由用户或系统控制。
// 防止模型通过滥用状态来逃避任务
export const GoalTool = Tool.define(
  "goal",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    // Effect.orDie 将 GoalError 转为 defect，使 error 类型为 never，
    // 与 Def.execute 的签名 Effect.Effect<ExecuteResult<M>> 对齐
    execute: (params: { status?: "complete" | "blocked" }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const extra = ctx.extra as GoalToolExtra | undefined
        if (!extra?.goalSvc) {
          return yield* Effect.fail(new Error("goal tool requires goalSvc in ctx.extra"))
        }

        // 无 status 参数 → get 模式：返回当前 goal 的完整信息
        if (params.status === undefined) {
          const goalOpt = yield* extra.goalSvc.get(ctx.sessionID)
          if (Option.isNone(goalOpt)) {
            return {
              title: "Goal",
              metadata: {},
              output: "No goal is currently set for this session.",
            }
          }
          const goal = goalOpt.value
          // 镜像 Codex get_goal 的响应结构：goal + remaining_tokens
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
              },
              tokensUsed: goal.tokensUsed,
              tokenBudget: goal.tokenBudget ?? "unbounded",
              remainingTokens: remaining ?? "unbounded",
              timeUsedSeconds: goal.timeUsedSeconds,
            }, null, 2),
          }
        }

        // 有 status 参数 → update 模式：标记 goal complete 或 blocked
        yield* extra.goalSvc.set(ctx.sessionID, { status: params.status })
        // 返回明确消息让模型知道 loop 即将结束
        return {
          title: `Goal ${params.status}`,
          metadata: {},
            output:
              params.status === "complete"
                ? `Goal marked as complete. The session loop will end after this turn.`
                : `Goal marked as blocked. The session loop will end after this turn. The user can resume the goal later.`,
        }
      }).pipe(Effect.orDie),
  }),
)
