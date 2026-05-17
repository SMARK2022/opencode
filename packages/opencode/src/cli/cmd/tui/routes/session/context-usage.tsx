import { createEffect, createMemo, createResource, For, Show } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useDialog } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { useLocal } from "@tui/context/local"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { TextAttributes } from "@opentui/core"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util"
import { createThrottledSignal } from "../../util/signal"
import {
  computeContextData,
  type ContextCategoryColor,
  type ContextUsageData,
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
  const keybind = useKeybind()
  const { theme } = useTheme()
  useRenderer()

  const inputRaw = createMemo(() => {
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
  })

  // Throttle the resource source so streaming deltas don't starve computeContextData.
  // leadingAndTrailing ensures the first update is immediate and the last one always flushes.
  const [input, setInput] = createThrottledSignal(inputRaw(), 500)
  createEffect(() => setInput(inputRaw()))

  const [data] = createResource(input, computeContextData)

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return
    if (evt.name === "escape" || (evt.ctrl && evt.name === "c") || keybind.match("app_exit", evt)) {
      props.onClose()
      evt.preventDefault()
      evt.stopPropagation()
    }
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
