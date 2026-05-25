import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture"
import { mkdir, mkdtemp, realpath, rm } from "fs/promises"
import path from "path"
import os from "os"
import { Database } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { eq } from "drizzle-orm"
import { SessionPath } from "@/session/path"
import { testEffect } from "../lib/effect"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { InstanceRef } from "@/effect/instance-ref"
import { $ } from "bun"

void Log.init({ print: false })
const it = testEffect(
  SessionNs.layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(SyncEvent.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
    Layer.provide(BackgroundJob.defaultLayer),
  ),
)

const withSession = (input?: Parameters<SessionNs.Interface["create"]>[0]) =>
  Effect.acquireRelease(
    SessionNs.Service.use((session) => session.create(input)),
    (created) => SessionNs.Service.use((session) => session.remove(created.id).pipe(Effect.ignore)),
  )

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

        const ids = (yield* SessionNs.Service.use((session) => session.list())).map((session) => session.id)
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
      const homeProjectID = ProjectID.make("proj_windows_home")
      const otherProjectID = ProjectID.make("proj_windows_other")
      const home = yield* withSession({ title: "windows-home-switch" })
      const other = yield* withSession({ title: "windows-other-switch" })

      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          Database.use((db) => {
            db.delete(ProjectTable).where(eq(ProjectTable.id, homeProjectID)).run()
            db.delete(ProjectTable).where(eq(ProjectTable.id, otherProjectID)).run()
          }),
        ),
      )

      yield* Effect.sync(() =>
        Database.use((db) => {
          db.insert(ProjectTable)
            .values([
              {
                id: homeProjectID,
                worktree: "C:/Users/Alice",
                vcs: "git",
                time_created: Date.now(),
                time_updated: Date.now(),
                sandboxes: [],
              },
              {
                id: otherProjectID,
                worktree: "D:/Work/Repo",
                vcs: "git",
                time_created: Date.now(),
                time_updated: Date.now(),
                sandboxes: [],
              },
            ])
            .run()
          db.update(SessionTable)
            .set({ project_id: homeProjectID, directory: "C:\\Users\\Alice", path: "" })
            .where(eq(SessionTable.id, home.id))
            .run()
          db.update(SessionTable)
            .set({ project_id: otherProjectID, directory: "D:/Work/Repo", path: "" })
            .where(eq(SessionTable.id, other.id))
            .run()
        }),
      )

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

        yield* Effect.sync(() =>
          Database.use((db) =>
            db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, current.id)).run(),
          ),
        )
        yield* Effect.sync(() =>
          Database.use((db) =>
            db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sibling.id)).run(),
          ),
        )

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

        const sessions = yield* SessionNs.Service.use((session) => session.list({ roots: true }))
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

        const sessions = yield* SessionNs.Service.use((session) => session.list({ search: "unique-search" }))
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

        const sessions = yield* SessionNs.Service.use((session) => session.list({ limit: 2 }))
        expect(sessions.length).toBe(2)
      }),
    { git: true },
  )
})
