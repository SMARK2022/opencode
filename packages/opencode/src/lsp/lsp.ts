import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Log from "@opencode-ai/core/util/log"
import * as LSPClient from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import * as LSPServer from "./server"
import { Config } from "@/config/config"
import { Process } from "@/util/process"
import { spawn as lspspawn } from "./launch"
import { Effect, Layer, Context, Option, Schema, Semaphore } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionID } from "@/session/schema"
import { EffectBridge } from "@/effect/bridge"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

const log = Log.create({ service: "lsp" })

export const Event = {
  Updated: BusEvent.define("lsp.updated", Schema.Struct({})),
}

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
})

export const Range = Schema.Struct({
  start: Position,
  end: Position,
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
}).annotate({ identifier: "Symbol" })
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
}).annotate({ identifier: "DocumentSymbol" })
export type DocumentSymbol = typeof DocumentSymbol.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
  sessionIDs: Schema.optional(Schema.Array(SessionID)),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

const filterExperimentalServers = (servers: Record<string, LSPServer.Info>, flags: RuntimeFlags.Info) => {
  if (flags.experimentalLspTy) {
    if (servers["pyright"]) {
      log.info("LSP server pyright is disabled because OPENCODE_EXPERIMENTAL_LSP_TY is enabled")
      delete servers["pyright"]
    }
  } else {
    if (servers["ty"]) {
      delete servers["ty"]
    }
  }
}

type LocInput = { file: string; line: number; character: number }

interface ClientEntry {
  client: LSPClient.Info
  owners: Map<SessionID, object>
  unscoped: boolean
}
type PendingClient = { promise: Promise<ClientEntry | undefined>; owners: Set<object | undefined> }

interface State {
  updated: Effect.Effect<void>
  clients: ClientEntry[]
  servers: Record<string, LSPServer.Info>
  broken: Set<string>
  spawning: Map<string, PendingClient>
  tokens: Map<SessionID, object>
  closed: boolean
  // 连接存活不代表诊断完成，所有参与连接的实际结果决定检查有效性。
  diagnosticsFailed: boolean
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  readonly hover: (input: LocInput) => Effect.Effect<any>
  readonly definition: (input: LocInput) => Effect.Effect<any[]>
  readonly references: (input: LocInput) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<Symbol[]>
  readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LSP") {}

type SessionOwner = { readonly sessionID: SessionID; readonly token: object; readonly active: Effect.Effect<void> }

const CurrentOwner = Context.Reference<SessionOwner | undefined>("@opencode/LSP/SessionOwner", { defaultValue: () => undefined })

export function withSession(sessionID: SessionID, active: Effect.Effect<void>) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provideService(CurrentOwner, { sessionID, token: {}, active }))
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const fs = yield* AppFileSystem.Service
    const bridge = yield* EffectBridge.make()
    const states = new Set<State>()
    const lifecycle = Semaphore.makeUnsafe(1)

    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* (ctx) {
        const cfg = yield* config.get()

        const servers: Record<string, LSPServer.Info> = {}

        // LSP 采用显式启用：配置注释约定省略或 false 均关闭，仅 true 或对象开启。
        // 默认路径不创建任何内置 server，避免为未启用语言功能的用户常驻数 GB 的 LSP 进程。
        if (!cfg.lsp) {
          log.info("all LSPs are disabled")
        } else {
          for (const server of Object.values(LSPServer)) {
            servers[server.id] = server
          }

          filterExperimentalServers(servers, flags)

          // cfg.lsp 为 true 时无自定义配置可遍历；仅对象类型才进入自定义配置。
          if (cfg.lsp !== true) {
            for (const [name, item] of Object.entries(cfg.lsp)) {
              const existing = servers[name]
              if (item.disabled) {
                log.info(`LSP server ${name} is disabled`)
                delete servers[name]
                continue
              }
              servers[name] = {
                ...existing,
                id: name,
                root: existing?.root ?? (async (_file, ctx) => ctx.directory),
                extensions: item.extensions ?? existing?.extensions ?? [],
                spawn: async (root) => ({
                  process: lspspawn(item.command[0], item.command.slice(1), {
                    cwd: root,
                    env: { ...process.env, ...item.env },
                  }),
                  initialization: item.initialization,
                }),
              }
            }
          }

          log.info("enabled LSP servers", {
            serverIds: Object.values(servers)
              .map((server) => server.id)
              .join(", "),
          })
        }

        const s: State = {
          updated: Effect.promise(() => Bus.publish(Event.Updated, {}, { context: { instance: ctx } })),
          clients: [],
          servers,
          broken: new Set(),
          spawning: new Map(),
          tokens: new Map(),
          closed: false,
          diagnosticsFailed: false,
        }

        states.add(s)
        yield* Effect.addFinalizer(() => {
          // closed 先于 shutdown，阻止跨过 initialize 的旧 fiber 在 finalizer 后回挂孤儿 client。
          s.closed = true
          states.delete(s)
          return shutdown(detach(s, s.clients))
        })

        return s
      }),
    )

    const getClients = Effect.fnUntraced(function* (file: string, workspaceOnly = false) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return [] as LSPClient.Info[]
      const s = yield* InstanceState.get(state)
      yield* pruneMissingRoots(s)
      const owner = yield* CurrentOwner
      const token = owner?.token
      return yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        const result: LSPClient.Info[] = []

        // client 身份属于 server/root；Session generation 只是一份独立 claim。
        // 这样并发 Session 可以复用进程，同时 status 仍能按 Session 精确投影。
        async function claim(entry: ClientEntry, pending?: PendingClient) {
          if (!owner) {
            const changed = !entry.unscoped
            entry.unscoped = true
            if (changed) await bridge.promise(s.updated)
            return entry.client
          }
          if (!s.closed && s.tokens.get(owner.sessionID) === owner.token) {
            const changed = entry.owners.get(owner.sessionID) !== owner.token
            entry.owners.set(owner.sessionID, owner.token)
            if (changed) await bridge.promise(s.updated)
            return entry.client
          }

          // token 已退休时，请求不能继续消费 client。若该 entry 没有其他 owner，
          // 立即走统一 detach；共享 entry 则只拒绝这次旧 claim。
          // spawning waiter 与 Promise 共存；旧 claimant 仅在没有当前 waiter 时回收，让新 generation 原子接管。
          const waiting = !s.closed && (pending?.owners.has(undefined) || [...s.tokens.values()].some((token) => pending?.owners.has(token)))
          if (s.clients.includes(entry) && !entry.unscoped && entry.owners.size === 0 && !waiting) {
            await bridge.promise(shutdown(detach(s, [entry])))
            await bridge.promise(s.updated)
          }
        }

        async function schedule(server: LSPServer.Info, root: string, key: string) {
          const handle = await server
            .spawn(root, ctx, flags)
            .then((value) => {
              if (!value) s.broken.add(key)
              return value
            })
            .catch((err) => {
              s.broken.add(key)
              log.error(`Failed to spawn LSP server ${server.id}`, { error: err })
              return undefined
            })

          if (!handle) return undefined
          log.info("spawned lsp server", { serverID: server.id, root })

          const client = await LSPClient.create({
            serverID: server.id,
            server: handle,
            root,
            directory: ctx.directory,
            instance: ctx,
          }).catch(async (err) => {
            s.broken.add(key)
            if ("process" in handle) await Process.stop(handle.process)
            else handle.dispose()
            log.error(`Failed to initialize LSP client ${server.id}`, { error: err })
            return undefined
          })

          if (!client) return undefined
          // initialize 是 root 可消失的异步边界；注册前复验，避免消费已不可能使用的 client。
          if (!(await bridge.promise(fs.existsSafe(root)))) {
            await client.shutdown()
            return undefined
          }

          const existing = s.clients.find((x) => x.client.root === root && x.client.serverID === server.id)
          if (existing) {
            await client.shutdown()
            return existing
          }

          const entry: ClientEntry = { client, owners: new Map(), unscoped: false }
          s.clients.push(entry)
          // 监听后再检查退出码，同时覆盖“注册前已退出”和“注册后退出”；重复回调
          // 由 exact-entry detach 幂等吸收，不需要第二套进程状态判断。
          const exited = () => bridge.fork(removeExitedClient(s, entry))
          // 外部连接共用退出清理，但不假定存在可结束的子进程。
          if ("process" in handle) {
            handle.process.once("exit", exited)
            if (handle.process.exitCode !== null || handle.process.signalCode !== null) exited()
          } else handle.connection.onDispose(exited)
          return entry
        }

        for (const server of Object.values(s.servers)) {
          // 工作区请求没有扩展名，只获取声明支持global的注册项。
          if (workspaceOnly && !server.global) continue
          if (server.extensions.length && !server.extensions.includes(extension)) continue

          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue

          const match = s.clients.find((x) => x.client.root === root && x.client.serverID === server.id)
          if (match) {
            const client = await claim(match)
            if (client) result.push(client)
            continue
          }

          const inflight = s.spawning.get(root + server.id)
          if (inflight) {
            inflight.owners.add(token)
            const entry = await inflight.promise
            inflight.owners.delete(token)
            if (!entry) continue
            const client = await claim(entry, inflight)
            if (client) result.push(client)
            continue
          }

          const task = schedule(server, root, root + server.id)
          const pending = { promise: task, owners: new Set([token]) }
          s.spawning.set(root + server.id, pending)

          task.finally(() => {
            if (s.spawning.get(root + server.id) === pending) {
              s.spawning.delete(root + server.id)
            }
          })

          const entry = await task
          pending.owners.delete(token)
          if (!entry) continue

          const client = await claim(entry, pending)
          if (client) result.push(client)
        }

        return result
      })
    })

    const run = Effect.fnUntraced(function* <T>(file: string, fn: (client: LSPClient.Info) => Promise<T>) {
      const clients = yield* getClients(file)
      return yield* Effect.promise(() => Promise.all(clients.map((x) => fn(x))))
    })

    const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Promise<T>) {
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(() => Promise.all(s.clients.map((x) => fn(x.client))))
    })

    const init = Effect.fn("LSP.init")(function* () {
      const s = yield* InstanceState.get(state)
      const owner = yield* CurrentOwner
      if (owner) yield* beginSession(s, owner)
    })

    function detach(s: State, entries: ClientEntry[]) {
      // registry 是进程生命周期的权威索引；同步 detach 后才允许异步 shutdown，
      // 因而 admission/deletion 的线性化锁不需要等待外部进程退出。
      const discarded = new Set(entries)
      s.clients = s.clients.filter((entry) => !discarded.has(entry))
      return entries
    }

    const shutdown = (entries: ClientEntry[]) =>
      Effect.promise(() => Promise.all(entries.map((entry) => entry.client.shutdown())).then(() => undefined))

    const removeExitedClient = Effect.fnUntraced(function* (s: State, entry: ClientEntry) {
      // reset/root cleanup 已先 detach 时，迟到 exit 只属于旧对象；按对象身份检查
      // 可防止同 server/root 的 replacement 被旧进程终态误删。
      if (!s.clients.includes(entry)) return
      yield* shutdown(detach(s, [entry]))
      yield* s.updated
    })

    const pruneMissingRoots = Effect.fnUntraced(function* (s: State) {
      const existing = yield* Effect.forEach(s.clients, (entry) => fs.existsSafe(entry.client.root), { concurrency: "unbounded" })
      const stale = s.clients.filter((_, index) => !existing[index])
      const detached = detach(s, stale)
      if (detached.length === 0) return
      yield* shutdown(detached)
      yield* s.updated
    })

    function retireSession(s: State, sessionID: SessionID) {
      // token 先失效再撤销 claim，仍在 initialize 的旧请求恢复后只能走
      // orphan detach；新 run 与删除共用这一条状态转换。
      s.tokens.delete(sessionID)
      // map 后再 some，确保同一 Session 跨多个 root 的 claims 全部撤销；
      // 直接 some(delete) 会在首个 true 后短路并留下后续 client。
      const changed = s.clients.map((entry) => entry.owners.delete(sessionID)).some(Boolean)
      const unused = s.clients.filter((entry) => !entry.unscoped && entry.owners.size === 0)
      return { changed: changed || unused.length > 0, detached: detach(s, unused) }
    }

    function retireEverywhere(sessionID: SessionID) {
      const retired = [...states].map((state) => ({ state, ...retireSession(state, sessionID) }))
      return {
        changed: retired.filter((item) => item.changed).map((item) => item.state),
        detached: retired.flatMap((item) => item.detached),
      }
    }

    const finishTransition = (transition: ReturnType<typeof retireEverywhere>) => Effect.all([shutdown(transition.detached), Effect.forEach(transition.changed, (state) => state.updated)], { concurrency: "unbounded", discard: true })

    const beginSession = Effect.fnUntraced(function* (s: State, owner: SessionOwner) {
      const transition = yield* lifecycle.withPermits(1)(
        Effect.gen(function* () {
          // Session 存在性检查与内存 transition 共用线性化点：删除先完成时
          // admission 失败；admission 先完成时，后到删除必然看见已安装 token。
          yield* owner.active
          const retired = retireEverywhere(owner.sessionID)
          if (!s.closed) s.tokens.set(owner.sessionID, owner.token)
          return retired
        }),
      )
      yield* finishTransition(transition)
    })

    // Session 模块经 MessageV2 依赖 LSP；这里在 layer 已完成模块求值后再取正式事件定义，
    // 避免为删除清理制造静态 Session -> LSP -> Session 环。
    const deleted = (yield* Effect.promise(() => import("@/session/session"))).Event.Deleted.type
    const decodeSessionID = Schema.decodeUnknownOption(SessionID)
    const onGlobalEvent = (event: GlobalEvent) => {
      if (event.payload?.type !== deleted) return
      const sessionID = decodeSessionID(event.payload.properties?.sessionID)
      if (Option.isNone(sessionID)) return

      // 地址簿只遍历已经物化的 State，不创建 cache；持久化 D、事件 envelope
      // 与 Workspace target T 即使不同，也不会漏掉真实 claim。
      bridge.fork(lifecycle.withPermits(1)(Effect.sync(() => retireEverywhere(sessionID.value))).pipe(Effect.flatMap(finishTransition)))
    }
    yield* Effect.acquireRelease(Effect.sync(() => GlobalBus.on("event", onGlobalEvent)), () => Effect.sync(() => GlobalBus.off("event", onGlobalEvent)))

    const status = Effect.fn("LSP.status")(function* () {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      yield* pruneMissingRoots(s)
      // 编辑工具消费status判断检查是否可靠，不能让其他存活连接掩盖失败。
      if (s.diagnosticsFailed) return []
      const result: Status[] = []
      for (const entry of s.clients) {
        const client = entry.client
        result.push({
          id: client.serverID,
          name: s.servers[client.serverID].id,
          root: path.relative(ctx.directory, client.root),
          status: "connected",
          ...(entry.owners.size ? { sessionIDs: [...entry.owners.keys()] } : {}),
        })
      }
      return result
    })

    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue
          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue
          return true
        }
        return false
      })
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
      const s = yield* InstanceState.get(state)
      log.info("touching file", { file: input })
      const clients = yield* getClients(input)
      const ready = yield* Effect.promise(() =>
        Promise.all(
          clients.map(async (client) => {
            const after = Date.now()
            const version = await client.notify.open({ path: input })
            if (!diagnostics) return true
            return client.waitForDiagnostics({
              path: input,
              version,
              mode: diagnostics,
              after,
            })
          }),
        ).catch((err) => {
          log.error("failed to touch file", { err, file: input })
          return []
        }),
      )
      // 成功空报告也有效；light warm不覆盖之前strong touch的检查结果。
      if (diagnostics) s.diagnosticsFailed = !ready.length || ready.some((value) => !value)
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
      const s = yield* InstanceState.get(state)
      const result: Record<string, LSPClient.Diagnostic[]> = {}
      // 缓存只由原客户端持有，读取结果不再发现bridge或重复请求。
      for (const { client } of s.clients) {
        for (const [file, items] of client.diagnostics) result[file] = [...(result[file] ?? []), ...items]
      }
      return result
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      return yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/hover", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/definition", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/references", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
            context: { includeDeclaration: true },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        !client.supports("textDocument/implementation") ? Promise.resolve([]) : client.connection
          .sendRequest("textDocument/implementation", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client) =>
        client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []),
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
      // CLI直接查询时尚未touch文件，仍须经已有注册集合取得工作区连接。
      const ctx = yield* InstanceState.context
      yield* getClients(ctx.directory, true)
      const results = yield* runAll((client) =>
        client.connection
          .sendRequest<Symbol[]>("workspace/symbol", { query })
          .then((result) => result.filter((x) => kinds.includes(x.kind)).slice(0, 10))
          .catch(() => [] as Symbol[]),
      )
      return results.flat()
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        !client.supports("textDocument/prepareCallHierarchy") ? Promise.resolve([]) : client.connection
          .sendRequest("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    ) {
      const results = yield* run(input.file, async (client) => {
        // 已知缺少能力的外部连接在请求前筛除，原生路径保持原有兼容性。
        if (!client.supports("textDocument/prepareCallHierarchy")) return []
        const items = await client.connection
          .sendRequest<unknown[] | null>("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => [] as unknown[])
        if (!items?.length) return []
        return client.connection.sendRequest(direction, { item: items[0] }).catch(() => [])
      })
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
    })

    return Service.of({
      init,
      status,
      hasClients,
      touchFile,
      diagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(RuntimeFlags.defaultLayer), Layer.provide(AppFileSystem.defaultLayer))

export * as Diagnostic from "./diagnostic"

export * as LSP from "./lsp"
