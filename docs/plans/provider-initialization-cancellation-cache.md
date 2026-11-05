# Canonical Implementation Plan: Provider 初始化取消结果的目录缓存修复

> Status: approved
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: 本对话的 ReefCraft 启动故障及后续用户要求，见第 1 节
>
> Implementation allowed: yes
>
> Last updated: 2026-10-19

本文件是本任务唯一实施规格。当前交付是现场恢复、诊断与方案；生产修复实施需另行进入批准方案实施流程。

## 1. Verbatim Requirement

> 下面有一个问题需要你去检查，当前我看我的在一个另外一个就是 Open Code 的，就是一个目录下去打开现在 Open Code，但是它这个 Open Code 启动不起来，然后它一直报了一个错误，但是我在其他地方我就能启动起来，所以你看一下到底怎么回事儿。它说连接不到，但是本质而言，我就是我使用其他的目录啊，无非就是什么都好，就是我都启动起来，就这个地方好像不行。

现场错误，用户连续三次启动得到相同结果：

```text
Error: 2 of 5 requests failed: config.providers: opencode server GET http://127.0.0.1:4096/config/providers?directory=F%3A%5CProject%5CHKUST%5CReefCraft → 499 unknown: (empty response body); provider.list: opencode server GET http://127.0.0.1:4096/provider?directory=F%3A%5CProject%5CHKUST%5CReefCraft → 499 unknown: (empty response body)
Daemon still running:  5 TUI connections, 6 active sessions - stop with opencode daemon stop
C:\Users\Lenovo\.local\share\opencode\opencode.db
```

> 准确检查，清晰分析相应的原因。你不要只给出一个相应的一个不确定的结果。我必须要准确的结果，因为我必须要去解决这个问题。

> 当然这个释放实例缓存你可以去释放，但是我需要去知道东西它是为什么会出现相应的内容。

> 也就是说在你释放实力缓存之前，你必须找到清晰的触发路径，并且提出相应的可审计的一些方案，或者说可修复的一些方案。你不得给出说什么没有找到，或者说不支持，没有证据。你不要给出任何 defensible 的一些否定式表达。

> 换言之，我当时想第一次，第一次的时候想打开它的时候，它就已经打不开，就直接给我报下一个错误。所以并不是我什么异常退出或者操作不当等导致的。本质而言，我做得很简单，进入目录，然后去启动 OpenCode。

最新指令调整执行次序，授权先进行现场恢复：

> 你先去清理一下，你先去清理一下当前的一个情况，让我能够正常打开，然后你再去进行下那个Plan的一个构建和方案提出。

REQ-01：恢复指定目录的启动接口，保护其他目录的活动会话和持久化数据。
REQ-02：解释目录选择性 499 的程序执行链，以可运行实验与现场对照支持结论。
REQ-03：提供可审计、可实施的根因修复方案，覆盖取消、缓存、并发和清理。
REQ-04：以用户首次正常启动的陈述为事实；历史信号与用户主动退出之间不建立未经验证的归因。

## 2. Explicit Non-Goals

本轮只增加本方案文档。生产代码、测试、依赖、配置和数据库保持原样。现场恢复使用现有单目录实例释放接口。全局 daemon 重启、删除数据库、SDK 重试、空 Provider 成功响应和修改模型配置均不属于修复设计。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md`, `CONTEXT.md` | InstanceState 按目录隔离；AppRuntime 共享服务；包内运行测试与 `bun typecheck` |
| `packages/opencode/AGENTS.md` | 使用 ScopedCache 的 run-once 语义；保持 Effect 风格和小改动 |
| `packages/opencode/test/AGENTS.md` | 使用真实实现、Deferred 同步与已有 fixture |
| `packages/opencode/test/server/AGENTS.md` | HTTP 取消测试必须走 Effect HTTP 语义；测试全栈时遵守隔离 |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | HTTP handler 只编排服务，缓存策略由拥有者承担 |
| `docs/adr/` | 现有 ADR 涉及 triage；没有对本次缓存策略增加独立约束 |
| `.opencode/policy/first-principles-engineering.md` | 根因修复、零新增 fallback、独立审查和中文注释要求 |
| `.opencode/references/effect-smol/packages/effect/src/ScopedCache.ts` | API 参考；实际执行行为以已安装 `node_modules/effect` 为准 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:1268` | 初次 bootstrap 并发发起两个 Provider 请求；任一阻塞请求失败后退出 | Observed |
| `packages/opencode/src/cli/cmd/tui/context/sdk.tsx:29`, `:209` | 所有 SDK 请求共享 AbortSignal；组件清理取消请求 | Observed |
| `packages/opencode/src/cli/cmd/tui/context/exit.tsx:43` | 信号/程序退出清理 renderer；只证明退出机制 | Observed |
| `packages/sdk/js/src/v2/client.ts:17` | GET directory 参数与 Request 信号沿 SDK 传递 | Observed |
| `packages/opencode/src/server/server.ts:104`, `:192` | 真实监听使用 NodeHttpServer，含 Windows/Bun 请求清理适配 | Observed |
| `node_modules/@effect/platform-node/src/NodeHttpServer.ts:175` | 未完成 response 的 close 给请求 fiber 附加 ClientAbort 中断 | Observed |
| `node_modules/effect/src/unstable/http/HttpRouter.ts:194` | 正常路由 handler 在可中断区执行 | Observed |
| `node_modules/effect/src/unstable/http/HttpEffect.ts:250` | Web Request adapter 的 abort 同样发出 ClientAbort | Observed |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts:29` | 解析目录并注入 InstanceRef | Observed |
| `packages/opencode/src/project/instance-store.ts:70`, `:119`, `:167` | 外层目录加载已有独立 scope/失败清槽；单目录释放运行 disposers | Observed |
| `packages/opencode/src/project/bootstrap.ts:38` | 预热 Config、Plugin 等，但没有预热 Provider | Observed |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts:24`, `handlers/provider.ts:40` | 两个错误端点汇合到 Provider.list | Observed |
| `packages/opencode/src/provider/provider.ts:1407`, `:1674`, `:1862` | Provider 初始化、异步依赖与列表读缓存；提供 invalidateAll | Observed |
| `packages/opencode/src/provider/auth.ts:110` | auth 方法列表从 Plugin 独立读取，现场返回 200 | Observed |
| `packages/opencode/src/effect/instance-state.ts` | 所有目录服务缓存的拥有者，未指定 TTL | Observed |
| `packages/opencode/src/effect/instance-registry.ts`, `bridge.ts` | 单目录清理注册和 Effect 上下文边界 | Observed |
| `node_modules/effect/src/ScopedCache.ts:63`, `:144`, `:163` | makeWith 可依 Exit 决定 TTL；默认无限；Exit 包括中断被缓存 | Observed |
| `node_modules/effect/src/unstable/http/HttpServerError.ts:235` | ClientAbort 中断映射 499，其他服务端中断映射 503 | Observed |
| `packages/opencode/test/effect/instance-state.test.ts` | 现有目录隔离、并发去重、reload/dispose 测试；新切片扩展位置 | Observed |
| `packages/opencode/test/provider/provider.test.ts`, `test/server/httpapi-provider.test.ts` | Provider 真实服务构建与 HTTP 测试模式 | Observed |
| `packages/opencode/src/mcp/index.ts:285`, `:452`, `:518`, `:556` | 连接成功后工具发现与登记之间的资源所有权；整体 finalizer 注册过晚 | Observed |
| `packages/opencode/test/mcp/lifecycle.test.ts` | 真实 MCP Service + transport fixture 的取消/关闭验证接口 | Observed |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts:24`, `lifecycle.ts:46` | 已授权恢复接口及响应后的实例清理 | Observed |
| `packages/core/src/filesystem.ts:216` | 目录经过 realpath 规范化，测试应使用不同真实目录 | Observed |
| `packages/core/src/util/log.ts`, `packages/opencode/src/cli/cmd/tui/worker.ts:35` | 日志路径、留存和 daemon 初始化 | Observed |
| `C:/Users/Lenovo/.local/share/opencode/log/2026-10-19T051301.log` | 05:13:03Z SIGHUP 后两请求取消；该日志没有 directory 字段 | Observed |
| 同目录 `2026-10-19T051311.log`, `2026-10-19T051731.log` | 后续 ReefCraft 两个 Provider 接口持续 499 | Observed |
| 本节及第 18 节现场/隔离实验记录 | 同目录永久 499，其他目录 200，释放缓存后恢复 | Observed |

共享缓存调用点检索覆盖 `packages/opencode/src` 的 29 个 `InstanceState.make`：Provider、ProviderAuth、Config、Plugin、Env、Agent、Command、工具注册、File/FileWatcher、LSP、Format、Snapshot、MCP、Skill 两处、SessionRunState、Instruction、Question、Permission 及两类 permission cache、Vcs、Project、Reference、ShareNext、Bus、BackgroundJob、Pty。它们继续使用一个缓存策略；本方案仅改变含中断 Exit 的有效性。

## 5. Current Behavior

```text
正常首次启动 TUI
 -> bootstrap 并发请求 /config/providers 与 /provider
 -> InstanceStore 加载目录，Config/Plugin 完成预热
 -> 两个 handler 都进入 Provider.list
 -> 首个访问者在自身请求 fiber 中执行 Provider 的 InstanceState lookup
 -> 若初始化尚未完成时，该请求收到 ClientAbort
 -> ScopedCache.onExit 把中断 Exit 写入共享 Deferred，TTL 无限
 -> 同一轮等待者及此后新请求复用中断 Exit
 -> HttpServerError 转换成空 body 的 499
 -> TUI 汇总成 2 of 5 requests failed
```

启动界面出现之前已经发生上述并发 HTTP 请求。触发条件是服务端请求生命周期中断，用户主动退出并非该代码路径的前置条件。新的 TUI 进程复用旧 daemon，按目录缓存继续存活，因此重复启动会立即得到旧结果。

**证据分层：** 实验确认完整的取消到持续 499 链；现场单目录释放后恢复确认内存状态责任。历史 SIGHUP 日志仅作为时间线线索，不能定位该次信号所属目录或发送来源，故不作为 ReefCraft 首次失败的因果证据。REQ-04 保留为明确约束。具体首次连接为何结束是历史取证边界，与缓存修复的必要性分别陈述。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 合法 Windows 目录 | TUI/SDK | directory 解码、realpath | middleware → Provider → InstanceState | InstanceState | Observed |
| 初始化期间请求中断 | HTTP response close / Request AbortSignal | ClientAbort 标记来自 HTTP adapter | 请求 fiber → lookup Exit | InstanceState 缓存有效性 | Observed（Web adapter 实验） |
| 同目录并发访问 | bootstrap 两个 Provider 请求 | 共用 InstanceRef.directory | ScopedCache.get | InstanceState | Reachable |
| 取消等待者而非首个 lookup 者 | 多 TUI/并发请求 | 等待同一 Deferred | ScopedCache hit 分支 | ScopedCache | Reachable |
| 初始化中已分配的 scope 资源 | acquireRelease / forkScoped 的目录服务 | 由 entry scope 持有 | 过期后替换 / invalidate | ScopedCache | Reachable |
| 普通失败/成功结果 | init Effect | Exit 区分失败与中断 | TTL 判定 | InstanceState | Contracted：保持既有语义 |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 已取消的初始化结果不能使后来独立请求永久取消 | 现场、隔离实验 | 新增取消后重入测试 |
| INV-02 | 正常成功状态按目录隔离并复用；同轮初始化仍去重 | CONTEXT、既有调用者 | instance-state 缓存/隔离/并发测试 |
| INV-03 | 中断后的下一次初始化按既有 scope 协议先释放旧资源；dispose/reload 保留原行为 | ScopedCache 替换及 disposer 实现 | 扩展 acquireRelease 测试 |
| INV-04 | 真正取消仍保持取消；普通业务失败和缺陷不转成成功 | HTTP/Effect 错误约定 | 新增非中断 Exit 保持测试 |
| INV-05 | 现场恢复限于目标目录，配置/数据库/其他会话保持正常 | REQ-01 | 第 18 节现场检查 |
| INV-06 | 共享中断缓存过期引入 MCP 重入时，部分成功客户端和工具发现中的客户端都有释放者，不累积旧连接 | 审查 B-01；MCP.create/state 的可达取消点 | 新增 MCP 部分初始化取消回归 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | 首次请求中断结束 lookup 时，InstanceState 所选无限 TTL 把中断结果保留为未来目录状态 | `InstanceState.make` 的缓存策略 | ScopedCache `onExit`、最小实验、真实 Provider 实验 |
| INV-02/03/04 | 当前不是已证实违反项；修复必须保留 | InstanceState/ScopedCache | 既有测试与清理语义 |
| INV-06 | MCP 客户端已完成连接，但尚在 defs 或等待其他客户端时，整体 finalizer 尚未登记 | MCP.create / MCP.state 资源生命周期 | `mcp/index.ts:469`, `:529`, `:556`；审查 B-01 |

根因是缓存把请求生命周期中断当成可长期复用的初始化结果；HTTP 499、TUI 汇总失败和重复启动均是下游结果。首次取消由传输层给出，修复不要求推定用户执行过退出操作。

原始红信号（包目录内运行）：

```powershell
curl.exe --noproxy "*" -s -o NUL -w "%{http_code}\n" "http://127.0.0.1:4096/provider?directory=F%3A%5CProject%5CHKUST%5CReefCraft" --max-time 15
```

清理前稳定返回 `499`；父目录同接口 `200`。清理后该命令返回 `200`。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 中断 Exit 的缓存寿命 | InstanceState.make | 为目录提供可复用的服务状态 | 统一选择 TTL 的包装层 | Provider 和 TUI 不应各自重试/清缓存 |
| entry scope 清理 | ScopedCache | 替换/失效关闭 entry scope | 已有完整实现 | 不增加自制 map、Fiber 状态机 |
| ClientAbort → 499 | HTTP adapter | 保留真实取消语义 | 传输协议边界 | 改状态码会掩盖同一故障 |
| 临时恢复 | 现有 instance.dispose | 释放指定目录资源 | 已授权现场操作 | 不变成生产失败自动恢复分支 |
| MCP 部分初始化的连接释放 | MCP.create / MCP.state | 连接成功后必须有持续的资源拥有者 | MCP 知道 transport、client、工具发现与发布时机 | TTL 层只能关闭已登记的 scope，不能推断客户端 |

## 10. Single Approved Primary-Path Design

唯一代码修复方向：将 `InstanceState.make` 的 `ScopedCache.make` 改为 `ScopedCache.makeWith`，设置 `timeToLive: (exit) => Exit.hasInterrupts(exit) ? Duration.zero : Duration.infinity`。

```text
init 完成 → 原样发布 Exit
             ├─ 含中断：TTL 0，下一次 get 按原 lookup 重新初始化
             └─ 成功/无中断失败：维持无限 TTL
```

使用已安装 Effect 的真实 API。当前请求/同轮已经等待该 Deferred 的请求仍可观察原始中断；它们不会在底层静默重试。稍后发起的新请求会走唯一正常初始化路径。缓存 hit 等待者自身被取消不会改变进行中的 producer 或已成功缓存。旧 entry scope 在下一次 get 替换时由现有逻辑关闭；长期没有下一次 get 时仍由显式 invalidate/服务 scope 关闭负责。保持这一既有清理时序，不新增定时器或后台 producer。

没有外部失败恢复算法、fallback、全局 reset 或 public API 增量。外层 InstanceStore 已处理自身 boot 的取消，此处修正的是内部服务 InstanceState，二者责任分别成立。

### 10.1 共享重入前的 MCP 资源所有权修复

R4 接受审查 B-01、B-02、B-03。缓存仍是同一全局规则；MCP 必须先具备可安全重入的资源协议，实施顺序先完成本节再启用 TTL。

1. `MCP.state` 在创建 `s` 后、启动 `Effect.forEach` 前登记**一个**清理 finalizer，使已写入 `s.clients` 的部分成功连接随旧 entry scope 释放。保留现有 stdio descendants 清理和 client.close 行为。增加一个该次初始化局部的完成标记，初值 false，全部初始化成功结束后同步设为 true。此 finalizer 始终先等待客户端释放完成，然后仅在完成标记为 true 时执行原来的 `pendingOAuthTransports.clear()`。这样成功 entry 保持原有释放顺序，未完成 entry 只释放已取得的客户端。不得拆成两个独立 finalizer，因为 scope 的 LIFO 顺序会倒置客户端关闭与 OAuth 清理。
2. `MCP.create` 用一个 `Effect.uninterruptibleMask` 保护“连接成功结果接收 → 安装本地失败清理 → 工具发现结果接收 → 返回所有权”的同步交接。连接和 `defs` 两个网络等待都通过 `restore(...)` 保持可中断。连接失败期间沿用 `connectTransport` 的释放；连接成功之后，`defs` 的错误、中断以及 `!listed` 由本地作用域关闭该 client。成功返回只移交所有权，不关闭有效连接。
3. `MCP.state` 的每个并发分支同样以 `uninterruptibleMask` 包围 `restore(create(...))` 和紧随的 `s.clients` 登记。恢复可中断的是 create 的异步工作；接收成功结果与发布到已有清理者之间保持原子交接。应用现有 status/defs/watch 注册；若 watch 注册抛出，client 已在清理者持有的集合中。
4. 保留 `createAndStore` 的其他调用路径语义；MCP.create 的新增本地失败清理只覆盖其自身拥有资源的阶段。此设计不增加连接尝试、transport fallback 或后台进程。
5. 每个 MCP.state 初始化闭包再保存一个局部 `closed` 标记，初值 false；上述唯一 finalizer **先同步设 closed=true，再遍历并释放已登记客户端**。单独关闭 entry scope 不会中断 lookup，因此成功 acquisition 的发布必须与该标记做所有权交接：`create` 返回后，在第 3 步的不可中断同步区域内检查 closed；若已关闭，直接释放尚未登记的返回客户端并以 Effect 中断结束旧初始化；若仍打开，则同步写入 s.clients。关闭动作和发布动作都先执行同步部分，所以客户端恰好归属现有集合或迟到资源释放者之一。
6. finalizer 刚登记后及 forEach 全部完成后、设置完成标记并返回 s 前检查 closed；已关闭的旧 entry 以中断结束。这样 cfg 等待期间已经关闭的 scope 以及仅包含 disabled 项的初始化也不会发布旧状态。此标记只表示 MCP 资源生命周期终止，不替代缓存的 run-once、cache key 或代际机制。
7. 提取现有 stdio descendants + client.close 的一个私有 `disposeClient` 操作，供 finalizer 集合释放和第 5 步的迟到客户端释放复用；该 helper 在两处都有实际调用。工具发现阶段的本地失败释放也复用该资源操作，避免只关闭父进程却遗留已启动的子进程。沿用既有 best-effort close 错误处理，不增加连接尝试。

这两处 mask 保护的是短暂所有权交接，而不是整个网络初始化；取消仍能打断 connect/defs。测试必须在这两个等待点分别取消，并验证旧客户端关闭、新客户端能正常提供 tools、另一目录连接保持有效。

并发 dispose/reload 时，旧 lookup 正在等待的 connect/defs 可以随后完成；其取得的资源由 closed 分支释放，旧请求以中断结束，新 entry 的 clients/defs 不受旧请求写入。这个终止分支返回中断而不是伪造成功，属于资源所有权主路径。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 根据 Exit 决定 TTL | Proposed | primary-contract branch | 仅成功 Exit 本身成功 | 与 MCP 行合计为新主路径判断面的 100% | implement |
| MCP 初始化交接和失败释放 | Proposed | primary-contract branch | 成功只沿现有 create 路径 | 与 TTL 行合计为新主路径判断面的 100% | implement |
| 原 lookup、entry scope 替换和 disposer | Current | primary-contract branch | 按原结果 | 既有 | preserve |
| 人工调用单目录 dispose | Current | diagnostic/operational path | 返回释放结果 | 新生产判断面 0% | 本次现场操作 |
| 捕获 499 后 TUI 重试/返回空列表/全局重启 | Rejected | forbidden fallback | 会掩盖故障 | 0% | reject |

新增替代成功路径 0；新增生产诊断分支 0%；无 rollback 请求。

## 12. Workaround Deletion and Replacement

现有生产代码没有本缺陷专用 workaround。现场单次 dispose 为恢复操作，不写入自动执行逻辑。保持现有 auth 变更触发的 Provider.invalidateAll，其职责与本缺陷不同。

MCP 的现有 `!listed` 关闭动作纳入同一 create 资源协议，避免同时保留两个会重复关闭同一连接的释放实现；晚登记的客户端 finalizer 移到首次创建连接之前，保持一份释放逻辑。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| REQ-01 / INV-05 | instance.dispose | 无生产修改，已执行现场恢复 | 同目录接口、配置哈希、其他会话状态对照 |
| REQ-02 / REQ-04 | TUI → HTTP → Provider → InstanceState | 本文记录链与归因边界 | 第 18 节真实 Provider 取消实验 |
| REQ-03 / INV-01 | InstanceState.make/get | `src/effect/instance-state.ts` TTL | 取消后两个 Provider 入口新请求成功 |
| INV-02 | ScopedCache.get | 同上，保留单一缓存 | 并发成功返回相同状态、跨目录隔离 |
| INV-03 | scope/invalidate/reload | 同上，复用清理 | 被中断资源在新初始化前释放；dispose/reload |
| INV-04 | Exit/HTTP error conversion | 保持原发布路径 | 取消仍取消、普通失败仍失败且缓存 |
| INV-06 / INV-03 | MCP.create/state → entry scope | `src/mcp/index.ts` 早登记清理与安全交接 | A 成功/B 等待取消后重入；connect 后 defs 中取消；其他目录保持可用 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 含中断 Exit 的 TTL 为零 | INV-01、REQ-03 | 永久 499 实验 | make 的固定 TTL 无法按 Exit 区分 |
| makeWith 的 Exit-sensitive 配置 | INV-02/03/04 | 现有 ScopedCache API | 复用既有 map、scope、Deferred；不新增概念 |
| MCP 提前登记现有客户端 finalizer | INV-06 | 审查 B-01，部分成功后 forEach 可中断 | 当前登记发生在全部连接完成之后 |
| create 失败清理和短交接 mask | INV-06 | 连接与 defs 是分离的异步阶段 | 当前客户端已连接但未发布时 entry scope 无从释放 |
| 初始化完成标记 | INV-03/INV-06 | 审查 B-02；未完成 entry 新增了释放入口 | 单个提前登记的 finalizer 必须区分部分初始化与原有成功清理合同；一个局部 boolean 足够 |
| entry 关闭标记及迟到客户端释放 | INV-03/INV-06 | 审查 B-03；invalidate 关闭 scope 而不终止 lookup | 已执行的单次 finalizer 无法自动接管其后返回的客户端 |
| 私有 disposeClient | INV-06 | 已登记和迟到客户端都需要同样的 stdio/close 协议 | 一份释放算法供两个真实所有权路径复用 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/effect/instance-state.ts` | modify | Exit-sensitive TTL，解释取消不是长期服务状态 | 约 5–8 行（含 imports/comments） |
| `packages/opencode/test/effect/instance-state.test.ts` | modify | 取消重入、等待者取消、scope 清理、普通失败保留 | 约 80–130 行 |
| `packages/opencode/test/server/httpapi-provider.test.ts` | modify | 使用真实 Provider 与 HttpEffect Request 取消行为的集成回归，明确依赖隔离 | 约 60–100 行 |
| `packages/opencode/src/mcp/index.ts` | modify | 提前登记现有客户端清理，补连接到工具发现/发布的可中断安全交接，以及并发释放后的迟到资源归属 | 约 35–65 有效行，另有 finalizer 纯移动 |
| `packages/opencode/test/mcp/lifecycle.test.ts` | modify | 按连接实例隔离 fixture，验证部分成功取消、并发 dispose/reload、迟到成功后的关闭及可重入 | 约 120–200 行 |
| 本文 | add/update | 诊断、方案、审查、现场记录 | 文档 |

不修改 `node_modules`，不更新 SDK 或数据库。

## 16. TDD Behavior Slices

实施前在本方案评审中确认测试接口：`InstanceState.make/get/invalidate`、`Provider.Service.list` 经 Effect HTTP adapter 的客户端响应、`MCP.Service.status/tools` 的连接存活和关闭结果。每次只实现一条纵向切片。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 0a | MCP A 完成连接，B 仍在 connect，取消初始化后 invalidate 再进入应只保留新连接 | A 尚未受 entry finalizer 管理 | 提前登记客户端释放 | 共享 TTL 前置资源安全 |
| 0b | connect 完成但 defs 尚未完成时取消，旧客户端应关闭；成功客户端仍可提供 tools | create 的连接成功与工具发现间没有释放者 | 短交接 mask 和本地失败释放 | 所有权交接缺口 |
| 0c | A 成功 entry 正在异步 close 时，B 的 pending OAuth 仍可 finishAuth；部分初始化的 A 清理也保留 B 的 flow | 防止拆分 finalizer 提前清空共享 map，是保持性回归 | 单 finalizer 先 close 后按完成标记清理 | 跨目录 OAuth 顺序 |
| 0d | 初始化仍在 connect 或 defs 等待时直接 dispose/reload，再放行成功，迟到客户端必须关闭且旧状态不再发布 | 提前 finalizer 若没有 closed 协议就会漏掉迟到资源 | closed 与发布原子交接，统一 disposeClient | entry 终止边界 |
| 1 | 中断第一个初始化请求，随后新 get 应返回真实状态 | 无限 TTL 复用中断 | 中断 TTL=0 | 永久不可用 |
| 2 | 真实 Provider 通过 HTTP 取消后，新请求应返回含 fixture provider/model 的 200 | 两个入口共享中断缓存 | 同一 TTL 修复 | 原始 499 症状 |
| 3 | 成功并发请求共享状态，另目录成功；取消一个纯等待者不会破坏 producer | 锁定既有行为，属保持性回归 | 保持原缓存算法 | 去重与目录隔离 |
| 4 | 初始化 acquireRelease 后中断，重入前旧资源已清理；reload/dispose 不遗留资源 | 新过期分支需验证真实替换协议 | 复用 ScopedCache 清理 | 资源生命周期 |
| 5 | 无中断普通失败/缺陷仍按原 Exit 缓存；真实取消仍返回取消 | 防止把所有失败都过期/吞错 | 仅 hasInterrupts 判断 | 错误契约 |
| 6 | 启用 TTL 后重复 0a/0b，下一次 status 无需人工 invalidate 就重入，旧连接已关闭 | 原无限 TTL 会直接重复中断 | 第 0、1 步共同生效 | 缓存策略与 MCP 集成 |

以 Deferred 就绪门同步，使用固定的期望状态和公开结果，不把调用次数/源码字符串作为新回归断言。集成测试替换外部模型/认证/插件依赖以隔离凭据和网络，Provider、InstanceState、HTTP error mapping 使用真实实现。新增测试遵守包内 Effect fixture；资源恢复用 finalizer。

MCP fixture 必须按各自 client/transport 实例保存状态和就绪门，不能依赖现有 `lastCreatedClientName` 全局变量来区分并发 A/B；测试断言实际连接的 closed/可用状态而不是 close 调用次数。0a/0b 使用现有公开实例释放 fixture，保证在 TTL 修复之前即可得到独立红绿信号。新切片也检查取消一个目录后另一目录 tools 仍可使用，并复跑 OAuth 既有测试以锁定原清理行为。

0c 在 `MCP.Service.startAuth/finishAuth` 及实例释放接口验证：用 Deferred 暂停 A 的 client.close，B 调用 startAuth 后，在 A 的 close 完成之前调用 finishAuth 并得到正常协议结果，再释放 close 门。另一个切片取消 A 的未完成初始化并使其释放，B 的 flow 仍可完成。观察 OAuth 公共结果，不直接读取 pendingOAuthTransports。

0d 不先取消原始 lookup：在 connect/defs 就绪门处确认正在等待，调用现有实例 dispose/reload 并等待其完成，再放行旧等待。分别断言旧客户端 closed、旧请求中断、新目录 entry 可以获取可用 tools，且新客户端没有被旧 finalizer 关闭。使用参数化边界覆盖 connect/defs × dispose/reload，不添加新的测试专用生产接口。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines E | 约 250–420 | 排除 imports/空白/finalizer 纯移动/格式 |
| Required Chinese explanatory comments C | 至少 ceil(E × 0.15)，约 38–63 | 实施后按实际 diff 逐行计算 |

注释分布在：中断与业务失败的缓存区别、并发等待者/producer 区别、取消门的确定性、旧 scope 在替换前清理、两 HTTP 入口共享 Provider、MCP connect/defs/发布之间的所有权、网络等待仍须可取消、OAuth 清理时序与并发 fixture 隔离。当前文档阶段 E=0、C=0。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| 第 8 节 curl | `packages/opencode` | 现场 499 → 200 |
| `bun test test/effect/instance-state.test.ts` | `packages/opencode` | 缓存、取消、并发、清理 |
| `bun test test/server/httpapi-provider.test.ts` | `packages/opencode` | Provider HTTP 回归 |
| `bun test test/provider/provider.test.ts` | `packages/opencode` | Provider 既有行为 |
| `bun test test/mcp/lifecycle.test.ts` | `packages/opencode` | MCP 连接/工具发现/部分初始化取消与重入 |
| `bun test test/mcp` | `packages/opencode` | MCP/OAuth 既有契约 |
| `bun test test/effect` | `packages/opencode` | 共享 Effect 生命周期回归 |
| `bun typecheck` | `packages/opencode` | 类型检查 |
| `git diff --check` | 仓库根 | diff 基础校验 |

### 18.1 已执行的现场恢复

对 `F:\Project\HKUST\ReefCraft` 调用 `POST http://127.0.0.1:4096/instance/dispose?directory=F%3A%5CProject%5CHKUST%5CReefCraft`，响应 `200 true`。执行前逐一读取 busy session 元数据，10 个活跃会话全部属于其他目录。

| Endpoint | Before | After round 1 | After round 2 |
| --- | --- | --- | --- |
| /config/providers | 499，空 body | 200，1285 ms | 200，50 ms |
| /provider | 499，空 body | 200，564 ms | 200，509 ms |
| /config | 200 | 200，5550 ms（重建） | 200，14 ms |
| /agent | 200 | 200，34 ms | 200，14 ms |
| /project/current | 恢复前未采样 | 200，46 ms | 200，35 ms |

前后 `/config` JSON 的 SHA-256 均为 `34ea9f53edce362b4c3915e5b2d38ec85c04c8b66c046bb723b3e7544d347dda`。`/global/health` 均返回 `healthy:true, version:1.15.14-smark`。前后 10 个 busy session ID/状态完全一致。执行过程只发送目标实例释放 POST；没有重启 daemon、修改配置、删除数据库或手动更新数据库。验证范围为启动 HTTP 阻塞项；用户终端的交互式显示由用户下一次启动确认。

### 18.2 真实 Provider + Request abort 的可重复实验

在 `packages/opencode` 将以下 TypeScript 通过 PowerShell here-string 管道交给 `bun run -`。实验使用独立 Layer/scope，无生产 daemon/数据库访问。测试输入仅控制认证依赖的等待时机；取消本身由标准 AbortController 产生，错误映射、Provider 和缓存全部是真实代码。

```typescript
import { Effect, Layer, Deferred } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Provider } from "./src/provider/provider"
import { Config } from "./src/config/config"
import { Auth } from "./src/auth"
import { Env } from "./src/env"
import { Plugin } from "./src/plugin"
import * as ModelsDev from "@opencode-ai/core/models"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { RuntimeFlags } from "./src/effect/runtime-flags"
import { InstanceRef } from "./src/effect/instance-ref"

const entered = Deferred.makeUnsafe()
let first = true
const deps = Layer.mergeAll(
  Layer.mock(Config.Service, { get: () => Effect.succeed({
    provider: { probe: { npm: "@ai-sdk/openai-compatible", models: { "probe-model": { name: "Probe" } } } },
  }) }),
  Layer.mock(Auth.Service, {
    get: () => Effect.succeed(undefined),
    all: () => Effect.suspend(() => {
      if (!first) return Effect.succeed({})
      first = false
      return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
    }),
  }),
  Layer.mock(Env.Service, { all: () => Effect.succeed({}) }),
  Layer.mock(Plugin.Service, { list: () => Effect.succeed([]) }),
  Layer.mock(ModelsDev.Service, { get: () => Effect.succeed({}) }),
  AppFileSystem.defaultLayer,
  RuntimeFlags.layer({}),
)
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const provider = yield* Provider.Service
  const app = Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const directory = new URL(req.url, "http://localhost").searchParams.get("directory")
    const providers = yield* provider.list().pipe(Effect.provideService(InstanceRef, {
      directory, worktree: "/", project: { id: "global" },
    }))
    return HttpServerResponse.jsonUnsafe({ providers: Object.keys(providers) })
  })
  const handler = HttpEffect.toWebHandler(Effect.interruptible(app))
  yield* Effect.promise(async () => {
    const controller = new AbortController()
    const pending = handler(new Request("http://localhost/config/providers?directory=affected", {
      signal: controller.signal,
    }))
    await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("5 seconds")))
    controller.abort()
    console.log("cancelled", (await pending).status)
    for (const [endpoint, directory] of [
      ["/config/providers", "affected"], ["/provider", "affected"],
      ["/provider", "other"], ["/provider", "affected"],
    ]) {
      const r = await handler(new Request("http://localhost" + endpoint + "?directory=" + directory))
      console.log(endpoint, directory, r.status, await r.text())
    }
    await Effect.runPromise(provider.invalidateAll())
    const r = await handler(new Request("http://localhost/provider?directory=affected"))
    console.log("isolated cache cleared", r.status, await r.text())
  })
})).pipe(Effect.provide(Provider.layer.pipe(Layer.provide(deps)))))
```

观察结果：取消请求 `499`；后续新请求 `affected/config.providers=499`、`affected/provider=499`、`other/provider=200 {providers:[probe]}`、再次 affected 仍 `499`；仅清理独立 Provider 缓存后 `200 {providers:[probe]}`。实验中的 URL 名称只是两条 probe 入口，未装载完整 production API handler；两个真实 handler 汇合到同一服务的证明见第 4 节源码。

早期直接使用 NodeHttpServer.makeHandler 的 socket probe 两次超时；加上 router 的 interruptible 语义后，Bun fetch abort 仍未在 5 秒内触发服务端 onInterrupt。该实验不作为 socket 关闭的动态证据。成功实验采用项目已有 Web Request adapter，精确验证从 Request abort 到 Provider 缓存的后半链。所有 probe 是临时 stdin 进程，未落测试文件。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 本文 1 | 唯一方案文档 |
| Files modified | 实施时 5 | 共享 owner + MCP 生命周期 + 三组行为回归 |
| Files deleted | 0 | 无专用 workaround |
| Production lines | 约 40–73 有效行 | 复用 makeWith/Exit/Duration，MCP 交接、关闭判定与统一释放；另有纯移动 |
| Test lines | 约 260–430 | 取消、并发 dispose/reload、资源生命周期和 fixture 隔离 |
| Generated lines | 0 | 无 API/schema 变更 |

## 20. Real Risks and Open Decisions

共享 InstanceState 有 29 个调用点，过期规则必须仅匹配含中断 Exit；把所有失败都设为过期会扩张语义。同步完成成功/失败仍须缓存。过期项的资源释放由下一次访问或显式释放触发，测试应验证先清理再重入的顺序。现场临时恢复不会把内存中的程序升级为修复版本。

MCP 资源清理是共享重入的实施前置条件。提前登记的单 finalizer 先管理目标 entry 的客户端集合，成功 entry 才在其关闭完成后执行原有 OAuth 全局清理；部分初始化不触发该全局清理。完成标记只表达这两个已有生命周期阶段，不引入新的运行模式。mask 的边界必须通过 connect 和 defs 两个可取消测试证实，避免把等待改为不可中断。

entry scope 关闭不终止进行中的 lookup，故 closed 由 finalizer 首先同步写入，迟到资源必须在发布前转交统一释放者。完成/关闭两个局部标记分别对应成功清理合同与终止所有权，均不承担初始化去重。

### Open Decisions Requiring the User

当前无产品分歧。后续实施使用第 16 节测试接口；该修复的代码实施与部署需要新的实施阶段指令。现场恢复已经由最新指令授权并完成。

### Rejected Speculation

用户主动异常退出：与用户陈述冲突，且 SIGHUP 日志没有目录和发送来源。将此排除为根因前置条件。
目录配置损坏：现场有效配置哈希与父目录一致，释放实例后相同配置成功。数据库损坏/端口不可达：同 daemon 的其他接口正常，单目录实例释放即恢复；不以这些猜测驱动持久化变更。

## 21. Audit Contract

独立审查覆盖原始需求、首次启动归因、真实触发链、现场操作安全、缓存取消修复、成功与错误契约、并发与 scope 清理、完整正反向追溯、测试敏感性和 15% 中文注释预算。审查者自行复核源码和可运行实验，构建者的解释不充当证据。每轮均 full-scope。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 | 无另列非阻断项。 | **BLOCK — R1，full-scope。** | `ses_ead56a809ffeeRQ3Dg5BNITo25` |
| 2 | R2 | yes | B-02 | 无另列非阻断项。 | **BLOCK — R2，full-scope。** | `ses_ead56a809ffeeRQ3Dg5BNITo25` |
| 3 | R3 | yes | B-03 | 无另列非阻断项。 | **BLOCK — R3，full-scope。** | `ses_ead56a809ffeeRQ3Dg5BNITo25` |
| 4 | R4 | yes | No blocking findings. | N-01 | **APPROVE — R4，full-scope。** | `ses_ead56a809ffeeRQ3Dg5BNITo25` |

### Round 1 原文

#### B-01 共享 TTL 重入会放大 MCP 初始化的资源泄漏

- Violated invariant: INV-03 要求中断后的旧资源在下一次初始化前释放；REQ-03 要求修复覆盖取消、并发和清理。
- Evidence class: reachable
- Producer and execution path: 合法配置包含两个启用的 MCP 服务。`GET /mcp` → `MCP.status()` → `InstanceState.get()` → 并发初始化；服务 A 已连接并完成工具发现，服务 B 仍在等待，此时 HTTP 请求取消。初始化在注册整体清理之前退出。R1 将中断条目立即过期，下一请求重新创建 A。
- Source evidence: `packages/opencode/src/server/routes/instance/httpapi/handlers/mcp.ts:11` 接入真实服务；`packages/opencode/src/mcp/index.ts:296` 在连接成功后把 transport 交给调用者；`packages/opencode/src/mcp/index.ts:529` 并发创建客户端；`packages/opencode/src/mcp/index.ts:548` 保存已成功的客户端；`packages/opencode/src/mcp/index.ts:556` 到全部初始化结束后才注册 finalizer。`node_modules/effect/src/ScopedCache.ts:194` 的旧 scope 关闭只能执行已经登记的释放逻辑。
- Canonical-plan evidence: 第 4 节明确统一改变全部 29 个调用点；第 10 节在 `docs/plans/provider-initialization-cancellation-cache.md:166` 设置共享中断 TTL=0，并在第 10、20 节依赖既有 scope 保证先释放再重入；第 15、16 节没有覆盖上述 MCP 生命周期。
- Responsibility owner: MCP 初始化期间的客户端资源生命周期由 `MCP.state` 及其 acquisition 路径负责；`InstanceState.make` 是本次新增自动重入行为的统一入口。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 下一请求即使成功，也会同时留下旧 A 和新建 A；重复取消、重新访问能够持续累积客户端、连接或本地子进程。使用正确登记了 `acquireRelease` 的通用缓存测试无法发现这个真实调用者的缺口。
- Why this is not speculative: 多服务配置由 `packages/opencode/src/config/config.ts:216` 接受；请求关闭触发中断由 `node_modules/@effect/platform-node/src/NodeHttpServer.ts:176` 实现。既有代码在首次取消后缓存失败，后续访问不会再次创建客户端；R1 新增的过期重入使同一资源泄漏持续扩大，因此属于本方案恶化的后果。
- Minimal correction direction: 在启用共享重入前，让 MCP 部分初始化获得的资源具备覆盖中断边界的释放归属，并将“部分成功 → 取消 → 再次初始化”的资源回归纳入文件计划和验证。继续保留单一 lookup 路径。

#### Non-blocking findings
无另列非阻断项。

#### Release verdict
**BLOCK — R1，full-scope。**

审查文件：`docs/plans/provider-initialization-cancellation-cache.md`
内容标识：`e5ac1e44fbded4e164b6ea2152173ca077856c76`

保留阻断项 **B-01**。修订方案、递增 revision 并完成下一轮全范围独立审查后，才能批准实施。

R2 将 B-01 纳入第 10.1、13–20 节；此说明不替代下一轮独立 verdict。

### Round 2 原文

#### B-02 拆分 finalizer 会提前清除其他目录的 OAuth 交接状态

- Violated invariant: INV-03 要求保留既有 dispose/reload 行为；R2 第 10.1、20 节明确承诺维持 OAuth 清理时序。
- Evidence class: reachable
- Producer and execution path: 目录 B 的 `startAuth()` 将待完成的 transport 写入全局 `pendingOAuthTransports`；目录 A 的已完成 MCP 实例开始释放。R2 先登记客户端清理、后登记 OAuth 清理，而 entry scope 按登记逆序执行，因此先清空全局 map，再等待 A 的客户端关闭。此时 B 的合法认证回调进入 `finishAuth()`，已经取不到 transport。
- Source evidence: `node_modules/effect/src/ScopedCache.ts:177` 创建默认 scope；`node_modules/effect/src/internal/effect.ts:3756` 默认采用 sequential 策略，`node_modules/effect/src/internal/effect.ts:3681` 逆序执行 finalizer。现有 `packages/opencode/src/mcp/index.ts:556` 在同一个 finalizer 中先等待客户端关闭，再于 `packages/opencode/src/mcp/index.ts:575` 清空 OAuth map。待认证 transport 的生产者和消费者分别位于 `packages/opencode/src/mcp/index.ts:813`、`packages/opencode/src/mcp/index.ts:880`。
- Canonical-plan evidence: `docs/plans/provider-initialization-cancellation-cache.md:187` 明确将客户端清理提前登记，同时把 `pendingOAuthTransports.clear()` 单独留在初始化完成后的 finalizer；`docs/plans/provider-initialization-cancellation-cache.md:391` 承诺保持原完成时序。
- Responsibility owner: `MCP.state` 的资源释放编排及其 OAuth 清理顺序。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 原本在 A 的客户端关闭期间能够取得 transport 并继续认证的 B 请求，会改为抛出 `No pending OAuth flow for MCP server`。这个时间窗口真实存在：已安装 SDK 的 stdio 关闭会等待进程退出，并包含两次最长两秒的等待，见 `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js:152`。现有 OAuth 测试及计划中的部分初始化取消测试均未覆盖这一释放顺序。
- Why this is not speculative: 两个目录、待完成 OAuth、单目录实例释放和异步客户端关闭都有当前生产路径。阻断针对 R2 提前执行全局清理新增的失败窗口；既有释放末尾清空全局 map 的问题不作为本轮独立阻断。
- Minimal correction direction: 保留成功 entry“客户端释放完成后，再执行既有 OAuth 清理”的相对顺序，同时落实未完成初始化的客户端释放。增加关闭尚未完成时另一目录 OAuth 回调的行为验证，锁定该顺序。

#### Non-blocking findings
无另列非阻断项。

#### Release verdict
**BLOCK — R2，full-scope。**

审查文件：`docs/plans/provider-initialization-cancellation-cache.md`
内容标识：`dc0fde110f0c29727099f52e30c7192da32a6904`

R1 的 **B-01** 已在方案层面得到处理；本轮保留新增阻断项 **B-02**。修订、递增 revision 后，需要再次进行全范围独立审查。

R3 将 B-02 纳入第 10.1 的单 finalizer 与局部完成标记、第 14 节逆向追溯、第 16 节跨目录 OAuth 行为验证。

### Round 3 原文

#### B-03 提前执行的一次性 finalizer 会遗漏实例释放后才完成初始化的客户端

- Violated invariant: INV-03 要求保留 dispose/reload 的资源释放行为；INV-06 要求 MCP 初始化获得的客户端始终有释放者。
- Evidence class: reachable
- Producer and execution path: `GET /mcp` 启动初始化，客户端已经连接、`defs` 尚未完成；另一请求释放同一目录实例。R3 提前登记的 finalizer 此时执行，而客户端尚未写入 `s.clients`。随后原请求的 `defs` 成功，`create` 移交客户端，并发分支将其写入已经关闭的 entry。该 finalizer 已执行完毕，不会再次释放这个迟到的客户端。
- Source evidence: `packages/opencode/src/project/instance-store.ts:105` 调用目录 disposers；`packages/opencode/src/effect/instance-state.ts:40` 转入缓存失效。`node_modules/effect/src/ScopedCache.ts:459` 删除条目并关闭 scope，没有中断正在执行的 lookup；lookup 在 `node_modules/effect/src/ScopedCache.ts:195` 仅通过 `Scope.provide` 获得资源上下文。MCP 的异步等待与发布分别位于 `packages/opencode/src/mcp/index.ts:469`、`packages/opencode/src/mcp/index.ts:548`。`Effect.forEach` 的工作 fiber 也没有绑定到 entry scope 的关闭操作，见 `node_modules/effect/src/internal/effect.ts:4598`、`node_modules/effect/src/internal/effect.ts:5012`。
- Canonical-plan evidence: 第 10.1 节在 `docs/plans/provider-initialization-cancellation-cache.md:187` 提前登记一个 finalizer；第 2、3 步规定 create 成功后移交并发布客户端，但没有覆盖所属 scope 已关闭的交接。第 16 节 0a/0b 是先取消初始化再释放，未覆盖初始化继续运行时并发 dispose/reload。
- Responsibility owner: MCP 初始化的资源接收、所有权移交及其与 entry 生命周期的协调。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 实例释放完成后仍可留下存活的旧客户端或本地子进程；下一次初始化又创建新连接。短暂的 `uninterruptibleMask` 和初始化完成标记都不会让已经执行的 finalizer 再次接管资源。
- Why this is not speculative: 两个合法 HTTP 请求即可形成该顺序。外层 bootstrap 不等待 MCP 初始化，见 `packages/opencode/src/project/bootstrap.ts:48`。现有代码在初始化结束后登记 finalizer；如果 scope 已关闭，Effect 会立即执行该新登记的 finalizer，见 `node_modules/effect/src/internal/effect.ts:3718`，因此迟到客户端仍会被关闭。R3 将登记提前并取消这个后续释放机会，构成新增回归。
- Minimal correction direction: 让 MCP 的资源移交协议覆盖“所属 entry 已关闭、异步 acquisition 随后成功”的终止边界。增加初始化仍在运行时执行 dispose/reload、随后放行连接或工具发现成功的行为回归，验证迟到资源仍被释放；保持既定单一初始化路径。

#### Non-blocking findings
无另列非阻断项。

#### Release verdict
**BLOCK — R3，full-scope。**

审查文件：`docs/plans/provider-initialization-cancellation-cache.md`
内容标识：`053b1213c82fda1e017a8ca03813d5cb86575d6e`

此前 B-01、B-02 所指出的场景已有对应方案；本轮新增阻断项 **B-03**。修订、递增 revision 后，需要再次进行全范围独立审查。

R4 将 B-03 纳入第 10.1 的 closed 所有权交接、第 14 节、第 16 节 0d 以及对应文件/注释预算。

### Round 4 原文

#### Blocking findings

No blocking findings.

#### Non-blocking findings

##### N-01 判断面占比记录需要更新

`docs/plans/provider-initialization-cancellation-cache.md:203` 仍将 TTL 判断记为“新生产判断面 100%”，而 R4 已包含 MCP 生命周期判断及资源释放分支。该比例记录已过时。

这些分支均属于主路径；新增生产诊断判断面仍为 **0%**，没有违反预算或改变放行结论。

#### Rejected speculation

- 初始化完成标记与 `closed` 分别承担清理资格和生命周期终止判断，有明确可达场景，不属于重复实现缓存去重。
- 未将既有 OAuth 全局状态模型、未改变的动态连接路径或未知历史信号来源扩大为本轮整改项。
- 没有要求增加请求重试、后台初始化或备用缓存实现。

#### Requirement and traceability coverage

- **REQ-01 / INV-05：** 恢复操作限定既有单目录释放接口，持久化数据和其他目录保护要求保留。现场恢复数据本轮未重放；交互式 TUI 确认仍明确列为后续验证。
- **REQ-02 / REQ-04：** TUI 并发请求、两个 Provider handler 汇合、目录缓存保存中断 Exit、后续请求复用并返回 499 的执行链成立。方案保留了首次取消来源的取证边界。
- **INV-01 / INV-02 / INV-04：** 修复位于 `InstanceState.make` 的缓存有效性策略；成功复用、目录隔离、等待者取消及非中断失败保留均有对应测试。
- **B-01：方案层面关闭。** 提前登记清理及 create 阶段的资源保护，覆盖部分连接成功后取消；切片 0a、0b、6 验证资源释放与共享 TTL 重入。
- **B-02：方案层面关闭。** 单 finalizer 保持先关闭客户端、后按初始化完成状态执行既有 OAuth 清理，避免 LIFO 倒置；切片 0c 对应跨目录行为。
- **B-03：方案层面关闭。** finalizer 先设置 `closed`，成功 acquisition 在发布前同步检查并交接所有权；迟到客户端使用同一释放操作，旧初始化以中断结束。切片 0d 明确不预先取消 lookup，覆盖 connect/defs × dispose/reload 四个边界。

正向需求映射与反向概念依据完整。新增标记、交接判断和 `disposeClient` 均有对应责任与证据；helper 复用同一释放协议，没有形成第二套初始化算法。

审查范围覆盖原始需求、R4 全文、五个拟改文件、29 个初始化调用点及直接相关的 HTTP、实例清理、MCP/OAuth 路径。本轮为只读方案审查，未执行测试或操作现场 daemon。

#### Primary-path and fallback verdict

**通过。**

唯一缓存主路径保持为：初始化发布原始 Exit，中断结果过期，下一独立请求重新进入同一 lookup。

MCP 的正常发布、失败释放和终止后的迟到资源释放共同实现一个所有权协议。终止分支返回中断，人工 dispose 保持为现场恢复操作。

新增替代成功路径为 **0**；新增生产诊断判断面为 **0%**。

#### Code quality and Chinese-comment verdict

**方案阶段通过。**

变更集中在缓存拥有者和 MCP 资源拥有者，无新增公共接口、配置开关、依赖或测试专用生产入口。计划保留网络等待的可中断性，并要求合并原有 `!listed` 释放逻辑，避免重复关闭实现。

中文解释性注释预算承诺 `C ≥ ceil(E × 0.15)`；估算 `E=250–420`、`C=38–63` 可行。当前方案阶段实际代码改动为 `E=0`、`C=0`，比例不适用；文档、无关工作树改动以及规定的排除类别不计入。

#### Release verdict

**APPROVE — R4，full-scope。**

审查文件：`docs/plans/provider-initialization-cancellation-cache.md`
内容标识：`5cb59b1f27cf4dc256e0135d5c76d7aa8583bfb8`

本 verdict 仅批准该 R4 方案。代码修复仍需后续实施授权，并完成红绿测试、包内验证、原始启动反馈回路及完整独立实施审查。

审查后行政记录：N-01 的比例表已更正为 TTL 与 MCP 两项合计 100% 主路径判断面；生产设计、测试规格、范围及批准 revision 保持 R4。

任何实质修订递增 revision 并清除批准。独立 verdict 原样记录。

## 23. Implementation Evidence

### Actual Files and Diff
本轮仅本文；生产修复尚待实施。

### Red-Green Test Evidence
现场 499 → 200 属于临时缓存释放验证；第 18 节是当前缺陷复现，均不等同于代码修复通过。

### Verification Commands and Results
现场和隔离诊断命令见第 18 节。正式测试与 typecheck 在实施阶段执行。

### Original Feedback-Loop Result
现有 daemon 指定目录接口经释放恢复，两个 Provider 接口各连续两次 200。

### Actual Secondary and Replacement Path Inventory
当前生产改动为零；只调用既有单目录恢复接口。

### Chinese Comment Calculation
当前 E=0，C=0，ratio=N/A。实施后重新计算实际 E/C。

### Remaining Unverified Items
交互式 TUI 显示由用户下一次启动确认；具体首次 HTTP 连接结束来源属于历史取证边界，不把它包装成用户操作事实。永久代码修复与部署另行验证。

## 24. Implementation Audit Record

Not applicable：当前为方案阶段，实施审查在代码修复后执行。
