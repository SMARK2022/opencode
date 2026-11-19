import { useEvent } from "@tui/context/event"
import type {
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"

function activeAssistant(messages: SessionMessage[]) {
  const index = messages.findIndex((message) => message.type === "assistant" && !message.time.completed)
  if (index < 0) return
  const assistant = messages[index]
  return assistant?.type === "assistant" ? assistant : undefined
}

function activeCompaction(messages: SessionMessage[]) {
  const index = messages.findIndex((message) => message.type === "compaction")
  if (index < 0) return
  const compaction = messages[index]
  return compaction?.type === "compaction" ? compaction : undefined
}

function activeShell(messages: SessionMessage[], callID: string) {
  const index = messages.findIndex((message) => message.type === "shell" && message.callID === callID)
  if (index < 0) return
  const shell = messages[index]
  return shell?.type === "shell" ? shell : undefined
}

function latestTool(assistant: SessionMessageAssistant | undefined, callID?: string) {
  return assistant?.content.findLast(
    (item): item is SessionMessageAssistantTool => item.type === "tool" && (callID === undefined || item.id === callID),
  )
}

function latestText(assistant: SessionMessageAssistant | undefined) {
  return assistant?.content.findLast((item): item is SessionMessageAssistantText => item.type === "text")
}

function latestReasoning(assistant: SessionMessageAssistant | undefined, reasoningID: string) {
  return assistant?.content.findLast(
    (item): item is SessionMessageAssistantReasoning => item.type === "reasoning" && item.id === reasoningID,
  )
}

export const { use: useSyncV2, provider: SyncProviderV2 } = createSimpleContext({
  name: "SyncV2",
  init: () => {
    const [store, setStore] = createStore<{
      messages: {
        [sessionID: string]: SessionMessage[]
      }
    }>({
      messages: {},
    })

    const event = useEvent()
    const sdk = useSDK()

    type Mark = (id: string) => void
    // Set 同时充当本次请求身份，只在 HTTP 在途时保存该会话实际更新的消息 ID。
    const requests = new Map<string, Set<string>>()

    function update(sessionID: string, fn: (messages: SessionMessage[], mark: Mark) => void) {
      // 从事件所有者记录变化，无需读取正文，也不会使路由订阅内容变化。
      const changed = requests.get(sessionID)
      setStore(
        "messages",
        produce((draft) => {
          fn((draft[sessionID] ??= []), (id) => {
            changed?.add(id)
          })
        }),
      )
    }

    function updateAssistant(sessionID: string, fn: (assistant: SessionMessageAssistant) => false | void) {
      update(sessionID, (draft, mark) => {
        const assistant = activeAssistant(draft)
        // 迟到且已找不到 owner 的事件不应把未变化消息标记为本地更新。
        if (assistant && fn(assistant) !== false) mark(assistant.id)
      })
    }

    event.subscribe((event) => {
      switch (event.type) {
        case "session.next.prompted": {
          update(event.properties.sessionID, (draft, mark) => {
            // 新消息用生产端事件 ID 与 HTTP 去重，不能按本地数组位置标记。
            mark(event.id)
            draft.unshift({
              id: event.id,
              type: "user",
              text: event.properties.prompt.text,
              files: event.properties.prompt.files,
              agents: event.properties.prompt.agents,
              time: { created: event.properties.timestamp },
            })
          })
          break
        }
        case "session.next.synthetic":
          update(event.properties.sessionID, (draft, mark) => {
            mark(event.id)
            draft.unshift({
              id: event.id,
              type: "synthetic",
              sessionID: event.properties.sessionID,
              text: event.properties.text,
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.shell.started":
          update(event.properties.sessionID, (draft, mark) => {
            mark(event.id)
            draft.unshift({
              id: event.id,
              type: "shell",
              callID: event.properties.callID,
              command: event.properties.command,
              output: "",
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.shell.ended":
          update(event.properties.sessionID, (draft, mark) => {
            // Shell 不归属活动 Assistant，用调用标识找到该条独立消息。
            const match = activeShell(draft, event.properties.callID)
            if (!match) return
            match.output = event.properties.output
            match.time.completed = event.properties.timestamp
            mark(match.id)
          })
          break
        case "session.next.step.started":
          update(event.properties.sessionID, (draft, mark) => {
            // 一次 Started 可能关掉旧 Assistant 并创建新消息，旧快照不能漏保任一条。
            const currentAssistant = activeAssistant(draft)
            if (currentAssistant) {
              currentAssistant.time.completed = event.properties.timestamp
              mark(currentAssistant.id)
            }
            mark(event.id)
            draft.unshift({
              id: event.id,
              type: "assistant",
              agent: event.properties.agent,
              model: event.properties.model,
              content: [],
              snapshot: event.properties.snapshot ? { start: event.properties.snapshot } : undefined,
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.step.ended":
          updateAssistant(event.properties.sessionID, (assistant) => {
            assistant.time.completed = event.properties.timestamp
            assistant.finish = event.properties.finish
            assistant.cost = event.properties.cost
            assistant.tokens = event.properties.tokens
            if (event.properties.snapshot)
              assistant.snapshot = { ...assistant.snapshot, end: event.properties.snapshot }
          })
          break
        case "session.next.step.failed":
          updateAssistant(event.properties.sessionID, (assistant) => {
            assistant.time.completed = event.properties.timestamp
            assistant.finish = "error"
            assistant.error = event.properties.error
          })
          break
        case "session.next.text.started":
          updateAssistant(event.properties.sessionID, (assistant) => {
            assistant.content.push({ type: "text", text: "" })
          })
          break
        case "session.next.text.delta":
          updateAssistant(event.properties.sessionID, (assistant) => {
            const match = latestText(assistant)
            if (!match) return false
            match.text += event.properties.delta
          })
          break
        case "session.next.text.ended":
          updateAssistant(event.properties.sessionID, (assistant) => {
            // 插件可缩短最终正文，不能用字符数判断本地结束事件是否更新了消息。
            const match = latestText(assistant)
            if (!match) return false
            match.text = event.properties.text
          })
          break
        case "session.next.tool.input.started":
          updateAssistant(event.properties.sessionID, (assistant) => {
            assistant.content.push({
              type: "tool",
              id: event.properties.callID,
              name: event.properties.name,
              time: { created: event.properties.timestamp },
              state: { status: "pending", input: "" },
            })
          })
          break
        case "session.next.tool.input.delta":
          updateAssistant(event.properties.sessionID, (assistant) => {
            const match = latestTool(assistant, event.properties.callID)
            if (match?.state.status !== "pending") return false
            match.state.input += event.properties.delta
          })
          break
        case "session.next.tool.input.ended":
          break
        case "session.next.tool.called":
          updateAssistant(event.properties.sessionID, (assistant) => {
            const match = latestTool(assistant, event.properties.callID)
            if (!match) return false
            match.time.ran = event.properties.timestamp
            match.provider = event.properties.provider
            match.state = { status: "running", input: event.properties.input, structured: {}, content: [] }
          })
          break
        case "session.next.tool.progress":
          updateAssistant(event.properties.sessionID, (assistant) => {
            // 工具输出变化可能完全不改可见正文，仍应保留所属 Assistant。
            const match = latestTool(assistant, event.properties.callID)
            if (match?.state.status !== "running") return false
            match.state.structured = event.properties.structured
            match.state.content = [...event.properties.content]
          })
          break
        case "session.next.tool.success":
          updateAssistant(event.properties.sessionID, (assistant) => {
            const match = latestTool(assistant, event.properties.callID)
            if (match?.state.status !== "running") return false
            match.state = {
              status: "completed",
              input: match.state.input,
              structured: event.properties.structured,
              content: [...event.properties.content],
            }
            match.provider = event.properties.provider
            match.time.completed = event.properties.timestamp
          })
          break
        case "session.next.tool.failed":
          updateAssistant(event.properties.sessionID, (assistant) => {
            const match = latestTool(assistant, event.properties.callID)
            if (match?.state.status !== "running") return false
            match.state = {
              status: "error",
              error: event.properties.error,
              input: match.state.input,
              structured: match.state.structured,
              content: match.state.content,
            }
            match.provider = event.properties.provider
            match.time.completed = event.properties.timestamp
          })
          break
        case "session.next.reasoning.started":
          updateAssistant(event.properties.sessionID, (assistant) => {
            assistant.content.push({
              type: "reasoning",
              id: event.properties.reasoningID,
              text: "",
            })
          })
          break
        case "session.next.reasoning.delta":
          updateAssistant(event.properties.sessionID, (assistant) => {
            const match = latestReasoning(assistant, event.properties.reasoningID)
            if (!match) return false
            match.text += event.properties.delta
          })
          break
        case "session.next.reasoning.ended":
          updateAssistant(event.properties.sessionID, (assistant) => {
            const match = latestReasoning(assistant, event.properties.reasoningID)
            if (!match) return false
            match.text = event.properties.text
          })
          break
        case "session.next.retried":
          break
        case "session.next.compaction.started":
          update(event.properties.sessionID, (draft, mark) => {
            mark(event.id)
            draft.unshift({
              id: event.id,
              type: "compaction",
              reason: event.properties.reason,
              summary: "",
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.compaction.delta":
          update(event.properties.sessionID, (draft, mark) => {
            const match = activeCompaction(draft)
            if (!match) return
            match.summary += event.properties.text
            mark(match.id)
          })
          break
        case "session.next.compaction.ended":
          update(event.properties.sessionID, (draft, mark) => {
            // 压缩摘要不是 Assistant 正文，回包竞争由其自身消息 ID 判定。
            const match = activeCompaction(draft)
            if (!match) return
            match.summary = event.properties.text
            match.include = event.properties.include
            mark(match.id)
          })
          break
      }
    })

    const result = {
      data: store,
      session: {
        message: {
          async sync(sessionID: string) {
            const changed = new Set<string>()
            requests.set(sessionID, changed)
            try {
              const response = await sdk.client.v2.session.messages({ sessionID })
              // 回包内容即使相同也不恢复旧请求的写入权。
              if (requests.get(sessionID) !== changed) return
              const messages = new Map((response.data?.items ?? []).map((message) => [message.id, message]))
              for (const message of store.messages[sessionID] ?? []) {
                const saved = messages.get(message.id)
                // 已持久化的终态优先；本地先完成也不能回退成同 ID 的未完成快照。
                if (saved?.type === "assistant" && saved.time.completed !== undefined) continue
                // 仍在流式输出的前缀未必已投影到 HTTP，静默请求也要保留它。
                // 其余未变且不在回包中的完成消息遵从服务端分页。
                if (
                  changed.has(message.id) ||
                  (message.type === "assistant" &&
                    (message.time.completed === undefined || saved?.type === "assistant"))
                ) {
                  messages.set(message.id, message)
                }
              }
              // 与服务端 time_created / BINARY id 的降序一致，不能使用语言区域排序。
              setStore(
                "messages",
                sessionID,
                reconcile(
                  [...messages.values()].sort(
                    (a, b) => b.time.created - a.time.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
                  ),
                ),
              )
            } finally {
              // 旧请求返回或失败时，只释放自己的身份；新请求仍要收集后续事件。
              if (requests.get(sessionID) === changed) requests.delete(sessionID)
            }
          },
          fromSession(sessionID: string) {
            const messages = store.messages[sessionID]
            if (!messages) return []
            return messages
          },
        },
      },
    }

    return result
  },
})
