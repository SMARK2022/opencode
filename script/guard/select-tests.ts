#!/usr/bin/env bun
// 覆盖率图提供候选测试；图不完整、基线不可用或改动没有覆盖时，必须回到静态依赖图。
import path from "node:path"
import os from "node:os"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { ESCALATE_FULL } from "./affected-rules"
import { posix, pjoin, git, listFiles, flag } from "./lib"
import { TEST_FILE } from "./affected"

export type CoverageMap = { version: 2; commit: string; pkg: string; tests: Record<string, Record<string, number[]> | null> }

export async function buildCoverageMap(pkgDir: string, out: string, jobs = 4) {
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error("--jobs 必须是正整数")
  pkgDir = await realpath(pkgDir)
  const repo = readGit(pkgDir, "rev-parse", "--show-toplevel")
  const rel = posix(path.relative(repo, pkgDir))
  const tests = (await listFiles(pkgDir, "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}")).filter((file) => TEST_FILE.test(file))
  if (!tests.length) throw new Error("没有发现可建图的测试：" + rel)
  const map: CoverageMap = { version: 2, commit: readGit(repo, "rev-parse", "HEAD"), pkg: rel, tests: {} }
  const tmp = await mkdtemp(path.join(os.tmpdir(), "guard-covmap-"))
  const failures: string[] = []
  let next = 0
  try {
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(jobs, tests.length) }, async () => {
        while (next < tests.length) {
          const index = next++
          const test = tests[index]
          const dir = path.join(tmp, String(index))
          const proc = Bun.spawn(
            [process.execPath, "test", "--timeout=30000", "--coverage", "--coverage-reporter=lcov", "--coverage-dir=" + dir, "./" + test],
            {
              cwd: pkgDir,
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          const [code, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ])
          const lcov = Bun.file(path.join(dir, "lcov.info"))
          const key = pjoin(rel, test)
          if (code === 0 && (await lcov.exists())) {
            const text = await lcov.text()
            try {
              map.tests[key] = parseLcov(text, repo, pkgDir)
              continue
            } catch (error) {
              console.warn(`${key}: ${error}`)
            }
          }
          map.tests[key] = null
          // 子测试诊断保留在日志中，前缀与外层 Bun reporter 的 (fail) 行区分。
          console.warn(`跳过覆盖记录：${key}（退出码 ${code}）\n${(stdout + "\n" + stderr).replace(/^/gm, "| ")}`)
        }
      }),
    )
    for (const worker of workers) if (worker.status === "rejected") failures.push(String(worker.reason))
    if (failures.length) throw new Error("覆盖率建图进程失败：\n" + failures.join("\n"))
    if (Object.values(map.tests).some(Boolean)) await Bun.write(out, JSON.stringify(map))
    return map
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

export async function selectTests(pkgDir: string, mapFile: string, restrict?: string[]) {
  pkgDir = await realpath(pkgDir)
  const repo = readGit(pkgDir, "rev-parse", "--show-toplevel")
  const pkg = posix(path.relative(repo, pkgDir))
  const map: unknown = await Bun.file(mapFile).json()
  if (!validMap(map, pkg)) return { mode: "stale", reason: "覆盖率图格式或完整性版本不匹配" }
  if (!git(repo, "cat-file", "-e", map.commit + "^{commit}").ok) return { mode: "stale", reason: "本地没有建图提交" }
  if (!git(repo, "merge-base", "--is-ancestor", map.commit, "HEAD").ok)
    return { mode: "stale", reason: "建图提交不在当前历史上" }
  const changed = [
    ...new Set([
      ...readGit(repo, "diff", "--name-only", "-z", "--no-renames", map.commit, "--").split("\0"),
      ...readGit(repo, "ls-files", "-z", "--others", "--exclude-standard").split("\0"),
    ]),
  ]
    .map(posix)
    .filter((file) => file && (!restrict || restrict.includes(file)))
  const escalate = changed.find((file) => ESCALATE_FULL.some((re) => re.test(file)))
  if (escalate) return { mode: "full", reason: "全局输入改动：" + escalate }
  const covered = new Set(Object.values(map.tests).flatMap((coverage) => Object.keys(coverage ?? {})))
  const selected = new Set<string>()
  for (const [test, coverage] of Object.entries(map.tests))
    if (coverage === null && (await Bun.file(path.join(repo, test)).exists())) selected.add(test)
  const unmapped: string[] = []
  for (const file of changed) {
    if (file.startsWith(pkg + "/") && TEST_FILE.test(file)) {
      if (await Bun.file(path.join(repo, file)).exists()) selected.add(file)
      else unmapped.push(file)
      continue
    }
    if (!covered.has(file)) {
      unmapped.push(file)
      continue
    }
    const ranges = readGit(
      repo,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--unified=0",
      map.commit,
      "--",
      file,
    )
      .split("\n")
      .flatMap((line) => {
        const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+/)
        if (!match) return []
        const start = Number(match[1])
        const length = match[2] === undefined ? 1 : Number(match[2])
        return [[Math.max(1, start - 1), start + Math.max(length, 1)]]
      })
    const hits = Object.entries(map.tests).filter(([, coverage]) =>
      coverage?.[file]?.some((line) => ranges.some(([start, end]) => line >= start && line <= end)),
    )
    if (!hits.length) unmapped.push(file)
    for (const [test] of hits) {
      if (await Bun.file(path.join(repo, test)).exists()) selected.add(test)
      else unmapped.push(file)
    }
  }
  return { mode: "files", tests: [...selected].sort(), unmapped: [...new Set(unmapped)].sort() }
}

function readGit(repo: string, ...args: string[]) {
  const result = git(repo, ...args)
  if (!result.ok) throw new Error("git " + args[0] + " 失败：" + result.err)
  return result.out
}

function parseLcov(text: string, repo: string, cwd: string) {
  const out: Record<string, number[]> = {}
  let file = ""
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      file = posix(path.relative(repo, path.resolve(cwd, line.slice(3))))
      if (file.startsWith("../") || path.isAbsolute(file)) file = "" // 测试运行时写到临时目录的文件不是仓库源码
      else out[file] ??= []
    }
    if (!line.startsWith("DA:") || !file) continue
    const [number, hits] = line.slice(3).split(",").map(Number)
    if (!Number.isSafeInteger(number) || number < 1 || !Number.isFinite(hits) || hits < 0) {
      throw new Error("无效 lcov 行：" + line)
    }
    if (hits > 0) out[file].push(number)
  }
  if (!Object.keys(out).length) throw new Error("lcov 没有任何源文件记录")
  return out
}

function validMap(value: unknown, pkg: string): value is CoverageMap {
  if (!value || typeof value !== "object") return false
  const map = value as Partial<CoverageMap>
  if (map.version !== 2 || map.pkg !== pkg || typeof map.commit !== "string" || !/^[a-f0-9]{40}$/.test(map.commit))
    return false
  if (!map.tests || typeof map.tests !== "object" || Array.isArray(map.tests) || !Object.keys(map.tests).length)
    return false
  return Object.entries(map.tests).every(
    ([test, coverage]) =>
      test.startsWith(pkg + "/") &&
      TEST_FILE.test(test) &&
      typeof coverage === "object" &&
      !Array.isArray(coverage) &&
      Object.entries(coverage ?? {}).every(
        ([file, lines]) =>
          file &&
          !file.startsWith("../") &&
          !path.isAbsolute(file) &&
          Array.isArray(lines) &&
          lines.every((line) => Number.isSafeInteger(line) && line > 0),
      ),
  )
}

if (import.meta.main) {
  const [cmd, pkgArg, ...args] = process.argv.slice(2)
  const pkg = path.resolve(pkgArg ?? ".")
  if (cmd === "map") {
    const map = await buildCoverageMap(
      pkg,
      flag(args, "--out") ?? "coverage-map.json",
      Number(flag(args, "--jobs") ?? 4),
    )
    const records = Object.values(map.tests)
    console.log(`${map.pkg}: ${records.filter(Boolean).length}/${records.length} 个测试文件有覆盖记录`)
  } else if (cmd === "select") {
    console.log(
      JSON.stringify(
        await selectTests(
          pkg,
          flag(args, "--map") ?? "coverage-map.json",
          flag(args, "--files")?.split(",").map(posix),
        ),
      ),
    )
  } else {
    throw new Error("未知命令：" + cmd + "（可选 map | select）")
  }
}
