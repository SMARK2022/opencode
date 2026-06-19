import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import path from "path"
import { ToolDiffs } from "@opencode-ai/core/session/tool-diffs"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "@/snapshot"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "./session"
import { SessionID, MessageID } from "./schema"
import { Config } from "@/config/config"

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
  readonly computeDiff: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const events = yield* EventV2Bridge.Service
    const nativeMessages = yield* SessionStore.Service
    const config = yield* Config.Service

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: SessionV1.WithParts[] }) {
      // 修改文件追踪以「工具调用流」为主源：edit/write/apply_patch 各自携带落盘前后的
      // 文件改动证据（part.state.metadata），按文件聚合后能区分不同工具/并行 subagent
      // 的改动归属，避免 git 整树快照把并发改动并集成 A∪B。
      // worktree 与 snapshot.diffFull 同款依赖（后者内部已用 InstanceState），故此处取用不引入新运行时依赖。
      const ctx = yield* InstanceState.context
      // worktree 是 git 项目的根（与 git numstat、apply_patch 的相对基一致）；
      // 非 git 项目 worktree="/"（见 project.fromDirectory），此时退回 directory 作为相对基。
      const base = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
      const byTool = ToolDiffs.collect(input.messages.flatMap((message) => message.info.hidden ? [] :
        message.parts.flatMap((part) => part.hidden || part.type !== "tool" || part.state.status !== "completed"
          ? [] : [part.state.metadata]),
      ), base)

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
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
        },
      })
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: [] })
      if ((yield* config.get()).snapshot === false) return
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      if (!all.length) return

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
      if (!input.messageID) return []
      // 两代消息分表；按已保存的身份读取Native摘要，不执行工具或解析模型可见文本。
      const native = yield* nativeMessages.message(SessionMessage.ID.make(input.messageID))
      if (native?.sessionID === input.sessionID && native.message.type === "user") {
        return native.message.summary?.diffs.map((item) => ({ ...item })) ?? []
      }
      const message = (yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
        (item) => item.info.id === input.messageID,
      )
      if (!message || message.info.role !== "user") return []
      const diffs = message.info.summary?.diffs ?? []
      return diffs.map((item) => {
        if (item.file === undefined) return item
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)


// 将路径统一为相对 base 的正斜杠路径，与 git numstat 输出格式对齐，
// 保证工具来源与 git 兜底来源能在合并去重时按同一 key 匹配。
// 相对路径按 fromBase（默认 base 本身）解析为绝对再求相对：git 路径来自 directory，
// 工具的 apply_patch relativePath 来自 worktree，两者需各自正确的解析基。
function toWorktreeRel(base: string, target: string, fromBase: string = base) {
  const abs = path.isAbsolute(target) ? target : path.resolve(fromBase, target)
  return path.relative(base, abs).replaceAll("\\", "/")
}

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, Snapshot.node, EventV2Bridge.node, Config.node, SessionStore.node],
})

export * as SessionSummary from "./summary"
