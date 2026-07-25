import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

const PACKAGE_ROOT = join(import.meta.dir, "..")
const REPORT_DIR = join(PACKAGE_ROOT, ".artifacts", "unit")
const REPORTER_ARGS = ["--timeout", "30000", "--reporter=junit"]

export function partitionTestFiles(files: readonly string[]) {
  // Bun Glob 在 Windows 返回反斜杠；先统一表示，分区才不会只在 Unix 上成立。
  const normalized = files.map((file) => file.replaceAll("\\", "/"))
  // 三个 CLI 根目录是 Windows feedback loop 验证过的 native process domain。
  // 其余路径默认进入 core，确保未来新增测试不会因名单未更新而被静默漏掉。
  const isTuiTest = (file: string) => /^test\/cli\/(?:run|tui|cmd\/tui)\//.test(file)

  return {
    core: normalized.filter((file) => !isTuiTest(file)),
    tui: normalized.filter(isTuiTest),
  }
}

async function runShard(name: "core" | "tui", files: readonly string[]) {
  console.log(`Running ${name} test shard (${files.length} files)`)
  // 每个 child 独占 JUnit 路径；复用同一文件会覆盖先完成 shard 的失败证据。
  const proc = Bun.spawn(
    [
      process.execPath,
      "test",
      ...files,
      ...REPORTER_ARGS,
      `--reporter-outfile=.artifacts/unit/junit-${name}.xml`,
    ],
    {
      cwd: PACKAGE_ROOT,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  return proc.exited
}

async function main() {
  const files = (
    await Array.fromAsync(new Bun.Glob("test/**/*.test.{ts,tsx}").scan({ cwd: PACKAGE_ROOT, onlyFiles: true }))
  ).sort()
  if (files.length === 0) {
    // 空列表会让 Bun test 重新发现全套测试，反而破坏 native process boundary。
    throw new Error("No opencode test files were discovered")
  }

  const shards = partitionTestFiles(files)
  // 任一空 shard 都会让 Bun 退回自动发现全套测试，重新破坏进程隔离。
  // 在编排 owner 处 fail closed，避免“看似分片、实际全量”的假绿。
  if (shards.core.length === 0 || shards.tui.length === 0) {
    throw new Error(`Expected non-empty core and TUI shards, got ${JSON.stringify(shards)}`)
  }

  await mkdir(REPORT_DIR, { recursive: true })
  const reports = await Array.fromAsync(new Bun.Glob("*.xml").scan({ cwd: REPORT_DIR, onlyFiles: true }))
  // 清理旧报告，避免 CI 或本地复用目录时发布未参与本次运行的结果。
  await Promise.all(reports.map((file) => rm(join(REPORT_DIR, file), { force: true })))

  // 两个 shard 必须顺序启动；TUI child 不能继承 core 的 native process state。
  const coreStatus = await runShard("core", shards.core)
  const tuiStatus = await runShard("tui", shards.tui)
  // 首个非零 exit code 保留真实失败；core 失败不能阻止 TUI 产生完整报告。
  process.exit(coreStatus || tuiStatus)
}

if (import.meta.main) await main()
