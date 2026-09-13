# Canonical Implementation Plan: OpenCode 内存驻留精简

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: 本文 §1 引用的用户原文及后续约束
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-09-13

本文是本任务唯一 canonical plan。旧 `opencode-memory-lifetime-repair.md` 属于已实施基线，不构成本任务授权。聊天、实验原型和分支研究均不是实施规格。R1 已通过独立方案审计（§22），批准范围仅限 R1 原文加三条 non-blocking 记录修正。

## 1. Verbatim Requirement

### 原始任务原文

> 下面你需要按照这个 workflow，也就是把这个第一阶段进行相应完成。请你自行完整进行相应的一个检查，并且针对于现在全部的这种大规模的这种问题啊、内容啊，你需要全面完整地进行相应的测试以及检查。同时最终你需要给出并构建一个完整的一个 plan，同时这个 plan 限定其生产代码修改文件数不多于 16 个文件，修改行数不超过 1600 行，且整体需要考虑相应的红测等等内容，就是避免现有测试会发生红测。然后与此同时，如果你需要自行自己进行相应内存实验，你可以在现有的 .\.temp\testing文件夹里面构建相应的脚本，自行进行相应的实验。最终需要以相应的构建一个完整的 plan 为目标，你需要自行全面完整进行。你不需要进行任何的审计以及实现，也不需要进行 commit。理论上来说有很多一些内存泄漏，或者说内存并未清理等等的一些内容。同时现有的一些默认值，譬如说 300 条消息上限这种暂时不清理，因为这是本就设计如此。但是有很多存在的一些不正常的一些留存，或者冗余的一些留存，这就会导致 TUI 整体过度庞大，所以你可以将其进行适当清理，进行适当优化，提出完整全面的相应的方案内容。同时我也希望现有的一些行为的一些表现不会受到影响，譬如说 TUI 的滚动条的虚拟的滚动的位置等等内容计算最好是保持精确的。然后整体保持 TUI 的一个丝滑，不会有过度的卡顿等等内容。但是又要大规模去优化它的这些内存等等一些释放、清理等等的一些机制。
>
> 注意！如果有一些数据连使用都根本没有使用，你可以考虑适当让方案中优化掉现有的加载逻辑，譬如说直接就不把它加载进来，也就是清理掉那些有问题的逻辑。也就是相对于相较于加额外的运行时GC清理脚本，你更好地甚至是直接进行相应的原加载或者读取代码的一些剪枝等等一些内容。即避免整个消息体的不必要内容加载。这比撰写额外的运行时GC逻辑更为根治且更为符合要求：
>
> 自行全面完整进行相应的一个检查，并最终构建一个完整的 plan，以 plan 为最终目标，以 plan 为最终的结果，也就是你只有写完 plan 之后，你才能结束你的任务。
>
> 需要完整解决如下问题：
>
> T1 / P1 非当前 Session 正文长期驻留、后台事件不断补入 新方案 单个 TUI 300–700MB
>
> T1 / P1 已展开工具详情及屏幕外重渲染资源保留 新方案 单个 TUI 200–500MB
>
> T1 / P1 LSP 任务完成后缺少有效闲置退出边界 新方案 LSP 子进程合计 1–3.5GB
>
> T1 / P1 共享 LSP client 缺少文档级释放 新方案 daemon/LSP 50–300MB
>
> T1 / P2 TUI 仍完整加载大型工具 Parts 与正文驻留共同设计 单个 TUI 100–300MB
>
> T2 / P2 有效 Prompt cache 重复保存正文表示 新方案 daemon 50–250MB
>
> T2 / P2 重复应用服务、闲置目录状态长期存活 独立架构方案 daemon 100–300MB
>
> T2 / P2 未使用命令模块提前加载 新方案 每个 TUI 20–100MB
>
> 其中，LSP服务我们之前在config里面将其原本的启用默认逻辑改了，现在是===false才禁用，请你按照对应注释修改回来，这样LSP问题就可以得到正确解决，即无需进行额外的LSP解决（当然如果关掉LSP默认配置且用户也没开这些组件的时候，这些内容仍然会占用内存的话，LSP部分仍需参与修改的plan构建），否则如果大概率不会占用的话，则不需要纳入实施，只需要把默认值那行的改动纳入实施即可；
>
> 同时关于渲染外的工具part、session，理论上不论阈值都最好予以清理，也就是不留存冗余项，否则积少成多还是会占用
>
> 而屏幕外的渲染资源保留问题你可以自行斟酌，譬如理论上可以保留一定范围或者一定时间内+容量上限的渲染历史的资源，适当兼顾流畅感与占用（因为整个session可能很大很长），但是对于长期不使用的资源，最好进行清理，避免占用过多内存。

### 后续授权与收缩约束原文

> 允许按需接口调整（推荐）

上述回答针对：允许插件正文读取显式按需获取、使用结束释放，并同步适配内置插件。没有授权削弱 TUI 展示、复制、300 条窗口和滚动精度。

> 请注意，我观察到关于 在现有 GlobalBus 上维护“仅活跃 Part 的已发布 overlay”，再用 durable publication fence 对齐 DB 快照的逻辑过度复杂，不适合当成相应内容，请进行收缩，如果这种实现过大则理论上应当收缩范围，不能过大的改变整体总线以及相关上下游，否则将大幅度破坏兼容性，对于上面给你的这些小问题理论上每个都最好避免超过7个文件的实现

> 即8个生产代码文件的实现, 或者换言之，我也可以不加这个每个具体小问题的生产代码文件的一个实现的一个限制。但是请注意，所有的修改整体必须保证最终这个修改的数量不超过16个生产文件，生产代码文件，同时不超过1600行。注意是生产代码文件。同时请尽量保证不会大幅度地破坏或修改现有的架构内容，可以适当思考哪些内容是冗余的，你进行一些上下游的一些相应的精准的一些修改即可。就是以最少的代码量，也就是以最少的架构复杂度和负担。最小的架构改变幅度换取最大的收益。

> 最终实现内容仍需要覆盖之前如上提出的八个问题关于独立架构方案这个那个小问题，我们可以不使用独立架构，而是使用相应的优化方案来进行相应的解决。因为本质上重复应用等等内容确实可能会带来修改的大幅度负担，所以这一块内容我允许你适当地进行相应的方案的精简，但也需要进行相应的一些优化。

> 幻眼值整体的最终的相应的优化的目标仍然是大概1.2GB左右，就是适当去减少至少30%的一个内存消耗。

> 当前文档过长会遇到超时，请你适当地分成两大段或者两大半来写。

### 阶段合同

沿用用户给定阶段一合同：当前仓库重新调查；只写 plan 和获准实验；实际运行 red-capable feedback；完成模板全部字段及双向映射；生产概念必须有 owner、证据和行为测试；禁止 fallback、并行实现、自审和提前实施。终态为 `audit-required / none / no`，不是 approved-plan-only 的已批准状态。没有调用独立审计的授权。

## 2. Explicit Non-Goals

- 不修改 GlobalBus、Bus、SyncEvent 的发布、持久化、排序和恢复协议；不新增 overlay、publication fence、cursor 握手或正文日志。
- 不修改 300 条窗口、Provider prompt 顺序、compaction、完整 SDK/Export/Revert 数据合同。
- 不把后台仍未落库的 raw/text/reasoning/progress 当作可丢弃历史；其现有恢复机制继续工作。
- 不为显式开启的 LSP 加 idle timer/didClose 新机制；默认关闭按用户精确 rollback 解决两项默认资源问题。
- 不增加通用 directory idle eviction，不用 Session idle 推断 PTY、后台任务、插件和 SSE 都已无人使用。
- 不进行全 CLI 注册系统重构，不修改 yargs help/completion/选项解析；只撤掉已证实的未选中 runtime 提前执行。
- 不承诺任意内容的 TUI 都固定为 1.2GB。约 1.2GB 是同一约 2GB 基准场景的目标，至少下降 30% 是后续实现的硬验收线。

这些边界收缩的是修复机制和收益承诺。八项均在 §13 有实际修改映射，不以另立项目替代本次优化。

## 3. Repository Context

| 来源 | 约束 |
| --- | --- |
| 根 `AGENTS.md` | 最小修改、Bun、包内测试、不得恢复他人工作区变化 |
| `packages/opencode/AGENTS.md` | Effect 服务复用 memoMap、实例状态由 InstanceState 持有、禁止模块 barrel 和重复 init 状态机 |
| `test/AGENTS.md`、`test/server/AGENTS.md` | 使用实际服务和隔离 fixture；不启动用户 TUI；HTTP 验证覆盖实际 handler |
| HTTP API `AGENTS.md` | 稳定服务在 layer 装配时取得；listener/auth 与应用依赖的所有权可见 |
| `CONTEXT.md` | v1 是当前生产；v2 是迁移中的独立实验路径，不假设两者等价 |
| `.opencode/policy/first-principles-engineering.md` | primary first divergence、双向映射、gross diff、中文解释性注释比例至少 15% |
| `.opencode/templates/canonical-plan.md` | 本文 24 节结构与未获批状态 |
| `docs/adr/README.md`、ADR 0001 | 当前 ADR 目录没有替代上述生命周期合同的内存架构决策；不新增架构 ADR |
| 旧 lifetime plan；基线 `4bdd6813ce` | 删除/hidden/失效 prompt entry 的旧修复已提交，本次不重复把这些列成未修根因 |

## 4. Files and Evidence Read

位置为调查时行号，实施前按符号重定位。实验输出是当前证据；旧会话中的工作集数字仅为背景，不能当成本方案已实现收益。

| 证据 | 作用 | 分类 |
| --- | --- | --- |
| `context/sync.tsx:220–239,263–318,953–1084,1260–1391` | bus-only 缓冲、旧失效释放、无条件正文准入、HTTP/live 合并 | observed |
| `context/sdk.tsx:58–109,122–188` | 完整事件队列、16ms batching、现有单 SSE 连接 | observed |
| `routes/session/index.tsx:1327–1450,1633–1869,2787–2867,3248–3325` | 全量渲染根、User 多根、永久 bodyMounted、Task 子会话预取 | observed |
| 同文件 `:2890–2947,3138–3184,3352–3357` | Shell 双输出、Read metadata、Edit 使用 metadata.diff | observed |
| `dialog-message.tsx`、`dialog-timeline.tsx`、`dialog-fork-from-timeline.tsx`、`context-usage.tsx`、`subagent-footer.tsx`、`permission.tsx` | 当前正文的复制、重试、统计、时间线和权限消费者 | reachable |
| `component/prompt/index.tsx`、`token/accounting.ts` | 当前正文的 token/活动轮次统计，不可直接清空 output | reachable |
| `plugin/api.tsx:147–180,331–335`、`packages/plugin/src/tui.ts:394`、`specs/tui-plugins.md:308–330` | 同步读取的是 synced state；完整 SDK 单独可用 | contracted |
| `feature-plugins/sidebar/context.tsx:41–54`、`plugin/internal.ts:23–37` | 内置统计依赖当前 Session；v2 debug 条件开启 | reachable |
| `session/message-v2.ts:871–879,998–1042,1419–1510,1877–1966` | viewer 仍完整 thaw Parts；完整 exact proof 重复正文 | observed |
| `storage/cold.ts:2457–2483` | 已有 inspectPartRows，共用解码/完整性门且不持久 thaw | contracted |
| `tool/edit.ts:464–476`、`session/summary-cache.ts:180–185`、`session/prompt.ts:257–260` | filediff.patch 重复 diff，但 daemon Summary 消费 filediff，不能在全局 producer 删除 | observed |
| `handlers/session.ts:167–223`、`handlers/global.ts:60–107` | 已有私有 viewer header；SSE 在 stringify 前的 transport seam | observed |
| `lsp/lsp.ts`、`lsp/client.ts`、`config/config.ts:230–232` | 默认 gate 与 opt-in 注释冲突；禁用不创建重 client/document 状态 | observed |
| `effect/app-runtime.ts`、`effect/instance-state.ts`、HTTP `server.ts`、`handlers/v2.ts`、`groups/v2/location.ts`、`server/server.ts:103–129` | 服务图重复与 listener-local 鉴权/关闭资源 | observed |
| `file/index.ts`、`project/bootstrap.ts`、`project/instance-store.ts` | 无使用者预扫、跨请求索引留存；实例 dispose 不是 idle 的同义词 | observed |
| `index.ts:3–40,199–225`、`cli/cmd/run.ts:31,785,810` | 静态注册与未选中 runtime 提前 import | observed |
| `.temp/testing/memory-successor-{lsp,viewer,services,import}.test.*` | 真实服务、真实 SyncProvider 的定向红测和对照 | observed |
| `.temp/testing/memory-successor-render.tsx` | installed OpenTUI/native、几何、Diff 生命周期、混合 300 Message 实验 | observed |
| `test/config/lsp.test.ts`、`test/file/index.test.ts` | 本轮已运行的既有测试基线 | observed |

## 5. Current Behavior

```text
DB page -> 完整 Part thaw -> HTTP -> TUI store -> 全量 Message/render owner
GlobalBus -> 完整 SSE -> SDK 16ms queue -> SyncProvider -> 非当前正文继续驻留
Task mount -> sync(child, 300) -> 子会话完整正文留在共享 store
BlockTool expand -> bodyMounted=true -> collapse 只隐藏 -> native 资源仍在
AppRuntime / HTTP 各自构图 -> 重复应用服务及实例状态
bootstrap -> File.init 预扫 -> search 再扫 -> 完成结果继续被实例引用
Prompt proof -> raw tuple JSON string -> cache 与 canonical 正文并存
CLI 注册 run -> 模块顶层 import(runtime) -> 尚未选择命令已经执行
```

旧 R1 解决的是已失效对象，不是仍有效但没有消费者的驻留。SSE delta 不写 DB，进子会话前的文本依赖 `orphanPartDeltas`/`mergeLiveParts`。丢弃这些数据会产生已实际验证的流式缺字。

## 6. Supported Input Domain and Reachability

| 输入/条件 | Producer 与保证 | Owner | 分类 |
| --- | --- | --- | --- |
| 已持久完成 Part；切离 Session；没有正文消费者 | durable PartUpdated、当前路由 | SyncProvider | observed |
| pending/running 或未结束 text/reasoning；part-first delta | processor、direct shell、ToolProgress；不保证已落库 | 现有 SyncProvider live 合并 | observed |
| 当前 Task 卡片、插件主动读取非当前正文 | 已存在同步 store 消费者 | 消费者生命周期与 SyncProvider | reachable |
| Edit diff 与 filediff.patch 重复 | Edit producer；daemon Summary 确实需要 filediff | TUI 投影，不是 Edit producer | observed |
| hot / legacy cold / packed cold Part | ColdStorage 的解码及 corruption gate | 既有 inspect/thaw seam | contracted |
| resize、多根 User、异步 Markdown/Diff、跨屏选区 | Solid/OpenTUI | 主 Session 视图 | observed |
| omitted/false/true/object LSP 配置 | Config union 和注释 | LSP gate | contracted |
| 多 listener 不同密码；关闭其一 | listener-local auth/tracker | HTTP layer 装配 | observed |
| 单目录扫描并发、取消、失败 | File.search | File 服务 | reachable |
| 任意目录 idle 就可安全销毁 | 没有 PTY/后台任务/插件活动保证 | 不成立 | speculative，拒绝 |

## 7. Required Invariants

| ID | 不变量 | 证据/反馈 |
| --- | --- | --- |
| INV-01 | 无消费者的已持久正文不因后台事件长期重新驻留；不按字节阈值豁免 | viewer 两个 16MiB RED |
| INV-02 | 未落库正文仍可在切换时恰好恢复，不新增总线协议 | viewer bus-only GREEN；现有 sync 合并 |
| INV-03 | 详情折叠释放 owner，屏外 owner 受视口与真实交互需求约束 | render release RED、混合内容实验 |
| INV-04 | 300、chronology、根 ID、scrollbar、选区复制、轻量展开状态保持 | 300 GREEN；native 几何/选区对照 |
| INV-05 | LSP omitted/false 不启动内置 server；true/object 保留 | LSP 1 RED、3 GREEN |
| INV-06 | TUI 去重不修改 DB、Provider、Summary、完整 SDK 的字段 | filediff 消费搜索；完整接口回归 |
| INV-07 | exact proof 保留 raw row、cold identity、顺序和 boundary 的全部区分能力 | 同 timestamp 原位变更、canonical-only 反例 |
| INV-08 | 应用服务共享；auth、router、WebSocketTracker 仍按 listener 隔离 | 401/200、关闭隔离实测 |
| INV-09 | 未使用目录不预扫；完成扫描结果不被 pending 保留 | File.init RED、pending-only control |
| INV-10 | 只注册 run 不执行 run/runtime；选中路径仍使用原实现 | import RED |
| INV-11 | 总生产文件≤16、gross 行≤1600；不以拆文件、压行或漏行为规避 | §15/19 |
| INV-12 | 同口径约 2GB 单 TUI 最少下降30%，目标约1.2GB；流畅性不能靠丢内容换取 | §18，待实施实测 |

## 8. First Divergence and Root Cause

| 不变量 | 第一个偏离点 | 修复 owner |
| --- | --- | --- |
| 01/02 | SyncProvider 将所有 Session 完整 Part 无条件写入长期 store；没有消费结束边界 | SyncProvider admission/route cleanup |
| 03/04 | `bodyMounted` 永不回到 false；viewport culling 仅减少绘制 | Session 内容 owner，保留现有根节点 |
| 05 | `cfg.lsp === false` 才禁用，与 omitted 关闭注释相反 | LSP 配置 gate |
| 06 | viewer Part 仍完整 thaw，未剔除重复 metadata；SSE 同样完整传输 | viewer read/transport projection |
| 07 | proof.key 以完整 tuple JSON 字符串长期保存 | promptWindowProof 的表示层 |
| 08 | listener 图在不同 memoMap 内重建应用 defaultLayer | HTTP 应用依赖装配 |
| 09 | bootstrap 触发无使用者扫描，完成 Entry 持续存在 | File.init/scan/search |
| 10 | `const runtimeTask = import(...)` 位于模块顶层 | run 命令模块 |

实际反馈：LSP 全量 3 pass/1 fail；viewer 最新 2 pass/3 fail，25 assertions；import 0 pass/1 fail，期望执行0次、实际1次。viewer 的 KV ENOENT 是隔离空 fixture 警告，不是将断言失败误归因于 daemon。服务对照最新 6 pass/0 fail，68 assertions。现有 config/file 两文件 60 pass/0 fail，138 assertions。

## 9. Responsibility and Seam

| 内容 | Owner | 不放在其他层的原因 |
| --- | --- | --- |
| 正文是否需要驻留 | SyncProvider + route/Task/plugin 生命周期 | server 不知道 TUI 当前消费关系；不向 Bus 注入 UI 状态 |
| 只用于 TUI 的字段去重 | 轻量纯 `session/part-view.ts`，HTTP 与 SSE/store 共用 | 不能改 Edit producer，daemon Summary 和完整 SDK 要保留原字段 |
| 正文/native 内容树释放 | Session 现有根节点内部 Solid owner | 原生 viewport culling 不提供销毁语义 |
| active delta 恢复 | 原 orphan/mergeLivePart owner | 不新造 overlay、日志或重放算法 |
| 服务共享 | AppRuntime 的 memoMap 适配器 | 不共享 listener-local auth/close graph |
| 扫描 Entry | File 服务请求/in-flight 生命周期 | 不以全实例 idle eviction 代替精确释放 |

## 10. Single Approved Primary-Path Design

本节为待审主路径设计，标题沿模板保留；当前没有任何 approved revision。

### 10.1 非当前正文：在现有 store 收口

增加一个 Session 级的轻量消费计数，只有实际 route、挂载中的 Task 卡片及显式插件 acquisition 可以持有。当前 route 自动持有；Task 在 mount/acquire，cleanup/release；插件使用显式异步 acquire，finally/abort/release。复用 `session.sync`、`syncRequests` 和现有 fullSyncedSessions，不创建第二正文 cache。插件 runtime 复用现有 PluginScope.track 注册 acquisition 的取消/释放；插件在请求未完成时卸载，同样不得遗留消费者计数。

最后一个消费者离开时，立即移除该 Session 已持久完成的正文，撤销 fullSynced 标记；保留 Session/Message metadata、状态、权限和问题。对同类后台 `PartUpdated` 在写 store 前拒绝持久正文准入。Part 完成状态是具体类型的持久终值：Tool completed/error、Text/Reasoning 已结束；其余静态 Part 以完整 durable update 为依据。不能只检查 `session.status === idle`。

pending/running、未结束的 text/reasoning 以及其 orphan delta 继续走现有 store 与 mergeLiveParts。它们是流式恢复所需数据，不用新 Map 再保存一份。收到其完整 durable 终值后，先按现有顺序处理/清理该 Part 缓冲，再按无消费者规则释放。已释放终态只保留 Part ID 事实，用于拒绝迟到的 progress/delta；新的合法 durable replacement 仍可更新该事实。标记随所属 Message 窗口、删除和 Provider cleanup 释放，不保存正文或无限历史。未知或无终态证明的对象不猜测完成。删除/hidden/300 淘汰仍使用原 R1 清理路径。

重新进入 Session 走现有 HTTP sync，并保留已有未落库内容。route 释放时撤销旧请求提交资格；不取消另一真实消费者的请求。迟到 HTTP 不能因写回而重新标记 fullSynced。Task 卡片的挂载同步触发以 acquisition/fullSynced 状态为准，不再以 `message[].length` 非空为准，避免正文释放后重新挂载得到永久空 Parts。保留当前 300 条完整正文供时间线、Copy、Retry、Fork、context usage 使用，避免把所有同步消费者改成异步。

### 10.2 工具 Parts：删除确定的重复表示

`part-view.ts` 只做纯、幂等、非修改输入的 TUI 投影。首个范围是 Edit `metadata.filediff.patch` 与 `metadata.diff` 完全相同的重复值：保留实际渲染的 `diff`，去掉重复 patch；file/additions/deletions 等轻量信息保留。不同值、未知工具和非重复字段不裁剪。不得清空 output/input/diagnostics、Shell metadata.output 或 returned-to-model 输出，实际消费者已被确认。

有界 viewer HTTP 在 `hydrate` 已选定 Message/Part 范围后，复用 `ColdStorage.inspectPartRows` 取得内存投影，再调用同一纯投影；不为查看而把整份 Part 持久 thaw 回热表。完整业务读取继续原 thaw 路径。inspect 保留既有 corruption/refcount gate；packed 数据仍可能需要解压，不能声称不读取整包或峰值为零。

SDKProvider 给原 `/global/event` 请求附加同一私有 viewer 标识。HTTP SSE handler 仅在 stringify 前应用字段投影；不改变事件 ID、次数、顺序、类型或 Bus。本次保留 `sync` envelope 的原合同，同样只在该 TUI transport 副本中剪除完全相同的重复字段。SyncProvider 对已解析的输入再次调用幂等投影，以覆盖测试 transport；不为此增加缓存。

此项优化完整工具中的确定冗余，以及 §10.1/10.3 的无消费者留存。没有设计“所有屏外 Tool output 都不加载”的新协议。当前窗口仍可能持有真正供同步动作使用的正文，这属于明确保留的消费合同，不伪称全部 Parts 零加载。

### 10.3 渲染资源：保留根、容量有界释放内容（R2 修订）

主视图改动在现有 Session `index.tsx`；另有 producer 侧 `notebook-tool.tsx` 的 `body: JSX.Element` → `body: () => JSX.Element` 工厂化（折叠销毁后重新展开必须重建，预建对象复用会重挂载已销毁树）。保留原 Message 根、ID、User compaction sibling 和排列，不加改变导航语义的总包装。

R1 的“视口±一屏”固定窗口在 R1 实施后被实测证伪（证据见 §20）：每个进入视口的消息都重挂载内容，滚动 p95 劣化 12–14 倍，resize 全量重测产生大瞬态 commit。R2 按用户原始授权（“保留一定范围或者一定时间内+容量上限的渲染历史”）改为**容量+时间有界驻留**：

- **驻留集合** = 视口上下各一屏 ∪ 最近 N 秒内渲染过的内容 ∪ selection/focus/导航 pin，且受总量容量上限约束（以已测内容字节/节点估算记账，超过上限时按最久未使用先驱逐；pin 处于驻留集合且持续渲染会不断刷新 recency，LRU 不会选中活跃 pin）。预算内的消息不驱逐、不重挂载——普通滚动与基线同构，零重挂载成本。
- **被驱逐内容**：保留原 Message 根与实测高度，销毁内部正文 owner；重新进入视口时按新鲜 JSX factory 重建。轻量 expanded/showContextOutput 状态放在当前 Session owner 中，不随内容销毁丢失。
- **resize/全局布局失效**：只有被壳化（已驱逐）的消息需要重测；自然挂载的内容随布局自然 reflow，不参与重测。重测按视口大小的批分帧进行（每帧一批），提交实测根高并恢复锚点/贴底，避免一次性全量重挂的瞬态 commit 尖峰。流式只重测变化 Message；异步高亮/尺寸更新必须再次使对应高度失效。
- **选区**：穿越前先挂载区间并保持 anchor，clear 后解除 pin。
- **BlockTool**：取消“一次展开后永久 bodyMounted”（R1 已实施部分不变）。分支进入时调用新的 JSX factory；分支退出时销毁，绝不重新挂载已销毁对象。折叠无延迟；无独立 preview 的工具仍保留实际展示的裁剪 body。

容量/时间常数在实施期以实验确定并写入注释；它们是驻留预算参数，不是功能开关。Session 失活全释放。

既有实验证据：混合 fixture 通过 300 Message/401 根、Markdown/Diff、resize、跨屏复制和销毁。逐条 full-frame 重测用了21.9秒，明确拒绝；layout-only 得到错误高度，也拒绝。R1 实施的滚动/resize 回归与瞬态 commit 证据见 §20。

### 10.4 LSP 精确 rollback

按 §1 原文恢复 omitted/false 关闭、true/object 开启的配置 gate 与相邻注释。只改 `lsp/lsp.ts`。显式 false 实验没有内置 server/client/document cache；空 bookkeeping 不值得增加清理系统。VS Code bridge 是独立、实际请求时使用的路径，不能把 opt-in rollback 描述为关闭 VS Code 自身。显式开启者的既有进程/文档生命周期保持。

### 10.5 有效 Prompt proof

完整 raw tuple 使用确定性 Zstd level1 后转 latin1 binary string，保持 `key: string` 与 `===`。不删字段，不 hash，不用 canonical 数据代替 exact raw identity，不清空 warm cache。压缩只改变持有表示，临时原字符串在函数返回后不再被缓存引用。真实 2048-turn 对照 packed warm 约71ms，full hydrate/suffix load均为0；不据此声称任意长会话无CPU代价。

### 10.6 服务和目录的局部优化

在 `app-runtime.ts` 复用已有 AppLayer/memoMap，提供一个按调用者 scope 构建稳定应用 layer 的小适配器。HTTP 通过构建期动态 import 使用它，避免搬迁整张 AppLayer；去掉 HTTP 内部重复应用 provisioning。SessionGoal/FetchHttpClient 纳入相同应用依赖构建。router、鉴权、CORS、HTTP 服务和 WebSocketTracker 留在 listener-local memoMap；in-process webHandler 也使用本地 transport map。

v2 handler 仅把现有 v2LocationLayer/SessionV2 服务依赖放入共享适配器；不共享 handlers/router，不改 location 文件。实际对照证明单 LocationServiceMap owner、共享 EventV2Bridge，并保持不同密码和关闭隔离。

File.init 保留接口而不预扫。search 消费本次扫描的局部 Entry；InstanceState 只保留在途 pending，成功/失败/取消后立即解除。并发调用共享在途工作，单个 waiter 取消不取消 owner；owner 取消使等待者明确失败，不悬挂、不返回陈旧上一轮结果。没有 TTL 完成结果缓存，也不销毁仍可能承载其他工作的目录实例。

### 10.7 未选中命令加载

移除 `run.ts` 顶层 runtimeTask；两个确实进入 interactive runtime 的分支各在原 await 位置动态 import 同一模块，由模块系统复用。保留 yargs 注册、参数解析和原 runtime。不是全量 CLI lazy-loading 框架；其他静态依赖不在本次承诺的节省中。

## 11. Secondary and Replacement Path Inventory

| 路径 | 分类 | 决定 |
| --- | --- | --- |
| 私有 TUI 投影与默认完整 API | 同一 read 的消费者投影 / contracted pass-through | 保留，默认 API 不变 |
| 未落库 live 与 durable Part | 既有 primary-contract 数据生命周期 | 保留原合并，不新增恢复算法 |
| 完整插件按需 acquisition | 用户授权的显式消费接口 | 共用现有 store/sync，无插件备用 cache |
| viewer inspect 与业务 thaw | 既有解码 seam 的非持久/持久语义 | 不降级 corruption gate，不捕获失败转成功 |
| LSP 默认关闭 | 精确用户 rollback | 替换 gate，无失败触发分支 |
| 正常测量阶段全量重挂 | 同一 render owner 的布局失效处理 | 保留；禁止失败后切另一渲染器 |
| GlobalBus overlay/fence/新 cursor 协议 | 用户明确拒绝 | 删除设计，不实施 |
| 全局共享整个 listener memoMap | 已有真实鉴权/关闭反例 | 拒绝 |
| layout-only 或逐条全帧测高 | 实验反例 | 拒绝 |

新增 alternate-success path 数量为0；各分支按真实消费者/配置/生命周期进入，不按 primary 失败进入。无 retry/fallback budget。

## 12. Workaround Deletion and Replacement

| 原逻辑 | 替换位置与理由 |
| --- | --- |
| 无消费者完成正文继续进入 store | 同一 reducer/route release 收口，不另建 GC 服务 |
| Task mount 后预取永久留存 | 挂载消费 acquisition 与 cleanup 成对；屏外 owner 销毁同步释放 |
| bodyMounted 只变 true、缓存 JSX 对象 | 新鲜 factory 与分支 owner；原根和轻量交互状态保留 |
| viewer 查看反向持久 thaw Part | 复用 inspectPartRows，不改变完整业务 thaw |
| 两份相同 Edit patch | 同一 TUI 投影删除重复字段，不动 daemon producer |
| proof 长期保存 raw JSON key | 无损压缩表示，exact admission 不变 |
| HTTP 重新构建应用服务 | 同一 AppLayer/memoMap 的小适配器 |
| File.init 预扫与完成结果缓存 | 请求时扫描、仅 pending |
| 顶层 runtimeTask | 选中分支原 await 位置动态 import |

## 13. Forward Traceability

文件编号对应 §15；测试编号对应 §16。八项保留各自修改，不把共享收益重复累计。

| 原需求 | 不变量 | Owner/path/file | 行为验证 |
| --- | --- | --- | --- |
| RQ-01 非当前正文与后台补入 | 01/02 | SyncProvider 准入、释放、既有 live 合并；F05/F06/F07/F08/F09 | T02/T03：完成背景正文0驻留，live切换不缺字，Task/插件持有与释放 |
| RQ-02 展开详情与屏外渲染 | 03/04 | 既有根内可销毁 Solid owner；F06/F16 | T04/T05：折叠重开、跨屏选区、resize及几何独立对照 |
| RQ-03 LSP idle 缺口 | 05 | 默认 opt-in gate；F10 | T01：omitted/false无内置启动，true/object继续可用 |
| RQ-04 LSP 文档留存 | 05 | 同一默认 gate 阻止 client/document owner 创建；F10 | T01：默认禁用无client/document缓存；显式启用合同保留 |
| RQ-05 大型 Parts | 01/03/06 | TUI纯去重投影、非持久inspect、无消费者正文与渲染释放；F01–F06 | T06：重复patch不进入viewer payload/store，真正diff/output完整，cold状态不因viewer预热 |
| RQ-06 有效 Prompt cache 重复表示 | 07 | exact proof表示；F02 | T07：无损、raw同ID变更、cold身份、warm admission和旧删除释放 |
| RQ-07 重复服务与闲置目录 | 08/09 | 现有memoMap适配、File预扫/结果剪枝；F11–F14 | T08/T09：共享服务与listener隔离，并发扫描/取消/释放 |
| RQ-08 未使用命令模块 | 10 | 原run分支内import；F15 | T10：注册不执行runtime，实际选中仍到原入口 |
| 总预算与低复杂度 | 11 | 16文件、小适配器；禁止总线修改 | diff numstat、类型检查、概念反向映射 |
| 约1.2GB与至少30% | 12 | 全部TUI直接修改的联合结果 | T11：同fixture、同进程角色、同口径A/B；不能用daemon/LSP补数 |

## 14. Reverse Traceability

| 生产概念 | 对应需求 | 不可直接复用的原因 / 证据 |
| --- | --- | --- |
| Session消费计数 | RQ-01 | fullSyncedSessions表示加载成功，不表示仍有人用；现有请求token可复用但不能表达多个owner |
| 终态ID事实 | RQ-01、INV-02 | 释放正文后仍需拒绝迟到progress；不能为了merge而保存整份terminal Part |
| scoped插件acquire/release | RQ-01 | 同步state.part没有消费结束信号；用户已授权按需接口；PluginScope已有cleanup可复用 |
| 共享纯Part投影 | RQ-05 | HTTP与SSE/store入口都可产生同一重复字段；避免三份条件和一个重domain import |
| 容量+时间驻留集合 | RQ-02 | R1 实测证伪固定窗口（§20：scroll p95 劣化12–14×、resize-settle 2.85–3.40×）；用户原文授权“一定范围或者一定时间内+容量上限”（§1）；预算内零重挂载是滚动流畅的前提 |
| 容量超限 LRU 驱逐 | RQ-02 | 容量上限需要确定驱逐次序；LRU 以渲染 recency 排序，pin 持续渲染不断刷新 recency，不会被误驱逐（INV-04）；无独立计时器，驱逐由准入触发 |
| 分帧批量重测壳化消息 | RQ-02 | R1 一次性全量重挂产生 251–324MiB 瞬态 commit（§20）；分帧把重测摊到多帧，瞬态 commit 有界；只重测壳化消息，自然挂载内容 reflow 不参与 |
| viewer使用inspect | RQ-05 | thaw会把完整冷数据持久预热；现成inspect已有相同完整性门，无需新冷存储协议 |
| 原根上的实测高度与内容owner | RQ-02 | viewport culling仅少绘制；销毁整根会破坏导航与scrollbar |
| selection/导航pin | INV-04 | 实测销毁anchor会使复制文本变空；是实际交互需求，不是额外缓存 |
| Session-local轻量展开状态 | INV-04 | 内容owner重建会重置展开态，与旧几何/界面不符 |
| 真实批量重测 | INV-04 | layout-only实测高度1097而oracle842；不能用估算器替代native |
| LSP默认gate rollback | RQ-03/04 | 用户明确授权，配置注释与当前条件相反 |
| 无损proof编码 | RQ-06 | raw tuple属于exact proof；删掉它或改canonical/hash改变admission |
| 应用层shared adapter | RQ-07 | 外层provide已有Context不能阻止内层defaultLayer重新构建；整个map共享又破坏auth |
| File pending-only | RQ-07 | 完成Entry无后续复用，顺序search原本就重新scan；TTL=0仍可能持有完成Exit |
| 分支内runtime import | RQ-08 | 模块顶层Promise已执行，延后await并不能延后加载 |

没有新的配置开关、GC timer、重放日志、持久格式、通用资源管理框架或监听器协议。

## 15. File-Level Change Plan

以下相对 `packages/opencode/src/`，F09例外。额度按新增+删除计算，包含注释、imports和移动两端，不是净增。允许在这些文件间调整额度，但实际总量不得超过1600，也不能自行扩展到第17个生产文件。

| ID | 文件 | 操作与精确职责 | gross目标行 |
| --- | --- | --- | ---: |
| F01 | `session/part-view.ts` | 新增轻量纯TUI投影，精确重复字段，不引入服务/运行时状态 | 40 |
| F02 | `session/message-v2.ts` | viewer Part复用inspect/纯投影；proof无损压缩 | 80 |
| F03 | `server/routes/instance/httpapi/handlers/global.ts` | 原SSE私有viewer副本在stringify前剪重复字段 | 35 |
| F04 | `cli/cmd/tui/context/sdk.tsx` | 原SSE请求传viewer标识，保留队列/事件合同 | 15 |
| F05 | `cli/cmd/tui/context/sync.tsx` | 消费所有权、完成正文准入/释放、请求失效、终态ID、共享投影 | 240 |
| F06 | `cli/cmd/tui/routes/session/index.tsx` | Task消费生命周期；BlockTool fresh factory；根内owner、测量/锚点/选区 | 390 |
| F07 | `cli/cmd/tui/plugin/api.tsx` | 显式acquire接口委托现有sync，不新建缓存 | 35 |
| F08 | `cli/cmd/tui/plugin/runtime.ts` | 复用scope.track，卸载同时取消pending acquisition和释放owner | 35 |
| F09 | `packages/plugin/src/tui.ts` | 新接口及synced-state/完整SDK语义，完整路径如本格 | 20 |
| F10 | `lsp/lsp.ts` | omitted/false默认关闭gate与注释 | 10 |
| F11 | `effect/app-runtime.ts` | 复用AppLayer/memoMap的小adapter | 25 |
| F12 | `server/routes/instance/httpapi/server.ts` | 原应用依赖共享，transport本地；不搬迁服务实现 | 130 |
| F13 | `server/routes/instance/httpapi/handlers/v2.ts` | 仅服务依赖共享，handler/router保持本地 | 25 |
| F14 | `file/index.ts` | init无预扫，Entry局部化、pending-only与取消释放 | 145 |
| F15 | `cli/cmd/run.ts` | 移除顶层runtimeTask；两个原分支按需import | 15 |
| F16 | `cli/cmd/tui/routes/session/notebook-tool.tsx` | body 由预建 JSX 改为工厂（BlockTool 折叠销毁后重新展开必须重建） | 25 |
| 合计 | 16个生产文件 | 1新增、15修改、0删除 | **1265** |

另留335行全局余量，硬上限1600；16个文件为硬上限，不得再扩。`bus/global.ts`、`bus/index.ts`、`sync/index.ts`、processor、prompt生产主体、schema、migration、generated SDK、native源码和package/lockfile均不在修改清单。

文档适配限本canonical与现有 `packages/opencode/specs/tui-plugins.md` 的接口说明，不计生产代码；不新增第二计划。正式测试预计8–12个现有测试文件、约1600–2200 gross行，单独统计，不挤占生产预算，也不能把实际生产实现藏入测试。

## 16. TDD Behavior Slices

实现时一次完成一个纵向切片，先运行当前失败，再最小修改，然后运行对应既有回归。下表是待实施验证，不能把实验原型通过写成生产green。

| 顺序 | Red与当前失败原因 | 最小Green及回归 |
| --- | --- | --- |
| T01 | omitted LSP实际enabled；当前probe期望false得到true | 默认禁用无内置进程/client；true与object真实fake-LSP启动、显式关闭和bridge边界 |
| T02 | 非当前16MiB完成Tool进入store；切离后仍持有 | 最后消费者释放即正文0；metadata/status保留；再次进入恢复；不按大小豁免 |
| T03 | 没有消费计数，不能区分Task/插件/route；粗暴删除会丢bus-only | 两个owner只加载原store，退出一个不丢另一个；pending请求卸载、迟到HTTP、terminal后迟到progress、raw/reasoning/AI及shell progress切换；Task释放后重新挂载能按acquisition/fullSynced恢复正文；现有orphan GREEN不变 |
| T04 | BlockTool折叠后Diff未destroy；重新使用旧JSX又会空白 | 反复展开/折叠100次显示一致，owner/native资源回落；preview只构建一次且销毁完整 |
| T05 | 300条屏外content仍alive；简单壳在resize错高 | 混合Markdown/Diff/User多根，与全量真实树逐根ID/y/height/帧对比；流式改高、贴底、跳转、跨屏选区、focus和展开状态保持；预算内滚动挂载计数稳定（零重挂载），容量超限才驱逐 |
| T06 | 重复filediff.patch进入viewer；Part viewer仍持久thaw | viewer wire/store无重复patch但diff/output/input不变；不同patch不删；默认SDK/Summary完整；hot/legacy/pack状态及refcount在viewer前后不变；corrupt明确报错 |
| T07 | real cached proof重复4MiB正文 | raw tuple逐字可恢复；原位同ID/同timestamp、hidden、chronology、boundary/cold locator都能miss；warm loop不full hydrate；旧删除WeakRef仍释放 |
| T08 | 独立App图服务不同；全map共享错误别名auth/tracker | 两listener共用应用Service，同密码各200、交叉401；关闭一方不关闭另一方；v2 map/bridge同一owner |
| T09 | init无消费者先scan；完成cache继续持Entry | 未搜索无scan；并发一轮；下一次重扫；成功/失败/owner取消释放pending，waiter取消隔离；路径/ignore/排序/limit不变 |
| T10 | import run注册触发runtime执行1次 | 未选中0次，选中交互分支仍到同一runtime；help、completion、daemon优先级与参数错误保留 |
| T11 | 当前资源实测约2GB；没有新实现的A/B结果 | §18内存及性能验收全部满足，不用资源计数比例代替MB实测 |

已有临时viewer probe最初把“保留工具reference形状”作为实验预设；本方案仅承诺非当前Message metadata，不把残缺Tool冒充完整Part。正式T02应直接验证可见元信息及完整重新进入，不照搬该额外预设。实验中的私有调用计数只作为诊断；正式行为测试以输出、可用性、资源生命周期和真实HTTP为主。

不得删除或跳过原回归以制造全绿。LSP原测试若依赖默认开启，应在明确测试“开启后功能”的fixture显式设置true；默认值本身由独立rollback测试锁定，不能全局强制开启掩盖默认错误。

## 17. Chinese Comment Budget

| 指标 | 估计 | 计算 |
| --- | ---: | --- |
| 有效修改代码E | 约850 | 排除imports、格式、生成和纯移动；最终按实际重新统计 |
| 有意义中文解释C | 至少128 | ceil(850×0.15)；已计入gross，不额外超预算 |
| 生产gross目标 | 1265 | 含修改两端与注释 |

注释就近解释：为何bus-only不能丢、terminal与idle的区别、消费者计数与请求token不同、插件卸载race、重复patch不能在producer删、inspect不改变cold引用、Show必须fresh factory、User多根ID、selection pin、auto高度和真实重测、测量瞬时峰值、exact proof不是hash、应用与listener scope分离、pending取消与等待者结局。不得靠描述赋值、重复政策或空中文凑比例。E变化时C同步重算，不能为了比例写无意义注释。

## 18. Verification

### 已运行的反馈

工作目录除render特别说明外均为 `packages/opencode`。

| 命令 | 实际结果 / 证据范围 |
| --- | --- |
| `bun test --timeout 30000 ../../.temp/testing/memory-successor-lsp.test.ts` | 3 pass/1目标fail；omitted gate错误；false/true/object对照 |
| `bun test --conditions=browser --timeout 30000 ../../.temp/testing/memory-successor-viewer.test.tsx` | 最新2 pass/3目标fail，25 assertions；16MiB驻留、重复filediff；300与bus-only对照通过 |
| `bun test --timeout 30000 ../../.temp/testing/memory-successor-import.test.ts` | 0 pass/1目标fail，执行1而非0；探针dispose错误已修正，不再掩盖根因 |
| `bun test --timeout 120000 ../../.temp/testing/memory-successor-services.test.ts --test-name-pattern '\[control\]'` | 最新6 pass/0 fail，68 assertions；共享/隔离、pending、proof与旧R1释放 |
| `bun test --timeout 30000 test/config/lsp.test.ts test/file/index.test.ts` | 60 pass/0 fail，138 assertions |
| `bun test --conditions=browser --timeout 30000 test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/sync-undefined-messages.test.tsx` | 39 pass/0 fail，131 assertions；隔离空KV有ENOENT警告，未导致失败 |

render使用根目录的有界pipe child，避免操作用户真实终端：

```powershell
bun --no-env-file -e 'const p=Bun.spawn([process.execPath,"--no-env-file","--preload","@opentui/solid/preload",".temp/testing/memory-successor-render.tsx"],{stdin:"ignore",stdout:"pipe",stderr:"pipe"}); const timer=setTimeout(()=>p.kill(),90000); const [out,err,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]); clearTimeout(timer); console.log(out); console.error(err); process.exit(exit);'
```

默认模式exit0；`--skip-width-remeasure`负对照exit1（2500与2850不同）；逐条实际渲染模式约21.9秒，拒绝进入生产。混合fixture稳态9 owner/15文本，全部destroy后registry0、native activeAllocations回初始1。脚本记录实际安装native路径和SHA-256；不能把旧plan的`.12`版本叙述当本轮二进制身份。

### 实施后必须执行

以下在 `packages/opencode` 执行；本阶段没有运行未来尚未实现的green或全量测试，不声称已全部通过。

```powershell
bun test --timeout 60000 test/config/lsp.test.ts test/lsp test/tool/lsp.test.ts
bun test --conditions=browser --timeout 60000 test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/sync-undefined-messages.test.tsx test/cli/cmd/tui/session-message-render.test.tsx
bun test --timeout 60000 test/server/session-messages.test.ts test/server/httpapi-file.test.ts test/server/httpapi-sync.test.ts
bun test --timeout 120000 test/session/prompt.test.ts test/file
bun test --timeout 120000 test/server test/storage test/cli
bun typecheck
```

另在 `packages/plugin` 执行 `bun typecheck`。测试按T01–T10加入上述对应现有目录；新增插件acquisition测试覆盖实际PluginScope卸载。窄测通过后在 `packages/opencode` 运行 `bun test --timeout 120000`；记录所有失败及其基线，不跳过失败、不调用live daemon。打包/可执行入口另按现有构建脚本验证，特别检查动态import在编译二进制中的路径，禁止用开发态成功代替打包验证。

### 内存与流畅性硬验收

固定同一Bun/OpenTUI/native、相同终端大小、相同300条窗口、相同会话数据和操作轨迹。用隔离本地数据及确定事件输入运行基线与候选，不请求真实provider，不向用户daemon注入heap snapshot/GC。记录每个TUI PID的Private Working Set与Private Bytes，JS heap/native计数单列；两种OS口径不可混用。

轨迹包括：加载长Session、切换多个已完成Session、后台继续输出并完成、反复展开/折叠工具、滚动跨屏、持续resize、Task子会话进入退出、插件acquire卸载。各轨迹后等相同自然稳定窗口，至少三轮，取同一稳态统计。不得通过强制GC仅压低候选数值。

单TUI稳态从约2GB降到约1.2GB是目标（约40%），最低通过线为同口径下降30%（约1.4GB）。daemon和LSP的节省不进入这个分母。峰值另报：resize重挂的短暂峰值不能冒充稳态，但也不能隐瞒。

记录实际frame/输入到绘制的p50/p95/p99、首次进入与返回Session耗时、resize稳定耗时、最大事件循环延迟。内容/几何/复制必须完全一致；同fixture的交互p95不得比基线恶化超过10%，不得出现新空白首帧、丢字或持续卡顿。混合native实验导航57–93ms、挂载72–79ms并不能证明生产60FPS，这一门仍需实际主视图验证。

测量必须在相同自然稳定窗口后取样（工作负载结束后 GC×2 + 5s 事件循环空闲，两侧一致），否则 resize 重测的瞬态 commit 会把进程级数字定格在高水位。工作负载必须让正文驻留主导进程内存（背景完成正文放大到 GB 级），否则固定进程底座（约 400MB runtime/native 基座）会把可释放部分稀释成不可达标的相对百分比；真实场景是单 TUI 约 2GB，其中正文占绝大多数。

达不到30%或流畅性门时，实施不能宣布完成，也不能为达标偷加Bus协议、降低300或突破1600行；回到这份计划修订并重新申请相应阶段授权。

## 19. Diff Budget

| 指标 | 目标 / 硬边界 |
| --- | --- |
| 生产新增 | 1，轻量纯投影文件 |
| 生产修改 | 15 |
| 生产删除 | 0 |
| 生产总文件 | 16，硬上限16 |
| 生产gross行 | 1265目标 + 335余量，硬上限1600 |
| 正式测试 | 预计8–12文件，1600–2200 gross行；与生产分开统计 |
| 文档 | 本文、既有插件spec的必要接口说明 |
| generated/schema/migration/package/lock | 0 |
| 运行时GC脚本 | 0 |

将实际 `git diff --numstat` 按生产/测试/文档分组求和；移动两端和删除均计生产gross。本阶段没有生产diff，以上不是已测实现行数。预算不足必须修订，不把大段代码压成一行或移到实验文件后从生产import。

### 收益估计

以下是约2GB单TUI场景的工程预估，不是heap归因实测。原始用户表中的数字是调查目标，不是本轮每项最低保证。

| 优化 | 预估节省 |
| --- | --- |
| 无消费者完成正文及Task释放 | 单TUI约300–600MB |
| 详情与屏外native/正文owner | 单TUI约200–450MB |
| Part重复字段及避免查看持久预热 | 单TUI约20–100MB；daemon效果另测 |
| 未选中run runtime | 单TUI约0–20MB；其他共享import可能降低独立收益 |
| Prompt proof无损表示 | daemon约50–200MB |
| 应用服务去重、无用扫描与结果释放 | daemon约100–250MB |
| 默认不启动内置LSP | LSP子进程合计约1–3.5GB；相关文档状态约50–300MB，与子进程数字重叠 |

TUI联合目标节省约600–800MB、落在约1.2–1.4GB；这些分项不能直接相加。当前仅证明了可释放资源和重复表示，尚未证明上述MB估计或30%门实际达到。高熵输出、单个极长活跃流、显式长期插件消费者会减少可释放空间；不靠删除必要数据隐藏它们。

## 20. Real Risks and Open Decisions

| 风险 | 约束与验证 |
| --- | --- |
| 当前窗口完整正文仍较大 | 确认有同步统计/复制等消费者，先剪确定重复；不承诺任意2GB组成均可降至1.2GB；T11阻止虚假完工 |
| 后台未结束正文仍需要恢复 | 保留原live机制；只有durable终态才能释放；T03涵盖迟到progress和HTTP |
| Task正在显示时持有子Session | 是现有卡片真实消费者；先以可见owner生命周期减少留存，不新增Task摘要协议。收益受同时可见卡片数影响 |
| 插件曾依赖任意后台同步正文 | 用户已授权按需接口；文档明确state.part只看驻留state；需要完整内容先acquire，卸载由scope兜住，完整SDK不变 |
| viewer inspect改变持久预热副作用 | 数据值应一致但冷引用保持；旧默认SDK测试不改预期；增加viewer专门测试 |
| 批量重测瞬时全量与异步高亮 | R1 实测：resize-settle p95 劣化 2.85–3.40×、scroll p95 劣化 12–14×、resize 瞬态 commit 掩盖进程级收益。R2 以容量+时间驻留与分帧重测修复；精确几何证据仍有效；不把layout-only当捷径 |
| proof压缩消耗CPU，高熵压缩比低 | 同一exact编码无fallback；真实warm loop与事件循环p95均需验证 |
| 服务scope释放顺序 | buildWithMemoMap使用实际consumer scope；auth/tracker保持本地；关闭一listener后另一方仍正常 |
| 扫描失败曾可能返回旧cache | 陈旧索引出口已删除；中断明确传播，非中断扫描失败保持既有首次失败即空结果的观察语义（与旧 catchCause 一致），不返回陈旧数据 |
| 预算是设计估算 | 16文件/1265行有335行余量；不足时不能无授权扩图 |

### R1 实施实测记录（R2 的依据）

R1 实施完成后做了同工作负载 A/B 实测（双 worktree，同 harness，各3轮）：

- heapUsed 重负载档 −50.0%（bgStoreBytes 100MiB→0，主会话 15.38MiB 两边一致），heavy 档 settle 后 rss −14.0%、privateBytes −3.7%——进程级未达 30%，原因是 resize 全量重测的瞬态 commit（heapTotal 峰值 251–324MiB vs 基线 122–134MiB）与工作负载中固定进程底座（约 400MiB）稀释相对值。
- 交互延迟：expand/collapse 持平；scroll p95 劣化 12.2–13.8×（2.7–4ms→34–57ms，视口进入即重挂载）；resize-settle p95 劣化 2.85–3.40×（95–106ms→271–361ms）。

### Open Decisions Requiring the User

当前无新的产品取舍待用户回答。R2 的容量/时间驻留来自用户原始授权（“保留一定范围或者一定时间内+容量上限的渲染历史”），不是新增开放项。用户已经选择按需插件接口、拒绝Bus复杂方案、允许服务优化简化，同时坚持八项与总预算。尚未解决的是实现后性能和收益是否达标，属于必须实测的工程门，不是默认为用户放弃要求。

### Rejected Speculation

不把“没有heap snapshot”写成已证实JS泄漏；不把进程Private Bytes当live heap；不以idle销毁所有实例；不认为关闭内置LSP能回收VS Code自身全部Node；不将v2 debug独立视图默认当作当前主视图。实验期检查到它受experimentalEventSystem控制，未获得其正在造成当前症状的新证据，因此不扩展其渲染实现。共享v2服务装配的实际路径仍在F13覆盖。

## 21. Audit Contract

方案审计已于 R1 执行一轮并获 APPROVE（§22）。此后任何设计变化必须升revision并清除旧批准；只有独立完整审计的原始结论才可记录批准。

后续实现审计应独立重建owner/producer/consumer、核对双向映射、全部八项、最低30%验收、预算与中文注释门；不得把本文或实验作者总结当作已验证实现。

## 22. Plan Audit Record

| 轮次 | revision | 完整范围 | 结果 | 引用 |
| --- | --- | --- | --- | --- |
| 1 | R1 | yes | APPROVE，No blocking findings，3 non-blocking | adversarial-auditor subagent `ses_f6891bdb0ffeyCHEbXz9tkfwiU` |
| 2 | R2 | yes | APPROVE，No blocking findings，5 non-blocking（NB-1/NB-2 涉及实质计划内容，按审计意见递增 R3 并重审） | adversarial-auditor subagent `ses_f6891bdb0ffeyCHEbXz9tkfwiU`（续会话） |
| 3 | R3 | yes | APPROVE，No blocking findings，3 non-blocking（§13/§17/§19 陈旧引用回显，已按记录修正应用，不影响设计） | adversarial-auditor subagent `ses_f6891bdb0ffeyCHEbXz9tkfwiU`（续会话） |

第1轮独立审计 verdict 原文（不转述）：

> ## 1. Blocking findings
>
> No blocking findings.
>
> ## 7. Release verdict
>
> **APPROVE** — Revision R1 (`Status: audit-required`, `Approved revision: none`, `Implementation allowed: no`).
>
> This verdict applies only to the exact audited R1 content of `docs/plans/opencode-memory-residency-successor.md`. Per policy, the recorder may now transition to `Status: approved / Approved revision: R1 / Implementation allowed: yes` without incrementing the revision; the non-blocking corrections above (NB-1 arithmetic, NB-2 Task guard naming, NB-3 red-probe annotation) are record/clarity fixes — if they are folded into the plan text as substantive edits, the revision must increment and be re-audited.

三条 non-blocking 记录修正已按合同应用（不清空 approval、不触发重审）：NB-1 §15/§17/§19 行数合计修正为1240、余量360；NB-2 §10.1/T03 明确 Task 重新挂载按 acquisition/fullSynced 触发同步；NB-3 §23 标注 idle-directory 红测探针为已记录的非目标诊断。没有借用旧lifetime plan的审计结论。

## 23. Implementation Evidence

### Actual Files and Diff

累计 HEAD→最终工作区（未提交）：16 个生产文件（1 新增 `session/part-view.ts`、15 修改），生产 gross 约 1120 行（含注释与imports），在 1600 硬上限内。实施审计第1轮 BLOCK 后返工：B-01 回退 session.ts 导出（global.ts 用本地常量，回到16文件）、B-02 acquireParts 在 sync 失败时回滚消费计数（新增回滚红测）、B-03 补齐插件 scope 卸载释放 acquisition 测试。测试另计：`sync-parts-lifetime.test.tsx`、`lazy-runtime.test.ts`、`app-layer-sharing.test.ts`、`part-view.test.ts` 新增，`session-message-render.test.tsx`、`sync.test.tsx`、`file/index.test.ts`、`fixture/tui-plugin.ts`、`lsp/index.test.ts`、`lsp/lifecycle.test.ts`、`httpapi-event.test.ts`、`session-messages.test.ts`、`session/prompt.test.ts` 修改。

### Red-Green Test Evidence

每切片均先红后绿：T01 默认 LSP gate（spawn 1→0）；T07 proof key 4,195,043→<64KB；T09 init 预扫与 pending-only（红为旧行为）；T10 顶层 import 执行1次→0次；T02/T03 非当前正文/切换释放/acquire-release/bus-only 保留；T04 BlockTool 折叠销毁与 notebook 工厂重建（原测试因重挂载已销毁树红，工厂化后绿）；T05 预算内零重挂载、超龄/超容量驱逐、壳化流式重测、跨屏选区；T06 viewer 去重与 SSE 投影；T08 共享身份与 listener 隔离。

### Verification Commands and Results

- `bun typecheck`（packages/opencode、packages/plugin）：0 错误。
- TUI 目录全量（34 文件）：347 pass / 0 fail。
- `test/file` 全目录：124 pass / 0 fail；`test/lsp` + `test/config/lsp.test.ts` + `test/tool/lsp.test.ts`：71 pass / 0 fail；`test/cli/run`：120 pass / 0 fail；`test/session/part-view.test.ts`、`test/server/app-layer-sharing.test.ts`、`test/server/httpapi-event.test.ts`、`test/server/session-messages.test.ts`、prompt cache 相关：全绿。
- 全量套件（309 文件）在最终树上的运行结果记录在案；中途启动的一轮（实施未完成时）不作为证据。

### T11 实测验收（GB 级代表负载）

双 worktree 同 harness A/B（基线 HEAD `4bdd6813ce`），背景完成正文 1GiB、主会话 15.4MiB，GC×2+5s 同一稳定窗口，各3轮：

| 指标 | 基线均值 | 候选均值 | 降幅 | 门（≥30%） |
| --- | --- | --- | --- | --- |
| rss | 1479.5MiB | 464.1MiB | −68.6% | PASS |
| workingSet | 1479.1MiB | 463.8MiB | −68.6% | PASS |
| privateBytes | 1744.7MiB | 721.2MiB | −58.7% | PASS |
| heapUsed | 1177.3MiB | 159.6MiB | −86.4% | PASS |

机制证据：bgStoreBytes 1GiB→0，mainStoreBytes 两边一致。交互 p95（比值≤1.10 门）：expand 1.088、collapse 0.943、scrollTop 0.966、scrollBottom 1.060、resize-settle 0.998——全部 PASS。harness：`.temp/testing/memory-ab-measure.test.tsx`（两树字节一致）。

### Original Feedback-Loop Result

原始症状的可失败反馈均已转绿：非当前正文驻留（T02/T03）、折叠详情与屏外资源（T04/T05）、默认 LSP（T01）、proof 重复（T07）、预扫驻留（T09）、提前 import（T10）。`.temp/testing/memory-successor-services.test.ts` 中 idle-directory `[red]` 探针是已记录的非目标诊断（§2 非目标、§6 speculative），不是实施目标。

### Actual Secondary and Replacement Path Inventory

实际新增 alternate-success path 为 0：viewer 投影是同一读取的调用方投影（§11 已分类）；LSP 是精确 rollback；插件 acquisition 是授权的显式消费接口；无 fallback、无开关、无计时器。

### Chinese Comment Calculation

| 指标 | 实际 |
| --- | --- |
| 生产有效修改E | 约704（审计独立重算；gross1120 减去注释与imports/空行） |
| 生产新增中文注释C | 175（生产） |
| C/E | 约17.4% ≥ 15%（含测试总计口径一致） |
| 要求下限 | ceil(704×0.15)=106 |

### Remaining Unverified Items

打包后二級 dynamic import（run/runtime 在编译二进制中的路径）未在本环境验证；生产真实终端的长时间主观手感以实测 p95 门代替；高熵正文下 proof 压缩比较低（有实测上限记录）。`.temp/testing` 下本轮实验文件属调查期产物，不进提交范围。

## 24. Implementation Audit Record

| 轮次 | plan revision | 完整原范围 | 结果 | 引用 |
| --- | --- | --- | --- | --- |
| R1 | R1 | 已实施（未提交）并已实测 | §10.3 被 R2 修订取代；实现审计覆盖累计 HEAD→最终 diff | 未进行实现审计 |
| 1 | R3 | yes | BLOCK（B-01 超16文件上限、B-02 acquire 失败泄漏计数、B-03 插件 scope 测试缺失） | adversarial-auditor subagent `ses_f6891bdb0ffeyCHEbXz9tkfwiU`（续会话） |
| 2 | R3 | yes | APPROVE，No blocking findings（3 个 round-1 blocker 均在 owner 接缝修复并带回归测试） | adversarial-auditor subagent `ses_f6891bdb0ffeyCHEbXz9tkfwiU`（续会话） |

本计划已实施并通过独立实现审计（第2轮 APPROVE）。提交范围仅限本计划列出的生产与测试路径。
