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
        "Get the current goal, or mark its status.",
        "",
        "Call with no arguments to get the current goal for this session, including status, objective, token and elapsed-time usage, remaining token budget, and objective generation. You MUST call get before marking any status — the tool will reject status changes without a prior get in the same goal turn.",
        "",
        "Call with `mark` and `reason` to mark the goal as achieved, blocked, or resumed:",
        "- Mark as `complete` with a `reason` only when the objective has actually been achieved and no required work remains.",
        "- Mark as `blocked` with a `reason` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change. The tool tracks consecutive attempts automatically — call blocked once per goal turn, and the status will only change to blocked on the third consecutive attempt with the same reason.",
        "- Mark as `active` (no reason needed) to resume a goal that you previously marked complete or blocked, but only in a later user-initiated turn. You cannot resume a goal that was paused or terminated by the user.",
        "- If the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, mark as `blocked` again.",
        "- Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; mark as `blocked`.",
        "- Do not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.",
        "- Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.",
        "- You cannot use this tool to pause, resume (from paused), or clear a goal; those status changes are controlled by the user.",
        "- When marking a budgeted goal achieved with `complete`, report the final token usage from the tool result to the user.",
      ].join("\n"),
      input: Schema.Struct({
        mark: Schema.Literals(["complete", "blocked", "active"]).pipe(Schema.optional).annotate({
          description: "Mark the goal as `complete` when the objective is achieved, or `blocked` when genuinely stuck after at least three consecutive failed attempts. Mark as `active` to resume a model-produced terminal goal in a later user turn. Omit to get the current goal status.",
        }),
        reason: Schema.String.pipe(Schema.optional).annotate({
          description: "Required when marking `complete` or `blocked`. A concise explanation of why the goal is being marked. Ignored for `active`.",
        }),
      }),
      // 继续直接返回完整Goal；仅pending附加进度，不能把active误报为已blocked。
      output: Schema.NullOr(Schema.Struct({
        ...SessionGoal.Goal.fields,
        blockedAttempt: Schema.optional(Schema.Struct({ attempt: Schema.Number, required: Schema.Number })),
      })),
      execute: (input, context) => Effect.gen(function* () {
        const turn = context.goalTurn
        if (input.mark === undefined) {
          const goal = Option.getOrNull(yield* goals.get(context.sessionID))
          if (goal && turn) turn.read = { goalID: goal.id, generation: goal.generation, status: goal.status }
          return goal
        }
        if (!turn?.read) return yield* Effect.fail(new ToolFailure({
          message: "goal tool: must call get (no arguments) before marking a status. Read the current goal first.",
        }))
        const result = yield* goals.modelTransition(context.sessionID, {
          snapshot: turn.read, turnID: turn.id, previousTurnID: turn.previousID,
          userInitiated: turn.userInitiated, status: input.mark, reason: input.reason,
        }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
        return result.type === "blocked-pending"
          ? { ...result.goal, blockedAttempt: { attempt: result.attempt, required: result.required } }
          : result.goal
      }),
      toModelOutput: ({ input, output }) => [{
        type: "text",
        text: !output
          ? "No goal is currently set for this session."
          : input.mark === undefined
            ? JSON.stringify({
                goal: { objective: output.objective, status: output.status, generation: output.generation, reason: output.reason },
                tokensUsed: output.tokensUsed,
                tokenBudget: output.tokenBudget ?? "unbounded",
                // 超预算只显示零余额，不改变Goal或把提示预算变成硬限额。
                remainingTokens: output.tokenBudget == null ? "unbounded" : Math.max(0, output.tokenBudget - output.tokensUsed),
                timeUsedSeconds: output.timeUsedSeconds,
              }, null, 2)
            : output.blockedAttempt
              ? `Blocked attempt ${output.blockedAttempt.attempt} of ${output.blockedAttempt.required}. The goal remains active. Continue working, or call blocked again in the next goal turn with the same reason if the blocker persists.`
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
