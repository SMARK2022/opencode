import * as Tool from "./tool"
import DESCRIPTION from "./goal.txt"
import type { SessionGoal } from "@/session/goal"
import { Effect, Schema } from "effect"

// goal 工具参数：status 只接受 complete 或 blocked
const Parameters = Schema.Struct({
  status: Schema.Literals(["complete", "blocked"] as const),
})

// goal 工具的执行上下文需要 SessionGoal.Service，
// 通过 ctx.extra 传入（与 TaskTool 的 promptOps 模式一致）
export interface GoalToolExtra {
  goalSvc: SessionGoal.Interface
}

// goal 工具：仅允许模型标记 complete 或 blocked。
// 不允许模型 pause/resume/clear/改预算——这些由用户或系统控制。
// 防止模型通过滥用状态来逃避任务
export const GoalTool = Tool.define(
  "goal",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    // Effect.orDie 将 GoalError 转为 defect，使 error 类型为 never，
    // 与 Def.execute 的签名 Effect.Effect<ExecuteResult<M>> 对齐
    execute: (params: { status: "complete" | "blocked" }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const extra = ctx.extra as GoalToolExtra | undefined
        if (!extra?.goalSvc) {
          return yield* Effect.fail(new Error("goal tool requires goalSvc in ctx.extra"))
        }
        // 更新 goal 状态；如果 session 没有 goal 则报错
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
