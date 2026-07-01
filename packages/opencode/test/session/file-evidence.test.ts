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
      type: "tool", tool: "grep", state: { status: "completed", input: { pattern: `query${i}`, path: "src|lib" }, metadata: { totalMatches: i } },
    }))
    // 重复搜索应更新最近结果，不能占用第二个交接名额；没有 read 也必须产出交接。
    parts.push({ type: "tool", tool: "grep", state: { status: "completed", input: { pattern: "query4", path: "src|lib" }, metadata: { totalMatches: 99 } } })
    const messages = [{ info: { role: "assistant" }, parts }] as unknown as SessionV1.WithParts[]
    const result = yield* CompactionFileEvidence.render(messages, fs, ".", 3)
    expect(result).toContain("### Search History")
    expect(result).not.toContain("### Inspected Files")
    expect(result).toContain("| grep | query4 | src\\|lib | 99 |")
    expect(result?.match(/\| grep \| query4 \|/g)).toHaveLength(1)
    expect(result).not.toContain("| grep | query0 |")
    expect(result).toContain("Omitted: 2 searches due to evidence budget.")
    expect(result).toContain("This is compaction #3.")
  }),
)

it.live("renders all executed commands with credentials redacted", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const commands = ["OPENAI_API_KEY=sk-secret node --check plain.js", "node --check piped-sentinel.js | tee out.txt", "node --check redirected-sentinel.js > out.txt", "node --check $(echo subcommand-sentinel).js", "bun test && echo dangerous-sentinel", `node --check ${"a".repeat(160)}.js --token=sk-token`]
    const parts = commands.map(command => ({ type: "tool", tool: "bash", state: { status: "completed", input: { command }, metadata: { exit: 0 } } }))
    const messages = [{ info: { role: "assistant" }, parts }] as unknown as SessionV1.WithParts[]
    const text = yield* CompactionFileEvidence.render(messages, fs, ".", 1)
    expect(text).toContain("### Executed Commands")
    for (const marker of ["piped-sentinel", "redirected-sentinel", "subcommand-sentinel", "dangerous-sentinel"]) expect(text).toContain(marker)
    expect(text).toContain("OPENAI_API_KEY=[redacted]")
    expect(text).not.toContain("sk-secret")
    expect(text).not.toContain("sk-token")
    expect(text).toContain("[cmd:")
  }),
)


