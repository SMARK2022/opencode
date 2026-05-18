import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { tmpdir } from "../fixture/fixture"

const INSTALL_SCRIPT = fileURLToPath(new URL("../../../../install", import.meta.url))
const VERSION = "1.2.3-smark"

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
      PATH: `${fakeBin}:${existingBin}:${process.env.PATH}`,
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
      PATH: `${fakeBin}:${installDir}:${process.env.PATH}`,
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
    const expected = `export PATH="${installDir}:$PATH"`

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
        PATH: `${fakeBin}:${process.env.PATH}`,
        SHELL: "/bin/bash",
      })
      expectSuccess(result)
    }

    expect(count(await Bun.file(bashrc).text(), expected)).toBe(1)
    expect(count(await Bun.file(bashProfile).text(), expected)).toBe(1)
    expect(count(await Bun.file(zshrc).text(), "$HOME/.local/bin")).toBe(1)
    expect(count(await Bun.file(zshrc).text(), installDir)).toBe(0)
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
      PATH: `${fakeBin}:${process.env.PATH}`,
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
  await runCommand(["tar", "-czf", asset, "-C", payload, "opencode"], dir)

  return asset
}

async function writeFakeReleaseCommands(dir: string, asset: string) {
  await writeIdCommand(dir, 501)
  await writeExecutable(
    path.join(dir, "uname"),
    `#!/usr/bin/env bash\ncase "${"$1"}" in\n  -s) echo Linux ;;\n  -m) echo x86_64 ;;\nesac\n`,
  )
  await writeExecutable(
    path.join(dir, "curl"),
    `#!/usr/bin/env bash\nset -euo pipefail\nout=""\nstatus=false\nurl=""\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) out="$2"; shift 2 ;;\n    -w) status=true; shift 2 ;;\n    *) url="$1"; shift ;;\n  esac\ndone\nif [ "$status" = "true" ]; then\n  printf "200"\n  exit 0\nfi\nif [[ "$url" == *checksums.txt ]]; then\n  exit 22\nfi\nif [ -z "$out" ]; then\n  printf '{"tag_name":"v${VERSION}"}'\n  exit 0\nfi\ncp "${asset}" "$out"\n`,
  )
}

async function writeIdCommand(dir: string, uid: number) {
  await writeExecutable(path.join(dir, "id"), `#!/usr/bin/env bash\n[ "${"$1"}" = "-u" ] && echo ${uid}\n`)
}

async function writeExecutable(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, content)
  await fs.chmod(file, 0o755)
}

async function runInstall(args: string[], env: Record<string, string | undefined>) {
  return runCommand(["bash", INSTALL_SCRIPT, ...args], path.dirname(INSTALL_SCRIPT), {
    ...process.env,
    GITHUB_ACTIONS: "",
    ...env,
  })
}

async function runBinary(file: string) {
  const result = await runCommand([file, "--version"], path.dirname(file), process.env)
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
