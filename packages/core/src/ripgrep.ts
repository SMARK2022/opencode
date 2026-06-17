export * as Ripgrep from "./ripgrep"

import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import path from "path"
import { LayerNode } from "./effect/layer-node"
import { Entry, Match } from "./filesystem/schema"
import { FSUtil } from "./fs-util"
import { AppProcess, collectStream, waitForAbort } from "./process"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema"
import { RipgrepBinary } from "./ripgrep/binary"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const MAX_SUBMATCHES = 100
export const MAX_SEARCH_FILES = 5_000
export const MAX_SEARCH_RESULTS = 1_000

const RawMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})

type RawMatchData = (typeof RawMatch.Type)["data"]

export class Error extends Schema.TaggedErrorClass<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class InvalidPatternError extends Schema.TaggedErrorClass<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export class SearchTooBroadError extends Schema.TaggedErrorClass<SearchTooBroadError>()("Ripgrep.SearchTooBroadError", {
  maxFiles: Schema.Number,
  message: Schema.String,
}) {}

type PatternInput = string | readonly string[]

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: PatternInput
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface SearchInput extends Omit<GrepInput, "file" | "limit"> {
  readonly file?: string | readonly string[]
  readonly glob?: PatternInput
  readonly exclude?: PatternInput
  readonly limit?: number
  readonly maxFiles?: number | false
  readonly timeout?: number | false
  readonly follow?: boolean
}

export interface SearchResult {
  readonly items: readonly Match[]
  readonly partial: boolean
  readonly truncated: boolean
  readonly timedOut?: boolean
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
  readonly search: (input: SearchInput) => Effect.Effect<SearchResult, Error | InvalidPatternError | SearchTooBroadError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

const patterns = (input?: PatternInput) => {
  if (!input) return []
  return (Array.isArray(input) ? input : [input]).filter((item) => item.length > 0)
}

const clean = (input: string) =>
  input
    .replace(/^(?:\.[\\/])+/u, "")
    .replace(/^[\\/]+/u, "")
    .replaceAll("\\", "/")

const fileTargets = (cwd: string, input?: string | readonly string[]) => {
  if (!input) return ["."]
  return (Array.isArray(input) ? [...input] : [input]).map((item) => (path.isAbsolute(item) ? path.relative(cwd, item) : item))
}

function filesArgs(input: {
  hidden?: boolean
  follow?: boolean
  glob?: PatternInput
  include?: PatternInput
  exclude?: PatternInput
}) {
  return [
    "--no-config",
    "--files",
    ...(input.hidden === false ? [] : ["--hidden"]),
    ...(input.follow ? ["--follow"] : []),
    ...patterns(input.glob).map((item) => `--glob=${item}`),
    ...patterns(input.include).map((item) => `--glob=${item}`),
    ...patterns(input.exclude).map((item) => `--glob=${item.startsWith("!") ? item : `!${item}`}`),
    "--glob=!**/.git/**",
    ".",
  ]
}

function grepArgs(input: SearchInput) {
  return [
    "--no-config",
    "--json",
    "--hidden",
    "--no-messages",
    ...(input.follow ? ["--follow"] : []),
    ...patterns(input.glob).map((item) => `--glob=${item}`),
    ...patterns(input.include).map((item) => `--glob=${item}`),
    ...patterns(input.exclude).map((item) => `--glob=${item.startsWith("!") ? item : `!${item}`}`),
    "--glob=!**/.git/**",
    "--",
    input.pattern,
    ...fileTargets(input.cwd, input.file),
  ]
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const binary = yield* RipgrepBinary.Service

    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly timeout?: number | false
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
    }) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* process.spawn(
            ChildProcess.make(yield* binary.filepath, input.args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          let timedOut = false
          if (input.timeout !== false && input.timeout !== undefined && input.timeout > 0) {
            yield* Effect.sleep(`${input.timeout} millis`).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  timedOut = true
                }),
              ),
              Effect.flatMap(() => handle.kill({ forceKillAfter: "3 seconds" })),
              Effect.ignore,
              Effect.forkScoped,
            )
          }
          const rows = yield* Stream.decodeText(handle.stdout).pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            Stream.take(input.limit + 1),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )
          const truncated = rows.length > input.limit
          if (truncated) yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)

          const code = yield* handle.exitCode.pipe(
            Effect.catch((error) => (truncated || timedOut ? Effect.succeed(0) : Effect.fail(error))),
          )
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (!truncated && !timedOut && code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return {
            items: code === 1 && !truncated && !timedOut ? [] : rows.slice(0, input.limit),
            truncated,
            partial: code === 2 && !truncated,
            timedOut: timedOut || undefined,
          }
        }),
      )
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    const search: Interface["search"] = Effect.fn("Ripgrep.search")(function* (input) {
      const limit = input.limit && input.limit > 0 ? input.limit : MAX_SEARCH_RESULTS
      const maxFiles = input.maxFiles === false ? undefined : (input.maxFiles ?? MAX_SEARCH_FILES)
      if (maxFiles !== undefined && !input.file) {
        const candidates = yield* run<string>({
          cwd: input.cwd,
          limit: maxFiles,
          signal: input.signal,
          timeout: input.timeout,
          args: filesArgs({ glob: input.glob, include: input.include, exclude: input.exclude, follow: input.follow }),
          parse: (line) => Effect.succeed(clean(line)),
        })
        if (candidates.truncated) {
          return yield* new SearchTooBroadError({
            maxFiles,
            message: `Search scope is too broad: more than ${maxFiles} candidate files.`,
          })
        }
      }
      return yield* run<RawMatchData>({
        cwd: input.cwd,
        limit,
        signal: input.signal,
        timeout: input.timeout,
        pattern: input.pattern,
        args: grepArgs(input),
        parse: (line) =>
          (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES
            ? Effect.fail(failure(`Ripgrep JSON record exceeded ${MAX_RECORD_BYTES} bytes`))
            : Effect.try({
                try: () => JSON.parse(line) as unknown,
                catch: (cause) => failure("Invalid ripgrep JSON output", cause),
              })
          ).pipe(
            Effect.flatMap((json) => {
              if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                return Effect.succeed(undefined)
              return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                Effect.map((match) => ({
                  ...match.data,
                  path: { text: clean(match.data.path.text) },
                  submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                })),
                Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
              )
            }),
          ),
      }).pipe(
        Effect.map((result) => ({
          ...result,
          items: result.items.map((match) => {
            const relative = clean(match.path.text)
            const absolute = path.resolve(input.cwd, relative)
            return new Match({
              entry: new Entry({
                path: RelativePath.make(relative),
                type: "file",
                mime: FSUtil.mimeType(absolute),
              }),
              line: match.line_number,
              offset: match.absolute_offset,
              text: match.lines.text.length > 2_000 ? match.lines.text.slice(0, 2_000) + "..." : match.lines.text,
              submatches: match.submatches.map((submatch) => ({
                text: submatch.match.text,
                start: submatch.start,
                end: submatch.end,
              })),
            })
          }),
        })),
      )
    })

    return Service.of({
      glob: (input) =>
        run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden === false ? [] : ["--hidden"]),
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) =>
            Effect.succeed(clean(line)),
        }).pipe(
          Effect.map((result) =>
            result.items.map((relative) => {
              const absolute = path.resolve(input.cwd, relative)
              return new Entry({
                path: RelativePath.make(relative),
                type: "file",
                mime: FSUtil.mimeType(absolute),
              })
            }),
          ),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      find: (input) =>
        run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden === false ? [] : ["--hidden"]),
            ...(input.follow ? ["--follow"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => {
            const relative = clean(line)
            return Effect.succeed(
              new Entry({
                path: RelativePath.make(relative),
                type: "file",
                mime: FSUtil.mimeType(path.resolve(input.cwd, relative)),
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(
          Effect.map((result) => result.items),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      grep: (input) =>
        search({ ...input, file: input.file, limit: input.limit, maxFiles: false }).pipe(
          Effect.map((result) => result.items),
          Effect.catchTag("Ripgrep.SearchTooBroadError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      search,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Layer.merge(RipgrepBinary.defaultLayer, AppProcess.defaultLayer)))
export const node = LayerNode.make(layer, [RipgrepBinary.node, AppProcess.node])
