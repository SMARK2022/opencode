import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260616000100_request_usage",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`request_usage\` (
          \`session_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`root_request_id\` text NOT NULL,
          \`source\` text NOT NULL,
          \`status\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`variant\` text,
          \`assistant_count\` integer DEFAULT 0 NOT NULL,
          \`step_count\` integer DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`tokens_total\` integer DEFAULT 0 NOT NULL,
          \`cost_micros\` integer DEFAULT 0 NOT NULL,
          \`time_completed\` integer,
          \`error_message\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`request_usage_pk\` PRIMARY KEY(\`session_id\`, \`request_id\`),
          CONSTRAINT \`fk_request_usage_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`request_usage_assistant\` (
          \`session_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`root_request_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`variant\` text,
          \`step_count\` integer DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`tokens_total\` integer DEFAULT 0 NOT NULL,
          \`cost_micros\` integer DEFAULT 0 NOT NULL,
          \`time_completed\` integer,
          \`error_message\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`request_usage_assistant_pk\` PRIMARY KEY(\`session_id\`, \`assistant_message_id\`),
          CONSTRAINT \`fk_request_usage_assistant_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`request_usage_session_time_created_idx\` ON \`request_usage\` (\`session_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`request_usage_session_root_idx\` ON \`request_usage\` (\`session_id\`,\`root_request_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`request_usage_session_status_updated_idx\` ON \`request_usage\` (\`session_id\`,\`status\`,\`time_updated\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`request_usage_assistant_session_request_idx\` ON \`request_usage_assistant\` (\`session_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`request_usage_assistant_session_root_idx\` ON \`request_usage_assistant\` (\`session_id\`,\`root_request_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`request_usage_assistant_session_status_updated_idx\` ON \`request_usage_assistant\` (\`session_id\`,\`status\`,\`time_updated\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
