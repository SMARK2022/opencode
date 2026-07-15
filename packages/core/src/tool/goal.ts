export * as GoalTool from "./goal"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionGoal } from "../session/goal"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const layer = Layer.effectDiscard(Effect.gen(function* () {
  const tools = yield* Tools.Service
  const goals = yield* SessionGoal.Service
  yield* tools.register({
    goal: Tool.make({
      description: [
        "Read the current goal, or change its status.",
        "",
        "Call with `operate: \"read\"` to get the current goal for this session, including status, objective, token and elapsed-time usage, remaining token budget, and objective generation. You MUST read before changing any status — the tool rejects transitions without a prior read in the same Goal turn.",
        "",
        "Call with `operate` and, when required, `reason` to change the goal:",
        "- Use `operate: \"complete\"` with a `reason` only when the objective has actually been achieved and no required work remains.",
        "- Use `operate: \"blocked\"` with a `reason` only when the same blocking condition remains across two consecutive eligible Goal turns using the same trimmed reason, counting the original/user-triggered turn and any automatic Goal continuation. The first call keeps the Goal active: re-read relevant files, search with different patterns, split the problem into smaller verifiable steps, and check for overlooked dependencies or constraints. If you still cannot proceed with the available information, call `operate: \"blocked\"` again in the next eligible Goal turn with the same trimmed reason. The second consecutive call marks the Goal as blocked.",
        "- Use `operate: \"active\"` (no reason needed) to resume a goal that you previously marked complete or blocked, but only in a later user-initiated turn. You cannot resume a goal that was paused or terminated by the user.",
        "- If the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least two consecutive resumed goal turns, mark as `blocked` again.",
        "- Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; use `operate: \"blocked\"`.",
        "- Do not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.",
        "- Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.",
        "- You cannot use this tool to pause, resume (from paused), or clear a goal; those status changes are controlled by the user.",
        "- When marking a budgeted goal achieved with `complete`, report the final token usage from the tool result to the user.",
      ].join("\n"),
      input: Schema.Struct({
        // 显式 read 消除空调用歧义；可信快照仍保存在 runner 提供的同一 turn 上。
        operate: Schema.Literals(["read", "complete", "blocked", "active"]).annotate({
          description: "Use `read` to get the current goal before any transition. Use `complete` when the objective is achieved. Use `blocked` only when the same blocker remains after two consecutive eligible Goal turns using the same trimmed reason. Use `active` to resume a model-produced terminal goal in a later user turn.",
        }),
        reason: Schema.String.pipe(Schema.optional).annotate({
          description: "Required when operate is `complete` or `blocked`. A concise explanation of why the goal is being marked. Ignored for `read` and `active`.",
        }),
      }),
      // 继续直接返回完整Goal；仅pending附加进度，不能把active误报为已blocked。
      output: Schema.NullOr(Schema.Struct({
        ...SessionGoal.Goal.fields,
        blockedAttempt: Schema.optional(Schema.Struct({ attempt: Schema.Number, required: Schema.Number })),
      })),
      execute: (input, context) => Effect.gen(function* () {
        const turn = context.goalTurn
        if (input.operate === "read") {
          const goal = Option.getOrNull(yield* goals.get(context.sessionID))
          if (goal && turn) turn.read = { goalID: goal.id, generation: goal.generation, status: goal.status }
          return goal
        }
        if (!turn?.read) return yield* Effect.fail(new ToolFailure({
          message: "You must call the goal tool with operate `read` before changing the goal. Read the current goal, then retry with operate and reason.",
        }))
        const result = yield* goals.modelTransition(context.sessionID, {
          snapshot: turn.read, turnID: turn.id, previousTurnID: turn.previousID,
          userInitiated: turn.userInitiated, status: input.operate, reason: input.reason,
        }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
        return result.type === "blocked-pending"
          ? { ...result.goal, blockedAttempt: { attempt: result.attempt, required: result.required } }
          : result.goal
      }),
      toModelOutput: ({ input, output }) => [{
        type: "text",
        text: !output
          ? "No goal is currently set for this session."
          : input.operate === "read"
            ? JSON.stringify({
                goal: { objective: output.objective, status: output.status, generation: output.generation, reason: output.reason },
                tokensUsed: output.tokensUsed,
                tokenBudget: output.tokenBudget ?? "unbounded",
                // 超预算只显示零余额，不改变Goal或把提示预算变成硬限额。
                remainingTokens: output.tokenBudget == null ? "unbounded" : Math.max(0, output.tokenBudget - output.tokensUsed),
                timeUsedSeconds: output.timeUsedSeconds,
              }, null, 2)
            : output.blockedAttempt
              ? `Blocked attempt ${output.blockedAttempt.attempt} of ${output.blockedAttempt.required}. Before marking as blocked, re-read relevant files, search with different patterns, split the problem into smaller verifiable steps, and check for overlooked dependencies or constraints. If you still cannot proceed with the available information, call operate blocked again in the next eligible Goal turn with the same trimmed reason to confirm the blocker is persistent.`
              : output.status === "active"
                ? "Goal resumed to active. Continue working toward the objective."
                : output.status === "blocked"
                  ? `Goal marked as blocked: ${output.reason}. The session loop will end after this turn. The user can resume the goal later.`
                  : `Goal marked as complete: ${output.reason}. The session loop will end after this turn.`,
      }],
    }),
  }).pipe(Effect.orDie)
}))

// 注册归 Location，持久 Goal 仍归全局 Session-ID 存储服务。
export const node = makeLocationNode({
  name: "tool/goal",
  layer,
  deps: [ToolRegistry.node, SessionGoal.node],
})
