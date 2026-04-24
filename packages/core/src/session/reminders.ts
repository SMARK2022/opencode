export * as SessionReminders from "./reminders"

import path from "path"
import { eq } from "drizzle-orm"
import { ConfigProvider, DateTime, Effect } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { SessionPrompts } from "../system-context/prompts"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

export const make = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const location = yield* Location.Service
  const events = yield* EventV2.Service
  const database = yield* Database.Service
  return Effect.fn("SessionReminders.prepare")(function* (agent: string, sessionID: SessionSchema.ID, history: readonly SessionMessage.Message[]) {
    const environment = yield* ConfigProvider.ConfigProvider
    const enabled = yield* environment.load(["OPENCODE_EXPERIMENTAL_PLAN_MODE"]).pipe(
      Effect.flatMap(value => value === undefined ? environment.load(["OPENCODE_EXPERIMENTAL"]) : Effect.succeed(value)),
      Effect.map(value => value?._tag === "Value" && ["1", "true"].includes(value.value.toLowerCase())), Effect.orDie,
    )
    if (!enabled) return SessionPrompts.reminders(agent, history.some(message => message.type === "assistant" && message.agent === "plan"))
    const previous = history.findLast(message => message.type === "assistant")
    if (agent !== "plan" && previous?.agent !== "plan") return []
    const row = yield* database.db.select({ slug: SessionTable.slug, created: SessionTable.time_created }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!row) return yield* Effect.die(`Session not found: ${sessionID}`)
    // 沿V1持久slug/创建时间公式定位唯一计划文件，不搜索目录或增加另一份计划状态。
    const base = location.vcs ? path.join(location.project.directory, ".opencode", "plans") : path.join(global.data, "plans")
    const file = path.join(base, `${row.created}-${row.slug}.md`)
    const exists = yield* fs.existsSafe(file)
    const text = agent === "plan" ? SessionPrompts.planMode.replace("${planInfo}", () => exists
      ? `A plan file already exists at ${file}. You can read it and make incremental edits using the edit tool.`
      : `No plan file exists yet. You should create your plan at ${file} using the write tool.`)
      : exists ? `${SessionPrompts.buildSwitch}\n\nA plan file exists at ${file}. You should execute on the plan defined within it` : SessionPrompts.buildSwitch
    // 同阶段重试复用synthetic；再次切换必须重新提醒，不能让更早的相反模式成为最后约束。
    const boundary = history.findLastIndex(message => message.type === "agent-switched" || (message.type === "assistant" && message.agent !== agent))
    if (history.slice(boundary + 1).some(message => message.type === "synthetic" && message.text === text)) return []
    if (agent === "plan" && !exists) yield* fs.ensureDir(path.dirname(file)).pipe(Effect.orDie)
    yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: SessionMessage.ID.create(), timestamp: yield* DateTime.now, text })
    return [text]
  })
})
