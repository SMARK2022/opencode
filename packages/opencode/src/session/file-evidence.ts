export * as CompactionFileEvidence from "./file-evidence"

import { FileEvidence } from "@opencode-ai/core/session/file-evidence"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export const kind = FileEvidence.kind

export const render = (messages: SessionV1.WithParts[], fs: FSUtil.Interface, worktree: string) =>
  FileEvidence.render(messages.flatMap((message) => message.parts.flatMap((part) =>
    part.type === "tool" && part.tool === "read" && part.state.status === "completed"
      ? [part.state.metadata.read] : [],
  )), fs, worktree)

