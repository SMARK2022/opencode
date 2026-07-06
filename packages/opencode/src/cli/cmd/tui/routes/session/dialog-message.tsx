import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import * as Clipboard from "@tui/util/clipboard"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
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

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
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
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return
            dialog.clear()
            // 如果 session 正在运行，先 abort（与 Undo 命令一致），
            // 确保 runner idle 后 revert 才能通过 assertNotBusy
            const status = sync.data.session_status?.[props.sessionID]
            if (status?.type !== "idle") {
              await sdk.client.session.abort({ sessionID: props.sessionID }).catch(() => {})
            }
            // 提取原消息内容（在 revert 前，parts 必在 sync.data 中）
            const promptInfo = extractPromptInfo(msg.id)
            // await revert 完成——B1 守卫确保 revert 期间无其他操作竞争
            const revertResponse = await sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })
            if (revertResponse.error) {
              // revert 失败（如 runner 仍 busy），填回内容让用户手动处理
              props.setPrompt?.(promptInfo)
              return
            }
            // revert 成功：填回 prompt 并自动提交。
            // set 同步更新 store（prompt/index.tsx），submit 读取 store——时序安全
            props.setPrompt?.(promptInfo)
            props.submit?.()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await Clipboard.copy(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
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
      ]}
    />
  )
}
