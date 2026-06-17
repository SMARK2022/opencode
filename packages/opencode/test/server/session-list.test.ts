import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture"
import { mkdir, mkdtemp, realpath, rm } from "fs/promises"
import path from "path"
import os from "os"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { eq } from "drizzle-orm"
import { SessionPath } from "@/session/path"
import { testEffect } from "../lib/effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { InstanceRef } from "@/effect/instance-ref"
import { $ } from "bun"

const layer = (experimentalWorkspaces: boolean) =>
  Layer.mergeAll(
    Database.defaultLayer,
    SessionNs.layer.pipe(
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
  )
const it = testEffect(layer(false))
const itWorkspaces = testEffect(layer(true))

const withSession = (input?: Parameters<SessionNs.Interface["create"]>[0]) =>
  Effect.acquireRelease(SessionNs.use.create(input), (created) =>
    SessionNs.Service.use((session) => session.remove(created.id).pipe(Effect.ignore)),
  )

// 搜索回归测试只通过 Session service 写入 v1 消息，再通过 list({ search })
// 观察公开行为；helper 固定最小可用消息壳，避免每个断言都复制与搜索无关的
// agent/model/token 字段，同时保持持久化形状与真实 session 投影一致。
const createSearchUserMessage = Effect.fn("SessionListTest.createSearchUserMessage")(function* (sessionID: SessionID) {
  const messageID = MessageID.ascending()
  const message: MessageV2.User = {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    tools: {},
  }
  yield* SessionNs.Service.use((session) => session.updateMessage(message))
  return messageID
})

// Assistant 行需要真实 parent 和 token 外壳，因为搜索面对的是持久化历史而非
// 内存 fixture。这里刻意使用普通值，让 "reasoning"/"output" 这类词只会在
// 搜索逻辑错误索引 JSON 键名或排除字段时命中。
const createSearchAssistantMessage = Effect.fn("SessionListTest.createSearchAssistantMessage")(function* (
  sessionID: SessionID,
  parentID: MessageID,
) {
  const messageID = MessageID.ascending()
  const message: MessageV2.Assistant = {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "",
    agent: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* SessionNs.Service.use((session) => session.updateMessage(message))
  return messageID
})

// 保持断言入口等同 TUI/API 的真实路径：所有期望都从 session.list(search)
// 得到 session id 集合，而不是读取 SQL 或具体 JSON 字段实现。
const searchIDs = Effect.fn("SessionListTest.searchIDs")(function* (search: string) {
  return (yield* SessionNs.Service.use((session) => session.list({ search }))).map((session) => session.id)
})

const initGitRepo = (directory: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => $`git init`.cwd(directory).quiet())
    yield* Effect.promise(() => $`git config core.fsmonitor false`.cwd(directory).quiet())
    yield* Effect.promise(() => $`git config commit.gpgsign false`.cwd(directory).quiet())
    yield* Effect.promise(() => $`git config user.email "test@opencode.test"`.cwd(directory).quiet())
    yield* Effect.promise(() => $`git config user.name "Test"`.cwd(directory).quiet())
    yield* Effect.promise(() => $`git commit --allow-empty -m "root commit"`.cwd(directory).quiet())
  })

// Home-as-global switching must prove cross-project visibility, so these test
// projects live outside the active test worktree. Returning the realpath matches
// InstanceStore/AppFileSystem behavior and prevents `/var` vs `/private/var`
// aliases on macOS from making exact directory assertions flaky.
const tempGitRepo = () =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-session-list-"))).pipe(
      Effect.flatMap((directory) => Effect.promise(() => realpath(directory))),
      Effect.tap((directory) => initGitRepo(directory)),
    ),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
  )

// The plain temporary directory models a non-git `~` instance. It must also use
// realpath for the same reason as tempGitRepo: session rows store the resolved
// directory, while OPENCODE_TEST_HOME is compared against that stored value.
const tempDirectory = () =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-session-list-"))).pipe(
      Effect.flatMap((directory) => Effect.promise(() => realpath(directory))),
    ),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
  )

// `Global.Path.home` is backed by OPENCODE_TEST_HOME in tests. Keep the override
// scoped so path-range tests can model `~` without leaking a fake home into later
// cases that rely on the package preload's default test home.
const withTestHome = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
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

// Windows path matching is a query-time compatibility boundary: old rows can use
// backslashes, forward slashes, or different drive-letter casing. The production
// branch is guarded by process.platform, so the test temporarily enters that
// branch while still keeping the fake paths lexical and not touching the host FS.
const withPlatform = <A, E, R>(platform: typeof process.platform, effect: Effect.Effect<A, E, R>) =>
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
    "filters by directory when directory is provided",
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

        const root = yield* withSession({ title: "root" })
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
        expect(pathIDs).toContain(root.id)
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
    "path-scoped session switching from home includes sessions from every project",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const otherProject = yield* tempGitRepo()

        yield* withTestHome(
          test.directory,
          Effect.gen(function* () {
            const home = yield* withSession({ title: "home-switch-root" })
            const other = yield* withSession({ title: "other-switch-root" }).pipe(provideInstance(otherProject))

            const ids = (yield* SessionNs.Service.use((session) =>
              session.list({
                directory: test.directory,
                path: SessionPath.relative(test.directory, test.directory),
                start: Date.now() - 30 * 24 * 60 * 60 * 1000,
              }),
            )).map((session) => session.id)

            expect(ids).toContain(home.id)
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
    Effect.gen(function* () {
      const homeProjectID = Project.ID.make("proj_windows_home")
      const otherProjectID = Project.ID.make("proj_windows_other")
      const home = yield* withSession({ title: "windows-home-switch" })
      const other = yield* withSession({ title: "windows-other-switch" })

      yield* Effect.addFinalizer(() =>
        Database.Service.use(({ db }) =>
          Effect.all(
            [
              db.delete(ProjectTable).where(eq(ProjectTable.id, homeProjectID)).run(),
              db.delete(ProjectTable).where(eq(ProjectTable.id, otherProjectID)).run(),
            ],
            { discard: true },
          ),
        ).pipe(Effect.ignore),
      )

      yield* Database.Service.use(({ db }) =>
        Effect.all(
          [
            db
              .insert(ProjectTable)
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
              .run(),
            db
              .update(SessionTable)
              .set({ project_id: homeProjectID, directory: "C:\\Users\\Alice", path: "" })
              .where(eq(SessionTable.id, home.id))
              .run(),
            db
              .update(SessionTable)
              .set({ project_id: otherProjectID, directory: "D:/Work/Repo", path: "" })
              .where(eq(SessionTable.id, other.id))
              .run(),
          ],
          { discard: true },
        ),
      ).pipe(Effect.orDie)

      const ctx = {
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
    }),
  )

  it.instance("builds path ancestors", () =>
    Effect.sync(() => {
      expect(SessionPath.ancestors("packages/opencode/src", { root: true })).toEqual([
        "",
        "packages",
        "packages/opencode",
        "packages/opencode/src",
      ])
      expect(SessionPath.ancestors("F:/A/B/C")).toEqual(["F:", "F:/", "F:/A", "F:/A/B", "F:/A/B/C"])
    }),
  )

  it.instance(
    "includes global parent sessions from a git child project",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const repo = path.join(test.directory, "repo")
        const child = path.join(repo, "packages", "opencode")
        yield* Effect.promise(() => mkdir(child, { recursive: true }))
        yield* Effect.promise(() => $`git init`.cwd(repo).quiet())
        yield* Effect.promise(() => $`git config core.fsmonitor false`.cwd(repo).quiet())
        yield* Effect.promise(() => $`git config commit.gpgsign false`.cwd(repo).quiet())
        yield* Effect.promise(() => $`git config user.email "test@opencode.test"`.cwd(repo).quiet())
        yield* Effect.promise(() => $`git config user.name "Test"`.cwd(repo).quiet())
        yield* Effect.promise(() => $`git commit --allow-empty -m "root commit"`.cwd(repo).quiet())

        const parent = yield* withSession({ title: "global-parent" })
        yield* provideInstance(child)(
          Effect.gen(function* () {
            const current = yield* withSession({ title: "git-current" })
            const ids = (yield* SessionNs.Service.use((session) =>
              session.list({
                directory: child,
                path: SessionPath.relative(repo, child),
                roots: true,
              }),
            )).map((session) => session.id)

            expect(ids).toContain(parent.id)
            expect(ids).toContain(current.id)
          }),
        )
      }),
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
    "searches v1 visible text and tool input without indexing thinking or tool results",
    () =>
      Effect.gen(function* () {
        const title = yield* withSession({ title: "search-title-v1-needle" })
        const visible = yield* withSession({ title: "v1 visible holder" })
        const visibleMessage = yield* createSearchUserMessage(visible.id)
        yield* SessionNs.Service.use((session) =>
          session.updatePart({
            id: PartID.ascending(),
            sessionID: visible.id,
            messageID: visibleMessage,
            type: "text",
            text: "visible-text-v1-needle",
          }),
        )

        const tool = yield* withSession({ title: "v1 tool holder" })
        const toolParent = yield* createSearchUserMessage(tool.id)
        const toolMessage = yield* createSearchAssistantMessage(tool.id, toolParent)
        const command = `TARGET="space path"; printf "$TARGET" | grep "safe phrase" > "out file"; echo $(pwd); rm -rf "./danger zone"`
        yield* SessionNs.Service.use((session) =>
          session.updatePart({
            id: PartID.ascending(),
            sessionID: tool.id,
            messageID: toolMessage,
            type: "tool",
            callID: "v1-tool-call",
            tool: "bash",
            state: {
              status: "completed",
              input: {
                command,
                empty: "",
                nested: { path: "folder with spaces/file.ts" },
              },
              output: "secret-result-v1-needle",
              title: "visible-tool-title-v1-needle",
              metadata: {
                autoReview: { outcome: "deny", note: "approval-hidden-v1-needle" },
                secret: "metadata-hidden-v1-needle",
              },
              time: { start: 1, end: 2 },
            },
            metadata: { secret: "part-metadata-hidden-v1-needle" },
          } satisfies MessageV2.ToolPart),
        )

        const thinking = yield* withSession({ title: "v1 private holder" })
        const thinkingParent = yield* createSearchUserMessage(thinking.id)
        const thinkingMessage = yield* createSearchAssistantMessage(thinking.id, thinkingParent)
        yield* SessionNs.Service.use((session) =>
          session.updatePart({
            id: PartID.ascending(),
            sessionID: thinking.id,
            messageID: thinkingMessage,
            type: "reasoning",
            text: "private-thinking-v1-needle",
            time: { start: 1, end: 2 },
          }),
        )

        const ignored = yield* withSession({ title: "v1 ignored holder" })
        const ignoredMessage = yield* createSearchUserMessage(ignored.id)
        yield* SessionNs.Service.use((session) =>
          Effect.all([
            session.updatePart({
              id: PartID.ascending(),
              sessionID: ignored.id,
              messageID: ignoredMessage,
              type: "text",
              text: "synthetic-hidden-v1-needle",
              synthetic: true,
            }),
            session.updatePart({
              id: PartID.ascending(),
              sessionID: ignored.id,
              messageID: ignoredMessage,
              type: "text",
              text: "ignored-hidden-v1-needle",
              ignored: true,
            }),
          ]),
        )

        const failedTool = yield* withSession({ title: "v1 failed tool holder" })
        const failedToolParent = yield* createSearchUserMessage(failedTool.id)
        const failedToolMessage = yield* createSearchAssistantMessage(failedTool.id, failedToolParent)
        yield* SessionNs.Service.use((session) =>
          session.updatePart({
            id: PartID.ascending(),
            sessionID: failedTool.id,
            messageID: failedToolMessage,
            type: "tool",
            callID: "v1-failed-tool-call",
            tool: "bash",
            state: {
              status: "error",
              input: { command: "false" },
              error: "secret-error-v1-needle",
              metadata: { secret: "error-metadata-hidden-v1-needle" },
              time: { start: 1, end: 2 },
            },
          } satisfies MessageV2.ToolPart),
        )

        const pendingTool = yield* withSession({ title: "v1 pending tool holder" })
        const pendingToolParent = yield* createSearchUserMessage(pendingTool.id)
        const pendingToolMessage = yield* createSearchAssistantMessage(pendingTool.id, pendingToolParent)
        yield* SessionNs.Service.use((session) =>
          session.updatePart({
            id: PartID.ascending(),
            sessionID: pendingTool.id,
            messageID: pendingToolMessage,
            type: "tool",
            callID: "v1-pending-tool-call",
            tool: "bash",
            state: {
              status: "pending",
              input: {},
              raw: JSON.stringify({ command: "pending raw v1 value", path: "pending folder/file.ts" }),
            },
          } satisfies MessageV2.ToolPart),
        )

        // 这些搜索词覆盖 TUI session 搜索应该保留的 v1 语义面：标题、可见文本、
        // 工具名、工具标题，以及 shell 命令值中的引号、环境变量、管道、重定向、
        // 子命令、空格路径和危险命令字面量。搜索只负责定位历史，不做权限判断。
        for (const [term, sessionID] of [
          ["search-title-v1-needle", title.id],
          ["visible-text-v1-needle", visible.id],
          ["bash", tool.id],
          ["visible-tool-title-v1-needle", tool.id],
          ["space path", tool.id],
          ['$TARGET', tool.id],
          ['grep "safe phrase"', tool.id],
          ['> "out file"', tool.id],
          ["$(pwd)", tool.id],
          ['rm -rf "./danger zone"', tool.id],
          ["folder with spaces/file.ts", tool.id],
          ["false", failedTool.id],
          ["pending raw v1 value", pendingTool.id],
          ["pending folder/file.ts", pendingTool.id],
        ] as const) {
          expect(yield* searchIDs(term)).toContain(sessionID)
        }

        // 这些词只存在于 thinking、tool result、metadata、synthetic/ignored 文本或
        // JSON 键名中；若命中说明 session 搜索又退回了“整段 JSON 搜索”。
        for (const [term, sessionID] of [
          ["private-thinking-v1-needle", thinking.id],
          ["secret-result-v1-needle", tool.id],
          ["metadata-hidden-v1-needle", tool.id],
          ["approval-hidden-v1-needle", tool.id],
          ["part-metadata-hidden-v1-needle", tool.id],
          ["synthetic-hidden-v1-needle", ignored.id],
          ["ignored-hidden-v1-needle", ignored.id],
          ["secret-error-v1-needle", failedTool.id],
          ["error-metadata-hidden-v1-needle", failedTool.id],
          ["command", pendingTool.id],
          ["path", pendingTool.id],
          ["command", tool.id],
          ["output", tool.id],
          ["reasoning", thinking.id],
        ] as const) {
          expect(yield* searchIDs(term)).not.toContain(sessionID)
        }

        const blank = yield* searchIDs("   ")
        expect(blank).toContain(title.id)
        expect(blank).toContain(visible.id)
        expect(blank).toContain(tool.id)
      }),
    { git: true },
  )

  it.instance(
    "searches v2 visible text and tool input without indexing thinking or tool results",
    () =>
      Effect.gen(function* () {
        const session = yield* withSession({ title: "v2 search holder" })
        const toolCommand = `TARGET="quoted v2 path"; printf "$TARGET" | grep "v2 safe phrase" > "v2 out file"; echo $(pwd); rm -rf "./v2 danger"`
        const shellCommand = `printf "$HOME" | sed 's/home/HOME/' > "shell out file"`

        // v2 session_message 是 event-system 提供给 v2 session list 的投影。
        // 这里直接插入投影行，是为了只验证公开 list(search) 行为，并覆盖已经
        // 落库的历史投影数据；不启动 streaming/event pipeline，避免测试变成
        // 对消息生成流程的集成测试。
        yield* Database.Service.use(({ db }) =>
          db
            .insert(SessionMessageTable)
            .values([
                {
                  id: SessionMessage.ID.create(),
                  session_id: session.id,
                  type: "user",
                  seq: 1,
                  time_created: 1,
                data: {
                  text: "v2-user-visible-needle",
                  files: [
                    {
                      uri: "file:///tmp/v2-visible-file.ts",
                      mime: "text/plain",
                      name: "v2-file-visible-needle",
                      description: "v2-file-description-needle",
                    },
                    {
                      uri: "data:text/plain,v2-data-uri-hidden-needle",
                      mime: "text/plain",
                      name: "v2-data-name-visible-needle",
                    },
                  ],
                  agents: [{ name: "v2-agent-visible-needle" }],
                  references: [
                    {
                      name: "v2-reference-visible-needle",
                      kind: "local",
                      uri: "file:///tmp/v2-reference.ts",
                      repository: "v2-repository-visible-needle",
                      branch: "v2-branch-visible-needle",
                      target: "v2-target-visible-needle",
                      targetUri: "file:///tmp/v2-target-visible.ts",
                    },
                  ],
                  time: { created: 1 },
                } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
              },
                {
                  id: SessionMessage.ID.create(),
                  session_id: session.id,
                  type: "assistant",
                  seq: 2,
                  time_created: 2,
                data: {
                  agent: "build",
                  model: {
                    id: ModelV2.ID.make("model"),
                    providerID: ProviderV2.ID.make("provider"),
                    variant: ModelV2.VariantID.make("default"),
                  },
                  content: [
                    { type: "text", text: "v2-assistant-visible-needle" },
                    { type: "reasoning", id: "v2-reasoning", text: "v2-thinking-hidden-needle" },
                    {
                      type: "tool",
                      id: "v2-tool-call",
                      name: "bash",
                      provider: {
                        executed: false,
                        metadata: { secret: "v2-provider-hidden-needle" },
                      },
                      state: {
                        status: "completed",
                        input: { command: toolCommand, nested: { path: "v2 folder/file.ts" }, empty: "" },
                        content: [{ type: "text", text: "v2-tool-result-hidden-needle" }],
                        structured: { secret: "v2-structured-hidden-needle" },
                      },
                      time: { created: 3, completed: 4 },
                    },
                  ],
                  time: { created: 2 },
                } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
              },
                {
                  id: SessionMessage.ID.create(),
                  session_id: session.id,
                  type: "shell",
                  seq: 3,
                  time_created: 5,
                data: {
                  callID: "v2-shell-call",
                  command: shellCommand,
                  output: "v2-shell-result-hidden-needle",
                  time: { created: 5, completed: 6 },
                } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
              },
            ])
            .run(),
        ).pipe(Effect.orDie)

        // v2 保留与 v1 一致的用户可见语义：user/assistant 文本、工具名、工具输入
        // 以及 shell command；复杂命令字符必须按原值参与搜索，不能被 JSON 键名替代。
        for (const term of [
          "v2-user-visible-needle",
          "v2-file-visible-needle",
          "v2-file-description-needle",
          "file:///tmp/v2-visible-file.ts",
          "v2-data-name-visible-needle",
          "v2-agent-visible-needle",
          "v2-reference-visible-needle",
          "v2-repository-visible-needle",
          "v2-branch-visible-needle",
          "v2-target-visible-needle",
          "file:///tmp/v2-target-visible.ts",
          "v2-assistant-visible-needle",
          "bash",
          "quoted v2 path",
          '$TARGET',
          'grep "v2 safe phrase"',
          '> "v2 out file"',
          "$(pwd)",
          'rm -rf "./v2 danger"',
          "v2 folder/file.ts",
          "$HOME",
          "sed 's/home/HOME/'",
          '> "shell out file"',
        ]) {
          expect(yield* searchIDs(term)).toContain(session.id)
        }

        // v2 excluded fields mirror v1: assistant reasoning, tool result content,
        // structured/provider metadata, shell output, and raw JSON key names must
        // not make a session searchable.
        for (const term of [
          "v2-thinking-hidden-needle",
          "v2-tool-result-hidden-needle",
          "v2-structured-hidden-needle",
          "v2-provider-hidden-needle",
          "v2-shell-result-hidden-needle",
          "v2-data-uri-hidden-needle",
          "text/plain",
          "command",
          "output",
          "reasoning",
        ]) {
          expect(yield* searchIDs(term)).not.toContain(session.id)
        }
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
})
