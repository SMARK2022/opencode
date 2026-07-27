import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

// 同一用例覆盖已消费的.1/.2/.4，断言Release闭包与第三方源码边界均保留。
test.each(["0.4.3-smark.1", "0.4.3-smark.2", "0.4.3-smark.4"])("upgrade-opentui preserves release %s and thirdparty boundary", async (version) => {
  await using tmp = await tmpdir()
  await Promise.all(["script", "packages/plugin", "thirdparty/opentui"].map((directory) => fs.mkdir(path.join(tmp.path, directory), { recursive: true })))
  await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({
    name: "opentui-upgrade-fixture", private: true,
    workspaces: { catalog: { "@opentui/core": "0.4.5", "@opentui/keymap": "0.4.5", "@opentui/solid": "0.4.5" } },
    // 真实最小安装保证目标原有的 lock 检查也执行，而非只测试 JSON 编辑算法。
    devDependencies: { "@opentui/core": "catalog:" },
    overrides: { "@opentui/core": "catalog:", "@opentui/keymap": "catalog:", "@opentui/solid": "catalog:" },
  }, null, 2) + "\n")
  await Bun.write(path.join(tmp.path, "packages/plugin/package.json"), JSON.stringify({
    peerDependencies: { "@opentui/core": ">=0.4.5", "@opentui/keymap": ">=0.4.5", "@opentui/solid": ">=0.4.5" },
  }, null, 2) + "\n")
  const nested = '{"name":"@opentui/core","version":"0.4.3-smark.1"}\n'
  await Bun.write(path.join(tmp.path, "thirdparty/opentui/package.json"), nested)
  await Bun.write(path.join(tmp.path, "script/upgrade-opentui.ts"), await Bun.file(path.join(import.meta.dir, "../../../../script/upgrade-opentui.ts")).text())

  const run = async (version: string) => {
    const child = Bun.spawn([process.execPath, "run", "script/upgrade-opentui.ts", version], { cwd: tmp.path, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    // 安装器可能输出正常诊断；以退出码和真实落盘结果验证升级，不要求 stderr 完全为空。
    expect({ code, stdout, stderr }).toMatchObject({ code: 0 })
  }
  await run(version)
  const root = await Bun.file(path.join(tmp.path, "package.json")).json()
  expect(root.workspaces.catalog).toEqual({
    "@opentui/core": version,
    "@opentui/keymap": version,
    "@opentui/solid": version,
  })
  // asset 名使用独立 literal，只代入本例版本，不引用升级器自己的映射来自证。
  expect(root.overrides).toEqual({
    "@opentui/core": `https://github.com/SMARK2022/opentui/releases/download/v${version}/opentui-core-${version}.tgz`,
    "@opentui/keymap": `https://github.com/SMARK2022/opentui/releases/download/v${version}/opentui-keymap-${version}.tgz`,
    "@opentui/solid": `https://github.com/SMARK2022/opentui/releases/download/v${version}/opentui-solid-${version}.tgz`,
    "@opentui/core-darwin-arm64": `https://github.com/SMARK2022/opentui/releases/download/v${version}/opentui-core-darwin-arm64-${version}.tgz`,
    "@opentui/core-darwin-x64": `https://github.com/SMARK2022/opentui/releases/download/v${version}/opentui-core-darwin-x64-${version}.tgz`,
    "@opentui/core-linux-arm64": `https://github.com/SMARK2022/opentui/releases/download/v${version}/opentui-core-linux-arm64-${version}.tgz`,
    "@opentui/core-linux-arm64-musl": `https://github.com/SMARK2022/opentui/releases/download/v${version}/opentui-core-linux-arm64-musl-${version}.tgz`,
    "@opentui/core-linux-x64": `https://github.com/SMARK2022/opentui/releases/download/v${version}/opentui-core-linux-x64-${version}.tgz`,
    "@opentui/core-linux-x64-musl": `https://github.com/SMARK2022/opentui/releases/download/v${version}/opentui-core-linux-x64-musl-${version}.tgz`,
    "@opentui/core-win32-arm64": `https://github.com/SMARK2022/opentui/releases/download/v${version}/opentui-core-win32-arm64-${version}.tgz`,
    "@opentui/core-win32-x64": `https://github.com/SMARK2022/opentui/releases/download/v${version}/opentui-core-win32-x64-${version}.tgz`,
  })
  const plugin = await Bun.file(path.join(tmp.path, "packages/plugin/package.json")).json()
  expect(Object.values(plugin.peerDependencies)).toEqual([`>=${version}`, `>=${version}`, `>=${version}`])
  expect(await Bun.file(path.join(tmp.path, "thirdparty/opentui/package.json")).text()).toBe(nested)

  // 升级到正常 registry 版本时，必须同时退出旧 fork 的 native 闭包，而非只替换三个 JS 包。
  await run("0.4.5")
  const registry = await Bun.file(path.join(tmp.path, "package.json")).json()
  expect(registry.workspaces.catalog).toEqual({ "@opentui/core": "0.4.5", "@opentui/keymap": "0.4.5", "@opentui/solid": "0.4.5" })
  expect(registry.overrides).toEqual({ "@opentui/core": "catalog:", "@opentui/keymap": "catalog:", "@opentui/solid": "catalog:" })
  expect(await Bun.file(path.join(tmp.path, "thirdparty/opentui/package.json")).text()).toBe(nested)
})
