import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import http from "http"
import os from "os"
import path from "path"
import * as VscodeBridge from "../../src/ide/vscode-bridge"

const originalRegistryDir = process.env.OPENCODE_IDE_REGISTRY_DIR
const tempDirs: string[] = []

afterEach(async () => {
  restoreEnv("OPENCODE_IDE_REGISTRY_DIR", originalRegistryDir)
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("vscode bridge discovery", () => {
  test("selects registry bridge matching the requested file path", async () => {
    using first = await bridgeServer()
    using second = await bridgeServer()
    const dir = await tempRegistry()
    const firstId = "11111111-1111-1111-1111-111111111111"
    const secondId = "22222222-2222-2222-2222-222222222222"
    // The fixture uses UUID-shaped names because production discovery only owns
    // files created by the VS Code extension's randomUUID-based manifest writer.
    await writeEntry(dir, firstId, first.port, "/tmp/project-a")
    await writeEntry(dir, secondId, second.port, "/tmp/project-b")

    const bridge = await VscodeBridge.resolveBridge({
      cwd: "/tmp/project-a",
      filePath: "/tmp/project-b/demo.ipynb",
    })

    expect(bridge.id).toBe(secondId)
  })

  test("does not reuse a cached bridge after the registry directory changes", async () => {
    using first = await bridgeServer()
    using second = await bridgeServer()
    const cwd = "/tmp/cache-project"
    const filePath = "/tmp/cache-project/demo.ipynb"
    const firstId = "11111111-1111-1111-1111-111111111111"
    const secondId = "22222222-2222-2222-2222-222222222222"

    // OPENCODE_IDE_REGISTRY_DIR is the supported escape hatch for tests and
    // non-default state locations. Reusing the same cwd/filePath across two
    // directories must not return a bridge from the previous registry cache.
    await writeEntry(await tempRegistry(), firstId, first.port, cwd)
    expect((await VscodeBridge.resolveBridge({ cwd, filePath })).id).toBe(firstId)

    await writeEntry(await tempRegistry(), secondId, second.port, cwd)
    expect((await VscodeBridge.resolveBridge({ cwd, filePath })).id).toBe(secondId)
  })

  test("ignores corrupted registry entries", async () => {
    using server = await bridgeServer()
    const dir = await tempRegistry()
    const cwd = "/tmp/corrupted-project"
    const filePath = "/tmp/corrupted-project/demo.ipynb"
    const corrupted = path.join(dir, "00000000-0000-0000-0000-000000000000.json")
    const registryId = "22222222-2222-2222-2222-222222222222"
    // All-NUL content mirrors the observed Windows corruption while keeping the
    // assertion behavioural: discovery must skip the bad entry and still select
    // the live bridge, then cleanup only the abandoned corrupt manifest file.
    await fs.writeFile(corrupted, Buffer.alloc(566))
    await fs.utimes(corrupted, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    await writeEntry(dir, registryId, server.port, cwd)

    const bridge = await VscodeBridge.resolveBridge({
      cwd,
      filePath,
    })

    expect(bridge.id).toBe(registryId)
    await expect(fs.stat(corrupted)).rejects.toThrow()
  })

  test("does not remove non-manifest json files, directories, or recently modified corrupted manifests", async () => {
    using server = await bridgeServer()
    const dir = await tempRegistry()
    const cwd = "/tmp/safety-project"
    const filePath = "/tmp/safety-project/demo.ipynb"
    const nonManifest = path.join(dir, "notes.json")
    const shellLookingNonManifest = path.join(dir, "notes with spaces $(noop).json")
    const manifestDirectory = path.join(dir, "00000000-0000-0000-0000-000000000000.json")
    const recentCorrupted = path.join(dir, "11111111-1111-1111-1111-111111111111.json")
    const registryId = "22222222-2222-2222-2222-222222222222"
    const foreignJson = path.join(dir, "33333333-3333-3333-3333-333333333333.json")
    // These names cover the deletion boundary rather than implementation shape:
    // non-UUID JSON, shell-looking filenames with spaces and `$()`, UUID-named
    // directories, fresh corrupt files, and valid-but-foreign JSON must remain
    // untouched even when OPENCODE_IDE_REGISTRY_DIR points at this directory.
    await fs.writeFile(nonManifest, "not json")
    await fs.writeFile(shellLookingNonManifest, "not json")
    await fs.mkdir(manifestDirectory)
    await fs.writeFile(recentCorrupted, Buffer.alloc(566))
    await fs.writeFile(foreignJson, JSON.stringify({ ok: false }))
    await writeEntry(dir, registryId, server.port, cwd)

    const bridge = await VscodeBridge.resolveBridge({
      cwd,
      filePath,
    })

    expect(bridge.id).toBe(registryId)
    expect((await fs.stat(nonManifest)).isFile()).toBe(true)
    expect((await fs.stat(shellLookingNonManifest)).isFile()).toBe(true)
    expect((await fs.stat(manifestDirectory)).isDirectory()).toBe(true)
    expect((await fs.stat(recentCorrupted)).isFile()).toBe(true)
    expect((await fs.stat(foreignJson)).isFile()).toBe(true)
  })

  test("rejects file paths that do not match any live VS Code workspace", async () => {
    using server = await bridgeServer()
    const dir = await tempRegistry()
    await writeEntry(dir, "11111111-1111-1111-1111-111111111111", server.port, "/tmp/mismatch-project")

    await expect(
      VscodeBridge.resolveBridge({
        cwd: "/tmp/mismatch-project",
        filePath: "/tmp/mis match-project/demo.ipynb",
      }),
    ).rejects.toThrow("No live VS Code bridge workspace matches filePath")
  })

  test("ignores and removes stale registry entries", async () => {
    const dir = await tempRegistry()
    const staleId = "11111111-1111-1111-1111-111111111111"
    await writeEntry(dir, staleId, 9, "/tmp/stale-project", Date.now() - 60_000)

    await expect(VscodeBridge.resolveBridge({ cwd: "/tmp/stale-project", staleMs: 100 })).rejects.toThrow(
      "No live VS Code bridge",
    )
    await expect(fs.stat(path.join(dir, `${staleId}.json`))).rejects.toThrow()
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
