import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

const root = path.resolve(import.meta.dir, "../../../..")

describe("upstream app e2e workflow", () => {
  test("installs browsers with the locked workspace Playwright and bounded setup time", async () => {
    const workflow = await fs.readFile(path.join(root, ".github/workflows/test.yml"), "utf8")
    const job = section(workflow, "  upstream-e2e-warning:")
    const installDeps = step(job, "Install Playwright system dependencies")
    const installBrowsers = step(job, "Install Playwright browsers")
    const runE2E = step(job, "Run upstream app e2e tests")
    const catalog = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).workspaces.catalog
    const playwrightVersion = catalog["@playwright/test"]
    const lockfile = await fs.readFile(path.join(root, "bun.lock"), "utf8")

    // Node 24.16+ 会让 Playwright 1.60.0 之前的浏览器解压停在 100%，
    // 所以上游 E2E 的公开契约是使用已包含修复的 workspace 版本。
    expect(atLeast(playwrightVersion, "1.60.0")).toBe(true)
    // catalog 和 lockfile 必须同步，否则 workflow 读到的是新版本，实际安装仍可能是旧安装器。
    expect(lockfile).toContain(`"@playwright/test": "${playwrightVersion}"`)
    expect(lockfile).toContain(`"@playwright/test@${playwrightVersion}"`)
    expect(lockfile).toContain(`"playwright@${playwrightVersion}"`)
    expect(lockfile).toContain(`"playwright-core@${playwrightVersion}"`)

    // Linux 系统依赖和浏览器安装都发生在测试步骤之前，必须各自有边界，
    // 否则一个下载或解压卡住会吞掉整个 warning job 的超时时间。
    expect(field(installDeps, "timeout-minutes")).toBe("10")
    expect(field(installBrowsers, "timeout-minutes")).toBe("15")

    expect(playwrightCommand(installDeps)).toEqual([
      "node",
      "../../node_modules/playwright/cli.js",
      "install-deps",
      "chromium",
    ])
    expect(playwrightCommand(installBrowsers)).toEqual([
      "node",
      "../../node_modules/playwright/cli.js",
      "install",
      "chromium",
    ])
    expect(playwrightCommand(runE2E)).toEqual(["node", "../../node_modules/playwright/cli.js", "test"])

    // 安装和测试命令必须停留在 packages/app 的依赖边界内，并显式使用 hoisted 后的根 CLI。
    // Windows 上 Bun 执行 .bin shim 会尝试重映射 bin metadata；直接用 Node 执行锁定 CLI 可避开该边界。
    expect(field(installDeps, "working-directory")).toBe("packages/app")
    expect(field(installBrowsers, "working-directory")).toBe("packages/app")
    expect(field(runE2E, "working-directory")).toBe("packages/app")
    // E2E 入口改为直接执行 CLI 后仍必须保留 JUnit 输出位置，
    // 后续汇总步骤依赖这个约定判断 warning job 是否产出报告。
    expect(envField(runE2E, "PLAYWRIGHT_JUNIT_OUTPUT")).toBe("e2e/junit-${{ matrix.os_label }}.xml")
    expect(job).not.toContain("bunx playwright")
    expect(job).not.toContain(".bin/playwright")
  })
})

function section(source: string, marker: string) {
  const start = source.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = source.slice(start + marker.length)
  const next = rest.search(/\n  [A-Za-z0-9_-]+:/)
  return marker + (next === -1 ? rest : rest.slice(0, next))
}

function step(source: string, name: string) {
  const marker = `      - name: ${name}`
  const start = source.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = source.slice(start + marker.length)
  const next = rest.indexOf("\n      - name:")
  return marker + (next === -1 ? rest : rest.slice(0, next))
}

function field(source: string, key: string) {
  const match = source.match(new RegExp(`^        ${key}: (.+)$`, "m"))
  return match?.[1]
}

function envField(source: string, key: string) {
  const match = source.match(new RegExp(`^          ${key}: (.+)$`, "m"))
  return match?.[1]
}

function playwrightCommand(source: string) {
  const command = field(source, "run")
  expect(command).toBeTruthy()
  expect(/[|;&><`$]/.test(command!)).toBe(false)
  return command!.split(" ")
}

function atLeast(actual: string, minimum: string) {
  const actualParts = actual.split(".").map(Number)
  const minimumParts = minimum.split(".").map(Number)
  // 逐段比较固定版本号即可覆盖 Playwright 下限约束，同时避免引入新的 semver 依赖。
  const comparison = Array.from({ length: Math.max(actualParts.length, minimumParts.length) }, (_, index) =>
    Math.sign((actualParts[index] ?? 0) - (minimumParts[index] ?? 0)),
  ).find((value) => value !== 0)
  return (comparison ?? 0) >= 0
}
