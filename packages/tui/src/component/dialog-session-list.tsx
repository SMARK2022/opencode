import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js"
import path from "path"
import { Locale } from "../util/locale"
import { useProject } from "../context/project"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { DialogSessionRename } from "./dialog-session-rename"
import { createDebouncedSignal } from "../util/signal"
import { useToast } from "../ui/toast"
import { openWorkspaceSelect, type WorkspaceSelection, warpWorkspaceSession } from "./dialog-workspace-create"
import { Spinner } from "./spinner"
import { errorMessage } from "../util/error"
import { DialogSessionDeleteFailed } from "./dialog-session-delete-failed"
import { useCommandShortcut } from "../keymap"
import { useEvent } from "../context/event"
import {
  appendScanHits,
  isSessionSearchLoading,
  resolveDisplayHits,
  resolveProgressiveSessionListSource,
  sessionListEmptyLabel,
  shouldStopSearchScan,
  SESSION_LIST_CONTENT_BATCH,
  SESSION_LIST_CONTENT_DELAY_MS,
  SESSION_LIST_BROWSE_LIMIT,
  SESSION_LIST_LOOKBACK_MS,
  SESSION_LIST_SEARCH_LIMIT,
  type SearchPhase,
} from "../util/session-list-params"

type SessionListFilter = { directory?: string; scope?: "project"; path?: string }

export function createDialogSessionListQuery(input: { search?: string; filter: SessionListFilter }) {
  const search = input.search?.trim()
  return {
    roots: true,
    // #306：仅搜索限制时间窗；默认浏览仍能访问更早会话，不能共享搜索的时间过滤。
    // #529：搜索与后台缓存共享半年窗；搜索400、默认浏览1600，仍保留浏览无start。
    ...(search
      ? { start: Date.now() - SESSION_LIST_LOOKBACK_MS, limit: SESSION_LIST_SEARCH_LIMIT }
      : { limit: SESSION_LIST_BROWSE_LIMIT }),
    ...(search ? { search } : {}),
    ...input.filter,
  }
}

export function loadDialogSessionList<T>(input: {
  search?: string
  filter: SessionListFilter
  list: (query: ReturnType<typeof createDialogSessionListQuery>) => Promise<{ data?: T[] }>
}) {
  return input.list(createDialogSessionListQuery(input)).then(
    (result) => result.data,
    () => undefined,
  )
}

export function matchesDialogSessionSearch(
  session: { id: string; title: string },
  query: string,
  results?: { id: string }[],
) {
  // 服务端命中也可能来自正文；只对额外附加的会话保留标题过滤。
  return !query || results?.some((item) => item.id === session.id) || session.title.toLowerCase().includes(query)
}

// #115：会话列表预览默认 2 行
const SESSION_LIST_PREVIEW_LINES = 2

// #529：服务端搜索是唯一判定权威，客户端不二次过滤服务端返回集（源 plan 禁重复过滤）；
// token 过滤只作用于本地注入的 extra 行（当前会话+置顶），保留上游对注入行的 title 收窄行为。
// 跨字段命中（title 含 alpha、content 含 beta）必须直接可见——否则多词交集在显示面退化为 title 内 AND。
export function visibleSessions<T extends { id: string; title: string }>(input: {
  result: T[]
  extra: T[]
  deleted: Set<string>
  query: string
}): T[] {
  const tokens = input.query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  // extra 与服务端同词法（分词 + AND）：注入行与返回集的命中口径不因来源不同而分叉
  return [
    ...input.result,
    ...input.extra.filter((session) => tokens.every((token) => matchesDialogSessionSearch(session, token))),
  ].filter((session) => !input.deleted.has(session.id))
  // 注：deleted 排除对两源一致生效——会话删除后服务端缓存与本地注入都不再出现
}
// #120：同时预加载预览的会话数上限
// #306：预览上限从 50 提到 400，预览覆盖更完整，避免滚动时再触发补拉。
// #366：预览内容由批量端点一次性返回，本文件不再分页拉取/解析消息 parts。
const SESSION_LIST_PREVIEW_SESSION_LIMIT = 400

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const project = useProject()
  const { theme } = useTheme()
  const sdk = useSDK()
  const event = useEvent()
  const local = useLocal()
  const toast = useToast()
  const [toDelete, setToDelete] = createSignal<string>()
  const [deleted, setDeleted] = createSignal(new Set<string>())
  const [rawSearch, setSearch] = createDebouncedSignal("", 150)
  // 与既有查询构造器同样归一空白，避免只含空格的输入启动全表扫描。
  const search = createMemo(() => rawSearch().trim())
  // #120：sessionID -> 多行用户消息预览（非单行再折词）
  const [previews, setPreviews] = createSignal<Record<string, string[]>>({})
  // #544 progressive search 状态：AbortSignal 是 committed query 的唯一过期事实。
  // #561 单轨收敛：改词/清空/卸载都只 abort 当前 controller，不再维护 generation 双轨。
  const [searchPhase, setSearchPhase] = createSignal<SearchPhase | undefined>()
  // success complete 只信 scan；error complete 保留 title∪scan（已展示 hits 不抹掉）
  // terminal 与 phase 分离：phase 驱动 Spinner/文案，terminal 决定 complete 的展示集合来源。
  const [searchTerminal, setSearchTerminal] = createSignal<"success" | "error" | undefined>()
  // title 首屏与 scan 权威流分开存：partial 需要 union 展示，complete 需要单选 scan。
  const [titleHits, setTitleHits] = createSignal<NonNullable<typeof sync.data.session>>([])
  const [scanFullHits, setScanFullHits] = createSignal<NonNullable<typeof sync.data.session>>([])
  // #561 disposed 防止 dialog.replace 后旧闭包仍启动 progressive search
  let disposed = false
  let searchController: AbortController | undefined
  // 删除后refetch也会更换controller，卸载必须取消最新请求而非只捕获初次搜索。
  onCleanup(() => {
    disposed = true
    searchController?.abort()
    searchController = undefined
  })

  // Hit 形状与 browse 同源（Session.Info）——visibleSessions/options 管道无需分支适配。
  type SessionHit = (typeof sync.data.session)[number]

  // 复用列表已有roots、时间窗与目录过滤，标题首屏和scan不能另建候选宇宙。
  function sessionListScopeParams(query: string) {
    return createDialogSessionListQuery({ search: query, filter: sync.session.query() })
  }

  // #544：POST/手写 GET 都需 directory query，workspace routing 才能定位实例
  function directoryQuery(url: URL) {
    // sync.path.directory 优先：workspace 子目录会话必须路由回其所属实例。
    // title/scan 共用同一 directory 解析：路由不一致会让两阶段命中不同实例。
    const dir = sync.path.directory || sdk.directory
    if (dir) url.searchParams.set("directory", dir)
  }

  /**
   * #544 progressive Path B 主路径：
   * 1) title-only GET 首屏（子集，可漏跨字段 multi-token）
   * 2) contentDelay 后再串行 POST /session/search/scan
   * 3) complete 权威集合 = scanFullHits，与 list 全条件 top-400 对齐
   * #561 AbortSignal 是唯一过期事实：改词/清空/卸载都 abort 当前 controller。
   */
  async function runProgressiveSearch(query: string, signal: AbortSignal) {
    const scope = sessionListScopeParams(query)
    // 起始即 awaiting_first：首个 title 响应到达前列表显示 Searching… 而非 Not Found。
    // 首行即清空旧代集合：新代不继承任何上代 hits，避免跨代串味。
    setSearchPhase("awaiting_first")
    setSearchTerminal(undefined)
    setTitleHits([])
    setScanFullHits([])

    try {
      // B1：手写 GET，gen SDK 无 searchMode 字段；返回是首屏子集，禁止当作 complete 权威集合
      const titleUrl = new URL("/session", sdk.url)
      directoryQuery(titleUrl)
      titleUrl.searchParams.set("search", query)
      titleUrl.searchParams.set("searchMode", "title")
      if ("start" in scope) titleUrl.searchParams.set("start", String(scope.start))
      titleUrl.searchParams.set("roots", String(scope.roots))
      titleUrl.searchParams.set("limit", String(SESSION_LIST_SEARCH_LIMIT))
      if (scope.scope) titleUrl.searchParams.set("scope", scope.scope)
      // 空 path 表示当前 worktree 根；省略它会让 title 与 scan 落入不同的会话宇宙。
      if (scope.path !== undefined) titleUrl.searchParams.set("path", scope.path)
      if ("directory" in scope && scope.directory) titleUrl.searchParams.set("directory", scope.directory)

      // limit 与 Path B 搜索上限同源：title 子集也被 cap 在 400，partial 展示不会超发。
      const titleRes = await sdk.fetch(titleUrl, { method: "GET", signal })
      // 唯一过期检查：controller abort 后 transport 可能仍解析响应。
      if (signal.aborted) return
      if (!titleRes.ok) {
        // #561 title 失败已经结束本代搜索，不能把失败伪装成 partial 再发起 scan。
        setSearchTerminal("error")
        setSearchPhase("complete")
        return
      }
      const titleData = (await titleRes.json()) as SessionHit[]
      if (signal.aborted) return
      // 非数组响应按空集处理：title 是增强首屏，坏响应不构成失败终态。
      setTitleHits(Array.isArray(titleData) ? titleData : [])
      // partial 阶段开始：title∪scan 并集展示，Spinner 仍在。
      setSearchPhase("partial")

      // contentDelay：输入 debounce 之后再等一截，慢打时少发过期 scan
      // #561 该等待处于 abort 守卫之下：改词后旧代的 timer 会随 Abort 立即失效。
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, SESSION_LIST_CONTENT_DELAY_MS)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new DOMException("Aborted", "AbortError"))
        }
        if (signal.aborted) return onAbort()
        signal.addEventListener("abort", onAbort, { once: true })
      })
      // 等待期被 abort 会以 AbortError 出走 catch，不进入 scan。
      if (signal.aborted) return

      // B2：串行 keyset scan——串行而非并发是为了 abort 即停与 SQLite 单写者压力。
      // early-stop 只数 scanFullHits：title 是子集查询，计入会让 complete 偏离 list top-400。
      let cursor: { time_updated: number; id: string } | null = null
      let scanHits: SessionHit[] = []
      for (;;) {
        // 循环顶也只认 abort：分页继续的唯一条件是当前 controller 仍存活。
        if (signal.aborted) return
        if (shouldStopSearchScan(scanHits.length)) break

        const scanUrl = new URL("/session/search/scan", sdk.url)
        // scan 端点恒定：分页状态只经 cursor 传递，不再用 URL 携带代次。
        directoryQuery(scanUrl)
        const body = {
          // start/scope/path 与 browse 同宇宙：候选窗不得引入第二套 scope 语义。
          search: query,
          cursor: cursor ?? undefined,
          batch: SESSION_LIST_CONTENT_BATCH,
          start: "start" in scope ? scope.start : undefined,
          roots: scope.roots,
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
        // #561 每批结束后再检查 abort，防止慢响应写回已过期 query
        if (signal.aborted) return
        // 非 2xx：标记 error 终态并退出；保留已展示 title/scan hits
        if (!scanRes.ok) {
          // 已展示 hits 不抹掉：error complete 的展示集合仍由 resolveDisplayHits 决定。
          setSearchTerminal("error")
          setSearchPhase("complete")
          return
        }
        // 页体解析失败会以异常进入 catch——与网络失败同一 error 终态。
        const page = (await scanRes.json()) as {
          sessions: SessionHit[]
          nextCursor: { time_updated: number; id: string } | null
          done: boolean
        }
        if (signal.aborted) return
        // 只累积 full-condition 命中；title overlay 不在此写入
        // append 去重并保序：scan 页本身按 recency 返回，cap 截断即 early-stop 信号。
        scanHits = appendScanHits(scanHits, page.sessions ?? [])
        setScanFullHits(scanHits)
        setSearchPhase("partial")
        // done 或无 nextCursor：候选宇宙扫尽（双条件防御服务端响应缺字段）。
        if (page.done || !page.nextCursor) break
        cursor = page.nextCursor
      }

      if (signal.aborted) return
      // 成功 complete：权威集合仅为 scanFullHits——title overlay 从此不再参与展示
      setSearchTerminal("success")
      setSearchPhase("complete")
    } catch {
      // abort 不改 UI；网络失败则 complete+error，保留 title∪scan，禁止 fallback browse
      if (signal.aborted) return
      setSearchTerminal("error")
      setSearchPhase("complete")
    }
  }

  // #561 唯一启动入口：组件存活期内才创建 controller，旧请求一律 abort
  function startSearch(query: string) {
    if (disposed) return
    // 旧请求立即过期：新 controller 尚未创建即先断旧链。
    searchController?.abort()
    const controller = new AbortController()
    // 单一 controller 引用：任何时刻至多一代搜索在途。
    searchController = controller
    // fire-and-forget：终态只经 signal/UI 反映，调用方不 await。
    void runProgressiveSearch(query, controller.signal)
  }

  // #544：committed query 变化——清空/改词都 abort 上一代；空串回到 browse 且无 Spinner
  // #561 卸载兜底 abort 由组件级 onCleanup 承担，effect 内不再重复注册。
  createEffect(
    on(
      () => ({ query: search(), filter: sync.session.query() }),
      ({ query }) => {
        if (!query) {
          // 清空是显式回 browse：abort 使任何 in-flight 写回立即过期。
          searchController?.abort()
          searchController = undefined
          // browse 态无 phase/terminal：清空即回初始列表。
          setSearchPhase(undefined)
          setSearchTerminal(undefined)
          setTitleHits([])
          setScanFullHits([])
          return
        }
        // #561 新 query 立即丢弃旧 hits，避免改词串味
        startSearch(query)
      },
    ),
  )

  // [local-smark] #366：批量预览——单次 POST /session/preview 拉取全部未加载
  // session 的预览文本，替代逐 session 分页扫描（N×M 次请求 → 1 次）。
  // 服务端过滤条件与旧 textFromUserMessage 完全对齐（非 synthetic/ignored
  // 的用户 text part），返回键为 sessionID、值为按新→旧排序的预览行数组。
  // SDK client 生成物上不存在 preview 方法，as any 调用会在运行时变成
  // undefined(...) 同步 TypeError 被 catch 吞掉；sdk.fetch 的 rewrite 仅处理
  // GET/HEAD，POST 需手动带 directory query param（#368 useGoalApi 同模式）
  async function loadPreviewsBatch(sessionIDs: string[], signal: AbortSignal) {
    const url = new URL("/session/preview", sdk.url)
    directoryQuery(url)
    const resp = await sdk.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIDs, limit: SESSION_LIST_PREVIEW_LINES }),
      signal,
    })
    // 非成功响应不能冒充有效空预览，否则缓存会吞掉下一批的重试。
    if (!resp.ok) return undefined
    return (await resp.json()) as Record<string, string[]>
  }

  // Part 编辑不一定推进时间戳，版本缓存只在当前查询内复用，改词或清空即换 owner。
  createEffect(
    on(
      () => search(),
      () => {
        const previewCache = new Map<string, string[]>()
        // 同查询各扫描批次共享在途键，避免 phase 更新反复中止有效工作。
        const previewInflight = new Map<string, AbortController>()
        // 展示以裸 id 为键；旧版本迟到响应只能缓存，不能覆盖已推进的展示。
        const previewLatest = new Map<string, string>()
        onCleanup(() => {
          for (const controller of previewInflight.values()) controller.abort()
          previewInflight.clear()
        })
        createEffect(
          on(
            () => sessions(),
            (currentSessions) => {
              if (SESSION_LIST_PREVIEW_LINES <= 0) return

              // browse 的 Store 可被 SSE 原地更新，必须在发送时固定身份，响应时不能重读。
              const wanted = currentSessions
                .slice(0, SESSION_LIST_PREVIEW_SESSION_LIMIT)
                .map((s) => ({ id: s.id, key: `${s.id}:${s.time.updated}` }))
              for (const w of wanted) previewLatest.set(w.id, w.key)
              // 同键最多一个在途请求，title→partial→complete 不重复取得相同内容。
              const missing = wanted.filter((w) => !previewCache.has(w.key) && !previewInflight.has(w.key))
              if (missing.length === 0) return

              const controller = new AbortController()
              for (const w of missing) previewInflight.set(w.key, controller)

              void (async () => {
                try {
                  const data = await loadPreviewsBatch(missing.map((w) => w.id), controller.signal)
                  // 传输可能在 abort 后仍交付响应；查询 owner 失效后阻止缓存及展示写回。
                  if (!data || controller.signal.aborted) return
                  // 响应缺省 ID 表示无可见文本；记空数组，避免零新增批次反复请求。
                  setPreviews((prev) => {
                    const next = { ...prev }
                    for (const w of missing) {
                      const lines = data[w.id] ?? []
                      previewCache.set(w.key, lines)
                      if (previewLatest.get(w.id) === w.key) next[w.id] = lines
                    }
                    return next
                  })
                } catch {
                  // 失败不阻断列表也不写缓存，缺失键随下一次触发自然重试。
                } finally {
                  // 闭包只持有本查询的 Map；旧 finally 不能删除新查询同名的在途键。
                  for (const w of missing) previewInflight.delete(w.key)
                }
              })()
            },
          ),
        )
      },
    ),
  )
  const deleteHint = useCommandShortcut("session.delete")
  const quickSwitch1 = useCommandShortcut("session.quick_switch.1")
  const quickSwitch9 = useCommandShortcut("session.quick_switch.9")

  const [browseResults, { refetch: refetchBrowse }] = createResource(
    () => sync.session.query(),
    (filter) => loadDialogSessionList({ filter, list: (query) => sdk.client.session.list(query) }),
  )
  // #561：删除后重跑当前 query；必须走 startSearch，才能被 dispose/cleanup 约束
  // browse 侧由调用点 refetchBrowse 负责；此处只重建 search 代，避免双拉。
  function refetchSearch() {
    const query = search()
    if (!query) return
    // closed-over refetch 与 effect 同一入口，无第二套 controller 构造。
    startSearch(query)
  }

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  // #544：partial 展示 = title overlay ∪ scan 流；success complete 只信 scanFullHits
  // resolveDisplayHits 把终态选择集中到 util——组件不复制集合选择规则。
  const displayHits = createMemo(() =>
    resolveDisplayHits({
      phase: searchPhase(),
      terminal: searchTerminal(),
      titleHits: titleHits(),
      scanFullHits: scanFullHits(),
    }),
  )
  // #529/#544：空 query 回 browse；非空 query 全程停留在 search 源（含 loading），禁止回退闪现
  const listSource = createMemo(() =>
    resolveProgressiveSessionListSource({
      query: search(),
      phase: searchPhase(),
      hits: displayHits(),
      browse: browseResults() ?? sync.data.session,
    }),
  )
  // Spinner 门控 memo：empty 文案与 Spinner 共用同一 phase，两者状态不会分叉。
  const searching = createMemo(() => isSessionSearchLoading(search(), searchPhase()))
  const sessions = createMemo(() => {
    const result = listSource().sessions
    const synced = new Map(sync.data.session.map((session) => [session.id, session]))
    const ids = new Set(result.map((session) => session.id))
    const extra = [currentSessionID(), ...local.session.pinned()].flatMap((id) => {
      if (!id || ids.has(id)) return []
      const session = synced.get(id)
      if (session) ids.add(id)
      return session ? [session] : []
    })
    // #529：服务端结果直通；extra（当前会话+置顶）经 visibleSessions 按 token 过滤注入
    return visibleSessions({
      result: result.map((session) => synced.get(session.id) ?? session),
      extra,
      deleted: deleted(),
      query: search(),
    })
  })

  onCleanup(
    event.on("session.deleted", (event) => {
      setDeleted((current) => new Set(current).add(event.properties.info.id))
    }),
  )

  function recover(session: NonNullable<ReturnType<typeof sessions>[number]>) {
    const workspace = project.workspace.get(session.workspaceID!)
    const list = () => dialog.replace(() => <DialogSessionList />)
    const warp = async (selection: WorkspaceSelection) => {
      const workspaceID = await (async () => {
        if (selection.type === "none") return null
        if (selection.type === "existing") return selection.workspaceID
        let result
        try {
          result = await sdk.client.experimental.workspace.create({ type: selection.workspaceType, branch: null })
        } catch (err) {
          toast.show({
            title: "Failed to create workspace",
            message: errorMessage(err),
            variant: "error",
          })
          return
        }
        const workspace = result?.data
        if (!workspace) {
          toast.show({
            title: "Failed to create workspace",
            message: errorMessage(result?.error ?? "no response"),
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
          await refetchBrowse()
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

  const browseOrder = createMemo(() => orderByRecency(browseResults() ?? sync.data.session))

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

    // #529：展示顺序与数据源同源：搜索中不用 stale searchResults 真值误判
    const order = listSource().source === "search" ? orderByRecency(sessions()) : browseOrder()
    const current = currentSessionID()
    const displayOrder = current && sessionMap.has(current) && !order.includes(current) ? [...order, current] : order

    const pinned = local.session.pinned().filter((id) => sessionMap.has(id))
    const pinnedSet = new Set(pinned)
    const slotByID = new Map<string, number>(local.session.slots().map((id, i) => [id, i + 1]))

    function buildOption(id: string, category: string) {
      const x = sessionMap.get(id)
      if (!x) return undefined
      const directory = x.path
        ? x.directory.endsWith(x.path)
          ? x.directory.slice(0, -x.path.length).replace(/\/$/, "")
          : undefined
        : x.directory
      const footer =
        directory && directory !== project.data.project.mainDir ? Locale.truncate(path.basename(directory), 20) : ""

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
        // #120：直接使用已分页收集的多行预览
        previewLines: SESSION_LIST_PREVIEW_LINES > 0 ? previews()[x.id] : undefined,
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
      preserveSelection={true}
      // #529/#544：搜索空命中展示 Not Found <query>；loading（awaiting/partial）展示 Searching…
      emptyView={
        sessionListEmptyLabel(search(), searchPhase()) ? (
          <box paddingLeft={4} paddingRight={4} paddingTop={1}>
            <text fg={theme.textMuted}>{sessionListEmptyLabel(search(), searchPhase())}</text>
          </box>
        ) : undefined
      }
      filterAccessory={
        // #544：loading（含 partial）时搜索栏右侧转圈，直至 complete
        searching() ? <Spinner /> : undefined
      }
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
              await refetchBrowse()
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
