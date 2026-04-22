import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260623000000_session_step_usage",
  up(tx) {
    // 旧回填漏掉 native 结算且只取 V1 最后一步；升级修正基数，运行时仍由同一 projector 增量维护。
    return tx
      .run(`
        UPDATE session
        -- 仅修 token 基数；cost 已有独立账本，不能借这次回填改变历史费用。
        SET (tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write) = (
          SELECT
            coalesce(sum(json_extract(data, '$.tokens.input')), 0),
            coalesce(sum(json_extract(data, '$.tokens.output')), 0),
            coalesce(sum(json_extract(data, '$.tokens.reasoning')), 0),
            coalesce(sum(json_extract(data, '$.tokens.cache.read')), 0),
            coalesce(sum(json_extract(data, '$.tokens.cache.write')), 0)
          FROM (
            SELECT part.data FROM part
            JOIN message ON message.id = part.message_id
            -- part 与消息 owner 必须属于同一会话，避免错误关联把其他会话用量带入。
            WHERE part.session_id = session.id AND message.session_id = session.id
              AND json_extract(message.data, '$.role') = 'assistant'
              AND json_extract(part.data, '$.type') = 'step-finish'
            UNION ALL
            -- native 已确认用量在助手行上，不在 V1 part 表；未结算行的空 tokens 不参与求和。
            SELECT data FROM session_message
            WHERE session_id = session.id AND type = 'assistant'
          )
        )
      `)
      // SQL 失败交给迁移事务回滚且不写完成记录，不能吞错后让错误用量基数继续使用。
      .pipe(Effect.asVoid)
  },
} satisfies DatabaseMigration.Migration
