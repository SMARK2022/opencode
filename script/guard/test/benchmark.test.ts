import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import {
  judge,
  signedRankP,
  runOnce,
  startRssSampler,
  validateRounds,
  type Sample,
  type Target,
} from "../bench/harness"
import { measure, expectScaleInvariant } from "../budget"
import { assertReply } from "../bench/protocol"
import { isCompleteBench, renderBenchMarkdown, type BenchResult } from "../report"
import { SCENARIO_BUDGETS } from "../bench/budgets"

function sample(values: Partial<Sample> = {}): Sample {
  return {
    startupMs: 10,
    wallMs: 10,
    cpuMs: 1,
    maxBlockMs: 1,
    p50Ms: 1,
    p95Ms: 1,
    p99Ms: 1,
    probeErrorRate: 0,
    maxOutageMs: 0,
    peakRssMb: 10,
    rssGrowthMb: 0,
    crashed: 0,
    ...values,
  }
}

const samples = (values: Partial<Sample> = {}) => Array.from({ length: 5 }, () => sample(values))
const budget = [{ metric: "wallMs" as const, maxRatio: 0.1, minAbs: 1 }]

describe("基准必须完成有效的 A/B 测量", () => {
  test("HTTP 200 也必须带有效回复，abort 必须真的取消", () => {
    expect(() => assertReply({ info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] })).not.toThrow()
    expect(() => assertReply({ info: { role: "assistant", error: { name: "APIError" } }, parts: [] })).toThrow(
      "模型错误",
    )
    expect(() => assertReply({ info: { role: "assistant" }, parts: [] })).toThrow("正文")
    expect(() =>
      assertReply({ info: { role: "assistant", error: { name: "MessageAbortedError" } }, parts: [] }, true),
    ).not.toThrow()
    expect(() => assertReply({ info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] }, true)).toThrow(
      "未产生",
    )
  })
  test("正常数据通过，持续退化与任意一次 head 崩溃失败", () => {
    expect(judge(samples(), samples(), budget).some((v) => v.regressed)).toBe(false)
    expect(judge(samples({ wallMs: 100 }), samples(), budget)[0].regressed).toBe(true)
    const head = samples()
    head[0].crashed = 1
    expect(judge(head, samples(), budget).find((v) => v.metric === "crashed")?.regressed).toBe(true)
  })

  test("空样本、两组数量不同、非有限或不合法的指标均拒绝", () => {
    expect(() => judge([], [], budget)).toThrow("轮数")
    expect(() => judge(samples(), samples().slice(1), budget)).toThrow("样本数")
    for (const invalid of [
      { wallMs: NaN },
      { peakRssMb: Infinity },
      { cpuMs: -1 },
      { probeErrorRate: 1.1 },
      { crashed: 0.5 },
    ])
      expect(() => judge(samples(invalid), samples(), budget)).toThrow("指标无效")
  })

  test("HTTP/场景失败与 base 崩溃不会成为无退化", () => {
    expect(() =>
      judge(
        samples().map((s) => ({ ...s, error: "HTTP 500" })),
        samples(),
        budget,
      ),
    ).toThrow("未完成")
    expect(() =>
      judge(
        samples().map((s) => ({ ...s, error: "" })),
        samples(),
        budget,
      ),
    ).toThrow("未完成")
    expect(() => judge(samples(), samples({ crashed: 1 }), budget)).toThrow("base")
    expect(() =>
      judge(
        samples(),
        samples().map((s) => ({ ...s, error: "seed failed" })),
        budget,
      ),
    ).toThrow("base")
  })

  test("空预算、重复指标和无效阈值拒绝", () => {
    expect(() => judge(samples(), samples(), [])).toThrow("非空")
    expect(() => judge(samples(), samples(), [...budget, ...budget])).toThrow("唯一")
    expect(() => judge(samples(), samples(), [{ ...budget[0], minAbs: NaN }])).toThrow("预算")
    expect(() => judge(samples(), samples(), [{ ...budget[0], maxRatio: -1 }])).toThrow("预算")
  })

  test("配对检验：零差剔除、并列平均秩、单侧精确概率", () => {
    expect(signedRankP([1, 1], [1, 1])).toBe(1)
    expect(signedRankP([1, 1], [1, 0])).toBe(0.5)
    expect(signedRankP([3, 4], [1, 2])).toBe(0.25)
    expect(signedRankP([3, 2], [2, 3])).toBe(0.75)
  })

  test("负内存增量仍按变差方向比较，失败率保留小数精度", () => {
    const memory = [{ metric: "rssGrowthMb" as const, maxRatio: 0.5, minAbs: 15 }]
    expect(judge(samples({ rssGrowthMb: -20 }), samples({ rssGrowthMb: -100 }), memory)[0].regressed).toBe(true)
    expect(judge(samples({ rssGrowthMb: -120 }), samples({ rssGrowthMb: -100 }), memory)[0].regressed).toBe(false)
    const failure = judge(samples({ probeErrorRate: 0.02 }), samples(), [
      { metric: "probeErrorRate", maxRatio: 0, minAbs: 0.005 },
    ])[0]
    expect(failure.regressed).toBe(true)
    expect(failure.head).toBe(0.02)
  })

  test("轮数与场景参数错误在启动被测应用前返回 2", () => {
    for (const rounds of [0, 4, NaN, 4.5, 51]) expect(() => validateRounds(rounds)).toThrow("轮数")
    expect(() => validateRounds(5)).not.toThrow()
    for (const args of [
      ["--rounds", "0"],
      ["--rounds", "NaN"],
      ["--only", "typo"],
      ["--only", ","],
      ["--group", "typo"],
      ["--group", "basic", "--only", "list"],
      ["--sessions", "0"],
      ["--head", `missing-${crypto.randomUUID()}`],
    ]) {
      const result = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "../bench/opencode.ts"), ...args])
      expect(result.exitCode).toBe(2)
      expect(result.stderr.toString()).toContain("[bench]")
    }
  })
})

test("实际场景失败、超时和信号退出均失败并释放进程", async () => {
  for (const mode of ["failure", "timeout", "crash"]) {
    let proc: Bun.Subprocess | undefined
    const target: Target = {
      label: "fixture",
      healthPath: "/health",
      start: () => {
        proc = Bun.spawn([process.execPath, "-e", `const s = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("ok")}); console.log("opencode server listening on http://127.0.0.1:"+s.port)`], {
          stdout: "pipe",
          stderr: "inherit",
        })
        return proc
      },
    }
    const result = await runOnce(
      target,
      async () => {
        if (mode === "timeout") return new Promise<void>(() => {})
        if (mode === "crash") {
          proc?.kill()
          await proc?.exited
          return
        }
        throw new Error("scenario failed")
      },
      50,
      { rssMb: async () => 1, cpuMs: async () => 0 },
    )
    expect(result.error).toContain(mode === "timeout" ? "超过" : mode === "crash" ? "退出" : "scenario failed")
    expect(result.crashed).toBe(mode === "crash" ? 1 : 0)
    expect(proc?.exitCode !== null || proc?.signalCode !== null).toBe(true)
  }
}, 10_000)

test("进程采样失败阻断测量并关闭被测进程", async () => {
  let proc: Bun.Subprocess | undefined
  await expect(
    runOnce(
      {
        label: "unavailable metrics",
        healthPath: "/health",
        start: () => {
          proc = Bun.spawn([process.execPath, "-e", `const s = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("ok")}); console.log("opencode server listening on http://127.0.0.1:"+s.port)`], {
            stdout: "pipe",
            stderr: "inherit",
          })
          return proc
        },
      },
      async () => {},
      50,
      {
        rssMb: async () => {
          throw new Error("RSS unavailable")
        },
        cpuMs: async () => 0,
      },
    ),
  ).rejects.toThrow("RSS unavailable")
  expect(proc?.exitCode !== null || proc?.signalCode !== null).toBe(true)
})

test("RSS 采样串行执行，停止等待在途读取并传播采样失败", async () => {
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  let active = 0
  let maximum = 0
  const stop = startRssSampler(1, 0, async () => {
    calls++
    maximum = Math.max(maximum, ++active)
    if (calls === 2) {
      ready.resolve()
      await release.promise
    }
    active--
    return calls
  })
  await ready.promise
  const stopping = stop()
  release.resolve()
  expect(await stopping).toBe(2)
  expect(await stop()).toBe(2)
  expect(calls).toBe(2)
  expect(maximum).toBe(1)
  const failed = startRssSampler(1, 0, async () => {
    throw new Error("probe failed")
  })
  await expect(failed()).rejects.toThrow("probe failed")
})

describe("SQL 预算计量", () => {
  test("迭代器按实际消费行计量，字节采用 UTF-8", async () => {
    using db = new Database(":memory:")
    db.run("CREATE TABLE items (value TEXT)")
    db.query("INSERT INTO items VALUES (?)").run("中文")
    db.query("INSERT INTO items VALUES (?)").run("long")
    const all = await measure(() => db.query("SELECT * FROM items").all())
    const iterator = await measure(() => [...db.query("SELECT * FROM items").iterate()])
    expect(iterator.statements).toBe(1)
    expect(iterator.rowsRead).toBe(2)
    expect(iterator.bytesRead).toBe(all.bytesRead)
    expect(iterator.bytesRead).toBe(
      Buffer.byteLength(JSON.stringify({ value: "中文" })) + Buffer.byteLength(JSON.stringify({ value: "long" })),
    )
    const partial = await measure(() => {
      for (const row of db.query("SELECT * FROM items").iterate()) return row
    })
    expect(partial.rowsRead).toBe(1)
    expect((await measure(() => db.run("SELECT 1"))).statements).toBe(1)
    expect((await measure(() => db.exec("SELECT 1"))).statements).toBe(1)
  })

  test("并发测量相互隔离，嵌套测量结束后恢复父计数", async () => {
    using db = new Database(":memory:")
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = measure(async () => {
      db.query("SELECT 1").get()
      ready.resolve()
      await release.promise
      db.query("SELECT 2").get()
    })
    await ready.promise
    const second = await measure(() => db.query("SELECT 3").get())
    release.resolve()
    expect((await first).statements).toBe(2)
    expect(second.statements).toBe(1)
    const outer = await measure(async () => {
      db.query("SELECT 1").get()
      expect((await measure(() => db.query("SELECT 2").get())).statements).toBe(1)
      db.query("SELECT 3").get()
    })
    expect(outer.statements).toBe(2)
  })

  test("流式读取全部数据会触发规模预算，LIMIT 查询通过", async () => {
    using db = new Database(":memory:")
    db.run("CREATE TABLE items (value TEXT)")
    const seed = (n: number) => {
      db.run("DELETE FROM items")
      for (let i = 0; i < n; i++) db.query("INSERT INTO items VALUES (?)").run("row")
    }
    await expect(
      expectScaleInvariant(seed, () => [...db.query("SELECT * FROM items").iterate()], { n: 3, maxGrowth: 2 }),
    ).rejects.toThrow("读取量增长")
    const limited = await expectScaleInvariant(seed, () => [...db.query("SELECT * FROM items LIMIT 2").iterate()], {
      n: 3,
      maxGrowth: 2,
    })
    expect(limited.small.bytesRead).toBe(limited.large.bytesRead)
    await expect(expectScaleInvariant(seed, () => undefined, { n: 3, maxGrowth: 2 })).rejects.toThrow("未观察到 SQL")
  })
})

describe("基准报告的完成状态", () => {
  const result = (): BenchResult => ({
    kind: "bench",
    head: { sha: "head", date: "", subject: "head" },
    base: { sha: "base", date: "", subject: "base" },
    rounds: 5,
    createdAt: "",
    runner: { os: "linux", cpus: 1, ci: false },
    scenarios: {},
    regressed: false,
  })

  test("空结果和旧的场景错误不会显示为成功", () => {
    expect(renderBenchMarkdown(result())).toContain("没有完成任何基准场景")
    const failed = result()
    failed.scenarios.list = {
      verdict: judge(samples(), samples(), budget),
      headMedians: {},
      baseMedians: {},
      errors: ["HTTP 500"],
    }
    expect(renderBenchMarkdown(failed)).toContain("未完成：HTTP 500")
    failed.scenarios.list.errors = []
    expect(renderBenchMarkdown(failed, "failure")).toContain("基准任务状态：failure")
  })

  test("看板复用只接受完整指标和成功场景", () => {
    const value = {
      scenarios: Object.fromEntries(
        Object.keys(SCENARIO_BUDGETS).map((name) => [
          name,
          {
            head: { ...sample(), ...Object.fromEntries(SCENARIO_BUDGETS[name].map((b) => [b.metric, 0])) },
            base: { ...sample(), ...Object.fromEntries(SCENARIO_BUDGETS[name].map((b) => [b.metric, 0])) },
            regressed: [] as string[],
          },
        ]),
      ),
    }
    expect(isCompleteBench(value)).toBe(true)
    const { tui, ...measured } = value.scenarios
    const partial = { scenarios: measured, unavailable: { tui: "base 缺少 TUI 驱动接口" } }
    expect(isCompleteBench(partial)).toBe(true)
    expect(isCompleteBench({ scenarios: measured })).toBe(false)
    expect(isCompleteBench({ ...partial, unavailable: { tui: "" } })).toBe(false)
    expect(isCompleteBench({ ...partial, scenarios: { ...measured, tui } })).toBe(false)
    expect(isCompleteBench({ ...partial, error: "head 失败" })).toBe(false)
    expect(isCompleteBench({ scenarios: {} })).toBe(false)
    expect(isCompleteBench({ scenarios: { list: value.scenarios.list } })).toBe(false)
    expect(isCompleteBench({ ...value, error: "failed" })).toBe(false)
    expect(isCompleteBench({ scenarios: { list: { head: {}, base: {}, regressed: [] } } })).toBe(false)
    value.scenarios.list.head.probeErrorRate = 2
    expect(isCompleteBench(value)).toBe(false)
    value.scenarios.list.head.probeErrorRate = 0
    value.scenarios.list.base.crashed = 1
    expect(isCompleteBench(value)).toBe(false)
    value.scenarios.list.base.crashed = 0
    value.scenarios.list.regressed.push("crashed")
    expect(isCompleteBench(value)).toBe(false)
  })

  test("缺失失败任务的 artifact 与明确跳过分别显示", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "guard-bench-report-"))
    try {
      for (const status of ["failure", "cancelled", "skipped"]) {
        const file = path.join(dir, status + ".md")
        const command = Bun.spawnSync([
          process.execPath,
          path.join(import.meta.dir, "../report.ts"),
          "comment",
          "--bench",
          path.join(dir, "missing.json"),
          "--bench-status",
          status,
          "--out",
          file,
        ])
        expect(command.exitCode).toBe(0)
        const text = await Bun.file(file).text()
        expect(text).toContain(status === "skipped" ? "未运行" : "基准结果缺失")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
