#!/usr/bin/env bun
// 静态依赖图的测试选择（覆盖率图不可用或不完整时使用）：反向 import 闭包选中测试；
// 全局输入升级全部包，包内全局输入或图外文件只升级所属包。
import path from "node:path"
import { posix, git, flag, listFiles, loadPackages } from "./lib"
import { graph } from "./graph"
import { ESCALATE_FULL, ALWAYS_RUN, FULL_RATIO, BUN_TEST_PACKAGES } from "./affected-rules"

export const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/
export type TestPlan = {
  pkg: string
  mode: "full" | "files"
  tests: string[]
  reason: string
  runner: "bun" | "script"
  command: string[]
  commands?: string[][]
}

// 契约测试每次 push 都跑；它们加载的包也算作“本次测试的输入”。
const CONTRACT_PACKAGES = ["schema", "protocol"]

export async function planAffected(repo: string, changed: string[]) {
  const pkgs = await loadPackages(repo)
  const files = await listFiles(repo, "packages/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}")
  const sources = new Map<string, string>()
  for (const file of files) sources.set(file, await Bun.file(path.join(repo, file)).text())
  const imports = Map.groupBy(graph(repo, pkgs, sources).edges, (edge) => edge.file)
  const reverse = new Map<string, Set<string>>()
  const dependencies = new Map<string, Set<string>>()
  const link = (map: Map<string, Set<string>>, from: string, to: string) => {
    if (from !== to) (map.get(from) ?? map.set(from, new Set()).get(from)!).add(to)
  }
  for (const [file, refs] of imports)
    for (const ref of refs) {
      if (!ref.target) continue
      link(reverse, ref.target, file)
      const owner = pkgs.dirOf(file)
      const dependency = pkgs.dirOf(ref.target)
      if (owner && dependency) link(dependencies, owner, dependency)
    }

  // 主线不运行独立 sdk-next 套件或 Playwright E2E；源码仍参与依赖分析。
  const tests = files.filter((f) => TEST_FILE.test(f) && !/^packages\/(?:sdk-next\/|[^/]+\/e2e\/)/.test(f))
  const testSet = new Set(tests)
  const always = tests.filter((f) => ALWAYS_RUN.some((re) => re.test(f)))
  const selected = new Set(always)
  const guardChanged = changed.some((file) => file.startsWith("script/guard/"))
  if (guardChanged)
    for (const test of tests)
      if (/^packages\/(schema|protocol)\/test\//.test(test)) selected.add(test)
  // 升级全量只看改动本身：全局输入改全部包，包内全局输入或图外文件只改所属包
  const full = new Map<string, string>()
  for (const file of changed) {
    const owner = pkgs.dirOf(file)
    for (const test of closure(reverse, [file])) if (testSet.has(test)) selected.add(test)
    if (ESCALATE_FULL.some((re) => re.test(file))) {
      for (const pkg of owner ? [owner] : pkgs.byDir.keys()) full.set(pkg, "全局输入改动：" + file)
      continue
    }
    // 依赖图之外仍存在的文件（资源、提示词等运行时读取的输入）无法定位测试；已删除且无人引用的文件不影响测试
    const outside = owner && !sources.has(file) && !reverse.has(file) && !TEST_FILE.test(file)
    if (outside && (await Bun.file(path.join(repo, file)).exists())) full.set(owner, "改动文件不在依赖图中：" + file)
  }

  const suites = Map.groupBy(tests, (test) => {
    const dir = pkgs.dirOf(test)
    if (!dir) throw new Error("测试没有所属工作区包：" + test)
    return dir
  })
  const plan: TestPlan[] = []
  for (const [dir, all] of suites) {
    const picked = all.filter((test) => selected.has(test))
    if (!full.has(dir) && !picked.length) continue
    const scripts = pkgs.byDir.get(dir)?.json.scripts ?? {}
    const script = scripts.test
    if (typeof script !== "string" && !BUN_TEST_PACKAGES.has(dir))
      throw new Error("测试没有可执行入口：packages/" + dir + " 的 test（" + all[0] + "）")
    const commands = typeof script === "string" ? checkTestScript(scripts, "test", dir, all) : undefined
    // test 脚本就是一条 bun test（可带参数）时，按文件挑选；其他组合脚本整体执行
    const native = typeof script !== "string" || /^bun test(?: --[\w-]+(?:[= ]\d+)?)*$/.test(script)
    const whole = full.has(dir) || !native || picked.length > all.length * FULL_RATIO
    plan.push({
      pkg: "packages/" + dir,
      mode: whole ? "full" : "files",
      tests: whole ? all.sort() : picked.sort(),
      reason:
        full.get(dir) ??
        (!native
          ? "组合测试入口：test"
          : whole
            ? "受影响测试 " + picked.length + "/" + all.length
            : "import 图反向闭包"),
      runner: native ? "bun" : "script",
      command: native ? (typeof script === "string" ? script.split(/\s+/) : ["bun", "test"]) : ["bun", "run", "test"],
      ...(!native && commands?.every((command) => command.runner === "bun")
        ? { commands: commands.map((command) => ["bun", "test", ...command.args]) }
        : {}),
    })
  }
  if (guardChanged) {
    const tests = (await listFiles(repo, "script/guard/test/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}")).filter((file) =>
      TEST_FILE.test(file),
    )
    if (!tests.length) throw new Error("Guard 改动缺少规则自身的执行测试")
    plan.push({
      pkg: "script/guard",
      mode: "files",
      tests,
      reason: "Guard 规则自身测试",
      runner: "bun",
      command: ["bun", "test"],
    })
  }
  // 本次测试实际会加载的包：计划内的包与契约包，加上它们依赖的全部包（工作区有改动时据此判断能否在本地验证）
  const inputs = [
    ...closure(dependencies, [...plan.map((p) => p.pkg.replace(/^packages\//, "")), ...CONTRACT_PACKAGES]),
  ].filter((dir) => pkgs.byDir.has(dir))
  return { changed: changed.length, plan, always, inputs: inputs.map((dir) => "packages/" + dir).sort() }
}

function checkTestScript(scripts: Record<string, unknown>, name: string, dir: string, tests: string[]) {
  const commands = expand(name, [])
  if (!commands.some((command) => command.runner !== "other"))
    throw new Error("测试入口没有执行受支持的测试运行器：packages/" + dir + " 的 " + name)
  if (commands.some((command) => command.runner !== "bun")) return commands
  const values = new Set([
    "--timeout",
    "--preload",
    "--conditions",
    "--reporter",
    "--reporter-outfile",
    "--coverage-dir",
    "--max-concurrency",
    "--rerun-each",
  ])
  const roots = commands.map((command) => {
    const roots: string[] = []
    for (let i = 0; i < command.args.length; i++) {
      const arg = command.args[i]
      if (/^(--test-name-pattern|--watch|-t)(=|$)/.test(arg))
        throw new Error("固定测试入口禁止名称过滤或 watch：" + name)
      if (values.has(arg)) {
        i++
        continue
      }
      if (!arg.startsWith("-")) roots.push(arg.replace(/^\.\//, "").replace(/\/$/, ""))
    }
    return roots
  })
  const missing = tests.find((test) => {
    const file = test.slice(("packages/" + dir + "/").length)
    return !roots.some(
      (targets) => !targets.length || targets.some((target) => file === target || file.startsWith(target + "/")),
    )
  })
  if (missing) throw new Error("测试文件未被执行入口覆盖：" + missing)
  return commands

  function expand(name: string, stack: string[]): { runner: "bun" | "script" | "other"; args: string[] }[] {
    if (stack.includes(name)) throw new Error("测试脚本存在循环：" + [...stack, name].join(" → "))
    const script = scripts[name]
    if (typeof script !== "string") throw new Error("测试脚本引用了不存在的入口：" + name)
    if (/[;|`\n]|\$\(/.test(script)) throw new Error("测试脚本包含无法验证的控制流：" + name)
    return script.split(/\s*&&\s*/).flatMap((part) => {
      const command = part.trim().split(/\s+/)
      if (command[0] === "bun" && command[1] === "test") return [{ runner: "bun" as const, args: command.slice(2) }]
      if (command[0] === "bun" && command[1] === "run" && command.length === 3)
        return expand(command[2], [...stack, name])
      if (/^(playwright test|vitest(?: run)?|jest|vscode-test)(?:\s|$)/.test(part))
        return [{ runner: "script" as const, args: command }]
      return [{ runner: "other" as const, args: command }]
    })
  }
}

function closure(reverse: Map<string, Set<string>>, start: string[]) {
  const seen = new Set<string>()
  const queue = [...start]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const next of reverse.get(file) ?? []) queue.push(next)
  }
  return seen
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const repo = path.resolve(args[0] && !args[0].startsWith("--") ? args[0] : ".")
  const lines = (value: string) => value.split("\0").map(posix).filter(Boolean)
  const run = (...args: string[]) => {
    const result = git(repo, ...args)
    if (!result.ok) throw new Error("git " + args[0] + " 失败：" + result.err)
    return result.out
  }
  const explicit = flag(args, "--files")
  const changed =
    explicit !== undefined
      ? explicit.split(",").map(posix).filter(Boolean)
      : [
          ...new Set([
            ...lines(
              run(
                "diff",
                "--name-only",
                "-z",
                "--no-renames",
                flag(args, "--base") ?? run("merge-base", "origin/dev1-smark", "HEAD"),
                "HEAD",
              ),
            ),
            ...lines(run("diff", "--name-only", "-z", "--no-renames", "HEAD")),
            ...lines(run("ls-files", "-z", "--others", "--exclude-standard")),
          ]),
        ]
  const result = await planAffected(repo, changed)
  const out = flag(args, "--json")
  if (out) await Bun.write(out, JSON.stringify(result, null, 1))
  for (const plan of result.plan)
    console.log(plan.mode.padEnd(5) + " " + plan.pkg + " · " + plan.tests.length + " 个文件（" + plan.reason + "）")
  console.log("always: " + result.always.length + " 个文件；改动：" + result.changed + " 个文件")
}
