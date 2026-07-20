import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
// #0500：cold storage pack v2 列扩展——pack entry key、Part 同行 stats 投影与 Session summary cache 状态。
// v1→v2 升级由既有数据的事务性 repack 承担（eligible v1 owner 逐批升级），迁移只补列不搬数据。
export default {
  id: "20260930100000_cold_storage_pack_v2",
  // source的V1 pack已完整部署；Native列由紧随其后的独立增量迁移负责。
  legacy: ["20260718230857_cold_storage_pack_v2"],
  up(tx) {
    return Effect.gen(function* () {
      // #0500：cold_key 在 pack row 内定位 owner entry；v1 owner 保持 NULL，读取器按状态选择唯一 decoder。
      yield* tx.run(`ALTER TABLE \`message\` ADD \`cold_key\` blob;`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`cold_key\` blob;`)
      // #0500：cold_stats 是 Tool/StepFinish 的精确只读投影；hot row 始终 NULL，不建索引。
      yield* tx.run(`ALTER TABLE \`part\` ADD \`cold_stats\` text;`)
      // #0500：summary_ref/cursor 是 DB 权威聚合唯一 cache 状态；RESTRICT FK 与 message/part 共用同一 payload 生命周期。
      yield* tx.run(`ALTER TABLE \`session\` ADD \`summary_ref\` text REFERENCES cold_storage(hash);`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`summary_cursor\` text;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`summary_initialized\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`summary_init_dirty\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`summary_seed\` text;`)
      yield* tx.run(`CREATE INDEX \`session_summary_ref_idx\` ON \`session\` (\`summary_ref\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
