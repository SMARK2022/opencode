import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LSP.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("LSP service lifecycle", () => {
  let spawnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
  })

  afterEach(() => {
    spawnSpy.mockRestore()
  })

  it.live("init() completes without error", () => provideTmpdirInstance(() => LSP.Service.use((lsp) => lsp.init())))

  it.live("status() returns empty array initially", () =>
    provideTmpdirInstance(() =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.status()
          expect(Array.isArray(result)).toBe(true)
          expect(result.length).toBe(0)
        }),
      ),
    ),
  )

  it.live("diagnostics() returns empty object initially", () =>
    provideTmpdirInstance(() =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.diagnostics()
          expect(typeof result).toBe("object")
          expect(Object.keys(result).length).toBe(0)
        }),
      ),
    ),
  )

  it.live("hasClients() returns false for .ts files in instance when LSP is false", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const result = yield* lsp.hasClients(path.join(dir, "test.ts"))
            // [local-smark] LSP 显式 false 时 hasClients 返回 false
            expect(result).toBe(false)
          }),
        ),
      { config: { lsp: false } },
    ),
  )

  it.live("hasClients() returns true for .ts files when LSP is unset (default enabled)", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.hasClients(path.join(dir, "test.ts"))
          // [local-smark] 未配置 lsp 时默认启用，hasClients 对 .ts 返回 true
          expect(result).toBe(true)
        }),
      ),
    ),
  )

  it.live("hasClients() returns true for .ts files in instance when lsp is true", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const result = yield* lsp.hasClients(path.join(dir, "test.ts"))
            expect(result).toBe(true)
          }),
        ),
      { config: { lsp: true } },
    ),
  )

  it.live("hasClients() keeps built-in LSPs when config object is provided", () =>
    provideTmpdirInstance(
      (dir) =>
        LSP.Service.use((lsp) =>
          Effect.gen(function* () {
            const result = yield* lsp.hasClients(path.join(dir, "test.ts"))
            expect(result).toBe(true)
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

  it.live("hasClients() returns false for files outside instance", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.hasClients(path.join(dir, "..", "outside.ts"))
          expect(typeof result).toBe("boolean")
        }),
      ),
    ),
  )

  it.live("workspaceSymbol() returns empty array with no clients", () =>
    provideTmpdirInstance(() =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.workspaceSymbol("test")
          expect(Array.isArray(result)).toBe(true)
          expect(result.length).toBe(0)
        }),
      ),
    ),
  )

  it.live("definition() returns empty array for unknown file", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.definition({
            file: path.join(dir, "nonexistent.ts"),
            line: 0,
            character: 0,
          })
          expect(Array.isArray(result)).toBe(true)
        }),
      ),
    ),
  )

  it.live("references() returns empty array for unknown file", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.references({
            file: path.join(dir, "nonexistent.ts"),
            line: 0,
            character: 0,
          })
          expect(Array.isArray(result)).toBe(true)
        }),
      ),
    ),
  )

  it.live("multiple init() calls are idempotent", () =>
    provideTmpdirInstance(() =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          yield* lsp.init()
          yield* lsp.init()
          yield* lsp.init()
        }),
      ),
    ),
  )
})

describe("LSP.Diagnostic", () => {
  test("pretty() formats error diagnostic", () => {
    const result = LSP.Diagnostic.pretty({
      range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } },
      message: "Type 'string' is not assignable to type 'number'",
      severity: 1,
    } as any)
    expect(result).toBe("ERROR [10:5] Type 'string' is not assignable to type 'number'")
  })

  test("pretty() formats warning diagnostic", () => {
    const result = LSP.Diagnostic.pretty({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      message: "Unused variable",
      severity: 2,
    } as any)
    expect(result).toBe("WARN [1:1] Unused variable")
  })

  test("pretty() defaults to ERROR when no severity", () => {
    const result = LSP.Diagnostic.pretty({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: "Something wrong",
    } as any)
    expect(result).toBe("ERROR [1:1] Something wrong")
  })

  // [local-smark] reportDelta 增量诊断测试：只显示 baseline 中不存在的新错误，
  // 避免重复展示预存错误干扰模型判断编辑是否成功。
  function makeDiag(line: number, message: string, severity = 1) {
    return {
      range: { start: { line, character: 0 }, end: { line, character: 10 } },
      message,
      severity,
    } as any
  }

  test("reportDelta only shows errors not in baseline", () => {
    const baseline = [makeDiag(0, "old error A"), makeDiag(5, "old error B")]
    const current = [makeDiag(0, "old error A"), makeDiag(5, "old error B"), makeDiag(10, "new error C")]
    const result = LSP.Diagnostic.reportDelta("test.ts", current, baseline)
    expect(result).toContain("new error C")
    expect(result).not.toContain("old error A")
    expect(result).not.toContain("old error B")
  })

  test("reportDelta returns empty when no new errors", () => {
    const baseline = [makeDiag(0, "existing error")]
    const current = [makeDiag(0, "existing error")]
    const result = LSP.Diagnostic.reportDelta("test.ts", current, baseline)
    expect(result).toBe("")
  })

  test("reportDelta shows all current errors when baseline is empty", () => {
    const current = [makeDiag(0, "error A"), makeDiag(5, "error B")]
    const result = LSP.Diagnostic.reportDelta("test.ts", current, [])
    expect(result).toContain("error A")
    expect(result).toContain("error B")
  })

  test("reportDelta uses new-diagnostics tag", () => {
    const result = LSP.Diagnostic.reportDelta("test.ts", [makeDiag(0, "new error")], [])
    expect(result).toContain("<new-diagnostics")
    expect(result).not.toContain("<diagnostics")
  })

  test("reportDelta filters non-error severity", () => {
    const current = [makeDiag(0, "warning", 2), makeDiag(1, "error", 1)]
    const result = LSP.Diagnostic.reportDelta("test.ts", current, [])
    expect(result).toContain("error")
    expect(result).not.toContain("warning")
  })

  test("reportDelta truncates at 5 errors", () => {
    const current = Array.from({ length: 7 }, (_, i) => makeDiag(i, `error ${i}`))
    const result = LSP.Diagnostic.reportDelta("test.ts", current, [])
    expect(result).toContain("error 0")
    expect(result).toContain("error 4")
    expect(result).not.toContain("error 5")
    expect(result).toContain("... and 2 more")
  })

  test("report truncates at 5 errors", () => {
    const issues = Array.from({ length: 7 }, (_, i) => makeDiag(i, `error ${i}`))
    const result = LSP.Diagnostic.report("test.ts", issues)
    expect(result).toContain("error 0")
    expect(result).toContain("error 4")
    expect(result).not.toContain("error 5")
    expect(result).toContain("... and 2 more")
  })

  // [local-smark] deltaSummary 增量摘要测试：供 TUI 渲染紧凑状态行
  test("deltaSummary returns correct counts for mixed new and existing", () => {
    const baseline = [makeDiag(0, "old error A"), makeDiag(5, "old error B")]
    const current = [makeDiag(0, "old error A"), makeDiag(5, "old error B"), makeDiag(10, "new error C")]
    const result = LSP.Diagnostic.deltaSummary(current, baseline)
    expect(result.newCount).toBe(1)
    expect(result.existingCount).toBe(2)
  })

  test("deltaSummary returns zero new when all exist in baseline", () => {
    const baseline = [makeDiag(0, "error A")]
    const current = [makeDiag(0, "error A")]
    const result = LSP.Diagnostic.deltaSummary(current, baseline)
    expect(result.newCount).toBe(0)
    expect(result.existingCount).toBe(1)
  })

  test("deltaSummary returns all new when baseline is empty", () => {
    const current = [makeDiag(0, "error A"), makeDiag(5, "error B")]
    const result = LSP.Diagnostic.deltaSummary(current, [])
    expect(result.newCount).toBe(2)
    expect(result.existingCount).toBe(0)
  })

  // [local-smark] newErrors 返回新错误数组，供 metadata 存储给 TUI 渲染
  test("newErrors returns only errors not in baseline", () => {
    const baseline = [makeDiag(0, "old error")]
    const current = [makeDiag(0, "old error"), makeDiag(5, "new error")]
    const result = LSP.Diagnostic.newErrors(current, baseline)
    expect(result).toHaveLength(1)
    expect(result[0].message).toBe("new error")
  })
})
