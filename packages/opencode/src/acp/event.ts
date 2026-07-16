import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type {
  Event,
  EventMessagePartDelta,
  EventMessagePartProgress,
  EventMessagePartUpdated,
  OpencodeClient,
  Part,
  SessionMessageResponse,
  ToolPart,
} from "@opencode-ai/sdk/v2"
import { Hash } from "@opencode-ai/core/util/hash"
import { Effect } from "effect"
import { ACPSession } from "./session"
import { ACPPermission } from "./permission"
import { partsToContentChunks, type ReplayPart } from "./content"
import {
  duplicateRunningToolUpdate,
  errorToolUpdate,
  pendingToolCall,
  runningToolUpdate,
  shellOutputSnapshot,
  completedToolUpdate,
} from "./tool"

type Connection = Pick<AgentSideConnection, "sessionUpdate"> &
  Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile">>
type GlobalEventEnvelope = {
  payload?: Event
}
type GlobalEventStream = {
  stream: AsyncIterable<GlobalEventEnvelope>
}

export function start(input: { sdk: OpencodeClient; connection: Connection; session: ACPSession.Interface }) {
  const subscription = new Subscription(input)
  subscription.start()
  return subscription
}

export class Subscription {
  private readonly abort = new AbortController()
  // marker 按 Session+call 保留展示版本和终态，避免不同 Session 的 provider callID 互相污染。
  // 终态不能按短 timeout 驱逐，否则迟到的独立 transport 会重新打开 lifecycle。
  private readonly shellSnapshots = new Map<string, { hash?: string; version: number; terminal?: true }>()
  private readonly toolStarts = new Set<string>()
  private readonly connectionWaiters = new Set<() => void>()
  private readonly idleWaiters = new Map<string, Set<ReturnType<typeof signal>>>()
  private readonly permission: ACPPermission.Handler
  private connected = false
  private started = false

  constructor(
    private readonly input: {
      sdk: OpencodeClient
      connection: Connection
      session: ACPSession.Interface
    },
  ) {
    this.permission = new ACPPermission.Handler(input)
  }

  start() {
    if (this.started) return
    this.started = true
    this.run().catch(() => {
      if (this.abort.signal.aborted) return
    })
  }

  stop() {
    this.abort.abort()
    this.disconnected()
    for (const resolve of this.connectionWaiters) resolve()
    this.connectionWaiters.clear()
  }

  async runUntilIdle<A>(sessionId: string, request: () => Promise<A>) {
    await this.waitUntilConnected()
    const waiter = signal()
    const waiters = this.idleWaiters.get(sessionId) ?? new Set()
    waiters.add(waiter)
    this.idleWaiters.set(sessionId, waiters)

    try {
      // Idle is queued after the turn's events, and this subscription awaits each update in order.
      void waiter.promise.catch(() => {})
      const response = await request()
      await waiter.promise
      return response
    } finally {
      waiters.delete(waiter)
      if (waiters.size === 0) this.idleWaiters.delete(sessionId)
    }
  }

  async handle(event: Event) {
    switch (event.type) {
      case "session.status":
        if (event.properties.status.type === "idle") this.idle(event.properties.sessionID)
        return
      case "permission.asked":
        this.permission.handle(event)
        return
      case "message.part.updated":
      // live 与 durable snapshot 共享一个 ACP Tool lifecycle；progress 只增加
      // in_progress 帧，completed/error 仍由 ordered PartUpdated 决定。
      case "message.part.progress":
        return this.handlePartUpdated(event)
      case "message.part.delta":
        return this.handlePartDelta(event)
    }
  }

  async replayMessage(message: SessionMessageResponse) {
    if (message.info.role !== "assistant" && message.info.role !== "user") return

    const cwd = message.info.role === "assistant" ? message.info.path?.cwd : undefined
    for (const part of message.parts) {
      await this.recordFetchedPart(message.info.sessionID, message, part)
      if (part.type === "tool") {
        await this.handleToolPart(message.info.sessionID, part, cwd ?? process.cwd())
        continue
      }
      await this.replayContentPart(message, part)
    }
  }

  private async replayContentPart(message: SessionMessageResponse, part: Part) {
    if (part.type !== "text" && part.type !== "file" && part.type !== "reasoning") return

    const sessionUpdate =
      part.type === "reasoning"
        ? "agent_thought_chunk"
        : message.info.role === "user"
          ? "user_message_chunk"
          : "agent_message_chunk"

    for (const chunk of partsToContentChunks([part as ReplayPart])) {
      await this.input.connection.sessionUpdate({
        sessionId: message.info.sessionID,
        update: {
          sessionUpdate,
          messageId: part.type === "reasoning" ? part.id : message.info.id,
          ...chunk,
        },
      })
    }
  }

  private async run() {
    while (!this.abort.signal.aborted) {
      await this.consume().catch(() => {})
      this.disconnected()
      if (!this.abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  private async consume() {
    const events = (await this.input.sdk.global.event({
      signal: this.abort.signal,
    })) as GlobalEventStream
    this.connected = true
    for (const resolve of this.connectionWaiters) resolve()
    this.connectionWaiters.clear()

    for await (const event of events.stream) {
      if (this.abort.signal.aborted) return
      if (!event.payload) continue
      await this.handle(event.payload).catch(() => {})
    }
  }

  private async waitUntilConnected() {
    while (!this.connected) {
      if (this.abort.signal.aborted) throw new Error("ACP event subscription stopped")
      await new Promise<void>((resolve) => this.connectionWaiters.add(resolve))
    }
  }

  private disconnected() {
    if (!this.connected) return
    this.connected = false
    const error = new Error("ACP event stream disconnected")
    for (const waiters of this.idleWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error)
    }
    this.idleWaiters.clear()
  }

  private idle(sessionId: string) {
    const waiters = this.idleWaiters.get(sessionId)
    if (!waiters) return
    this.idleWaiters.delete(sessionId)
    for (const waiter of waiters) waiter.resolve()
  }

  private async handlePartUpdated(event: EventMessagePartUpdated | EventMessagePartProgress) {
    const part = event.properties.part
    const sessionId = part.sessionID || event.properties.sessionID
    const session = await Effect.runPromise(this.input.session.tryGet(sessionId))
    if (!session) return

    // progress 是纯展示快照：只推进 Tool lifecycle，不重复持久化元数据记录。
    if (event.type === "message.part.updated") {
      await Effect.runPromise(
        this.input.session.recordPartMetadata({
          sessionId: session.id,
          messageId: part.messageID,
          partId: part.id,
          partType: part.type,
          role: part.type === "reasoning" ? "assistant" : undefined,
          ignored: part.type === "text" ? part.ignored : undefined,
          toolCallId: part.type === "tool" ? part.callID : undefined,
          metadata: "metadata" in part ? part.metadata : undefined,
        }),
      )
    }
    if (part.type === "tool") {
      await this.handleToolPart(session.id, part, session.cwd)
    }
  }

  private async handlePartDelta(event: EventMessagePartDelta) {
    const props = event.properties
    const session = await Effect.runPromise(this.input.session.tryGet(props.sessionID))
    if (!session) return

    const known = await Effect.runPromise(
      this.input.session.tryGetPartMetadata({
        sessionId: session.id,
        messageId: props.messageID,
        partId: props.partID,
      }),
    )
    const metadata =
      known?.role && known.partType
        ? known
        : await this.fetchPartMetadata(session.id, session.cwd, props.messageID, props.partID)
    if (metadata?.role !== "assistant") return
    if (metadata.partType === "text" && props.field === "text" && metadata.ignored !== true) {
      await this.input.connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: props.messageID,
          content: {
            type: "text",
            text: props.delta,
          },
        },
      })
      return
    }

    if (metadata.partType === "reasoning" && props.field === "text") {
      await this.input.connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: props.partID,
          content: {
            type: "text",
            text: props.delta,
          },
        },
      })
    }
  }

  private async fetchPartMetadata(sessionId: string, cwd: string, messageId: string, partId: string) {
    const message = await this.input.sdk.session
      .message(
        {
          sessionID: sessionId,
          messageID: messageId,
          directory: cwd,
        },
        { throwOnError: true },
      )
      .then((response) => response.data)
      .catch(() => undefined)
    if (!message) return

    const part = message.parts.find((item) => item.id === partId)
    if (!part) return
    return await this.recordFetchedPart(sessionId, message, part)
  }

  private async recordFetchedPart(sessionId: string, message: SessionMessageResponse, part: Part) {
    return await Effect.runPromise(
      this.input.session.recordPartMetadata({
        sessionId,
        messageId: part.messageID,
        partId: part.id,
        partType: part.type,
        role: message.info.role,
        ignored: part.type === "text" ? part.ignored : undefined,
        toolCallId: part.type === "tool" ? part.callID : undefined,
        metadata: "metadata" in part ? part.metadata : undefined,
      }),
    )
  }

  private async handleToolPart(sessionId: string, part: ToolPart, cwd: string) {
    await this.toolStart(sessionId, part, cwd)

    switch (part.state.status) {
      case "pending":
        // terminal marker 不被 synthetic pending 清除：迟到的独立 transport
        // 重新握手时不能把已完成的 Tool 重新打开成执行中。
        if (!this.shellSnapshots.get(this.callKey(sessionId, part.callID))?.terminal)
          this.shellSnapshots.delete(this.callKey(sessionId, part.callID))
        return

      case "running":
        await this.runningTool(sessionId, part, cwd)
        return

      case "completed":
        this.closeToolCall(sessionId, part)
        await this.input.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            ...completedToolUpdate({
              toolCallId: part.callID,
              toolName: part.tool,
              state: part.state,
              cwd,
            }),
          },
        })
        return

      case "error":
        this.closeToolCall(sessionId, part)
        await this.input.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            ...errorToolUpdate({
              toolCallId: part.callID,
              toolName: part.tool,
              state: part.state,
              cwd,
            }),
          },
        })
        return
    }
  }

  private async runningTool(sessionId: string, part: ToolPart, cwd: string) {
    if (part.state.status !== "running") return

    const isShell = part.tool === "bash"
    const key = this.callKey(sessionId, part.callID)
    const marker = this.shellSnapshots.get(key)
    const progressVersion = this.shellProgressVersion(part)
    const output = isShell ? shellOutputSnapshot(part.state) : undefined
    if (isShell) {
      // live 与 durable 可独立到达；只接受更高 running version，避免旧 checkpoint 回退展示。
      // running 用 version 排序，terminal 则无条件支配，二者不能共享数值哨兵语义。
      if (marker && (marker.terminal || progressVersion <= marker.version)) return
      const hash = output === undefined ? undefined : Hash.fast(output)
      this.shellSnapshots.set(key, { hash, version: progressVersion })
      // 接受新版本后 hash 未变：发 duplicate 帧，不发重复 content。
      if (output !== undefined && marker?.hash === hash) {
        await this.input.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            ...duplicateRunningToolUpdate({
              toolCallId: part.callID,
              toolName: part.tool,
              state: part.state,
              cwd,
            }),
          },
        })
        return
      }
    }

    await this.input.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        ...runningToolUpdate({
          toolCallId: part.callID,
          toolName: part.tool,
          state: part.state,
          output,
          cwd,
        }),
      },
    })
  }

  private async toolStart(sessionId: string, part: ToolPart, cwd: string) {
    const key = this.callKey(sessionId, part.callID)
    // terminal marker 必须在任何 synthetic pending 之前生效，否则拒绝 running 时已经重新打开 lifecycle。
    if (part.tool === "bash" && this.shellSnapshots.get(key)?.terminal) return
    if (this.toolStarts.has(key)) return
    this.toolStarts.add(key)
    await this.input.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        ...pendingToolCall({
          toolCallId: part.callID,
          toolName: part.tool,
          state: part.state,
          cwd,
        }),
      },
    })
  }

  // completed/error 只清 toolStart；shell marker 转为 terminal，
  // 压过任何迟到的独立 transport running 快照。
  private closeToolCall(sessionId: string, part: ToolPart) {
    this.toolStarts.delete(this.callKey(sessionId, part.callID))
    const key = this.callKey(sessionId, part.callID)
    if (part.tool !== "bash") {
      this.shellSnapshots.delete(key)
      return
    }
    // version 只排序 running；terminal flag 跨 transport 无条件压过任何 late running。
    // terminal 的 version=0 不参与比较，避免为终态制造第二套递增版本来源。
    this.shellSnapshots.set(key, { version: 0, terminal: true })
  }

  // 0443 source 语义：close_session 时按 Session 前缀清理 lifecycle marker——
  // 订阅为连接级而非会话级，长寿命连接上 marker 随每次调用单调累积（内存泄漏）。
  clearSessionMarkers(sessionID: string) {
    const prefix = `${sessionID}\0`
    for (const key of this.shellSnapshots.keys()) if (key.startsWith(prefix)) this.shellSnapshots.delete(key)
    for (const key of this.toolStarts) if (key.startsWith(prefix)) this.toolStarts.delete(key)
  }

  private callKey(sessionID: string, callID: string) {
    return `${sessionID}\0${callID}`
  }

  private shellProgressVersion(part: ToolPart) {
    const raw = part.state.status === "running" ? part.state.metadata?.progressVersion : undefined
    // 旧持久化 Part 允许缺失或非法 version；归一化为 0 才能兼容首次恢复且拒绝后续回退。
    return typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw) && raw >= 0 ? raw : 0
  }
}

function signal() {
  const state: {
    resolve: () => void
    reject: (reason?: unknown) => void
  } = {
    resolve: () => {},
    reject: () => {},
  }
  const promise = new Promise<void>((resolve, reject) => {
    state.resolve = resolve
    state.reject = reject
  })
  return {
    promise,
    resolve: () => state.resolve(),
    reject: (reason?: unknown) => state.reject(reason),
  }
}

export * as ACPEvent from "./event"
