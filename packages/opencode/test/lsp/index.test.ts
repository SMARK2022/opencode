import { describe, expect, spyOn } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { VscodeBridge } from "@/ide/vscode-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const lspLayer = (flags: Parameters<typeof RuntimeFlags.layer>[0] = {}) =>
  LayerNode.compile(LayerNode.group([LSP.node, Config.node, RuntimeFlags.node, EventV2Bridge.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const it = testEffect(Layer.mergeAll(lspLayer(), LayerNode.compile(CrossSpawnSpawner.node)))
const experimentalTyIt = testEffect(
  Layer.mergeAll(lspLayer({ experimentalLspTy: true }), LayerNode.compile(CrossSpawnSpawner.node)),
)
const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
const disabledDownloadIt = testEffect(
  Layer.mergeAll(lspLayer({ disableLspDownload: true }), LayerNode.compile(CrossSpawnSpawner.node)),
)

describe("lsp.spawn", () => {
  it.instance(
    "does not spawn builtin LSP for files outside instance",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
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
  )

  it.instance(
    "does not spawn builtin LSP for files inside instance when LSP is false",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
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
    // 产品固定停用；显式false与默认配置都必须零spawn。
    { config: { lsp: false } },
  )

  it.instance("does not spawn builtin LSP for files inside instance when LSP is unset (product disabled)", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

        try {
          yield* lsp.hover({
            file: path.join(dir, "src", "inside.ts"),
            line: 0,
            character: 0,
          })
          // 默认值也不能恢复LSP，与既有true/custom配置防复活测试一致。
          expect(spy).toHaveBeenCalledTimes(0)
          expect(yield* lsp.status()).toEqual([])
        } finally {
          spy.mockRestore()
        }
      }),
    ),
  )

  it.instance("skips VSCode bridge touch for light warm without diagnostics", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const file = path.join((yield* TestInstance).directory, "src", "inside.ts")
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
          // read warm 使用无 diagnostics touch：bridge 环境下不能打开 VSCode，也不回退 spawn 内置 LSP
          expect(call).toHaveBeenCalledTimes(0)
          expect(spawn).toHaveBeenCalledTimes(0)
        } finally {
          resolve.mockRestore()
          call.mockRestore()
          spawn.mockRestore()
        }
      }),
    ),
  )
  it.instance("keeps document diagnostics disabled despite an advertised bridge", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const file = path.join((yield* TestInstance).directory, "src", "inside.ts")
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
          // 用户已停用整个LSP能力，显式document也不能调用IDE后端。
          // bridge广告或空快照不能恢复产品能力，更不能把未执行误报成clean。
          expect(call).toHaveBeenCalledTimes(0)
          expect(yield* lsp.diagnostics()).toEqual({})
          expect(yield* lsp.hasClients(FSUtil.normalizePath(file))).toBe(false)
        } finally {
          resolve.mockRestore()
          call.mockRestore()
        }
      }),
    ),
  )

  it.instance("does not report an advertised VSCode bridge as diagnostics-ready while disabled", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
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
          // 固定停用不消费失败bridge，空诊断和空status不能被解释为已运行成功。
          // 连续读取仍为不可用，不恢复内置后端或追加第二次请求。
          expect(yield* lsp.status()).toEqual([])
          expect(call).toHaveBeenCalledTimes(0)
          expect(yield* lsp.diagnostics()).toEqual({})
        } finally {
          resolve.mockRestore()
          call.mockRestore()
        }
      }),
    ),
  )

  it.instance(
    "does not spawn builtin LSP inside the instance even when lsp is true",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
          const external = spyOn(LSPServer.Vscode, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.ts"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(0)
            // 普通外部注册定义也不能被true配置重新启用，产品仍没有诊断连接。
            expect(external).toHaveBeenCalledTimes(0)
            expect(yield* lsp.status()).toEqual([])
            expect(yield* lsp.diagnostics()).toEqual({})
          } finally {
            spy.mockRestore()
            external.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance("keeps bridge diagnostics unavailable without a touch or a second request", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
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
          // 停用时连非空候选快照也不读取，连续调用不能产生首次或第二次bridge请求。
          expect(yield* lsp.diagnostics()).toEqual({})
          expect(yield* lsp.diagnostics()).toEqual({})
          expect(yield* lsp.status()).toEqual([])
          expect(call).toHaveBeenCalledTimes(0)
        } finally {
          resolve.mockRestore()
          call.mockRestore()
        }
      }),
    ),
  )
  it.instance(
    "custom LSP config cannot initialize a server or publish lsp.updated",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const lsp = yield* LSP.Service
        const updated: string[] = []
        const events = yield* EventV2Bridge.Service
        const unsubscribe = yield* events.listen((event) => {
          if (event.type === LSP.Event.Updated.type) updated.push(event.type)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        const file = path.join(dir, "sample.repro")
        yield* Effect.promise(() => Bun.write(file, "sample\n"))
        yield* lsp.touchFile(file)
        // 自定义命令也不能被执行，空状态不能误报成已连接或诊断通过。
        expect(updated).toEqual([])
        expect(yield* lsp.status()).toEqual([])
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
  )

  it.instance(
    "does not spawn builtin LSP when a config object is provided",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          // Effect 失败不运行生成器的 JS finally；由测试 scope 恢复 spy，零 spawn 断言不变。
          yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
          yield* lsp.hover({
            file: path.join(dir, "src", "inside.ts"),
            line: 0,
            character: 0,
          })
          expect(spy).toHaveBeenCalledTimes(0)
        }),
      ),
    {
      config: {
        lsp: {
          eslint: { disabled: true },
        },
      },
    },
  )

  it.instance("does not fall back to builtin LSP when VSCode bridge diagnostics fail", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
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
  )

  it.instance("does not spawn builtin LSP when VSCode bridge is unavailable for diagnostics", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
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
  )

  it.instance(
    "keeps pyright and ty disabled by default",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const ty = spyOn(LSPServer.Ty, "spawn").mockResolvedValue(undefined)
          const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.py"),
              line: 0,
              character: 0,
            })
            expect(ty).toHaveBeenCalledTimes(0)
            expect(pyright).toHaveBeenCalledTimes(0)
          } finally {
            ty.mockRestore()
            pyright.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  experimentalTyIt.instance(
    "experimentalLspTy cannot enable ty or pyright",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const ty = spyOn(LSPServer.Ty, "spawn").mockResolvedValue(undefined)
          const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.py"),
              line: 0,
              character: 0,
            })
            expect(ty).toHaveBeenCalledTimes(0)
            expect(pyright).toHaveBeenCalledTimes(0)
          } finally {
            ty.mockRestore()
            pyright.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  disabledDownloadIt.instance(
    "keeps LSP unavailable regardless of the download flag",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.py"),
              line: 0,
              character: 0,
            })
            expect(pyright).toHaveBeenCalledTimes(0)
            expect(yield* lsp.hasClients(path.join(dir, "src", "inside.py"))).toBe(false)
          } finally {
            pyright.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )
})
