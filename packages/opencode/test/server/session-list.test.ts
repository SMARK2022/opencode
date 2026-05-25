import { SessionPath } from "@opencode-ai/core/session/path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session as SessionNs } from "@/session/session"
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture"
import { mkdir, mkdtemp, realpath, rm } from "fs/promises"
import path from "path"
import os from "os"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/schema/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { $ } from "bun"
import { InstanceRef } from "@/effect/instance-ref"

const layer = (experimentalWorkspaces: boolean) =>
  AppNodeBuilder.build(LayerNode.group([Database.node, SessionNs.node, SessionProjector.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces })],
  ])
const it = testEffect(layer(false))
const itWorkspaces = testEffect(layer(true))

const withSession = (input?: Parameters<SessionNs.Interface["create"]>[0]) =>
// #228：withSession 负责会话创建与清理——acquireRelease 保证测试隔离
  Effect.acquireRelease(SessionNs.use.create(input), (created) =>
    SessionNs.Service.use((session) => session.remove(created.id).pipe(Effect.ignore)),
  )

const initGitRepo = (directory: string) =>
// #228：测试前置——临时 git repo 初始化，home 切换场景需要真实 git 项目
  Effect.gen(function* () {
    yield* Effect.promise(() => $`git init`.cwd(directory).quiet())
    yield* Effect.promise(() => $`git config core.fsmonitor false`.cwd(directory).quiet())
    yield* Effect.promise(() => $`git config commit.gpgsign false`.cwd(directory).quiet())
    yield* Effect.promise(() => $`git config user.email "test@opencode.test"`.cwd(directory).quiet())
    yield* Effect.promise(() => $`git config user.name "Test"`.cwd(directory).quiet())
    yield* Effect.promise(() => $`git commit --allow-empty -m "root commit"`.cwd(directory).quiet())
  })

// #228：home-as-global 切换测试需要跨 project 可见性——这些临时 repo 在 active worktree 之外，realpath 匹配 InstanceStore 行为
const tempGitRepo = () =>
// #228：home-as-global 切换需要跨 project 可见性——repo 在 active worktree 之外
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-session-list-"))).pipe(
      Effect.flatMap((directory) => Effect.promise(() => realpath(directory))),
      Effect.tap((directory) => initGitRepo(directory)),
    ),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
  )

// #228：非 git 的 ~ 实例——realpath 保证 session 行存储的 resolved 目录与 OPENCODE_TEST_HOME 比较一致
const tempDirectory = () =>
// #228：非 git 的 ~ 实例——realpath 保证存储目录与 OPENCODE_TEST_HOME 比较一致
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-session-list-"))).pipe(
      Effect.flatMap((directory) => Effect.promise(() => realpath(directory))),
    ),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
  )

// #228：OPENCODE_TEST_HOME 控制 Global.Path.home——scoped override 避免 fake home 泄漏到后续测试
const withTestHome = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
// #228：OPENCODE_TEST_HOME 控制 Global.Path.home——scoped override 不泄漏到后续测试
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = home
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_TEST_HOME
        else process.env.OPENCODE_TEST_HOME = previous
      }),
  )

// #228：Windows 路径匹配是 query-time 兼容边界——临时进入 win32 分支测试反斜杠/大小写归一化
const withPlatform = <A, E, R>(platform: typeof process.platform, effect: Effect.Effect<A, E, R>) =>
// #228：临时进入 win32 分支测试反斜杠/大小写归一化——不触碰真实宿主 FS
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = Object.getOwnPropertyDescriptor(process, "platform")
      Object.defineProperty(process, "platform", { ...original, value: platform })
      return original
    }),
    () => effect,
    (original) =>
      Effect.sync(() => {
        if (original) Object.defineProperty(process, "platform", original)
      }),
  )

afterEach(async () => {
  await disposeAllInstances()
})

describe("session.list", () => {
  it.instance(
// #228：it.instance 提供 scoped 临时目录与实例上下文
    "does not filter by directory when directory is omitted",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "opencode"), { recursive: true }))
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const root = yield* withSession({ title: "root" })
        const parent = yield* withSession({ title: "parent" }).pipe(
          provideInstance(path.join(test.directory, "packages")),
        )
        const current = yield* withSession({ title: "current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode")),
        )
        const sibling = yield* withSession({ title: "sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const ids = (yield* SessionNs.use.list()).map((session) => session.id)
        expect(ids).toContain(root.id)
        expect(ids).toContain(parent.id)
        expect(ids).toContain(current.id)
        expect(ids).toContain(sibling.id)
      }),
    { git: true },
  )

  it.instance(
    "path-scoped session switching from home includes sessions from every project",
// #228：核心场景——home 目录 list 必须包含每个 project 的会话，验证 global OR 臂
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const otherProject = yield* tempGitRepo()
// #228：跨 project 会话用独立 git repo 构造——验证 global OR 真实命中

        yield* withTestHome(
// #228：测试内切换 home——恢复由 acquireUseRelease 保证
          test.directory,
          Effect.gen(function* () {
            const home = yield* withSession({ title: "home-switch-root" })
// #228：home 目录内的会话与跨 project 会话都应被 home 视图列出
            const other = yield* withSession({ title: "other-switch-root" }).pipe(provideInstance(otherProject))

            const ids = (yield* SessionNs.Service.use((session) =>
// #228：list 断言使用真实 service 路径——不 mock 查询逻辑
              session.list({
// #228：list 入参覆盖 directory/path/start——验证 home 展开与目录过滤组合
                directory: test.directory,
                path: SessionPath.relative(test.directory, test.directory),
                start: Date.now() - 30 * 24 * 60 * 60 * 1000,
              }),
            )).map((session) => session.id)

            expect(ids).toContain(home.id)
// #228：home 视图必须包含 home 目录会话——缺省会话不丢失
            expect(ids).toContain(other.id)
          }),
        )
      }),
    { git: true },
  )

  it.instance(
    "path-scoped session switching from home preserves search and limit filters",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const otherProject = yield* tempGitRepo()

        yield* withTestHome(
          test.directory,
          Effect.gen(function* () {
            yield* withSession({ title: "home-filter-ignored" })
            const other = yield* withSession({ title: "needle-filter-other" }).pipe(provideInstance(otherProject))
            yield* withSession({ title: "needle-filter-home" })

            const sessions = yield* SessionNs.Service.use((session) =>
              session.list({
                directory: test.directory,
                path: SessionPath.relative(test.directory, test.directory),
                search: "needle-filter-other",
                limit: 1,
              }),
            )

            expect(sessions.map((session) => session.id)).toEqual([other.id])
          }),
        )
      }),
    { git: true },
  )

  it.instance(
    "path-scoped session switching includes exact home sessions outside home",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const homeDir = yield* tempDirectory()
// #228：非 git home 目录——验证无 project 会话仍被列出
        const otherProject = yield* tempGitRepo()

        yield* withTestHome(
          homeDir,
          Effect.gen(function* () {
            const current = yield* withSession({ title: "current-switch-root" })
            const home = yield* withSession({ title: "home-switch-root" }).pipe(provideInstance(homeDir))
            const unrelated = yield* withSession({ title: "unrelated-switch-root" }).pipe(provideInstance(otherProject))

            const ids = (yield* SessionNs.Service.use((session) =>
              session.list({
                directory: test.directory,
                path: SessionPath.relative(test.directory, test.directory),
                start: Date.now() - 30 * 24 * 60 * 60 * 1000,
              }),
            )).map((session) => session.id)

            expect(ids).toContain(current.id)
            expect(ids).toContain(home.id)
            expect(ids).not.toContain(unrelated.id)
          }),
        )
      }),
    { git: true },
  )

  it.instance(
    "directory-only session lists remain scoped to the requested directory",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const homeDir = yield* tempDirectory()

        yield* withTestHome(
          homeDir,
          Effect.gen(function* () {
            const current = yield* withSession({ title: "current-directory-only" })
            const home = yield* withSession({ title: "home-directory-only" }).pipe(provideInstance(homeDir))

            const ids = (yield* SessionNs.Service.use((session) =>
              session.list({ directory: test.directory }),
            )).map((session) => session.id)

            expect(ids).toContain(current.id)
            expect(ids).not.toContain(home.id)

            const homeIDs = (yield* SessionNs.Service.use((session) =>
              session.list({ directory: homeDir }),
            ).pipe(provideInstance(homeDir))).map((session) => session.id)

            expect(homeIDs).toContain(home.id)
            expect(homeIDs).not.toContain(current.id)
          }),
        )
      }),
    { git: true },
  )

  it.instance("path-scoped home matching treats Windows home spellings as equivalent", () =>
// #228：Windows 拼写等价——反斜杠/大小写/尾部斜杠变体必须命中同一 home
    Effect.gen(function* () {
      const homeProjectID = Project.ID.make("proj_windows_home")
// #228：直接插入 DB 行模拟历史 Windows 路径——绕过运行时创建避免路径解析干扰
      const otherProjectID = Project.ID.make("proj_windows_other")
      const home = yield* withSession({ title: "windows-home-switch" })
      const other = yield* withSession({ title: "windows-other-switch" })

      yield* Effect.addFinalizer(() =>
        Database.Service.use(({ db }) =>
          Effect.gen(function* () {
            yield* db.delete(ProjectTable).where(eq(ProjectTable.id, homeProjectID)).run()
            yield* db.delete(ProjectTable).where(eq(ProjectTable.id, otherProjectID)).run()
          }),
        ).pipe(Effect.ignore),
      )

      // Windows历史路径的写入也在相同平台语义域内，不能仅在查询时切换。
      yield* withPlatform("win32", Database.Service.use(({ db }) =>
        Effect.gen(function* () {
          yield* db.insert(ProjectTable)
// #228：project 行固定 worktree——与 session 行的 directory/path 分离构造
            .values([
              {
                id: homeProjectID,
                worktree: AbsolutePath.make("C:/Users/Alice"),
                vcs: "git",
                time_created: Date.now(),
                time_updated: Date.now(),
                sandboxes: [],
              },
              {
                id: otherProjectID,
                worktree: AbsolutePath.make("D:/Work/Repo"),
                vcs: "git",
                time_created: Date.now(),
                time_updated: Date.now(),
                sandboxes: [],
              },
            ])
            .run()
          yield* db.update(SessionTable)
// #228：把会话指向特定 project 并写入 Windows 拼写的 directory——构造历史数据
            .set({ project_id: homeProjectID, directory: "C:\\Users\\Alice", path: "" })
            .where(eq(SessionTable.id, home.id))
            .run()
          yield* db.update(SessionTable)
            .set({ project_id: otherProjectID, directory: "D:/Work/Repo", path: "" })
            .where(eq(SessionTable.id, other.id))
            .run()
        }),
      ))

      const ctx = {
// #228：win32 实例上下文——directory 用小写+尾部斜杠验证归一化路径
        directory: "c:/users/alice/",
        worktree: "C:/Users/Alice",
        project: {
          id: homeProjectID,
          worktree: "C:/Users/Alice",
          vcs: "git" as const,
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      }
      const otherCtx = {
// #228：另一 project 的上下文——验证 home 视图跨 project 可见
        directory: "D:/Work/Repo",
        worktree: "D:/Work/Repo",
        project: {
          id: otherProjectID,
          worktree: "D:/Work/Repo",
          vcs: "git" as const,
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      }

      const ids = yield* withPlatform(
// #228：win32 分支验证——生产代码按 process.platform 分支
        "win32",
        withTestHome(
          "C:/Users/Alice/",
          SessionNs.Service.use((session) =>
            session.list({
              directory: "c:/users/alice/",
              path: "",
              start: Date.now() - 30 * 24 * 60 * 60 * 1000,
            }),
          ).pipe(Effect.provideService(InstanceRef, ctx)),
        ),
      ).pipe(Effect.map((sessions) => sessions.map((session) => session.id)))

      expect(ids).toContain(home.id)
      expect(ids).toContain(other.id)

      const otherIDs = yield* withPlatform(
        "win32",
        withTestHome(
          "c:/users/alice/",
          SessionNs.Service.use((session) =>
            session.list({
              directory: "D:/Work/Repo",
              path: "",
              start: Date.now() - 30 * 24 * 60 * 60 * 1000,
            }),
          ).pipe(Effect.provideService(InstanceRef, otherCtx)),
        ),
      ).pipe(Effect.map((sessions) => sessions.map((session) => session.id)))

      expect(otherIDs).toContain(home.id)
      expect(otherIDs).toContain(other.id)
// #228：跨 project 视图也保持双向可见——home 展开不隔离 project
    }),
  )

  it.instance(
    "filters by directory when directory is provided",
// #228：显式 directory 过滤不受 home 展开影响——目录精确匹配优先
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "opencode"), { recursive: true }))
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const root = yield* withSession({ title: "root" })
        const parent = yield* withSession({ title: "parent" }).pipe(
          provideInstance(path.join(test.directory, "packages")),
        )
        const current = yield* withSession({ title: "current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode")),
        )
        const sibling = yield* withSession({ title: "sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const ids = (yield* SessionNs.Service.use((session) =>
          session.list({ directory: path.join(test.directory, "packages", "opencode") }),
        )).map((session) => session.id)
        expect(ids).not.toContain(root.id)
        expect(ids).not.toContain(parent.id)
        expect(ids).toContain(current.id)
        expect(ids).not.toContain(sibling.id)
      }),
    { git: true },
  )

  itWorkspaces.instance(
    "filters by directory when experimental workspaces are enabled",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "opencode"), { recursive: true }))
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const current = yield* withSession({ title: "current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode")),
        )
        const sibling = yield* withSession({ title: "sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const ids = (yield* SessionNs.Service.use((session) =>
          session.list({ directory: path.join(test.directory, "packages", "opencode") }),
        )).map((session) => session.id)
        expect(ids).toContain(current.id)
        expect(ids).not.toContain(sibling.id)
      }),
    { git: true },
  )

  it.instance(
    "matches a session regardless of directory separator on Windows",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const test = yield* TestInstance
        const dir = path.join(test.directory, "packages", "opencode")
        yield* Effect.promise(() => mkdir(dir, { recursive: true }))

        const created = yield* withSession({ title: "separator" }).pipe(provideInstance(dir))

        // A forward-slash query (e.g. from the SDK/HTTP layer) must still find it —
        // this is the regression: backslash-stored vs forward-slash-queried.
        const forwardIDs = (yield* SessionNs.Service.use((session) =>
          session.list({ directory: dir.replaceAll("\\", "/") }),
        )).map((session) => session.id)
        expect(forwardIDs).toContain(created.id)

        // The native form must keep matching too.
        const nativeIDs = (yield* SessionNs.Service.use((session) => session.list({ directory: dir }))).map(
          (session) => session.id,
        )
        expect(nativeIDs).toContain(created.id)
      }),
    { git: true },
  )

  it.instance(
    "filters by path relatives and ignores directory when path is provided",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          mkdir(path.join(test.directory, "packages", "opencode", "src", "deep"), { recursive: true }),
        )
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const parent = yield* withSession({ title: "parent" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode")),
        )
        const current = yield* withSession({ title: "current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode", "src")),
        )
        const deeper = yield* withSession({ title: "deeper" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode", "src", "deep")),
        )
        const sibling = yield* withSession({ title: "sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const pathIDs = (yield* SessionNs.Service.use((session) =>
          session.list({
            directory: path.join(test.directory, "packages", "app"),
            path: "packages/opencode/src",
          }),
        )).map((session) => session.id)
        // #143：祖先 parent 命中；current/deeper 命中；兄弟排除
        expect(pathIDs).toContain(parent.id)
        expect(pathIDs).toContain(current.id)
        expect(pathIDs).toContain(deeper.id)
        expect(pathIDs).not.toContain(sibling.id)

        if (process.platform === "win32") {
          const windowsPathIDs = (yield* SessionNs.Service.use((session) =>
            session.list({ path: "packages\\opencode\\src" }),
          )).map((session) => session.id)
          expect(windowsPathIDs).toContain(current.id)
          expect(windowsPathIDs).toContain(deeper.id)
        }
      }),
    { git: true },
  )

  it.instance(
    "falls back to directory when filtering legacy sessions without path",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          mkdir(path.join(test.directory, "packages", "opencode", "src"), { recursive: true }),
        )
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const current = yield* withSession({ title: "legacy-current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode", "src")),
        )
        const sibling = yield* withSession({ title: "legacy-sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const { db } = yield* Database.Service
// #228：直接 DB 写历史行——运行时 API 无法构造的拼写变体
        yield* db
          .update(SessionTable)
          .set({ path: null })
          .where(eq(SessionTable.id, current.id))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ path: null })
          .where(eq(SessionTable.id, sibling.id))
          .run()
          .pipe(Effect.orDie)

        const pathIDs = (yield* SessionNs.Service.use((session) =>
          session.list({
            directory: path.join(test.directory, "packages", "opencode", "src"),
            path: "packages/opencode/src",
          }),
        )).map((session) => session.id)
        expect(pathIDs).toContain(current.id)
        expect(pathIDs).not.toContain(sibling.id)
      }),
    { git: true },
  )

  it.instance(
    "filters root sessions",
    () =>
      Effect.gen(function* () {
        const root = yield* withSession({ title: "root-session" })
        const child = yield* withSession({ title: "child-session", parentID: root.id })

        const sessions = yield* SessionNs.use.list({ roots: true })
        const ids = sessions.map((session) => session.id)

        expect(ids).toContain(root.id)
        expect(ids).not.toContain(child.id)
      }),
    { git: true },
  )

  it.instance(
    "filters by start time",
    () =>
      Effect.gen(function* () {
        yield* withSession({ title: "new-session" })
        const sessions = yield* SessionNs.Service.use((session) => session.list({ start: Date.now() + 86400000 }))
        expect(sessions.length).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "filters by search term",
    () =>
      Effect.gen(function* () {
        yield* withSession({ title: "unique-search-term-abc" })
        yield* withSession({ title: "other-session-xyz" })

        const sessions = yield* SessionNs.use.list({ search: "unique-search" })
        const titles = sessions.map((session) => session.title)

        expect(titles).toContain("unique-search-term-abc")
        expect(titles).not.toContain("other-session-xyz")
      }),
    { git: true },
  )

  it.instance(
    "respects limit parameter",
    () =>
      Effect.gen(function* () {
        yield* withSession({ title: "session-1" })
        yield* withSession({ title: "session-2" })
        yield* withSession({ title: "session-3" })

        const sessions = yield* SessionNs.use.list({ limit: 2 })
        expect(sessions.length).toBe(2)
      }),
    { git: true },
  )

  it.instance(
    "includes metadata in listed sessions",
    () =>
      Effect.gen(function* () {
        const meta = { source: "sdk", trace: { id: "abc" } }
        const created = yield* withSession({ title: "meta-session", metadata: meta })

        const listed = (yield* SessionNs.Service.use((session) => session.list({ search: "meta-session" }))).find(
          (item) => item.id === created.id,
        )

        expect(listed?.metadata).toEqual(meta)
      }),
    { git: true },
  )

  // #143：子目录 path 过滤应包含 worktree 祖先会话（root/parent）
  it.instance(
    "includes ancestor sessions along path filter from a git child directory",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          mkdir(path.join(test.directory, "packages", "opencode", "src"), { recursive: true }),
        )
        const root = yield* withSession({ title: "repo-root" }).pipe(provideInstance(test.directory))
        const parent = yield* withSession({ title: "pkg-parent" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode")),
        )
        const child = yield* withSession({ title: "child-src" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode", "src")),
        )
        const ids = (yield* SessionNs.Service.use((session) =>
          session.list({
            directory: path.join(test.directory, "packages", "opencode", "src"),
            path: SessionPath.relative(test.directory, path.join(test.directory, "packages", "opencode", "src")),
          }),
        )).map((s) => s.id)
        // #143：空串 root + 父 path + 当前 path 均应命中
        expect(ids).toContain(root.id)
        expect(ids).toContain(parent.id)
        expect(ids).toContain(child.id)
      }),
    { git: true },
  )

  // #143：git 子项目列表必须 OR 进 global 项目父会话
  it.instance(
    "includes global parent sessions from a git child project",
// #228：git 子项目必须 OR 进 global 父会话——#143 回归覆盖
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const repo = path.join(test.directory, "repo")
        const child = path.join(repo, "packages", "opencode")
        yield* Effect.promise(async () => {
          await mkdir(child, { recursive: true })
          const { $ } = await import("bun")
          await $`git init`.cwd(repo).quiet()
          await $`git config core.fsmonitor false`.cwd(repo).quiet()
          await $`git config commit.gpgsign false`.cwd(repo).quiet()
          await $`git config user.email "test@opencode.test"`.cwd(repo).quiet()
          await $`git config user.name "Test"`.cwd(repo).quiet()
          await $`git commit --allow-empty -m "root commit"`.cwd(repo).quiet()
        })
        // #143：无 git 的 outer 会话 project_id=global
        const parent = yield* withSession({ title: "global-parent" }).pipe(provideInstance(test.directory))
// #228：无 git 的 outer 会话 project_id=global——子目录 list 必须能命中
        const current = yield* withSession({ title: "git-current" }).pipe(provideInstance(child))
        // #143：在 git 子目录上下文 list，才能触发 global OR 臂
        const ids = (
          yield* SessionNs.Service.use((session) =>
            session.list({
              directory: child,
              path: SessionPath.relative(repo, child),
              roots: true,
            }),
          ).pipe(provideInstance(child))
        ).map((s) => s.id)
        expect(ids).toContain(parent.id)
        expect(ids).toContain(current.id)
      }),
    { git: false },
  )
})

// #143：ancestors 覆盖 Unix 与 Windows 盘符根
test("builds path ancestors", () => {
  expect(SessionPath.ancestors("packages/opencode/src", { root: true })).toEqual([
    "",
    "packages",
    "packages/opencode",
    "packages/opencode/src",
  ])
  expect(SessionPath.ancestors("F:/A/B/C")).toEqual(["F:", "F:/", "F:/A", "F:/A/B", "F:/A/B/C"])
})
