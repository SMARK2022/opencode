import { describe, expect, test } from "bun:test"
import { mkdir, readdir } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import stripAnsi from "strip-ansi"
import { spawn as spawnPty, type Proc } from "#pty"
import { Database as SQLite } from "bun:sqlite"
import { Flock } from "@opencode-ai/core/util/flock"
import * as ServerLock from "../../src/cli/cmd/tui/server-lock"
import { tmpdir } from "../fixture/fixture"
// 测试只走公开 CLI/PTY seam；不导入 renderer 或调用维护私有函数，避免实现重构产生假绿。
const INDEX_TS = fileURLToPath(new URL("../../src/index.ts", import.meta.url))
const PTY_OPTIONS = { name: "xterm-256color", cols: 100 } as const
const PIPE_OPTIONS = { stdin: "ignore", stdout: "pipe", stderr: "pipe" } as const
// 所有路径都落在一次性目录，daemon lock、数据库和 XDG 状态不会接触开发者现场。
function isolatedEnv(root: string) {
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
  // 全局 middleware 只用 marker 判断一次性迁移；测试预置它，确保本切片只观察 DB 命令的公开输出。
  const dir = path.join(root, "share", "opencode")
  await mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, "opencode.db"), "")
}
// PTY helper 保留真实 stdin/stderr 关系，prompt、ANSI 和光标行为都由产品入口产生。
function runPty(args: string[], env: Record<string, string | undefined>) {
  const proc = spawnPty(process.execPath, [INDEX_TS, ...args], {
    ...PTY_OPTIONS,
    cwd: path.dirname(INDEX_TS),
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  })
  let output = ""
  proc.onData((data) => (output += data))
  const exited = new Promise<number>((resolve) => proc.onExit((event) => resolve(event.exitCode)))
  return { proc, exited, output: () => stripAnsi(output).replaceAll("\r", "") }
}
// 大文本 reasoning 只用于制造真实可压缩页；压缩 eligibility 和 payload 仍由 ColdStorage 判定。
// 通过插入再删除大行制造 freelist，使 PROMPT 门槛（16MB 或占比）在小 fixture 上也可达。
function inflateFreelist(root: string, targetBytes = 20_000_000) {
  const db = new SQLite(path.join(root, "opencode.db"))
  db.exec("CREATE TABLE IF NOT EXISTS freelist_pad (id INTEGER PRIMARY KEY, blob BLOB)")
  const chunk = 256_000
  const insert = db.query("INSERT INTO freelist_pad (blob) VALUES (?)")
  const payload = Buffer.alloc(chunk, 0x61)
  db.transaction(() => {
    for (let filled = 0; filled < targetBytes; filled += chunk) insert.run(payload)
  })()
  db.exec("DELETE FROM freelist_pad")
  db.exec("DROP TABLE freelist_pad")
  db.close()
}

async function seedColdParts(root: string, count = 40) {
  await markMigrated(root)
  await runCli(root, ["db", "status", "--json"])
  // 先使用真实 migration，再仅插入独立 owner；fixture 不复制 schema 或 eligibility 算法。
  const db = new SQLite(path.join(root, "opencode.db"))
  db.exec("PRAGMA foreign_keys = OFF")
  db.query(
    "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_cli_progress', 'global', 'progress', ?, 'progress fixture', 'test', 1, 1)",
  ).run(root)
  db.exec("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_cli_progress', 'ses_cli_progress', 1, 1, '{}')")
  const insert = db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 1, 1, ?)")
  db.transaction(() => {
    for (let index = 0; index < count; index++) {
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
  proc.kill()
  throw new Error("database maintenance PTY exceeded 20 seconds")
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

async function runCliUntilStderr(root: string, args: string[], marker: string) {
  const proc = Bun.spawn([process.execPath, INDEX_TS, ...args], {
    env: isolatedEnv(root),
    ...PIPE_OPTIONS,
    windowsHide: process.platform === "win32",
  })
  const stdout = new Response(proc.stdout).text()
  const reader = proc.stderr.pipeThrough(new TextDecoderStream()).getReader()
  let stderr = ""
  const observed = (async () => {
    // 流式观察 owned marker，不等待后续 Agent run 或整个 stderr EOF。
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return false
      stderr += chunk.value
      if (stderr.includes(marker)) return true
    }
  })()

  try {
    const result = await Promise.race([observed, Bun.sleep(20_000).then(() => false)])
    if (!result) throw new Error(`CLI did not emit stderr marker: ${marker}`)
  } finally {
    proc.kill()
    await Promise.allSettled([proc.exited, stdout, observed])
    reader.releaseLock()
  }

  return stderr
}

function answerPrompt(proc: Proc, prompt: string, answer: "y" | "n") {
  let answered = false
  proc.onData((data) => {
    if (answered || !data.includes(prompt)) return
    answered = true
    proc.write(`${answer}\r`)
  })
}
describe("database maintenance CLI", () => {
  test("renders compact database status in an interactive terminal", async () => {
    await using tmp = await tmpdir({ init: markMigrated })
    const cli = runPty(["db", "status"], isolatedEnv(tmp.path))
    expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
    const output = cli.output()
    expect(output).toMatch(/OpenCode database[\s\S]*Page allocation[\s\S]*Cold storage[\s\S]*Health/)
    expect(output).not.toContain('"pageSize"')
  }, 30_000)
  test("keeps first-run JSON status machine-readable", async () => {
    // 三种根命令都经过同一 migration presentation gate，避免只验证 status 的偶然路径。
    const commands = [
      ["status", "--json"],
      ["compress", "--older-than", "0ms", "--json"],
      ["vacuum", "--yes", "--json"],
    ]
    for (const command of commands) {
      await using tmp = await tmpdir()
      // marker 故意缺失，真实 root middleware 必须执行迁移但不能先污染本次 machine result。
      const result = await runCli(tmp.path, ["db", ...command])
      expect([result.exitCode, result.stdout], result.stderr).toEqual([0, ""])
      expect(() => JSON.parse(result.stderr)).not.toThrow()
      if (command[0] === "status") {
        expect(JSON.parse(result.stderr)).toMatchObject({ pageSize: 4096 })
      }
    }
  }, 90_000)
  test("does not classify a run message containing db status as a database command", async () => {
    await using tmp = await tmpdir()
    const stderr = await runCliUntilStderr(tmp.path, ["run", "db", "status"], "Performing one time database migration")
    // 该反例锁定非 DB 命令的既有迁移提示，防止 quiet policy 泄漏到 run message。
    expect(stderr).toContain("Performing one time database migration")
  }, 30_000)
  // progress 只观察已提交 checkpoint，测试不预设总量、百分比或内部 batch 次数。
  test("reports committed compression progress in an interactive terminal", async () => {
    await using tmp = await tmpdir({ init: seedColdParts })
    const cli = runPty(["db", "compress", "--older-than", "0ms", "--batch-size", "1"], isolatedEnv(tmp.path))
    answerPrompt(cli.proc, "Reclaim", "n")
    // N 在 offline reclaim prompt 只跳过 vacuum，不回滚已经完成并持久化的 compression。
    expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
    const output = cli.output()
    // 单一顺序断言同时锁定活动行与 terminal 汇总，避免两个宽松匹配分别命中无关输出。
    expect(output).toMatch(/Compressing cold data[\s\S]*owners[\s\S]*\/s[\s\S]*elapsed[\s\S]*Compression completed in (?:\d+\.\ds|\d+m \d+s)/)
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
    expect(await waitForExit(cli.proc, cli.exited)).not.toBe(0)
    const output = cli.output()
    expect(output).toMatch(/Compressing cold data[\s\S]*owners[\s\S]*fixture maintenance failure/)
    // elapsed 字段定宽填充后允许空白；进度行 \r 被 strip 后可能粘连多帧。
    expect(output).toMatch(/elapsed\s+\d+\.\ds[\s\S]*fixture maintenance failure/)
    expect(output).not.toMatch(/Compression completed|Reclaim/)
  }, 30_000)
  test("holds the daemon election while initially offline compression runs", async () => {
    await using tmp = await tmpdir({
      init: async (root) => {
        await seedColdParts(root, 80)
        // 保持 reclaim prompt 出现，election 覆盖到用户决策结束，避免无 prompt 时过早释放。
        inflateFreelist(root, 20_000_000)
      },
    })
    const electionDir = path.join(tmp.path, "state", "opencode", "locks")
    let acquired = false
    let acquiredAtTerminal = false
    const cli = runPty(["db", "compress", "--older-than", "0ms", "--batch-size", "1"], isolatedEnv(tmp.path))
    // Compression completed 出现时 election 仍应持有；contender 只能在 process 退出后进入。
    cli.proc.onData((data) => {
      if (data.includes("Compression completed")) acquiredAtTerminal = acquired
      if (!data.includes("Reclaim") || acquired) return
      // 先让 contender 挂起在 election 上，再回答 reclaim，拉长持锁窗口。
    })
    answerPrompt(cli.proc, "Reclaim", "n")
    while (!(await readdir(electionDir).catch(() => [])).some((file) => file.endsWith(".lock"))) {
      await Bun.sleep(10)
    }
    const contender = (async () => {
      await using _ = await Flock.acquire("opencode.server", { dir: electionDir, timeoutMs: 30_000 })
      acquired = true
      return "acquired" as const
    })()
    expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
    expect(acquiredAtTerminal).toBe(false)
    expect(await contender).toBe("acquired")
  }, 60_000)
  // Y 序列验证 logical compression 之后才取得 physical reclaim 授权，并复用现有 vacuum owner。
  test("reclaims SQLite pages after interactive compression approval", async () => {
    await using tmp = await tmpdir({
      init: async (root) => {
        await seedColdParts(root, 60)
        // 压缩本身 freelist 可能低于 PROMPT；垫高 freelist 以验证 reclaim 授权路径。
        inflateFreelist(root, 20_000_000)
      },
    })
    const cli = runPty(["db", "compress", "--older-than", "0ms", "--batch-size", "5"], isolatedEnv(tmp.path))
    answerPrompt(cli.proc, "Reclaim", "y")
    // 页面收益使用 pre-status pageSize 与 vacuum page counts，禁止把它伪装成主文件 stat。
    expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
    const output = cli.output()
    expect(output).toContain("of physical database space now? [Y/n]")
    expect(output).toMatch(/Logical compression is complete[\s\S]*SQLite still contains[\s\S]*Reclaiming SQLite pages[\s\S]*Physical reclaim completed[\s\S]*Page allocation[\s\S]*Reclaimed pages/)
    // standalone 保留显式 --yes 与同一 renderer，不复用 compress 的交互授权。
    // reclaim 后 freelist 已空；human vacuum 软跳过，不再假装 Reclaiming。
    const standalone = runPty(["db", "vacuum", "--yes"], isolatedEnv(tmp.path))
    expect(await waitForExit(standalone.proc, standalone.exited)).toBe(0)
    const standaloneOutput = standalone.output()
    expect(standaloneOutput).toContain("No reusable pages to reclaim")
    expect(standaloneOutput).not.toContain("Reclaiming SQLite pages")
    expect(standaloneOutput).not.toContain('"pagesBefore"')
  }, 30_000)
  // 显式 machine 组合必须等两阶段完成后一次性序列化，不能泄漏中间 human/progress 输出。
  // PROMPT 门槛过滤几 KB freelist：小 fixture 压缩后不应出现 reclaim 交互。
  test("skips reclaim prompt when freelist is only noise", async () => {
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

  // status Recommendation 与 reclaim 共用 HINT 门槛，噪声 freelist 不黄字建议 vacuum。
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

  // 定宽进度行：吞吐从非零回到 0 时不应残留上一帧更长的 rate 文本。
  test("progress line clears previous wider rate text", async () => {
    await using tmp = await tmpdir({ init: (root) => seedColdParts(root, 30) })
    const proc = spawnPty(process.execPath, [INDEX_TS, "db", "compress", "--older-than", "0ms", "--batch-size", "1"], {
      ...PTY_OPTIONS,
      cwd: path.dirname(INDEX_TS),
      env: Object.fromEntries(Object.entries(isolatedEnv(tmp.path)).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    })
    let raw = ""
    proc.onData((data) => (raw += data))
    answerPrompt(proc, "Reclaim", "n")
    expect(await waitForExit(proc, new Promise<number>((resolve) => proc.onExit((event) => resolve(event.exitCode))))).toBe(0)
    // 保留 \r 分帧；取最后一帧进度行检查无 MB/s 残影混入 0 B/s 帧。
    const frames = raw.split("\r").filter((frame) => frame.includes("owners") && frame.includes("elapsed"))
    expect(frames.length).toBeGreaterThan(1)
    const last = frames[frames.length - 1]
    expect(last).toMatch(/owners/)
    expect(last).toMatch(/elapsed/)
    // 清行序列应出现在进度写入中。
    expect(raw).toContain("\x1b[K")
  }, 30_000)

  // machine 复合结果在 NOISE 下不得触发物理 VACUUM，pageCount 应保持。
  test("skips SQL vacuum in compress-vacuum JSON when freelist is below noise", async () => {
    await using tmp = await tmpdir({
      init: async (root) => {
        await seedColdParts(root, 6)
        // 100KB 远低于 1MB NOISE，旧实现仍会 vacuum。
        inflateFreelist(root, 100_000)
      },
    })
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


  // 若恢复 2s HTTP status 轮询，挂起的 control GET 会 TimeoutError；reconcile 观察则仍应完成。
  // 本用例伪造 live daemon control：POST 只登记 task，进度只写 durable JSON。
  test("online observe completes while control status hangs during nonterminal work", async () => {
    await using tmp = await tmpdir({ init: (root) => seedColdParts(root, 8) })
    await runCli(tmp.path, ["db", "status", "--json"])
    const { realpath } = await import("fs/promises")
    // realpath 与 CLI Database.getPath 对齐，避免 task.dbPath mismatch 拒读。
    const dbPath = await realpath(path.join(tmp.path, "opencode.db"))
    const token = "hung-status-token"
    const lockPath = path.join(tmp.path, "tui-server.json")
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
          const base = {
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
          await Bun.write(path.join(root, "tasks", `${taskID}.json`), JSON.stringify(base, null, 2))
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
              await Bun.write(path.join(root, "tasks", `${taskID}.json`), JSON.stringify(base, null, 2))
            }
            base.status = "completed"
            base.updatedAt = Date.now()
            await Bun.write(path.join(root, "tasks", `${taskID}.json`), JSON.stringify(base, null, 2))
            // 终态后撤掉 owner，模拟 worker finally 释放 lease，settlement GET 可立即返回。
            await Bun.write(path.join(root, "lock", "owner.json"), JSON.stringify({
              taskID: "dbm_released",
              dbPath,
              pid: 1,
              token: "released",
              startedAt: Date.now(),
            })).catch(() => undefined)
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
      // N 保留“daemon”，强制 online 路径而非 offline lease。
      answerPrompt(cli.proc, "Stop daemon", "n")
      expect(await waitForExit(cli.proc, cli.exited)).toBe(0)
      const output = cli.output()
      expect(output).toMatch(/Continuing through the running daemon[\s\S]*Compression completed/)
      expect(output).not.toMatch(/timed out|TimeoutError/i)
    } finally {
      server.stop(true)
    }
  }, 30_000)

  // dead-owner 经 status --task 公开 seam 触发 reconcile，不得永久 running。
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
