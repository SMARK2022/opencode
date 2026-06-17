export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { statSync } from "fs"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { LayerNode } from "../effect/layer-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

function makeService(filename?: string) {
  return Effect.gen(function* () {
    if (filename) yield* warnLargeWal(filename)

    const db = yield* makeDatabase

    yield* db.run("PRAGMA busy_timeout = 30000")
    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run(`PRAGMA synchronous = ${Flag.OPENCODE_DB_DURABLE ? "FULL" : "NORMAL"}`)
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db
      .run("PRAGMA wal_checkpoint(PASSIVE)")
      .pipe(Effect.catchCause((cause) => Effect.logWarning("wal_checkpoint on open failed", { cause })))
    yield* DatabaseMigration.apply(db)
    yield* Effect.addFinalizer(() =>
      db
        .run("PRAGMA wal_checkpoint(TRUNCATE)")
        .pipe(Effect.catchCause((cause) => Effect.logWarning("wal_checkpoint on close failed", { cause })), Effect.ignore),
    )

    return { db }
  }).pipe(Effect.orDie)
}

export const layer = Layer.effect(Service, makeService())

function warnLargeWal(filename: string) {
  if (filename === ":memory:") return Effect.void
  return Effect.sync(() => statSync(filename + "-wal", { throwIfNoEntry: false })).pipe(
    Effect.flatMap((stat) =>
      stat && stat.size > 1024 * 1024
        ? Effect.logWarning("large WAL file detected; recovering uncheckpointed data", {
            path: filename + "-wal",
            bytes: stat.size,
          })
        : Effect.void,
    ),
    Effect.catch(() => Effect.void),
  )
}

export function layerFromPath(filename: string) {
  return Layer.effect(Service, makeService(filename)).pipe(Layer.provide(sqliteLayer({ filename })))
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

export const defaultLayer = Layer.unwrap(
  Effect.gen(function* () {
    return layerFromPath(path())
  }),
).pipe(Layer.provide(Global.defaultLayer))

export const node = LayerNode.make(layerFromPath(path()), [])
