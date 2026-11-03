export * as Format from "./format"

import { Context, Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import path from "path"
import { mergeDeep } from "remeda"
import { Config } from "./config"
import { Location } from "./location"
import { AppProcess } from "./process"
import { makeLocationNode } from "./effect/app-node"
import { builtins, definitions, type Info } from "./format/catalog"

export interface Interface {
  readonly file: (filepath: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Format") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const appProcess = yield* AppProcess.Service
    const location = yield* Location.Service
    const documents = (yield* config.entries()).flatMap((entry) =>
      entry.type === "document" && entry.info.formatter !== undefined ? [entry.info.formatter] : [],
    )
    const configured = documents.reduce<Config.Info["formatter"]>(
      (previous, current) =>
        typeof previous === "object" && typeof current === "object" ? mergeDeep(previous, current) : current,
      undefined,
    )
    const formatters: Record<string, Info> = {}
    const commands = new Map<string, string[] | false>()
    if (configured) {
      for (const item of builtins) formatters[item.name] = item
      if (typeof configured === "object") {
        for (const [name, item] of Object.entries(configured)) {
          if (["ruff", "uv"].includes(name) && (configured.ruff?.disabled || configured.uv?.disabled)) {
            delete formatters.ruff
            delete formatters.uv
            continue
          }
          if (item.disabled) {
            delete formatters[name]
            continue
          }
          const base = definitions[name]
          const info = mergeDeep(base ?? { extensions: [] }, item)
          formatters[name] = {
            ...info,
            name,
            extensions: [...(info.extensions ?? [])],
            enabled: base && !info.command ? base.enabled : async () => (info.command ? [...info.command] : false),
          }
        }
      }
    }
    // 显式 Oxfmt 开关优先于总实验开关，保持 V1 的启用次序。
    const experimentalOxfmt = /^(?:true|1|yes|on)$/i.test(
      process.env.OPENCODE_EXPERIMENTAL_OXFMT ?? process.env.OPENCODE_EXPERIMENTAL ?? "false",
    )
    return Service.of({
      file: Effect.fn("Format.file")(function* (filepath: string) {
        const matches = Object.values(formatters).filter((item) => item.extensions.includes(path.extname(filepath)))
        const ran = yield* Effect.forEach(
          matches,
          Effect.fnUntraced(function* (item) {
            const cached = commands.get(item.name)
            const command =
              cached === undefined || cached === false
                ? yield* Effect.promise((signal) =>
                    item.enabled({
                      directory: location.directory,
                      worktree: location.project.directory,
                      experimentalOxfmt,
                      // 探测与正式执行复用现有进程 owner，取消时不留下脱离作用域的进程。
                      probe: (cmd) =>
                        Effect.runPromise(
                          appProcess
                            .run(
                              ChildProcess.make(cmd[0]!, cmd.slice(1), {
                                cwd: location.directory,
                                stdin: "ignore",
                                stdout: "pipe",
                                stderr: "pipe",
                              }),
                            )
                            .pipe(
                              Effect.match({
                                onFailure: () => ({ code: 1, text: "" }),
                                onSuccess: (result) => ({
                                  code: result.exitCode,
                                  text: result.stdout.toString("utf8"),
                                }),
                              }),
                            ),
                          { signal },
                        ),
                    }),
                  )
                : cached
            commands.set(item.name, command)
            if (command === false) return false
            const args = command.map((part) => part.replace("$FILE", filepath))
            // formatter 失败沿用 V1 的记录语义，不能虚构成功修改或引入第二执行入口。
            yield* appProcess
              .run(
                ChildProcess.make(args[0]!, args.slice(1), {
                  cwd: location.directory,
                  env: item.environment,
                  extendEnv: true,
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                }),
              )
              .pipe(
                Effect.tap((result) =>
                  result.exitCode === 0
                    ? Effect.void
                    : Effect.logError("formatter exited unsuccessfully", { file: filepath, exitCode: result.exitCode }),
                ),
                Effect.catch((error) => Effect.logError("failed to format file", { file: filepath, error })),
              )
            return true
          }),
        )
        return ran.some(Boolean)
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node, Location.node, AppProcess.node] })
