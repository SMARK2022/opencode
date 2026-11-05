import { createMemo, createResource, mapArray } from "solid-js"
import type { AssistantMessage, Message, SessionRequestUsageGetResponse } from "@opencode-ai/sdk/v2"

export function createRequestUsage(input: {
  messages: () => readonly Message[]
  mounted: (id: string) => boolean
  get: (sessionID: string, requestID: string) => Promise<SessionRequestUsageGetResponse | undefined>
}) {
  // 只索引消息身份；统计由后端账本提供，不读取 Part 正文或按分页窗口重算费用。
  const groups = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    for (const message of input.messages()) {
      if (message.role !== "assistant") continue
      const group = result.get(message.parentID)
      if (group) {
        group.push(message)
        continue
      }
      result.set(message.parentID, [message])
    }
    return result
  })
  const visible = createMemo(() =>
    [...groups()].flatMap(([id, messages]) =>
      messages.some(
        (message) =>
          input.mounted(message.id) &&
          (message.error?.name === "MessageAbortedError" ||
            (message.finish && !["tool-calls", "unknown"].includes(message.finish))),
      )
        ? [id]
        : [],
    ),
  )
  // 同一 parent 仅有一个资源；退出驻留窗口后由 Solid 释放，不另设缓存或清理状态机。
  const resources = mapArray(visible, (requestID) => {
    const [usage] = createResource(
      // 只有该请求的助手身份或完成边界变化才刷新，正文 delta 不参与依赖。
      () =>
        groups()
          .get(requestID)
          ?.map((message) => `${message.id}@${message.time.completed ?? "running"}`)
          .join(","),
      () => input.get(groups().get(requestID)![0].sessionID, requestID),
    )
    return [requestID, usage] as const
  })
  return createMemo(() => new Map(resources()))
}
