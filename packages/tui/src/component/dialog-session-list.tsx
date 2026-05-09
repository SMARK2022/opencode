import type { Part, TextPart } from "@opencode-ai/sdk/v2"
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

type SessionListFilter = { scope?: "project"; path?: string }

export function createDialogSessionListQuery(input: { search?: string; filter: SessionListFilter }) {
  const search = input.search?.trim()
  return {
    roots: true,
    limit: search ? 30 : 100,
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
// #120：分页拉取消息页大小
const SESSION_LIST_PREVIEW_PAGE_SIZE = 16
// #120：最多扫描消息条数，避免全历史
const SESSION_LIST_PREVIEW_MESSAGE_SCAN_LIMIT = 200
// #120：同时预加载预览的会话数上限
const SESSION_LIST_PREVIEW_SESSION_LIMIT = 50
// #120：会话预览并发度
const SESSION_LIST_PREVIEW_CONCURRENCY = 6

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
  const [search, setSearch] = createDebouncedSignal("", 150)
  // #120：sessionID -> 多行用户消息预览（非单行再折词）
  const [previews, setPreviews] = createSignal<Record<string, string[]>>({})

  // #120：从用户消息 parts 提取纯文本
  function textFromUserMessage(parts: Part[]) {
    return (parts.filter((p) => p.type === "text" && !(p as any).synthetic && !(p as any).ignored) as TextPart[])
      .map((p) => p.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
  }

  // #120：分页向后扫消息，收集最多 N 条用户文本行
  async function loadPreviewLines(sessionID: string) {
    const lines: string[] = []
    let before: string | undefined
    let scanned = 0
    while (lines.length < SESSION_LIST_PREVIEW_LINES && scanned < SESSION_LIST_PREVIEW_MESSAGE_SCAN_LIMIT) {
      const limit = Math.min(SESSION_LIST_PREVIEW_PAGE_SIZE, SESSION_LIST_PREVIEW_MESSAGE_SCAN_LIMIT - scanned)
      const result = await sdk.client.session.messages({
        sessionID,
        limit,
        before,
      } as any)
      // #120：只认 data 数组契约（与 tip sync 一致）
      const messages = Array.isArray((result as any)?.data) ? ((result as any).data as any[]) : []
      scanned += limit
      for (let i = messages.length - 1; i >= 0 && lines.length < SESSION_LIST_PREVIEW_LINES; i--) {
        const message = messages[i]
        if (message.info?.role !== "user") continue
        const text = textFromUserMessage((message.parts ?? []) as Part[])
        if (text) lines.push(text)
      }
      const cursor =
        typeof (result as any)?.response?.headers?.get === "function"
          ? (result as any).response.headers.get("X-Next-Cursor")
          : undefined
      if (!cursor) break
      before = cursor
    }
    return lines
  }

  createEffect(
    on(
      () => sessions(),
      (sessions) => {
        if (SESSION_LIST_PREVIEW_LINES <= 0) return
        // #120：跳过已加载预览的会话
        const unloaded = sessions
          .slice(0, SESSION_LIST_PREVIEW_SESSION_LIMIT)
          .filter((s) => !(s.id in (previews() ?? {})))
        if (unloaded.length === 0) return
        void (async () => {
          const next: Record<string, string[]> = {}
          // #120：按并发度分块预取
          for (let i = 0; i < unloaded.length; i += SESSION_LIST_PREVIEW_CONCURRENCY) {
            const chunk = unloaded.slice(i, i + SESSION_LIST_PREVIEW_CONCURRENCY)
            await Promise.all(
              chunk.map(async (session) => {
                try {
                  const lines = await loadPreviewLines(session.id)
                  if (lines.length > 0) next[session.id] = lines
                } catch {
                  // #120：预览失败不阻断列表
                }
              }),
            )
          }
          if (Object.keys(next).length > 0) {
            setPreviews((prev) => ({ ...prev, ...next }))
          }
        })()
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
  const [searchResults, { refetch }] = createResource(
    () => ({ query: search(), filter: sync.session.query() }),
    (input) => {
      if (!input.query) return undefined
      return loadDialogSessionList({
        search: input.query,
        filter: input.filter,
        list: (query) => sdk.client.session.list(query),
      })
    },
  )

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const sessions = createMemo(() => {
    const result = searchResults() ?? browseResults() ?? sync.data.session
    const synced = new Map(sync.data.session.map((session) => [session.id, session]))
    const ids = new Set(result.map((session) => session.id))
    const extra = [currentSessionID(), ...local.session.pinned()].flatMap((id) => {
      if (!id || ids.has(id)) return []
      const session = synced.get(id)
      if (session) ids.add(id)
      return session ? [session] : []
    })
    const query = search().trim().toLowerCase()
    return [...result.map((session) => synced.get(session.id) ?? session), ...extra]
      .filter((session) => !deleted().has(session.id))
      .filter((session) => matchesDialogSessionSearch(session, query, searchResults()))
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
          if (search()) await refetch()
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

    const searchResult = searchResults()
    const order = searchResult ? orderByRecency(sessions()) : browseOrder()
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
              if (search()) await refetch()
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
