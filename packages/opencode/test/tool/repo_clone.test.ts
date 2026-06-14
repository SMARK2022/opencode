import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "node:url"
import type * as Scope from "effect/Scope"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "../../src/git"
import { Global } from "@opencode-ai/core/global"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "../../src/tool/truncate"
import { RepoCloneTool } from "../../src/tool/repo_clone"
import { disposeAllInstances, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "scout",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Git.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const init = Effect.fn("RepoCloneToolTest.init")(function* () {
  const info = yield* RepoCloneTool
  return yield* info.init()
})

const git = Effect.fn("RepoCloneToolTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    }
    return stdout.trim()
  })
})

const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      }),
  )

const waitForContent = (
  fs: AppFileSystem.Interface,
  file: string,
  content: string,
  attempts = 50,
): Effect.Effect<string, AppFileSystem.Error | Error> =>
  Effect.gen(function* () {
    const actual = yield* fs.readFileStringSafe(file)
    if (actual === content) return actual
    if (attempts <= 0) return yield* Effect.fail(new Error(`timed out waiting for ${file}`))
    yield* Effect.sleep("100 millis")
    return yield* waitForContent(fs, file, content, attempts - 1)
  })

const isolateRepoCache = (fs: AppFileSystem.Interface, cache: string): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    // repo_clone 测试使用固定 GitHub shorthand；先清掉全局 cache，
    // 防止 full run 中其他 reference/read/repo 测试留下同名工作区污染内容断言。
    yield* fs.remove(cache, { recursive: true }).pipe(Effect.ignore)
    yield* Effect.addFinalizer(() => fs.remove(cache, { recursive: true }).pipe(Effect.ignore))
  })

describe("tool.repo_clone", () => {
  it.live("clones a repo into the managed cache and reuses it on subsequent calls", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const source = yield* tmpdirScoped({ git: true })
        const remoteRoot = yield* tmpdirScoped()
        const owner = "repo-clone-reuse"
        const repo = "repo"
        // 每个用例使用独立的 GitHub shorthand，避免全量 CI 并发时共享
        // Global.Path.repos 下同一个 owner/repo 缓存而互相读到对方的工作区。
        const remoteDir = path.join(remoteRoot, owner)
        const remoteRepo = path.join(remoteDir, "repo.git")
        const cache = path.join(Global.Path.repos, "github.com", owner, repo)
        yield* isolateRepoCache(fs, cache)

        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "v1\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "add readme"])
        yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])

        const tool = yield* init()
        const cloned = yield* githubBase(`file://${remoteRoot}/`, tool.execute({ repository: `${owner}/${repo}` }, ctx))
        const cached = yield* githubBase(
          `file://${remoteRoot}/`,
          tool.execute({ repository: `https://github.com/${owner}/${repo}.git` }, ctx),
        )

        expect(cloned.metadata.status).toBe("cloned")
        expect(cloned.metadata.localPath).toBe(cache)
        expect(cached.metadata.status).toBe("cached")
        expect(yield* waitForContent(fs, path.join(cloned.metadata.localPath, "README.md"), "v1\n")).toBe("v1\n")
      }),
    ),
  )

  it.live("refresh updates an existing cached clone", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const source = yield* tmpdirScoped({ git: true })
        const remoteRoot = yield* tmpdirScoped()
        const owner = "repo-clone-refresh"
        const repo = "repo"
        // refresh 会复用同一个 cache path；用例级 owner 防止别的 repo_clone
        // 场景在全量 CI 中提前写入同名缓存，导致本测试刷新错误来源。
        const remoteDir = path.join(remoteRoot, owner)
        const remoteRepo = path.join(remoteDir, "repo.git")
        const cache = path.join(Global.Path.repos, "github.com", owner, repo)
        yield* isolateRepoCache(fs, cache)

        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "v1\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "add readme"])
        yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])

        const branch = yield* git(source, ["branch", "--show-current"])
        yield* git(source, ["remote", "add", "origin", remoteRepo])
        yield* git(source, ["push", "-u", "origin", `${branch}:${branch}`])

        const tool = yield* init()
        const first = yield* githubBase(`file://${remoteRoot}/`, tool.execute({ repository: `${owner}/${repo}` }, ctx))

        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "v2\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "update readme"])
        yield* git(source, ["push", "origin", `${branch}:${branch}`])

        const refreshed = yield* githubBase(
          `file://${remoteRoot}/`,
          tool.execute({ repository: `${owner}/${repo}`, refresh: true }, ctx),
        )

        expect(first.metadata.status).toBe("cloned")
        expect(refreshed.metadata.status).toBe("refreshed")
        expect(yield* waitForContent(fs, path.join(first.metadata.localPath, "README.md"), "v2\n")).toBe("v2\n")
      }),
    ),
  )

  it.live("clones a configured branch", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const source = yield* tmpdirScoped({ git: true })
        const remoteRoot = yield* tmpdirScoped()
        const owner = "repo-clone-branch"
        const repo = "repo"
        // branch 用例也必须独立 cache；否则同名 owner/repo 会让 checkout
        // 结果依赖其他测试先后顺序，而不是依赖本用例创建的远端仓库。
        const remoteDir = path.join(remoteRoot, owner)
        const remoteRepo = path.join(remoteDir, "repo.git")
        const cache = path.join(Global.Path.repos, "github.com", owner, repo)
        yield* isolateRepoCache(fs, cache)

        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "main\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "add readme"])
        yield* git(source, ["checkout", "-b", "docs"])
        yield* Effect.promise(() => Bun.write(path.join(source, "DOCS.md"), "docs\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "add docs"])
        yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])

        const tool = yield* init()
        const result = yield* githubBase(
          `file://${remoteRoot}/`,
          tool.execute({ repository: `${owner}/${repo}`, branch: "docs" }, ctx),
        )

        expect(result.metadata.status).toBe("cloned")
        expect(result.metadata.branch).toBe("docs")
        expect(yield* waitForContent(fs, path.join(result.metadata.localPath, "DOCS.md"), "docs\n")).toBe("docs\n")
      }),
    ),
  )

  it.live("rejects invalid repository inputs", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const tool = yield* init()
        const inputs = [
          { repository: "not-a-repo", message: "git URL" },
          { repository: "git@github.com:../../../etc/passwd", message: "git URL" },
          { repository: "-u:foo/bar", message: "git URL" },
          { repository: pathToFileURL(path.join(_dir, "local.git")).href, message: "Local file" },
        ]

        yield* Effect.forEach(
          inputs,
          (input) =>
            Effect.gen(function* () {
              const result = yield* tool.execute({ repository: input.repository }, ctx).pipe(Effect.exit)

              expect(Exit.isFailure(result)).toBe(true)
              if (Exit.isFailure(result)) {
                const error = Cause.squash(result.cause)
                expect(error instanceof Error ? error.message : String(error)).toContain(input.message)
              }
            }),
          { discard: true },
        )
      }),
    ),
  )

  it.live("rejects local file repository URLs", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const source = yield* tmpdirScoped({ git: true })
        const tool = yield* init()
        const result = yield* tool.execute({ repository: pathToFileURL(source).href }, ctx).pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          const error = Cause.squash(result.cause)
          expect(error instanceof Error ? error.message : String(error)).toContain("Local file")
        }
      }),
    ),
  )
})
