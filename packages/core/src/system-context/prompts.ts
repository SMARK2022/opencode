export * as SessionPrompts from "./prompts"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_ASTRA from "./prompt/gpt-astra.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"
import PROMPT_META from "./prompt/meta.txt"
import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import PROMPT_MINIMAX from "./prompt/minimax.txt"
import PROMPT_DEEPSEEK from "./prompt/deepseek.txt"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

// 文本只归Core所有；V1与V2共享正文，避免新增族时某条执行链仍收到旧摘要。
export function provider(id: string, providerID: string) {
  if (id.includes("muse")) {
    const name = id.includes("muse-glimmer") ? "Muse Glimmer" : "Muse Spark"
    return PROMPT_META.replaceAll("{{MODEL_NAME}}", name)
  }
  // 保留上游选择优先级，不能先匹配宽泛GPT分支改变已有模型的模板。
  if (id.includes("gpt-4") || id.includes("o1") || id.includes("o3")) return PROMPT_BEAST
  if (id.includes("gpt")) {
    if (id.includes("gpt-6")) return PROMPT_ASTRA
    if (id.includes("codex")) return PROMPT_CODEX
    return PROMPT_GPT
  }
  if (id.includes("gemini-")) return PROMPT_GEMINI
  if (id.includes("claude")) return PROMPT_ANTHROPIC
  if (id.toLowerCase().includes("trinity")) return PROMPT_TRINITY
  // 新族沿source优先于Kimi provider别名，完整正文同时覆盖两代请求。
  if (id.toLowerCase().includes("minimax") || id.toLowerCase().includes("mini-max")) return PROMPT_MINIMAX
  if (id.toLowerCase().includes("deepseek")) return PROMPT_DEEPSEEK
  // 部分兼容端点使用别名，Kimi沿原provider身份规则选模板。
  if (id.toLowerCase().includes("kimi") || ["kimi-for-coding", "moonshotai", "moonshotai-cn"].includes(providerID))
    return PROMPT_KIMI
  return PROMPT_DEFAULT
}

export const plan = PROMPT_PLAN
export const buildSwitch = BUILD_SWITCH
export const planMode = PLAN_MODE

export function reminders(agent: string, wasPlan: boolean) {
  // 只根据已提升输入对应的本轮agent提醒；排队但尚未提升的切换不能放开写权限。
  if (agent === "plan") return [plan]
  // 与V1普通模式一致：有plan历史的build请求重新明确当前可执行状态。
  if (agent === "build" && wasPlan) return [buildSwitch]
  return []
}
