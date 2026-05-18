import { onCleanup, onMount } from "solid-js"
import { readdirSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createStore } from "solid-js/store"
import { Option, Schema, SchemaGetter } from "effect"
import { Global } from "@opencode-ai/core/global"
import { isRecord } from "../util/record"
import { useTuiPaths } from "./runtime"
import { createSimpleContext } from "./helper"
import { editorIntegration } from "../editor"
import { fileURLToPath } from "url"

const MCP_PROTOCOL_VERSION = "2025-11-25"

const JsonRpcMessageSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
})

const PositionSchema = Schema.Struct({
  line: Schema.Number,
  character: Schema.Number,
})

const EditorSelectionRangeSchema = Schema.Struct({
  text: Schema.String,
  selection: Schema.Struct({
    start: PositionSchema,
    end: PositionSchema,
  }),
})

const EditorSelectionRangesSchema = Schema.Struct({
  filePath: Schema.String,
  // selection.source 增加 bridge 枚举，与 registry 主路径对齐
  source: Schema.optional(Schema.Literals(["websocket", "zed", "bridge"])),
  ranges: Schema.mutable(Schema.Array(EditorSelectionRangeSchema).check(Schema.isMinLength(1))),
})

const EditorSelectionSchema = Schema.Union([
  EditorSelectionRangesSchema,
  Schema.Struct({
    text: Schema.String,
    filePath: Schema.String,
    source: Schema.optional(Schema.Literals(["websocket", "zed", "bridge"])),
    selection: Schema.Struct({
      start: PositionSchema,
      end: PositionSchema,
    }),
  }),
]).pipe(
  Schema.decodeTo(EditorSelectionRangesSchema, {
    decode: SchemaGetter.transform((value) =>
      "ranges" in value
        ? value
        : {
            filePath: value.filePath,
            source: value.source,
            ranges: [
              {
                text: value.text,
                selection: value.selection,
              },
            ],
          },
    ),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)

const EditorMentionSchema = Schema.Struct({
  filePath: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
})

const EditorServerInfoSchema = Schema.Struct({
  protocolVersion: Schema.optional(Schema.String),
  serverInfo: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
    }),
  ),
})

const decodeJsonRpcMessage = Schema.decodeUnknownOption(JsonRpcMessageSchema)
const decodeEditorSelection = Schema.decodeUnknownOption(EditorSelectionSchema)
const decodeEditorMention = Schema.decodeUnknownOption(EditorMentionSchema)
const decodeEditorServerInfo = Schema.decodeUnknownOption(EditorServerInfoSchema)

type JsonRpcMessage = Schema.Schema.Type<typeof JsonRpcMessageSchema>
export type EditorSelection = Schema.Schema.Type<typeof EditorSelectionSchema>
export type EditorMention = Schema.Schema.Type<typeof EditorMentionSchema>
export type EditorLabelState = "pending" | "sent" | "none"
type EditorServerInfo = Schema.Schema.Type<typeof EditorServerInfoSchema>

type EditorConnection = {
  url: string
  authToken?: string
  source: string
}

export type EditorIntegration = Readonly<{
  connection?(directory: string): EditorConnection | undefined
  selection?(directory: string): Promise<unknown>
}>

export const { use: useEditorContext, provider: EditorContextProvider } = createSimpleContext({
  name: "EditorContext",
  init: (props: { integration?: EditorIntegration; WebSocketImpl?: typeof WebSocket }) => {
    const paths = useTuiPaths()
    const editor = props.integration ?? editorIntegration
    const value = process.env.CLAUDE_CODE_SSE_PORT || process.env.OPENCODE_EDITOR_SSE_PORT
    const parsedPort = value ? Number.parseInt(value, 10) : undefined
    const port =
      parsedPort && Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : undefined
    const zedTerminal = process.env.ZED_TERM === "true" || process.env.TERM_PROGRAM?.toLowerCase() === "zed"
    const mentionListeners = new Set<(mention: EditorMention) => void>()
    const WebSocketImpl = props.WebSocketImpl ?? WebSocket
    const [store, setStore] = createStore<{
      status: "disabled" | "connecting" | "connected"
      selection: EditorSelection | undefined
      selectionSent: boolean
      server: EditorServerInfo | undefined
    }>({
      status: "disabled",
      selection: undefined,
      selectionSent: false,
      server: undefined,
    })

    let socket: WebSocket | undefined
    let closed = false
    let reconnect: ReturnType<typeof setTimeout> | undefined
    // bridge registry 轮询句柄：5s 刷新 active file
    let bridgePoll: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let requestID = 0
    let zedSelection: Promise<void> | undefined
    let lastZedSelectionKey: string | undefined
    let directory = paths.cwd
    let preserveSelectionOnReconnect = false
    const pending = new Map<number, string>()

    const setSelection = (selection: EditorSelection | undefined) => {
      const changed = editorSelectionKey(selection) !== editorSelectionKey(store.selection)
      setStore("selection", selection)
      if (changed) setStore("selectionSent", false)
    }

    const clearSelectionForReconnect = (options?: { resetZedSelectionKey?: boolean }) => {
      if (preserveSelectionOnReconnect) {
        preserveSelectionOnReconnect = false
        return
      }
      if (options?.resetZedSelectionKey) lastZedSelectionKey = undefined
      setSelection(undefined)
    }

    const send = (payload: JsonRpcMessage) => {
      if (!socket || socket.readyState !== 1) return
      socket.send(JSON.stringify({ jsonrpc: "2.0", ...payload }))
    }

    const request = (method: string, params?: unknown) => {
      requestID += 1
      pending.set(requestID, method)
      send({ id: requestID, method, params })
    }

    const connect = () => {
      if (closed) return

      // ① Primary: Bridge Registry（opencode VS Code 扩展）
      // 优先 registry active 文件，不再依赖 OPENCODE_VSCODE_BRIDGE_* 环境变量
      const bridge = resolveBridgeRegistryActiveFile(directory)
      if (bridge) {
        if (socket) {
          socket.close()
          socket = undefined
        }
        // source=bridge 标记 selection 来自扩展 registry
        setSelection({ ...bridge, source: "bridge" })
        setStore("status", "connected")
        // 有 bridge selection 时 5s 轮询，捕获 active 切换
        scheduleBridgePoll()
        return
      }

      // ② Fallback: Claude Code lock / WebSocket
      // #116：conn 局部名缩短，避免与 editor.connection 配置字段混淆
      const conn = resolveEditorConnection(directory, port, editor.connection)
      if (!conn) {
        if (!zedTerminal) {
          setStore("status", "disabled")
          scheduleReconnect()
          return
        }
        if (!editor.selection) {
          setStore("status", "disabled")
          scheduleReconnect()
          return
        }

        zedSelection ??= editor
          .selection(directory)
          .then((result) => {
            if (closed || socket) return
            if (!isRecord(result) || result.type === "unavailable") return
            const decoded = result.type === "selection" ? decodeEditorSelection(result.selection) : Option.none()
            const selection = Option.getOrUndefined(decoded)
            const key = editorSelectionKey(selection)
            if (key !== lastZedSelectionKey) {
              lastZedSelectionKey = key
              setSelection(selection)
              setStore("status", selection ? "connected" : "disabled")
            }
          })
          .catch(() => {
            // Keep the last known Zed selection for transient polling failures.
          })
          .finally(() => {
            zedSelection = undefined
          })
        scheduleZedPoll()
        return
      }

      setStore("status", "connecting")
      // #116：使用 conn 打开编辑器 WebSocket
      const current = openEditorSocket(conn, WebSocketImpl)
      socket = current

      current.addEventListener("open", () => {
        if (socket !== current) {
          current.close()
          return
        }

        attempt = 0
        setStore("status", "connected")
        request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "opencode", version: "0.0.0" },
        })
      })

      current.addEventListener("message", (event) => {
        const message = parseMessage(event.data)
        if (!message) return

        const selection = message.method === "selection_changed" ? decodeEditorSelection(message.params) : Option.none()
        if (Option.isSome(selection)) {
          setSelection({ ...selection.value, source: "websocket" })
          return
        }

        const mention = message.method === "at_mentioned" ? decodeEditorMention(message.params) : Option.none()
        if (Option.isSome(mention)) {
          mentionListeners.forEach((listener) => listener(mention.value))
          return
        }

        if (typeof message.id !== "number") return

        const method = pending.get(message.id)
        if (!method) return

        pending.delete(message.id)
        if (message.error) return

        const initialize = method === "initialize" ? decodeEditorServerInfo(message.result) : Option.none()
        if (Option.isSome(initialize)) {
          setStore("server", initialize.value)
          send({ method: "notifications/initialized" })
          return
        }
      })

      current.addEventListener("close", () => {
        if (socket !== current) return

        socket = undefined
        pending.clear()
        if (closed) return

        setStore("status", "connecting")
        scheduleReconnect()
      })
    }

    const scheduleReconnect = () => {
      if (closed) return
      if (reconnect) clearTimeout(reconnect)
      attempt += 1
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000)
      reconnect = setTimeout(connect, delay)
    }

    const scheduleBridgePoll = () => {
      if (closed) return
      if (bridgePoll) clearTimeout(bridgePoll)
      // 5s 轮询：registry active file 变化需及时反映到 TUI selection
      bridgePoll = setTimeout(connect, 5000)
    }

    const scheduleZedPoll = () => {
      if (closed) return
      if (reconnect) clearTimeout(reconnect)
      reconnect = setTimeout(connect, 1000)
    }

    const reconnectWithDirectory = (nextDirectory?: string) => {
      const resolved = nextDirectory || paths.cwd
      const sameDirectory = directory === resolved
      clearSelectionForReconnect({ resetZedSelectionKey: !sameDirectory })
      if (sameDirectory) return

      directory = resolved
      attempt = 0
      pending.clear()
      if (reconnect) clearTimeout(reconnect)
      reconnect = undefined
      // 目录切换/卸载时清 bridge 轮询，避免跨目录串扰
      if (bridgePoll) clearTimeout(bridgePoll)
      bridgePoll = undefined
      if (socket) {
        const current = socket
        socket = undefined
        current.close()
      }
      setStore("status", "disabled")
      setStore("server", undefined)
      connect()
    }

    onMount(() => {
      connect()

      onCleanup(() => {
        closed = true
        if (reconnect) clearTimeout(reconnect)
        if (bridgePoll) clearTimeout(bridgePoll)
        socket?.close()
      })
    })

    return {
      // enabled 含 registry：无 websocket/zed 时仍可展示 bridge 绑定文件
      enabled() {
        return Boolean(resolveBridgeRegistryActiveFile(directory) || resolveEditorConnection(directory, port, editor.connection) || (zedTerminal && editor.selection))
      },
      connected() {
        return store.status === "connected"
      },
      selection() {
        return store.selection
      },
      clearSelection() {
        lastZedSelectionKey = undefined
        zedSelection = undefined
        setSelection(undefined)
      },
      preserveSelectionFromNewSession() {
        preserveSelectionOnReconnect = true
      },
      markSelectionSent() {
        if (!store.selection) return
        setStore("selectionSent", true)
      },
      labelState(): EditorLabelState {
        if (!store.selection) return "none"
        return store.selectionSent ? "sent" : "pending"
      },
      onMention(listener: (mention: EditorMention) => void) {
        mentionListeners.add(listener)
        return () => mentionListeners.delete(listener)
      },
      server() {
        return store.server
      },
      reconnect(directory?: string) {
        reconnectWithDirectory(directory)
      },
    }
  },
})

function resolveEditorConnection(
  directory: string,
  port: number | undefined,
  discover: ((directory: string) => EditorConnection | undefined) | undefined,
): EditorConnection | undefined {
  if (port) {
    return {
      url: `ws://127.0.0.1:${port}`,
      source: `env:${port}`,
    }
  }

  return discover?.(directory)
}

export function editorSelectionKey(selection: EditorSelection | undefined) {
  if (!selection) return ""
  return [
    selection.filePath,
    ...selection.ranges.flatMap((range) => [
      range.selection.start.line,
      range.selection.start.character,
      range.selection.end.line,
      range.selection.end.character,
      range.text,
    ]),
  ].join("\0")
}


// 从 opencode IDE registry 读取最近 active notebook/text 文件（按 workspace 路径打分）
// 读 ~/.local/state/opencode/ide 注册表 JSON，按 workspace 路径最长前缀打分

// #125：bridge registry URI → 本地路径（file/git；notebook-cell 忽略）
function bridgeUriToPath(value?: string) {
  if (!value) return
  // #125：file:// 用 fileURLToPath 解 percent-encoding
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value)
    } catch {
      return decodeURIComponent(new URL(value).pathname)
    }
  }
  if (value.startsWith("vscode-notebook-cell:")) return
  // #125：git: 从 query JSON.path 取真实路径
  if (value.startsWith("git:")) {
    const uri = new URL(value)
    const search = uri.search ? decodeURIComponent(uri.search.slice(1)) : undefined
    let parsed: unknown
    try {
      parsed = search ? JSON.parse(search) : undefined
    } catch {
      parsed = undefined
    }
    if (parsed && typeof parsed === "object" && typeof (parsed as any).path === "string") return (parsed as any).path
    const pathname = decodeURIComponent(uri.pathname)
    return /^\/[a-z]:/i.test(pathname) ? pathname.slice(1) : pathname
  }
  return value
}

// #171：与 vscode-bridge / 扩展写入同一 registry 根，禁止硬编码 home 分叉
function bridgeRegistryDir() {
  // #171：OPENCODE_IDE_REGISTRY_DIR 优先，否则 Global.Path.state/ide
  return process.env.OPENCODE_IDE_REGISTRY_DIR ?? path.join(Global.Path.state, "ide")
}

function resolveBridgeRegistryActiveFile(activeDirectory: string): EditorSelection | undefined {
  const dir = bridgeRegistryDir()
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  const now = Date.now()
  const parsed = entries
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        const data = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as unknown
        if (!isRecord(data) || data.schema !== 1) return []
        return [data]
      } catch {
        return []
      }
    })
    // 60s 心跳窗口：过期条目不参与 active 选择
    .filter((e) => now - (e.updatedAt as number) < 60_000)

  const scored = parsed
    .map((entry) => ({ entry, score: bridgeRegistryWorkspaceScore(entry, activeDirectory) }))
    // score=0 表示无 workspace 重叠，丢弃以免跨仓误选
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best) return

  const active = best.entry.active as Record<string, string> | undefined
  // notebook 优先于 textEditor：笔记本会话更依赖路径绑定
  // #125：notebook/textEditor 可能是 URI，需解码为路径
  const filePath = bridgeUriToPath(active?.notebook) ?? bridgeUriToPath(active?.textEditor)
  if (!filePath) return

  return { filePath, source: "bridge", ranges: [] as EditorSelection["ranges"] }
}

// workspaceFolders 与 TUI cwd 的路径包含长度作为匹配分
function bridgeRegistryWorkspaceScore(entry: Record<string, unknown>, activeDirectory: string) {
  const folders = Array.isArray(entry.workspaceFolders)
    ? (entry.workspaceFolders as Array<Record<string, unknown>>)
    : []
  return Math.max(
    0,
    ...folders.map((folder) => {
      const fsPath = typeof folder.fsPath === "string" ? folder.fsPath : ""
      // #125：workspace folder.uri 同样可能是 file://
      const uri = typeof folder.uri === "string" ? bridgeUriToPath(folder.uri) ?? folder.uri : ""
      return Math.max(
        fsPath ? pathContainsLength(fsPath, activeDirectory) : 0,
        uri ? pathContainsLength(uri, activeDirectory) : 0,
      )
    }),
  )
}

function pathContainsLength(parent: string, child: string) {
  const resolvedParent = path.resolve(parent)
  const resolvedChild = path.resolve(child)
  const relative = path.relative(resolvedParent, resolvedChild)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolvedParent.length : 0
}

function openEditorSocket(connection: EditorConnection, WebSocketImpl: typeof WebSocket) {
  if (!connection.authToken) return new WebSocketImpl(connection.url)

  return new WebSocketImpl(connection.url, {
    headers: {
      "x-claude-code-ide-authorization": connection.authToken,
    },
  } as any)
}

function parseMessage(value: unknown) {
  if (typeof value !== "string") return

  try {
    return Option.getOrUndefined(decodeJsonRpcMessage(JSON.parse(value)))
  } catch {
    return
  }
}
