import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionPrompts } from "@opencode-ai/core/system-context/prompts"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  // #159：decide 优先于 plan 提醒——仅注入 DECIDE_PROMPT，不进入 plan/build 切换分支
  // 早返回：避免 experimentalPlanMode 分支误注入 plan 文件路径
  if (input.agent.name === "decide") {
    // 挂到最新 user message，与其它 mode 提醒一致
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      // 合成提醒：禁止工具/改文件，要求给出可执行决断
      // 英文正文：模型侧 system-reminder 约定语言
      text: `<system-reminder>
Decide mode is active. Do not execute, modify files, call tools, or ask for tool-based confirmation.
Use the available conversation context to produce a decisive recommendation or implementation plan.
Prefer a concrete decision over broad option lists. If critical information is missing, state the smallest set of blocking questions in plain text.
</system-reminder>`,
      // synthetic：不计入用户原话，TUI 可折叠
      synthetic: true,
    })
    // 立即返回：decide 不与 plan/build 切换提示叠加
    return input.messages
  }

  if (!flags.experimentalPlanMode) {
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    // 正文和普通模式的选择规则共用，实验计划文件分支仍沿用原来的持久化责任。
    for (const text of SessionPrompts.reminders(input.agent.name, wasPlan)) {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text,
        synthetic: true,
      })
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${SessionPrompts.buildSwitch}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : SessionPrompts.buildSwitch,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: SessionPrompts.planMode.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
