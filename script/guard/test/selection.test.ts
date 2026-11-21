import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { planAffected } from "../affected"
import { buildCoverageMap, selectTests, type CoverageMap } from "../select-tests"

const fixtures: string[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("包配置变化升级所属包的全量，不扩散到消费者；嵌套包同样生效", async () => {
  const repo = await fixture({
    ...modules(),
    "packages/console/app/package.json": pkg("console-app", { "@fixture/core": "workspace:*" }),
    "packages/console/app/src/view.test.ts": "",
    "packages/console/app/tsconfig.test.json": "{}",
  })
  const result = await planAffected(repo, ["packages/core/package.json"])
  expect(result.plan.map((plan) => [plan.pkg, plan.mode])).toEqual([["packages/core", "full"]])
  expect((await planAffected(repo, ["packages/console/app/tsconfig.test.json"])).plan).toHaveLength(1)
})

test("静态闭包识别跨包源码、spec/JS 测试，并保留包自己的测试参数", async () => {
  const repo = await fixture(modules())
  const result = await planAffected(repo, ["packages/core/src/value.ts"])
  const consumer = result.plan.find((plan) => plan.pkg === "packages/opencode")!
  expect(consumer.mode).toBe("files")
  expect(consumer.tests).toEqual(["packages/opencode/test/read.spec.js"])
  expect(consumer.command).toEqual(["bun", "test", "--timeout", "30000", "--only-failures"])
})

test("删除被引用的源码仍然能找到消费者", async () => {
  const repo = await fixture(modules())
  await rm(path.join(repo, "packages/core/src/value.ts"))
  const result = await planAffected(repo, ["packages/core/src/value.ts"])
  expect(result.plan.find((plan) => plan.pkg === "packages/opencode")?.tests).toContain(
    "packages/opencode/test/read.spec.js",
  )
})

test("没有测试可达的源码不升级全量；图外资源升级所属包", async () => {
  const repo = await fixture({
    ...modules(),
    "packages/core/src/new.ts": "export const newValue = 1\n",
    "packages/core/src/prompt.txt": "hello\n",
  })
  expect((await planAffected(repo, ["packages/core/src/new.ts"])).plan).toEqual([])
  const asset = await planAffected(repo, ["packages/core/src/prompt.txt"])
  expect(asset.plan.map((plan) => [plan.pkg, plan.mode])).toEqual([["packages/core", "full"]])
})

test("always 套件并入计划，新增测试包缺少执行入口时失败", async () => {
  const repo = await fixture({
    ...modules(),
    "packages/other/package.json": pkg("other"),
    "packages/other/test/smoke/ready.test.ts": "",
  })
  const result = await planAffected(repo, ["packages/core/src/value.ts"])
  expect(result.plan.find((plan) => plan.pkg === "packages/other")?.tests).toEqual([
    "packages/other/test/smoke/ready.test.ts",
  ])
  await Bun.write(path.join(repo, "packages/unknown/package.json"), JSON.stringify({ name: "@fixture/unknown" }))
  await Bun.write(path.join(repo, "packages/unknown/test/a.test.ts"), "")
  await expect(planAffected(repo, ["packages/unknown/test/a.test.ts"])).rejects.toThrow("测试没有可执行入口")
})

test("复合脚本保留自己的执行器，端到端套件不进门禁", async () => {
  const repo = await fixture({
    "packages/app/package.json": JSON.stringify({
      name: "@fixture/app",
      scripts: {
        test: "bun run test:unit && bun run test:browser",
        "test:unit": "bun test --timeout 15000 ./src",
        "test:browser": "bun test ./test-browser",
        "test:e2e": "playwright test",
      },
    }),
    "packages/app/src/a.test.ts": "",
    "packages/app/e2e/a.spec.ts": "",
    "packages/app/e2e/performance/unit/a.test.ts": 'import { test } from "bun:test"\n',
  })
  const result = await planAffected(repo, ["packages/app/package.json"])
  expect(result.plan.map((plan) => [plan.command, plan.tests])).toEqual([
    [["bun", "run", "test"], ["packages/app/src/a.test.ts"]],
  ])
  expect(result.plan[0].commands).toEqual([
    ["bun", "test", "--timeout", "15000", "./src"],
    ["bun", "test", "./test-browser"],
  ])
  await Bun.write(
    path.join(repo, "packages/app/package.json"),
    JSON.stringify({
      name: "@fixture/app",
      scripts: {
        test: "bun run prepare && bun test",
        prepare: "bun build ./src/index.ts",
        "test:e2e": "playwright test",
      },
    }),
  )
  const prepared = await planAffected(repo, ["packages/app/package.json"])
  expect(prepared.plan.find((plan) => plan.command.at(-1) === "test")?.commands).toBeUndefined()
})

test("Guard 变动只调度规则自身和固定契约，不升级全部产品测试", async () => {
  const repo = await fixture({
    ...modules(),
    "packages/schema/package.json": JSON.stringify({ name: "@fixture/schema" }),
    "packages/client/package.json": pkg("client"),
    "packages/client/test/import-boundaries.test.ts": "",
    "packages/sdk-next/package.json": pkg("sdk-next"),
    "packages/sdk-next/test/import-boundaries.test.ts": "",
    "packages/schema/test/schema.test.ts": "",
    "script/guard/test/rule.test.ts": "",
  })
  const result = await planAffected(repo, ["script/guard/affected.ts"])
  expect(result.plan.map((plan) => plan.pkg)).toEqual(["packages/schema", "script/guard"])
  expect(result.plan.at(-1)?.tests).toEqual(["script/guard/test/rule.test.ts"])
})

test("实际 tsconfig paths 参与反向依赖选择", async () => {
  const repo = await fixture({
    ...modules(),
    "packages/opencode/tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "~shared/*": ["../core/src/*"] } },
    }),
    "packages/opencode/src/read.ts": 'import { value } from "~shared/value"\nexport const read = () => value\n',
  })
  const result = await planAffected(repo, ["packages/core/src/value.ts"])
  expect(result.plan.find((plan) => plan.pkg === "packages/opencode")?.tests).toEqual([
    "packages/opencode/test/read.spec.js",
  ])
})

test("CLI 显式 base 按两个提交直接比较，包含基线独有文件", async () => {
  const repo = await fixture(modules())
  const head = run(repo, "rev-parse", "HEAD")
  await Bun.write(path.join(repo, "packages/core/src/base-only.ts"), "export const value = 1")
  run(repo, "add", ".")
  run(repo, "-c", "user.name=Guard Test", "-c", "user.email=guard@example.invalid", "commit", "-qm", "base change")
  const base = run(repo, "rev-parse", "HEAD")
  run(repo, "checkout", "--detach", head)
  const output = path.join(repo, ".git", "plan.json")
  const result = Bun.spawnSync(
    [Bun.argv[0], path.join(import.meta.dir, "../affected.ts"), repo, "--base", base, "--json", output],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(result.exitCode).toBe(0)
  const plan = await Bun.file(output).json()
  expect(plan.changed).toBe(1)
  expect(plan.plan).toEqual([])
})

test("测试入口拒绝仅编译、循环引用和遗漏发现文件的目录过滤", async () => {
  const repo = await fixture(modules())
  for (const scripts of [
    { test: "echo passed" },
    { test: "bun run compile", compile: "tsgo --noEmit" },
    { test: "bun run cycle", cycle: "bun run test" },
    { test: "bun test ./test/other.test.ts" },
  ]) {
    await Bun.write(path.join(repo, "packages/core/package.json"), JSON.stringify({ name: "@fixture/core", scripts }))
    await expect(planAffected(repo, ["packages/core/package.json"])).rejects.toThrow()
  }
})

test("覆盖率选择保留跨包源文件的消费测试", async () => {
  const repo = await fixture(modules())
  const map = await coverage(repo, { "packages/core/src/value.ts": [1] })
  await Bun.write(path.join(repo, "packages/core/src/value.ts"), "export const value = 2\n")
  expect(await selectTests(path.join(repo, "packages/opencode"), map, ["packages/core/src/value.ts"])).toEqual({
    mode: "files",
    tests: ["packages/opencode/test/read.spec.js"],
    unmapped: [],
  })
})

test("覆盖图存在文件但未覆盖改动行时交给静态图", async () => {
  const repo = await fixture({
    ...modules(),
    "packages/core/src/value.ts":
      Array.from({ length: 20 }, (_, i) => "export const value" + i + " = 1").join("\n") + "\n",
  })
  const map = await coverage(repo, { "packages/core/src/value.ts": [1] })
  const file = path.join(repo, "packages/core/src/value.ts")
  await Bun.write(file, (await Bun.file(file).text()).replace("value19 = 1", "value19 = 2"))
  expect(await selectTests(path.join(repo, "packages/opencode"), map, ["packages/core/src/value.ts"])).toEqual({
    mode: "files",
    tests: [],
    unmapped: ["packages/core/src/value.ts"],
  })
})

test("旧格式覆盖图和其他包的图必须退回静态图", async () => {
  const repo = await fixture(modules())
  const map = await coverage(repo, { "packages/core/src/value.ts": [1] })
  const value = await Bun.file(map).json()
  delete value.version
  await Bun.write(map, JSON.stringify(value))
  expect((await selectTests(path.join(repo, "packages/opencode"), map)).mode).toBe("stale")
  await coverage(repo, { "packages/core/src/value.ts": [1] })
  expect((await selectTests(path.join(repo, "packages/core"), map)).mode).toBe("stale")
})

test("跳过失败覆盖记录，保留成功记录；没有成功记录时不覆盖旧图", async () => {
  const repo = await fixture({
    "packages/core/package.json": pkg("core"),
    "packages/core/src/value.ts": "export const value = 1\n",
    "packages/core/test/value.test.ts":
      'import { test, expect } from "bun:test"\nimport { value } from "../src/value"\ntest("value", () => expect(value).toBe(2))\n',
  })
  const out = path.join(repo, ".git", "coverage.json")
  await Bun.write(out, "previous map")
  await buildCoverageMap(path.join(repo, "packages/core"), out, 1)
  expect(await Bun.file(out).text()).toBe("previous map")
  await expect(buildCoverageMap(path.join(repo, "packages/core"), out, 0)).rejects.toThrow("正整数")
  await Bun.write(
    path.join(repo, "packages/core/test/pass.test.ts"),
    'import { test, expect } from "bun:test"\nimport { value } from "../src/value"\ntest("value", () => expect(value).toBe(1))\n',
  )
  const map = await buildCoverageMap(path.join(repo, "packages/core"), out, 1)
  expect(map.version).toBe(2)
  expect(map.tests["packages/core/test/pass.test.ts"]?.["packages/core/src/value.ts"]).toContain(1)
  expect(map.tests["packages/core/test/value.test.ts"]).toBeNull()
  expect((await selectTests(path.join(repo, "packages/core"), out, [])).tests).toEqual(["packages/core/test/value.test.ts"])
})

async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-selection-"))
  fixtures.push(dir)
  for (const [file, text] of Object.entries(files)) await Bun.write(path.join(dir, file), text)
  run(dir, "init", "-q")
  run(dir, "add", ".")
  run(dir, "-c", "user.name=Guard Test", "-c", "user.email=guard@example.invalid", "commit", "-qm", "fixture")
  return dir
}

function run(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function pkg(name: string, dependencies: Record<string, string> = {}) {
  return JSON.stringify({
    name: "@fixture/" + name,
    exports: { ".": "./src/value.ts", "./*": "./src/*.ts" },
    dependencies,
    scripts: { test: "bun test --timeout 30000 --only-failures" },
  })
}

function modules() {
  return {
    "packages/core/package.json": pkg("core"),
    "packages/core/src/value.ts": "export const value = 1\n",
    "packages/core/test/value.test.ts": 'import "../src/value"\n',
    "packages/core/test/other.test.ts": "",
    "packages/core/test/third.test.ts": "",
    "packages/opencode/package.json": pkg("opencode", { "@fixture/core": "workspace:*" }),
    "packages/opencode/src/read.ts": 'import { value } from "@fixture/core"\nexport const read = () => value\n',
    "packages/opencode/test/read.spec.js": 'import "../src/read.js"\n',
    "packages/opencode/test/other.test.ts": "",
    "packages/opencode/test/third.test.ts": "",
  }
}

async function coverage(repo: string, source: Record<string, number[]>) {
  const file = path.join(repo, ".git", "coverage.json")
  const map: CoverageMap = {
    version: 2,
    commit: run(repo, "rev-parse", "HEAD"),
    pkg: "packages/opencode",
    tests: { "packages/opencode/test/read.spec.js": source },
  }
  await Bun.write(file, JSON.stringify(map))
  return file
}

test("测试输入包含计划内的包和它们加载到的包", async () => {
  const repo = await fixture(modules())
  const result = await planAffected(repo, ["packages/core/src/value.ts"])
  expect(result.inputs).toEqual(expect.arrayContaining(["packages/core", "packages/opencode"]))
})
