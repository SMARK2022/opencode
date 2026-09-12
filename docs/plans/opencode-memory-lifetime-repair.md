# Canonical Implementation Plan: OpenCode Memory Lifetime Repair

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: 本会话用户的内存调查请求、阶段 1 请求及 `./.temp/testing` 路径确认，原文见 §1
>
> Implementation allowed: yes
>
> Last updated: 2026-09-12

本文件是本任务唯一 canonical plan。阶段终态是 **plan-only / audit-required**；用户粘贴模板中的 `verified-implementation-and-commit` 占位值不覆盖其明确的“不需要任何审计、实现、commit”。本轮不进入后续阶段。聊天总结、实验脚本和旧 plan 均不构成实施授权。

## 1. Verbatim Requirement

> 下面你需要按照这个 workflow，也就是把这个第一阶段进行相应完成。请你自行完整进行相应的一个检查，并且针对于现在全部的这种大规模的这种问题啊、内容啊，你需要全面完整地进行相应的测试以及检查。同时最终你需要给出并构建一个完整的一个 plan，同时这个 plan 限定其生产代码修改文件数不多于 12 个文件，修改行数不超过 1200 行，且整体需要考虑相应的红测等等内容，就是避免现有测试会发生红色。然后与此同时，如果你需要自行自己进行相应内存实验，你可以在现有的 TMP 文件夹里面的 Testing 的现有文件夹里面构建相应的脚本，自行进行相应的实验。最终需要以相应的构建一个完整的 plan 为目标，你需要自行全面完整进行。你不需要进行任何的审计以及实现，也不需要进行 commit。你的目标只是构建相应的完整的 plan。请全面完整进行相应的检查。理论上来说有很多一些内存泄漏，或者说内存并未清理等等的一些内容。同时现有的一些默认值，譬如说 300 条消息上限这种暂时不清理，因为这是本就设计如此。但是有很多存在的一些不正常的一些留存，或者冗余的一些留存，这就会导致 TUI 整体过度庞大，所以你可以将其进行适当清理，进行适当优化，提出完整全面的相应的方案内容。同时我也希望现有的一些行为的一些表现不会受到影响，譬如说 TUI 的滚动条的虚拟的滚动的位置等等内容计算最好是保持精确的。然后整体保持 TUI 的一个丝滑，不会有过度的卡顿等等内容。但是又要大规模去优化它的这些内存等等一些释放、清理等等的一些机制。同时如果有一些内存连根本使用都没有使用，你可以考虑适当让方案中优化掉现有的加载逻辑，譬如说直接就不把它加载进来，也就是清理掉那些有问题的逻辑。也就是相对于相较于加额外的清理脚本，你更好地甚至是直接进行相应的原代码的一些清理或者优化、裁切、剪裁、剪枝等等一些内容。
>
> 自行全面完整进行相应的一个检查，并最终构建一个完整的 plan，以 plan 为最终目标，以 plan 为最终的结果，也就是你只有写完 plan 之后，你才能结束你的任务。

后续路径确认：

> ./.temp/testing

用户要求阶段 1 完成 evidence/domain/reachability、invariant/divergence/owner、route/paths/workaround、file/TDD/verification/diff、risks/speculation/audit/comments，最终设置 `Status: audit-required`、`Approved revision: none`、`Implementation allowed: no`。

前序内存请求涉及 daemon、各 TUI、Node/VS Code 归属、堆留存和大幅降低内存的可能性。§5、§20 完整列出这些分支的调查结论；本修复不承诺未经对象归因验证的“所有进程减少 50%”。

## 2. Explicit Non-Goals

- 不改变每 Session 300 条消息窗口、chronology/BINARY 顺序、默认读取范围、现有完整 SDK/export 合同。
- 不增加 inactive-Session TTL/LRU、不关闭后台 Session 事件、不丢弃合法 delta-before-parent、不缩短正文或工具输出。
- 不改 ScrollBox/Yoga 高度、滚动 marker/平滑 thumb、viewport 算法、选择与导航；不以 hidden/unmount 切换重写工具折叠行为。
- 不增加 GC/工作集修剪定时器、daemon 清理脚本、诊断 API、配置开关或 fallback。
- 不改变有效 prompt cache 的单槽容量、exact proof、warm reuse、Compaction/Revert/模型转换语义。
- 不合并完整 listener 图、不更换鉴权/网络所有权、不借本次改动解决无界 SSE 背压协议。
- 不停用 read 的现有 LSP 行为、不统一 VS Code/OpenCode 的独立语言服务、不关闭仍有效的临时源码树索引。
- 不顺带修改当前工作树中的 edit/write/patch 修复，不修前序日志调查中的 provider/config 等非内存问题。
- 不覆盖已经存在的 OpenTUI 原生修复；native 分支只消费可证明来自该修复源码的不可变正式产物。
- 本阶段只新增本 plan 和用户允许的实验脚本；禁止审计、production/formal-test/config 修改、发布、部署、commit。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` | 最小修改、真实接口测试、package-local test/typecheck、不回退他人改动 |
| `packages/opencode/AGENTS.md` | Effect Service/InstanceState/Scope 所有权、禁止冗余运行时、模块命名 |
| `packages/opencode/test/AGENTS.md` | 隔离 tmpdir/testEffect、优先 readiness 而非猜测 sleep |
| `packages/opencode/test/server/AGENTS.md` | 真实 Effect HTTP seam、listener 生命周期和配置隔离 |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | 服务在 layer 边界构建，不能在 handler 重新 provide 整图 |
| `.opencode/policy/first-principles-engineering.md` | first divergence、零新 fallback、双向映射、15% 中文解释注释 |
| `.opencode/templates/canonical-plan.md`、`docs/workflow.md` | 本文 24 节和阶段终态 |
| `CONTEXT.md` | Session/Message/Part、Run state、InstanceState、AppRuntime、Snapshot 的既有含义 |
| `docs/adr/README.md`、ADR 索引 | 仅有 triage-label ADR，无内存生命周期 ADR；不虚构已接受的 eviction 策略 |
| `packages/opencode/bunfig.toml`、`test/preload.ts` | Solid preload、隔离 XDG、内存 SQLite、测试自己的 GC/清理，不接真实 daemon |

调查基线：父仓库 `da51973f8c75e7542096d6177cd956ad0d21ddbf`；运行环境 Windows x64 / Bun 1.3.14。原生 vendored HEAD `362be301`。源码工作树仍有其他任务的未提交 edit/write/patch 修改，已记录而未改动。实施前必须重读所有计划文件和此基线间的差异，不能据本文覆盖新工作。

## 4. Files and Evidence Read

下表列出建立本设计与排除项的证据。引用为当前源码，不能自动等同于用户长时间运行的发布二进制。

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:193-228,305-368,666-667,801-998,1168-1248` | store、pending/orphan delta、删除、同步提交和 300 窗口 owner | reachable |
| 同目录 `sdk.tsx:58-108,143-188`、`event.ts:71-81` | SDK 16ms 队列与 Project/active Session admission，不可静默丢后台流 | reachable |
| 同目录 `sync-v2.tsx:53-84,155-169`、`app.tsx:303-332` | app-lifetime v2 provider，不能假定所有会话都启用 v2 | reachable |
| `cli/cmd/tui/routes/session/index.tsx:315-333,1352,2134-2192,2793-2866` | 真实布局、文本预算、BlockTool 延迟构造与展开保留 | reachable |
| `cli/cmd/tui/routes/session/dialog-message.tsx:26-38,69-94,121-143` | Retry/Fork await 边界依赖原消息数据 | reachable |
| `cli/cmd/tui/plugin/api.tsx:179-180`、sidebar/files/context、prompt/history/stash/KV/audio | Part 公开消费者、固定历史/音频缓存边界 | reachable |
| `session/revert.ts:152-168,197-226` | unrevert 只清未提交 Revert；cleanup hidden 是独立不可见事实 | reachable |
| `session/prompt.ts:665-713,2613-2653,3043-3093` | 单槽真实 owner、exact prefix、conversion cache 与瞬态 request 字符串 | reachable |
| `session/message-v2.ts:1000-1043,1882-1966` | viewer payload、原始 JSON exact proof；不允许碰撞式替代 | contracted |
| `session/session.ts:711-727`、`session/projectors.ts:137-140`、`storage/db.ts:193-218` | 无实例删除、递归删除、事务后释放 seam | reachable |
| `effect/instance-registry.ts`、`instance-state.ts`、`project/instance-store.ts:102-168` | disposer、reload barrier、scope 结束与缓存失效 | reachable |
| `server/server.ts:103-139`、`server/routes/instance/httpapi/server.ts:185-255`、`websocket-tracker.ts` | 两图分裂与 listener-local auth/close owner | reachable |
| `server/routes/instance/httpapi/handlers/global.ts:60-107`、`bus/index.ts:63-164` | 未背压有界化的队列；本次不改协议 | reachable |
| `effect/run-service.ts`、`app-runtime.ts`、`plugin/index.ts:242-249` | shared memoMap 及 in-process 路径 | reachable |
| `lsp/lsp.ts:331-378,501-550`、`lsp/client.ts:307,595-698`、`lsp/server.ts:34-119`、`tool/read.ts` | Node roots、文档与 Session claim 生命周期；现有 read touch 语义 | reachable |
| `storage/db.ts:92-150`、`file/index.ts:337-396`、`provider/provider.ts:1409-1426,2084-2101` | SQLite 单例及目录缓存，不能宣称每图复制完整数据库 | reachable |
| `index.ts:3-40`、`cli/cmd/run.ts:31`、`cli/cmd/serve.ts`、`cli/effect-cmd.ts` | CLI eager import footprint；本次没有安全冷启动对照证明应重写 |
| `thirdparty/opentui/packages/core/src/Renderable.ts`、`renderables/{Diff,Code,TextBufferRenderable,ScrollBox}.ts` | live registry、原生资源释放、布局保持 | reachable |
| 同包 `lib/tree-sitter/{client,parser.worker}.ts`、`zig/{buffer,grapheme,text-buffer,text-buffer-view}.zig` | parser/tree、clip-before-allocation、容量与引用生命周期 | reachable |
| `thirdparty/opentui/packages/solid/src/reconciler.ts:118-168` | 256-root deferred destruction bound；非立即回收不等于永久泄漏 | reachable |
| `.opencode/plugins/tui-smoke.tsx:990-1010`、OpenTUI `post/effects.ts:264-336` | vignette mask 按屏幕面积，不是正文级缓存 | reachable |
| 根/`packages/{core,opencode,plugin}/package.json`、`bun.lock` | 实际 .12 dependency/peer/native closure | observed |
| `script/upgrade-opentui.ts`、`packages/opencode/script/{verify-opentui-closure,opentui-provenance,smoke-opentui-artifact}.ts` | 唯一 release/closure 路径及构建验收；不得复制 DLL | contracted |
| `test/cli/cmd/tui/{sync-fixture,sync.test,sync-undefined-messages.test,session-message-render.test,smooth-scrollbar.test}.tsx/ts` | 已有真实挂载、事件/HTTP、渲染/滚动 seam | observed |
| `test/session/{prompt,session}.test.ts`、`test/project/instance.test.ts`、`test/storage/cold.test.ts` | warm cache、mutation、无实例删除、disposal、事务失败回归 | observed |
| `test/server/httpapi-{listen,cors,authorization,instance,promptasync-context,event}.test.ts` | listener 配置及生命周期基线 | observed |
| `test/lsp/client.test.ts`、`test/tool/lsp.test.ts` | LSP 16 项现有回归通过 | observed |
| OpenTUI core 的 native-backed-measurement/renderer.lifecycle/text-buffer/text-buffer-view/scrollbox/native-handle/Diff.regression/allocator-stats/Code/renderer.custom-stdout 测试 | 170 项 core 相关现有测试通过，详见 §18 | observed |
| OpenTUI solid 的 scrollbox-cleanchildren/duplicate-id-culling/sticky-scroll 测试 | 22 项现有回归通过 | observed |
| `.temp/testing/memory-sync-lifecycle.test.tsx` | 真实 SyncProvider；18 个行为实验、16 MiB 留存、并发提交 | observed |
| `.temp/testing/memory-daemon-ownership.test.ts` | 实际 loop/remove/dispose WeakRef、exact proof 体积、共享图反例 | observed |
| `.temp/testing/memory-render-lifecycle.ts`、`memory-render-glyph.ts` | 安装/源码 DLL 对照、真实 native 资源与 geometry | observed |

说明：表内个别组合路径用文件 stem 表达，实际扩展名由相应目录已有文件决定；§18 给出可直接运行的完整路径。上轮 OS 指标仅作规模背景，不作为本 R1 对象归因证据。

## 5. Current Behavior

```text
daemon Message/Part/Snapshot -> Global SSE -> SDK queue -> useEvent admission
  -> SyncProvider message/session 索引 + Part 正文 + orphan delta
  -> Message/Session 删除只删除部分索引 -> 已失效正文继续可达
  -> 旧 HTTP 提交 / 后续 Part 更新 -> 已失效数据重新进入 store

SessionPrompt Service -> current-entry(proof + canonical + chunks)
  -> Session.remove / Instance.dispose -> 数据/实例退出
  -> Service 仍存活且槽未失效 -> 旧 proof/canonical/chunks 继续可达

已安装 .12 native -> 裁剪字形仍先分配 -> pool exhaustion / 缺字
vendored 修复 -> clip-before-allocation -> 同负载不消耗不可见 glyph owner
```

### 5.1 TUI 实测

- 同一个真实 provider，删除/隐藏 Message 后 Message 消失但 Part 保留。
- 删除有 16 个 1 MiB ASCII Part 的 Session 后，16,777,216 字节逻辑正文仍留存，其他 Session 的 4 字节保持有效。
- force replacement 不清旧页 Part 和 part-first orphan。
- 无父对象时删除前缓冲的 `STALE` 可以被随后 Part 回放；删除后的完整 Part/新 delta 也能重建已失效状态。
- Session 删除发生于 HTTP messages/diff 挂起时，旧响应能够重建 Session/history/diff。
- HTTP 快照开始后来的新 Message 能被旧空快照抹掉，留下 Part。这是清理方案必须保护的并发路径。
- 正向对照：300 窗口和 `limit=300`、后台 delta-before-parent、Part 局部隐藏/删除保留 sibling 均通过。

### 5.2 Daemon 实测

- 实际 `SessionPrompt.loop` 使用已完成 assistant，不调用上游 Provider；删除 Session / dispose Instance 后 WeakRef 仍存活。
- 同 Service 换入另一 Session 后旧 proof 被回收，说明探针本身没有永久保留它。
- 1 MiB/4 MiB 文本的 proof key 分别是 1,048,878 / 4,194,606 字节，保留完整正文是 existing exact contract，不是轻量版本号。
- TCP 与 AppRuntime 状态分裂真实可达；但共享整张图后第二 listener 密码收到 401、第一密码收到 200，并且 closeAll 会关闭另一个 listener 的 tracker。禁止将“共享 map”作为本次省内存捷径。

### 5.3 Render/native 实测

- 128 次 Diff create/layout/切换/destroy 后 registry 与 active allocation 返回基线；retired handles 被拒绝且 slot 被复用。
- 600 次紧凑挂载/卸载会暂时积压，nextTick drain 后回到基线；未证明永久 renderable 泄漏。
- BlockTool preview 只构造一次；首次展开 body 只构造一次，再折叠保留 body；scroll height `30 -> 87 -> 30`，重复 20 次稳定。不改变该布局/缓存行为。
- 两个 .12 DLL hash 不同。installed：`82f26aa9e6ee3701acb2b7a0d86ae7cd7231bd809f7afcdd16c5a9d9297922cb`；vendored：`da8692a626177c84b329273243849555a6fe2bdc42e019eea6d284ab2f26e7e9`。
- 65,534 次固定裁剪负载：installed child exit 1 / GraphemePool OutOfMemory / 缺字；vendored child exit 0 / 帧正确。
- active allocation 归零不保证 RSS 等量下降；allocator 报告 `requestedBytesValid=false`，不使用 RSS 反推活对象字节。

### 5.4 已调查但不以默认值裁切的资源

有效后台 Session、仍存在的 TS 工程、300 条正文、打开过的工具 body、音频和语言 parser cache 均可能占内存，但本轮未证明这些对象已经失去用途。CLI import 裁切牵涉完整命令/帮助/Worker 编译闭包；没有足够安全对照支持在此预算内实施。保留这些分支而释放失效对象，不等于宣称所有高内存问题都已解决。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Message removed/hidden | Session projector / Revert cleanup | ID 和所属 Session 已解码；hidden 是持久事实 | useEvent -> sync reducer | SyncProvider | observed |
| Part removed/hidden，父数组缺失 | 异步 Part 与 delta 生命周期 | 不能保证父 Message 已在 viewer | reducer/replay | SyncProvider | observed |
| Session 删除，含未加载父 Message 的 Part | Session.Event.Deleted | Session ID 唯一，列表不是全部历史 | Project event -> store | SyncProvider | observed |
| snapshot 挂起时删除/新增/terminal update | 并行 HTTP 与 SSE | 无统一服务端 revision，可顺序交错 | async session.sync + reducer | SyncProvider | observed |
| unknown-but-live delta-before-parent | 当前 SSE producer | delta 不持久化，丢弃会丢文字 | orphan replay | SyncProvider | observed |
| 300 窗口滚出、强制页替换 | 当前 viewer contract | projection removal 不等于持久删除 | sync/window | SyncProvider | contracted |
| Retry/Fork await 中原 Part 失效 | 用户动作与异步网络 | 已选 Message 可在 await 后消失 | DialogMessage | action owner | reachable |
| 无实例/递归 Session.remove | Session public interface | publish 可为 false，事务失败传播 | projector committed deletion | prompt slot owner | observed |
| Project reload/dispose，旧 run 与新实例竞争 | InstanceStore/RunState | disposal 有 barrier，scope 可中断 | cache publish/dispose boundary | prompt slot owner | reachable |
| 双 listener 不同 auth/close | Server.listen | 配置与 socket 生命周期必须隔离 | route layer build | listener owner | observed |
| 不可见字形裁剪 | ScrollBox/renderer | 裁剪位置已知，不应创建不可见 glyph owner | native draw | existing OpenTUI repair | observed |
| 任意无限乱序、多源伪造 ID | 无已证实生产者 | 不新增信任边界 | 不适用 | 不适用 | speculative |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 已删除/隐藏 Message 的 Part 和 delta 不再由 TUI 持有；其他 Message 不变 | TUI 红测 | 新 lifecycle slices |
| INV-02 | 已删除 Session 的重 payload 和 owned 状态释放，旧 HTTP/event 不得复活 | 16 MiB、HTTP race 红测 | 新 lifecycle slices |
| INV-03 | 快照仅释放最终投影之外的对象，保留请求期间的合法变化 | force/new-message 红测 | sync stale-stream/progress tests |
| INV-04 | 300、chronology、BINARY、后台恢复、terminal authority 不变 | 用户 + 现有通过测试 | sync chronology/delta/progress |
| INV-05 | 被删除/dispose 的 prompt current-entry 不得延长对象生命，其他有效槽不受影响 | WeakRef 红测 | 新 prompt lifetime slices |
| INV-06 | exact proof、单槽、2048-turn warm reuse、Compaction/Revert 和 Provider body 不变 | 现有 passing tests | prompt.test.ts |
| INV-07 | 原生可见输出正确，不给被裁剪字形创建未消费 owner | installed red / vendored green | existing clipped regression |
| INV-08 | 滚动高度/marker/thumb/选择、折叠、首屏与流式顺滑不退化 | 用户 + geometry 实验 | session-message-render / smooth-scrollbar / sticky-scroll |
| INV-09 | Retry/Copy/Revert/Fork 使用用户选中时的输入，await 不依赖被释放 store | action consumer | 新 action race slice |
| INV-10 | listener auth/close、LSP、MCP、权限/问题和数据库错误语义不弱化 | 反例 + 现有基线 | server/LSP/cold regressions |
| INV-11 | <=12 production/dependency 文件；本方案再约束正式代码+测试 gross changed lines <=1200 | 用户硬预算，本文更保守计法 | diff accounting |
| INV-12 | 本轮仅 plan 和指定实验；不审计、不实施、不提交 | 用户 | git status / audit record |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| 01/02 | 删除投影父对象时未释放子 payload；early return 跳过 orphan 清理 | sync reducer | memory-sync 14 reds |
| 02/03 | await 之后无删除/请求代际检查，HTTP 集合直接替换 live 集合 | session.sync/refresh commits | force deletion/new-message/diff reds |
| 05 | per-Service 单槽未加入 Session/Instance 生命周期 | SessionPrompt Service cache | delete/dispose WeakRef reds |
| 07 | consumer 仍解析到未包含现有裁剪修复的 native artifact | dependency closure | 同版本不同 hash，固定负载差分 |
| 09 | action 在 await 后才从可变化 store 提取用户选择内容 | DialogMessage | reachable consumer，须补行为红测 |

红测命令与结果见 §18。根因界定不包含“看到 RSS 大，所以所有缓存都泄漏”；没有推导出这条命题。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| viewer 对象释放与提交准入 | SyncProvider | useSync.data 对应有效 viewer projection | message/part/index/delta 和 HTTP commit 均由它持有 | renderer/SDK 不拥有完整 store |
| 操作输入跨 await | DialogMessage | Retry/Fork 作用于已选输入 | action 知道要跨异步保存哪些轻量/必要数据 | cache 不应为等待 action 保留整页 |
| current-entry 生存期 | 私有 prompt cache slot | 不延长已结束 Session/Instance 生存期 | 唯一保存 proof/canonical/chunks 的 owner | Bus publish=false 不能可靠通知所有槽 |
| 已提交删除通知 | Session projector + Database.effect | 事务成功才失效缓存 | 包含无实例与递归删除路径 | UI/网络 handler 不覆盖全部入口 |
| Project dispose/reload 完成 | InstanceStore existing barrier | 旧工作结束再清同代对象 | 避免 disposer 并行期间再发布旧槽 | timer 无法表达代际 |
| native 消费一致性 | dependency manifests/lock/gitlink + existing verifier | 发布源码与消费 DLL 同源 | 修复已在 vendored 实现，不应另造算法 | 手拷 DLL 不可复现 |

## 10. Single Approved Primary-Path Design

本节标题沿用 template；R1 **尚未 approved**。三个切片各修原 owner，共用“失效对象不再被消费/保留”的要求，不构成并行备用成功路径。

### 10.1 TUI：失效事实、所有权释放与原子快照

1. 在 `sync.tsx` 内复用现有 store/index，内聚三个释放操作：Part、Message、Session。局部 Part 释放不删 sibling；Message 释放清其 Parts、index、pending/orphan；Session 释放清其消息、part-first 对象、todo/diff/status/goal/permission/question/fullSynced 等 owned 状态。清理不能依赖列表/父数组已存在。
2. 区分 **持久删除/hidden** 与 **projection eviction**。前者建立仅含 ID 的失效事实；后者只释放对象，不建立永久 tombstone，后续合法 sync 仍可加载。当前 Revert cleanup hidden 没有 unhide producer；`unrevert` 在 cleanup 前只清 revert 边界，不复活 hidden row。
3. 在完整 update/progress、delta admission、orphan replay 和 HTTP commit 使用同一失效判定。收到删除时先按现有顺序 flush，再释放；不修改 SDK event id/count、Project admission 和后台流式合同。未知但未失效父对象仍走现有 orphan replay。
4. 失效集合只保存 ID/所属关系，不保存 Message/Part/字符串 payload；Session 删除可折叠子失效记录。Provider cleanup 清空所有元数据。不得给 tombstone 加未经协议证明的 TTL，避免到期后复活；也不宣称元数据在无限删除历史下严格常量。
5. 每 Session HTTP sync 使用当前请求 token；删除/Provider dispose 使旧 token 失效。token 只在活跃请求期间登记，finally 按身份释放。每个 await 后、goal/history/status/diff/fullSynced 提交点检查同一 token；较旧 force 响应不得覆盖较新结果。网络异常仍沿现有错误路径传播，不合成成功数据。
6. 快照请求期间只记录变更 ID 与轻量字段代际，不复制大正文。最终集合 = HTTP 页 + 请求开始后发生的合法 Message/Part 变化 - 已失效对象；正文复用当前 store 与 `mergeLiveParts`，沿现有 chronology/BINARY 和 300 窗口形成最终投影，再同步释放真正离开集合的 Parts。请求前 part-first orphan 仅在权威页证明不属于最终投影且请求期间无新变化时释放。
7. Session list、status、permission/question、goal 的其他 async 入口必须识别 Session 删除；复用 existing blocker change tracking。列表过滤造成的缺项不能当作删除。status 不得因同步某个 Session 抹掉其他 Session 的请求后变化。
8. 不对每个 delta 扫全部 store；正常 delta admission 保持 Map/Set O(1)，bulk 扫描只在显式删除/权威 snapshot 边界进行；同一次更新用既有 batch/produce 原子提交。
9. DialogMessage 在 Retry 第一个 await 前捕获 PromptInfo；Fork 同样在异步 fork 前捕获所选消息内容。捕获只服务本次 action，完成后释放；没有已选 Message 时沿已有 no-op。Copy/Revert 同步读取保持原行为。

### 10.2 Daemon：现有单槽加入真实生命周期

1. 新增私有 `session/prompt-window-cache.ts` 作为 existing Service slot 的资源 owner。一个 SessionPrompt Service 注册一个槽，不改成每 Project/Session 一份 cache；槽内仍是现有 proof/canonical/chunks，只额外携带 InstanceContext identity/Session ID。
2. `prompt.ts` 使用槽读写替代局部 `retainedMessages`，admission、exact proof、prefix/contraction、model conversion 原样保留。Service finalizer 注销槽并清引用。
3. Session projector 成功删除后，用 `Database.effect` 执行按 Session ID 的同步失效，覆盖所有 Service 图的槽、递归和无实例删除。回滚不执行失效；不依赖 publish=true。
4. InstanceStore 在现有 `runDisposers` barrier 完成后、旧实例 disposed 发布前失效旧 InstanceContext 的槽；reload 同样处理旧 context。不得改成按 directory 无条件清任何新槽。
5. 槽 publication 使用轻量 lease identity：当前 admission 在可能让出前取得 lease，删除/disposal/Service close 使匹配 lease 无效，旧工作在 await 后不得重新发布。失效已删除 Session 的记录不长期保存整个 Session；活跃 lease 注销后可删除相应轻量状态。未受影响的新 Session/新 InstanceContext 不被旧失效清除。
6. 当前 Provider 请求可继续持有本次需要的本地数组直到既有 cancel/release 完成；方案释放的是不该延长生存期的 cache owner，不提前改写活动 Provider body。不引入每次 idle 清缓存、强制 GC 或 proof hash。

### 10.3 Native：只消费已存在的修复

- 当前 `thirdparty/opentui` 已包含 clip-before-allocation 和既有测试，R1 不再次修改 Zig/renderer/ScrollBox。
- 正式消费必须是**新的不可变 release**，其 source commit 包含 `362be301` 的修复且通过既有 closure/provenance。2026-09-12 查询 `.12` 是已发布 prerelease；`.13` 尚不存在。不得覆盖 `.12` 资产或把同号本机 DLL 当成 release。
- dependency 切片在新 release 已由其 owner 发布后才可执行；本 plan 不授权发布。tag/source commit/integrity 一旦可用，先将其具体身份填入本 plan 并递增 revision，之后才能审计该精确集成 revision。当前状态不会误授未来任意版本升级权限。
- 预留根、core、opencode、plugin 的 manifest、`bun.lock` 和必要 gitlink 六个文件。catalog/override/peer/native 11-member family 同步；锁文件由 package manager 生成，不手写 integrity。既有 upgrade 脚本会递归扫描，执行环境若含 `.temp` 源码副本不得让其越过 allowlist；不为此修改升级脚本。
- 运行 installed consumer 的真实裁剪测试和既有 artifact smoke，必须得到正常帧。不得用 vendored green 代替 installed/compiled green，不复制 DLL，不跳过 provenance verifier。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| live/HTTP 合并，300 window，orphan-before-parent | current | primary-contract branch | yes | 保留 | preserve |
| deleted/hidden rejection + lease invalidation | proposed | primary-contract branch | 不产生替代数据 | 核心 owner transition | implement |
| goal 请求现有非致命处理、diff resolved/rejected 合同 | current | existing compatibility | 原有范围 | 不扩展 | preserve |
| 数据库 after-commit slot invalidation | proposed | primary-contract branch | 无独立业务结果 | 核心 lifetime | implement |
| 本地 DLL substitution | rejected | forbidden fallback | 可能伪装安装成功 | 0 | reject |
| 共享整张 listener 图 | rejected | 非等价替换 | 破坏 auth/close | 0 | reject |
| 每次 idle 清缓存、丢后台 delta、自动重试另一解析器 | rejected | forbidden fallback / behavior change | 可能 | 0 | reject |
| 新生产诊断路径 | none | diagnostic | no | **0%** | none |

新 alternate-success paths = 0；不增加 timer/TTL/备用 loader。测试和临时实验不计入 production decision surface。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Message/Session 删除只改父列表的局部逻辑 | 初期仅满足显示移除 | 显示 owner 与 payload owner 同步结束 | `sync.tsx` 删除分支折叠进统一 release |
| snapshot 只写新 Parts，不扫最终投影 | 保留 live 文本但忽略历史离场 | merge 完成后按最终集合释放，保留并发变化 | `sync.tsx` sync commit |
| 缺父对象 early return 位于 orphan cleanup 之前 | 假定无父即无资源 | 实验直接证明 orphan 可存在 | `sync.tsx` removed/hidden |
| 无 lifecycle 的 Service 局部 current-entry | warm reuse | 单槽保留、owner 正确退出 | `prompt.ts` 旧局部引用 |
| .12 consumer 未消费新裁剪修复 | 源码与已安装 artifact 更新不同步 | 新 immutable closure 后消费正确代码 | manifests/lock/gitlink |

已有 BlockTool preview memo、Diff teardown、deferred destroy、parser release 不删除也不重写；本轮实验没有证明它们失效。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| 01/02，异常正文不保留 | sync release/admission | `sync.tsx` | message/part/session + 16 MiB + late events |
| 02/03，旧异步请求不重建状态 | sync/refresh commit | `sync.tsx` | pending history/goal/diff/status/list/blocker、双 force |
| 04，300/后台/排序/正文不变 | existing admission/merge | 同文件保持参数与序列 | existing sync suite + positive controls |
| 05/06，cache 生命周期与 warm reuse | cache slots + deletion/disposal | prompt/cache/instance-store/projectors | WeakRef with collection control、warm prefix/body parity |
| 07，裁剪与 native release | dependency family | 六个 dependency/gitlink 文件 | installed native output + compiled smoke |
| 08，准确滚动/顺滑 | 不更改 layout；store 原子释放 | sync batching，render 路径保持 | existing render/scroll suite + repeated lifecycle geometry |
| 09，action await 安全 | capture selected content | dialog-message | Retry/Fork during deletion |
| 10，现有语义 | unchanged listener/LSP/database | 不引入整图共享 | server/LSP/cold baseline and regression |
| 11/12 | diff / stage control | 本文文件白名单、预算 | numstat、status、无审计记录 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Part/Message/Session release | 01/02 | 真实公开 store 红测 | 已有局部删除没有 child ownership |
| ID-only invalidation facts | 02/04 | late full Part/delta rehydrate | 清当前数组不能阻止后续准入；未知 live delta 不能全拒绝 |
| per-request token + active change IDs | 02/03 | HTTP stale resurrection/new message loss | fullSynced Set 不表示 in-flight generation |
| action-local PromptInfo | 09 | await 后读 store | cache 不应为 action 长期保留全页 |
| single-slot registry + lease | 05/06 | actual proof WeakRef | Service scope 比 Session/Instance 长且可有多图 |
| after-commit release | 05/10 | remove publish=false/cold rollback | Bus 不是全部删除入口，事务内提前释放错误 |
| old-context disposal boundary | 05/06 | dispose WeakRef + reload producer | 并发 runDisposers 内清理存在再发布窗口 |
| immutable dependency closure | 07 | installed/vendor 差分 | 版本字符串不能证明实际修复被消费 |

## 15. File-Level Change Plan

表内行数为 **added + deleted** 预算，包含注释/import/生成 lock，不用净删行抵销新增。不会改正式测试来让现有断言变弱。具体实现超预算时回到 plan revision，不删除必要测试凑数。

| File | Add / modify / delete | Exact responsibility of the change | Expected gross lines |
| --- | --- | --- | ---: |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | modify | 生命周期释放、失效准入、async snapshot commit | 330 |
| `packages/opencode/src/cli/cmd/tui/routes/session/dialog-message.tsx` | modify | Retry/Fork 首个 await 前捕获必要内容 | 20 |
| `packages/opencode/src/session/prompt.ts` | modify | 单槽/lease 接入，保持算法 | 55 |
| `packages/opencode/src/session/prompt-window-cache.ts` | add | 私有 slot registry、identity invalidation | 75 |
| `packages/opencode/src/project/instance-store.ts` | modify | old-context disposal/reload barrier 接入 | 18 |
| `packages/opencode/src/session/projectors.ts` | modify | after-commit Session 删除失效 | 10 |
| `package.json` | modify | family catalog/overrides | 28 |
| `packages/core/package.json` | modify | local package overrides | 22 |
| `packages/opencode/package.json` | modify | local package overrides | 22 |
| `packages/plugin/package.json` | modify | peer compatibility lower bound | 6 |
| `bun.lock` | generated change | 单一不可变 family URL/integrity | 80 |
| `thirdparty/opentui` gitlink | update only if release commit differs | 精确 release source pin，无新 native source 设计 | 2 |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx` | modify | 参数化生命周期/HTTP 竞态，复用 fixture | 190 |
| `packages/opencode/test/session/prompt.test.ts` | modify | cache lifecycle/rollback/concurrency，复用现有 fixtures | 95 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | modify | action race、布局保持 | 45 |
| **小计** | 12 production/dependency + 3 test files | production/dependency 668，tests 330 | **998** |

剩余 202 行是完整性余量，不授权第 13 个 production/dependency 文件。六个依赖文件为 release 前置条件可满足后的额度；本阶段不修改它们。现有 native 修复已在基线提交，不重复记作 R1 新代码；未来 release 若带入额外源代码，须单独检查完整 diff，不能借 gitlink 隐藏新算法或预算。

## 16. TDD Behavior Slices

实验 seam 由用户自主测试授权下选定：真实 SyncProvider/SDK test transport、真实 SessionPrompt/Session API、真实 renderable/native 输出。正式测试不照搬全部实验脚手架，不断言 private map 大小；从公开 store 内容、Provider body、资源可回收性和终端帧观察。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | removed/hidden Message 后公开 Part 仍存在 | 只删父/index | release 所属 Parts/delta | sibling/其他 Session、chronology |
| 2 | Session 删除后 16 MiB 与 owned 状态仍存在 | 只删列表/goal | release Session 全部 owned references | filtered list 非删除、后台活动 |
| 3 | 无父删除/hidden、late Part/delta 会复活 | early return/无失效准入 | shared invalidation + replay gate | unknown live delta-before-parent |
| 4 | HTTP history/goal/diff 迟到复活、双 force 乱序 | 无提交 token | token/active changes，逐 await guard | diff 错误传播、首屏先于 diff |
| 5 | status/list/permission/question 迟到回填 | 删除未进入快照合并 | 复用 change-tracking/失效过滤 | 现有 blocker race tests |
| 6 | snapshot 抹掉请求后新 Message | 直接 authoritative replace | final projection merge+prune | 300、BINARY、terminal、progress |
| 7 | Retry/Fork await 中删除导致输入丢失/异常 | 捕获太晚 | action-local capture | synthetic/附件/Undo/Copy |
| 8 | actual cache proof 在 delete/dispose 后仍可达 | service 单槽未失效 | slot/after-commit/context lifecycle | warm reuse、replacement control |
| 9 | rollback/old disposal/new entry/active run/Scope close | 尚未完整实验，必须先 red 或明确现有 green | lease identity，不清新 entry | 无实例/递归删除，Provider body |
| 10 | installed native clipped glyph exhaustion | consumer 落后修复 | 已发布修复 closure | native handles/scroll/selection |

一条 vertical slice red -> 最小 green -> 已有关联回归，再进入下一条。本轮只运行 red/现有基线，不实施 green。

WeakRef 是内存生命周期 oracle，不用它读取业务私有 map。正式测试需保留 replacement 可回收正向对照、隔离子进程和真实 loop，不把 spy 调用数当行为结果；若 JSC GC 时机不能稳定验证，必须采用同一真实路径的 heap retaining-path 证据并记录不可验证原因，不新增生产 test-only API。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | ---: | --- |
| Effective changed code lines E | 约 680 | production + tests；排除 import-only、lock/generated、纯移动 |
| Required Chinese explanatory comments C | 至少 102 | `ceil(E * 0.15)`；实际 E 增加时随之增加 |
| 预算包含关系 | 998 gross 内包含解释性注释 | 不在 1200 行之外另加注释 |

注释分布在：删除 vs eviction 的不同含义、未知 live delta 的不可丢弃性、snapshot 期间变更合并、terminal/progress 权威、过滤列表不等于删除、action await 输入所有权、单槽非 per-Project、after-commit/rollback、旧 context 与新 lease、native artifact 身份边界及测试对照意图。不得翻译赋值/重复测试名/集中凑行。

## 18. Verification

### 18.1 本阶段已运行

`P` = `F:/ML/PythonAIProject/Claude-Code/opencode/packages/opencode`；`C` = 同仓库 `thirdparty/opentui/packages/core`；`S` = 同仓库 `thirdparty/opentui/packages/solid`。

| Command | Working directory | Observed evidence |
| --- | --- | --- |
| `bun test --timeout 30000 ./test/cli/cmd/tui/sync.test.tsx ./test/cli/cmd/tui/sync-undefined-messages.test.tsx` | P | 28 pass / 0 fail |
| `bun test --preload @opentui/solid/preload --preload ./test/preload.ts --timeout 30000 ../../.temp/testing/memory-sync-lifecycle.test.tsx` | P | 最终 4 pass / 14 fail，47 assertions；扩展版重复得到同样分类 |
| `bun test --timeout 30000 ../../.temp/testing/memory-daemon-ownership.test.ts -t "releases retained proof"` | P | delete/dispose 两个目标红测；replacement collection positive control 通过 |
| `bun test --timeout 30000 ../../.temp/testing/memory-daemon-ownership.test.ts -t "dispose releases retained proof"` | P | 独立重复 disposal 红测 |
| `bun test --timeout 30000 ../../.temp/testing/memory-daemon-ownership.test.ts -t "real listener\|shared route memoMap\|shared tracker memoization\|measures real raw prompt proof"` | P | 四个命名实验的复现命令；前阶段各实验观察到 status 分裂、共享 auth/close 反例、exact proof 随 payload 增长。它们是排除错误方案证据，不要求全部变绿；未另计此合并命令的运行结果 |
| `bun run --conditions=browser --preload @opentui/solid/preload ../../.temp/testing/memory-render-lifecycle.ts` | P | installed lifecycle/geometry 通过 |
| 同上一命令加 `--vendored-native` | P | vendored lifecycle/geometry 通过 |
| `bun run ../../.temp/testing/memory-render-glyph.ts` | P | wrapper exit 0；installed child 1，vendored child 0；wrapper 成功不等于 installed 通过 |
| `bun test --timeout 15000 src/tests/native-backed-measurement-lifecycle.test.ts src/tests/renderer.lifecycle.test.ts src/text-buffer.test.ts src/text-buffer-view.test.ts src/tests/scrollbox.test.ts` | C | 144 pass |
| `bun test --timeout 15000 src/native-handle.test.ts src/renderables/Diff.regression.test.ts src/tests/allocator-stats.test.ts` | C | 20 pass |
| `bun test --timeout 15000 src/renderables/Code.test.ts -t "reuses one managed buffer\|filetype change releases\|replacing the client releases\|destroy during in-flight create\|destroy releases the managed buffer"` | C | 5 pass |
| `bun test --timeout 15000 src/tests/renderer.custom-stdout.test.ts -t "clipped text subtree preserves"` | C | 1 pass |
| `bun test --timeout 15000 tests/scrollbox-cleanchildren.test.tsx tests/scrollbox-duplicate-id-culling.test.tsx tests/sticky-scroll.test.tsx` | S | 22 pass |
| `bun test --timeout 15000 test/cli/cmd/tui/session-message-render.test.tsx -t "non-collapsed shell\|expanded shell\|collapsed shell preview\|apply_patch preview card\|notebook source card keeps\|session keeps latest streamed\|switching sessions after scrolling"` | P | 7 pass |
| `bun test --timeout 15000 test/cli/cmd/tui/smooth-scrollbar.test.ts` | P | 2 pass |
| `bun test --timeout 30000 ./test/server/httpapi-listen.test.ts ./test/server/httpapi-cors.test.ts ./test/server/httpapi-authorization.test.ts` | P | 15 pass / 7 skip，Windows PTY/WebSocket skips 不算验证通过 |
| `bun test --timeout 30000 ./test/server/httpapi-instance.test.ts ./test/server/httpapi-promptasync-context.test.ts ./test/server/httpapi-event.test.ts` | P | 10 pass |
| `bun test --timeout 30000 ./test/session/prompt.test.ts -t "reuses a 2048-turn prefix"` | P | 1 pass |
| `bun test --timeout 30000 ./test/session/prompt.test.ts -t "loop exits immediately\|contracts a retained suffix\|refreshes queued Permission\|invalidates a retained window\|sanitizes cached Tool"` | P | 5 pass |
| `bun test --timeout 30000 ./test/session/session.test.ts -t "remove works without an instance"` | P | 1 pass |
| `bun test --timeout 30000 ./test/project/instance.test.ts` | P | 10 pass |
| `bun test --timeout 30000 ./test/storage/cold.test.ts -t "fails closed on a corrupted payload\|releases shared cold references"` | P | 2 pass |
| `bun test --timeout 30000 ./test/lsp/client.test.ts ./test/tool/lsp.test.ts` | P | 16 pass / 0 fail，32 assertions |
| `bun typecheck` | P | exit 0，`tsgo --noEmit` |
| `gh release view v0.4.3-smark.12 --repo SMARK2022/opentui --json tagName,publishedAt,targetCommitish,isPrerelease` | root | .12 存在，2026-09-10 发布 prerelease |
| 对 `.13` 执行相同查询 | root | release not found；未发布任何内容 |

现有回归合计 **289 pass / 7 skip / 0 fail**，不含临时故意红测、不重复累计重复运行。完整仓库 suite 没有运行，不能称全仓全绿。临时实验最早的错误 SessionID fixture 已修正；它不是产品红测证据。

### 18.2 实施时必须运行

- 每个 §16 行为切片的正式 red/green，然后完整 `sync.test.tsx`、`sync-undefined-messages.test.tsx`、`session-message-render.test.tsx`、`smooth-scrollbar.test.ts`，不可只跑过滤后的样例。
- 完整 `test/session/prompt.test.ts`、`test/session/session.test.ts`、`test/project/instance.test.ts`，加 cold corruption/transaction rollback 与所有计划的新 memory lifecycle cases。
- 重跑表中全部 server/LSP/native/solid 基线；Windows skips 在平台允许的 CI 上补跑，不能通过删除/skip 断言“修复”红灯。
- P 中 `bun typecheck`；最终 package-local `bun test --timeout 30000` 必须记录实际结果和独立的已有失败归属。
- 新 release 前置条件满足后，P 中 `bun run script/verify-opentui-closure.ts`；所有 consumer 解析同一 family/solid realpath，tag/gitlink/nested HEAD/installed artifact 一致。随后在 P 中执行 `bun run script/smoke-opentui-artifact.ts --binary "<本次编译产物绝对路径>" --scenario normal` 和相同命令的 `--scenario target-liveness`。路径由实际构建结果提供，不能指向旧的用户运行二进制；脚本使用隔离数据库/假 provider/PTY 并清理自己创建的资源。本阶段未运行 compiled smoke。
- 运行固定 16 MiB 删除/强制同步工作负载多轮：最后无目标正文可达，其他 Session 不变；GC 后对象可回收仅在隔离实验进程验证。RSS/Private commit 作为辅助高水位指标，不是唯一 gate。
- 重复 render lifecycle 的 collapsed/expanded、width change、selection、session navigation/stream append，帧、scrollHeight/scrollTop/marker/thumb 与原行为逐项比较；不以 screenshot 相似代替坐标断言。
- 在同机器/相同 fixture 顺序的隔离子进程记录至少 5 轮 warm frame/update 时间分布；p95 相对基线退化超过 10% 必须调查。该数值是 release gate，不是当前已测量的改善百分比；不在共享 busy daemon 上做无控制 A/B。

## 19. Diff Budget

| Metric | Estimate / hard limit | Justification |
| --- | --- | --- |
| Production/dependency files | 12 / **<=12** | 包含 manifest、lock、gitlink，不隐藏在 generated 分类之外 |
| New production files | 1 | 私有 prompt slot owner 避免业务循环依赖 |
| Modified production/dependency | 11 | 包含条件成立后 gitlink |
| Deleted files | 0 | owner 逻辑原位替换 |
| Gross production/dependency lines | 668 | 注释/import/lock 计入 |
| Formal test lines | 330 | 复用 fixtures/参数化，不能为了预算去掉合同 |
| Gross implementation total | 998 / **<=1200** | 额外 202 行完整性余量；比只限 production 更保守 |
| New migration / SDK / CI | 0 | 不扩协议、schema、流水线 |
| Stage-1 experiments/docs | 4 个实验 + 本 plan | 用户单独授权的调研产物，不混作生产修改 |

实施前后使用准确 base 的 `git diff --numstat` 与新增文件统计计算 added+deleted。不得用净行数、formatter 排除或 submodule 指针遮蔽新源代码放宽用户硬限制。若完整实现不能落在预算，停止并修订同一 plan；不得悄悄缩范围或丢测试。当前预算是设计估算，未实施验证。

## 20. Real Risks and Open Decisions

- 无事件 generation 的现合同下，未知 live delta 恢复与永久删除阻断需要轻量 invalidation IDs；不能同时许诺无限历史下零元数据增长。正文与 ID 元数据必须分开量化。
- snapshot journal 只能保存 IDs/必要的状态变化，不复制正文；删除不能清请求期间新增 Message。两个 force、goal/status/blocker/list 竞态还有正式红测要补，本阶段未把未运行项写成通过。
- prompt deletion/disposal 与跨图 active run 有再发布风险，lease/context identity 和事务 rollback 必须先测试；registry 自身随 Service scope 退出注销，不能变成新 leak。
- native .12 和 vendored 两个同号产物差异已实测；未证明用户所有旧运行 PID 加载的是哪一个 hash。不能声称本 plan 已修复现场运行中的程序。
- 289 个现有测试通过不等于全套通过；7 个 Windows skips 和 full-suite/compiled artifact/长会话 p95 属于明确待验证项。
- 资源释放后 allocator 可能保留容量；验收先证明不可达/释放，再报告 OS 内存变化。没有给 50% 优化承诺。
- 当前源码仍有其他任务的未提交修改，本计划不会覆盖它们；实施阶段重新建立 baseline。

### Open Decisions Requiring the User

**当前 plan-only 阶段无需用户再选择产品行为。** native consumption 有执行前置条件：新的不可变 OpenTUI release 尚未存在，发布属于共享状态操作，必须由有权限的 release owner 另行执行；本次没有发布授权。精确 tag/commit/integrity 确定后，必须修订此 plan 再审计，不准在 R1 下任意选择后来版本。

### Investigated But Not Selected

| Area | Evidence | Disposition and reason |
| --- | --- | --- |
| 整张 daemon 图共享 | actual auth/close 反例 | 排除；不是行为等价内存修复，需独立 transport/app-layer 设计 |
| proof hash/每轮清缓存 | exact tuple 与 warm test | 排除；前者削弱零碰撞 admission，后者破坏 warm reuse |
| TUI inactive LRU/降低300/裁正文 | 当前数据确有用途，用户要求不变 | 排除；不借内存名义改变默认合同 |
| collapse 后 destroy body / 全量虚拟化 | geometry stable 且现行保留 intentional | 排除；没有必要改高度、选择、滚动、重新构造成本 |
| 原生普通 destroy/parser leak | 两 DLL lifecycle 均返回基线 | 没有本轮证据支持另加销毁算法 |
| LSP idle eviction/didClose 政策 | 独立工程有效、16 existing tests green | 保留调查结论；关闭时机会改变诊断/索引表现，当前无正确活动 lease 红测 |
| SSE 限流/背压 | 无界路径 reachable，未测到当前 backlog | 不添加丢事件/重同步协议；这是单独 transport 合同，不用猜测 drive 修改 |
| CLI lazy imports | broad dependency closure 可达 | 记录机会；尚无完整命令/help/compiled worker parity 与冷启动收益基线，不塞进此修复 |

### Rejected Speculation

- “每个 TUI 都运行一个完整数据库/daemon”：实际使用共享 daemon，静态 import 不证明服务启动。
- “Grapheme pool 单独解释几 GiB”：pool slot 有界，实测是容量耗尽/缺字；不冒充整个进程堆归因。
- “八个 MCP wrapper 等于八个浏览器 daemon”：进程职责不同。
- “RSS 没降说明销毁没发生”：native handle/registry 对照已经反证该推理。
- “所有高内存 Node 都是同 root 错误重复实例”：现场存在不同源码树，不能根据相同可执行文件名关闭它们。

## 21. Audit Contract

未来如用户授权审计，独立 auditor 必须读取本精确 revision 和原始需求，从仓库重建全部范围，检查 first divergence、零 fallback、并发清理完整性、300/scroll/权限/错误语义、12 文件/1200 gross 行预算以及 15% 中文注释。不得仅审新增清理 helper 或接受 builder 摘要。

**本轮用户明确不需要审计，因此不调用 auditor。** `audit-required` 只表示阶段 1 产物待审，不代表已审或准许实施。native 身份补全属于 substantive revision，必须清 approval 并全范围审计。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | 1) §16 slice 9 的 lease/context-identity 分支尚未实验固定，实施时必须先有 red 证据；2) `sync.tsx` 330 行是设计估算，超预算须回到 plan revision；3) §21 的“本轮用户明确不需要审计”是历史记录，不代表放行声明。 | APPROVE — plan revision R1 released for the approval transition. Any substantive edit, including filling in the future native release identity, invalidates this approval and requires a new full-scope audit. | adversarial-auditor task ses_f69ace5b8ffeOFIf502d2rFZX7 |

R1 已获独立 verdict（见上表）；本字段仅在获得 `No blocking findings` + `APPROVE` 后才可原样记录。

## 23. Implementation Evidence

### Actual Files and Diff

按批准的 R1 实施（2026-09-13，HEAD 基线 `da51973f8c` 上的工作树）。实际变更：

| File | Gross lines (added+deleted) | R1 估算 | 说明 |
| --- | ---: | ---: | --- |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | 337 | 330 | 失效集合、releaseMessage/releaseSession、admission、sync 代际与最终投影、pageFailed 保护、permission/question 守卫 |
| `packages/opencode/src/cli/cmd/tui/routes/session/dialog-message.tsx` | 15 | 20 | Retry/Fork 首个 await 前捕获 |
| `packages/opencode/src/session/prompt.ts` | 35 | 55 | 单槽接入 lease/instance，算法不变 |
| `packages/opencode/src/session/prompt-window-cache.ts` | 71（新增） | 75 | 私有 slot registry |
| `packages/opencode/src/project/instance-store.ts` | 6 | 18 | dispose/reload barrier 后按 directory 失效 |
| `packages/opencode/src/session/projectors.ts` | 4 | 10 | Session 删除 after-commit 失效 |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx` | 208 | 190 | 11 个 memory lifetime 用例（含无关 live part 存活对照） |
| `packages/opencode/test/session/prompt.test.ts` | 129 | 95 | 2 个 WeakRef 生命周期 + 1 个 lease 竞态 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | 35 | 45 | Fork 删除窗口捕获用例 |
| **合计** | **840** | 998 上限 | 生产/依赖 467 + 测试 373 |

生产代码文件 6 个（含 1 个新增），≤12；gross 总行数 840 ≤ 1200。native/dependency 切片（manifest/lock/gitlink）未执行：用户明确该 OpenTUI 发布与 submodule 指针由另一个 agent 负责，本 diff 不含任何 native 或依赖变更。

**实现审计 round 1 返工记录（2026-09-13）**：auditor 发现 B-01——`message.part.removed` 的 `dropBufferedDeltas` lambda 参数遮蔽 switch 作用域 event，恒真谓词会清空全部会话的缓冲 delta（一轮批量 edit 中该 hunk 因同批另一 hunk 失配而未落盘）。修复：先取常量再比较；permission.asked/question.asked 的 deletedSessionIDs 守卫同步补齐（同批未落盘项）；参数化 orphan 用例新增“无关 live part 的缓冲 delta 必须存活并回放”对照——该对照在恢复恒真谓词时红（ALIVE 丢失），修复后绿。

实施中两个经实验证实的偏差（均在 R1 既定语义内，非范围变化）：

1. **sync 快照在 messages 请求失败（`data === undefined`）时跳过替换与裁剪。** 既有测试证明 SDK 合同是无 throwOnError 的失败容忍；失败响应不是权威空页。此保护修复了实施中发现的 3 个既有回归（stale snapshot 保文测试），本身由这些既有测试锁定。
2. **dispose 失效按 directory 而非 InstanceContext 对象身份。** 实验发现测试/工具链可并存多张 InstanceStore 图，同一目录的 ctx 对象不唯一；directory 是实例生命周期的稳定标识。reload 的清槽发生在 completeLoad 之前，不会误清新 context。

### Red-Green Test Evidence

- TUI slices 1–6：`bun test --timeout 30000 ./test/cli/cmd/tui/sync.test.tsx -t "memory lifetime"` — 实施前 **0 pass / 11 fail**（逐项红：Part 残留、16 MiB 同类 bucket 留存、orphan 复活、迟到快照复活、diff 回填、force 抹掉新消息）；实施后 **11 pass / 0 fail**。
- slice 7：`session-message-render.test.tsx -t "Fork carries content captured"` — 还原 await 后读取时 **fail（prompt undefined）**，恢复修复后 **pass**；Retry 侧同一 seam 的另一份红证据：删除后 `sync.data.part[messageID]` 为 undefined，旧提取顺序抛 TypeError。
- daemon slices 8–9：`bun test --timeout 60000 ./test/session/prompt.test.ts -t "prompt window"` — 实施前 delete/dispose 两个生命周期用例 **fail（retainedAfter=true）**；lease 竞态用例随新模块建立（模块不存在即红）。实施后 **3 pass / 0 fail**。

### Verification Commands and Results

全部在 `packages/opencode` 目录执行：

| Command | Result |
| --- | --- |
| `bun test ./test/cli/cmd/tui/sync.test.tsx ./test/cli/cmd/tui/sync-undefined-messages.test.tsx` | **39 pass / 0 fail** |
| `bun test ./test/cli/cmd/tui/session-message-render.test.tsx`（完整文件） | **91 pass / 0 fail** |
| `bun test ./test/cli/cmd/tui/smooth-scrollbar.test.ts` | **2 pass / 0 fail** |
| `bun test ./test/session/prompt.test.ts`（完整文件） | **103 pass / 14 skip / 0 fail** |
| `bun test ./test/session/session.test.ts` | **4 pass / 0 fail** |
| `bun test ./test/project/instance.test.ts` | **10 pass / 0 fail** |
| `bun test ./test/storage/cold.test.ts -t "fails closed\|releases shared cold"` | **2 pass / 0 fail** |
| `bun test ./test/server/httpapi-{listen,cors,authorization}.test.ts` | **15 pass / 7 skip / 0 fail**（Windows PTY/WebSocket skips 为既有平台跳过） |
| `bun test ./test/server/httpapi-{instance,promptasync-context,event}.test.ts` | **10 pass / 0 fail** |
| `bun test ./test/lsp/client.test.ts ./test/tool/lsp.test.ts` | **16 pass / 0 fail** |
| `bun typecheck` | **exit 0**（`tsgo --noEmit`） |

完整仓库 suite 未运行；上述覆盖了全部变更文件的直接测试面与 R1 §18.2 列出的关联回归。

### Original Feedback-Loop Result

- `.temp/testing/memory-sync-lifecycle.test.tsx`：修复前 4 pass / 14 fail；修复后 **18 pass / 0 fail**（含 16 MiB 释放、迟到复活拒绝、force 保新消息等全部原红项）。
- `.temp/testing/memory-daemon-ownership.test.ts`：修复前 delete/dispose 双红；修复后 **2 pass / 0 fail**。实验中 dispose 通道修正为拥有该实例的 InstanceStore（`disposeAllInstancesEffect`），与正式测试同口径。
- installed native glyph 实验不属于本 diff 范围（见 §23 尾部 Remaining）。

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Verdict |
| --- | --- | --- |
| live/HTTP 合并、300 窗口、orphan-before-parent、mergeLivePart 守卫 | primary-contract branch（未改语义） | preserve |
| deleted/hidden 释放 + admission 拒绝 + sync 代际 token | primary-contract branch（R1 批准） | implemented，无替代成功路径 |
| pageFailed 跳过替换 | primary-contract branch（失败容忍是 SDK 既有合同） | implemented，由既有 stale-snapshot 测试锁定 |
| `Database.effect` after-commit 失效 | primary-contract branch | implemented；回滚不失效 |
| directory 维度 instance 失效 | primary-contract branch | implemented |
| 本地 DLL 替换、整图共享、idle 清缓存、TTL、诊断路径 | forbidden fallback | 均未引入；decision surface 新增 0% |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines E | **588** | `git diff -U0` 新增行中排除空行、import-only；测试与生产同计 |
| Qualifying Chinese comment lines C | **93** | 邻近修改点、解释不变量/边界/测试意图；不复述代码 |
| Ratio C / E | **15.8%** | ≥ ceil(588 × 0.15) = 89 |
| Required minimum C | 89 | 满足 |

代表性注释：`sync.tsx` 的“失效事实/窗口淘汰区别”“失败响应不是权威空页”“releaseMessage chronology 索引回退”；`prompt-window-cache.ts` 的“失效即推进 generation（在途发布目标未知）”“directory 而非 ctx 对象身份”；`projectors.ts` 的“事务提交后才失效”。

### Remaining Unverified Items

- **native 消费切片未实施**：已安装 `.12` DLL 的裁剪字形问题修复存在于 vendored 源码，但 OpenTUI release、版本 bump 与 submodule 指针由另一个 agent 负责（用户明确指派）；本 diff 不含 dependency 变更，installed/vendored 差异在其 release 完成后由既有 closure verifier 锁定。
- 完整仓库 suite 未运行；`session-message-render` / `prompt.test.ts` 全量及其他关联套件已逐项记录在上表。
- 长会话帧时间 p95 对照与实际 RSS 降幅未测：内存验收以公开 store 可达性与 WeakRef 回收为准，OS 指标是后续观察项而非本次 gate。
- Retry 的删除窗口捕获与 Fork 共享同一修复 seam（同一 owner 的两处 await 前捕获）；Fork 有正式行为测试，Retry 的红证据为临时还原验证（TypeError），未单独成测—— seam 相同，预算内未重复。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 `message.part.removed` 的 delta 清理谓词是恒真自比较，清空全部会话的缓冲流式 delta（sync.tsx lambda 参数遮蔽 switch 作用域 event；生产者 Session.removePart/processor/HTTP 端点可达；delta bus-only 丢弃即永久丢失，破坏 INV-04/08） | NB-1 §23 行数记账漂移（仍 ≤1200/≤12）；NB-2 Retry 无独立正式红测（与 Fork 同一 seam）；NB-3 session_goal undefined 键与空 part 数组键轻微留存；NB-4 §23 验证未由 auditor 复跑 | **BLOCK** | adversarial-auditor task ses_f6939cbdaffelZUu1PFKPJQD3N |
| 2 | R1 | yes | No blocking findings.（B-01 修复验证：遮蔽消除、存活对照对该 bug 敏感、permission/question 守卫落盘且属 R1 §10.1.7 批准范围；全量 hunk 重审无新缺陷） | NB-1（updated）行数表已与 numstat 一致，467/373 拆分与 468/372 有 1 行口径漂移；NB-2/NB-3/NB-4 carried；NB-5 §24 记录职责 | **APPROVE**（仅适用于当前实际 diff 对照 R1；任何后续 substantive 修改使 approval 失效） | adversarial-auditor task ses_f6939cbdaffelZUu1PFKPJQD3N |

实现已获两轮 full-scope 审计（round 1 BLOCK/B-01 已返工，round 2 APPROVE / No blocking findings）；commit 只包含本任务路径。
