import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createPendingToolInputParser,
  formatPendingCounts,
  formatPendingPathLabel,
} from "../../../src/routes/session/pending-tool-input"

describe("pending tool input parser (#187)", () => {
  test("edit parser counts old/new lines from streamed raw JSON", () => {
    // #187：分段推入仍应得到稳定 added/removed
    const parser = createPendingToolInputParser("edit")
    const raw = JSON.stringify({
      filePath: "src/a.ts",
      oldString: "one\ntwo\n",
      newString: "one\ntwo\nthree\n",
    })
    // #187：人为切断 JSON，验证跨分片拼接
    parser.push(raw.slice(0, 20))
    parser.push(raw.slice(20))
    const stats = parser.stats()
    expect(stats?.filePath).toBe("src/a.ts")
    expect(stats?.removed).toBe(2)
    expect(stats?.added).toBe(3)
    // canonical Edit 使用 path；同一解析器保留完整 old/new 计行语义。
    const native = createPendingToolInputParser("edit")
    native.push(JSON.stringify({ path: "src/native.ts", oldString: "one\ntwo\n", newString: "new\n" }))
    expect(native.stats()).toMatchObject({ filePath: "src/native.ts", removed: 2, added: 1 })
  })

  test("write parser counts content lines and path", () => {
    // #187：write 只有 added，removed 为 0
    const parser = createPendingToolInputParser("write")
    parser.push(JSON.stringify({ filePath: "b.ts", content: "a\nb\nc" }))
    const stats = parser.stats()
    expect(stats?.filePath).toBe("b.ts")
    expect(stats?.added).toBe(3)
    expect(stats?.removed).toBe(0)
    // 两字段分别累积，兼有时优先 filePath，不能生成 b.tsother.ts。
    const native = createPendingToolInputParser("write")
    native.push(JSON.stringify({ filePath: "b.ts", path: "other.ts", content: "a\nb\nc" }))
    expect(native.stats()).toMatchObject({ filePath: "b.ts", added: 3, removed: 0 })
  })

  test("apply_patch parser tracks file headers and diff lines", () => {
    // #187：patchText 流式识别文件与 +/- 行
    const parser = createPendingToolInputParser("apply_patch")
    const patch = "*** Begin Patch\n*** Update File: x.ts\n@@\n-old\n+new\n+new2\n*** End Patch\n"
    parser.push(JSON.stringify({ patchText: patch }))
    const stats = parser.stats()
    expect(stats?.fileCount).toBeGreaterThanOrEqual(1)
    expect((stats?.added ?? 0) + (stats?.removed ?? 0)).toBeGreaterThan(0)
  })

  test("unknown tool parser stays empty", () => {
    // #187：未知 tool 不抛错、无统计
    const parser = createPendingToolInputParser("bash")
    parser.push('{"command":"ls"}')
    expect(parser.stats()).toBeUndefined()
  })

  test("formatPendingCounts uses + then - order for #189 UI", () => {
    // #189：+N -M 顺序
    expect(formatPendingCounts({ fileCount: 1, added: 1, removed: 2 })).toBe(" +1 -2")
    expect(formatPendingPathLabel("src/space file.ts", 1)).toBe("src/space file.ts")
  })

  test("edit path and counts compose the pending headline contract", () => {
    // #187：path + counts 文案合同，替代 source frame harness
    const parser = createPendingToolInputParser("edit")
    parser.push(
      JSON.stringify({
        filePath: "src/space file.ts",
        oldString: "a\nb\n",
        newString: "a\n",
      }),
    )
    const stats = parser.stats()
    const headline = `Edit ${formatPendingPathLabel(stats?.filePath, stats?.fileCount ?? 0)}${formatPendingCounts(stats)}`
    expect(headline).toBe("Edit src/space file.ts +1 -2")
  })

  test("apply_patch multi-file headline uses fileCount when path absent", () => {
    // #187：多文件 patch 标题用 N files
    const parser = createPendingToolInputParser("apply_patch")
    const patch =
      "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Update File: b.ts\n@@\n+x\n+y\n*** End Patch\n"
    parser.push(JSON.stringify({ patchText: patch }))
    const stats = parser.stats()!
    const label = formatPendingPathLabel(undefined, stats.fileCount)
    const headline = `Patch ${label}${formatPendingCounts(stats)}`
    expect(label).toContain("file")
    expect(headline.startsWith("Patch ")).toBe(true)
    expect(formatPendingCounts(stats).length).toBeGreaterThan(0)
  })
})


test("progress interval is 50ms after #189", async () => {
  // #189：跟手刷新间隔
  const { PENDING_TOOL_INPUT_PROGRESS_INTERVAL } = await import("../../../src/routes/session/pending-tool-input")
  expect(PENDING_TOOL_INPUT_PROGRESS_INTERVAL).toBe(50)
})

describe("pending tool input stats pipeline (#187)", () => {
  // #187：createPendingToolInputStats 是 index.tsx 的有状态接线（signal+200ms 节流），
  // #187：用 solid root 驱动 part signal 验证流式 raw → stats 的行为契约（B-01 修复）
  const part = (raw: string) => ({ id: "p1", tool: "edit", state: { status: "pending", raw } })

  test("throttles streamed raw into stats", async () => {
    const { createPendingToolInputStats } = await import("../../../src/routes/session/index")
    // #187：节流窗口内不更新，窗口后产出路径与 +/- 计数
    let stats: (() => { filePath?: string; added: number; removed: number } | undefined) | undefined
    const early: unknown[] = []
    createRoot(() => {
      const [p, setP] = createSignal(part(""))
      stats = createPendingToolInputStats(p as never) as never
      setP(() => part(JSON.stringify({ filePath: "src/a.ts", oldString: "x\ny\n", newString: "x\n" })) as never)
      early.push((stats as () => unknown)())
    })
    expect(early[0]).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 320))
    const after = stats!()
    expect(after?.filePath).toBe("src/a.ts")
    expect(after?.removed).toBe(2)
    expect(after?.added).toBe(1)
  })
})
