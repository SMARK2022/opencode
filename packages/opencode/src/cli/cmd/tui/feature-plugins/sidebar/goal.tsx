import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, Show, createSignal } from "solid-js"

// [local-smark] goal sidebar 面板
// 显示当前 session 的持久化 goal 状态、objective、用量
// 仅当 goal 存在时显示（与 files.tsx 仅显示有 diff 时一致）
// 静态渲染，无动画（与 todo.tsx / files.tsx 一致）

const id = "internal:sidebar-goal"

// goal 状态对应的颜色和符号（与 footer 保持一致）
const STATUS_STYLE: Record<string, { color: string; symbol: string; label: string }> = {
  active: { color: "green", symbol: "●", label: "Active" },
  paused: { color: "yellow", symbol: "⏸", label: "Paused" },
  blocked: { color: "red", symbol: "■", label: "Blocked" },
  complete: { color: "blue", symbol: "✓", label: "Complete" },
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  // 从 sync store 读取 goal 状态
  const goal = createMemo(() => props.api.state.session.goal(props.session_id))
  const style = createMemo(() => (goal() ? STATUS_STYLE[goal()!.status] ?? STATUS_STYLE.active : null))

  return (
    <Show when={goal() && style()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
          {/* 折叠指示器：与 todo.tsx / files.tsx 一致 */}
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={style()!.color}>{style()!.symbol}</text>
          <text fg={theme().text}>
            <b>Goal</b>
          </text>
          <text fg={theme().textMuted}>{style()!.label}</text>
        </box>
        <Show when={open()}>
          {/* objective 文本：允许换行但限制高度，防止超长 objective 占满 sidebar */}
          <box paddingLeft={2}>
            <text fg={theme().text} wrapMode="word">
              {goal()!.objective}
            </text>
          </box>
          {/* 用量行：有预算时显示 "used / budget"，无预算时仅显示 used */}
          <Show when={goal()!.tokensUsed > 0 || goal()!.timeUsedSeconds > 0 || goal()!.tokenBudget != null}>
            <box flexDirection="row" gap={2} paddingLeft={2}>
              <Show when={goal()!.tokenBudget != null}>
                <text fg={theme().textMuted}>
                  {formatTokens(goal()!.tokensUsed)} / {formatTokens(goal()!.tokenBudget!)}
                </text>
              </Show>
              <Show when={goal()!.tokenBudget == null && goal()!.tokensUsed > 0}>
                <text fg={theme().textMuted}>{formatTokens(goal()!.tokensUsed)}</text>
              </Show>
              <Show when={goal()!.timeUsedSeconds > 0}>
                <text fg={theme().textMuted}>{formatTime(goal()!.timeUsedSeconds)}</text>
              </Show>
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

// 格式化 token 数量：1000 → 1K, 1500 → 1.5K, 1000000 → 1M
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}

// 格式化时间：秒 → 1s / 1m30s / 1h05m
function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return s > 0 ? `${m}m${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h}h${rm}m` : `${h}h`
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    // order 350：位于 LSP(300) 和 Todo(400) 之间，
    // 与任务追踪类面板分组
    order: 350,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
