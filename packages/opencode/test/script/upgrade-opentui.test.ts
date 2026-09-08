import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

// fixture 声明版本是断言的唯一预期来源；测试不得从生产 asset 表反推 URL，否则生产常量漂移时测试无法失败。
// 参数化两个 smark 版本是为证明脚本不依赖固定白名单：任何符合形状的 release 都必须被接受。
const cases = ["0.4.3-smark.1", "0.4.3-smark.10"] as const

for (const version of cases) {
  test(`upgrade-opentui updates the immutable release family without entering thirdparty (${version})`, async () => {
    // 临时fixture同时包含root、plugin和submodule，验证扫描边界而非只验证单个package.json。
    // nested manifest是独立expected value，不能由升级脚本重新计算后再自证。
    await using tmp = await tmpdir()
    await Promise.all(
      ["script", "packages/plugin", "thirdparty/opentui"].map((directory) =>
        fs.mkdir(path.join(tmp.path, directory), { recursive: true }),
      ),
    )
    await Bun.write(
      path.join(tmp.path, "package.json"),
      JSON.stringify(
        {
          workspaces: {
            catalog: {
              "@opentui/core": "0.3.4",
              "@opentui/keymap": "0.3.4",
              "@opentui/solid": "0.3.4",
            },
          },
          overrides: {
            "@opentui/core": "catalog:",
            "@opentui/keymap": "catalog:",
            "@opentui/solid": "catalog:",
          },
        },
        null,
        2,
      ) + "\n",
    )
    // root catalog保留可读semantic version，实际artifact URL由11项override唯一拥有。
    await Bun.write(
      path.join(tmp.path, "packages/plugin/package.json"),
      JSON.stringify(
        {
          peerDependencies: {
            "@opentui/core": ">=0.3.4",
            "@opentui/keymap": ">=0.3.4",
            "@opentui/solid": ">=0.3.4",
          },
        },
        null,
        2,
      ) + "\n",
    )
    // nested 固定声明旧版本：fixture 版本与其不一致时，升级脚本仍不得改写独立 Git 边界内的 manifest。
    const nested = '{"name":"@opentui/core","version":"0.4.3-smark.1"}\n'
    await Bun.write(path.join(tmp.path, "thirdparty/opentui/package.json"), nested)
    await Bun.write(
      path.join(tmp.path, "script/upgrade-opentui.ts"),
      await Bun.file(path.join(import.meta.dir, "../../../../script/upgrade-opentui.ts")).text(),
    )

    const proc = Bun.spawn(["bun", "run", "script/upgrade-opentui.ts", version], {
      cwd: tmp.path,
      stdout: "pipe",
      stderr: "pipe",
    })
    // 子进程运行真实CLI入口，避免直接import函数绕过文件扫描、序列化和退出码行为。
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(stderr).toBe("")
    expect(code).toBe(0)

    const root = await Bun.file(path.join(tmp.path, "package.json")).json()
    // catalog断言来自fixture声明版本，不调用production asset表生成expected。
    expect(root.workspaces.catalog).toEqual({
      "@opentui/core": version,
      "@opentui/keymap": version,
      "@opentui/solid": version,
    })
    // 三个framework包和八个native包必须来自同一tag；缺一项都会重新形成mixed ABI graph。
    const release = `https://github.com/SMARK2022/opentui/releases/download/v${version}`
    expect(root.overrides).toEqual({
      "@opentui/core": `${release}/opentui-core-${version}.tgz`,
      "@opentui/keymap": `${release}/opentui-keymap-${version}.tgz`,
      "@opentui/solid": `${release}/opentui-solid-${version}.tgz`,
      "@opentui/core-darwin-arm64": `${release}/opentui-core-darwin-arm64-${version}.tgz`,
      "@opentui/core-darwin-x64": `${release}/opentui-core-darwin-x64-${version}.tgz`,
      "@opentui/core-linux-arm64": `${release}/opentui-core-linux-arm64-${version}.tgz`,
      "@opentui/core-linux-arm64-musl": `${release}/opentui-core-linux-arm64-musl-${version}.tgz`,
      "@opentui/core-linux-x64": `${release}/opentui-core-linux-x64-${version}.tgz`,
      "@opentui/core-linux-x64-musl": `${release}/opentui-core-linux-x64-musl-${version}.tgz`,
      "@opentui/core-win32-arm64": `${release}/opentui-core-win32-arm64-${version}.tgz`,
      "@opentui/core-win32-x64": `${release}/opentui-core-win32-x64-${version}.tgz`,
    })
    const plugin = await Bun.file(path.join(tmp.path, "packages/plugin/package.json")).json()
    // 三个peer分别保留，防止实现只更新core而遗漏Solid/keymap公开surface。
    expect(Object.values(plugin.peerDependencies)).toEqual([`>=${version}`, `>=${version}`, `>=${version}`])
    // peer floor和URL closure必须同时升级，否则source能安装但plugin生态仍拒绝同一release。
    // thirdparty是独立Git边界；升级root consumer不得改写fork中的package manifests。
    expect(await Bun.file(path.join(tmp.path, "thirdparty/opentui/package.json")).text()).toBe(nested)
  })
}

test("upgrade-opentui rejects versions outside the smark release shape", async () => {
  // 形状校验是唯一前置门槛；白名单已移除，非 smark 形状的任意拼接仍必须被拒绝。
  await using tmp = await tmpdir()
  await Bun.write(
    path.join(tmp.path, "script/upgrade-opentui.ts"),
    await Bun.file(path.join(import.meta.dir, "../../../../script/upgrade-opentui.ts")).text(),
  )

  const proc = Bun.spawn(["bun", "run", "script/upgrade-opentui.ts", "0.4.3"], {
    cwd: tmp.path,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  expect(code).toBe(1)
  expect(stderr).toContain("Unsupported OpenTUI release: 0.4.3")
})
