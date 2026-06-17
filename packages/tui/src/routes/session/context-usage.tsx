import { createEffect, createMemo, createResource, For, Show, untrack } from "solid-js"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useDialog } from "../../ui/dialog"
import { useBindings } from "../../keymap"
import { useLocal } from "../../context/local"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { TextAttributes } from "@opentui/core"
import type { Agent, Config, Message, Part, Provider, VcsInfo } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { createThrottledSignal } from "../../util/signal"
import {
  computeContextData,
  type ContextCategoryColor,
  type ContextUsageData,
  type ComputeContextDataInput,
  type GridSquare,
} from "../../util/context-usage"

function formatTokens(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

export function contextUsageSnapshot<T extends Message[] | Part[]>(value: T): T {
  // The JSON roundtrip deliberately reads nested Solid store fields. A shallow
  // array copy misses tool/text deltas and only refreshes on whole-part updates.
  return JSON.parse(JSON.stringify(value)) as T
}

export function contextUsageRefreshKey(input: {
  messages: readonly Message[]
  getParts: (id: string) => readonly Part[]
  providers: readonly Provider[]
  config?: Config
  agents?: readonly Agent[]
  lastUserModel?: { providerID: string; modelID: string }
  vcs?: VcsInfo
  paths: { cwd: string; worktree?: string }
  columns?: number
}) {
  // 这个 key 是 `/context` 面板的低成本刷新信号：它必须读取 streaming
  // part 的 nested 字段来保持响应式依赖，但不能像真正输入快照那样深拷贝
  // message/part 全量内容。否则高频 tool raw/text delta 会在 throttle 之前
  // 先触发 JSON roundtrip，正是本次修复要移除的热路径。
  return [
    input.columns ?? "",
    input.paths.cwd,
    input.paths.worktree ?? "",
    input.lastUserModel ? `${input.lastUserModel.providerID}/${input.lastUserModel.modelID}` : "",
    configRefreshKey(input.config),
    input.vcs ? refreshJson(input.vcs) : "",
    input.providers.map(providerRefreshKey).join("|"),
    (input.agents ?? []).map((agent) => `${agent.name}:${agent.mode}:${agent.hidden ? 1 : 0}:${agent.description ?? ""}:${refreshJson(agent.permission)}`).join("|"),
    input.messages.map((message) => [messageRefreshKey(message), input.getParts(message.id).map(partRefreshKey).join(",")].join("=")).join("\n"),
  ].join("\n")
}

function refreshJsonLength(value: unknown) {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
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
    Object.values(provider.models)
      .map((model) => `${model.id}:${model.status}:${model.limit.context}:${model.limit.input}:${model.limit.output}`)
      .join(","),
  ].join(":")
}

function configRefreshKey(config: Config | undefined) {
  if (!config) return ""
  // computeContextData 只读取 compaction reserve、额外 instruction 路径和
  // skill 路径；这里刻意不序列化完整 config，避免把无关配置变更接入
  // `/context` 面板的 streaming 热路径。
  return [
    config.compaction?.reserved ?? "",
    Array.isArray(config.instructions) ? config.instructions.join("\0") : "",
    Array.isArray(config.skills?.paths) ? config.skills.paths.join("\0") : "",
  ].join("|")
}

function messageRefreshKey(message: Message) {
  return [
    message.id,
    message.role,
    "parentID" in message ? message.parentID : "",
    "providerID" in message ? message.providerID : "",
    "modelID" in message ? message.modelID : "",
    message.time && "completed" in message.time ? message.time.completed : "",
    "tokens" in message && message.tokens ? tokenRefreshKey(message.tokens) : "",
    "inputChars" in message ? message.inputChars : "",
    "inputTokens" in message ? message.inputTokens : "",
    "inputBreakdown" in message && message.inputBreakdown ? inputBreakdownRefreshKey(message.inputBreakdown) : "",
  ].join(":")
}

function partRefreshKey(part: Part) {
  const base = `${part.id ?? ""}:${part.type}`
  if (part.type === "text") return `${base}:${part.text?.length ?? 0}:${part.ignored ? 1 : 0}`
  if (part.type === "reasoning") return `${base}:${part.text?.length ?? 0}`
  if (part.type === "tool") {
    const state = part.state
    if (state.status === "pending") return `${base}:${part.tool}:${state.status}:${state.raw?.length ?? 0}`
    if (state.status === "completed") return `${base}:${part.tool}:${state.status}:${refreshJsonLength(state.input)}:${state.output?.length ?? 0}:${refreshJson(state.attachments)}`
    if (state.status === "error") return `${base}:${part.tool}:${state.status}:${refreshJsonLength(state.input)}:${state.error?.length ?? 0}`
    return `${base}:${part.tool}:${state.status}`
  }
  if (part.type === "step-start") return `${base}:${part.inputTokens ?? ""}:${part.inputChars ?? ""}:${part.inputBreakdown ? inputBreakdownRefreshKey(part.inputBreakdown) : ""}`
  if (part.type === "step-finish") return `${base}:${part.cost ?? 0}:${tokenRefreshKey(part.tokens)}:${part.inputChars ?? ""}:${part.inputBreakdown ? inputBreakdownRefreshKey(part.inputBreakdown) : ""}`
  if (part.type === "file") return `${base}:${part.filename}:${part.mime}:${part.url?.length ?? 0}`
  return base
}

function tokenRefreshKey(tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }) {
  return `${tokens.input}/${tokens.output}/${tokens.reasoning}/${tokens.cache.read}/${tokens.cache.write}`
}

type InputBreakdown = NonNullable<Extract<Message, { inputBreakdown?: unknown }>["inputBreakdown"]>

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

function percent(tokens: number, max: number) {
  if (!max) return "0.0%"
  return `${((tokens / max) * 100).toFixed(1)}%`
}

function fixed(input: string, width: number) {
  return Locale.truncate(input, width).padEnd(width)
}

function color(theme: ReturnType<typeof useTheme>["theme"], name: ContextCategoryColor) {
  return theme[name] ?? theme.textMuted
}

function categoryMarker(name: string) {
  if (name === "System prompt") return "◆"
  if (name === "Instructions") return "◇"
  if (name === "Skills") return "●"
  if (name === "Tool definitions") return "◦"
  if (name === "Input Messages") return "▰"
  if (name === "Tool results") return "▾"
  if (name === "Output Messages") return "▱"
  if (name === "Tool calls") return "▴"
  if (name === "Free space") return "·"
  return "×"
}

function displayPath(input: string) {
  return input.split(/[\\/]/).pop() || input
}

export function contextUsageFooter(data: ContextUsageData, columns: number) {
  const usage = data.details.usage
  const width = Math.max(36, columns - 18)
  const text =
    usage.total > 0
      ? [
          `Session Totals`,
          `Input ${formatTokens(usage.input)}`,
          `Output ${formatTokens(usage.output)}`,
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
  return fixed(Locale.truncateMiddle(text, width), width)
}

function ContextGrid(props: { rows: GridSquare[][] }) {
  const { theme } = useTheme()
  const gridColor = (name: ContextCategoryColor) => {
    if (name === "primary") return theme.primary
    if (name === "secondary") return theme.secondary
    if (name === "warning") return theme.warning
    if (name === "accent") return theme.accent
    if (name === "info") return theme.info
    if (name === "success") return theme.success
    return theme.textMuted
  }

  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={props.rows}>
        {(row) => (
          <box flexDirection="row" flexShrink={0}>
            <For each={row}>
              {(square) => (
                <text fg={gridColor(square.color)} flexShrink={0}>
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

function CategoryList(props: { data: ContextUsageData }) {
  const { theme } = useTheme()
  const labelWidth = 20
  const valueWidth = 14
  const groups = createMemo(() => [
    {
      title: "Prompt",
      categories: props.data.categories.filter((item) =>
        ["System prompt", "Instructions", "Skills", "Tool definitions"].includes(item.name),
      ),
    },
    {
      title: "Conversation",
      categories: props.data.categories.filter((item) =>
        ["Input Messages", "Tool results", "Output Messages", "Tool calls"].includes(item.name),
      ),
    },
    {
      title: "Window",
      categories: props.data.categories.filter((item) =>
        ["Free space", "Model reserve", "Autocompact buffer"].includes(item.name),
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

export function contextUsageDetailLines(data: ContextUsageData, columns: number) {
  const messages = data.details.messages
  const lineWidth = Math.max(36, columns - 8)
  const detailWidth = Math.max(18, Math.min(58, Math.floor(columns / 3)))
  const files = [
    ...data.details.instructions.map((item) => ({ label: item.path, tokens: item.tokens })),
    ...data.details.loadedInstructions.map((item) => ({ label: item.path, tokens: item.tokens })),
  ]
  const input = [
    `User ${formatTokens(messages.userText)}`,
    `Tool results ${formatTokens(messages.toolResults)}`,
    `Files ${formatTokens(messages.attachments)}`,
  ]
    .filter(Boolean)
    .join("  ")
  const output = [
    `Text ${formatTokens(messages.assistantText)}`,
    `Reasoning ${formatTokens(messages.reasoning)}`,
    `Tool calls ${formatTokens(messages.toolCalls)}`,
    messages.compactionSummary > 0 ? `Summary ${formatTokens(messages.compactionSummary)}` : undefined,
  ]
    .filter(Boolean)
    .join("  ")
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
    .filter((line): line is string => !!line && line.trim().length > 0)
    .map((line) => fixed(Locale.truncateMiddle(line, lineWidth), lineWidth))
}

function Details(props: { data: ContextUsageData; columns: number }) {
  const { theme } = useTheme()
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

export function ContextUsagePanel(props: { sessionID: string; onClose: () => void }) {
  const sync = useSync()
  const local = useLocal()
  const project = useProject()
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()
  const tuiConfig = useTuiConfig()
  const { theme } = useTheme()
  useRenderer()

  function buildInput(): ComputeContextDataInput {
    const messages = contextUsageSnapshot([...(sync.data.message[props.sessionID] ?? [])])
    const parts = Object.fromEntries(
      messages.map((msg) => [msg.id, contextUsageSnapshot([...(sync.data.part[msg.id] ?? [])])]),
    )
    const paths = project.instance.path()
    return {
      messages,
      parts,
      providers: [...sync.data.provider],
      config: sync.data.config,
      agents: [...sync.data.agent],
      lastUserModel: local.model.current(),
      vcs: sync.data.vcs,
      paths: { cwd: paths.directory, worktree: paths.worktree },
      columns: dimensions().width,
    }
  }

  const inputSource = createMemo(() => {
    const paths = project.instance.path()
    return contextUsageRefreshKey({
      messages: sync.data.message[props.sessionID] ?? [],
      getParts: (id) => sync.data.part[id] ?? [],
      providers: sync.data.provider,
      config: sync.data.config,
      agents: sync.data.agent,
      lastUserModel: local.model.current(),
      vcs: sync.data.vcs,
      paths: { cwd: paths.directory, worktree: paths.worktree },
      columns: dimensions().width,
    })
  })

  // 这里只 throttle 轻量 refresh key；真正的 message/part snapshot 放在
  // untrack(buildInput) 内执行，保证 JSON roundtrip 不会重新订阅 nested
  // streaming 字段并绕过 throttle。leading/trailing 语义仍保持首次立即刷新、
  // 流式更新结束后补最后一次刷新，这是面板读数必须保持的不变量。
  const [inputKey, setInputKey] = createThrottledSignal(inputSource(), 500)
  createEffect(() => setInputKey(inputSource()))
  const input = createMemo(() => {
    inputKey()
    return untrack(buildInput)
  })

  const [data] = createResource(input, computeContextData)

  useBindings(() => ({
    commands: [
      {
        name: "session.context.close",
        title: "Close context usage",
        category: "Session",
        run: () => {
          if (dialog.stack.length > 0) return
          props.onClose()
        },
      },
    ],
    bindings: tuiConfig.keybinds.get("session.context.close"),
  }))

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
            <box height={1}>
              <text fg={theme.textMuted}>{d().model}</text>
            </box>
            <box flexDirection="row" gap={2}>
              <ContextGrid rows={d().gridRows} />
              <CategoryList data={d()} />
            </box>
            <Details data={d()} columns={dimensions().width} />
          </box>
        )}
      </Show>

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
