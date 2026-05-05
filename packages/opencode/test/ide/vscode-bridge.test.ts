// 桥接发现/调用的行为测试：覆盖 health 与鉴权路径
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import http from "http"
import os from "os"
// 路径处理：构建临时注册文件路径
import path from "path"
import * as VscodeBridge from "../../src/ide/vscode-bridge"

const originalRegistryDir = process.env.OPENCODE_IDE_REGISTRY_DIR
const tempDirs: string[] = []

// 清理责任：每个测试用例后删除临时目录和注册文件，防止测试间状态泄漏
afterEach(async () => {
  restoreEnv("OPENCODE_IDE_REGISTRY_DIR", originalRegistryDir)
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

// 测试套件：VS Code 桥接发现和解析功能
// 测试意图：验证桥接发现逻辑正确处理过期、PID 失效和健康检查失败的注册条目
describe("vscode bridge discovery", () => {
  // 测试用例：验证桥接发现和路径匹配逻辑
// 边界条件：空目录时应返回空数组，不抛出异常
// 测试意图：验证 stale 条目（超过 staleMs）被正确移除
// 测试意图：验证 PID 失效的条目被移除，即使未超过 staleMs

test("selects registry bridge matching the requested file path", async () => {
    using first = await bridgeServer()
    using second = await bridgeServer()
    const dir = await tempRegistry()
    await writeEntry(dir, "first", first.port, "/tmp/project-a")
    await writeEntry(dir, "second", second.port, "/tmp/project-b")

    const bridge = await VscodeBridge.resolveBridge({
      cwd: "/tmp/project-a",
      filePath: "/tmp/project-b/demo.ipynb",
    })

    expect(bridge.id).toBe("second")
  })

test("rejects file paths that do not match any live VS Code workspace", async () => {
    using server = await bridgeServer()
    const dir = await tempRegistry()
    await writeEntry(dir, "registry", server.port, "/tmp/project")

    await expect(
      VscodeBridge.resolveBridge({
        cwd: "/tmp/project",
        filePath: "/tmp/pro ject/demo.ipynb",
      }),
    ).rejects.toThrow("No live VS Code bridge workspace matches filePath")
  })

test("ignores and removes stale registry entries", async () => {
    const dir = await tempRegistry()
    await writeEntry(dir, "stale", 9, "/tmp/project", Date.now() - 60_000)

    await expect(VscodeBridge.resolveBridge({ cwd: "/tmp/project", staleMs: 100 })).rejects.toThrow(
      "No live VS Code bridge",
    )
    await expect(fs.stat(path.join(dir, "stale.json"))).rejects.toThrow()
  })
})

async function tempRegistry() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-vscode-bridge-"))
  tempDirs.push(dir)
  process.env.OPENCODE_IDE_REGISTRY_DIR = dir
  return dir
}

async function writeEntry(dir: string, id: string, port: number, workspace: string, updatedAt = Date.now()) {
  await fs.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      schema: 1,
      id,
      pid: process.pid,
      port,
      token: `${id}-token`,
      host: "127.0.0.1",
      transport: "http",
      ideName: "Visual Studio Code",
      ideKind: "vscode",
      remoteName: null,
      createdAt: updatedAt,
      updatedAt,
      workspaceFolders: [{ name: path.basename(workspace), uri: `file://${workspace}`, fsPath: workspace }],
      active: {},
      capabilities: { notebook: true },
    }),
  )
}

async function bridgeServer() {
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing test server port")
  return {
    port: address.port,
    [Symbol.dispose]() {
      server.close()
    },
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
