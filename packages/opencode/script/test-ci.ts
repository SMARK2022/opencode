import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

const PACKAGE_ROOT = join(import.meta.dir, "..")
const REPORT_DIR = join(PACKAGE_ROOT, ".artifacts", "unit")
const REPORTER_ARGS = ["--timeout", "30000", "--reporter=junit"]

export function partitionTestFiles(files: readonly string[]) {
  // Bun Glob 在 Windows 返回反斜杠；先统一表示，分区才不会只在 Unix 上成立。
  const normalized = files.map((file) => file.replaceAll("\\", "/"))
  // 三个 CLI 根目录是 Windows feedback loop 验证过的 native process domain。
  // 其余路径分到 integration/runtime；默认全量调用仍将它们合并为原 core。
  const isTuiTest = (file: string) => /^test\/cli\/(?:run|tui|cmd\/tui)\//.test(file)
  // 先排除 TUI，再按目录拆会话/服务集成；其余新目录默认进入 runtime，不维护文件白名单。
  const isIntegrationTest = (file: string) => /^test\/(?:session|server|cli)\//.test(file)

  return {
    integration: normalized.filter((file) => !isTuiTest(file) && isIntegrationTest(file)),
    runtime: normalized.filter((file) => !isTuiTest(file) && !isIntegrationTest(file)),
    tui: normalized.filter(isTuiTest),
  }
}

async function runShard(name: "core" | keyof ReturnType<typeof partitionTestFiles>, files: readonly string[]) {
  console.log(`Running ${name} test shard (${files.length} files)`)
  const started = Date.now()
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
  // PID 与阶段时间将最后一条测试输出关联到实际 child；不把父进程活着误报成测试进展。
  console.log(JSON.stringify({ event: "test-shard-start", name, pid: proc.pid, files: files.length, time: started }))
  const code = await proc.exited
  // end 只在真实 child 退出后输出，区分测试摘要完成与原生句柄仍未释放。
  console.log(JSON.stringify({ event: "test-shard-end", name, pid: proc.pid, code, elapsed: Date.now() - started }))
  return code
}

async function main() {
  // 用 task env 选择单片，避免 Turbo argv 传入依赖 build；该变量在 turbo.json 中参与缓存键。
  const shard = process.env.OPENCODE_TEST_SHARD
  if (shard !== undefined && shard !== "integration" && shard !== "runtime" && shard !== "tui") {
    throw new Error("OPENCODE_TEST_SHARD must be integration, runtime, or tui")
  }
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
  if (Object.values(shards).some((files) => files.length === 0)) {
    throw new Error(`Expected non-empty integration, runtime, and TUI shards, got ${JSON.stringify(shards)}`)
  }

  await mkdir(REPORT_DIR, { recursive: true })
  const reports = await Array.fromAsync(new Bun.Glob("*.xml").scan({ cwd: REPORT_DIR, onlyFiles: true }))
  // 清理旧报告，避免 CI 或本地复用目录时发布未参与本次运行的结果。
  await Promise.all(reports.map((file) => rm(join(REPORT_DIR, file), { force: true })))

  // 单片独占 runner 与 JUnit 文件；不在同一 Windows 主机并发启动重型测试进程。
  if (shard) process.exit(await runShard(shard, shards[shard]))

  // 默认调用合并并恢复原排序，Linux/macOS 与本地全量执行的 core 顺序保持不变。
  const coreStatus = await runShard("core", [...shards.integration, ...shards.runtime].sort())
  const tuiStatus = await runShard("tui", shards.tui)
  // 首个非零 exit code 保留真实失败；core 失败不能阻止 TUI 产生完整报告。
  process.exit(coreStatus || tuiStatus)
}

if (import.meta.main) await main()
