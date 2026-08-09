import { describe, expect, test } from "bun:test"
import { Bus } from "@/bus"
import { Project } from "@/project/project"
import * as Log from "@opencode-ai/core/util/log"
import { $ } from "bun"
import path from "path"
import { tmpdirScoped } from "../fixture/fixture"
import { GlobalBus } from "../../src/bus/global"
import { ProjectID } from "../../src/project/schema"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { NodePath } from "@effect/platform-node"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"

void Log.init({ print: false })

const encoder = new TextEncoder()

const layer = Layer.mergeAll(Project.defaultLayer, CrossSpawnSpawner.defaultLayer)
const it = testEffect(layer)

function run<A>(fn: (svc: Project.Interface) => Effect.Effect<A>) {
  return Effect.gen(function* () {
    const svc = yield* Project.Service
    return yield* fn(svc)
  })
}

/**
 * Creates a mock ChildProcessSpawner layer that intercepts git subcommands
 * matching `failArg` and returns exit code 128, while delegating everything
 * else to the real CrossSpawnSpawner.
 */
function mockGitFailure(failArg: string) {
  return Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.make(
        Effect.fnUntraced(function* (command) {
          const std = ChildProcess.isStandardCommand(command) ? command : undefined
          if (std?.command === "git" && std.args.some((a) => a === failArg)) {
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(0),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
              stdout: Stream.empty,
              stderr: Stream.make(encoder.encode("fatal: simulated failure\n")),
              all: Stream.empty,
              getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            })
          }
          return yield* real.spawn(command)
        }),
      )
    }),
  ).pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))
}

function projectLayerWithFailure(failArg: string) {
  return Project.layer.pipe(
    Layer.provide(mockGitFailure(failArg)),
    Layer.provide(Bus.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(NodePath.layer),
    Layer.provide(RuntimeFlags.defaultLayer),
  )
}

function projectLayerWithRuntimeFlags(flags: Parameters<typeof RuntimeFlags.layer>[0]) {
  return Project.layer.pipe(
    Layer.provide(Bus.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(NodePath.layer),
    Layer.provide(RuntimeFlags.layer(flags)),
  )
}

const failureIt = (failArg: string) =>
  testEffect(Layer.mergeAll(projectLayerWithFailure(failArg), CrossSpawnSpawner.defaultLayer))

const iconDiscoveryIt = testEffect(
  Layer.provideMerge(projectLayerWithRuntimeFlags({ experimentalIconDiscovery: true }), CrossSpawnSpawner.defaultLayer),
)

function waitForProjectIcon(id: ProjectID, attempts = 50): Effect.Effect<Project.Info> {
  return Effect.gen(function* () {
    const project = Project.get(id)
    if (project?.icon?.url) return project
    if (attempts <= 0) throw new Error(`Project icon was not discovered: ${id}`)
    yield* Effect.sleep("10 millis")
    return yield* waitForProjectIcon(id, attempts - 1)
  })
}

describe("Project.fromDirectory", () => {
  it.live("should handle git repository with no commits", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => $`git init`.cwd(tmp).quiet())

      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      expect(project).toBeDefined()
      expect(project.id).toBe(ProjectID.global)
      expect(project.vcs).toBe("git")
      expect(project.worktree).toBe(tmp)

      const opencodeFile = path.join(tmp, ".git", "opencode")
      expect(yield* Effect.promise(() => Bun.file(opencodeFile).exists())).toBe(false)
    }),
  )

  it.live("should handle git repository with commits", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      expect(project).toBeDefined()
      expect(project.id).not.toBe(ProjectID.global)
      expect(project.vcs).toBe("git")
      expect(project.worktree).toBe(tmp)

      const opencodeFile = path.join(tmp, ".git", "opencode")
      expect(yield* Effect.promise(() => Bun.file(opencodeFile).exists())).toBe(false)
    }),
  )

  it.live("ignores copied cache values when deriving committed Project IDs", () =>
    Effect.gen(function* () {
      const first = yield* tmpdirScoped({ git: true })
      const second = yield* tmpdirScoped({ git: true })
      const stale = "copied-cache-project-id"
      yield* Effect.promise(() => Bun.write(path.join(first, ".git", "opencode"), stale))
      yield* Effect.promise(() => Bun.write(path.join(second, ".git", "opencode"), stale))

      const firstRoot = (yield* Effect.promise(() => $`git rev-list --max-parents=0 HEAD`.cwd(first).text())).trim()
      const secondRoot = (yield* Effect.promise(() => $`git rev-list --max-parents=0 HEAD`.cwd(second).text())).trim()
      const { project: firstProject } = yield* run((svc) => svc.fromDirectory(first))
      const { project: secondProject } = yield* run((svc) => svc.fromDirectory(second))

      // Project identity 必须来自当前仓库历史；复制的 mutable cache 不能取得 owner 身份。
      // 两个仓库故意写入相同 cache，只有 root commit 能保持它们的 identity 独立。
      // 测试同时观察返回值和仓库间不相等，覆盖错误 owner 与 collision 两个后果。
      expect(firstProject.id).toBe(ProjectID.make(firstRoot))
      expect(secondProject.id).toBe(ProjectID.make(secondRoot))
      expect(firstProject.id).not.toBe(secondProject.id)
    }),
    // 两个真实 Git fixture 共享同一 Effect layer，Windows 清理成本不能挤占行为断言时间。
    30_000,
  )

  it.live("returns global for non-git directory", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(project.id).toBe(ProjectID.global)
    }),
  )

  it.live("derives stable project ID from root commit", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project: a } = yield* run((svc) => svc.fromDirectory(tmp))
      const { project: b } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(b.id).toBe(a.id)
    }),
  )
})

describe("Project.fromDirectory git failure paths", () => {
  it.live("keeps vcs when rev-list exits non-zero (no commits)", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => $`git init`.cwd(tmp).quiet())

      // rev-list fails because HEAD doesn't exist yet: this is the natural scenario.
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(project.vcs).toBe("git")
      expect(project.id).toBe(ProjectID.global)
      expect(project.worktree).toBe(tmp)
    }),
  )

  failureIt("--show-toplevel").live("handles show-toplevel failure gracefully", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const { project, sandbox } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(project.worktree).toBe(tmp)
      expect(sandbox).toBe(tmp)
    }),
  )

  failureIt("--git-common-dir").live("handles git-common-dir failure gracefully", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const { project, sandbox } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(project.worktree).toBe(tmp)
      expect(sandbox).toBe(tmp)
    }),
  )
})

describe("Project.fromDirectory with worktrees", () => {
  it.live("should set worktree to root when called from root", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const { project, sandbox } = yield* run((svc) => svc.fromDirectory(tmp))

      expect(project.worktree).toBe(tmp)
      expect(sandbox).toBe(tmp)
      expect(project.sandboxes).not.toContain(tmp)
    }),
  )

  it.live("should set worktree to root when called from a worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const worktreePath = path.join(tmp, "..", path.basename(tmp) + "-worktree")
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove ${worktreePath}`
            .cwd(tmp)
            .quiet()
            .catch(() => {}),
        ),
      )
      yield* Effect.promise(() => $`git worktree add ${worktreePath} -b test-branch-${Date.now()}`.cwd(tmp).quiet())

      const { project, sandbox } = yield* run((svc) => svc.fromDirectory(worktreePath))

      expect(project.worktree).toBe(tmp)
      expect(sandbox).toBe(worktreePath)
      expect(project.sandboxes).toContain(worktreePath)
      expect(project.sandboxes).not.toContain(tmp)
    }),
    // linked worktree setup/cleanup 使用真实 Git 子进程，需覆盖 Windows fixture 清理成本。
    // 这里的 timeout 只延长生命周期预算，不把路径或 identity 断言变成 eventual assertion。
    30_000,
  )

  it.live("worktree should share project ID with main repo", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const { project: main } = yield* run((svc) => svc.fromDirectory(tmp))

      const worktreePath = path.join(tmp, "..", path.basename(tmp) + "-wt-shared")
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove ${worktreePath}`
            .cwd(tmp)
            .quiet()
            .catch(() => {}),
        ),
      )
      yield* Effect.promise(() => $`git worktree add ${worktreePath} -b shared-${Date.now()}`.cwd(tmp).quiet())

      const { project: wt } = yield* run((svc) => svc.fromDirectory(worktreePath))

      expect(wt.id).toBe(main.id)

      // cache 不再参与 identity；linked worktree 只能验证 root-commit 和公共 worktree 合同。
      // cache 文件不存在是删除竞争 identity source 的直接可观察结果。
      const cache = path.join(tmp, ".git", "opencode")
      const exists = yield* Effect.promise(() => Bun.file(cache).exists())
      expect(exists).toBe(false)
    }),
    // linked worktree 的建销使用真实 Git 子进程；延长预算只覆盖进程成本，不放宽确定性断言。
    30_000,
  )

  it.live("separate clones of the same repo should share project ID", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      // Create a bare remote, push, then clone into a second directory
      const bare = tmp + "-bare"
      const clone = tmp + "-clone"
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${bare} ${clone}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git clone --bare ${tmp} ${bare}`.quiet())
      yield* Effect.promise(() => $`git clone ${bare} ${clone}`.quiet())

      const { project: a } = yield* run((svc) => svc.fromDirectory(tmp))
      const { project: b } = yield* run((svc) => svc.fromDirectory(clone))

      expect(b.id).toBe(a.id)
    }),
    // clone identity 断言保持确定；Windows 子进程清理可能超过 Bun 的默认五秒预算。
    // clone 仍共享 root commit，而不是依赖任一目录中的可复制状态文件。
    30_000,
  )

  it.live("should accumulate multiple worktrees in sandboxes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const worktree1 = path.join(tmp, "..", path.basename(tmp) + "-wt1")
      const worktree2 = path.join(tmp, "..", path.basename(tmp) + "-wt2")
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            $`git worktree remove ${worktree1}`
              .cwd(tmp)
              .quiet()
              .catch(() => {}),
          )
          yield* Effect.promise(() =>
            $`git worktree remove ${worktree2}`
              .cwd(tmp)
              .quiet()
              .catch(() => {}),
          )
        }),
      )
      yield* Effect.promise(() => $`git worktree add ${worktree1} -b branch-${Date.now()}`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git worktree add ${worktree2} -b branch-${Date.now() + 1}`.cwd(tmp).quiet())

      yield* run((svc) => svc.fromDirectory(worktree1))
      const { project } = yield* run((svc) => svc.fromDirectory(worktree2))

      expect(project.worktree).toBe(tmp)
      expect(project.sandboxes).toContain(worktree1)
      expect(project.sandboxes).toContain(worktree2)
      expect(project.sandboxes).not.toContain(tmp)
    }),
    // 多个 linked worktree 使用真实 Git 子进程，预算需覆盖 setup/cleanup。
    // 两次 fromDirectory 必须汇聚到同一 Project row，并分别保留两个 sandbox。
    30_000,
  )
})

describe("Project.discover", () => {
  iconDiscoveryIt.live("discovers favicon from fromDirectory when enabled", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      yield* Effect.promise(() => Bun.write(path.join(tmp, "favicon.png"), pngData))

      const { project } = yield* run((svc) => svc.fromDirectory(tmp))
      const updated = yield* waitForProjectIcon(project.id)

      expect(updated.icon?.url).toStartWith("data:")
      expect(updated.icon?.url).toContain("base64")
    }),
  )

  it.live("should discover favicon.png in root", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      yield* Effect.promise(() => Bun.write(path.join(tmp, "favicon.png"), pngData))

      yield* run((svc) => svc.discover(project))

      const updated = Project.get(project.id)
      expect(updated).toBeDefined()
      expect(updated!.icon).toBeDefined()
      expect(updated!.icon?.url).toStartWith("data:")
      expect(updated!.icon?.url).toContain("base64")
      expect(updated!.icon?.color).toBeUndefined()
    }),
  )

  it.live("should not discover non-image files", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      yield* Effect.promise(() => Bun.write(path.join(tmp, "favicon.txt"), "not an image"))

      yield* run((svc) => svc.discover(project))

      const updated = Project.get(project.id)
      expect(updated).toBeDefined()
      expect(updated!.icon).toBeUndefined()
    }),
  )

  it.live("should not discover favicon when override is set", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      yield* run((svc) =>
        svc.update({
          projectID: project.id,
          icon: { override: "data:image/png;base64,override" },
        }),
      )

      const updatedProject = yield* run((svc) => svc.get(project.id))
      if (!updatedProject) throw new Error("Project not found")

      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      yield* Effect.promise(() => Bun.write(path.join(tmp, "favicon.png"), pngData))

      yield* run((svc) => svc.discover(updatedProject))

      const updated = Project.get(project.id)
      expect(updated).toBeDefined()
      expect(updated!.icon?.override).toBe("data:image/png;base64,override")
      expect(updated!.icon?.url).toBeUndefined()
    }),
  )
})

describe("Project.update", () => {
  it.live("should update name", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const updated = yield* run((svc) =>
        svc.update({
          projectID: project.id,
          name: "New Project Name",
        }),
      )

      expect(updated.name).toBe("New Project Name")

      const fromDb = Project.get(project.id)
      expect(fromDb?.name).toBe("New Project Name")
    }),
  )

  it.live("should update icon url", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const updated = yield* run((svc) =>
        svc.update({
          projectID: project.id,
          icon: { url: "https://example.com/icon.png" },
        }),
      )

      expect(updated.icon?.url).toBe("https://example.com/icon.png")

      const fromDb = Project.get(project.id)
      expect(fromDb?.icon?.url).toBe("https://example.com/icon.png")
    }),
  )

  it.live("should update icon color", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const updated = yield* run((svc) =>
        svc.update({
          projectID: project.id,
          icon: { color: "#ff0000" },
        }),
      )

      expect(updated.icon?.color).toBe("#ff0000")

      const fromDb = Project.get(project.id)
      expect(fromDb?.icon?.color).toBe("#ff0000")
    }),
  )

  it.live("should update icon override", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const updated = yield* run((svc) =>
        svc.update({
          projectID: project.id,
          icon: { override: "data:image/png;base64,abc123" },
        }),
      )

      expect(updated.icon?.override).toBe("data:image/png;base64,abc123")

      const fromDb = Project.get(project.id)
      expect(fromDb?.icon?.override).toBe("data:image/png;base64,abc123")
    }),
  )

  it.live("should update commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const updated = yield* run((svc) =>
        svc.update({
          projectID: project.id,
          commands: { start: "npm run dev" },
        }),
      )

      expect(updated.commands?.start).toBe("npm run dev")

      const fromDb = Project.get(project.id)
      expect(fromDb?.commands?.start).toBe("npm run dev")
    }),
  )

  it.live("should throw error when project not found", () =>
    Effect.gen(function* () {
      const exit = yield* run((svc) =>
        svc.update({
          projectID: ProjectID.make("nonexistent-project-id"),
          name: "Should Fail",
        }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error instanceof Error ? error.message : String(error)).toContain(
          "Project not found: nonexistent-project-id",
        )
      }
    }),
  )

  it.live("should emit GlobalBus event on update", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      let eventPayload: any = null
      const on = (data: any) => {
        eventPayload = data
      }
      GlobalBus.on("event", on)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

      yield* run((svc) => svc.update({ projectID: project.id, name: "Updated Name" }))

      expect(eventPayload).not.toBeNull()
      expect(eventPayload.payload.type).toBe("project.updated")
      expect(eventPayload.payload.properties.name).toBe("Updated Name")
    }),
  )

  it.live("should update multiple fields at once", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const updated = yield* run((svc) =>
        svc.update({
          projectID: project.id,
          name: "Multi Update",
          icon: { url: "https://example.com/favicon.ico", override: "data:image/png;base64,abc123", color: "#00ff00" },
          commands: { start: "make start" },
        }),
      )

      expect(updated.name).toBe("Multi Update")
      expect(updated.icon?.url).toBe("https://example.com/favicon.ico")
      expect(updated.icon?.override).toBe("data:image/png;base64,abc123")
      expect(updated.icon?.color).toBe("#00ff00")
      expect(updated.commands?.start).toBe("make start")
    }),
  )
})

describe("Project.list and Project.get", () => {
  it.live("list returns all projects", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const all = Project.list()
      expect(all.length).toBeGreaterThan(0)
      expect(all.find((p) => p.id === project.id)).toBeDefined()
    }),
  )

  it.live("get returns project by id", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const found = Project.get(project.id)
      expect(found).toBeDefined()
      expect(found!.id).toBe(project.id)
    }),
  )

  test("get returns undefined for unknown id", () => {
    const found = Project.get(ProjectID.make("nonexistent"))
    expect(found).toBeUndefined()
  })
})

describe("Project.setInitialized", () => {
  it.live("sets time_initialized on project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      expect(project.time.initialized).toBeUndefined()

      Project.setInitialized(project.id)

      const updated = Project.get(project.id)
      expect(updated?.time.initialized).toBeDefined()
    }),
  )
})

describe("Project.addSandbox and Project.removeSandbox", () => {
  it.live("addSandbox adds directory and removeSandbox removes it", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))
      const sandboxDir = path.join(tmp, "sandbox-test")

      yield* run((svc) => svc.addSandbox(project.id, sandboxDir))

      let found = Project.get(project.id)
      expect(found?.sandboxes).toContain(sandboxDir)

      yield* run((svc) => svc.removeSandbox(project.id, sandboxDir))

      found = Project.get(project.id)
      expect(found?.sandboxes).not.toContain(sandboxDir)
    }),
  )

  it.live("addSandbox emits GlobalBus event", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))
      const sandboxDir = path.join(tmp, "sandbox-event")

      const events: any[] = []
      const on = (evt: any) => events.push(evt)
      GlobalBus.on("event", on)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

      yield* run((svc) => svc.addSandbox(project.id, sandboxDir))

      expect(events.some((e) => e.payload.type === Project.Event.Updated.type)).toBe(true)
    }),
  )
})

describe("Project.fromDirectory with bare repos", () => {
  it.live("worktree from bare repo should cache in bare repo, not parent", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const parentDir = path.dirname(tmp)
      const barePath = path.join(parentDir, `bare-${Date.now()}.git`)
      const worktreePath = path.join(parentDir, `worktree-${Date.now()}`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${barePath} ${worktreePath}`.quiet().nothrow()).pipe(Effect.ignore),
      )

      yield* Effect.promise(() => $`git clone --bare ${tmp} ${barePath}`.quiet())
      yield* Effect.promise(() => $`git worktree add ${worktreePath} HEAD`.cwd(barePath).quiet())

      const { project } = yield* run((svc) => svc.fromDirectory(worktreePath))

      expect(project.id).not.toBe(ProjectID.global)
      expect(project.worktree).toBe(barePath)

      const correctCache = path.join(barePath, "opencode")
      const wrongCache = path.join(parentDir, ".git", "opencode")

      expect(yield* Effect.promise(() => Bun.file(correctCache).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(wrongCache).exists())).toBe(false)
    }),
    // bare repo 没有普通 worktree；identity 仍来自 HEAD 的 root commit，且不创建 cache。
  )

  it.live("different bare repos under same parent should not share project ID", () =>
    Effect.gen(function* () {
      const tmp1 = yield* tmpdirScoped({ git: true })
      const tmp2 = yield* tmpdirScoped({ git: true })

      const parentDir = path.dirname(tmp1)
      const bareA = path.join(parentDir, `bare-a-${Date.now()}.git`)
      const bareB = path.join(parentDir, `bare-b-${Date.now()}.git`)
      const worktreeA = path.join(parentDir, `wt-a-${Date.now()}`)
      const worktreeB = path.join(parentDir, `wt-b-${Date.now()}`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${bareA} ${bareB} ${worktreeA} ${worktreeB}`.quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )

      yield* Effect.promise(() => $`git clone --bare ${tmp1} ${bareA}`.quiet())
      yield* Effect.promise(() => $`git clone --bare ${tmp2} ${bareB}`.quiet())
      yield* Effect.promise(() => $`git worktree add ${worktreeA} HEAD`.cwd(bareA).quiet())
      yield* Effect.promise(() => $`git worktree add ${worktreeB} HEAD`.cwd(bareB).quiet())

      const { project: projA } = yield* run((svc) => svc.fromDirectory(worktreeA))
      const { project: projB } = yield* run((svc) => svc.fromDirectory(worktreeB))

      expect(projA.id).not.toBe(projB.id)

      const cacheA = path.join(bareA, "opencode")
      const cacheB = path.join(bareB, "opencode")
      const wrongCache = path.join(parentDir, ".git", "opencode")

      expect(yield* Effect.promise(() => Bun.file(cacheA).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(cacheB).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(wrongCache).exists())).toBe(false)
    }),
    // 两个 bare repository 会启动多组真实 Git 子进程，预算必须覆盖 setup/cleanup 后再判定 identity。
    // 同父目录不能再通过共享 cache 产生错误的 Project owner。
    // 两个返回值必须由各自 HEAD 派生，不能由目录位置或父目录 cache 派生。
    30_000,
  )

  it.live("bare repo without .git suffix is still detected via core.bare", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const parentDir = path.dirname(tmp)
      const barePath = path.join(parentDir, `bare-no-suffix-${Date.now()}`)
      const worktreePath = path.join(parentDir, `worktree-${Date.now()}`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${barePath} ${worktreePath}`.quiet().nothrow()).pipe(Effect.ignore),
      )

      yield* Effect.promise(() => $`git clone --bare ${tmp} ${barePath}`.quiet())
      yield* Effect.promise(() => $`git worktree add ${worktreePath} HEAD`.cwd(barePath).quiet())

      const { project } = yield* run((svc) => svc.fromDirectory(worktreePath))

      expect(project.id).not.toBe(ProjectID.global)
      expect(project.worktree).toBe(barePath)

      const correctCache = path.join(barePath, "opencode")
      expect(yield* Effect.promise(() => Bun.file(correctCache).exists())).toBe(false)
    }),
  )
})
