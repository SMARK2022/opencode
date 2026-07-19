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
// [local-smark] VSCode Bridge LSP backend：优先通过 bridge 获取 VSCode 的 LSP 能力
import * as VscodeBridge from "@/ide/vscode-bridge"
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
  bridgeOwners: Map<SessionID, object>
  closed: boolean
  // bridge 能连通不代表 diagnostics endpoint 成功；status 需要这条信号避免 clean 误报。
  bridgeDiagnostics?: "ok" | "failed"
  // 保存最近一次 strong touch 的同请求快照，后续 diagnostics() 只读缓存，不再产生第二段等待。
  bridgeSnapshot: Record<string, LSPClient.Diagnostic[]>
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

        // [local-smark] 默认启用 LSP：未配置时视为 true，仅 false 显式禁用。
        // 官方 PR #23416 因"LSP 有意默认禁用"被关闭，但作为 fork 我们选择默认启用
        // 以降低使用门槛。LSP 按需启动（touchFile 时 spawn），不影响启动性能。
        if (cfg.lsp === false) {
          log.info("all LSPs are disabled")
        } else {
          for (const server of Object.values(LSPServer)) {
            servers[server.id] = server
          }

          filterExperimentalServers(servers, flags)

          // [local-smark] cfg.lsp 为 undefined（默认启用）时跳过自定义配置遍历，
          // 防止 Object.entries(undefined) 报错。仅对象类型才进入自定义配置。
          if (cfg.lsp && cfg.lsp !== true) {
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
          bridgeOwners: new Map(),
          closed: false,
          bridgeDiagnostics: undefined,
          bridgeSnapshot: {},
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

    const getClients = Effect.fnUntraced(function* (file: string) {
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
            await Process.stop(handle.process)
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
            await Process.stop(handle.process)
            return existing
          }

          const entry: ClientEntry = { client, owners: new Map(), unscoped: false }
          s.clients.push(entry)
          // 监听后再检查退出码，同时覆盖“注册前已退出”和“注册后退出”；重复回调
          // 由 exact-entry detach 幂等吸收，不需要第二套进程状态判断。
          const exited = () => bridge.fork(removeExitedClient(s, entry))
          handle.process.once("exit", exited)
          if (handle.process.exitCode !== null || handle.process.signalCode !== null) exited()
          return entry
        }

        for (const server of Object.values(s.servers)) {
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

    // [local-smark] 尝试发现支持 LSP 的 VSCode bridge。resolveBridge 有 5s 缓存。
    // 失败返回 undefined，调用方回退到内置 LSP。
    const resolveLspBridge = Effect.fnUntraced(function* (filePath?: string) {
      const ctx = yield* InstanceState.context
      return yield* Effect.promise(async () => {
        try {
          const bridge = await VscodeBridge.resolveBridge({ cwd: ctx.directory, filePath })
          if (!bridge.capabilities?.lsp) return undefined
          return bridge
        } catch {
          return undefined
        }
      })
    })

    // [local-smark] 通过 bridge 调用 LSP 端点。失败返回 undefined，由诊断调用方保留真实失败状态。
    // timeout 只由 strong diagnostic touch 传入；hover 等其他 bridge 能力保持各自原有上限。
    const callLspBridge = Effect.fnUntraced(function* (
      endpoint: string,
      body: Record<string, unknown>,
      filePath?: string,
      timeoutMs?: number,
    ) {
      const ctx = yield* InstanceState.context
      return yield* Effect.promise(async () => {
        try {
          return await VscodeBridge.callBridge({ cwd: ctx.directory, path: endpoint, body, filePath, timeoutMs })
        } catch {
          return undefined
        }
      })
    })

    // [local-smark] 将 bridge 诊断格式转换为内置 LSP 的 Record<string, Diagnostic[]> 格式。
    // 对 key 做 normalizePath，与 write/edit/apply_patch 的查找 key 对齐。
    function bridgeDiagnosticsToMap(result: unknown): Record<string, LSPClient.Diagnostic[]> | undefined {
      if (!result || typeof result !== "object") return undefined
      const diags = (result as { diagnostics?: unknown[] }).diagnostics
      if (!Array.isArray(diags)) return undefined
      const severityMap: Record<string, number> = { Error: 1, Warning: 2, Information: 3, Hint: 4 }
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      for (const d of diags) {
        if (!d || typeof d !== "object") continue
        const item = d as { file?: string; line?: number; column?: number; severity?: string; message?: string; source?: string }
        if (!item.file || typeof item.line !== "number" || typeof item.column !== "number") continue
        const diagnostic: LSPClient.Diagnostic = {
          range: {
            start: { line: item.line - 1, character: item.column - 1 },
            end: { line: item.line - 1, character: item.column },
          },
          message: item.message ?? "",
          severity: (severityMap[item.severity ?? "Error"] ?? 1) as LSPClient.Diagnostic["severity"],
          ...(item.source ? { source: item.source } : {}),
        }
        // [local-smark] 对 key 做 normalizePath，与 write/edit/apply_patch 的查找 key 对齐
        const normalizedFile = AppFileSystem.normalizePath(item.file)
        const arr = results[normalizedFile] ?? []
        arr.push(diagnostic)
        results[normalizedFile] = arr
      }
      return results
    }

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
      const bridgeChanged = s.bridgeOwners.delete(sessionID)
      // map 后再 some，确保同一 Session 跨多个 root 的 claims 全部撤销；
      // 直接 some(delete) 会在首个 true 后短路并留下后续 client。
      const changed = s.clients.map((entry) => entry.owners.delete(sessionID)).some(Boolean) || bridgeChanged
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
      // [local-smark] 有 bridge 且 diagnostics 未失败时才返回 VSCode 连接状态。
      const bridge = yield* resolveLspBridge()
      if (bridge && s.bridgeDiagnostics !== "failed") {
        return [{
          id: "vscode",
          name: "VSCode",
          root: ".",
          status: "connected" as const,
          ...(s.bridgeOwners.size ? { sessionIDs: [...s.bridgeOwners.keys()] } : {}),
        }]
      }
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
      // [local-smark] 有 bridge 时直接返回 true（VSCode 已有 LSP 扩展）
      const bridge = yield* resolveLspBridge(file)
      if (bridge) return true
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
      const owner = yield* CurrentOwner
      // [local-smark] bridge 下区分 light warm 与 strong diagnostics：read warm 不应打开 VSCode。
      const bridge = yield* resolveLspBridge(input)
      if (bridge) {
        // Bridge 连接由外部进程拥有；这里只在异步解析后校验 token 并记录可见性，
        // release 只删除 claim，绝不关闭或重连外部 Bridge。
        if (owner && !s.closed && s.tokens.get(owner.sessionID) === owner.token) {
          const changed = s.bridgeOwners.get(owner.sessionID) !== owner.token
          s.bridgeOwners.set(owner.sessionID, owner.token)
          if (changed) yield* s.updated
        }
        if (!diagnostics) return
        const touched = yield* callLspBridge("/lsp/touch", { filePath: input }, input, 1000)
        const mapped = bridgeDiagnosticsToMap(touched)
        if (mapped) {
          const normalized = AppFileSystem.normalizePath(input)
          // 空数组也覆盖旧快照，保证“未发现错误”不会保留上一次错误。
          // 非空数组同样固定在本次 Tool 结果中，后到事件不能修改已经返回的输出。
          s.bridgeSnapshot[normalized] = mapped[normalized] ?? []
          s.bridgeDiagnostics = "ok"
          return
        }
        s.bridgeDiagnostics = "failed"
        // bridge 已被选中后失败属于真实失败，不允许再切换内置 LSP 改变诊断语义。
        return
      }
      if (diagnostics) {
        // strong touch 没有 bridge 时直接标记失败；仅 light warm 保留原有内置 LSP 兼容路径。
        s.bridgeDiagnostics = "failed"
        return
      }
      log.info("touching file", { file: input })
      const clients = yield* getClients(input)
      yield* Effect.promise(() =>
        Promise.all(
          clients.map(async (client) => {
            const after = Date.now()
            const version = await client.notify.open({ path: input })
            if (!diagnostics) return
            return client.waitForDiagnostics({
              path: input,
              version,
              mode: diagnostics,
              after,
            })
          }),
        ).catch((err) => {
          log.error("failed to touch file", { err, file: input })
        }),
      )
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
      // [local-smark] touch 已返回同一请求的快照；这里不再发第二个 bridge 请求。
      // 空对象与 bridge 失败由 status 区分，成功的空文件快照则保留规范化文件 key 和空数组。
      const s = yield* InstanceState.get(state)
      const bridge = yield* resolveLspBridge()
      if (!bridge) {
        s.bridgeDiagnostics = "failed"
        return {}
      }
      return s.bridgeDiagnostics === "failed" ? {} : s.bridgeSnapshot
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      // [local-smark] 优先 bridge，提取 bare array 与 tool 层对齐
      const bridge = yield* resolveLspBridge(input.file)
      if (bridge) {
        const result = yield* callLspBridge("/lsp/hover", {
          filePath: input.file, line: input.line, character: input.character,
        }, input.file)
        if (result) return (result as { hovers?: unknown[] }).hovers ?? []
      }
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
      // [local-smark] 优先 bridge，提取 .definitions
      const bridge = yield* resolveLspBridge(input.file)
      if (bridge) {
        const result = yield* callLspBridge("/lsp/definition", {
          filePath: input.file, line: input.line, character: input.character,
        }, input.file)
        if (result) return (result as { definitions?: unknown[] }).definitions ?? []
      }
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
      // [local-smark] 优先 bridge，提取 .references
      const bridge = yield* resolveLspBridge(input.file)
      if (bridge) {
        const result = yield* callLspBridge("/lsp/references", {
          filePath: input.file, line: input.line, character: input.character,
        }, input.file)
        if (result) return (result as { references?: unknown[] }).references ?? []
      }
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
        client.connection
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
      // [local-smark] 优先 bridge，提取 .symbols
      const bridge = yield* resolveLspBridge(file)
      if (bridge) {
        const result = yield* callLspBridge("/lsp/document-symbol", { filePath: file }, file)
        if (result) return ((result as { symbols?: unknown[] }).symbols ?? []) as (DocumentSymbol | Symbol)[]
      }
      const results = yield* run(file, (client) =>
        client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []),
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
      // [local-smark] 优先 bridge，提取 .symbols
      const bridge = yield* resolveLspBridge()
      if (bridge) {
        const result = yield* callLspBridge("/lsp/workspace-symbol", { query })
        // [local-smark] workspaceSymbol bridge 返回需要类型断言
        if (result) return ((result as { symbols?: unknown[] }).symbols ?? []) as Symbol[]
      }
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
        client.connection
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
