# Canonical Implementation Plan: Notebook 定点回归修复

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: 本会话 2026-11-29 用户实施请求，原文见第 1 节
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-29

唯一实施规格。固定实施前基线为 `53ec198de854db5c0318706f5f62946a087398b9`；回退行为参照用户确认的 `dev-smark@26061b595b`。终态为 `verified-implementation-and-commit`，不 push。生产代码增删合计最多 320 行，不新增测试文件。

## 1. Verbatim Requirement

> 因此这块已经很清晰了。精准移除掉或者增加一行限定，使得这些消费逻辑去给它摘除掉，不得因为 Execute 的工具引起 Output，或者引起普通工具的退化。然后与此同时，请注意一点，你不要去给我什么新增 test，本身这个事情已经充分反映出来，GPT 在写代码的时候，它过度地去施加限定逻辑，所以当前要做的是减法而不是加法。同时相较于你之前所说的新增回归，P1，P2，也就是1、2、3这三个回归，给它纠正回来。按理来讲纠正的方法是做定点修改，不要做大幅度的调整，请注意这点，不要做大幅度调整。把相应的逻辑精准修改成我们之前在 DEV 的那个主分支里面的逻辑，精准调整移除掉冗余的。 修改掉有问题的。同时，对于原有问题中的自动匹配缩进这一块，这个第一，第二，第三，第四，需要进行精准的调整。第五第六不参与。同时请注意一点，按理来讲，如上的每一个修改的行数，我觉得就是总体的修改行数，就如上这些所有那种整体修改行数，我希望生产代码修改限定在320行以内。测试代码，你修正那些功能逻辑，你可以每一个新增一个 test，但是既有的那些东西，尽量避免去修改，尽量避免去引入新的 test，最多是。 修改现有的 test。然后与此同时请注意，不要去新增 test 文件数，同时保持修改精准，不要再去引入用户没有说的任何逻辑，请注意这点。不要再去试图引入一些各种各样的一些限定啊、分支啊、各种逻辑。你可以完整地吸取现在的教训，现在就是我们实现逻辑实现的过渡。因此下面请你按照 document 里面有个 guide，里面有一个 workflow.md，按照那个逻辑进行 Verify Implementation and Commit 的逻辑。

编号所指的既有审查结论如下，固定本任务范围：

| ID | 明确行为 |
| --- | --- |
| R1 | Execute 的程序结果投影/校验不阻断普通 Notebook 工具的原输出 |
| R2 | 注册恢复独立 UUID，能被现有客户端发现 |
| R3 | 稳定目标格仅因前方无关插格而移位时，仍执行同一格 |
| R4 | 扩展终端不覆盖用户的服务认证环境配置 |
| R5 | 模糊替换迁移缩进时保留 replacement 的相对嵌套层级 |
| R6 | 范围运行不被一个单格的 HTTP 期限截断 |
| R7 | 同一本地文档的普通路径/file URI 写法共用执行锁 |
| R8 | 已提交编辑之后，版本同步等待及时响应取消并清理订阅 |

## 2. Explicit Non-Goals

不修改上次审查的第五、第六项：UI/runtime/artifact 展示、环境描述和手工面板。不给旧桥接响应补默认字段，不加协议协商、版本探测、重试、自动回放或替代执行后端。不改 SDK 返回字段或 Execute 已有程序合同，不升级/安装扩展，不执行用户 Notebook、不读取生产凭证。权限、实际操作失败、目标删除/替换的拒绝保持。无关 staged 文件保持原状。

## 3. Repository Context

遵循根 AGENTS、packages/opencode/AGENTS、packages/opencode/test/AGENTS、Core tool AGENTS、CONTEXT 的工具输出和权限归属，及 docs/guides/workflow.md。ADR 索引只有 triage 决策，无 Notebook 专项约束。仅增加本 plan；实施在完整方案批准后开始，最终独立实现审计通过才提交。

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| packages/opencode/src/plugin/vscode-bridge.ts、tool/registry.ts、session/tools.ts、tool/code-mode.ts、tool/tool.ts；packages/plugin/src/tool.ts | 程序投影、共用校验、真实 executeParent 来源与消费端 | observed |
| packages/core/src/ide/vscode-bridge.ts、tool/notebook.ts | 两代共用客户端、HTTP deadline 与取消 | observed |
| sdks/vscode/src/bridge.ts、bridge-registry.ts、extension.ts、util.ts | 注册 ID、锁、认证变量、URI 规范化 | observed |
| sdks/vscode/src/notebook/{edit,run,resolve,format,output}.ts | 缩进、格身份、版本等待和副作用 | observed |
| packages/opencode/test/{plugin/vscode-bridge,plugin/vscode-notebook-tool-summary,ide/vscode-bridge,tool/registry}.test.ts | 可复用的现有工具/原生 HTTP fixtures | observed |
| packages/core/test/tool-notebook.test.ts；sdks/vscode/src/test/*.ts、package.json、.vscode-test.mjs | V2 集成及包内验证门禁 | observed |
| 本会话固定 HEAD 的审查实验、git diff dev-smark HEAD、14790e2dbb 实际 diff | 回归及原有缺陷的前后行为 | observed |
| 用户原文、workflow、policy、canonical template | 范围、行数、测试和提交约束 | contracted |

## 5. Current Behavior

普通/嵌套调用共用 registry -> 插件 -> Bridge HTTP -> SDK handler。SessionTools 只为真实 Execute 子调用设置 `ctx.executeParent`；registry 已将 ctx 展开给插件，但插件 ToolContext 类型没有声明该现存字段。Notebook 插件无条件产生 program.value，registry 无条件校验，旧响应因缺少 outputCount 等字段使原文本输出一起丢失。

SDK 以 env.sessionId 注册，客户端先过滤纯 UUID 文件名。run 在显示文档前固定索引，随后按旧索引拒绝移动。extension 无条件注入默认用户名和空密码。edit 的 migrateIndent 在公共缩进为空时逐行 trimStart，压平内部缩进。客户端对整个范围套单格 timeout+5s，SDK 却每格独立计时。锁键直接使用原始 filePath。编辑 signal 只在 resolve 后检查，两个版本等待器没有订阅取消。

## 6. Supported Input Domain and Reachability

| Condition | Producer / route | Owner | Class |
| --- | --- | --- | --- |
| 旧扩展返回文本及旧 data，直接工具调用 | 已安装 1.15.11；普通 registry -> Notebook 插件 | 插件与 registry 的程序消费边界 | observed |
| 显式 Execute 子调用 | SessionTools.context 的 executeParent；调用者不能用参数伪造 ctx | 同一插件/registry | contracted |
| UUID+timestamp 的 VS Code sessionId | 支持的 VS Code telemetry -> env.sessionId -> registerBridge | SDK bridge | observed |
| showNotebookDocument 等待时前方插格 | 用户 UI 编辑更新 cell.index，目标对象/URI不变 | SDK run | observed |
| terminal.integrated.env 配置凭证 | VS Code 先合并用户设置、再合并扩展 TerminalOptions.env | SDK extension | observed |
| 无公共基缩进的嵌套 replacement | 已支持 oldCode/newCode 模糊替换 | SDK edit | observed |
| 多格各自合法但总耗时超过单格期限 | run cellId/endCellId，SDK串行等待 | Bridge 客户端总期限 | observed |
| Windows 路径与 file URI 同时变更 | uriFromInput 可解析的显式 notebook 路径 | SDK HTTP锁 | reachable |
| applyEdit 已接受，版本尚未变化时取消 | HTTP断连 signal 传入 editNotebook | SDK两个等待器 | observed |

## 7. Required Invariants

INV-01 至 INV-08 分别对应 R1 至 R8。普通调用仍交付原 output/metadata/attachments；嵌套调用仍取得原固定程序合同。UUID discovery、稳定格身份、环境继承、相对缩进、逐格期限、同 URI 互斥和取消清理分别归其现有 owner。INV-09：生产增删总计 <=320，零新增测试文件，最多每项修复增加一项 test；修改现有用例时保留原行为断言。INV-10：实际权限/操作失败不伪装成功，不重试已发生副作用。

## 8. First Divergence and Root Cause

| Invariant | First divergence / owner | Executed baseline signal |
| --- | --- | --- |
| INV-01 | 插件将程序投影作为普通输出前提，registry再强制parse | 固定HEAD真实output调用及旧响应回放均得到 expected number/undefined；配套113场景无异常 |
| INV-02 | bridge把sessionId代替原UUID | 真实activate/register/discover隔离链：纯UUID发现1；UUID+timestamp健康200但发现0 |
| INV-03 | run比较捕获时索引 | 同格前插Markdown：旧实现执行1次；当前执行0次并拒绝 |
| INV-04 | TerminalOptions.env覆盖配置 | 实际openTerminal合成API探针：旧配置密码保留，当前变为空 |
| INV-05 | migrateIndent逐行trimStart | 两版实际edit将 if ok / nested new() 压成同缩进 |
| INV-06 | client把单格期限作为请求总期限 | 本轮bun -e真实callBridge：两段60ms、单段期限80ms，请求84ms被中止；直接HTTP加调用方取消信号正常完成 |
| INV-07 | HTTP锁按raw字符串分组 | 本轮实际vscode-uri探针：C:\\work\\a b.ipynb、C:/work/a b.ipynb及大小写盘符file URI均规范成file:///c%3A/work/a%20b.ipynb；当前锁仍分组 |
| INV-08 | signal未传入版本等待器 | 固定HEAD实际edit取消探针：取消后仍订阅，事件或10s期限才释放 |

上述已执行审查实验与本轮读到的文件均对应未变的固定HEAD，可复用；实施时在原有测试 seam 先观察红测再修复。生产 registry 与真实用户 Notebook 不参与重放。

### 8.1 可重跑的原始故障证据

本节命令在固定基线实际运行，输出只列行为证据；测试凭证均为合成值。命令中的模块真实导入或从固定git tree内存转译，不更改生产/测试源码。后续测试沿相同public seam检查修正后结果。

**R1，cwd packages/opencode，退出0（精确捕获两项原始错误）。**

```powershell
bun -e 'import { spyOn } from "bun:test"; import { VscodeBridgePlugin } from "./src/plugin/vscode-bridge"; import * as VscodeBridge from "./src/ide/vscode-bridge"; const tools=(await VscodeBridgePlugin({})).tool; const filePath="F:/fixture/assignment.ipynb"; const context={directory:"F:/fixture",worktree:"F:/fixture",sessionID:"ses_repro",messageID:"msg_repro",agent:"build",abort:new AbortController().signal,metadata(){},async ask(){}}; const bridge=spyOn(VscodeBridge,"callBridge"); for(const name of ["run","output"]){const cell={i:1,id:"imports",exec:"succeeded",existing_outs:[],artifacts:[]}; bridge.mockResolvedValue({ran:name==="run",summary:"original IDE summary",data:name==="run"?{path:filePath,completed:true,cells:[cell]}:{path:filePath,cell,artifacts:[]}}); try {const result=await tools[`vscode_notebook_${name}`].execute({filePath,cellId:"imports"},context); console.log(JSON.stringify({tool:name,output:result.output}));} catch(error){console.log(JSON.stringify({tool:name,error:error.issues}));}} bridge.mockRestore();'
```

```json
{"tool":"run","error":[{"expected":"number","code":"invalid_type","path":[],"message":"Invalid input: expected number, received undefined"}]}
{"tool":"output","error":[{"expected":"number","code":"invalid_type","path":[],"message":"Invalid input: expected number, received undefined"}]}
```

**R2，cwd sdks/vscode，退出0。** 完整真实注册/发现探针由审查任务 `ses_ddca231feffelDqb0Mkh2afiRc` 执行，下面保留原命令：

```powershell
bun -e '
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { mock } from "bun:test";
const root = await fs.mkdtemp("D:/Temp/opencode/notebook-registry-audit-");
const previousRegistry = process.env.OPENCODE_IDE_REGISTRY_DIR;
const env = { sessionId: "", appName: "Isolated bridge audit", remoteName: undefined };
const vscode = { env, workspace: { workspaceFolders: [{ name: "audit", uri: { fsPath: root, toString: () => pathToFileURL(root).toString() } }], notebookDocuments: [] }, window: {}, extensions: { getExtension() { return undefined; } } };
let bridgeModule;
try {
  mock.module("vscode", () => ({ default: vscode, ...vscode }));
  mock.module(path.resolve("../../packages/core/src/global.ts"), () => ({ Global: { Path: { state: root } } }));
  bridgeModule = await import("./src/bridge.ts");
  const client = await import("../../packages/core/src/ide/vscode-bridge.ts");
  const uuid = "11111111-1111-4111-8111-111111111111";
  for (const testcase of [{ name: "pure-uuid", sessionId: uuid, expected: 1 }, { name: "uuid-plus-timestamp", sessionId: uuid + Date.now(), expected: 0 }]) {
    const registry = path.join(root, testcase.name);
    process.env.OPENCODE_IDE_REGISTRY_DIR = registry;
    env.sessionId = testcase.sessionId;
    let info;
    try {
      info = await bridgeModule.activateBridge({ appendLine() {} });
      const health = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(2000) });
      assert.equal(health.status, 200); await health.json();
      const filenames = await fs.readdir(registry);
      assert.deepEqual(filenames, [testcase.sessionId + ".json"]);
      const manifest = JSON.parse(await fs.readFile(path.join(registry, filenames[0]), "utf8"));
      assert.equal(manifest.id, testcase.sessionId); assert.equal(manifest.port, info.port); assert.equal(manifest.token, info.token); assert.equal(manifest.pid, process.pid);
      const live = await client.discoverBridges({ cwd: root });
      assert.equal(live.length, testcase.expected);
      if (testcase.expected) assert.equal(live[0].id, testcase.sessionId);
      let resolution = "resolved";
      try { await client.resolveBridge({ cwd: root, filePath: path.join(root, "book.ipynb") }); } catch (error) { resolution = error.message; }
      assert.equal(resolution, testcase.expected ? "resolved" : "No live VS Code bridge found. Open this workspace in VS Code or launch opencode from the VS Code extension.");
      console.log(JSON.stringify({ case: testcase.name, health: health.status, realProducerWroteExpectedFilename: true, manifestIdentityPortAndTokenMatchListener: true, discoverCount: live.length, resolution }));
    } finally {
      await bridgeModule.closeBridge(); assert.deepEqual(await fs.readdir(registry), []);
      if (info) {
        const closed = await new Promise((resolve, reject) => {
          const socket = net.createConnection({ host: "127.0.0.1", port: info.port }); socket.setTimeout(2000);
          socket.once("connect", () => { socket.destroy(); resolve(false); });
          socket.once("error", (error) => error.code === "ECONNREFUSED" ? resolve(true) : reject(error));
          socket.once("timeout", () => { socket.destroy(); reject(new Error("Listener-close verification timed out")); });
        }); assert.equal(closed, true);
      }
      console.log(JSON.stringify({ case: testcase.name, registryRemovedByCloseBridge: true, listenerClosed: true }));
    }
  }
} finally {
  try { await bridgeModule?.closeBridge(); } finally {
    if (previousRegistry === undefined) delete process.env.OPENCODE_IDE_REGISTRY_DIR; else process.env.OPENCODE_IDE_REGISTRY_DIR = previousRegistry;
    mock.restore(); await fs.rm(root, { recursive: true, force: true });
    console.log("CLEANUP: closeBridge completed; registry env restored; mock.restore called; isolated test directory removed; module mocks confined to this exiting child process.");
  }
}'
```

输出为纯UUID `health=200, discoverCount=1, resolution=resolved`；UUID加时间戳 `health=200, discoverCount=0, resolution=No live VS Code bridge found...`；两组均 `registryRemovedByCloseBridge=true, listenerClosed=true`。断言测试当前错误行为，修复后的验收必须两组都可发现实际独立UUID。

**R3，cwd sdks/vscode，退出0。** 审查任务 `ses_ddca23240ffej1RI9cM6y3vaYe` 重新运行两套完整固定树及相对依赖：

```powershell
bun -e @'
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import { posix } from "node:path";
const repo = "F:/ML/PythonAIProject/Claude-Code/opencode";
const revisions = [["source", "26061b595b3140d37717248222c7ed2016421db0"], ["target", "53ec198de854db5c0318706f5f62946a087398b9"]];
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
const modules = new Map();
async function moduleURL(revision, file) {
  const key = `${revision}:${file}`; if (modules.has(key)) return modules.get(key);
  const blob = Bun.spawnSync(["git", "show", key], { cwd: repo }); assert.equal(blob.exitCode, 0, blob.stderr.toString());
  let js = transpiler.transformSync(blob.stdout.toString());
  for (const match of [...js.matchAll(/from\s+["'](\.[^"']+)["']/g)]) {
    const dependency = posix.normalize(posix.join(posix.dirname(file), match[1])) + ".ts";
    js = js.replace(match[0], "from " + JSON.stringify(await moduleURL(revision, dependency)));
  }
  const url = "data:text/javascript;base64," + Buffer.from(js).toString("base64"); modules.set(key, url); return url;
}
let notebook, targetCell, insertBefore, nativeCalls, executedOriginal;
const listeners = new Set();
const uri = value => ({ scheme: "file", fsPath: value.split("#")[0], fragment: value.split("#")[1] ?? "", toString: () => `file://${value}` });
function cell(name, kind = 2) {
  const value = { notebook, kind, metadata: {}, outputs: [], executionSummary: undefined, document: { uri: uri(`/audit/fixture.ipynb#${name}`), languageId: kind === 2 ? "python" : "markdown", lineCount: 1, version: 1, getText: () => name } };
  Object.defineProperty(value, "index", { get: () => notebook.cells.indexOf(value) }); return value;
}
const vscode = {
  NotebookCellKind: { Markup: 1, Code: 2 }, NotebookRange: class { constructor(start, end) { this.start = start; this.end = end; } },
  workspace: { notebookDocuments: [], onDidChangeNotebookDocument(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; } },
  window: { async showNotebookDocument(document) {
    assert.equal(document, notebook); await Promise.resolve();
    if (insertBefore) { notebook.cells.unshift(cell("unrelated-markdown", 1)); notebook.version++; notebook.isDirty = true; }
    return { notebook, selection: undefined, revealRange() {} };
  } },
  commands: { async getCommands() { return ["notebook.cell.execute"]; }, async executeCommand(command, args) {
    assert.equal(command, "notebook.cell.execute"); assert.equal(args.document, notebook.uri); nativeCalls++;
    const selected = notebook.cellAt(args.ranges[0].start); assert.equal(selected, targetCell); executedOriginal = true;
    selected.executionSummary = { success: true, executionOrder: 1, timing: { startTime: 1, endTime: 2 } }; notebook.version++;
    for (const listener of [...listeners]) listener({ notebook, cellChanges: [{ cell: selected, executionSummary: selected.executionSummary }] });
  } },
};
mock.module("vscode", () => ({ default: vscode, ...vscode }));
for (const [label, revision] of revisions) {
  const { runNotebook } = await import(await moduleURL(revision, "sdks/vscode/src/notebook/run.ts"));
  const { copilotLikeCellId } = await import(await moduleURL(revision, "sdks/vscode/src/notebook/format.ts"));
  for (const insertion of [false, true]) {
    listeners.clear(); insertBefore = insertion; nativeCalls = 0; executedOriginal = false;
    notebook = { uri: uri("/audit/fixture.ipynb"), metadata: {}, version: 1, isClosed: false, isDirty: false, cells: [], get cellCount() { return this.cells.length; }, getCells() { return this.cells; }, cellAt(index) { return this.cells[Math.max(0, Math.min(index, this.cells.length - 1))]; } };
    targetCell = cell("target"); notebook.cells = [targetCell]; vscode.workspace.notebookDocuments = [notebook];
    const id = copilotLikeCellId(targetCell); let completed = false, error = null;
    try { completed = (await runNotebook({ filePath: notebook.uri.fsPath, cellId: id, timeoutMs: 1000 })).data.completed; } catch (cause) { error = cause.message; }
    const rejected = label === "target" && insertion;
    assert.equal(completed, !rejected); assert.equal(error, rejected ? "Notebook changed before execution; select the target cells again" : null);
    assert.equal(nativeCalls, rejected ? 0 : 1); assert.equal(executedOriginal, !rejected); assert.equal(copilotLikeCellId(targetCell), id);
    assert.equal(targetCell.index, insertion ? 1 : 0); assert.equal(notebook.getCells()[targetCell.index], targetCell); assert.equal(listeners.size, 0);
    console.log(JSON.stringify({ label, insertion, completed, nativeCalls, executedOriginal, sameCellID: true, targetIndex: targetCell.index, error }));
  }
}
'@
```

实际4组：source/no insertion与source/insertion、target/no insertion均completed=true/nativeCalls=1；target/insertion为completed=false/nativeCalls=0且上述changed错误。四组sameCellID=true，移位后targetIndex=1，无残余listener。

**R4，cwd repo，退出0。** 实际openTerminal函数，终端API和process.env为合成输入，不声称真实终端/activate验收。

```powershell
bun -e 'import {execFileSync} from "node:child_process";for(const revision of ["26061b595b","53ec198de8"]){const source=execFileSync("git",["show",revision+":sdks/vscode/src/extension.ts"],{encoding:"utf8"}).replace(/^import .*\r?\n/gm,"").replace(/^export /gm,"");let options;const vscode={Uri:{file:x=>x},ViewColumn:{Beside:2},window:{createTerminal:x=>{options=x;return{show(){},sendText(){}}}}};const open=new Function("vscode","registryDir","process",new Bun.Transpiler({loader:"ts"}).transformSync(source)+";return openTerminal;")(vscode,()=>"synthetic-registry",{env:{}});await open({asAbsolutePath:x=>x},Promise.resolve());const settings={OPENCODE_SERVER_USERNAME:"configured-user",OPENCODE_SERVER_PASSWORD:"synthetic-setting"};const terminalEnv={...settings,...options.env};console.log(JSON.stringify({revision,explicitCredentialKeys:Object.keys(options.env).filter(k=>k.startsWith("OPENCODE_SERVER_")),retainsConfiguredPassword:terminalEnv.OPENCODE_SERVER_PASSWORD===settings.OPENCODE_SERVER_PASSWORD,retainsConfiguredUsername:terminalEnv.OPENCODE_SERVER_USERNAME===settings.OPENCODE_SERVER_USERNAME,emptyPassword:terminalEnv.OPENCODE_SERVER_PASSWORD===""}));}'
```

实际source保留username/password且emptyPassword=false；target不保留两者且emptyPassword=true。终端先settings后TerminalOptions.env的合并顺序对应VS Code 1.94.0 terminalEnvironment.ts:296-298。

**R5/R8，cwd sdks/vscode，退出0。** 审查任务 `ses_ddca22b71ffeQjMLWZcctzlYGc` 本轮重跑；原生命令如下，包含真实10秒计时，不替换timer。

```powershell
@'
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
const root = "F:/ML/PythonAIProject/Claude-Code/opencode";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const head = git("rev-parse", "HEAD").trim(); console.log(JSON.stringify({ head, bun: Bun.version, typescript: ts.version }));
function fixture(initial, delayed = false) {
  let text = initial, pending, applies = 0;
  const textListeners = new Set(), notebookListeners = new Set(), ready = Promise.withResolvers();
  const uri = value => ({ fsPath: value.split("#")[0], fragment: value.split("#")[1] ?? "", toString: () => value });
  const document = { uri: uri("/fixture.ipynb#cell"), languageId: "python", eol: 1, version: 1, getText: () => text, get lineCount() { return text.split("\n").length; }, lineAt: index => ({ text: text.split("\n")[index], range: { end: {} } }) };
  const cell = { index: 0, kind: 2, metadata: {}, outputs: [], document };
  const notebook = { uri: uri("/fixture.ipynb"), metadata: {}, isDirty: true, version: 1, cells: [cell], get cellCount() { return this.cells.length; }, getCells() { return this.cells; }, cellAt(index) { assert.ok(this.cells[index]); return this.cells[index]; } };
  function subscribe(set, listener) { set.add(listener); ready.resolve(); return { dispose: () => set.delete(listener) }; }
  function flush() {
    const edit = pending; pending = undefined;
    for (const entry of edit.entries) {
      if (entry.type === "text") { text = entry.text; document.version++; for (const listener of textListeners) listener({ document }); }
      else { for (const change of entry.edits) { const removed = notebook.cells.splice(change.range.start, change.range.end - change.range.start); removed.forEach(cell => { cell.index = -1; }); }
        notebook.cells.forEach((cell, index) => { cell.index = index; }); notebook.version++; for (const listener of notebookListeners) listener({ notebook }); }
    }
  }
  const vscode = {
    NotebookCellKind: { Markup: 1, Code: 2 }, EndOfLine: { LF: 1, CRLF: 2 }, Position: class {}, Range: class {},
    NotebookRange: class { constructor(start, end) { Object.assign(this, { start, end }); } }, NotebookEdit: { deleteCells: range => ({ range }) },
    WorkspaceEdit: class { entries = []; replace(uri, range, text) { this.entries.push({ type: "text", uri, text }); } set(uri, edits) { this.entries.push({ type: "notebook", uri, edits }); } },
    window: {}, workspace: { notebookDocuments: [notebook], openNotebookDocument: async () => { throw new Error("Unexpected real document access"); },
      applyEdit: async edit => { applies++; pending = edit; if (!delayed) flush(); return true; },
      onDidChangeTextDocument: listener => subscribe(textListeners, listener), onDidChangeNotebookDocument: listener => subscribe(notebookListeners, listener) },
  };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const compiled = ts.transpileModule(git("show", `${head}:${file}`), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const localRequire = name => name === "vscode" ? vscode : name.startsWith(".") ? load(path.posix.join(path.posix.dirname(file), name) + ".ts") : require(name);
    new Function("require", "module", "exports", compiled)(localRequire, module, module.exports); return module.exports;
  }
  const { editNotebook } = load("sdks/vscode/src/notebook/edit.ts");
  return { edit: (args, signal) => editNotebook({ filePath: "/fixture.ipynb", cellId: "cell", editType: "edit", ...args }, signal), ready: ready.promise, flush, document, notebook, listeners: () => textListeners.size + notebookListeners.size, applies: () => applies };
}
const nested = fixture("if ready:\n    old()\n");
const result = await nested.edit({ oldCode: "  old()  ", newCode: "if ok:\n    new()" });
const expected = "if ready:\n    if ok:\n        new()\n", actual = nested.document.getText();
assert.match(result.summary, /\(line-trimmed\)/); assert.equal(actual, "if ready:\n    if ok:\n    new()\n"); assert.notEqual(actual, expected);
console.log(JSON.stringify({ case: "nested-indentation", strategy: "line-trimmed", expected, actual, flattened: true }));
async function cancelledWait(kind, completion) {
  const f = fixture("old", true), controller = new AbortController(); let state = "pending";
  const settled = f.edit(kind === "text" ? { newCode: "new" } : { editType: "delete" }, controller.signal).then(value => { state = "fulfilled"; return { state, applied: value.data.applied }; }, error => { state = "rejected"; return { state, error: error.message }; });
  await f.ready; controller.abort(new Error("fixture cancellation")); await new Promise(resolve => setImmediate(resolve));
  const afterAbort = { aborted: controller.signal.aborted, state, listeners: f.listeners(), applyCalls: f.applies() };
  assert.deepEqual(afterAbort, { aborted: true, state: "pending", listeners: 1, applyCalls: 1 });
  if (completion === "matching-event") f.flush();
  const outcome = await settled; assert.equal(outcome.state, completion === "matching-event" ? "fulfilled" : "rejected");
  if (completion === "timeout") assert.match(outcome.error, /^Timed out waiting for VS Code/);
  assert.equal(f.listeners(), 0);
  return { case: `cancelled-${kind}-wait`, completion, afterAbort, outcome, listenersAfterSettlement: f.listeners(), source: f.document.getText(), cellCount: f.notebook.cellCount };
}
const checks = await Promise.all([cancelledWait("text", "matching-event"), cancelledWait("structure", "matching-event"), cancelledWait("text", "timeout"), cancelledWait("structure", "timeout")]);
checks.forEach(check => console.log(JSON.stringify(check)));
console.log("PASS: both defects reproduced; native 10000ms timers were not replaced.");
'@ | bun -
```

实际结果：nested actual为`if ready:\n    if ok:\n    new()\n`，expected子句有8空格；四个取消场景afterAbort均为`{aborted:true,state:pending,listeners:1,applyCalls:1}`；两个matching-event随后fulfilled，另两个到10秒才以同步超时rejected，settlement后listeners=0。这是取消未生效的原始坏行为，非通过验收。

**R6，cwd packages/opencode，退出0；真实HTTP与实际client。**

```powershell
bun -e 'import fs from "node:fs/promises"; import path from "node:path"; import assert from "node:assert/strict"; import { pathToFileURL } from "node:url"; import { VscodeBridge } from "@opencode-ai/core/ide/vscode-bridge"; const dir = await fs.mkdtemp("D:/Temp/opencode/notebook-range-plan-"); const previous = process.env.OPENCODE_IDE_REGISTRY_DIR; const filePath = path.join(dir,"probe.ipynb"); const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){ if(new URL(req.url).pathname === "/health") return Response.json({ok:true}); const body=await req.json(); await new Promise(resolve=>setTimeout(resolve,body.timeoutMs*0.75)); await new Promise(resolve=>setTimeout(resolve,body.timeoutMs*0.75)); return Response.json({ran:true,summary:"two cells completed",data:{completed:true}}); }}); try {process.env.OPENCODE_IDE_REGISTRY_DIR=dir; await fs.writeFile(filePath,"{}"); await fs.writeFile(path.join(dir,"11111111-1111-1111-1111-111111111111.json"),JSON.stringify({schema:1,id:"11111111-1111-1111-1111-111111111111",pid:process.pid,host:"127.0.0.1",port:server.port,token:"fixture",transport:"http",ideKind:"vscode",ideName:"fixture",createdAt:Date.now(),updatedAt:Date.now(),workspaceFolders:[{name:"fixture",fsPath:dir,uri:pathToFileURL(dir).href}]})); const started=performance.now(); await assert.rejects(VscodeBridge.callBridge({cwd:dir,filePath,path:"/notebook/run",body:{filePath,cellId:"TOP",endCellId:"BOTTOM",timeoutMs:80},timeoutMs:80})); console.log(JSON.stringify({baseline:"range failed before two valid per-cell intervals completed",elapsedMs:Math.round(performance.now()-started)})); const response=await fetch(`http://127.0.0.1:${server.port}/notebook/run`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({timeoutMs:80}),signal:AbortSignal.timeout(1000)}); assert.equal((await response.json()).data.completed,true); console.log("Owner-controlled range plus caller abort: PASS");} finally {await server.stop(true); if(previous===undefined)delete process.env.OPENCODE_IDE_REGISTRY_DIR; else process.env.OPENCODE_IDE_REGISTRY_DIR=previous; await fs.rm(dir,{recursive:true,force:true});}'
```

实际输出`baseline=range failed before two valid per-cell intervals completed, elapsedMs=84`；`Owner-controlled range plus caller abort: PASS`。服务端延迟fixture只证明transport预算冲突；原SDK的逐格timer另由现有run测试覆盖。

**R7候选关键假设，cwd sdks/vscode，退出0。**

```powershell
bun -e 'import { URI } from "vscode-uri"; const values = ["C:\\work\\a b.ipynb", "C:/work/a b.ipynb", "file:///C:/work/a%20b.ipynb", "file:///c:/work/a%20b.ipynb"]; for (const value of values) console.log(JSON.stringify({ input: value, key: (/^[a-zA-Z]:[\\/]/.test(value) ? URI.file(value) : URI.parse(value)).toString() }));'
```

四者实际key均为`file:///c%3A/work/a%20b.ipynb`。此项证明规范化假设；锁错误的正式红绿必须经真实HTTP并且先证明两种路径可解析同一文档。

## 9. Responsibility and Seam

程序合同只由真实 Execute 消费；Notebook 插件控制是否生成其投影，registry控制是否校验，保留其他插件普通调用已有的原始program值。桥接注册身份和文档锁归SDK HTTP owner；终端环境归extension；范围总期限归两代共用的Core Bridge客户端；缩进和编辑同步归edit，不改变内核或Session调度。

## 10. Single Approved Primary-Path Design

1. **程序消费限定。** packages/plugin ToolContext 声明已由宿主传递的可选 executeParent。notebookResult 接收该现存上下文；先构造原 output/metadata，当 executeParent 缺省时直接返回，只有真实子调用才读取 data、运行原 program 投影并附加 program。六个入口传入现有 context。registry 保留已有 program，只在 toolCtx.executeParent 存在且有 output schema 时执行 parse；直接调用不校验程序结果。无 catch/default，无旧格式重建；不改输入和权限，不加调用模式参数或配置。
2. **注册回退。** startBridge 使用独立 randomUUID 生成 id，注册和 /manifest 使用同一个 id；删除 env.sessionId/port 后备注册路径，发现过滤器不变。
3. **格身份。** 删除 positions，前置校验改为 notebook.getCells()[cell.index] === cell，与执行期间已有身份检查一致；删除/替换/关闭仍拒绝，原生命令读取最新索引。
4. **环境回退。** 删除 extension 的两个 OPENCODE_SERVER_USERNAME/PASSWORD 覆盖字段，恢复旧主线继承方式。
5. **缩进。** migrateIndent 非空行统一返回 targetIndent + line.slice(srcBase.length)，公共前缀为空时 slice(0) 保留嵌套；保留空行原样和三种原匹配策略，不加匹配条件。
6. **范围期限。** callBridgeOnce 对 /notebook/run 且有字符串 endCellId 的请求，不安装额外HTTP总计时器，交给SDK已有逐格deadline和调用方AbortSignal。复用内部 timeoutMs=0 表示无额外timer，fetchWithTimeout在0时不建timer并照常订阅/释放abort。其他请求（含单格、health）原期限不变；不预读summary、不猜格数、不延长固定倍数、不重试。SDK自己的逐格超时和首失败停止完整保留。
7. **锁身份。** withFileLock 的 key 改为 uriFromInput(filePath).toString()，复用已经负责Windows盘符和URI解析的唯一函数。读取与stop/info旁路不变，create不存在路径也能规范化，不为取锁预先打开文件，不增加锁表或realpath读取。
8. **编辑取消。** 把既有可选signal依次传入delete/insert/edit/type-change/string-edit及两个apply/wait辅助函数。等待器入口先throwIfAborted，覆盖applyEdit期间已取消和无版本变化的快路径；等待中注册abort listener，以signal.reason拒绝并复用finish清理timer、文档listener和abort listener。resolve/reject/abort都清理。取消不撤销已应用编辑；等待拒绝后不继续后续显式save。实际applyEdit由VS Code拥有，不声称能撤销其已提交操作，不新建命令竞速器。

用户精确回退授权为“把相应的逻辑精准修改成我们之前在 DEV 的那个主分支里面的逻辑”。R2/R4直接恢复源行为；R1普通入口恢复旧output交付，Execute子入口保留配套新合同，选择由调用上下文决定而非失败后切换。R3保持真实目标身份检查但移除旧位置约束。其余旧缺陷没有可回退的正确实现，按现有owner定点修复。

## 11. Secondary and Replacement Path Inventory

| Path | Class | Success | Disposition |
| --- | --- | --- | --- |
| 普通原output与显式Execute程序输出 | explicit user-requested rollback / primary-contract branch | 是 | 根据现存父调用身份选择，非失败fallback |
| 3种已有编辑匹配策略、已有ID别名 | existing compatibility | 是 | 保持 |
| 单格transport deadline与范围SDK逐格deadline | primary-contract branch | 是 | 按真实请求目标选择；用户取消通用 |
| 读取、stop/info锁旁路 | primary-contract branch | 是 | 保持 |
| 补缺字段、协议探测、重试、替代写法 | forbidden fallback / out of scope | 不新增 | 拒绝 |

新增诊断分支为零，无新增失败后备用成功路径。

## 12. Workaround Deletion and Replacement

移除普通调用的程序投影/parse前提、sessionId注册替代路径、旧索引数组、默认认证覆盖、逐行trimStart、范围单格总deadline以及锁的raw字符串身份。现有错误恢复文案、输入/权限校验、超时/取消资源释放不被删除。

## 13. Forward Traceability

| Requirement | Production file/change | Existing test seam |
| --- | --- | --- |
| R1 | plugin/src/tool.ts、opencode plugin/vscode-bridge.ts、tool/registry.ts | plugin/vscode-bridge.test.ts旧响应普通输出；tool/registry.test.ts普通结果与嵌套parse |
| R2 | SDK bridge.ts id | ide/vscode-bridge.test.ts真实activate/register/discover；复用现有worker |
| R3 | SDK run.ts身份校验 | plugin/vscode-notebook-tool-summary.test.ts现有run场景加无关插格 |
| R4 | SDK extension.ts env | 同ide测试worker实际扩展activate/openNewTerminal捕获env |
| R5 | SDK edit.ts migrateIndent | notebook summary测试的编辑场景，断言完整预期源码 |
| R6 | Core ide/vscode-bridge.ts timer | ide/vscode-bridge.test.ts真实HTTP范围超过单格transport期限，并保留单格/abort检查 |
| R7 | SDK bridge.ts lock key | 既有native disconnect worker将排队edit改用同文件file URI，最终源码仍无cancelled格 |
| R8 | SDK edit.ts signal等待 | 同notebook测试fixture延迟版本事件，结构/文本等待取消后检查订阅释放与取消原因 |

## 14. Reverse Traceability

仅新增signal透传和两个等待器abort订阅（R8，复用现有finish）；仅声明现有executeParent类型并按其限定投影（R1，既有字段未在插件类型声明）；内部0期限只省略范围总timer（R6，SDK已有独立timer）。UUID、URI规范化、身份校验和缩进均复用现成函数/变量。无新helper、状态机、配置、依赖、业务字段。

## 15. File-Level Change Plan

| File | Change | Estimated added+deleted |
| --- | --- | --- |
| packages/plugin/src/tool.ts | 现存上下文类型1字段 | 1-3 |
| packages/opencode/src/plugin/vscode-bridge.ts | 普通投影early return及context透传 | 25-45 |
| packages/opencode/src/tool/registry.ts | 程序parse条件 | 2-6 |
| packages/core/src/ide/vscode-bridge.ts | 范围总timer移除、取消保留 | 8-16 |
| sdks/vscode/src/bridge.ts | 独立UUID与规范锁键 | 12-22 |
| sdks/vscode/src/extension.ts | 删除凭证覆盖 | 2 |
| sdks/vscode/src/notebook/run.ts | 删除positions，按对象校验 | 5-10 |
| sdks/vscode/src/notebook/edit.ts | 缩进及取消传递/等待清理 | 70-115 |
| 上述4个现有opencode测试文件 | 最小扩充，保留原有断言 | 预计 <=250，非生产预算 |
| 本plan | 审计与验证记录 | 文档，不计生产 |

## 16. TDD Behavior Slices

按R1、R2/R4/R7、R3、R5、R6、R8顺序逐片实施。先修改对应现有测试（有必要时每个功能最多一个新增test），运行并记录基线红，再实现和复跑。R2/R4/R7复用同一个真实HTTP worker覆盖实际入口，避免另造测试文件。worker的URI fixture复用已安装vscode-uri实现file/parse/joinPath，并用两种表示读取同一文档成功后再进行并发排队断言，避免无法解析URI产生假绿。R8可在一项test内分别覆盖文本和结构等待。测试使用实际工具/handler、真实HTTP及现有VS Code fixture，不测试源码文本或私有函数，不全仓改测试。

## 17. Comments

仅为普通/Execute程序消费边界和范围deadline所有权写必要短注释；编辑清理代码无需重复动作注释。不补注释配额，不改不相关旧注释。

## 18. Verification

| Command | cwd | Purpose |
| --- | --- | --- |
| bun test test/plugin/vscode-bridge.test.ts test/tool/registry.test.ts --timeout 30000 | packages/opencode | 普通/程序结果及原插件回归 |
| bun test test/ide/vscode-bridge.test.ts test/plugin/vscode-notebook-tool-summary.test.ts --timeout 30000 | packages/opencode | SDK/HTTP八项行为与原回归 |
| bun test test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts test/session/execute.test.ts test/session/tools.test.ts --timeout 30000 | packages/opencode | 显式Execute消费仍可用 |
| bun test test/tool-notebook.test.ts --timeout 30000 | packages/core | V2共用客户端、权限和完整原响应 |
| bun typecheck | packages/opencode、packages/core、packages/plugin | 相关类型合同 |
| bun run check-types && bun run lint && bun run package | sdks/vscode | SDK类型、lint和bundle |
| git diff --check；git diff --numstat 53ec198de8 -- <8个生产文件> | repo | 机械检查、累计生产增删<=320 |

真实用户Notebook不运行；以隔离fixture验证同一原始故障响应及所有修复。真实已安装旧扩展与当前运行进程不会被自动更新，因此不能声称本次commit已热修用户环境。默认保留现有包测试时限，不跳过失败。

## 19. Diff Budget

生产8文件，预计125-219行增删，硬上限320；测试0新文件，预计4现有文件、最多每项一条新增test；文档仅本plan；无生成源码或配置修改。构建产物只用于验证，不提交。每轮审计前通过git统计实际生产总量。

## 20. Real Risks and Open Decisions

范围请求取消仍依赖调用方signal；SDK逐格deadline继续停止范围，不自动interrupt运行中的内核。取消编辑不回滚VS Code已接受操作。程序合同仍约束显式Execute嵌套调用，旧SDK嵌套不做自动转换。路径锁覆盖URI规范等价写法，不新增符号链接/文件系统大小写推断。

Open decisions: 无需用户重新决定实现方式，按限定owner和范围推进。

Follow-up: 上次审查第五、第六项明确排除；扩展安装/发布、协议协商、真实远程内核矩阵不在本任务；未修改。

Rejected speculation: 不为未出现的输出类型/URI协议添加新分支，不为未取消的pending VS Code命令增加重试、自动重启或撤销。

## 21. Audit Contract

按workflow独立完整审计用户原文、固定基线到当前revision的全部设计/差异及必要上下游。主线程仅发送原文、plan路径、repo和mode；实施审计另给实际文件清单/diff。满足No blocking findings和APPROVE才推进。源码修正只由主线程实施。

## 22. Revision Delta and Plan Audit Record

R2仅补充第8.1节完整方案阶段命令/输入/结果，明确第16节URI fixture必须真正解析到同一文档。八项生产设计、接口和文件范围不变，未增加生产概念。

| Round | Revision | Full scope | Findings | Verdict | Task |
| --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 Blocking；N-01 Non-blocking | BLOCK | ses_ddc58a861ffeB6LbCQ9V0SY2JB |
| 2 | R2 | yes | No blocking findings；B-01已解决；N-01已处理 | APPROVE | ses_ddc58a861ffeB6LbCQ9V0SY2JB |

首轮原样记录：

> B-01 方案阶段的原始故障验证仍只有结论，无法独立核验
>
> Minimal correction direction: 将已有隔离实验的完整调用、输入、实际结果和基线身份补入 canonical plan 或其可直接读取的证据记录；已有结果可复用，无需增加生产逻辑或测试文件。
>
> N-01 R7 的现有 worker 存在假绿入口
>
> 第 16 节已经要求修复前观察有效红测，因此这里保留为实施核对项：该验证必须证明两种表示确实到达同一文档，失败原因确实是锁身份分裂。
>
> **BLOCK — `notebook-targeted-regression-repair.md`，R1，首轮全范围方案审计。**
>
> 阻断项为 **B-01**。八项生产修复方向无需因此扩展；补齐方案阶段的可核验证据后，再对完整 revision 复审。

第二轮原样记录：

> No blocking findings.
>
> **B-01 已解决。** 第 8.1 节补齐了实验工作目录、完整命令、输入、结果及固定基线。R1 的旧响应明确缺少 `outputCount`，记录的错误与实际投影路径吻合；R2—R8 的实验也明确区分了真实实现、API fixture 和验证范围。
>
> **N-01 已在方案中处理。** 第 16 节明确使用现有 `vscode-uri` 实现，并先验证两种路径表示都能读取同一文档，再检查并发排队行为。
>
> **APPROVE — `docs/plans/notebook-targeted-regression-repair.md`，R2，第二轮全范围方案审计。**
>
> 批准仅适用于当前 R2，固定实施前基线为 `53ec198de854db5c0318706f5f62946a087398b9`。记录本次完整结论后，可按该 revision 实施；完成和提交仍须满足计划中的验证及独立实现审计门禁。

## 23. Implementation Evidence

### Actual Files and Diff

八个生产文件与第15节完全一致，增删共 **123** 行（新增68、删除55）。四个原有测试文件增删164行（新增137、删除27），只新增2项test：范围transport和编辑取消；其余复用/扩充原断言，无新增测试文件。本plan是唯一新增文档。SDK构建产物未纳入提交。

| Production file | Added | Deleted | 必要性 |
| --- | --- | --- | --- |
| packages/core/src/ide/vscode-bridge.ts | 6 | 2 | 范围请求不叠加单格总deadline，调用方abort不变 |
| packages/opencode/src/plugin/vscode-bridge.ts | 14 | 12 | 普通输出先返回，仅子调用产生程序投影 |
| packages/opencode/src/tool/registry.ts | 6 | 4 | 程序schema仅在Execute消费时校验 |
| packages/plugin/src/tool.ts | 1 | 0 | 声明宿主已有executeParent字段 |
| sdks/vscode/src/bridge.ts | 5 | 5 | UUID恢复及既有URI函数生成锁键 |
| sdks/vscode/src/extension.ts | 0 | 2 | 删除认证环境覆盖 |
| sdks/vscode/src/notebook/edit.ts | 35 | 26 | 相对缩进和原signal透传到等待器 |
| sdks/vscode/src/notebook/run.ts | 1 | 4 | 删除旧索引数组，保留同格身份检查 |

为满足既有圈复杂度门禁，registry在原execute闭包先选用outputSchema，Effect generator仍用原parse分支；范围期限由同一Core客户端的callBridge包装器预备后传入callBridgeOnce。条件、owner、输入/输出行为均与第10节相同，没有新增helper或路径。

完整生产diff留存：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_223c42cbb001THVVuuZqEvwgP5`。完整测试diff：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_223c42c92001fnXTA4XVCZhT9J`。权威比较仍为固定基线到当前工作树的限定路径git diff。

### Red-Green Test Evidence

所有下列bun test命令cwd为packages/opencode，使用`--timeout 30000`。

| Slice | Narrow command / actual red | Green |
| --- | --- | --- |
| R1 | `bun test test/plugin/vscode-bridge.test.ts test/tool/registry.test.ts --timeout 30000 --test-name-pattern 'keeps notebook output metadata|preserves attachments from structured custom tool results'`；2 fail，分别为缺outputCount和普通program字符串被number schema拒绝 | 两文件完整32 pass，原附件断言及嵌套校验保留 |
| R2/R4 | `bun test test/ide/vscode-bridge.test.ts --timeout 30000 --test-name-pattern 'native HTTP disconnect'`；先认证覆盖true!=false，删除覆盖后发现数0!=1 | 独立UUID修正后原生启动/发现/终端及取消场景通过 |
| R7 | 同一worker的排队edit改为file URI前，两种路径summary的data已核对相同；红测最终多出cancelled格 | 规范锁键后完整ide套件通过，取消格不写入 |
| R3 | `bun test test/plugin/vscode-notebook-tool-summary.test.ts --timeout 30000 --test-name-pattern 'run proceeds when kernel'`；原格前插Markdown触发changed拒绝 | 原目标仍执行，返回i=3；run相关5 pass |
| R5 | `bun test test/plugin/vscode-notebook-tool-summary.test.ts --timeout 30000 --test-name-pattern 'string-match edit summary'`；new()实际4空格、预期8空格 | edit/insert/delete相关12 pass |
| R6 | `bun test test/ide/vscode-bridge.test.ts --timeout 30000 --test-name-pattern 'range requests'`；单格期限结束后range已AbortError | 范围正常交付，单格仍超时、调用方取消仍拒绝；完整ide 11 pass |
| R8 | `bun test test/plugin/vscode-notebook-tool-summary.test.ts --timeout 30000 --test-name-pattern 'cancelling an accepted edit'`；取消后等10010ms收到同步超时而非取消reason | 文本/结构均返回原取消reason并释放订阅、不执行save；完整handler 41 pass |

测试fixture首次构建暴露Bun不解析file URL import，改用fileURLToPath；实际vscode-uri在Windows生成反斜杠fsPath，因此补齐fixture的openNotebookDocument，只接受规范URI等价的同一文档。两次属于fixture前置错误，未当作产品红测。范围测试最初固定sleep被既有guard拒绝，改为等待真实单格请求deadline作为同步信号，未放宽规则。registry/transport的条件起初使大函数CC增加，移到已有调用包装器的准备步骤，guard随后无error。

### Verification Commands and Results

| cwd | Command | Result |
| --- | --- | --- |
| packages/opencode | `bun test test/plugin/vscode-bridge.test.ts test/tool/registry.test.ts test/ide/vscode-bridge.test.ts test/plugin/vscode-notebook-tool-summary.test.ts --timeout 30000` | 84 pass，0 fail，322 assertions |
| packages/core | `bun test test/tool-notebook.test.ts --timeout 30000` | 2 pass，0 fail，127 assertions |
| packages/opencode | `bun test test/tool/code-mode.test.ts --timeout 30000` | 67 pass，0 fail，556 assertions |
| packages/opencode | `bun test test/tool/code-mode-integration.test.ts --timeout 30000` | 16 pass，0 fail，74 assertions |
| packages/opencode | `bun test test/session/execute.test.ts --timeout 30000` | 80 pass，0 fail，779 assertions，198.61s |
| packages/opencode | `bun test test/session/tools.test.ts --timeout 30000` | 1 pass，0 fail，5 assertions |
| packages/opencode、packages/core、packages/plugin | 各包`bun typecheck` | 全部exit0 |
| sdks/vscode | `bun run check-types && bun run lint` | exit0 |
| sdks/vscode | `bun run package` | check-types、eslint、esbuild全部通过 |
| repo | `git diff --check` | exit0 |
| repo | `bun script/guard/check.ts . --files <12个实际变更代码文件，以逗号分隔>` | 0 error，3个defensive-check提示，未放宽任何规则 |

去重测试合计 **250 pass、0 fail**。最初Execute四文件合并命令在外层180秒被终止；保留该未完成结果，随后逐文件完整运行同一集合。单文件execute耗时198.61秒，包含既有长耗时场景；每例30秒设置及各测试既有显式时限均未修改。最终全部四文件通过，未跳过测试。

### Original Feedback-Loop Result

第8.1节R1的同一旧响应（run/output均缺outputCount、无execution对象）再次通过实际插件普通入口重放，加入`assert.equal(result.output,"original IDE summary")`和`assert.equal(result.program,undefined)`。实际输出两条`{tool:run|output,output:"original IDE summary",ordinaryDelivery:"PASS"}`。程序化完整合同继续由现有fixture加真实executeParent校验；显式嵌套非法program仍失败。未伪造缺失字段，未catch转成功。

### Actual Secondary and Replacement Path Inventory

与第11节一致。没有协议协商、重试、补字段、额外状态机或执行后端。普通与Execute只按原父调用身份选择消费；范围只删除叠加的transport timer；真实SDK逐格timer、权限和显式abort保留。

### Remaining Unverified Items

未安装新扩展、重启用户IDE或执行用户Notebook；未运行真实Jupyter/远程SSH/WSL端到端矩阵。native HTTP测试使用真实Node HTTP、注册文件、发现客户端和SDK handler，但VS Code文档/API为fixture。现有已安装扩展与运行中的CLI仍需后续部署才能使用本commit。这些部署操作不在用户本轮要求中。

## 24. Implementation Audit Record

| Round | Revision | Full scope | Findings | Verdict | Task |
| --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | B-01 Blocking：必需执行验证尚未完成独立核验 | BLOCK | ses_ddc3a86eeffe9moAS5AdoIDn5m |
| 2 | R2 | yes | No blocking findings；B-01已解决 | APPROVE | ses_ddc3a86eeffe9moAS5AdoIDn5m |

首轮原样记录：

> B-01 必需执行验证尚未完成独立核验
>
> Minimal correction direction: 提供可直接读取的原始运行记录，或授权复跑既定验证命令；无需为此修改生产代码或增加测试。
>
> 无。源码与测试差异审查未发现需要返工的行为缺陷。
>
> **BLOCK — R2 当前实现差异，首轮全范围实现审计。**
>
> 唯一阻断项是 **B-01：执行验证待独立核验**。生产实现与测试设计目前无需返工。请授权复跑计划第 18 节命令，或提供原始执行记录后继续完成放行审计。

第二轮原样记录：

> No blocking findings.
>
> **B-01 已解决。** 本轮独立执行了既定测试、类型检查、SDK lint/build、guard 和原始症状回放，全部通过。12 个代码文件的 Git blob 与首轮审计一致；本轮变化仅为计划第 24 节的审计记录。
>
> 无新增项。
>
> Guard 报告的 3 个 `defensive-check` 提示对应普通/Execute 消费边界及范围期限处理，均有明确需求和调用路径依据，无需追加修改。
>
> 测试合计 **250 pass、0 fail、1,863 assertions**。
>
> **APPROVE — `docs/plans/notebook-targeted-regression-repair.md`，R2，第二轮全范围实现审计。**
>
> 批准仅适用于基线 `53ec198de854db5c0318706f5f62946a087398b9` 到本轮核验的 12 个代码文件实际 diff。首轮 **B-01 已解决**，全部阶段适用门禁通过；可记录本次结论并进入 workflow 的 `verified` 阶段。本轮未提交。

独立复跑命令与第23节相同；Session Execute本轮200.16秒。审计员另重放全部原始故障：旧响应普通run/output恢复，独立UUID对两种sessionId均可发现；原格移位、凭证继承、缩进、锁和取消均核验。范围HTTP固定基线约85ms中止，当前相同输入约126ms完成。源码blob及无关工作区修改保持原状。按用户授权进入限定路径提交。
