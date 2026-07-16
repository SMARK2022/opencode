import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { VscodeBridge } from "@/ide/vscode-bridge"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LSP.node))

describe("LSP service lifecycle", () => {
  let spawnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
  })

  afterEach(() => {
    spawnSpy.mockRestore()
  })

  it.instance("init() completes without error", () => LSP.Service.use((lsp) => lsp.init()))

  it.instance("status() returns empty array initially", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        // [local-smark] 测试环境可能有 bridge registry 残留，mock 掉避免干扰
        const resolve = spyOn(VscodeBridge, "resolveBridge").mockRejectedValue(new Error("no bridge"))
        try {
          const result = yield* lsp.status()
          expect(Array.isArray(result)).toBe(true)
          expect(result.length).toBe(0)
        } finally {
          resolve.mockRestore()
        }
      }),
    ),
  )

  it.instance("diagnostics() returns empty object initially", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const resolve = spyOn(VscodeBridge, "resolveBridge").mockRejectedValue(new Error("no bridge"))
        try {
          const result = yield* lsp.diagnostics()
          expect(typeof result).toBe("object")
          expect(Object.keys(result).length).toBe(0)
        } finally {
          resolve.mockRestore()
        }
      }),
    ),
  )

  it.instance(
    "hasClients() returns false for .ts files in instance when LSP is false",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "test.ts"))
          // [local-smark] LSP 显式 false 时 hasClients 返回 false
          expect(result).toBe(false)
        }),
      ),
    { config: { lsp: false } },
  )

  it.instance("hasClients() returns false for .ts files when LSP is unset (product disabled)", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "test.ts"))
        // 没有活动后端时保持false，不以配置默认值伪造可用状态。
        expect(result).toBe(false)
      }),
    ),
  )

  it.instance(
    "hasClients() stays false even when lsp is true",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "test.ts"))
          // 配置不能重启产品已停用的能力，Read warming 也不能偷偷启动服务。
          expect(result).toBe(false)
          yield* lsp.touchFile(path.join((yield* TestInstance).directory, "test.ts"))
          expect(spawnSpy).toHaveBeenCalledTimes(0)
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance(
    "hasClients() stays false when a config object is provided",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "test.ts"))
          expect(result).toBe(false)
          yield* lsp.touchFile(path.join((yield* TestInstance).directory, "test.ts"))
          expect(spawnSpy).toHaveBeenCalledTimes(0)
        }),
      ),
    { config: { lsp: { eslint: { disabled: true } } } },
  )

  it.instance("hasClients() returns false for files outside instance", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "..", "outside.ts"))
        expect(typeof result).toBe("boolean")
      }),
    ),
  )

  it.instance("workspaceSymbol() returns empty array with no clients", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        // [local-smark] 测试环境可能有 bridge registry 残留，mock 掉避免干扰
        const resolve = spyOn(VscodeBridge, "resolveBridge").mockRejectedValue(new Error("no bridge"))
        try {
          const result = yield* lsp.workspaceSymbol("test")
          expect(Array.isArray(result)).toBe(true)
          expect(result.length).toBe(0)
        } finally {
          resolve.mockRestore()
        }
      }),
    ),
  )

  it.instance("definition() returns empty array for unknown file", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.definition({
          file: path.join((yield* TestInstance).directory, "nonexistent.ts"),
          line: 0,
          character: 0,
        })
        expect(Array.isArray(result)).toBe(true)
      }),
    ),
  )

  it.instance("references() returns empty array for unknown file", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.references({
          file: path.join((yield* TestInstance).directory, "nonexistent.ts"),
          line: 0,
          character: 0,
        })
        expect(Array.isArray(result)).toBe(true)
      }),
    ),
  )

  it.instance("multiple init() calls are idempotent", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        yield* lsp.init()
        yield* lsp.init()
        yield* lsp.init()
      }),
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
  // 避免重复展示预存错误干扰模型判断编辑是否成功
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

  test("checkedMessage confirms clean LSP results for a single file", () => {
    const result = LSP.Diagnostic.checkedMessage({ newCount: 0, existingCount: 0 }, "file")
    // clean 确认必须只在 LSP 已经返回 summary 后使用，避免模型误以为 LSP 没工作。
    expect(result).toBe("LSP checked: no errors found in this file.")
  })

  test("checkedMessage keeps existing errors as a count-only summary", () => {
    const result = LSP.Diagnostic.checkedMessage({ newCount: 0, existingCount: 4 }, "file")
    // 既有错误只给数量，不给详情，避免模型把历史问题误判成当前编辑失败。
    expect(result).toBe("LSP checked: no new errors introduced; 4 existing errors remain.")
  })

  test("checkedMessage uses changed-files copy for patch clean results", () => {
    const result = LSP.Diagnostic.checkedMessage({ newCount: 0, existingCount: 0 }, "changed-files")
    expect(result).toBe("LSP checked: no errors found in changed files.")
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

