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
  SnapshotFileDiff,
  ConsoleState,
  EventMessagePartDelta,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useEpilogue } from "./epilogue"
import { useArgs } from "./args"
import { batch, onCleanup, onMount } from "solid-js"
import path from "path"
import { SessionPath } from "@opencode-ai/core/session/path"
// #132：会话 path 规范化
import { useKV } from "./kv"
import { usePermission } from "./permission"
import { logPartDeltaTiming, partDeltaTimingKey, PART_DELTA_TIMING_LIMIT } from "./stream-timing"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function compareMessage(a: Message, b: Message) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

const messageKey = (message: Message) => message.time.created + message.id

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const permission = usePermission()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      capabilities: {
        experimentalBackgroundSubagents: boolean
      }
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
        [sessionID: string]: SnapshotFileDiff[]
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
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      capabilities: {
        experimentalBackgroundSubagents: false,
      },
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
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()

    const fullSyncedSessions = new Set<string>()
    // #132：区分首次 connected 与重连
    let connectedOnce = false
    // #192：重连后 permission/question 快照版本
    // #192：版本计数决定哪些本地变更应回放，避免重连恢复丢变更
    let permissionVersion = 0
    let questionVersion = 0
    let permissionRefreshes = 0
    let questionRefreshes = 0
    let permissionRefreshVersion = 0
    let questionRefreshVersion = 0
    const permissionChanges = new Map<string, { sessionID: string; requestID: string; version: number }>()
    const questionChanges = new Map<string, { sessionID: string; requestID: string; version: number }>()
    // #186：同一 part/field 的相邻 delta 在 16ms 窗内合并，压低 Solid store 抖动
    // #186：队列与 timer 均局部于 SyncProvider，不泄漏到 SDK 订阅层
    let pendingPartDeltas: EventMessagePartDelta[] = []
    let pendingPartDeltaTimer: Timer | undefined
    const loggedPartDeltaApplications = new Set<string>()

    function targetsSamePartDelta(previous: EventMessagePartDelta, next: EventMessagePartDelta) {
      // #186：仅同 session/message/part/field 的相邻 delta 可合并；公共事件流仍逐条投递
      // #186：field 不同（如 text vs raw）必须分桶，防止串写
      return (
        previous.properties.sessionID === next.properties.sessionID &&
        previous.properties.messageID === next.properties.messageID &&
        previous.properties.partID === next.properties.partID &&
        previous.properties.field === next.properties.field
      )
    }

    function coalescePartDeltas(events: readonly EventMessagePartDelta[]) {
      // #186：线性扫一遍，只合并“相邻且同 key”的片段，跨 part 不合并
      const result: EventMessagePartDelta[] = []
      for (const event of events) {
        const previous = result.at(-1)
        if (!previous || !targetsSamePartDelta(previous, event)) {
          // #186：边界切换：开启新桶，保留事件顺序语义
          result.push(event)
          continue
        }
        // #186：保留首条 id，只拼接 delta 文本；part.updated 等边界会先 flush
        // #186：后到事件的 id 丢弃不影响 store，只服务合并槽位
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
      // #186：orphan delta（part 尚未入 store）直接丢弃，与 hydration 竞态测试一致
      const parts = store.part[event.properties.messageID]
      if (!parts) {
        logPartDeltaApplication(event, "delta.drop", "missing-message")
        return
      }
      const result = search(parts, event.properties.partID, (p) => p.id)
      // #186：找不到 part 时不创建空壳，避免伪造 tool/text
      if (!result.found) {
        logPartDeltaApplication(event, "delta.drop", "missing-part")
        return
      }
      // 合并后的实际写入仍须标记 hydration 冲突，避免旧 HTTP 快照覆盖实时内容。
      // 此标记不创建 orphan，也不改变 pending raw 的嵌套状态契约。
      touchPart(event.properties.sessionID, event.properties.partID)
      setStore(
        "part",
        event.properties.messageID,
        produce((draft) => {
          const part = draft[result.index]
          // V1 raw 表示工具的未解析参数，必须更新嵌套 pending state 才能被 token 消费端读取。
          if (event.properties.field === "raw") {
            if (part.type === "tool" && part.state.status === "pending")
              part.state.raw += event.properties.delta
            // 终态或非工具的迟到 raw 不能污染顶层字段，也不能把 running input 变回字符串。
            return
          }
          const field = event.properties.field as keyof typeof part
          const existing = part[field] as string | undefined
          ;(part[field] as string) = (existing ?? "") + event.properties.delta
        }),
      )
      logPartDeltaApplication(event, "delta.apply")
    }

    function flushPartDeltas() {
      // #186：先清 timer 再消费队列，防止重入二次调度
      if (pendingPartDeltaTimer) {
        clearTimeout(pendingPartDeltaTimer)
        pendingPartDeltaTimer = undefined
      }
      if (pendingPartDeltas.length === 0) return
      // #186：取出快照后立刻清空，后续 enqueue 进入新窗
      const events = coalescePartDeltas(pendingPartDeltas)
      pendingPartDeltas = []
      // #186：同帧 batch 写入，避免 N 次独立 store 通知
      // #186：顺序仍按 coalesce 结果，跨 part 交替时保持到达序
      batch(() => {
        for (const event of events) applyPartDelta(event)
      })
    }

    function enqueuePartDelta(event: EventMessagePartDelta) {
      // #186：只入队不立刻写 store，把高频 token 片段留给 coalesce
      pendingPartDeltas.push(event)
      if (pendingPartDeltaTimer) return
      // #186：16ms 对齐一帧；超时或非 delta 边界都会 flush
      pendingPartDeltaTimer = setTimeout(flushPartDeltas, 16)
    }

    const syncingSessions = new Map<string, Promise<void>>()
    type SessionTrace = {
      session?: Session | null
      moved?: Pick<Session, "directory" | "path" | "workspaceID"> & { time: { updated: number } }
    }
    const hydratingSessions = new Map<string, SessionTrace & { messages: Set<string>; parts: Set<string> }>()
    const listingSessions = new Set<Map<string, SessionTrace>>()
    // 完整更新/删除可替代 HTTP；moved 只有 placement，不能阻止缺失会话的完整初始化。
    const touchSession = (sessionID: string, session?: Session | null, moved?: SessionTrace["moved"]) => {
      // 入 trace 前复制原始事件；随后 store 的 reconcile 可以原地改写它的嵌套 tokens/time。
      const tracker = hydratingSessions.get(sessionID)
      if (tracker) {
        if (session !== undefined) tracker.session = structuredClone(session)
        tracker.moved = moved
      }
      for (const listing of listingSessions) {
        const tracker: SessionTrace = listing.get(sessionID) ?? {}
        if (session !== undefined) tracker.session = structuredClone(session)
        tracker.moved = moved
        listing.set(sessionID, tracker)
      }
    }
    // 后到完整事件清除旧 placement；否则将最后一次 moved 叠到 HTTP 行上并保留 created。
    const acceptSession = (info: Session, tracker?: SessionTrace) => {
      // 只有明确 null 才是删除；复制事件快照再入 store，避免另一列表或 reconcile 改写请求证据。
      const current = tracker?.session === undefined ? info : structuredClone(tracker.session)
      if (!current || !tracker?.moved) return current
      return { ...current, ...tracker.moved, time: { ...current.time, ...tracker.moved.time } }
    }
    const touchMessage = (sessionID: string, messageID: string) => {
      hydratingSessions.get(sessionID)?.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

    function sessionListQuery(): { directory?: string; scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      // #143：同时传 directory 供 path 为空的历史会话 fallback
      return {
        directory: project.data.instance.path.directory,
        path: SessionPath.relative(project.data.instance.path.worktree, project.data.instance.path.directory),
      }
    }

    function listSessions() {
      const tracker = new Map<string, SessionTrace>()
      listingSessions.add(tracker)
      const query = { start: Date.now() - 90 * 24 * 60 * 60 * 1000, limit: 1200, ...sessionListQuery() }
      // project ID 固定到请求发起时的实例；全局事件本身不做项目筛选。
      const projectID = project.project()
      const directory = query.directory
      const worktree = project.data.instance.path.worktree
      // #143：接收合并也遵循服务端的祖先、子孙、global 与 directory OR，包含已定义的空 path。
      const matches = (info: Session) => {
        if (query.path === undefined) return info.projectID === projectID
        const nullPath = info.path === undefined && directory !== undefined && info.directory === directory
        const projectPath = SessionPath.aliases({
          path: query.path,
          directory,
          global: projectID === "global",
        }).some((item) => {
          const prefix = item.replace(/\/+$/, "")
          return info.path !== undefined && (SessionPath.ancestors(item, { root: true }).includes(info.path) || info.path.startsWith(prefix ? `${prefix}/` : ""))
        })
        if (info.projectID === projectID && (projectPath || nullPath)) return true
        if (!directory) return false
        const left = SessionPath.relative(worktree, directory)
        const right = query.path.replaceAll("\\", "/")
        if (process.platform === "win32" ? left.toLowerCase() !== right.toLowerCase() : left !== right) return false
        // #143：仅 directory/path 同源时启用跨项目分支；不把所有触碰行盲目并入列表。
        const globalPath = SessionPath.aliases({
          path: SessionPath.relative("/", directory),
          directory,
          global: true,
        }).some((item) => {
          const prefix = item.replace(/\/+$/, "")
          return info.path !== undefined && (SessionPath.ancestors(item).includes(info.path) || info.path.startsWith(prefix ? `${prefix}/` : ""))
        })
        if (info.projectID === "global" && (globalPath || nullPath)) return true
        const normalized = path.resolve(directory).replaceAll("\\", "/").replace(/\/+$/, "")
        const value = process.platform === "win32" ? normalized.toLowerCase() : normalized
        const comparable = info.directory.replaceAll("\\", "/")
        const current = process.platform === "win32" ? comparable.toLowerCase() : comparable
        return SessionPath.ancestors(value).includes(current) || current.startsWith(value ? `${value}/` : "")
      }
      return sdk.client.session
        .list(query)
        .then((x) => {
          // 未触碰行保留服务端结果；触碰行先完成部分初始化，再按最新 placement 判断成员。
          const infos = (x.data ?? []).flatMap((info) => {
            if (!tracker.has(info.id)) return [info]
            const current = acceptSession(info, tracker.get(info.id))
            return current && matches(current) ? [current] : []
          })
          // 只补本请求收到事件的行，保住新会话；不保留未触碰的旧排除成员或删除墓碑。
          infos.push(
            ...Array.from(tracker).flatMap(([id, trace]) => {
              // 已知 full/null 只取本请求的事件证据；仅部分 move 可借用仍可见的基础行。
              const base = trace.session === undefined ? store.session.find((item) => item.id === id) : trace.session
              const info = base && acceptSession(base, trace)
              // start 仅筛补入的成员；usage 不推进 updated，不能用它仲裁快照先后。
              return info && !infos.some((item) => item.id === id) && matches(info) && info.time.updated >= query.start
                ? [info]
                : []
            }),
          )
          setStore("session", reconcile(infos.toSorted((a, b) => a.id.localeCompare(b.id))))
          return infos
        })
        // tracker 只存活到快照真正接收完毕；HTTP 失败同样释放，不能积累常驻版本表。
        .finally(() => listingSessions.delete(tracker))
    }

    const exit = useExit()
    const setEpilogue = useEpilogue()
    // 主动停机先锁定退出状态，后续实例释放通知不能再次 bootstrap。
    let daemonStopSeen = false

    event.subscribe((event, { directory, workspace }) => {
      // #186：非 delta 事件前强制 flush，保证 part.updated / vcs 等看到完整文本
      // #186：delta 自身不 flush，继续积攒同一 16ms 窗口
      if (event.type !== "message.part.delta") flushPartDeltas()
      switch (event.type) {
        case "global.disposed": {
          // 原始SSE载荷仍按运行时字段识别，普通dispose不触发主动停机路径。
          const properties: unknown = event.properties
          if (!properties || typeof properties !== "object" ||
            !("reason" in properties) || properties.reason !== "daemon-stop") break
          daemonStopSeen = true
          // 提示走 epilogue；exit 的 reason 参数会被现有退出 owner 判作错误。
          setEpilogue("opencode daemon stopped.")
          exit()
          break
        }
        case "server.instance.disposed":
          if (daemonStopSeen) break
          void bootstrap()
          break
        case "server.connected":
          loggedPartDeltaApplications.clear()
          // #132：SSE 无回放；重连后刷新持久化状态
          if (!connectedOnce) {
            connectedOnce = true
            break
          }
          fullSyncedSessions.clear()
          void bootstrap({ fatal: false }).catch(() => undefined)
          break
        case "permission.replied": {
          markPermissionRequestChange((event.properties as { sessionID: string; requestID: string }).sessionID, (event.properties as { sessionID: string; requestID: string }).requestID)
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
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
          if (permission.mode === "auto") {
            void sdk.client.permission.reply({
              requestID: request.id,
              reply: "once",
              directory,
              workspace,
            })
            break
          }
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
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
          markQuestionRequestChange((event.properties as { sessionID: string; requestID: string }).sessionID, (event.properties as { sessionID: string; requestID: string }).requestID)
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
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
          const match = search(requests, request.id, (r) => r.id)
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

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          touchSession(event.properties.info.id, null)
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          touchSession(event.properties.info.id, event.properties.info)
          const result = search(store.session, event.properties.info.id, (s) => s.id)
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

        case "session.next.moved": {
          // 保存显式 undefined，移动回本地/根目录也要清掉旧 workspace/path。
          touchSession(event.properties.sessionID, undefined, {
            directory: event.properties.location.directory,
            path: event.properties.subdirectory,
            workspaceID: event.properties.location.workspaceID,
            time: { updated: event.properties.timestamp },
          })
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          // #98：隐藏消息按 ID 移除，旧快照不能复活。
          const info = event.properties.info
          if ((info as Record<string, unknown>).hidden) {
            touchMessage(info.sessionID, info.id)
            const messages = store.message[info.sessionID]
            if (messages) {
              const index = messages.findIndex((message) => message.id === info.id)
              if (index !== -1) {
                setStore(
                  "message",
                  info.sessionID,
                  produce((draft) => {
                    draft.splice(index, 1)
                  }),
                )
              }
            }
            break
          }
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = search(messages, messageKey(event.properties.info), messageKey)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          // #162：本地缓存消息数阈值与 200 窗口对齐
          // #290：本地缓存窗口从 200 提升至 300，降低长会话过早截断风险
          if (updated.length > 300) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
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
          touchMessage(event.properties.sessionID, event.properties.messageID)
          const messages = store.message[event.properties.sessionID]
          const index = messages.findIndex((message) => message.id === event.properties.messageID)
          if (index !== -1) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          // #98：隐藏部件先记入 hydration，再从 store 移除。
          const part = event.properties.part
          if ((part as Record<string, unknown>).hidden) {
            touchPart(part.sessionID, part.id)
            const parts = store.part[part.messageID]
            if (!parts) break
            const foundAt = search(parts, part.id, (p) => p.id)
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
          touchPart(event.properties.part.sessionID, event.properties.part.id)
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = search(parts, event.properties.part.id, (part) => part.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          // #186：进入队列合并，applyPartDelta 内仍走 #157 raw 路径
          // #186：此处禁止直接 setStore，否则绕过 coalesce 失去批处理收益
          enqueuePartDelta(event)
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          const result = search(parts, event.properties.partID, (part) => part.id)
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
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
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
      // #186：卸载时丢弃未 flush 队列，避免定时器写已销毁 store
      // #186：不在 cleanup 里 flush——组件已拆，UI 不再需要最后一帧
      if (pendingPartDeltaTimer) clearTimeout(pendingPartDeltaTimer)
      pendingPartDeltas = []
      loggedPartDeltaApplications.clear()
    })

    const args = useArgs()

    // #153：session_status 独立刷新，force sync 与 bootstrap 共用同一入口
    // #192：快照按 session 建表，供后续增量 update 提供二分查找的排序不变式
    function pendingRequestsBySession<T extends { id: string; sessionID: string }>(requests: T[]) { return requests.toSorted((a, b) => a.id.localeCompare(b.id)).reduce<Record<string, T[]>>((result, request) => { ;(result[request.sessionID] ??= []).push(request); return result }, {}) }
    function pendingRequestChangeKey(sessionID: string, requestID: string) { return `${sessionID}\0${requestID}` }
    // #192：merge live changes 防 stale 覆盖
    // #192：快照整体替换负责丢弃断线期间已解决的 blocker，live changes 只回放本地确认的变更
    function pendingRequestsWithLiveChanges<T extends { id: string; sessionID: string }>(snapshot: Record<string, T[]>, current: Record<string, T[]>, changes: Map<string, { sessionID: string; requestID: string; version: number }>, since: number) {
      const result = Object.fromEntries(Object.entries(snapshot).map(([sessionID, requests]) => [sessionID, [...requests]])) as Record<string, T[]>
      for (const change of changes.values()) {
        if (change.version <= since) continue
          // #192：版本号小于快照起始的变更已被快照包含，跳过避免重复回放
        const currentRequests = current[change.sessionID]
        if (!currentRequests) { removePendingRequest(result, change.sessionID, change.requestID); continue }
          // #192：当前 store 已无该请求说明已解决，快照中对应项也应清除
        const currentMatch = search(currentRequests, change.requestID, (request) => request.id)
        if (!currentMatch.found) { removePendingRequest(result, change.sessionID, change.requestID); continue }
          // #192：变更指向的请求在 store 中不存在时同样从快照结果移除
        const requests = result[change.sessionID] ?? []
        const match = search(requests, change.requestID, (request) => request.id)
        if (match.found) { requests[match.index] = currentRequests[currentMatch.index] } else { requests.splice(match.index, 0, currentRequests[currentMatch.index]) }
        result[change.sessionID] = requests
      }
      return result
    }
    function removePendingRequest<T extends { id: string }>(requestsBySession: Record<string, T[]>, sessionID: string, id: string) {
      const requests = requestsBySession[sessionID]
      if (!requests) return
      const match = search(requests, id, (request) => request.id)
      if (!match.found) return
      const next = requests.toSpliced(match.index, 1)
      if (next.length === 0) { delete requestsBySession[sessionID]; return }
      requestsBySession[sessionID] = next
    }
    // #192：permission 变更记录在本地增量表，重连快照恢复后据此回放
    // #192：permissionVersion 是本地单调计数，快照恢复时仅回放版本号更新的变更
    // #192：快照恢复以版本号为界：变更版本高于快照起始才回放，保证不丢不重
    function markPermissionRequestChange(sessionID: string, requestID: string) { permissionVersion += 1; if (permissionRefreshes === 0) return; permissionChanges.set(pendingRequestChangeKey(sessionID, requestID), { sessionID, requestID, version: permissionVersion }) }
    // #192：question 变更与 permission 同走增量表，保证两类 blocker 一致恢复
    // #192：questionVersion 与 permission 同规则，保证两类请求恢复一致
    function markQuestionRequestChange(sessionID: string, requestID: string) { questionVersion += 1; if (questionRefreshes === 0) return; questionChanges.set(pendingRequestChangeKey(sessionID, requestID), { sessionID, requestID, version: questionVersion }) }
    // #192：refreshVersion 是请求计数，仅最新 reconnect 的响应写 store，乱序返回被丢弃
    // #192：permission 快照恢复与本地变更回放合并，是重连后 store 重建的完整路径
    // #192：快照整体替换后由本地变更表决定保留哪些请求，阻断期解决的 blocker 不再回放，live changes 只回放本地确认的变更
    async function refreshPermissionRequests(workspace: string | undefined) {
      const version = permissionVersion; const refreshVersion = permissionRefreshVersion + 1; permissionRefreshVersion = refreshVersion; permissionRefreshes += 1
      try { const response = await sdk.client.permission.list({ workspace }); if (refreshVersion !== permissionRefreshVersion) return; setStore("permission", reconcile(pendingRequestsWithLiveChanges(pendingRequestsBySession(response.data ?? []), store.permission, permissionChanges, version))) }
      // #192：竞态守卫比对刷新时的版本号，旧响应即使后到也不覆盖新快照
      finally { permissionRefreshes -= 1; if (permissionRefreshes === 0) permissionChanges.clear() }
    }
    // #192：question 与 permission 共用同一快照替换+live merge 规则，保证两类请求恢复一致
    async function refreshQuestionRequests(workspace: string | undefined) {
      const version = questionVersion; const refreshVersion = questionRefreshVersion + 1; questionRefreshVersion = refreshVersion; questionRefreshes += 1
      try { const response = await sdk.client.question.list({ workspace }); if (refreshVersion !== questionRefreshVersion) return; setStore("question", reconcile(pendingRequestsWithLiveChanges(pendingRequestsBySession(response.data ?? []), store.question, questionChanges, version))) }
      finally { questionRefreshes -= 1; if (questionRefreshes === 0) questionChanges.clear() }
    }

    async function refreshStatus() {
      // 失败随 bootstrap 的 Effect.all 语义上抛，与其他首次拉取保持一致的致命性
      const x = await sdk.client.session.status({ workspace: project.workspace.current() })
      // reconcile 保持增量更新，避免全量替换导致订阅组件失去局部状态
      setStore("session_status", reconcile(x.data ?? {}))
    }

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const capabilitiesPromise = sdk.client.experimental.capabilities
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => undefined)
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      await Promise.all([
        providersPromise,
        providerListPromise,
        capabilitiesPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const capabilitiesResponse = capabilitiesPromise
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            capabilitiesResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const capabilities = responses[2]
            const consoleState = responses[3]
            const agents = responses[4]
            const config = responses[5]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("capabilities", "experimentalBackgroundSubagents", capabilities?.backgroundSubagents === true)
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            // #153：bootstrap 以同一入口拉取 status，替代原先内联的实现
            refreshStatus(),
            // #192：refresh 拉取快照后回放本地变更，pending 请求在 store 中重建
            refreshPermissionRequests(workspace),
            refreshQuestionRequests(workspace),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          console.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            exit(e)
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
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          await listSessions()
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
          // #132：force 忽略 fullSynced 缓存
          if (!options?.force && fullSyncedSessions.has(sessionID)) return
          while (syncingSessions.has(sessionID)) {
            if (!options?.force) return syncingSessions.get(sessionID)
            // #132：重连等旧请求收尾并重查 owner，再取新快照，避免并发覆盖 tracker。
            // #132：旧请求失败仍需补读；仅忽略旧失败，新快照错误照常传出。
            await syncingSessions.get(sessionID)!.catch(() => undefined)
          }
          // 请求开始前结清旧窗；之后到达的片段才属于本次 hydration tracker。
          flushPartDeltas()
          const tracker = { messages: new Set<string>(), parts: new Set<string>(), session: undefined }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const [session, messages, todo, diff] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              // #162：会话消息拉取窗口扩至 200，降低长会话过早截断
              // #290：会话消息拉取窗口同步提升至 300，与本地缓存窗口对齐
              sdk.client.session.messages({ sessionID, limit: 300 }),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.diff({ sessionID }),
              // #153：force sync 同时刷新 status，避免 diff 已更新而 busy 状态过期
              sdk.client.session.status({ workspace: project.workspace.current() })
                .then((x) => setStore("session_status", reconcile(x.data ?? {}))),
            ])
            // 先应用排队片段并标记 touched，再让快照仲裁，避免同一文本被追加两次。
            flushPartDeltas()
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                // 全量事件优先；只有 moved 时仍接收 HTTP 必需字段，再叠加最新 placement。
                const info = acceptSession(session.data!, tracker)
                if (info) {
                  if (match.found) draft.session[match.index] = info
                  if (!match.found) draft.session.splice(match.index, 0, info)
                }
                draft.todo[sessionID] = todo.data ?? []
                const currentMessages = draft.message[sessionID] ?? []
                const infos = (messages.data ?? []).flatMap((message) => {
                  if (!tracker.messages.has(message.info.id)) return [message.info]
                  const current = currentMessages.find((item) => item.id === message.info.id)
                  return current ? [current] : []
                })
                infos.push(
                  ...currentMessages.filter(
                    (message) => tracker.messages.has(message.id) && !infos.some((item) => item.id === message.id),
                  ),
                )
                infos.sort(compareMessage)
                // #162：裁掉窗口外旧消息，保留最近 200
                // #290：可见切片随 limit 同步 300——缓存阈值/拉取 limit/可见切片三处对齐，缺一即无谓丢弃
                const removed = infos.slice(0, -300)
                // #162：可见消息切片与 hydrate limit 一致
                const visible = infos.slice(-300)
                const visibleIDs = new Set(visible.map((message) => message.id))
                for (const message of messages.data ?? []) {
                  if (!visibleIDs.has(message.info.id)) {
                    delete draft.part[message.info.id]
                    continue
                  }
                  const currentParts = draft.part[message.info.id] ?? []
                  const parts = message.parts.flatMap((part) => {
                    const current = currentParts.find((item) => item.id === part.id)
                    if (tracker.parts.has(part.id)) return current ? [current] : []
                    if (
                      current &&
                      (part.type === "text" || part.type === "reasoning") &&
                      (current.type === "text" || current.type === "reasoning") &&
                      part.text.length === 0 &&
                      current.text.length > 0
                    ) {
                      return [current]
                    }
                    return [part]
                  })
                  parts.push(
                    ...currentParts.filter(
                      (part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id),
                    ),
                  )
                  draft.part[message.info.id] = parts
                }
                for (const message of removed) delete draft.part[message.id]
                draft.message[sessionID] = visible
                draft.session_diff[sessionID] = diff.data ?? []
              }),
            )
            fullSyncedSessions.add(sessionID)
          })().finally(() => {
            syncingSessions.delete(sessionID)
            hydratingSessions.delete(sessionID)
          })
          syncingSessions.set(sessionID, task)
          return task
        },
      },
      sessionStatus: { refresh: refreshStatus },
      bootstrap,
    }
    return result
  },
})
