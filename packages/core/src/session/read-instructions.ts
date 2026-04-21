export * as SessionReadInstructions from "./read-instructions"

import path from "path"
import { Effect, Option, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { InstructionContext } from "../instruction-context"
import { Location } from "../location"
import { SessionStore } from "./store"
import { SessionSchema } from "./schema"
import { AbsolutePath } from "../schema"

export const Files = Schema.Array(InstructionContext.File)

export const make = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const location = yield* Location.Service
  const store = yield* SessionStore.Service
  return Effect.fn("SessionReadInstructions.resolve")(function* (target: string, sessionID: SessionSchema.ID) {
    const root = yield* fs.realPath(location.directory)
    if (!FSUtil.contains(root, target)) return []
    const excluded = new Set(
      (yield* store.context(sessionID)).flatMap(message => message.type === "assistant" ? message.content.flatMap(part => {
        if (part.type !== "tool" || part.name !== "read" || part.time.pruned !== undefined || part.state.status !== "completed") return []
        const files = Schema.decodeUnknownOption(Files)(part.state.structured.instructions)
        if (Option.isNone(files)) return []
        const body = part.state.content.flatMap(content => content.type === "text" ? [content.text] : []).join("\n")
        // 只有实际保留给模型的完整正文才能证明已加载；pruned、限幅或压缩不能延长去重证明。
        return files.value.filter(file => body.includes(`Instructions from: ${file.path}\n${file.content}`)).map(file => file.path)
      }) : []),
    )
    const result: InstructionContext.File[] = []
    // 逐目录取首个规则类型；不扫描子树，Location根及以上由ambient Context Source承担。
    for (let directory = path.dirname(target); path.relative(root, directory) !== "" && FSUtil.contains(root, directory); directory = path.dirname(directory)) {
      for (const name of InstructionContext.names()) {
        const file = AbsolutePath.make(yield* fs.resolve(path.join(directory, name)))
        if (!(yield* fs.existsSafe(file))) continue
        if (file !== target && !excluded.has(file)) {
          const content = yield* fs.readFileStringSafe(file)
          if (content) result.push(new InstructionContext.File({ path: file, content }))
        }
        break
      }
    }
    // 并行未结算的read允许重复携带规则，不提前claim导致另一条失败时规则永久丢失。
    return result
  })
})
