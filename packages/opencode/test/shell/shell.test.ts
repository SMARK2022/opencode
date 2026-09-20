import { describe, expect, test } from "bun:test"
import path from "path"
import { Shell } from "../../src/shell/shell"
import { Filesystem } from "@/util/filesystem"
import { which } from "../../src/util/which"
import { tmpdir } from "../fixture/fixture"

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
  for (const name of ["bash", "zsh"]) {
    const file = name === "bash" && process.platform === "win32" ? Shell.gitbash() : which(name)
    test.skipIf(!file)(`${name} preserves native script and startup behavior`, async () => {
      if (!file) throw new Error(`Missing ${name}`)
      await using home = await tmpdir()
      await using cwd = await tmpdir()
      // 独立 HOME 避免用户 rc 干扰；login 和手动 rc 各自提供可观察标记。
      await Bun.write(path.join(home.path, name === "bash" ? ".bash_profile" : ".zprofile"), "export LOGIN_MARK=login\n")
      await Bun.write(path.join(home.path, `.${name}rc`), "export VALUE=outer\nalias fidelity_alias='printf alias'\ncd /\n")
      // Zsh 的 env 与 rc 查找语义不同于 Bash，不能合并初始化脚本。
      await Bun.write(path.join(home.path, ".zshenv"), "export ENV_MARK=zshenv\n")
      await Bun.write(path.join(cwd.path, "cwd-marker"), "")
      // rc 故意离开工作目录；命令开始前必须恢复 cwd，且别名仍可用。
      const command = String.raw`VALUE=inner
printf '%s\n' "$VALUE" '$VALUE' 'C:\Temp\x'
printf '%s\n' \
  'continued'
printf '%s\n' "$LOGIN_MARK" "$0"
fidelity_alias
[[ -f cwd-marker ]] && printf ':cwd'
[[ -n "$ENV_MARK" ]] && printf ':zshenv'
true`
      // 先锁定输入中的反斜杠换行，防止测试源码先把目标字符吃掉。
      expect(command).toContain(String.fromCharCode(92, 10))
      const proc = Bun.spawn([file, ...Shell.args(file, command, cwd.path)], {
        cwd: home.path,
        env: { ...process.env, HOME: home.path, ZDOTDIR: home.path, ENV_MARK: "" },
        stdout: "pipe", stderr: "pipe",
      })
      const [output, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      expect(error).toBe("")
      expect(code).toBe(0)
      // 预期值由语言合同独立给出：赋值后才展开，单引号中的字符原样输出。
      expect(output).toBe("inner\n$VALUE\nC:\\Temp\\x\ncontinued\nlogin\nopencode\nalias:cwd" + (name === "zsh" ? ":zshenv" : ""))
    })
  }

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

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes /cygdrive paths via windowsPath (does not require Git Bash installed)", () => {
      const input = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      expect(Filesystem.windowsPath(input)).toBe("C:/Program Files/Git/bin/bash.exe")
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
