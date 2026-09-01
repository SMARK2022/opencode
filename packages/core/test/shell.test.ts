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
  test("normalizes bare double dash only for PowerShell permission parsing", async () => {
    // 直接调用共享解析器覆盖事故、缺段、三类豁免与残余错误；不启动任何shell进程。
    for (const [command, expected] of [
      ['git commit -m "x" -- a.ts', 'git commit -m "x" "--" a.ts'],
      ['git commit --only -m "a" -m "b" -- p1.txt p2.txt', 'git commit --only -m "a" -m "b" "--" p1.txt p2.txt'],
      ['git log --oneline -2 -- path', 'git log --oneline -2 "--" path'],
      ['git checkout --;git reset --hard', 'git checkout "--";git reset --hard'],
      ['git commit -m "unclosed', 'git commit -m "unclosed'],
      ['echo "a -- b"', 'echo "a -- b"'],
      ['git push --% --force', 'git push --% --force'],
      ['git log --oneline', 'git log --oneline'],
    ] as const) {
      const tree = await Shell.parse(command, true)
      try {
        expect(tree.rootNode.text).toBe(expected)
        if (!expected.includes('"--"')) continue
        expect(tree.rootNode.hasError).toBe(false)
        expect(tree.rootNode.descendantsOfType("command").length).toBe(command.includes(";") ? 2 : 1)
      } finally { tree.delete() }
    }
    // Bash无需改写；同一共享入口不能扩大归一化范围。
    const bash = await Shell.parse("git log -- path", false)
    try { expect(bash.rootNode.text).toBe("git log -- path") } finally { bash.delete() }
  })

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

  test("normalizes only bounded Windows PowerShell inline Python through the real transport", () => {
    const command = String.raw`python -c "print('{\"key\":1}')"`
    const normalized = Shell.normalizePowerShellInlinePython(command, "pwsh", "win32")
    if (!normalized) throw new Error("expected static Python adaptation")
    expect(normalized.source).toBe(`print('{"key":1}')`)
    expect(normalized.command).toContain("$PSNativeCommandArgumentPassing = 'Legacy'")
    const encoded = Shell.cmd("pwsh", normalized.command, "win32").args.at(-1)
    if (!encoded) throw new Error("expected EncodedCommand")
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain(normalized.command)
    // 显式平台输入沿用Shell.cmd风格，不伪造全局platform，也不启动任何解释器。
    for (const platform of ["linux", "darwin"]) expect(Shell.normalizePowerShellInlinePython(command, "pwsh", platform)).toBeUndefined()
    expect(Shell.normalizePowerShellInlinePython(command, "cmd.exe", "win32")).toBeUndefined()
    for (const prefix of ["python3.12 -B -Wdefault -Xutf8", "py -3.12 -B", '& "C:\\Python312\\python3.12.exe"', "conda run --name=agent --live-stream python"]) {
      expect(Shell.normalizePowerShellInlinePython(`${prefix} -c "print(1)"`, "pwsh", "win32")?.source).toBe("print(1)")
    }
    for (const value of [
      'python -i -c "print(1)"', 'python -c "print(1)" extra', 'python -c "print(1)"; Write-Output done',
      'python -c "print(1)" > output.txt', 'conda run --name=$env:ENV python -c "print(1)"',
    ]) expect(Shell.normalizePowerShellInlinePython(value, "pwsh", "win32")).toBeUndefined()
    expect(Shell.normalizePowerShellInlinePython(`python -c "${"x".repeat(20_000)}"`, "pwsh", "win32")).toBeUndefined()
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
    // 显式启动shell；Windows名称去扩展名依赖真实宿主，只在Windows验证cmd路径。
    expect(Shell.cmd("/bin/sh", "echo hi", "linux")).toEqual({ command: "/bin/sh", args: ["-c", "echo hi"], shell: false })
    if (process.platform === "win32") expect(Shell.cmd("cmd.exe", "echo hi", "win32")).toEqual({
      command: "cmd.exe", args: ["/d", "/s", "/c", '"echo hi"'], shell: false,
    })
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
