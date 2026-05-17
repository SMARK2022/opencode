import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// #159：历史 review 代理重写为 interactive（不是 decide）
// decide 是新原生无工具模式；旧 review 会话应落到可执行的 interactive
// 六处 UPDATE 覆盖列字段与 JSON 载荷，避免 UI/统计/事件残留 review
export default {
  id: "20260725100000_migrate_review_agent",
  // source已完成的代理迁移不能因编号变化再次改写历史载荷。
  legacy: ["20260517000000_migrate_review_agent"],
  up(tx) {
    return Effect.gen(function* () {
      // session.agent 列：会话级当前代理
      // 列级字符串，非 JSON
      yield* tx.run(`UPDATE \`session\`
SET \`agent\` = 'interactive'
WHERE \`agent\` = 'review';`)
      // request_usage.agent：用量统计维度，避免 review 孤儿值
      // 与 session 同步，保证按 agent 聚合一致
      yield* tx.run(`UPDATE \`request_usage\`
SET \`agent\` = 'interactive'
WHERE \`agent\` = 'review';`)
      // message.data.agent：V1 消息 JSON 载荷
      // user/assistant 消息均可能带 agent
      yield* tx.run(`UPDATE \`message\`
SET \`data\` = json_set(\`data\`, '$.agent', 'interactive')
WHERE json_extract(\`data\`, '$.agent') = 'review';`)
      // message.data.mode：助手消息 mode 与 agent 同步
      // mode 历史与 agent 同值，需单独改写
      yield* tx.run(`UPDATE \`message\`
SET \`data\` = json_set(\`data\`, '$.mode', 'interactive')
WHERE json_extract(\`data\`, '$.mode') = 'review';`)
      // session_message.data.agent：投影/事件消息
      // agent-switched 等类型依赖此字段
      yield* tx.run(`UPDATE \`session_message\`
SET \`data\` = json_set(\`data\`, '$.agent', 'interactive')
WHERE json_extract(\`data\`, '$.agent') = 'review';`)
      // event.data.agent：事件溯源载荷
      // 不改 type，只改 data.agent 字符串
      yield* tx.run(`UPDATE \`event\`
SET \`data\` = json_set(\`data\`, '$.agent', 'interactive')
WHERE json_extract(\`data\`, '$.agent') = 'review';`)
    })
  },
} satisfies DatabaseMigration.Migration
