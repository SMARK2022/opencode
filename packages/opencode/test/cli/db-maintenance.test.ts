import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { RunCommand } from "../../src/cli/cmd/run"
import { mkdir, readdir } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import stripAnsi from "strip-ansi"
import { spawn, type Proc } from "@opencode-ai/core/pty/pty.bun" // Bun 宿主沿 source 的 #pty 使用原生后端。
import { Database as SQLite } from "bun:sqlite"
import { Flock } from "@opencode-ai/core/util/flock"
// #549：status --task / hung-control 用例消费 reconcile 与 control 协议常量（目标 owner 在 cli/tui）。
import { ServerLock } from "../../src/cli/tui/server-lock"
import type { MaintenanceTask } from "@opencode-ai/core/storage/cold-storage"
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
  const proc = spawn(process.execPath, [INDEX_TS, ...args], {
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
// #549：通过插入再删除大行制造 freelist，使 PROMPT 门槛（16MB 或占比）在小 fixture 上也可达。
function inflateFreelist(root: string, targetBytes = 20_000_000) {
  const db = new SQLite(path.join(root, "opencode.db"))
  db.exec("CREATE TABLE IF NOT EXISTS freelist_pad (id INTEGER PRIMARY KEY, blob BLOB)")
  const chunk = 256_000
  // 256KB 分块避免单语句过长；目标体积足以跨过 PROMPT/HINT 的绝对阈值。
  const insert = db.query("INSERT INTO freelist_pad (blob) VALUES (?)")
  const payload = Buffer.alloc(chunk, 0x61)
  db.transaction(() => {
    for (let filled = 0; filled < targetBytes; filled += chunk) insert.run(payload)
  })()
  db.exec("DELETE FROM freelist_pad")
  // DELETE+DROP 把整表页归还 freelist；单文件页级回收由 SQLite 自动完成。
  db.exec("DROP TABLE freelist_pad")
  db.close()
}

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
async function waitForExit(proc: Proc, exited: Promise<number>) {
  // PTY 是真实 CLI seam；外层期限只防测试挂死，不参与产品进度或完成判定。
  const result = await Promise.race([exited, Bun.sleep(20_000).then(() => "timeout" as const)])
  if (result !== "timeout") return result
  // 超时先 kill 再抛错，避免挂死的 PTY 子进程泄漏到后续用例。
  proc.kill()
  throw new Error("database maintenance PTY exceeded 20 seconds")
}
// #568：插入一条热 Tool 坏行（state.input 为字符串），模拟 AI SDK invalid dynamic 兜底入库形态。
// 必须直接 SQL 播种：任何经过 processor/import 的写入都会被归一化或校验，
// 无法制造出历史遗留形态的坏行。
// foreign_keys 关闭是播种前置：fixture 只写三张表，不维护真实外键图。
async function seedMalformedToolInput(root: string) {
  await markMigrated(root)
  await runCli(root, ["db", "status", "--json"])
  const db = new SQLite(path.join(root, "opencode.db"))
  db.exec("PRAGMA foreign_keys = OFF")
  db.query(
    "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_ti_repair', 'global', 'repair', ?, 'repair fixture', 'test', 1, 1)",
  ).run(root)
  db.exec("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_ti_repair', 'ses_ti_repair', 1, 1, '{}')")
  db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_ti_repair', 'msg_ti_repair', 'ses_ti_repair', 1, 1, ?)").run(
    JSON.stringify({
      type: "tool",
      tool: "bash",
      callID: "call-1",
      state: { status: "error", input: "{bad json", error: "boom", time: { start: 1, end: 2 } },
    }),
  )
  db.close()
}

// 非 PTY helper 分开读取 stdout/stderr，确保 machine JSON 不被人类提示污染。
async function runCli(root: string, args: string[]) {
  // 后台 CLI 子进程在 Windows 上隐藏 console，避免维护命令验证时弹出 conhost。
  const proc = Bun.spawn([process.execPath, INDEX_TS, ...args], {
    env: isolatedEnv(root),
    ...PIPE_OPTIONS,
    windowsHide: process.platform === "win32",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    // 三个 stream 分别消费，保证 machine JSON 的合法性不会被 stdout/stderr 竞争掩盖。
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}
function answerPrompt(proc: Proc, prompt: string, answer: "y" | "n") {
  let answered = false
  // 只应答首个匹配 prompt；后续 reclaim 等待由各自用例单独控制，避免双写 stdin。
  let output = ""
  // PTY 可以把提示文本和 ANSI 序列拆到不同 chunk；累积后再识别提示。
  // 回答后停止累积，避免此 helper 持有后续维护进度输出。
  proc.onData((data) => {
    if (answered) return
    output += data
    if (!stripAnsi(output).includes(prompt)) return
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

  // 目标已移除旧首跑迁移提示；直接使用实际命令定义验证正文归属，不进入Agent handler。
  test("does not classify a run message containing db status as a database command", () => {
    const selected: string[] = []
    const parsed = yargs(["run", "db", "status"])
      .command({ ...RunCommand, handler: () => { selected.push("run") } })
      .parseSync()
    expect(selected).toEqual(["run"])
    expect(parsed.message).toEqual(["db", "status"])
  })
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
    // #549：elapsed 字段定宽填充后允许空白；进度行 \r 被 strip 后可能粘连多帧。
    expect(output).toMatch(/elapsed\s+\d+\.\ds[\s\S]*fixture maintenance failure/)
    // 失败后不得出现完成或回收文案，防止把 failed task 伪装成成功序列。
    expect(output).not.toMatch(/Compression completed|Reclaim/)
  }, 30_000)
  ptyInteractive("holds the daemon election while initially offline compression runs", async () => {
    await using tmp = await tmpdir({
      init: async (root) => {
        await seedColdParts(root, 80)
        // #549：保持 reclaim prompt 出现，election 覆盖到用户决策结束，避免无 prompt 时过早释放。
        inflateFreelist(root, 20_000_000)
      },
    })
    const electionDir = path.join(tmp.path, "state", "opencode", "locks")
    // acquired 只在 contender 真正拿到锁后置位；acquiredAtTerminal 锁 terminal 时刻采样。
    let acquired = false
    let acquiredAtTerminal = false
    const cli = runPty(["db", "compress", "--older-than", "0ms", "--batch-size", "1"], isolatedEnv(tmp.path))
    // #549：Compression completed 出现时 election 仍应持有；contender 只能在 process 退出后进入。
    cli.proc.onData((data) => {
      if (data.includes("Compression completed")) acquiredAtTerminal = acquired
    })
    answerPrompt(cli.proc, "Reclaim", "n")
    while (!(await readdir(electionDir).catch(() => [])).some((file) => file.endsWith(".lock"))) {
      await Bun.sleep(10)
    }
    const contender = (async () => {
      // contender 只拿同 key 选主锁；30s 等待窗口内任何提前成功都是发布边界波漏。
      await using _ = await Flock.acquire(`opencode.server:${path.join(tmp.path, "tui-server.json")}`, { dir: electionDir, timeoutMs: 30_000 })
      acquired = true
      return "acquired" as const
    })()
    expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
    // terminal 时刻 election 必须仍持有：#549 采样点取代原 race 断言（更强且不依赖调度）。
    expect(acquiredAtTerminal).toBe(false)
    // CLI 退出后 contender 才拿到锁：release 发生在全部 checkpoint 与输出之后。
    expect(await contender).toBe("acquired")
  }, 60_000)
  // Y 序列验证 logical compression 之后才取得 physical reclaim 授权，并复用现有 vacuum owner。
  ptyInteractive("reclaims SQLite pages after interactive compression approval", async () => {
    await using tmp = await tmpdir({
      init: async (root) => {
        await seedColdParts(root, 60)
        // #549：压缩本身 freelist 可能低于 PROMPT；垫高 freelist 以验证 reclaim 授权路径。
        inflateFreelist(root, 20_000_000)
      },
    })
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
    // #549：reclaim 后 freelist 已空；human vacuum 软跳过，不再假装 Reclaiming。
    expect(standaloneOutput).toContain("No reusable pages to reclaim")
    expect(standaloneOutput).not.toContain("Reclaiming SQLite pages")
    // 人类域不得泄漏 machine 字段名。
    expect(standaloneOutput).not.toContain('"pagesBefore"')
  }, 30_000)
  // 显式 machine 组合必须等两阶段完成后一次性序列化，不能泄漏中间 human/progress 输出。
  // #549：PROMPT 门槛过滤几 KB freelist——小 fixture 压缩后不应出现 reclaim 交互。
  ptyInteractive("skips reclaim prompt when freelist is only noise", async () => {
    await using tmp = await tmpdir({
      init: async (root) => {
        await seedColdParts(root, 4)
        // 约 100KB freelist：旧 gate reusable>0 会 prompt；PROMPT/HINT 必须跳过。
        inflateFreelist(root, 100_000)
      },
    })
    const cli = runPty(["db", "compress", "--older-than", "0ms", "--batch-size", "2"], isolatedEnv(tmp.path))
    expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
    const output = cli.output()
    expect(output).toMatch(/Compression completed/)
    expect(output).not.toContain("of physical database space now? [Y/n]")
    expect(output).not.toContain("Logical compression is complete")
  }, 30_000)

  // #549：status Recommendation 与 reclaim 共用 HINT 门槛，噪声 freelist 不黄字建议 vacuum。
  test("omits vacuum recommendation when reusable freelist is below hint", async () => {
    await using tmp = await tmpdir({
      init: async (root) => {
        await markMigrated(root)
        await runCli(root, ["db", "status", "--json"])
        // 非零但低于 HINT：旧 Recommendation 会亮；新门槛必须保持沉默。
        inflateFreelist(root, 100_000)
      },
    })
    const cli = runPty(["db", "status"], isolatedEnv(tmp.path))
    expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
    const output = cli.output()
    expect(output).toMatch(/OpenCode database[\s\S]*Cold storage[\s\S]*Health/)
    expect(output).not.toContain("Recommendation")
    expect(output).not.toContain("opencode db vacuum --yes")
  }, 30_000)

  // #549：定宽进度行——吞吐从非零回到 0 时不应残留上一帧更长的 rate 文本（\x1b[K 清行）。
  ptyInteractive("progress line clears previous wider rate text", async () => {
    await using tmp = await tmpdir({ init: (root) => seedColdParts(root, 30) })
    const proc = spawn(process.execPath, [INDEX_TS, "db", "compress", "--older-than", "0ms", "--batch-size", "1"], {
      ...PTY_OPTIONS,
      cwd: path.dirname(INDEX_TS),
      env: Object.fromEntries(Object.entries(isolatedEnv(tmp.path)).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    })
    let raw = ""
    proc.onData((data) => (raw += data))
    answerPrompt(proc, "Reclaim", "n")
    expect(await waitForExit(proc, new Promise<number>((resolve) => proc.onExit((event) => resolve(event.exitCode))))).toBe(0)
    // 保留 \r 分帧；取进度帧检查无残影混入 0 B/s 帧。
    // \\r 分帧保留原始帧边界；strip-ansi 后仍可按 owners+elapsed 识别进度帧。
    const frames = raw.split("\r").filter((frame) => frame.includes("owners") && frame.includes("elapsed"))
    expect(frames.length).toBeGreaterThan(1)
    const last = frames[frames.length - 1]
    expect(last).toMatch(/owners/)
    expect(last).toMatch(/elapsed/)
    // 清行序列应出现在进度写入中。
    expect(raw).toContain("\x1b[K")
  }, 30_000)

  // #549：machine 复合结果在 NOISE 下不得触发物理 VACUUM，pageCount 应保持。
  test("skips SQL vacuum in compress-vacuum JSON when freelist is below noise", async () => {
    await using tmp = await tmpdir({
      init: async (root) => {
        await seedColdParts(root, 6)
        // 100KB 远低于 1MB NOISE，旧实现仍会 vacuum。
        inflateFreelist(root, 100_000)
      },
    })
    // pageCount 前后对比是"物理页未动"的直接证据；JSON shape 断言只证明协议不破。
    const before = await runCli(tmp.path, ["db", "status", "--json"])
    const beforeReport = JSON.parse(before.stderr)
    const result = await runCli(tmp.path, [
      "db",
      "compress",
      "--older-than",
      "0ms",
      "--batch-size",
      "3",
      "--vacuum",
      "--yes",
      "--json",
    ])
    expect(result.exitCode, result.stderr).toBe(0)
    const body = JSON.parse(result.stderr)
    expect(body).toMatchObject({
      type: "compress-vacuum",
      compress: { operation: "compress", status: "completed" },
      vacuum: { type: "vacuum" },
    })
    // NOISE 跳过：pageCount 不变，不是 vacuum 失败。
    expect(body.vacuum.pagesBefore).toBe(body.vacuum.pagesAfter)
    const after = await runCli(tmp.path, ["db", "status", "--json"])
    const afterReport = JSON.parse(after.stderr)
    expect(afterReport.pageCount).toBe(beforeReport.pageCount)
  }, 30_000)

  // #549：若恢复 2s HTTP status 轮询，挂起的 control GET 会 TimeoutError；reconcile 观察则仍应完成。
  // 本用例伪造 live daemon control：POST 只登记 task，进度只写 durable JSON。
  ptyInteractive("online observe completes while control status hangs during nonterminal work", async () => {
    await using tmp = await tmpdir({ init: (root) => seedColdParts(root, 8) })
    // seedColdParts 已通过真实 CLI 完成 migration，无需再次冷启动相同的 status 命令。
    const { realpath } = await import("fs/promises")
    // realpath 与 CLI Database.getPath 对齐，避免 task.dbPath mismatch 拒读。
    const dbPath = await realpath(path.join(tmp.path, "opencode.db"))
    const token = "hung-status-token"
    const lockPath = path.join(tmp.path, "tui-server.json")
    // taskID 由 POST 分配；terminal 标记 durable 终态已写入（settlement 解锁）。
    let taskID = ""
    let terminal = false
    // 假 control 与真 daemon 同协议：token 鉴权 + maintenance POST/GET 路径。
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.headers.get(ServerLock.CONTROL_TOKEN_HEADER) !== token) {
          return new Response("unauthorized", { status: 401 })
        }
        const url = new URL(request.url)
        if (request.method === "POST" && url.pathname === ServerLock.CONTROL_MAINTENANCE_PATH) {
          // 202 后 CLI 进入 observe；此处不执行 ColdStorage，只推进 task 文件。
          taskID = `dbm_hung_${crypto.randomUUID()}`
          const root = `${dbPath}.maintenance`
          await mkdir(path.join(root, "tasks"), { recursive: true })
          const base: MaintenanceTask = {
            version: 1,
            taskID,
            dbPath,
            operation: "compress",
            args: { operation: "compress", olderThanMs: 0, batchSize: 1 },
            status: "running",
            cursor: { owner: "part", lastID: "" },
            processed: 0,
            skipped: 0,
            failed: 0,
            rawBytes: 0,
            compressedBytes: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          // 真实 observer 可在任意时刻读取 checkpoint；fixture 也必须遵守原子发布协议。
          await ServerLock.writeMaintenanceTask(base)
          // live owner 必须与 task 同时存在，否则首帧 reconcile 会直接降为 interrupted。
          await mkdir(path.join(root, "lock"), { recursive: true })
          await Bun.write(
            path.join(root, "lock", "owner.json"),
            JSON.stringify(
              {
                taskID,
                dbPath,
                pid: process.pid,
                token: "hung-owner-token",
                startedAt: Date.now(),
              },
              null,
              2,
            ),
          )
          // 后台推进 durable counters，不经 control 进度通道。
          // 间隔 > PROGRESS_FRAME_MS，确保至少多帧 reconcile 读到 running。
          void (async () => {
            for (const processed of [2, 5, 8]) {
              await Bun.sleep(120)
              base.processed = processed
              base.rawBytes = processed * 1000
              base.updatedAt = Date.now()
              await ServerLock.writeMaintenanceTask(base)
            }
            base.status = "completed"
            base.updatedAt = Date.now()
            // 终态 checkpoint 同样原子提交；随后直接移除 lease 目录，不覆写虚假 owner。
            await ServerLock.writeMaintenanceTask(base)
            // 终态后撤掉 owner，模拟 worker finally 释放 lease，settlement GET 可立即返回。
            await import("fs/promises").then((fs) => fs.rm(path.join(root, "lock"), { recursive: true, force: true }))
            terminal = true
          })()
          return Response.json({ taskID, operation: "compress", status: "running", createdAt: base.createdAt }, { status: 202 })
        }
        if (request.method === "GET" && url.pathname === ServerLock.CONTROL_MAINTENANCE_STATUS_PATH) {
          // 非终态故意挂起 >2s：旧 HTTP 轮询必 TimeoutError；新路径只在 settlement 时打一次。
          // settlement 时 terminal=true，必须立即返回 completed 以免误伤 ensureSettled。
          if (!terminal) await Bun.sleep(5_000)
          const id = url.searchParams.get("task") ?? taskID
          const raw = await Bun.file(`${dbPath}.maintenance/tasks/${id}.json`).text()
          return Response.json(JSON.parse(raw))
        }
        return Response.json({ error: "unexpected" }, { status: 404 })
      },
    })
    try {
      // pid=本测试进程：liveDaemon() 认为 daemon 仍活，从而走 online observe。
      await Bun.write(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          port: 1,
          token,
          dbPath,
          channel: "test",
          startedAt: new Date().toISOString(),
          controlPort: server.port,
        }),
      )
      const env = { ...isolatedEnv(tmp.path), OPENCODE_LOCK_PATH: lockPath }
      const cli = runPty(["db", "compress", "--older-than", "0ms", "--batch-size", "1"], env)
      // N 保留"daemon"，强制 online 路径而非 offline lease。
      answerPrompt(cli.proc, "Stop daemon", "n")
      expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
      const output = cli.output()
      expect(output).toMatch(/Continuing through the running daemon[\s\S]*Compression completed/)
      expect(output).not.toMatch(/timed out|TimeoutError/i)
    } finally {
      server.stop(true)
    }
  }, 30_000)

  // #549：dead-owner 经 status --task 公开 seam 触发 reconcile，不得永久 running。
  // reconcile 契约：running + 死 owner 必须变成 interrupted 并给出 resume 提示。
  test("status --task demotes a running task with a dead lease owner to interrupted", async () => {
    await using tmp = await tmpdir({ init: markMigrated })
    await runCli(tmp.path, ["db", "status", "--json"])
    const dbPath = await Bun.file(path.join(tmp.path, "opencode.db")).exists().then(async () => {
      const { realpath } = await import("fs/promises")
      return realpath(path.join(tmp.path, "opencode.db"))
    })
    const taskID = "dbm_dead_owner_status_task"
    const root = `${dbPath}.maintenance`
    await mkdir(path.join(root, "tasks"), { recursive: true })
    await mkdir(path.join(root, "lock"), { recursive: true })
    const task = {
      version: 1,
      taskID,
      dbPath,
      operation: "compress",
      args: { operation: "compress", olderThanMs: 0, batchSize: 1 },
      status: "running",
      cursor: { owner: "message", lastID: "" },
      processed: 3,
      skipped: 0,
      failed: 0,
      rawBytes: 0,
      compressedBytes: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await Bun.write(path.join(root, "tasks", `${taskID}.json`), JSON.stringify(task, null, 2))
    // 不存在的 pid：alive() 为 false，reconcile 必须降为 interrupted。
    await Bun.write(
      path.join(root, "lock", "owner.json"),
      JSON.stringify(
        {
          taskID,
          dbPath,
          pid: 2_147_000_000,
          token: "dead-token",
          startedAt: Date.now(),
        },
        null,
        2,
      ),
    )
    // status --task 是公开 seam：render 前先经 reconcile（dead-owner 降级在此发生）。
    const cli = runPty(["db", "status", "--task", taskID], isolatedEnv(tmp.path))
    expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
    const output = cli.output()
    expect(output).toMatch(/interrupted|Maintenance interrupted/i)
    expect(output).toContain(taskID)
    expect(output).toContain("opencode db resume")
  }, 30_000)

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

  // #568：CLI 层覆盖 --repair-tool-input 的完整往返：yargs flag → task args 持久化 →
  // daemon maintain 执行 immediate 写事务；只测同步 verify 会漏掉 task-backed 边界。
  // 行断言直接用 SQL json_type 检查持久化形状，不依赖 task JSON 里的计数。
  test("db verify --repair-tool-input fixes malformed tool input so status succeeds", async () => {
    await using tmp = await tmpdir({ init: (root) => seedMalformedToolInput(root) })
    const before = await runCli(tmp.path, ["db", "status", "--json"])
    expect(before.exitCode).not.toBe(0)
    expect(before.stderr).toContain("Stored tool input is invalid")
    const repaired = await runCli(tmp.path, ["db", "verify", "--repair-tool-input"])
    expect(repaired.exitCode).toBe(0)
    expect(JSON.parse(repaired.stderr)).toMatchObject({ operation: "verify", status: "completed" })
    const db = new SQLite(path.join(tmp.path, "opencode.db"), { readonly: true })
    const inputType = db.query("SELECT json_type(data, '$.state.input') AS t FROM part WHERE id = 'prt_ti_repair'").get() as
      | { t?: string }
      | undefined
    db.close()
    expect(inputType?.t).toBe("object")
    const after = await runCli(tmp.path, ["db", "status", "--json"])
    expect(after.exitCode).toBe(0)
  }, 30_000)
})
