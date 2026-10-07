import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { existsSync, mkdirSync, watch } from "node:fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "node:url"
import * as DaemonModule from "../../../src/cli/cmd/tui/daemon"
import { Effect } from "effect"
import { pollWithTimeout } from "../../lib/effect"

// wrapper 取证合同（S9）：worker 写原生 stderr 后以非零码退出，wrapper 必须留下
// 生命周期记录、退出码记录与有界轮转的错误尾部；print-logs 之外这是崩溃唯一的原生证据。
const win = process.platform === "win32" ? describe : describe.skip

win("daemon wrapper forensics", () => {
  let dir = ""
  afterEach(async () => {
    DaemonModule._setSpawn(undefined)
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    dir = ""
  })

  test("startup evidence failure reaps the worker before rejecting the launch", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-daemon-init-"))
    const diag = path.join(dir, "diag")
    const marker = path.join(dir, "worker-pid")
    const worker = path.join(dir, "worker.js")
    await fs.mkdir(diag)
    await Bun.write(worker, `await Bun.write(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{},1000)`)
    const blocked = Promise.withResolvers<void>() // 先确认冲突真正建立，不能因watch漏事件把正常启动误当作故障回收。
    // launch目录创建先于Add-Type/worker.Start，watch只在本次独占目录放置文件名冲突。
    const watcher = watch(diag, (_event, name) => {
      if (!name) return
      const target = path.join(diag, String(name), "lifecycle.json")
      if (existsSync(target)) return
      mkdirSync(target) // 同步建立障碍，避免异步mkdir排在wrapper写记录之后。
      blocked.resolve()
    })
    const launched = Promise.resolve(
      DaemonModule._spawn([process.execPath, worker], {
        env: { ...process.env, OPENCODE_DAEMON_DIAG_DIR: diag },
      }),
    ).then(
      () => "started",
      () => "rejected",
    )
    try {
      await blocked.promise
      expect(await Promise.race([launched, Bun.sleep(15000).then(() => "pending")])).toBe("rejected")
      // worker可能尚未来得及运行JS；若已经写出身份，启动失败必须已回收它。
      if (await Bun.file(marker).exists()) {
        const pid = Number(await Bun.file(marker).text())
        expect(() => process.kill(pid, 0)).toThrow()
      }
    } finally {
      watcher.close()
      if (await Bun.file(marker).exists()) {
        try {
          process.kill(Number(await Bun.file(marker).text()), "SIGKILL")
        } catch {}
      }
      await launched // 清理后仍结算原启动操作，迟到的拒绝不能逃出测试生命周期。
    }
  }, 30000)

  test("preserves separate crash evidence across launches from the same TUI run", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-daemon-generations-"))
    const diag = path.join(dir, "diag")
    const worker = path.join(dir, "worker.js")
    await Bun.write(worker, "process.stderr.write(process.env.PROBE_TEXT); process.exit(3)")
    // 使用同一个启动者runID和诊断父目录，精确覆盖TUI重连而不是两个独立启动者。
    // 旧证据必须仍可读，不能只证明第二次退出成功。
    for (const marker of ["first-crash", "second-crash"]) {
      const daemon = await DaemonModule._spawn([process.execPath, worker], {
        env: { ...process.env, OPENCODE_RUN_ID: "same-tui", OPENCODE_DAEMON_DIAG_DIR: diag, PROBE_TEXT: marker },
      })
      expect(await daemon.exited).toBe(3)
    }
    const runs = (await fs.readdir(diag, { withFileTypes: true })).filter((entry) => entry.isDirectory()) // 按实际分代目录枚举，不把缓存runID拼成期望路径。
    expect(runs.length).toBe(2)
    const evidence = await Promise.all(
      runs.map(async (entry) => ({
        lifecycle: await Bun.file(path.join(diag, entry.name, "lifecycle.json")).json(),
        tail: await Bun.file(path.join(diag, entry.name, "stderr.b")).text(),
      })),
    )
    expect(evidence.map((entry) => entry.tail).sort()).toEqual(["first-crash", "second-crash"]) // 文件系统枚举顺序无合同，内容集合才是保留证据。
    expect(evidence.every((entry) => entry.lifecycle.runID === "same-tui")).toBe(true)
    expect(new Set(evidence.map((entry) => entry.lifecycle.launchID)).size).toBe(2)
  }, 30000)

  test.each(["rotation", "exit record"])(
    "%s I/O failure stays visible while the worker stderr continues draining",
    async (phase) => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-daemon-io-"))
      const worker = path.join(dir, "worker.js")
      const launcher = path.join(dir, "launcher.ts")
      const marker = path.join(dir, "write-completed")
      const ready = path.join(dir, "launcher-ready") // 只在握手完成后破坏终态文件，区别于上面的启动失败路径。
      await Bun.write(
        worker,
        `
      const fs = require('node:fs/promises');
      while (!await Bun.file(${JSON.stringify(ready)}).exists()) await Bun.sleep(10);
      // 删除已发布记录再放置目录，确保失败发生在退出更新而非首次身份发布。
      const target = require('node:path').join(process.env.OPENCODE_DAEMON_DIAG_DIR, ${JSON.stringify(phase === "rotation" ? "stderr.a" : "lifecycle.json")});
      if (${JSON.stringify(phase)} === 'exit record') await fs.unlink(target);
      await fs.mkdir(target);
      await new Promise(resolve => process.stderr.write(Buffer.alloc(3 * 1024 * 1024, 88), resolve));
      // 仅在写回调之后发布marker，排除数据还留在worker用户态队列的假完成。
      await Bun.write(${JSON.stringify(marker)}, 'drained'); process.exit(3);
    `,
      )
      // 用真实launcher子进程捕获其stderr，重现ensure默认传入ignore的配置。
      // 轮转目标目录冲突只污染本夹具，不需要填满真实磁盘，也不依赖随机I/O故障。
      const module = fileURLToPath(new URL("../../../src/cli/cmd/tui/daemon.ts", import.meta.url))
      await Bun.write(
        launcher,
        `
      const D = await import(${JSON.stringify(module)});
      const d = await D._spawn([process.execPath, ${JSON.stringify(worker)}], { env: process.env, stderr: 'ignore' });
      await Bun.write(${JSON.stringify(ready)}, 'ready');
      const timer = setTimeout(() => { d.kill(); process.exit(124) }, 10000);
      try { console.log(JSON.stringify({ exit: await d.exited })) } finally { clearTimeout(timer) }
    `,
      )
      const proc = Bun.spawn([process.execPath, launcher], {
        env: { ...process.env, OPENCODE_DAEMON_DIAG_DIR: path.join(dir, "diag") },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      try {
        const result = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        expect(result[0]).toBe(0) // launcher自身成功只证明监督完成，不能替代下一条worker状态断言。
        expect(JSON.parse(result[1]).exit).toBe(3) // 诊断失败不可把业务退出码覆盖为PowerShell自身的1。
        expect(await Bun.file(marker).text()).toBe("drained")
        expect(result[2]).toContain("diagnostic unavailable") // 与worker持续产出同时成立，防止吞错误换取假绿。
      } finally {
        proc.kill()
      }
    },
    30000,
  )

  test.each([false, true])(
    "a descendant holding stdout cannot keep the wrapper alive after worker exit (writing=%s)",
    async (writing) => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-daemon-tail-"))
      const worker = path.join(dir, "worker.ps1")
      const childFile = path.join(dir, "child.js")
      const marker = path.join(dir, "child-pid")
      const diag = path.join(dir, "diag")
      // 静默持有者验证EOF截止，持续写入者同时覆盖CopyToAsync与Finish的并发收尾。
      await Bun.write(
        childFile,
        writing ? "setInterval(()=>process.stderr.write('late-bytes'), 10)" : "setInterval(()=>{},1000)",
      )
      const literal = (value: string) => `'${value.replaceAll("'", "''")}'` // 临时目录可能含引号，路径始终作为PowerShell数据字面量。
      await Bun.write(
        worker,
        `$child = Start-Process -NoNewWindow -PassThru -FilePath ${literal(process.execPath)} -ArgumentList ${literal(childFile)}\n[IO.File]::WriteAllText(${literal(marker)}, [string]$child.Id)\n[Environment]::Exit(6)`,
      )
      const powershell = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
      const daemon = await DaemonModule._spawn([powershell, worker], {
        env: { ...process.env, OPENCODE_DAEMON_DIAG_DIR: diag },
      })
      try {
        const runs = await fs.readdir(diag)
        // 先观察worker退出记录，再对尾部结算设护栏，慢机启动PS/后台child不占五秒窗口。
        await Effect.runPromise(
          pollWithTimeout(
            Effect.promise(async () => {
              const life = await Bun.file(path.join(diag, runs[0], "lifecycle.json"))
                .json()
                .catch(() => undefined)
              return life?.workerExitCode === 6 ? true : undefined
            }),
            "worker did not publish exit",
            "20 seconds",
          ),
        )
        const result = await Promise.race([daemon.exited, Bun.sleep(5000).then(() => "pending")])
        const state = await Bun.file(path.join(diag, runs[0], "stderr.state.json")).json()
        expect(state.tailTruncated).toBe(true)
        expect(state.diagnosticUnavailable).toBe(false) // 正常截止不应被FileStream并发Dispose误报为落盘失败。
        expect(result).toBe(6)
      } finally {
        const child = Number(await Bun.file(marker).text())
        try {
          process.kill(child, "SIGKILL") // 仅fixture负责清理故意保留的后台进程，生产截止不以杀后代制造EOF。
        } catch {}
        await daemon.exited
      }
    },
    60000,
  )

  test("print-logs also persists the native stderr evidence", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-daemon-print-"))
    const worker = path.join(dir, "worker.js")
    const diag = path.join(dir, "diag")
    await Bun.write(worker, "process.stderr.write('native-evidence'); process.exit(7)")
    // 终端可见性不能替代持久化；终端关闭后仍需能从本次launch目录读取同一字节。
    const daemon = await DaemonModule._spawn([process.execPath, worker], {
      env: { ...process.env, OPENCODE_PRINT_LOGS: "1", OPENCODE_DAEMON_DIAG_DIR: diag },
    })
    expect(await daemon.exited).toBe(7)
    const launches = await fs.readdir(diag)
    expect(launches.length).toBe(1)
    expect(await Bun.file(path.join(diag, launches[0], "stderr.b")).text()).toBe("native-evidence") // 检查内容而非仅文件存在，避免空文件伪装tee成功。
  }, 30000)

  test("normal wrapper exit preserves every byte of large forwarded stdout", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-daemon-stdout-"))
    const payload = path.join(dir, "payload.bin")
    const worker = path.join(dir, "worker.js")
    const launcher = path.join(dir, "launcher.ts")
    // 包含零字节和非UTF8字节，长度相同仍无法掩盖解码、重复或截断。
    const expected = Buffer.alloc(3 * 1024 * 1024)
    for (let i = 0; i < expected.length; i++) expected[i] = i % 251 // 周期与64KiB互素，整帧重复或错序也会改变期望字节。
    await Bun.write(payload, expected)
    await Bun.write(
      worker,
      `process.stdout.write(require('fs').readFileSync(${JSON.stringify(payload)}), () => process.exit(7))`,
    )
    const module = fileURLToPath(new URL("../../../src/cli/cmd/tui/daemon.ts", import.meta.url))
    await Bun.write(
      launcher,
      `
      const D = await import(${JSON.stringify(module)});
      const d = await D._spawn([process.execPath, ${JSON.stringify(worker)}], {env:process.env, stdout:'inherit'});
      process.exitCode = await d.exited;
    `,
    )
    const proc = Bun.spawn([process.execPath, launcher], {
      env: { ...process.env, OPENCODE_PRINT_LOGS: "1", OPENCODE_DAEMON_DIAG_DIR: path.join(dir, "diag") },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    try {
      const [code, bytes, error] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).arrayBuffer(), // 不经过文本解码，否则非法UTF8会在测试自身被替换。
        new Response(proc.stderr).text(),
      ])
      expect(code).toBe(7)
      expect(Buffer.from(bytes).equals(expected)).toBe(true)
      // 正常排空必须走EOF，不靠截止截断取得退出码。
      expect(error).not.toContain("tail cutoff")
    } finally {
      proc.kill()
    }
  }, 60000)

  test("persists lifecycle, exit code and a bounded rotated stderr tail", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-daemon-diag-"))
    const diag = path.join(dir, "diag")
    const worker = path.join(dir, "worker.js")
    // 3MiB 超过单段 1MiB 上限，必定触发轮转；退出码 3 验证非零终态落盘。
    await Bun.write(
      worker,
      `await new Promise(resolve => process.stderr.write(Buffer.alloc(3145728, 88), resolve)); process.exit(3)`,
    )

    const daemon = await DaemonModule._spawn([process.execPath, worker], {
      env: { ...process.env, OPENCODE_DAEMON_DIAG_DIR: diag } as Record<string, string>,
    })
    const exitCode = await daemon.exited
    expect(exitCode).toBe(3)
    const launches = await fs.readdir(diag)
    expect(launches.length).toBe(1)
    const run = path.join(diag, launches[0])
    const lifecycle = (await Bun.file(path.join(run, "lifecycle.json")).json()) as {
      workerPID?: number
      workerExitCode?: number
      workerExitHex?: string
    }
    expect(lifecycle.workerPID).toBe(daemon.pid)
    expect(lifecycle.workerExitCode).toBe(3)
    expect(lifecycle.workerExitHex).toBe("00000003") // 固定位型表示保留原生异常码的可比较形式。

    const tail = await fs.stat(path.join(run, "stderr.b"))
    const previous = await fs.stat(path.join(run, "stderr.a"))
    // 两段各不超 1MiB；前段存在即轮转发生；总量有界，磁盘占用不随 worker 噪音增长。
    expect(tail.size).toBeLessThanOrEqual(1024 * 1024)
    expect(previous.size).toBeLessThanOrEqual(1024 * 1024)
    // 最后两段各是完整1MiB的X，严格比对能捕获轮转只建文件却漏写尾部的问题。
    expect(Buffer.from(await Bun.file(path.join(run, "stderr.a")).arrayBuffer())).toEqual(Buffer.alloc(1024 * 1024, 88))
    expect(Buffer.from(await Bun.file(path.join(run, "stderr.b")).arrayBuffer())).toEqual(Buffer.alloc(1024 * 1024, 88))
    const state = (await Bun.file(path.join(run, "stderr.state.json")).json()) as { tailTruncated?: boolean }
    expect(state.tailTruncated).toBe(true)
  }, 60000)
})
