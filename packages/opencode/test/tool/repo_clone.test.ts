import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "node:url"
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

const gitResult = Effect.fn("RepoCloneToolTest.gitResult")(function* (cwd: string, args: string[]) {
  // 测试仓库初始化也复用生产 Git wrapper，确保 Windows CI 上 autocrlf、fsmonitor、longpaths 等配置一致。
  const service = yield* Git.Service
  return yield* service.run(args, { cwd })
})

const git = Effect.fn("RepoCloneToolTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* gitResult(cwd, args)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || result.text().trim() || `git ${args.join(" ")} failed`)
  }
  return result.text().trim()
})

const commitFile = Effect.fn("RepoCloneToolTest.commitFile")(function* (
  cwd: string,
  file: string,
  content: string,
  message: string,
) {
  yield* Effect.promise(() => Bun.write(path.join(cwd, file), content))
  yield* git(cwd, ["add", "--", file])
  const staged = yield* git(cwd, ["diff", "--cached", "--name-only", "--", file])
  // CI 上曾出现工作区已写入但 commit 没有纳入文件的情况；先验证 staged 内容，失败时直接指向 fixture 根因。
  if (!staged.split(/\r?\n/).includes(file)) throw new Error(`git did not stage ${file}`)
  yield* git(cwd, ["commit", "-m", message])
  const clean = yield* gitResult(cwd, ["diff", "--quiet", "--exit-code", "HEAD", "--", file])
  // refresh 用例依赖远端提交真实变化；用 Git 自身 diff 判断，避免 Windows runner 上 stdout 换行形态影响 fixture 校验。
  if (clean.exitCode !== 0) throw new Error(`git did not commit ${file}`)
})

function githubFileBase(dir: string) {
  // OPENCODE_REPO_CLONE_GITHUB_BASE_URL 会作为 URL base 参与 new URL()；pathToFileURL 负责 Windows 盘符和空格路径转义。
  return pathToFileURL(dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`).href
}

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
    if (attempts <= 0) {
      return yield* Effect.fail(
        new Error(`timed out waiting for ${file}\nexpected: ${JSON.stringify(content)}\nactual: ${JSON.stringify(actual)}`),
      )
    }
    yield* Effect.sleep("100 millis")
    return yield* waitForContent(fs, file, content, attempts - 1)
  })

const isolateRepoCache = (fs: AppFileSystem.Interface, cache: string) =>
  Effect.gen(function* () {
    // repo_clone 测试使用固定 GitHub shorthand；先清掉全局 cache，
    // 防止 full run 中其他 reference/read/repo 测试留下同名工作区污染内容断言。
    yield* gitResult(cache, ["fsmonitor--daemon", "stop"]).pipe(Effect.ignore)
    yield* fs.remove(cache, { recursive: true }).pipe(Effect.ignore)
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Git for Windows 可能留下 fsmonitor 后台进程占用 .git 文件；清理前先 best-effort 停止，不影响不支持该命令的平台。
        yield* gitResult(cache, ["fsmonitor--daemon", "stop"]).pipe(Effect.ignore)
        yield* fs.remove(cache, { recursive: true }).pipe(Effect.ignore)
      }),
    )
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

        yield* commitFile(source, "README.md", "v1\n", "add readme")
        yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])
        expect(yield* git(remoteRepo, ["show", "HEAD:README.md"])).toBe("v1")

        const tool = yield* init()
        const cloned = yield* githubBase(githubFileBase(remoteRoot), tool.execute({ repository: `${owner}/${repo}` }, ctx))
        const cached = yield* githubBase(
          githubFileBase(remoteRoot),
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

        yield* commitFile(source, "README.md", "v1\n", "add readme")
        yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])

        const branch = yield* git(source, ["branch", "--show-current"])
        yield* git(source, ["remote", "add", "origin", remoteRepo])
        yield* git(source, ["push", "-u", "origin", `${branch}:${branch}`])

        const tool = yield* init()
        const first = yield* githubBase(githubFileBase(remoteRoot), tool.execute({ repository: `${owner}/${repo}` }, ctx))

        yield* commitFile(source, "README.md", "v2 updated\n", "update readme")
        yield* git(source, ["push", "origin", `${branch}:${branch}`])
        expect(yield* git(remoteRepo, ["show", `refs/heads/${branch}:README.md`])).toBe("v2 updated")

        const refreshed = yield* githubBase(
          githubFileBase(remoteRoot),
          tool.execute({ repository: `${owner}/${repo}`, refresh: true }, ctx),
        )

        expect(first.metadata.status).toBe("cloned")
        expect(refreshed.metadata.status).toBe("refreshed")
        expect(yield* waitForContent(fs, path.join(first.metadata.localPath, "README.md"), "v2 updated\n")).toBe("v2 updated\n")
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

        yield* commitFile(source, "README.md", "main\n", "add readme")
        yield* git(source, ["checkout", "-b", "docs"])
        yield* commitFile(source, "DOCS.md", "docs\n", "add docs")
        yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])
        expect(yield* git(remoteRepo, ["show", "docs:DOCS.md"])).toBe("docs")

        const tool = yield* init()
        const result = yield* githubBase(
          githubFileBase(remoteRoot),
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
