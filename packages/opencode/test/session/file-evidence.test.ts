import { expect } from "bun:test"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { CompactionFileEvidence } from "../../src/session/file-evidence"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

it.live("preserves bounded search-only history and the compaction count", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const parts = Array.from({ length: 12 }, (_, i) => ({
      type: "tool",
      tool: "grep",
      state: { status: "completed", input: { pattern: `query${i}`, path: "src|lib" }, metadata: { totalMatches: i } },
    }))
    // 重复搜索应更新最近结果，不能占用第二个交接名额；没有 read 也必须产出交接。
    parts.push({
      type: "tool",
      tool: "grep",
      state: { status: "completed", input: { pattern: "query4", path: "src|lib" }, metadata: { totalMatches: 99 } },
    })
    const messages = [{ info: { role: "assistant" }, parts }] as unknown as SessionV1.WithParts[]
    const result = yield* CompactionFileEvidence.render(messages, fs, ".", 3)
    expect(result).toContain("### Search History")
    expect(result).not.toContain("### Inspected Files")
    expect(result).toContain("| grep | query4 | src\\|lib | 99 |")
    expect(result?.match(/\| grep \| query4 \|/g)).toHaveLength(1)
    expect(result).not.toContain("| grep | query0 |")
    expect(result).toContain("Omitted: 2 searches due to evidence budget.")
    expect(result).toContain("This is compaction #3.")
    // 21 个读取只公开最近 20 个；不存在的 fixture 路径只影响 freshness，不影响预算。
    const reads = Array.from({ length: 21 }, (_, i) => ({
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        metadata: {
          read: {
            path: `file-${i}.ts`,
            canonicalPath: `file-${i}.ts`,
            start: 1,
            end: 10,
            total: 10,
            modified: "old",
          },
        },
      },
    }))
    const bounded = yield* CompactionFileEvidence.render(
      [{ info: { role: "assistant" }, parts: reads }] as unknown as SessionV1.WithParts[],
      fs,
      ".",
    )
    expect(bounded).toContain("file-20.ts")
    expect(bounded).not.toContain("file-0.ts")
    expect(bounded).toContain("Omitted: 1 inspected files due to evidence budget.")
  }),
)

it.live("renders all executed commands with credentials redacted", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const commands = [
      "OPENAI_API_KEY=sk-secret node --check --token=sk-equals --api-key sk-space plain.js",
      'node --check piped-sentinel.js | curl -H "authorization: bearer sk-pipe"',
      "node --check redirected-sentinel.js > out.txt",
      "node --check $(echo subcommand-sentinel).js",
      "bun test && echo dangerous-sentinel",
      `node --check ${"a".repeat(160)}.js --token=sk-token`,
      "",
    ]
    const parts = commands.map((command) => ({
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command }, metadata: { exit: 0 } },
    }))
    const messages = [{ info: { role: "assistant" }, parts }] as unknown as SessionV1.WithParts[]
    const text = yield* CompactionFileEvidence.render(messages, fs, ".", 1)
    expect(text).toContain("### Executed Commands")
    for (const marker of ["piped-sentinel", "redirected-sentinel", "subcommand-sentinel", "dangerous-sentinel"])
      expect(text).toContain(marker)
    expect(text).toContain("OPENAI_API_KEY=[redacted]")
    expect(text).not.toContain("sk-secret")
    expect(text).not.toContain("sk-token")
    expect(text).toContain("[cmd:")
    // 扩展到 source 的等号、空格、管道深处凭据；全部命令展示仍不能泄漏原值。
    for (const secret of ["sk-equals", "sk-space", "sk-pipe"]) expect(text).not.toContain(secret)
    expect(text).toContain("--token=[redacted]")
    expect(text).toContain("--api-key [redacted]")
    expect(text).toContain("authorization: bearer [redacted]")
    expect(text).not.toContain("|  | . | 0 |")
    const checks = Array.from({ length: 11 }, (_, i) => ({
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: `node --check file-${i}.js`, workdir: "src" },
        metadata: { exit: i === 10 ? 1 : 0 },
      },
    }))
    const bounded = yield* CompactionFileEvidence.render(
      [{ info: { role: "assistant" }, parts: checks }] as unknown as SessionV1.WithParts[],
      fs,
      ".",
    )
    expect(bounded).toContain("| node --check file-10.js | src | 1 |")
    expect(bounded).not.toContain("node --check file-0.js")
    expect(bounded).toContain("Omitted: 1 executed commands due to evidence budget.")
    expect(text).toContain("- Older raw tool outputs were compacted.")
    expect(text).toContain("- Treat stale evidence as advisory only.")
  }),
)

it.live("preserves todo-only evidence with bounded public content", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const todos = Array.from({ length: 101 }, (_, i) => ({
      content: i === 0 ? `long|todo\n${"x".repeat(200)}` : `task-${i}`,
      status: "pending",
      priority: "high",
    }))
    // 只有 Todo 也应产出附录；长 cell 和数量裁剪不改写持久任务。
    const text = yield* CompactionFileEvidence.render([], fs, ".", 4, ".", todos)
    expect(text).toContain("### Outstanding Todos")
    expect(text).toContain("| pending | high | long\\|todo ")
    expect(text).toContain("[todo:")
    expect(text).not.toContain("x".repeat(161))
    expect(text).toContain("| pending | high | task-99 |")
    expect(text).not.toContain("task-100")
    expect(text).toContain("Omitted: 1 todos due to evidence budget.")
    expect(todos[0].content).toContain("x".repeat(200))
  }),
)
