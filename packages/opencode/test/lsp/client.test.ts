import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "path"
import { ManagedRuntime } from "effect"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"
import { LSPClient } from "@/lsp/client"
import type * as LSPServer from "@/lsp/server"
import { AppLayer } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { Process } from "@/util/process"

type LspCase = {
  readonly initialization?: LSPServer.Handle["initialization"]
  readonly files?: Readonly<Record<string, string>>
}

async function withLspCase(
  input: LspCase,
  use: (client: Awaited<ReturnType<typeof LSPClient.create>>, directory: string) => Promise<void>,
) {
  await using tmp = await tmpdir()
  // 实例启动会读取项目，文件在加载前即存在，保留原测试的初始文档。
  for (const [name, contents] of Object.entries(input.files ?? {})) {
    await Bun.write(path.join(tmp.path, name), contents)
  }
  // 不使用全局 memo，关闭当前用例的运行时不会关闭套件中其他用例的服务。
  const runtime = ManagedRuntime.make(AppLayer)
  try {
    // LSP 根目录和实例目录取同一个临时项目，避免仓库插件初始化影响握手。
    const ctx = await runtime.runPromise(InstanceStore.Service.use((store) => store.load({ directory: tmp.path })))
    try {
      const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
      const processHandle = spawn(process.execPath, [serverPath], { stdio: "pipe" })
      // 先订阅 close，初始化前就退出的子进程也有真实的退出回执。
      const closed = new Promise<void>((resolve) => processHandle.once("close", () => resolve()))
      let client: Awaited<ReturnType<typeof LSPClient.create>> | undefined
      try {
        client = await LSPClient.create({
          serverID: "fake",
          server: { process: processHandle, initialization: input.initialization },
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })
        await use(client, tmp.path)
      } finally {
        try {
          // 初始化失败也要结束已启动的进程；此时还没有可关闭的协议客户端。
          if (client) await client.shutdown()
          else await Process.stop(processHandle)
        } finally {
          // shutdown 可能只发出终止信号；等 close 才证明子进程与 stdio 已结算。
          await closed
        }
      }
    } finally {
      // 实例释放需要仍存活的 store；应用级资源随后由独占运行时统一释放。
      await runtime.runPromise(InstanceStore.Service.use((store) => store.dispose(ctx)))
    }
  } finally {
    await runtime.dispose()
  }
}

describe("LSPClient interop", () => {
  test("handles workspace/workspaceFolders request", async () => {
    await withLspCase({}, async (client, directory) => {
      // 连接已建立只证明初始化成功；控制请求必须等客户端完成反向调用。
      const folders = await client.connection.sendRequest("test/request-client", {
        method: "workspace/workspaceFolders",
        params: {},
      })
      // 用文件 URL 验证协议值，保留 Windows 盘符和路径字符的转义。
      expect(folders).toEqual([{ name: "workspace", uri: pathToFileURL(directory).href }])
    })
  })

  test("handles client/registerCapability request", async () => {
    await withLspCase({}, async (client) => {
      const response = await client.connection.sendRequest("test/request-client", {
        method: "client/registerCapability",
        params: {
          registrations: [
            {
              id: "test-diagnostic-registration",
              // 客户端会忽略其他注册方法；传入诊断方法才会进入它维护动态诊断能力的分支。
              method: "textDocument/diagnostic",
              registerOptions: { identifier: "syntax" },
            },
          ],
        },
      })
      expect(response).toBeNull()
    })
  })

  test("handles client/unregisterCapability request", async () => {
    await withLspCase({}, async (client) => {
      await client.connection.sendNotification("test/trigger", {
        method: "client/unregisterCapability",
      })

      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(client.connection).toBeDefined()
    })
  })

  test("initialize does not overclaim unsupported diagnostics capabilities", async () => {
    await withLspCase({}, async (client) => {
      const params = await client.connection.sendRequest<any>("test/get-initialize-params", {})
      expect(params.capabilities.workspace.diagnostics.refreshSupport).toBe(false)
      expect(params.capabilities.textDocument.publishDiagnostics.versionSupport).toBe(false)
    })
  })

  test("workspace/configuration returns one result per requested item", async () => {
    const initialization = {
      alpha: {
        beta: 1,
      },
      gamma: true,
    }

    await withLspCase({ initialization }, async (client) => {
      const response = await client.connection.sendRequest<any[]>("test/request-configuration", {
        items: [{ section: "alpha" }, { section: "alpha.beta" }, { section: "missing" }, {}],
      })

      expect(response).toEqual([{ beta: 1 }, 1, null, initialization])
    })
  })

  test("sends ranged didChange for incremental sync servers", async () => {
    await withLspCase({ files: { "client.ts": "first\n" } }, async (client, directory) => {
      const file = path.join(directory, "client.ts")

      await client.notify.open({ path: file })
      await Bun.write(file, "second\nthird\n")
      await client.notify.open({ path: file })

      const change = await client.connection.sendRequest<{
        textDocument: { version: number }
        contentChanges: {
          range?: { start: { line: number; character: number }; end: { line: number; character: number } }
          text: string
        }[]
      }>("test/get-last-change", {})
      expect(change.textDocument.version).toBe(1)
      expect(change.contentChanges).toEqual([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 1, character: 0 },
          },
          text: "second\nthird\n",
        },
      ])
    })
  })

  test("document mode falls back to push diagnostics", async () => {
    await withLspCase({ files: { "client.ts": "const x = 1\n" } }, async (client, directory) => {
      const file = path.join(directory, "client.ts")

      const version = await client.notify.open({ path: file })
      const wait = client.waitForDiagnostics({ path: file, version, mode: "document" })
      await client.connection.sendNotification("test/publish-diagnostics", {
        uri: pathToFileURL(file).href,
        version,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            message: "push diagnostic",
            severity: 1,
          },
        ],
      })
      await wait

      const diagnostics = client.diagnostics.get(file) ?? []
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe("push diagnostic")

      const count = await client.connection.sendRequest("test/get-diagnostic-request-count", {})
      expect(count).toBe(0)
    })
  })

  test("document mode accepts matching push diagnostics published before waiting", async () => {
    await withLspCase({ files: { "client.ts": "const x = 1\n" } }, async (client, directory) => {
      const file = path.join(directory, "client.ts")

      const version = await client.notify.open({ path: file })
      await client.connection.sendNotification("test/publish-diagnostics", {
        uri: pathToFileURL(file).href,
        version,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            message: "push diagnostic",
            severity: 1,
          },
        ],
      })

      for (let i = 0; i < 20 && (client.diagnostics.get(file)?.length ?? 0) === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }

      expect(client.diagnostics.get(file)?.[0]?.message).toBe("push diagnostic")

      const started = Date.now()
      await client.waitForDiagnostics({ path: file, version, mode: "document" })
      expect(Date.now() - started).toBeLessThan(1_000)
    })
  })

  test("document mode waits for pull diagnostics", async () => {
    await withLspCase({ files: { "client.cs": "class C {}\n" } }, async (client, directory) => {
      const file = path.join(directory, "client.cs")

      await client.connection.sendRequest("test/configure-pull-diagnostics", {
        registerOn: "didOpen",
        registrations: [{ identifier: "DocumentCompilerSemantic" }],
        documentDiagnosticsByIdentifier: {
          DocumentCompilerSemantic: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              message: "pull diagnostic",
              severity: 1,
            },
          ],
        },
      })

      const version = await client.notify.open({ path: file })
      await client.waitForDiagnostics({ path: file, version, mode: "document" })

      const diagnostics = client.diagnostics.get(file) ?? []
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toBe("pull diagnostic")

      const count = await client.connection.sendRequest("test/get-diagnostic-request-count", {})
      expect(count).toBeGreaterThan(0)
    })
  })

  test("document mode does not wait for the slowest pull identifier after current-file diagnostics arrive", async () => {
    await withLspCase({ files: { "client.cs": "class C {}\n" } }, async (client, directory) => {
      const file = path.join(directory, "client.cs")

      await client.connection.sendRequest("test/configure-pull-diagnostics", {
        registrations: [{ identifier: "fast" }, { identifier: "slow" }],
        documentDiagnosticsByIdentifier: {
          fast: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              message: "fast diagnostic",
              severity: 1,
            },
          ],
          slow: [],
        },
        documentDelayMsByIdentifier: {
          slow: 2_500,
        },
      })

      const version = await client.notify.open({ path: file })
      await client.connection.sendRequest("test/register-configured-pull-diagnostics", {})
      await new Promise((resolve) => setTimeout(resolve, 100))
      const started = Date.now()
      await client.waitForDiagnostics({ path: file, version, mode: "document" })

      expect(Date.now() - started).toBeLessThan(1_000)
      expect(client.diagnostics.get(file)?.[0]?.message).toBe("fast diagnostic")
      expect(await client.connection.sendRequest("test/get-diagnostic-request-count", {})).toBeGreaterThan(1)
    })
  })

  test("full mode includes workspace pull diagnostics", async () => {
    await withLspCase({ files: { "client.cs": "class C {}\n", "other.cs": "class D {}\n" } }, async (client, directory) => {
      const file = path.join(directory, "client.cs")
      const related = path.join(directory, "other.cs")

      await client.connection.sendRequest("test/configure-pull-diagnostics", {
        registerOn: "didOpen",
        registrations: [
          { identifier: "DocumentCompilerSemantic" },
          { identifier: "WorkspaceDocumentsAndProject", workspaceDiagnostics: true },
        ],
        documentDiagnosticsByIdentifier: {
          DocumentCompilerSemantic: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              message: "current file",
              severity: 1,
            },
          ],
        },
        workspaceDiagnosticsByIdentifier: {
          WorkspaceDocumentsAndProject: [
            {
              uri: pathToFileURL(related).href,
              items: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 5 },
                  },
                  message: "workspace file",
                  severity: 1,
                },
              ],
            },
          ],
        },
      })

      const version = await client.notify.open({ path: file })
      await client.waitForDiagnostics({ path: file, version, mode: "full" })

      expect(client.diagnostics.get(file)?.[0]?.message).toBe("current file")
      expect(client.diagnostics.get(related)?.[0]?.message).toBe("workspace file")
    })
  })

  test("full mode treats an empty workspace pull response as handled", async () => {
    await withLspCase({ files: { "client.cs": "class C {}\n" } }, async (client, directory) => {
      const file = path.join(directory, "client.cs")

      await client.connection.sendRequest("test/configure-pull-diagnostics", {
        registerOn: "didOpen",
        registrations: [{ identifier: "WorkspaceDocumentsAndProject", workspaceDiagnostics: true }],
        workspaceDiagnosticsByIdentifier: {
          WorkspaceDocumentsAndProject: [],
        },
      })

      const version = await client.notify.open({ path: file })
      const started = Date.now()
      await client.waitForDiagnostics({ path: file, version, mode: "full" })

      expect(Date.now() - started).toBeLessThan(1_000)
    })
  })
})
