import { describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { tmpdir } from "../fixture/fixture"

const INSTALL_SCRIPT = fileURLToPath(new URL("../../../../install", import.meta.url))
const VERSION = "1.2.3-smark"
const BASH = preferredWindowsGitBash() ?? Bun.which("bash") ?? "bash"

describe("install script", () => {
  test("installs to the requested directory even when PATH has the same version elsewhere", async () => {
    await using tmp = await tmpdir()
    const home = path.join(tmp.path, "home")
    const installDir = path.join(home, ".local", "bin")
    const fakeBin = path.join(tmp.path, "fake-bin")
    const existingBin = path.join(tmp.path, "existing-bin")
    const asset = await createReleaseAsset(tmp.path, "requested-target")

    await writeFakeReleaseCommands(fakeBin, asset)
    await writeExecutable(path.join(existingBin, "opencode"), `#!/usr/bin/env bash\necho "${VERSION}"\n`)

    const result = await runInstall(["--version", VERSION, "--no-modify-path"], {
      HOME: home,
      OPENCODE_INSTALL_DIR: installDir,
      OPENCODE_TEST_ASSET: asset,
      PATH: bashPath(fakeBin, existingBin),
    })

    expectSuccess(result)
    expect(result.output).toContain("Found existing opencode")
    expect(result.output).toContain("Will still install requested version to")
    expect(result.output).toContain("/.local/bin/opencode")
    expect(await runBinary(path.join(installDir, "opencode"))).toBe(VERSION)
  })

  test("reinstalls over the target binary instead of skipping the same version", async () => {
    await using tmp = await tmpdir()
    const home = path.join(tmp.path, "home")
    const installDir = path.join(home, ".local", "bin")
    const fakeBin = path.join(tmp.path, "fake-bin")
    const asset = await createReleaseAsset(tmp.path, "new-target")
    const target = path.join(installDir, "opencode")

    await writeFakeReleaseCommands(fakeBin, asset)
    await writeExecutable(target, `#!/usr/bin/env bash\necho "${VERSION}"\n# old-target\n`)

    const result = await runInstall(["--version", VERSION, "--no-modify-path"], {
      HOME: home,
      OPENCODE_INSTALL_DIR: installDir,
      OPENCODE_TEST_ASSET: asset,
      PATH: bashPath(fakeBin, installDir),
    })

    expectSuccess(result)
    expect(result.output).toContain("reinstalling to refresh it")
    expect(await Bun.file(target).text()).toContain("new-target")
  })

  test("updates all existing supported profiles by default without duplicate PATH entries", async () => {
    await using tmp = await tmpdir()
    const home = path.join(tmp.path, "home")
    const installDir = path.join(home, ".local", "bin")
    const binary = path.join(tmp.path, "opencode")
    const fakeBin = path.join(tmp.path, "fake-bin")
    const bashrc = path.join(home, ".bashrc")
    const bashProfile = path.join(home, ".bash_profile")
    const zshrc = path.join(home, ".zshrc")
    const expected = `export PATH="${bashPathForFile(installDir)}:$PATH"`

    await writeIdCommand(fakeBin, 501)
    await writeExecutable(binary, `#!/usr/bin/env bash\necho "${VERSION}"\n`)
    await fs.mkdir(home, { recursive: true })
    await Bun.write(bashrc, "# bashrc\n")
    await Bun.write(bashProfile, "# bash profile\n")
    await Bun.write(zshrc, 'export PATH="$HOME/.local/bin:$PATH"\n')

    for (let i = 0; i < 2; i++) {
      const result = await runInstall(["--binary", binary], {
        HOME: home,
        OPENCODE_INSTALL_DIR: installDir,
        PATH: bashPath(fakeBin),
        SHELL: "/bin/bash",
      })
      expectSuccess(result)
    }

    expect(count(await Bun.file(bashrc).text(), expected)).toBe(1)
    expect(count(await Bun.file(bashProfile).text(), expected)).toBe(1)
    expect(count(await Bun.file(zshrc).text(), "$HOME/.local/bin")).toBe(1)
    expect(count(await Bun.file(zshrc).text(), bashPathForFile(installDir))).toBe(0)
  })

  test("refuses root or sudo execution unless explicitly allowed", async () => {
    await using tmp = await tmpdir()
    const home = path.join(tmp.path, "home")
    const installDir = path.join(home, ".local", "bin")
    const fakeBin = path.join(tmp.path, "fake-bin")
    const binary = path.join(tmp.path, "opencode")

    await writeExecutable(binary, `#!/usr/bin/env bash\necho "${VERSION}"\n`)
    await writeIdCommand(fakeBin, 0)

    const result = await runInstall(["--binary", binary, "--no-modify-path"], {
      HOME: home,
      OPENCODE_INSTALL_DIR: installDir,
      PATH: bashPath(fakeBin),
      SUDO_USER: "tester",
    })

    expect(result.code).toBe(1)
    expect(result.output).toContain("refusing to run under sudo by default")
  })
})

async function createReleaseAsset(dir: string, marker: string) {
  const payload = path.join(dir, `payload-${marker}`)
  const asset = path.join(dir, `opencode-linux-x64-${marker}.tar.gz`)

  await writeExecutable(path.join(payload, "opencode"), `#!/usr/bin/env bash\necho "${VERSION}"\n# ${marker}\n`)
  // release asset 是 fake curl 的唯一输入；必须在这里验证 tar 成功，
  // 否则 Windows CI 会延迟到 cp cannot stat，掩盖真正的归档失败原因。
  const result = await runCommand(archiveCommand(asset, payload), dir)
  if (result.code !== 0) throw new Error(result.output || `failed to create release asset: ${asset}`)
  if (!existsSync(asset)) throw new Error(`release asset was not created: ${asset}`)

  return asset
}

function archiveCommand(asset: string, payload: string) {
  if (process.platform !== "win32") return ["tar", "-czf", asset, "-C", payload, "opencode"]
  // GitHub Windows runner 的安装脚本实际由 Git Bash 执行；归档也走同一 POSIX PATH，
  // 让 tar 产物和后续 fake curl/cp 使用一致的 /c/... 路径语义。
  return [
    BASH,
    "-c",
    [
      "exec",
      "env",
      quoteForSh(`PATH=${bashPath()}`),
      "tar",
      "-czf",
      quoteForSh(bashPathForFile(asset)),
      "-C",
      quoteForSh(bashPathForFile(payload)),
      "opencode",
    ].join(" "),
  ]
}

async function writeFakeReleaseCommands(dir: string, asset: string) {
  await writeIdCommand(dir, 501)
  await writeExecutable(
    path.join(dir, "uname"),
    `#!/usr/bin/env bash\ncase "$1" in\n  -s) echo Linux ;;\n  -m) echo x86_64 ;;\nesac\n`,
  )
  await writeExecutable(
    path.join(dir, "curl"),
    `#!/usr/bin/env bash\nset -euo pipefail\nout=""\nstatus=false\nurl=""\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) out="$2"; shift 2 ;;\n    -w) status=true; shift 2 ;;\n    *) url="$1"; shift ;;\n  esac\ndone\nif [ "$status" = "true" ]; then\n  printf "200"\n  exit 0\nfi\nif [[ "$url" == *checksums.txt ]]; then\n  exit 22\nfi\nif [ -z "$out" ]; then\n  printf '{"tag_name":"v${VERSION}"}'\n  exit 0\nfi\ncp "${bashPathForFile(asset)}" "$out"\n`,
  )
}

async function writeIdCommand(dir: string, uid: number) {
  await writeExecutable(path.join(dir, "id"), `#!/usr/bin/env bash\n[ "$1" = "-u" ] && echo ${uid}\n`)
}

async function writeExecutable(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, content)
  await fs.chmod(file, 0o755)
}

async function runInstall(args: string[], env: Record<string, string | undefined>) {
  const script = await installScriptForBash(env)
  const scriptEnv = {
    GITHUB_ACTIONS: "",
    ...bashEnv(env),
  }
  return runCommand(bashCommand(bashPathForFile(script), args, scriptEnv), path.dirname(INSTALL_SCRIPT), {
    ...process.env,
    ...scriptEnv,
  })
}

async function runBinary(file: string) {
  const result = await runCommand(
    process.platform === "win32" ? bashCommand(bashPathForFile(file), ["--version"], { PATH: bashPath() }) : [file, "--version"],
    path.dirname(file),
    process.env,
  )
  expect(result.code).toBe(0)
  return result.stdout.trim()
}

async function runCommand(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const proc = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, output: `${stdout}${stderr}`, code }
}

function expectSuccess(result: { code: number; output: string }) {
  if (result.code !== 0) throw new Error(result.output)
}

function count(text: string, needle: string) {
  return text.split(needle).length - 1
}

async function installScriptForBash(env: Record<string, string | undefined>) {
  const source = await Bun.file(INSTALL_SCRIPT).text()
  if (process.platform !== "win32" && !source.includes("\r\n")) return INSTALL_SCRIPT
  const script = path.join(path.dirname(env.HOME ?? path.dirname(INSTALL_SCRIPT)), "install")
  await fs.mkdir(path.dirname(script), { recursive: true })
  // WSL may run these Linux tests from a Windows checkout where git materialized
  // CRLF line endings. Bash then sees `pipefail\r`; normalize only the temp copy.
  await Bun.write(script, source.replaceAll("\r\n", "\n"))
  await fs.chmod(script, 0o755)
  return script
}

function bashEnv(env: Record<string, string | undefined>) {
  if (process.platform !== "win32") return env
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      if (!value) return [key, value]
      // Windows 的 `bash` 通常是 WSL 入口；脚本内部只理解 `/mnt/<drive>`
      // 形式的 POSIX 路径。只转换测试明确传给 install 脚本的路径变量，避免
      // 改写 token、用户名等非路径环境值并掩盖脚本自身的真实行为。
      if (["HOME", "OPENCODE_INSTALL_DIR", "OPENCODE_TEST_ASSET"].includes(key)) return [key, bashPathForFile(value)]
      return [key, value]
    }),
  )
}

function bashCommand(script: string, args: string[], env: Record<string, string | undefined>) {
  if (process.platform !== "win32") return [BASH, script, ...args]
  // Windows CI 使用 Git Bash，本地机器可能把 bash.exe 解析到 WSL；统一通过
  // env + /bin/bash 执行，既保留 bash-only 的 pipefail，也避免 login shell 重置 PATH。
  const assignments = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => quoteForSh(`${key}=${value}`))
  return [
    BASH,
    "-c",
    ["exec", "env", ...assignments, "/bin/bash", quoteForSh(script), ...args.map((arg) => quoteForSh(bashPathForFile(arg)))].join(" "),
  ]
}

function bashPath(...entries: string[]) {
  if (process.platform !== "win32") return [...entries, process.env.PATH].filter((item): item is string => Boolean(item)).join(":")
  // Windows POSIX 层不会可靠解析原生 PATH 里的 `C:\...` drive colon；测试只需要
  // fake-bin 中的桩命令和基础工具链，所以固定基础 PATH 来隔离用户环境。
  return [...entries.map(bashPathForFile), "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(":")
}

function bashPathForFile(file: string) {
  if (process.platform !== "win32") return file
  const normalized = file.replaceAll("\\", "/")
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/)
  if (!match) return normalized
  const drive = match[1].toLowerCase()
  // Git Bash 使用 /c/...，WSL 使用 /mnt/c/...；根据实际 bash.exe 风味转换，
  // 让同一组 install 行为测试能覆盖本地 WSL 和 GitHub Actions Git Bash。
  return windowsBashFlavor() === "wsl" ? `/mnt/${drive}/${match[2]}` : `/${drive}/${match[2]}`
}

function quoteForSh(value: string) {
  // 测试路径可能包含空格或括号；单引号是 POSIX sh 中最小且稳定的转义，
  // 这里只用于测试启动命令，不进入生产 install 参数解析逻辑。
  return `'${value.replaceAll("'", "'\\''")}'`
}

function preferredWindowsGitBash() {
  if (process.platform !== "win32") return undefined
  // GitHub Actions 固定提供 Git Bash；本地 Windows 常见 PATH 会先命中 WSL
  // C:\Windows\System32\bash.exe，优先选择 Git Bash 才能复现 CI shell 语义。
  return ["C:\\Program Files\\Git\\bin\\bash.exe", "D:\\Program Files\\Git\\bin\\bash.exe"].find((candidate) =>
    existsSync(candidate),
  )
}

function windowsBashFlavor() {
  if (process.platform !== "win32") return "posix"
  return BASH.replaceAll("\\", "/").toLowerCase().endsWith("/windows/system32/bash.exe") ? "wsl" : "git"
}
