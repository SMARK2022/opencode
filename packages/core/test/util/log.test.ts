import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { _cleanup } from "@opencode-ai/core/util/log"

// daemon-native 诊断目录的保留治理：活跃目录随进程寿命保留；完成目录保留最新10个或24h窗口；
// start-only 且进程已死且超窗的目录是 wrapper 夭折残留，必须可回收。
const DAY = 24 * 60 * 60 * 1000

describe("log cleanup daemon-native retention", () => {
  let dir = ""
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  async function runDir(
    name: string,
    opts: { lifecyclePid?: number; wrapperPid?: number; exit?: boolean; ageMs?: number },
  ) {
    const full = path.join(dir, "daemon-native", name)
    await fs.mkdir(full, { recursive: true })
    if (opts.lifecyclePid !== undefined || opts.wrapperPid !== undefined || opts.exit) {
      const time = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString()
      await Bun.file(path.join(full, "lifecycle.json")).write(
        JSON.stringify({
          workerPID: opts.lifecyclePid,
          wrapperPID: opts.wrapperPid,
          startedAt: time,
          ...(opts.exit ? { exitedAt: time, workerExitCode: 0 } : {}),
        }),
      )
    }
    if (opts.ageMs) {
      const past = new Date(Date.now() - opts.ageMs) // 回拨真实mtime而不等待24小时，机器速度不参与保留策略断言。
      for (const file of await fs.readdir(full)) await fs.utimes(path.join(full, file), past, past)
      await fs.utimes(full, past, past) // 尚无记录的目录以自身年龄保护初始化中间态。
    }
    return full
  }

  test("keeps active and fresh directories, reaps stale residue", async () => {
    // 活跃：进程存活，即使证据文件超窗也保留。
    const active = await runDir("active", { lifecyclePid: process.pid, ageMs: 2 * DAY })
    // worker已经死去但supervisor仍在收尾时，不能仅凭worker PID回收证据。
    const wrapping = await runDir("wrapping", {
      lifecyclePid: 4_000_000_000,
      wrapperPid: process.pid,
      exit: true,
      ageMs: 2 * DAY,
    })
    // 完成且新鲜：窗口内保留。
    const freshDone = await runDir("fresh-done", { exit: true })
    // start-only 且进程已死且超窗：删除。
    const stale = await runDir("stale", { lifecyclePid: 4_000_000_000, ageMs: 2 * DAY })
    // 刚建目录可能还在编译wrapper，缺少记录不等于已死；无记录残留也须跨过保留窗。
    const empty = await runDir("empty", { ageMs: 2 * DAY })
    const initializing = await runDir("initializing", {})
    const partial = await runDir("partial", { lifecyclePid: process.pid, ageMs: 2 * DAY })
    // 生命周期更新使用WriteAllText；读到截断中的JSON不能等价为owner已经死亡。
    await Bun.write(path.join(partial, "lifecycle.json"), '{"workerPID":')

    await _cleanup(dir)

    expect(await Bun.file(path.join(active, "lifecycle.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(wrapping, "lifecycle.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(freshDone, "lifecycle.json")).exists()).toBe(true)
    expect((await fs.stat(initializing)).isDirectory()).toBe(true)
    expect(await Bun.file(path.join(partial, "lifecycle.json")).exists()).toBe(true)
    expect(await fs.stat(stale).catch(() => undefined)).toBe(undefined)
    expect(await fs.stat(empty).catch(() => undefined)).toBe(undefined)
  })

  test("completed directories are bounded to the newest ten beyond the window", async () => {
    // 12 个完成目录全部超窗：只保留 mtime 最新的 10 个。
    for (let i = 0; i < 12; i++) {
      await runDir(`done-${String(i).padStart(2, "0")}`, { exit: true, ageMs: 2 * DAY + i * 60_000 }) // 年龄差超过mtime精度，排序不依赖目录枚举次序。
    }
    await _cleanup(dir)
    const remaining = await fs.readdir(path.join(dir, "daemon-native"))
    expect(remaining.length).toBe(10)
    // 最旧的两个（age 最大）必须被回收。
    expect(remaining).not.toContain("done-11") // 名字越大反而越旧，不能误用名称排序代替证据时间。
    expect(remaining).not.toContain("done-10")
  })
})
