import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { MessageV2 } from "@/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// 该测试覆盖会话「修改文件」追踪由「整树 git 快照 diff」改为「工具调用流聚合」的行为。
// 现状 computeDiff 仅用 snapshot.diffFull(from,to)，无 step 快照时返回空数组，
// 无法反映同 turn 内 edit/write/apply_patch 各自的文件改动，也无法在并行 subagent
// 场景下按工具归因（会把并发改动并集成 A∪B）。下列断言在旧实现下均为 RED。
const env = Layer.mergeAll(
  Session.defaultLayer,
  SessionSummary.defaultLayer,
  Snapshot.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(env)

// 构造一条带 completed 工具 part 的 assistant 消息。metadata 形态与真实 edit/write/
// apply_patch 工具返回一致（edit 用 filediff、write 用 diff+filepath、apply_patch 用 files[]），
// 这样测试断言的是行为而非实现细节。
function assistantWithTools(sessionID: SessionID, worktree: string, parts: MessageV2.Part[]): MessageV2.WithParts {
  const messageID = MessageID.ascending()
  return {
    info: {
      id: messageID,
      role: "assistant",
      sessionID,
      mode: "default",
      agent: "default",
      path: { cwd: worktree, root: worktree },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelID.make("gpt-4"),
      providerID: ProviderID.make("openai"),
      parentID: MessageID.ascending(),
      time: { created: Date.now() },
      finish: "end_turn",
    },
    parts,
  }
}

function toolPart(tool: string, metadata: Record<string, unknown>): MessageV2.Part {
  return {
    id: PartID.ascending(),
    sessionID: "" as SessionID,
    messageID: MessageID.ascending(),
    type: "tool",
    tool,
    callID: "call-" + Math.random(),
    // completed 状态携带的 metadata 是工具落盘后的文件改动证据（见 processor.completeToolCall）
    state: {
      status: "completed",
      input: {},
      output: "ok",
      title: tool,
      metadata,
      time: { start: 0, end: 1 },
    },
  } as MessageV2.Part
}

// edit 工具的 metadata：filediff 内含绝对路径的 file、patch 文本与增删计数
function editMeta(absFile: string, patch: string, additions: number, deletions: number) {
  return { diff: patch, filediff: { file: absFile, patch, additions, deletions }, diagnostics: {} }
}

// write 工具的 metadata：仅 exists=true 时带 diff；filepath 为绝对路径
function writeMeta(absFile: string, patch: string, exists = true) {
  return { filepath: absFile, exists, diff: patch, diagnostics: {} }
}

// apply_patch 工具的 metadata：files[] 每项 relativePath 已相对 worktree
function applyPatchMeta(files: Array<{ relativePath: string; type: string; patch: string; additions: number; deletions: number }>) {
  return {
    diff: files.map((f) => f.patch).join("\n"),
    files: files.map((f) => ({ filePath: "/abs/" + f.relativePath, relativePath: f.relativePath, type: f.type, patch: f.patch, additions: f.additions, deletions: f.deletions })),
    diagnostics: {},
  }
}

describe("computeDiff tool-flow aggregation", () => {
  it.live(
    "aggregates edit tool diffs by file even without git snapshots",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const summary = yield* SessionSummary.Service
        const session = yield* Session.Service
        const info = yield* session.create({})
        // 两个 edit 工具改同一文件的不同区域（模拟并行 A/B），路径为绝对路径
        const abs = dir + "/src/a.ts"
        const msg = assistantWithTools(info.id, dir, [
          toolPart("edit", editMeta(abs, "+++added-A\n", 1, 0)),
          toolPart("edit", editMeta(abs, "+++added-B\n", 1, 0)),
        ])
        const diffs = yield* summary.computeDiff({ messages: [msg] })
        // 旧实现无快照返回 []（RED）；新实现按文件归并：单条 a.ts，计数累加
        expect(diffs.length).toBe(1)
        expect(diffs[0]!.file).toBe("src/a.ts")
        expect(diffs[0]!.additions).toBe(2)
        expect(diffs[0]!.deletions).toBe(0)
      }),
    ),
  )

  it.live(
    "keeps separate files separate (no union conflation)",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const summary = yield* SessionSummary.Service
        const session = yield* Session.Service
        const info = yield* session.create({})
        const msg = assistantWithTools(info.id, dir, [
          toolPart("edit", editMeta(dir + "/a.ts", "+a\n", 1, 0)),
          toolPart("edit", editMeta(dir + "/b.ts", "+b\n", 1, 0)),
        ])
        const diffs = yield* summary.computeDiff({ messages: [msg] })
        expect(diffs.map((d) => d.file).sort()).toEqual(["a.ts", "b.ts"])
      }),
    ),
  )

  it.live(
    "counts write tool additions/deletions from its patch text",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const summary = yield* SessionSummary.Service
        const session = yield* Session.Service
        const info = yield* session.create({})
        const patch = "--- x\n+++ x\n@@\n-old\n+new\n+new2\n"
        const msg = assistantWithTools(info.id, dir, [toolPart("write", writeMeta(dir + "/c.ts", patch))])
        const diffs = yield* summary.computeDiff({ messages: [msg] })
        expect(diffs.length).toBe(1)
        expect(diffs[0]!.file).toBe("c.ts")
        // write 不自带计数，由 patch 文本统计：排除 +++/--- 头后 +2 / -1
        expect(diffs[0]!.additions).toBe(2)
        expect(diffs[0]!.deletions).toBe(1)
      }),
    ),
  )

  it.live(
    "maps apply_patch per-file entries with status from type",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const summary = yield* SessionSummary.Service
        const session = yield* Session.Service
        const info = yield* session.create({})
        // apply_patch 的 relativePath 已是 worktree-相对，不依赖 worktree 变量本身
        const msg = assistantWithTools(info.id, dir, [
          toolPart("apply_patch", applyPatchMeta([
            { relativePath: "added.ts", type: "add", patch: "+a\n", additions: 1, deletions: 0 },
            { relativePath: "removed.ts", type: "delete", patch: "-r\n", additions: 0, deletions: 1 },
          ])),
        ])
        const diffs = yield* summary.computeDiff({ messages: [msg] })
        expect(diffs.length).toBe(2)
        const byFile = Object.fromEntries(diffs.map((d) => [d.file, d]))
        expect(byFile["added.ts"]!.status).toBe("added")
        expect(byFile["removed.ts"]!.status).toBe("deleted")
      }),
    ),
  )

  it.live(
    "skips hidden tool parts so undone edits do not re-aggregate",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const summary = yield* SessionSummary.Service
        const session = yield* Session.Service
        const info = yield* session.create({})
        const visible = toolPart("edit", editMeta(dir + "/keep.ts", "+keep\n", 1, 0))
        const hidden = toolPart("edit", editMeta(dir + "/gone.ts", "+gone\n", 1, 0))
        hidden.hidden = { time: Date.now(), reason: "undo" }
        const msg = assistantWithTools(info.id, dir, [visible, hidden])
        const diffs = yield* summary.computeDiff({ messages: [msg] })
        expect(diffs.map((d) => d.file)).toEqual(["keep.ts"])
      }),
    ),
  )
})
