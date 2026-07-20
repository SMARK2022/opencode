import { describe, expect, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { LSPClient } from "@/lsp/client"
import * as LSPServer from "@/lsp/server"
import { spawn as lspSpawn } from "@/lsp/launch"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Process } from "@/util/process"
import * as VscodeBridge from "@/ide/vscode-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { disposeInstance } from "@/effect/instance-registry"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LSP.defaultLayer, Session.defaultLayer, CrossSpawnSpawner.defaultLayer))
const experimentalTyIt = testEffect(
  Layer.mergeAll(
    LSP.layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(RuntimeFlags.layer({ experimentalLspTy: true })), Layer.provide(AppFileSystem.defaultLayer)),
    CrossSpawnSpawner.defaultLayer,
  ),
)
const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
const fakeConfig = { lsp: { fake: { command: [process.execPath, fakeServerPath], extensions: [".repro"] } } }
const typescriptOnly = {
  lsp: { eslint: { disabled: true }, oxlint: { disabled: true }, biome: { disabled: true } },
} satisfies Partial<Config.Info>
const touchAs = (lsp: LSP.Interface, sessionID: SessionID, file: string) =>
  Effect.gen(function* () {
    yield* lsp.init()
    yield* lsp.touchFile(file)
  }).pipe(LSP.withSession(sessionID, Effect.void))
const disabledDownloadIt = testEffect(
  Layer.mergeAll(
    LSP.layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(RuntimeFlags.layer({ disableLspDownload: true })), Layer.provide(AppFileSystem.defaultLayer)),
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe("lsp.spawn", () => {
  it.live("does not spawn builtin LSP for files outside instance", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.touchFile(path.join(dir, "..", "outside.ts"))
              yield* lsp.hover({
                file: path.join(dir, "..", "hover.ts"),
                line: 0,
                character: 0,
              })
              expect(spy).toHaveBeenCalledTimes(0)
            } finally {
              spy.mockRestore()
            }
          }),
        ),
      { config: { lsp: true } },
    ),
  )

  it.live("does not spawn builtin LSP for files inside instance when LSP is false", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.ts"),
                line: 0,
                character: 0,
              })
              // [local-smark] LSP 显式设为 false 时不 spawn
              expect(spy).toHaveBeenCalledTimes(0)
            } finally {
              spy.mockRestore()
            }
          }),
        ),
      // [local-smark] 默认启用 LSP：未配置时视为 true，仅 false 显式禁用
      { config: { lsp: false } },
    ),
  )

  it.live("spawns builtin LSP for files inside instance when LSP is unset (default enabled)", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.ts"),
              line: 0,
              character: 0,
            })
            // [local-smark] 未配置 lsp 时默认启用，会尝试 spawn
            expect(spy).toHaveBeenCalledTimes(1)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    ),
  )

  it.live("would spawn builtin LSP for files inside instance when lsp is true", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.ts"),
                line: 0,
                character: 0,
              })
              expect(spy).toHaveBeenCalledTimes(1)
            } finally {
              spy.mockRestore()
            }
          }),
        ),
      { config: { lsp: true } },
    ),
  )

  it.live("skips VSCode bridge touch for light warm without diagnostics", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const file = path.join(dir, "src", "inside.ts")
          const resolve = spyOn(VscodeBridge, "resolveBridge").mockResolvedValue({ id: "bridge", port: 1, token: "token", host: "127.0.0.1", source: "registry", capabilities: { lsp: true } } satisfies VscodeBridge.BridgeRef)
          const call = spyOn(VscodeBridge, "callBridge").mockResolvedValue({ ok: true, diagnostics: [] })
          const spawn = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.touchFile(file)
            // read warm 使用无 diagnostics touch。bridge 环境下它不能打开 VSCode，也不能回退 spawn 内置 LSP。
            expect(call).toHaveBeenCalledTimes(0)
            expect(spawn).toHaveBeenCalledTimes(0)
          } finally {
            resolve.mockRestore()
            call.mockRestore()
            spawn.mockRestore()
          }
        }),
      ),
    ),
  )

  it.live("uses VSCode bridge touch for document diagnostics", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const file = path.join(dir, "src", "inside.ts")
          const resolve = spyOn(VscodeBridge, "resolveBridge").mockResolvedValue({
            id: "bridge",
            port: 1,
            token: "token",
            host: "127.0.0.1",
            source: "registry",
            capabilities: { lsp: true },
          } satisfies VscodeBridge.BridgeRef)
          const call = spyOn(VscodeBridge, "callBridge").mockResolvedValue({ ok: true, diagnostics: [] })

          try {
            yield* lsp.touchFile(file, "document")
            // edit/write/apply_patch 需要 strong touch 来触发 VSCode/Pylance 诊断计算。
            // 空数组是成功的“未发现错误”快照，必须保留文件 key，不能退化为 unavailable。
            expect(call).toHaveBeenCalledWith(expect.objectContaining({ path: "/lsp/touch", filePath: file, timeoutMs: 1000 }))
            expect(yield* lsp.diagnostics()).toEqual({ [AppFileSystem.normalizePath(file)]: [] })
            expect(yield* lsp.status()).toEqual([{ id: "vscode", name: "VSCode", root: ".", status: "connected" }])
          } finally {
            resolve.mockRestore()
            call.mockRestore()
          }
        }),
      ),
    ),
  )

  it.live("returns diagnostics from the VSCode bridge touch without a second request", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const file = path.join(dir, "src", "inside.ts")
          const resolve = spyOn(VscodeBridge, "resolveBridge").mockResolvedValue({
            id: "bridge",
            port: 1,
            token: "token",
            host: "127.0.0.1",
            source: "registry",
            capabilities: { lsp: true },
          } satisfies VscodeBridge.BridgeRef)
          const call = spyOn(VscodeBridge, "callBridge").mockResolvedValue({
            ok: true,
            diagnostics: [{ file, line: 2, column: 3, severity: "Error", message: "type mismatch", source: "test" }],
          })

          try {
            yield* lsp.touchFile(file, "document")
            // touch 响应已经携带诊断；再次读取必须命中同一缓存而不是发送第二个 HTTP 请求。
            expect((yield* lsp.diagnostics())[AppFileSystem.normalizePath(file)]).toEqual([
              expect.objectContaining({ message: "type mismatch", severity: 1, source: "test" }),
            ])
            expect(call).toHaveBeenCalledTimes(1)
          } finally {
            resolve.mockRestore()
            call.mockRestore()
          }
        }),
      ),
    ),
  )

  it.live("does not report VSCode bridge as diagnostics-ready after diagnostics failure", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const file = path.join(dir, "src", "inside.ts")
          const resolve = spyOn(VscodeBridge, "resolveBridge").mockResolvedValue({
            id: "bridge",
            port: 1,
            token: "token",
            host: "127.0.0.1",
            source: "registry",
            capabilities: { lsp: true },
          } satisfies VscodeBridge.BridgeRef)
          const call = spyOn(VscodeBridge, "callBridge").mockResolvedValue(undefined)

          try {
            yield* lsp.touchFile(file, "document")
            yield* lsp.diagnostics()
            // bridge 存活不等于诊断成功；失败后不能输出 clean，也不能再叠加第二次诊断请求。
            // 此处同时锁定状态和调用次数，避免未来把失败重新包装成空成功。
            expect(yield* lsp.status()).toEqual([])
            expect(call).toHaveBeenCalledTimes(1)
            expect(call).toHaveBeenCalledWith(expect.objectContaining({ path: "/lsp/touch", timeoutMs: 1000 }))
          } finally {
            resolve.mockRestore()
            call.mockRestore()
          }
        }),
      ),
    ),
  )

  it.live("does not fall back to builtin LSP when VSCode bridge diagnostics fail", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const file = path.join(dir, "src", "inside.ts")
          const resolve = spyOn(VscodeBridge, "resolveBridge").mockResolvedValue({
            id: "bridge",
            port: 1,
            token: "token",
            host: "127.0.0.1",
            source: "registry",
            capabilities: { lsp: true },
          } satisfies VscodeBridge.BridgeRef)
          const call = spyOn(VscodeBridge, "callBridge").mockResolvedValue(undefined)
          const spawn = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.touchFile(file, "document")
            // 已选中的 VS Code 诊断失败后不得启动另一套 provider 来制造不同结果。
            expect(spawn).toHaveBeenCalledTimes(0)
          } finally {
            resolve.mockRestore()
            call.mockRestore()
            spawn.mockRestore()
          }
        }),
      ),
    ),
  )

  it.live("does not spawn builtin LSP when VSCode bridge is unavailable for diagnostics", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const file = path.join(dir, "src", "inside.ts")
          const resolve = spyOn(VscodeBridge, "resolveBridge").mockRejectedValue(new Error("bridge unavailable"))
          const spawn = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.touchFile(file, "document")
            // bridge 缺失只影响诊断；本测试防止 strong touch 静默回到内置 TypeScript LSP。
            expect(spawn).toHaveBeenCalledTimes(0)
          } finally {
            resolve.mockRestore()
            spawn.mockRestore()
          }
        }),
      ),
    ),
  )

  it.live("publishes lsp.updated after custom LSP initialization", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const updated = yield* Deferred.make<void>()
          let updates = 0
          const unsubscribe = Bus.subscribe(LSP.Event.Updated, () => (++updates, Effect.runSync(Deferred.succeed(updated, undefined))))
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

          const file = path.join(dir, "sample.repro")
          yield* Effect.promise(() => Bun.write(file, "sample\n"))
          yield* lsp.touchFile(file)
          yield* awaitWithTimeout(Deferred.await(updated), "lsp.updated event was not published")
          // 同一 owner 重复 touch 没有 metadata 变化，不能伪造一次列表刷新。
          yield* lsp.touchFile(file)
          expect(updates).toBe(1)
        }),
      {
        config: {
          lsp: {
            fake: {
              command: [process.execPath, fakeServerPath],
              extensions: [".repro"],
            },
          },
        },
      },
    ),
  )

  it.live("shuts a shared LSP client down only after its final Session releases it", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const sessions = yield* Session.Service
          const sessionA = yield* sessions.create({ title: "LSP A" })
          const sessionB = yield* sessions.create({ title: "LSP B" })
          const target = yield* tmpdirScoped({ config: fakeConfig })
          const file = path.join(dir, "release.repro")
          yield* Effect.promise(() => Bun.write(file, "release\n"))

          yield* touchAs(lsp, sessionA.id, file)
          yield* touchAs(lsp, sessionB.id, file)
          // 两个 Session 共享一条底层 client row；owner metadata 只决定投影与
          // final-owner shutdown，不能复制进程。
          expect((yield* lsp.status())[0]?.sessionIDs).toEqual([sessionA.id, sessionB.id])

          // 新 run 可以在 Workspace target T 发起，但必须退休该 Session 在 D
          // 已物化 registry 中的旧 claim；B 仍持有时共享进程不能被关闭。
          yield* provideInstance(target)(lsp.init().pipe(LSP.withSession(sessionA.id, Effect.void)))
          expect(yield* lsp.status()).toEqual([expect.objectContaining({ id: "fake", sessionIDs: [sessionB.id] })])

          // B 是最后 owner；它释放后，client 必须从公共状态移除并完成 shutdown。
          yield* provideInstance(target)(lsp.init().pipe(LSP.withSession(sessionB.id, Effect.void)))
          expect(yield* lsp.status()).toEqual([])

          const targetFile = path.join(target, "target.repro")
          yield* Effect.promise(() => Bun.write(targetFile, "target\n"))
          yield* provideInstance(target)(touchAs(lsp, sessionA.id, targetFile))
          yield* provideInstance(target)(touchAs(lsp, sessionB.id, targetFile))
          const [checking, resume] = yield* Effect.all([Deferred.make<void>(), Deferred.make<void>()])
          const active = Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(resume)), Effect.andThen(sessions.get(sessionA.id)), Effect.asVoid, Effect.orDie)
          const admission = yield* provideInstance(target)(lsp.init().pipe(LSP.withSession(sessionA.id, active))).pipe(Effect.forkChild)
          yield* Deferred.await(checking)
          // 删除先提交 DB 后，仍在等待的 admission 必须失败；它不能在删除事件
          // 已退休 claims 之后再安装一个不可见的新 token。
          yield* sessions.remove(sessionA.id)
          yield* Deferred.succeed(resume, undefined)
          expect(Exit.isFailure(yield* Fiber.await(admission))).toBe(true)
          yield* pollWithTimeout(
            provideInstance(target)(lsp.status()).pipe(Effect.map((rows) => (rows[0]?.sessionIDs?.join(",") === sessionB.id ? true : undefined))),
            "deleting Session A did not retire its target-State claim",
          )

          const resolve = spyOn(VscodeBridge, "resolveBridge").mockResolvedValue({ id: "bridge", port: 1, token: "token", host: "127.0.0.1", source: "registry", capabilities: { lsp: true } } satisfies VscodeBridge.BridgeRef)
          try {
            yield* touchAs(lsp, sessionA.id, file)
            yield* touchAs(lsp, sessionB.id, file)
            // Bridge 只共享一条外部资源 row；退休 owner 不能关闭或复制它。
            expect((yield* lsp.status())[0]?.sessionIDs).toEqual([sessionA.id, sessionB.id])
            yield* lsp.init().pipe(LSP.withSession(sessionA.id, Effect.void))
            expect((yield* lsp.status())[0]?.sessionIDs).toEqual([sessionB.id])
          } finally {
            resolve.mockRestore()
          }
        }),
      { config: fakeConfig },
    ),
  )

  it.live("removes terminated clients and rejects stale in-flight claims", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const observed = { shutdowns: 0, create: LSPClient.create }
          const create = spyOn(LSPClient, "create").mockImplementation(async (input) => {
            const client = await observed.create(input)
            return {
              ...client,
              shutdown: async () => {
                observed.shutdowns++
                await client.shutdown()
              },
            }
          })
          yield* Effect.addFinalizer(() => Effect.sync(() => create.mockRestore()))

          // prune 认 client.root 是否存在，不认 process.cwd。
          // fake 进程 cwd 固定为 instance 目录，避免 Windows 因 cwd 锁住 root 而无法删/改名目录。
          // Effect.gen 的 JS finally 在 Effect 失败时不执行；spawn/root spy 必须按 iteration 用 scoped finalizer 恢复。
          for (const terminal of ["root", "process"] as const) {
            const root = path.join(dir, terminal)
            const file = path.join(root, "index.ts")
            yield* Effect.promise(() => fs.mkdir(root, { recursive: true }))
            yield* Effect.promise(() => Bun.write(file, "export {}\n"))
            yield* Effect.scoped(
              Effect.gen(function* () {
                let child: ReturnType<typeof lspSpawn> | undefined
                const resolveRoot = spyOn(LSPServer.Typescript, "root").mockResolvedValue(root)
                const spawn = spyOn(LSPServer.Typescript, "spawn").mockImplementation(async () => ({
                  process: (child = lspSpawn(process.execPath, [fakeServerPath], { cwd: dir })),
                }))
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    resolveRoot.mockRestore()
                    spawn.mockRestore()
                  }),
                )
                yield* lsp.touchFile(file)
                expect((yield* lsp.status()).some((item) => item.id === "typescript")).toBe(true)
                if (!child) return yield* Effect.die(new Error("fake LSP process was not captured"))
                const processHandle = child
                // root 消失与 child exit 都必须 exact-entry detach/shutdown，而不是只从 status 列表隐藏。
                if (terminal === "root") yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
                else yield* Effect.promise(() => Process.stop(processHandle))
                yield* pollWithTimeout(
                  lsp.status().pipe(
                    Effect.map((rows) =>
                      !rows.some((item) => item.id === "typescript") && observed.shutdowns === (terminal === "root" ? 1 : 2)
                        ? true
                        : undefined,
                    ),
                  ),
                  `${terminal} terminal did not remove LSP client`,
                )
              }),
            )
          }

          // handoff：新 generation 接管 inflight spawn；reload：无接管者时 disposed State 清孤儿；
          // missing-root：initialize 完成前 root 消失则不得登记可用 client，进程须退出。
          const sessionID = SessionID.make("ses_lsp_stale_generation")
          for (const transition of ["handoff", "reload", "missing-root"] as const) {
            const root = path.join(dir, transition)
            const file = path.join(root, "index.ts")
            const [started, release] = yield* Effect.all([Deferred.make<void>(), Deferred.make<void>()])
            yield* Effect.promise(() => fs.mkdir(root, { recursive: true }))
            yield* Effect.promise(() => Bun.write(file, "export {}\n"))
            // 与 terminal 环相同：scoped finalizer 保证本 transition 失败也不会把 mock 泄漏到下一轮。
            yield* Effect.scoped(
              Effect.gen(function* () {
                let child: ReturnType<typeof lspSpawn> | undefined
                const resolveRoot = spyOn(LSPServer.Typescript, "root").mockResolvedValue(root)
                const spawn = spyOn(LSPServer.Typescript, "spawn").mockImplementation(async () => {
                  // cwd=dir 使 missing-root 的 rename(root) 在 Windows 上可达，仍测 client.root 复验。
                  child = lspSpawn(process.execPath, [fakeServerPath], { cwd: dir })
                  Effect.runSync(Deferred.succeed(started, undefined))
                  await Effect.runPromise(Deferred.await(release))
                  return { process: child }
                })
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    resolveRoot.mockRestore()
                    spawn.mockRestore()
                  }),
                )
                const touch = yield* Effect.gen(function* () {
                  yield* lsp.init()
                  yield* lsp.touchFile(file)
                }).pipe(LSP.withSession(sessionID, Effect.void), Effect.forkChild)
                yield* awaitWithTimeout(Deferred.await(started), "LSP spawn did not reach the controlled boundary")

                // 新 token 接管同一 spawn；无接管者时 disposed State / 消失 root 仍须销毁孤儿。
                const handoff = Effect.yieldNow.pipe(
                  Effect.andThen(Deferred.succeed(release, undefined)),
                  Effect.forkChild,
                  Effect.andThen(touchAs(lsp, sessionID, file)),
                )
                yield* (transition === "handoff"
                  ? handoff
                  : (transition === "missing-root"
                      ? Effect.promise(() => fs.rename(root, `${root}.gone`))
                      : Effect.promise(() => disposeInstance(dir))
                    ).pipe(Effect.andThen(Deferred.succeed(release, undefined))))
                yield* Fiber.join(touch)
                if (transition === "missing-root") {
                  yield* pollWithTimeout(
                    Effect.sync(() =>
                      child && (child.exitCode !== null || child.signalCode !== null) ? true : undefined,
                    ),
                    "missing-root client process did not exit",
                  )
                }
                expect((yield* lsp.status()).filter((item) => item.id === "typescript")).toEqual(
                  transition === "handoff" ? [expect.objectContaining({ sessionIDs: [sessionID] })] : [],
                )
              }),
            )
          }
        }),
      { config: typescriptOnly },
    ),
  )

  it.live("would spawn builtin LSP for files inside instance when config object is provided", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.ts"),
                line: 0,
                character: 0,
              })
              expect(spy).toHaveBeenCalledTimes(1)
            } finally {
              spy.mockRestore()
            }
          }),
        ),
      {
        config: {
          lsp: {
            eslint: { disabled: true },
          },
        },
      },
    ),
  )

  it.live("uses pyright instead of ty by default", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const ty = spyOn(LSPServer.Ty, "spawn").mockResolvedValue(undefined)
            const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.py"),
                line: 0,
                character: 0,
              })
              expect(ty).toHaveBeenCalledTimes(0)
              expect(pyright).toHaveBeenCalledTimes(1)
            } finally {
              ty.mockRestore()
              pyright.mockRestore()
            }
          }),
        ),
      { config: { lsp: true } },
    ),
  )

  experimentalTyIt.live("uses ty instead of pyright when experimentalLspTy is enabled", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const ty = spyOn(LSPServer.Ty, "spawn").mockResolvedValue(undefined)
            const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.py"),
                line: 0,
                character: 0,
              })
              expect(ty).toHaveBeenCalledTimes(1)
              expect(pyright).toHaveBeenCalledTimes(0)
            } finally {
              ty.mockRestore()
              pyright.mockRestore()
            }
          }),
        ),
      { config: { lsp: true } },
    ),
  )

  disabledDownloadIt.live("passes disableLspDownload to builtin LSP spawn", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

            try {
              yield* lsp.hover({
                file: path.join(dir, "src", "inside.py"),
                line: 0,
                character: 0,
              })
              expect(pyright).toHaveBeenCalledTimes(1)
              expect(pyright.mock.calls[0]?.[2]).toMatchObject({ disableLspDownload: true })
            } finally {
              pyright.mockRestore()
            }
          }),
        ),
      { config: { lsp: true } },
    ),
  )
})
