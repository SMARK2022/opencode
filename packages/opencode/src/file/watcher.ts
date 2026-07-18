import { Cause, Config as EffectConfig, Effect, Layer, Context, Schema } from "effect"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { readdir, realpath } from "fs/promises"
import path from "path"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Git } from "@/git"
import { lazy } from "@/util/lazy"
import { Config } from "@/config/config"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import * as Log from "@opencode-ai/core/util/log"

declare const OPENCODE_LIBC: string | undefined

const log = Log.create({ service: "file.watcher" })
const SUBSCRIBE_TIMEOUT_MS = 10_000

export const Event = {
  Updated: BusEvent.define(
    "file.watcher.updated",
    Schema.Struct({
      file: Schema.String,
      event: Schema.Literals(["add", "change", "unlink"]),
    }),
  ),
}

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${OPENCODE_LIBC || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch (error) {
    log.error("failed to load watcher binding", { error })
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const rel = path.relative(dir, item)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
  })
}

export const hasNativeBinding = () => !!watcher()

export interface Interface {
  // init暴露真实acquisition错误，bootstrap可统一记录失败，而直接调用者不会收到伪ready结果。
  readonly init: () => Effect.Effect<void, EffectConfig.ConfigError | Cause.TimeoutError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileWatcher") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const git = yield* Git.Service

    const state = yield* InstanceState.make(
      Effect.fn("FileWatcher.state")(
        function* () {
          if (yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER) return

          const ctx = yield* InstanceState.context

          log.info("init", { directory: ctx.directory })

          const backend = getBackend()
          if (!backend) {
            log.error("watcher backend not supported", { directory: ctx.directory, platform: process.platform })
            return
          }

          const w = watcher()
          if (!w) return

          log.info("watcher backend", { directory: ctx.directory, platform: process.platform, backend })
          // native callback通过EffectBridge恢复当前Instance上下文，跨Project事件不能借ambient状态串线。
          const bridge = yield* EffectBridge.make()
          // 只登记已完成acquisition的subscription，scope finalizer不会假设pending Promise已经产生handle。
          const subs: ParcelWatcher.AsyncSubscription[] = []
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => Promise.allSettled(subs.map((sub) => sub.unsubscribe()))),
          )

          const cb: ParcelWatcher.SubscribeCallback = bridge.bind((err, evts) => {
            if (err) return
            for (const evt of evts) {
              if (evt.type === "create") void Bus.publish(Event.Updated, { file: evt.path, event: "add" })
              if (evt.type === "update") void Bus.publish(Event.Updated, { file: evt.path, event: "change" })
              if (evt.type === "delete") void Bus.publish(Event.Updated, { file: evt.path, event: "unlink" })
            }
          })

          const subscribe = (dir: string, ignore: string[]) => {
            // pending在timeout wrapper外创建，超时后仍可观察迟到结果并执行unsubscribe，避免native资源泄漏。
            const pending = w.subscribe(dir, cb, { ignore, backend })
            return Effect.gen(function* () {
              const sub = yield* Effect.promise(() => pending)
              subs.push(sub)
            }).pipe(
              Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
              Effect.catchCause((cause) => {
                // timeout不会取消native Promise；若它迟到成功，立即退订，不能留下未归属InstanceState的listener。
                pending.then((s) => s.unsubscribe()).catch(() => {})
                // acquisition失败必须穿透到bootstrap的统一边界，不能把无listener状态缓存成初始化成功。
                return Effect.failCause(cause)
              }),
            )
          }

          const cfg = yield* config.get()
          const cfgIgnores = cfg.watcher?.ignore ?? []

          if (yield* Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER) {
            // init返回即代表backend已订阅；fork会让首个文件写入抢在native readiness前并永久丢失事件。
            yield* subscribe(ctx.directory, [...FileIgnore.PATTERNS, ...cfgIgnores, ...protecteds(ctx.directory)])
          }

          if (ctx.project.vcs === "git") {
            // root acquisition先完成再处理.git，任一必要subscription失败都会让整个InstanceState保持未初始化。
            const result = yield* git.run(["rev-parse", "--git-dir"], {
              cwd: ctx.worktree,
            })
            const resolved = result.exitCode === 0 ? path.resolve(ctx.worktree, result.text().trim()) : undefined
            const vcsDir = resolved ? yield* Effect.promise(() => realpath(resolved).catch(() => resolved)) : undefined
            if (
              vcsDir &&
              !cfgIgnores.includes(".git") &&
              !cfgIgnores.includes(vcsDir) &&
              (!resolved || !cfgIgnores.includes(resolved))
            ) {
              const ignore = (yield* Effect.promise(() => readdir(vcsDir).catch(() => []))).filter(
                (entry) => entry !== "HEAD",
              )
              // .git watcher与root watcher共享同一init契约，不能把一次性subscribe误当成后台消费循环。
              yield* subscribe(vcsDir, ignore)
            }
          }
        },
        Effect.catchCause((cause) => {
          log.error("failed to init watcher service", { cause: Cause.pretty(cause) })
          // 记录由service owner完成，但cause仍交给bootstrap决定降级策略，InstanceState不会缓存伪成功。
          return Effect.failCause(cause)
        }),
      ),
    )

    return Service.of({
      init: Effect.fn("FileWatcher.init")(function* () {
        yield* InstanceState.get(state)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Git.defaultLayer))

export * as FileWatcher from "./watcher"
