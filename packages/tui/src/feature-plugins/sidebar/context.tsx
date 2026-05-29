import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useLocal } from "../../context/local"
import { useSDK } from "../../context/sdk"
import { createThrottledSignal, createTokenFlowPulse } from "../../util/signal"
import { getContextLimit } from "../../util/token-estimate"
import { tokenAccounting } from "../../util/token-accounting"
// #122：侧栏 context 与 prompt 共用 accounting

const id = "internal:sidebar-context"
// 探测完成后再计下一秒，慢连接不会叠加并发请求。
const PING_INTERVAL = 1_000

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const sdk = useSDK()
  const local = useLocal()
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))

  // retry 也属于等待；首次引导不能在重试间隙闪回空闲零值。
  const isRunning = createMemo(() => (props.api.state.session.status(props.session_id)?.type ?? "idle") !== "idle")
  // sidebar 保持直接可读对象，新增括号累计也随同一节流快照发布。
  // 主值属于请求，total 字段属于全局，不能复用一个变量伪装两种范围。
  // 费用随 token 同一快照发布，不能继续读取独立的会话 cost memo。
  // 零值状态也必须含 cost，避免新请求等待时保留上一请求费用。
  type StateValue = { tokens: number; totalTokens: number; input: number; output: number; totalInput: number; totalOutput: number; percent: number | null; cost: number }

  const stateRaw = createMemo((): StateValue => {
    const messages = msg()
    const assistants = messages.filter((item): item is AssistantMessage => item.role === "assistant")
    // plugin 的 session.get 直通 sync，复用同一服务端投影，不另建 sidebar 私有累计。
    const confirmed = session()?.tokens
    if (!confirmed) {
      return { tokens: 0, totalTokens: 0, input: 0, output: 0, totalInput: 0, totalOutput: 0, percent: null, cost: 0 }
    }

    // plugin 的 session.get 已直通同步 Session，不能另建 sidebar 私有请求账本。
    const request = session()?.request
    // 三个视图共享服务端 provisional input；侧栏不维护第二个估算/累计 owner。
    // 空闲无回复保持全字段零值，避免新 Session 留下上一请求的费用或百分比。
    if (!request || (!request.assistantID && !isRunning())) {
      return { tokens: 0, totalTokens: 0, input: 0, output: 0, totalInput: 0, totalOutput: 0, percent: null, cost: 0 }
    }
    const requestAssistants = assistants.filter((item) => item.id === request?.assistantID)
    const last = requestAssistants.at(-1)
    // 当前 step 确认值由完整请求投影提供，窗口只保留流式字符近似的职责。

    // 参数只含当前助手尾部，不能把其他请求的缓存 parts 传给共享计算。
    const lastParts = last ? props.api.state.part(last.id) : []
    // 确认值低于估算时仍取真实 step，百分比和其他视图保持同一口径。
    // 插件读取同一冻结密度，不能另扫 sidebar 的消息窗口建立第二份历史估算。
    // 侧栏使用同一会话投影，保留未到首个助手及窗口外累计的显示。
    const { input, output, totalInput, totalOutput } = tokenAccounting(messages, (id) => props.api.state.part(id), undefined, { session: session(), last, parts: lastParts }).request
    const tokens = input + output
    const totalTokens = totalInput + totalOutput
    // 未确认请求可用其用户模型；已确认 native 请求不依赖用户仍在显示窗口。
    const modelRef = request.model ?? messages.find((item): item is UserMessage => item.role === "user" && item.id === request.messageID)?.model
    const contextLimit = getContextLimit(props.api.state.provider, modelRef?.providerID, modelRef?.modelID, request.model?.contextLimit)
    return {
      tokens,
      totalTokens,
      input,
      output,
      totalInput,
      totalOutput,
      // 没有当前 step 的上下文或模型上限时，保留缺省百分比而不捏造测量值。
      percent: tokens > 0 && contextLimit ? Math.round((tokens / contextLimit) * 100) : null,
      // 请求费用是所有助手 cost 的完整求和，不是最后 step 的费用。
      cost: request.cost,
    }
  })

  // 插件视图始终需要可读对象，用零值而非 undefined 支撑 state().tokens 等直接读取。
  // tokens、input、output、percent 整体发布，避免侧栏在同一帧显示不同版本的统计字段。
  // 初始值补齐 total 字段，保留 50ms 发布节奏与原来的箭头脉冲 API。
  // 保留既有节流与脉冲生命周期，只把请求费用并入同一初始快照。
  const [state, setStateThrottled] = createThrottledSignal<StateValue>({ tokens: 0, totalTokens: 0, input: 0, output: 0, totalInput: 0, totalOutput: 0, percent: null, cost: 0 }, 50)
  createEffect(() => setStateThrottled(stateRaw()))

  // sidebar 总有零值 state，零值到正值可触发增长；tokens/percent 的单独变化不会续期。
  const flow = createTokenFlowPulse(state)

  // 沿源功能跟随当前选择；历史 API ID 不能唯一标识 Catalog 别名。
  const targetApiUrl = createMemo(() => {
    // 等待持久化选择就绪，避免冷启动时探测随后会被恢复状态替换的临时模型。
    if (!local.model.ready) return null
    const selected = local.model.current()
    if (!selected) return null
    const provider = props.api.state.provider.find((item) => item.id === selected.providerID)
    const model = provider?.models[selected.modelID]
    if (!model) return null
    // 提供者 baseURL 沿实际 SDK/native 适配器的优先级，显示与发往的端点保持一致。
    const configuredBaseUrl = provider?.options.baseURL
    const baseUrl = typeof configuredBaseUrl === "string" && configuredBaseUrl !== "" ? configuredBaseUrl : model.api.url
    // 配置缺失或地址非法时不创建探测，不能把未解析的配置误报为网络离线。
    if (typeof baseUrl !== "string" || !URL.canParse(baseUrl)) return null
    const url = new URL(baseUrl)
    // 只探测 HTTP origin，避免协议路径的路由与处理耗时混入网络 RTT。
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null
  })

  const [latency, setLatency] = createSignal<number | null>(null)
  const [pingStatus, setPingStatus] = createSignal<"ok" | "down" | "init">("init")
  const [isProxy, setIsProxy] = createSignal(false)

  createEffect(
    on(targetApiUrl, (url) => {
      // 切换 origin 时清除旧测量，不能把上一模型的 RTT 显示给新选择。
      setLatency(null)
      setPingStatus("init")
      setIsProxy(false)
      if (!url) return

      let active = true
      let timer: ReturnType<typeof setTimeout> | undefined
      const controller = new AbortController()
      // 视图清理须中止在途请求；仅忽略迟到结果仍会留下提供者网络 IO。
      onCleanup(() => {
        active = false
        controller.abort()
        if (timer) clearTimeout(timer)
      })

      const ping = async () => {
        if (!active) return
        // 从探测开始统一计三秒，后续请求沿同一信号，不因代理刷新重新开启超时窗口。
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)])
        try {
          // 唯一探测owner归daemon，侧栏只订阅结果并保留现有清理与超时信号。
          const target = new URL("/tui/provider-endpoint-status", sdk.url)
          target.searchParams.set("url", url)
          if (sdk.directory) target.searchParams.set("directory", sdk.directory)
          const res = await sdk.fetch(target, { method: "GET", signal })
          if (!res.ok) throw new Error(`endpoint status failed: ${res.status}`)
          const status = (await res.json()) as { status: "ok" | "down"; latency: number | null; route: { type: "direct" | "proxy" } }
          if (!active) return
          setIsProxy(status.route.type === "proxy")
          // 网关故障判定沿daemon口径，不把业务认证状态另判为网络故障。
          setPingStatus(status.status)
          setLatency(status.status === "down" ? null : status.latency)
        } catch {
          if (!active) return
          setPingStatus("down")
          setLatency(null)
        }
        // 当前探测结算后才排下一次，保留源功能的一秒串行间隔。
        if (active) timer = setTimeout(ping, PING_INTERVAL)
      }

      void ping()
    }),
  )

  // RTT 颜色只反映连接耗时，不把提供者认证状态混入延迟等级。
  const latencyDisplay = createMemo(() => {
    const icon = isProxy() ? "🌐" : "⚡"
    if (pingStatus() === "down") return { text: `${icon} offline`, fg: theme().error }
    const value = latency()
    if (value === null) return { text: `${icon} ...`, fg: theme().textMuted }
    return { text: `${icon} ${value}ms`, fg: value < 300 ? theme().success : value < 800 ? theme().warning : theme().error }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      {/* 插件主题在渲染时读取，脉冲只存布尔值，不缓存可能被换肤替换的颜色。 */}
      <text fg={theme().textMuted}><span style={{ fg: flow().input ? theme().text : theme().textMuted }}>↑</span> {state().input.toLocaleString()}({state().totalInput.toLocaleString()}) · <span style={{ fg: flow().output ? theme().text : theme().textMuted }}>↓</span> {state().output.toLocaleString()}({state().totalOutput.toLocaleString()})</text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} ({state().totalTokens.toLocaleString()}) tokens{state().percent != null ? ` · ${state().percent}%` : ""}</text>
      {/* 未解析到 origin 时隐藏探测，避免冷启动一直显示没有目标的等待状态。 */}
      <text fg={theme().textMuted}>
        {money.format(state().cost)} spent
        {targetApiUrl() && <>{" · "}<span style={{ fg: latencyDisplay().fg }}>{latencyDisplay().text}</span></>}
      </text>
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
