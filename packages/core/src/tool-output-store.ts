export * as ToolOutputStore from "./tool-output-store"

import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { SessionSchema } from "./session/schema"
import { Identifier } from "./util/identifier"
import type { ToolOutput } from "@opencode-ai/llm"

export const MAX_LINES = 2_000
// 缺省投影与 capture 内存窗口共同收紧；retain 的原始字节仍完整保存到托管文件。
export const MAX_BYTES = 24 * 1024
export const RETENTION = Duration.days(7)

export const MANAGED_DIRECTORY = "tool-output"

export interface BoundInput {
  readonly sessionID: SessionSchema.ID
  readonly toolCallID: string
  readonly output: ToolOutput
}

export interface BoundResult {
  readonly output: ToolOutput
  readonly outputPaths: ReadonlyArray<string>
}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("ToolOutputStore.StorageError", {
  operation: Schema.Literals(["encode", "write"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Failed to ${this.operation} tool output${detail ? `: ${detail}` : ""}`
  }
}

export type Error = StorageError

export interface Interface {
  readonly limits: () => Effect.Effect<{ readonly maxLines: number; readonly maxBytes: number }>
  readonly bound: (input: BoundInput) => Effect.Effect<BoundResult, Error>
  // capture 不暴露路径给 leaf；只有 registry 的 bound 才能发布托管恢复引用。
  readonly capture: <A, E>(
    input: Pick<BoundInput, "sessionID" | "toolCallID">,
    body: (write: (chunk: Uint8Array) => Effect.Effect<void, Error>) => Effect.Effect<{ value: A; retain: boolean }, E>,
  ) => Effect.Effect<A, E | Error>
  readonly discard: (input: Pick<BoundInput, "sessionID" | "toolCallID">) => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolOutputStore") {}

const takePrefix = (input: string, maximumBytes: number) => {
  let bytes = 0
  let content = ""
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content += char
    bytes += size
  }
  return content
}

const takeSuffix = (input: string, maximumBytes: number) => {
  let bytes = 0
  const content: string[] = []
  for (const char of Array.from(input).toReversed()) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content.unshift(char)
    bytes += size
  }
  return content.join("")
}

const preview = (text: string, maxLines: number, maxBytes: number) => {
  const lines = text.split("\n")
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const sampled =
    lines.length <= maxLines
      ? text
      : [
          lines.slice(0, headLines).join("\n"),
          ...(tailLines > 0 ? [lines.slice(lines.length - tailLines).join("\n")] : []),
        ].join("\n")
  if (Buffer.byteLength(sampled, "utf-8") <= maxBytes) {
    return lines.length <= maxLines
      ? { head: sampled, tail: "" }
      : {
          head: lines.slice(0, headLines).join("\n"),
          tail: tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : "",
        }
  }
  const headBytes = Math.ceil(maxBytes / 2)
  const tailBytes = Math.floor(maxBytes / 2)
  return { head: takePrefix(sampled, headBytes), tail: takeSuffix(sampled, tailBytes) }
}

const boundedPreview = (text: string, marker: string, maxLines: number, maxBytes: number) => {
  const markerOnly = takePrefix(marker, maxBytes).split("\n").slice(0, maxLines).join("\n")
  const markerBytes = Buffer.byteLength(marker, "utf-8")
  if (maxLines <= 4 || maxBytes <= markerBytes + 4) return markerOnly
  const bounded = preview(text, maxLines - 4, maxBytes - markerBytes - 4)
  return bounded.tail ? `${bounded.head}\n\n${marker}\n\n${bounded.tail}` : `${bounded.head}\n\n${marker}`
}

const lineCount = (text: string) => {
  let count = 1
  for (const char of text) if (char === "\n") count++
  return count
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const config = yield* Effect.serviceOption(Config.Service)
    // 暂存引用只属于本次 settlement，成功、失败与中断都由 registry 收尾。
    const captures = new Map<string, { path: string; retain: boolean; flush: () => Effect.Effect<string, Error> }>()
    // Session 与 call 联合定位，避免不同 Session 的同名 call 串用原文。
    const captureKey = (input: Pick<BoundInput, "sessionID" | "toolCallID">) => JSON.stringify([input.sessionID, input.toolCallID])
    const directory = path.join(global.data, MANAGED_DIRECTORY)
    const limits = Effect.fn("ToolOutputStore.limits")(function* () {
      if (Option.isNone(config)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const entries = yield* config.value.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[])))
      const configured = Object.assign(
        {},
        ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info.tool_output ?? {}] : [])),
      )
      return { maxLines: configured.max_lines ?? MAX_LINES, maxBytes: configured.max_bytes ?? MAX_BYTES }
    })

    const write = Effect.fn("ToolOutputStore.write")(function* (content: string) {
      const file = path.join(directory, `tool_${Identifier.ascending()}`)
      yield* fs.ensureDir(directory).pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      yield* fs
        .writeFileString(file, content, { flag: "wx" })
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      return file
    })

    const discard = Effect.fn("ToolOutputStore.discard")(function* (input: Pick<BoundInput, "sessionID" | "toolCallID">) {
      const key = captureKey(input)
      const captured = captures.get(key)
      captures.delete(key)
      // 已发布路径已在 bound 中移出暂存表，不能在返回后误删可恢复的日志。
      if (captured?.path) yield* fs.remove(captured.path).pipe(Effect.orDie)
    })
    const capture = <A, E>(
      input: Pick<BoundInput, "sessionID" | "toolCallID">,
      body: (write: (chunk: Uint8Array) => Effect.Effect<void, Error>) => Effect.Effect<{ value: A; retain: boolean }, E>,
    ) => Effect.gen(function* () {
      // 小输出先在固定字节窗口中保存，不因托管目录不可写而阻止普通命令。
      const chunks: Uint8Array[] = []
      let bytes = 0
      const captured = { path: "", retain: false, flush: (): Effect.Effect<string, Error> => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        // 只屏蔽排他创建与路径登记；wx 失败没有所有权，不能删除碰撞文件。
        if (!captured.path) captured.path = yield* write("")
        // 路径已归本次 capture 所有，append 恢复可中断并保留失败 cause，ensuring 才能按所有权清理。
        yield* restore(Effect.forEach(chunks, (chunk) => fs.writeFile(captured.path, chunk, { flag: "a" }).pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause }))), { discard: true }))
        // 后续 flush 不能重放已写前缀，失败时直接终止本次 capture。
        chunks.length = 0
        bytes = 0
        return captured.path
      })) }
      let completed = false
      return yield* Effect.gen(function* () {
        const result = yield* body((chunk) => Effect.gen(function* () {
          if (!chunk.byteLength) return
          // 固定 MAX_BYTES 限制采集内存，不随用户模型预算放大或关闭。
          if (!captured.path && bytes + chunk.byteLength <= MAX_BYTES) {
            // 复制观察窗口，不能持有进程可能复用的缓冲；空 chunk 不增加对象数。
            chunks.push(Uint8Array.from(chunk))
            bytes += chunk.byteLength
            return
          }
          // 跨过限额前先写已有窗口，当前大块直接追加，不扩大内存副本。
          yield* captured.flush()
          // 直接追加原始字节保留跨块 UTF-8；ENOSPC 等映射为同类存储失败并保留 cause，不升级为会话 defect。
          yield* fs.writeFile(captured.path, chunk, { flag: "a" }).pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
        }))
        captured.retain = result.retain
        // 压缩或诊断损失要求原文时必须成功落盘；失败不能伪装成普通内存路径。
        if (result.retain) yield* captured.flush()
        // 未落盘窗口留到 bound 决定最终投影是否超限，退出状态也可能触发保留。
        captures.set(captureKey(input), captured)
        completed = true
        return result.value
      }).pipe(Effect.ensuring(Effect.suspend(() => completed || !captured.path ? Effect.void : fs.remove(captured.path).pipe(Effect.orDie))))
    })

    const bound = Effect.fn("ToolOutputStore.bound")(function* (input: BoundInput) {
      const outputLimits = yield* limits()
      const media = input.output.content.filter((item) => item.type === "file")
      const text = input.output.content.filter((item) => item.type === "text")
      const contextual =
        input.output.content.length === 0
          ? yield* Effect.try({
              try: () => JSON.stringify(input.output.structured, null, 2) ?? String(input.output.structured),
              catch: (cause) => new StorageError({ operation: "encode", cause }),
            })
          : text.map((item) => item.text).join("")
      const captured = captures.get(captureKey(input))
      const fits = lineCount(contextual) <= outputLimits.maxLines && Buffer.byteLength(contextual, "utf-8") <= outputLimits.maxBytes
      // 压缩未截断也需要恢复标记；不能只靠 outputPaths 向模型广告原文。
      if (fits && !captured?.retain)
        return {
          output: input.output,
          outputPaths: [],
        }

      // 有流式原文时复用同一个托管文件，不能把压缩后的文本另存成所谓完整原文。
      const outputPath = captured ? yield* captured.flush() : yield* write(contextual)
      const marker = captured
        ? `... output ${fits ? "presentation changed" : "truncated"}; captured raw output saved to ${outputPath} ...`
        : `... output truncated; full content saved to ${outputPath} ...`
      captures.delete(captureKey(input))
      // 通用预算仍只在这里执行；恢复标记本身也占用字节与行数预算。
      const withMarker = `${contextual}\n\n${marker}`
      // 若总预算允许就保留原 content 分段，退出状态与媒体位置不能因增加路径而变化。
      const preserveParts = lineCount(withMarker) <= outputLimits.maxLines && Buffer.byteLength(withMarker) <= outputLimits.maxBytes

      return {
        output: {
          structured: input.output.structured,
          content: preserveParts ? [...input.output.content, { type: "text" as const, text: `\n\n${marker}` }] : [
            {
              type: "text" as const,
              text: boundedPreview(contextual, marker, outputLimits.maxLines, outputLimits.maxBytes),
            },
            ...media,
          ],
        },
        outputPaths: [outputPath],
      }
    })

    const cleanup = Effect.fn("ToolOutputStore.cleanup")(function* () {
      const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])))
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      for (const entry of entries) {
        if (!entry.startsWith("tool_")) continue
        const file = path.join(directory, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
        const modified = info?.mtime.pipe(
          Option.map((date) => date.getTime()),
          Option.getOrElse(() => 0),
        )
        if (modified !== undefined && modified < cutoff) yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    return Service.of({ limits, bound, capture, discard, cleanup })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node, Config.node] })

export const nodeWithoutConfig = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })

/** Runs retention scanning once globally rather than once per active Location. */
export const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Service
    yield* store.cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [FSUtil.node, Global.node],
})
