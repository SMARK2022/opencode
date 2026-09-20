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
        "Call with `operate: \"read\"` to get the current goal for this session, including status, objective, token and elapsed-time usage, remaining token budget, and objective generation. You MUST read before changing any status — the tool rejects transitions without a prior read of the current goal state.",
        "",
        "Call with `operate` and, when required, `reason` to change the goal:",
        "- Use `operate: \"complete\"` with a `reason` only when the objective has actually been achieved and no required work remains.",
        "- Use `operate: \"blocked\"` to start a blocker audit; a second consecutive call with the same trimmed reason marks the goal blocked. The first call keeps the Goal active: re-check the blocker breadth-first, inspect adjacent producers/consumers/tests/configuration, run a different focused check, and continue immediately if any branch yields a viable path. If the same blocker still prevents meaningful progress after that verification, optionally delegate an independent audit to a subagent with the task tool, then call `operate: \"blocked\"` again with the same trimmed reason after the next goal-continuation message arrives; a repeated call while answering the same message does not count. Do not block merely because the work is hard, uncertain, or incomplete.",
        "- Use `operate: \"active\"` (no reason needed) to resume a goal that you previously marked complete or blocked, but only after the user has sent a new message. You cannot resume a goal that was paused or terminated by the user.",
        "- If the user resumes a goal that was previously marked `blocked`, treat the resumed work as a fresh blocked audit: the same blocking condition must be verified again before marking `blocked`.",
        "- Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; use `operate: \"blocked\"`.",
        "- Do not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.",
        "- Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.",
        "- You cannot use this tool to pause, resume (from paused), or clear a goal; those status changes are controlled by the user.",
        "- When marking a budgeted goal achieved with `complete`, report the final token usage from the tool result to the user.",
      ].join("\n"),
      input: Schema.Struct({
        // 显式 read 消除空调用歧义；可信快照仍保存在 runner 提供的同一 turn 上。
        operate: Schema.Literals(["read", "complete", "blocked", "active"]).annotate({
          description: "Use `read` to get the current goal before any transition. Use `complete` when the objective is achieved. Use `blocked` to start a blocker audit; a second consecutive call with the same trimmed reason marks the goal blocked. The first blocked call keeps the Goal active: re-check relevant evidence breadth-first, continue if any branch yields a viable path, and only confirm the same blocker after the next goal-continuation message arrives. Do not block merely because work is hard, uncertain, or incomplete. Use `active` to resume a model-produced terminal goal after the user sends a new message.",
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
        // 真正使用Goal时才加载有界lineage，现有直接调用仍可提供同一可信对象。
        const turn = context.loadGoalTurn ? yield* context.loadGoalTurn() : context.goalTurn
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
              ? [
                  `Blocked attempt ${output.blockedAttempt.attempt} of ${output.blockedAttempt.required}. The Goal stays active; do not confirm it as blocked yet. Re-check the blocker with a breadth-first pass:`,
                  "1. Restate the exact blocker and the Goal requirement it prevents.",
                  "2. Re-read the most relevant files and inspect one adjacent producer, consumer, test, or configuration path that could change the conclusion.",
                  "3. Run one different search, test, or focused check, and split the blocker into a smaller verifiable question.",
                  // 审查建议不新增持久状态或准入条件；计数仍归modelTransition。
                  "4. Delegate an independent audit to a subagent with the task tool: fresh context should judge whether the blocker is real, whether the current route is wrong, and which requirements remain unfinished.",
                  "5. If any branch yields a viable path, continue working and do not call blocked again.",
                  'If no branch is viable, call operate "blocked" again with the same trimmed reason after the next goal-continuation message arrives; a repeated call while answering the same message does not count. Do not mark the Goal blocked merely because the work is hard, uncertain, or incomplete.',
                ].join("\n")
              : output.status === "active"
                ? "Goal resumed to active. Continue working toward the objective."
                : output.status === "blocked"
                  ? `Goal marked as blocked: ${output.reason}. The user can resume the goal later.`
                  : `Goal marked as complete: ${output.reason}.`,
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
