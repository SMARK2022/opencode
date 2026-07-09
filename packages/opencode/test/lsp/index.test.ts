import { describe, expect, spyOn } from "bun:test"
import path from "path"
import { Deferred, Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import * as VscodeBridge from "@/ide/vscode-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LSP.defaultLayer, CrossSpawnSpawner.defaultLayer))
const experimentalTyIt = testEffect(
  Layer.mergeAll(
    LSP.layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(RuntimeFlags.layer({ experimentalLspTy: true }))),
    CrossSpawnSpawner.defaultLayer,
  ),
)
const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
const disabledDownloadIt = testEffect(
  Layer.mergeAll(
    LSP.layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(RuntimeFlags.layer({ disableLspDownload: true }))),
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
          const resolve = spyOn(VscodeBridge, "resolveBridge").mockResolvedValue({
            id: "bridge",
            port: 1,
            token: "token",
            host: "127.0.0.1",
            source: "registry",
            capabilities: { lsp: true },
          } satisfies VscodeBridge.BridgeRef)
          const call = spyOn(VscodeBridge, "callBridge").mockResolvedValue({ ok: true })
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
          const call = spyOn(VscodeBridge, "callBridge").mockResolvedValue({ ok: true })

          try {
            yield* lsp.touchFile(file, "document")
            // edit/write/apply_patch 需要 strong touch 来触发 VSCode/Pylance 诊断计算。
            expect(call).toHaveBeenCalledWith(expect.objectContaining({ path: "/lsp/touch", filePath: file }))
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
            yield* lsp.diagnostics()
            // bridge 存活不等于 diagnostics 成功；失败后 status 不能让工具输出 clean。
            expect(yield* lsp.status()).toEqual([])
            expect(call).toHaveBeenCalledWith(expect.objectContaining({ path: "/lsp/diagnostics" }))
          } finally {
            resolve.mockRestore()
            call.mockRestore()
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
          const unsubscribe = Bus.subscribe(LSP.Event.Updated, () =>
            Effect.runSync(Deferred.succeed(updated, undefined)),
          )
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

          const file = path.join(dir, "sample.repro")
          yield* Effect.promise(() => Bun.write(file, "sample\n"))
          yield* lsp.touchFile(file)
          yield* awaitWithTimeout(Deferred.await(updated), "lsp.updated event was not published")
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
