import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { inArray } from "drizzle-orm"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { sanitizeVisibleText } from "@opencode-ai/core/util/terminal-text"
import { Tool } from "./tool"
import { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { select, statusResult } from "@/session/compaction"

const historyDescription = `Search or read archived messages from earlier in this session (or prior sessions via scope="global") when a current action needs an exact detail omitted from the rolling summary and visible tail.

USE for a specific uncertainty gap: an exact error, config value, command flag, file detail, or rejected approach needed for the current step.
SKIP when the summary and visible tail already answer it. Never search merely because compaction happened or to reconstruct the transcript.

Search defaults to the current session. Use scope="global" only when the evidence may belong to another session. Global hits include a short sessionTitle and message time.

1. Search uses literal substring matching. Pass ONE short, distinctive token, not a natural-language phrase.
   Good: { operation:"search", query:"ECONNREFUSED" }
   Good: { operation:"search", query:"auth.get" }
   Bad: { operation:"search", query:"redis connection refused error fix" }
2. Inspect snippets. Read only when surrounding text is needed: pass the hit's ref unchanged. The first read includes up to 512 characters before the match and uses 4000 chars by default. Adjust chars only when you know the required window; for continuation, pass the returned nextOffset unchanged.
3. Stop as soon as the fact is recovered.

Use the default 4000 ms first. If timedOut=true, repeat the same query and scope to resume automatically without a cursor or page number. To request more hits after reaching maxResults, increase maxResults with the same query and scope; the host reuses earlier hits and resumes the scan. If timedOut=false, remainingMessages=0, and readErrors=0, an empty result means no match was found. Search again after completion if the history changed. Nonempty hits remain usable when a search stops early.`

const HistoryInput = Schema.Struct({
  operation: Schema.Literals(["search", "read"]).annotate({
    description: "Search archived evidence or read a bounded slice from a search hit.",
  }),
  query: Schema.optionalKey(Schema.String).annotate({
    description: "Search query: a distinctive literal substring.",
  }),
  scope: Schema.optionalKey(Schema.Literals(["session", "global"])).annotate({
    description:
      "Search only (omit for read). Use session by default; use global when evidence may belong to a prior session.",
  }),
  timeout: Schema.optionalKey(Schema.Number).annotate({
    description: "Milliseconds per search (default 4000).",
  }),
  maxResults: Schema.optionalKey(Schema.Number).annotate({
    description: "Number of search hits (default 10).",
  }),
  ref: Schema.optionalKey(Schema.String).annotate({
    description: "Read only (omit for search). Copy one ref returned by search unchanged.",
  }),
  offset: Schema.optionalKey(Schema.Number).annotate({
    description:
      "Read only (omit for search). Explicit character offset; omit to include up to 512 characters before the match.",
  }),
  chars: Schema.optionalKey(Schema.Number).annotate({
    description: "Number of characters to read (default 4000).",
  }),
})

const result = (output: string) => ({ title: "Context history", output, metadata: { truncated: false } })

const singleLine = (text: string, limit: number) =>
  [...sanitizeVisibleText(text).replace(/\s+/gu, " ")].slice(0, limit).join("")

function alignOffset(text: string, offset: number) {
  const index = Math.max(0, Math.min(text.length, offset))
  return index > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(index)) && /[\uD800-\uDBFF]/u.test(text.charAt(index - 1))
    ? index - 1
    : index
}

export const ContextCompact = Tool.define(
  "context_compact",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description: SessionCompaction.CONTEXT_COMPACT_DESCRIPTION,
      parameters: SessionCompaction.CONTEXT_COMPACT_INPUT,
      execute: Effect.fnUntraced(function* (
        args: typeof SessionCompaction.CONTEXT_COMPACT_INPUT.Type,
        ctx: Tool.Context,
      ) {
        yield* ctx.ask({
          permission: "context_compact",
          patterns: [args.operation],
          always: ["*"],
          metadata: { operation: args.operation },
        })
        if (args.operation === "status") {
          const model = ctx.extra!.model as Provider.Model
          const cut = yield* select({ messages: ctx.messages, cfg: yield* config.get(), model })
          return { title: "Context compaction", metadata: {}, output: JSON.stringify(statusResult(ctx.messages, cut)) }
        }
        if (!args.summary?.trim() || !ctx.messages.some((m) => m.info.id === args.tailStartID))
          throw new Error("propose requires a current message ID and a nonblank summary")
        return { title: "Context compaction", metadata: {}, output: JSON.stringify({ status: "accepted" }) }
      }),
    }
  }),
)

type HistoryArgs = typeof HistoryInput.Type

export const ContextHistory = Tool.define(
  "context_history",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const scans = new Map<string, SessionHistory.ArchiveScan>()
    return {
      description: historyDescription,
      parameters: HistoryInput,
      execute: Effect.fnUntraced(function* (args: HistoryArgs, ctx: Tool.Context) {
        yield* ctx.ask({
          permission: "context_history",
          patterns: [args.operation],
          always: ["*"],
          metadata: { operation: args.operation, scope: args.scope },
        })
        if (args.operation === "read") {
          const { ref = "" } = args
          const { text, anchorOffset } = yield* Database.withSync(database, (db) => SessionHistory.readArchive(db, ref))
          const { offset = anchorOffset - 512, chars = 4000 } = args
          const start = alignOffset(text, offset)
          const cut = alignOffset(text, start + Math.max(1, chars))
          const end = cut === start ? Math.min(start + 2, text.length) : cut
          return result(`ref=${ref} offset=${start} total=${text.length} nextOffset=${end}\n${text.slice(start, end)}`)
        }
        const { query: literal = "", scope = "session", timeout = 4000, maxResults = 10 } = args
        const query = literal.trim()
        const key = JSON.stringify([ctx.sessionID, scope, query.replace(/[A-Z]/g, (letter) => letter.toLowerCase())])
        let state = scans.get(key)
        const search = { sessionID: ctx.sessionID, scope, query, deadline: Date.now() + timeout, maxResults }
        for (;;) {
          const output = yield* Database.withSync(database, (db) => {
            const page = SessionHistory.searchArchive(db, { ...search, state })
            state = page.state
            if (!state.eof && !page.timedOut && page.hits.length < maxResults) return
            const hits = page.hits
            const ids = hits.map((hit) => hit.sessionID)
            const rows =
              scope === "global" && ids.length
                ? db
                    .select({ id: SessionTable.id, title: SessionTable.title })
                    .from(SessionTable)
                    .where(inArray(SessionTable.id, ids))
                    .all()
                : []
            const titles = new Map(rows.map((row) => [row.id, singleLine(row.title, 120)]))
            const lines = hits.map((hit) => {
              const source =
                scope === "global"
                  ? ` sessionTitle=${titles.get(hit.sessionID)} time=${new Date(hit.time).toISOString()}`
                  : ""
              return `ref=${hit.ref} role=${hit.role} partType=${hit.partType}${source} snippet=${singleLine(hit.snippet, 360)}`
            })
            if (state.eof) scans.delete(key)
            else scans.set(key, state)
            return result(
              [
                `items=${hits.length} timedOut=${page.timedOut}`,
                `scannedMessages=${state.scanned} totalMessages=${state.total} remainingMessages=${state.eof ? 0 : state.total - state.scanned} readErrors=${state.errors}`,
                ...lines,
              ].join("\n"),
            )
          })
          if (output) return output
          yield* Effect.yieldNow
        }
      }),
    }
  }),
)
