import type { V2Event } from "@opencode-ai/sdk/v2"
import { batch, onCleanup } from "solid-js"

type Delta = Extract<
  V2Event,
  { type: "session.next.text.delta" | "session.next.reasoning.delta" | "session.next.tool.input.delta" }
>

export function createDataEventQueue(apply: (event: V2Event) => void) {
  let pending: Delta[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  function flush() {
    if (timer) clearTimeout(timer)
    timer = undefined
    const events = pending
    pending = []
    // 同一帧批量提交，但不同内容的先后顺序不能因合并而改变。
    batch(() => events.forEach(apply))
  }

  function target(event: Delta) {
    const data = event.data
    const content = "textID" in data ? data.textID : "reasoningID" in data ? data.reasoningID : data.callID
    // 类型也是单元身份：同一个 ID 的正文、推理与工具参数不能混写。
    return JSON.stringify([event.type, data.sessionID, data.assistantMessageID, content])
  }

  onCleanup(() => {
    // 销毁只丢弃待显示片段，既不更改持久化消息，也不写已销毁的 store。
    if (timer) clearTimeout(timer)
    pending = []
  })

  return {
    flush,
    push(event: V2Event) {
      if (
        event.type !== "session.next.text.delta" &&
        event.type !== "session.next.reasoning.delta" &&
        event.type !== "session.next.tool.input.delta"
      ) {
        // 完整值、结束和失败先看到所有前序片段，再沿原 reducer 转换状态。
        flush()
        apply(event)
        return
      }
      const previous = pending.at(-1)
      if (previous && target(previous) === target(event)) {
        // 相同判别类型和目标已核对；保留首条事件身份，仅拼接其 payload。
        pending[pending.length - 1] = {
          ...previous,
          data: { ...previous.data, delta: previous.data.delta + event.data.delta },
        } as Delta
      } else {
        pending.push(event)
      }
      // 只在首片段开启 16ms 窗，持续输入不能把刷新退化成 debounce。
      if (!timer) timer = setTimeout(flush, 16)
    },
  }
}
