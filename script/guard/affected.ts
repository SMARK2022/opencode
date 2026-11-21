#!/usr/bin/env bun
// 静态依赖图的测试选择（覆盖率图不可用或不完整时使用）：反向 import 闭包选中测试；
// 全局输入升级全部包，包内全局输入或图外文件只升级所属包。
import path from "node:path"
import { posix, git, flag, listFiles, loadPackages } from "./lib"
import { graph } from "./graph"
import { guardPlan, closure, ALWAYS_RUN, FULL_RATIO } from "./affected-rules"

export const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/
export type TestPlan = {
  pkg: string
  mode: "full" | "files"
  tests: string[]
  reason: string
  command: string[]
}

export async function planAffected(repo: string, changed: string[]) {
  const policy = guardPlan(changed, repo)

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

  // 独立 sdk-next 套件与 Playwright E2E 不进主线门禁；它们的源码仍参与依赖分析。
  const tests = files.filter((f) => TEST_FILE.test(f) && policy.suite(f))
  const testSet = new Set(tests)
  const always = tests.filter((f) => ALWAYS_RUN.some((re) => re.test(f)))
  const selected = new Set(always)
  const guardChanged = changed.some((file) => file.startsWith("script/guard/"))

  // 升级全量只看改动本身：根配置影响全部主线包，包内全局输入或图外文件只升级所属包。
  const full = new Map<string, string>()
  for (const file of changed) {
    const owner = pkgs.dirOf(file)
    for (const test of closure(reverse, [file])) if (testSet.has(test)) selected.add(test)
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
    const whole = policy.full(dir) || full.has(dir) || picked.length > all.length * FULL_RATIO
    if (!whole && !picked.length) continue

    // 主线按文件选测，保留包的 bun test 参数。cli 已有 Bun 测试，但没有声明 test 脚本。
    const script = pkgs.byDir.get(dir)?.json.scripts?.test ?? (dir === "cli" ? "bun test" : "")
    if (!/^bun test(?: --(?:only-failures|timeout(?:=| )\d+))*$/.test(script))
      throw new Error("主线包需要可按文件执行的 bun test 入口：packages/" + dir)
    plan.push({
      pkg: "packages/" + dir,
      mode: whole ? "full" : "files",
      tests: whole ? all.sort() : picked.sort(),
      reason: full.get(dir) ?? (whole ? "包级输入或全量" : "import 图反向闭包"),
      command: script.split(/\s+/),
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
      command: ["bun", "test"],
    })
  }

  // 本次测试实际会加载的包：计划内的包与契约包，加上它们依赖的全部包（工作区有改动时据此判断能否在本地验证）
  const inputs = [
    ...closure(dependencies, [...plan.map((p) => p.pkg.replace(/^packages\//, "")), ...policy.contracts]),
  ].filter((dir) => pkgs.byDir.has(dir))
  return { changed: changed.length, plan, always, inputs: inputs.map((dir) => "packages/" + dir).sort() }
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
