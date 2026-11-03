export * as ToolOutputStore from "./tool-output-store"

import path from "path"
import { Cause, Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { SessionSchema } from "./session/schema"
import { Identifier } from "./util/identifier"
import { sanitizeVisibleText } from "./util/terminal-text"
import { formatOutputTruncatedNotice, outputStats } from "./util/output-notice"
import type { ToolOutput } from "@opencode-ai/llm"

// 通用投影默认与 V1 对齐，不把它当作 Read 参数 schema 的硬上限。
export const MAX_LINES = 1_000
// 缺省投影与 capture 内存窗口共同收紧；retain 的原始字节仍完整保存到托管文件。
// #178：默认输出上限 24KiB→16KiB
export const MAX_BYTES = 16 * 1024
export const RETENTION = Duration.days(7)

export const MANAGED_DIRECTORY = "tool-output"

export interface BoundInput {
  readonly sessionID: SessionSchema.ID
  readonly toolCallID: string
  readonly output: ToolOutput
}

type CaptureInput = Pick<BoundInput, "sessionID" | "toolCallID"> & { readonly direction?: "head" | "tail" }

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
    input: CaptureInput,
    body: (write: (chunk: Uint8Array) => Effect.Effect<void, Error>) => Effect.Effect<{ value: A; retain: boolean }, E>,
    onInterrupted?: () => Effect.Effect<ToolOutput>,
  ) => Effect.Effect<A, E | Error>
  // 取消快照只供同一次 registry settlement 消费，不是另一个模型投影入口。
  readonly interrupted: (input: Pick<BoundInput, "sessionID" | "toolCallID">) => Effect.Effect<ToolOutput | undefined>
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

const preview = (text: string, maxLines: number, maxBytes: number, direction?: "head" | "tail") => {
  const lines = text.split("\n")
  // 方向是producer的呈现偏好，实际行/字节限额仍只由本owner实施。
  if (direction === "head") return { head: takePrefix(lines.slice(0, maxLines).join("\n"), maxBytes), tail: "" }
  if (direction === "tail") return { head: "", tail: takeSuffix(lines.slice(-maxLines).join("\n"), maxBytes) }
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

const boundedPreview = (
  text: string,
  format: (shown: ReturnType<typeof outputStats>, direction: "head" | "tail" | "head+tail") => string,
  maxLines: number,
  maxBytes: number,
  direction?: "head" | "tail",
) => {
  const markerBytes = Buffer.byteLength(format({ lines: maxLines, bytes: maxBytes }, direction ?? "head+tail"), "utf-8")
  // 极小预算优先保住完整恢复路径；不能裁断标签后声称原文仍可恢复。
  if (maxLines <= 4 || maxBytes <= markerBytes + 8) return format(outputStats(""), direction ?? "head")
  // 八字节覆盖分隔换行和KB/MB边界处的显示长度变化，不改变原head/tail选择。
  const bounded = preview(text, maxLines - 4, maxBytes - markerBytes - 8, direction)
  const shown = bounded.tail ? `${bounded.head}\n${bounded.tail}` : bounded.head
  const marker = format(outputStats(shown), bounded.tail ? (bounded.head ? "head+tail" : "tail") : "head")
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
    const captures = new Map<
      string,
      {
        path: string
        retain: boolean
        totalBytes: number
        direction?: "head" | "tail"
        flush: () => Effect.Effect<string, Error>
        onInterrupted?: () => Effect.Effect<ToolOutput>
      }
    >()
    // Session 与 call 联合定位，避免不同 Session 的同名 call 串用原文。
    const captureKey = (input: Pick<BoundInput, "sessionID" | "toolCallID">) =>
      JSON.stringify([input.sessionID, input.toolCallID])
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

    const discard = Effect.fn("ToolOutputStore.discard")(function* (
      input: Pick<BoundInput, "sessionID" | "toolCallID">,
    ) {
      const key = captureKey(input)
      const captured = captures.get(key)
      captures.delete(key)
      // 已发布路径已在 bound 中移出暂存表，不能在返回后误删可恢复的日志。
      if (captured?.path) yield* fs.remove(captured.path).pipe(Effect.orDie)
    })
    const capture = <A, E>(
      input: CaptureInput,
      body: (
        write: (chunk: Uint8Array) => Effect.Effect<void, Error>,
      ) => Effect.Effect<{ value: A; retain: boolean }, E>,
      onInterrupted?: () => Effect.Effect<ToolOutput>,
    ) =>
      Effect.gen(function* () {
        // 小输出先在固定字节窗口中保存，不因托管目录不可写而阻止普通命令。
        const chunks: Uint8Array[] = []
        let bytes = 0
        const captured = {
          path: "",
          retain: false,
          totalBytes: 0,
          direction: input.direction,
          onInterrupted,
          flush: (): Effect.Effect<string, Error> =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                // 排他创建、窗口追加与登记连续完成；wx 失败没有所有权，不能删除碰撞文件。
                if (!captured.path) captured.path = yield* write("")
                // 窗口最多 MAX_BYTES；一次追加和消费登记不可分割，取消后不能重放已写前缀。
                if (chunks.length)
                  yield* fs
                    .writeFile(captured.path, Buffer.concat(chunks), { flag: "a" })
                    .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
                // 只有追加成功才清空窗口；写盘失败仍由原有 typed error 和所有权清理处理。
                chunks.length = 0
                bytes = 0
                return captured.path
              }),
            ),
        }
        let completed = false
        const key = captureKey(input)
        captures.set(key, captured)
        return yield* Effect.gen(function* () {
          const result = yield* body((chunk) =>
            Effect.gen(function* () {
              if (!chunk.byteLength) return
              // 原始归档计数跨flush累加；编码未确认时不把解码窗口行数冒充原文行数。
              captured.totalBytes += chunk.byteLength
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
              yield* fs
                .writeFile(captured.path, chunk, { flag: "a" })
                .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
            }),
          )
          captured.retain = result.retain
          // 压缩或诊断损失要求原文时必须成功落盘；失败不能伪装成普通内存路径。
          if (result.retain) yield* captured.flush()
          // 未落盘窗口留到 bound 决定最终投影是否超限，退出状态也可能触发保留。
          completed = true
          return result.value
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              // 仅纯取消保留暂存；失败/defect 仍清理，registry 随后负责发布或丢弃。
              if (exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause) && onInterrupted) completed = true
            }),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              if (completed) return Effect.void
              captures.delete(key)
              return captured.path ? fs.remove(captured.path).pipe(Effect.orDie) : Effect.void
            }),
          ),
        )
      })
    const interrupted = Effect.fn("ToolOutputStore.interrupted")(function* (
      input: Pick<BoundInput, "sessionID" | "toolCallID">,
    ) {
      const captured = captures.get(captureKey(input))
      if (!captured?.onInterrupted) return
      // 中断本身也是呈现变化；即使小输出未超限，也应保留已观察的原文字节。
      captured.retain = true
      return yield* captured.onInterrupted()
    })

    const bound = Effect.fn("ToolOutputStore.bound")(function* (input: BoundInput) {
      const outputLimits = yield* limits()
      const media = input.output.content.filter((item) => item.type === "file")
      const text = input.output.content.filter((item) => item.type === "text")
      const raw =
        input.output.content.length === 0
          ? yield* Effect.try({
              try: () => JSON.stringify(input.output.structured, null, 2) ?? String(input.output.structured),
              catch: (cause) => new StorageError({ operation: "encode", cause }),
            })
          : text.map((item) => item.text).join("")
      // 领域structured和媒体不改写，避免formatter真值/文件路径被当作展示metadata消毒。
      const output = {
        ...input.output,
        content: input.output.content.map((item) =>
          item.type === "text" ? { ...item, text: sanitizeVisibleText(item.text) } : item,
        ),
      }
      const contextual =
        output.content.length === 0
          ? sanitizeVisibleText(raw)
          : output.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("")
      const captured = captures.get(captureKey(input))
      const fits =
        lineCount(contextual) <= outputLimits.maxLines &&
        Buffer.byteLength(contextual, "utf-8") <= outputLimits.maxBytes
      // 压缩未截断也需要恢复标记；不能只靠 outputPaths 向模型广告原文。
      if (fits && !captured?.retain && raw === contextual)
        return {
          output,
          outputPaths: [],
        }

      // 有流式原文时复用同一个托管文件，不能把压缩后的文本另存成所谓完整原文。
      // 展示清理同样可能丢失原始信息，归档仍保存原文/原字节，不能保存清理后的替身。
      const outputPath = captured ? yield* captured.flush() : yield* write(raw)
      const total = captured ? { bytes: captured.totalBytes } : outputStats(raw)
      const notice = (shown: ReturnType<typeof outputStats>, direction: "head" | "tail" | "head+tail") =>
        formatOutputTruncatedNotice({ source: "tool", total, shown: { direction, ...shown }, path: outputPath })
      // 未截断呈现变化仍沿原恢复广告；真实限幅才报告output_truncated。
      const marker = fits
        ? captured
          ? `... output presentation changed; captured raw output saved to ${outputPath} ...`
          : `... output presentation changed; full content saved to ${outputPath} ...`
        : notice(outputStats(""), "head")
      captures.delete(captureKey(input))
      // 通用预算仍只在这里执行；仅完整路径本身超额时允许固定notice开销。
      const withMarker = `${contextual}\n\n${marker}`
      // 若总预算允许就保留原 content 分段，退出状态与媒体位置不能因增加路径而变化。
      const preserveParts =
        lineCount(withMarker) <= outputLimits.maxLines && Buffer.byteLength(withMarker) <= outputLimits.maxBytes

      // Bash的独立末段承载退出/超时/取消通知，选择正文方向不能把执行结果截掉。
      const suffix = captured?.direction && text.length > 1 ? sanitizeVisibleText(text.at(-1)?.text ?? "") : ""
      const window = suffix ? contextual.slice(0, -suffix.length) : contextual
      const bounded = () =>
        boundedPreview(
          window,
          notice,
          outputLimits.maxLines - (suffix ? lineCount(suffix) + 2 : 0),
          outputLimits.maxBytes - (suffix ? Buffer.byteLength(suffix) + 2 : 0),
          captured?.direction,
        ) + (suffix ? `\n\n${sanitizeVisibleText(suffix)}` : "")
      return {
        output: {
          structured: input.output.structured,
          content: preserveParts
            ? [...output.content, { type: "text" as const, text: `\n\n${marker}` }]
            : [
                {
                  type: "text" as const,
                  text: bounded(),
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
          // 未知mtime不是过期证据；与stat失败一样保留文件，不能伪装为epoch零。
          Option.getOrUndefined,
        )
        if (modified !== undefined && modified < cutoff) yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    return Service.of({ limits, bound, capture, interrupted, discard, cleanup })
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
