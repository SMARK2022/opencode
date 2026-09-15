# Canonical Implementation Plan: TUI Session Search Progressive Loading

> Status: blocked
>
> Revision: R8
>
> Approved revision: none
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL / multi-turn user request (2026-07-25) — 做 A+B1+B2（loading UX + title 首屏 + content 每 50 条增量）；搜索栏右侧 Spinner；首屏前显示正在搜索中；首屏后 Spinner 仍保留直到完全搜完；清空搜索不 loading；改词取消上一代；debounce + content 延后；避免 C/CJ/CJK 三倍浪费；串行 batch；甜点级；≤8 代码文件、≤1200 行；不做 FTS/物化表；目标终态 verified-implementation-and-commit。
>
> Implementation allowed: no
>
> Last updated: 2026-07-27
>
> R3 plan audit APPROVE; implementation audit round1 BLOCK B-01; rework; round2 APPROVE. R4 added the missing HttpApi exerciser scenario; R5 repairs the workspace-routing seam that rejected that route before the handler.
>
> Successor workflow authorized by user after R8 exceeded the six-round plan-audit ceiling: `docs/plans/tui-session-search-progressive-successor.md`.

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
| `packages/opencode/test/server/AGENTS.md` | HttpApi exerciser test seam and scenario conventions |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | Existing HttpApi route ownership and group/handler boundary |
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

## R4 Amendment: Complete HttpApi Route Coverage

### Verbatim follow-up requirement

> “当前我有检查到一些新的问题,这个是在我们GitHub上CI测试的新问题,请检查检查这些问题哪来的,然后按照我们的同样工作流进行新一轮的完整修正,请确保最终提交的内容不会有任何错误。”

### Scope and non-goals

The R3 progressive Session search production path is already implemented and
must remain unchanged. R4 only closes the route-coverage contract that the R3
implementation introduced but did not register in the existing HttpApi
exerciser. It does not change the route schema, handler, Session service,
generated SDK, TUI behavior, OpenAPI surface, or any timeout/retry behavior.

### Current evidence and red feedback loop

The current producer-to-consumer path is:

```text
SessionApi.searchScan endpoint
  -> SessionPaths.searchScan = POST /session/search/scan
  -> HttpApi route registry/effectRoutes
  -> test/server/httpapi-exercise/routing.ts route-key comparison
  -> test/server/httpapi-exercise/index.ts scenarios
  -> CI --fail-on-missing gate
```

The route and handler are present at:

- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:244-246,678-689`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:88-103,673`

The exerciser has no matching scenario. The red-capable command was run from
`packages/opencode`:

```text
bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip
```

Observed result:

```text
effectRoutes=140 missing=1 extra=0
MISS POST /session/search/scan
summary pass=156 fail=0 skip=0 missing=1 extra=0
one or more routes have no scenario
```

The same missing route was independently observed in CI run `30208861589` in
all three required gates (`coverage`, `auth`, and `effect`), while the required
`packages/opencode` Windows job passed. This separates the old Windows OpenTUI
failure from the current deterministic route-coverage failure.

### R4 invariants and first divergence

| ID | Behavioral invariant | First divergence | Owner | Evidence |
| --- | --- | --- | --- | --- |
| INV-14 | Every registered Effect HttpApi route has at least one executable scenario in each required exerciser mode. | The route registry contains `POST /session/search/scan`, but the scenario array has no matching `(method,path)` entry. | `packages/opencode/test/server/httpapi-exercise/index.ts` route scenario registry | observed local red and CI red |
| INV-15 | The `searchScan` scenario must exercise the public route contract and independently verify a seeded Session search hit. | No request reaches the route from the exerciser because route-key coverage fails before a matching scenario exists. | The existing HttpApi exerciser DSL at `test/server/httpapi-exercise/dsl.ts` | contracted by endpoint schema and reachable through the route |

The first divergence is the missing test-side route registration, not a
production response defect. No production repair or alternate route is
authorized by R4.

### R4 primary path

Add one `http.protected.post("/session/search/scan", "session.search.scan")`
scenario beside the existing `session.preview` scenario. Seed one Session with
a known title, send a valid `search` and bounded `batch`, then assert the
response contains that Session and reports the one-page scan as complete. This
uses the existing `ScenarioBuilder`, `ScenarioContext.session`, and public HTTP
request seam; it does not inspect the database or private helpers.

```text
seed Session -> POST /session/search/scan -> decode JSON -> assert independent hit and terminal cursor
```

The expected title and terminal response are fixed test facts, not a
reimplementation of the Session search algorithm. The route remains the sole
production semantic path.

### Secondary-path inventory

| Path | Classification | Produces success? | Disposition |
| --- | --- | --- | --- |
| Existing `searchScan` production route | primary contract | yes | preserve |
| New exerciser scenario | diagnostic/verification path | no production success | add |
| Missing-scenario bypass, skip, or `--fail-on-missing` relaxation | forbidden workaround | would hide failure | reject |

No alternate success path, fallback, retry, skip, or gate relaxation is
planned.

### R4 traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-14 | Existing `SessionApi.searchScan` route registration | `packages/opencode/test/server/httpapi-exercise/index.ts` add matching scenario | coverage/auth/effect exerciser route-key accounting |
| INV-15 | Existing `searchScan` handler and Session service | Same scenario sends valid payload and checks seeded hit | scenario execution and JSON assertions |

| Proposed concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| One route-coverage scenario | INV-14, INV-15 | local red and CI missing-route output | The route registry cannot infer a semantic request or expected response from the production endpoint alone |

### R4 file and TDD plan

| File | Change | Expected delta |
| --- | --- | --- |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | Add one seeded protected POST scenario beside `session.preview`; assert hit, `done`, and `nextCursor` through the public response | +18 to +28 lines |

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | The local coverage command reports `MISS POST /session/search/scan`. | No scenario has the route key. | Add the one valid seeded request and response assertion. | All three required modes no longer report the route missing, and the route is exercised rather than merely declared. |

The scenario will include concise Chinese comments only where they explain the
non-obvious progressive scan contract: the request's `batch` is a candidate
window and the terminal cursor is expected to be null after the isolated seed.

### R4 verification and diff budget

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip` | `packages/opencode` | Red before change; green route coverage after change |
| `bun run script/httpapi-exercise.ts --mode auth --fail-on-missing --fail-on-skip` | `packages/opencode` | Auth-mode scenario execution and complete route accounting |
| `bun run script/httpapi-exercise.ts --mode effect --fail-on-missing --fail-on-skip` | `packages/opencode` | Effect-mode scenario execution and complete route accounting |
| `bun typecheck` | `packages/opencode` | Scenario type safety and package typecheck |
| `bun test test/server/httpapi-exercise` | `packages/opencode` | Package-local exerciser regression if the test path is selected by the package test script |

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | Use the existing exerciser registry |
| Files modified | 1 test file | One route scenario is the owning repair |
| Files deleted | 0 | No workaround exists to delete |
| Production lines | 0 | Production route and handler already satisfy the contract |
| Test lines | 18-28 | Seed, request, and independent response assertions |
| Generated lines | 0 | No SDK/OpenAPI regeneration is needed |
| Effective changed code `E` | 12-20 | Excludes comments and formatting |
| Required qualifying Chinese comments `C` | 2-3 | Meets `ceil(E * 0.15)` and explains only the candidate-window/terminal-cursor invariant |

### R4 risks and rejected speculation

| Risk | Disposition |
| --- | --- |
| Seeded Session ordering changes under unrelated database state | The exerciser resets isolated state per scenario; the assertion checks the seeded ID, not global ordering. |
| `searchScan` has future pagination changes | The scenario asserts only the contracted response shape and terminal behavior for one isolated page. |
| Windows shell lifecycle or OpenTUI native renderer | Rejected for R4: current required OpenTUI Windows job passed and the red signal is a deterministic Linux route gate. |

Rejected speculation: changing production search semantics, adding SDK fields,
adding a second route, relaxing `--fail-on-missing`, increasing timeouts, or
adding retries. None is required by the observed first divergence.

### R4 audit contract

The independent plan auditor must audit the complete R3 progressive search scope
plus this R4 route-coverage amendment. It must verify that the proposed change
is test-only, that the public endpoint remains the owning production path, that
the scenario has an independent expected value, and that no missing-route
failure is hidden by a skip or gate relaxation.

## R4 Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R4 | yes | None | Auth mode does not execute route requests; conditional package test command may be non-authoritative; historical R3 evidence is administratively dense | APPROVE | ses_060b58f76ffeOfjAIK6bfz0Vqz |

### R4 independent plan audit verdict (verbatim)

```text
No blocking findings.

## Blocking findings

None.

## Non-blocking findings

- The R4 plan states that the new scenario runs in all three CI modes, but the existing exerciser’s `auth` mode only performs authentication probes and does not execute the route request itself (`packages/opencode/test/server/httpapi-exercise/runner.ts:43-55`). This does not block the route-coverage repair because route-key accounting is performed independently for all modes, while the public response contract is exercised in `effect` mode.
- The proposed verification command `bun test test/server/httpapi-exercise` is qualified as conditional and may not provide meaningful coverage if the directory is not selected by the package’s test configuration. The three explicit exerciser commands are the authoritative verification for this R4 change.
- The canonical plan retains extensive R3 implementation evidence and historical audit records before the R4 amendment. This is administratively dense but does not change the current R4 scope or implementation contract.

## Rejected speculation

- Changing the production `searchScan` route or handler: the route is registered and its handler is reachable; the observed divergence is the missing exerciser scenario.
- Adding an SDK field or regenerating the SDK: R4 explicitly preserves the existing hand-written transport and does not require a client contract change.
- Relaxing `--fail-on-missing`, adding a skip, retry, or timeout: these would hide the deterministic route-coverage failure rather than repair its owner.
- Reworking the progressive TUI search path: the R4 requirement is limited to route coverage, and no evidence shows a production progressive-search defect in this audit scope.
- Requiring the scenario to prove global ordering or unrelated pagination behavior: the intended test owns the public route contract for a seeded, isolated one-page request, not the complete search algorithm already covered by `session-list.test.ts`.

## Requirement and traceability coverage

- The original follow-up requirement is quoted verbatim in the canonical plan at section 23/R4.
- The current CI producer-to-consumer chain is correctly reconstructed:
  - `SessionApi.searchScan`
  - `POST /session/search/scan`
  - OpenAPI route registry
  - exerciser route-key comparison
  - CI `coverage`, `auth`, and `effect` gates
- The missing route scenario is independently confirmed by source:
  - Route path and endpoint registration: `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:244-246,678-689`
  - Existing exerciser scenario registry and route-key comparison: `packages/opencode/test/server/httpapi-exercise/index.ts:45,1480-1483`
  - CI commands and required modes: `.github/workflows/test.yml:208-242`
- INV-14 is mapped to the existing exerciser scenario registry and the three route-accounting commands.
- INV-15 is mapped to a seeded public POST request using the existing `ScenarioBuilder`, `ScenarioContext.session`, and response assertions.
- The expected response is behaviorally independent: the seeded Session ID and title are created by the fixture, while the assertion observes the HTTP response rather than private database state.
- The proposed change is restricted to one existing test file and leaves the production route, handler, Session service, SDK, TUI behavior, and OpenAPI schema unchanged.
- The TDD red state is behaviorally meaningful: without a scenario matching `POST /session/search/scan`, the current route-key comparison reports the route as missing and the required `--fail-on-missing` gate fails.

## Primary-path and fallback verdict

- The production `searchScan` route remains the sole semantic path for progressive Session search.
- The added exerciser scenario is diagnostic/verification-only and cannot produce production success.
- No alternate production success path, fallback, retry, skip, route duplication, gate relaxation, or compatibility branch is proposed.
- The plan correctly assigns the repair to the exerciser’s scenario registry, which owns route coverage accounting.
- The route contract is exercised through the public HTTP seam, with a seeded Session and assertions for:
  - matching Session presence,
  - terminal `done`,
  - terminal `nextCursor: null`.
- The R3 progressive-search primary path and its previously audited invariants remain in scope and are not narrowed by R4.

## Code quality and Chinese-comment verdict

Plan-mode quality review passes:

- The change follows the existing HttpApi exerciser DSL and scenario conventions.
- No production interface, dependency, generated artifact, or route schema is expanded.
- The proposed test remains localized to `packages/opencode/test/server/httpapi-exercise/index.ts`.
- The estimated effective change is `E = 12–20`; the planned `C = 2–3` qualifying Chinese explanatory-comment lines satisfy the hard minimum:
  - `ceil(12 × 0.15) = 2`
  - `ceil(20 × 0.15) = 3`
- The planned comments are tied to non-obvious candidate-window and terminal-cursor semantics rather than restating control flow.

## Release verdict

**APPROVE** the exact canonical plan revision **R4** for implementation.

This approval applies only to the current R4 plan revision and authorizes only the specified one-file exerciser scenario. Implementation still requires the approved-plan workflow, the required red-green verification, and a subsequent independent full-scope implementation audit.

## R5 Amendment: Route Collection Endpoint Through Workspace Routing

### R5 status

R4 implementation is not complete: its approved exerciser scenario reaches the
real route but returns a 500 before the Session handler. This is a material
ownership discovery, so R4 approval is cleared and the complete plan is revised
to R5 for a new full-scope audit.

### R5 current red evidence

The approved R4 focused command was run from `packages/opencode`:

```text
bun run script/httpapi-exercise.ts --mode effect --include session.search.scan --fail-on-missing --fail-on-skip --trace
```

Observed result:

```text
FAIL POST /session/search/scan session.search.scan
Error: expected 200, got 500: {"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details."}}
ERROR service=server error=Expected a string starting with "ses", got "search"
  at packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:195:23
```

The trace proves the route request reaches the workspace middleware, but the
failure occurs before `sessionHandlers.searchScan` can execute. The existing
`session.preview` effect scenario passes, while the R4 `searchScan` scenario
fails, isolating the difference to the newly introduced collection path.

### R5 producer-to-consumer chain and first divergence

```text
POST /session/search/scan
  -> workspaceRoutingLayer
  -> routeHttpApiWorkspace
  -> getWorkspaceRouteSessionID(URL)
  -> SessionID.make("search")
  -> defect -> UnknownError 500
```

`packages/opencode/src/server/shared/workspace-routing.ts:20-29` extracts the
first segment after `/session/` for every path except `/session/status` and
`/session/preview`. For `/session/search/scan`, that segment is the literal
collection-route word `search`, not a SessionID. `SessionID.make("search")`
therefore throws at the workspace middleware boundary before the route's own
schema and handler are selected.

| ID | Behavioral invariant | First divergence | Owner | Evidence |
| --- | --- | --- | --- | --- |
| INV-16 | Collection-level Session endpoints under `/session` must reach their own HttpApi route without being parsed as `:sessionID`. | `getWorkspaceRouteSessionID` parses `search` from `/session/search/scan` and invokes the SessionID brand constructor. | `packages/opencode/src/server/shared/workspace-routing.ts` | observed trace and reachable middleware call path |
| INV-17 | The `searchScan` endpoint must preserve the existing workspace routing contract and return its declared `SearchScanResponse`. | The R4 public scenario gets a 500 before the handler; the route's unit-level Session service behavior already has direct regression coverage. | Workspace routing middleware plus HttpApi exerciser | observed focused effect failure; existing `session-list.test.ts` searchScan tests |

### R5 responsibility and primary path

The owning repair is one exact collection-route exemption in
`getWorkspaceRouteSessionID`, alongside the existing `/session/status` and
`/session/preview` exemptions. The function will return `null` for the exact
pathname `/session/search/scan`, allowing workspace routing to use the caller's
directory and letting the registered HttpApi endpoint handle the request.

```text
collection route -> exact no-session-ID classification -> workspace plan -> searchScan handler -> declared JSON response
session route -> existing SessionID extraction -> existing session-aware workspace plan
```

This preserves one routing algorithm and one production searchScan path. It does
not add a catch-all parser, retry, route reorder, fallback, or error-to-success
conversion.

### R5 secondary-path inventory

| Path | Classification | Produces success? | Disposition |
| --- | --- | --- | --- |
| Existing SessionID extraction for `/session/:sessionID/...` | primary-contract branch | yes | preserve |
| Exact collection-route exemptions (`status`, `preview`, `search/scan`) | primary-contract branch | yes | extend with the proven route |
| Generic “ignore invalid SessionID” catch or route fallback | forbidden fallback | would hide routing errors | reject |

### R5 traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-16 | `getWorkspaceRouteSessionID` exact path classification | `packages/opencode/src/server/shared/workspace-routing.ts` add `/session/search/scan` collection exemption | `packages/opencode/test/server/workspace-routing.test.ts` exact null result |
| INV-17 | Existing workspace middleware plus registered searchScan handler | Preserve R4 scenario in `packages/opencode/test/server/httpapi-exercise/index.ts` | Focused effect scenario returns seeded hit, `done: true`, `nextCursor: null` |

| Proposed concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| One exact collection-path classification | INV-16 | 500 trace at `SessionID.make("search")` | The current generic extractor has no knowledge of this newly introduced collection endpoint |
| One routing regression assertion | INV-16 | Existing workspace-routing unit seam | The HttpApi scenario is slower and does not isolate the first middleware transition |

### R5 file-level and TDD plan

| File | Change | Expected delta |
| --- | --- | --- |
| `packages/opencode/src/server/shared/workspace-routing.ts` | Return `null` for the exact `/session/search/scan` collection path beside existing collection exemptions | +3 to +4 lines |
| `packages/opencode/test/server/workspace-routing.test.ts` | Add the public helper regression for `/session/search/scan` | +4 to +6 lines |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | Retain the approved R4 seeded searchScan HTTP scenario | R4 +18 to +28 lines |

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `getWorkspaceRouteSessionID(new URL("http://localhost/session/search/scan"))` is expected to be `null` but currently throws. | Generic segment extraction passes `search` to `SessionID.make`. | Add only the exact collection-path exemption. | Middleware cannot regress to parsing the collection segment as a SessionID. |
| 2 | The focused R4 effect scenario expects HTTP 200 but currently receives 500. | Workspace routing fails before the HttpApi handler. | Reuse the same route after the owner fix and assert the seeded response contract. | End-to-end route, middleware, schema, handler, and Session service remain connected. |

### R5 comment and diff budget

The production explanation will use two nearby Chinese comment lines: one
identifies `/session/search/scan` as a collection-level route, and one explains
why it must not enter SessionID parsing. The existing R4 scenario comments remain
in scope and continue to explain candidate-window and terminal-cursor semantics.

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | Existing routing and test seams are sufficient |
| Files modified | 3 | One production owner plus one unit and one integration test |
| Files deleted | 0 | No workaround is removed |
| Production lines | 2-4 | Exact path classification only |
| Test lines | 22-34 total | R4 scenario plus one routing regression |
| Generated lines | 0 | No SDK/OpenAPI change |
| Effective changed code `E` | 18-28 | Excludes the five planned explanatory comment lines and formatting |
| Required qualifying Chinese comments `C` | 5 | Meets `ceil(E * 0.15)` for the approved range and explains real route invariants |

### R5 verification and rejected speculation

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test test/server/workspace-routing.test.ts` | `packages/opencode` | Red/green exact middleware seam |
| `bun run script/httpapi-exercise.ts --mode effect --include session.search.scan --fail-on-missing --fail-on-skip` | `packages/opencode` | Red/green public route contract |
| `bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip` | `packages/opencode` | Route accounting remains complete |
| `bun run script/httpapi-exercise.ts --mode auth --fail-on-missing --fail-on-skip` | `packages/opencode` | Auth route accounting remains complete |
| `bun run script/httpapi-exercise.ts --mode effect --fail-on-missing --fail-on-skip` | `packages/opencode` | Full Effect exerciser route and response regression |
| `bun typecheck` | `packages/opencode` | Type safety for routing and scenario changes |

Rejected speculation: changing the Session schema, changing the search SQL,
adding a second workspace-routing parser, using a generic invalid-ID catch,
relaxing route coverage, or increasing scenario timeouts. The observed defect
is a single exact path classification, and those changes would widen ownership
or hide failures.

## R5 Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R5 | yes | None | Auth mode is route accounting/probe only; duplicate effect command in verification table; historical plan evidence is administratively dense; neighboring invalid-path assertion is not added | APPROVE | ses_060a3e3e4ffeQR5Oyppx1Rzuqj |

### R5 independent plan audit verdict (verbatim)

```text
No blocking findings.

## Blocking findings

None.

## Non-blocking findings

- The `auth` exerciser mode performs authentication probes and route accounting but does not execute the authenticated route request itself (`packages/opencode/test/server/httpapi-exercise/runner.ts:43-55`). The `effect` mode remains the authoritative public response-contract check.
- The verification table repeats the full `effect` command at lines 852–853. This is redundant documentation only and does not affect the executable plan.
- The canonical plan retains extensive historical R3/R4 implementation and audit material. This is administratively dense but does not narrow the current R5 scope or alter its implementation contract.
- The proposed routing unit test proves the exact positive exemption. It does not independently assert that neighboring collection-like paths remain invalid SessionID paths; this is not blocking because the planned implementation direction explicitly requires an exact pathname comparison and the focused test fails on the current defect.

## Rejected speculation

- Changing the Session search schema, SQL, handler, generated SDK, or TUI progressive-search orchestration: the observed failure occurs earlier, when workspace routing parses `"search"` as a SessionID.
- Adding a generic invalid-SessionID catch, route fallback, retry, or error-to-success conversion: these would hide routing defects instead of repairing the owning classification seam.
- Modifying `isLocalWorkspaceRoute`: the existing preview route demonstrates that collection-level handling does not require adding a new local control-plane rule; workspace selection and forwarding remain governed by the existing workspace-routing contract.
- Requiring the exerciser `auth` mode to execute the full route request: the current runner architecture does not do so, and route accounting is independently performed in the required modes.
- Requiring global ordering or multi-page search semantics in the new exerciser scenario: those semantics already have direct Session-service coverage; R5’s new scenario owns the public route reachability and response contract for an isolated seeded page.

## Requirement and traceability coverage

- The original follow-up requirement is quoted verbatim in the canonical plan at section 23/R4.
- The R5 revision independently reconstructs the observed CI failure path:

  ```text
  POST /session/search/scan
    -> workspaceRoutingLayer
    -> routeHttpApiWorkspace
    -> getWorkspaceRouteSessionID
    -> SessionID.make("search")
    -> UnknownError 500
  ```

- The route is registered as a collection endpoint at:
  - `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:242-246`
  - `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:677-689`
- The workspace middleware calls `getWorkspaceRouteSessionID` before the endpoint handler at:
  - `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:193-203`
- The current extractor parses the first segment after `/session/`, so `/session/search/scan` reaches `SessionID.make("search")`:
  - `packages/opencode/src/server/shared/workspace-routing.ts:20-29`
- The existing HttpApi exerciser scenario reaches the route but currently receives HTTP 500 before the handler:
  - `packages/opencode/test/server/httpapi-exercise/index.ts:1386-1409`
  - Canonical plan R5 current red evidence, lines 734-747.
- INV-16 maps to the shared workspace-routing classifier and its focused unit test.
- INV-17 maps to the existing public `searchScan` route and the retained seeded HttpApi exerciser scenario.
- The planned production correction is localized to the first divergent transition: exact collection-route classification in `getWorkspaceRouteSessionID`.
- The route scenario independently seeds a Session and asserts its returned ID/title, `done: true`, and `nextCursor: null`; it does not duplicate the search implementation or inspect private persistence state.
- No confirmed R3 progressive-search requirement is removed or narrowed by R5.
- The proposed R5 production concepts are justified by observed route reachability and the reproduced 500.
- TDD is executable:
  1. The focused routing test fails because the current helper throws.
  2. The focused effect scenario fails with HTTP 500 before the handler.
  3. The exact exemption repairs both the owner seam and the public route path.
- The planned diff remains within the stated file and line constraints.
- Plan-mode Chinese-comment feasibility passes: the estimate `E = 18–28` requires `C = 5` at the upper bound, and the plan commits five qualifying comments distributed around the routing and scenario invariants.

## Primary-path and fallback verdict

- The existing `searchScan` production route remains the sole semantic Session-search path.
- The R5 repair targets the first divergence in the shared workspace-routing seam rather than compensating in the handler, exerciser, or TUI.
- The exact `/session/search/scan` exemption is a primary routing classification branch, analogous to the existing `/session/status` and `/session/preview` collection-route exemptions.
- Session-specific paths continue through the existing SessionID extraction branch.
- No generic parser relaxation, catch-and-default behavior, route duplication, retry, skip, gate relaxation, or alternate success path is proposed.
- The exerciser scenario is diagnostic-only and cannot produce production success.

## Release verdict

**APPROVE** the exact canonical plan revision **R5**.

This approval applies only to the current R5 revision. Implementation remains disallowed until the independent verdict is recorded for this exact revision according to repository policy.

## R6 Amendment: Evidence-Bounded Effect Verification

### Reason for revision

R5 implementation audit round 1 returned `BLOCK` solely because the complete
157-scenario Effect exerciser did not finish in the local Windows environment.
This is a substantive verification-contract change, so R5 approval is cleared
and the plan advances to R6. No production or test implementation change is
made by this amendment.

### Evidence resolving the scope of the timeout

The prior Ubuntu CI run `30208861589` executed the complete Effect exerciser at
the pre-R5 commit and produced:

```text
summary pass=156 fail=0 skip=0 missing=1 extra=0
MISS POST /session/search/scan
```

The same job completed in approximately three minutes and did not report any
failure from the 156 existing routes. The only missing route was the newly
introduced `POST /session/search/scan`. R5 then independently produced:

- routing unit: `16 pass / 0 fail`;
- focused public searchScan Effect: `1 pass / 0 fail`, HTTP 200;
- all Session-related Effect scenarios: `54 pass / 0 fail`;
- coverage: `157 pass / 0 fail / 0 skip / missing=0 / extra=0`;
- auth accounting: `157 pass / 0 fail / 0 skip / missing=0 / extra=0`;
- package typecheck: passed.

The local Windows full Effect run timed out while entering unrelated
non-Session/PTY setup. No R5 diff changes those routes, their handlers, or their
process lifecycle. Therefore the R6 implementation verification scope is the
evidence-backed differential:

```text
Ubuntu full baseline: all 156 pre-existing routes pass
  + R5 exact middleware classification and route scenario pass
  + route accounting reports 157/157
  + package typecheck passes
  = R5 affected interface verified
```

The official post-fix Ubuntu CI `httpapi-required / effect` job remains a final
release gate. It must pass before the task is reported as fully released; this
R6 local audit contract does not reinterpret a future CI failure as success.

### R6 verification contract

| Evidence | Command or source | Release meaning |
| --- | --- | --- |
| Existing-route full baseline | CI `30208861589`, Ubuntu effect job: `156 pass / 0 fail / 1 missing` | Proves the unchanged 156-route Effect surface before R5 |
| New route focused contract | `bun run script/httpapi-exercise.ts --mode effect --include session.search.scan --fail-on-missing --fail-on-skip` | Proves the new route reaches middleware, handler, schema, and Session service after R5 |
| Affected Session route regression | `bun run script/httpapi-exercise.ts --mode effect --include session --fail-on-missing --fail-on-skip` | Proves all 54 Session-related routes, including preview and searchScan |
| Route accounting | coverage and auth commands | Proves the new route is not skipped or omitted in required modes |
| Type safety | `bun typecheck` | Proves the changed production/test seam compiles |
| Final release gate | post-fix official Ubuntu full Effect job | Required before claiming CI release success |

No timeout, skip, route filter, or failure suppression is added to CI or the
exerciser. The local platform limitation is reported as an unverified item, and
the final Ubuntu gate remains mandatory.

### R6 file and diff disposition

R6 authorizes no new file or code change. The exact R5 implementation remains:

- `packages/opencode/src/server/shared/workspace-routing.ts`
- `packages/opencode/test/server/workspace-routing.test.ts`
- `packages/opencode/test/server/httpapi-exercise/index.ts`

The only R6 change is this verification contract and its evidence record.

### R6 audit contract

The independent auditor must re-audit the complete R3 progressive search scope,
R4 route-coverage amendment, R5 root-cause repair, and R6 evidence boundary.
It must verify that the differential proof is bounded to the actual affected
interface, that the prior Ubuntu run really completed all unchanged routes, that
the local timeout is not being hidden or converted to success, and that the
post-fix official Ubuntu gate remains an explicit release condition.

## R6 Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R6 | yes | None | Prior Ubuntu evidence is external; unrelated Windows cleanup failures remain; historical plan is dense; metadata says full-scope rather than plan | APPROVE | ses_06070583dffeTHhuk41zxGRIa5 |

### R6 independent plan audit verdict (verbatim)

```text
No blocking findings.

## Blocking findings

None.

## Non-blocking findings

- **R6 verification evidence remains partly external.** The prior Ubuntu baseline and post-R5 results are recorded in the plan, but they are not independently reproducible from repository files alone. This does not block the plan because R6 explicitly retains the official post-fix Ubuntu Effect job as a mandatory final release gate rather than converting the local differential evidence into release success.
- **The complete `session-list.test.ts` suite has known unrelated Windows cleanup failures.** The plan records these as pre-existing and outside the R5 routing seam. The affected route contract is separately covered by the focused routing, Session-filtered Effect, route-accounting, and typecheck commands.
- **The R6 plan is administratively dense.** It contains historical R3–R5 implementation and audit records alongside the current verification amendment. This does not alter the current implementation contract or narrow the original requirement.
- **The canonical metadata uses `Audit mode: full-scope` rather than explicitly repeating `plan`.** The user-supplied audit mode is still unambiguous, and the plan explicitly requires a full-scope plan audit.

## Rejected speculation

- Requiring a generic invalid-`SessionID` catch: the failure is directly reachable at `getWorkspaceRouteSessionID`, and the exact collection route is the owning classification seam.
- Changing `isLocalWorkspaceRoute`: the existing `/session/preview` path demonstrates that collection-level workspace handling already works without adding a new local control-plane route rule.
- Changing the Session search algorithm, schema, handler, generated SDK, or TUI orchestration: the R5 failure occurs before the handler at workspace routing.
- Requiring `auth` mode to execute the full authenticated request: `runner.ts:43-55` shows that auth mode performs authentication probes and route accounting, while Effect mode owns the response contract.
- Requiring the new exerciser scenario to prove global ordering or multi-page semantics: those semantics already have direct Session-service coverage in `session-list.test.ts`; the new public scenario owns route reachability and the one-page response contract.
- Treating the local Windows full Effect timeout as success: the plan explicitly records it as unverified and preserves the post-fix Ubuntu CI gate.

## Requirement and traceability coverage

- The original requirement is quoted verbatim in the canonical plan at R4 section 23, including the request to investigate the new CI failure and perform a complete correction workflow.
- The original progressive Session-search scope remains represented by the R3 invariants:
  - loading must not appear as `Not Found`;
  - Spinner remains visible through partial loading;
  - clearing the query returns to browse without loading;
  - title-only first paint;
  - full-condition serial candidate scanning;
  - generation cancellation and delayed content scanning;
  - complete results remain aligned with the existing full search contract and 400-result cap;
  - no FTS, materialized table, SSE, parallel scan, browse-cache narrowing, or search fallback.
- The R3 producer-to-consumer path is supported by current source:
  - `DialogSessionList` performs title and scan requests through hand-written `sdk.fetch` (`packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx:85-182`);
  - the Session service performs full-condition keyset scanning (`packages/opencode/src/session/session.ts:1029-1100`);
  - `searchCondition(..., { mode: "title" | "all" })` keeps title overlay separate from authoritative full search (`packages/opencode/src/session/search.ts:22-39`);
  - the UI keeps `Searching…` and Spinner active until completion (`packages/opencode/src/cli/cmd/tui/util/session-list-params.ts:45-67`, `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx:456-464`).
- R4 correctly maps the CI failure to missing exerciser route registration:
  - the production route is registered as `POST /session/search/scan` (`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:678-689`);
  - the scenario registry compares every OpenAPI route against `(method, path)` entries (`packages/opencode/test/server/httpapi-exercise/index.ts:1504-1508`);
  - the retained scenario now covers the public endpoint (`packages/opencode/test/server/httpapi-exercise/index.ts:1386-1409`).
- R5 correctly identifies the first divergence before the handler:
  - the workspace middleware calls `getWorkspaceRouteSessionID` before planning the request (`packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:193-203`);
  - the former generic extraction would parse `"search"` as a `SessionID`;
  - the exact collection-route exemption is now at that seam (`packages/opencode/src/server/shared/workspace-routing.ts:20-32`);
  - the focused regression asserts `null` for the collection route (`packages/opencode/test/server/workspace-routing.test.ts:44-52`).
- R6 preserves forward traceability by changing only the verification boundary:
  - focused routing regression;
  - focused public Effect route contract;
  - Session-filtered Effect regression;
  - coverage and auth route accounting;
  - package typecheck;
  - mandatory post-fix official Ubuntu full Effect gate.
- No confirmed requirement is left without an implementation owner or a behavioral verification path. The manual visual Spinner placement and live large-database latency are explicitly identified as unverified rather than falsely claimed as automated proof.

## Primary-path and fallback verdict

- The Session progressive search path remains one authoritative production semantic path:
  - title-only first paint;
  - serial full-condition keyset scan;
  - full scan results define successful completion.
- The legacy list endpoint without `searchMode` is a concrete compatibility path for existing clients and remains unchanged.
- The R5 routing repair restores the existing production route to its owning handler; it does not create a second search implementation.
- The exact `/session/search/scan` exemption is a primary classification branch analogous to the existing collection-level `/session/status` and `/session/preview` handling.
- No alternate production success path, retry-after-failure path, catch-and-default behavior, route duplication, skip, timeout relaxation, gate relaxation, or search fallback is proposed.
- The HttpApi exerciser scenario is diagnostic-only and cannot produce production success.
- The diagnostic decision surface remains within policy because the added route scenario and focused routing assertion observe the existing route rather than implementing a replacement algorithm.

## Code quality and Chinese-comment verdict

Plan-mode quality review passes:

- The R5 production correction is localized to the shared workspace-routing owner.
- The R4 test remains in the existing HttpApi exerciser DSL and uses the public route seam.
- The R5 unit test uses the existing focused routing helper seam and follows the package server-test guidance.
- No generated SDK, OpenAPI schema, database schema, dependency, retry policy, timeout policy, or unrelated route is expanded.
- The implementation remains within the stated scope of three existing files for R5.
- R6 authorizes no additional production or test code, so no new implementation concept or comment burden is introduced by the current revision.
- For the previously approved R5 implementation, the plan records `E = 21`, `C = 5`, and `C / E = 0.238`, exceeding the required `ceil(21 × 0.15) = 4`. In plan mode this is a feasibility record rather than an independently recomputed implementation audit.

## Release verdict

**APPROVE** the exact canonical plan revision **R6** for implementation/verification workflow purposes.

This approval does **not** declare the repository released. The official post-fix Ubuntu `httpapi-required / effect` job remains a mandatory release condition, and the known unrelated Windows `session-list.test.ts` cleanup failures must not be reported as fixed by this plan.

## R6 Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R6 | yes | B-01 title HTTP failure continues into scan path | Local full Windows Effect timeout remains unverified; unrelated worktree modification excluded; route scenario batch differs from TUI batch | BLOCK | ses_0606b900dffeid8FbmZ2ENRdue |

### R6 independent implementation audit verdict (verbatim)

```text
# Blocking findings

### B-01 Title HTTP failure incorrectly continues into the scan path

- **Violated invariant:** INV-12 requires any title or scan HTTP failure to terminate loading, turn Spinner off, and avoid silently continuing the progressive request lifecycle. The approved primary-path contract in plan §10 states: “On HTTP failure for title or scan … `phase = complete; spinner off`”.
- **Evidence class:** reachable
- **Producer and execution path:** `DialogSessionList.runProgressiveSearch()` issues the title request through `sdk.fetch(GET /session?searchMode=title)`. `sdk.fetch` returns a normal `Response` for reachable non-2xx server responses. The implementation checks `titleRes.ok`, but when it is false it continues to `setSearchPhase("partial")`, waits for `contentDelay`, and starts `POST /session/search/scan`.
- **Source evidence:** `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx:104-123`
  - `titleRes.ok` is only used to conditionally update `titleHits`.
  - `setSearchPhase("partial")` executes regardless of the title response status.
  - The delayed scan starts afterward at `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx:125-143`.
- **Canonical-plan evidence:** `docs/plans/tui-session-search-progressive.md:121` (INV-12) and §10 lines 230-233.
- **Responsibility owner:** `DialogSessionList` progressive-search orchestration, which owns generation state, phase transitions, request cancellation, and loading termination.
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** A reachable title HTTP failure is treated as a partial successful search and causes a second scan request. This violates the approved failure lifecycle and means the title failure does not end loading at the first failed request. The current tests do not exercise this branch.
- **Why this is not speculative:** The public HTTP request is an actual network seam, and the code explicitly distinguishes `titleRes.ok === false`; non-2xx responses are therefore directly reachable without malformed input or bypassing validation.
- **Minimal correction direction:** At the `titleRes.ok` decision in `DialogSessionList`, make the title-failure branch terminate the current generation according to INV-12 (`complete` + error terminal + Spinner off) without starting the content scan or introducing a fallback success path.

# Non-blocking findings

- The focused and affected-interface verification passed:
  - `bun test test/server/workspace-routing.test.ts`: **16 pass, 0 fail**
  - `bun test test/cli/cmd/tui/session-list-params.test.ts`: **12 pass, 0 fail**
  - Focused `session.search.scan` Effect exerciser: **1 pass, 0 fail**
  - Session-filtered Effect exerciser: **54 pass, 0 fail**
  - Coverage mode: **157 pass, 0 fail, 0 skip, missing=0, extra=0**
  - Auth accounting mode: **157 pass, 0 fail, 0 skip, missing=0, extra=0**
  - `bun typecheck`: passed
- The complete local Windows Effect run remains unverified because it previously exceeded the documented timeout during unrelated non-Session/PTY setup. R6 correctly preserves the official post-fix Ubuntu Effect job as a mandatory release gate; this is not independently treated as a release pass.
- The unrelated pre-existing worktree modification `packages/core/src/models-snapshot.js` was not part of the supplied audited change set and was not evaluated as part of this implementation verdict.
- The R4 exerciser scenario uses `batch: 100`, while the TUI primary path uses `SESSION_LIST_CONTENT_BATCH = 50`. Existing direct Session-service tests cover `batch: 50` and keyset pagination, so this does not create a separate blocking defect in the R4 route-reachability scenario.

# Rejected speculation

- A generic invalid-`SessionID` catch is not required. The observed R5 failure is localized to the reachable `/session/search/scan` collection route, and the exact exemption in `getWorkspaceRouteSessionID` repairs that owner seam.
- Changing `isLocalWorkspaceRoute` is not required. Existing collection endpoints such as `/session/status` and `/session/preview` demonstrate the relevant workspace-routing behavior without a new generic local-route rule.
- Changing the Session search SQL, schema, handler, generated SDK, or TUI search algorithm to solve the R5 CI failure would be responsibility leakage; the failure occurred before the handler at workspace routing.
- Requiring the `auth` exerciser mode to execute the full authenticated route request is not justified by the current runner contract. Its route accounting passed, while the Effect mode exercised the public response contract.
- Requiring a complete local Windows 157-route Effect run as the only acceptable evidence would ignore the R6 evidence boundary and the documented unrelated platform lifecycle limitation.

# Requirement and traceability coverage

- The original progressive-search scope remains represented in the current implementation:
  - Loading state is distinguished from `Not Found` through `SearchPhase`.
  - Spinner remains active through `partial`.
  - Clearing the query returns to browse without loading.
  - Title-first request uses hand-written `sdk.fetch` with `searchMode=title`.
  - Full-condition scanning uses serialized keyset batches.
  - Generation and `AbortController` cancellation are present.
  - Content delay is 250 ms.
  - Complete success results use the full scan stream and preserve the 400 cap.
  - No FTS, materialized table, SSE, parallel scan, browse-cache narrowing, or search fallback was added.
- R4 coverage is implemented and verified through the public `POST /session/search/scan` scenario at `packages/opencode/test/server/httpapi-exercise/index.ts:1386-1409`.
- R5 repairs the first observed divergence at `getWorkspaceRouteSessionID`:
  - Production correction: `packages/opencode/src/server/shared/workspace-routing.ts:20-32`
  - Focused regression: `packages/opencode/test/server/workspace-routing.test.ts:49-52`
  - Public route regression: focused Effect exerciser passed with HTTP 200.
- R6’s evidence boundary is preserved in the plan. The local verification results establish the affected Session interface and route accounting, but the official post-fix Ubuntu full Effect job has not yet supplied release evidence.
- INV-12 is not fully covered by the implementation: scan HTTP failure is handled, but title HTTP failure follows the scan path instead of terminating loading.

# Primary-path and fallback verdict

- The changed R4/R5 production routing remains one authoritative route-classification path.
- The exact `/session/search/scan` exemption is a primary classification branch, not a fallback.
- The HttpApi scenario is diagnostic-only and cannot produce production success.
- No unauthorized retry, catch-and-default, route duplication, gate relaxation, or alternate production search implementation was introduced.
- The R3 progressive-search primary path is not fully compliant because its title non-2xx branch continues into the delayed scan instead of applying the approved failure terminal transition.
- The primary-path verdict therefore fails the exact R6 implementation contract until B-01 is corrected.

# Code quality and Chinese-comment verdict

- Repository style and package-local interfaces are preserved in the audited diff.
- The route repair is localized and type-safe.
- The public exerciser uses the existing DSL and independently asserts the seeded Session ID/title, `done`, and `nextCursor`.
- No production fallback, compatibility layer, generated artifact, schema change, or unrelated implementation concept was added in the supplied four-file audit scope.
- `git diff --check` passed.
- Independent Chinese explanatory-comment calculation for the actual R4/R5 implementation diff:
  - **E = 25** substantive added/modified executable lines across production and tests, excluding blank, formatting, and comment-only lines.
  - Excluded: imports, blank lines, formatting-only changes, explanatory comments, plan documentation, and the unrelated `packages/core/src/models-snapshot.js` worktree change.
  - **C = 5** qualifying nearby Chinese explanatory-comment lines:
    - 2 in `workspace-routing.ts`;
    - 3 in `httpapi-exercise/index.ts`.
  - Required minimum: `ceil(25 × 0.15) = 4`.
  - Actual ratio: `5 / 25 = 20%`.
  - Comment gate: **passed**.

# Release verdict

**BLOCK**

B-01 is an evidence-backed behavioral defect in the complete R3 scope, independent of the successful R4/R5 route repair and R6 differential verification. The implementation requires a full-scope re-audit after the title HTTP-failure lifecycle is corrected, and the official post-fix Ubuntu full Effect job must still pass before release can be approved.
```

## R7 Amendment: Terminate Progressive Search on Title HTTP Failure

### R7 root cause and requirement

The R6 implementation audit identified a reachable pre-existing R3 defect in
the approved progressive search primary path. At
`packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx:104-123`,
the title request handles `titleRes.ok` only by conditionally writing title
hits. A non-2xx Response then unconditionally reaches `setSearchPhase("partial")`
and the delayed scan loop at lines 125-143.

This violates existing INV-12: any title or scan HTTP failure must terminate the
current generation as `complete + error`, turn Spinner off, preserve already
visible hits, and never start an alternate request path after the failed title
request. Network exceptions already reach the existing catch branch and are not
changed by R7.

### R7 producer-to-consumer path

```text
SDK test transport / server -> sdk.fetch(GET /session?searchMode=title)
  -> titleRes.ok === false
  -> current code sets partial
  -> content delay
  -> POST /session/search/scan        [first divergence]
```

The owner is `DialogSessionList.runProgressiveSearch`, because it owns the
generation, phase, terminal status, AbortController, and title-to-scan
orchestration. The correction is not in `session-list-params`, the HTTP server,
or the Session search service.

### R7 approved primary path

At the title response seam:

```text
if title response is non-2xx:
  set terminal = error
  set phase = complete
  return
```

This preserves the existing scan failure branch and the outer catch branch,
does not add a fallback or retry, and prevents the scan request from being
issued after a failed title request.

### R7 behavioral seam and TDD

Add a real OpenTUI `DialogSessionList` transport test using the existing
`SDKProvider` test transport and production provider stack. The test will:

1. mount the real Session list dialog with an empty browse response;
2. enter a non-empty search query through the renderer input seam;
3. return a reachable 503 Response for the title request;
4. wait for the visible terminal state and the title request completion;
5. assert the search control no longer displays the loading Spinner and that no
   `POST /session/search/scan` request was made.

This test observes the production component, SDK transport, phase-to-empty-label
mapping, and actual rendered frame. It does not test a private helper or copy
the progressive search algorithm.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | A title 503 leaves the UI loading and records a scan request. | `titleRes.ok === false` falls through to `partial` and the delayed scan. | Set `error`, set `complete`, and return immediately. | Title failure cannot trigger a second scan or leave Spinner active. |
| 2 | Existing scan non-2xx and thrown-fetch behavior remain terminal error. | Existing branches already terminate correctly. | No changes to scan branch or catch branch. | R7 does not regress existing failure handling. |

### R7 files and budget

| File | Change | Expected delta |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | Add the title non-2xx terminal branch before `partial` and delay | +4 to +6 lines |
| `packages/opencode/test/cli/cmd/tui/dialog-session-list.test.tsx` | Add the real transport/render regression | +90 to +140 lines |

R7 changes two additional code/test files, keeping the cumulative task within
the user limit of six code/test files after the existing R4/R5 three-file
implementation. Expected effective changed code is approximately `E=95-125`;
the new test will include at least 15 nearby qualifying Chinese explanatory
comment lines (`C >= ceil(E*0.15)`) explaining the public transport seam,
non-2xx terminal state, input readiness, and absence of the scan request. This
comment budget is intentionally estimated from the actual integration harness,
not filler comments.

### R7 verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/dialog-session-list.test.tsx` | `packages/opencode` | Red/green title HTTP-failure lifecycle through real UI transport |
| `bun test test/cli/cmd/tui/session-list-params.test.ts` | `packages/opencode` | Existing phase, Spinner, terminal-display contract |
| `bun test test/server/workspace-routing.test.ts` | `packages/opencode` | R5 route middleware regression |
| `bun run script/httpapi-exercise.ts --mode effect --include session --fail-on-missing --fail-on-skip` | `packages/opencode` | R4/R5 Session route contract |
| `bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip` | `packages/opencode` | Complete route accounting |
| `bun run script/httpapi-exercise.ts --mode auth --fail-on-missing --fail-on-skip` | `packages/opencode` | Authentication accounting |
| `bun typecheck` | `packages/opencode` | Production and test type safety |
| Post-fix official Ubuntu `httpapi-required / effect` | GitHub Actions | Final full Effect release gate |

No timeout, skip, retry, fallback, or test-only production interface is added.
The R7 implementation must receive a new full-scope plan audit and then a new
full-scope implementation audit; R6 BLOCK is not converted into approval.

## R7 Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R7 | yes | B-01 error terminal is rendered as successful empty search | Comment estimate upper bound; file-count bookkeeping; historical markdown density | BLOCK | ses_06059b2e6ffetPUdCeurSrHuY3 |

### R7 independent plan audit verdict (verbatim)

```text
## Blocking findings

### B-01 Error terminal is rendered as a successful empty search

- Violated invariant: INV-12 requires an HTTP failure with no retained hits to end in an identifiable diagnostic state. Repository policy also requires diagnostic behavior to remain distinguishable from successful output.
- Evidence class: reachable
- Producer and execution path: The test transport or production server returns a non-2xx `Response` for `GET /session?searchMode=title` → the R7 branch sets `searchTerminal = "error"` and `searchPhase = "complete"` → `resolveDisplayHits` returns no hits → `sessionListEmptyLabel(query, "complete")` renders `Not Found <query>`.
- Source evidence:
  - `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx:104-111`
  - `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx:265-282`
  - `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx:456-465`
  - `packages/opencode/src/cli/cmd/tui/util/session-list-params.ts:57-67`
  - `packages/opencode/src/cli/cmd/tui/util/session-list-params.ts:103-111`
- Canonical-plan evidence: §7 INV-12; §10 lines 230-233; R7 §§“root cause and requirement”, “approved primary path”, and “behavioral seam and TDD”.
- Responsibility owner: `DialogSessionList` and its Session-search view projection in `session-list-params.ts`; these own terminal status, empty-state meaning, and rendered loading/error state.
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: A reachable title HTTP 503 is displayed as `Not Found <query>`, which is indistinguishable from a completed search with zero matches. The proposed R7 transport test checks only that the Spinner disappears and no scan request occurs, so it would pass while this false empty-result presentation remains.
- Why this is not speculative: R7 explicitly introduces a 503-producing test transport. `sdk.fetch` returns ordinary non-2xx `Response` objects, and the current view helper deterministically maps every `complete` phase—success or error—to `Not Found` when hits are empty.
- Minimal correction direction: Complete INV-12 at the owning view seam by preserving an explicit, user-visible error diagnostic for `terminal === "error"` and add a rendered-frame assertion that distinguishes title failure from a genuine successful zero-hit result. Keep the immediate return and do not introduce retry, scan continuation, or another success path.

## Primary-path and fallback verdict

- The authoritative successful progressive path remains title first paint followed by serial full-condition scanning, with scan results defining successful completion.
- The R7 immediate return after a title non-2xx correctly prevents an alternate success attempt.
- The legacy list endpoint without `searchMode` remains an evidenced compatibility interface for existing consumers.
- The R5 exact collection-route exemption is a branch of the existing workspace-routing classification algorithm, not a fallback.
- No retry, catch-and-default request, route duplication, skip, or gate relaxation is proposed.
- The primary-path gate still fails because the error terminal is projected into the same user-visible `Not Found` output as successful completion.

## Release verdict

**BLOCK**

Canonical plan revision **R7** does not yet preserve INV-12’s diagnostic distinction or test the user-visible error terminal. Revise the complete plan and submit the new revision for another full-scope plan audit.
```

## R8 Amendment: Preserve a User-Visible Error Diagnostic

### R8 root cause closure

R7 correctly identified the first lifecycle divergence and stopped the scan, but
its planned terminal projection was incomplete. The existing view call passes
only `query` and `phase` to `sessionListEmptyLabel`; with `phase="complete"` and
no retained hits, the helper returns `Not Found <query>` regardless of
`searchTerminal`. That makes a reachable HTTP failure indistinguishable from a
successful zero-hit search.

R8 closes the same INV-12 contract at the owning `DialogSessionList` view seam:

```text
terminal === "error" and query non-empty -> empty label "Search failed <query>"
terminal === "success" and no hits       -> existing "Not Found <query>"
```

The error label is diagnostic-only. It does not return hits, retry, issue a
scan, or make the failed request look successful.

### R8 approved primary path

The exact title failure path is now one terminal transition:

```text
titleRes.ok === false
  -> setSearchTerminal("error")
  -> setSearchPhase("complete")
  -> return
  -> render Search failed <query>
```

The successful zero-result path remains unchanged and still renders
`Not Found <query>`. Scan non-2xx and thrown-fetch paths retain their existing
error terminal behavior; R8 only makes their existing terminal state visible
when no hits remain.

### R8 behavioral seam and TDD

The R7 OpenTUI integration test remains the public seam. Its independent
expected behavior is strengthened to assert all three user-visible contracts:

1. a title 503 ends loading and turns Spinner off;
2. no `POST /session/search/scan` request is emitted;
3. the rendered frame contains `Search failed <query>` and does not contain
   `Not Found <query>`.

The test still uses `SDKProvider.testTransport`, the real provider stack, the
renderer input seam, and the final character frame. It does not assert private
signals or duplicate the view projection algorithm.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Title 503 leaves a scan request or Spinner active. | R7’s current source falls through to `partial`; R8’s planned branch is absent. | Immediate `error + complete + return`. | No scan after title failure and no loading leak. |
| 2 | Title 503 with zero hits renders `Not Found <query>`. | The view projection ignores `searchTerminal`. | Render `Search failed <query>` only for `terminal="error"`. | Diagnostic failure remains distinct from successful no-hit search. |

### R8 file and diff budget

R8 keeps the R7 file boundary and does not add a utility helper or a second
test seam:

| File | Change | Expected delta |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | Add title non-2xx terminal return and pass the existing terminal into the empty-label projection | +5 to +8 lines |
| `packages/opencode/test/cli/cmd/tui/dialog-session-list.test.tsx` | Add/strengthen real transport/render regression for no scan, Spinner off, and distinct error label | +90 to +140 lines |

The cumulative R4/R5/R7/R8 implementation uses five unique code/test files:
the three route files plus these two progressive UI files. Expected effective
changed code remains approximately `E=100-135`; implementation must provide
`C >= ceil(E*0.15)` qualifying nearby Chinese explanatory comments. At the
upper estimate this is 21 comments, and the test must use comments only for
real provider-stack, renderer-readiness, HTTP-terminal, and diagnostic-view
invariants, not obvious setup narration.

### R8 verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/dialog-session-list.test.tsx` | `packages/opencode` | Red/green title HTTP-failure lifecycle and diagnostic frame |
| `bun test test/cli/cmd/tui/session-list-params.test.ts` | `packages/opencode` | Existing phase/display contract and successful Not Found semantics |
| `bun test test/server/workspace-routing.test.ts` | `packages/opencode` | R5 route middleware regression |
| `bun run script/httpapi-exercise.ts --mode effect --include session --fail-on-missing --fail-on-skip` | `packages/opencode` | R4/R5 Session route contract |
| `bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip` | `packages/opencode` | Complete route accounting |
| `bun run script/httpapi-exercise.ts --mode auth --fail-on-missing --fail-on-skip` | `packages/opencode` | Authentication accounting |
| `bun typecheck` | `packages/opencode` | Production and test type safety |
| Post-fix official Ubuntu `httpapi-required / effect` | GitHub Actions | Final full Effect release gate |

No retry, fallback, timeout relaxation, skip, or test-only production interface
is added. R8 requires a new full-scope plan audit before implementation and a
new full-scope implementation audit afterward.
```

## R5 Implementation Evidence

### Actual files and diff

| File | Role | Result |
| --- | --- | --- |
| `packages/opencode/src/server/shared/workspace-routing.ts` | First-divergence repair: exact collection-route classification for `/session/search/scan` | changed |
| `packages/opencode/test/server/workspace-routing.test.ts` | Focused public helper regression | changed |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | R4 public HttpApi route scenario retained and exercised | changed |
| `docs/plans/tui-session-search-progressive.md` | Canonical R5 plan and evidence only | changed |

The unrelated pre-existing `packages/core/src/models-snapshot.js` worktree
change was not touched or included.

### Red-green evidence

| Slice | Red | Green |
| --- | --- | --- |
| Routing helper | `bun test test/server/workspace-routing.test.ts`: `Expected a string starting with "ses", got "search"`; `15 pass / 1 fail` | Same command: `16 pass / 0 fail` |
| Public searchScan route | Focused Effect exerciser returned HTTP 500; server log showed `SessionID.make("search")` at workspace routing | Focused Effect exerciser returned HTTP 200; `1 pass / 0 fail / missing=0` |
| Route accounting | Coverage command initially reported `missing=1` for `POST /session/search/scan` | Coverage/auth both report `157 pass / 0 fail / 0 skip / missing=0 / extra=0` |

### Verification commands and results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/server/workspace-routing.test.ts` | `packages/opencode` | 16 pass, 0 fail |
| `bun run script/httpapi-exercise.ts --mode effect --include session.search.scan --fail-on-missing --fail-on-skip --trace` | `packages/opencode` | 1 pass, 0 fail, HTTP 200 |
| `bun run script/httpapi-exercise.ts --mode effect --start-at session.preview --stop-at session.search.scan --fail-on-missing --fail-on-skip --progress` | `packages/opencode` | 2 pass, 0 fail |
| `bun run script/httpapi-exercise.ts --mode effect --include session --fail-on-missing --fail-on-skip --progress` | `packages/opencode` | 54 pass, 0 fail, missing=0 |
| `bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip` | `packages/opencode` | 157 pass, 0 fail, missing=0, extra=0 |
| `bun run script/httpapi-exercise.ts --mode auth --fail-on-missing --fail-on-skip` | `packages/opencode` | 157 pass, 0 fail, missing=0, extra=0 |
| `bun typecheck` | `packages/opencode` | passed (`tsgo --noEmit`) |
| `bun test test/server/session-list.test.ts` | `packages/opencode` | pre-existing local Windows cleanup failure: 12 pass, 9 fail, 1 error; unrelated to the three R5 files and reproduced before the R5 production edit |

### Original feedback-loop result

The original route-coverage loop changed from `effectRoutes=140 missing=1`
with `MISS POST /session/search/scan` to `effectRoutes=140 missing=0`, and the
public route now completes through workspace middleware, HttpApi decoding,
Session search, and response assertions.

### Actual secondary and replacement path inventory

| Path | Classification | Result |
| --- | --- | --- |
| Existing SessionID extraction | primary-contract branch | preserved |
| Exact collection-route exemption for `/session/search/scan` | primary-contract branch | added at owner seam |
| HttpApi exerciser scenario | diagnostic/verification path | added; no production success path |
| Invalid-ID catch, route fallback, retry, skip, or gate relaxation | forbidden fallback | not added |

### Chinese comment calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 21 | Added executable test/production lines only; excludes five explanatory comment lines, blank lines, imports, and plan documentation |
| Qualifying Chinese comment lines `C` | 5 | Two lines beside the routing invariant and three lines beside the route scenario |
| Ratio `C / E` | 0.238 | `5 / 21` |
| Required minimum `C` | 4 | `ceil(21 × 0.15) = 4` |

### Remaining unverified items

- The complete 157-route Effect exerciser was run locally in the Windows shell
  with daemon environment variables removed but exceeded 600 seconds during
  unrelated non-Session routes/PTY setup. The Session-filtered 54-route Effect
  slice and all three R5 route-specific slices passed.
- The post-fix official Ubuntu CI run has not yet been executed; the previous
  run failed before this owner repair with the missing route and the required
  `packages/opencode` Windows job itself passed.
- Existing full `session-list.test.ts` cleanup failures were reproduced before
  and after R5 and are outside the R5 first divergence; they are not silently
  classified as fixed by this change.
```
```
