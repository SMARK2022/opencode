# Canonical Implementation Plan: Interrupted Directory-State Recovery

> Status: verified
>
> Revision: R8
>
> Approved revision: R8
>
> Audit mode: full-scope
>
> Requirement source: 本文件第 1 节逐字需求；关联已复现故障 `All fibers interrupted without error`、目录级 499/503、`/instance/dispose` 后恢复，以及 ModelsDev、全局 Config、ACP 的真实 Service 中断复现
>
> Implementation allowed: yes
>
> Last updated: 2026-11-12

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 按照这个逻辑，其实我们当前的这个项目里面应该是存在大量的这里缓存的问题。但是这个问题本质上它应该是很好去解决掉。你也可以去查看一下上游，上游我记得官方应该有一些处理这个的，或者说他们有一些 PR 去修复这个东西的，所以你去准确地去检查一下。我希望不要大改接线，不要大改架构，让整体的逻辑更加比较优秀。就比如说按照我的理解，可能是不是能够，比如修改五十行以内就能够解决掉这件事情，同时又不会造成这种性能损伤啊，不会造成这种不必要的缓存释放啊，巴拉巴拉的这种逻辑。所以你去看一下相应的情况，让这套逻辑变得更稳定一点。那注意当前是 read only。然后你可以按照我们的 Document 文件夹里面，就是 DOCS 文件夹里面的 Workflow.md，或者说那个是在 Guide 里面。然后按照那个 Markdown 的要求内容呢，找到其中的 Workflow，按照 First Principle Plan 的原则进行 Verified Plan 的一个构建。也就是说构建 Plan 并审计。同时相应的 Plan 和各种内容应该由你完成。你可以使用 Sub-agent 去完成一些调研啊等等一些东西，但是请注意不要让他们在工作区写入一些东西。

后续原文约束：

> 你的东西要写成 plain，你不要写成。你不要直接转述，我再说一遍。而且 plain 是需要被审计的，你不要去直接转述给他，转述给他，你每一次都换一个说法，每一次都换一个说法，那你到底按哪个说法来，根本就无法固定证据。且成play，然后再重新附加给这个复用同一个task。

> 你可以自己先不要直接加测试，你可以自己去跑一跑这种像一些测试啊，巴拉巴拉的东西。就是你可以自己去内存测试，你去跑一跑有没有这种精彩问题。比如说你让它中间去卡一下呀，或者模拟一下卡顿啊，巴拉巴拉的。就反正你自己去看一看。然后我的意见是你先不要去改工作区，就是你可以继续弄你的那个 plan，按照 workflow 继续走。如果你觉得你要去修改你的 plan的话，你可以继续修改，然后按照 workflow 来走。

> OK，那我们按照这个约定，生产代码修改行数不超过200行，也就是增减总和不超过200行，相应测试修改行数不超过600行。每一个 hunk 你都应该去想一想整体从上游去修改有没有能否去减少不必要的复杂度，或者说不必要的各种各样的进行，或者说比如说从一些更加集中的一些入口点去切入。然后按照现在开始要完整按照 documents 里面的 guide，里面的 workflow.md，你去按照那个逻辑进行对应的 verified implementation and commit 的逻辑。

> 我授权你进行后续甚至六次的这种审计，但是请注意一点，也不要因为审计员给你一个 block，你就去加一个测试，审计员给你一个 block，你就加一个测试。有一些 block 本身可能不合理，或者说它的时间窗口过度，或者说怎么怎么样。反正我已经跟你说了，你的修改代码的行数的硬上限已经给你了，必须按照这个逻辑，不得宽松，自己去执行，自己去检查，自己去尝试。

执行解释：R1 至 R5 为计划阶段；R6 将终态改为 `verified-implementation-and-commit`。用户明确授权 R7 开启新的审计轮次。R7 修正 R6 的三项 blocking findings，不机械增加测试或生产钩子；严格按批准设计实施、验证、独立实现审计后仅提交本任务文件，不修改真实业务数据，不 push。

## 2. Explicit Non-Goals

- 不重启 daemon，不调用真实项目 dispose，不改用户会话、数据库或真实缓存文件。
- 不增加 API、配置、定时清理、自动全实例释放、客户端重试或失败后的备用成功路径。
- 不改变各服务普通 typed failure 的现有缓存/重试语义，不把所有失败都视为中断。
- 不统一重写 `Effect.cached` 的所有使用点；本 revision 只增加已经用真实 Service 复现且属于实际生产调用链的 ModelsDev、全局 Config、ACP Directory。
- 不修改 ACP Usage：默认 `ACPService.make/sendUsageUpdate` 每次构造局部 Map，未使用计划中的跨请求 `UsageService.node`。
- 不修改尚未复现该问题的 Storage、Image、Ripgrep、LocationServiceMap、PromptWindowCache 或请求内一次性缓存。
- 不处理普通模型请求取消、TUI 状态展示或 HTTP 错误映射。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `docs/guides/workflow.md` | 第一性根因、primary path、TDD、全范围独立审计。 |
| `.opencode/policy/first-principles-engineering.md` | owner、证据、反向追踪、中文注释门禁。 |
| `AGENTS.md`、`packages/opencode/AGENTS.md` | `InstanceState` 负责按目录缓存与清理；缓存 lookup 内直接工作，由 `ScopedCache` 去重；`Effect.cached` 用于共享单次计算。 |
| `CONTEXT.md` | Session Drain 在 provider turn 前准备工具；本计划不改变持久会话或历史语义。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/effect/instance-state.ts:26-50` | 当前 `ScopedCache.make` 默认无限 TTL，所有目录服务共用。 | observed |
| `node_modules/effect/src/ScopedCache.ts:132-164,300-394,873-887,1006-1124` | `makeWith` 支持 Exit-sensitive TTL；lookup exit 写入 Deferred；过期在下一次 get 替换并关闭旧 scope；invalidate/refresh 具有不同替换语义。 | contracted |
| `node_modules/effect/src/internal/effect.ts:4096-4159` | `Effect.cached` 等于无限 TTL；共享等待者读取同一个已发布 Exit，不能由单个等待者提前清槽。 | contracted |
| `packages/opencode/src/provider/provider.ts:1734-1739` | Provider 冷初始化直接调用 ModelsDev。 | observed |
| `packages/core/src/models-dev.ts:150-275` | 真实 ModelsDev Service、磁盘/网络加载、无限缓存及 refresh。 | observed |
| `packages/opencode/src/config/config.ts:189,275-322,629-669` | 真实 `getGlobal` 内层无限缓存、外层 InstanceState、显式 invalidate。 | observed |
| `packages/core/src/mcp/connection.ts:205-237,368-410,488-551,581-600` | MCP owner scope、create 中断透传、内层 `Effect.cached`、finalizer 在并发连接之后。 | observed |
| `packages/opencode/src/mcp/index.ts:50-70` | 外层 `InstanceState` 只创建 connection；status/tools 进入 Core 内层 state。 | observed |
| `packages/opencode/src/acp/directory.ts:144-200` | 跨请求 Map + `Effect.cached`；typed failure 删除 entry；refresh 替换缓存。 | observed |
| `packages/opencode/src/acp/directory.ts:116-139`、`packages/opencode/src/agent/agent.ts:431-448` | ACP Loader 可达配置 defect；当前 `tapError` 不删除 defect entry。 | reachable |
| Effect 参考源码 `packages/effect/src/Cause.ts:771-781`（effect-smol 参考仓库） | `Cause.hasFails` 区分 typed failure 与 defect，供 ACP Directory 保留不同 retention。 | contracted |
| `packages/opencode/src/acp/service.ts:619-638,897-909` | 默认 ACP Usage 每次 `makeUsageService(sdk)` 新建局部 Promise Map，不使用 `UsageService.node`；排除该生产修改。 | observed |
| `node_modules/effect/src/internal/effect.ts:3869-3894` | `Effect.onExit` 在完成时关闭可中断性并运行完成器；成功完成器可原子注册成功 generation 的聚合 finalizer。 | contracted |
| `packages/opencode/src/project/instance-store.ts:68-83,101-154` | InstanceStore 已按 entry 身份清理失败 boot；dispose/reload 入口不变。 | observed |
| `packages/opencode/test/effect/instance-state.test.ts:27-103,302-318` | 已有成功缓存、目录隔离、dispose、并发去重测试。 | observed |
| `packages/core/test/models.test.ts` | ModelsDev 现有磁盘、fetch、refresh 测试边界。 | observed |
| `packages/opencode/test/acp/directory.test.ts`、`usage.test.ts` | ACP 现有公开 Service 测试 seam。 | observed |
| `packages/core/test/session-runner-tool-registry.test.ts:160-284` | 真实 MCP SDK + InMemoryTransport 测试 seam。 | observed |
| 上游 issue [#58942](https://github.com/anomalyco/opencode/issues/58942) | 首次请求取消后目录接口持续 499，dispose 后 200，与本地同类。 | observed upstream |
| 上游 PR [#51019](https://github.com/anomalyco/opencode/pull/51019) | V1 小补丁：失败时 invalidate；未合并。 | observed upstream |
| 上游 V2 PR [#46957](https://github.com/anomalyco/opencode/pull/46957) | 已合并失败初始化重试，成功保留无限缓存；包含 replacement identity 防护。 | observed upstream |

实际只读实验：

1. 当前 `ScopedCache.make`：首个 lookup 中断后，第二次 get 得到 `cached-interrupt`，`attempts=1`。
2. 当前 `Effect.cached`：同样第二次 `cached-interrupt`，`attempts=1`。
3. `ScopedCache.makeWith` + 仅中断 TTL=0：第二次初始化成功、第三次复用同一对象、`attempts=2`、superseded finalizer=1。
4. 同样策略下普通 typed failure 连续两次读取 `attempts=1`，保持现有缓存。
5. 单 key `ScopedCache.makeWith` + 仅中断 TTL=0：producer 中断时，两个同代等待者均收到原始纯中断、无 defect；下一次读取初始化成功，后续读取复用同一对象，`attempts=2`。
6. 早期真实 MCP 内存复现受缺失 SDK 阻塞；随后已通过 `bun install --frozen-lockfile` 恢复锁定依赖，稳定反馈脚本现已用真实 MCP SDK + InMemoryTransport 得到 `fastCloses=0` 的红灯。
7. 真实 `ModelsDev.Service`：用内存 `FSUtil.readJson` 卡住首次加载并禁用网络，中断后第二次 `get()` 为 `cached-interrupt`，`readJsonCalls=1`。
8. 真实 `Config.Service`：用内存 `readFileStringSafe` 卡住首次全局加载，中断后第二次 `getGlobal()` 为 `cached-interrupt`，`reads=1`。
9. 真实 `ACPDirectory.Service`：首次 loader 中断后第二次 `get()` 为 `cached-interrupt`，`loads=1`；显式 `refresh()` 成功且 `loads=2`。
10. 隔离构建的 `ACPUsage.Service` 也曾复现 cached interrupt，但 R6 生产链证据证明默认 ACP 不构造该 node；该结果不再驱动生产修改。
11. ACP refresh 候选语义：`ScopedCache.invalidate` 后紧接着 `get`，并发 `get()` 加入新 generation，refresh 与并发读取均得到新值，loader 共执行 2 次。
12. 稳定原始反馈脚本：`D:\Temp\opencode\cache-interrupt-feedback.ts`，SHA-256 `20B7A536BB6A9821531D0015957CA5A2B5B70F430A18E35C6D2B2704590833B6`。在 `packages/opencode` 先设置第 18 节的临时 XDG 环境，再执行 `Get-Content -Raw -LiteralPath "D:\Temp\opencode\cache-interrupt-feedback.ts" | bun --no-install run -`。R7 基线五项均红：InstanceState、ModelsDev、Config、ACP Directory 均为 `All fibers interrupted without error`；MCP `fastCloses=0`，预期修复后同一脚本五项全绿。脚本只使用临时目录和内存依赖，不访问真实业务缓存。

## 5. Current Behavior

Provider/其他目录服务：

```text
HTTP abort 或 session cancel
-> 当前 fiber interrupt
-> InstanceState.get
-> ScopedCache lookup producer 被中断
-> interrupted Exit 写入目录 entry
-> 默认无限 TTL
-> 后续请求 Deferred.await 重放中断
-> 499/503 或 All fibers interrupted without error
-> 只有显式 dispose/reload 清槽
```

嵌套全局初始化：

```text
Provider InstanceState retry
-> modelsDevSvc.get()
-> ModelsDev 内层 cachedGet 已保存首次中断
-> 外层 retry 仍失败

Config InstanceState retry
-> getGlobal()
-> cachedGlobal 已保存首次中断
-> 外层 retry 仍失败
```

MCP：

```text
MCP.status/tools
-> 外层 InstanceState 已成功返回 McpConnection
-> Core 内层 Effect.cached 开始并发连接
-> 某些客户端已写入 s.clients，另一客户端挂起
-> 当前调用中断
-> cached interrupted Exit 永久保存；聚合 finalizer 尚未注册
-> 后续 status/tools 重放中断，部分客户端缺少失败清理
```

ACP：

```text
ACPDirectory.get / ACPUsage.contextLimit
-> 跨请求 Map 取出 Effect.cached
-> 首次 loader 被请求中断
-> Map 继续持有 cached interrupted Exit
-> 后续同 key 调用重放中断
```

Directory 的显式 refresh 可通过替换缓存恢复。Directory 普通 typed failure 当前会删除 Map entry，因此下一次 get 本来就会重试。默认 ACP Usage 的局部 Map 每次调用重新创建，没有这条跨请求故障链。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 首次目录 lookup 被 HTTP/会话取消 | HttpEffect abort / run-state interrupt | 中断属于当前 fiber | 24 个 `InstanceState.make` 调用点 | InstanceState | observed/reachable |
| Provider 冷初始化在 ModelsDev 等待 | Provider -> ModelsDev.get | 内层缓存独立保存 Exit | `provider.ts:1734-1739` | ModelsDev | observed |
| 全局 Config 首次读取等待 | Config.getGlobal | `orElseSucceed` 只处理普通错误 | `config.ts:275-322` | Config global cache | observed |
| 同 key 并发 lookup | 多请求/多服务调用 | 同 generation single-flight | `ScopedCache.get` | 各 cache owner | contracted |
| lookup 成功 | 正常初始化 | 成功 Exit 可按 TTL 缓存 | 后续 get 必须复用 | 各 cache owner | observed |
| 普通 typed failure | 配置/业务错误 | 各服务现有语义不同 | InstanceState/ModelsDev 保持缓存；ACP Directory 保持 typed retry 与纯 defect 缓存 | 各既有服务 | observed/contracted |
| MCP 部分成功后另一连接中断 | 多 MCP server 并发启动 | `create` 透传纯中断 | forEach 未结束、finalizer 未注册 | McpConnection | reachable |
| ACP refresh 与新读取并发 | 显式 refresh + get | 当前 refresh 先替换 Map，后续 get 加入新加载 | `directory.ts:150-193` | ACPDirectory | observed/contracted |
| 已结束 generation 的过期 entry | 新 get | 过期 entry 可替换 | 关闭旧 scope 后 retry | ScopedCache | contracted |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 中断可传递给当前调用者，但不得成为后续新调用的永久目录或全局状态。 | 当前红灯实验与真实 Service 复现 | 缺失 |
| INV-02 | 成功状态继续按现有策略缓存；连续读取不增加正常路径初始化、网络请求或 MCP 重连。 | 当前成功缓存合同与候选实验 | 部分存在 |
| INV-03 | 普通 typed failure 保持各服务当前语义：该缓存的继续缓存，该重试的继续重试，该转成功 undefined 的继续转成功；ACP Directory 纯 defect 继续缓存且不重复 Loader。 | 当前控制流、defect producer 与 Cause 合同 | 需新增 typed/defect 控制测试 |
| INV-04 | 同 generation 并发调用继续 single-flight，所有等待者收到同一个已发布 Exit；中断后的下一 generation 也只能初始化一次。 | ScopedCache Deferred 合同与双等待者实验 | 现有 dedupe 不覆盖中断 generation |
| INV-05 | 被替代 ScopedCache entry 的 finalizer 在 retry 前执行一次；MCP 失败/中断的部分客户端立即清理，成功客户端仅在既有 owner scope 清理时释放，清理可重复但不 double-close。 | ScopedCache 源码、MCP 控制流 | 缺失 |
| INV-06 | 现有 dispose/reload、ModelsDev refresh、Config invalidate、ACP refresh、公开服务接口和持久数据不变。 | 现有公开接口与管理路径 | 既有回归 + 新中断对照 |
| INV-07 | 请求中断及其 retry 只清理当前 generation 的客户端资源，不得清除其他目录或新 generation 的待完成 OAuth transport。 | 模块级 `pendingOAuthTransports` 与跨目录连接实例 | 缺失 |
| INV-08 | ModelsDev/全局 Config 的内层缓存在中断后允许下一次 get 重试；显式 refresh/invalidate 不被自动调用，后台刷新策略不变。 | 真实 Service 红灯实验 | 缺失 |
| INV-09 | ACP Directory 普通 typed failure 仍在下一次 get 重试，纯 defect 仍缓存；显式 refresh 强制新加载，refresh 期间的后续 get 加入新 generation 而非读取旧快照。 | 当前 Map 删除/替换逻辑、defect producer 与候选实验 | 缺失 defect 与并发对照 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `instance-state.ts` 使用默认无限 TTL，使请求作用域的 interrupted Exit 变成目录长期状态。 | InstanceState | 当前 `ScopedCache.make` 红灯实验 |
| INV-01、INV-05 | Core MCP 使用 `Effect.cached` 无限保存中断，且聚合 finalizer 注册晚于并发连接。 | McpConnection | `connection.ts:488-551` 与红灯实验 |
| INV-08 | ModelsDev 和 Config global 用独立无限缓存保存首次中断，外层 InstanceState retry 无法清除。 | ModelsDev / Config global | 真实 Service 实验 7、8 |
| INV-01、INV-09 | ACP Directory 的 Map 长期持有 `Effect.cached`；typed failure 处理不覆盖中断。 | ACPDirectory | 真实 Service 实验 9 |

红灯反馈信号：本文件第 4 节固定路径和哈希的稳定脚本已证明 InstanceState、ModelsDev、Config、ACP Directory 均重放中断，MCP 部分客户端未清理。候选 ScopedCache 语义实验通过。实施时须把行为固化为第 16 节测试，并原样重跑稳定脚本。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 目录 entry retention | InstanceState | 按目录缓存成功状态并管理 entry 生命周期 | 所有目录服务在此共享 `ScopedCache` | Provider、Session、HTTP 不拥有通用 entry retention |
| 模型目录全局缓存 | ModelsDev | `get` 共享目录数据，`refresh` 显式更新 | cachedGet/populate/invalidate 均在这里 | Provider 不应直接清空 ModelsDev 内部状态 |
| 全局配置缓存 | Config.getGlobal | 全局配置读取与显式 invalidate | cachedGlobal 由 Config 自己创建 | 外层 InstanceState 不知道全局 entry 身份 |
| MCP 连接池初始化与清理 | McpConnection | 共享完整连接池并释放客户端 | 内层 state 与 clients 均在这里创建 | 外层 wrapper 只看到 connection |
| ACP 目录快照 | ACPDirectory | 按目录缓存快照、失败重试、显式 refresh | 现有 Map 与 loader 均在这里 | Provider 不拥有 ACP 快照生命周期 |
| 显式 dispose/reload | InstanceStore | 保留现有管理入口 | 已有 owner | 不增加自动补偿路径 |

## 10. Single Approved Primary-Path Design

### A. `packages/opencode/src/effect/instance-state.ts`

- 引入 `Cause`、`Duration`、`Exit`。
- 将 `ScopedCache.make` 改为 `ScopedCache.makeWith`，lookup/capacity 不变。
- `timeToLive(exit)`：`Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)` 时 `Duration.zero`，否则 `Duration.infinity`。
- 加中文注释说明“请求中断不得成为目录长期状态；成功与普通错误保持原缓存”。
- 使用 entry 自身 TTL，而不是 get 后按 key invalidate，避免旧 generation 晚到时误删显式 reload/dispose 后的新 entry；不增加 identity 字段。

### B. `packages/core/src/mcp/connection.ts`

- 引入 `Duration`、`ScopedCache`；保留现有 `Cause`/`Exit`/`Scope` 使用。
- 将 `Effect.cached(init)` 改为容量 1 的单 key `ScopedCache.makeWith`，lookup 仍为现有 init，`timeToLive(exit)` 与 InstanceState 相同。
- 内部 `state = ScopedCache.get(cache, "state")`；所有现有 status/clients/tools 等调用点不变。共享 Deferred 先向同代所有等待者发布同一个 Exit，后续新 get 才替换过期 entry。
- 保留 init 的 `Effect.provideService(Scope.Scope, scope)`，使聚合清理仍归属 McpConnection owner scope。
- 将现有客户端关闭体提为本地 `closeClients`：先取出并清空 clients/defs/instructions，再关闭取出的客户端和进程后代；不在该 effect 中操作 `pendingOAuthTransports`。
- 在 forEach 之前注册仅含 `closeClients` 的 owner finalizer。它覆盖 forEach 内及后续任意中断点的部分客户端，失败直接 dispose 也只重复执行幂等客户端清理。
- 用 `Effect.onExit` 包住 forEach：失败时执行 `closeClients`；成功时通过 `Effect.addFinalizer` 注册聚合 finalizer，聚合 finalizer 依次执行 `closeClients` 与既有 `pendingOAuthTransports.clear()`。
- `Effect.onExit` 完成器在 `fiber.interruptible=false` 下运行，因此 forEach 成功与聚合 finalizer 注册之间没有可中断 checkpoint；失败 generation 不注册含 OAuth 的 finalizer。该结构修复 R6 B-01 的极窄窗口，不增加生产测试钩子或额外同步原语。
- 成功 dispose 时后注册的聚合 finalizer 先按原顺序关闭客户端并清理 OAuth，较早的 `closeClients` finalizer 随后空操作；失败 dispose 只执行较早的客户端清理。普通错误仍由 create 转为 failed status 并形成成功 State。

### C. `packages/core/src/models-dev.ts`

- 引入 `Cause`、`Exit`、`ScopedCache`，保留现有 `Duration`。
- 用容量 1 的单 key `ScopedCache.makeWith` 替代 `Effect.cachedInvalidateWithTTL`：lookup 为现有 populate，成功和非中断失败保持无限 TTL，仅中断 TTL=0。
- `get()` 改为 `ScopedCache.get(cache, "models")`；现有 refresh 中 `invalidate` 改为同一 key 的 `ScopedCache.invalidate`。
- 保留现有 fetch、磁盘读取、Flock、后台 60 分钟 refresh、错误处理与事件发布；不在 get 中自动 refresh，不增加网络重试。

### D. `packages/opencode/src/config/config.ts`

- 引入 `Cause`、`ScopedCache`，保留现有 `Duration`/`Exit`。
- 用容量 1 的单 key `ScopedCache.makeWith` 替代 `cachedGlobal`：lookup 仍为 `loadGlobal().pipe(log, orElseSucceed({}))`，仅中断 TTL=0。
- `getGlobal` 改为读取该 key；现有 `Config.invalidate` 改为失效同一 key。
- 普通错误仍转成成功默认配置并缓存；不新增文件监听、自动更新或重复读取。

### E. `packages/opencode/src/acp/directory.ts`

- 引入 `Cause`、`Duration`、`Exit`、`ScopedCache`，移除不再需要的 `SynchronizedRef`。
- 用按 directory key、`capacity: Number.POSITIVE_INFINITY` 的 `ScopedCache.makeWith` 替代 `Map<string, Effect<Snapshot>>`：lookup 为 `loader.load(directory)`，不按 LRU 驱逐 key。
- 仅在 `Exit.isFailure(exit) && (Cause.hasInterrupts(exit.cause) || Cause.hasFails(exit.cause))` 时使用 `Duration.zero`，其余使用 `Duration.infinity`。这同时覆盖中断和现有 `tapError` 的 typed failure retry；纯 defect 等其他 Cause 继续缓存，不重复 Loader。
- `get(directory)` 使用 `ScopedCache.get`。
- `refresh(directory)` 使用同一 key 的 `ScopedCache.invalidate` 后紧接着 `ScopedCache.get`，使后续 get 加入新 generation；不使用会允许并发 get 先读旧值的直接 refresh 形式。
- 保留 `build`、`variants` 和 Loader 接口，不改变快照内容。

共同执行路径：

```text
interrupt
-> 当前调用收到原中断
-> 当前 generation cleanup/TTL 失效
-> 后续调用建立唯一新 generation
-> 成功结果按原策略复用
```

无后台补偿重试、自动 dispose 或替代成功路径。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 原 dispose/reload | current | existing compatibility | yes | 既有显式管理入口 | 保留，不自动调用 |
| ScopedCache TTL=0 后的下一次 get | proposed | primary-contract branch | yes | 仅失效 generation 的后续读取 | 主路径 |
| MCP failure cleanup | proposed | resource cleanup | no | 失败 generation | 必须，不吞错、不返回成功 |
| ModelsDev refresh / Config invalidate / ACP refresh | current | existing compatibility | yes | 仅显式调用 | 保留原触发条件，不作为自动恢复 fallback |
| ACP Directory 普通失败后的下一次 get | current + proposed retention equivalent | primary-contract branch | yes | 既有普通失败 retry | 用 TTL=0 保留原行为 |
| HTTP 499/503、UnknownError 映射 | current | diagnostic | no | 既有错误边界 | 保留 |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 手动 `/instance/dispose` 恢复中毒目录 | 清理永久缓存的中断 | 后续读取自行建立新 generation | 不删除显式管理入口；消除恢复依赖 |
| 全 daemon 重启 | 清空所有进程内缓存 | 按 entry 失效，避免影响其他目录 | 不新增重启逻辑 |
| ACP Directory 手写 Map + typed failure 删除 | 去重加载并允许普通失败 retry | ScopedCache Exit-sensitive TTL 同时承载两种失效 | `acp/directory.ts` 内折叠，不改 Loader API |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01/02/03/04/05 ScopedCache | Exit-sensitive TTL | `instance-state.ts` | interrupted retry + success/typed retention + single-flight + finalizer |
| INV-01/02/04 MCP | 单 key ScopedCache | `core/mcp/connection.ts` | 同代双等待者、后续 retry、成功复用、single-flight |
| INV-05/07 MCP | forEach failure `closeClients`；成功后 owner finalizer | `core/mcp/connection.ts` | 部分客户端关闭、直接 dispose 与成功 retry 的 OAuth 隔离 |
| INV-08 ModelsDev | 单 key ScopedCache + 既有 refresh invalidate | `core/models-dev.ts` | 真实 Service 首次 readJson 中断后 retry；成功复用；既有 refresh/fetch 回归 |
| INV-08 Config global | 单 key ScopedCache + 既有 invalidate | `config/config.ts` | 真实 Service 首次全局读取中断后 retry；默认配置普通错误与显式 invalidate 回归 |
| INV-01/03/09 ACP Directory | 按目录 ScopedCache；中断或 typed failure TTL=0，纯 defect 无限缓存；invalidate+get refresh | `acp/directory.ts` | 中断 retry、typed failure retry、纯 defect 缓存、成功复用、refresh 与并发 get 新值 |
| INV-02/04/06 全部 | 既有公开 API 与显式管理路径 | 五生产文件 | 各现有测试、并发 single-flight、typecheck |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `Cause.hasInterrupts` | INV-01、INV-03、INV-08、INV-09 | 当前中断红灯与普通错误控制 | 只识别中断，保留普通 failure/成功语义 |
| `Duration.zero/infinity` | INV-01、INV-02、INV-09 | ScopedCache 合同 | 现有无限缓存无法按 Exit 或服务现有失败策略区分 |
| MCP 单 key ScopedCache | INV-01、INV-04 | Effect.cached 无限 TTL；Deferred 合同 | 逐等待者 invalidate 会破坏共享 Exit 分发 |
| ModelsDev/Config 单 key ScopedCache | INV-08 | 真实 Service 红灯 | 外层 InstanceState 无法清理独立内层缓存 |
| ACP Directory 中断或 typed failure 零 TTL | INV-03、INV-09 | 当前 typed failure 删除 Map entry；配置 defect 不删除 | 仅中断零 TTL 会改变 typed failure retry；全失败零 TTL 会改变纯 defect 缓存 |
| ACP Directory invalidate+get refresh | INV-06、INV-09 | 当前 refresh 替换 Map；候选并发实验 | 直接 refresh 在替换前可能让并发 get 读取旧 entry |
| MCP `closeClients` + 成功后 owner OAuth finalizer | INV-05、INV-07 | 部分初始化与模块级 OAuth Map | 请求失败资源清理与成功 generation 全局清理边界不同 |

不新增跨模块 helper、服务、配置、依赖、后台任务或 generation identity；MCP 局部 `closeClients` 由真实资源泄漏证据支持。不通过共享抽象隐藏各服务不同的普通失败语义。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/effect/instance-state.ts` | modify | makeWith + interrupt-only TTL | 约 +7/-1 |
| `packages/core/src/mcp/connection.ts` | modify | 单 key cache、generation 客户端清理 | 约 +20/-12 |
| `packages/core/src/models-dev.ts` | modify | 单 key cache、既有 refresh invalidate | 约 +10/-3 |
| `packages/opencode/src/config/config.ts` | modify | 单 key global cache、既有 invalidate | 约 +10/-4 |
| `packages/opencode/src/acp/directory.ts` | modify | 按目录 ScopedCache、保留失败 retry 与 refresh 语义 | 约 +18/-35 |
| `packages/opencode/test/effect/instance-state.test.ts` | modify | InstanceState 行为回归 | 约 +55 |
| `packages/core/test/session-runner-tool-registry.test.ts` | modify | MCP 中断/retry/cleanup/OAuth 回归 | 约 +85 |
| `packages/core/test/models.test.ts` | modify | ModelsDev 真实 Service 中断回归 | 约 +45 |
| `packages/opencode/test/config/config.test.ts` | modify | 全局 Config 中断与 invalidate 回归 | 约 +45 |
| `packages/opencode/test/acp/directory.test.ts` | modify | ACP Directory 中断/普通失败/refresh 并发回归 | 约 +65 |

生产修改 5 文件，预计约 +65/-55；测试修改 5 文件，预计约 +295。ACP Usage 及其测试已移除，因为默认生产调用链没有使用该跨请求 Service。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | InstanceState gated first lookup + acquireRelease；中断后第二次 get | 当前重放中断 | 第二次成功、旧 finalizer 先于 retry 一次、第三次同对象 | INV-01/02/05 |
| 2 | InstanceState typed failure 两次读取 | 用于拒绝过度修复 | attempts=1，failure 不变 | INV-03 |
| 3 | InstanceState retry generation 两个并发 get | 新实现不得破坏 single-flight | 初始化只增加一次，两个调用同值 | INV-04 |
| 4 | MCP fast client 成功、hanging client 中断；两个同代等待者 | 当前 cached interrupt 且 fast close=0 | 等待者均收原中断无 defect，fast close=1 | INV-01/04/05 |
| 5 | MCP 修复 hanging 后 retry；失败后直接 dispose 的 OAuth 对照 | 当前无法 retry；防止提前全局清理 | retry 成功且 single-flight；直接 dispose 不清其他目录 OAuth；成功 dispose 保持原清理 | INV-02/05/06/07 |
| 6 | 真实 ModelsDev 首次 readJson 中断后第二次 get | 实测第二次 cached interrupt、reads=1 | 第二次重新 readJson 并成功，第三次复用；既有 refresh(true) 仍强制 fetch+invalidate | INV-02/04/06/08 |
| 7 | 真实 Config.getGlobal 首次读取中断后第二次 get | 实测第二次 cached interrupt、reads=1 | 第二次重新读取并成功；普通错误仍为默认配置；显式 invalidate 仍强制下一次读取 | INV-02/03/06/08 |
| 8 | ACP Directory 首次 loader 中断后第二次 get | 实测 cached interrupt | 第二次 loader 重试成功，第三次复用 | INV-01/02/04 |
| 9 | ACP Directory typed failure、纯 defect 分别连续 get；成功缓存后 refresh 并同时 get | typed failure 当前删除 Map；纯 defect 当前保留 Map；refresh 当前替换 Map | typed failure 下一次 retry；纯 defect 连续读取不重新 Loader；refresh/并发 get 均新值，加载次数符合单一新 generation | INV-03/06/09 |
| 10 | 第 4 节稳定原始反馈脚本（固定路径与 SHA-256） | 当前五项均红 | 同一脚本五项全绿 | 原始症状 |

测试观察公开行为与独立预期值，不断言私有 helper；不依赖生产环境 dispose。等待使用 Deferred readiness，不用固定 sleep 猜测初始化状态。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 220 | 生产+测试有效改动；排除 import-only、formatter-only、generated、pure move |
| Required Chinese explanatory comments `C` | 33 | `ceil(220 * 0.15) = 33` |

生产至少 7 条解释各 owner 的中断 retention、普通失败差异、同代 Exit 分发、ACP refresh 与 MCP 客户端/OAuth 清理边界；测试在 red 行为、并发去重、普通错误保留、资源仅释放一次、跨目录 OAuth 和 refresh 并发附近分布解释性中文注释。实施按实际 E/C 重算，不复述测试名凑数。

## 18. Verification

所有 Core 测试和反馈脚本在启动 Bun 进程前使用以下隔离环境，避免 `Global.Path` 指向真实用户目录；每个命令都在新的 PowerShell 进程内设置，不写回用户环境：

```powershell
$env:XDG_CACHE_HOME = "D:\Temp\opencode\cache-feedback-xdg\cache"
$env:XDG_CONFIG_HOME = "D:\Temp\opencode\cache-feedback-xdg\config"
$env:XDG_DATA_HOME = "D:\Temp\opencode\cache-feedback-xdg\data"
$env:XDG_STATE_HOME = "D:\Temp\opencode\cache-feedback-xdg\state"
$env:OPENCODE_TEST_HOME = "D:\Temp\opencode\cache-feedback-home"
```

这些目录只保存测试生成的缓存、配置、数据和状态。现有 `models.test.ts` 删除/改写的 `models.json` 因而位于临时 XDG cache，而非真实用户 cache。

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/effect/instance-state.test.ts` | `packages/opencode` | InstanceState 中断、缓存、finalizer、并发及既有回归 |
| `bun test test/models.test.ts` | `packages/core` | ModelsDev 中断 retry 与既有磁盘/fetch/refresh 回归 |
| `bun test test/session-runner-tool-registry.test.ts` | `packages/core` | 真实 MCP SDK 内存传输 retry/cleanup/OAuth 与工具行为 |
| `bun test test/config/config.test.ts` | `packages/opencode` | 全局 Config 中断、默认配置、invalidate 与既有回归 |
| `bun test test/acp/directory.test.ts` | `packages/opencode` | ACP Directory 中断、普通失败、defect 与 refresh 并发 |
| `bun typecheck` | `packages/opencode` | InstanceState、Config、ACP 类型 |
| `bun typecheck` | `packages/core` | ModelsDev、MCP 类型 |
| `git diff --check`、`git diff --stat`、生产 diff 行数复核 | repo root（只读检查） | whitespace、范围、diff 预算 |
| 上述 XDG 环境后，`Get-Content -Raw -LiteralPath "D:\Temp\opencode\cache-interrupt-feedback.ts" \| bun --no-install run -` | `packages/opencode` | 固定 SHA-256 的同一脚本：实施前五项红、修复后五项绿；MCP 以 `setNotificationHandler` 的 watch 安装信号作为 readiness，不使用固定 sleep；不操作用户 daemon 或真实缓存文件 |

锁定依赖已通过 `bun install --frozen-lockfile` 恢复，Effect `4.0.0-beta.83` 与 MCP SDK `1.29.0` 均存在。本计划阶段尚未运行完整 suite 或 typecheck；第 4 节是真实 Service 故障注入，不能冒充完整 suite green。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 复用现有测试文件 |
| Files modified | 10 | 5 生产 + 5 测试 |
| Files deleted | 0 | 无 |
| Production lines | 约 +65/-55 | 五个实际生产 cache owner；ACP Directory 手写 Map 折叠抵消新增 |
| Test lines | 约 +295 | 各服务公开行为、并发、资源、refresh 与普通错误控制 |
| Generated lines | 0 | 不改生成物 |

50 行是最初主链的优化目标，后续真实 Service 红灯扩大了必要范围。R7 的硬预算为生产代码新增与删除总行数 `<= 200`，测试新增与删除总行数 `<= 600`；当前估算分别为 120 和 295，均在预算内。不得通过共享抽象或压缩测试隐藏必要范围。

## 20. Real Risks and Open Decisions

- TTL=0 是 lazy expiry：不会定时清缓存；下一次 get 才替换，符合避免不必要释放的目标。
- 同一代等待者在 producer 中断时仍收到同一个原中断；ScopedCache 先完成 Exit 分发，后续调用才 retry。
- `pendingOAuthTransports` 是模块级共享 Map；请求失败只执行当前 generation 的 `closeClients`，全局 OAuth 清理仍仅属于成功 generation 的 owner disposal。
- ModelsDev 的 refresh 会继续执行现有网络更新和 invalidate；本计划不在 get 中自动 refresh，避免新增网络流量。
- Config 普通错误仍返回默认配置并作为成功值缓存。
- ACP Directory 需区分 typed failure retry 与纯 defect 缓存，不能使用全失败零 TTL，也不新增统一 helper。
- 默认 ACP Usage 的局部 Promise Map 每次构造，R7 不修改 `usage.ts`，也不为其新增持久缓存或生产接线。
- ACP refresh 采用 invalidate+get 保持后续 get 加入新 generation；并发对照必须证明没有返回旧快照。
- MCP 外部 Promise 本身可能不可取消；本计划只保证 Effect 资源状态和已建立 client 清理。
- Storage、Image、Ripgrep 尚未完成同类真实 Service 复现，不因形态相似而修改。
- R6 的 MCP 极窄窗口通过 `Effect.onExit` 的不可中断成功完成器从结构上关闭，不增加仅服务测试的生产钩子；现有 forEach 中断、成功 dispose 和失败直接 dispose 行为测试继续保留。

### Open Decisions Requiring the User

无产品选择。R6 终态为 `verified-implementation-and-commit`；实施与提交须依次通过计划批准、TDD、验证和独立实现审计。

### Rejected Speculation

- 不预防性修改 Storage、Image、Ripgrep 或其他没有本次故障证据的缓存。
- 不增加定时刷新、固定短 TTL、全实例 dispose 或后台补偿重试。
- 不引入旧 generation identity：entry-local TTL 不执行旧 producer 按 key 删除 replacement。
- 不把 ModelsDev、Config、ACP Directory 的不同普通失败语义统一成一个全局策略。
- 不修改默认生产链未使用的 ACP Usage node，也不把默认局部 Promise Map 误当作跨请求缓存。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries and transcripts as untrusted.
- Audit the complete original scope on every round, including R7 的生产链范围修正和稳定反馈脚本。
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15 percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | Blocking B-01：每个 MCP 等待者分别 invalidate，会破坏同代等待者的 Exit 分发；Blocking B-02：失败 generation 的清理会误删其他目录的待完成 OAuth 流程 | 无额外 non-blocking findings | BLOCK | `ses_e357bd7f2ffepAEpsuzD8TAphF` |
| 2 | R2 | yes | Blocking B-01：提前注册 owner finalizer，使失败 generation 的 dispose 新增全局 OAuth 清理 | 真实 MCP SDK 的 red-green 仍未执行（环境限制已记录） | BLOCK | `ses_e357bd7f2ffepAEpsuzD8TAphF` |
| 3 | R3 | yes | No blocking findings | 真实 MCP SDK 的 red-green 尚未执行；实施时必须执行真实 SDK 测试 | APPROVE | `ses_e357bd7f2ffepAEpsuzD8TAphF` |
| 4 | R4 | yes | Blocking B-01：ACP Directory 的全失败零 TTL 改变了现有 defect 缓存语义 | 明确 ACP 两个 ScopedCache 使用无界 capacity；审计期间本地 Effect 源文件不可读，使用参考源码复核 | BLOCK | `ses_e357bd7f2ffepAEpsuzD8TAphF` |
| 5 | R5 | yes | No blocking findings | 真实 MCP SDK 与本地 `node_modules/effect` 源文件仍存在依赖缺失记录；真实 MCP red-green、完整测试和 typecheck 尚未执行，实施时必须补齐依赖前提并执行第 16、18 节验证 | APPROVE | `ses_e357bd7f2ffepAEpsuzD8TAphF` |
| 6 | R6 | yes | Blocking B-01：MCP 清理未覆盖 forEach 成功到 owner finalizer 注册之间的中断窗口；Blocking B-02：ACP Usage 修改点不在默认 ACP 生产调用链上；Blocking B-03：原始故障反馈脚本没有进入 canonical plan | 真实 MCP SDK red-green 尚未执行；实施证据须分别记录生产与测试实际 diff；提交仅包含本任务路径 | BLOCK | `ses_e34260315ffebvuUTFgB1yE56w` |
| 7 | R7 | yes | Blocking B-01：ModelsDev 验证命令会删除并改写真实用户缓存 | 固定反馈脚本仍使用 `Effect.sleep("50 millis")` 等待 fast client 入库，与第 16 节 readiness 约束不一致；第 14 节“不新增 helper”与局部 `closeClients` 存在文字矛盾 | BLOCK | `ses_e33f25101ffeDW6PIxNfMwQadX` |
| 8 | R8 | yes | No blocking findings | Round 7 的 non-blocking 行政记录应保留审计原措辞；本轮未重新计算外部脚本 SHA-256，也未执行完整测试或 typecheck，这些属于实施阶段必需验证 | APPROVE | `ses_e33f25101ffeDW6PIxNfMwQadX` |

Round 1 release verdict（原样记录）：

**BLOCK**

仅针对 canonical revision **R1**。必须修订 B-01、B-02，递增 revision 并重新进行 full-scope audit；`Implementation allowed` 必须保持 `no`。只读约束不授权实施，也不降低上述行为门禁。

Round 2 release verdict（原样记录）：

**BLOCK**

仅针对 canonical revision **R2**。需要修正 owner finalizer 的注册时机并补齐失败后直接 dispose 的隔离测试，然后递增 revision、重新进行 full-scope audit；`Implementation allowed` 必须保持 `no`。

Round 3 release verdict（原样记录）：

**APPROVE**

仅批准 canonical revision **R3**。该结论只覆盖本次完整计划审计，不代表实现、测试或 typecheck 已完成。本任务继续保持只读、不实施；后续任何实施均需用户另行明确授权。

R4 修订原因：R3 之后的真实 Service 内存故障注入新增四条红灯，证明 ModelsDev、全局 Config、ACP Directory、ACP Usage 的内层/独立缓存不受 R3 外层修复覆盖。R4 增加 INV-08 至 INV-10 及对应 owner、测试与 refresh/invalidate 兼容性约束；R3 批准不再适用于当前 revision。

Round 4 release verdict（原样记录）：

**BLOCK**

仅针对 canonical revision **R4**。需要缩小 ACP Directory 的失败 TTL 范围并补充 defect 对照测试，然后递增 revision、重新进行 full-scope audit；`Implementation allowed` 必须保持 `no`。

R5 修订映射：R4 B-01 将 ACP Directory 的零 TTL 限定为中断或 `Cause.hasFails` 的 typed failure，纯 defect 保持无限缓存并新增连续读取控制测试；两个 ACP cache 明确 `Number.POSITIVE_INFINITY` capacity。

Round 5 release verdict（原样记录）：

**APPROVE**

仅批准 canonical revision **R5**。本结论只覆盖本次完整计划审计，不代表实现、真实 SDK 测试或 typecheck 已完成。本任务继续保持只读、不实施；后续任何实施均需用户另行明确授权。

R6 更新原因：用户将终态从 plan-only 改为 `verified-implementation-and-commit`，并给出生产 diff 总增减不超过 200 行、测试 diff 总增减不超过 600 行的硬预算。

Round 6 release verdict（原样记录）：

**BLOCK**

仅针对 canonical revision **R6**。`Implementation allowed` 必须保持 `no`，不得实施或提交。

R7 修订映射：R6 B-01 通过提前注册幂等 `closeClients` 及 `Effect.onExit` 不可中断成功完成器注册聚合 finalizer，从结构上关闭窗口，不增加生产测试钩子；R6 B-02 移除 ACP Usage、INV-10 及对应测试和预算；R6 B-03 固定临时反馈脚本路径、SHA-256、命令和五项基线红灯，实施前后原样重跑。用户已明确授权开启新的审计轮次，并要求逐项判断 blocker 合理性，不机械增加测试。

Round 7 release verdict（原样记录）：

**BLOCK**

仅针对 canonical revision **R7** 的 full-scope 审计。必须修正 B-01 的验证数据隔离问题，递增 revision 并重新进行 full-scope audit；`Implementation allowed` 必须保持 `no`，不得实施或提交。

R8 修订映射：R7 B-01 为所有 Core 测试和反馈脚本增加独立临时 XDG 环境，防止 ModelsDev 测试触碰真实用户缓存；MCP readiness 改为 watch 的 `setNotificationHandler` 信号并更新脚本 SHA-256。生产设计未改变。

Round 8 release verdict（原样记录）：

**APPROVE**

仅批准 canonical revision **R8** 的完整计划。原样记录本次 `No blocking findings` 和 `APPROVE` 后，可按 workflow 进入该 revision 的 TDD 实施。

本批准不代表实现、测试、typecheck 或实现审计已经完成。提交前仍须完成全部验证和独立 full-scope implementation audit，且只能提交本任务文件，不得 push。

只有同 revision `No blocking findings` + `APPROVE` 才构成计划批准。批准后按 TDD 实施并完成独立实现审计；只有 verified 状态才允许提交本任务文件，不 push。

## 23. Implementation Evidence

- Actual files：5 个生产文件、5 个测试文件及本 canonical plan；未修改 ACP Usage、生成物或用户业务数据。
- Red-green：InstanceState、ModelsDev、Config、MCP、ACP Directory 新行为测试均先在原实现失败，再在各自 owner 修复后通过。
- Core verification：`bun test test/models.test.ts test/session-runner-tool-registry.test.ts`，30 pass、0 fail；`bun typecheck` 通过。
- opencode verification：`bun test test/effect/instance-state.test.ts test/config/config.test.ts test/acp/directory.test.ts`，136 pass、2 skip、0 fail；`bun typecheck` 通过。
- 原始 feedback loop：固定 SHA-256 `20B7A536BB6A9821531D0015957CA5A2B5B70F430A18E35C6D2B2704590833B6` 的脚本五项全绿；InstanceState attempts=2、ModelsDev reads=2、Config reads=4、ACP loads=2、MCP fastCloses=1 且 retry connected。
- Secondary paths：ModelsDev 既有磁盘/fetch/refresh 测试、Config 全文件、MCP 真实 SDK 工具回归、ACP typed failure/defect/refresh 并发及 InstanceState 既有缓存/dispose 测试均通过。InstanceState 事件顺序断言证明 `finalized:first` 先于 `lookup:second`；MCP 公开 `startAuth/finishAuth` 用例分别关闭失败与成功 owner Scope，证明失败 dispose 保留其他 pending OAuth、成功 dispose 仍清理。
- Production diff：`+72/-67`，总增减 139，满足 `<=200`。逐文件：MCP +25/-10；ModelsDev +11/-4；InstanceState +6/-2；Config +16/-10；ACP Directory +14/-41。
- Test diff：`+379/-3`，总增减 382，满足 `<=600`。
- Comment gate：`E=369`、`C=56`、要求 `ceil(369*0.15)=56`。E 按 `git diff --unified=0` 统计新增或实质修改的非空代码行，排除注释行、import-only、删除行、生成物和 pure movement；C 为与变更相邻的中文解释性注释。
- `git diff --check` 通过。测试和反馈脚本均使用第 18 节临时 XDG 目录，未删除或改写真实用户 ModelsDev 缓存。
- 未验证项：完整 monorepo 全量测试未运行；本次执行批准计划列出的目标 suite、两个 package typecheck 和原始反馈回路。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R8 | yes | B-01：MCP 失败后直接 dispose 的 OAuth 隔离没有行为验证；B-02：InstanceState 测试不能识别 finalizer 与新 lookup 的执行顺序；B-03：必需测试、typecheck 和原始 feedback 未获独立验证 | 工作树存在不属于本任务的 `bun.lock`、`packages/opencode/config.json` 和其他计划文档，不应混入提交 | BLOCK | `ses_e3392a144ffewXIAeAonpBqDhG` |

Round 1 修正：InstanceState 用事件顺序断言覆盖先释放后初始化；MCP 用公开 `startAuth/finishAuth` 和独立 owner Scope 覆盖失败隔离及成功清理；已重跑 Core 30 pass、opencode 136 pass/2 skip、两个 typecheck、固定哈希反馈脚本五项全绿。复审明确允许在临时 XDG 环境中独立执行相同命令。

| 2 | R8 | yes | B-01：新增 OAuth 测试通过双重断言依赖 SDK 私有字段 | 第 23 节测试行数记录需按实际 diff 修正；无关 `bun.lock`、`config.json` 和其他计划不得混入提交 | BLOCK | `ses_e3392a144ffewXIAeAonpBqDhG` |

Round 2 修正：删除 `as unknown as`、`_authProvider` 和 transport 私有方法覆写，改用本机临时 HTTP 服务提供公开 401、RFC 8414 discovery 与 token 响应；`startAuth/finishAuth` 完整公开流程通过，Core typecheck 通过。

| 3 | R8 | yes | No blocking findings | 无关 `bun.lock`、`config.json` 和其他计划文档不得进入提交；完整 monorepo 全量测试未运行，但 R8 指定验证均独立完成 | APPROVE | `ses_e3392a144ffewXIAeAonpBqDhG` |

Round 3 release verdict（原样记录）：

**APPROVE**

仅批准 canonical revision **R8** 对应的当前实际任务 diff。全部原始范围、次级路径、硬预算、E/C 门禁及第 18 节验证均已通过，Round 3 没有遗留 blocking finding。

可由 primary 将本轮 `No blocking findings` 和 `APPROVE` 原样记录后进入 `verified`；只能提交本任务文件，排除上述无关工作树修改，不 push。审计未修改工作区或真实用户数据。

只有实际 diff 获得全范围 `No blocking findings` 且验证完成后，才能将状态改为 `verified` 并提交。
