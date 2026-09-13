import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  EventMessagePartDelta,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "@tui/context/project"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@opencode-ai/core/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, createEffect, onCleanup, onMount } from "solid-js"
import * as Log from "@opencode-ai/core/util/log"
import { emptyConsoleState, type ConsoleState } from "@/config/console-state"
import { useKV } from "./kv"
import { useRoute } from "./route"
// [local-smark] SessionPath for daemon multi-instance path management
import { SessionPath } from "@/session/path"
import { PartView } from "@/session/part-view"
import { SESSION_LIST_BROWSE_LIMIT, SESSION_LIST_LOOKBACK_MS } from "@tui/util/session-list-params"
import { aggregateFailures } from "./aggregate-failures"
import { logPartDeltaTiming, partDeltaTimingKey, PART_DELTA_TIMING_LIMIT } from "./stream-timing"
import { DisposedReason } from "@/server/event"

// 同一私有 viewer 信号收窄 Message 与 diff；默认 SDK/Web App 请求不带它，完整合同不变。
// 该常量只属于 TUI transport，不进入 OpenAPI query 或 generated SDK，避免把内部投影固化成公共 API。
const TUI_VIEWER_HEADER = "x-opencode-tui-message-projection"
const TUI_VIEWER = "viewer"
// 100 是所有 TUI Session 共用的结果上限，不根据 Session 大小、耗时或内存走不同生产路径。
// Files 保持默认展开；上限直接约束网络对象、store 项和 Renderable 基数，而不是延迟同一份无界工作。
const TUI_DIFF_LIMIT = 100
// 总量放在私有 response headers，body 继续满足既有 FileDiff[] schema，不引入 sentinel 或 wrapper。
// legacy Session 即使缺少 hot summary，也能从本次 authoritative diff 获得精确总量而无需第二数据源。
const TUI_DIFF_TOTAL_FILES = "x-opencode-tui-total-files"
const TUI_DIFF_TOTAL_ADDITIONS = "x-opencode-tui-total-additions"
const TUI_DIFF_TOTAL_DELETIONS = "x-opencode-tui-total-deletions"

function searchMessage(messages: readonly Message[], target: Message) {
  let left = 0
  let right = messages.length
  // TUI snapshot 的权威顺序是持久创建时间；同毫秒 ID 必须复刻 SQLite BINARY 的 UTF-8 byte order。
  // locale/UTF-16 顺序都无法覆盖合法 caller ID；lower-bound 仍让三个生命周期分支共享 O(log n) 语义。
  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    const current = messages[middle]
    const order = current.time.created - target.time.created || Buffer.compare(Buffer.from(current.id), Buffer.from(target.id))
    if (order < 0) left = middle + 1
    else right = middle
  }
  return { found: messages[left]?.id === target.id, index: left }
}

function projectTuiDiff(diffs: readonly Snapshot.FileDiff[]) {
  // SSE 仍携带共享完整事件；TUI reducer 是不破坏 share consumer 的首个可收窄 owner。
  // HTTP body 已由 daemon 截断，但再次应用同一投影可保证测试 transport 和未来 caller 都不能灌回 patch。
  // 与 plugin adapter 共用 file 可见性口径；必须在 totals/cap 前过滤，legacy 项不能占用100行预算。
  const displayable = diffs.filter((item) => item.file !== undefined)
  return {
    items: displayable.slice(0, TUI_DIFF_LIMIT).map((item) => {
      const { patch: _, ...stats } = item
      return stats
    }),
    summary: {
      files: displayable.length,
      additions: displayable.reduce((total, item) => total + item.additions, 0),
      deletions: displayable.reduce((total, item) => total + item.deletions, 0),
    },
  }
}

// [local-smark] goal 类型定义（SDK 未重新生成前使用内联类型）
// 字段与 src/session/goal.ts 的 Goal schema 对齐
type SessionGoalInfo = {
  sessionID: string
  id: string
  objective: string
  status: "active" | "paused" | "complete" | "blocked"
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  // [local-smark] 错误后续跑策略：用户通过 GUI 控制，跨重启持久化
  continueOnError: boolean
  // objective 代际：仅 trimmed objective 真正改变时递增
  generation: number
  // terminal 状态理由；active/paused 为 null
  reason: string | null
  time: { created: number; updated: number }
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
      // [local-smark] goal 状态：每个 session 最多一个 goal
      session_goal: {
        [sessionID: string]: SessionGoalInfo | undefined
      }
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
      // [local-smark] goal 初始为空
      session_goal: {},
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    const kv = useKV()
    const route = useRoute()

    const fullSyncedSessions = new Set<string>()
    // [正文消费计数] 只有当前 route、可见 Task 卡片与显式插件 acquisition 持有 Session 正文使用权。
    // 最后一个消费者离开时立即释放已持久终态正文；fullSyncedSessions 只是加载成功标记，不代表仍有人使用。
    const partConsumers = new Map<string, number>()
    // 已释放终态 Part 的 ID 事实：拒绝迟到的 progress/delta 在无消费者 Session 上重建正文。
    // 按 Session→Message→PartID 嵌套归属：被释放的 Part 已不在 store，窗口淘汰/删除边界
    // 不能靠 store 反查 ID，必须持有自有轻量归属关系；随淘汰、删除与 Provider cleanup 释放。
    const releasedTerminalParts = new Map<string, Map<string, Set<string>>>()
    // remove event 只有 ID，且公开 caller 可提供非单调 ID；索引保存已有 Message 的 chronology key。
    // Map 只引用 bounded store 中的对象，不复制正文，也不引入 ID 排序或失败后的扫描路径。
    const messageByID = new Map<string, Map<string, Message>>()
    const indexMessage = (message: Message) => {
      // update 只替换同 ID 的最新完整 Info；生产者保证 time.created 是不可变的持久创建时间。
      // event-first 与 snapshot 两种入口共用此索引形状，remove 不需要判断 Message 来自哪条 transport。
      const index = messageByID.get(message.sessionID)
      if (index) return index.set(message.id, message)
      messageByID.set(message.sessionID, new Map([[message.id, message]]))
    }
    const unindexMessage = (message: Message) => messageByID.get(message.sessionID)?.delete(message.id)
    // [local-smark] daemon multi-instance workspace tracking
    let syncedWorkspace = project.workspace.current()
    let connectedOnce = false
    // [重连快照版本] 这些计数只描述 TUI 本地 store，不是 daemon 版本号；
    // 用来让重连快照清理 stale blocker，同时保留 list 发出后到达的 SSE 变更。
    let permissionVersion = 0
    let questionVersion = 0
    let permissionRefreshes = 0
    let questionRefreshes = 0
    let permissionRefreshVersion = 0
    let questionRefreshVersion = 0
    let lspRefreshVersion = 0
    let lspRoute: string | undefined
    const permissionChanges = new Map<string, { sessionID: string; requestID: string; version: number }>()
    const questionChanges = new Map<string, { sessionID: string; requestID: string; version: number }>()
    let pendingPartDeltas: EventMessagePartDelta[] = []
    let pendingPartDeltaTimer: Timer | undefined
    const loggedPartDeltaApplications = new Set<string>()
    // 缓冲因本地 part 尚未加载而被 drop 的 delta，按 partID 索引。
    // 进入已在 streaming 的 Session 或并发 HTTP sync 时，本地 store 可能尚无
    // 对应 part；delta 是 bus-only，若直接 drop 就无法从 SQLite replay。
    // delta 是 bus-only（不写 DB），被 drop 后永久丢失——子会话进入前
    // 已生成的流式文本将无法恢复。缓冲后在 part.updated 创建 part 时 replay。
    const orphanPartDeltas = new Map<string, EventMessagePartDelta[]>()

    // [失效事实] 持久删除/hidden 只记录 ID，不保存 payload；300 窗口淘汰不进入这些集合，
    // 允许后续 sync 重新加载。迟到事件与旧 HTTP 快照统一经 admission 检查拒绝复活。
    const deletedSessionIDs = new Set<string>()
    const removedMessageIDs = new Set<string>()
    const removedPartIDs = new Set<string>()
    // 每 Session 只有最新 sync 请求可提交；删除或更新的 force 请求使在途旧请求失效。
    let syncRequestSeq = 0
    const syncRequests = new Map<string, number>()
    // 同 Session 的 sync 请求串行排队：并发取代会让被取代请求“成功返回但没有提交”，
    // acquireParts 会把空 store 误当正文就绪。排队后每个 await sync 对应真实执行；跨 Session 仍并行。
    const syncChains = new Map<string, Promise<void>>()
    // 请求期间只登记变化 ID（不复制正文）；提交时并入最终投影，HTTP 页不能抹掉 live 流式。
    const syncChanges = new Map<string, { messages: Set<string>; parts: Set<string> }>()

    function messageGone(sessionID: string, messageID: string) {
      return deletedSessionIDs.has(sessionID) || removedMessageIDs.has(messageID)
    }

    function partGone(sessionID: string, messageID: string, partID: string) {
      return messageGone(sessionID, messageID) || removedPartIDs.has(partID)
    }

    function trackSyncChange(sessionID: string, messageID?: string, partID?: string) {
      const changes = syncChanges.get(sessionID)
      if (!changes) return
      if (messageID) changes.messages.add(messageID)
      if (partID) changes.parts.add(partID)
    }

    function dropBufferedDeltas(match: (event: EventMessagePartDelta) => boolean) {
      pendingPartDeltas = pendingPartDeltas.filter((event) => !match(event))
      for (const [partID, deltas] of orphanPartDeltas) {
        if (deltas[0] && match(deltas[0])) orphanPartDeltas.delete(partID)
      }
    }

    // 释放不依赖父数组存在：part-first 对象与 orphan delta 同样属于该 Message。
    function releaseMessage(sessionID: string, messageID: string, info?: Message) {
      dropBufferedDeltas((event) => event.properties.sessionID === sessionID && event.properties.messageID === messageID)
      // chronology key 优先取索引（event-first 与 snapshot 同一形状）；索引未登记时退回事件 info，
      // 两条入口共用 searchMessage 的 BINARY 语义，不引入第三条定位路径。
      const target = messageByID.get(sessionID)?.get(messageID) ?? info
      // Message 删除边界忘掉其 Part 的终态 ID 事实，重建后能正常准入。
      releasedTerminalParts.get(sessionID)?.delete(messageID)
      const messages = store.message[sessionID]
      batch(() => {
        if (messages && target) {
          const result = searchMessage(messages, target)
          if (result.found)
            setStore(
              "message",
              sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
        }
        messageByID.get(sessionID)?.delete(messageID)
        if (store.part[messageID])
          setStore(
            "part",
            produce((draft) => {
              delete draft[messageID]
            }),
          )
      })
    }

    // 终态判定：tool 的 completed/error 是持久终值；其余 Part 以父 Message 完成态为准
    //（user 写完即持久，assistant 以 time.completed 为准）。未完成的流式 Part 保持现状——
    // 其 bus-only 内容不可从 DB 恢复，不能释放。
    function isDurableTerminal(part: Part, completedMessages: Set<string>) {
      if (part.type === "tool") return part.state.status === "completed" || part.state.status === "error"
      return completedMessages.has(part.messageID)
    }

    // 事件准入时的父 Message 完成态查询：优先索引，event-first 次序下退回 bounded store 查找。
    function isTerminalAdmission(part: Part) {
      if (part.type === "tool") return part.state.status === "completed" || part.state.status === "error"
      const match =
        messageByID.get(part.sessionID)?.get(part.messageID) ??
        store.message[part.sessionID]?.find((message) => message.id === part.messageID)
      if (!match) return false
      return match.role !== "assistant" || match.time.completed !== undefined
    }

    // 释放单个终态 Part：记录 ID 事实、清掉其缓冲 delta、从 store 移除。
    // 正文终值已持久在 DB，重新进入时由 HTTP sync 恢复。
    function releasePart(sessionID: string, part: Part) {
      let byMessage = releasedTerminalParts.get(sessionID)
      if (!byMessage) {
        byMessage = new Map()
        releasedTerminalParts.set(sessionID, byMessage)
      }
      let ids = byMessage.get(part.messageID)
      if (!ids) {
        ids = new Set()
        byMessage.set(part.messageID, ids)
      }
      ids.add(part.id)
      dropBufferedDeltas((event) => event.properties.sessionID === sessionID && event.properties.partID === part.id)
      const parts = store.part[part.messageID]
      if (!parts) return
      const foundAt = Binary.search(parts, part.id, (p) => p.id)
      if (!foundAt.found) return
      setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(foundAt.index, 1)
        }),
      )
      if ((store.part[part.messageID] ?? []).length === 0) {
        setStore(
          "part",
          produce((draft) => {
            delete draft[part.messageID]
          }),
        )
      }
    }

    // 最后一个消费者离开时释放该 Session 的全部已持久终态正文；Message metadata、状态、
    // 权限与问题桶保留（它们轻量且 sidebar/status 仍需要）。
    function releaseSessionParts(sessionID: string) {
      fullSyncedSessions.delete(sessionID)
      const completed = new Set(
        (store.message[sessionID] ?? [])
          .filter((message) => message.role !== "assistant" || message.time.completed !== undefined)
          .map((message) => message.id),
      )
      const doomed = Object.values(store.part)
        .flat()
        .filter((part) => part.sessionID === sessionID && isDurableTerminal(part, completed))
      batch(() => {
        for (const part of doomed) releasePart(sessionID, part)
      })
    }

    function acquireParts(sessionID: string) {
      partConsumers.set(sessionID, (partConsumers.get(sessionID) ?? 0) + 1)
    }

    function releaseParts(sessionID: string) {
      const count = partConsumers.get(sessionID) ?? 0
      if (count > 1) {
        partConsumers.set(sessionID, count - 1)
        return
      }
      if (count === 0) return
      partConsumers.delete(sessionID)
      // 撤销在途 sync 的提交资格：迟到响应不能把刚释放的正文写回；另一消费者的请求由新 token 保护。
      syncRequests.delete(sessionID)
      releaseSessionParts(sessionID)
    }

    // Session 删除是显式边界：这里才允许按 sessionID 归属扫描全量 Part，正常 delta 路径保持 O(1)。
    function releaseSession(sessionID: string) {
      syncRequests.delete(sessionID)
      syncChanges.delete(sessionID)
      fullSyncedSessions.delete(sessionID)
      partConsumers.delete(sessionID)
      messageByID.delete(sessionID)
      dropBufferedDeltas((event) => event.properties.sessionID === sessionID)
      // 删除边界同时忘掉终态 ID 事实：同一 Session 重建后新 Part 需要能正常准入。
      releasedTerminalParts.delete(sessionID)
      batch(() => {
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, sessionID, (item) => item.id)
            if (match.found) draft.session.splice(match.index, 1)
            delete draft.message[sessionID]
            delete draft.todo[sessionID]
            delete draft.session_diff[sessionID]
            delete draft.session_status[sessionID]
            delete draft.permission[sessionID]
            delete draft.question[sessionID]
            for (const key of Object.keys(draft.part)) {
              if (draft.part[key]?.[0]?.sessionID === sessionID) delete draft.part[key]
            }
          }),
        )
        setStore("session_goal", sessionID, undefined)
      })
    }

    function clearLsp(owner?: string) {
      lspRoute = owner
      setStore("lsp", reconcile([]))
    }

    async function refreshLsp() {
      const version = ++lspRefreshVersion
      const current = route.data
      if (current.type !== "session") return clearLsp()
      const match = Binary.search(store.session, current.sessionID, (session) => session.id)
      if (!match.found) return clearLsp(current.sessionID)
      const session = store.session[match.index]
      const owner = `${current.sessionID}\0${session.directory}\0${session.workspaceID ?? ""}`
      // snapshot owner 在请求前切换；同步清空才能保证 B 的网络请求挂起或失败时，
      // sidebar/footer 也绝不会继续渲染已经属于 A 的 rows。
      if (lspRoute !== owner) clearLsp(owner)
      const response = await sdk.client.lsp.status({ directory: session.directory, workspace: session.workspaceID })
      // route A 的请求可能在切到 B 后才返回；只有最新 token 能提交，
      // 否则一次网络乱序就会把 B 的右侧列表重新污染成 A。
      if (version !== lspRefreshVersion) return
      setStore("lsp", reconcile((response.data ?? []).filter((item) => item.sessionIDs?.includes(current.sessionID))))
    }

    // route 与 Session snapshot 都是 reactive 输入。Session 列表在 bootstrap 后到达时，
    // 当前 route 会自动补做一次正确目录/Workspace 的 LSP 请求。
    createEffect(() => void refreshLsp())

    // 当前 route 持有其 Session 的正文使用权；离开即释放，后台完成事件不再把正文补进 store。
    let routeParts: string | undefined
    createEffect(() => {
      const current = route.data
      const next = current.type === "session" ? current.sessionID : undefined
      if (next === routeParts) return
      if (routeParts !== undefined) releaseParts(routeParts)
      routeParts = next
      if (next !== undefined) acquireParts(next)
    })

    function targetsSamePartDelta(previous: EventMessagePartDelta, next: EventMessagePartDelta) {
      // Only adjacent deltas for the same Solid store cell are safe to merge.
      // The public SDK/useEvent stream still receives every event individually;
      // this coalescing happens after routing, inside SyncProvider's private
      // store reducer, so plugins and non-rendering consumers keep raw event
      // count/id semantics while the TUI avoids per-fragment reactive churn.
      return (
        previous.properties.sessionID === next.properties.sessionID &&
        previous.properties.messageID === next.properties.messageID &&
        previous.properties.partID === next.properties.partID &&
        previous.properties.field === next.properties.field
      )
    }

    function coalescePartDeltas(events: readonly EventMessagePartDelta[]) {
      const result: EventMessagePartDelta[] = []
      for (const event of events) {
        const previous = result.at(-1)
        if (!previous || !targetsSamePartDelta(previous, event)) {
          result.push(event)
          continue
        }
        // Preserve the first event id because the merged item occupies that
        // original store-update slot; only the text payload changes.  Later
        // boundaries such as part.updated still force a flush before they run.
        result[result.length - 1] = {
          ...previous,
          properties: {
            ...previous.properties,
            delta: previous.properties.delta + event.properties.delta,
          },
        }
      }
      return result
    }

    function logPartDeltaApplication(event: EventMessagePartDelta, phase: "delta.apply" | "delta.drop", reason?: string) {
      const key = `${phase}\0${partDeltaTimingKey(event.properties)}`
      if (loggedPartDeltaApplications.has(key)) return
      // apply/drop 阶段表示 “SyncProvider reducer 已处理 delta”。drop 只说明
      // 当时本地 store 缺 message/part，不代表 daemon 没发；这些 reason 字符串
      // 必须保持短且稳定，方便和 receive 阶段在 daemon log 中对齐。
      // key 前缀包含 phase，保证同一 part 先 drop 后恢复 apply 时两段都会出现。
      if (loggedPartDeltaApplications.size >= PART_DELTA_TIMING_LIMIT) loggedPartDeltaApplications.clear()
      loggedPartDeltaApplications.add(key)
      logPartDeltaTiming({ client: sdk.client, phase, reason, ...event.properties })
    }

    function applyPartDelta(event: EventMessagePartDelta) {
      if (partGone(event.properties.sessionID, event.properties.messageID, event.properties.partID)) {
        // 失效对象的 delta 不再缓冲：缓冲即留存，part.updated 到达时会被同一 admission 拒绝。
        logPartDeltaApplication(event, "delta.drop", "invalidated")
        return
      }
      const parts = store.part[event.properties.messageID]
      if (!parts) {
        // part 尚未到达（fire-and-forget 竞态）：缓冲 delta，等 part.updated 创建 part 后 replay
        const buffered = orphanPartDeltas.get(event.properties.partID)
        if (buffered) buffered.push(event)
        else orphanPartDeltas.set(event.properties.partID, [event])
        logPartDeltaApplication(event, "delta.drop", "missing-message")
        return
      }
      const result = Binary.search(parts, event.properties.partID, (p) => p.id)
      if (!result.found) {
        // part 在数组中不存在（part.updated 尚未到达）：同样缓冲
        const buffered = orphanPartDeltas.get(event.properties.partID)
        if (buffered) buffered.push(event)
        else orphanPartDeltas.set(event.properties.partID, [event])
        logPartDeltaApplication(event, "delta.drop", "missing-part")
        return
      }
      setStore(
        "part",
        event.properties.messageID,
        produce((draft) => {
          const part = draft[result.index]
          if (part.type === "tool" && part.state.status === "pending" && event.properties.field === "raw") {
            part.state.raw += event.properties.delta
            return
          }
          const field = event.properties.field as keyof typeof part
          const existing = part[field] as string | undefined
          ;(part[field] as string) = (existing ?? "") + event.properties.delta
        }),
      )
      logPartDeltaApplication(event, "delta.apply")
    }

    // 当 part.updated 终于到达并创建 part 后，replay 之前因 part 缺失而缓冲的 delta。
    // 合并同一 partID 的连续 delta 以减少 reactive 更新次数，然后逐条 apply。
    // replay 后清除缓冲，避免终态 part.updated 再次触发时重复应用。
    // 终态 part（time.end 存在）不 replay：其文本是权威完整的，追加 delta 会污染。
    function replayOrphanDeltas(partID: string, messageID: string) {
      const buffered = orphanPartDeltas.get(partID)
      if (!buffered || buffered.length === 0) return
      // 检查 store 中的 part 是否已终态（text-end 的 DB 快照携带完整文本）
      const parts = store.part[messageID]
      if (parts) {
        const found = Binary.search(parts, partID, (p) => p.id)
        if (found.found) {
          const part = parts[found.index]
          if ((part.type === "text" || part.type === "reasoning") && part.time?.end) {
            orphanPartDeltas.delete(partID)
            return
          }
        }
      }
      const coalesced = coalescePartDeltas(buffered)
      // 仅应用 messageID 匹配的 delta（partID 全局唯一，此处防御未来可能的碰撞）
      const matched = coalesced.filter((event) => event.properties.messageID === messageID)
      if (matched.length === 0) return
      // 匹配后才删除缓冲，未匹配的保留以防 partID 碰撞时另一 message 仍需 replay
      orphanPartDeltas.delete(partID)
      for (const event of matched) {
        applyPartDelta(event)
      }
    }

    // 单调合并守卫：防止 pending 阶段或 HTTP sync 的短快照覆盖本地长流式文本。
    // 当 Session 首次加载、切换或 reconnect 时，HTTP snapshot 与 live BusEvent
    // 可以独立到达；不带 time.end 的短文本不能回退本地已拼接内容。
    // 不带 time.end 的短文本不应回退本地已通过 delta 拼接的长文本。
    // 终态（time.end 存在）始终接受权威最终值，包括 plugin 修改后的文本。
    // equal-v0 字段补全：只合并 input/autoReview/title，不把 next.output 当更新的进度。
    // 这是进度合同之外的生命周期 enrich，不是把 progress 比较改成 >=。
    // reviewing 窗内 shell 尚未 bump progressVersion，equal-v0 很常见。
    function enrichEqualVersionBashRunning(existing: Part, next: Part): Part {
      if (existing.type !== "tool" || next.type !== "tool") return existing
      if (existing.state.status !== "running" || next.state.status !== "running") return existing
      const existingInput =
        existing.state.input && typeof existing.state.input === "object" && !Array.isArray(existing.state.input)
          ? (existing.state.input as Record<string, unknown>)
          : {}
      const nextInput =
        next.state.input && typeof next.state.input === "object" && !Array.isArray(next.state.input)
          ? (next.state.input as Record<string, unknown>)
          : {}
      // raw-only → structured 单向：有 command 后不得再被 raw 快照盖回。
      // 已有 structured 时保留 existing.input，防止后到的残缺快照回退 command。
      const existingKeys = Object.keys(existingInput)
      const existingRawOnly =
        existingKeys.length === 1 && existingKeys[0] === "raw" && typeof existingInput.raw === "string"
      const nextStructured = Object.keys(nextInput).some((key) => key !== "raw")
      const input = existingRawOnly && nextStructured ? nextInput : existingInput
      const existingMeta =
        existing.state.metadata && typeof existing.state.metadata === "object" && !Array.isArray(existing.state.metadata)
          ? existing.state.metadata
          : {}
      const nextMeta =
        next.state.metadata && typeof next.state.metadata === "object" && !Array.isArray(next.state.metadata)
          ? next.state.metadata
          : {}
      // 保留 existingMeta 中的 output/progressVersion；只补 autoReview envelope。
      // time.start 保留先到 running 的开始时刻，避免审核写重置执行计时观感。
      return {
        ...existing,
        state: {
          ...existing.state,
          input,
          title: next.state.title ?? existing.state.title,
          metadata: {
            ...existingMeta,
            autoReview: nextMeta.autoReview ?? existingMeta.autoReview,
          },
          time: existing.state.time,
        },
      }
    }

    function mergeLivePart(existing: Part | undefined, next: Part) {
      if (!existing) return next
      if (next.type === "text") {
        if (existing.type !== "text") return next
        // 终态快照直接采纳——daemon 在 text-end 写入的 DB 值是权威完整文本
        if (next.time?.end) return next
        // pending 阶段：本地更长时保留本地文本，拒绝短快照回退
        if (existing.text.length <= next.text.length) return next
        return { ...next, text: existing.text }
      }
      if (next.type === "reasoning") {
        if (existing.type !== "reasoning") return next
        if (next.time?.end) return next
        if (existing.text.length <= next.text.length) return next
        return { ...next, text: existing.text }
      }
      if (next.type === "tool") {
        if (existing.type !== "tool") return next
        if (next.state.status === "completed" || next.state.status === "error") return next
        // terminal 是权威终态；独立到达的 HTTP running snapshot 无论版本如何
        // 都不能让同一 Tool Part 恢复为执行中。
        if (existing.state.status === "completed" || existing.state.status === "error") return existing
        if (
          next.tool === "bash" &&
          existing.tool === "bash" &&
          next.state.status === "running" &&
          existing.state.status === "running"
        ) {
          const version = (part: typeof next) => {
            const value = part.state.status === "running" ? part.state.metadata?.progressVersion : undefined
            // 旧 SQLite JSON、NaN、fraction 和负数都属于同一个 legacy v0；不回写
            // 数据库，升级后的 client 只在 store merge boundary 做兼容归一化。
            if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return 0
            return value
          }
          const nextVersion = version(next)
          const existingVersion = version(existing)
          if (nextVersion > existingVersion) return next
          if (nextVersion < existingVersion) return existing
          // equal-v0：进度不前进时仍允许 input/autoReview 生命周期字段一次补全，
          // 避免 reviewing 快照被更早的 raw-only 或无 envelope running 永久挡住。
          // 不得用 next 的 output/progress 回退 live 输出（不是 progress >=）。
          return enrichEqualVersionBashRunning(existing, next)
        }
        // tool 只在 pending 阶段保护 raw（delta 累积的参数 JSON）；
        // 非 shell running 状态仍保持既有 PartUpdated 语义。
        if (next.state.status !== "pending" || existing.state.status !== "pending") return next
        if (existing.state.raw.length <= next.state.raw.length) return next
        return { ...next, state: { ...next.state, raw: existing.state.raw } }
      }
      return next
    }

    // 批量合并：用于 session.sync HTTP 快照与本地 store 的 parts 合并。
    // 对每个快照 part 调用 mergeLivePart 与本地对应 part 做单调守卫。
    function mergeLiveParts(existing: readonly Part[] | undefined, next: readonly Part[]): Part[] {
      if (!existing) return next.slice()
      return next.map((part) => mergeLivePart(existing.find((item) => item.id === part.id), part))
    }

    function flushPartDeltas() {
      if (pendingPartDeltaTimer) {
        clearTimeout(pendingPartDeltaTimer)
        pendingPartDeltaTimer = undefined
      }
      if (pendingPartDeltas.length === 0) return
      const events = coalescePartDeltas(pendingPartDeltas)
      pendingPartDeltas = []
      batch(() => {
        for (const event of events) applyPartDelta(event)
      })
    }

    function enqueuePartDelta(event: EventMessagePartDelta) {
      // 到达时刻登记 sync 变更；flush 延迟 16ms，不能等 apply 才记录，否则 prune 先于登记。
      trackSyncChange(event.properties.sessionID, event.properties.messageID, event.properties.partID)
      pendingPartDeltas.push(event)
      if (pendingPartDeltaTimer) return
      // Match the SDK frame queue: a short 16ms window keeps streaming feedback
      // interactive while collapsing the tiny provider chunks that were forcing
      // tokenAccounting/context memos to recompute thousands of times per tool.
      pendingPartDeltaTimer = setTimeout(flushPartDeltas, 16)
    }

    function sessionListQuery(): { directory?: string; scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        directory: project.data.instance.path.directory,
        path: SessionPath.relative(project.data.instance.path.worktree, project.data.instance.path.directory),
      }
    }

    function listSessions() {
      return sdk.client.session
        .list({
          start: Date.now() - SESSION_LIST_LOOKBACK_MS,
          limit: SESSION_LIST_BROWSE_LIMIT,
          ...sessionListQuery(),
        })
        // 列表快照可能早于 session.deleted 发出；已删除行不能经旧响应回到 store。
        // 过滤/时间窗口造成的缺项不是删除事实，这里只排除显式删除过的 ID。
        .then((x) => (x.data ?? []).filter((session) => !deletedSessionIDs.has(session.id)).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    function pendingRequestsBySession<T extends { id: string; sessionID: string }>(requests: T[]) {
      // [快照建表] reconnect 会用 daemon list 整体替换 pending map；这里先排序，
      // 保持后续 permission/question asked/replied 增量更新依赖的二分查找不变量。
      return requests.toSorted((a, b) => a.id.localeCompare(b.id)).reduce<Record<string, T[]>>((result, request) => {
        ;(result[request.sessionID] ??= []).push(request)
        return result
      }, {})
    }

    function pendingRequestChangeKey(sessionID: string, requestID: string) {
      // [本地变更键] 只在内存里区分 session/request；不改变 SDK shape、持久化值或用户可见 id。
      return `${sessionID}\0${requestID}`
    }

    function pendingRequestsWithLiveChanges<T extends { id: string; sessionID: string }>(
      snapshot: Record<string, T[]>,
      current: Record<string, T[]>,
      changes: Map<string, { sessionID: string; requestID: string; version: number }>,
      since: number,
    ) {
      // [快照叠加规则] 整体替换负责丢弃断线期间已解决的 blocker；list 期间新到的
      // asked/replied 只按 request id 从当前 store 回放，避免旧快照抹掉或复活新状态。
      const result = Object.fromEntries(
        Object.entries(snapshot).map(([sessionID, requests]) => [sessionID, [...requests]]),
      ) as Record<string, T[]>
      for (const change of changes.values()) {
        if (change.version <= since) continue
        const currentRequests = current[change.sessionID]
        if (!currentRequests) {
          removePendingRequest(result, change.sessionID, change.requestID)
          continue
        }
        const currentMatch = Binary.search(currentRequests, change.requestID, (request) => request.id)
        if (!currentMatch.found) {
          removePendingRequest(result, change.sessionID, change.requestID)
          continue
        }
        const requests = result[change.sessionID] ?? []
        const match = Binary.search(requests, change.requestID, (request) => request.id)
        if (match.found) {
          requests[match.index] = currentRequests[currentMatch.index]
        } else {
          requests.splice(match.index, 0, currentRequests[currentMatch.index])
        }
        result[change.sessionID] = requests
      }
      return result
    }

    function removePendingRequest<T extends { id: string }>(requestsBySession: Record<string, T[]>, sessionID: string, id: string) {
      const requests = requestsBySession[sessionID]
      if (!requests) return
      const match = Binary.search(requests, id, (request) => request.id)
      if (!match.found) return
      const next = requests.toSpliced(match.index, 1)
      if (next.length === 0) {
        delete requestsBySession[sessionID]
        return
      }
      requestsBySession[sessionID] = next
    }

    function markPermissionRequestChange(sessionID: string, requestID: string) {
      permissionVersion += 1
      if (permissionRefreshes === 0) return
      permissionChanges.set(pendingRequestChangeKey(sessionID, requestID), {
        sessionID,
        requestID,
        version: permissionVersion,
      })
    }

    function markQuestionRequestChange(sessionID: string, requestID: string) {
      questionVersion += 1
      if (questionRefreshes === 0) return
      questionChanges.set(pendingRequestChangeKey(sessionID, requestID), {
        sessionID,
        requestID,
        version: questionVersion,
      })
    }

    async function refreshPermissionRequests(workspace: string | undefined) {
      const version = permissionVersion
      const refreshVersion = permissionRefreshVersion + 1
      permissionRefreshVersion = refreshVersion
      permissionRefreshes += 1
      try {
        const response = await sdk.client.permission.list({ workspace })
        // [竞态保护] 多次 reconnect 的 list 可能乱序返回；只有最新快照能覆盖 store。
        if (refreshVersion !== permissionRefreshVersion) return
        // 快照可能早于 session.deleted 发出；已删除 Session 的 pending 请求不得回填。
        const rows = (response.data ?? []).filter((request) => !deletedSessionIDs.has(request.sessionID))
        setStore(
          "permission",
          reconcile(
            pendingRequestsWithLiveChanges(
              pendingRequestsBySession(rows),
              store.permission,
              permissionChanges,
              version,
            ),
          ),
        )
      } finally {
        permissionRefreshes -= 1
        if (permissionRefreshes === 0) permissionChanges.clear()
      }
    }

    async function refreshQuestionRequests(workspace: string | undefined) {
      const version = questionVersion
      const refreshVersion = questionRefreshVersion + 1
      questionRefreshVersion = refreshVersion
      questionRefreshes += 1
      try {
        const response = await sdk.client.question.list({ workspace })
        // [问题快照规则] 与 permission 一致：最新 reconnect 快照负责整体替换，实时 SSE 另行叠加。
        if (refreshVersion !== questionRefreshVersion) return
        // 与 permission 同一失效口径：已删除 Session 的 pending 请求不得回填。
        const rows = (response.data ?? []).filter((request) => !deletedSessionIDs.has(request.sessionID))
        setStore(
          "question",
          reconcile(
            pendingRequestsWithLiveChanges(
              pendingRequestsBySession(rows),
              store.question,
              questionChanges,
              version,
            ),
          ),
        )
      } finally {
        questionRefreshes -= 1
        if (questionRefreshes === 0) questionChanges.clear()
      }
    }

    // [local-smark] refreshStatus for daemon session status tracking
    async function refreshStatus() {
      const x = await sdk.client.session.status({ workspace: project.workspace.current() })
      // 状态快照可能早于 session.deleted 发出；已删除 Session 的 status 不得回填。
      setStore(
        "session_status",
        reconcile(Object.fromEntries(Object.entries(x.data ?? {}).filter(([id]) => !deletedSessionIDs.has(id)))),
      )
    }

    const exit = useExit()
    let daemonStopSeen = false

    event.subscribe((event, { workspace }) => {
      if (event.type !== "message.part.delta") flushPartDeltas()
      switch (event.type) {
        case "global.disposed":
          if (daemonStopReason(event) === DisposedReason.DaemonStop) {
            daemonStopSeen = true
            exit.message.set("opencode daemon stopped.")
            void exit()
          } else {
            // 非 DaemonStop 的 global.disposed 来自 auth 变更后的 Provider 缓存刷新。
            // 不销毁实例，仅刷新 TUI 本地数据以获取最新 provider 列表。
            void bootstrap()
          }
          break
        case "server.connected":
          loggedPartDeltaApplications.clear()
          if (!connectedOnce) {
            connectedOnce = true
            break
          }
          // SSE has no replay buffer. After a reconnect, refresh persisted state
          // from SQLite so missed message/status events cannot leave the TUI stale.
          fullSyncedSessions.clear()
          void bootstrap({ fatal: false }).catch(() => undefined)
          break
        case "server.instance.disposed":
          if (daemonStopSeen) break
          void bootstrap()
          break
        case "permission.replied": {
          markPermissionRequestChange(event.properties.sessionID, event.properties.requestID)
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          if (deletedSessionIDs.has(event.properties.sessionID)) break
          const request = event.properties
          markPermissionRequestChange(request.sessionID, request.id)
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          markQuestionRequestChange(event.properties.sessionID, event.properties.requestID)
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          if (deletedSessionIDs.has(event.properties.sessionID)) break
          const request = event.properties
          markQuestionRequestChange(request.sessionID, request.id)
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          if (deletedSessionIDs.has(event.properties.sessionID)) break
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        // [local-smark] goal 事件：更新或清除 sidebar 中的 goal 状态
        // TODO(sdk-regen): SDK 重新生成后移除 as string / as any，改用类型安全的 event.properties
        case "session.goal.updated" as string:
          if (deletedSessionIDs.has((event as any).properties.sessionID)) break
          setStore("session_goal", (event as any).properties.sessionID, (event as any).properties.goal)
          break

        case "session.goal.cleared" as string:
          setStore("session_goal", (event as any).properties.sessionID, undefined)
          break

        case "session.diff":
          if (deletedSessionIDs.has(event.properties.sessionID)) break
          setStore(
            produce((draft) => {
              // diff rows 与 totals 必须在同一 Solid transaction 收敛，否则 Files 会短暂把旧总数解释成新列表截断。
              // 本地 summary 只是 viewer projection；共享 Session 持久数据仍由 daemon 的 Summary/Revert owner 管理。
              const projected = projectTuiDiff(event.properties.diff)
              draft.session_diff[event.properties.sessionID] = projected.items
              const result = Binary.search(draft.session, event.properties.sessionID, (session) => session.id)
              if (result.found) draft.session[result.index].summary = projected.summary
            }),
          )
          break

        case "session.deleted": {
          deletedSessionIDs.add(event.properties.info.id)
          releaseSession(event.properties.info.id)
          break
        }
        case "session.updated": {
          // 携带 sessionID 的事件入口统一过 deletedSessionIDs：迟到的 SSE 不得复活已删除 Session 的任何桶。
          if (deletedSessionIDs.has(event.properties.info.id)) break
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            const summary = Object.hasOwn(store.session_diff, event.properties.info.id)
              ? store.session[result.index]?.summary
              : undefined
            setStore(
              "session",
              result.index,
              reconcile({
                ...event.properties.info,
                // 已有viewer diff时summary属于同一TUI投影；完整updated只更新其余Session metadata。
                // Summary/Revert两种事件顺序最终都由下一次session.diff提交新的normalized totals。
                summary: summary ?? event.properties.info.summary,
              }),
            )
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          if (deletedSessionIDs.has(event.properties.sessionID)) break
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          const info = event.properties.info
          if (deletedSessionIDs.has(info.sessionID)) break
          if ((info as Record<string, unknown>).hidden) {
            // hidden 是持久事实：记录失效 ID 后释放，迟到的 Part/delta 不得复活正文。
            removedMessageIDs.add(info.id)
            releaseMessage(info.sessionID, info.id, info)
            break
          }
          if (removedMessageIDs.has(info.id)) break
          trackSyncChange(info.sessionID, info.id)
          // Message 内容持久的到达边界：user 写完即持久，assistant 以 time.completed 为准。
          // 覆盖 part-first 乱序（Part 先于父 Message 到达时已按未知状态准入）。
          if (!partConsumers.has(info.sessionID) && (info.role !== "assistant" || info.time.completed !== undefined)) {
            // 拷贝出稳定快照再逐个释放：releasePart 会 splice 同一个 store 数组，
            // 直接在原数组上迭代会跳过相邻元素。
            const doomed = [...(store.part[info.id] ?? [])]
            batch(() => {
              for (const part of doomed) releasePart(info.sessionID, part)
            })
          }
          const messages = store.message[info.sessionID]
          if (!messages) {
            // 首条 SSE 会直接建立数组；先登记索引才能保证紧随其后的 ID-only remove 使用同一投影事实。
            indexMessage(info)
            setStore("message", info.sessionID, [info])
            break
          }
          const result = searchMessage(messages, info)
          if (result.found) {
            // reconcile 与索引替换属于同一个同步事件边界，后续 remove 只能看到这次 update 的 chronology key。
            indexMessage(info)
            setStore("message", info.sessionID, result.index, reconcile(info))
            break
          }
          indexMessage(info)
          setStore(
            "message",
            info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, info)
            }),
          )
          const updated = store.message[info.sessionID]
          if (updated.length > 300) {
            const oldest = updated[0]
            // 300 条窗口删除 chronology 首项；索引必须在同一事件调用栈移除相同 Message。
            unindexMessage(oldest)
            // 窗口淘汰同时忘掉终态 ID 事实：淘汰后重新加载的 Part 需要能正常准入。
            releasedTerminalParts.get(info.sessionID)?.delete(oldest.id)
            batch(() => {
              setStore(
                "message",
                info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          // ID-only event：即使本地从未加载父 Message，也要记录失效并清掉 orphan/pending delta。
          removedMessageIDs.add(event.properties.messageID)
          releaseMessage(event.properties.sessionID, event.properties.messageID)
          break
        }
        case "message.part.updated":
        case "message.part.progress": {
          // 幂等 TUI 投影：剪掉同 Part 逐字重复的大字段；生产 SSE 已在 daemon 侧投影，
          // 这里覆盖测试 transport 与直接 SDK 注入，重复应用无害。
          const part = PartView.project(event.properties.part)
          if ((part as Record<string, unknown>).hidden) {
            removedPartIDs.add(part.id)
            dropBufferedDeltas((event) => event.properties.partID === part.id)
            const parts = store.part[part.messageID]
            if (!parts) break
            const foundAt = Binary.search(parts, part.id, (p) => p.id)
            if (!foundAt.found) break
            setStore(
              "part",
              part.messageID,
              produce((draft) => {
                draft.splice(foundAt.index, 1)
              }),
            )
            break
          }
          if (partGone(part.sessionID, part.messageID, part.id)) break
          trackSyncChange(part.sessionID, part.messageID, part.id)
          if (!partConsumers.has(part.sessionID)) {
            // 无消费者 Session 的终态正文不入 store；已释放 Part 的迟到 progress/update 直接拒绝。
            if (releasedTerminalParts.get(part.sessionID)?.get(part.messageID)?.has(part.id)) break
            if (isTerminalAdmission(part)) {
              // running→completed 的持久替换先移除已驻留的旧版本，再拒绝新正文准入；
              // 只拒绝事件不删旧值会把 running 正文留在 store。
              releasePart(part.sessionID, part)
              break
            }
          } else {
            // 有消费者时新的合法 durable 更新可以覆盖已释放事实。
            releasedTerminalParts.get(part.sessionID)?.get(part.messageID)?.delete(part.id)
          }
          const parts = store.part[part.messageID]
          if (!parts) {
            setStore("part", part.messageID, [part])
            // part 首次创建：replay 在 part.updated 之前到达的缓冲 delta
            replayOrphanDeltas(part.id, part.messageID)
            break
          }
          const result = Binary.search(parts, part.id, (p) => p.id)
          if (result.found) {
            // 合并守卫：防止 fire-and-forget 竞态导致短快照覆盖长流式文本
            setStore("part", part.messageID, result.index, reconcile(mergeLivePart(parts[result.index], part)))
            break
          }
          setStore(
            "part",
            part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, part)
            }),
          )
          // part 插入到已有数组：replay 在 part.updated 之前到达的缓冲 delta
          replayOrphanDeltas(part.id, part.messageID)
          break
        }

        case "message.part.delta": {
          // 已释放终态 Part 的迟到 delta 直接丢弃；其余按原缓冲/应用路径。
          const released = releasedTerminalParts.get(event.properties.sessionID)?.get(event.properties.messageID)
          if (!released?.has(event.properties.partID)) enqueuePartDelta(event)
          break
        }

        case "message.part.removed": {
          removedPartIDs.add(event.properties.partID)
          // lambda 参数会遮蔽 switch 作用域的 event；先取常量再比较，避免恒真谓词清空全部会话的缓冲 delta。
          const removedPartID = event.properties.partID
          dropBufferedDeltas((event) => event.properties.partID === removedPartID)
          const parts = store.part[event.properties.messageID]
          // Part同样可能先于本地bootstrap到达；缺失集合不应中断后续正文事件。
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          void refreshLsp()
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    onCleanup(() => {
      if (pendingPartDeltaTimer) clearTimeout(pendingPartDeltaTimer)
      pendingPartDeltas = []
      orphanPartDeltas.clear()
      loggedPartDeltaApplications.clear()
      // Provider 退出即失效元数据的终点；ID 集合本身也不跨 Provider 生命周期保留。
      deletedSessionIDs.clear()
      removedMessageIDs.clear()
      removedPartIDs.clear()
      syncRequests.clear()
      syncChanges.clear()
      partConsumers.clear()
      releasedTerminalParts.clear()
    })

    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      const blockingRequests: { name: string; promise: Promise<unknown> }[] = [
        { name: "config.providers", promise: providersPromise },
        { name: "provider.list", promise: providerListPromise },
        { name: "app.agents", promise: agentsPromise },
        { name: "config.get", promise: configPromise },
        { name: "project.sync", promise: projectPromise },
        ...(args.continue ? [{ name: "session.list", promise: sessionListPromise }] : []),
      ]

      await Promise.allSettled(blockingRequests.map((r) => r.promise))
        .then((settled) => {
          // Surface every failed endpoint in one labeled message instead of
          // letting the first rejection drown its siblings as unhandled
          // rejections.
          const failure = aggregateFailures(blockingRequests.map((r, i) => ({ name: r.name, result: settled[i] })))
          if (failure) throw failure
        })
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const consoleState = responses[2]
            const agents = responses[3]
            const config = responses[4]
            const sessions = responses[5]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            refreshStatus(),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            // [pending 恢复入口] permission/question 只在 daemon 内存里，SSE 又不能 replay；
            // reconnect bootstrap 必须主动拉快照，才能恢复断线期间仍 pending 的 blocker。
            refreshPermissionRequests(workspace),
            refreshQuestionRequests(workspace),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          Log.Default.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            await exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      void bootstrap()
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (process.env.OPENCODE_FAST_BOOT) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string, options?: { force?: boolean }) {
          // 同 Session 的请求经串行门排队进入：并发取代会让被取代请求“成功返回但没有提交”，
          // acquireParts 会把空 store 误当正文就绪。gate 在本体结束时放行下一个；跨 Session 仍并行。
          const previous = syncChains.get(sessionID) ?? Promise.resolve()
          let gate!: () => void
          const current = previous.catch(() => {}).then(() => new Promise<void>((resolve) => (gate = resolve)))
          syncChains.set(sessionID, current)
          await previous.catch(() => {})
          try {
          if (!options?.force && fullSyncedSessions.has(sessionID)) return
          if (deletedSessionIDs.has(sessionID)) return
          const token = ++syncRequestSeq
          syncRequests.set(sessionID, token)
          const changes = { messages: new Set<string>(), parts: new Set<string>() }
          syncChanges.set(sessionID, changes)
          // 每个 await 之后都必须重新检查 alive：删除或更新的 force 请求会让旧提交失效，
          // 旧响应既不能复活已删 Session，也不能覆盖较新请求的结果。
          const alive = () => syncRequests.get(sessionID) === token && !deletedSessionIDs.has(sessionID)
          try {
            const [session, messages, todo, status] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              // 仅 TUI viewer 请求省略每轮冷 summary；Web App/SDK 的默认完整合同不带此信号。
              // limit=300 继续锁定现有分页语义；projection 只改变每条 Message 的数据深度，不改变范围或顺序。
              sdk.client.session.messages(
                { sessionID, limit: 300 },
                { headers: { [TUI_VIEWER_HEADER]: TUI_VIEWER } },
              ),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.status({ workspace: project.workspace.current() }),
            ])
            if (!alive()) return
            // 同一份 infos 同时提交 store 和索引，避免两次 projection 对 hidden/window 范围产生分歧。
            const infos = (messages.data ?? []).map((message) => message.info)
            // [local-smark] goal fetch：非致命，失败不影响 session sync
            // SDK 未重新生成 goal 方法，直接用 fetch 调用 HTTP 端点
            // GET 请求由 sdk.fetch 的 rewrite 拦截器自动添加 directory query param
            try {
              const resp = await sdk.fetch(`${sdk.url}/session/${sessionID}/goal`)
              if (!alive()) return
              if (resp.ok) {
                const data = await resp.json()
                setStore("session_goal", sessionID, data?.goal ?? undefined)
              }
            } catch {
              // goal 端点不可用时不阻塞 session sync
            }
            if (!alive()) return
            // messages 请求失败时 SDK 合同是 data=undefined（无 throwOnError）；
            // 失败响应不是权威空页：跳过替换与裁剪，保留本地消息与正文，等下一次 sync。
            const pageFailed = messages.data === undefined
            setStore(
              produce((draft) => {
                const match = Binary.search(draft.session, sessionID, (s) => s.id)
                if (match.found) draft.session[match.index] = session.data!
                if (!match.found) draft.session.splice(match.index, 0, session.data!)
                draft.todo[sessionID] = todo.data ?? []
                if (pageFailed) return
                for (const message of messages.data ?? []) {
                  // HTTP 快照合并：DB 在 streaming 期间 text="" ，
                  // mergeLiveParts 保留本地已通过 delta 累积的长文本
                  if (removedMessageIDs.has(message.info.id)) continue
                  draft.part[message.info.id] = mergeLiveParts(
                    draft.part[message.info.id],
                    message.parts.map((part) => PartView.project(part)),
                  )
                }
                // 最终投影 = HTTP 页 + 请求期间的合法 live 变化 - 已失效对象。
                // 合并后按 chronology/BINARY 重排，保持与事件路径相同的顺序不变量。
                const pageIDs = new Set(infos.map((message) => message.id))
                const index = messageByID.get(sessionID)
                const merged = infos.filter((message) => !removedMessageIDs.has(message.id))
                for (let i = 0; i < merged.length; i++) {
                  const live = changes.messages.has(merged[i].id) ? index?.get(merged[i].id) : undefined
                  if (live && !removedMessageIDs.has(live.id)) merged[i] = live
                }
                for (const id of changes.messages) {
                  if (pageIDs.has(id) || removedMessageIDs.has(id)) continue
                  const live = index?.get(id)
                  if (live) merged.push(live)
                }
                merged.sort((a, b) => a.time.created - b.time.created || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)))
                draft.message[sessionID] = merged
                // 窗口外与 part-first 对象在 authoritative 页落定后释放；
                // 请求期间有变化的 Part 保留，等待其 Message 到达。
                const finalIDs = new Set(merged.map((message) => message.id))
                for (const key of Object.keys(draft.part)) {
                  const parts = draft.part[key]
                  if (parts?.[0]?.sessionID !== sessionID || finalIDs.has(key)) continue
                  if (parts.some((part) => changes.parts.has(part.id))) continue
                  delete draft.part[key]
                }
              }),
            )
            // force sync 是整页 authoritative replacement；重建而非增量合并可清除已不在窗口内的旧 key。
            // 页面失败时没有 authoritative 事实，索引保持现有投影不动。
            if (!pageFailed) {
              const finalMessages = store.message[sessionID] ?? []
              messageByID.set(sessionID, new Map(finalMessages.map((message) => [message.id, message])))
            }
            setStore("session_status", reconcile(status.data ?? {}))
            // session.sync 从 DB 创建/更新 parts 后，replay 在 parts 到达前缓冲的 delta。
            // 这对子会话尤其关键：进入子会话前 delta 全部被缓冲（store 中没有 message），
            // sync 从 DB 拉到 text="" 的 part 后必须 replay 缓冲 delta 才能恢复完整文本。
            for (const message of messages.data ?? []) {
              for (const part of message.parts) {
                replayOrphanDeltas(part.id, message.info.id)
              }
            }
          } finally {
            // 只清自己登记的记录：更新的请求已经换了对象，误删会让新请求丢失变更跟踪。
            if (syncChanges.get(sessionID) === changes) syncChanges.delete(sessionID)
          }
          // 可见历史先发布；diff 的 decode/传输失败仍由同一个 sync 直接抛出，但不能再成为首屏屏障。
          // diff 此时才创建 Promise，因此不存在“早期 rejection 等待其他请求”造成的 unhandled 窗口。
          // force reconnect 仍 await 同一 authoritative 请求；这里不是 fire-and-forget，也不合成备用成功。
          const diff = await sdk.client.session.diff(
            { sessionID },
            { headers: { [TUI_VIEWER_HEADER]: TUI_VIEWER } },
          )
          // diff 是 sync 的最后一个 await：删除发生在 diff 挂起时，结果不得回填。
          if (!alive()) return
          const projected = projectTuiDiff(diff.data ?? [])
          const files = diff.response?.headers.get(TUI_DIFF_TOTAL_FILES) ?? null
          const additions = diff.response?.headers.get(TUI_DIFF_TOTAL_ADDITIONS) ?? null
          const deletions = diff.response?.headers.get(TUI_DIFF_TOTAL_DELETIONS) ?? null
          setStore(
            produce((draft) => {
              draft.session_diff[sessionID] = projected.items
              const result = Binary.search(draft.session, sessionID, (item) => item.id)
              // headers 成组存在时是同一viewer response的权威总量；否则采用当前data??[]投影，不能混入旧Session summary。
              // resolved HTTP error因此原子提交空rows/zero totals；fetch exception仍由optional response access保持既有语义。
              if (result.found)
                draft.session[result.index].summary =
                  files === null || additions === null || deletions === null
                    ? projected.summary
                    : {
                        files: Number(files),
                        additions: Number(additions),
                        deletions: Number(deletions),
                      }
            }),
          )
          fullSyncedSessions.add(sessionID)
          } finally {
            // 本体无论提交、早退还是失败都必须放行队列；只有后继者已接管时才保留其队首位置。
            gate()
            if (syncChains.get(sessionID) === current) syncChains.delete(sessionID)
          }
        },
        // 显式正文消费：Task 卡片与插件用它持有 Session 正文，release 后无消费者即释放。
        // acquire 成功后 await 现有 sync；返回的 release 幂等由调用方/插件 scope 保证。
        async acquireParts(sessionID: string) {
          acquireParts(sessionID)
          try {
            await result.session.sync(sessionID)
            // 早退路径（Session 删除竞态等）不提交正文：获取承诺必须观察到 fullSynced，
            // 否则调用方会把空 store 当作已加载成功。
            if (!fullSyncedSessions.has(sessionID)) throw new Error(`session parts unavailable: ${sessionID}`)
          } catch (error) {
            // sync 失败（Session 删除竞态/守护进程重启）必须回滚计数：没有句柄返回，
            // 不回滚会让该 Session 的正文使用权永久泄漏，后台完成事件持续补入。
            releaseParts(sessionID)
            throw error
          }
          return {
            release() {
              releaseParts(sessionID)
            },
          }
        },
      },
      sessionStatus: {
        refresh: refreshStatus,
      },
      // [local-smark] goal reconcile：POST 成功后立即更新 store，不等 SSE
      goal: {
        reconcile: (sessionID: string, goal: SessionGoalInfo) => {
          setStore("session_goal", sessionID, goal)
        },
      },
      bootstrap,
    }
    return result
  },
})

function daemonStopReason(event: { properties: unknown }) {
  const properties = event.properties
  if (!properties || typeof properties !== "object") return
  return typeof (properties as { reason?: unknown }).reason === "string"
    ? (properties as { reason: string }).reason
    : undefined
}
