import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { createMemo, createSignal, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { Locale } from "../util/locale"
import { goalEndpointUrl, goalHttpClear, goalHttpSet } from "../util/goal-http"

// [local-smark] goal 管理 dialog
// SDK 未重新生成 goalSet/goalClear 方法，直接用 sdk.fetch 调用 HTTP 端点
// raw sdk.fetch不经过生成SDK的rewrite；POST/DELETE显式携带directory并复用鉴权headers。

interface DialogGoalProps {
  sessionID: string
}

// 封装 goal HTTP 调用：统一错误处理和 dialog 关闭；实现落到 shared goal-http
// #368：goal 生命周期走 sdk.fetch 而非 as-any SDK 方法——生成物没有 goalSet/goalClear，
// as-any 调用在运行时是 undefined(...) 同步 TypeError；显式 fetch 保证类型与运行时一致。
function useGoalApi(sessionID: string) {
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const dialog = useDialog()

  // #0503：directory query param 由 shared goalEndpointUrl 统一构建，
  // workspace routing 中间件通过 directory 定位实例（多实例 daemon 模式）
  const goalUrl = () => {
    const dir = sync.path.directory || sdk.directory
    return goalEndpointUrl(sdk.url, sessionID, dir || undefined)
  }
  const deps = () => ({
    url: goalUrl(),
    fetch: (input: string | URL, init?: RequestInit) => sdk.fetch(input, init),
    onError: (message: string) => toast.show({ message, variant: "error" as const }),
  })

  // POST /session/:id/goal — 设置或更新 goal
  // [local-smark] 返回解析后的 Goal，供 toggle 调用方 reconcile 到 sync store
  const setGoal = async (input: { objective?: string; status?: string; continueOnError?: boolean }, close = true) => {
    const goal = await goalHttpSet(deps(), input)
    if (goal === undefined) return
    if (close) dialog.clear()
    return goal
  }

  // DELETE /session/:id/goal — 清除 goal
  const clearGoal = async () => {
    const ok = await goalHttpClear(deps())
    if (ok) dialog.clear()
  }

  return { setGoal, clearGoal }
}

// 无 goal 时显示：输入 objective 创建新 goal
export function DialogGoal(props: DialogGoalProps) {
  const dialog = useDialog()
  const { setGoal } = useGoalApi(props.sessionID)

  return (
    <DialogPrompt
      title="Set Goal"
      placeholder="Enter your objective..."
      onConfirm={(value) => {
        // 空 objective 不允许创建
        if (!value.trim()) return
        void setGoal({ objective: value })
      }}
      onCancel={() => dialog.clear()}
    />
  )
}

// 有 goal 时显示：管理菜单
export function DialogGoalMenu(props: DialogGoalProps) {
  const dialog = useDialog()
  const sync = useSync()
  const { theme } = useTheme()
  const { setGoal, clearGoal } = useGoalApi(props.sessionID)
  // [local-smark] toggle loading 状态：防止重复切换
  const [toggleLoading, setToggleLoading] = createSignal(false)

  const goal = createMemo(() => sync.data.session_goal[props.sessionID])

  // [local-smark] 切换 continueOnError：POST 成功后 reconcile 到 sync store，
  // 保持菜单打开
  const toggleContinueOnError = async () => {
    if (toggleLoading()) return
    const g = goal()
    if (!g) return
    setToggleLoading(true)
    // close=false：toggle 后菜单保持打开
    const result = await setGoal({ continueOnError: !g.continueOnError }, false)
    if (result?.goal) {
      // 立即更新 store，不等 SSE
      sync.goal.reconcile(props.sessionID, result.goal)
    }
    setToggleLoading(false)
  }

  // 摘要使用large宽度；header只提供内容槽位，不能替代对话框尺寸。
  onMount(() => dialog.setSize("large"))
  // header 显示 goal 摘要：wrapMode=none + overflow=hidden + Locale.truncate
  // 保证可预测的行数，不依赖渲染器自动撑开容器
  const goalHeader = createMemo(() => {
    const g = goal()
    if (!g) return undefined
    return (
      <box flexDirection="column" gap={0}>
        {/* objective 截断到 68 chars（88 宽度 - 8 padding - 12 "Objective: " 前缀） */}
        <text fg={theme.textMuted} wrapMode="none" overflow="hidden">
          {"Objective: " + (g.objective ? Locale.truncate(g.objective, 68) : "—")}
        </text>
        <text fg={theme.textMuted} wrapMode="none" overflow="hidden">
          {"Status: " + g.status + "  ·  Tokens: " + g.tokensUsed}
        </text>
        {/* [local-smark] terminal 状态显示 reason，让用户了解终态化依据 */}
        {g.reason ? (
          <text fg={theme.textMuted} wrapMode="none" overflow="hidden">
            {"Reason: " + Locale.truncate(g.reason, 68)}
          </text>
        ) : undefined}
      </box>
    )
  })

  return (
    <DialogSelect
      title="Manage Goal"
      header={goalHeader()}
      renderFilter={false}
      options={[
        {
          title: "Edit objective",
          // 截断 description 避免 6400 字符 objective 在选项行中换行导致 rows() 计算不准
          description: goal()?.objective ? Locale.truncate(goal()!.objective, 60) : undefined,
          value: "edit",
          onSelect: () => {
            dialog.replace(() => <DialogGoalEdit sessionID={props.sessionID} />)
          },
        },
        // [local-smark] Continue after errors toggle：开启显示 ✓ Enabled，
        // 关闭显示 ○ Disabled，保存中显示 ⋯ Saving
        {
          title: "Continue after errors",
          description: toggleLoading() ? "⋯ Saving" : goal()?.continueOnError ? "✓ Enabled" : "○ Disabled",
          value: "toggle-continue",
          onSelect: () => void toggleContinueOnError(),
        },
        // active 状态下显示 Pause 选项
        ...(goal()?.status === "active"
          ? [
              {
                title: "Pause",
                description: "Pause the active goal",
                value: "pause",
                onSelect: () => void setGoal({ status: "paused" }),
              },
            ]
          : []),
        // paused/blocked/complete 状态下显示 Resume 选项
        // complete 也允许 Resume：用户可能需要让模型重新验证或继续完善已完成的目标
        ...(goal()?.status === "paused" || goal()?.status === "blocked" || goal()?.status === "complete"
          ? [
              {
                title: "Resume",
                description: "Resume the goal to active",
                value: "resume",
                onSelect: () => void setGoal({ status: "active" }),
              },
            ]
          : []),
        {
          title: "Clear",
          description: "Remove the goal",
          value: "clear",
          onSelect: () => void clearGoal(),
        },
      ]}
    />
  )
}

// 编辑 objective 的 dialog：预填充当前 objective
function DialogGoalEdit(props: DialogGoalProps) {
  const dialog = useDialog()
  const sync = useSync()
  const { setGoal } = useGoalApi(props.sessionID)

  const goal = createMemo(() => sync.data.session_goal[props.sessionID])

  return (
    <DialogPrompt
      title="Edit Goal Objective"
      value={goal()?.objective}
      onConfirm={(value) => {
        if (!value.trim()) return
        void setGoal({ objective: value })
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
// #0503：供 prompt `/goal` 零参数路径使用：直接用 submit 权威 sessionID 打开 dialog，
// 不走 goal.manage 的 route.type===session 守卫（home 上 create 后路由可能尚未切换）
export function openGoalDialog(input: { sessionID: string; hasGoal: boolean; replace: (view: () => unknown) => void }) {
  if (input.hasGoal) {
    input.replace(() => <DialogGoalMenu sessionID={input.sessionID} />)
    return
  }
  input.replace(() => <DialogGoal sessionID={input.sessionID} />)
}
