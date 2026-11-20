import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"

const CHECK = path.join(import.meta.dir, "..", "check.ts")

async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-architecture-"))
  for (const name of ["schema", "core", "app", "tui", "opencode", "sdk/js"])
    await Bun.write(
      path.join(dir, "packages", name, "package.json"),
      JSON.stringify({
        name: name === "sdk/js" ? "@opencode-ai/sdk" : `@opencode-ai/${name}`,
        exports: { "./*": "./src/*.ts" },
      }),
    )
  for (const [file, source] of Object.entries(files)) await Bun.write(path.join(dir, file), source)
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.name=guard", "-c", "user.email=guard@example.test", "commit", "-qm", "base")
  return {
    dir,
    git,
    write: (file: string, text: string) => Bun.write(path.join(dir, file), text),
    run: async (...args: string[]) => {
      const output = path.join(dir, "result.json")
      await rm(output, { force: true })
      const process = Bun.spawnSync([Bun.argv[0], CHECK, dir, "--json", output, "--quiet", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const report: { violations: { rule: string }[] } = (await Bun.file(output).exists())
        ? await Bun.file(output).json()
        : { violations: [] }
      return {
        code: process.exitCode,
        rules: report.violations.map((entry) => entry.rule),
        error: process.stderr.toString(),
      }
    },
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  }
}

describe("能力规则按绑定和语法结构判定", () => {
  const cases = [
    ["packages/core/src/tool/a.ts", 'import { Effect as Fx } from "effect"; Fx["catchCause"](() => 1)', "tool-cause"],
    [
      "packages/core/src/tool/a.ts",
      'import * as Fx from "effect/Effect"; const { ignoreCause: hide } = Fx; hide(task)',
      "tool-cause",
    ],
    [
      "packages/schema/src/a.ts",
      'import { Any as Unsafe } from "effect/Schema"; export const Data = Unsafe',
      "schema-any",
    ],
    [
      "packages/tui/src/a.tsx",
      'import { createEffect as watch } from "solid-js"; const load = async () => 1; watch(load)',
      "solid-async-effect",
    ],
    [
      "packages/tui/src/a.tsx",
      'import { createEffect, on } from "solid-js"; createEffect(on(() => value, async () => 1))',
      "solid-async-effect",
    ],
    [
      "packages/core/src/a.ts",
      'const later = globalThis["setTimeout"]; export const start = () => later(work, 1)',
      "raw-timer",
    ],
    [
      "packages/core/src/a.ts",
      'import { setTimeout as later } from "node:timers"; export const start = () => later(work, 1)',
      "raw-timer",
    ],
    [
      "packages/core/src/a.ts",
      "export async function load() { try { await work() } catch { /* ignored */ } }",
      "swallow",
    ],
    [
      "packages/core/src/a.ts",
      'import { ManagedRuntime as Runtime } from "effect"; export const value = Runtime.make(layer)',
      "runtime-create",
    ],
  ]
  for (const [file, source, rule] of cases)
    test(`${rule}: ${source}`, async () => {
      await using fx = await fixture({ [file]: source })
      const result = await fx.run()
      expect(result.rules).toContain(rule)
      expect(result.code).toBe(1)
    })

  test("字符串、注释和局部同名参数不持有受限能力", async () => {
    await using fx = await fixture({
      "packages/core/src/tool/a.ts":
        'import { Effect } from "effect"; export function explain(Effect: { catchCause: () => number }) { return Effect.catchCause() }\nexport const text = "setTimeout(() => {}, 1); Effect.catchCause(work)"',
    })
    expect((await fx.run()).code).toBe(0)
  })

  test("错误上报中的 void 表达式保留执行语义，空回调仍失败", async () => {
    await using fx = await fixture({
      "packages/core/src/a.ts":
        "export const recover = (task: Promise<unknown>) => task.catch(error => void console.error(error))",
    })
    expect((await fx.run()).code).toBe(0)
    await fx.write(
      "packages/core/src/a.ts",
      "export const recover = (task: Promise<unknown>) => task.catch(() => void 0)",
    )
    expect((await fx.run()).rules).toContain("swallow")
  })

  test("局部 require 参数保持普通调用", async () => {
    await using fx = await fixture({
      "packages/app/src/a.ts": 'export function load(require: (name: string) => string) { return require("node:fs") }',
    })
    expect((await fx.run()).code).toBe(0)
  })

  test("其他文件的同名变量不会遮蔽当前模块的全局能力", async () => {
    await using fx = await fixture({
      "packages/core/src/local.ts": "const setTimeout = () => 1; setTimeout()",
      "packages/core/src/global.ts": "setTimeout(work, 1)",
    })
    expect((await fx.run()).rules).toContain("raw-timer")
  })

  test("Promise 返回值和本地异步函数进入响应式计算时失败", async () => {
    await using fx = await fixture({
      "packages/app/src/a.ts": 'import { createEffect } from "solid-js"; createEffect(() => Promise.resolve(1))',
    })
    expect((await fx.run()).rules).toContain("solid-async-effect")
    await fx.write(
      "packages/app/src/a.ts",
      'import { createEffect } from "solid-js"; async function load() { return 1 }; createEffect(() => { return load() })',
    )
    expect((await fx.run()).rules).toContain("solid-async-effect")
    await fx.write(
      "packages/app/src/a.ts",
      'import { createEffect } from "solid-js"; export function mount(Promise: { resolve: () => number }) { createEffect(() => Promise.resolve()) }',
    )
    expect((await fx.run()).code).toBe(0)
  })

  test("工具通过本地转发和别名取得 catchCause 仍失败", async () => {
    await using fx = await fixture({
      "packages/core/src/bridge.ts": 'export { catchCause as absorb } from "effect/Effect"',
      "packages/core/src/public.ts": 'import { absorb } from "./bridge"; export const recover = absorb',
      "packages/core/src/tool/a.ts": 'import { recover } from "../public"; export const task = recover(() => 1)',
    })
    expect((await fx.run()).rules).toContain("tool-cause")
    await fx.write("packages/core/src/public.ts", "export const recover = (value: () => number) => value()")
    expect((await fx.run()).code).toBe(0)
  })

  test("转发环超过绑定缓存容量时仍终止并识别受限能力", async () => {
    await using fx = await fixture({
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `packages/core/src/bridge${index}.ts`,
          `export * from "./bridge${(index + 1) % 40}";` +
            (index === 0 ? ' export { catchCause as absorb } from "effect/Effect"' : ""),
        ]),
      ),
      "packages/core/src/tool/a.ts": 'import { absorb } from "../bridge0"; export const value = absorb(() => 1)',
    })
    expect((await fx.run()).rules).toContain("tool-cause")
  })

  test("子进程源码字符串允许定时器，测试自身固定等待仍失败", async () => {
    await using fx = await fixture({
      "packages/core/test/wait.test.ts":
        'import { test } from "bun:test"; test("fixture", () => Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 60000)"]))',
    })
    expect((await fx.run()).code).toBe(0)
    await fx.write("packages/core/test/wait.test.ts", 'import { sleep as delay } from "bun"; await delay(1)')
    expect((await fx.run()).rules).toContain("test-sleep")
  })
})

test("tsconfig 别名改变后重新检查未改动的消费者", async () => {
  await using fx = await fixture({
    "packages/schema/tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@shared/*": ["./src/*"] } } }),
    "packages/schema/src/a.ts": 'export { value } from "@shared/value"',
    "packages/schema/src/value.ts": "export const value = 1",
    "packages/core/src/value.ts": "export const value = 2",
  })
  await fx.run("--write-baseline")
  await fx.write(
    "packages/schema/tsconfig.json",
    JSON.stringify({ compilerOptions: { paths: { "@shared/*": ["../core/src/*"] } } }),
  )
  fx.git("add", "-A")
  const result = await fx.run("--staged")
  expect(result.rules).toContain("B4-relative-escape")
  expect(result.code).toBe(1)
})

test("JavaScript 源码同样执行定时器限制", async () => {
  await using fx = await fixture({ "packages/core/src/a.js": "export const load = () => setTimeout(work, 1)" })
  expect((await fx.run()).rules).toContain("raw-timer")
})

test("Core 的旧 SDK 依赖只允许类型，禁止改为运行时导出", async () => {
  await using fx = await fixture({ "packages/core/src/a.ts": 'export { type Value } from "@opencode-ai/sdk/v2/types"' })
  expect((await fx.run()).code).toBe(0)
  await fx.write("packages/core/src/a.ts", 'export { Value } from "@opencode-ai/sdk/v2/types"')
  expect((await fx.run()).rules).toContain("B8-type-only-dependency")
})

test("兼容入口的允许目标固定，删除约束也会失败", async () => {
  await using fx = await fixture({ "packages/opencode/src/compat.ts": 'export { value } from "@opencode-ai/core/a"' })
  await fx.run("--write-baseline")
  const previous = await Bun.file(path.join(fx.dir, "script/guard/baseline.json")).text()
  await fx.write("previous.json", previous)
  await fx.write("packages/opencode/src/compat.ts", 'export { value } from "@opencode-ai/core/b"')
  expect((await fx.run()).rules).toContain("F1-forwarder-lock")
  await fx.write(
    "script/guard/baseline.json",
    JSON.stringify({ ...JSON.parse(previous), forwarders: [], forwarderTargets: {} }),
  )
  await fx.write("packages/opencode/src/compat.ts", "export const value = 1")
  expect((await fx.run("--previous-baseline", path.join(fx.dir, "previous.json"))).rules).toContain(
    "C2-baseline-raised",
  )
})

test("历史依赖环逐边冻结，新增闭环失败", async () => {
  await using fx = await fixture({
    "packages/core/src/a.ts": 'import { b } from "./b"; export const a = () => b',
    "packages/core/src/b.ts": "export const b = 1",
  })
  await fx.run("--write-baseline")
  await fx.write("packages/core/src/b.ts", 'import { a } from "./a"; export const b = () => a')
  expect((await fx.run()).rules).toContain("B10-dependency-cycle")
})

test("无效比较引用和语法错误使分析失败", async () => {
  await using fx = await fixture({ "packages/core/src/a.ts": "export const value = 1" })
  expect((await fx.run("--changed-since", "does-not-exist")).code).toBe(2)
  await fx.write("packages/core/src/a.ts", "export const =")
  expect((await fx.run()).code).toBe(2)
})

test("结构化基线禁止移除、降版或用无效计数放行", async () => {
  await using fx = await fixture({ "packages/core/src/a.ts": "export const value = 1" })
  await fx.run("--write-baseline")
  const original = await Bun.file(path.join(fx.dir, "script/guard/baseline.json")).json()
  await fx.write("previous.json", JSON.stringify(original))
  await fx.write("script/guard/baseline.json", JSON.stringify({ ...original, structured: null }))
  expect((await fx.run()).code).toBe(2)
  await fx.write("script/guard/baseline.json", JSON.stringify({ ...original, counts: { "raw-timer": { file: "1" } } }))
  expect((await fx.run()).code).toBe(2)
  await fx.write("script/guard/baseline.json", JSON.stringify({ ...original, version: 2 }))
  expect((await fx.run("--previous-baseline", path.join(fx.dir, "previous.json"))).rules).toContain(
    "C2-baseline-raised",
  )
})

test("提交快照复用已安装的外部 tsconfig，源码仍取自提交", async () => {
  await using fx = await fixture({
    ".gitignore": "node_modules\n",
    "packages/core/tsconfig.json": JSON.stringify({ extends: "@tsconfig/bun/tsconfig.json" }),
    "packages/core/src/a.ts": 'import { value } from "./b"; export const result = value',
    "packages/core/src/b.ts": "export const value = 1",
  })
  await fx.write("node_modules/@tsconfig/bun/package.json", JSON.stringify({ name: "@tsconfig/bun" }))
  await fx.write(
    "node_modules/@tsconfig/bun/tsconfig.json",
    JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
  )
  expect((await fx.run()).code).toBe(0)
  expect((await fx.run("--staged")).code).toBe(0)
  expect((await fx.run("--commit", "HEAD")).code).toBe(0)
})
