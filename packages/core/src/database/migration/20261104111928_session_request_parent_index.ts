import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261104111928_session_request_parent_index",
  up(tx) {
    return Effect.gen(function* () {
      // 只添加访问路径；不搬迁或改写旧消息、冷存储及请求账本。
      yield* tx.run(
        `CREATE INDEX \`message_session_parent_time_created_id_idx\` ON \`message\` (\`session_id\`,json_extract("data", '$.parentID'),\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`message_session_compaction_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`) WHERE json_extract("data", '$.role') = 'assistant' AND json_extract("data", '$.summary') = 1 AND coalesce(json_extract("data", '$.finish'), '') != '' AND coalesce(json_type("data", '$.error'), 'null') = 'null';`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
