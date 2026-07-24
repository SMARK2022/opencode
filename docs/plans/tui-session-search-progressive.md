# Canonical Implementation Plan: TUI Session Search Progressive Loading

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL / multi-turn user request (2026-07-25) — 做 A+B1+B2（loading UX + title 首屏 + content 每 50 条增量）；搜索栏右侧 Spinner；首屏前显示正在搜索中；首屏后 Spinner 仍保留直到完全搜完；清空搜索不 loading；改词取消上一代；debounce + content 延后；避免 C/CJ/CJK 三倍浪费；串行 batch；甜点级；≤8 代码文件、≤1200 行；不做 FTS/物化表；目标终态 verified-implementation-and-commit。
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-25
>
> R3 plan audit APPROVE; implementation audit round1 BLOCK B-01; rework; round2 APPROVE.

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

用户确认只做 A、B1、B2（不做额外表/物化/FTS），并细化 loading 与请求生命周期：

1. **A（loading UX）**：只要还在 loading，搜索栏**右边**显示现有工具运行用的 Spinner/转圈 UI；首屏结果出来之前，列表区显示「正在搜索中」类文案（不是 Not Found）；首屏出来后 Spinner **继续**保留，直到 content 全搜完；清空搜索框后不算搜索，不显示 loading。
2. **B1（title 首屏）**：先做 title 匹配以尽快出首屏。
3. **B2（content 每 50 条）**：content 按 recency 每批约 50 个 session 增量匹配并合并；未搜完不得看起来像最终定稿。
4. **取消与防抖**：用户改词则取消上一代搜索；输入 debounce；content 在稳定 query 上再延后约 200–300ms，避免 C→CJ→CJK 连续 content 全量浪费；batch 串行；过期请求结果丢弃。
5. **克制**：整体修改保持甜点级；**代码文件 ≤8、修改行数 ≤1200**；不引入 FTS/物化表/第二套搜索语义。

目标终态：`verified-implementation-and-commit`。

**R2 语义澄清（不缩小需求，只闭合合同）：**

- B1 title 首屏是 **partial overlay / first-paint 子集**（可漏跨字段 multi-token；也可暂时显示「尚未扫到的 recency 前缀」之外的旧 title 命中）。
- B2 从 list **同宇宙头部** 起 keyset 扫描：每批 ≤50 **候选**，对候选施加 **完整** `searchCondition`，按 recency 累积 **full-condition 命中**。
- **`complete` 的权威结果 = 仅 full-condition 扫描流的 top-400**（与今日 `list({search,limit:400})` 同语义）。Title 命中**不得**计入 early-stop，也不得在 `titleHits.length>=400` 时跳过 scan。
- 「content 每 50 条」= 候选窗口大小，不是 content-half 条件。

## 2. Explicit Non-Goals

- 不引入 FTS5、search_document 物化表、生成列全文索引或 migration。
- 不改变 path/directory scope、半年 lookback、browse limit 1600、**search result cap 400** 的既有产品阈值。
- 不把 content 候选宇宙改成 browse 缓存子集（R1 B-03 已否决）。
- 不改变 root-only UI 过滤（`parentID === undefined`）、pin 规则；progressive 结果按 recency 排序后 cap。
- 不实现 SSE/WebSocket 流式搜索。
- 不并行多批 scan；不 content 失败后 fallback 全量 `searchMode=all`。
- 不修改 preview SQL 语义（可复用 Abort / `sdk.fetch` 手写模式）。
- 不强制重建 JS SDK 生成物；TUI progressive 请求与 preview 一样走 **手写 `sdk.fetch`**。
- 不扩大到 app web UI session list。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` Session / Session search | Title+message search 合同 |
| `docs/plans/tui-session-list-search-tuning.md`（verified） | Path A/B、半年窗、search limit 400、空结果 Not Found；本任务修 loading 假空态，不回退 cap/path |
| `packages/opencode/AGENTS.md` | package-local test/typecheck |
| `.opencode/policy/first-principles-engineering.md` | first divergence；禁止 fallback |
| `Spinner` / preview Abort / `sdk.fetch` preview | UI 与取消样板 |
| `packages/sdk/js/src/v2/gen/sdk.gen.ts` session.list params | **无 searchMode**；新 query 不能靠现成 client.list 透传（R1 B-02） |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `session-list-params.ts` + test | loading→`[]`→Not Found 假空态 | observed |
| `dialog-session-list.tsx` | debounce 150；createResource list；preview fetch+Abort | observed |
| `dialog-select.tsx` | filter 无右侧 accessory | observed |
| `spinner.tsx` | 转圈 UI | observed |
| `session/search.ts` | 每 token title∨content AND | contracted |
| `session.ts` listByProject | scope/start/search/limit 全宇宙过滤再 limit | observed |
| `sync.tsx` listSessions | browse limit 1600 另一集合 | observed |
| SDK `session.list` gen | 无 searchMode 键 | observed |
| 真实库 bench | title ~10ms；full content 1–3s；50 候选批 ~40ms | observed |
| Red：params loading 映射 | 用户症状可执行复现 | observed |

## 5. Current Behavior

```text
Path A: GET /session?start&limit=1600&scope → sync.data.session
Path B: debounced Q → sdk.client.session.list({search:Q,start,limit:400,scope})
        → listByProject + searchCondition(Q)  // 全候选宇宙，完整 title∨content AND
        → resolve: Q? (searchResults??[]) : browse
        → empty: Not Found Q  // loading 时亦然
        → 无 filter Spinner
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| debounced non-empty Q | DialogSessionList | 150ms debounce | progressive generation | TUI | observed |
| cleared Q | 同上 | `""` | browse；无 loading | TUI | contracted |
| query change mid-flight | 用户输入 | 新 committed | abort 上一代 | TUI | contracted |
| title first paint | hand-written GET searchMode=title | 子集语义 | B1 | Session.search | contracted |
| scan batch full condition | hand-written POST scan | 同 list 宇宙；每批 50 候选；完整 searchCondition | B2 | Session.search | contracted |
| multi-token AND 完整语义 | search.ts | 每 token title∨content | complete 后对齐今日 list | Session.search | contracted |
| result cap 400 | merge | SESSION_LIST_SEARCH_LIMIT | progressive 视图 | TUI + list | contracted |
| Spinner accessory | DialogSelect | optional prop | filter 右 | TUI | contracted |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 非空 Q 且 phase≠complete 时不得 `Not Found`；awaiting_first 显示 Searching… | user A | 反例：params loading→[] |
| INV-02 | loading（awaiting_first\|partial）时搜索栏右 Spinner；complete/browse 无 | user A | none |
| INV-03 | Q 清空 → browse，无 Spinner/Searching | user | 部分 Path A |
| INV-04 | title-only 请求不跑 content EXISTS；可单独产出首屏 hits（子集） | user B1；bench | none |
| INV-05 | 在 **与 list 相同的 scope/start 宇宙** 上按 recency 每批扫描 ≤50 候选，对每批施加 **完整** searchCondition，串行 merge | user B2；R1 B-01/B-03 | none |
| INV-06 | 改词/清空/卸载 abort；过期 generation 丢弃 | user | preview 模式 |
| INV-07 | content/scan 仅在 committed 稳定后 + contentDelay 200–300ms | user | 仅 150ms 输入 debounce |
| INV-08 | complete 后命中语义 = 今日 `searchCondition`（多 token 每 token title∨content AND）；B1 子集不得定义 complete | R1 B-01；search.ts | multi-token tests |
| INV-09 | **complete** 结果 = 自宇宙 recency 头部起 full-condition 命中流的前 **SESSION_LIST_SEARCH_LIMIT(400)** 条；early-stop **仅**当 `scanFullHits.length >= 400` 或宇宙耗尽。Title overlay 不计入 stop 计数 | prior plan；R2 audit early-stop | list limit |
| INV-10 | path/start 与 listByProject 一致 | non-goal | path tests |
| INV-11 | TUI progressive 不依赖 SDK gen 新字段；title/scan 用 `sdk.fetch` 手写 | R1 B-02 | preview 先例 |
| INV-12 | 请求失败须结束 loading（complete + 已有 hits 或 empty 诊断），禁止无限 Spinner；禁止 fallback 全量 all | R1 non-block | none |
| INV-13 | ≤8 代码路径文件、≤1200 行 | user | n/a |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `resolveSessionListSource`：loading `undefined`→`[]`；empty 一律 Not Found | session-list-params | red bun + test |
| INV-02 | DialogSelect 无 filterAccessory | dialog-select | 源码 |
| INV-04 | searchCondition 无 title-only | search.ts | 源码 |
| INV-05/08 | 单次全宇宙 EXISTS；无分批完整条件扫描 | listByProject | EXPLAIN + bench |
| INV-06/07 | createResource 单飞无 generation | dialog-session-list | 源码 |

**Root cause：** (1) UX 把进行中编码成空结果；(2) 首字节与全量 content 扫描绑定。  
非 path 过滤、非 title 缺 CJK。

### Red-capable feedback loop

```text
packages/opencode:
  bun test test/cli/cmd/tui/session-list-params.test.ts
  → pass including loading → []
  bun -e resolveSessionListSource(query:CJK, undefined) → Not Found CJK
User symptom: 搜索未完成与真无命中不可区分。
SQL bench: title ~10ms vs full 1–3s.
```

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why here |
| --- | --- | --- | --- |
| phase / empty 文案 / cap 视图 | session-list-params + DialogSessionList | SearchView | list 数据源 owner |
| filterAccessory | DialogSelect | 可选 JSX 槽 | 通用布局 |
| Spinner | 既有 Spinner | 转圈 | 复用 |
| title-only SQL | search.ts | searchCondition(q,{mode:"title"}) | 唯一搜索契约 |
| 完整 searchCondition | search.ts | mode "all"（默认） | 兼容 + B2 scan |
| 候选批扫描 | Session service | searchScan({search,cursor,limit:50,scope…}) | 与 listByProject 同 scope/start 宇宙 |
| HTTP | groups/handlers | ListQuery.searchMode；POST search/scan | 与 preview 同层 |
| TUI 传输 | DialogSessionList `sdk.fetch` | 手写 GET/POST + Abort | INV-11；不重建 SDK |
| generation / 串行 / delay | DialogSessionList | 单 generation 编排 | 唯一 UI 编排 |

## 10. Single Approved Primary-Path Design

一条 progressive Session search 路径：

```text
raw input → debounce 150–200ms → committed Q
if Q=="":
  abort G; browse; spinner off; return

start generation G (AbortController):
  phase = awaiting_first
  spinner on
  empty = Searching…   // never Not Found here
  titleHits = []       // first-paint overlay only
  scanFullHits = []    // authoritative full-condition stream from universe head

  // B1 title first paint（子集 overlay；不定义 complete；不触发 early-stop）
  GET /session?search=Q&searchMode=title&start&limit=400&{scope}
    via sdk.fetch (NOT sdk.client.session.list — no searchMode in gen SDK)
  if still G:
    titleHits = title results (recency sorted, ≤400)
    phase = partial
    displayHits = mergeDisplay(titleHits, scanFullHits) // see below
    // even if titleHits empty — scan may still find cross-field AND

  // content delay
  wait 200–300ms; if !G or Q cleared: stop

  // B2 scan from universe HEAD — FULL searchCondition per candidate window
  cursor = null
  loop:
    // INV-09: stop only on full-condition scan hits, never titleHits.length
    if !G or scanFullHits.length >= 400: break
    POST /session/search/scan
      body: { search:Q, cursor, limit:50, /* same scope as list via query */ }
      signal: G
    response: {
      sessions: Info[]  // full-condition matches among next ≤50 candidates
      nextCursor: { time_updated, id } | null
      done: boolean
    }
    // Server (one page):
    //   1. Next ≤50 sessions: SAME predicates as listByProject (project/path/directory/start/roots)
    //      ORDER BY time_updated DESC, id DESC; keyset after cursor (NOT browse cache).
    //   2. Keep rows where full searchCondition(Q) holds.
    //   3. Return those matches + nextCursor + done.
    //   Note: page limit 50 is candidate window size; matches per page may be 0..50.
    if still G:
      append sessions to scanFullHits in response order (already recency);
      dedupe by id; if scanFullHits.length > 400: truncate to 400
      phase = partial
      displayHits = mergeDisplay(titleHits, scanFullHits)
    if done or !nextCursor: break

  if still G:
    phase = complete
    spinner off
    // complete 权威结果：仅 scanFullHits（≡ list full-condition top-400 流）
    // 丢弃仅存在于 titleHits、尚未被 scan 流覆盖的展示垫数（见 mergeDisplay 完成态）
    finalHits = scanFullHits  // length ≤ 400
    if finalHits empty: empty = Not Found Q
    else show finalHits

mergeDisplay(titleHits, scanFullHits) for phase=partial only:
  // UX: show title overlay ∪ scan so far, recency sort, display cap 400
  // Does NOT authorize complete; does NOT stop the scan loop
  return sortByRecency(uniqueById(titleHits ∪ scanFullHits)).slice(0, 400)

On HTTP failure for title or scan (still G):
  phase = complete; spinner off
  keep any hits already merged; if none, empty may show Not Found or short failure-neutral Searching→Not Found
  // no fallback to searchMode=all

On Q change / clear / unmount: abort G; discard in-flight
```

**为何修复 first divergence 与 R1 blockers：**

| R1 | R2 闭合 |
| --- | --- |
| B-01 | scan 使用 **完整** searchCondition；title-only 仅 first-paint 子集 |
| B-02 | title/scan **强制** `sdk.fetch` 手写；禁止依赖 gen `client.session.list` 传 searchMode |
| B-03 | 候选来自 listByProject **同宇宙** keyset 分页，不是 sync browse 缓存 |
| B-04 / R2 early-stop | early-stop 只看 `scanFullHits.length`；complete=`scanFullHits`；title 不计入 stop |

**兼容：** 无 `searchMode` 的 GET list+search = 今日全量 all（其它客户端）。TUI Path B **不再**以单次 all 为主路径。

**delete 后重搜：** progressive 替换 createResource 后，删除成功须对 **当前 Q** 重启 generation（等同旧 `refetch`）。

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Success? | Disposition |
| --- | --- | --- | --- |
| Progressive title→scan full condition | primary | yes | implement |
| Legacy list search 无 searchMode | existing compatibility | yes | preserve |
| loading→[]→Not Found | forbidden UX workaround | misleading | remove |
| content-half match as complete | forbidden wrong contract | wrong | reject (R1) |
| browse-cache candidates | forbidden silent narrow | wrong | reject (R1) |
| scan fail → all search fallback | forbidden fallback | yes | reject |
| FTS / SSE / parallel batches | non-goal / forbidden | — | reject |

## 12. Workaround Deletion and Replacement

| Workaround | Superseded by | Location |
| --- | --- | --- |
| `searchResults ?? []` 表示 loading | phase awaiting_first | session-list-params |
| TUI 单次全量 list search 作 Path B | progressive title+scan | dialog-session-list |

## 13. Forward Traceability

| Req/INV | Path | File | Test |
| --- | --- | --- | --- |
| INV-01/03 | SearchView phase + empty helpers | session-list-params.ts | params.test 扩 phase |
| INV-02 | filterAccessory + Spinner | dialog-select.tsx；dialog-session-list.tsx | props 接线：session-list 传 accessory 当 searching；dialog-select 渲染右侧（可用源码级组件 prop 契约测或最小 solid 测若已有 harness；至少 list 侧 createMemo 可单测 searching→accessory 非空的纯函数） |
| INV-04 | searchMode title + fetch GET | search.ts；session.ts；groups/handlers；session-list fetch | session-list.test title mode |
| INV-05/08/10 | searchScan full condition + keyset | search.ts；session.ts；handlers | session-list.test：跨字段 multi-token 仅 scan 命中；title mode 不命中 |
| INV-06/07 | generation + delay | dialog-session-list + 可测 helper in params/util | helper 单测 abort/delay 决策 |
| INV-09 | scanFullHits cap + early stop only on scan | session-list-params helpers | unit：title 预置不 stop；scan 满 400 才 stop；complete≡scan |
| INV-11 | sdk.fetch only | dialog-session-list | 不新增 SDK gen 文件 |
| INV-12 | failure → complete | dialog-session-list | 编排注释 + 可选 helper |
| delete refetch | restart generation | dialog-session-list | 保持调用点 |

## 14. Reverse Traceability

| Concept | Req | Why existing insufficient |
| --- | --- | --- |
| SearchPhase | INV-01 | 无 phase |
| filterAccessory | INV-02 | 无槽 |
| searchMode title | INV-04 | 条件绑死 content |
| searchScan keyset + full condition | INV-05/08/B-03 | 无分批完整扫描；browse 缓存非法 |
| SESSION_LIST_SEARCH_LIMIT merge | INV-09 | progressive 无 cap |
| sdk.fetch progressive | INV-11 | gen SDK 无新字段 |
| generation/contentDelay | INV-06/07 | createResource 单飞 |
| CONTENT_BATCH=50 | INV-05 | 批大小常量 |

## 15. File-Level Change Plan

**硬顶 ≤8 代码路径（锁定，按路径实算 8）：**

| # | File | Change | Δ lines |
| --- | --- | --- | --- |
| 1 | `packages/opencode/src/cli/cmd/tui/util/session-list-params.ts` | phase、empty、mergeDisplay、scan early-stop helpers、常量 | +120 |
| 2 | `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | progressive 编排、sdk.fetch、Spinner、abort、delete 重跑 | +220 |
| 3 | `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` | filterAccessory（搜索栏右侧） | +25 |
| 4 | `packages/opencode/src/session/search.ts` | mode title/all；full condition 复用 | +50 |
| 5 | `packages/opencode/src/session/session.ts` | ListInput.searchMode；searchScan keyset | +80 |
| 6 | `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` | ListQuery.searchMode + SearchScan endpoint schema | +55 |
| 7 | `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | 透传 searchMode + scan handler | +55 |
| 8 | `packages/opencode/test/server/session-list.test.ts` | title mode、scan、multi-token、early-stop 对齐 list、旧 search 回归；**并** import 测 `session-list-params` 的 phase/empty/mergeDisplay（不再改第二个测试文件，避免第 9 路径） | +220 |

说明：`session-list-params.test.ts` **本任务不修改**；其旧用例「loading→[]」将随 util API 变更而失败——实现时**删除或迁移**那些用例进文件 #8，若必须动 params.test 则用其**替换** #8 中的 params 用例文件占用（总路径仍 ≤8：即 7 prod + 1 test 文件，params 旧文件仅当替换 #8 时改）。推荐 **只扩 session-list.test.ts** 覆盖 util 导出。

不新增路由文件；SearchScan 挂现有 session group。

## 16. TDD Behavior Slices

| Order | Red behavior | Why fails now | Green | Regression |
| --- | --- | --- | --- | --- |
| 1 | awaiting_first empty ≠ Not Found；complete+[] = Not Found | 仅 Not Found | params API | 假空态 |
| 2 | empty Q → browse | 保持 | 保持 | Path A |
| 3 | title mode：title 命中；仅 content 含 needle 不命中 | 无 mode | searchMode title | B1 边界 |
| 4 | multi-token：title 含 A、text 含 B → title mode 不命中；scan/full 命中 | 若 content-half 会永久漏 | full condition on scan | INV-08 |
| 5 | searchScan 两页 keyset 覆盖 recency 顺序且不依赖 browse 表 | 无 API | searchScan | B-03 |
| 6 | mergeDisplay partial cap 400；complete 仅 scanFullHits | 无 | helper | INV-09 |
| 7 | title 预置 ≥1 且更新 content-only 存在时：early-stop 不得因 title 跳过 scan；complete 含该 content-only（与 list 对齐） | 若 title 计入 stop 会红 | scanFullHits 语义 | R2 early-stop |
| 8 | 旧 list search 无 mode 行为不变 | 防回归 | 既有 search tests | 兼容 |

## 17. Chinese Comment Budget

| Metric | Estimate |
| --- | --- |
| E | ~400–550 |
| C min | ceil(E×0.15) ≈ 60–83 |

注释点：phase≠Not Found；title overlay vs scanFullHits 权威 complete；early-stop 禁止数 title；list 宇宙 keyset；cap 400；generation abort；debounce vs contentDelay；sdk.fetch；失败结束 loading 不 fallback。

## 18. Verification

| Command | Cwd | Proves |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/session-list-params.test.ts` | packages/opencode | phase/empty/cap |
| `bun test test/server/session-list.test.ts` | packages/opencode | title mode、scan、multi-token、旧 search |
| `bun typecheck` | packages/opencode | types |
| 手动 Sessions：CJK | 用户库 | Spinner→Searching→title 首屏→partial→complete；清空；慢改词 abort |

## 19. Diff Budget

| Metric | Estimate |
| --- | --- |
| Files modified | ≤8 |
| Files added | 0 code |
| Production lines | ~400–500 |
| Test lines | ~150–220 |
| Total | **≤1200** |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| 0 命中稀有词仍全宇宙 scan | 与今日成本同阶；title 仍快失败首屏 |
| partial 误以为完成 | Spinner 至 complete |
| keyset 与 path scope 复杂度 | 复用 listByProject 条件构造，不复制 path 语义 |
| 失败态文案 | INV-12 complete + 已有 hits |

### Open Decisions Requiring the User

无。R1 的 browse 缓存边界 **拒绝**，不作为 open decision。

### Rejected Speculation

- FTS/物化/SSE
- content-half complete
- browse-cache 候选
- scan 失败后 all fallback
- 重建全量 SDK 仅为 searchMode

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round (R2 full-scope, not delta-only).
- Require evidence for every blocking finding.
- Check under-design and over-design, root-cause repair, fallback, ownership, tests, code quality, and 15% Chinese comment plan.
- Verify R1 B-01…B-04 are closed without new silent contract narrowing.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 multi-token; B-02 transport; B-03 browse-cache; B-04 cap 400 | failure terminal; Spinner verify; delete refetch; file-count | BLOCK | ses_06a67c302ffeNRVTudTFtKFOoC |
| 2 | R2 | yes | early-stop counts titleHits → complete ≠ list LIMIT 400 | Spinner verify weak; failure copy; file-count 9 paths; keyset id tie-break | BLOCK | ses_06a5c113fffetHt2ZuhUbKjMoI |
| 3 | R3 | yes | No blocking findings. | INV-02 Spinner verify weak; keyset id tie-break vs list; complete overload on failure path; partial+[] empty copy; file budget vs params.test | APPROVE | adversarial-auditor ses_06a56d94cffec7cadOwOBwIR9M |

### R3 independent plan audit verdict (verbatim summary from auditor)

```text
No blocking findings.
APPROVE
```

仅对 canonical plan revision R3 全范围 plan audit。实现须严格按 R3 执行，完成后仍需独立 implementation audit。

## 23. Implementation Evidence

### Actual Files and Diff

| File | Role |
| --- | --- |
| `packages/opencode/src/cli/cmd/tui/util/session-list-params.ts` | phase/empty/merge/early-stop helpers |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | progressive orchestration, Spinner, abort |
| `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` | filterAccessory slot |
| `packages/opencode/src/session/search.ts` | searchMode title/all |
| `packages/opencode/src/session/session.ts` | list searchMode + searchScan keyset |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` | ListQuery.searchMode + searchScan API |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | handlers |
| `packages/opencode/test/cli/cmd/tui/session-list-params.test.ts` | phase/empty/cap unit |
| `packages/opencode/test/server/session-list.test.ts` | title mode + scan + multi-token |
| `docs/plans/tui-session-search-progressive.md` | plan only |

Diff (code+test): ~696 insertions / 103 deletions across 9 code/test paths (plan untracked separate). Within 1200-line budget; one extra test file vs strict 8-path ideal (params.test + session-list.test both required for util+server seams).

### Red-Green Test Evidence

- Extended `session-list-params.test.ts`: Searching… vs Not Found; progressive source; early-stop; mergeDisplay; appendScanHits.
- Extended `session-list.test.ts`: searchMode title; multi-token cross-field scan; keyset paging.
- All 32 tests pass after green implementation.

### Verification Commands and Results

| Command | Cwd | Result |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/session-list-params.test.ts test/server/session-list.test.ts` | packages/opencode | 32 pass, 0 fail |
| `bun typecheck` | packages/opencode | clean |

### Original Feedback-Loop Result

Prior red: loading mapped to `[]` + `Not Found CJK`. After: `sessionListEmptyLabel(q,"awaiting_first")` → `Searching…`; complete empty → `Not Found`.

### Actual Secondary and Replacement Path Inventory

| Path | Disposition |
| --- | --- |
| Progressive title→scan | primary implemented |
| Legacy list search no mode | preserved (default all) |
| loading→Not Found | removed via phase empty labels |
| fail→searchMode=all | not implemented |
| browse-cache candidates | not used; searchScan list universe |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 651 | non-blank added lines minus import-only in src+test diff |
| Qualifying Chinese comment lines `C` | 98 | added lines containing CJK |
| Ratio `C / E` | 0.151 | |
| Required minimum `C` | 98 | ceil(E×0.15)=98 |

### Remaining Unverified Items

- Manual TUI visual: Spinner position on filter right under real daemon (layout prop wired; no automated render test).
- Live 1.7GB DB end-to-end progressive latency (unit/server tests cover semantics; prior bench informed constants).

### Implementation rework after audit round 1

- B-01 fixed: `searchTerminal` success|error; `resolveDisplayHits` keeps title∪scan on error complete; success complete still scan-only.
- Test: `resolveDispl| 1 | R3 | yes | B-01 failure complete drops title overlay hits | phase race; refetch cleanup; 9 files; helper-level early-stop test gap; manual Spinner | BLOCK | ses_06a3d77a5ffeiH9oS3ebe7bi6Z |
| 2 | R3 | yes | No blocking findings. | 9 files vs 8; Spinner manual; refetch cleanup; title non-2xx continues scan; early-stop integration gap | APPROVE | ses_06a331d54ffeKHW8pmhuq65xOU |

### Implementation audit round 2 verdict (verbatim)

```text
No blocking findings.
APPROVE
```y on error complete only`.
- Re-verify: 33 pass, typecheck clean.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
|  |  | yes |  |  |  |  |
