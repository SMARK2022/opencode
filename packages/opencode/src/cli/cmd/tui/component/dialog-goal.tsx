import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { createMemo, onMount } from "solid-js"
import { MAX_OBJECTIVE_CHARS } from "@/session/goal"

// [local-smark] goal 管理 dialog
// SDK 未重新生成 goalSet/goalClear 方法，直接用 sdk.fetch 调用 HTTP 端点
// POST/DELETE 需手动设置 directory query param（sdk.fetch 的 rewrite 仅处理 GET/HEAD）

interface DialogGoalProps {
  sessionID: string
}

// 封装 goal HTTP 调用：统一错误处理和 dialog 关闭
function useGoalApi(sessionID: string) {
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const dialog = useDialog()

  // 构建带 directory query param 的 URL
  // workspace routing 中间件通过 directory 定位实例
  const goalUrl = () => {
    const url = new URL(`/session/${sessionID}/goal`, sdk.url)
    const dir = sync.path.directory || sdk.directory
    if (dir) url.searchParams.set("directory", dir)
    return url
  }

  // POST /session/:id/goal — 设置或更新 goal
  const setGoal = async (input: { objective?: string; status?: string }) => {
    // 仅对 objective 更新做长度预检；status-only 更新（Pause/Resume）objective 为 undefined，
    // 必须跳过预检，否则会误拦状态切换。上限与 SessionGoal.MAX_OBJECTIVE_CHARS 保持一致，
    // 提前拦截避免无效往返
    if (input.objective !== undefined && input.objective.trim().length > MAX_OBJECTIVE_CHARS) {
      toast.show({
        message: `Goal objective must be at most ${MAX_OBJECTIVE_CHARS} characters`,
        variant: "error",
      })
      return
    }
    try {
      const resp = await sdk.fetch(goalUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
      if (!resp.ok) {
        // 服务器返回 NamedError 形态 {name, data:{message}}；提取 data.message
        // 让用户看到具体原因（如 budget/无goal 等 client 未预判的拒绝）。
        // 解析失败或无 message 时回退通用文案，兼容中间件非 JSON 响应
        const body = await resp.json().catch(() => null)
        toast.show({ message: body?.data?.message ?? "Failed to update goal", variant: "error" })
        return
      }
      dialog.clear()
    } catch {
      toast.show({ message: "Failed to update goal", variant: "error" })
    }
  }

  // DELETE /session/:id/goal — 清除 goal
  const clearGoal = async () => {
    try {
      const resp = await sdk.fetch(goalUrl(), {
        method: "DELETE",
      })
      if (!resp.ok) {
        toast.show({ message: "Failed to clear goal", variant: "error" })
        return
      }
      dialog.clear()
    } catch {
      toast.show({ message: "Failed to clear goal", variant: "error" })
    }
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
  const { setGoal, clearGoal } = useGoalApi(props.sessionID)

  const goal = createMemo(() => sync.data.session_goal[props.sessionID])

  // 使用 large 宽度（88 chars），让 goal objective 描述和选项标题有足够显示空间，
  // 避免 medium（60 chars）下选项被截断或显得拥挤。与 dialog-session-list / dialog-skill 一致。
  onMount(() => dialog.setSize("large"))

  return (
    <DialogSelect
      title="Manage Goal"
      // 只有 3-4 个选项，不需要搜索 filter；隐藏 filter 节省 2 行垂直空间，
      // 让小终端（≤18 行）也能完整显示所有选项无需滚动
      renderFilter={false}
      options={[
        {
          title: "Edit objective",
          description: goal()?.objective,
          value: "edit",
          onSelect: () => {
            dialog.replace(() => <DialogGoalEdit sessionID={props.sessionID} />)
          },
        },
        // active 状态下显示 Pause 选项
        ...(goal()?.status === "active"
          ? [{
              title: "Pause",
              description: "Pause the active goal",
              value: "pause",
              onSelect: () => void setGoal({ status: "paused" }),
            }]
          : []),
        // paused/blocked/complete 状态下显示 Resume 选项
        // complete 也允许 Resume：用户可能需要让模型重新验证或继续完善已完成的目标
        ...(goal()?.status === "paused" || goal()?.status === "blocked" || goal()?.status === "complete"
          ? [{
              title: "Resume",
              description: "Resume the goal to active",
              value: "resume",
              onSelect: () => void setGoal({ status: "active" }),
            }]
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
