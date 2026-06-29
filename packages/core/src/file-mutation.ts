export * as FileMutation from "./file-mutation"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { createTwoFilesPatch } from "diff"
import { dirname } from "path"
import { KeyedMutex } from "./effect/keyed-mutex"
import { FSUtil } from "./fs-util"
import { normalizeLineEndings } from "./util/line-ending"

export interface Target {
  readonly canonical: string
  readonly resource: string
}

export interface WriteInput {
  readonly target: Target
  readonly content: string | Uint8Array
  readonly format?: (filepath: string) => Effect.Effect<boolean>
}

export interface TextWriteInput {
  readonly target: Target
  readonly content: string
  readonly format?: (filepath: string) => Effect.Effect<boolean>
}

export interface ConditionalWriteInput extends WriteInput {
  readonly expected: Uint8Array
}

export interface ConditionalMoveInput extends ConditionalWriteInput {
  readonly content: string
  readonly destination: Target
}
export interface RemoveInput {
  readonly target: Target
}

export class StaleContentError extends Schema.TaggedErrorClass<StaleContentError>()("FileMutation.StaleContentError", {
  path: Schema.String,
}) {}

export class TargetExistsError extends Schema.TaggedErrorClass<TargetExistsError>()("FileMutation.TargetExistsError", {
  path: Schema.String,
}) {}

export class MoveIncompleteError extends Schema.TaggedErrorClass<MoveIncompleteError>()("FileMutation.MoveIncompleteError", {
  path: Schema.String,
  destination: Schema.String,
  reason: Schema.String,
}) {}

export interface WriteResult {
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
  // 仅文本覆写生成展示patch，普通创建和二进制写入保持原结果。
  // 最终展示和增删统计必须使用同一次持锁写入的前像。
  readonly previous?: string
  readonly diff?: string
  readonly text?: string
  readonly formattedDiff?: string
  readonly formattedContent?: string
}

export interface RemoveResult {
  readonly operation: "remove"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface Interface {
  /** Create without replacing an existing target. */
  readonly create: (input: WriteInput) => Effect.Effect<WriteResult, TargetExistsError | FSUtil.Error>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, FSUtil.Error>
  /** Write text while retaining an existing UTF-8 BOM and emitting at most one BOM. */
  readonly writeTextPreservingBom: (input: TextWriteInput) => Effect.Effect<WriteResult, FSUtil.Error>
  /** Commit only if an existing target still has the expected bytes. */
  readonly writeIfUnchanged: (
    input: ConditionalWriteInput,
  ) => Effect.Effect<WriteResult, StaleContentError | FSUtil.Error>
  readonly moveIfUnchanged: (input: ConditionalMoveInput) => Effect.Effect<WriteResult, StaleContentError | MoveIncompleteError | FSUtil.Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<RemoveResult, FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileMutation") {}

/**
 * Serialize file changes by canonical target. Conditional writes compare and
 * write under the same process-local lock so cooperating OpenCode mutations do
 * not overwrite changes made from the same stale content.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        locks.withLock(target.canonical)(Effect.uninterruptible(effect))

    const writeResult = (target: Target, existed: boolean): WriteResult => ({
      operation: "write",
      target: target.canonical,
      resource: target.resource,
      existed,
    })

    const finishText = Effect.fn("FileMutation.finishText")(function* (input: TextWriteInput, previous: string, bom: boolean, existed: boolean) {
      // 外部格式化可中断；最终回读与 BOM 修复始终受目标锁和退出收尾保护。
      const readFinal = Effect.gen(function* () {
        const final = yield* fs.readFile(input.target.canonical)
        let offset = 0
        while (hasUtf8Bom(final.subarray(offset))) offset += 3
        // 以原字节修复前缀；字符串读取会隐藏 BOM，取消时也不能重编码 formatter 的半写入内容。
        if (offset !== (bom ? 3 : 0)) {
          const next = new Uint8Array(final.length - offset + (bom ? 3 : 0))
          if (bom) next.set([0xef, 0xbb, 0xbf])
          next.set(final.subarray(offset), bom ? 3 : 0)
          yield* fs.writeFile(input.target.canonical, next)
        }
        return new TextDecoder().decode(final.subarray(offset))
      })
      const formatted = input.format ? yield* input.format(input.target.canonical).pipe(
        Effect.interruptible,
        Effect.onExit((exit) => Exit.isFailure(exit) ? readFinal.pipe(Effect.asVoid) : Effect.void),
      ) : false
      const text = yield* readFinal
      const before = normalizeLineEndings(previous)
      const after = normalizeLineEndings(text)
      const submitted = normalizeLineEndings(splitBom(input.content).text)
      return {
        ...writeResult(input.target, existed),
        previous,
        diff: createTwoFilesPatch(input.target.resource, input.target.resource, before, after),
        ...(formatted ? { text } : {}),
        ...(formatted && submitted !== after ? {
          // 回传请求与最终落盘之间的实际变化，不能用请求片段伪造 formatter 结果。
          formattedDiff: createTwoFilesPatch(input.target.resource, input.target.resource, submitted, after),
          formattedContent: text,
        } : {}),
      }
    })


    const removeResult = (target: Target, existed: boolean): RemoveResult => ({
      operation: "remove",
      target: target.canonical,
      resource: target.resource,
      existed,
    })

    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const existed = yield* fs.exists(input.target.canonical)
          yield* fs.writeWithDirs(input.target.canonical, input.content)
          return writeResult(input.target, existed)
        }),
      ),
    )

    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const next = splitBom(input.content)
          const current = yield* fs
            .readFile(input.target.canonical)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
          yield* fs.writeWithDirs(
            input.target.canonical,
            joinBom(next.text, Boolean(current && hasUtf8Bom(current)) || next.bom),
          )
          if (current === undefined && !input.format) return writeResult(input.target, false)
          return yield* finishText(input, current ? splitBom(new TextDecoder().decode(current)).text : "", Boolean(current && hasUtf8Bom(current)) || next.bom, current !== undefined)
        }),
      ),
    )

    const create = Effect.fn("FileMutation.create")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const write =
            typeof input.content === "string"
              ? fs.writeFileString(input.target.canonical, input.content, { flag: "wx" })
              : fs.writeFile(input.target.canonical, input.content, { flag: "wx" })
          yield* write.pipe(
            Effect.catchReason("PlatformError", "NotFound", () =>
              fs.ensureDir(dirname(input.target.canonical)).pipe(Effect.andThen(write)),
            ),
            Effect.catchReason("PlatformError", "AlreadyExists", () =>
              Effect.fail(new TargetExistsError({ path: input.target.canonical })),
            ),
          )
          if (input.format && typeof input.content === "string")
            return yield* finishText({ ...input, content: input.content }, "", splitBom(input.content).bom, false)
          return writeResult(input.target, false)

        }),
      ),
    )

    const writeIfUnchanged = Effect.fn("FileMutation.writeIfUnchanged")((input: ConditionalWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const current = yield* fs.readFile(input.target.canonical)
          if (!sameBytes(current, input.expected)) {
            return yield* new StaleContentError({ path: input.target.canonical })
          }
          yield* typeof input.content === "string"
            ? fs.writeFileString(input.target.canonical, input.content)
            : fs.writeFile(input.target.canonical, input.content)
          if (input.format && typeof input.content === "string")
            return yield* finishText({ ...input, content: input.content }, splitBom(new TextDecoder().decode(current)).text, splitBom(input.content).bom, true)
          return writeResult(input.target, true)
        }),
      ),
    )

    const moveIfUnchanged = Effect.fn("FileMutation.moveIfUnchanged")((input: ConditionalMoveInput) => {
      const commit = Effect.gen(function* () {
        const source = yield* fs.readFile(input.target.canonical)
        if (!sameBytes(source, input.expected)) return yield* new StaleContentError({ path: input.target.canonical })
        const previous = yield* fs.readFile(input.destination.canonical)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
        // 目的地继承源BOM，格式化与最终回读沿用唯一文本收尾路径。
        yield* fs.writeWithDirs(input.destination.canonical, input.content)
        const result = yield* finishText({ ...input, target: input.destination }, previous ? splitBom(new TextDecoder().decode(previous)).text : "", splitBom(input.content).bom, previous !== undefined)
        if (input.destination.canonical !== input.target.canonical) {
          yield* fs.remove(input.target.canonical).pipe(Effect.mapError(error => new MoveIncompleteError({
            path: input.target.canonical, destination: input.destination.canonical, reason: error.message,
          })))
        }
        return result
      })
      if (input.destination.canonical === input.target.canonical) return withTargetLock(input.target)(commit)
      // 两端按同一顺序取锁，反向Move不会互相持有一半锁而死锁。
      const first = input.target.canonical < input.destination.canonical ? input.target : input.destination
      const second = first === input.target ? input.destination : input.target
      return withTargetLock(first)(withTargetLock(second)(commit))
    })

    const remove = Effect.fn("FileMutation.remove")((input: RemoveInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const existed = yield* fs.remove(input.target.canonical).pipe(
            Effect.as(true),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
          )
          return removeResult(input.target, existed)
        }),
      ),
    )

    return Service.of({ create, write, writeTextPreservingBom, writeIfUnchanged, moveIfUnchanged, remove })
  }),
)

function splitBom(text: string) {
  const stripped = text.replace(/^\uFEFF+/, "")
  return { bom: stripped.length !== text.length, text: stripped }
}

function joinBom(text: string, bom: boolean) {
  const stripped = splitBom(text).text
  return bom ? `\uFEFF${stripped}` : stripped
}

function hasUtf8Bom(content: Uint8Array) {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  return left.every((byte, index) => byte === right[index])
}

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node] })

/**
 * Deferred until the corresponding V2 integrations exist.
 */
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after V2 snapshot design exists.
// TODO: Notify LSP and collect diagnostics after V2 LSP runtime exists.
// TODO: Design multi-file transactions / rollback if apply_patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// TODO: Define crash recovery and idempotency for side effects between Tool.Called and durable settlement.
