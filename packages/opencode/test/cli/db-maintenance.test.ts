import { describe, expect, test } from "bun:test"
import { mkdir, readdir } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import stripAnsi from "strip-ansi"
import { spawn as spawnPty, type IPty } from "@lydell/node-pty"
import { Database as SQLite } from "bun:sqlite"
import { Flock } from "@opencode-ai/core/util/flock"
import { tmpdir } from "../fixture/fixture"
// 测试只走公开 CLI/PTY seam；不导入 renderer 或调用维护私有函数，避免实现重构产生假绿。
const INDEX_TS = fileURLToPath(new URL("../../src/index.ts", import.meta.url))
const PTY_OPTIONS = { name: "xterm-256color", cols: 100 } as const
const PIPE_OPTIONS = { stdin: "ignore", stdout: "pipe", stderr: "pipe" } as const
// 所有路径都落在一次性目录，daemon lock、数据库和 XDG 状态不会接触开发者现场。
function isolatedEnv(root: string) {
  // OPENCODE_DB 与 lock 全部落一次性目录：db 命令的 liveDaemon 判定不会被真实 daemon 污染。
  return {
    ...process.env,
    OPENCODE_PROCESS_ROLE: "main",
    OPENCODE_LOCK_PATH: path.join(root, "tui-server.json"),
    OPENCODE_DB: path.join(root, "opencode.db"),
    OPENCODE_TEST_HOME: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "share"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
}
async function markMigrated(root: string) {
  // 预置 data marker 避免首跑迁移耗时把断言焦点从 DB 命令输出偏移到存储初始化。
  const dir = path.join(root, "share", "opencode")
  await mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, "opencode.db"), "")
}
// PTY helper 保留真实 stdin/stderr 关系，prompt、ANSI 和光标行为都由产品入口产生。
function runPty(args: string[], env: Record<string, string | undefined>) {
  // env 过滤 undefined：PTY 构造器要求值类型完整，不依赖平台对 undefined 的容错。
  const proc = spawnPty(process.execPath, [INDEX_TS, ...args], {
    ...PTY_OPTIONS,
    cwd: path.dirname(INDEX_TS),
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  })
  let output = ""
  // scrollback 全量累积后统一去 ANSI；单个 chunk 的转义序列边界不可信。
  proc.onData((data) => (output += data))
  const exited = new Promise<number>((resolve) => proc.onExit((event) => resolve(event.exitCode)))
  return { proc, exited, output: () => stripAnsi(output).replaceAll("\r", "") }
}
// 大文本 reasoning 只用于制造真实可压缩页；压缩 eligibility 和 payload 仍由 ColdStorage 判定。
async function seedColdParts(root: string, count = 40) {
  await markMigrated(root)
  // 先经真实 CLI status 完成建库与迁移；夹具只在合法 schema 上追加行。
  await runCli(root, ["db", "status", "--json"])
  // 先使用真实 migration，再仅插入独立 owner；fixture 不复制 schema 或 eligibility 算法。
  const db = new SQLite(path.join(root, "opencode.db"))
  // FK OFF 只为插入速度；eligibility 仍由 ColdStorage 的 session.age 判定决定。
  db.exec("PRAGMA foreign_keys = OFF")
  // session.time_updated=1 是 age 时钟：older-than 0ms 时所有 owner 立即 eligible。
  db.query(
    "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_cli_progress', 'global', 'progress', ?, 'progress fixture', 'test', 1, 1)",
  ).run(root)
  db.exec("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_cli_progress', 'ses_cli_progress', 1, 1, '{}')")
  const insert = db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 1, 1, ?)")
  db.transaction(() => {
    for (let index = 0; index < count; index++) {
      // 4KB 重复文本保证 reasoning part 足够大，压缩收益与速率计算都有真实信号。
      insert.run(
        `prt_cli_progress_${index}`,
        "msg_cli_progress",
        "ses_cli_progress",
        JSON.stringify({ type: "reasoning", text: `reasoning-${index}-`.repeat(4_096), time: { start: 1 } }),
      )
    }
  })()
  db.close()
}
async function waitForExit(proc: IPty, exited: Promise<number>) {
  // PTY 是真实 CLI seam；外层期限只防测试挂死，不参与产品进度或完成判定。
  const result = await Promise.race([exited, Bun.sleep(20_000).then(() => "timeout" as const)])
  if (result !== "timeout") return result
  // 超时先 kill 再抛错，避免挂死的 PTY 子进程泄漏到后续用例。
  proc.kill()
  throw new Error("database maintenance PTY exceeded 20 seconds")
}
// 非 PTY helper 分开读取 stdout/stderr，确保 machine JSON 不被人类提示污染。
async function runCli(root: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, INDEX_TS, ...args], {
    env: isolatedEnv(root),
    ...PIPE_OPTIONS,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    // 三个 stream 分别消费，保证 machine JSON 的合法性不会被 stdout/stderr 竞争掩盖。
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}
function answerPrompt(proc: IPty, prompt: string, answer: "y" | "n") {
  let answered = false
  // 只应答首个匹配 prompt；后续 reclaim 等待由各自用例单独控制，避免双写 stdin。
  proc.onData((data) => {
    if (answered || !data.includes(prompt)) return
    answered = true
    proc.write(`${answer}\r`)
  })
}
// Windows ConPTY 下 Bun 子进程 attach stdin 后输入管道即被关闭（readline/process.stdin/Bun.stdin 三探针均不可达），
// 依赖回写 stdin 的交互用例只在 POSIX 执行；机器域与纯渲染用例全平台运行。
const ptyInteractive = process.platform === "win32" ? test.skip : test
describe("database maintenance CLI", () => {
  test("renders compact database status in an interactive terminal", async () => {
    await using tmp = await tmpdir({ init: markMigrated })
    const cli = runPty(["db", "status"], isolatedEnv(tmp.path))
    // status 不读 stdin：即使交互回写不可用，渲染断言在本平台仍然有效。
    expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
    const output = cli.output()
    // 四段标题顺序锁定渲染结构；字段顺序由 renderer 决定而非 JSON 序列化顺序。
    expect(output).toMatch(/OpenCode database[\s\S]*Page allocation[\s\S]*Cold storage[\s\S]*Health/)
    // 人类视图不得泄漏 machine 字段名；JSON 输出只属于 --json/重定向路径。
    expect(output).not.toContain('"pageSize"')
  }, 30_000)
  test("keeps first-run JSON status machine-readable", async () => {
    // 三种根命令经过同一 machine 序列化边界，避免只验证 status 的偶然路径。
    const commands = [
      ["status", "--json"],
      ["compress", "--older-than", "0ms", "--json"],
      ["vacuum", "--yes", "--json"],
    ]
    for (const command of commands) {
      await using tmp = await tmpdir()
      // marker 故意缺失，真实初始化不能污染本次 machine result。
      const result = await runCli(tmp.path, ["db", ...command])
      // stdout 必须为空：machine JSON 全量走 stderr，调用方无需在两个流里猜协议。
      expect([result.exitCode, result.stdout], result.stderr).toEqual([0, ""])
      expect(() => JSON.parse(result.stderr)).not.toThrow()
      // status 是唯一可预先断言字段的命令；pageSize 由 SQLite PRAGMA 固定为 4096。
      if (command[0] === "status") {
        expect(JSON.parse(result.stderr)).toMatchObject({ pageSize: 4096 })
      }
    }
  }, 90_000)
  // progress 只观察已提交 checkpoint，测试不预设总量、百分比或内部 batch 次数。
  ptyInteractive("reports committed compression progress in an interactive terminal", async () => {
    await using tmp = await tmpdir({ init: seedColdParts })
    const cli = runPty(["db", "compress", "--older-than", "0ms", "--batch-size", "1"], isolatedEnv(tmp.path))
    // batch-size 1 强制多批 checkpoint；进度行必须由持久化快照驱动而非内存估计。
    answerPrompt(cli.proc, "Reclaim", "n")
    // N 在 offline reclaim prompt 只跳过 vacuum，不回滚已经完成并持久化的 compression。
    expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
    const output = cli.output()
    // 单一顺序断言同时锁定活动行与 terminal 汇总，避免两个宽松匹配分别命中无关输出。
    expect(output).toMatch(/Compressing cold data[\s\S]*owners[\s\S]*\/s[\s\S]*elapsed[\s\S]*Compression completed in (?:\d+\.\ds|\d+m \d+s)/)
    // 交互域不得输出 task JSON；JSON 只属于 machine 分支。
    expect(output).not.toContain('"operation": "compress"')
  }, 30_000)
  test("finishes visible progress before reporting a maintenance failure", async () => {
    await using tmp = await tmpdir({ init: (root) => seedColdParts(root, 4) })
    const db = new SQLite(path.join(tmp.path, "opencode.db"))
    const row = db.query("SELECT id FROM part ORDER BY id LIMIT 1 OFFSET 1").get() as { id: string }
    // 第一个 batch 已持久化后才由临时 trigger 失败，确保受测的是可见 progress 的异常收尾而非启动失败。
    db.exec(`CREATE TRIGGER fail_progress BEFORE UPDATE ON part WHEN OLD.id = '${row.id}' BEGIN SELECT RAISE(ABORT, 'fixture maintenance failure'); END`)
    db.close()
    const cli = runPty(["db", "compress", "--older-than", "0ms", "--batch-size", "1"], isolatedEnv(tmp.path))
    // 失败路径不进 reclaim prompt；非零退出码由真实维护错误产生。
    expect(await waitForExit(cli.proc, cli.exited)).not.toBe(0)
    const output = cli.output()
    // trigger 消息必须来自 durable task record，证明错误在 checkpoint 后才进入 UI。
    expect(output).toMatch(/Compressing cold data[\s\S]*owners[\s\S]*fixture maintenance failure/)
    // 进度行换行先于错误文本：finish() 必须在错误传播前把活动行终结。
    expect(output).toMatch(/elapsed \d+\.\ds[^\n]*\n.*fixture maintenance failure/s)
    // 失败后不得出现完成或回收文案，防止把 failed task 伪装成成功序列。
    expect(output).not.toMatch(/Compression completed|Reclaim/)
  }, 30_000)
  ptyInteractive("holds the daemon election while initially offline compression runs", async () => {
    await using tmp = await tmpdir({ init: (root) => seedColdParts(root, 80) })
    const electionDir = path.join(tmp.path, "state", "opencode", "locks")
    const cli = runPty(["db", "compress", "--older-than", "0ms", "--batch-size", "1"], isolatedEnv(tmp.path))
    answerPrompt(cli.proc, "Reclaim", "n")
    // 等待真实 lock 文件发布后再启动 contender，避免用 PTY 批量刷出时机推断 election 已经持有。
    while (!(await readdir(electionDir).catch(() => [])).some((file) => file.endsWith(".lock"))) {
      await Bun.sleep(10)
    }
    const contender = (async () => {
      // contender 只拿同 key 选主锁；30s 等待窗口内任何提前成功都是发布边界波漏。
      await using _ = await Flock.acquire(`opencode.server:${path.join(tmp.path, "tui-server.json")}`, { dir: electionDir, timeoutMs: 30_000 })
      return "acquired" as const
    })()
    const exited = waitForExit(cli.proc, cli.exited)
    // terminal 必须先于 contender acquisition；该顺序直接验证 election 覆盖完整 offline sequence。
    expect(await Promise.race([contender, exited.then(() => "finished" as const)])).toBe("finished")
    expect(await exited).toBe(0)
    // CLI 退出后 contender 才拿到锁：release 发生在全部 checkpoint 与输出之后。
    expect(await contender).toBe("acquired")
  }, 60_000)
  // Y 序列验证 logical compression 之后才取得 physical reclaim 授权，并复用现有 vacuum owner。
  ptyInteractive("reclaims SQLite pages after interactive compression approval", async () => {
    await using tmp = await tmpdir({ init: (root) => seedColdParts(root, 60) })
    const cli = runPty(["db", "compress", "--older-than", "0ms", "--batch-size", "5"], isolatedEnv(tmp.path))
    answerPrompt(cli.proc, "Reclaim", "y")
    // 页面收益使用 pre-status pageSize 与 vacuum page counts，禁止把它伪装成主文件 stat。
    expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
    const output = cli.output()
    // prompt 文案包含具体容量；它是 pre-vacuum StatusReport 的 freelist 计算结果。
    expect(output).toContain("of physical database space now? [Y/n]")
    // 顺序锁定完整 Y 序列：完成提示 → 容量提示 → vacuum 活动 → 页面前后对比。
    expect(output).toMatch(/Logical compression is complete[\s\S]*SQLite still contains[\s\S]*Reclaiming SQLite pages[\s\S]*Physical reclaim completed[\s\S]*Page allocation[\s\S]*Reclaimed pages/)
    // standalone 保留显式 --yes 与同一 renderer，不复用 compress 的交互授权。
    const standalone = runPty(["db", "vacuum", "--yes"], isolatedEnv(tmp.path))
    expect(await waitForExit(standalone.proc, standalone.exited)).toBe(0)
    const standaloneOutput = standalone.output()
    // 同一 tmp 复用已压缩数据库：standalone vacuum 的可回收页来自上一轮残留。
    expect(standaloneOutput).toContain("Reclaiming SQLite pages")
    expect(standaloneOutput).toMatch(/Physical reclaim completed in (?:\d+\.\ds|\d+m \d+s)/)
    // 人类域不得泄漏 machine 字段名。
    expect(standaloneOutput).not.toContain('"pagesBefore"')
  }, 30_000)
  // 显式 machine 组合必须等两阶段完成后一次性序列化，不能泄漏中间 human/progress 输出。
  test("emits one JSON document for an approved non-interactive compression and vacuum", async () => {
    // 此测试使用 non-TTY 与显式 --json 双重 machine 信号，防止任一路径重新引入 readline。
    await using tmp = await tmpdir({ init: (root) => seedColdParts(root, 20) })
    const result = await runCli(tmp.path, [
      "db",
      "compress",
      "--older-than",
      "0ms",
      "--batch-size",
      "5",
      "--vacuum",
      "--yes",
      "--json",
    ])
    // composite shape 保留原 task 与 vacuum 结果，不创造第三套 storage result 协议。
    expect([result.exitCode, result.stdout], result.stderr).toEqual([0, ""])
    // 两阶段完成才允许序列化；中间不得输出 compress 单独 JSON 或进度行。
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "compress-vacuum",
      compress: { operation: "compress", status: "completed" },
      vacuum: { type: "vacuum", pagesBefore: expect.any(Number), pagesAfter: expect.any(Number) },
    })
    // 同一公开 argv seam 也锁定 --yes 不能脱离 --vacuum 成为隐式 stop/reclaim 授权。
    const invalid = await runCli(tmp.path, ["db", "compress", "--yes", "--json"])
    expect([invalid.exitCode === 0, invalid.stderr.includes("compress --yes requires --vacuum")]).toEqual([false, true])
  }, 30_000)
})
