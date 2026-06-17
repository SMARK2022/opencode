import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Ripgrep.defaultLayer)

const write = (file: string, data: string) => Effect.promise(() => fs.writeFile(file, data))
const mkdir = (dir: string) => Effect.promise(() => fs.mkdir(dir, { recursive: true }))

const withTmp = <A, E, R>(body: (tmp: Awaited<ReturnType<typeof tmpdir>>) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    body,
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const withRipgrepConfig = <A, E, R>(value: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.RIPGREP_CONFIG_PATH
      process.env.RIPGREP_CONFIG_PATH = value
      return prev
    }),
    () => effect,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.RIPGREP_CONFIG_PATH
        else process.env.RIPGREP_CONFIG_PATH = prev
      }),
  )

describe("Ripgrep", () => {
  it.live("keeps ignored files out of catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes git metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".opencode", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service

          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".opencode/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".opencode/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("hidden false excludes hidden files", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        yield* write(path.join(tmp.path, "visible.txt"), "hello")
        yield* mkdir(path.join(tmp.path, ".opencode"))
        yield* write(path.join(tmp.path, ".opencode", "thing.json"), "{}")

        const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", hidden: false, limit: 10 })
        expect(files.map((item) => item.path)).toContain(RelativePath.make("visible.txt"))
        expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".opencode/thing.json"))
      }),
    ),
  )

  it.live("search returns empty when nothing matches", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        yield* write(path.join(tmp.path, "match.ts"), "const value = 'other'\n")

        const result = yield* (yield* Ripgrep.Service).search({ cwd: tmp.path, pattern: "needle" })
        expect(result.partial).toBe(false)
        expect(result.items).toEqual([])
      }),
    ),
  )

  it.live("search returns match metadata with normalized path", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        yield* mkdir(path.join(tmp.path, "src"))
        yield* write(path.join(tmp.path, "src", "match.ts"), "const needle = 1\n")

        const result = yield* (yield* Ripgrep.Service).search({ cwd: tmp.path, pattern: "needle" })
        expect(result.partial).toBe(false)
        expect(result.items).toHaveLength(1)
        expect(result.items[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result.items[0]?.line).toBe(1)
        expect(result.items[0]?.text).toContain("needle")
      }),
    ),
  )

  it.live("search supports legacy glob and include/exclude filters", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        yield* write(path.join(tmp.path, "match.ts"), "const value = 'needle'\n")
        yield* write(path.join(tmp.path, "skip.txt"), "const value = 'needle'\n")
        yield* write(path.join(tmp.path, "skip.test.ts"), "const value = 'needle'\n")

        const glob = yield* (yield* Ripgrep.Service).search({ cwd: tmp.path, pattern: "needle", glob: ["*.ts"] })
        expect(glob.items.map((item) => item.entry.path)).toEqual([
          RelativePath.make("match.ts"),
          RelativePath.make("skip.test.ts"),
        ])

        const filtered = yield* (yield* Ripgrep.Service).search({
          cwd: tmp.path,
          pattern: "needle",
          include: ["*.ts"],
          exclude: ["*.test.ts"],
        })
        expect(filtered.items.map((item) => item.entry.path)).toEqual([RelativePath.make("match.ts")])
      }),
    ),
  )

  it.live("search supports explicit absolute file targets", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        yield* write(path.join(tmp.path, "match.ts"), "const value = 'needle'\n")
        yield* write(path.join(tmp.path, "skip.ts"), "const value = 'needle'\n")

        const result = yield* (yield* Ripgrep.Service).search({
          cwd: tmp.path,
          pattern: "needle",
          file: [path.join(tmp.path, "match.ts")],
        })
        expect(result.partial).toBe(false)
        expect(result.items.map((item) => item.entry.path)).toEqual([RelativePath.make("match.ts")])
      }),
    ),
  )

  it.live("glob returns empty when the pattern matches no files", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        yield* mkdir(path.join(tmp.path, "packages", "console"))
        yield* write(path.join(tmp.path, "packages", "console", "package.json"), "{}")

        const files = yield* (yield* Ripgrep.Service).glob({ cwd: tmp.path, pattern: "packages/*", limit: 10 })
        expect(files).toEqual([])
      }),
    ),
  )

  it.live("glob returns filenames and respects filters", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        yield* write(path.join(tmp.path, "a.txt"), "hello")
        yield* write(path.join(tmp.path, "b.txt"), "world")
        yield* write(path.join(tmp.path, "keep.ts"), "yes")

        const files = yield* (yield* Ripgrep.Service).glob({ cwd: tmp.path, pattern: "*", limit: 10 })
        expect(files.map((item) => item.path).sort()).toEqual([
          RelativePath.make("a.txt"),
          RelativePath.make("b.txt"),
          RelativePath.make("keep.ts"),
        ])

        const filtered = yield* (yield* Ripgrep.Service).glob({ cwd: tmp.path, pattern: "*.ts", limit: 10 })
        expect(filtered.map((item) => item.path)).toEqual([RelativePath.make("keep.ts")])
      }),
    ),
  )

  it.live("glob fails on nonexistent directories", () =>
    Effect.gen(function* () {
      const exit = yield* (yield* Ripgrep.Service)
        .glob({ cwd: path.join(process.cwd(), "missing-ripgrep-dir"), pattern: "*", limit: 10 })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.live("search timeout returns a bounded partial result instead of failing", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        yield* write(path.join(tmp.path, "large.txt"), "x".repeat(32 * 1024 * 1024))

        const result = yield* (yield* Ripgrep.Service).search({ cwd: tmp.path, pattern: "needle", timeout: 1 })
        expect(result.items).toEqual([])
        expect(result.timedOut).toBe(true)
        expect(result.truncated).toBe(false)
      }),
    ),
  )

  it.live("search timeout does not hide invalid regex errors", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        yield* write(path.join(tmp.path, "match.txt"), "needle\n")

        const exit = yield* (yield* Ripgrep.Service).search({ cwd: tmp.path, pattern: "(", timeout: 1000 }).pipe(
          Effect.exit,
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("ignores RIPGREP_CONFIG_PATH", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        yield* write(path.join(tmp.path, "match.ts"), "const needle = 1\n")

        const result = yield* withRipgrepConfig(
          path.join(tmp.path, "missing-ripgreprc"),
          (yield* Ripgrep.Service).search({ cwd: tmp.path, pattern: "needle" }),
        )
        expect(result.items).toHaveLength(1)
      }),
    ),
  )
})
