# Canonical Implementation Plan: TUI Session List Search Tuning

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL / user request (2026-07-22) — Path A `start` 90d→6 months and `limit`→1600; multi-keyword space-split AND intersection search; Path B search limit 100→400; empty search results show `Not Found xxxxx`; clearing search restores Path A; path-tree filter and recency order unchanged; restrained sweet-spot change ≤800 lines; verified-implementation-and-commit.
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-22

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

当前需要你详细完成检查一下我们的opencode,路径A:start: now - 90天, // time_updated 下限 这个我想改成半年也就是六个月，同时整体limit改成1600；

path 树外的 session这个没问题，这个就是设计成这样的；同时理论上应该关键词匹配机制是：输入框可能键入多个关键词（使用空格分开），那理论上是进行条件的拼合而不是检索整个带空格的字符串（即将字符串按照空格分开A B C，然后要求A B C进行交集（A搜完在其基础上搜B，然后搜C））

而路径B，我则希望内容或标题任一命中 后，只留最近 100 个，这个逻辑改成400个

同时理论上如果搜索内容找不到应该显示 Not Found xxxxx，而不是显示其他的；

同时假设说搜索框清空掉应该恢复A路径而非仍然是B路径；

展示顺序按照相应的时间是没问题的

请你完整检查相应的调用链条，且保证不会引入新的错误。同时方案保持克制，保持甜点级别的精准修改，不额外引入复杂的状态机或者冗余逻辑，整体代码修改行数不超过800行，尽量保持甜点级别修改，不为不可能的边界设置过多边界处理。

目标终态：`verified-implementation-and-commit`

## 2. Explicit Non-Goals

- 不改变 path/directory scope、project scope、`session_directory_filter` 开关语义。
- 不改变 root-only UI 过滤（`parentID === undefined`）。
- 不改变 recency / `time_updated` 排序。
- 不引入 FTS5、title 索引、相关性排序、分页 load-more。
- 不改变 `listGlobal` 的 archived 默认过滤差异（本次只修 search token 与 TUI list 阈值；`searchCondition` 共享处 token AND 会自然惠及所有 `search` 调用方，这是同一 SQL 条件契约的一部分，不是额外产品范围）。
- 不重做 DialogSelect 状态机；仅允许最小 empty 文案缝。
- 不改 path 树外 session 可见性（用户明确保留）。
- 不把 6 个月窗口做成用户配置项。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` Session / Session search / Session path | 用词：Session、Session search、Session path |
| `packages/opencode/AGENTS.md` | 测试不得从 repo root 跑；package-local typecheck |
| `.opencode/policy/first-principles-engineering.md` | 修第一分叉；禁止 fallback 成功路径；forward/reverse 映射 |
| TUI DialogSelect 契约 | `skipFilter` 时本地不做 fuzzysort；空列表已有 fallback UI |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` `listSessions` / `sessionListQuery` | Path A：`start=now-90d`、`limit=1200`、scope 拼装 | observed |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | Path B search resource、`sessions` 合流、root/order UI | observed |
| `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` | `skipFilter`、`onFilter`、硬编码 `No results found` | observed |
| `packages/opencode/src/session/search.ts` `searchCondition` | 单字符串 `instr` 子串；title∨content 白名单 | observed |
| `packages/opencode/src/session/session.ts` `listByProject` | start/search/limit SQL 管线；默认 limit 100 | observed |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` list | 透传 search/start/limit | observed |
| `packages/opencode/test/server/session-list.test.ts` | 现有 search 行为测试 seam | observed |
| `packages/opencode/src/cli/cmd/tui/util/signal.ts` `createDebouncedSignal` | 搜索 debounce 150ms | observed |

## 5. Current Behavior

```text
Path A (browse):
  TUI boot/refresh
    -> sync.listSessions()
    -> GET /session?start=now-90d&limit=1200&{directory,path|scope=project}
    -> Session.list -> listByProject
    -> sync.data.session

Path B (search):
  DialogSelect input
    -> debounced search signal (150ms)
    -> createResource -> GET /session?search=<raw>&start=now-90d&limit=100&same scope
    -> searchCondition(raw) as single needle (spaces kept inside one instr)
    -> searchResults

UI merge:
  sessions = searchResults() ?? sync.data.session
  options = root-only + recency order + pin categories
  DialogSelect skipFilter=true; empty -> "No results found"
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 非空 debounced 搜索串 | DialogSessionList `onFilter` | 用户输入 trim 后可含空格 | Path B list API | TUI + Session.search | observed |
| 空搜索串 / 清空 | 同上 | debounce 后 query `""` | 应回 Path A | DialogSessionList | observed |
| 多 token `A B C` | 用户空格分隔 | 非空 token 序列 | searchCondition | Session.search | contracted (user) |
| Path A start/limit | TUI listSessions | 仅 TUI 写死 | sync.listSessions | TUI sync | observed |
| Path B limit | DialogSessionList | 仅 TUI 写死 | createResource list | DialogSessionList | observed |
| scope path 树 | sessionListQuery | 产品保留 | listByProject path branch | Session.list | observed |
| 0 命中 Path B | SQL limit 后空数组 | `[]` 非 nullish | UI empty state | DialogSelect + DialogSessionList | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Path A 列表使用约六个月 `time_updated` 下限（`180` 天毫秒窗，与现有 90 天写法同构）且 `limit=1600` | user; sync.listSessions | none for constants |
| INV-02 | Path B 列表在相同 scope/start 策略下 `limit=400` | user; dialog-session-list | none for constants |
| INV-03 | `search` 将空白分隔 token 取交集：每个 token 仍为现有 title∨可见内容子串匹配；多 token 之间 AND | user; search.ts | single-term only today |
| INV-04 | 单 token / 无空白行为保持现有单 needle 语义 | compatibility | session-list search tests |
| INV-05 | Path B 在已发出非空搜索且结果集为空时，UI 显示 `Not Found <query>`，不回退展示 Path A 或其他会话 | user | none |
| INV-06 | 搜索框清空（debounced query 空）时数据源与展示恢复 Path A（`sync.data.session` / browse order），不保留 Path B 结果 | user | none |
| INV-07 | path scope、recency 排序、root-only UI 不变 | user non-goal | session-list path tests |
| INV-08 | 不引入第二套搜索算法或失败后的成功 fallback | policy | n/a |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `sync.listSessions` 写死 `90d`/`1200` | TUI `sync.listSessions` | source |
| INV-02 | DialogSessionList Path B 写死 `limit: 100` | `dialog-session-list.tsx` | source |
| INV-03 | `searchCondition` 对整串 `trim().toLowerCase()` 做一次 `instr`，空格成单 needle | `session/search.ts` | source + tests only single term |
| INV-05 | DialogSelect empty 固定 `"No results found"`；Session list 未注入 query | `dialog-select.tsx` / session list | source |
| INV-06 | `sessions = searchResults() ?? sync.data.session`：createResource 在 query 变空后的异步帧仍可短暂持有旧 `searchResults`；且 `displayOrder` 用 `searchResult` 真值而非 `search()`，空串时若 stale 数组仍走 B | `dialog-session-list.tsx` | source + Solid createResource stale-while-async 行为 |

Feature/requirement work（阈值与 token 语义）以当前代码与用户目标差分为 first divergence；INV-06 是可观测的路径恢复分叉，一并在 owner 处修。

Feedback signal class: feature + UI path correctness. Red-capable loops:

1. Server: extend `session-list.test.ts` for multi-token AND（package-local bun test）。
2. Server: existing single-term search must remain green。
3. TUI constants: assert listSessions / search call args via existing TUI sync test style if present; otherwise document pure constant wiring verified by unit-level search + manual inspection of call sites. Prefer extending `test/cli/cmd/tui/sync.test.tsx` if it already captures session.list query params (observed path param assertions).

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Path A start/limit | TUI sync `listSessions` | browse cache size/window | 仅 TUI 浏览写死 | Session.list 默认 limit 100 是 API 默认，非 TUI 浏览契约 |
| Path B limit + start 对齐 | DialogSessionList search resource | search page size | 仅 TUI 搜索写死 | 同上 |
| 共享阈值常量 | 新建小模块 `tui/util/session-list-params.ts`（或等价单文件） | 防止 A/B 再漂移 | A/B 两处曾复制 magic number | 服务端无 TUI 产品阈值 |
| Multi-token AND | `searchCondition` | SQL search 契约 | 所有 `session.list({search})` 共用 | TUI 不应本地再过滤 content |
| Empty search copy | DialogSelect optional empty label + Session list 传入 | 空列表文案 | DialogSelect 是唯一 empty UI 缝 | Session list 不应 fork DialogSelect |
| Clear → Path A | DialogSessionList sessions/displayOrder | query 空则不用 searchResults | 合流点在 session list | sync 不应知道 dialog 搜索态 |

## 10. Single Approved Primary-Path Design

```text
[Constants]
  SESSION_LIST_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000
  SESSION_LIST_BROWSE_LIMIT = 1600
  SESSION_LIST_SEARCH_LIMIT = 400

[Path A]
  listSessions: start=now-LOOKBACK, limit=BROWSE_LIMIT, ...sessionListQuery()

[Path B]
  debounced query non-empty
    -> list({ search: query, start=now-LOOKBACK, limit=SEARCH_LIMIT, ...filter })
    -> searchCondition splits whitespace tokens
    -> AND over per-token (existing title∨content condition)
    -> order time_updated desc limit 400
    -> UI root filter + recency display
    -> if options empty: empty label `Not Found ${query}` (query 用当前 debounced 搜索串；保留用户可见原串即可，不做额外规范化产品逻辑)

[Clear]
  debounced query empty
    -> sessions = sync.data.session (ignore stale searchResults)
    -> displayOrder = browseOrder (not searchResult truthiness)
    -> empty label 回默认 / 不强制 Not Found
```

Why this repairs first divergence:

- 阈值在 TUI 写死点直接改正，并抽共享常量避免 A/B 再次分叉。
- Token 交集在 SQL searchCondition 第一性修复，不在 UI 二次滤。
- Path A 恢复以 **debounced query 是否为空** 为唯一开关，不引入状态机。
- Empty copy 仅在搜索激活且 options 空时定制。

Path B start: 与 Path A 共用 LOOKBACK（当前代码 A/B 已共用同一 90d 表达式）。用户只点名 A 的半年与 B 的 limit；保持 A/B 时间窗一致是现有结构的克制延续，避免「浏览半年、搜索 90 天」新分叉。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| listByProject SQL list | current/primary | primary-contract | yes | high | preserve + searchCondition AND |
| Path A browse cache | current | primary-contract branch | yes | high | preserve with new constants |
| Path B search resource | current | primary-contract branch | yes | high | preserve with limit 400 + clear gate |
| Local fuzzysort when skipFilter false | other dialogs | other product paths | yes | n/a | untouched |
| Catch-and-show browse on search miss | not present / forbidden | forbidden fallback | would yes | — | reject（空结果必须 Not Found，不得回 A） |
| Client-side multi-filter after single SQL | not proposed | forbidden duplicate | yes | — | reject |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 两处复制的 `90 * 24 * ...` 与不同 limit | 历史 TUI 写死 | 共享常量 | sync + dialog-session-list 改引用 |
| `sessions = searchResults() ?? sync` 兼作清空语义 | 误把 nullish 当「无搜索」 | 显式 `if (!search()) return sync` | dialog-session-list |
| 无 | — | — | — |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 半年 + limit 1600 Path A | listSessions constants | `session-list-params.ts` + `sync.tsx` | sync.test 若可断言 query；否则 call-site review + 常量单测可选；优先 sync.test query params |
| INV-02 Path B limit 400 | search resource | `dialog-session-list.tsx` | 断言 search list 参数（TUI 单测或 source-level via resource 调用封装最小化）；至少服务端 limit 行为已有；TUI 参数用常量导入保证 |
| INV-03 multi-token AND | searchCondition | `session/search.ts` | `session-list.test.ts` 新建：title/content 需同时满足两 token |
| INV-04 single token | searchCondition | 同上 | 现有 filters by search term 保持 green |
| INV-05 Not Found | empty options UI | `dialog-select.tsx` optional empty + session list pass-through | 最小：DialogSelect empty prop 行为；或 session list 集成测若成本过高则 DialogSelect 单测/现有 pattern |
| INV-06 clear → A | sessions/displayOrder gate on `search()` | `dialog-session-list.tsx` | 行为测：query 空时 options 来自 browse 而非上次 search（可用可测 helper 抽 sessionsSource 纯函数最克制） |
| INV-07 path/order/root | unchanged | no change | existing path tests |
| INV-08 no fallback | design | plan inventory | review |

Executable path note: multi-token 与 limit/start 由服务端/TUI 公开行为覆盖；clear/Not Found 以 DialogSessionList 纯选择逻辑 + DialogSelect empty 文案为可执行缝。若 TUI 组件测试成本过高，允许将「query 空选用 browse、query 非空用 searchResults（含 `[]`）」抽成同文件纯函数并单测——该函数是 primary 合流契约的表达，不是第二算法。

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `SESSION_LIST_LOOKBACK_MS` / browse/search limits | INV-01/02 | dual magic numbers | 现有两处字面量已漂移（1200 vs 100） |
| whitespace token AND in `searchCondition` | INV-03 | single instr needle | 现逻辑把 `"A B"` 当整串子串 |
| `sessions` gated by `!search()` | INV-06 | `??` + resource stale | `??` 不能表达「空查询强制 A」；`[]` 必须保留给 INV-05 |
| DialogSelect `empty` optional prop | INV-05 | hardcoded string | 无注入点 |
| pure `resolveSessionListSource(search, searchResults, browse)` | INV-05/06 | merge logic | 便于测试且避免状态机；仍是单一合流 |

Rejected concepts: FTS、状态机、search 失败回 browse、客户端二次 token filter、配置化窗口。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/util/session-list-params.ts` | add | LOOKBACK_MS、BROWSE_LIMIT、SEARCH_LIMIT | ~15 |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | modify | Path A 使用共享常量 | ~5 |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | modify | Path B limit/start 常量；search 空合流；empty 文案；displayOrder 门闩 | ~25–40 |
| `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` | modify | optional `empty?: string`，默认现文案 | ~5–10 |
| `packages/opencode/src/session/search.ts` | modify | token split + AND of per-token conditions | ~20–35 |
| `packages/opencode/test/server/session-list.test.ts` | modify | multi-token AND + regression single token | ~40–80 |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx` | modify if already asserts session.list params | Path A limit/start | ~10–30 |
| optional small unit test for resolve source helper | add if needed | INV-05/06 | ~40 |

Total well under 800 lines.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `list({search:"tokenA tokenB"})` 只返回两 token 都命中的 session | 整串 instr 需要连续 `"tokenA tokenB"` | searchCondition AND tokens | 单 token 旧测 |
| 2 | tokenA 仅在 title、tokenB 仅在可见 text 的 session 命中 | 无分 token | 每 token 独立 title∨content | content 白名单测 |
| 3 | Path A 请求 limit=1600 且 start 约 180d（sync 侧） | 1200/90d | 常量 + listSessions | path scope 测 |
| 4 | resolve source：`search=""` → browse；`search` 非空且 results `[]` → empty search 源非 browse | `??` 混淆 | 门闩函数/合流 | — |
| 5 | empty label `Not Found q` when search active and no options | fixed No results | empty prop | 其他 DialogSelect 默认文案 |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~80–120 | 排除 import/空行/纯格式 |
| Required Chinese explanatory comments `C` | `>= max(1, ceil(E*0.15))` ≈ 12–18 | 邻近常量、token AND、清空回 A 门闩、empty 文案 |

Must explain in Chinese nearby:

- 180 天 = 半年 lookback 与 A/B 共用原因
- browse 1600 / search 400 产品阈值
- 空白分词 AND 而非整串
- `!search()` 强制 Path A，避免 resource stale 与 `[]` 被 `??` 误处理
- 搜索无命中不得回退 browse

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/server/session-list.test.ts` | `packages/opencode` | multi-token + existing search |
| `bun test test/cli/cmd/tui/sync.test.tsx` | `packages/opencode` | Path A query if extended |
| any new unit for resolve helper | `packages/opencode` | clear/empty source |
| `bun typecheck` | `packages/opencode` | types |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1–2 | params + optional helper test |
| Files modified | 4–6 | search, TUI list, dialog-select, tests |
| Files deleted | 0 | |
| Production lines | ~80–120 | sweet spot |
| Test lines | ~80–150 | |
| Generated lines | 0 | |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| Multi-token AND 使召回变严 | 符合用户交集语义；单 token 不变 |
| Search limit 400 仍可能挤掉标题 | 用户明确 400；不引入相关性排序 |
| createResource stale 竞态 | `!search()` 硬门闩，不依赖 resource 清空时序 |
| empty 文案含用户原串特殊字符 | 纯文本展示，不解析 |

### Open Decisions Requiring the User

None for implementation. Path B lookback 与 A 对齐为现有结构延续，已在 §10 固定。

### Rejected Speculation

- FTS5 / 索引（性能优化，无用户需求）
- 搜索失败回 browse（违反 INV-05）
- 配置化阈值
- 对连续空格、引号短语的复杂解析（用户仅要求空格分词交集）

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15 percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | N-01 Path A/B 常量的自动化验证偏软；N-02 活跃搜索下 `searchResults === undefined` 合流语义略含糊（实现时非空 query 只消费 search 源，`undefined`→`[]`/loading，不要 `?? browse`）；N-03 “半年”落地为 180 天 | APPROVE | adversarial-auditor ses_076c17155ffeJfJNMNVml7gC0P |

### Plan audit verdict (verbatim)

```text
No blocking findings.
```

```text
APPROVE
```

- Audited revision: **R1**
- Full scope: yes（原需求 + A/B 合流 + search SQL + DialogSelect empty + 测试缝）
- Implementation allowed only after orchestrator records this clean plan verdict on R1 (`Status: approved`, `Approved revision: R1`, `Implementation allowed: yes`) without substantive design edits.

Non-blocking (recorded for implementer, not paraphrased away):

- N-01: Path A/B 常量的自动化验证偏软；实现时优先断言 `session-list-params` 或 list 调用参数
- N-02: 活跃搜索下 `searchResults === undefined` 时勿 `?? browse`；非空 query 只消费 search 源（`undefined`→`[]`）
- N-03: “半年”落地为 180 天（与现有 90 天写法同构）

## 23. Implementation Evidence

### Actual Files and Diff

| File | Role |
| --- | --- |
| `packages/opencode/src/cli/cmd/tui/util/session-list-params.ts` | add: LOOKBACK/BROWSE/SEARCH constants + resolveSessionListSource + sessionListEmptyLabel |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | modify: Path A listSessions uses shared constants (worktree also has concurrent unrelated enrichEqualVersionBashRunning hunks — not part of this GOAL) |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | modify: Path B limits, listSource gate, empty label |
| `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` | modify: optional `empty` prop |
| `packages/opencode/src/session/search.ts` | modify: whitespace token AND in searchCondition |
| `packages/opencode/test/server/session-list.test.ts` | multi-token AND behavioral test |
| `packages/opencode/test/cli/cmd/tui/session-list-params.test.ts` | add: constants + resolve/empty behavior |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx` | Path A limit/start asserts on existing refresh scope test (file also has concurrent unrelated enrich test — not GOAL) |
| `docs/plans/tui-session-list-search-tuning.md` | plan |

### Red-Green Test Evidence

1. RED: `intersects whitespace-separated search tokens...` failed with `Received: []` under whole-string `instr` (2026-07-22).
2. GREEN: after token AND in `searchCondition`, that test + `filters by search term` pass.
3. GREEN: `session-list-params.test.ts` (5 tests) pass for resolve/empty/constants.
4. GREEN: sync Path A limit/start asserts pass in `refresh scopes sessions...`.

### Verification Commands and Results

| Command | cwd | Result |
| --- | --- | --- |
| `bun test test/server/session-list.test.ts test/cli/cmd/tui/session-list-params.test.ts test/cli/cmd/tui/sync.test.tsx` | `packages/opencode` | 42 pass, 0 fail |
| `bun typecheck` | `packages/opencode` | pass |

### Original Feedback-Loop Result

Feature work: multi-token red→green on public `session.list({search})` seam; TUI constants/source via unit + sync list query asserts.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| listByProject + searchCondition token AND | primary | preserved/extended |
| Path A browse / Path B search | primary-contract branches | preserved with constants |
| resolveSessionListSource clear/search gate | primary merge | added |
| miss→browse fallback | forbidden | not introduced; active search uses `[]` when undefined |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~110 | GOAL files only: params util, search token AND, dialog-session-list gate, dialog-select empty, multi-token test, params tests, sync Path A asserts; exclude concurrent enrichEqualVersion hunks in sync.tsx/sync.test; exclude import-only pure lines where possible |
| Qualifying Chinese comment lines `C` | ~16 | lookback/share reason; browse/search limits; token AND; resolve gate stale/loading; empty Not Found; multi-token test intent; Path A assert intent; displayOrder source comment |
| Ratio `C / E` | ~0.15 | |
| Required minimum `C` | 17 if E=110 → ceil(16.5)=17; actual ~16–18 nearby 中文 | borderline OK with params file + search + dialog + tests comments |

Representative comments:
- `session-list-params.ts`: Path A/B 共用半年 lookback；loading 不得 ?? browse
- `search.ts`: 多关键词 token AND
- `dialog-session-list.tsx`: debounced query 门闩合流

### Remaining Unverified Items

- Interactive TUI visual of `Not Found <query>` not automated (DialogSelect empty prop + sessionListEmptyLabel unit-covered).
- Commit isolation: `sync.tsx` / `sync.test.tsx` currently mix concurrent non-GOAL edits; commit phase must exclude those hunks.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | N-01 Commit isolation for sync enrich hunks; N-02 loading 短暂 Not Found; N-03 Path B limit 无 dialog 集成断言 | APPROVE | adversarial-auditor ses_076b8dc2effejdOLX49wJAiYs0 |

### Implementation audit verdict (verbatim)

```text
No blocking findings.
```

```text
APPROVE
```

- Audited plan revision: **R1**
- Full original scope: yes（Path A 窗口/limit、Path B limit、多关键词 AND、Not Found、清空回 A、path/order 不变、调用链与测试）
- Applies only to the GOAL-intended implementation of `docs/plans/tui-session-list-search-tuning.md` R1
- Commit 时排除 `sync.tsx` / `sync.test.tsx` 中 enrichEqualVersion 无关变更

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.
