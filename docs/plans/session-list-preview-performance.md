# Canonical Implementation Plan: Session List Search Preview Performance

> Status: verified
>
> Revision: R5
>
> Approved revision: R5
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL / user request (2026-10-07) — 检查当前 session list，消息逻辑展示与性能逻辑；六个关键词回放平均 ≤3 秒；生产代码 ≤6 文件且 ≤800 行；不改 schema / 数据库存储格式；不引入或出现消息展示逻辑的红测。
>
> Implementation allowed: yes
>
> Last updated: 2026-10-08

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 检查当前 session list，消息逻辑展示与性能逻辑，最终验收标准是六个关键词的回放平均降低到三秒钟以内，同时生产代码修改数量不超过六个文件以及八百行代码。整体而言修改保持克制，避免修改影响到相应 schema 或数据库储存格式等等内容。整体不得引入或出现相应消息展示逻辑的既有或者引入红测。

补充约束（用户同会话后续消息，均为本次范围约束）：

- 否决建立搜索投影 / FTS 等任何带来额外存储压力或 schema 变更的方案。
- 保留既有排序修复成果（三元组排序机制），不重新引入顺序 bug。
- 避免造成用户体验降低。
- 验收关键词集合：`sqlite`、`session`、`冷存储`、`搜索`、`windows shell`、`sqlite session`（与测量基线一致）。

## 2. Explicit Non-Goals

- 不改数据库 schema、不写 migration、不建索引、不建搜索投影表、不引入 FTS。
- 不改 `searchCondition` 的匹配语义（title∨内容白名单、多 token AND、`instr(lower())` 子串）。
- 不改搜索范围参数：180 天 lookback、TUI roots-only、400 命中上限、浏览 1600。
- 不改 `time_updated DESC, id DESC` 会话排序与 `(time_updated, id)` keyset 游标。
- 不改每批候选 50（`SESSION_LIST_CONTENT_BATCH`）：实测 75/100 平均再省 ≤0.08 秒且最长单批同步执行变长。
- 不改候选页 `SELECT *`（窄字段实测再省约 0.01 秒，不值得 diff）。
- 不截断预览文本（保持全文传输与当前展示语义一致；性能目标无需此改动）。
- 不改 `DialogSelect` 的全局选中/滚动语义；不改 preview 的两行展示结构与 `├─/└─` 前缀。
- 不改 `PreviewPayload` wire schema（`sessionIDs: string[]`、`limit 1..10` 缺省 2、响应 `Record<string, string[]>`）。
- 不改 `listGlobal`、ACP `listSessions`、Web/App 前端的 session list（它们不经 TUI 预览端点）。
- 不处理预先存在的渐进更新选中项跟随问题（属既有行为，非本需求；改它即变更展示逻辑）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | 用词：Session / Message / Session search / Session path |
| `packages/opencode/AGENTS.md` | 测试从 package 目录运行；Effect 与模块组织规则 |
| `packages/opencode/test/AGENTS.md` + `test/server/AGENTS.md` | 测试夹具与同步约定 |
| `.opencode/policy/first-principles-engineering.md` | 修 first divergence；禁 fallback；traceability；E/C 门禁 |
| `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | 仅 triage 标签，与本任务无关 |
| `docs/plans/tui-session-list-search-tuning.md`（已 verified） | 本任务在其引入的 progressive 搜索（B1 title + B2 scan）之上做性能修复，不改变其语义 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `src/cli/cmd/tui/component/dialog-session-list.tsx`（preview effect、`runProgressiveSearch`、`appendScanHits` 调用点） | 预览触发与放大链第一现场 | observed |
| `src/cli/cmd/tui/util/session-list-params.ts`（常量与 `appendScanHits`） | 批次/上限/合并语义 | observed |
| `src/server/routes/instance/httpapi/handlers/session.ts` `preview` handler（窗口函数 SQL） | 预览 SQL 第二现场 | observed |
| `src/server/routes/instance/httpapi/groups/session.ts`（PreviewPayload/PreviewResponse/searchScan 路由） | wire 契约，保持不变 | observed |
| `src/session/session.ts` `listByProject`/`searchScanByProject`/`listUniverseConditions`/`touch` | 搜索宇宙与排序；`touch` 是 `time.updated` 的唯一常规推进 | observed |
| `src/session/search.ts` `searchCondition` | 匹配条件不改 | observed |
| `src/session/projectors.ts`（MessageV2 Updated/PartUpdated 不推进 `time_updated`；`applyUsage` 显式写回原值） | 证明 `id+time.updated` 版本键失效时机与今日 `sessions()` 触发时机严格一致 | observed |
| `src/cli/cmd/tui/context/sync.tsx`（`session.updated` 驱动 `sync.data.session`；`sessions()` 变化是预览唯一既有触发源） | 缓存失效时机等价性论证 | observed |
| `src/session/session.sql.ts`（`message_session_time_created_id_idx`、`part_message_id_id_idx`、`part_session_idx`；无 search 专用索引） | 既有索引即可承载早停查询 | observed |
| `test/server/session-preview.test.ts`（12 个既有行为用例） | 语义护栏基线 | observed |
| `test/cli/cmd/tui/dialog-session-list.test.tsx`（`withSessionList` 假 transport 可计数 preview 请求） | 去重红测缝 | observed |
| `test/cli/cmd/tui/session-list-params.test.ts` | 回归护栏（本任务不改该文件） | observed |
| `D:\Temp\opencode\session-search-bench-20261007.mjs` + round-1..4 JSON | 只读真实库回放基线与对照（见 §8） | observed |
| 真实库 `C:\Users\Lenovo\.local\share\opencode\opencode.db` 只读统计（5,343 session / 610 半年主 session / message 40.4 万 / part 187.8 万 / 主文件约 2.97 GiB） | 数据规模 | observed |

## 5. Current Behavior

```text
输入关键词
  -> debounce 150ms -> B1 GET /session?searchMode=title&roots=true&start=now-180d&limit=400
  -> 250ms 后 -> B2 串行 POST /session/search/scan（每批 50 候选，keyset 推进，≤400 命中停止）
  -> 每批 setScanFullHits（每批都产生新数组）
  -> displayHits/sessions() 变化
  -> 预览 effect：slice(0,400) 全量 ID -> POST /session/preview（每次包含全部已显示 ID）
       -> handler：对全部请求 session 的全部可见 user 历史做 ROW_NUMBER 排名，再取 msg_rn<=2
  -> setPreviews 整体替换 -> options 全量重建
```

预览语义（保持不变的契约）：每 session 取最近 `limit` 条可见 user 消息（role=user、message 无 hidden、至少一个可见 text part；part 需 type=text、非 synthetic/ignored、无 part hidden），同一消息多 text part 按 `part.id` 升序空格拼接，JS 侧 `\s+ -> " "` 归一化，数组旧→新排列，无可见文本的 session 不出现在响应。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 非空 debounced 搜索串 | DialogSelect onFilter | 可含空格/CJK | B1+B2+预览 | DialogSessionList | observed |
| 浏览态（空 query） | sync.data.session | ≤1600 条 | 预览 effect 同样触发 | DialogSessionList | observed |
| sessionIDs ≤400 / limit 1..10 | PreviewPayload schema | schema 校验 | preview handler | HttpApi | contracted |
| session 内容在弹窗存活期内变化 | prompt `sessions.touch` → `session.updated` SSE | `sync.data.session` 更新 | 预览 effect 再触发 | sync → dialog | observed |
| 消息/Part 写入不推进 `time_updated` | projectors.ts | `session.updated` 是 store 唯一更新源 | 预览失效时机 = `sessions()` 触发时机（改前改后一致） | projectors + sync | observed |
| 无可见文本的 session | preview 响应省略该 ID | 响应 schema 允许缺省 | 需缓存「已取且为空」避免每批重取 | preview handler → dialog | observed |
| 预览请求失败/abort | 网络层 | 静默忽略（既有行为） | 不写缓存，下一次触发重试 | dialog | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 搜索宇宙、范围、排序、400 上限、多 token AND 语义不变 | user + tuning plan | `session-list.test.ts` progressive 系列 |
| INV-02 | 预览内容契约逐字节保持（过滤、拼接、归一化、旧→新、limit 1..10） | user + 现有测试 | `session-preview.test.ts` 全部既有用例必须保持绿 |
| INV-03 | 无 schema/migration/索引/存储格式变更；搜索与预览路径只读 | user | git diff 证明 + 无新 migration |
| INV-04 | 不引入红测：本任务影响的既有测试全部保持绿 | user | package-local bun test |
| INV-05 | 预览失效时机与既有触发时机一致：session 内容变化（`time.updated` 变化）重取该 session；弹窗关闭清理全部预览态 | observed 语义等价 | 新增 dialog 用例 |
| INV-06 | 六个关键词回放平均总时长 ≤3 秒（真实库数据副本、真实 HTTP handler、真实渐进协议回放） | user | 验收脚本（§18） |

## 8. First Divergence and Root Cause

反馈环（red-capable，已实际运行）：

- 命令：`bun D:\Temp\opencode\session-search-bench-20261007.mjs <round>`（只读连接真实库，SQL 谓词与生产逐行镜像；4 轮 × 6 关键词 × 6 方案，等价性 digest 全等断言）。
- 捕获的用户症状：`current` 方案完整回放 8.05–12.52 秒/词，六词三轮中位数平均 **10.72 秒**，超 3 秒验收线 —— 即 red。
- 最小化：耗时集中于预览——`sqlite`/`session`/`搜索`/`windows shell`/`sqlite session` 五词预览占 80–95%，`冷存储` 占 53–56%（正文扫描主导）；一次搜索的预览请求实测 14–15 次、累计 441–3780 个 session·次。

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-06 | 预览 effect 以「当前显示集合」为请求单位：每批（含零新增批）都对全部已显示 ID 重发 POST `/session/preview`；一次搜索实测 14–15 次预览、累计 441–3780 个 session·次 | `DialogSessionList` 预览 effect | 回放计数器（previewCalls/previewSessions）；`appendScanHits` 空页也返回新数组（纯函数实测 `old!==next`） |
| INV-06 | handler SQL 先对每 session 的全部可见 user 历史做 `ROW_NUMBER()` 再过滤 `msg_rn<=2`，而非按 `(session_id,time_created,id)` 索引倒序找到 2 条即停 | `SessionHttpApi.preview` | 400 session 实测 792–945ms（窗口）vs 103ms（逐 session 索引 LIMIT），归一化文本与顺序逐字节一致；EXPLAIN 显示临时 B-tree 排名 |

两个 first divergence 同属「session 预览」这一 primary path 的两个 owner 模块（客户端取数编排 / 服务端取数 SQL），均在 owner 处直接修复；不引入第二算法、不引入失败后备用路径。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 预览取数编排（取哪些、何时取、失败静默、卸载清理） | `DialogSessionList` 预览 effect | 弹窗存活期内的预览加载 | 它是唯一消费者与唯一触发点 | sync 只管数据同步，不认识弹窗预览；server 无客户端批次语义 |
| 预览内容查询（过滤/排序/拼接/归一化契约） | `SessionHttpApi.preview` handler | `POST /session/preview` wire 契约 | SQL 是该端点唯一实现 | Session 服务层无预览方法；MessageV2.page 是全量 hydrate 路径，语义不同 |
| 版本失效键（`id:time.updated`） | `DialogSessionList`（消费 `sync.data.session` 既有字段） | `session.updated` 事件契约 | 与既有触发时机同源 | projectors/sync 语义不变，无需新事件 |
| 搜索条件与宇宙 | `searchCondition` / `searchScanByProject` | 不变 | 本任务不改 | — |

## 10. Single Approved Primary-Path Design

### R5 Authoritative Lifecycle Repair

### R5 Implementation Evidence

Final full-scope implementation audit (round 3), `ses_ee80c2268ffeY3mAXG5XSJvjVf`: **No blocking findings.** Release verdict verbatim: **APPROVE — 仅适用于 canonical R5 与本轮实际审计的完整 HEAD→工作区任务 diff。** B-01 closed. Auditor independently ran 28 TUI/params tests, 40 server tests, typecheck, coverage inventory, scoped diff check, actual-effect probe and read-only 5353-Session SQL equivalence (limits 1/2/3/10); all passed. Performance artifact independently read: mean 1938ms. Non-blocking: warmed HTTP replay does not establish terminal-render/cold-cache SLA; superseded R4 prose remains historical.

Final independent comment accounting: E=497, C=75, minimum=ceil(497*0.15)=75, ratio=15.09%. By file (E/C): dialog 32/19, handler 36/10, dialog tests 324/34, server tests 105/12. Excluded blank/import-only/indentation/pure-move/documentation lines and comments merely restating operations; qualifying examples explain query-owned closures, old-finally isolation, immutable request snapshots and legacy Set/floor semantics.

- Current production diff: dialog +75/-32, handler +63/-59, total 229 added/deleted lines in 2 production files. Tests: dialog +381/-2, server preview +134. Existing unrelated worktree changes remain untouched.
- RED: extracted actual-effect loop produced one request and stale-one; real component test `query changes isolate pending preview responses and cleanup` failed waiting for new query's request before implementation. GREEN: same extracted loop produces two requests and fresh-two; component regression passes. Added regression verifies old finally while new request remains pending across scan batches. A→B→A and component disposal are covered through input/frame/AbortSignal seams.
- Removed standalone cache-clear watcher and dialog-lifetime maps. Query owner now creates all three maps and owns cleanup; same-query batches still share in-flight requests. No fallback, generation counter, new module, schema or public interface introduced.
- Verification cwd `packages/opencode`: `bun test test/cli/cmd/tui/dialog-session-list.test.tsx test/cli/cmd/tui/session-list-params.test.ts` = 28 pass; `bun test test/server/session-preview.test.ts test/server/session-list.test.ts` = 40 pass; `bun typecheck` clean. `bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip` = 158 inventory entries, zero missing/skip/fail (coverage inventory, not 158 executed endpoint scenarios). Scoped `git diff --check` passes.
- Acceptance script now asserts exact isolated OPENCODE_DB before dynamic Server import, asserts every HTTP response and the six-keyword <=3000ms mean. Executed with OPENCODE_DB=D:/Temp/opencode/acceptance-db/opencode-acceptance.db and filewatcher disabled. Results (ms): sqlite 1815, session 1311, 冷存储 2242, 搜索 1939, windows shell 2519, sqlite session 1799; mean 1938. This is warmed HTTP protocol replay, not real terminal-render latency or OS cold-cache SLA.
- Final E/C must be independently recomputed from complete HEAD diff using 15% hard gate; previous R4 counts are historical and cannot authorize current release. Query ownership, old-finally isolation and controlled-response test intentions have adjacent explanations.
- R5 received full-scope independent implementation approval; historical R4 approval and residual-window claims are superseded.

R5 plan audit (full scope, round 5), `ses_ee80c2268ffeY3mAXG5XSJvjVf`: **No blocking findings.** Release verdict verbatim: **APPROVE — 仅批准 `docs/plans/session-list-preview-performance.md` 的 R5 计划。** Non-blocking: historical lifecycle/10%/residual-window statements are superseded by this R5 section; the external feedback loop was inspected but not independently executed in plan mode. Current implementation remains subject to full HEAD→final implementation audit.

R5 supersedes the R4 lifecycle pseudocode below; server SQL, snapshots, ordering, scope and other approved behavior remain as specified. Earlier revision descriptions and §23 measurements are historical evidence, not current release approval.

- Feedback loop executed: `bun D:\Temp\opencode\session-preview-query-lifecycle-probe.mjs` from `packages/opencode`. It extracts and executes the current preview effect with real Solid scheduling, controlled transport and in-memory data. Observed RED: `requests=1`, rendered `stale-one`, expected `fresh-two`. No database or server involved.
- First divergence: new committed query clears completed cache but continues using the old query's in-flight keys and response closures. Ownership remains `DialogSessionList`; Part writes and Session timestamps retain their existing semantics.
- Replace the separate cache-clear watcher and dialog-lifetime maps with one outer `createEffect(on(() => search(), ...))`. Its callback creates query-local cache/inflight/latest Maps, registers cleanup that aborts all owned controllers, and creates the existing inner sessions-driven effect. Solid disposes the inner owner before recreating the outer query owner.
- Each inner request closes over only its own query Maps and immutable `{id,key}` snapshots. Existing post-JSON abort guard blocks old writes. Existing finally deletes only from its captured old Map, so it cannot erase a new query's identical key. Intra-query sessions/phase changes retain in-flight dedupe and completed-cache reuse.
- Clearing search to browse and A→B→A each construct a fresh query owner, even when the Session version is identical. Component disposal invokes the same owner cleanup. No generation counter, fallback, new module or public interface is needed.
- Remove R4's standalone clear effect and false lifecycle-equivalence / GET-only rewrite comments. Explain only the actual explicit directory query requirement of this raw fetch.
- Forward mapping: INV-05 → query-local preview owner → dialog component → pending old-response/new-query frame regression, including A→B→A or search-to-browse and disposal. INV-01/02/03/04/06 retain all existing mappings and verification commands.
- Reverse mapping: query-owned Maps and cleanup → INV-05 observed RED. Existing dialog-lifetime Maps cannot isolate equal-version requests across queries; Solid owner cleanup already provides the required lifetime boundary.
- TDD slice: retain controlled old response while new query reaches the same Session; verify fresh text appears before releasing old response, then verify fresh text survives old response completion. Include a pending new response while old finally completes and a later same-query batch, so old cleanup cannot defeat new in-flight dedupe. Existing same-query dedupe and browse snapshot tests remain required.
- File budget: only dialog component and its existing test file receive further behavior edits; total task remains 2 production files, anticipated <300 production changed lines (<800). No schema/storage/config change. Chinese comment hard gate remains C >= ceil(E*0.15) across production plus tests, with meaningful owner/race/test explanations.
- Verification: original extracted-effect loop, component regression, all four §18 test files, package-local typecheck, coverage inventory, scoped diff check, and six-keyword HTTP protocol replay on an explicitly isolated database copy. HTTP status and <=3s average must be asserted; replay remains distinct from terminal-render timing. Warm-up runs do not establish OS cold-cache SLA.
- Audit record: both fresh R4 implementation audits returned BLOCK on this same B-01 (`ses_ee80c2268ffeY3mAXG5XSJvjVf`, `ses_ee80c2208ffeVV40hi0OdVMU4g`). Those findings supersede the earlier R4 release claim. The supposed one-trigger residual window is withdrawn: R4 could retain stale content indefinitely within that query.
- No open product decision: repair the newly introduced lifecycle regression at its owner, retain intra-query performance optimization. Audit is full original scope. All earlier 10% comment-threshold interpretations are superseded by the user's and policy's mandatory 15%.

```text
[Server: SessionHttpApi.preview]
  对每个请求的 sessionID：
    SELECT message.id, time_created FROM message
      WHERE session_id=? AND role/hidden/EXISTS(text part) 过滤与现状逐字一致
      ORDER BY time_created DESC, id DESC LIMIT <limit>     -- 索引早停
    再对选中的 message 按 part.id 升序聚合 text
  JS 归一化与分组逻辑保持不变；响应 schema 不变
  输入语义保持（R4）：
    sessionIDs = new Set(payload.sessionIDs) 去重——保持旧 IN 查询的集合语义：
      重复 ID 只贡献一次结果（公开 schema 未要求唯一）
    limit = Math.floor(payload.limit ?? 2)——对齐旧实现 msg_rn <= limit 的行数语义：
      schema 接受 [1,10] 内 Number（含 1.5），SQLite LIMIT 只接受整数

[TUI: DialogSessionList 预览 effect]
  cache: Map<版本键, string[]>；生命周期 = 单个 committed query（search() 变化即清空）
  inflight: Map<版本键, AbortController>（同键最多一个在途请求）
  latest: Map<id, 版本键>（每代刷新，供迟到响应判断是否仍是当前显示版本）
  search() 变化（改词/清空/回浏览，先于 preview effect 注册）：清空 cache
    ——恢复旧实现「重新搜索即整批重取预览」的刷新路径；保留单搜索内跨批去重
  sessions() 变化（每批/complete/浏览刷新共用同一触发）：
    wanted = 前 400 个显示项的身份快照 {id, key=`${id}:${time.updated}`}；刷新 latest
    ——快照在发请求时固定身份；响应阶段不得重读 Store 对象（reconcile 原地突变）
    missing = wanted 中未缓存且不在途的键
    missing 为空 -> 返回（零网络）
    新 controller -> POST missing 的 id；快照键记入 inflight
    成功且未 dispose-abort -> 响应缺省 ID 记 [] 入缓存（写快照键）；合并进 previews record
      （写展示 record 前校验 latest[id] 仍为该响应快照键，否则只写缓存不写展示）
    失败 -> 不写缓存（该代的键随下一次触发自然重试）
    finally 按快照键清除本代 inflight
  代与代之间不 abort：在途代必然完成并写入版本键缓存，覆盖语义由「缓存 ∪ 在途 ∪
  本代请求」共同满足；abort 仅发生在弹窗 dispose（onCleanup）。
  版本键变化（session.updated）=> 旧键不再被 wanted 引用，新键进入 missing => 仅该 session 重取；
  旧版本迟到响应因 latest 校验被挡在展示 record 之外。

  关键不变量：每个 wanted 键要么已缓存、要么在途（必完成并写缓存）、要么随本代
  发出；终止代（末批/complete）与任意中间代语义相同，终止后全部 wanted 键必然
  解析——不依赖未来触发（审计 B-01 的修复）。

  R2→R3 修订原因：R2 的「abort 上一代 + 未缓存键随下一代携带」在 Solid 连续信号
  写（title→partial、partial→complete 级联）下会把内容不变的在途请求反复中止重发
  （实现期实测：title [c] 后 phase 切换即在途重发 [c]），请求序列随定时漂移、
  线上无法稳定断言且浪费有界 SQL 工作。本修订采用审计 B-01 修正方向中明确认可
  的替代机制（「let in-flight generations complete into the version-keyed cache
  and restrict abort to dispose」），覆盖不变量与 INV-05 等价性不变。

  R3→R4 修订原因：双审计归因复核确认四项本次引入/扩大的回归（均含对照实验证据）：
  (1) missing 持有可变 Store 对象，响应阶段重读 time.updated 导致身份漂移
      （错版本缓存/覆盖新版/在途键遗留）——修为发请求时的 {id,key} 身份快照；
  (2) 版本键缓存跨 query 存活，吞掉旧实现「改词重搜即整批重取」的刷新恢复路径
      （同时间戳内容修改后重新搜索仍展示旧预览）——修为缓存生命周期=单 query；
  (3) 逐 ID 循环丢失旧 IN 的集合语义（重复 ID 重复追加、突破 limit）；
  (4) 直接 LIMIT 丢失旧 msg_rn<=limit 的非整数容忍（limit=1.5 由返回一行变为
      SQLITE_MISMATCH）——修为 Set 去重 + Math.floor。
  另修正两处记录问题：handler 顶部过时「窗口函数」说明、测试注释证据边界。
  注释门禁口径纠正：以最终 diff 的生产+测试 E 重算，承诺达到 15% 目标线
  （C >= ceil(E×0.15)）；10% 仅为不阻塞下限，不作为本任务的交付目标。
```

为何这是 first-divergence 修复：

- Divergence A：请求单位从「整批显示集合」改为「未缓存版本集合」，在触发点消灭重复取数；触发时机、失败语义、卸载清理全部沿用既有结构。R4 补充：请求身份以发出时快照为准（不依赖可变 Store 对象的后续状态）；缓存生命周期收窄到单 query，恢复旧实现「改词重搜即刷新」的恢复路径。
- Divergence B：排名被替换为「沿既有索引找到 LIMIT 条即停」，过滤谓词、拼接顺序、归一化、响应形状逐字保留；等时消息由 `id DESC` 定序、part 由 `id ASC` 拼接，差分夹具（等时戳、part 逆序插入、hidden/synthetic、limit 1/2/3/10）已证明与窗口实现逐字节一致。R4 补充：输入侧保持旧 IN 集合语义（去重）与 msg_rn<=limit 行数语义（floor），公开端点已接受输入域无行为变化。
- 无 schema/索引/存储变更；无新 wire 字段；无新配置；无第二套搜索或预览算法。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| B1 title 首屏 + B2 scan | current | primary-contract branch | yes | 本任务不改 | preserve |
| 预览失败静默（catch 忽略） | current | existing shipped 行为（行无预览即为降级外观，非伪造成功） | no | 既有 | preserve 原样 |
| 浏览态（空 query）预览加载 | current | primary-contract branch | yes | 与搜索共用同一 effect | preserve + 同样去重 |
| 预览空结果缓存为 `[]` | proposed | 主合同内分支（响应缺省 ID 的客户端记账） | no（不产出数据） | 小 | 纳入设计，防重复请求 |
| 失败时回退旧整批重取 | not proposed | forbidden fallback | would yes | — | reject |
| 投影/FTS/新索引 | rejected by user | forbidden（存储格式变更） | — | — | reject |

诊断面估算：0 新增分支超出主合同；无新建 alternate success path。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 每批整集合预览重取（含全量 abort+替换） | 初版以「sessions 变化即整体刷新」为最简正确实现 | 版本键去重在同一 owner 内给出同新鲜度、子集取数 | `dialog-session-list.tsx` 预览 effect 原位置换 |
| 窗口函数全历史排名 | 单条 SQL 替代 N×M 分页时的直接实现 | 索引早停查询在同一 handler 内给出同语义、限量读取 | `handlers/session.ts` preview SQL 原位置换 |

无遗留 workaround；被替换代码直接删除，不保留并存路径。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 搜索语义不变 | 不改 `searchCondition`/`searchScan` | 无改动 | 既有 `session-list.test.ts` progressive 系列保持绿 |
| INV-02 预览内容契约 | 新有界 SQL，谓词逐字保留；输入侧 Set 去重 + floor(limit) | `handlers/session.ts` preview | 既有 15 用例保持绿 + 新增重复 ID/非整数 limit 用例（对 R3 实现为红） |
| INV-03 无存储变更 | 仅查询与客户端编排 | 两个生产文件 | git diff 不含 `*.sql.ts`/`migration/` |
| INV-04 无红测 | — | — | §18 全部测试命令绿 |
| INV-05 失效时机等价 | 版本键 = `${id}:${time.updated}`；身份快照；缓存生命周期=单 query | `dialog-session-list.tsx` | 新增：跨批仅取新增；同版本不重取；版本变化仅重取该 session；空预览不重复请求；可变对象身份漂移守卫；改词重搜刷新恢复 |
| INV-06 平均 ≤3 秒 | 上述两处修复叠加 | 同上 | §18 验收脚本（真实 handler + 数据副本回放）平均 ≤3s 且预览映射与基线全等 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 逐 session 索引早停预览查询 | INV-06 | 实测 400 session：792–945ms → 103ms，结果逐字节一致 | 窗口排名在过滤 `msg_rn` 前必须物化每 session 全部合格行，结构性无法早停 |
| 版本键预览缓存（弹窗局部） | INV-06/INV-05 | 实测预览占 84–94% 且 13–15 次重复请求；`time.updated` 由 `session.updated` 唯一驱动 | 现有 effect 以数组引用为触发事实，无版本记忆，必然整批重取 |
| 空预览记账（`[]` 入缓存） | INV-06 | 响应缺省 ID 是既有契约；缺记账则每批重取空会话 | 现有「data 合并」语义无法区分「未取过」与「取过为空」 |
| 在途代完成写缓存 + latest 版本校验（代间不 abort，abort 仅限 dispose） | INV-05/竞态 | 在途代必然完成写缓存，终止代不丢预览（审计 B-01 修正方向认可机制）；latest 校验挡住旧版本迟到写展示 record | 现有守卫面向整批替换且天然全覆盖；子集化后必须有等价完成保证，否则终止代丢键；R2 abort+carry 实测在级联触发下产生定时相关重复请求 |
| 请求身份快照 `{id, key}`（R4） | INV-05/竞态 | 审计对照实验：reconcile 原地突变 Store 对象后，响应阶段重读 time.updated 产生错版本缓存/覆盖/在途键遗留 | HEAD 只持字符串 ID 无此问题；快照是 R3 版本键机制的正确实现前提 |
| 缓存生命周期=单 query（R4） | 保留既有展示语义/INV-05 | 审计对照实验：同时间戳内容修改后重新搜索，HEAD 重取恢复、R3 缓存跳过 | HEAD 每次 sessions() 变化整批重取，改词重搜即刷新；去重收益主体在单搜索内跨批，不受 query 边界清空影响 |
| 输入侧 Set 去重 + floor(limit)（R4） | INV-02 | 审计最小复现：`[id,id]` 重复追加突破 limit；`limit=1.5` 触发 SQLITE_MISMATCH | 逐 ID 循环与直接 LIMIT 丢失了旧 IN/msg_rn<=limit 的输入域语义 |

无未映射的生产概念。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | modify | preview handler：窗口 CTE → 逐 session 索引早停查询；谓词/归一化/响应不变；输入侧 Set 去重 + floor(limit)；修正过时「窗口函数」说明 | +75 / −58 |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | modify | 预览 effect：身份快照 + 版本键缓存（单 query 生命周期）+ 在途去重 + 缺失子集请求 + 空结果记账；静默失败语义与 dispose 时统一 abort 保留 | +95 / −40 |
| `packages/opencode/test/server/session-preview.test.ts` | modify | 新增语义等价护栏 + 重复 ID/非整数 limit 输入域用例 | +170 / 0 |
| `packages/opencode/test/cli/cmd/tui/dialog-session-list.test.tsx` | modify | 新增去重/失效/空结果请求计数 + 身份漂移守卫 + 改词刷新恢复用例 | +230 / 0 |
| `docs/plans/session-list-preview-performance.md` | add | 本计划 | n/a（非生产） |

生产文件：2 个（≤6）；生产行变更：约 +170/−98（≤800）。不改 `session-list-params.ts`、`dialog-select.tsx`、`search.ts`、`session.ts`、schema/migration。

## 16. TDD Behavior Slices

公共 seam：`POST /session/preview`（server 行为）与 `DialogSessionList` 经 `withSessionList` 假 transport 的请求序列（TUI 行为）。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 0（等价护栏，先于改动即绿） | 等时戳按 `id DESC` 定序、part 逆序插入按 `id ASC` 拼接、最新 user 消息无可见 text 时回退到更早消息、limit=1/3/10 | 现状即应通过（语义保持证明基线） | 不改代码 | INV-02 |
| 1 | 两批渐进命中重叠时，第二次 preview POST 只含新增 ID；零新增批不发请求 | 现实现每批 POST 全量 ID（红） | 版本键缓存 + missing 子集请求 | INV-06 |
| 2 | 某 session `time.updated` 变化后，仅该 session 被重新请求；其余沿用缓存 | 现实现全量重取（红） | 键含版本，旧键自然失配 | INV-05 |
| 3 | 响应缺省 ID（无文本会话）在后续批次不再被请求 | 现实现每批重发（红） | 缺省 ID 记 `[]` 入缓存 | INV-06 |
| 4 | 预览请求失败后，下次触发重试同一子集且不写缓存 | 现实现整批重试（行为差：范围）——此条验证收窄后的等价重试语义 | 失败不写缓存 | INV-05 |
| 5 | 同版本在途键不重复请求（上一批 [a] 在途时新到 [b] 只请求 [b]）；session 版本推进后旧版本迟到响应不得覆盖展示 record | 现实现每代整批重取（对「不重复请求」为红）；R2 abort+carry 在级联触发下重复请求同内容（红）；此条钉住在途去重与 latest 守卫 | 在途集合去重 + latest 版本校验 | INV-05 |
| 6（R4） | 请求挂起期间同一 session 对象被原地更新（模拟 reconcile），迟到旧响应不得错标新版本/覆盖新版/遗留在途键 | R3 实现响应阶段重读可变对象 time.updated（红） | 发出时身份快照贯穿请求/写回/校验/清理 | INV-05 |
| 7（R4） | 预览缓存后改词重新搜索，同版本 session 被重新请求（恢复旧实现的刷新恢复路径） | R3 缓存跨 query 存活跳过（红） | search() 变化清空版本缓存 | 保留既有展示语义 |
| 8（R4） | 重复 sessionID 与 limit=1.5 的响应与单 ID/floor 语义一致 | R3 逐 ID 循环重复追加、SQLite LIMIT 报错（红） | Set 去重 + Math.floor(limit) | INV-02 |

性能 red→green：§8 反馈环即 red（10.72s > 3s）；实施后 §18 验收脚本重跑为 green（≤3s）。性能断言只在外部验收脚本，不写入 CI 测试（避免计时 flake）。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ≈560（生产 ≈170 + 测试 ≈390，不含 import/空行/纯移动/文档） | 按 §15 估算，实施后记实际值；口径=生产+测试（R4 纠正：不得仅计生产） |
| Required Chinese explanatory comments `C` | ≥ ceil(E×0.15)，按最终实际 E 重算；15% 为交付目标线（10% 仅为不阻塞下限） | 原始要求与 policy |

注释落点（均为非显然约束，非复述）：

- 版本键 `${id}:${time.updated}` 与 `session.updated` 触发时机的等价性（失效语义）。
- 代间不 abort 的覆盖论证：缓存 ∪ 在途 ∪ 本代请求 = wanted 全集，终止代后必解析（B-01 修复机制）。
- latest 版本校验：版本推进后旧版本迟到响应只写版本键缓存、不写展示 record。
- 空结果记账：`PreviewResponse` 缺省 ID 的既有 wire 契约。
- missing 子集 + 在途去重的竞态边界（同键最多一个在途；迟到响应受 latest 校验）。
- 失败不写缓存 = 重试语义与旧整批重试的关系。
- SQL：为何 `ORDER BY time_created DESC, id DESC LIMIT` 与窗口 `ROW_NUMBER` 排名等价（索引有序性 + 过滤先于 LIMIT）；等时戳由 id 定序。
- part 拼接顺序依赖 `part.id` 升序；JS 归一化保持服务端外一致性。
- `limit` 透传 1..10 不写死 2（wire 契约）。
- 身份快照：sync.data.session 为 Solid Store，reconcile 原地突变；响应阶段重读即漂移。
- 缓存单 query 生命周期：恢复旧实现「改词重搜即整批重取」的刷新恢复路径；part 写不 touch 时间戳，query 边界是唯一无 schema 变更的恢复点。
- Set 去重保持旧 IN 集合语义；floor(limit) 对齐旧 msg_rn<=limit 行数语义（schema 接受非整数）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/server/session-preview.test.ts` | `packages/opencode` | 等价护栏、重复 ID/非整数 limit 用例与既有 15 用例全绿（INV-02/INV-04） |
| `bun test test/cli/cmd/tui/dialog-session-list.test.tsx` | `packages/opencode` | 去重/失效/空记账/失败重试用例与既有用例全绿（INV-05/INV-04） |
| `bun test test/cli/cmd/tui/session-list-params.test.ts` | `packages/opencode` | 未改文件回归绿 |
| `bun test test/server/session-list.test.ts` | `packages/opencode` | 搜索语义回归绿（INV-01） |
| `bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip` | `packages/opencode` | 路由覆盖含 `/session/preview` 探针（INV-04）；完整三模式为 `bun run test:httpapi` |
| `bun typecheck` | `packages/opencode` | 类型绿 |
| `git diff --stat` 与 `git status` | repo root | 生产 2 文件、≤800 行、无 schema/migration 变更（INV-03） |
| 验收回放：`bun D:\Temp\opencode\session-search-acceptance-20261007.mjs`（实施时新建） | `D:\Temp\opencode`（cwd 依赖 `packages/opencode` 解析，脚本置 `OPENCODE_DB` 指向真实库副本） | INV-06：真实 `Server.Default().app.request` + `provideInstance`（镜像 `session-preview.test.ts` 拓扑）对副本库回放 6 关键词的旧式/新式客户端协议；报告每词总时长与平均、预览映射与实施前基线全等 digest、平均 ≤3s。副本流程：`Copy-Item opencode.db*` 到 temp 目录后置 `OPENCODE_DB`，迁移只作用于副本。若进程内 Server 引导在该脚本环境不可行，则以同一脚本经 `opencode serve`（指向副本）HTTP 回放为记录的同口径替代验收缝 |
| 等价参考（已运行，实施后用同脚本复核 SQL 形状）：`bun D:\Temp\opencode\session-search-bench-20261007.mjs <n>` | `D:\Temp\opencode` | SQL 级基线与对照、排序差分夹具 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 生产（计划文档 1） | 无新模块需求 |
| Files modified | 2 生产 + 2 测试 | §15 |
| Files deleted | 0 | — |
| Production lines | ≈ +170 / −98（≤800，≤6 文件） | 两处 owner 内置换 + R4 修正 |
| Test lines | ≈ +400 / 0 | 护栏 + 去重 + 身份漂移/改词刷新/输入域用例 |
| Generated lines | 0 | 无 SDK/migration 再生成 |

## 20. Real Risks and Open Decisions

| Risk | Class | Mitigation |
| --- | --- | --- |
| 逐 session 循环最多 400 次同步查询的调用开销 | observed（实测 400 ID 103ms 热缓存） | 保持单 HTTP 批量端点；不测冷缓存 SLA |
| 稀有关键词（零命中/冷存储类）总时长仍约 3.2–3.9s，单批最长同步执行可达 1.3–1.9s | observed（回放实测） | 验收为六词平均；该成本属 `instr` 正文扫描，投影/FTS 已被用户否决 |
| `time.updated` 不变而正文变化的理论窗口（part 写不 touch） | reachable（审计已证实可达） | R4：缓存生命周期收窄为单 query，恢复旧实现「改词重搜即重取」的恢复路径；弹窗关闭重建缓存兜底 |
| 弹窗内缓存与 SSE 更新竞争（迟到响应覆盖） | reachable | latest 版本键校验 + dispose 时统一 abort；代间不 abort，在途代必完成（审计 B-01 修复即此） |
| 计时回放不含 HTTP 传输与终端渲染，P0 代理均值 ≈1.87s 距 3s 阈值余量 ≈1.1s | observed | §18 验收脚本经真实 handler 回放兜底；若真实端到端均值 >3s，按实测热点再评估（不回退本设计） |

### Open Decisions Requiring the User

无。验收口径（六词平均 ≤3s、≤6 文件 ≤800 行、不动 schema）已由用户明确。

### Rejected Speculation

- 搜索投影表 / FTS5 trigram / 新索引：用户明确否决存储增长；且 P0 实测已达标。
- 批量 75/100、候选窄 SELECT：实测再省 ≤0.08s / 0.01s，不抵 diff 与停顿风险。
- 预览文本按宽度截断：验收无需；引入显示语义变化风险。
- `DialogSelect` 选中项身份化：属既有展示行为，不在本需求，改动即越界。

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

（R3 实现后经双审计归因复核发现四项本次引入/扩大回归，R4 修订并清空 approval，重新全范围审计；见 §10 R3→R4 修订原因与 §24 记录。）

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01（abort-supersede 丢弃仍被需要的预览键，reachable，INV-05/用户体验约束）——R2 以「abort 不缩小覆盖范围，被 abort 代未缓存键随下一代携带」修复 | (1) 既有预览用例数为 12 非 10；(2) `冷存储` 预览占比实为 53–56%；(3) 预览请求数实为 14–15；(4) `httpapi-exercise` preview 探针应入验证清单；(5) 传输开销应入风险表 | BLOCK | task ses_ee9359b86ffeB8WENFNFhd6hom |
| 2 | R2 | yes | No blocking findings. | (1) §10 「missing 为空」括号句与 abort 次序的文字瑕疵（实现时扫清，不改合同）；(2) §8 「80–95%」与重算 80.7–92.2% 的约 3pp 近似差 | APPROVE（Release verdict 原文：「APPROVE — applies exclusively to plan revision R2 as audited. Permitted transition per policy: Status: approved, Approved revision: R2, Implementation allowed: yes. Any substantive edit after this verdict invalidates it and requires a new full-scope audit.」；B-01 re-check: resolved） | task ses_ee9359b86ffeB8WENFNFhd6hom |

R2→R3 修订说明：R2 获 APPROVE 后进入实现；TDD 红绿中发现 R2 的 abort+carry 机制在 Solid 级联信号写下产生定时相关的重复请求（实测：title [c] 后 phase 切换即在途重发 [c]，请求序列随定时漂移），属实质行为差异，按流程递增 revision、清空 approval 并重新全范围审计。R3 仅替换预览 effect 的代际管理机制（审计 B-01 修正方向中认可的「在途代完成 + abort 仅限 dispose」），其余范围、文件计划、不变量与验收口径不变。

| 3 | R3 | yes | No blocking findings. | (1) §15 dialog 行仍写「abort…语义保留」，R3 下仅 dispose-abort 与静默失败保留（文字扫尾，已修）；(2)（沿用）§8 「80–95%」与重算 80.7–92.2% 的约 3pp 近似差 | APPROVE（Release verdict 原文：「APPROVE — applies exclusively to plan revision R3 as audited. Permitted transition per policy: Status: approved, Approved revision: R3, Implementation allowed: yes. Any substantive edit after this verdict invalidates it and requires a new full-scope audit.」） | task ses_ee9359b86ffeB8WENFNFhd6hom |
| 4 | R4 | yes | No blocking findings. | (1) §19 预算口径漂移（已修）；(2) §18「既有 12 用例」过时（已修为 15）；(3) §10/§17 「不得以 10% 放行」措辞不精确——10% 为不阻塞下限、15% 为交付目标（已修）；(4) §23 需在 R4 实施后按新 diff 重写；(5) 已披露的跨 query 在途响应残余窗口（§20 第 3 行覆盖）；(6) slice 8 的 limit 半边 red 依赖 SQLITE_MISMATCH 复现，重复 ID 半边保持 red-capable | APPROVE（Release verdict 原文：「APPROVE — applies exclusively to plan revision R4 as audited. Permitted transition per policy: Status: approved, Approved revision: R4, Implementation allowed: yes. The R4 implementation must refresh §23 for the new diff and undergo a full-scope implementation audit against the total HEAD→final diff before completion. Any substantive edit after this verdict invalidates it.」） | task ses_ee9359b86ffeB8WENFNFhd6hom |

## 23. Implementation Evidence（R4 最终 diff）

### Actual Files and Diff

| File | Change | Diff（numstat） |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | 预览 effect 置换：身份快照 {id,key} + 版本键缓存（单 query 生命周期，search() 变化清空）+ 在途去重 + latest 守卫 + 空结果记账；代间不 abort，abort 仅限 dispose | +56 / −9 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | preview handler：窗口 CTE → 逐 session 索引早停查询；输入侧 Set 去重 + floor(limit)；谓词/归一化/响应形状逐字保留；修正过时「窗口函数」说明 | +63 / −59 |
| `packages/opencode/test/cli/cmd/tui/dialog-session-list.test.tsx` | 新增 8 用例（增量去重/版本键重取/空记账/失败重试/在途去重/迟到版本守卫/browse 身份漂移守卫/改词刷新恢复）+ harness 暴露 emit/sync | +304 / −2 |
| `packages/opencode/test/server/session-preview.test.ts` | 新增 5 用例（等时戳 id 定序/part 逆序/最新不可见回退/重复 ID 集合语义/非整数 limit floor 语义） | +134 / 0 |

生产文件 2 个（≤6）；生产增删 119+68=187 行（≤800）；无 `*.sql.ts`/`migration/`/SDK/wire 变更。

### Red-Green Test Evidence

- dialog 6 个 R3 用例对旧代码 RED（旧实现同搜索发 5 次 preview POST）；R4 新增 2 用例对 R3 实现 RED：browse 身份漂移（迟到 v1 响应被重算的 v2 键误判丢弃，frame 无 text-a）、改词重搜不刷新（第二次 preview POST 超时未发）。修复后 GREEN（14/14）。
- server 3 等价护栏在旧窗口 SQL 上 GREEN（语义保持基线）；R4 新增 2 输入域用例对 R3 实现 RED（重复 ID 重复追加；limit=1.5 报错）。修复后 GREEN（17/17）。
- 性能 RED→GREEN：验收回放基线均值 6573ms（>3s）→ R4 实施后新协议均值 2301ms（≤3s）。

### Verification Commands and Results

| Command | cwd | Result |
| --- | --- | --- |
| `bun test test/server/session-preview.test.ts` | packages/opencode | 17 pass / 0 fail（92.7s） |
| `bun test test/cli/cmd/tui/dialog-session-list.test.tsx` | packages/opencode | 14 pass / 0 fail（13.3s） |
| `bun test test/cli/cmd/tui/session-list-params.test.ts` | packages/opencode | 12 pass / 0 fail |
| `bun test test/server/session-list.test.ts` | packages/opencode | 23 pass / 0 fail（91.2s） |
| `bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip` | packages/opencode | pass=158 fail=0 skip=0 missing=0 |
| `bun typecheck` | packages/opencode | clean |
| `git diff --numstat` / `git status` | repo root | 生产 2 文件 +119/−68、无 schema/migration 变更 |

### Original Feedback-Loop Result

验收回放（真实 `Server.listen` + 副本库，path scope）：R4 实施后 old 协议均值 3786ms（仅服务端 SQL 生效），**new 协议均值 2301ms ≤ 3s ✓（INV-06）**；R3 轮次实测 1790ms（暖）/2349ms（冷），R4 的输入规范化不改变热路径形状。

（基线 per-keyword 值取自实施前运行日志：5353/5300/6828/6463/7942/6836，均值 6573ms。验收脚本曾覆写自身基线文件，已改为时间戳文件名；digest 等价由下方 SQL 级全量证明独立兑底。）

等价性证据链：

1. 跨协议 digest 全等：old/new 协议同关键词 sessionDigest + previewDigest 逐词一致。
2. `D:\Temp\opencode\preview-sql-equivalence-20261008.mjs`：旧窗口 SQL（git HEAD 原文）与新 SQL 在全部 5353 session × limit 1/2/3/10 逐字节一致（digest MATCH）；R4 的去重/floor 是循环前输入规范化，不改变该 SQL 形状。
3. 服务端 17 测试含等价护栏与输入域护栏全绿。

### Actual Secondary and Replacement Path Inventory

| Path | Disposition |
| --- | --- |
| 预览失败静默（不写缓存、下触发重试） | 保留原样 |
| 浏览态（空 query）预览共用同一 effect | 保留，同享版本键去重与身份快照 |
| 空预览记账 `[]` 入缓存 | 新增（防重取，不产出数据） |
| 每批整集合预览重取 | 已删除（被单 query 生命周期的版本键缓存取代；改词重搜的刷新恢复路径经 query 边界清空保留） |
| 窗口函数全历史排名 SQL | 已删除（被索引早停查询取代） |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 427（生产+测试口径，新增代码行） | 机械统计 git diff；排除空行、注释行、11 行纯移动（含归一化/过滤行） |
| Qualifying Chinese comment lines `C` | 83 | 排除 3 行纯移动旧注释；其余均为不变量/边界/契约解释（身份快照防 reconcile 突变、单 query 生命周期恢复改词刷新、Set 去重保持 IN 集合语义、floor 对齐 msg_rn、索引早停与窗口排名等价、在途去重边界、wire 缺省 ID 契约、失败重试语义、测试意图与视口证据边界等） |
| Ratio `C / E` | 83/427 ≈ 19.4% | — |
| Required minimum `C` | 65（15% 目标线） | `ceil(427 × 0.15)`；10% 下限=43 亦已越过 |

### Remaining Unverified Items

- 真实终端肉眼渲染未复核（预览行渲染代码路径未改，frame 断言已覆盖预览行出现）。
- 冷缓存（进程首启、OS 页缓存冷）SLA 未测；实测冷跑 2349ms、R4 复跑 2301ms 均 ≤3s。
- 跨 query 在途响应残余窗口已披露（§20）：改词瞬间在途的旧 query 响应会回填刚清空的缓存，最旧展示一个触发周期；窄于任务前既有陈旧窗口。
- 验收基线 per-keyword 值依赖运行日志记录；digest 等价已由 SQL 级全量证明独立建立。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R3 | yes | No blocking findings. | (1) §23 diff 数字口径漂移（已按 numstat 实测修正）；(2) 验收基线文件被覆写（已披露，RED 侧由 bench 基线 10.72s 兑底）；(3) E/C 重算 14.7%（生产+测试口径，高于 10% 阻塞线、略低于 15% 目标线） | APPROVE（后经双审计归因复核推翻：R3 实现存在四项本次引入/扩大回归，见 §10 R3→R4 修订原因） | task ses_ee9359b86ffeB8WENFNFhd6hom |
| 2 | R4 | yes | No blocking findings. | (1) E/C 口径说明（两种计数均 ≈19%，达 15% 目标）；(2) §23 既有披露项保持（未肉眼渲染、冷缓存 SLA、基线日志化、跨 query 在途残余窗口） | APPROVE（Release verdict 原文：「APPROVE — the actual HEAD→final diff of dialog-session-list.tsx, handlers/session.ts, dialog-session-list.test.tsx, and session-preview.test.ts against canonical plan revision R4 is released. All hard gates pass under auditor reproduction: six verification commands green, INV-06 acceptance artifact-backed at 2301ms ≤ 3s, equivalence digest chains intact, E/C gate met at ≈19%.」；六条验证命令与验收产物由 auditor 独立复跑/复核一致） | task ses_ee9359b86ffeB8WENFNFhd6hom |
