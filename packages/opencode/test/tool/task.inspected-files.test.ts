import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { buildParentInspectedFilesSummary } from "../../src/tool/task"

// 测试用 worktree 路径——使用当前盘符避免跨盘符导致 path.relative 返回绝对路径
const WORKTREE = `${process.cwd().slice(0, 2)}/repo`

/** 构造一条 completed read tool part 的最小结构 */
function makeReadPart(
  filePath: string,
  start: number,
  end: number,
  extra?: {
    stub?: boolean | string
    canonicalPath?: string
    compacted?: boolean
    status?: string
  },
): MessageV2.ToolPart {
  return {
    id: PartID.ascending(),
    type: "tool",
    tool: "read",
    callID: "test-call-id",
    sessionID: SessionID.descending() as MessageV2.ToolPart["sessionID"],
    messageID: MessageID.ascending(),
    state: {
      // 允许传入非 completed 状态用于测试过滤逻辑
      status: (extra?.status ?? "completed") as MessageV2.ToolStateCompleted["status"],
      input: { filePath },
      output: "...",
      title: "Read",
      metadata: {
        read: {
          path: filePath,
          canonicalPath: extra?.canonicalPath ?? filePath,
          start,
          end,
          total: end,
          size: 1000,
          modified: "2026-01-01 00:00:00",
          modifiedMs: 1735689600000,
          // stub: true 被 buildParentInspectedFilesSummary 跳过；
          // stub: "high_overlap_visible" 保留（表示文件已被读过，仅当前 read 被抑制）
          ...(extra?.stub !== undefined ? { stub: extra.stub } : {}),
        },
      },
      time: {
        start: Date.now(),
        end: Date.now(),
        // compacted 的 read part 被跳过——压缩后旧 read 不再代表有效证据
        ...(extra?.compacted ? { compacted: 1 } : {}),
      },
    },
  }
}

/** 构造一条包含给定 tool parts 的 assistant message。
 *  info 使用类型断言——buildParentInspectedFilesSummary 只读 info.role，不需要完整 Assistant 结构。*/
function makeMessages(parts: MessageV2.ToolPart[]): MessageV2.WithParts[] {
  return [
    {
      info: {
        id: MessageID.ascending(),
        sessionID: SessionID.descending() as MessageV2.WithParts["info"]["sessionID"],
        role: "assistant",
        time: { created: 0 },
      } as MessageV2.WithParts["info"],
      parts,
    },
  ]
}

describe("buildParentInspectedFilesSummary", () => {
  // ===== Range 合并 =====

  describe("range merging", () => {
    test("merges overlapping ranges from multiple reads of the same file", () => {
      const messages = makeMessages([
        makeReadPart(`${WORKTREE}/src/a.ts`, 1, 100),
        makeReadPart(`${WORKTREE}/src/a.ts`, 50, 150),
        makeReadPart(`${WORKTREE}/src/a.ts`, 300, 400),
      ])
      const result = buildParentInspectedFilesSummary(messages, WORKTREE)
      expect(result).toBeDefined()
      // 1-100 和 50-150 重叠 → 合并为 1-150；300-400 不相邻 → 保持
      expect(result!).toContain("1-150")
      expect(result!).toContain("300-400")
      // 不应出现未合并的原始 range
      expect(result!).not.toContain("1-100, 50-150")
    })

    test("merges adjacent ranges (start == last.end + 1)", () => {
      const messages = makeMessages([
        makeReadPart(`${WORKTREE}/src/b.ts`, 1, 100),
        makeReadPart(`${WORKTREE}/src/b.ts`, 101, 200),
      ])
      const result = buildParentInspectedFilesSummary(messages, WORKTREE)
      // 相邻区间（101 == 100 + 1）合并为 1-200
      expect(result!).toContain("1-200")
      expect(result!).not.toMatch(/1-100.*101-200/)
    })

    test("merges contained ranges (A fully contains B)", () => {
      const messages = makeMessages([
        makeReadPart(`${WORKTREE}/src/c.ts`, 1, 100),
        makeReadPart(`${WORKTREE}/src/c.ts`, 20, 30),
      ])
      const result = buildParentInspectedFilesSummary(messages, WORKTREE)
      // 20-30 完全在 1-100 内 → 合并后仍为 1-100
      expect(result!).toContain("1-100")
      expect(result!).not.toContain("20-30")
    })

    test("sorts and merges out-of-order ranges", () => {
      const messages = makeMessages([
        makeReadPart(`${WORKTREE}/src/d.ts`, 200, 300),
        makeReadPart(`${WORKTREE}/src/d.ts`, 1, 50),
      ])
      const result = buildParentInspectedFilesSummary(messages, WORKTREE)
      // 逆序输入应排序后输出 1-50, 200-300（不相邻，保持两个）
      expect(result!).toContain("1-50")
      expect(result!).toContain("200-300")
      // 1-50 应在 200-300 之前
      expect(result!.indexOf("1-50")).toBeLessThan(result!.indexOf("200-300"))
    })

    test("keeps non-adjacent ranges separate", () => {
      const messages = makeMessages([
        makeReadPart(`${WORKTREE}/src/e.ts`, 1, 100),
        makeReadPart(`${WORKTREE}/src/e.ts`, 200, 300),
      ])
      const result = buildParentInspectedFilesSummary(messages, WORKTREE)
      expect(result!).toContain("1-100")
      expect(result!).toContain("200-300")
    })
  })

  // ===== Range 截断 =====

  test("limits to 8 ranges per file with overflow indicator", () => {
    // 构造 12 个不相邻 range，超过 8 个上限
    const parts = Array.from({ length: 12 }, (_, i) =>
      makeReadPart(`${WORKTREE}/src/f.ts`, i * 100 + 1, i * 100 + 50),
    )
    const messages = makeMessages(parts)
    const result = buildParentInspectedFilesSummary(messages, WORKTREE)
    // 截断 8 个，剩余 4 个用 ...(+4) 标记
    expect(result!).toContain("...(+4)")
  })

  test("limits to 20 files with omission notice", () => {
    // 构造 25 个不同文件，超过 20 个上限
    const parts = Array.from({ length: 25 }, (_, i) =>
      makeReadPart(`${WORKTREE}/src/file-${i}.ts`, 1, 10),
    )
    const messages = makeMessages(parts)
    const result = buildParentInspectedFilesSummary(messages, WORKTREE)
    expect(result!).toContain("Omitted: 5 files")
  })

  // ===== 去重 =====

  test("deduplicates by canonicalPath even when filePath differs", () => {
    // 同一 canonicalPath、不同 filePath（如相对路径 vs 绝对路径）应合并到同一行
    const messages = makeMessages([
      makeReadPart(`${WORKTREE}/src/g.ts`, 1, 50, { canonicalPath: `${WORKTREE}/src/g.ts` }),
      makeReadPart("./src/g.ts", 100, 150, { canonicalPath: `${WORKTREE}/src/g.ts` }),
    ])
    const result = buildParentInspectedFilesSummary(messages, WORKTREE)
    // 两个 read 合并为一行，ranges 合并
    expect(result!).toContain("1-50")
    expect(result!).toContain("100-150")
    // 只出现一次文件路径行
    const lines = result!.split("\n").filter((l) => l.includes("g.ts"))
    expect(lines.length).toBe(1)
  })

  // ===== Stub 过滤 =====

  test("skips stub: true reads but keeps stub: high_overlap_visible", () => {
    const messages = makeMessages([
      makeReadPart(`${WORKTREE}/src/h.ts`, 1, 100, { stub: true }),
      makeReadPart(`${WORKTREE}/src/h.ts`, 1, 100, { stub: "high_overlap_visible" }),
    ])
    const result = buildParentInspectedFilesSummary(messages, WORKTREE)
    // stub: true 被跳过，stub: "high_overlap_visible" 保留
    expect(result).toBeDefined()
    expect(result!).toContain("h.ts")
    expect(result!).toContain("1-100")
  })

  // ===== Compacted 过滤 =====

  test("skips compacted read parts", () => {
    const messages = makeMessages([
      makeReadPart(`${WORKTREE}/src/i.ts`, 1, 100, { compacted: true }),
      makeReadPart(`${WORKTREE}/src/j.ts`, 1, 100),
    ])
    const result = buildParentInspectedFilesSummary(messages, WORKTREE)
    // compacted 的 i.ts 被跳过，只有 j.ts 出现
    expect(result!).toContain("j.ts")
    expect(result!).not.toContain("i.ts")
  })

  // ===== 路径显示 =====

  test("shows relative path for worktree files, absolute for external", () => {
    const messages = makeMessages([
      makeReadPart(`${WORKTREE}/src/k.ts`, 1, 10),
      makeReadPart(`${process.cwd().slice(0, 2)}/other/f.ts`, 1, 10),
    ])
    const result = buildParentInspectedFilesSummary(messages, WORKTREE)
    // worktree 内文件显示相对路径
    expect(result!).toContain("src/k.ts")
    // worktree 外文件保持绝对路径（跨目录但不跨盘符，path.relative 返回 ../other/f.ts → 显示原始路径）
    expect(result!).toContain("other/f.ts")
    expect(result!).not.toContain("../")
  })

  // ===== 空输入 =====

  test("returns undefined for empty messages", () => {
    const result = buildParentInspectedFilesSummary([], WORKTREE)
    expect(result).toBeUndefined()
  })

  test("returns undefined when no completed read parts exist", () => {
    const messages = makeMessages([
      makeReadPart(`${WORKTREE}/src/l.ts`, 1, 10, { status: "running" }),
    ])
    const result = buildParentInspectedFilesSummary(messages, WORKTREE)
    expect(result).toBeUndefined()
  })
})
