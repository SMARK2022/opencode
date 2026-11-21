import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import {
  GATE_STEP,
  environmentFailure,
  preflightPlatforms,
  preflightRuns,
  preflightState,
  type PreflightRun,
} from "../preflight"

const base = "1".repeat(40)

function run(platforms: string[], changes: Partial<PreflightRun> = {}): PreflightRun {
  return {
    databaseId: 1,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    displayTitle: `preflight base=${base} · preflight/fixture · ${platforms.join(",")}`,
    url: "https://github.com/example/repo/actions/runs/1",
    createdAt: "2026-01-01T00:00:00Z",
    jobs: platforms.map((platform) => ({
      name: `preflight / ${platform} / ${base}`,
      status: "completed",
      conclusion: "success",
    })),
    ...changes,
  }
}

describe("preflight platform coverage", () => {
  test("requires every requested platform and accepts additional successful platforms", () => {
    expect(preflightState([run(["linux"])], ["linux", "macos"], base).kind).toBe("none")
    expect(preflightState([run(["linux", "macos", "windows"])], ["linux", "macos"], base).kind).toBe("green")
  })

  test("a skipped or failed required job cannot be accepted as green", () => {
    for (const conclusion of ["skipped", "failure", "cancelled", null]) {
      const current = run(["linux"])
      current.jobs[0].conclusion = conclusion
      expect(preflightState([current], ["linux"], base).kind).toBe("failed")
    }
  })

  test("a newer failure or pending execution supersedes an older success", () => {
    const old = run(["linux"])
    const failed = run(["linux"], { databaseId: 2, conclusion: "failure", createdAt: "2026-01-02T00:00:00Z" })
    expect(preflightState([old, failed], ["linux"], base).kind).toBe("failed")
    expect(preflightState([old, { ...failed, status: "in_progress", jobs: [] }], ["linux"], base).kind).toBe("running")
    expect(preflightState([old, { ...failed, jobs: [] }], ["linux"], base).kind).toBe("failed")
    expect(preflightState([failed, { ...old, updatedAt: "2026-01-03T00:00:00Z" }], ["linux"], base).kind).toBe("green")
  })

  test("a different comparison base and mismatched executed jobs cannot certify the requested range", () => {
    expect(preflightState([run(["linux"])], ["linux"], "2".repeat(40)).kind).toBe("none")
    const current = run(["linux"])
    current.jobs[0].name = `preflight / linux / ${"2".repeat(40)}`
    expect(preflightState([current], ["linux"], base).kind).toBe("failed")
  })

  test("push and PR workflows do not certify preflight", () => {
    expect(
      preflightState([run(["linux"], { event: "push" }), run(["linux"], { event: "pull_request" })], ["linux"], base)
        .kind,
    ).toBe("none")
  })

  test("platform input is normalized and rejects empty or unknown matrices", () => {
    expect(preflightPlatforms("Linux,macos linux")).toEqual(["linux", "macos"])
    expect(() => preflightPlatforms("")).toThrow("未知平台")
    expect(() => preflightPlatforms("linux,freebsd")).toThrow("未知平台")
  })
})

test("failed GitHub queries throw instead of becoming an empty or successful run", () => {
  expect(() => preflightRuns(() => ({ ok: false, out: "", err: "query denied" }), "example/repo", "HEAD")).toThrow(
    "查询 preflight 运行失败",
  )
  expect(() =>
    preflightRuns(
      (...args) =>
        args[1] === "list"
          ? { ok: true, out: JSON.stringify([run(["linux"])]), err: "" }
          : { ok: false, out: "", err: "jobs unavailable" },
      "example/repo",
      "HEAD",
    ),
  ).toThrow("查询 preflight 平台结果失败")
})

test("a missing comparison base returns an execution error before remote dispatch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-preflight-test-"))
  try {
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" })
    expect(git("init", "-q").exitCode).toBe(0)
    expect(
      git("-c", "user.name=guard", "-c", "user.email=guard@example.test", "commit", "--allow-empty", "-qm", "fixture")
        .exitCode,
    ).toBe(0)
    const result = Bun.spawnSync(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../preflight.ts"),
        "ensure",
        "--base",
        "missing",
        "--platforms",
        "linux",
      ],
      {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain("无法解析比较基准")
    expect(result.stdout.toString()).not.toContain("已启动")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("CI classification uses the same exact comparison commits as push validation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-plan-test-"))
  try {
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" })
    const commit = () => {
      expect(git("add", ".").exitCode).toBe(0)
      expect(
        git("-c", "user.name=guard", "-c", "user.email=guard@example.test", "commit", "--allow-empty", "-qm", "fixture")
          .exitCode,
      ).toBe(0)
      return git("rev-parse", "HEAD").stdout.toString().trim()
    }
    expect(git("init", "-q").exitCode).toBe(0)
    const original = commit()
    await Bun.write(path.join(dir, "packages/core/src/中文.ts"), "export const value = 1\n")
    const comparison = commit()
    expect(git("checkout", "-q", "--detach", original).exitCode).toBe(0)
    await Bun.write(path.join(dir, "README.md"), "fixture\n")
    commit()
    const result = Bun.spawnSync(
      [process.execPath, path.resolve(import.meta.dir, "../ci.ts"), "plan", "--base", comparison],
      {
        cwd: dir,
        env: { ...process.env, GITHUB_OUTPUT: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("files=2")
    expect(result.stdout.toString()).toContain("runtime=true")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the required CI result rejects skipped, failed or cancelled mandatory jobs", () => {
  const normal = {
    mode: "pr",
    plan: "success",
    rules: "success",
    bench: "success",
    runtime: "true",
    preflight: "skipped",
  }
  const checks: { change: Partial<typeof normal>; code: number }[] = [
    { change: {}, code: 0 },
    { change: { runtime: "false", bench: "skipped" }, code: 0 },
    { change: { mode: "push", bench: "skipped" }, code: 0 },
    { change: { mode: "preflight", rules: "skipped", bench: "skipped", preflight: "success" }, code: 0 },
    { change: { mode: "unknown" }, code: 1 },
    { change: { plan: "skipped" }, code: 1 },
    { change: { plan: "failure" }, code: 1 },
    { change: { rules: "skipped" }, code: 1 },
    { change: { rules: "cancelled" }, code: 1 },
    { change: { bench: "skipped" }, code: 1 },
    { change: { runtime: "false", bench: "failure" }, code: 1 },
    { change: { mode: "push", rules: "skipped" }, code: 1 },
    { change: { mode: "preflight", preflight: "skipped" }, code: 1 },
    { change: { mode: "preflight", preflight: "cancelled" }, code: 1 },
    { change: { runtime: "" }, code: 1 },
  ]
  for (const check of checks) {
    const args = Object.entries({ ...normal, ...check.change }).flatMap(([key, value]) => ["--" + key, value])
    const result = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, "../ci.ts"), "result", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect({ args, code: result.exitCode }).toEqual({ args, code: check.code })
  }
})

test("composite Bun suites run with leak checks through the actual gate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-composite-test-"))
  try {
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" })
    expect(git("init", "-q").exitCode).toBe(0)
    expect(
      git("-c", "user.name=guard", "-c", "user.email=guard@example.test", "commit", "--allow-empty", "-qm", "fixture")
        .exitCode,
    ).toBe(0)
    await Bun.write(
      path.join(dir, "packages/app/package.json"),
      JSON.stringify({
        name: "@opencode-ai/app",
        scripts: {
          test: "bun run test:unit && bun run test:browser",
          "test:unit": "bun test --timeout 15000 ./src",
          "test:browser": "bun test ./test-browser",
        },
      }),
    )
    await Bun.write(
      path.join(dir, "packages/app/src/unit.test.ts"),
      'import { test } from "bun:test"\ntest("leak", () => { Bun.spawn([process.execPath, "-e", "Bun.serve({port:0,fetch:()=>new Response()})"], { stdout: "ignore", stderr: "ignore" }) })\n',
    )
    await Bun.write(
      path.join(dir, "packages/app/test-browser/browser.test.ts"),
      'import { test, expect } from "bun:test"\ntest("browser suite", () => expect(true).toBe(true))\n',
    )
    const result = Bun.spawnSync(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../gate.ts"),
        "stop",
        "--files",
        "packages/app/src/unit.test.ts",
      ],
      {
        cwd: dir,
        env: { ...process.env, GITHUB_ACTIONS: "false", GUARD_TESTS: "full", GUARD_MAP_SYNC: "off" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("leakedChildren")
    expect(result.stdout.toString()).toContain("1 通过")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("gate reports early failures before the output tail and keeps each suite log", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-failure-summary-"))
  try {
    expect(Bun.spawnSync(["git", "init", "-q", dir]).exitCode).toBe(0)
    const pkg = path.join(dir, "packages/function")
    await Bun.write(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "@opencode-ai/function",
        scripts: { test: "bun test ./unit && bun test ./other" },
      }),
    )
    await Bun.write(
      path.join(pkg, "unit/sample.test.ts"),
      `import { test, expect } from "bun:test"
      test("early case", () => expect(12).toBe(34))
      test("late case", () => { console.error("x".repeat(9000)); throw new Error("late diagnostic") })`,
    )
    await Bun.write(
      path.join(pkg, "other/sample.test.ts"),
      'import { test } from "bun:test"; test("other suite", () => { throw new Error("other diagnostic") })',
    )
    const result = Bun.spawnSync(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../gate.ts"),
        "stop",
        "--files",
        "packages/function/unit/sample.test.ts",
      ],
      { cwd: dir, env: { ...process.env, GITHUB_ACTIONS: "true", GUARD_LOG_ARTIFACT: "guard-logs-linux" } },
    )
    expect(result.exitCode).toBe(1)
    const output = result.stdout.toString()
    const summary = output.match(/失败摘要（2 条[^\n]*\n([\s\S]*?)\n原始输出（仅显示末尾 8000 字符）/)?.[1]
    expect(summary).toMatch(/\(fail\)[^\n]*early case[\s\S]*Expected: 34[\s\S]*Received: 12/)
    expect(summary).toMatch(/\(fail\)[^\n]*late case[\s\S]*error: late diagnostic/)
    expect(output).toContain("Artifacts → guard-logs-linux")
    const logs = Array.from(output.matchAll(/完整日志：([^\r\n]+\.log)/g), (m) => path.resolve(dir, m[1]))
    expect(new Set(logs).size).toBe(2)
    const contents = await Promise.all(logs.map((file) => Bun.file(file).text()))
    expect(contents.some((s) => s.includes("Expected: 34") && s.includes("x".repeat(9000)))).toBe(true)
    expect(contents.some((s) => s.includes("other diagnostic"))).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("parallel gates keep their selected test plans isolated and remove temporary plans", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-parallel-test-"))
  try {
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" })
    expect(git("init", "-q").exitCode).toBe(0)
    expect(
      git("-c", "user.name=guard", "-c", "user.email=guard@example.test", "commit", "--allow-empty", "-qm", "fixture")
        .exitCode,
    ).toBe(0)
    await Bun.write(
      path.join(dir, "packages/function/package.json"),
      JSON.stringify({ name: "@opencode-ai/function", scripts: { test: "bun test" } }),
    )
    await Bun.write(
      path.join(dir, "packages/function/test/pass.test.ts"),
      'import { test, expect } from "bun:test"\ntest("passing suite", () => expect(true).toBe(true))\n',
    )
    await Bun.write(
      path.join(dir, "packages/function/test/fail.test.ts"),
      'import { test, expect } from "bun:test"\ntest("failing suite", () => expect(true).toBe(false))\n',
    )
    const results = await Promise.all(
      ["pass", "fail"].map(async (name) => {
        const proc = Bun.spawn(
          [
            process.execPath,
            path.resolve(import.meta.dir, "../gate.ts"),
            "stop",
            "--files",
            `packages/function/test/${name}.test.ts`,
          ],
          {
            cwd: dir,
            env: { ...process.env, GITHUB_ACTIONS: "false", GUARD_TESTS: "full", GUARD_MAP_SYNC: "off" },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [code, out] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        return { code, out }
      }),
    )
    expect(results.map((result) => result.code)).toEqual([0, 1])
    expect(results[0].out).toContain("1 通过")
    expect(results[1].out).toContain("expect(received)")
    expect(
      (await readdir(path.join(dir, ".git", "guard-cache"))).filter((file) => file.startsWith("affected")),
    ).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("leak checks respect suite ownership and concurrent cleanup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-lifetime-test-"))
  try {
    const file = path.join(dir, "lifetime.test.ts")
    await Bun.write(
      file,
      `
      import { beforeAll, afterAll, test } from "bun:test"
      let shared
      beforeAll(() => { shared = setInterval(() => {}, 60_000) })
      afterAll(() => clearInterval(shared))
      test.concurrent("first", async () => {
        const timer = setInterval(() => {}, 60_000)
        await Bun.sleep(3)
        clearInterval(timer)
      })
      test.concurrent("second", async () => {
        const timer = setInterval(() => {}, 60_000)
        await Bun.sleep(1)
        clearInterval(timer)
      })
    `,
    )
    const result = Bun.spawnSync(
      [process.execPath, "test", "--preload", path.resolve(import.meta.dir, "../leak-preload.ts"), file],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    )
    expect(result.exitCode).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


async function leakRun(source: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-leak-test-"))
  try {
    await Bun.write(path.join(dir, "case.test.ts"), source)
    const result = Bun.spawnSync(
      [process.execPath, "test", "--preload", path.resolve(import.meta.dir, "../leak-preload.ts"), "./case.test.ts"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    )
    return { code: result.exitCode, output: result.stderr.toString() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("资源泄漏在整轮测试结束时判定", () => {
  test("第一个测试里启动、afterAll 关闭的共享计时器不算泄漏", async () => {
    const result = await leakRun(`
      import { afterAll, expect, test } from "bun:test"
      let shared: ReturnType<typeof setInterval> | undefined
      const runtime = () => (shared ??= setInterval(() => {}, 1000))
      test("first", () => { runtime(); expect(1).toBe(1) })
      test("second", () => { runtime(); expect(1).toBe(1) })
      afterAll(() => clearInterval(shared))
    `)
    expect(result.code).toBe(0)
  })

  test("结束时仍在运行的计时器判为泄漏并给出创建位置；unref 的不算", async () => {
    const leaked = await leakRun(`
      import { expect, test } from "bun:test"
      test("leak", () => { setInterval(() => {}, 1000); expect(1).toBe(1) })
    `)
    expect(leaked.code).toBe(1)
    expect(leaked.output).toContain("case.test.ts")
    const unref = await leakRun(`
      import { expect, test } from "bun:test"
      test("unref", () => { setInterval(() => {}, 1000).unref(); expect(1).toBe(1) })
    `)
    expect(unref.code).toBe(0)
  })

  test("结束时仍在运行的子进程判为泄漏", async () => {
    const result = await leakRun(`
      import { expect, test } from "bun:test"
      test("leak", () => {
        Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 60_000)"], { stdout: "ignore", stderr: "ignore" })
        expect(1).toBe(1)
      })
    `)
    expect(result.code).toBe(1)
    expect(result.output).toContain("leakedChildren")
  })
})

async function gateRepo(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-push-test-"))
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" })
  const commit = async (changes: Record<string, string>) => {
    for (const [file, text] of Object.entries(changes)) await Bun.write(path.join(dir, file), text)
    git("add", ".")
    git("-c", "user.name=guard", "-c", "user.email=guard@example.test", "commit", "--allow-empty", "-qm", "fixture")
    return git("rev-parse", "HEAD").stdout.toString().trim()
  }
  git("init", "-q")
  await commit(files)
  const push = (env: Record<string, string>, ...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, "../gate.ts"), "push", ...args], {
      cwd: dir,
      env: { ...process.env, GITHUB_ACTIONS: "false", GUARD_MAP_SYNC: "off", ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
  }
  return { dir, commit, push, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) }
}

test("同一提交与基准通过一次后，再次 push 直接跳过；GUARD_TESTS=off 只提示", async () => {
  await using repo = await gateRepo({ "README.md": "fixture\n" })
  const first = repo.push({ GUARD_TESTS: "off" }, "--since", "HEAD")
  expect(first.code).toBe(0)
  expect(first.output).toContain("GUARD_TESTS=off")
  const second = repo.push({ GUARD_TESTS: "off" }, "--since", "HEAD")
  expect(second.code).toBe(0)
  expect(second.output).toContain("此前已通过")
})

test("测试会加载的包里有未提交改动时，测试交给 preflight", async () => {
  await using repo = await gateRepo({
    "packages/core/package.json": JSON.stringify({ name: "@fixture/core", scripts: { test: "bun test" } }),
    "packages/core/src/value.ts": "export const value = 1\n",
    "packages/core/test/value.test.ts":
      'import { expect, test } from "bun:test"\nimport { value } from "../src/value"\ntest("value", () => expect(value).toBe(1))\n',
  })
  await repo.commit({ "packages/core/src/value.ts": "export const value = 1 // pushed\n" })
  await Bun.write(path.join(repo.dir, "packages/core/src/value.ts"), "export const value = 2\n")
  const result = repo.push({ GUARD_PREFLIGHT: "off" }, "--since", "HEAD~1")
  expect(result.output).toContain("1 处未提交改动会被测试加载")
  expect(result.output).toContain("测试交给 preflight")
  expect(result.output).toContain("GUARD_PREFLIGHT=off")
  expect(result.output).not.toContain("1 通过")
})

test("只有门禁那一步之外的失败才按线上环境问题自动重跑，且只重跑一次", () => {
  const failed = (step: string, attempt = 1) =>
    run(["linux"], {
      conclusion: "failure",
      attempt,
      jobs: [
        {
          name: `preflight / linux / ${base}`,
          status: "completed",
          conclusion: "failure",
          steps: [
            { name: "Run actions/checkout", conclusion: "success" },
            { name: step, conclusion: "failure" },
          ],
        },
      ],
    })
  expect(environmentFailure(failed("Run ./.github/actions/setup-bun"))).toBe("Run ./.github/actions/setup-bun")
  expect(environmentFailure(failed(`${GATE_STEP}（linux）`))).toBeUndefined()
  expect(environmentFailure(failed("Run ./.github/actions/setup-bun", 2))).toBeUndefined()
})
