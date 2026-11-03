export * as CompactionFileEvidence from "./file-evidence"

import { FileEvidence } from "@opencode-ai/core/session/file-evidence"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Todo } from "./todo"

export const kind = FileEvidence.kind

export const render = (
  messages: SessionV1.WithParts[],
  fs: FSUtil.Interface,
  worktree: string,
  compactionCount = 1,
  directory = worktree,
  todos: readonly Todo.Info[] = [],
) =>
  FileEvidence.render(
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "tool" && part.tool === "read" && part.state.status === "completed"
          ? [part.state.metadata.read]
          : [],
      ),
    ),
    fs,
    worktree,
    {
      todos,
      compactionCount,
      searches: messages.flatMap((message) =>
        message.parts.flatMap((part) => {
          if (
            part.type !== "tool" ||
            part.state.status !== "completed" ||
            (part.tool !== "grep" && part.tool !== "glob")
          )
            return []
          const pattern = part.state.input.pattern
          if (typeof pattern !== "string" || !pattern) return []
          const count =
            part.tool === "grep"
              ? (part.state.metadata.totalMatches ?? part.state.metadata.matches)
              : (part.state.metadata.total ?? part.state.metadata.count)
          // 剪枝之后仍保存权限不完整性，不能只把零匹配交给下一轮。
          return [
            {
              tool: part.tool,
              pattern,
              path: typeof part.state.input.path === "string" ? part.state.input.path : ".",
              matches: typeof count === "number" ? count : 0,
              partial: part.state.metadata.partial === true,
            },
          ]
        }),
      ),
      directory,
      commands: messages.flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.type !== "tool" || part.tool !== "bash" || part.state.status !== "completed") return []
          const input = part.state.input
          if (typeof input.command !== "string" || !input.command.trim()) return []
          return [
            {
              command: input.command,
              ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
              ...(typeof input.workdir === "string" ? { workdir: input.workdir } : {}),
              ...(typeof part.state.metadata.exit === "number" ? { exit: part.state.metadata.exit } : {}),
            },
          ]
        }),
      ),
    },
  )
