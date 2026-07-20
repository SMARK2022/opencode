import { createEffect, createMemo, createResource, For, onCleanup, Show, untrack } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { Binding, Keymap, KeymapEvent } from "@opentui/keymap"
import { useTuiConfig } from "../../config"
import { useOpencodeKeymap } from "../../keymap"
import { useDialog } from "../../ui/dialog"
import { useLocal } from "../../context/local"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { createThrottledSignal } from "../../util/signal"
import { TextAttributes } from "@opentui/core"
import { Locale } from "../../util/locale"
import type {
  Agent,
  Config,
  Message,
  Part,
  Provider,
  Session,
  SessionMessageInputEstimate,
  VcsInfo,
} from "@opencode-ai/sdk/v2"
import type { InputBreakdown } from "@opencode-ai/schema/session-message"
import {
  computeContextData,
  type ComputeContextDataInput,
  type ContextCategoryColor,
  type ContextUsageData,
  type GridSquare,
} from "../../util/context-usage"

// 完整快照保留全部 wire 字段；resource 仅在节流后深拷贝，避免订阅绕过节流。
export function contextUsageSnapshot<T,>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function contextUsageRefreshKey(input: {
  messages: readonly Message[]
  getParts: (id: string) => readonly Part[]
  providers: readonly Provider[]
  config?: Config
  agents?: readonly Agent[]
  session?: Session
  lastUserModel?: { providerID: string; modelID: string }
  vcs?: VcsInfo
  paths: ComputeContextDataInput["paths"]
  columns?: number
  instructionFiles?: ComputeContextDataInput["instructionFiles"]
  skills?: ComputeContextDataInput["skills"]
  toolDefinitions?: ComputeContextDataInput["toolDefinitions"]
}) {
  const request = input.session?.request
  // 轻量字段订阅 streaming；流式正文只取长度，完整快照留到节流发布后。
  return [
    input.columns ?? "",
    input.paths.cwd,
    input.paths.worktree ?? "",
    input.paths.shell ?? "",
    input.paths.home ?? "",
    input.paths.config ?? "",
    input.lastUserModel ? `${input.lastUserModel.providerID}/${input.lastUserModel.modelID}` : "",
    configRefreshKey(input.config),
    input.vcs ? refreshJson(input.vcs) : "",
    input.providers.map(providerRefreshKey).join("|"),
    (input.agents ?? [])
      .map((agent) => `${agent.name}:${agent.mode}:${agent.hidden ? 1 : 0}:${agent.description ?? ""}:${agent.prompt?.length ?? 0}:${refreshJson(agent.permission)}`)
      .join("|"),
    input.session?.id ?? "",
    refreshJson(input.session?.permission),
    input.session?.tokens ? tokenRefreshKey(input.session.tokens) : "",
    input.session?.cost ?? "",
    // 本轮投影包括零预算与首包前估算，不能退回旧消息的估算 owner。
    request
      ? [
          request.messageID,
          request.assistantID ?? "",
          request.input,
          request.output,
          request.cost,
          request.stepInput,
          request.stepOutput,
          request.pendingInput ?? "",
          request.estimatedInput ?? "",
          request.model?.providerID ?? "",
          request.model?.modelID ?? "",
          request.model?.contextLimit ?? "",
          inputEstimateRefreshKey(request.inputEstimate),
        ].join("/")
      : "",
    // 显式空列表覆盖扫描或目录默认，和未提供列表不同。
    input.instructionFiles ? input.instructionFiles.map((item) => `${item.path}:${item.content.length}`).join("|") : "-",
    input.skills ? input.skills.map((item) => `${item.name}:${item.description}:${item.path}`).join("|") : "-",
    input.toolDefinitions ? input.toolDefinitions.map((item) => `${item.name}:${item.text.length}`).join("|") : "-",
    input.messages
      .map((message) => [messageRefreshKey(message), input.getParts(message.id).map(partRefreshKey).join(",")].join("="))
      .join("\n"),
  ].join("\n")
}

// 只累计结构和字符串长度，不序列化工具参数；这个信号不参与 token 估算。
function refreshJsonLength(value: unknown): number {
  if (typeof value === "string") return value.length + 2
  if (value === null || typeof value !== "object") return String(value).length
  if (Array.isArray(value)) return value.reduce<number>((length, item) => length + 1 + refreshJsonLength(item), 2)
  return Object.entries(value).reduce((length, [key, item]) => length + key.length + 4 + refreshJsonLength(item), 2)
}

function refreshJson(value: unknown) {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

function providerRefreshKey(provider: Provider) {
  return [
    provider.id,
    Object.entries(provider.models)
      .map(([id, model]) => `${id}:${model.id}:${model.providerID}:${model.api.id}:${model.status}:${model.limit.context}:${model.limit.input}:${model.limit.output}`)
      .join(","),
  ].join(":")
}

function configRefreshKey(config: Config | undefined) {
  if (!config) return ""
  // 只观察计算实际使用的预留和扫描路径，流式更新不复制整份 config。
  return [
    config.compaction?.reserved ?? "",
    Array.isArray(config.instructions) ? config.instructions.join("\0") : "",
    Array.isArray(config.skills?.paths) ? config.skills.paths.join("\0") : "",
  ].join("|")
}

function messageRefreshKey(message: Message) {
  const extra = message.role === "assistant" ? message.inputEstimate : undefined
  return [
    message.id,
    message.role,
    "parentID" in message ? message.parentID : "",
    "providerID" in message ? message.providerID : "",
    "modelID" in message ? message.modelID : "",
    message.time && "completed" in message.time ? message.time.completed : "",
    "tokens" in message && message.tokens ? tokenRefreshKey(message.tokens) : "",
    message.agent,
    message.role === "user" ? `${message.model.providerID}/${message.model.modelID}` : "",
    message.role === "user" ? message.system?.length ?? 0 : "",
    message.role === "user" ? refreshJson(message.tools) : "",
    message.role === "assistant" ? `${message.summary ? 1 : 0}:${message.finish ?? ""}:${message.error ? 1 : 0}` : "",
    message.role === "assistant" ? message.cost : "",
    inputEstimateRefreshKey(extra),
  ].join(":")
}

function partRefreshKey(part: Part): string {
  const base = `${part.id ?? ""}:${part.type}`
  if (part.type === "text") return `${base}:${part.text?.length ?? 0}:${part.ignored ? 1 : 0}`
  if (part.type === "reasoning") return `${base}:${part.text?.length ?? 0}`
  if (part.type === "tool") {
    const state = part.state
    if (state.status === "pending") return `${base}:${part.tool}:${state.status}:${refreshJsonLength(state.input)}:${state.raw?.length ?? 0}`
    // 压缩标记、read 规则路径和附件各自改变分类，不能只观察工具输出长度。
    if (state.status === "completed")
      return [
        base,
        part.tool,
        state.status,
        refreshJsonLength(state.input),
        state.output?.length ?? 0,
        state.time.compacted ?? "",
        Array.isArray(state.metadata.loaded) ? state.metadata.loaded.filter((item) => typeof item === "string").join("\0") : "",
        state.attachments?.map(partRefreshKey).join(",") ?? "",
      ].join(":")
    if (state.status === "error")
      return `${base}:${part.tool}:${state.status}:${refreshJsonLength(state.input)}:${state.error?.length ?? 0}`
    return `${base}:${part.tool}:${state.status}:${refreshJsonLength(state.input)}`
  }
  // 目标只有 step-finish 携带确认细分；step-start 不再承担上传估算。
  if (part.type === "step-finish")
    return `${base}:${part.cost ?? 0}:${tokenRefreshKey(part.tokens)}:${part.inputChars ?? ""}:${part.inputBreakdown ? inputBreakdownRefreshKey(part.inputBreakdown) : ""}`
  if (part.type === "file") return `${base}:${part.filename ?? ""}:${part.mime}:${part.url?.length ?? 0}`
  if (part.type === "compaction") return `${base}:${part.tail_start_id ?? ""}`
  if (part.type === "subtask") return `${base}:${part.prompt.length}:${part.description.length}`
  return base
}

function tokenRefreshKey(tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }) {
  return `${tokens.input}/${tokens.output}/${tokens.reasoning}/${tokens.cache.read}/${tokens.cache.write}`
}

function inputEstimateRefreshKey(input: SessionMessageInputEstimate | undefined) {
  if (!input) return ""
  return [
    input.input,
    input.bodyChars,
    input.confirmed ? 1 : 0,
    input.charsPerToken ?? "",
    input.afterPartID ?? "",
    input.contextLimit ?? "",
    input.inputBreakdown ? inputBreakdownRefreshKey(input.inputBreakdown) : "",
  ].join("/")
}

// 数值逐字段展开，100→200这类等长变化也要刷新；共享Schema保留可选媒体测量。
function inputBreakdownRefreshKey(input: InputBreakdown) {
  return [
    input.system,
    input.instructions,
    input.skills,
    input.tools,
    input.messages.userText,
    input.messages.assistantText,
    input.messages.reasoning,
    input.messages.toolInput,
    input.messages.toolOutput,
    input.messages.attachments,
    input.messages.total,
    input.media ? `${input.media.rawChars}/${input.media.textChars}/${input.media.tokens}/${input.media.count}` : "",
  ].join("/")
}


// 显示缩写不改变底层 token，明细相加仍使用原始整数，不能把四舍五入结果当账本。
function formatTokens(tokens: number) {
  // 先判断百万档，避免百万级窗口仍被显示成四位数 k 并挤掉右侧占比。
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

// 未知模型窗口没有可比较分母；显示 0.0% 而不是向终端输出 Infinity/NaN。
function percent(tokens: number, max: number) {
  // 明细占比始终以窗口为分母，不能换成 usable 后让 reserve 项显示超过自身容量的比例。
  if (!max) return "0.0%"
  return `${((tokens / max) * 100).toFixed(1)}%`
}

// 数值字段与路径先截断再补齐，长指令路径不能挤到旁边的网格列。
function fixed(input: string, width: number) {
  return Locale.truncate(input, width).padEnd(width)
}

// 分类和网格共用颜色解析，secondary 等新增分类不能只在一处被降级成 muted。
function color(theme: ReturnType<typeof useTheme>["theme"], name: ContextCategoryColor) {
  return theme[name] ?? theme.textMuted
}

// 符号补充颜色辨识；输入与工具定义共享颜色时仍须有不同标记。
function categoryMarker(name: string) {
  // 新 mass 类别必须有独立 marker，否则列表与网格图例无法区分 Attachments/Unaccounted。
  if (name === "System prompt") return "◆"
  if (name === "Instructions") return "◇"
  if (name === "Skills") return "●"
  if (name === "Tool definitions") return "◦"
  if (name === "User Messages") return "▰"
  if (name === "Tool Results") return "▾"
  if (name === "Attachments") return "▣"
  if (name === "Assistant Messages") return "▱"
  if (name === "Tool Calls") return "▴"
  if (name === "Pending") return "◌"
  if (name === "Unaccounted") return "×"
  if (name === "Free space") return "·"
  return "×"
}

// 保存的路径可能来自另一平台，两种分隔符都识别，不能按 TUI 宿主系统假设路径格式。
function displayPath(input: string) {
  return input.split(/[\\/]/).pop() || input
}

// footer 的确认总额与实时窗口是不同口径；尚无确认消费时使用窗口信息，不制造 Session Totals。
export function contextUsageFooter(data: ContextUsageData, columns: number) {
  const usage = data.details.usage
  // footer 留出关闭提示的固定宽度；总额中间截断也不能覆盖右侧 esc 操作。
  const width = Math.max(36, columns - 18)
  const text =
    // 金额单独为正也不能证明存在 token 总额；零 token 会话仍显示实时窗口而非伪造账本。
    usage.total > 0
      ? [
          `Session Totals`,
          `Input ${formatTokens(usage.input)}`,
          `Output ${formatTokens(usage.output)}`,
          // reasoning 是独立确认字段，显示它不会再次改变 Output 或 total 的数值。
          usage.reasoning > 0 ? `Reason ${formatTokens(usage.reasoning)}` : undefined,
          `Cache W/R ${formatTokens(usage.cacheWrite)}/${formatTokens(usage.cacheRead)}`,
          usage.cost > 0 ? `Cost $${usage.cost.toFixed(4)}` : undefined,
        ].filter(Boolean).join("  ")
      : [
          `Current Window`,
          `Used ${formatTokens(data.totalTokens)}`,
          `Free ${formatTokens(data.categories.find((item) => item.name === "Free space")?.tokens ?? 0)}`,
          `Usable ${formatTokens(data.details.window.usableInput)}`,
          `Buffer ${formatTokens(data.details.window.compactionBuffer)}`,
        ].join("  ")
  // 中间截断保留两端身份，显示缩略不回写 provider 的确认总额。
  return fixed(Locale.truncateMiddle(text, width), width)
}

// 网格只消费 computeContextData 的有限 cells，渲染层不再从比例构造另一份分配状态。
function ContextGrid(props: { rows: GridSquare[][] }) {
  const { theme } = useTheme()
  // 渲染只为每个采样符号补一个空格，不能在此按 fullness 再次生成额外 cells 改变分配比例。
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={props.rows}>
        {(row) => (
          <box flexDirection="row" flexShrink={0}>
            <For each={row}>
              {(square) => (
                <text fg={color(theme, square.color)} flexShrink={0}>
                  {square.symbol + " "}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

// window 预留仅展示模型容量，Prompt/Conversation 展示实际载荷，组间不重复计算分类总额。
function CategoryList(props: { data: ContextUsageData }) {
  const { theme } = useTheme()
  // 标签列不能随某项 token 数增长而变宽，否则 resize 会把数值列推到网格上。
  const labelWidth = 20
  // 数值列只截断展示文本，超窗口百分比仍保留大于 100% 的实际估算。
  const valueWidth = 14
  // 无 provider reserve 时整项不存在，按分类过滤而非补一个看似有测量依据的零值。
  // tokens===0 不进列表，避免 Attachments 等零值噪音；网格 weights 仍可含零（waterline 为 no-op）。
  const groups = createMemo(() => [
    {
      title: "Prompt",
      categories: props.data.categories.filter(
        (item) =>
          item.tokens > 0 && ["System prompt", "Instructions", "Skills", "Tool definitions"].includes(item.name),
      ),
    },
    {
      title: "Conversation",
      // 附件与待上传结果等额拆桶，列表与网格使用同一组类别。
      categories: props.data.categories.filter(
        (item) =>
          item.tokens > 0 &&
          ["User Messages", "Tool Results", "Attachments", "Assistant Messages", "Tool Calls", "Pending"].includes(item.name),
      ),
    },
    {
      title: "Window",
      categories: props.data.categories.filter(
        (item) => item.tokens > 0 && ["Unaccounted", "Free space", "Model reserve", "Autocompact buffer"].includes(item.name),
      ),
    },
  ].filter((group) => group.categories.length > 0))

  return (
    <box flexDirection="column" gap={1} flexGrow={1} paddingLeft={2}>
      <For each={groups()}>
        {(group) => (
          <box flexDirection="column" gap={0}>
            <box height={1}><text fg={theme.textMuted}>{group.title}</text></box>
            <For each={group.categories}>
              {(category) => (
                <box flexDirection="row" justifyContent="space-between" height={1}>
                  <box flexDirection="row" gap={1} flexShrink={1}>
                    <text fg={color(theme, category.color)} flexShrink={0}>
                      {categoryMarker(category.name)}
                    </text>
                    <text fg={theme.text}>{fixed(category.name, labelWidth)}</text>
                  </box>
                  <text fg={theme.textMuted} flexShrink={0}>
                    {fixed(`${formatTokens(category.tokens)} ${percent(category.tokens, props.data.maxTokens)}`.padStart(valueWidth), valueWidth)}
                  </text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

// 明细只显示代表性路径与计数，完整分类 token 仍来自 data；隐藏长列表不应减少已用量。
export function contextUsageDetailLines(data: ContextUsageData, columns: number) {
  const messages = data.details.messages
  // 按调用时列宽响应 resize；36 列下限只保证基础字段可读，不宣称最窄终端能容纳整行。
  const lineWidth = Math.max(36, columns - 8)
  // 路径中间截断保留文件尾部，basename 仍按两种分隔符解析，不能依赖宿主平台的 path.basename。
  const detailWidth = Math.max(18, Math.min(58, Math.floor(columns / 3)))
  // 磁盘规则与 read 加载的规则有不同来源，明细并列展示，但不在 UI 再次估算其正文。
  const files = [
    ...data.details.instructions.map((item) => ({ label: item.path, tokens: item.tokens })),
    ...data.details.loadedInstructions.map((item) => ({ label: item.path, tokens: item.tokens })),
  ]
  // 用户正文之外的工具结果和文件也会发送为输入，只按 role 展示会漏掉助手承载的返回内容。
  const input = [
    `User ${formatTokens(messages.userText)}`,
    `Tool results ${formatTokens(messages.toolResults)}`,
    `Files ${formatTokens(messages.attachments)}`,
  ]
    .filter(Boolean)
    .join("  ")
  // 摘要单列只在非零时展示；其 token 已归输出总额，UI 不能再把 Summary 加入其他计数。
  const output = [
    `Text ${formatTokens(messages.assistantText)}`,
    `Reasoning ${formatTokens(messages.reasoning)}`,
    `Tool calls ${formatTokens(messages.toolCalls)}`,
    messages.compactionSummary > 0 ? `Summary ${formatTokens(messages.compactionSummary)}` : undefined,
  ]
    .filter(Boolean)
    .join("  ")
  // 只取首个路径限制展示宽度；工具/技能数量仍来自完整列表，不能随明细截断减少能力数。
  const prompt = [
    ...files.slice(0, 1).map((item) => `Instruction ${formatTokens(item.tokens)} ${Locale.truncateMiddle(displayPath(item.label), detailWidth)}`),
    data.details.toolDefs.length > 0 ? `Tools ${data.details.toolDefs.length}` : undefined,
    data.details.skills.length > 0 ? `Skills ${data.details.skills.length}` : undefined,
  ]
    .filter(Boolean)
    .join("  ")

  return [
    input ? `Input   ${input}` : undefined,
    output ? `Output  ${output}` : undefined,
    prompt ? `Prompt  ${prompt}` : undefined,
  ]
    // 可选项全部为空时省略整行，避免空 Prompt 明细占用有限高度并挤掉真实输入输出。
    .filter((line): line is string => !!line && line.trim().length > 0)
    .map((line) => fixed(Locale.truncateMiddle(line, lineWidth), lineWidth))
}

// 明细行长度由同一 formatter 限制，组件不能拼回被截断的路径再使网格溢出。
function Details(props: { data: ContextUsageData; columns: number }) {
  const { theme } = useTheme()
  // 只在完整结果和列宽上建立展示 memo，不能重新订阅原始部件让一行混合两个计算版本。
  const lines = createMemo(() => contextUsageDetailLines(props.data, props.columns))
  return (
    <box flexDirection="column" gap={0} paddingTop={1}>
      <For each={lines()}>
        {(line) => (
          <box height={1}>
            <text fg={theme.textMuted}>{line}</text>
          </box>
        )}
      </For>
    </box>
  )
}

// 先订阅轻量字段，完整输入只在节流发布后形成脱离 store proxy 的快照。
export function contextUsageResource(input: () => ComputeContextDataInput) {
  const inputSource = createMemo(() => {
    const value = input()
    return contextUsageRefreshKey({ ...value, getParts: (id) => value.parts[id] ?? [] })
  })
  // 首值立即发布，持续 delta 只覆盖尾值，沿用现有 500ms 首尾节流。
  const [throttled, setThrottled] = createThrottledSignal(inputSource(), 500)
  createEffect(() => setThrottled(inputSource()))
  const snapshot = createMemo<ComputeContextDataInput>(() => {
    throttled()
    // 深拷贝不再订阅 store，异步计算也只读取这一轮完整快照。
    return untrack(() => contextUsageSnapshot(input()))
  })
  return createResource(snapshot, computeContextData)
}

// 此注册入口由面板与真实 keymap harness 共用，关闭键不经过另一个 matcher 或全局退出命令。
export function registerContextUsageKeys<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
  input: { bindings: () => readonly Binding<TTarget, TEvent>[]; enabled: () => boolean; onClose: () => void },
) {
  createEffect(() => {
    // 弹层打开即撤掉面板 layer，其 modal/escape 处理继续拥有优先权，不能先关面板再冒泡。
    if (!input.enabled()) return
    // 配置更新会重新注册；Solid 在重跑及卸载前清理旧 layer，不能留下关闭旧面板的回调。
    onCleanup(keymap.registerLayer({
      priority: 1,
      bindings: [{ key: "escape" }, { key: "ctrl+c" }, ...input.bindings()].map((binding) => ({
        ...binding,
        // 配置里的 app.exit 仅提供按键/序列；当前面板把动作替换为 onClose，不调用应用退出。
        cmd: input.onClose,
        // 两个开关分别阻止宿主传播和 keymap 内继续匹配，用户配置的 fallthrough 不能放行全局退出。
        preventDefault: true,
        fallthrough: false,
      })),
    }))
  })
}

// 面板与 headless 调用共用唯一 resource，流式更新只发布节流后的完整快照。
export function ContextUsagePanel(props: { sessionID: string; onClose: () => void }) {
  const sync = useSync()
  const local = useLocal()
  const project = useProject()
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()
  const { theme } = useTheme()
  const keymap = useOpencodeKeymap()
  const tuiConfig = useTuiConfig()

  // 保留全部计算输入；原位 streaming 依赖由 resource 的轻量 key 订阅。
  const input = createMemo(() => {
    // 这里只复制成员集合，消息与部件的完整深快照仍在节流后构建。
    const messages = [...(sync.data.message[props.sessionID] ?? [])]
    // 只取当前会话消息关联的部件，其他会话的 delta 不应刷新本窗口的估算。
    const parts = Object.fromEntries(messages.map((msg) => [msg.id, [...(sync.data.part[msg.id] ?? [])]]))
    const paths = project.instance.path()
    return {
      messages,
      parts,
      providers: [...sync.data.provider],
      config: sync.data.config,
      agents: [...sync.data.agent],
      // 持久权限与本轮 request 一起进入同一 key 和快照，保持服务端投影优先级。
      session: sync.session.get(props.sessionID),
      lastUserModel: local.model.current(),
      vcs: sync.data.vcs,
      paths: { cwd: paths.directory, worktree: paths.worktree, shell: sync.data.config.shell },
      columns: dimensions().width,
    }
  })

  // 一个 resource 处理所有来源变化，Solid 丢弃旧请求的迟到结果；不追加 polling 或独立刷新计时器。
  const [data] = contextUsageResource(input)

  // 关闭只调用路由的 onClose，不能复用 Session interrupt 将展示操作升级为模型执行取消。
  registerContextUsageKeys(keymap, {
    // gather 保留默认 Ctrl+D、leader 序列与用户覆盖；不能把 app_exit 缩成固定的 Ctrl+C。
    // 新关闭命令仍由既有 layer 消费，保留应用退出键在面板内仅关闭的语义。
    bindings: () => [...tuiConfig.keybinds.gather("app_exit", ["app.exit"]), ...tuiConfig.keybinds.get("session.context.close")],
    enabled: () => dialog.stack.length === 0,
    onClose: props.onClose,
  })

  return (
    <box
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
      borderStyle="rounded"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
      marginTop={1}
    >
      {/* 标题读取同一 resource 结果的总量与分母，流式刷新不能把新 used 与旧窗口限制拼成占比。 */}
      <box flexDirection="row" justifyContent="space-between" marginBottom={1} height={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.primary}>{"◇"}</text>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Context usage
          </text>
        </box>
        <Show when={data()}>
          {(d) => (
            <text fg={theme.textMuted}>
              {`${formatTokens(d().totalTokens)} / ${formatTokens(d().maxTokens)} (${(d().percentage * 100).toFixed(1)}%)`}
            </text>
          )}
        </Show>
      </box>

      <Show when={data()}>
        {(d) => (
          <box flexDirection="column" gap={1}>
            {/* 模型标签使用计算结果的请求身份，切换 UI 选择不能单独改名而仍展示旧请求的用量。 */}
            <box height={1}>
              <text fg={theme.textMuted}>{d().model}</text>
            </box>
            {/* 网格和分类列表共享同一完成快照，异步读取期间不在左右两列各触发一次计算。 */}
            <box flexDirection="row" gap={2}>
              <ContextGrid rows={d().gridRows} />
              <CategoryList data={d()} />
            </box>
            {/* 明细消费已算好的路径与整数，渲染不能重新访问磁盘使同一结果在两次绘制间变动。 */}
            <Details data={d()} columns={dimensions().width} />
          </box>
        )}
      </Show>

      {/* 首次加载没有结果才显示 Loading；刷新期间仍展示原 resource 值，不把暂未完成当零消费。 */}
      <box flexDirection="row" justifyContent="space-between" marginTop={1} height={1}>
        <Show when={data()} fallback={<text fg={theme.textMuted}>Loading...</text>}>
          {(d) => <text fg={theme.textMuted}>{contextUsageFooter(d(), dimensions().width)}</text>}
        </Show>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            esc
          </text>
          <text fg={theme.textMuted}>close</text>
        </box>
      </box>
    </box>
  )
}
