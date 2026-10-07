import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { WindowsShellOutput } from "@opencode-ai/core/windows-shell-output"

// 本套件验证执行宿主的进程级故障域：Job 回收、late failure、后台任务寿命合同。
// 全部用例依赖 Windows Job Object 与 IPC 宿主，非 win32 平台整体跳过。
const win = process.platform === "win32" ? describe : describe.skip

function marked(code: string) {
  return WindowsShellOutput.mark(ChildProcess.make(process.execPath, ["-e", code], { stdin: "ignore" }))
}

function hostPid(session: WindowsShellOutput.RemoteSession) {
  if (session.proc.pid === undefined) throw new Error("capture host has no pid") // 身份缺失立即停止注入，绝不对未知PID执行kill。
  return session.proc.pid
}

function alive(pid: number) {
  try {
    process.kill(pid, 0) // signal 0只观察存活，不以测试自身的终止动作掩盖泄漏。
    return true
  } catch {
    return false
  }
}

async function pollDead(pid: number, timeout = 5000) {
  const deadline = Date.now() + timeout // Job回收由OS异步完成，轮询终态而非假定kill返回时整棵树已消失。
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await Bun.sleep(50)
  }
  return false
}

const signal = (session: WindowsShellOutput.RemoteSession) => Effect.runPromise(Deferred.await(session.signal)) // root退出不是完整成功，仅用于建立late-failure窗口。

function collect(stream: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    let out = ""
    stream.on("data", (chunk) => (out += chunk.toString()))
    stream.on("end", () => resolve(out)) // 只以EOF交付收集结果，data出现本身不能证明宿主完成。
    stream.on("error", reject) // 保留流失败，避免用部分文本伪装一次完整输出。
  })
}

win("windows shell output host", () => {
  test("closing an acquired host before ready leaves no command side effect", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-host-startup-"))
    const marker = path.join(dir, "executed")
    const session = WindowsShellOutput.openRemote(
      marked(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`),
      {},
    )
    // 同一同步调用栈先拥有host再发取消，子进程ready回调尚未进入父端事件循环。
    const ready = Promise.allSettled([session.ready]) // 取消可能早于首次await，预先订阅拒绝避免产生测试外未处理异常。
    try {
      await session.close()
      expect((await ready)[0].status).toBe("rejected")
      expect(await Bun.file(marker).exists()).toBe(false)
      expect(await pollDead(hostPid(session))).toBe(true)
    } finally {
      await session.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 15000)

  test("output stays fallible after both byte streams end until host completion", async () => {
    const session = await WindowsShellOutput.openRemote(marked("process.stdout.write('final-bytes')"), {})
    let ends = 0
    let completed = false
    // 注入点来自真实宿主报文，位于字节排空和native资源结算之间；只杀本测试持有的host。
    // 这里断言输出消费的失败，不把报文次序本身作为产品结果。
    session.proc.prependListener("message", (message) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return
      if (message.type === "completed") completed = true
      if (message.type === "end" && ++ends === 2) session.proc.kill("SIGKILL")
    })
    const output = Promise.allSettled(session.capture.streams.map(collect)) // 双流都要给出失败，不能让空stderr走提前成功。
    try {
      await session.ready
      const results = await output
      expect(completed).toBe(false) // 若故障注入落到成功屏障之后，本例必须失败而不是冒充命中目标窗口。
      expect(results.every((result) => result.status === "rejected")).toBe(true)
    } finally {
      session.proc.kill("SIGKILL")
      await session.close()
    }
  }, 30000)

  test("parent disconnect releases the host and its running command", async () => {
    const session = await WindowsShellOutput.openRemote(marked("setInterval(() => {}, 1000)"), {})
    const root = await session.ready
    try {
      // 保持parent测试进程存活，只关闭真实IPC，区分主动kill与失去控制端的回收责任。
      // 先等待host退出再查root，锁定Job句柄释放带来的后代清理而非测试主动杀树。
      session.proc.disconnect()
      expect(await pollDead(hostPid(session))).toBe(true)
      expect(await pollDead(root)).toBe(true)
    } finally {
      session.proc.kill("SIGKILL")
      await session.close()
    }
  }, 15000)

  test("host hard kill reaps the command tree via job", async () => {
    const session = await WindowsShellOutput.openRemote(marked("setInterval(() => {}, 1000)"), {})
    const root = await session.ready
    expect(alive(root)).toBe(true) // 先证明待回收命令确实存在，排除启动即退出的退化夹具。
    // 宿主被外部强杀时不能留下孤儿命令：KILL_ON_JOB_CLOSE 由 OS 兜底回收本次调用的后代。
    process.kill(hostPid(session), "SIGKILL")
    expect(await pollDead(hostPid(session))).toBe(true)
    expect(await pollDead(root)).toBe(true)
    await session.close()
  }, 30000)

  test("host death after a zero root exit still fails the execution", async () => {
    // 100KB 需要两次捕获读：首帧预授权发出后，次帧被 credit 闸门扣住（父端不消费）。
    // 命令在第二次读取后即可退出，因此 root-exit=0 先到达、completed 永远不来，
    // 注入窗口是确定性的，不依赖时序竞争。
    const size = 102400 // 大于一帧、小于两帧，root可退出而父端仍扣住后续输出额度。
    const session = await WindowsShellOutput.openRemote(
      marked(`process.stdout.write(Buffer.alloc(${size},65)); process.exitCode=0`),
      {},
    )
    await session.ready
    const [code] = await signal(session)
    expect(code).toBe(0) // 先锁定根进程成功，后续错误才能证明不是普通命令非零退出。
    process.kill(hostPid(session), "SIGKILL")
    // root 已报 0 但宿主未能交付完整输出：终态必须沿流错误通道携带执行身份，不得伪造成功。
    const failure = await new Promise<Error>((resolve) => session.capture.streams[0].once("error", resolve))
    expect(failure.message).toContain("shell capture host lost")
    await session.close()
  }, 30000)

  test("killing one call's host leaves a concurrent call byte-exact", async () => {
    // 多会话隔离本质（S7 的机制层）：每个调用独占宿主进程，A 宿主被强杀只能带走 A。
    // B 持续交付 2MiB 双流量并正常完成；A 沿流错误通道失败且身份可区分。
    const size = 2097152
    const a = await WindowsShellOutput.openRemote(marked("setInterval(() => {}, 1000)"), {})
    const b = await WindowsShellOutput.openRemote(
      marked(`process.stdout.write(Buffer.alloc(${size},66)); process.exitCode=0`),
      {},
    )
    const [aRoot, bRoot] = await Promise.all([a.ready, b.ready])
    expect(aRoot).not.toBe(bRoot)
    expect(hostPid(a)).not.toBe(hostPid(b))

    const bOut = collect(b.capture.streams[0]) // B独立消费并返还credit，A的失败不能令它失去额度。
    const aFailure = new Promise<Error>((resolve) => a.capture.streams[0].once("error", resolve))
    process.kill(hostPid(a), "SIGKILL")

    const failure = await aFailure
    expect(failure.message).toContain("shell capture host lost")
    const bytes = await bOut
    expect(bytes.length).toBe(size)
    expect(bytes).toBe("B".repeat(size)) // 长度检查之外验证内容，防止跨执行通道串入A的数据。
    const [bCode] = await signal(b)
    expect(bCode).toBe(0)
    await Promise.all([a.close(), b.close()])
  }, 30000)

  test("completed foreground call releases job limits so background tasks survive", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-host-bg-"))
    const marker = path.join(dir, "bg.log")
    const script = path.join(dir, "bg.js")
    // 后台任务延迟落盘：若宿主完成时未解除 kill-on-close，该写入永远不会发生。
    await fs.writeFile(
      script,
      `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 2000)`,
    )
    const escaped = (value: string) => value.replaceAll("'", "''")
    const ps = [
      `$p = Start-Process -WindowStyle Hidden -PassThru -FilePath '${escaped(process.execPath)}' -ArgumentList '${escaped(script)}'`,
      "Write-Output $p.Id",
    ].join("; ")
    const session = await WindowsShellOutput.openRemote(
      WindowsShellOutput.mark(
        ChildProcess.make("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdin: "ignore" }),
      ),
      {},
    )
    await session.ready
    const out = collect(session.capture.streams[0])
    const [code] = await signal(session)
    expect(code).toBe(0)
    const bg = Number((await out).trim())
    expect(bg).toBeGreaterThan(0)
    await session.close()
    try {
      // 宿主与前台命令均已终态后，后台任务必须仍活着并完成自己的写入。
      expect(await pollDead(hostPid(session))).toBe(true)
      expect(alive(bg)).toBe(true) // 在测试主动清理之前观察，验证生产Job限制已解除。
      const deadline = Date.now() + 8000
      let content = ""
      while (Date.now() < deadline && !content) {
        content = await fs.readFile(marker, "utf-8").catch(() => "")
        if (!content) await Bun.sleep(100)
      }
      expect(content).toBe("alive")
    } finally {
      try {
        process.kill(bg, "SIGKILL")
      } catch {}
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }, 30000)
})
