import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Shell } from "@opencode-ai/core/shell"
import { ShellRemote } from "@opencode-ai/core/shell-remote"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { which } from "@opencode-ai/core/util/which"
import { tmpdir } from "./fixture/tmpdir"

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

describe("shell", () => {
  test("keeps guest payload ranges separate from following host commands", () => {
    // 边界识别不执行命令，两个shell族在任何测试平台都可验证。
    for (const [shell, command, guest] of [
      ["pwsh", "wsl -d Ubuntu -- cat /mnt/file", "cat /mnt/file"],
      ["pwsh", "wsl --cd /tmp -u root --exec sh -lc 'cat /mnt/file | grep data' | Get-Content local", "sh -lc 'cat /mnt/file | grep data'"],
      ["cmd", 'WSL.EXE --exec cat /mnt/file & TYPE local', "cat /mnt/file"],
      ["pwsh", "ssh -p 22 host 'cat /etc/os-release | grep NAME' | grep local", "'cat /etc/os-release | grep NAME'"],
      ["cmd", "ssh -i key host cat /etc/os-release & TYPE local", "cat /etc/os-release"],
      ["cmd", "wsl --exec cat /mnt/file ^| data", "cat /mnt/file ^| data"],
    ] as const) {
      expect(ShellRemote.ranges(command, shell).map((range) => command.slice(range.start, range.end).trim())).toEqual([guest])
    }
    expect(ShellRemote.ranges("ssh -p 22 host", "pwsh")).toEqual([])
  })

  test("builds Windows UTF-8 overlays without mutating the inherited environment", () => {
    const env = { PATH: "configured-path", JAVA_TOOL_OPTIONS: "-Xmx1g", RUBYOPT: "-w", PYTHONUTF8: "0" }
    // 平台作为纯输入覆盖两支，不写全局环境或伪造 process.platform。
    expect(Shell.utf8Environment("linux")).toEqual({})
    expect(Shell.utf8Environment("darwin")).toEqual({})
    expect(Shell.utf8Environment("win32")).toEqual({
      PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1",
    })
    // 只覆盖 Python；用户显式 Java/Ruby 原值在环境合并中保留，不能重建旧 oracle。
    expect({ ...env, ...Shell.utf8Environment("win32") }).toEqual({
      PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1",
      PATH: "configured-path", JAVA_TOOL_OPTIONS: "-Xmx1g", RUBYOPT: "-w",
    })
    expect(env).toEqual({ PATH: "configured-path", JAVA_TOOL_OPTIONS: "-Xmx1g", RUBYOPT: "-w", PYTHONUTF8: "0" })
  })

  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(Shell.login("/bin/bash")).toBe(true)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      const acceptable = Shell.acceptable()
      expect(Shell.preferred("opencode-missing-shell")).toBe(preferred)
      expect(Shell.acceptable("opencode-missing-shell")).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", () => {
    expect(Shell.name(Shell.acceptable("fish"))).not.toBe("fish")
    expect(Shell.name(Shell.acceptable("nu"))).not.toBe("nu")
  })

  test("builds command args per shell family", () => {
    expect(Shell.args("/bin/sh", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    expect(Shell.args("/usr/bin/fish", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    const zsh = Shell.args("/bin/zsh", "echo hi", "/tmp")
    expect(zsh[0]).toBe("-l")
    expect(zsh[1]).toBe("-c")
    expect(zsh.at(-1)).toBe("/tmp")
  })

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      // 路径归一测试只需存在的可执行文件名，不依赖主机Git安装，也不启动该夹具。
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "Git with spaces", "bin", "bash.exe")
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, "fixture executable is never invoked")
      const shell = file.replace(/^([A-Za-z]):/, (_, drive) => `/cygdrive/${drive.toLowerCase()}`).replaceAll("\\", "/")
      await withShell(shell, async () => {
        expect(Shell.preferred()).toBe(FSUtil.windowsPath(shell))
        // 保留临时夹具的真实解析，同时独立核对source固定路径，不依赖主机Git安装。
        expect(FSUtil.windowsPath("/cygdrive/c/Program Files/Git/bin/bash.exe")).toBe("C:/Program Files/Git/bin/bash.exe")
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.acceptable("bash")).toBe(bash)
      expect(Shell.preferred("bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })
  }
})
