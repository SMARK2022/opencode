import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Process } from "@/util/process"
import { tmpdir } from "../fixture/fixture"

function node(script: string) {
  return [process.execPath, "-e", script]
}

function isProcessRunning(pid: number) {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function remainsRunningAfter(pid: number, timeout: number) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (!isProcessRunning(pid)) return false
    // Windows 的进程表可见性有短暂延迟；短轮询比固定 sleep 更能避免 CI 抖动。
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return isProcessRunning(pid)
}

describe("util.process", () => {
  test("captures stdout and stderr", async () => {
    const out = await Process.run(node('process.stdout.write("out");process.stderr.write("err")'))
    expect(out.code).toBe(0)
    expect(out.stdout.toString()).toBe("out")
    expect(out.stderr.toString()).toBe("err")
  })

  test("returns code when nothrow is enabled", async () => {
    const out = await Process.run(node("process.exit(7)"), { nothrow: true })
    expect(out.code).toBe(7)
  })

  test("throws RunFailedError on non-zero exit", async () => {
    const err = await Process.run(node('process.stderr.write("bad");process.exit(3)')).catch((error) => error)
    expect(err).toBeInstanceOf(Process.RunFailedError)
    if (!(err instanceof Process.RunFailedError)) throw err
    expect(err.code).toBe(3)
    expect(err.stderr.toString()).toBe("bad")
  })

  test("aborts a running process", async () => {
    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 25)

    const out = await Process.run(node("setInterval(() => {}, 1000)"), {
      abort: abort.signal,
      nothrow: true,
    })

    expect(out.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 3000)

  test("aborts a Windows process tree before resolving", async () => {
    if (process.platform !== "win32") return

    const nodePath = Bun.which("node")
    if (!nodePath) return

    const abort = new AbortController()
    const proc = Process.spawn(
      [
        nodePath,
        "-e",
        [
          'const { spawn } = require("child_process")',
          // detached 子进程模拟浏览器/daemon：父进程退出后仍可能留在前台或继续占用资源。
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })',
          "child.unref()",
          // 输出 pid 不是实现细节断言，而是为了在 abort 返回后观察真实 OS 子进程是否已被清理。
          "console.log(child.pid)",
          "setInterval(() => {}, 1000)",
        ].join(";"),
      ],
      { abort: abort.signal, stdout: "pipe", stderr: "pipe" },
    )

    if (!proc.stdout || !proc.stderr) throw new Error("Process output not available")
    proc.stderr.resume()

    let childPid = 0
    try {
      childPid = await new Promise<number>((resolve, reject) => {
        let stdout = ""
        const timer = setTimeout(() => reject(new Error("child pid was not printed")), 1_000)
        proc.stdout!.on("data", (chunk) => {
          stdout += chunk.toString()
          const pid = Number(stdout.trim().split(/\s+/)[0])
          if (!Number.isFinite(pid) || pid <= 0) return
          clearTimeout(timer)
          resolve(pid)
        })
      })

      abort.abort()
      expect(await proc.exited).not.toBe(0)

      // 这里验证的是 abort 返回后的系统状态：不能只让父进程结束，还必须清掉 detached 子进程。
      expect(await remainsRunningAfter(childPid, 1_000)).toBe(false)
    } finally {
      abort.abort()
      // 失败路径也必须清理，避免测试自身制造本需求要消除的后台 node.exe 垃圾。
      if (proc.pid && isProcessRunning(proc.pid)) await Process.run(["taskkill", "/pid", String(proc.pid), "/T", "/F"], { nothrow: true })
      if (childPid && isProcessRunning(childPid)) await Process.run(["taskkill", "/pid", String(childPid), "/T", "/F"], { nothrow: true })
    }
  }, 5000)

  test("kills after timeout when process ignores terminate signal", async () => {
    if (process.platform === "win32") return

    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 25)

    const out = await Process.run(node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'), {
      abort: abort.signal,
      nothrow: true,
      timeout: 25,
    })

    expect(out.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 3000)

  test("uses cwd when spawning commands", async () => {
    await using tmp = await tmpdir()
    const out = await Process.run(node("process.stdout.write(process.cwd())"), {
      cwd: tmp.path,
    })
    expect(out.stdout.toString()).toBe(tmp.path)
  })

  test("merges environment overrides", async () => {
    const out = await Process.run(node('process.stdout.write(process.env.OPENCODE_TEST ?? "")'), {
      env: {
        OPENCODE_TEST: "set",
      },
    })
    expect(out.stdout.toString()).toBe("set")
  })

  test("uses shell in run on Windows", async () => {
    if (process.platform !== "win32") return

    const out = await Process.run(["set", "OPENCODE_TEST_SHELL"], {
      shell: true,
      env: {
        OPENCODE_TEST_SHELL: "ok",
      },
    })

    expect(out.code).toBe(0)
    expect(out.stdout.toString()).toContain("OPENCODE_TEST_SHELL=ok")
  })

  test("runs cmd scripts with spaces on Windows without shell", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "with space")
    const file = path.join(dir, "echo cmd.cmd")

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n")

    const proc = Process.spawn([file, "--stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await proc.exited).toBe(0)
  })

  test("rejects missing commands without leaking unhandled errors", async () => {
    await using tmp = await tmpdir()
    const cmd = path.join(tmp.path, "missing" + (process.platform === "win32" ? ".cmd" : ""))
    const err = await Process.spawn([cmd], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }).exited.catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err).toMatchObject({
      code: "ENOENT",
    })
  })
})
