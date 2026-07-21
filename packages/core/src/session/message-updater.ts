import { castDraft, produce, type WritableDraft } from "immer"
import { Effect } from "effect"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"

export type MemoryState = {
  messages: SessionMessage.Message[]
}

export interface Adapter {
  readonly getCurrentAssistant: () => Effect.Effect<SessionMessage.Assistant | undefined>
  readonly getAssistant: (messageID: SessionMessage.ID) => Effect.Effect<SessionMessage.Assistant | undefined>
  readonly getCurrentShell: (callID: string) => Effect.Effect<SessionMessage.Shell | undefined>
  readonly updateAssistant: (assistant: SessionMessage.Assistant) => Effect.Effect<void>
  readonly updateShell: (shell: SessionMessage.Shell) => Effect.Effect<void>
  readonly appendMessage: (message: SessionMessage.Message) => Effect.Effect<void>
  readonly getMessage: (messageID: SessionMessage.ID) => Effect.Effect<SessionMessage.Message | undefined>
  readonly updateMessage: (message: SessionMessage.Message) => Effect.Effect<void>
}

export function memory(state: MemoryState): Adapter {
  const assistantIndex = (messageID: SessionMessage.ID) =>
    state.messages.findLastIndex((message) => message.id === messageID)
  // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
  const latestAssistantIndex = () => state.messages.findLastIndex((message) => message.type === "assistant")
  const activeShellIndex = (callID: string) =>
    state.messages.findLastIndex((message) => message.type === "shell" && message.callID === callID)

  return {
    getMessage(messageID) {
      return Effect.sync(() => state.messages.find((message) => message.id === messageID))
    },
    updateMessage(message) {
      return Effect.sync(() => {
        const index = assistantIndex(message.id)
        if (index >= 0) state.messages[index] = message
      })
    },
    getCurrentAssistant() {
      return Effect.sync(() => {
        const index = latestAssistantIndex()
        if (index < 0) return
        const assistant = state.messages[index]
        return assistant?.type === "assistant" && !assistant.time.completed ? assistant : undefined
      })
    },
    getAssistant(messageID) {
      return Effect.sync(() => {
        const index = assistantIndex(messageID)
        if (index < 0) return
        const assistant = state.messages[index]
        return assistant?.type === "assistant" ? assistant : undefined
      })
    },
    getCurrentShell(callID) {
      return Effect.sync(() => {
        const index = activeShellIndex(callID)
        if (index < 0) return
        const shell = state.messages[index]
        return shell?.type === "shell" ? shell : undefined
      })
    },
    updateAssistant(assistant) {
      return Effect.sync(() => {
        const index = assistantIndex(assistant.id)
        if (index < 0) return
        const current = state.messages[index]
        if (current?.type !== "assistant") return
        state.messages[index] = assistant
      })
    },
    updateShell(shell) {
      return Effect.sync(() => {
        const index = activeShellIndex(shell.callID)
        if (index < 0) return
        const current = state.messages[index]
        if (current?.type !== "shell") return
        state.messages[index] = shell
      })
    },
    appendMessage(message) {
      return Effect.sync(() => {
        state.messages.push(message)
      })
    },
  }
}

export function update(adapter: Adapter, event: SessionEvent.Event) {
  type DraftAssistant = WritableDraft<SessionMessage.Assistant>
  type DraftTool = WritableDraft<SessionMessage.AssistantTool>
  type DraftText = WritableDraft<SessionMessage.AssistantText>
  type DraftReasoning = WritableDraft<SessionMessage.AssistantReasoning>

  const latestTool = (assistant: DraftAssistant | undefined, callID?: string) =>
    assistant?.content.findLast(
      (item): item is DraftTool => item.type === "tool" && (callID === undefined || item.id === callID),
    )

  const latestText = (assistant: DraftAssistant | undefined, textID: string) =>
    assistant?.content.findLast((item): item is DraftText => item.type === "text" && item.id === textID)

  const latestReasoning = (assistant: DraftAssistant | undefined, reasoningID: string) =>
    assistant?.content.findLast((item): item is DraftReasoning => item.type === "reasoning" && item.id === reasoningID)

  const updateOwnedAssistant = (messageID: SessionMessage.ID, recipe: (draft: DraftAssistant) => void) =>
    Effect.gen(function* () {
      const assistant = yield* adapter.getAssistant(messageID)
      if (assistant) yield* adapter.updateAssistant(produce(assistant, recipe))
    })

  return Effect.gen(function* () {
    yield* SessionEvent.All.match(event, {
      "session.next.agent.switched": (event) => {
        return adapter.appendMessage(
          SessionMessage.AgentSwitched.make({
            id: event.data.messageID,
            type: "agent-switched",
            metadata: event.metadata,
            agent: event.data.agent,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.model.switched": (event) => {
        return adapter.appendMessage(
          SessionMessage.ModelSwitched.make({
            id: event.data.messageID,
            type: "model-switched",
            metadata: event.metadata,
            model: event.data.model,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.moved": () => Effect.void,
      "session.next.prompted": (event) => {
        return adapter.appendMessage(
          SessionMessage.User.make({
            id: event.data.messageID,
            type: "user",
            metadata: event.metadata,
            text: event.data.prompt.text,
            files: event.data.prompt.files,
            agents: event.data.prompt.agents,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.prompt.admitted": () => Effect.void,
      // 零助手请求终态只更新账本，消息投影保留真实零助手历史。
      "session.next.prompt.failed": () => Effect.void,
      "session.next.prompt.completed": () => Effect.void,
      // 估算事件仅供现有 Session SELECT 读取，不创建消息或触发用量结算。
      "session.next.request.estimated": () => Effect.void,
      "session.next.context.updated": (event) =>
        adapter.appendMessage(
          SessionMessage.System.make({
            id: event.data.messageID,
            type: "system",
            text: event.data.text,
            time: { created: event.data.timestamp },
          }),
        ),
      "session.next.synthetic": (event) => {
        return adapter.appendMessage(
          SessionMessage.Synthetic.make({
            sessionID: event.data.sessionID,
            text: event.data.text,
            id: event.data.messageID,
            type: "synthetic",
            // 与其他消息同样保存既有事件metadata，展示标记不改变synthetic授权身份。
            metadata: event.metadata,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.messages.hidden": (event) =>
        Effect.forEach(event.data.messageIDs, (messageID) => Effect.gen(function* () {
          const message = yield* adapter.getMessage(messageID)
          if (!message) return
          // 合并标记而非替换metadata，保留审查关联、真实正文与已有终态。
          yield* adapter.updateMessage({ ...message, metadata: { ...message.metadata, hidden: event.data.hidden } })
        }), { discard: true }),
      "session.next.shell.started": (event) => {
        return adapter.appendMessage(
          SessionMessage.Shell.make({
            id: event.data.messageID,
            type: "shell",
            metadata: event.metadata,
            callID: event.data.callID,
            command: event.data.command,
            output: "",
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.shell.ended": (event) => {
        return Effect.gen(function* () {
          const currentShell = yield* adapter.getCurrentShell(event.data.callID)
          if (currentShell) {
            yield* adapter.updateShell(
              produce(currentShell, (draft) => {
                draft.output = event.data.output
                draft.time.completed = event.data.timestamp
              }),
            )
          }
        })
      },
      "session.next.step.started": (event) => {
        return Effect.gen(function* () {
          // 审查child复用但模型并行，明确绑定的独立请求不能提前完成另一助手。
          const currentAssistant = event.data.agent === "permission-reviewer" && typeof event.metadata?.permissionReviewerRequestID === "string"
            ? undefined
            : yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                draft.time.completed = event.data.timestamp
              }),
            )
          }
          yield* adapter.appendMessage(
            SessionMessage.Assistant.make({
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              metadata: event.metadata,
              model: event.data.model,
              // 原生助手的 tokens 在 Ended 前仍缺省，元数据不会触发结算。
              inputEstimate: event.data.inputEstimate,
              time: { created: event.data.timestamp },
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
            }),
          )
        })
      },
      "session.next.step.ended": (event) => {
        return Effect.gen(function* () {
          yield* updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.time.completed = event.data.timestamp
          // 迟到的用量结算可更新快照，但不能将已有失败投影成成功 finish。
          draft.finish = draft.error ? "error" : event.data.finish
          draft.cost = event.data.cost
          draft.tokens = event.data.tokens
          // 零输入也完成确认；迟到结算继续修订同一助手快照。
          if (draft.inputEstimate) draft.inputEstimate.confirmed = true
          if (event.data.snapshot || event.data.files)
            draft.snapshot = {
              ...draft.snapshot,
              end: event.data.snapshot,
              files: event.data.files ? Array.from(event.data.files) : undefined,
            }
          })
          if (event.data.summary) {
            const user = yield* adapter.getMessage(event.data.summary.messageID)
            // 更新同一用户消息而非Session全局summary；重放相同快照只替换，不重复累加。
            if (user?.type === "user") yield* adapter.updateMessage({ ...user,
              summary: { ...user.summary, diffs: event.data.summary.diffs },
            })
          }
        })
      },
      "session.next.step.failed": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.time.completed = event.data.timestamp
          draft.finish = "error"
          draft.error = event.data.error
        })
      },
      "session.next.text.started": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.content.push(
            castDraft(SessionMessage.AssistantText.make({ type: "text", id: event.data.textID, text: "" })),
          )
        })
      },
      "session.next.text.delta": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestText(draft, event.data.textID)
          if (match) match.text += event.data.delta
        })
      },
      "session.next.text.ended": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestText(draft, event.data.textID)
          if (match) match.text = event.data.text
        })
      },
      "session.next.tool.input.started": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.content.push(
            castDraft(
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: event.data.callID,
                name: event.data.name,
                time: { created: event.data.timestamp },
                state: SessionMessage.ToolStatePending.make({ status: "pending", input: "" }),
              }),
            ),
          )
        })
      },
      "session.next.tool.input.delta": () => Effect.void,
      "session.next.tool.input.ended": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.callID)
          if (match && match.state.status === "pending") match.state.input = event.data.text
        })
      },
      "session.next.tool.called": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.callID)
          if (match) {
            match.provider = event.data.provider
            match.time.ran = event.data.timestamp
            match.state = castDraft(
              SessionMessage.ToolStateRunning.make({
                status: "running",
                input: event.data.input,
                structured: {},
                content: [],
              }),
            )
          }
        })
      },
      "session.next.tool.progress": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.callID)
          if (match && match.state.status === "running") {
            // 普通工具进度不能擦掉已完成的权限审查；reviewer自己的新状态仍可覆盖旧状态。
            match.state.structured = { ...event.data.structured,
              ...(event.data.structured.autoReview === undefined && match.state.structured.autoReview !== undefined
                ? { autoReview: match.state.structured.autoReview } : {}),
            }
            match.state.content = [...event.data.content]
          }
        })
      },
      "session.next.tool.success": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.callID)
          if (match && match.state.status === "running") {
            match.provider = {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            }
            match.time.completed = event.data.timestamp
            const sync = event.data.structured.syncInput
            // 只有本地 Edit 的完整真值回写输入；provider 同名字段不能改写调用历史。
            const syncInput = match.name === "edit" && !event.data.provider.executed && sync !== null && typeof sync === "object" &&
              "path" in sync && typeof sync.path === "string" && "edits" in sync && Array.isArray(sync.edits)
              ? { path: sync.path, edits: sync.edits }
              : undefined
            // 只有本地 Write 的格式化真值改写历史输入；空文件同样是有效最终内容。
            const formattedContent = match.name === "write" && !event.data.provider.executed && typeof event.data.structured.formattedContent === "string"
              ? event.data.structured.formattedContent
              : undefined
            match.state = castDraft(
              SessionMessage.ToolStateCompleted.make({
                status: "completed",
                input: syncInput ?? (formattedContent === undefined ? match.state.input : { ...match.state.input, content: formattedContent }),
                // 完成投影后去掉临时整文，避免在 input 与 structured 重复保存。
                structured: {
                  ...Object.fromEntries(Object.entries(event.data.structured).filter(([key]) => !(key === "formattedContent" && formattedContent !== undefined) && !(key === "syncInput" && syncInput !== undefined))),
                  // 终态继续保留本轮reviewID/导航/裁决，不由工具返回值抹去或替换审批事实。
                  ...(match.state.structured.autoReview === undefined ? {} : { autoReview: match.state.structured.autoReview }),
                },
                content: [...event.data.content],
                outputPaths: event.data.outputPaths ? [...event.data.outputPaths] : [],
                result: event.data.result,
              }),
            )
          }
        })
      },
      "session.next.tool.failed": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.callID)
          if (match && (match.state.status === "pending" || match.state.status === "running")) {
            match.provider = {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            }
            match.time.completed = event.data.timestamp
            match.state = castDraft(
              SessionMessage.ToolStateError.make({
                status: "error",
                error: event.data.error,
                input: typeof match.state.input === "string" ? {} : match.state.input,
                structured: match.state.status === "running" ? match.state.structured : {},
                content: match.state.status === "running" ? match.state.content : [],
                result: event.data.result,
              }),
            )
          }
        })
      },
      "session.next.reasoning.started": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.content.push(
            castDraft(
              SessionMessage.AssistantReasoning.make({
                type: "reasoning",
                id: event.data.reasoningID,
                text: "",
                providerMetadata: event.data.providerMetadata,
                time: { created: event.data.timestamp },
              }),
            ),
          )
        })
      },
      "session.next.reasoning.delta": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestReasoning(draft, event.data.reasoningID)
          if (match) match.text += event.data.delta
        })
      },
      "session.next.reasoning.ended": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestReasoning(draft, event.data.reasoningID)
          if (match) {
            match.text = event.data.text
            match.time = { created: match.time?.created ?? event.data.timestamp, completed: event.data.timestamp }
            if (event.data.providerMetadata !== undefined) match.providerMetadata = event.data.providerMetadata
          }
        })
      },
      "session.next.retried": () => Effect.void,
      "session.next.compaction.started": () => Effect.void,
      "session.next.compaction.delta": () => Effect.void,
      // 失败压缩不替换上下文，使用量 projector 结算而不制造摘要。
      "session.next.compaction.failed": () => Effect.void,
      "session.next.compaction.ended": (event) => {
        return adapter.appendMessage(
          SessionMessage.Compaction.make({
            id: event.data.messageID,
            type: "compaction",
            metadata: event.metadata,
            reason: event.data.reason,
            summary: event.data.text,
            recent: event.data.recent,
            // 持久投影传递原事件字段，进程重放不能从当前历史重新构造memento。
            recent_user_messages: event.data.recent_user_messages,
            file_evidence: event.data.file_evidence,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.revert.staged": () => Effect.void,
      "session.next.revert.cleared": () => Effect.void,
      "session.next.revert.committed": () => Effect.void,
    })
  })
}

export * as SessionMessageUpdater from "./message-updater"
