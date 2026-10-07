import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { WindowsShellOutput } from "@opencode-ai/core/windows-shell-output"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// 原生捕获隔离前的实测崩溃负载：Bun 1.3.14 在 1531 次调用后于共享进程内段错误（exit 3）。
// 隔离后故障域是单次调用独占的宿主进程；本测试以固定次数复跑同级负载，
// 父进程（本测试进程）必须保持到正常终态——父进程死亡即回归。
//
// 本测试由 OPENCODE_STRESS 环境变量门控：主套件与主 CI 路线默认跳过（瞬时，零负担）。
// bun 即使显式传路径也只运行 .test 后缀文件，改名排除法不可用；skip 门控是
// 不污染默认报告且可显式执行的唯一形态。运行入口：
//   test.yml 的必过压力分支 core-stress-windows（500 次，job 10 分钟硬上限）
//   手动：OPENCODE_STRESS=1 bun test test/stress/windows-shell-output-stress.test.ts
// 断言只关心稳定性/正确性（固定次数全部完成、退出码为 0、父进程存活），不做任何
// benchmark 式性能断言——线上 CI 主机性能不稳定，吞吐只记录在 plan §23 作参考。
const ROUNDS = Number(process.env.OPENCODE_STRESS_ROUNDS ?? 1)
const PER_ROUND = Number(process.env.OPENCODE_STRESS_COUNT ?? 400)
// 固定有界并发避免命令风暴本身耗尽弱CI主机资源；吞吐不参与通过判定。
const CONCURRENCY = Number(process.env.OPENCODE_STRESS_CONCURRENCY ?? 8)

const win = process.platform === "win32" && process.env.OPENCODE_STRESS ? test : test.skip

win(
  "PowerShell capture storm preserves both streams and releases interrupted scopes",
  async () => {
    // 配置错误必须红标，不能因零轮次、NaN或零并发而空跑通过。
    for (const count of [ROUNDS, PER_ROUND, CONCURRENCY]) {
      expect(Number.isSafeInteger(count) && count > 0).toBe(true)
    }
    await Effect.runPromise(
      Effect.forEach(
        // 固定次数覆盖反复取得和释放宿主资源；单个长期命令循环输出不能替代这条路径。
        Array.from({ length: ROUNDS * PER_ROUND }, (_, i) => i),
        (index) =>
          Effect.gen(function* () {
            const partial = index % 16 === 0 // 固定分布保留可复现的取消占比，不依赖随机调度抽样。
            const pid = yield* Effect.scoped(
              Effect.gen(function* () {
                // 使用原始PowerShell入口；超过64KiB的双流迫使真实背压和多帧结算参与。
                // 完整调用显式exit 0，输出断言独立于退出码，锁定“成功退出却缺字节”的红信号。
                const handle = yield* WindowsShellOutput.mark(
                  ChildProcess.make(
                    "powershell.exe",
                    [
                      "-NoProfile", // 用户profile不能向压力负载插入额外命令或交互等待。
                      "-NonInteractive",
                      "-Command",
                      partial
                        ? "[Console]::Out.Write('ready'); Start-Sleep -Seconds 300"
                        : `[Console]::Out.Write('out-${index}:' + ('O' * 65537)); [Console]::Error.Write('err-${index}:' + ('E' * 65537)); exit 0`,
                    ],
                    { stdin: "ignore" },
                  ),
                )
                if (partial) {
                  // 先观察真实产出再离开scope，保留stderr pending read的取消回收压力。
                  yield* Stream.runCollect(handle.stdout.pipe(Stream.take(1)))
                  return handle.pid
                }
                const bytes = yield* Effect.all(
                  [handle.stdout, handle.stderr].map((stream) =>
                    Stream.runCollect(stream).pipe(Effect.map((chunks) => Buffer.concat(chunks))),
                  ),
                  { concurrency: "unbounded" }, // 这里只并发两条流；串行读取会让另一条pipe背压制造假死锁。
                )
                // 期望由固定载荷独立构造，不能用actual长度反推，否则会掩盖已复现的256字节缺失。
                // ASCII载荷在PowerShell与Node侧字节一致，避免把控制台编码差异当作捕获缺失。
                const expected = [
                  Buffer.from(`out-${index}:` + "O".repeat(65537)),
                  Buffer.from(`err-${index}:` + "E".repeat(65537)),
                ]
                if (bytes.some((value, i) => !value.equals(expected[i]))) {
                  // 只在失败时保存完整字节；Bun的截断diff不能作为实际缺失长度的证据。
                  // 每次失败独占目录，并发命令的产物不能互相覆盖。
                  const dir = yield* Effect.promise(() =>
                    fs.mkdtemp(path.join(os.tmpdir(), "opencode-stress-failure-")),
                  )
                  // 两条流都保存后再断言，stdout先失败时仍能检查stderr的影响范围。
                  yield* Effect.promise(() =>
                    Promise.all(
                      bytes.flatMap((value, i) => [
                        Bun.write(path.join(dir, `actual-${i}.bin`), value),
                        Bun.write(path.join(dir, `expected-${i}.bin`), expected[i]),
                      ]),
                    ),
                  )
                  console.error(
                    JSON.stringify({
                      index,
                      rootPID: Number(handle.pid),
                      actual: bytes.map((value) => value.length),
                      expected: expected.map((value) => value.length),
                      dir,
                    }),
                  )
                  // 诊断目录保留用于事后归因；真实命令的回收仍由外层scope负责。
                }
                expect(bytes[0]).toEqual(expected[0])
                expect(bytes[1]).toEqual(expected[1]) // 每次唯一前缀同时检查并发调用之间的串线。
                // EOF由completed屏障交付，不能以root-exit=0替代完整执行成功。
                expect(Number(yield* handle.exitCode)).toBe(0)
                return handle.pid
              }),
            )
            // scope release返回即交还进程所有权；提前消费结束不能遗留命令树。
            expect(() => process.kill(Number(pid), 0)).toThrow()
          }),
        { concurrency: CONCURRENCY, discard: true }, // 断言在每个scope中完成，不积存数百份大输出影响压力对象。
      ).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)),
    )
  },
  // 固定五分钟仅作挂起护栏，CI job的十分钟总上限另覆盖安装，不断言吞吐或每次耗时。
  300_000,
)
