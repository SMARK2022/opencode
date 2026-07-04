import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, type JSX } from "solid-js"
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

  // [local-smark] session list preview: 批量获取预览文本
  // 单次 POST /session/preview 替代原来 N×M 次 session.messages 分页调用。
  // AbortController 保证 dialog 关闭或搜索切换时取消 in-flight 请求；
  // signal.aborted 守卫防止已取消的响应覆盖新数据（竞态防护）
  createEffect(
    on(
      () => sessions(),
      (currentSessions) => {
        if (SESSION_LIST_PREVIEW_LINES <= 0) return

        const ids = currentSessions
          .slice(0, SESSION_LIST_PREVIEW_SESSION_LIMIT)
          .map((s) => s.id)
        if (ids.length === 0) return

        // 每次 sessions 变化创建新 controller；onCleanup 在下次触发或卸载时 abort
        const controller = new AbortController()
        onCleanup(() => controller.abort())

        void (async () => {
          try {
            // POST 请求需手动设置 directory query param（sdk.fetch 的 rewrite
            // 仅处理 GET/HEAD），确保 workspace routing 中间件正确定位实例
            const url = new URL("/session/preview", sdk.url)
            const dir = sync.path.directory || sdk.directory
            if (dir) url.searchParams.set("directory", dir)

            const res = await sdk.fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionIDs: ids, limit: SESSION_LIST_PREVIEW_LINES }),
              signal: controller.signal,
            })
            if (!res.ok) return
            const data = (await res.json()) as Record<string, string[]>
            // 竞态守卫：若请求完成时已被 abort，不覆盖新数据
            // 无条件 setPreviews(data)：空响应也需覆盖，避免搜索切换后残留过期预览
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

  const [searchResults, { refetch }] = createResource(
    () => ({ query: search(), filter: sync.session.query() }),
    async (input) => {
      if (!input.query) return undefined
      const result = await sdk.client.session.list({
        search: input.query,
        start: Date.now() - 90 * 24 * 60 * 60 * 1000,
        limit: 100,
        ...input.filter,
      })
      return result.data ?? []
    },
  )

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const sessions = createMemo(() => searchResults() ?? sync.data.session)

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

    const searchResult = searchResults()
    const displayOrder = searchResult ? orderByRecency(searchResult) : browseOrder()

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
