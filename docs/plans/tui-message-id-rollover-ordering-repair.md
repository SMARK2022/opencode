# Canonical Implementation Plan: TUI Message ID Rollover Ordering Repair

> Status: verified
>
> Revision: R5
>
> Approved revision: R5
>
> Audit mode: full-scope
>
> Requirement source: 用户在当前 Session 中于 2026-08-16 提出的实现要求
>
> Implementation allowed: no (verified)
>
> Last updated: 2026-08-16

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 修改优化现有的消息更新删除插入创建的机制，将根据ID进行二分法查找的简易算法改成复杂度类似的能确保ID循环后仍然正常工作的方法（也就是至少要在边界处工作正常），（要考虑时间）；同时代码的实现量不超过200行，不要引入过于复杂的状态机以及新的数据库schema，保持逻辑简洁核心以及适当复用；整体生产修改行数不超过200行，修改代码文件数量8个以内；不要触碰既有的其他无关问题或者代码逻辑，同时保持修改能根源处准确解决现有问题而不引入新的问题

> 请注意，修改范围仅限于TUI方面，app/web方面不进行修改

## 2. Explicit Non-Goals

- 不修改 Message ID 的 6-byte 时间编码、生成格式或数据库 schema；这些修改不能修复已经持久化的回绕前后 Message。
- 不改变服务端 `MessageV2.page` 的 `(time_created, id)` 顺序、分页 cursor 或 TUI 的 300 条 Message 窗口。
- 不修改 Part 的 ID 二分机制；Part 没有统一的 `time.created` 字段，且本次真实症状和反馈信号只涉及 Message 投影。
- 不修改 App/Web 的 HTTP、prefetch、optimistic 或 event Message 投影；用户已明确把修改范围限制为 TUI。
- 不修改 TUI Session route 中 Revert、待发送提示等功能使用的 Message ID 大小比较。这些是独立的功能消费者，不在“Message 创建/插入/更新/删除投影消失”的生产调用链中；当前反馈信号也不经过这些判断。
- 不新增索引 Map、状态机、兼容分支、重试、fallback、配置、迁移或 generated SDK 变更。
- 不调整 SMARK 191-195 patch、第三方 replay worktree 或其他既有未提交修改。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Message 是当前 `MessageV2` part-based 记录；`packages/opencode/src/session/` 是当前生产 owner，`src/v2/` 仍在迁移中。 |
| `docs/adr/README.md` | 本次是局部投影算法修复，不形成新的长期架构决定，不创建 ADR。 |
| `AGENTS.md` | 默认分支是 `dev`；测试和 typecheck 必须从 package 目录运行；修改应保持最小且不得干扰用户工作树。 |
| `packages/opencode/AGENTS.md` | 多 sibling 模块保持独立文件；私有 helper 留在 owner 附近；本任务不需要数据库迁移。 |
| `packages/opencode/test/AGENTS.md` | 测试使用现有 fixture，并通过可观察条件等待异步事件，不用固定 sleep 充当 readiness signal。 |
| `.opencode/policy/first-principles-engineering.md` | 必须修复 first divergence、保持单一语义路径、完成正反向映射、TDD、独立审计和中文解释性注释门禁。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:821-891` | `message.updated`、hidden update、`message.removed` 当前都对 chronology 数组按纯 ID 二分；超过 300 后从头裁剪。 | observed |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:1128-1176` | TUI HTTP snapshot 请求 300 条并按服务端返回顺序直接建立 Message store。 | observed |
| `packages/core/src/util/binary.ts:1-41` | `Binary.search` 只表达按字符串 key 排序的数组，其正确性前提与 Message chronology 数组不一致。 | contracted |
| `packages/opencode/src/session/message-v2.ts:788-795` | 服务端内存 consumer 以 `time.created` 为主、`localeCompare` 处理同毫秒 ID；它不是 TUI HTTP snapshot 的实际 collation owner。 | observed |
| `packages/opencode/src/session/message-v2.ts:1435-1512`、`packages/opencode/src/session/session.sql.ts:164-183` | TUI snapshot 由 SQLite 按 `time_created DESC, id DESC` 默认 BINARY collation 查询后 reverse；同毫秒 tie-break 是 UTF-8 byte order。 | contracted |
| `packages/opencode/src/session/session.ts:882-916` | bounded Message API 使用 `MessageV2.page`；remove producer 只发布 `sessionID` 和 `messageID`。 | observed |
| `packages/opencode/src/session/message-v2.ts:673-717` | update event 携带完整 Info 和创建时间；removed event 不携带创建时间。 | contracted |
| `packages/opencode/src/session/projectors.ts:155-205` | Message update 持久化 `time.created`，remove 按唯一 ID 删除；时间是持久事实而非 TUI 到达顺序。 | observed |
| `packages/opencode/src/id/id.ts:51-77` | ascending ID 只保留 6 bytes 的 `timestamp * 0x1000 + counter`，约每 `2^36 ms` 回绕；单个回绕边界两侧分别保持 ID 升序。 | observed |
| `packages/opencode/src/session/revert.ts:75-189`、`packages/opencode/src/session/prompt.ts:2955` | 服务端已有按 Message chronology 判断边界的生产先例。 | observed |
| `packages/opencode/test/cli/cmd/tui/sync-fixture.tsx:17-180` | 可通过 SDK test transport、真实 `SyncProvider` 和 SSE event 观察公开 store。 | reachable |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx:1-238, 1029-1147` | 已有 Message/Part event helper 和 force-sync HTTP snapshot 测试模式。 | reachable |
| `packages/sdk/js/src/v2/gen/types.gen.ts:543-589` | SDK `Message` 的 user/assistant 形状均提供 `id` 和 `time.created`。 | contracted |
| `C:/Users/Lenovo/.local/share/opencode/opencode.db` | 真实 Session 中目标“继续”Message 已持久化；同一 300 条窗口跨越 `msg_ffff...` 到 `msg_0000...` 回绕。 | observed |
| `F:/include/CLI/opencode.exe` | 当前运行二进制包含 TUI viewer header 和 `limit: 300`，排除旧二进制/旧窗口假设。 | observed |
| `thirdparty/opencode-11720/.temp/patches/current/0290-b734bd7f4b87.patch` | 该 patch 将 Message 窗口从 200 增到 300，只暴露了错误排序前提，不是 first divergence。 | observed |
| `packages/app/src/context/sync.tsx:295-306`、`packages/app/src/context/global-sync/event-reducer.ts:186-238`、`packages/app/src/pages/layout.tsx:747-810` | App/Web 也有独立 ID-sorted Message 投影；用户后续明确要求不修改，仅用于确认范围边界。 | observed |
| `https://github.com/anomalyco/opencode/issues/42583` | 上游记录同一 ID 回绕导致服务端 `MessageV2.latest`/prompt 停答；官方说明 1.18.15 已修复。 | observed |
| `packages/opencode/src/session/message-v2.ts:1957-1975`、`packages/opencode/src/session/prompt.ts:2683-2705` | 当前 fork 已分别按 chronology 选 latest，并以 assistant `parentID` 判断是否回答 latest user，不再依赖 ID 大小。 | observed |
| Git blame `be05b674fb3`、`3d34a00d7cf` | 当前 fork 的服务端修复早于本次故障，证明 #42583 路径不是待实施缺口。 | observed |
| Implementation audit `ses_ff7813981ffeu6to5ArQbZNaRt` | `localeCompare` 与 SQLite BINARY 对合法混合大小写 caller ID 顺序不同，能使 update/hidden/remove lower-bound 漏命中。 | observed |

## 5. Current Behavior

```text
MessageV2.Event.Updated producer
  -> SyncEvent 持久化完整 Message Info（含 time.created）
  -> server/SDK event transport
  -> TUI SyncProvider message.updated reducer
  -> 对服务端 chronology 数组执行纯 ID Binary.search
  -> ID 回绕后得到错误位置 0
  -> 插入后 301 条窗口执行 shift()
  -> 刚提交的新 Message 被立即移除，TUI 底部不可见
```

HTTP recovery 路径由 `MessageV2.page` 返回 `(time.created, SQLite BINARY id)` 升序并直接替换 TUI store，因此 store 的真实排序 invariant 是持久时间加 UTF-8 byte-order tie-break，而不是全局 ID lexical order或 locale collation。正常 update 与 hidden update 都携带完整 Message，可按同一 chronology 定位。`message.removed` 只携带唯一 ID，而且公开 prompt contract 允许 caller-supplied `msg` ID，因此不能从 ID 推导 chronology，也不能假设 ID 投影是旋转有序。TUI 必须从自己已经持有的 Message 投影维护最小 `ID -> chronology Message` 派生索引，remove 才能先 `O(1)` 取得时间 key，再 `O(log n)` 定位 chronology 数组。

真实数据库、Session Status 和 provider 执行均正常；目标 Message 已经持久化且未被标记 hidden。当前 fork 的 `MessageV2.latest` 与 prompt completion 也已修复 #42583 所述服务端停答路径。当前错误仅发生在 TUI 投影更新，随后由既有 300 条窗口裁剪放大为“新 Message 消失”。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 普通新 Message | `MessageV2.Event.Updated` | 完整 Info，含唯一 ID、Session ID、持久化创建时间 | SSE -> `message.updated` | TUI SyncProvider reducer | observed |
| 已有 Message 更新 | 同上 | 同一 ID 的 `time.created` 是持久行创建时间，不随更新改变 | SSE -> update branch | TUI SyncProvider reducer | contracted |
| hidden Message 更新 | 同上 | hidden Info 仍携带 ID 和原创建时间 | SSE -> hidden branch | TUI SyncProvider reducer | observed |
| 显式 Message 删除 | `Session.removeMessage` | event 仅有 Session ID 和唯一 Message ID | SSE -> `message.removed` | TUI SyncProvider reducer | contracted |
| 回绕后 lexical-low ID | `Identifier.ascending` | 6-byte 时间区域会在长期运行后回绕；真实数据库已经出现 | 与普通 update 相同 | Message ID producer + TUI consumer | observed |
| 同毫秒 Message | Message producer | 服务端用 ID 作稳定 tie-break | HTTP snapshot / SSE | Message chronology contract | contracted |
| 已加载且已有 300 条 Message | TUI `session.sync` | snapshot chronology 升序、窗口固定 300 | SSE insert -> trim | TUI SyncProvider reducer | observed |
| caller-supplied 非单调 Message ID | public prompt payload | `MessageID` 只要求 `msg` 前缀，创建时间独立持久化 | update -> TUI index；explicit remove -> indexed chronology search | TUI SyncProvider reducer | reachable |
| 同毫秒混合大小写/Unicode caller ID | public prompt payload + SQLite TEXT | snapshot 采用 SQLite BINARY UTF-8 byte order；locale order 不受合同保证 | HTTP snapshot -> update/hidden/remove | TUI SyncProvider reducer | reachable |
| 尚未加载的 Session event | project event stream | store 中可能没有该 Session 的 Message 数组 | reducer no-op/first insert | TUI SyncProvider reducer | reachable |
| 任意修改 `time.created` 的同 ID update | 无已确认 producer | projector 使用 event Info，但现有生产者保留创建时间 | 无证据路径 | none | speculative |

Speculative rows do not justify production logic or blocking findings.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| REQ-01 | Message 创建、插入和更新在 ID 回绕后仍按持久创建时间正确显示。 | 用户原始要求；真实 Session 症状 | 无 |
| REQ-02 | hidden update 与 explicit remove 在 ID 回绕边界删除准确目标。 | 用户原始要求；两类生产 event | 无 |
| REQ-03 | 生产修改少于 200 行、代码文件少于 8 个，不新增 DB schema 或复杂状态机。 | 用户原始要求 | 审计/numstat |
| REQ-04 | 只修复直接 Message 生命周期路径，不改变无关 Part、Revert、窗口和服务端分页语义。 | 用户原始范围约束 | 相关 regression + diff inspection |
| INV-01 | TUI 每个 Session 的 Message 数组按 `(time.created ASC, SQLite BINARY UTF-8 id ASC)` 排列。 | `MessageV2.page` SQL producer | rollover test；缺少 mixed-case tie regression |
| INV-02 | 301 条时裁剪 chronology 最旧 Message，新到达的 chronology 最新 Message 必须保留。 | `sync.tsx` 300 条 bounded store | 无 |
| INV-03 | 更新已有 Message 必须 reconcile 原位置，不得产生重复 ID。 | `message.updated` reducer contract | 无回绕覆盖 |
| INV-04 | 删除只影响匹配 ID；未加载 Session 或不存在 ID 保持 no-op。 | 当前 reducer 与 event contract | 部分 no-op 代码，无回绕覆盖 |
| INV-05 | 带完整 Message 的 chronology 定位为 `O(log n)`；ID-only remove 以 `O(1)` 索引取得 chronology key 后同样 `O(log n)` 定位；数组 splice/shift 的既有移动成本保持 `O(n)`。 | 用户“复杂度类似于二分查找”要求 | 代码审计 + boundary tests |
| INV-06 | TUI 的 ID 索引与当前 Message store 一一对应；snapshot replace、create/update、hidden、window eviction 和 explicit remove 均在既有 mutation owner 同步。 | arbitrary caller ID 的 reachable remove 路径 | lifecycle tests + mutation mapping |
| INV-07 | TUI lower-bound 的 ID tie-break 必须与 HTTP snapshot 的 SQLite BINARY collation 相同，不依赖主机 locale。 | caller-supplied mixed-case/Unicode ID + implementation audit | 新 mixed-case snapshot lifecycle test |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| REQ-01 / INV-01 | `sync.tsx` 把服务端 chronology 数组交给只接受 ID-sorted 数组的 `Binary.search`。 | TUI `SyncProvider` Message reducer | 真实 300 条数据与真实 reducer fixture 都把新 lexical-low Message 定位到 0。 |
| INV-02 | 错误定位后，正确的窗口 `shift()` 删除了错误放在首位的新 Message。 | 上游定位错误；`shift()` 只是下游症状 | 红灯结果显示 count 仍为 300，但 target 不存在。 |
| REQ-02 / INV-03 / INV-04 | update/hidden/remove 复用普通升序 ID 二分；update/hidden 忽略已有时间，remove 没有可用于 chronology 二分的 target key。 | TUI `SyncProvider` Message reducer | 三个 `Binary.search(messages, ..., m => m.id)` 调用共享“全局 ID 升序”这一不成立前提；公开 caller ID 还能形成任意非单调 ID 序列。 |
| INV-01 / INV-03 / INV-04 / INV-07 | R4 的 chronology helper 使用 locale-sensitive `localeCompare`，而 snapshot producer 使用 SQLite BINARY。 | TUI `searchMessage` ID tie-break | 同毫秒 snapshot `msg_B, msg_a` 符合 BINARY 顺序，但 locale comparator 可将其解释为相反顺序，导致 update 重复或 hidden/remove 漏删。 |

Red-capable feedback loop（已在 `packages/opencode` 运行，直接驱动真实 `SyncProvider`、HTTP snapshot 和 SSE reducer）：

```powershell
bun -e 'import { Global } from "@opencode-ai/core/global"; import { tmpdir } from "./test/fixture/fixture"; import { directory, json, mount } from "./test/cli/cmd/tui/sync-fixture"; const previous=Global.Path.state; await using tmp=await tmpdir(); Global.Path.state=tmp.path; await Bun.write(`${tmp.path}/kv.json`,"{}"); const message=(id,created)=>({id,sessionID:"ses_1",role:"user",time:{created},agent:"build",model:{providerID:"provider",modelID:"model"}}); const history=Array.from({length:300},(_,index)=>message(index<180?`msg_ffff${String(index).padStart(8,"0")}`:`msg_0000${String(index).padStart(8,"0")}`,index+1)); const target=message("msg_000100000001",301); const {app,emit,sync}=await mount((url)=>{if(url.pathname==="/session/ses_1") return json({id:"ses_1",time:{created:1,updated:1},directory}); if(url.pathname==="/session/ses_1/message"||url.pathname==="/session/ses_1/messages") return json(history.map((info)=>({info,parts:[]}))); if(url.pathname==="/session/ses_1/todo") return json([]); if(url.pathname==="/session/ses_1/diff") return json([])}); try {await sync.session.sync("ses_1",{force:true}); emit({directory,project:"proj_test",payload:{id:"evt_rollover",type:"message.updated",properties:{sessionID:"ses_1",info:target}}}); await Bun.sleep(30); const messages=sync.data.message.ses_1??[]; const targetVisible=messages.some((item)=>item.id===target.id); console.log(JSON.stringify({count:messages.length,first:messages[0]?.id,last:messages.at(-1)?.id,targetVisible})); if(!targetVisible) throw new Error("new chronological message disappeared after ID rollover")} finally {app.renderer.destroy(); Global.Path.state=previous}'
```

Observed result:

```text
{"count":300,"first":"msg_ffff00000000","last":"msg_000000000299","targetVisible":false}
error: new chronological message disappeared after ID rollover
exit code 1
```

最小算法回放只需三条 chronology Message：`msg_fffe(t1), msg_ffff(t2), msg_0001(t3)`，再到达 `msg_0002(t4)`；纯 ID 二分返回 0，四条裁剪为三条时新 Message 消失。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Message chronology 比较与二分 | TUI `SyncProvider` 私有 helper | 对 SDK Message 执行 `(time.created, SQLite BINARY UTF-8 id)` lower-bound | 用户限定 TUI-only，reducer 拥有 store 排列与窗口裁剪 | snapshot SQL 是实际 producer；不能修改 `src/session`，也不能使用 locale-sensitive comparator |
| ID -> chronology 派生索引 | TUI `SyncProvider` 私有 Map | 为 ID-only remove 提供同一 store 中已知 Message 的 chronology key | event 不含时间且 caller ID 任意；TUI 是唯一同时持有 bounded Message 和 remove event 的 owner | 不修改 event/schema/server；不使用失败后 scan fallback |
| 索引生命周期 | TUI 各既有 Message mutation branch | store 与索引在同一同步调用栈收敛 | 所有 writer 都在同一个 `sync.tsx`，可完整映射 | 外部 TUI consumer 不直接写 Message store；`session.deleted` 当前也不删除 Message cache，因此索引保持相同 lifetime |
| 公开行为测试 | `sync.test.tsx` + existing fixture | 通过 HTTP snapshot 与 SSE event 观察 SyncProvider store | 这是用户症状发生的真实公开 seam | 私有 helper/unit test 会绕过 transport、window 和 reducer |

## 10. Single Approved Primary-Path Design

```text
HTTP chronology snapshot
  -> TUI Message[] 保持 (time.created, id) 升序
  -> message.updated 携带完整 Info
  -> 私有 chronology lower-bound 二分
  -> found: 原位 reconcile / hidden: 原位删除 / missing: chronology 位置插入
  -> 超过 300 时删除 chronology 首项
  -> TUI 始终显示最新 Message

message.removed（仅 ID）
  -> 从 TUI 派生索引按 ID 取得该 Message 的持久 chronology key
  -> 用同一 chronology lower-bound 在 Message[] 中二分
  -> 命中后 splice；未命中保持 no-op
```

在 `sync.tsx` 内使用一个局部 Message chronology lower-bound helper：先比较 `time.created`，同毫秒通过 `Buffer.compare(Buffer.from(current.id), Buffer.from(target.id))` 使用 UTF-8 bytes 的 BINARY 顺序，精确遵守 TUI HTTP snapshot 的 SQLite producer 合同。该比较不使用 `localeCompare`，因此不受主机 locale 影响，并覆盖合法混合大小写/Unicode caller ID。用户要求 TUI-only，因此不新增或修改 `src/session` 模块，也不把 DB-aware `message-v2.ts` 导入 TUI。

同一 owner 内增加 `Map<sessionID, Map<messageID, Message>>` 派生索引。HTTP snapshot replacement 重建该 Session 索引；普通 create/update 写入索引；hidden、300 条 window eviction 和 explicit remove 删除对应项。全仓搜索确认 TUI Message store 没有外部 writer，因此这不是并行状态机，而是 bounded store 的唯一派生 lookup；`session.deleted` 当前不删除 Message cache，索引也不擅自改变该既有 lifetime。ID-only remove 先 `O(1)` 取得 target Message，再复用 chronology lower-bound `O(log n)` 定位；索引缺失即按既有 missing no-op contract 结束，不执行线性或 ID-sort fallback。

该设计在 first divergence 处恢复 store 的真实排序 invariant，并在 TUI owner 内补足 ID-only event 缺失的 lookup key；不改变服务端、App/Web、窗口、event schema 或 ID 生成，也不增加失败后重试、fallback 或第二数据源。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 完整 `message.updated` chronology 二分 | proposed | primary-contract branch | yes | 带完整 Info 的 create/update/hidden | add as primary locator |
| `message.removed` indexed chronology 二分 | proposed | primary-contract branch | yes | 仅 ID 的 explicit remove event | add; payload-defined branch |
| Message ID 派生索引同步 | proposed | primary-contract support | no | 所有 TUI Message mutation writer | add; no alternate result |
| 未加载 Session no-op | current | contracted pass-through | no | store 没有 Message[] | preserve |
| 首条 Message 直接建立数组 | current | primary-contract branch | yes | 已加载 Session 尚无 Message[] | preserve |
| HTTP snapshot replacement | current | primary-contract branch | yes | force sync/reconnect | preserve |
| 失败后退回纯 ID 二分 | proposed forbidden | forbidden fallback | yes | zero | reject |
| 索引 miss 后线性 scan / 纯 ID retry | proposed forbidden | forbidden fallback | yes | zero | reject |

新 alternate success path 数量为 0；两类定位由 event 的既有 payload domain 决定，不由失败或不确定性触发。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Message reducer 三处 `Binary.search(..., m => m.id)` | ID 未回绕时期，ID lexical order 恰好近似 chronology，代码量较小 | 真实 store 合同和服务端顺序是 `(time.created, id)`；回绕和 caller ID 都否定该前提 | `sync.tsx` 三处统一改走 chronology helper；ID-only remove 先从派生索引取得 target |
| 无 Message 排序 fallback | Not applicable | 本计划直接修复 owner，不增加 replacement path | Not applicable |

`updated.shift()` 和 300 条窗口不是 workaround：chronology invariant 恢复后它会再次准确删除最旧 Message，因此保留。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| REQ-01 / INV-01 | `message.updated` create/insert | `sync.tsx` 局部 chronology lower-bound | 300 条跨回绕 snapshot 后提交 lexical-low 新 Message，断言位于末尾且可见 |
| INV-02 | insert -> 300 cap | `sync.tsx` 保留现有 shift，修正其输入顺序 | 同一用例断言长度 300、最旧项被裁剪、新项保留 |
| INV-03 | `message.updated` found branch | `sync.tsx` chronology found index | 对刚插入 Message 再发更新，断言原位字段更新且 ID 只有一条 |
| REQ-02 / INV-04 | hidden `message.updated` | `sync.tsx` chronology found index | 对回绕后 Message 发 hidden update，断言准确移除 |
| REQ-02 / INV-04 | event-first create -> inserts -> `message.removed` | `sync.tsx` ID index -> chronology lower-bound | 不做 snapshot，首条 SSE 创建后形成 caller-supplied 非单调 ID chronology，再删除目标并验证 missing no-op |
| INV-05 | full Info lower-bound；ID lookup + same lower-bound | `sync.tsx` 一个 chronology helper 和 bounded derived index | code inspection + boundary regression；locator 为 `O(log n)` |
| INV-06 | snapshot/create/update/hidden/eviction/remove | `sync.tsx` 各既有 Message writer 同步派生索引 | 300 条 snapshot lifecycle + event-first create/remove regression；full diff writer mapping |
| INV-07 | same-millisecond ID tie-break | `sync.tsx` UTF-8 BINARY comparator | mixed-case snapshot `msg_B, msg_a` 后 update/hidden/remove，断言无重复且准确删除 |
| REQ-03 | bounded implementation | 2 个 code files，无 schema/config/generated changes | `git diff --numstat`、changed-file list、typecheck |
| REQ-04 | direct TUI Message projection only | 不修改 App/Web、route、Part、server page/latest/window | targeted regression + full diff audit |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| TUI chronology comparator/lower-bound | REQ-01, INV-01, INV-03, INV-05 | 服务端只读合同与红灯结果；TUI-only 用户范围 | 现有 Binary API 无 comparator target；修改/导入服务端模块会越过明确范围 |
| bounded ID -> Message 派生索引 | REQ-02, INV-04, INV-05, INV-06 | removed schema 只有 ID；public prompt 允许任意 `msg` ID；所有 TUI Message writer 位于同一 owner | 任意 ID 无法反推出 time；无索引时只能线性 scan、改 schema 或错误假设 ID 有序 |
| UTF-8 BINARY ID tie-break | INV-01, INV-03, INV-04, INV-07 | SQLite snapshot uses default BINARY collation；implementation audit mixed-case proof | `localeCompare` 受 locale 影响；JS relational order也不能对完整 Unicode 输入等价于 SQLite UTF-8 byte order |
| SyncProvider lifecycle integration tests | REQ-01, REQ-02, REQ-04 | 已运行的真实 fixture 可复现用户症状 | 纯 comparator 或 source-text test 无法证明 SSE reducer、300 cap 和公开 store |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | modify | 增加局部 BINARY chronology lower-bound 与 bounded ID index；在全部既有 Message writer 同步索引；替换三个错误 locator | +55 to +90 |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx` | modify | 通过真实 SyncProvider 添加回绕 lifecycle、event-first arbitrary-ID remove 与 mixed-case same-millisecond regressions | +125 to +170 |

Implementation code files: 2。连同本 canonical plan，任务总文件数仍低于用户上限 8；不修改 `src/session`、App/Web 或 generated files。

## 16. TDD Behavior Slices

Agreed public seam: `sync.test.tsx` 通过 existing `mount()` 的 HTTP snapshot + SDK event source 驱动真实 `SyncProvider`，只观察 `sync.data.message`。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 300 条 chronology snapshot 横跨 high/low ID；同毫秒 tie-break 后再到达 lexical-low 新 Message，随后更新并 hidden | 初始 insert 按 ID 得到 0，window 立即删掉新项；后续 update/hidden 也依赖错误前提 | 增加 TUI chronology lower-bound 和派生索引，在 full-Info writer 同步索引 | create/insert 可见、oldest trim 与 index eviction、同毫秒稳定顺序、原位 update 无重复、hidden 准确删除 |
| 2 | 不执行 Session snapshot；依次通过 SSE 创建 chronology ID `msg_m, msg_z, msg_a, msg_y`，确认首条 create 后再删除 `msg_y` 和不存在 ID | Slice 1 的 chronology 插入会得到非 ID-sorted 数组，旧 remove 二分因此红；若首条 create 未建索引，新 remove 也保持红 | removed 先从首条 create 起维护的派生索引取 target，再复用 chronology lower-bound | event-first 首条索引初始化、arbitrary-ID explicit remove、其他 Message 不受影响、missing no-op、locator 为 `O(log n)` |
| 3 | HTTP snapshot 同毫秒顺序为 SQLite BINARY worked order `msg_B, msg_a`；随后 update、hidden 和 ID-only remove | R4 `localeCompare` lower-bound 把 snapshot 解释为相反顺序，update 可重复、hidden/remove 可漏命中 | 只把 ID tie-break 改为 UTF-8 `Buffer.compare`，其余 chronology/index path 不变 | locale-independent same-millisecond insert/update/hidden/remove，与实际 SQLite producer 全序一致 |

Slice 1 与 Slice 2 的 R4 red-green 证据保留。R5 先写 Slice 3 并在当前 `localeCompare` implementation 上观察红灯，再只修正 tie-break 到绿，随后重跑前两条 slice 和完整 suite。Expected values 使用 SQLite BINARY 的 worked literal order，不在断言中调用 production comparator。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 180-250 | 与 Section 15 production + test 范围一致；排除 import-only、空行、formatter-only、pure move |
| Required Chinese explanatory comments `C` | 27-38 | 实施后按实际 `max(1, ceil(E * 0.15))` 取上界并逐行核算 |

附近中文解释性注释必须覆盖：

- chronology 以持久 `time.created` 为主，ID 只处理同毫秒 tie-break，不能从回绕 ID 反推完整时间。
- SQLite BINARY 按 UTF-8 bytes 比较 ID；`localeCompare` 与 JS UTF-16 relational order 都不能承载完整合法 caller ID 域。
- lower-bound helper 的数组排序前提和 `O(log n)` 定位目的。
- 300 条边界为何必须删除 chronology 首项而保留刚到达项。
- removed event 缺少创建时间且 caller ID 任意，因此索引保存 chronology key，而不是猜测 ID 排列。
- 索引必须在 snapshot replacement、full-Info event、window eviction 和 remove 的已有 mutation 点同步；索引 miss 不能触发第二套 scan fallback。
- 两个测试 fixture 为什么故意先放 lexical-high、后放 lexical-low ID，以及 worked expected order。
- lifecycle 测试同时锁定插入、更新不重复、hidden 删除；remove 测试锁定 payload 限制。

不计数的注释包括复述赋值、翻译变量名、重复测试名或集中堆放的比例填充文本。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/sync.test.tsx -t "keeps Message lifecycle chronological across ID rollover"` | `packages/opencode` | Slice 1 red -> green，真实 HTTP/SSE/SyncProvider path |
| `bun test test/cli/cmd/tui/sync.test.tsx -t "removes arbitrary Message IDs through chronology index"` | `packages/opencode` | Slice 2 red -> green，ID-only remove 与 index replacement path |
| `bun test test/cli/cmd/tui/sync.test.tsx -t "matches SQLite BINARY order for same-millisecond Message IDs"` | `packages/opencode` | Slice 3 red -> green，mixed-case snapshot/update/hidden/remove path |
| `bun test test/cli/cmd/tui/sync.test.tsx` | `packages/opencode` | 相关 SyncProvider 全套 regression |
| `bun typecheck` | `packages/opencode` | SDK Message、共享 comparator 和 TUI 类型边界正确 |
| 重跑 Section 8 的 `bun -e` | `packages/opencode` | 原始 300 条真实 reducer feedback 从 `targetVisible:false` 变为 `true`，exit 0 |
| `git diff --check` | repository root | 无 whitespace error |
| `git diff --numstat -- packages/opencode/src/cli/cmd/tui/context/sync.tsx packages/opencode/test/cli/cmd/tui/sync.test.tsx` | repository root | 生产行数、code file 数和 TUI-only 范围预算证据 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 plan | 本 canonical artifact；implementation 不新增 code file |
| Files modified | 2 code | TUI reducer 与现有 integration suite |
| Files deleted | 0 | 无文件级 workaround |
| Production lines | 55-90 | 明显低于 200；一个 BINARY comparator/lower-bound、一个 bounded derived index、全部 writer 同步 |
| Test lines | 125-170 | 三个真实 SyncProvider behavior slices 与必要 fixture/comments |
| Generated lines | 0 | SDK 与 schema 不变 |

代码文件共 2，低于 8。预算是审计信号，不允许用它省略四类已确认 Message lifecycle 行为或索引 writer。

## 20. Real Risks and Open Decisions

- 真实风险：如果 HTTP snapshot 或其他 caller 未来不再提供 chronology 升序，lower-bound 前提会失效。当前 server SQL、reverse 和既有 Message contract 已明确保证该顺序；本任务在 TUI 不重复排序 300 条 snapshot。
- 真实风险：同毫秒 Message 只按 ID 区分。共享 comparator 和服务端现有合同一致，测试必须包含 worked tie-break。
- 真实风险：派生索引若遗漏任何 Message writer 会产生 stale/missing key。全仓搜索确认 writer 集中于 `sync.tsx`，计划逐项覆盖 snapshot、create/update、hidden、eviction 和 explicit remove，并用 lifecycle 测试与 diff mapping 验证。
- 真实风险：索引使每个已加载 Message 多保留一个 Map entry；每 Session Message store bounded 为 300，索引与现有 cache 保持相同 lifetime，空间与现有投影同阶。
- 真实风险：TUI 局部 comparator 必须保持与服务端 `(time.created, id)` 合同一致；测试覆盖同毫秒 ID tie-break，且本任务因 TUI-only 不修改服务端 owner。
- 真实风险：SQLite BINARY 比较的是 UTF-8 bytes；实现必须使用 `Buffer.compare` 而不是只覆盖 ASCII 的 locale 或 UTF-16 比较，mixed-case test 锁定已观察 failure，代码审计锁定完整 Unicode 语义。

### Open Decisions Requiring the User

None。用户已经明确了时间顺序、复杂度、范围、行数、文件数和 schema 约束；仓库证据足以选择 owner 和测试 seam。

### Rejected Speculation

- 修改 ID 编码或从 ID 解码绝对时间：不能修复已有回绕数据，且扩大持久兼容范围。
- 调低/调高 300 条窗口：只改变症状触发数据量，不修复排序 invariant。
- 给 `message.removed` 增加创建时间或数据库 lookup：TUI 派生索引已在现有 ID-only event 上提供 chronology key；没有必要扩大 schema 或 producer I/O。
- 维护 `Map<messageID, arrayIndex>`：splice/shift 后所有位置都会变化，更新成本和失步面更大；R3 只保存稳定 Message chronology key，再复用二分定位。
- 修改 Part reducer：Part 缺少 Message 的 chronology contract，当前无反馈信号或用户症状。
- 同步修复 route 中所有 ID 边界比较：它们属于 Revert/queued UI 行为，不参与当前 Message 投影消失调用链；没有本次可达失败证据。
- 修改 App/Web Message 投影：用户后续原文明确限定只修改 TUI；已确认的 App/Web 路径只作为范围证据，不进入实现。
- 重复修复 #42583 的服务端 latest/prompt：当前 fork 已按 chronology 选择 latest，并以 assistant `parentID` 判断回答关系；上游也确认 1.18.15 已修复，当前现场 provider 调用成功。
- 统一修改服务端 `MessageV2.compareChronology`：用户限定 TUI-only；R5 只让 TUI locator 对齐自己的实际 HTTP snapshot producer，不扩张服务端内存 consumer。
- 在 TUI 直接 import 完整 `message-v2.ts`：为了两字段纯比较引入 DB/cold-storage runtime 依赖，不符合 owner 边界和最小改动。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15
  percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 App 的 Message 生命周期生产路径未纳入修复范围；B-02 ID-only remove 被降为线性查找 | Section 17 的 E/C 估算区间可能不一致 | BLOCK | `ses_ff7b3e97dffexfUd7v1UYiSPeF`（含同会话 blocker 复议） |
| 2 | R2 | yes | B-01 计划修改服务端模块，违反 TUI-only 范围；B-02 旋转二分前提不覆盖合法 caller-supplied Message ID | 无 | BLOCK | `ses_ff7a43bc9ffenktLlG6z81cOEj` |
| 3 | R3 | yes | B-01 首条 Message 创建分支缺少可失败的索引生命周期测试 | E/C 与文件范围验证命令估算记录偏差 | BLOCK | `ses_ff7963025ffeHXUzUO4zn8OYWU` |
| 4 | R4 | yes (plan audit) | 无 | Audit mode metadata wording；E/C 必须按实际 diff 重算 | APPROVE | `ses_ff78e6f5cffeI53PUNTblYWWHK` |
| 5 | R5 | yes (plan audit) | 无 | Audit mode metadata wording；R5 实现后须重算 E/C | APPROVE | `ses_ff77921caffeYodPEkH7ZzxorF` |

Round 1 exact release verdict:

> **BLOCK**
>
> 当前精确审计对象仍是 `R1`。B-01 与 B-02 均保留，需形成新的 canonical revision 后执行下一轮全范围审计。

Round 2 exact release verdict:

> **BLOCK**
>
> 精确审计对象为 canonical plan revision `R2`。B-01 与 B-02 均需修订后执行下一轮完整范围审计。

R3 disposition is substantive and therefore clears approval: all planned production
changes now stay inside the TUI owner, and arbitrary caller-supplied IDs resolve through
a bounded ID-to-chronology derived index before the shared logarithmic chronology search.
R3 requires a new full-scope audit.

Round 3 exact release verdict:

> **BLOCK**
>
> 精确审计对象为 canonical plan revision `R3`。B-01 需修订后执行下一轮完整范围审计。

R4 disposition is substantive and therefore clears approval: the remove slice now starts
from an event-first empty Message store, so omitting index initialization in the first
Message creation branch produces a behavioral failure. R4 requires a new full-scope audit.

Round 4 exact verdict:

> No blocking findings.
>
> **APPROVE**
>
> 该 verdict 仅适用于当前 canonical plan revision **R4**，且只表示计划审计通过。实现前仍必须将该 revision 标记为 approved，并在实现完成后执行独立的完整 implementation audit。

R5 is a substantive revision caused by implementation-audit evidence: the TUI tie-break
must match SQLite BINARY UTF-8 order rather than locale collation, and a mixed-case
same-millisecond behavior slice is now required. R4 approval is cleared and R5 requires
a new full-scope plan audit.

Round 5 exact verdict:

> No blocking findings.
>
> **APPROVE**
>
> 本 verdict 仅适用于 canonical plan revision **R5** 的 full-scope plan audit。R5 当前仍需由主流程记录本次独立 verdict，并在实现前将计划状态推进为与批准修订一致；实现完成后必须对 R5 实际 diff 执行独立 full-scope implementation audit。

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

- `packages/opencode/src/cli/cmd/tui/context/sync.tsx`: `47` additions, `5` deletions. Added the TUI-local chronology lower-bound, bounded ID-to-Message index, full-Info writer synchronization, indexed ID-only remove, window eviction cleanup, and snapshot index replacement.
- `packages/opencode/test/cli/cmd/tui/sync.test.tsx`: `174` additions, `2` deletions. Added public SyncProvider rollover lifecycle, event-first arbitrary-ID remove, and same-millisecond SQLite BINARY regressions.
- `docs/plans/tui-message-id-rollover-ordering-repair.md`: canonical R1-R5 plan, audit record, and implementation evidence; this untracked plan is not included by `git diff --numstat` until staged.
- Actual code files changed: `2`; production touched lines: `52` additions plus deletions, below the user limit of `200`; no App/Web, server, schema, config, migration, generated, or Part files changed.

### Red-Green Test Evidence

1. Slice 1 red: `bun test test/cli/cmd/tui/sync.test.tsx -t "keeps Message lifecycle chronological across ID rollover"` failed because expected oldest `msg_ffff00000001` but received `msg_ffff00000000`; the new target had been inserted at index 0 and shifted out.
2. Slice 1 green: the same command passed `1` test / `5` assertions after chronology lower-bound plus snapshot/full-Info index synchronization.
3. Slice 2 red: `bun test test/cli/cmd/tui/sync.test.tsx -t "removes arbitrary Message IDs through chronology index"` failed because received IDs still contained `msg_y` after ID-only remove.
4. Slice 2 green: the same command passed `1` test / `3` assertions after indexed chronology removal; Slice 1 was rerun in parallel and remained green.
5. Slice 3 red: `bun test test/cli/cmd/tui/sync.test.tsx -t "matches SQLite BINARY order for same-millisecond Message IDs"` failed because update produced duplicate order `[msg_B, msg_a, msg_B]` under `localeCompare`.
6. Slice 3 green: the same command passed `1` test / `5` assertions after changing only the ID tie-break to UTF-8 `Buffer.compare`; Slices 1 and 2 were rerun in parallel and remained green.

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/sync.test.tsx -t "keeps Message lifecycle chronological across ID rollover"` | `packages/opencode` | PASS: 1 pass, 5 assertions |
| `bun test test/cli/cmd/tui/sync.test.tsx -t "removes arbitrary Message IDs through chronology index"` | `packages/opencode` | PASS: 1 pass, 3 assertions |
| `bun test test/cli/cmd/tui/sync.test.tsx -t "matches SQLite BINARY order for same-millisecond Message IDs"` | `packages/opencode` | PASS: 1 pass, 5 assertions |
| `bun test test/cli/cmd/tui/sync.test.tsx` | `packages/opencode` | PASS: 27 pass, 94 assertions; existing non-fatal temporary KV `ENOENT` log remained visible |
| `bun typecheck` | `packages/opencode` | PASS: `tsgo --noEmit`, exit 0 |
| Section 8 `bun -e` real SyncProvider replay | `packages/opencode` | PASS: `{"count":300,"first":"msg_ffff00000001","last":"msg_000100000001","targetVisible":true}` |
| `git diff --check -- <implementation files>` | repository root | PASS: no output |
| conservative PowerShell diff count | repository root | 221 added lines, 204 nonblank, 31 qualifying Chinese comments before import-only exclusions |

### Original Feedback-Loop Result

Pre-implementation: `targetVisible:false`, target absent, exit 1 with `new chronological message disappeared after ID rollover`.

Post-implementation: `targetVisible:true`, count remains 300, chronology first item is the second-oldest Message, target is last, exit 0.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Actual disposition |
| --- | --- | --- |
| Full `message.updated` SQLite BINARY chronology lower-bound | supported-domain primary branch | implemented for insert/update/hidden, including mixed-case same-millisecond IDs |
| ID-only `message.removed` index lookup + same BINARY lower-bound | supported-domain primary branch | implemented without scan or ID retry |
| Missing/unloaded Session or missing index | contracted no-op | preserved |
| First event Message array creation | supported-domain primary branch | preserved and now indexes the first Message |
| HTTP snapshot replacement | supported-domain primary branch | preserved and now replaces the Session index from the same `infos` projection |
| Index miss linear scan / pure ID retry | forbidden fallback | absent |
| App/Web, server latest/prompt, Part, schema, migration, config | outside approved TUI path | unchanged |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 200 | 204 added nonblank lines minus 10 import-only lines, plus 6 substantive deleted/replaced old lines; blanks and deleted import line excluded |
| Qualifying Chinese comment lines `C` | 31 | Adjacent explanations for BINARY chronology, lower-bound, index necessity/lifecycle, window eviction, snapshot identity, and independent test intent |
| Ratio `C / E` | 15.5% | `31 / 200` |
| Required minimum `C` | 30 | `ceil(200 * 0.15)` |

### Remaining Unverified Items

None for the approved path. No interactive visual TUI run was required because both regressions drive the real public SyncProvider HTTP/SSE seam and inspect the same Message store rendered by the TUI.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R4 | yes | B-01 TUI 二分比较器与 HTTP snapshot 的 ID 排序规则不一致 | 无 | BLOCK | `ses_ff7813981ffeu6to5ArQbZNaRt` |
| 2 | R5 | yes | 无 | 完整 `sync.test.tsx` 输出既有非致命临时 `kv.json` ENOENT；27 pass / 0 fail | APPROVE | `ses_ff753d422ffeZVX3qgnD7gKBTg` |

Implementation audit round 1 exact release verdict:

> **BLOCK**
>
> R4 当前 implementation diff 需要修复 B-01，并再次执行完整范围 implementation audit。

Implementation audit round 2 exact verdict:

> No blocking findings.
>
> **APPROVE**
>
> 该 verdict 仅适用于 canonical plan **R5** 与当前审计的两文件完整 implementation diff。

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.
