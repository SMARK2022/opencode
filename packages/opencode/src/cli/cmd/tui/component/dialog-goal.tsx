import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { createMemo } from "solid-js"

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
    try {
      const resp = await sdk.fetch(goalUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
      if (!resp.ok) {
        toast.show({ message: "Failed to update goal", variant: "error" })
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

  return (
    <DialogSelect
      title="Manage Goal"
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
