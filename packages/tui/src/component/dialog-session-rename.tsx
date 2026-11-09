import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

interface DialogSessionRenameProps {
  session: string
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const session = createMemo(() => sync.session.get(props.session))
  const [generating, setGenerating] = createSignal(false)
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  function fail(error: unknown) {
    if (disposed) return
    // 失败只恢复非 busy 并展示真实错误；不 clear 面板，因此 textarea 草稿仍可修改或重试。
    setGenerating(false)
    toast.show({ title: "Failed to generate title", message: errorMessage(error), variant: "error" })
  }

  function generate() {
    // busy 同时锁住 Generate 和 Enter，防止重复 POST 或把旧草稿 PATCH 回 Session。
    if (generating()) return
    setGenerating(true)
    void sdk.client.session.generateTitle({ sessionID: props.session }).then(
      (result) => {
        // Esc 只卸载面板，不伪称取消服务端请求；晚到响应不得关闭后续 Dialog 或弹陈旧 toast。
        if (disposed) return
        if (result.error) return fail(result.error)
        dialog.clear()
      },
      (error) => fail(error),
    )
  }

  return (
    <DialogPrompt
      title="Rename Session"
      value={session()?.title}
      busy={generating()}
      busyText="Generating…"
      onGenerate={generate}
      onConfirm={(value) => {
        void sdk.client.session.update({
          sessionID: props.session,
          title: value,
        })
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
