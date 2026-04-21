import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, createSignal } from "solid-js"
import { createThrottledSignal } from "../../util/signal"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  type StateValue = { tokens: number; input: number; output: number; percent: number | null }

  const stateRaw = createMemo((): StateValue => {
    // 放宽 last 查找条件：不再要求 output > 0，流式输出中也需展示用量
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant")
    if (!last) {
      // 始终显示零值，sidebar 从 prompt 发送起即可见
      // sidebar 的面板始终存在，不沿用 footer 的 idle 隐藏分支。
      return { tokens: 0, input: 0, output: 0, percent: null }
    }

    // 分离输入/输出 token 统计，流式输出时用字符数估算输出 token
    const parts = props.api.state.part(last.id)
    const chars = parts.reduce((sum, part) => {
      if (part.type === "text" && !part.ignored) return sum + part.text.length
      if (part.type === "reasoning") return sum + part.text.length
      return sum
    }, 0)

    // sidebar 的 part 来源是插件 API；step-finish 分界只在同一条助手消息的 parts 中解释。
    // 分界之前的工具结果不再加估算，否则上下文百分比会把历史工具文本重复放大。
    const lastStepFinishIdx = parts.reduce((idx: number, part, i) => (part.type === "step-finish" ? i : idx), -1)
    // 完成消息不补工具字符，避免临时估算进入静态用量。
    const toolOutputChars = !last.time.completed
      ? parts.reduce((sum, part, i) => {
          if (i <= lastStepFinishIdx) return sum
          if (part.type === "tool" && part.state.status === "completed") return sum + part.state.output.length
          return sum
        }, 0)
      : 0

    // 累加所有 step-finish parts 的 token（last.tokens 仅含最后一步）
    const cumTokens = parts.reduce(
      (acc, part) => {
        if (part.type !== "step-finish") return acc
        return {
          input: acc.input + part.tokens.input + part.tokens.cache.read + part.tokens.cache.write,
          // 多步思考用量与正文分别计数，不因本步没有正文就丢掉 reasoning。
          output: acc.output + part.tokens.output + part.tokens.reasoning,
        }
      },
      { input: 0, output: 0 },
    )
    // 缓存命中仍占上下文输入，不能因为无需重复生成就从流量中扣除。
    const inputBase = cumTokens.input
    // percent 与 tokens 共用这一输入值，保持同一快照内口径一致。
    const input = inputBase + Math.round(toolOutputChars / 4)
    const outputActual = cumTokens.output
    const outputEstimated = Math.round(chars / 4)
    // 流式输出未完成时，取实际值与估算值的较大值，避免用量低估
    const output = last.time.completed ? outputActual : Math.max(outputActual, outputEstimated)
    const tokens = input + output
    // 缺少模型 context limit 时保留 token 实数，不能捏造百分比上限。
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      input,
      output,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  // 插件视图始终需要可读对象，用零值而非 undefined 支撑 state().tokens 等直接读取。
  // tokens、input、output、percent 整体发布，避免侧栏在同一帧显示不同版本的统计字段。
  const [state, setStateThrottled] = createThrottledSignal<StateValue>({ tokens: 0, input: 0, output: 0, percent: null }, 50)
  createEffect(() => setStateThrottled(stateRaw()))

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      {/* 添加输入/输出流量显示 */}
      <text fg={theme().textMuted}>↑ {state().input.toLocaleString()} · ↓ {state().output.toLocaleString()}</text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
