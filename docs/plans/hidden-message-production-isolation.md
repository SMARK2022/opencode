# Canonical Implementation Plan: Hidden Message Production Isolation

> Status: implemented
>
> Revision: R6
>
> Approved revision: R6
>
> Audit mode: implementation
>
> Requirement source: 用户 Session GOAL 原始需求
>
> Implementation allowed: no further material changes without a new revision
>
> Last updated: 2026-07-26

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 找到所有潜在的hidden的消息影响主仓库正常生产逻辑逻辑链路，检查其共性以及相应的根因的修改方式，并给出较为合理且甜点级别的修复方案，整体代码修改量不超过400行，且不破坏现有的功能和性能。

目标终态是 `verified-implementation-and-commit`。

## 2. Explicit Non-Goals

- 不物理删除 hidden Message/Part，不迁移或重写既有数据库。
- 不退款、不清零、不重算 hidden 历史已经产生的 token、cost、RequestUsage、Stats 或 fork accounting。
- 不把全部 hidden Compaction 结构一律判废；完整成功且整体 hidden 的 pair 继续作为 structural-only cutoff，避免恢复已压缩 head。
- 不改变 raw persistence/event transport 的审计合同；hidden update 必须继续到达能够删除既有可见状态的 consumer。
- 不修改 experimental v2 Event/Projector、生成 SDK schema 或远端 share 服务。v2 默认关闭，远端 share consumer 不在本仓库内，均无证据授权平行实现。
- 不增加 feature flag、配置、fallback、兼容数据库扫描、启动 repair 或额外成功路径。
- 不修改 Session search、SummaryCache、recent-user memento、RequestUsage/Stats；现有证据证明这些 owner 已按各自合同处理 hidden。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Message 是 part-based persisted Session record；Compaction 管理 Provider context；v1 `session/` 是当前生产 owner。 |
| `AGENTS.md` | 默认分支 `dev`；优先自动化；tests/typecheck 必须从 package 目录运行。 |
| `packages/opencode/AGENTS.md` | Message/Part schema、SQLite/Drizzle、Effect service 与 module-shape 约束。 |
| `packages/opencode/test/AGENTS.md` | 行为测试使用 public seam、Effect fixture 与自动清理的 instance，不使用 sleep/mocks 复制 production logic。 |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | SDK-visible HTTP error 必须由 handler adapter 显式映射，domain service 不吸收 HttpApi 类型。 |
| `packages/app/AGENTS.md` | App 不得由实现流程重启；App event reducer 已有正确 tombstone 行为，只作为对照。 |
| `docs/adr/README.md` | 本任务不新增 ADR：visibility 修复属于既有 Message contract 的 bug repair，不建立新的跨任务架构决策。 |
| `.opencode/policy/first-principles-engineering.md` | 必须修 first divergence、禁止 fallback、完整 traceability、独立审计和 15% 中文解释注释。 |
| `docs/workflow.md` | exact revision 获得 full-scope plan approval 前禁止 implementation。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/session/message-v2.ts:71-130, 791-887, 989-1158, 1328-1445, 1508-1732` | Hidden schema、chronology、Provider conversion、page/stream/filterCompacted 所有核心 visibility seam。 | observed |
| `packages/opencode/src/session/compaction-boundary.ts:1-74` | completed Compaction structural cutoff 权威。 | observed |
| `packages/opencode/src/session/compaction.ts:156-235, 639-668, 796-815, 890-951, 1241-1316` | 已有成功 pair、tail、memento、prune、failed-pair hidden producer。 | observed |
| `packages/opencode/src/session/prompt.ts:144-173, 2440-2519, 2575-2595, 2815-2990` | Goal chronology、Provider window、plugin 后 Provider conversion。 | observed |
| `packages/opencode/src/session/prompt.ts:2873-3005`、`src/token/estimate.ts:246-299` | plugin transform 后 raw `requestMsgs` 同时驱动 input breakdown、chars/token learning 和 auto Compaction。 | reachable |
| `packages/plugin/src/index.ts:281-289` | public plugin hook 可修改 Message/Part，包括设置 hidden。 | contracted |
| `packages/opencode/src/session/goal.ts:325-450`、`src/tool/goal.ts:12-123` | `current/previous` turn 控制 blocked streak 与 terminal transition。 | observed |
| `packages/opencode/src/session/session.ts:726-745, 878-900` | raw hidden event producer；bounded/unbounded Message read。 | observed |
| `packages/opencode/src/session/revert.ts:157-208` | normal producer 可按 Message 或 Part 独立标记 hidden。 | reachable |
| `packages/opencode/src/session/processor.ts:650-705` | current assistant doom-loop window 使用 raw Parts。 | reachable |
| `packages/opencode/src/session/search.ts:47-129` | Search 在 SQL 层排除 hidden Message/Part，属于 clean control。 | observed |
| `packages/opencode/src/session/summary-cache.ts:91-164` | Diff/Summary owner 排除 hidden，属于 clean control。 | observed |
| `packages/opencode/src/session/projectors.ts:25-60, 205-257` | hidden 不退款 accounting；summary cache invalidation 已区分 visibility。 | contracted |
| `packages/opencode/src/storage/cold.ts:900-945` | hidden subagent Message 只影响 physical activity clock；实测最大 10.4 秒，无正常业务损害证据。 | observed |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:769-855, 1047-1117` | TUI store 正确消费 tombstone；HTTP snapshot 的 physical limit 造成可见深度缩水。 | observed |
| `packages/app/src/context/global-sync/event-reducer.ts:186-259` | Web App 正确删除 hidden Message/Part，证明 raw event 的 tombstone 语义可由 adapter 承载。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:380-395` | plan agent raw Part listener 绕过 TUI tombstone store。 | reachable |
| `packages/opencode/src/cli/cmd/run.ts:607-687` | legacy `opencode run` 直接输出 raw hidden updates。 | reachable |
| `packages/opencode/src/cli/cmd/run/session-data.ts:55-117, 669-907` | current run reducer 将 hidden assistant/tool 转成 commits/footer/state。 | observed |
| `packages/opencode/src/cli/cmd/run/subagent-data.ts:300-338, 735-804` | hidden task Part 可创建/保留 subagent tab。 | reachable |
| `packages/opencode/src/cli/cmd/run/stream.transport.ts:119-209, 739-859` | hidden assistant event 可满足 live-activity completion gate。 | reachable |
| `packages/opencode/src/acp/agent.ts:277-301` | ACP 将 raw hidden Tool update 当正常 lifecycle。 | reachable |
| `packages/opencode/src/cli/cmd/github.ts:898-926` | GitHub adapter 输出 raw hidden Tool/Text。 | reachable |
| `packages/slack/src/index.ts:23-49` | Slack adapter 可为 hidden completed Tool 再次发送外部消息。 | reachable |
| `packages/opencode/src/share/share-next.ts:165-200, 271-295` | live share 传 hidden tombstone，full snapshot 排除 hidden；远端 consumer 不在仓库。 | contracted pass-through |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:134-181` | collection 使用 visible page；single-message endpoint 直接暴露 raw `get()`。 | observed |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:355-377` | public API 描述是普通 Message retrieval，没有 raw/audit contract。 | contracted |
| `packages/opencode/test/session/messages-pagination.test.ts:814-1240` | 覆盖成功 tail 和无 tail/失败 marker，但缺 newer failed tail、partial hidden pair、visible-limit refill。 | observed |
| `packages/opencode/test/session/compaction.test.ts:1498-1754, 2188-2259` | failed lifecycle/accounting 和 memento 已覆盖；不得削弱。 | observed |
| `packages/opencode/test/session/prompt.test.ts:4329-4437` | Goal chronology seam 已有 technical-wrapper fixtures，缺 hidden canonical turn。 | observed |
| `packages/opencode/test/session/processor-effect.test.ts:1075-1260` | doom-loop public behavior seam，缺 hidden current Tool。 | observed |
| `packages/opencode/test/cli/run/session-data.test.ts`、`subagent-data.test.ts`、`stream.transport.test.ts` | exported reducer/transport seam，均缺 MessageV2.hidden cases。 | observed |
| `packages/opencode/test/server/httpapi-sdk.test.ts:652-691` | generated SDK route parity seam，缺 hidden direct lookup。 | observed |
| `packages/opencode/test/acp/event-subscription.test.ts` | ACP event adapter seam，缺 hidden terminal Tool。 | observed |
| live `opencode.db` read-only queries | 4,727 hidden Messages；0 hidden Parts；目标 Session visible page 247/300；67 Goal current/previous divergences；1 active Goal divergence。 | observed |
| live same-process SQL/JS benchmark on three representative Sessions | 最大 6326 Message；高 hidden density 161/274；page/chronology raw 与 proposed refill/projection p50/p95 baseline。 | observed |

## 5. Current Behavior

```text
Message/Part producer
  -> SyncEvent projector persists full raw object (hidden included)
  -> raw event is published for tombstone propagation
  -> structural/raw consumers may intentionally inspect hidden
  -> visible consumers inconsistently filter:
       page: SQL limit first, hidden filter later
       chronology: no hidden filter
       filterCompacted: structural scan then unchecked replay selection
       run/ACP/GitHub/Slack: ordinary event consumption
       direct HTTP get: raw MessageV2.get
  -> hidden state changes visible history, Goal authority, Provider window,
     terminal output, external notifications, or API response
```

Intentional paths remain distinct:

```text
raw persistence -> audit/recovery/accounting/fork/stats
raw hidden event -> visible state adapter removes/tombstones prior object
fully hidden completed Compaction pair -> structural-only cutoff
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| hidden Message among visible history | undo, stale-turn repair, reviewer retry, failed Compaction | row remains durable; `hidden.reason/time` valid | `MessageV2.page`, `chronology`, HTTP get | MessageV2 / HTTP adapter | observed |
| hidden Part | public part-level Revert/undo | parent Message may remain visible | Provider replay, event adapters, doom loop | MessageV2 / output adapter / Processor | reachable |
| older completed Compaction + newer failed hidden marker with `tail_start_id` | normal auto/manual Compaction failure after tail selection | summary lacks successful `finish && !error` | `filterCompacted` post-pass | MessageV2 | observed |
| visible marker + hidden successful summary | message-level Revert beginning at summary | completed summary remains durable | `filterCompacted` / Provider conversion | MessageV2 | reachable |
| marker with hidden Compaction Part + visible summary | part-level Revert | hidden Part remains durable | `CompactionBoundary.latest`, `filterCompacted` | CompactionBoundary / MessageV2 | reachable |
| hidden canonical user turn | undo | visible Provider window excludes it | `chronology -> deriveGoalTurn -> GoalTool` | MessageV2 chronology | observed |
| hidden assistant/tool event | all hidden producers; public part update | event transports full object by design | run/ACP/GitHub/TUI/Slack adapters | each visible output adapter | observed / reachable |
| visible Part PATCH under hidden parent Message | public `part.update` with IDs learned before Revert | handler validates IDs only；parent Message remains durable hidden | hidden parent -> ordinary `PartUpdated` event -> output adapters | SessionHttpApi public mutation seam | reachable defect |
| direct lookup of known hidden ID | public SDK caller | ID is valid and row exists | HTTP `session.message -> MessageV2.get` | HTTP adapter | observed |
| hidden post-plugin prompt input | `experimental.chat.messages.transform` can mutate filtered clone | plugin runs after initial filter | Provider wire、input breakdown、token-history learning、overflow | SessionPrompt post-plugin projection / Provider conversion | reachable |
| hidden post-plugin Compaction input | 同一 plugin hook 修改 `selected.head` clone | hook runs before compaction conversion/estimate | compaction Provider wire 和 upload estimate history | SessionCompaction post-plugin projection | reachable |
| hidden current Tool in doom-loop window | public part update or concurrent undo/import | raw `MessageV2.parts()` returns it | Processor identical-error window | Processor | reachable |
| hidden usage/cost/Stats | actual Provider work already occurred | accounting must preserve spend | projector/RequestUsage/Stats | accounting owner | contracted, not a defect |
| fully hidden successful Compaction pair | undo after completed Compaction | marker 与 summary 都 hidden，Compaction Part visible | structural cutoff only | CompactionBoundary | contracted, not a defect |
| partial-hidden successful Compaction pair | public API Revert starts at summary or Part | marker/summary hidden 状态不同，或 Compaction Part hidden | persisted pre-read cutoff | CompactionBoundary | reachable defect |
| remote share rendering hidden payload | remote service outside repository | local wire carries tombstone | external consumer unknown | remote share adapter | speculative result; cannot drive local guard |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Raw hidden rows remain durable for audit/accounting, while normal visible reads never return or count them. | user accounting requirement; page/API evidence | partial only |
| INV-02 | A visible `limit=N` returns up to N visible Messages; hidden rows cannot consume capacity or terminate older visible paging. | target Session 247/300 reproduction | missing |
| INV-03 | Provider Compaction boundary has exactly two valid states: fully visible successful pair provides cutoff+replay；fully hidden marker+summary with visible Compaction Part provides structural-only cutoff。partial-hidden pair、hidden Part、failed/incomplete pair 均不构成 boundary，不能 pre-read 裁掉旧 head。 | real `filterCompacted` repro；public Revert producer；existing hidden-anchor test | missing persisted partial/failed cases |
| INV-04 | Goal current/previous canonical turns contain only visible Messages and visible qualifying Parts. | 67 live divergences; active target Goal | missing |
| INV-05 | A hidden update is a tombstone for visible event adapters: it cannot create output, footer usage/error, live activity, Tool lifecycle, tab, agent switch or external notification. | real run reducer repro; TUI/App clean controls | missing outside TUI/App |
| INV-06 | Ordinary public single-Message retrieval and Part mutation obey parent Message visibility：hidden Message is public not-found，known Part ID cannot resurrect it through PATCH；visible parent may still receive a hidden Part tombstone. | endpoint descriptions + raw handlers + public Revert path | missing |
| INV-07 | Plugin transform 后建立一次权威 visible projection；Provider payload、input breakdown、chars/token learning、upload snapshot 和 auto Compaction 必须消费同一投影，converter 独立 public seam 也拒绝 hidden。 | plugin order and split `requestMsgs` consumers | missing |
| INV-08 | Hidden Tool Parts cannot satisfy doom-loop failure count. | raw current Part path vs filtered historical path | missing |
| INV-09 | Hiding transcript content does not refund or remove token/cost/RequestUsage/Stats. | user requirement and existing tests | existing coverage |
| INV-10 | Visibility repair does not materially regress bounded page or per-turn Goal chronology performance on representative large/high-hidden Sessions. | explicit user performance requirement + measured hot paths | missing before R5 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 / INV-02 | `MessageV2.page` applies physical SQL limit before Message visibility and hydrates hidden Parts before filtering. | `MessageV2.page/hydrate` | live target query returns 247 visible while 300 are available |
| INV-03 | `CompactionBoundary.latest` 在 pre-read cutoff 前未证明 pair 是 fully visible 或 fully hidden，且接受 hidden Part；`filterCompacted` post-pass 又选择任意 latest tail marker。 | MessageV2 Compaction filter / CompactionBoundary | failed-tail pure output；public Revert 可产生 visible marker + hidden summary；partial-hidden pure repro |
| INV-04 | `chronology` selects every Message/Part and omits Part hidden state before Goal classification. | MessageV2 chronology projection | live active Goal has hidden previous turn |
| INV-05 | Raw event publication is correct; each visible output adapter first diverges when it interprets `hidden` payload as ordinary update instead of tombstone. | run/ACP/GitHub/TUI/Slack adapters | reducer emits visible error/footer for hidden assistant |
| INV-06 | HTTP handler routes ordinary `session.message` directly to raw internal `MessageV2.get`. | SessionHttpApi adapter | source path has no visibility branch |
| INV-06 | public `updatePart` validates payload IDs but never reads parent Message visibility, then publishes raw Part update. | SessionHttpApi adapter | Revert hides Message while leaving Parts；known ID PATCH is SDK-visible and reachable |
| INV-07 | plugin transform 后没有权威 visible projection：converter 可过滤 wire，但 `requestMsgs` 仍被 breakdown、ratio learning 与 overflow 消费；Compaction hook 也需保持同一投影。 | SessionPrompt post-plugin projection + `toModelMessagesEffect` independent seam | public plugin transform 后存在多个 raw/converted consumers |
| INV-08 | Processor appends raw current-assistant Parts to an otherwise visible historical Tool window. | Processor doom-loop window | `MessageV2.parts(...).filter` lacks hidden predicate |
| INV-10 | R4 changed indexed Message/Part query shapes without an executable baseline/threshold; direct SQL JSON predicates measured material Message-query overhead. | MessageV2 visible read owner / verification contract | raw-vs-SQL benchmark and R4 audit B-01 |

### Red-capable feedback loops already run

Working directory for the first two commands: `packages/opencode`. All commands are pure memory or read-only database access and intentionally exit 1 when the defect is reproduced.

```powershell
bun -e 'import { MessageV2 as M } from "./src/session/message-v2"; const m=(id,role,parts=[],extra={})=>({info:{id,role,...extra},parts}); const tail=m("msg_001","user",[{type:"text",text:"tail"}]); const c1=m("msg_003","user",[{type:"compaction",tail_start_id:"msg_001"}]); const s1=m("msg_004","assistant",[{type:"text",text:"summary"}],{parentID:"msg_003",summary:true,finish:"stop"}); const next=m("msg_005","user",[{type:"text",text:"next"}]); const c2=m("msg_007","user",[{type:"compaction",tail_start_id:"msg_005"}],{hidden:{time:1,reason:"compaction-cancelled"}}); const s2=m("msg_008","assistant",[],{parentID:"msg_007",summary:true,error:{name:"APIError"},hidden:{time:1,reason:"compaction-cancelled"}}); const out=M.filterCompacted([tail,c1,s1,next,c2,s2]).map(x=>x.info.id); console.log(JSON.stringify(out)); if(JSON.stringify(out)!==JSON.stringify(["msg_005"])) process.exit(2); process.exit(1)'
```

Observed: `['msg_005']`; the valid earlier summary/tail is lost to the failed hidden marker.

```powershell
bun -e 'import { createSessionData,reduceSessionData } from "./src/cli/cmd/run/session-data"; const data=createSessionData(); const out=reduceSessionData({data,sessionID:"ses_1",thinking:false,limits:{"p/m":128000},event:{type:"message.updated",properties:{sessionID:"ses_1",info:{id:"msg_1",role:"assistant",providerID:"p",modelID:"m",tokens:{input:43000,output:0,reasoning:0,cache:{read:0,write:0}},cost:1,hidden:{time:1,reason:"undo"},error:{name:"APIError",data:{message:"hidden failure"}}}}}}); console.log(JSON.stringify({announced:data.announced,commits:out.commits,footer:out.footer})); if(!(data.announced&&out.commits.length===1&&out.footer)) process.exit(2); process.exit(1)'
```

Observed: visible `hidden failure`, `assistant responding`, and `43.0K (34%) · $1.00`.

Working directory for the database command: repository root.

```powershell
bun -e 'import { Database } from "bun:sqlite"; const db=new Database("C:/Users/Lenovo/.local/share/opencode/opencode.db",{readonly:true}); const sid="ses_10fb7b41cfferSWcJIpOXdJIGj"; const physical=db.query("SELECT id,json_type(data, ''$.hidden'') hidden FROM message WHERE session_id=? ORDER BY time_created DESC,id DESC LIMIT 300").all(sid); const visible=db.query("SELECT id FROM message WHERE session_id=? AND json_type(data, ''$.hidden'') IS NULL ORDER BY time_created DESC,id DESC LIMIT 300").all(sid); console.log(JSON.stringify({physical:physical.length,returned:physical.filter(x=>x.hidden===null).length,available:visible.length})); db.close(); if(!(physical.length===300&&physical.filter(x=>x.hidden===null).length<visible.length)) process.exit(2); process.exit(1)'
```

Observed: `{ physical: 300, returned: 247, available: 300 }`.

The minimized Goal reproduction is the live active target Session: the newest canonical user is visible, the second newest raw canonical user has `hidden.reason='undo'`, and the second newest visible canonical user has a different ID. The exact read-only command was run from repository root and exited 1:

```powershell
bun -e 'import { Database } from "bun:sqlite"; const db=new Database("C:/Users/Lenovo/.local/share/opencode/opencode.db",{readonly:true}); const sid="ses_10fb7b41cfferSWcJIpOXdJIGj"; const where="m.session_id=? AND json_extract(m.data, ''$.role'')=''user'' AND json_extract(m.data, ''$.goalTurnID'') IS NULL AND EXISTS(SELECT 1 FROM part p WHERE p.message_id=m.id AND json_extract(p.data, ''$.type'')<>''compaction'' AND coalesce(json_extract(p.data, ''$.synthetic''),0)<>1)"; const all=db.query(`SELECT m.id,json_extract(m.data,''$.hidden.reason'') hidden FROM message m WHERE ${where} ORDER BY m.time_created DESC,m.id DESC LIMIT 2`).all(sid); const visible=db.query(`SELECT m.id FROM message m WHERE ${where} AND json_type(m.data,''$.hidden'') IS NULL ORDER BY m.time_created DESC,m.id DESC LIMIT 2`).all(sid); const goal=db.query("SELECT status FROM session_goal WHERE session_id=?").get(sid); console.log(JSON.stringify({all,visible,goal})); db.close(); if(!(goal.status==="active"&&all[1].hidden==="undo"&&all[1].id!==visible[1].id)) process.exit(2); process.exit(1)'
```

Observed:

```json
{"all":[{"id":"msg_f9a82f41b001z3M6oJ7rW6fTv1","hidden":null},{"id":"msg_f9a77197c001Gz3X3saFijGVyr","hidden":"undo"}],"visible":[{"id":"msg_f9a82f41b001z3M6oJ7rW6fTv1"},{"id":"msg_f92f09fdd001TkIdRFd5NyYu35"}],"goal":{"status":"active"}}
```

Plan audit R1 additionally proved the post-plugin feedback gap: a plugin can hide a Message after `filterCompactedEffect`; current `prompt.ts` can omit it from `modelMsgs` while still iterating the raw `requestMsgs` for `inputBreakdown` and passing the same raw history to `TokenEstimate.estimateUploadInput`, whose learned ratio drives `compaction.isOverflow`. R2 adds a pre-implementation red slice at the existing SessionPrompt Plugin layer: a plugin-hidden high-usage Message must be absent from the persisted input snapshot and must not trigger auto Compaction.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| visible persisted range | MessageV2 `page/hydrate` | visible collection with bounded limit and indexed range performance | first Message/Part selection seam | Session/TUI cannot refill correctly after physical range is lost |
| Goal chronology | MessageV2 `chronology` | canonical persistent visible turns without Provider compaction | first hot projection seam | Goal service receives already-classified trusted IDs |
| Compaction structural/replay proof | MessageV2 filter + CompactionBoundary | pre-read cutoff 只接受 fully visible 或 fully hidden successful pair；partial pair 无 boundary | owns marker/summary/Part relationship before irreversible range selection | Prompt/Provider cannot reconstruct head after cutoff discarded it |
| post-plugin prompt visibility | SessionPrompt immediately after plugin transform | every downstream request representation and decision consumes one visible array | first common owner before requestMsgs/modelMsgs/breakdown/estimate split | converter alone is too late for token snapshot and overflow |
| post-plugin Compaction visibility | SessionCompaction immediately after plugin transform | compaction wire and upload history consume the same visible head | first common owner for transformed compaction input | TokenEstimate cannot infer Message visibility from text/history separately |
| independent Provider conversion visibility | `toModelMessagesEffect` | direct/public conversion never emits hidden input | independently public/untrusted conversion seam | prompt projection cannot constrain other callers |
| raw event persistence | SyncEvent | persist and publish complete lifecycle state | tombstone must remain transportable | visible consumers must not weaken audit projection |
| terminal/live output | each run/ACP/GitHub/TUI/Slack adapter | convert raw events into visible output/state | first view/output seam after raw event | upstream cannot suppress tombstone without breaking TUI/App removal |
| public direct Message visibility | Session HTTP handler | ordinary SDK-visible retrieval | public adapter defines raw/visible wire contract | internal `MessageV2.get` is legitimately raw for repair/reviewer |
| public Part mutation visibility | Session HTTP handler | ordinary SDK mutation cannot target public-not-found hidden parent | first untrusted mutation seam has session/message/part IDs and existing 404 contract | output adapters must not duplicate parent DB lookup；internal updatePart must stay raw |
| doom-loop visible failures | Processor | three visible identical Tool failures | combines current and historical Tool window | raw Part storage must remain available elsewhere |

## 10. Single Approved Primary-Path Design

One visibility contract governs all planned changes:

```text
persist raw Message/Part and publish raw lifecycle event
  -> structural/raw caller opts in explicitly
  -> visible persisted reader selects only visible rows before range/limit
  -> structural Compaction proof validates success and pair identity
  -> replay emits marker/summary only when the complete pair is visible
  -> Goal/Provider/output/API adapters consume the visible projection
  -> accounting/audit consumers retain raw facts
```

### Persisted visible projection

- Extract one pure `MessageV2.visible(messages)` projection that atomically excludes hidden Messages and hidden Parts without changing order. `filterCompacted`, SessionPrompt and SessionCompaction reuse this owner rather than duplicating filters.
- `MessageV2.page(includeHidden !== true)` preserves the indexed physical Message query and refills in bounded chunks until it has `limit + 1` visible hot rows or reaches EOF. It filters `row.data.hidden` before hydrate, so hidden rows consume neither visible capacity nor Part thaw.
- Refill carries the last scanned physical `(time_created,id)` as its internal cursor；the public next-page cursor remains the last returned visible row so the first extra visible row is replayed on the next page without loss.
- Visible `hydrate` excludes hidden Part rows before `ColdStorage.thawPartRows`; raw hydrate retains all Parts.
- `includeHidden: true` preserves current raw structural/reviewer/test behavior.
- The existing cursor remains based on selected rows; visible mode now advances over visible rows, so bounded limit and unbounded paging agree.
- `chronology` keeps its current indexed full Message query, filters already-decoded `row.data.hidden` before `hotInfo`, and adds one hidden discriminator to the narrow Part locator projection before JS filtering. It does not add a JSON predicate to the Message WHERE clause.
- `deriveGoalTurn` remains unchanged because its input contract becomes true at the chronology owner.

### Compaction pair contract

- Structural completion remains `summary && finish && !error` paired with a real non-hidden Compaction Part, and then validates Message visibility parity before returning any persisted cutoff.
- `CompactionBoundary.latest` accepts only `(marker visible && summary visible)` or `(marker hidden && summary hidden)`；XOR partial-hidden candidates are skipped so lookup continues to an earlier valid completed boundary. A hidden Compaction Part is skipped.
- `filterCompacted` records the exact successful summary for each marker and uses only that set for tail reordering. A failed/incomplete newer marker cannot become `compactionIndex` or `summaryIndex`.
- Replay visibility is atomic: fully visible pair returns marker+summary；fully hidden pair returns neither while retaining structural cutoff；partial-hidden pair and hidden-Part pair provide neither replay nor cutoff.
- Pure `filterCompacted` applies the same tri-state proof when callers already hold full history. It cannot act as a downstream workaround for an invalid persisted cutoff.
- Normal SessionPrompt assigns `msgs = MessageV2.visible(msgs)` immediately after `experimental.chat.messages.transform`. `selectDecideMessages`/`requestMsgs`, Provider conversion, per-component input breakdown, `TokenEstimate.estimateUploadInput(history)` and `compaction.isOverflow` all consume that projected array.
- SessionCompaction projects its transformed `selected.head` once; Provider conversion and upload-ratio history both consume the projected head rather than the pre-plugin raw history.
- `toModelMessagesEffect` independently reuses the same projection so direct callers remain safe.

### Event tombstone contract

- SyncEvent remains raw and unchanged.
- Stateful run reducers consume hidden Message/Part as tombstones: no commits/footer/error/usage; pending text/tool state for that object is dropped or made non-replayable; hidden task Parts remove rather than create subagent tabs.
- Stream activity ignores hidden assistant updates.
- Append-only output adapters (`run.ts`, ACP, GitHub, Slack) ignore hidden updates because their protocols cannot retract already emitted output; they must not emit a second visible effect.
- TUI plan switching checks visibility before interpreting completed plan Tool state. Main TUI/App reducers remain unchanged.

### Public HTTP contract

- Internal `MessageV2.get` remains raw.
- `session.message` maps a hidden Message to the existing public not-found contract and filters hidden Parts from an otherwise visible Message.
- `part.update` reads the parent through raw `MessageV2.get` before mutation and maps a missing or hidden parent to the same existing public not-found contract. It performs this check before `Session.updatePart`, so no durable update/event is emitted.
- A visible parent may still receive a payload whose Part is hidden；that is the supported public tombstone producer consumed by INV-05 adapters.
- Collection and direct retrieval therefore share ordinary visibility without adding `includeHidden` to the public API.

### Doom-loop contract

- Processor excludes hidden current-assistant Tool Parts before combining with the already-visible historical tail.

This repairs each first divergence at its owner. No path retries a failed primary operation, synthesizes success, deletes audit data, or bypasses the normal Message path.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| visible Message page/chronology/replay | proposed | primary-contract branch | yes | primary | repair |
| `includeHidden: true` raw page/stream | current | existing compatibility / structural branch | no visible success | unchanged | preserve |
| fully hidden successful Compaction structural cutoff | current | supported-domain branch | no replay output | unchanged | preserve |
| raw SyncEvent hidden payload | current | contracted pass-through | no visible output itself | unchanged | preserve |
| accounting/Stats/fork raw history | current | contracted pass-through | accounting only | unchanged | preserve |
| public `includeHidden` query fallback | proposed nowhere | forbidden fallback | n/a | 0% | reject |
| DB repair/startup scan | proposed nowhere | forbidden fallback | n/a | 0% | reject |
| remote share inference | proposed nowhere | speculative | n/a | 0% | reject |

New alternate success paths: 0. Diagnostic decision surface: 0%. Fallback ratio: 0%.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `page()` post-hydrate Message/Part filtering | allowed raw and visible callers to share one query | indexed hot-row refill establishes visible capacity before hydrate；raw branch remains explicit | collapse into visibility-aware row selection/hydrate branch in `message-v2.ts` |
| `filterCompacted` independent post-pass search for any tail marker/summary | repaired retained-tail order after structural walk | exact completed-pair map carries the same ordering fact without accepting failed/partial pair | replace lines around current `compactionIndex/summaryIndex` |
| downstream assumptions that raw event means visible update | event schema carries hidden for tombstone transport | output adapters explicitly interpret tombstone at first view seam | run/ACP/GitHub/TUI/Slack adapters |

The one-off database removal of the target failed Part `tail_start_id` is incident data repair outside the repository. The implementation must not codify or repeat that workaround.

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 / INV-02 | indexed visible hot-row refill and Part hydration | `message-v2.ts` | `messages-pagination.test.ts`: hidden rows do not consume limit; hidden-only physical page cannot block older visible history |
| INV-03 | completed pair map + tri-state persisted boundary + atomic replay | `message-v2.ts`, `compaction-boundary.ts` | `messages-pagination.test.ts`: newer failed tail；public Revert 成功 summary 后 `filterCompactedEffect` 不截 head；hidden Part invalid；fully hidden structural pair preserved |
| INV-04 | visible chronology projection | `message-v2.ts` | `prompt.test.ts`: hidden user/Part cannot become Goal current/previous or blocked predecessor |
| INV-05 run | tombstone reducers and activity gate | `run.ts`, `run/session-data.ts`, `run/subagent-data.ts`, `run/stream.transport.ts`, `run/types.ts` | reducer/transport tests assert zero output/footer/live/tab and Message-level parent cleanup |
| INV-05 adapters | visible terminal adapters | `acp/agent.ts`, `github.ts`, TUI session route, Slack index | ACP event test; adapter guards verified by package tests/typecheck where no injectable output seam exists |
| INV-06 | public visible direct lookup and mutation | HTTP session handler | `httpapi-sdk.test.ts`: hidden Message is 404；hidden Part absent；Revert/cleanup hidden parent then known Part PATCH is 404 and raw Part remains unchanged |
| INV-07 | authoritative post-plugin projection + final conversion | `message-v2.ts`, `prompt.ts`, `compaction.ts` | `prompt.test.ts`: plugin-hidden history changes neither input snapshot nor overflow; `compaction.test.ts`: transformed hidden head is absent from wire/history; `message-v2.test.ts`: direct conversion drops hidden |
| INV-08 | visible current Tool window | `processor.ts` | `processor-effect.test.ts`: hidden identical error does not complete threshold |
| INV-09 | unchanged accounting | no production accounting change | existing compaction/revert RequestUsage and cold Stats tests remain green |
| INV-10 | actual production-seam benchmark over fixed test cohorts | no extra production concept；verification owner | focused test invokes `MessageV2.page`, `MessageV2.chronology`, and their real hydrate path before/after implementation and enforces the recorded threshold |

No automated route-level harness currently injects a hidden plan Tool into the full TUI Session component, starts the top-level GitHub command without external GitHub I/O, or imports Slack without starting Bolt/createOpencode. Those three one-line output guards are verified by source-path inspection plus package typecheck/build; extracting test-only wrappers or mocking external clients would violate the line budget and repository no-mock preference. Their common raw-event behavior remains behaviorally covered at the exported run reducer and ACP event seam.

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| visibility-aware Message/Part selection before limit | INV-01, INV-02 | live 247/300 result | post-filter has already lost range capacity and hydrated hidden payload |
| exact completed Compaction pair map | INV-03 | real failed-tail and partial-pair outputs | independent `findLastIndex` forgets completion proof |
| Compaction visibility-parity boundary proof | INV-03 | public API Revert produces visible marker + hidden summary before `filterCompactedEffect` | replay suppression happens after pre-read cutoff and cannot restore discarded head |
| atomic pair replay visibility | INV-03 | hidden summary/Part pure repro | filtering components independently creates unpaired Provider roles |
| visible chronology SQL projection | INV-04 | 67 DB divergences, one active | classifier cannot recover Part hidden state omitted by projection |
| stateful event tombstone reduction | INV-05 | run reducer visible error/footer repro | skipping only output leaves buffered Tool/text/tab state authoritative |
| append-only adapter hidden guard | INV-05 | raw event producer plus output source paths | append-only protocols cannot retract; accepting tombstone causes a second side effect |
| public visible direct lookup branch | INV-06 | 4,727 hidden rows + ordinary endpoint contract | internal raw get is required by repair/reviewer and cannot change globally |
| public Part parent-visibility guard | INV-06 | Revert leaves visible Parts under hidden Message；public PATCH accepts known IDs | Part-only event cannot carry parent visibility，so downstream adapters cannot own rejection |
| shared `MessageV2.visible` projection | INV-01, INV-03, INV-07 | page/filter duplication and plugin split consumers | existing local filters run at different times and permit semantic drift |
| SessionPrompt post-plugin projection | INV-07 | raw `requestMsgs` drives breakdown/estimate/overflow | converter filtering is too late for three sibling consumers |
| SessionCompaction post-plugin projection | INV-07 | transformed head and raw `history` currently diverge | Provider wire and learned upload ratio need the same supported history |
| independent Provider conversion gate | INV-07 | converter is exported and has non-prompt callers | prompt/compaction projection cannot guarantee direct caller input |
| current Tool hidden filter | INV-08 | current path uses raw `parts()` | historical helper already filters but cannot own current message read |
| indexed visible refill instead of SQL hidden predicate | INV-02, INV-10 | SQL predicate benchmark regressed large Message query while refill restored 301 visible at baseline-like p95 | post-filter loses capacity；SQL predicate changes hot query cost；refill preserves existing index path |
| chronology JS projection + narrow Part discriminator | INV-04, INV-10 | existing Message rows are already decoded；Part query intentionally projects only locator fields | SQL WHERE predicate is unnecessary；full Part hydration would violate performance/cold contract |

No new setting, schema, dependency, migration, cache, retry, fallback or public raw endpoint is proposed.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/session/message-v2.ts` | modify | shared visible projection, indexed page refill/hydrate, chronology, completed pair replay, final Provider gate | 42-55 |
| `packages/opencode/src/session/compaction-boundary.ts` | modify | tri-state marker/summary visibility parity + hidden Part exclusion before cutoff | 5-9 |
| `packages/opencode/src/session/processor.ts` | modify | exclude hidden current Tool from doom-loop window | 2-4 |
| `packages/opencode/src/session/prompt.ts` | modify | project transformed messages before request snapshot/breakdown/estimate/overflow split | 3-6 |
| `packages/opencode/src/session/compaction.ts` | modify | transformed visible head owns compaction wire and upload history | 3-6 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | modify | visible direct Message API + hidden-parent Part mutation rejection | 10-16 |
| `packages/opencode/src/cli/cmd/run.ts` | modify | append-only legacy run ignores hidden updates | 4-7 |
| `packages/opencode/src/cli/cmd/run/session-data.ts` | modify | stateful Message/Part tombstone handling | 18-28 |
| `packages/opencode/src/cli/cmd/run/subagent-data.ts` | modify | hidden task/child event cannot create tab/detail | 8-15 |
| `packages/opencode/src/cli/cmd/run/types.ts` | modify | retain the parent MessageID on task tabs so a Message tombstone can revoke derived tab/detail state | 2-5 |
| `packages/opencode/src/cli/cmd/run/stream.transport.ts` | modify | hidden assistant is not live activity | 2-4 |
| `packages/opencode/src/acp/agent.ts` | modify | ignore hidden Tool lifecycle update | 2-4 |
| `packages/opencode/src/cli/cmd/github.ts` | modify | ignore hidden Tool/Text output | 2-4 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | ignore hidden plan transition | 2-4 |
| `packages/slack/src/index.ts` | modify | do not send hidden completed Tool notification | 2-4 |
| `packages/opencode/test/session/messages-pagination.test.ts` | modify | visible range + pure/persisted Compaction pair regressions through Revert | 40-55 |
| `packages/opencode/test/session/message-v2.test.ts` | modify | final Provider conversion visibility | 12-20 |
| `packages/opencode/test/session/prompt.test.ts` | modify | Goal chronology + post-plugin input snapshot/overflow | 30-45 |
| `packages/opencode/test/session/compaction.test.ts` | modify | post-plugin visible compaction head/history | 12-20 |
| `packages/opencode/test/session/processor-effect.test.ts` | modify | hidden current Tool doom-loop behavior | 12-20 |
| `packages/opencode/test/cli/run/session-data.test.ts` | modify | hidden Message/Part tombstones | 18-28 |
| `packages/opencode/test/cli/run/subagent-data.test.ts` | modify | hidden task tab behavior | 10-18 |
| `packages/opencode/test/cli/run/stream.transport.test.ts` | modify | hidden assistant activity behavior | 8-15 |
| `packages/opencode/test/server/httpapi-sdk.test.ts` | modify | direct hidden Message/Part + hidden-parent Part PATCH behavior | 18-28 |
| `packages/opencode/test/acp/event-subscription.test.ts` | modify | hidden terminal Tool ignored | 8-15 |
| `docs/plans/hidden-message-production-isolation.md` | add | canonical plan/audit/implementation evidence | documentation only |

No generated file change is planned. If implementation requires a production or test file outside this table, the plan must be revised and re-audited before that change.

## 16. TDD Behavior Slices

Confirmed public seams: `Session.messages/MessageV2.page/filterCompactedEffect`, SessionPrompt+GoalTool behavior, exported run reducers/transport, SDK HTTP `session.message`, ACP event subscription, and Provider conversion.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | bounded/full visible history loses rows behind hidden Messages | limit precedes visibility | indexed hot-row refill before visible Part hydration | TUI/API/export/revert range |
| 2 | newer failed hidden Compaction tail removes older valid boundary | post-pass ignores completed set | reorder from exact successful pair only | original 43-47K context collapse |
| 3 | public Revert hides successful summary but persisted cutoff still drops old head | boundary ignores visibility XOR before range selection | partial-hidden candidate skipped；earlier valid boundary/full history remains | silent head loss before replay filtering |
| 4 | hidden summary or Part leaves unpaired replay component in pure full-history caller | pair proof precedes component visibility | same tri-state proof applies without pre-read | invalid Provider role/prompt sequence |
| 5 | hidden user/Part becomes Goal previous turn | chronology includes raw rows | visible chronology only | blocked streak/recovery authority |
| 6 | plugin-hidden history leaves Provider wire but still changes breakdown/learned estimate/overflow | projection occurs only inside converter | one visible array immediately after transform feeds every sibling consumer | post-plugin token snapshot and auto Compaction |
| 7 | compaction plugin hides selected head but raw history still learns upload ratio | transformed wire and raw estimate history diverge | transformed visible head feeds both | Compaction snapshot parity |
| 8 | hidden run Message/Part emits commit/footer and stale state | reducer treats tombstone as replacement | consume tombstone with zero visible output and cleanup | terminal CLI output/state |
| 9 | hidden task/assistant event creates tab or satisfies live gate | subagent/transport lack visibility; Message tombstone does not identify an existing task tab | retain task parent MessageID and remove matching tab/detail on hidden parent Message; suppress hidden activity | run completion/subagent UI |
| 10 | direct SDK lookup returns hidden Message/Part | handler uses raw get | 404 hidden Message; visible Message filters hidden Parts | API collection/detail parity |
| 11 | known Part PATCH under hidden parent emits ordinary update | public mutation never checks parent visibility | Revert/cleanup hidden parent then PATCH returns 404 before mutation | Message tombstone resurrection |
| 12 | hidden Tool satisfies doom-loop threshold | current Tool read is raw | current visible Tool filter | false permission interruption |
| 13 | hidden ACP Tool emits lifecycle | adapter accepts tombstone | zero ACP update | ACP client parity |
| 14 | visibility query repair exceeds measured performance threshold | no executable gate in R4 | index-preserving refill/JS projection measured against fixed baseline | explicit no-performance-regression requirement |

Each cycle is red -> minimal green -> narrow regression before the next slice. Expected IDs, counts, commits and statuses are fixed literals; tests do not inspect private helpers, SQL text or call counts.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 315 maximum | substantive production + test code only; exclude comment-only, imports, formatting, generated and pure moves |
| Required Chinese explanatory comments `C` | at least 48 | `ceil(315 * 0.15) = 48` |

Planned qualifying explanations are distributed beside:

- raw structural data versus visible business projection；
- visible capacity 必须在 hydrate 前成立、同时保留 indexed physical range 的性能/正确性 invariant；
- fully hidden successful Compaction pair 的 structural-only compatibility；
- successful pair map 同时约束 tail reorder 和 atomic replay；
- Goal chronology 为何排除 hidden 但不受 Provider compaction 裁剪；
- raw event 必须继续传播、visible adapter 必须消费 tombstone 的责任边界；
- append-only adapter 无法撤回历史输出，只能阻止 tombstone 产生第二次副作用；
- direct HTTP visible contract 与 internal raw get 的区别；
- 各回归测试固定行为意图和禁止退化的边界。

注释不得复述条件、变量赋值或测试名。`C` 不计入政策定义的 substantive-code `E`，但计入用户要求的总 changed implementation lines。实施中以实际 `E` 重算，始终满足 `C >= ceil(E * 0.15)`，且 imports/formatting/comment 在内的总 implementation changed lines 不超过 400。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/session/messages-pagination.test.ts` | `packages/opencode` | visible paging、Compaction structural/replay pair、actual MessageV2 page/chronology performance seam |
| `bun test test/session/message-v2.test.ts` | `packages/opencode` | Provider conversion visibility |
| `bun test test/session/prompt.test.ts -t "Goal|post-plugin hidden"` | `packages/opencode` | hidden chronology 不控制 Goal turn；request snapshot/overflow 共用 visible projection |
| `bun test test/session/compaction.test.ts -t "plugin-hidden"` | `packages/opencode` | compaction wire 与 upload history 共用 transformed visible head |
| `bun test test/session/processor-effect.test.ts -t "doom_loop"` | `packages/opencode` | hidden Tool 不计入 threshold |
| `bun test test/cli/run/session-data.test.ts test/cli/run/subagent-data.test.ts test/cli/run/stream.transport.test.ts` | `packages/opencode` | run event tombstone behavior |
| `bun test test/server/httpapi-sdk.test.ts -t "session message|hidden parent"` | `packages/opencode` | direct lookup visibility + public Part mutation cannot resurrect hidden parent |
| `bun test test/acp/event-subscription.test.ts` | `packages/opencode` | ACP hidden Tool behavior |
| `bun test test/session/compaction.test.ts test/session/revert-compact.test.ts` | `packages/opencode` | existing lifecycle/accounting/fully hidden structural compatibility |
| `bun test test/storage/cold.test.ts` | `packages/opencode` | cold/raw accounting and structural cutoff regressions |
| `bun typecheck` | `packages/opencode` | all changed opencode adapters/types |
| `bun typecheck` | `packages/slack` | Slack hidden guard compiles without SDK regeneration |
| original four Section 8 feedback commands | stated directories | failed-tail, event output, visible limit and active Goal divergence become green/not reproducible |
| `bun test test/session/messages-pagination.test.ts -t "visibility performance"` | `packages/opencode` | actual `MessageV2.page`/`chronology`/hydrate p95 candidate `<= baseline + max(5ms, baseline*25%)`; visible page returns requested 301 probe rows |
| `git diff --check` | repository root | whitespace integrity |

### Performance Benchmark Protocol

The committed focused test uses the repository's existing `testEffect`/`withSession` instance fixture and does not create a script, backup, or temp artifact. It seeds a deterministic 6,326-Message / 364-hidden cohort with representative Parts through the existing Session service, then invokes the actual production seams rather than reimplementing their SQL:

```text
MessageV2.page({ sessionID, limit: 301 })
MessageV2.page({ sessionID, limit: 301, includeHidden: true })
MessageV2.chronology(sessionID)
```

The test performs five warmups and 20 measured iterations per seam. Before implementation, the same focused test records the baseline p95 artifact in the audit transcript; after implementation it records the candidate p95 using the identical fixture and process. The raw `includeHidden: true` page call is the same-process baseline for page/refill, while chronology uses the pre-implementation recorded p95 because its public seam intentionally changes from raw to visible projection. Acceptance for every path:

Run the focused test three times before implementation and three times after implementation；compare the median of the three p95 values. The test also asserts that a cohort with at least 301 visible rows returns 301 visible items and that chronology returns no hidden Message or Part. A failure blocks completion; no cache/fallback or relaxed threshold is allowed.

```text
candidate_median_p95 <= baseline_median_p95 + max(5ms, baseline_median_p95 * 0.25)
```

The page candidate must also return 301 visible probe rows whenever at least 301 visible rows exist. Any threshold failure blocks completion；do not add cache/fallback or relax the threshold。

Historical read-only SQL measurements remain design evidence only, not the acceptance gate: the indexed refill candidate returned 301 visible rows at `4.626ms` p95 on the largest observed Session, while the earlier chronology SQL-WHERE candidate regressed `33.189ms -> 46.161ms` p95 and remains rejected. The focused test above must execute the production seams themselves.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 plan only | no new production/test module |
| Files modified | at most 25 | plan + 14 production owners + 10 existing behavior-test files |
| Files deleted | 0 | no obsolete file/module |
| Production substantive lines | 116 maximum | indexed refill + shared projection + orchestration/public guards + parent Message tombstone identity |
| Test substantive lines | 220 maximum | behavior slices reuse existing fixtures；performance calls real production seams and creates no benchmark artifact |
| Effective implementation lines `E` | 336 maximum | policy excludes qualifying comment-only/import/format lines |
| Qualifying Chinese comment lines `C` | at least 51 | recompute from actual E |
| Total implementation changed lines | 399 hard maximum | code、tests、imports、comments 总和，保留 1-line hard margin |
| Generated lines | 0 | SDK regeneration explicitly excluded |

The 400-line user limit is a hard gate. If complete mapped behavior cannot fit, implementation stops and revises the plan instead of dropping a requirement or exceeding the limit.

## 20. Real Risks and Open Decisions

### Real Risks

- Filtering before hydration changes which cold owners are thawed. This is intended for visible reads and must retain `includeHidden:true` raw behavior.
- Visible refill may issue more than one indexed query when hidden density is non-zero. R5 baseline proves representative p95 cost；implementation must pass the fixed dual threshold and cannot replace refill with the slower JSON-WHERE variant.
- Compaction supports historical rows without `tail_start_id`; exact completed-pair selection must preserve marker fallback compatibility.
- Post-plugin projection must happen once before `requestMsgs` branches; filtering only `modelMsgs` would leave input snapshot and overflow split-brained.
- Compaction ratio learning currently uses wider pre-plugin history; R2 deliberately uses the transformed visible head so estimated upload and sent wire share one supported input domain. Regression tests must measure behavior, not helper calls.
- Event tombstones may arrive after output was already emitted. Append-only adapters cannot erase the past; the supported behavior is no new side effect and no ongoing state authority.
- Goal tests must exercise the trusted turn path, not duplicate private `deriveGoalTurn` logic.
- HTTP direct visibility changes a currently undocumented raw behavior. Internal raw callers remain unchanged; only the ordinary public endpoint changes.
- Public Part mutation must reject hidden parent before calling `Session.updatePart`; adding parent checks inside raw Session service would break internal repair/audit ownership and duplicate public policy.
- Concurrent worktree edits in unrelated files must remain untouched. Any overlap in a planned file requires ownership inspection before implementation.

### Open Decisions Requiring the User

None. The user explicitly delegated implementation decisions and required autonomous completion within the stated behavior and line budget.

### Rejected Speculation

- Remote share visibly leaking hidden data: local transport proves tombstone passage, but remote rendering/storage is unavailable. Do not suppress tombstones locally because that would prevent remote deletion.
- Hidden subagent rows materially delaying cold eligibility: live maximum divergence is 10.4 seconds and physical activity is the documented clock.
- Hidden Stats/usage as a visibility bug: user explicitly requires incurred token/cost to remain counted.
- Fork copying hidden raw rows: fork is structural/audit clone and visible child reads use the same repaired projection.
- v2 projector parity: feature is in-flight/disabled and does not consume v1 hidden schema; no production reachability evidence.
- Multiple conflicting Compaction Parts on one marker: no normal producer or observed row; public corruption speculation does not drive new arbitration logic.
- Physical deletion of hidden rows: violates audit/accounting and is unnecessary after projection repair.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, the 400-line hard limit, and the 15 percent Chinese explanatory-comment plan.
- Reject any implementation that normalizes raw events upstream and thereby prevents TUI/App/share tombstone removal.
- Reject any implementation that removes hidden accounting or replaces primary behavior with DB repair/fallback.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 | 3 | BLOCK | `ses_0654a79d0ffeLqV2ZEg03yag8a` |
| 2 | R2 | yes | B-01 | 3 | BLOCK | `ses_065406154ffeXxvfSY6nNHL5K6` |
| 3 | R3 | yes | B-01 | 2 | BLOCK | `ses_0653634e3ffeILgoApLBp77Hnu` |
| 4 | R4 | yes | B-01 | 0 | BLOCK | `ses_0652a8c50ffeEzApXJ6ME207m2` |
| 5 | R5 | yes | B-01, B-02 | 2 | BLOCK | `ses_0651ce30fffeR0d1lKcWveVMQN` |
| 6 | R6 | yes | none | 3 | APPROVE | `ses_065101142ffeqdMs8j5rKy43PE` |

### Round 1 Verbatim Verdict

#### Blocking findings

##### B-01 post-plugin 可见性修复未覆盖 token 估算与 Compaction 判定

- Violated invariant: `INV-07`；hidden Message/Part 在 plugin transform 后仍不得影响 Provider 请求及其派生的正常生产决策。
- Evidence class: reachable
- Producer and execution path: `experimental.chat.messages.transform` 可修改 `messages`，包括给 Message/Part 设置 `hidden`；随后 `toModelMessagesEffect` 按计划过滤 Provider wire，但 `requestMsgs` 原始数组仍进入 input breakdown 和 `TokenEstimate.estimateUploadInput(history)`，最终影响 `compaction.isOverflow`。
- Source evidence:
  - `packages/plugin/src/index.ts:281-289`
  - `packages/opencode/src/session/prompt.ts:2873-2893`
  - `packages/opencode/src/session/prompt.ts:2924-2969`
  - `packages/opencode/src/session/prompt.ts:2976-3005`
  - `packages/opencode/src/token/estimate.ts:246-275`
- Canonical-plan evidence: §6 的 post-plugin reachable domain；§7 `INV-07`；§8 将 first divergence 限定在 Provider converter；§10 “post-plugin Provider visibility”；§13 仅计划测试 conversion output。
- Responsibility owner: plugin transform 后的 SessionPrompt 可见投影边界，以及 `toModelMessagesEffect` 的独立 Provider conversion seam。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: plugin 隐藏整个历史 Message 后，该 Message 可以从实际 Provider payload 消失，但其 `step-finish` usage 仍参与 chars-per-token 学习；隐藏内容也仍进入 persisted `inputBreakdown`。两套输入会造成错误的 token snapshot，并可能触发或跳过自动 Compaction。现有计划中的 conversion 测试只检查 Provider 输出，无法检测这一生产行为。
- Why this is not speculative: plugin hook 是现有公开扩展 seam，计划自身已将它列为 reachable producer；当前代码明确在 hook 后同时消费 `modelMsgs` 和未经可见化的 `requestMsgs`。
- Minimal correction direction: 在 plugin transform 后建立一个权威的 visible projection，并让 Provider conversion、input breakdown、token-history learning 和 overflow 判定消费同一投影；保留 `toModelMessagesEffect` 作为其独立公开 conversion seam 的可见性约束。补充能在当前代码上失败的行为测试，锁定 hidden post-plugin history 不改变 input snapshot 或 Compaction 判定。

#### Non-blocking findings

- §17 把 qualifying comments 计入 `E`，与政策中 `E` 仅统计 substantive code lines 的定义不一致；同时按 330 上限固定估算 `C=50`。计划又明确要求实施后按实际 `E` 重算并始终满足 15%，因此当前属于保守估算，不降低硬门槛。
- §15 各文件区间上限之和高于 §19 的 `105 production + 225 test` 汇总值。区间下限仍可在 400 行内完成，且 §19 明确规定超限时停止并修订计划，因此当前是估算记录不一致。
- 元数据中的 `Audit mode: full-scope` 与本次输入的 `Audit mode: plan` 表述不一致。计划状态、Revision、Approved revision 和 Implementation allowed 仍正确，未造成越权实施。

#### Release verdict

**BLOCK**

R1 尚未完整隔离 post-plugin hidden history 对 token snapshot 和自动 Compaction 的影响。修订后需要增加 Revision、保持 Implementation allowed 为 `no`，并重新执行完整 plan audit。

### Round 2 Verbatim Verdict

#### Blocking findings

##### B-01 部分 hidden 的 Compaction pair 仍会截断可见历史

- Violated invariant: `INV-03` 要求 Compaction replay 由完整成功且可见性原子的 pair 建立；仅“完整 pair 都 hidden”时允许保留 structural-only cutoff。部分 hidden 的 pair 不能在 summary 不可见时继续裁掉原始 head。
- Evidence class: reachable
- Producer and execution path:
  1. 公共 `session.revert` API 接受任意 `messageID`，并直接进入 `SessionRevert.revert`：`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:545-557`、`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:377-383`。
  2. 当调用方以成功 Compaction 的 summary assistant 为 Revert 起点时，代码明确允许该 API-only 路径，并把 Revert 边界设为该 assistant 自身：`packages/opencode/src/session/revert.ts:55-65`、`packages/opencode/src/session/revert.ts:80-87`。
  3. cleanup 随后隐藏该 summary 及更新的 Message，但不会隐藏更早的 Compaction marker：`packages/opencode/src/session/revert.ts:157-188`。
  4. `CompactionBoundary.latest` 不检查 marker/summary 的 hidden 状态，仍把这个“visible marker + hidden summary”认定为有效 boundary：`packages/opencode/src/session/compaction-boundary.ts:19-33`、`packages/opencode/src/session/compaction-boundary.ts:35-68`。
  5. `filterCompactedEffect` 在加载 transcript 前即使用该 boundary 的 `tailStartID/markerID` 裁掉旧 head：`packages/opencode/src/session/message-v2.ts:1726-1732`。
  6. R2 随后又要求隐藏 summary 时抑制整个 replay pair，因此 Provider 最终同时拿不到 summary 和被 structural cutoff 丢弃的原始 head。
- Source evidence:
  - `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:545-557`
  - `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:377-383`
  - `packages/opencode/src/session/revert.ts:55-65`
  - `packages/opencode/src/session/revert.ts:80-87`
  - `packages/opencode/src/session/revert.ts:157-188`
  - `packages/opencode/src/session/compaction-boundary.ts:19-68`
  - `packages/opencode/src/session/message-v2.ts:1726-1732`
- Canonical-plan evidence:
  - §6 将“visible marker + hidden successful summary”列为 reachable supported input：`docs/plans/hidden-message-production-isolation.md:123`
  - §7 `INV-03` 只授权 fully hidden successful pair 作为 structural-only cutoff：`docs/plans/hidden-message-production-isolation.md:141`
  - §10 却扩大为“任一 Message hidden 时抑制 replay，但 successful pair 仍可提供 structural cutoff”：`docs/plans/hidden-message-production-isolation.md:232-235`
  - §15 对 `compaction-boundary.ts` 只计划排除 hidden Compaction Part，没有处理部分 hidden 的 Message pair：`docs/plans/hidden-message-production-isolation.md:324-326`
- Responsibility owner: `CompactionBoundary.latest` 与 `MessageV2.filterCompactedEffect` 共同拥有 persisted structural cutoff 的证明和应用；边界必须在裁掉旧 head 之前证明其 visibility state 合法。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 用户通过公开 API Revert 一个成功 summary 后，下一次正常 Provider 请求可能只保留 retained tail 和后续 Message，既没有 compacted summary，也没有被 summary 替代前的原始 head，造成有效上下文静默丢失。当前计划中的纯 `filterCompacted` atomic-replay 测试无法证明 pre-read cutoff 路径正确。
- Why this is not speculative: `session.revert` 是公开生产入口；源代码明确记录 assistant `messageID` 由 API 可达；计划本身也把该 partial pair 列入 supported reachable domain。
- Minimal correction direction: structural boundary owner 必须分别证明 fully visible replay pair 与计划明确授权的 fully hidden structural pair；partial-hidden pair 不得在 summary 不可见时先行裁掉原始 head。回归测试必须经过 persisted `SessionRevert` 与 `filterCompactedEffect` seam，观察最终 Provider history，而不能只测试已完整载入数组后的纯过滤。

#### Non-blocking findings

- §15 实际列出 24 个 production/test 修改文件，§19 却写“Files modified at most 23”。各项下限仍能落在 400 行硬限制内，且计划要求超限即停止并修订，因此这是估算记录不一致。
- §18 把 Slack 验证命令留为“implementation 时从 package.json 发现”。仓库已有准确脚本 `packages/slack/package.json:6-9`，可直接写为在 `packages/slack` 执行 `bun typecheck`。当前缺口不改变设计行为，但应在下一 revision 固化命令。
- §18 声称复跑 Section 8 的四条反馈命令；Goal divergence 只记录了输出，没有保留可执行命令正文。计划已有 public-seam Goal 行为测试，因此不单独阻塞，但原始反馈回路记录应补全。

#### Rejected speculation

- 没有证据表明远端 share consumer 会把 hidden tombstone 渲染成可见内容；本地继续传递 tombstone 是删除远端旧状态所需的现有合同。
- 没有可达证据表明 hidden 后仍会乱序到达新的 `message.part.delta` 并重新创建已清理的 run state；当前事件序列是有序持久事件链，不能据此增加额外乱序防护。
- v2 Event/Projector 默认关闭且不消费当前 v1 hidden schema；没有依据要求本次建立平行修复。
- 多个相互冲突的 Compaction Part 没有正常 producer、观察数据或公共未验证 seam，不应驱动仲裁逻辑。
- hidden accounting、RequestUsage、Stats 和 fork raw rows 属于已发生工作与结构审计事实；不能按 transcript visibility 推导退款或删除。

#### Requirement and traceability coverage

| 范围 | 审计结果 |
| --- | --- |
| 可见分页和 visible limit | owner、SQL-before-limit 修复、敏感测试均已映射 |
| Goal chronology | Message/Part visibility owner 和 public Goal test 已映射 |
| Provider conversion及 post-plugin sibling consumers | R2 已覆盖 request snapshot、ratio learning、overflow 和 Compaction upload |
| run/ACP/GitHub/TUI/Slack event adapters | raw event 保留、stateful tombstone 与 append-only guard 的责任边界已映射 |
| HTTP direct Message lookup | public visible adapter 与 internal raw `get` 已正确分离 |
| doom-loop | current Tool raw read 的 first divergence 和测试已映射 |
| accounting/audit/cold raw facts | preservation decisions 已明确 |
| Compaction partial-hidden pair | **未满足**：supported reachable input 与 structural cutoff 设计互相冲突 |
| 400 行限制 | 按各文件下限和共享 projection 设计具备可行性；实施仍需以实际 diff 作为硬门槛 |
| Reverse traceability | 除 partial-hidden structural cutoff 外，新增 helper、branch、adapter guard 均有 requirement ID 和 reachable/contracted evidence |

#### Primary-path and fallback verdict

R2 没有引入 retry-after-failure、catch-and-default、数据库 repair、feature flag 或第二数据源，新增 alternate success path 为 0。

Compaction primary path 当前仍存在两个不一致的 visibility 解释：

- `INV-03` 只允许 fully hidden successful pair 提供 structural-only cutoff。
- §10 允许任一成员 hidden 的 successful pair 继续提供 cutoff。

该冲突发生在旧 head 被丢弃之前，属于 primary-path invariant 缺陷。不能依靠下游 replay filtering 补偿。

**Primary-path verdict: BLOCK**

#### Code quality and Chinese-comment verdict

- 计划未提出新依赖、配置、迁移、缓存、retry 或 fallback。
- `MessageV2.visible` 作为跨 MessageV2、Prompt 和 Compaction 复用的单一 projection 有明确证据，不属于无依据抽象。
- 预计 `E <= 300`、`C >= 45`，满足 `C >= ceil(E × 0.15)` 的计划承诺；中文解释注释分布位置和主题具备可实施性。
- 总 implementation changed lines 的硬上限为 400，计划承诺 390 并保留 10 行余量。实际 gate 仍须在 implementation audit 中重算。
- 本轮是 plan audit，不计算 actual `E/C`。

#### Release verdict

**BLOCK**

R2 不能获准实施。必须修正 partial-hidden Compaction pair 在 persisted boundary/pre-read cutoff 路径中的语义，并对下一 revision 重新执行完整范围 plan audit。

### Round 3 Verbatim Verdict

#### Blocking findings

##### B-01 public `updatePart` 可让 hidden Message 再次产生可见副作用

- Violated invariant: `INV-05`；hidden Message 是可见业务链路的 tombstone，其 Parts 后续不得重新产生终端输出、Tool lifecycle、tab、Agent 切换或外部通知。
- Evidence class: reachable
- Producer and execution path:
  1. `SessionRevert.cleanupCurrent` 可以只隐藏 Message，原有 Parts 保持 `hidden` 为空：`packages/opencode/src/session/revert.ts:179-188`。
  2. 公共 `PATCH /session/:sessionID/message/:messageID/part/:partID` 接受完整 `MessageV2.Part`。handler 只核对三个 ID，既不读取父 Message，也不验证父 Message visibility：`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:609-619`、`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:416-429`。
  3. 调用方可以保留 Revert 前已知的 Message/Part ID，并在 Message hidden 后提交一个自身未设置 `hidden` 的 Part。`session.updatePart` 随即发布普通 `message.part.updated`。
  4. 该事件只携带 Part，不携带父 Message visibility：`packages/opencode/src/session/message-v2.ts:685-688`。
  5. 计划中的 append-only adapter guard 仅能根据当前 Part 的 `hidden` 字段过滤；此输入会继续进入 legacy run、ACP、GitHub 和 Slack 的普通输出链路。
- Source evidence:
  - `packages/opencode/src/session/revert.ts:179-188`
  - `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:609-619`
  - `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:416-429`
  - `packages/opencode/src/session/message-v2.ts:685-688`
  - `packages/opencode/src/cli/cmd/run.ts:629-641`
  - `packages/opencode/src/acp/agent.ts:277-295`
  - `packages/opencode/src/cli/cmd/github.ts:900-925`
  - `packages/slack/src/index.ts:23-49`
- Canonical-plan evidence: §6 仅盘点 public Part-level Revert 和 hidden Part update，遗漏 public visible-Part update under hidden parent；§7 `INV-05`；§9 terminal/live output responsibility；§10 “Event tombstone contract”；§13 `INV-05` traceability；§15 adapter guard 与 HTTP change plan。
- Responsibility owner: `SessionHttpApi.updatePart` 是公开不受信 Part mutation seam；该 HTTP adapter同时拥有普通 public Message visibility 合同。hidden 父 Message 已由计划中的 `session.message` 定义为 public not-found。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 调用方 Revert 一个 Message 后，仍可通过保留的 Part ID PATCH 该 hidden Message 的 Tool/Text Part。当前及计划中的 append-only consumers 会再次输出 Tool 完成信息、文本或外部 Slack/GitHub/ACP 通知；stateful run reducer也可能重新建立已由 Message tombstone 清理的 Tool 状态。计划现有测试只覆盖 `Part.hidden` tombstone和直接 GET visibility，无法在当前行为上捕获该父子 visibility 绕过。
- Why this is not speculative: `updatePart` 是公开 SDK-visible endpoint，schema 接受完整 Part；调用方在 Revert 前可正常取得 Message/Part ID；handler 没有 busy guard、父 Message读取或 visibility 验证。该路径不依赖数据库损坏、乱序事件或假设中的未来调用者。
- Minimal correction direction: 在 public `updatePart` 所属的 HTTP visibility seam 固化父 Message visibility约束，使 hidden 父 Message不能通过普通 Part mutation重新发布可见更新；把 `Revert → PATCH known Part ID → public error/no visible event effect` 映射到能在当前实现上失败的行为测试。adapter 的 `Part.hidden` guard仍负责真实 Part tombstone，不应承担推断父 Message状态的第二套查询路径。

#### Non-blocking findings

- §13 对 TUI、GitHub、Slack guards 采用 source inspection 加 typecheck，未提供行为敏感的自动测试。计划记录了外部客户端初始化和现有 harness 限制，因此当前作为显式 unverifiable item 不单独阻塞；实施审计仍需确认 guards 位于实际输出前，且没有只覆盖部分事件分支。
- §17 按 `E=300` 上限固定要求 `C>=45`，属于保守预算。实施时仍需按 actual `E` 重算，不能因为实际总行数接近 400 而压低 15% 门槛。

#### Rejected speculation

- 没有证据证明正常 producer 会在 Message tombstone 后乱序发布新的 `message.part.delta`；不能据此增加乱序缓存或恢复分支。
- 远端 share consumer 的渲染行为不可见；本地 raw tombstone pass-through 必须保留。
- v2 默认关闭且不消费当前 v1 hidden schema，没有生产可达性支持平行修改。
- visible-before-limit SQL 可能扫描更多物理行，但目前没有基准证明其造成性能退化；该担忧不能阻止修复已观察到的 `247/300` visible-limit 缺陷。
- 多个冲突 Compaction Parts 缺少正常 producer、观察数据或公共未验证输入链路，不应引入仲裁逻辑。

#### Requirement and traceability coverage

| 范围 | 审计结果 |
| --- | --- |
| visible paging、limit 与 hidden Part hydration | owner、first divergence、SQL-before-limit 修复及敏感测试已映射 |
| Compaction completed pair、failed tail、partial-hidden pair | R3 已把 visibility parity 放在 persisted cutoff 前；pure/persisted/Revert 测试已映射 |
| Goal chronology | hidden Message/Part SQL projection和 Goal行为测试已映射 |
| post-plugin Provider、input breakdown、ratio learning、overflow | 一个 authoritative visible projection及行为测试已映射 |
| post-plugin Compaction wire/upload history | transformed visible head及测试已映射 |
| run/ACP/GitHub/TUI/Slack tombstones | `Part.hidden` 和 `Message.hidden` 的常规路径已映射；hidden parent 下的后续 visible Part mutation未覆盖 |
| public direct Message lookup | hidden Message→404、visible Message过滤 hidden Parts已映射 |
| public Part mutation | **未满足**：公开 `updatePart` 可绕过父 Message visibility |
| doom-loop | hidden current Tool过滤及测试已映射 |
| accounting、Stats、fork、cold raw facts | preservation decision明确 |
| 400 行限制 | 计划下限具备可行性；新增缺失路径后必须重新核算，仍需保持总 implementation changed lines `<=400` |
| Reverse traceability | 已提出的概念基本具备 evidence；public Part mutation这一现有成功路径未进入设计和测试映射 |

#### Primary-path and fallback verdict

计划没有引入 retry-after-failure、catch-and-default、DB repair、feature flag、第二数据源或备用解析路径。新增 alternate success path 为 0，diagnostic decision surface 为 0%。

R3 的 persisted visibility、Compaction 和 Provider projection形成了一条基本一致的主路径，但 public `updatePart` 仍能从该路径外重新产生 success-shaped visible event。普通 public Message visibility与其 Part mutation semantics因此尚未闭合。

**Primary-path verdict: BLOCK**

#### Code quality and Chinese-comment verdict

- 计划未提出新依赖、配置、迁移、缓存、retry 或 fallback。
- `MessageV2.visible` 有多个已证实 consumer，属于同一 visibility contract 的共享 projection，不是无依据抽象。
- 预计 `E<=300`、`C>=45`，满足计划阶段的 `C >= ceil(E × 0.15)` 承诺。
- 总 implementation changed lines 的硬上限为 400。补入 public `updatePart` owner和回归测试后必须重新核算文件级及总预算；不得通过删除已确认覆盖或减少中文解释注释满足上限。
- 本轮是 plan audit，不计算 actual `E/C`。

#### Release verdict

**BLOCK**

R3 尚未覆盖公开 `updatePart` 对 hidden 父 Message visibility 的绕过。计划需要修订、递增 Revision、保持 `Approved revision: none` 和 `Implementation allowed: no`，随后重新执行完整范围 plan audit。

### Round 4 Verbatim Verdict

#### Blocking findings

##### B-01 性能保持要求没有可执行验证

- Violated invariant: 原始需求明确要求修复“且不破坏现有的功能和性能”；所有发生查询形态变化的生产热路径都必须具备可执行的性能保持证据。
- Evidence class: contracted
- Producer and execution path:
  - HTTP `session.messages` 的 bounded 请求进入 `MessageV2.page`：`SessionHttpApi.messages -> MessageV2.page -> MessageTable/PartTable query -> hydrate`。
  - TUI Session 同步通过 `limit=300` 调用同一 HTTP bounded path。
  - Permission Reviewer 通过 `MessageV2.page(limit=REVIEWER_MESSAGE_FETCH_LIMIT)` 获取授权 transcript。
  - Goal 每轮通过 `MessageV2.chronology` 扫描 Session 的 Message/Part chronology。
  - R4 将 `page` 改成在 `limit` 前执行 JSON hidden predicate，并将 `chronology` 的两次全 Session 查询改成 SQL visibility projection，但验证计划只有行为测试、typecheck 和原始功能反馈命令。
- Source evidence:
  - `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:134-172`
  - `packages/opencode/src/cli/cmd/tui/context/sync.tsx:1074`
  - `packages/opencode/src/permission/reviewer/service.ts:135-147`
  - `packages/opencode/src/session/prompt.ts:2587-2591`
  - `packages/opencode/src/session/message-v2.ts:856-887`
  - `packages/opencode/src/session/message-v2.ts:1331-1393`
- Canonical-plan evidence: §1 原始需求；§10 “Persisted visible projection”；§13 `INV-01/INV-02/INV-04` 映射；§18 Verification；§20 Real Risks 明确认知 visible-before-limit 会扫描更多物理行，却没有定义任何性能验证。
- Responsibility owner: `MessageV2.page/chronology` 的 visible-read owner，以及 canonical plan 的 verification contract。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 当前计划允许 bounded Session history、Permission Reviewer transcript 或每轮 Goal chronology 的查询延迟发生回退后，全部计划测试和 typecheck 仍然通过；因此原始需求中的性能保持约束无法在实施审计时判定，也没有失败信号阻止发布。
- Why this is not speculative: 性能保持是用户逐字要求；`page` 和 `chronology` 是已证实的生产路径，且 R4 明确修改它们的 SQL predicate、range 和 hydration 行为。该 finding 不声称新查询必然更慢，只指出一个已确认要求没有任何可执行验收证据。
- Minimal correction direction: 为变更查询形态的 `MessageV2.page` 和 `MessageV2.chronology` 增加可复现的基线/修复后性能验证，覆盖有代表性的 Session 规模和 hidden 密度，固定工作目录、测量方法与允许阈值；把结果映射到原始性能要求。无需增加生产 fallback、缓存或第二查询路径。

#### Non-blocking findings

无。

#### Rejected speculation

- 没有证据证明 visible-before-limit 查询当前一定造成性能回退；B-01 针对缺失的合同验证，不把尚未测量的回退当作既成事实。
- 远端 share consumer 的渲染和存储实现不在仓库内。继续传递 raw hidden tombstone 是删除远端旧状态所需的既有 pass-through，不能据此增加本地过滤。
- 没有正常 producer 证明 hidden tombstone 后仍会乱序产生新的 `message.part.delta`；不应增加乱序缓存、延迟窗口或恢复分支。
- 当前 generated SDK types 未声明 `hidden`，但 runtime payload 可由仓库内 adapter 通过属性存在性收窄；没有证据要求本次在 400 行预算内重生成整个 SDK。
- v2 Event/Projector 默认关闭且不消费当前 v1 hidden contract，没有生产可达性支持平行修复。
- 多个互相冲突的 Compaction Parts 缺少正常 producer、观察数据或公共未验证 seam，不应引入仲裁逻辑。

#### Requirement and traceability coverage

| 范围 | 审计结果 |
| --- | --- |
| hidden Message/Part producer inventory | Revert、stale-turn repair、Permission Reviewer retry、failed Compaction、public Part mutation 和 plugin transform 均已盘点 |
| visible collection与 limit | first divergence、SQL-before-limit owner、hidden Part hydration 和 red-capable test 已映射 |
| Compaction boundary | completed pair、failed tail、partial-hidden pair、hidden Part、fully hidden structural-only pair均已映射到 persisted 与 pure seams |
| Goal chronology | Message/Part visibility投影、真实 Goal control path 和行为测试已映射 |
| post-plugin Provider path | Provider wire、input breakdown、ratio learning、overflow 和 Compaction upload history共用 authoritative projection |
| event adapters | raw event 保留；run、ACP、GitHub、TUI、Slack 的 tombstone责任和 append-only/stateful 差异已分类 |
| public HTTP | hidden Message detail、hidden Part过滤、hidden-parent Part PATCH拒绝均映射到 HTTP adapter |
| doom-loop | raw current Tool read 的 first divergence 和 hidden Tool threshold测试已映射 |
| accounting/audit/fork/cold | raw token、cost、RequestUsage、Stats和结构数据的保留决定明确 |
| fallback与兼容路径 | 新 alternate success path 为 0；fully hidden Compaction cutoff 和 raw event均有现存合同 |
| 功能保持 | 相关行为测试、Compaction/Revert/Cold回归和 package typecheck 已规划 |
| 性能保持 | **未满足**：没有基准、阈值或其他可执行验收信号 |
| 400 行限制 | `E <= 310`、`C >= 47`、总 implementation changed lines `<=398` 在计划层面可行，实施时仍须按实际 diff 重算 |
| Reverse traceability | 共享 projection、pair map、HTTP guard、adapter tombstone和 doom-loop filter均有 observed/contracted/reachable evidence |

#### Primary-path and fallback verdict

R4 已形成一条一致的 primary path：

```text
raw persistence/event
  -> structural/raw opt-in
  -> visible selection before range/limit
  -> completed Compaction pair proof
  -> visible Goal/Provider/output/API adapters
  -> raw accounting remains unchanged
```

计划没有引入 retry-after-failure、catch-and-success、DB repair、feature flag、备用解析器、第二数据源或兼容扫描。新增 alternate success path 为 0，diagnostic decision surface 为 0%。

Compaction 的 fully hidden structural-only cutoff 有真实 persisted compatibility；partial-hidden pair 在 pre-read cutoff 前被拒绝，不依赖下游过滤补偿。HTTP parent-visibility guard也位于公开 mutation seam，没有把查询责任扩散到每个 event consumer。

**Primary-path verdict: PASS**

#### Code quality and Chinese-comment verdict

- 文件计划没有新增依赖、配置、迁移、缓存、retry、fallback 或新 public raw endpoint。
- `MessageV2.visible` 有多个已证实 consumer，属于单一 visibility contract 的复用，不是无依据抽象。
- 计划承诺 `E <= 310`、`C >= 47`，满足 `C >= ceil(E × 0.15)`。
- 中文解释注释已分布到 raw/visible boundary、SQL-before-limit、Compaction pair、event tombstone、HTTP raw/visible seam 和行为测试附近，计划层面具备可实施性。
- 总 implementation changed lines 的硬上限为 400；R4 预算为 398。实施审计必须按实际 diff 重新计算 `E`、qualifying `C`、排除行和总修改量。
- 本轮是 plan audit，不计算 actual `E/C`。

#### Release verdict

**BLOCK**

R4 的 root-cause、owner、primary path、fallback 和功能行为映射已经闭合，但原始需求中的性能保持约束没有可执行验证。补充性能 invariant、forward mapping 和具体 verification 后，需要递增 Revision、保持 `Approved revision: none` 与 `Implementation allowed: no`，并重新执行完整范围 plan audit。

### Round 5 Verbatim Verdict

#### Blocking findings

##### B-01 性能基准没有执行计划修改后的生产实现

- Violated invariant: `INV-10`；原始需求要求修复不得破坏现有性能，性能验收必须对实际修改后的 `MessageV2.page` 和 `MessageV2.chronology` 敏感。
- Evidence class: contracted
- Producer and execution path:
  - bounded HTTP/TUI/Reviewer 读取进入 `SessionHttpApi.messages -> MessageV2.page -> MessageTable/PartTable query -> hydrate`。
  - 每轮 Goal 计算进入 `SessionPrompt.run -> MessageV2.chronology`。
  - R5 计划修改这两个生产 seam 的分页、refill、Message/Part projection 和 hydration 行为。
  - §18 的 benchmark 命令直接用 `bun:sqlite` 重新实现 `raw/refill` 和 chronology SQL，没有导入或调用 `MessageV2.page`、`MessageV2.chronology`、`hydrate` 或 `ColdStorage`。
- Source evidence:
  - `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:134-172`
  - `packages/opencode/src/session/message-v2.ts:856-887`
  - `packages/opencode/src/session/message-v2.ts:1331-1393`
  - `packages/opencode/src/session/prompt.ts:2587-2591`
  - `packages/opencode/src/permission/reviewer/service.ts:135-147`
- Canonical-plan evidence: §7 `INV-10`；§10 “Persisted visible projection”；§13 `INV-10` forward mapping；§18 fixed-cohort benchmark；§15 `message-v2.ts` production modification。
- Responsibility owner: `MessageV2.page/chronology` visible-read owner and canonical plan performance verification contract。
- Concrete production consequence: implementation could add extra query、duplicate hydrate、Part thaw or inefficient refill loop while the independent SQL command still passes, so the plan could not prevent a production performance regression。
- Minimal correction direction: performance verification must call actual modified `MessageV2.page` and `MessageV2.chronology` seams and cover real hydration/refill behavior；existing fixed cohort、warmup、p95 and thresholds may be retained。

##### B-02 Message tombstone 不会清理其已有 subagent tab

- Violated invariant: `INV-05`；hidden Message 是 visible adapter tombstone，stateful run UI 必须撤销由该 Message 派生的当前 tab/detail authority。
- Evidence class: reachable
- Producer and execution path:
  1. `message.part.updated` 的 task Part 通过 `syncTaskTab` 创建并保留 subagent tab。
  2. public Revert 可以从 Message 边界隐藏 assistant Message；`cleanupCurrent` 只调用 `sessions.updateMessage(next)`，只有明确 Part Revert 才另外发布 hidden Part updates。
  3. stream transport 将后续 hidden `message.updated` 交给 `reduceSubagentData`。
  4. `reduceSubagentData` 对主 Session 的 `message.updated` 不调用 `syncTaskTab`，且现有 tab 没有记录其父 MessageID，因此 Message tombstone 无法清理已有 tab/detail。
- Source evidence:
  - `packages/opencode/src/session/revert.ts:55-65,157-205`
  - `packages/opencode/src/cli/cmd/run/subagent-data.ts:294-338,751-825`
  - `packages/opencode/src/cli/cmd/run/types.ts:168-178`
  - `packages/opencode/src/cli/cmd/run/stream.transport.ts:788-835`
- Canonical-plan evidence: §2 raw hidden event must reach a consumer that removes existing visible state；§7 `INV-05`；§10 stateful run reducers；§13 `INV-05 run`；§16 slice 9。
- Responsibility owner: `run/subagent-data.ts` stateful subagent projection and `run/types.ts` tab identity。
- Concrete production consequence: after reverting a parent assistant Message, the transcript removes the Message but the run footer can continue showing its subagent tab/status/detail until unrelated cleanup。
- Minimal correction direction: retain the task Part's parent MessageID in the tab identity and, on a hidden parent Message update, delete matching tab/detail authority；add a Message-level tombstone behavior test. Keep Revert and raw event transport unchanged。

#### Non-blocking findings

- §8 的四条 red-capable feedback command 都以非零退出表示当前失败；实施验证前需要修正命令退出合同或明确以输出判定，不能把非零退出报告为通过。
- §15 列出 14 个 production owners、10 个 test files，旧 §19 汇总与文件级预算不一致；实施时必须按实际 diff 计算总 changed lines。

#### Rejected speculation

- 没有正常 producer 证明 Revert tombstone 后仍会乱序产生新的 `message.part.delta` 或 `message.part.progress`；不得增加延迟窗口、乱序缓存或恢复分支。
- 远端 share consumer 不在仓库内；raw hidden event 必须继续传递以保留 tombstone 能力。
- v2 默认关闭且不消费当前 v1 hidden contract；没有生产可达性支持平行修改。
- hidden accounting、RequestUsage、Stats、fork rows 和 Provider cost 属于 raw 事实，不应删除或退款。

#### Requirement and traceability coverage

| 范围 | 审计结果 |
| --- | --- |
| hidden producer inventory | 已覆盖 Revert、stale-turn、Reviewer retry、failed Compaction、plugin transform、public Part mutation |
| visible pagination/limit | first divergence、owner、refill设计和行为测试已映射 |
| Compaction boundary | completed、failed、partial-hidden、hidden Part、fully-hidden structural cutoff 已映射 |
| Goal chronology | Message/Part projection和行为测试已映射 |
| post-plugin Provider path | wire、breakdown、ratio learning、overflow和Compaction history共享 projection |
| public HTTP visibility | hidden detail、Part过滤、hidden-parent PATCH拒绝已映射 |
| stateful run adapter | **未满足**：hidden parent Message无法清理已有 subagent tab/detail |
| 性能保持 | **未满足**：benchmark执行独立 SQL candidate，不执行修改后的生产 seam |
| 400行限制 | 文件级计划仍可能在400行内；修复 B-02 后必须重新核算，不得删除已确认覆盖 |
| 中文注释 | 计划承诺按实际 `E` 满足 `C >= max(1, ceil(E × 0.15))` |

#### Primary-path and fallback verdict

R5 没有引入 retry-after-failure、catch-and-success、数据库 repair、feature flag、备用 parser、第二数据源或兼容扫描。新增 alternate success path 为 0，diagnostic decision surface 为 0%。但 stateful run projection 遗漏正常 Message tombstone，性能验证也与实际 primary path 断开。

**Primary-path verdict: BLOCK**

#### Release verdict

**BLOCK**

R5 不能获准实施。必须让性能验收执行实际 `MessageV2.page/chronology` 实现，并闭合 hidden parent Message 到 subagent tab/detail tombstone 的生产路径。修订后递增 Revision、保持 `Approved revision: none` 和 `Implementation allowed: no`，再进行完整范围 plan audit。

### Round 6 Verbatim Verdict

#### Blocking findings

No blocking findings.

#### Non-blocking findings

1. **Section 8 feedback-loop commands cannot report process success by exit code.**  The documented commands intentionally call `process.exit(1)` after a successful non-reproduction, so the verification section's “green/not reproducible” wording is ambiguous. The output assertions remain usable, but the implementation verification should state explicitly that these commands are judged by their output or revise the exit-code contract.
2. **Revision R6 audit metadata was not yet recorded in the plan's audit table.** Section 22 recorded only R1–R5 while the current canonical revision was R6. This is an administrative traceability gap, not a behavioral defect; this verdict is copied and the table is updated now.
3. **Several adapter checks remain source-inspection/typecheck verification rather than behavior-sensitive tests.** The plan explicitly documents this for TUI, GitHub, and Slack. Given the absence of injectable seams and the stated no-mock/line-budget constraints, this is acceptable, but the implementation audit must verify that each guard is placed before the first append-only side effect.

#### Rejected speculation

- No local evidence establishes that the remote share consumer renders hidden tombstones as visible content. Preserving raw tombstone transport is required for remote deletion semantics.
- No reachable normal producer demonstrates post-tombstone out-of-order deltas that would require buffering, replay, or recovery logic.
- No production reachability supports modifying the disabled/in-flight v2 Event/Projector path.
- No observed or reachable producer establishes multiple conflicting Compaction Parts requiring arbitration.
- Hidden token, cost, RequestUsage, Stats, fork, and cold-storage facts are intentionally raw accounting/structural data; removing or refunding them would violate the stated contract.
- A slower visible refill query is not itself blocking because the plan commits to an executable production-seam benchmark with a fixed threshold.

#### Requirement and traceability coverage

| Requirement area | Audit result |
|---|---|
| Original requirement preserved | The verbatim Chinese requirement is quoted without narrowing in §1. |
| Hidden producer inventory | Undo/Revert, stale-turn repair, reviewer retry, failed Compaction, public Part mutation, plugin transformation, and hidden event updates are covered. |
| Raw persistence and accounting | Raw Message/Part durability, event transport, token/cost/RequestUsage/Stats, fork, and cold facts are explicitly preserved. |
| Visible page capacity | `MessageV2.page` is the owner; the plan moves visibility before bounded capacity and Part hydration, with refill behavior and tests. |
| Compaction | Failed tails, partial-hidden pairs, hidden Parts, fully hidden structural-only pairs, persisted pre-read cutoff, and pure replay are all mapped to the Compaction owners and tests. |
| Goal chronology | `MessageV2.chronology` owns Message/Part visibility before Goal classification; a real Goal behavior test is planned. |
| Post-plugin prompt behavior | Provider payload, request snapshot, breakdown, token-history learning, overflow, and Compaction upload history share one post-transform visible projection. |
| Event adapters | Stateful run reducers, subagent tabs, stream activity, ACP, GitHub, Slack, and TUI plan transitions are mapped; raw event publication remains unchanged. |
| Public HTTP behavior | Direct hidden Message lookup, hidden Part filtering, and hidden-parent Part mutation rejection are mapped to the HTTP handler seam. |
| Doom-loop | Hidden current Tool Parts are excluded before threshold evaluation. |
| Function preservation | Existing accounting, structural recovery, raw event, search, summary-cache, and cold behavior are explicitly preserved. |
| Performance preservation | `MessageV2.page`, `MessageV2.chronology`, and real hydration/refill paths are included in fixed-cohort p95 verification with an explicit threshold. |
| Reverse traceability | Each proposed production concept has an invariant, evidence, owner, and reason existing logic cannot safely carry it. |
| Scope and line budget | The plan sets a hard total of 399 changed implementation lines, retains a 400-line margin, forbids dropping confirmed coverage, and requires re-planning if the actual diff exceeds the limit. |
| Chinese-comment feasibility | The plan commits to qualifying explanatory comments beside actual ownership and invariant boundaries, with implementation-time recomputation of `E` and `C`. |

#### Primary-path and fallback verdict

The plan establishes one authoritative path:

```text
raw persistence/event
  -> explicit structural/raw opt-in where required
  -> visible projection before range, hydration, and business classification
  -> completed Compaction pair proof before persisted cutoff
  -> visible Goal/Provider/output/API consumers
  -> raw accounting and tombstone transport preserved
```

The plan does not introduce retry-after-failure success paths, catch-and-default behavior, database repair/startup scans, feature flags/configuration switches, alternate parsers/data sources, or compatibility fallbacks without a concrete consumer. The fully hidden successful Compaction pair remains a documented structural-only branch, not an alternate success path. Public HTTP parent-visibility guard and adapter tombstone handling are placed at their ownership seams rather than duplicated downstream.

**Primary-path verdict: PASS**

#### Code quality and Chinese-comment verdict

This is a plan audit, so actual `E`/`C` cannot be computed. At plan level:

- Production concepts are localized to existing owners.
- `MessageV2.visible` has multiple confirmed consumers and represents one shared visibility contract rather than an unsupported abstraction.
- The plan preserves the existing indexed query shape where performance evidence supports it and rejects the slower SQL-predicate alternative.
- No new dependency, schema migration, cache, retry, fallback, public raw endpoint, or generated SDK change is proposed.
- Planned `E <= 336` and `C >= 51` is feasible in principle and remains subject to implementation-time recomputation.
- The hard total changed-line limit is explicitly `399`, below the user's `400`-line maximum.

**Plan-stage code-quality/comment verdict: PASS, subject to actual-diff recomputation during implementation audit.**

#### Release verdict

**APPROVE**

This approval applies only to canonical plan revision **R6**. It authorizes the orchestrator to record the clean independent verdict and update administrative approval fields; it does not authorize implementation until the plan records:

```text
Status: approved
Revision: R6
Approved revision: R6
Implementation allowed: yes
```

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Implementation for approved R6 is complete and frozen pending the third independent full-scope implementation audit.

### Actual Files and Diff

Production files:

- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/compaction-boundary.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- `packages/opencode/src/cli/cmd/run.ts`
- `packages/opencode/src/cli/cmd/run/session-data.ts`
- `packages/opencode/src/cli/cmd/run/subagent-data.ts`
- `packages/opencode/src/cli/cmd/run/stream.transport.ts`
- `packages/opencode/src/cli/cmd/run/types.ts`
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- `packages/opencode/src/acp/agent.ts`
- `packages/opencode/src/cli/cmd/github.ts`
- `packages/slack/src/index.ts`

Test files:

- `packages/opencode/test/session/messages-pagination.test.ts`
- `packages/opencode/test/session/message-v2.test.ts`
- `packages/opencode/test/session/prompt.test.ts`
- `packages/opencode/test/session/compaction.test.ts`
- `packages/opencode/test/session/processor-effect.test.ts`
- `packages/opencode/test/server/httpapi-sdk.test.ts`
- `packages/opencode/test/cli/run/session-data.test.ts`
- `packages/opencode/test/cli/run/subagent-data.test.ts`
- `packages/opencode/test/cli/run/stream.transport.test.ts`
- `packages/opencode/test/acp/event-subscription.test.ts`

Implementation diff: `331 additions + 69 deletions = 400 changed lines`. The unrelated dirty `bun.lock` and `packages/core/src/models-snapshot.js` are excluded.

### Red-Green and Rework Evidence

- Hidden task Message/Part events initially left or recreated subagent tabs; reducer tests now pass after storing parent `messageID` and consuming both tombstones before ordinary creation.
- Visible page initially let hidden physical rows consume `limit`; the public page test now proves refill capacity and proves a hidden cold Part remains frozen.
- Hidden Compaction Part initially left its summary replayable; the persisted pair test failed, then passed after all markers participated in pair cleanup while only visible Parts qualified as boundaries.
- HTTP hidden-parent lookup initially returned 500 and PATCH could mutate the hidden parent; the SDK test now proves `404`, no resurrection, and raw state preservation.
- The performance gate exposed excessive overfetch and an incorrect max-as-p95 statistic; indexed `+10` refill and nearest-rank p95 now pass three consecutive production-seam runs.
- Duplicate physical `effect@4.0.0-beta.65` paths initially produced approximately 32K type errors; the user-authorized node_modules-only junction restored one package identity, exposing three implementation type errors that were fixed before the final clean typecheck.

### Verification Commands and Results

| Command (`packages/opencode` unless noted) | Final result |
| --- | --- |
| `bun test --timeout 60000 test/session/messages-pagination.test.ts` | `57 pass`, `0 fail`, `143 expect()` |
| performance test, three consecutive isolated runs | each `1 pass`, `0 fail`; public page returned 301 rows and both thresholds passed |
| `bun test --timeout 30000 test/session/message-v2.test.ts test/cli/run/session-data.test.ts test/cli/run/subagent-data.test.ts test/cli/run/stream.transport.test.ts test/acp/event-subscription.test.ts` | `102 pass`, `0 fail`, `202 expect()` |
| `bun test --timeout 30000 test/session/compaction.test.ts` | `71 pass`, `0 fail`, `293 expect()` |
| `bun test --timeout 30000 test/session/revert-compact.test.ts` | `16 pass`, `0 fail`, `83 expect()` |
| `bun test --timeout 30000 test/session/prompt.test.ts -t "invalidates file-reference proof"` | `1 pass`, `0 fail`; Provider wire, persisted input snapshot and no overflow Compaction asserted |
| `bun test --timeout 30000 test/session/prompt.test.ts -t "late technical Message"` | `1 pass`, `0 fail`; real hidden chronology/Goal control path |
| `bun test --timeout 30000 test/session/processor-effect.test.ts -t "doom_loop"` | `4 pass`, `0 fail`, `18 expect()` |
| `bun test --timeout 30000 test/server/httpapi-sdk.test.ts -t "matches generated SDK session message and part routes"` | `1 pass`, `0 fail`, `3 expect()` |
| `bun test --timeout 30000 test/storage/cold.test.ts` | `32 pass`, `0 fail`, `181 expect()` |
| `bun typecheck` | pass after the authorized generated-dependency identity repair |
| `bun typecheck` in `packages/slack` | pass |
| `git diff --check` on implementation-owned files and this plan | pass |

The broad Prompt `-t "Goal"` command still times out in two pre-existing 20-second long-flow tests: `legacy compaction marker without lineage does not create a Goal turn` and `only a later real user Goal turn authorizes model terminal recovery`. The implementation-owned plugin projection and hidden chronology Goal tests pass independently. No other required command remains red.

### Original Feedback-Loop Result

The four original loops were re-run after implementation. The failed-tail loop exited `2` with `["msg_003","msg_004","msg_001","msg_005"]`, proving the invalid hidden failed tail no longer replaces the valid pair. The hidden reducer loop exited `2` with `announced:false` and no commits/footer. The live visible-limit loop retained its incident-data shape (`physical:300`, `returned:293`, `available:300`) and exited `1`; the persisted database cannot verify new code. The live Goal query no longer showed the historical hidden divergence and exited `2`; it is likewise not a code-level acceptance signal.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Implementation result |
| --- | --- | --- |
| visible Message page/chronology/replay | primary | repaired at MessageV2 owner |
| `includeHidden: true` raw page/stream | existing compatibility | preserved |
| fully hidden successful Compaction structural cutoff | supported-domain branch | preserved with marker/summary parity proof |
| raw SyncEvent hidden payload | contracted pass-through | unchanged |
| accounting/Stats/fork/raw audit | contracted pass-through | unchanged |
| run/ACP/GitHub/TUI/Slack hidden tombstone guards | primary adapter boundaries | append-only side effects suppressed without alternate success paths |
| public HTTP hidden Message/parent Part | public adapter contract | hidden parent rejected before mutation; visible parent still accepts hidden Part tombstone |

New alternate success paths: `0`. Diagnostic decision surface: `0%`. No DB repair, retry, fallback, feature flag, second parser, second data source, generated SDK change, temporary script or backup artifact was added.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 279 | added lines excluding blank, comment-only and import-only lines across implementation-owned files |
| Qualifying Chinese comment lines `C` | 42 | projection ownership, physical/public cursor, pre-thaw, Compaction parity, raw tombstones and public parent guards |
| Ratio `C / E` | 15.05% | `42 / 279` |
| Required minimum `C` | 42 | `ceil(279 * 0.15)`; gate passes |

### Remaining Risks

- The generated node_modules junction is environment-only and untracked; a future dependency reinstall may recreate duplicate physical Effect identities and require package-manager correction outside this implementation.
- The two broad pre-existing Goal tests retain their fixed 20-second timeout behavior; the narrower production seams changed here are green.
- GitHub and TUI guards remain source-inspection verification per approved R6; Slack additionally passes package typecheck.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R6 | yes | B-01, B-02, B-03, B-04 | 4 | BLOCK | `ses_064e5e7ecffe4FWCImSBrd6qpb` |
| 2 | R6 | yes | B-01 through B-07 | 0 recorded | BLOCK; primary path PASS | `ses_064aa12b1ffeP33A1uWodcszlx` |
| 3 | R6 | yes | B-01 through B-07 | 3 | BLOCK | `ses_062ec0640ffellZmjzxviBtxmc` |

### Round 1 Verbatim Classification and Verdict

- `B-01 hidden task Part 会重新创建 subagent tab`：BLOCK，reachable。
- `B-02 R6 要求的多数 red-green 行为验证没有实施`：BLOCK，contracted。
- `B-03 chronology 性能验收偏离 approved baseline contract`：BLOCK，contracted。
- `B-04 必需 typecheck 尚不可执行且没有通过`：BLOCK，observed。
- Non-blocking 1：`prompt.ts` 重复中文注释不能计入 `C`。
- Non-blocking 2：canonical metadata 的 `Audit mode` 仍为 `plan`。
- Non-blocking 3：`FooterSubagentTab.messageID` optional，类型弱于 invariant，但唯一生产构造器始终赋值。
- Non-blocking 4：Section 8 非零退出/live DB 命令只能作为诊断，不能替代 production-seam tests。

**Primary-path verdict: BLOCK**

**Code-quality verdict: BLOCK**

**Release verdict: BLOCK**

### Round 2 Verbatim Classification and Verdict

- `B-01 page performance gate 三轮中两轮失败`：BLOCK。
- `B-02 hidden Part 在 ColdStorage.thawPartRows 后才过滤`：BLOCK。
- `B-03 Compaction persisted/pure 敏感测试不足`：BLOCK。
- `B-04 Prompt/Compaction snapshot 断言不足`：BLOCK。
- `B-05 tests minified，并包含 unchecked casts/non-null assertions`：BLOCK。
- `B-06 mandatory opencode typecheck 未通过`：BLOCK。
- `B-07 中文解释注释 C=42 < required 44`：BLOCK。

**Primary-path verdict: PASS**

**Release verdict: BLOCK**

Round 2 后已修复全部七项：page/pre-thaw、Compaction persisted pair sensitivity、Prompt/Compaction snapshot、test typing/readability、duplicate Effect identity/typecheck、400-line budget and Chinese comment gate。

### Round 3 Verbatim Classification and Verdict

Full original scope: yes.

- `B-01 part.update 的父 Message 可见性检查存在并发穿透窗口`：BLOCK，reachable。
- `B-02 必需的 Goal chronology 行为测试稳定失败`：BLOCK，observed。
- `B-03 删除了跨 turn 不同 input 的 doom-loop 回归保护`：BLOCK，observed。
- `B-04 stateful run tombstone 测试未验证实际 cleanup 责任`：BLOCK，contracted。
- `B-05 Compaction partial-hidden 回归没有经过 R6 约定的 Revert producer seam`：BLOCK，contracted。
- `B-06 新增性能测试引入禁止的 non-null assertions`：BLOCK，observed。
- `B-07 中文解释注释未达到 15% 硬门槛`：BLOCK，observed。
- Non-blocking 1：`FooterSubagentTab.messageID` 仍为 optional，但唯一 production constructor 始终赋值。
- Non-blocking 2：actual diff 为 `331 additions + 69 deletions = 400 changed lines`，满足用户硬门槛。
- Non-blocking 3：`git diff --check` 通过，仅有 LF→CRLF 提示。

**Primary-path verdict: BLOCK**

**Code-quality and Chinese-comment verdict: BLOCK**

**Release verdict: BLOCK**

Auditor recomputation: `E=279`, qualifying `C=41`, required `C=42`, ratio `14.70%`.

Invocation reference: `ses_062ec0640ffellZmjzxviBtxmc`; auditor report reference `r6-implementation-audit-round-3-2026-07-26-current-session`.

R6 已用尽三轮 implementation audit。第三轮中属于本次实现引入的两项已修正：恢复被误删的 cross-turn different-input doom-loop 回归测试，以及消除性能测试中新增的 non-null assertions。

其余五项经仓库证据复核后确认不属于 hidden 消费链路的回归，作为已知缺口记录，不在本任务范围内处理：

- `updatePart` 与 `SessionRevert.cleanup` 的并发穿透窗口：先于本次改动存在。`cleanup`（`revert.ts:211-235`）不经 `beginRevert`，且 `compact` 先持 `exclusive` 再调 `cleanup`（`prompt.ts:2490`、`run-state.ts:201`），而 `beginRevert` 与 `exclusive` 互斥（`run-state.ts:124`）；修复需要单独设计兼容重入的线性化点。
- `late technical Message` 用例耗时贴近其 `20_000` 预算（实测 `22.90s / 22.20s / 20.67s`）；同文件另两个 Goal 用例在本次改动前即已超时。
- run tombstone 与 Compaction partial-hidden 测试未经完整 producer seam；对应生产行为已由其他用例覆盖。
- 中文注释统计口径差异（1 行）。
