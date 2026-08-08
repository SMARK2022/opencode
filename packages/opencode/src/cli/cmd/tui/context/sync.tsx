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
import { SESSION_LIST_BROWSE_LIMIT, SESSION_LIST_LOOKBACK_MS } from "@tui/util/session-list-params"
import { aggregateFailures } from "./aggregate-failures"
import { logPartDeltaTiming, partDeltaTimingKey, PART_DELTA_TIMING_LIMIT } from "./stream-timing"
import { DisposedReason } from "@/server/event"

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
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
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
        setStore(
          "permission",
          reconcile(
            pendingRequestsWithLiveChanges(
              pendingRequestsBySession(response.data ?? []),
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
        setStore(
          "question",
          reconcile(
            pendingRequestsWithLiveChanges(
              pendingRequestsBySession(response.data ?? []),
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
      setStore("session_status", reconcile(x.data ?? {}))
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
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        // [local-smark] goal 事件：更新或清除 sidebar 中的 goal 状态
        // TODO(sdk-regen): SDK 重新生成后移除 as string / as any，改用类型安全的 event.properties
        case "session.goal.updated" as string:
          setStore("session_goal", (event as any).properties.sessionID, (event as any).properties.goal)
          break

        case "session.goal.cleared" as string:
          setStore("session_goal", (event as any).properties.sessionID, undefined)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          // [local-smark] 清理已删除 session 的 goal 状态，防止 store 泄漏
          setStore("session_goal", event.properties.info.id, undefined)
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
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
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          const info = event.properties.info
          if ((info as Record<string, unknown>).hidden) {
            const messages = store.message[info.sessionID]
            // 同Project事件可能属于未加载Session；本地没有可删除的投影时必须保持消费链继续。
            if (!messages) break
            const result = Binary.search(messages, info.id, (m) => m.id)
            if (result.found) {
              setStore(
                "message",
                info.sessionID,
                produce((draft) => {
                  draft.splice(result.index, 1)
                }),
              )
            }
            break
          }
          const messages = store.message[info.sessionID]
          if (!messages) {
            setStore("message", info.sessionID, [info])
            break
          }
          const result = Binary.search(messages, info.id, (m) => m.id)
          if (result.found) {
            setStore("message", info.sessionID, result.index, reconcile(info))
            break
          }
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
          const messages = store.message[event.properties.sessionID]
          // daemon的删除事实仍有效，但未加载Session的TUI投影只能安全地no-op。
          if (!messages) break
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated":
        case "message.part.progress": {
          const part = event.properties.part
          if ((part as Record<string, unknown>).hidden) {
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
            // 清除该 part 的缓冲 delta（part 已隐藏移除，delta 不再需要）
            orphanPartDeltas.delete(part.id)
            break
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
          enqueuePartDelta(event)
          break
        }

        case "message.part.removed": {
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
          // 清除该 part 的缓冲 delta（part 已移除，delta 不再需要）
          orphanPartDeltas.delete(event.properties.partID)
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
          if (!options?.force && fullSyncedSessions.has(sessionID)) return
          const [session, messages, todo, diff, status] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
            sdk.client.session.messages({ sessionID, limit: 300 }),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
            sdk.client.session.status({ workspace: project.workspace.current() }),
          ])
          // [local-smark] goal fetch：非致命，失败不影响 session sync
          // SDK 未重新生成 goal 方法，直接用 fetch 调用 HTTP 端点
          // GET 请求由 sdk.fetch 的 rewrite 拦截器自动添加 directory query param
          try {
            const resp = await sdk.fetch(`${sdk.url}/session/${sessionID}/goal`)
            if (resp.ok) {
              const data = await resp.json()
              setStore("session_goal", sessionID, data?.goal ?? undefined)
            }
          } catch {
            // goal 端点不可用时不阻塞 session sync
          }
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session[match.index] = session.data!
              if (!match.found) draft.session.splice(match.index, 0, session.data!)
              draft.todo[sessionID] = todo.data ?? []
              const infos: (typeof draft.message)[string] = []
              for (const message of messages.data ?? []) {
                infos.push(message.info)
                // HTTP 快照合并：DB 在 streaming 期间 text="" ，
                // mergeLiveParts 保留本地已通过 delta 累积的长文本
                draft.part[message.info.id] = mergeLiveParts(draft.part[message.info.id], message.parts)
              }
              draft.message[sessionID] = infos
              draft.session_diff[sessionID] = diff.data ?? []
            }),
          )
          setStore("session_status", reconcile(status.data ?? {}))
          // session.sync 从 DB 创建/更新 parts 后，replay 在 parts 到达前缓冲的 delta。
          // 这对子会话尤其关键：进入子会话前 delta 全部被缓冲（store 中没有 message），
          // sync 从 DB 拉到 text="" 的 part 后必须 replay 缓冲 delta 才能恢复完整文本。
          for (const message of messages.data ?? []) {
            for (const part of message.parts) {
              replayOrphanDeltas(part.id, message.info.id)
            }
          }
          fullSyncedSessions.add(sessionID)
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
