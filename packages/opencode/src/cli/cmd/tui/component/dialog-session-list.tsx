import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js"
import { Locale } from "@/util/locale"
import { useProject } from "@tui/context/project"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { Flag } from "@opencode-ai/core/flag/flag"
import { DialogSessionRename } from "./dialog-session-rename"
import { createDebouncedSignal } from "../util/signal"
import { useToast } from "../ui/toast"
import { openWorkspaceSelect, type WorkspaceSelection, warpWorkspaceSession } from "./dialog-workspace-create"
import { Spinner } from "./spinner"
import { errorMessage } from "@/util/error"
import { DialogSessionDeleteFailed } from "./dialog-session-delete-failed"
import { WorkspaceLabel } from "./workspace-label"
import { useCommandShortcut } from "../keymap"
import {
  appendScanHits,
  isSessionSearchLoading,
  resolveDisplayHits,
  resolveProgressiveSessionListSource,
  sessionListEmptyLabel,
  shouldStopSearchScan,
  SESSION_LIST_CONTENT_BATCH,
  SESSION_LIST_CONTENT_DELAY_MS,
  SESSION_LIST_LOOKBACK_MS,
  SESSION_LIST_SEARCH_LIMIT,
  type SearchPhase,
} from "@tui/util/session-list-params"

type WorkspaceStatus = "connected" | "connecting" | "disconnected" | "error"

const SESSION_LIST_PREVIEW_LINES = 2
const SESSION_LIST_PREVIEW_SESSION_LIMIT = 400

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const project = useProject()
  const { theme } = useTheme()
  const sdk = useSDK()
  const local = useLocal()
  const toast = useToast()
  const [toDelete, setToDelete] = createSignal<string>()
  const [search, setSearch] = createDebouncedSignal("", 150)
  // [local-smark] Session list preview functionality
  const [previews, setPreviews] = createSignal<Record<string, string[]>>({})
  // progressive search 状态：generation 与 Abort 绑定 committed query
  const [searchPhase, setSearchPhase] = createSignal<SearchPhase | undefined>()
  // success complete 只信 scan；error complete 保留 title∪scan（INV-12 已展示 hits）
  const [searchTerminal, setSearchTerminal] = createSignal<"success" | "error" | undefined>()
  const [titleHits, setTitleHits] = createSignal<NonNullable<typeof sync.data.session>>([])
  const [scanFullHits, setScanFullHits] = createSignal<NonNullable<typeof sync.data.session>>([])
  let searchGeneration = 0
  let searchController: AbortController | undefined

  type SessionHit = (typeof sync.data.session)[number]

  // 与 Path A browse 相同 start/scope，保证 progressive 候选宇宙一致
  function sessionListScopeParams() {
    return {
      start: Date.now() - SESSION_LIST_LOOKBACK_MS,
      ...sync.session.query(),
    }
  }

  // POST/手写 GET 都需 directory query，workspace routing 才能定位实例
  function directoryQuery(url: URL) {
    const dir = sync.path.directory || sdk.directory
    if (dir) url.searchParams.set("directory", dir)
  }

  /**
   * progressive Path B 主路径（R3）：
   * 1) title-only GET 首屏（子集，可漏跨字段 multi-token）
   * 2) contentDelay 后再串行 POST /session/search/scan
   * 3) complete 权威集合 = scanFullHits，与 list 全条件 top-400 对齐
   * generation+Abort 保证改词/清空时丢弃过期响应。
   */
  async function runProgressiveSearch(query: string, generation: number, signal: AbortSignal) {
    const scope = sessionListScopeParams()
    setSearchPhase("awaiting_first")
    setSearchTerminal(undefined)
    setTitleHits([])
    setScanFullHits([])

    try {
      // B1：手写 GET，gen SDK 无 searchMode 字段（INV-11）
      const titleUrl = new URL("/session", sdk.url)
      directoryQuery(titleUrl)
      titleUrl.searchParams.set("search", query)
      titleUrl.searchParams.set("searchMode", "title")
      titleUrl.searchParams.set("start", String(scope.start))
      titleUrl.searchParams.set("limit", String(SESSION_LIST_SEARCH_LIMIT))
      if (scope.scope) titleUrl.searchParams.set("scope", scope.scope)
      if (scope.path) titleUrl.searchParams.set("path", scope.path)
      if ("directory" in scope && scope.directory) titleUrl.searchParams.set("directory", scope.directory)

      const titleRes = await sdk.fetch(titleUrl, { method: "GET", signal })
      if (signal.aborted || generation !== searchGeneration) return
      if (titleRes.ok) {
        const titleData = (await titleRes.json()) as SessionHit[]
        if (signal.aborted || generation !== searchGeneration) return
        setTitleHits(Array.isArray(titleData) ? titleData : [])
      }
      setSearchPhase("partial")

      // contentDelay：输入 debounce 之后再等一截，慢打时少发过期 scan
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, SESSION_LIST_CONTENT_DELAY_MS)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new DOMException("Aborted", "AbortError"))
        }
        if (signal.aborted) return onAbort()
        signal.addEventListener("abort", onAbort, { once: true })
      })
      if (signal.aborted || generation !== searchGeneration) return

      // B2：串行 keyset scan；early-stop 只数 scanFullHits
      let cursor: { time_updated: number; id: string } | null = null
      let scanHits: SessionHit[] = []
      for (;;) {
        if (signal.aborted || generation !== searchGeneration) return
        if (shouldStopSearchScan(scanHits.length)) break

        const scanUrl = new URL("/session/search/scan", sdk.url)
        directoryQuery(scanUrl)
        const body = {
          search: query,
          cursor: cursor ?? undefined,
          batch: SESSION_LIST_CONTENT_BATCH,
          start: scope.start,
          scope: scope.scope,
          path: scope.path,
          directory: "directory" in scope ? scope.directory : undefined,
        }
        const scanRes = await sdk.fetch(scanUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        })
        // 每批结束后再检查 generation，防止慢响应写回已过期 query
        if (signal.aborted || generation !== searchGeneration) return
        // 非 2xx：标记 error 终态并退出；保留已展示 title/scan hits
        if (!scanRes.ok) {
          if (signal.aborted || generation !== searchGeneration) return
          setSearchTerminal("error")
          setSearchPhase("complete")
          return
        }
        const page = (await scanRes.json()) as {
          sessions: SessionHit[]
          nextCursor: { time_updated: number; id: string } | null
          done: boolean
        }
        if (signal.aborted || generation !== searchGeneration) return
        // 只累积 full-condition 命中；title overlay 不在此写入
        scanHits = appendScanHits(scanHits, page.sessions ?? [])
        setScanFullHits(scanHits)
        setSearchPhase("partial")
        // done 或无 nextCursor：候选宇宙扫尽
        if (page.done || !page.nextCursor) break
        cursor = page.nextCursor
      }

      if (signal.aborted || generation !== searchGeneration) return
      // 成功 complete：权威集合仅为 scanFullHits（INV-09）
      setSearchTerminal("success")
      setSearchPhase("complete")
    } catch {
      // abort 不改 UI；网络失败则 complete+error，保留 title∪scan，禁止 fallback all
      if (signal.aborted || generation !== searchGeneration) return
      setSearchTerminal("error")
      setSearchPhase("complete")
    }
  }

  // committed query 变化：清空/改词都 abort 上一代；空串回到 browse 且无 Spinner
  createEffect(
    on(
      () => search(),
      (query) => {
        searchController?.abort()
        if (!query) {
          searchGeneration += 1
          searchController = undefined
          setSearchPhase(undefined)
          setSearchTerminal(undefined)
          setTitleHits([])
          setScanFullHits([])
          return
        }
        // 新 generation 立即丢弃旧 hits，避免 C→CJ 串味
        const generation = ++searchGeneration
        const controller = new AbortController()
        searchController = controller
        onCleanup(() => controller.abort())
        void runProgressiveSearch(query, generation, controller.signal)
      },
    ),
  )

  // [local-smark] session list preview: 批量获取预览文本
  createEffect(
    on(
      () => sessions(),
      (currentSessions) => {
        if (SESSION_LIST_PREVIEW_LINES <= 0) return

        const ids = currentSessions
          .slice(0, SESSION_LIST_PREVIEW_SESSION_LIMIT)
          .map((s) => s.id)
        if (ids.length === 0) return

        const controller = new AbortController()
        onCleanup(() => controller.abort())

        void (async () => {
          try {
            const url = new URL("/session/preview", sdk.url)
            directoryQuery(url)

            const res = await sdk.fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionIDs: ids, limit: SESSION_LIST_PREVIEW_LINES }),
              signal: controller.signal,
            })
            if (!res.ok) return
            const data = (await res.json()) as Record<string, string[]>
            if (!controller.signal.aborted) {
              setPreviews(data)
            }
          } catch {
            // 预览加载失败不阻塞 session list 显示
          }
        })()
      },
    ),
  )
  // [upstream] Command shortcuts for session management
  const deleteHint = useCommandShortcut("session.delete")
  const quickSwitch1 = useCommandShortcut("session.quick_switch.1")
  const quickSwitch9 = useCommandShortcut("session.quick_switch.9")

  // 删除后重跑当前 query 的 progressive generation，等价旧 createResource.refetch
  function refetchSearch() {
    const query = search()
    if (!query) return
    searchController?.abort()
    const generation = ++searchGeneration
    const controller = new AbortController()
    searchController = controller
    void runProgressiveSearch(query, generation, controller.signal)
  }

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const displayHits = createMemo(() =>
    resolveDisplayHits({
      phase: searchPhase(),
      terminal: searchTerminal(),
      titleHits: titleHits(),
      scanFullHits: scanFullHits(),
    }),
  )
  const listSource = createMemo(() =>
    resolveProgressiveSessionListSource({
      query: search(),
      phase: searchPhase(),
      hits: displayHits(),
      browse: sync.data.session,
    }),
  )
  const sessions = createMemo(() => listSource().sessions)
  const searching = createMemo(() => isSessionSearchLoading(search(), searchPhase()))

  function recover(session: NonNullable<ReturnType<typeof sessions>[number]>) {
    const workspace = project.workspace.get(session.workspaceID!)
    const list = () => dialog.replace(() => <DialogSessionList />)
    const warp = async (selection: WorkspaceSelection) => {
      const workspaceID = await (async () => {
        if (selection.type === "none") return null
        if (selection.type === "existing") return selection.workspaceID
        const result = await sdk.client.experimental.workspace
          .create({ type: selection.workspaceType, branch: null })
          .catch(() => undefined)
        const workspace = result?.data
        if (!workspace) {
          toast.show({
            message: `Failed to create workspace: ${errorMessage(result?.error ?? "no response")}`,
            variant: "error",
          })
          return
        }
        await project.workspace.sync()
        return workspace.id
      })()
      if (workspaceID === undefined) return
      await warpWorkspaceSession({
        dialog,
        sdk,
        sync,
        project,
        toast,
        sourceWorkspaceID: session.workspaceID,
        workspaceID,
        sessionID: session.id,
        copyChanges: false,
        done: list,
      })
    }
    dialog.replace(() => (
      <DialogSessionDeleteFailed
        session={session.title}
        workspace={workspace?.name ?? session.workspaceID!}
        onDone={list}
        onDelete={async () => {
          const current = currentSessionID()
          const info = current ? sync.data.session.find((item) => item.id === current) : undefined
          const result = await sdk.client.experimental.workspace.remove({ id: session.workspaceID! })
          if (result.error) {
            toast.show({
              variant: "error",
              title: "Failed to delete workspace",
              message: errorMessage(result.error),
            })
            return false
          }
          await project.workspace.sync()
          await sync.session.refresh()
          if (search()) refetchSearch()
          if (info?.workspaceID === session.workspaceID) {
            route.navigate({ type: "home" })
          }
          return true
        }}
        onRestore={() => {
          void openWorkspaceSelect({
            dialog,
            sdk,
            sync,
            project,
            toast,
            onSelect: (selection) => {
              void warp(selection)
            },
          })
          return false
        }}
      />
    ))
  }

  function orderByRecency(sessionsList: NonNullable<ReturnType<typeof sessions>>) {
    return sessionsList
      .filter((x) => x.parentID === undefined)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .map((x) => x.id)
  }

  const [browseOrder] = createSignal<string[]>(orderByRecency(sync.data.session))

  const quickSwitchHint = createMemo(() => {
    const first = quickSwitch1()
    const last = quickSwitch9()
    if (!first || !last) return undefined
    return quickSwitchRange(first, last)
  })
  const quickSwitchFooterHints = createMemo(() => {
    const hint = quickSwitchHint()
    return hint && local.session.slots().length > 0 ? [{ title: "switch", label: hint }] : []
  })

  const options = createMemo(() => {
    const today = new Date().toDateString()
    const sessionMap = new Map(
      sessions()
        .filter((x) => x.parentID === undefined)
        .map((x) => [x.id, x]),
    )

    // 展示顺序与数据源同源：搜索中不用 stale searchResults 真值误判
    const displayOrder = listSource().source === "search" ? orderByRecency(sessions()) : browseOrder()

    const pinned = local.session.pinned().filter((id) => sessionMap.has(id))
    const pinnedSet = new Set(pinned)
    const slotByID = new Map<string, number>(local.session.slots().map((id, i) => [id, i + 1]))

    function buildOption(id: string, category: string) {
      const x = sessionMap.get(id)
      if (!x) return undefined
      const workspace = x.workspaceID ? project.workspace.get(x.workspaceID) : undefined

      let footer: JSX.Element | string = ""
      if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
        if (x.workspaceID) {
          footer = workspace ? (
            <WorkspaceLabel
              type={workspace.type}
              name={workspace.name}
              status={project.workspace.status(x.workspaceID) ?? "error"}
            />
          ) : (
            <WorkspaceLabel type="unknown" name={x.workspaceID} status="error" />
          )
        }
      } else {
        footer = Locale.time(x.time.updated)
      }

      const isDeleting = toDelete() === x.id
      const status = sync.data.session_status?.[x.id]
      const isWorking = status?.type === "busy" || status?.type === "retry"
      const slot = slotByID.get(x.id)
      const gutter = isWorking
        ? () => <Spinner />
        : slot !== undefined
          ? () => <text fg={theme.accent}>{slot}</text>
          : undefined
      return {
        title: isDeleting ? `Press ${deleteHint()} again to confirm` : x.title,
        bg: isDeleting ? theme.error : undefined,
        value: x.id,
        category,
        footer,
        gutter,
        // [local-smark] session list preview
        previewLines: previews()[x.id],
      }
    }

    const remaining = displayOrder
      .filter((id) => !pinnedSet.has(id))
      .map((id) => {
        const x = sessionMap.get(id)
        if (!x) return undefined
        const label = new Date(x.time.updated).toDateString()
        return buildOption(id, label === today ? "Today" : label)
      })
      .filter((x) => x !== undefined)

    return [...pinned.map((id) => buildOption(id, "Pinned")).filter((x) => x !== undefined), ...remaining]
  })

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title="Sessions"
      options={options()}
      skipFilter={true}
      empty={sessionListEmptyLabel(search(), searchPhase())}
      // loading（含 partial）时搜索栏右侧转圈，直至 complete
      filterAccessory={searching() ? <Spinner /> : undefined}
      current={currentSessionID()}
      onFilter={setSearch}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        route.navigate({
          type: "session",
          sessionID: option.value,
        })
        dialog.clear()
      }}
      actions={[
        {
          command: "session.pin.toggle",
          title: "pin/unpin",
          onTrigger: (option: { value: string }) => {
            local.session.togglePin(option.value)
          },
        },
        {
          command: "session.delete",
          title: "delete",
          onTrigger: async (option) => {
            if (toDelete() === option.value) {
              const session = sessions().find((item) => item.id === option.value)
              const status = session?.workspaceID ? project.workspace.status(session.workspaceID) : undefined

              try {
                const result = await sdk.client.session.delete({
                  sessionID: option.value,
                })
                if (result.error) {
                  if (session?.workspaceID) {
                    recover(session)
                  } else {
                    toast.show({
                      variant: "error",
                      title: "Failed to delete session",
                      message: errorMessage(result.error),
                    })
                  }
                  setToDelete(undefined)
                  return
                }
              } catch (err) {
                if (session?.workspaceID) {
                  recover(session)
                } else {
                  toast.show({
                    variant: "error",
                    title: "Failed to delete session",
                    message: errorMessage(err),
                  })
                }
                setToDelete(undefined)
                return
              }
              if (status && status !== "connected") {
                await sync.session.refresh()
              }
              if (search()) refetchSearch()
              setToDelete(undefined)
              return
            }
            setToDelete(option.value)
          },
        },
        {
          command: "session.rename",
          title: "rename",
          onTrigger: async (option) => {
            dialog.replace(() => <DialogSessionRename session={option.value} />)
          },
        },
      ]}
      footerHints={quickSwitchFooterHints()}
    />
  )
}

function quickSwitchRange(first: string, last: string) {
  const prefix = first.slice(0, -1)
  if (first.endsWith("1") && last === `${prefix}9`) return `${prefix}1-9`
  return `${first} through ${last}`
}
