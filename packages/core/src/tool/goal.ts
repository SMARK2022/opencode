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
        "Get the current goal, or update its status.",
        "",
        "Call with no arguments to get the current goal for this session, including status, objective, token and elapsed-time usage, and remaining token budget.",
        "",
        "Call with `status` to mark the goal achieved or genuinely blocked:",
        "- Set status to `complete` only when the objective has actually been achieved and no required work remains.",
        "- Set status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.",
        "- If the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again.",
        "- Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`.",
        "- Do not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.",
        "- Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.",
        "- You cannot use this tool to pause, resume, or clear a goal; those status changes are controlled by the user.",
        "- When marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.",
      ].join("\n"),
      input: Schema.Struct({
        status: Schema.Literals(["complete", "blocked"]).pipe(Schema.optional).annotate({
          description: "Set to `complete` when the objective is achieved, or `blocked` when genuinely stuck after at least three consecutive failed attempts. Omit to get the current goal status.",
        }),
      }),
      // 无目标用null表示，仍由现有工具输出编码器验证完整Goal快照。
      output: Schema.NullOr(SessionGoal.Goal),
      // 原生工具直接调用共享目标服务，不通过 V1 ctx.extra 或旧执行循环。
      execute: (input, context) => input.status === undefined
        ? goals.get(context.sessionID).pipe(Effect.map(Option.getOrNull))
        : goals.set(context.sessionID, { status: input.status }).pipe(
            Effect.mapError((error) => new ToolFailure({ message: error.message })),
          ),
      toModelOutput: ({ input, output }) => [{
        type: "text",
        text: !output
          ? "No goal is currently set for this session."
          : input.status === undefined
            ? JSON.stringify({
                goal: { objective: output.objective, status: output.status },
                tokensUsed: output.tokensUsed,
                tokenBudget: output.tokenBudget ?? "unbounded",
                // 超预算只显示零余额，不改变Goal或把提示预算变成硬限额。
                remainingTokens: output.tokenBudget == null ? "unbounded" : Math.max(0, output.tokenBudget - output.tokensUsed),
                timeUsedSeconds: output.timeUsedSeconds,
              }, null, 2)
            : output.status === "complete"
              ? "Goal marked as complete. The session loop will end after this turn."
              : "Goal marked as blocked. The session loop will end after this turn. The user can resume the goal later.",
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
