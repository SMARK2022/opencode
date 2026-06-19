import { Effect, Layer, Context, Schema } from "effect"
import path from "path"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { InstanceState } from "@/effect/instance-state"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: MessageV2.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: MessageV2.WithParts[] }) {
      // 修改文件追踪以「工具调用流」为主源：edit/write/apply_patch 各自携带落盘前后的
      // 文件改动证据（part.state.metadata），按文件聚合后能区分不同工具/并行 subagent
      // 的改动归属，避免 git 整树快照把并发改动并集成 A∪B。
      // worktree 与 snapshot.diffFull 同款依赖（后者内部已用 InstanceState），故此处取用不引入新运行时依赖。
      const ctx = yield* InstanceState.context
      // worktree 是 git 项目的根（与 git numstat、apply_patch 的相对基一致）；
      // 非 git 项目 worktree="/"（见 project.fromDirectory），此时退回 directory 作为相对基。
      const base = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
      const byTool = collectToolDiffs(input.messages, base)

      // git 兜底：未被任何工具记录的文件改动（write 新文件、MCP、bash、手动编辑）
      // 仍由整树快照 diff 补齐，保证「无工具的纯 shell turn」行为不回归。
      let from: string | undefined
      let to: string | undefined
      for (const item of input.messages) {
        if (!from) {
          for (const part of item.parts) {
            if (part.type === "step-start" && part.snapshot) {
              from = part.snapshot
              break
            }
          }
        }
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) to = part.snapshot
        }
      }
      const gitDiffs = from && to ? yield* snapshot.diffFull(from, to) : []

      // 合并：工具覆盖的文件优先按工具归属（Copilot working-set 语义，单条工具 diff
      // 即终态，不与 git hunk 拼接）；仅补齐工具未触及的文件。git 历史条目 file 可选，
      // 缺省视为未被工具覆盖以免误丢弃。
      // 注意 git numstat 路径相对 directory（snapshot/index.ts 中 git 以 state.directory 为
      // cwd），而工具条目相对 worktree；当 directory 是 worktree 的子目录（monorepo/
      // submodule）时两者不同基，需把 git 路径统一到 worktree 再去重，否则同一文件会重复。
      const covered = new Set(byTool.map((item) => item.file))
      const gitMerged = gitDiffs.map((item) => {
        if (item.file === undefined) return item
        const rel = toWorktreeRel(base, unquoteGitPath(item.file), ctx.directory)
        return rel === item.file ? item : { ...item, file: rel }
      })
      return [...byTool, ...gitMerged.filter((item) => item.file === undefined || !covered.has(item.file))]
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      if (!all.length) return

      const diffs = yield* computeDiff({ messages: all })
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })

      const messages = all.filter(
        (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
      )
      const target = messages.find((m) => m.info.id === input.messageID)
      if (!target || target.info.role !== "user") return
      const msgDiffs = yield* computeDiff({ messages })
      target.info.summary = { ...target.info.summary, diffs: msgDiffs }
      yield* sessions.updateMessage(target.info)
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const diffs = yield* storage
        .read<Snapshot.FileDiff[]>(["session_diff", input.sessionID])
        .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
      const next = diffs.map((item) => {
        if (item.file === undefined) return item
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
      const changed = next.some((item, i) => item.file !== diffs[i]?.file)
      if (changed) yield* storage.write(["session_diff", input.sessionID], next).pipe(Effect.ignore)
      return next
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

// 将路径统一为相对 base 的正斜杠路径，与 git numstat 输出格式对齐，
// 保证工具来源与 git 兜底来源能在合并去重时按同一 key 匹配。
// 相对路径按 fromBase（默认 base 本身）解析为绝对再求相对：git 路径来自 directory，
// 工具的 apply_patch relativePath 来自 worktree，两者需各自正确的解析基。
function toWorktreeRel(base: string, target: string, fromBase: string = base) {
  const abs = path.isAbsolute(target) ? target : path.resolve(fromBase, target)
  return path.relative(base, abs).replaceAll("\\", "/")
}

// 统计 unified diff 文本行：+ 计入 additions、- 计入 deletions，
// 排除 +++/--- 文件头（与 TUI diffLineStats 计数契约一致）。write 工具不自带计数，
// 在此由其 patch 文本现场统计。
function countPatchStats(patch: string) {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions++
    else if (line.startsWith("-")) deletions++
  }
  return { additions, deletions }
}

// 仅凭 patch 行推断变更类型（status 在 FileDiff 中可选，TUI 不渲染）：
// 只增不删视为新增、只删不增视为删除、否则视为修改。
function inferStatus(additions: number, deletions: number): "added" | "deleted" | "modified" {
  if (deletions === 0 && additions > 0) return "added"
  if (additions === 0 && deletions > 0) return "deleted"
  return "modified"
}

// 工具 metadata 形态各异，按结构特征归一为 per-file FileDiff：
// - apply_patch: metadata.files[]（relativePath 已相对 worktree，含 type/计数）
// - edit: metadata.filediff（绝对 file，含 patch/计数）
// - write: metadata.diff + metadata.filepath（绝对，仅 exists=true 有 diff，计数现场算）
function collectToolDiffs(messages: MessageV2.WithParts[], worktree: string): Snapshot.FileDiff[] {
  const byFile = new Map<string, Snapshot.FileDiff>()
  const merge = (file: string, patch: string, additions: number, deletions: number, status?: string) => {
    const rel = toWorktreeRel(worktree, file)
    const hit = byFile.get(rel)
    // 同文件多次工具编辑（并行 A/B 或多轮 edit）：patch 拼接、计数累加，
    // status 取最重（added/deleted 优先于 modified），保持单条文件终态。
    byFile.set(rel, {
      file: rel,
      patch: (hit?.patch ?? "") + patch,
      additions: (hit?.additions ?? 0) + additions,
      deletions: (hit?.deletions ?? 0) + deletions,
      status: heaviestStatus(hit?.status, mapStatus(status) ?? inferStatus(additions, deletions)),
    } satisfies Snapshot.FileDiff)
  }

  for (const msg of messages) {
    // 跳过被 undo/隐藏的整条消息，避免 cleanup 后重算时把已撤销的工具改动重新聚合。
    if (msg.info.hidden) continue
    for (const part of msg.parts) {
      if (part.hidden) continue
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const meta = part.state.metadata as Record<string, unknown>

      const files = arrayValue(meta.files)
      if (files.length) {
        // apply_patch：每个 file 条目自带 type 与增删计数
        for (const entry of files) {
          if (!entry || typeof entry !== "object") continue
          const fp = stringValue((entry as Record<string, unknown>).relativePath) ?? stringValue((entry as Record<string, unknown>).filePath) ?? ""
          if (!fp) continue
          const patch = stringValue((entry as Record<string, unknown>).patch) ?? ""
          merge(fp, patch, numberValue((entry as Record<string, unknown>).additions), numberValue((entry as Record<string, unknown>).deletions), stringValue((entry as Record<string, unknown>).type))
        }
        continue
      }

      const filediff = meta.filediff
      if (filediff && typeof filediff === "object") {
        // edit：filediff 自带 file/patch/计数（file 为绝对路径）
        const fd = filediff as Record<string, unknown>
        const fp = stringValue(fd.file)
        if (fp) merge(fp, stringValue(fd.patch) ?? "", numberValue(fd.additions), numberValue(fd.deletions))
        continue
      }

      const diff = stringValue(meta.diff)
      const fp = stringValue(meta.filepath)
      // write：filepath+diff（仅 exists=true 时 diff 存在；新文件写由 git 兜底补齐）
      if (diff && fp) {
        const { additions, deletions } = countPatchStats(diff)
        merge(fp, diff, additions, deletions)
      }
    }
  }
  return [...byFile.values()]
}

type Status = "added" | "deleted" | "modified"

function heaviestStatus(a: Status | undefined, b: Status): Status {
  if (!a) return b
  // 已是 added/deleted 的不再被后续 modified 覆盖，保留更有信号量的状态
  if (a === "added" || a === "deleted") return a
  return b
}

function mapStatus(type: string | undefined): Status | undefined {
  if (!type) return undefined
  if (type === "add") return "added"
  if (type === "delete") return "deleted"
  // update/move 及未知类型统一按 modified
  return "modified"
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}
function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export * as SessionSummary from "./summary"
