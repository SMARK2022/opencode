import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { createMemo, Show } from "solid-js"

// [local-smark] goal 管理 dialog
// 无 goal 时 → DialogPrompt 输入 objective 直接创建
// 有 goal 时 → DialogSelect 选择 Edit/Pause/Resume/Clear
// Edit 选中后用 dialog.replace 切换到 DialogPrompt（无返回导航，可接受）

interface DialogGoalProps {
  sessionID: string
}

// 无 goal 时显示：输入 objective 创建新 goal
export function DialogGoal(props: DialogGoalProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  return (
    <DialogPrompt
      title="Set Goal"
      placeholder="Enter your objective..."
      onConfirm={(value) => {
        // 空 objective 不允许创建
        if (!value.trim()) {
          toast.show({ message: "Objective must not be empty", variant: "error" })
          return
        }
        // SDK 未重新生成，用 as any 绕过方法不存在检查
        void (sdk.client.session as any)
          .goalSet({ sessionID: props.sessionID, objective: value })
          .then(() => dialog.clear())
          .catch(() => toast.show({ message: "Failed to set goal", variant: "error" }))
      }}
      onCancel={() => dialog.clear()}
    />
  )
}

// 有 goal 时显示：管理菜单
export function DialogGoalMenu(props: DialogGoalProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()

  const goal = createMemo(() => sync.data.session_goal[props.sessionID])

  // 调用 goalSet API 更新 status，出错时 toast 提示
  const callSet = (input: { status?: string }) => {
    void (sdk.client.session as any)
      .goalSet({ sessionID: props.sessionID, ...input })
      .then(() => dialog.clear())
      .catch(() => toast.show({ message: "Failed to update goal", variant: "error" }))
  }

  // 调用 goalClear API 删除 goal
  const callClear = () => {
    void (sdk.client.session as any)
      .goalClear({ sessionID: props.sessionID })
      .then(() => dialog.clear())
      .catch(() => toast.show({ message: "Failed to clear goal", variant: "error" }))
  }

  return (
    <DialogSelect
      title="Manage Goal"
      options={[
        {
          title: "Edit objective",
          // 显示当前 objective 作为描述
          description: goal()?.objective,
          value: "edit",
          // 选中后替换 dialog 为 DialogPrompt 编辑模式
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
              onSelect: () => callSet({ status: "paused" }),
            }]
          : []),
        // paused/blocked 状态下显示 Resume 选项
        ...(goal()?.status === "paused" || goal()?.status === "blocked"
          ? [{
              title: "Resume",
              description: "Resume the goal to active",
              value: "resume",
              onSelect: () => callSet({ status: "active" }),
            }]
          : []),
        {
          title: "Clear",
          description: "Remove the goal",
          value: "clear",
          onSelect: () => callClear(),
        },
      ]}
    />
  )
}

// 编辑 objective 的 dialog：预填充当前 objective
function DialogGoalEdit(props: DialogGoalProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()

  const goal = createMemo(() => sync.data.session_goal[props.sessionID])

  return (
    <DialogPrompt
      title="Edit Goal Objective"
      // 预填充当前 objective
      value={goal()?.objective}
      onConfirm={(value) => {
        if (!value.trim()) {
          toast.show({ message: "Objective must not be empty", variant: "error" })
          return
        }
        void (sdk.client.session as any)
          .goalSet({ sessionID: props.sessionID, objective: value })
          .then(() => dialog.clear())
          .catch(() => toast.show({ message: "Failed to update goal", variant: "error" }))
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
