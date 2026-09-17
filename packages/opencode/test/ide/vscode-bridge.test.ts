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
  test("native HTTP disconnect cancels queued writes and later cells without blocking stop", async () => {
    const dir = await tempRegistry()
    // SDK实际运行在Node；Bun的http兼容层不派发断开的response.close，不能替代此边界。
    const entry = path.join(dir, "worker.ts")
    await fs.writeFile(entry, `
      import assert from "node:assert/strict";
      import { subscribe } from "node:diagnostics_channel";
      import { startBridge, closeBridge } from ${JSON.stringify(path.resolve(import.meta.dir, "../../../../sdks/vscode/src/bridge.ts"))};
      import { workspace, started, release, executions } from "vscode";
      // 客户端abort返回不代表服务端已收到断开，使用Node公开HTTP事件同步。
      const disconnected = Promise.withResolvers();
      subscribe('http.server.request.start',({request,response})=>{
        if(request.url==='/notebook/run')response.once('close',()=>disconnected.resolve());
      });
      const server = await startBridge({ appendLine() {} });
      const abortRun = new AbortController(), abortEdit = new AbortController();
      const post = (route, body, signal) => fetch('http://127.0.0.1:'+server.port+'/notebook/'+route, {
        method:'POST', headers:{Authorization:'Bearer '+server.token,'Content-Type':'application/json'},
        body:JSON.stringify({filePath:'/test/demo.ipynb',...body}), signal
      });
      try {
        const run = post('run',{cellId:'TOP',endCellId:'BOTTOM',timeoutMs:5000},abortRun.signal).catch(()=>{});
        await started.promise;
        const edit = post('edit',{cellId:'BOTTOM',editType:'insert',newCode:'cancelled'},abortEdit.signal).catch(()=>{});
        await post('summary',{});
        abortEdit.abort(); await edit;
        assert.equal((await post('env',{operation:'stop'},AbortSignal.timeout(1000))).status,200);
        abortRun.abort(); await run;
        await disconnected.promise;
        // 当前cell正常完成后，错误实现会继续下一cell，不能借cell超时得到假绿。
        release.resolve();
        const barrier = await post('edit',{cellId:'BOTTOM',editType:'insert',newCode:'barrier'});
        assert.equal(barrier.status,200);
        assert.deepEqual(workspace.notebookDocuments[0].getCells().map(c=>c.document.getText()),['first','second','barrier']);
        assert.equal(executions,1);
      } finally { abortRun.abort(); abortEdit.abort(); release.resolve(); await closeBridge(); }
    `)
    // 只替代VS Code文档API；服务器、HTTP连接、队列与handler均为实际实现。
    const build = await Bun.build({ entrypoints: [entry], target: "node", outdir: dir, plugins: [{ name: "vscode-fixture", setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }))
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: `
        const uri = value => ({ fsPath:value, scheme:'file',fragment:value.split('#')[1]||'',toString(){return value} });
        export const env={appName:'test'}, extensions={getExtension(){}};
        export const NotebookCellKind={Code:2,Markup:1}, EndOfLine={LF:1,CRLF:2};
        export class NotebookRange { constructor(start,end){this.start=start;this.end=end} }
        export class NotebookCellData { constructor(kind,value,languageId){Object.assign(this,{kind,value,languageId})} }
        export class WorkspaceEdit { set(uri,edits){this.edits=edits} }
        export const NotebookEdit={replaceCells:(range,cells)=>({range,cells})};
        const listeners=new Set(), cells=[];
        const notebook={uri:uri('/test/demo.ipynb'),metadata:{},notebookType:'jupyter-notebook',isDirty:true,version:1,
          get cellCount(){return cells.length},getCells:()=>cells,cellAt:i=>cells[i]};
        const make = (value,index) => ({notebook,index,kind:2,outputs:[],metadata:{},document:{uri:uri('/test/demo.ipynb#'+index),
          languageId:'python',eol:1,lineCount:1,getText:()=>value,lineAt:()=>({text:value})}});
        cells.push(make('first',0),make('second',1));
        export const workspace={notebookDocuments:[notebook],workspaceFolders:[],
          onDidChangeNotebookDocument(fn){listeners.add(fn);return{dispose:()=>listeners.delete(fn)}},
          async applyEdit(edit){for(const e of edit.edits)cells.splice(e.range.start,e.range.end-e.range.start,...e.cells.map(c=>make(c.value,cells.length)));
            notebook.version++;for(const fn of listeners)fn({notebook,cellChanges:[]});return true}};
        export const window={async showNotebookDocument(){return{notebook,revealRange(){}}}};
        export const started=Promise.withResolvers(),release=Promise.withResolvers(); export let executions=0;
        export const commands={async getCommands(){return['notebook.cell.execute']},async executeCommand(command,args){
          executions++;started.resolve();await release.promise;
          const cell=cells[args.ranges[0].start];cell.executionSummary={success:true};
          for(const fn of listeners)fn({notebook,cellChanges:[{cell,executionSummary:cell.executionSummary}]});
        }};
      ` }))
    } }] })
    expect(build.success).toBe(true)
    const child = Bun.spawnSync(["node", path.join(dir, "worker.js")], { env: { ...process.env, OPENCODE_IDE_REGISTRY_DIR: dir }, timeout: 10_000 })
    // 子进程断言失败或超时必须使CI变红，不能吞掉stderr里的实际缺陷。
    expect({ exit: child.exitCode, error: child.stderr.toString() }).toEqual({ exit: 0, error: "" })
  })

  test("create reaches the bridge for a missing file while reads still reject it", async () => {
    using server = await postBridgeServer()
    const dir = await tempRegistry()
    const filePath = path.join(dir, "new.ipynb")
    await writeEntry(dir, "11111111-1111-1111-1111-111111111111", server.port, dir)
    // 同一不存在的路径，create与读取的契约不同；不能放松全部路由。
    await expect(VscodeBridge.callBridge({ cwd: dir, filePath, path: "/notebook/env", body: { filePath, operation: "create" } })).resolves.toMatchObject({ summary: "ok" })
    await expect(VscodeBridge.callBridge({ cwd: dir, filePath, path: "/notebook/summary", body: { filePath } })).rejects.toThrow("does not exist")
  })

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

  test("already cancelled create never reaches the HTTP operation", async () => {
    using server = await postBridgeServer()
    const dir = await tempRegistry()
    await writeEntry(dir, "11111111-1111-1111-1111-111111111111", server.port, dir)
    const abort = new AbortController()
    abort.abort(new Error("cancelled before request"))
    // 已发生的abort不会再次派发事件，入口必须消费signal当前状态。
    await expect(VscodeBridge.callBridge({ cwd: dir, filePath: path.join(dir, "new.ipynb"), path: "/notebook/env", body: { operation: "create" }, signal: abort.signal })).rejects.toThrow("cancelled before request")
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

  // ---------------------------------------------------------------------------
  // 全局请求队列已移除：不同文件的 callBridge 请求应能并发执行，
  // 不被客户端全局 Promise 队列序列化。服务端 withFileLock 仍按文件序列化。
  // ---------------------------------------------------------------------------
  test("does not serialize concurrent callBridge requests for different files", async () => {
    const cwd = "/tmp/concurrent-project"
    const fileA = path.join(cwd, "a.ipynb")
    const fileB = path.join(cwd, "b.ipynb")
    const dir = await tempRegistry()
    // 两个 bridge server 分别绑定不同 active notebook，使 resolveBridge
    // 通过 active 匹配将 fileA 路由到 serverA、fileB 路由到 serverB
    using serverA = await postBridgeServer()
    using serverB = await postBridgeServer()
    await writeEntry(dir, "11111111-1111-1111-1111-111111111111", serverA.port, cwd, Date.now(), { notebook: fileA })
    await writeEntry(dir, "22222222-2222-2222-2222-222222222222", serverB.port, cwd, Date.now() + 1, { notebook: fileB })

    // 创建磁盘文件以满足 assertExistingLocalFilePath
    await fs.mkdir(cwd, { recursive: true })
    await fs.writeFile(fileA, "")
    await fs.writeFile(fileB, "")
    tempDirs.push(cwd)

    // serverA 的 POST 处理被阻塞直到 releaseA 被调用；
    // 如果全局队列仍在，serverB 的请求会被 serverA 阻塞，promise 会超时
    const callA = VscodeBridge.callBridge({ cwd, path: "/notebook/summary", body: { filePath: fileA }, filePath: fileA, timeoutMs: 5_000 })
    // 给 callA 一点时间进入 fetch（确保它先占住队列——如果队列存在的话）
    await new Promise((resolve) => setTimeout(resolve, 50))
    // callB 应该能立即完成，不被 callA 阻塞
    const resultB = await VscodeBridge.callBridge({ cwd, path: "/notebook/summary", body: { filePath: fileB }, filePath: fileB, timeoutMs: 5_000 })
    expect(resultB).toBeDefined()

    // 释放 callA
    serverA.release()
    await callA
  })
})

async function tempRegistry() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-vscode-bridge-"))
  tempDirs.push(dir)
  process.env.OPENCODE_IDE_REGISTRY_DIR = dir
  return dir
}

async function writeEntry(dir: string, id: string, port: number, workspace: string, updatedAt = Date.now(), active?: { notebook?: string }) {
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
      active: active ?? {},
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

// POST bridge server：第一个 POST 请求会被阻塞直到 release() 被调用，
// 用于验证客户端移除全局队列后不同文件的请求能真正并发。
async function postBridgeServer() {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (request.method === "POST") {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => { body += chunk })
      request.on("end", async () => {
        // 第一个请求阻塞直到 release；通过 body 中 filePath 区分
        const parsed = JSON.parse(body || "{}")
        if (parsed.filePath && parsed.filePath.includes("a.ipynb")) {
          await blocked
        }
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(JSON.stringify({ ran: false, summary: "ok", data: {} }))
      })
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
    release,
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
