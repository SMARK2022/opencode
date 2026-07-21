import { createMemo } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useClipboard } from "../../context/clipboard"
import type { PromptInfo } from "../../component/prompt/history"
import { stripPromptPartIDs as strip } from "../../prompt/part"
// #520：DialogSelectOption.onSelect 的 ctx 类型；显式标注使 filter 后的 options 保持完整推断。
import { type DialogContext } from "../../ui/dialog"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  // #520：subtype 已由 Session renderer 从持久化 Part 判定；Dialog 不再解析 synthetic XML。
  goalContinuation?: boolean
  setPrompt?: (prompt: PromptInfo) => void
  // submit 回调由调用方传入——dialog.replace 渲染上下文脱离 PromptRefProvider，
  // 不能在此组件内直接 usePromptRef，必须通过 prop 传递。
  submit?: () => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()

  // 从消息 parts 提取 PromptInfo（text 拼接 + file parts），供 Revert/Retry 复用
  function extractPromptInfo(messageID: string): PromptInfo {
    const parts = sync.data.part[messageID]
    return parts.reduce(
      (agg, part) => {
        if (part.type === "text") {
          if (!part.synthetic) agg.input += part.text
        }
        if (part.type === "file") agg.parts.push(strip(part))
        return agg
      },
      { input: "", parts: [] as PromptInfo["parts"] },
    )
  }
  const clipboard = useClipboard()

  return (
    <DialogSelect
      title={props.goalContinuation ? "Goal Continuation" : "Message Actions"}
      options={[
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog: DialogContext) => {
            const msg = message()
            if (!msg) return

            void sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })

            if (props.setPrompt) {
              props.setPrompt(extractPromptInfo(msg.id))
            }
            dialog.clear()
          },
        },
        {
          title: "Retry",
          value: "session.retry",
          description: "revert to here and resend",
          onSelect: async (dialog: DialogContext) => {
            const msg = message()
            if (!msg) return
            dialog.clear()
            // session 运行中先 abort（与 Undo 一致），确保 runner idle 后 revert 才能过 assertNotBusy
            const status = sync.data.session_status?.[props.sessionID]
            if (status?.type !== "idle") {
              await sdk.client.session.abort({ sessionID: props.sessionID }).catch(() => {})
            }
            // 提取原消息内容（revert 前 parts 必在 sync.data 中）
            const promptInfo = extractPromptInfo(msg.id)
            const revertResponse = await sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })
            if (revertResponse.error) {
              // revert 失败（如 runner 仍 busy）：填回内容让用户手动处理
              props.setPrompt?.(promptInfo)
              return
            }
            // revert 成功：填回 prompt 并自动提交。set 同步更新 store，submit 读取 store——时序安全
            props.setPrompt?.(promptInfo)
            props.submit?.()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog: DialogContext) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await clipboard.write?.(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog: DialogContext) => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const msg = message()
            const prompt = msg
              ? sync.data.part[msg.id].reduce(
                  (agg, part) => {
                    if (part.type === "text") {
                      if (!part.synthetic) agg.input += part.text
                    }
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] as PromptInfo["parts"] },
                )
              : undefined
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          },
        },
        // #520：先复用原有 option handler 再收窄集合，确保 continuation 没有复制出来的 Revert 实现。
        // Goal continuation 的 synthetic 正文不能 Copy/Retry/Fork；保留同一个 Revert owner，避免第二套回退路径。
      ].filter((option) => !props.goalContinuation || option.value === "session.revert")}
    />
  )
}
