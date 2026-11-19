#!/usr/bin/env bun
// 基于覆盖率的测试选择（regression test selection）。
//   建图: bun select-tests.ts map <pkgDir> --out map.json [--jobs 8]
//         对包内每个测试文件单独跑 bun test --coverage，记录它真正执行过的源码行。
//   选择: bun select-tests.ts select <pkgDir> --map map.json
//         用 `git diff -U0 <map.commit>` 的旧行号区间与执行行求交，输出必须运行的测试文件。
// 选择结果完全由覆盖率和 diff 决定，Agent 无法也无需参与判断。
import path from "node:path"
import { Glob } from "bun"
import { ESCALATE_FULL } from "./affected-rules"
import { posix } from "./lib"

type CoverageMap = { commit: string; pkg: string; tests: Record<string, Record<string, number[]>> }

const [cmd, pkgArg, ...rest] = process.argv.slice(2)
const opt = (n: string) => {
  const i = rest.indexOf(n)
  return i === -1 ? undefined : rest[i + 1]
}
const pkgDir = path.resolve(pkgArg ?? ".")
const run = (cwd: string, ...a: string[]) => Bun.spawnSync(a, { cwd }).stdout.toString().trim()
const repo = run(pkgDir, "git", "rev-parse", "--show-toplevel")
const rel = (abs: string) => posix(path.relative(repo, abs))

function parseLcov(text: string, cwd: string) {
  const out: Record<string, number[]> = {}
  let file = ""
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) file = rel(path.resolve(cwd, line.slice(3)))
    else if (line.startsWith("DA:")) {
      const [ln, hits] = line.slice(3).split(",").map(Number)
      if (hits > 0) (out[file] ??= []).push(ln)
    }
  }
  return out
}

if (cmd === "map") {
  const tests: string[] = []
  for await (const f of new Glob("**/*.test.{ts,tsx}").scan({ cwd: pkgDir })) if (!f.includes("node_modules")) tests.push(posix(f))
  const jobs = Number(opt("--jobs") ?? 4)
  const map: CoverageMap = { commit: run(repo, "git", "rev-parse", "HEAD"), pkg: rel(pkgDir), tests: {} }
  const tmp = path.join(require("node:os").tmpdir(), `covmap-${process.pid}`)
  let next = 0
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < tests.length) {
        const t = tests[next++]
        const dir = path.join(tmp, t.replaceAll("/", "__"))
        const proc = Bun.spawn(["bun", "test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${dir}`, t], {
          cwd: pkgDir,
          stdout: "ignore",
          stderr: "ignore",
        })
        await proc.exited
        const lcov = Bun.file(path.join(dir, "lcov.info"))
        map.tests[rel(path.join(pkgDir, t))] = (await lcov.exists()) ? parseLcov(await lcov.text(), pkgDir) : {}
      }
    }),
  )
  await Bun.write(opt("--out") ?? "coverage-map.json", JSON.stringify(map))
  console.log(`mapped ${tests.length} test files at ${map.commit.slice(0, 8)}`)
}

if (cmd === "select") {
  const map: CoverageMap = await Bun.file(opt("--map") ?? "coverage-map.json").json()
  // 建图提交不在本地（浅克隆或尚未 fetch）时 diff 为空，会静默漏选；交给调用方退回静态图
  if (Bun.spawnSync(["git", "cat-file", "-e", `${map.commit}^{commit}`], { cwd: repo }).exitCode !== 0) {
    console.log(JSON.stringify({ mode: "stale", reason: `本地没有建图提交 ${map.commit.slice(0, 8)}` }))
    process.exit(0)
  }
  // 旧行号区间：相对建图提交的全部改动（含未提交与未跟踪文件）
  const diff = run(repo, "git", "diff", "-U0", map.commit, "--", ".")
  const hunks = new Map<string, [number, number][]>()
  let file = ""
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) file = line.slice(4).replace(/^a\//, "")
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+/)
    if (m && file !== "/dev/null") {
      const start = Number(m[1])
      const len = m[2] === undefined ? 1 : Number(m[2])
      ;(hunks.get(file) ?? hunks.set(file, []).get(file)!).push([start - 1, start + Math.max(len, 1)])
    }
  }
  const untracked = run(repo, "git", "ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean)
  const added = run(repo, "git", "diff", "--name-only", "--diff-filter=A", map.commit).split("\n").filter(Boolean)
  // --files：只考虑这些文件（Agent 结束闸门按会话改动的文件选测试）
  const restrict = opt("--files")?.split(",").map(posix)
  const changed = [...new Set([...hunks.keys(), ...untracked, ...added])]
    .filter((f) => !restrict || restrict.includes(f))
    .filter((f) => f.startsWith(map.pkg + "/") || !f.startsWith("packages/"))

  const escalate = changed.find((f) => ESCALATE_FULL.some((re) => re.test(f)))
  if (escalate) {
    console.log(JSON.stringify({ mode: "full", reason: `全局输入改动: ${escalate}` }))
    process.exit(0)
  }
  const covered = new Set(Object.values(map.tests).flatMap((c) => Object.keys(c)))
  const selected = new Set<string>()
  const unmapped: string[] = []
  for (const f of changed) {
    if (map.tests[f] !== undefined || /\.test\.tsx?$/.test(f)) {
      selected.add(f)
      continue
    }
    if (!covered.has(f)) {
      unmapped.push(f)
      continue
    }
    const ranges = hunks.get(f) ?? [[0, Number.MAX_SAFE_INTEGER]]
    for (const [t, cov] of Object.entries(map.tests)) {
      const lines = cov[f]
      if (lines?.some((ln) => ranges.some(([a, b]) => ln >= a && ln <= b))) selected.add(t)
    }
  }
  // 覆盖图里没有的源文件（新文件、运行时读取的资源）交给静态 import 图兜底
  console.log(JSON.stringify({ mode: "files", tests: [...selected].sort(), unmapped }))
}
