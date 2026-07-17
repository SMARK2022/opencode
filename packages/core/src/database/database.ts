export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Sqlite } from "./sqlite"
import { Cause, Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { statSync } from "fs"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape & { readonly sync: Sqlite.DrizzleClient }
  // 同一 Layer 原生连接的同步 facade，不注册模块级最后连接或另建数据库。
  sync: Sqlite.DrizzleClient
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = (filename: string) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const sync = yield* Sqlite.Drizzle
    // 原查询能力显式携带同连接facade，参数式历史读取无需另取全局服务。
    const db = Object.assign(yield* makeDatabase, { sync })

    // busy_timeout 必须最先设置，确保后续 PRAGMA 在锁争用时能等待
    yield* db.run("PRAGMA busy_timeout = 30000")
    yield* db.run("PRAGMA journal_mode = WAL")
    // 默认 NORMAL 保留吞吐；显式 durable 才升级 FULL 的提交落盘保证，不改变事务边界。
    yield* db.run("PRAGMA synchronous = " + (Flag.OPENCODE_DB_DURABLE ? "FULL" : "NORMAL"))
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    // PASSIVE 可能因其他进程持锁失败；警告后继续启动，不中断 open
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)").pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => Effect.sync(() => {
          console.warn("wal_checkpoint on open failed (another process may be active)", { error: Cause.pretty(cause) })
        }),
      ),
    )
    // 使用本层实际打开的文件；自定义 layerFromPath 不能误检查全局数据库。
    try {
      const walStat = statSync(filename + "-wal")
      if (walStat.size > 1024 * 1024) {
        // WAL 大小只能证明 checkpoint 未充分完成，不能声称正在恢复未提交事务。
        console.warn("large WAL file detected after startup checkpoint", {
          path: filename + "-wal",
          bytes: walStat.size,
        })
      }
    } catch {
      // WAL 文件不存在是正常情况
    }
    yield* DatabaseMigration.apply(db)

    // 上层 finalizer 先于依赖连接释放执行，保留 checkpoint-before-close 顺序。
    // 条件恢复仍保留 query error 类型；仅在 finalizer 边界转为 defect，剩余失败不能伪装成功。
    yield* Effect.addFinalizer(() => checkpoint(db).pipe(Effect.orDie))
    return { db, sync }
  }).pipe(Effect.orDie),
)

// 调用者传入其 Layer 已持有的连接；多数据库实例不共享 dbRef 或另开连接。
export function checkpoint(db: DatabaseShape) {
  return db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(
    Effect.asVoid,
    // 持锁失败只报告，不阻断 native Layer 随后的 close finalizer。
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) => Effect.sync(() => console.warn("wal_checkpoint on close failed", { error: Cause.pretty(cause) })),
    ),
  )
}

// 同步事务复用 Effect 驱动的连接预约；不跨 await 持有连接，也不重复开启 Effect SQL 事务。
export function withSync<A>(database: Interface, body: (sync: Sqlite.DrizzleClient) => A) {
  return Effect.scoped(Effect.andThen(database.db.$client.reserve, Effect.sync(() => body(database.sync)))).pipe(
    Effect.orDie,
  )
}

export function layerFromPath(filename: string) {
  return layer(filename).pipe(Layer.provide(sqliteLayer({ filename })))
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
