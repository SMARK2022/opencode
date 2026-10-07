import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WindowsShellOutput } from "@opencode-ai/core/windows-shell-output"
import { tmpdir } from "../../fixture/fixture"
import { Schema } from "effect"

// S8：编译 bundle 的 shell-capture 角色必须由 index.ts 显式分发到 runHost
//（import.meta.main 在 bunfs 内不成立）。本测试驱动真实构建产物走完协议：
// ready证明角色分发到达宿主入口；stderr只检查意外输出，存储副作用须另查隔离目录。
// env 直接取 HOST_ROLE 常量：index.ts 字面量与常量漂移时本测试即红。
// 无构建产物时跳过：CI 的测试分支不构建 exe，本测试是发布前的本地/发布流水线门禁。
const exe = path.resolve(fileURLToPath(new URL("../../../dist/opencode-windows-x64/bin/opencode.exe", import.meta.url)))
const gate = process.platform === "win32" && fs.existsSync(exe) ? test : test.skip

describe("compiled shell-capture role", () => {
  gate(
    "dispatches into the capture host and executes one command",
    async () => {
      await using tmp = await tmpdir()
      const executionID = crypto.randomUUID()
      const child = spawn(exe, [], {
        cwd: tmp.path, // 错误入口即使按cwd初始化Project，也只能污染当前独占目录。
        env: {
          ...process.env,
          OPENCODE_PROCESS_ROLE: WindowsShellOutput.HOST_ROLE,
          OPENCODE_SHELL_EXEC: executionID,
          // 角色入口必须早于应用存储初始化；隔离目录让误启动DB/选主留下可断言证据。
          OPENCODE_DB: path.join(tmp.path, "capture.db"),
          OPENCODE_LOCK_PATH: path.join(tmp.path, "daemon.json"),
          OPENCODE_TEST_HOME: path.join(tmp.path, "home"),
          XDG_DATA_HOME: path.join(tmp.path, "data"),
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"], // 直接驱动编译产物的IPC，不通过源码adapter掩盖角色分发错误。
      })
      // spawn后立即登记退出事件，避免completed与快速退出之间漏订阅；signal退出允许null。
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
      try {
        let stderr = ""
        if (!child.stderr) throw new Error("compiled host has no stderr pipe")
        child.stderr.on("data", (chunk) => (stderr += chunk.toString()))
        const seen: string[] = []
        let rootPID: number | undefined
        let exitCode: unknown
        const bytes: Buffer[] = [] // 按到达次序保留原始字节，禁止排序拼接掩盖传输顺序错误。
        const done = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`protocol stalled; stderr tail: ${stderr.slice(-300)}`)),
            55_000, // 早于外层60秒截止，给finally回收失败产物保留时间。
          )
          child.on("message", (raw) => {
            const msg = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(raw)
            if (msg.v !== 1 || msg.executionID !== executionID) return
            seen.push(String(msg.type))
            if (msg.type === "ready") {
              child.send({
                v: 1,
                type: "run",
                executionID,
                command: {
                  file: process.execPath, // 根命令用绝对可执行路径，使空env不依赖PATH解析。
                  args: ["-e", "process.stdout.write('compiled-ok')"],
                  env: {}, // 验证线缆明确携带的命令环境，不借用编译host的角色环境。
                  stdin: "ignore",
                },
              })
              return
            }
            if (msg.type === "started") rootPID = Number(msg.rootPID)
            if (msg.type === "chunk") {
              bytes.push(Buffer.from(String(msg.base64), "base64"))
              // 小输出只需首帧预授权；credit 仍按合同回授，协议双向都被真实驱动。
              child.send({ v: 1, type: "credit", executionID, stream: msg.stream, seq: msg.seq })
              return
            }
            if (msg.type === "root-exit") exitCode = msg.code
            if (msg.type === "completed") {
              child.send({ v: 1, type: "accepted", executionID }) // 接收确认后host才可退出，避免IPC尾帧因快速退出丢失。
              clearTimeout(timer)
              resolve()
            }
          })
          child.once("error", (error) => {
            clearTimeout(timer)
            reject(error)
          })
        })
        await done
        // 断言协议合同而非精确次序：并发 forward 纤维下跨流交错与 root-exit 时点是
        // 设计留白；合同只保证 ready 首发、started 先于首帧、双 end 与 root-exit 先于
        // completed（由协议违例强制）、completed 末位。
        expect(seen[0]).toBe("ready")
        expect(seen.indexOf("started")).toBeLessThan(seen.indexOf("chunk"))
        // completed 末位成立时，双 end 与 root-exit 自然先于它。
        expect(seen.at(-1)).toBe("completed")
        expect(seen.filter((type) => type === "end").length).toBe(2)
        expect(seen.filter((type) => type === "chunk").length).toBe(1)
        expect(seen.filter((type) => type === "root-exit").length).toBe(1)
        expect(rootPID).toBeGreaterThan(0)
        expect(rootPID).not.toBe(child.pid) // started必须指向命令，不能把执行宿主伪装成根进程。
        expect(exitCode).toBe(0)
        expect(Buffer.concat(bytes)).toEqual(Buffer.from("compiled-ok"))
        // 运行协议完成还需宿主实际退出，不能只凭completed忽略泄漏的IPC进程。
        expect(await exited).toBe(0)
        expect(stderr).toBe("")
        // quiet stderr只证明输出安静；落盘检查才证明没有启动应用数据库和daemon选主。
        expect(fs.existsSync(path.join(tmp.path, "capture.db"))).toBe(false)
        expect(fs.existsSync(path.join(tmp.path, "daemon.json"))).toBe(false)
        expect(
          fs
            .readdirSync(tmp.path, { recursive: true })
            .some((name) => /(?:\.db(?:-|$)|tui-server|daemon\.json)/.test(String(name))), // 同时捕获SQLite sidecar与默认路径误写。
        ).toBe(false)
      } finally {
        child.kill("SIGKILL")
      }
    },
    60_000,
  )
})
