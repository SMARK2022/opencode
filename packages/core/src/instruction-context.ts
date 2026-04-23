export * as InstructionContext from "./instruction-context"

import { Array, Effect, Layer, Schema } from "effect"
import { truthy } from "./flag/flag"
import { basename, dirname, isAbsolute, join, relative, sep } from "path"
import { FSUtil } from "./fs-util"
import { Config } from "./config"
import { LayerNodePlatform } from "./effect/app-node-platform"
import { HttpClient } from "effect/unstable/http"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"
import { makeLocationNode } from "./effect/app-node"

export class File extends Schema.Class<File>("InstructionContext.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = SystemContext.Key.make("core/instructions")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const config = yield* Config.Service
    const client = yield* HttpClient.HttpClient
    const http = HttpClient.filterStatusOk(client)

    const source = (value: ReadonlyArray<File> | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(Files),
        load: Effect.succeed(value),
        baseline: render,
        update: (_previous, current) =>
          `These instructions replace all previously loaded ambient instructions.\n\n${render(current)}`,
        removed: () => "Previously loaded instructions no longer apply.",
      })

    const observe = Effect.fn("InstructionContext.observe")(function* () {
      const start = yield* fs.resolve(location.directory)
      const stop = yield* fs.resolve(location.project.directory)
      const fromProject = relative(stop, start)
      const insideProject =
        fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject))
      const discovered = new Set<string>()
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG && insideProject) {
        for (const name of names()) {
          const matches = yield* fs.up({ targets: [name], start, stop })
          if (matches.length === 0) continue
          for (const match of matches) discovered.add(yield* fs.resolve(match))
          break
        }
      }
      // 全局首个存在项获胜；项目按文件类型选一组，不能叠加所有祖先的三种规则。
      const globals: string[] = []
      for (const candidate of [join(global.config, "AGENTS.md"), ...(names().includes("CLAUDE.md") ? [join(global.home, ".claude", "CLAUDE.md")] : [])]) {
        const resolved = yield* fs.resolve(candidate)
        if (!(yield* fs.existsSafe(resolved))) continue
        globals.push(resolved)
        break
      }
      // 配置按优先级顺序串联；latest只取最后一份文档会丢失前序有效规则。
      const configured = Array.dedupe((yield* config.entries()).flatMap(entry => entry.type === "document" ? entry.info.instructions ?? [] : []))
      const extra = yield* Effect.forEach(configured.filter(item => !/^https?:\/\//.test(item)), raw => {
        const pattern = raw.startsWith("~/") ? join(global.home, raw.slice(2)) : raw
        if (isAbsolute(pattern)) return fs.glob(basename(pattern), { cwd: dirname(pattern), absolute: true, include: "file" })
        // 关闭项目配置时，相对规则仍允许从全局配置目录解析，不再遍历项目祖先。
        return fs.globUp(pattern, Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? global.config : start, Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? global.config : insideProject ? stop : start)
      })
      const paths = Array.dedupe([...globals, ...discovered, ...extra.flat()])
      const files = yield* Effect.forEach(
        paths,
        (path) =>
          fs
            .readFileStringSafe(path)
            .pipe(
              Effect.map((content) =>
                content === undefined ? undefined : new File({ path: AbsolutePath.make(path), content }),
              ),
            ),
        { concurrency: "unbounded" },
      )
      if (files.some((file, index) => file === undefined && discovered.has(paths[index])))
        return SystemContext.unavailable
      return files.filter((file): file is File => file !== undefined)
    })

    const remote = Effect.gen(function* () {
      const urls = Array.dedupe((yield* config.entries()).flatMap(entry => entry.type === "document" ? entry.info.instructions ?? [] : [])).filter(item => /^https?:\/\//.test(item))
      return yield* Effect.forEach(urls, url => http.get(url).pipe(
        Effect.flatMap(response => response.text),
        Effect.timeout("5 seconds"),
        Effect.map(content => ({ url, content })),
      ), { concurrency: 4 }).pipe(Effect.map(files => files.filter(file => file.content !== "")))
    })

    yield* registry.register({
      key,
      load: Effect.all([
      observe().pipe(
        Effect.map((files) =>
          files === SystemContext.unavailable
            ? source(files)
            : files.length === 0
              ? SystemContext.empty
              : source(files),
        ),
        Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
      ),
      remote.pipe(Effect.map(remoteContext), Effect.catch(() => Effect.succeed(remoteContext(SystemContext.unavailable)))),
      ]).pipe(Effect.map(SystemContext.combine)),
    })
  }),
)

export const node = makeLocationNode({
  name: "instruction-context",
  layer,
  deps: [FSUtil.node, Global.node, Location.node, SystemContextRegistry.node, Config.node, LayerNodePlatform.httpClient],
})

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}

export function names() {
  const claude = !truthy("OPENCODE_DISABLE_CLAUDE_CODE") && !truthy("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT")
  return ["AGENTS.md", ...(claude ? ["CLAUDE.md"] : []), "CONTEXT.md"]
}

const RemoteFiles = Schema.Array(Schema.Struct({ url: Schema.String, content: Schema.String }))

function remoteContext(files: typeof RemoteFiles.Type | SystemContext.Unavailable) {
  if (files !== SystemContext.unavailable && files.length === 0) return SystemContext.empty
  const render = (values: typeof RemoteFiles.Type) => values.map(file => `Instructions from: ${file.url}\n${file.content}`).join("\n\n")
  // URL不进入本地路径codec；短暂网络失败沿Context Epoch保留已接纳正文，不伪装删除或空成功。
  return SystemContext.make({
    key: SystemContext.Key.make("core/instructions-remote"),
    codec: Schema.toCodecJson(RemoteFiles),
    load: Effect.succeed(files),
    baseline: render,
    update: (_previous, current) => `These remote instructions replace all previously loaded remote instructions.\n\n${render(current)}`,
    removed: () => "Previously loaded remote instructions no longer apply.",
  })
}
