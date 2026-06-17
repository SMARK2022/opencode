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
  SnapshotFileDiff,
  ConsoleState,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onCleanup, onMount } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { logPartDeltaTiming, partDeltaTimingKey, PART_DELTA_TIMING_LIMIT } from "./stream-timing"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

const DisposedReason = {
  DaemonStop: "daemon-stop",
} as const
const SESSION_MESSAGE_WINDOW = 100

function sessionPathRelative(worktree: string, directory: string) {
  const resolvedDirectory = path.resolve(directory)
  if (process.platform === "win32" && (worktree === "/" || worktree === "\\")) {
    return resolvedDirectory.replaceAll("\\", "/")
  }
  return path.relative(path.resolve(worktree), resolvedDirectory).replaceAll("\\", "/")
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

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
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
    // [local-smark] daemon multi-instance workspace tracking
    let connectedOnce = false
    // [重连快照版本] 这些计数只描述 TUI 本地 store，不是 daemon 版本号；
    // 用来让重连快照清理 stale blocker，同时保留 list 发出后到达的 SSE 变更。
    let permissionVersion = 0
    let questionVersion = 0
    let permissionRefreshes = 0
    let questionRefreshes = 0
    let permissionRefreshVersion = 0
    let questionRefreshVersion = 0
    const permissionChanges = new Map<string, { sessionID: string; requestID: string; version: number }>()
    const questionChanges = new Map<string, { sessionID: string; requestID: string; version: number }>()
    let pendingPartDeltas: EventMessagePartDelta[] = []
    let pendingPartDeltaTimer: Timer | undefined
    const loggedPartDeltaApplications = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    const hydratingSessions = new Map<string, { messages: Set<string>; parts: Set<string> }>()
    const touchMessage = (sessionID: string, messageID: string) => {
      hydratingSessions.get(sessionID)?.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

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
        logPartDeltaApplication(event, "delta.drop", "missing-message")
        return
      }
      const result = search(parts, event.properties.partID, (p) => p.id)
      if (!result.found) {
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
        path: sessionPathRelative(project.data.instance.path.worktree, project.data.instance.path.directory),
      }
    }

    function listSessions() {
      return sdk.client.session
        .list({ start: Date.now() - 90 * 24 * 60 * 60 * 1000, limit: 1200, ...sessionListQuery() })
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
        const currentMatch = search(currentRequests, change.requestID, (request) => request.id)
        if (!currentMatch.found) {
          removePendingRequest(result, change.sessionID, change.requestID)
          continue
        }
        const requests = result[change.sessionID] ?? []
        const match = search(requests, change.requestID, (request) => request.id)
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
      const match = search(requests, id, (request) => request.id)
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
          if (daemonStopReason(event) !== DisposedReason.DaemonStop) break
          daemonStopSeen = true
          exit.message.set("opencode daemon stopped.")
          void exit()
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
          markQuestionRequestChange(event.properties.sessionID, event.properties.requestID)
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
          const info = event.properties.info
          touchMessage(info.sessionID, info.id)
          if ((info as Record<string, unknown>).hidden) {
            const messages = store.message[info.sessionID]
            if (!messages) break
            const result = search(messages, info.id, (m) => m.id)
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
          const result = search(messages, info.id, (m) => m.id)
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
          if (updated.length > SESSION_MESSAGE_WINDOW) {
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
          touchMessage(event.properties.sessionID, event.properties.messageID)
          const messages = store.message[event.properties.sessionID]
          const result = search(messages, event.properties.messageID, (m) => m.id)
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
        case "message.part.updated": {
          const part = event.properties.part
          touchPart(part.sessionID, part.id)
          if ((part as Record<string, unknown>).hidden) {
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
          const parts = store.part[part.messageID]
          if (!parts) {
            setStore("part", part.messageID, [part])
            break
          }
          const result = search(parts, part.id, (p) => p.id)
          if (result.found) {
            setStore("part", part.messageID, result.index, reconcile(part))
            break
          }
          setStore(
            "part",
            part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, part)
            }),
          )
          break
        }

        case "message.part.delta": {
          enqueuePartDelta(event)
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          const result = search(parts, event.properties.partID, (p) => p.id)
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
      if (pendingPartDeltaTimer) clearTimeout(pendingPartDeltaTimer)
      pendingPartDeltas = []
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
      await Promise.all([
        providersPromise,
        providerListPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
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
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
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
          const syncing = syncingSessions.get(sessionID)
          if (syncing && !options?.force) return syncing
          const tracker = { messages: new Set<string>(), parts: new Set<string>() }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const [session, messages, todo, diff, status] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              sdk.client.session.messages({ sessionID, limit: SESSION_MESSAGE_WINDOW }),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.diff({ sessionID }),
              sdk.client.session.status({ workspace: project.workspace.current() }),
            ])
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                if (match.found) draft.session[match.index] = session.data!
                if (!match.found) draft.session.splice(match.index, 0, session.data!)
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
                const removed = infos.slice(0, -SESSION_MESSAGE_WINDOW)
                const visible = infos.slice(-SESSION_MESSAGE_WINDOW)
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
            setStore("session_status", reconcile(status.data ?? {}))
            fullSyncedSessions.add(sessionID)
          })().finally(() => {
            syncingSessions.delete(sessionID)
            hydratingSessions.delete(sessionID)
          })
          syncingSessions.set(sessionID, task)
          return task
        },
      },
      sessionStatus: {
        refresh: refreshStatus,
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
