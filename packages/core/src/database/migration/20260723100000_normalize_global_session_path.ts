import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// #132：Windows 全局 session.path 补全盘符
export default {
  id: "20260723100000_normalize_global_session_path",
  // 已规范化的旧库保留原完成记录，不因文件重命名再次修改路径。
  legacy: ["20260513000000_normalize_global_session_path"],
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`UPDATE \`session\`
SET \`path\` = replace(\`directory\`, '\\', '/')
WHERE \`project_id\` = 'global'
  AND \`path\` IS NOT NULL
  AND substr(\`path\`, 2, 2) != ':/'
  AND substr(replace(\`directory\`, '\\', '/'), 2, 2) = ':/'
  AND substr(replace(\`directory\`, '\\', '/'), 4) = \`path\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
