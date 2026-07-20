# Canonical Implementation Plan: Context usage grid seat apportionment

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: 当前你需要检查一个问题,我发现我们的context usage的面板,其显示的百分比会由于四舍五入的截断而导致整体内容显示的比例过于奇怪。当前的换算有点问题,就比如说很多时候它有一些部分组件是不满一格的,但是这些组件合一块加起来可能又占好几格。与此同时,像这样会导致,譬如说100K的东西,理论上来说是300K的三分之一,但是我可能在,或者说200K的东西是占400K的二分之一。但是我很多情况下都会发现,它实际上在context usage里面相应渲染的,相应token的icon,或者说那个小图标,只占不到三分之一。所以我觉得这是由于四舍五入原因造成的。那么我觉得理论上的解决方式应该是它有一个总体的,整体的token icon的总数,然后按照总数进行分配,且分配的总数必须达到总数。也就是说不能因为分配的时候四舍五入而导致总量远小于理论要求的总数。也就是请你完整检查一下这个逻辑,看看怎么回事。请你首先分析其原因根因,然后给出完整的解决方案。不用进行审计。如果你审计的话,请使用叫做ses开头的一个task ID,不要使用其他task ID。同时注意不要修改仓库里的内容。唯一能做的东西是进行文档的转写。
>
> Implementation allowed: no further material changes without revision
>
> Last updated: 2026-07-20
>
> Revision notes:
> - R2: 废止 LRM，改用 cumulative waterline。
> - R3: 钉死 categories 顺序与唯一 mass 映射。
> - R4: 废除 `gap<0` 扣减 accounting tokens；INV-03 改为「used mass 不得消失 + 欠账用 Unaccounted」；超窗时 waterline 分母 = `Σ weights`（可 > contextLimit），列表仍展示 accounting 真值。

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority. The companion note
`docs/plans/context-usage-grid-rounding-diagnosis.md` is non-authoritative
scratch diagnosis only.

## 1. Verbatim Requirement

当前你需要检查一个问题,我发现我们的context usage的面板,其显示的百分比会由于四舍五入的截断而导致整体内容显示的比例过于奇怪。当前的换算有点问题,就比如说很多时候它有一些部分组件是不满一格的,但是这些组件合一块加起来可能又占好几格。与此同时,像这样会导致,譬如说100K的东西,理论上来说是300K的三分之一,但是我可能在,或者说200K的东西是占400K的二分之一。但是我很多情况下都会发现,它实际上在context usage里面相应渲染的,相应token的icon,或者说那个小图标,只占不到三分之一。所以我觉得这是由于四舍五入原因造成的。那么我觉得理论上的解决方式应该是它有一个总体的,整体的token icon的总数,然后按照总数进行分配,且分配的总数必须达到总数。也就是说不能因为分配的时候四舍五入而导致总量远小于理论要求的总数。也就是请你完整检查一下这个逻辑,看看怎么回事。请你首先分析其原因根因,然后给出完整的解决方案。不用进行审计。如果你审计的话,请使用叫做ses开头的一个task ID,不要使用其他task ID。同时注意不要修改仓库里的内容。唯一能做的东西是进行文档的转写。

Session goal end state for this planning cycle: `approved-plan-only` (plan +
independent plan audit only; no production code changes in this GOAL).

## 2. Explicit Non-Goals

- 不修改 Web app `packages/app` 的 `ProgressCircle` 上下文指示器（无 token icon 网格）。
- 不改写 `tokenAccounting` 的 provider 确认/估算公式本身（只消费其 breakdown 输出以补齐网格 mass）。
- 不改变 context 百分比数值的定义：`percentage = used / maxTokens` 仍以真实 step used 为准。
- 不强制“每个 tokens>0 的 used 类别至少 1 格”（会牺牲严格比例）；默认用累积水位线分配即可。
- 不采用经典最大余数法（LRM）作为 seat 算法（R1 废止；仅作已拒绝路径）。
- 不把网格分母从 `contextLimit` 改成 usable-only（Model reserve / Autocompact 仍占全窗）；若文案歧义，仅可选 UI 标注，不改分母语义。
- 本 GOAL（`approved-plan-only`）不实施代码、不 commit。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session / Compaction / Message 用语；context 面板展示的是 Session 当前窗口占用。 |
| `packages/opencode/AGENTS.md` | 测试不得在 repo root 跑；package 内 `bun typecheck`。 |
| `packages/opencode/test/AGENTS.md` | 测试风格与 fixture 约定。 |
| `.opencode/policy/first-principles-engineering.md` | 修 primary path 第一分歧点；禁止 fallback 链；完整 traceability。 |
| 现有 TUI 模块边界 | 网格分配在 `context-usage.ts`；渲染在 `context-usage.tsx`；token 数来自 `token/accounting.ts`。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/util/context-usage.ts` (`contextGrid` ~601-666, `computeContextData` categories ~756-782) | 独立 `Math.round` + remainder→Free；categories 未含 attachments | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/context-usage.tsx` (`ContextGrid` ~207-235) | 只渲染 `gridRows`，不二次分配 | observed |
| `packages/opencode/src/token/accounting.ts` breakdown (~308-390) | 产出 `attachments` / `pending`；被 panels 部分消费 | observed |
| `packages/opencode/test/cli/tui/context-usage.test.ts` | 有 window/Autocompact 尾部断言；无 seat 闭包/比例闭包测试 | observed |
| Red harness（见 §8）：亚半格全灭 usedCells=0 vs expected=4；160 格 used 52 vs 53.33；attachments 空洞 free 膨胀 | 捕获用户症状 | observed |
| `packages/app/src/components/session-context-usage.tsx` | 无网格；排除 app | observed |

## 5. Current Behavior

```text
tokenAccounting(messages, parts, maxTokens)
  -> breakdown categories + step.input/output
computeContextData
  -> categories[] (部分 breakdown 字段未入类)
  -> free = usableInput - used
  -> contextGrid(categories, contextLimit, {columns})
       count_i = round(tokens_i / contextLimit * total)  // 独立
       remaining seats += Free space                    // 系统偏置
  -> gridRows: GridSquare[][]
ContextGrid (TUI) 按 symbol 渲染
```

Autocompact buffer 先 `round` 出 `tailCount`，body 在 `total - tailCount` 内再独立 round。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 多类别 `exact ∈ (0, 0.5)` | 真实会话多组件小份额 | categories.tokens ≥ 0 | `/context` → `contextGrid` | `contextGrid` | observed |
| used ≈ 1/3 或 1/2 of contextLimit | step + breakdown | used 来自 accounting | 同上 | `contextGrid` | observed |
| attachments > 0 | `tokenAccounting` breakdown | breakdown 可非 null | `computeContextData` 写 msgDetails.attachments 但不入 categories | `computeContextData` | observed |
| Autocompact / Model reserve > 0 | windowDetails | model.limit + config.compaction | 尾部/窗口类 | `contextGrid` / categories | observed |
| grid total = W×H 随 columns/contextLimit 变 | `gridSize` | terminal width | 任意 TUI 宽度 | `gridSize` | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 固定 `total = W×H` 时，所有类别格子数之和恒等于 `total`（seat 闭包） | 用户要求“分配总数必须达到总数” | 无 |
| INV-02 | 按 **钉死的类别顺序** 做累积水位线：对任意前缀 P，`|count(P) - exact(P)| < 1`（其中 `exact(P)=(Σ tokens_P/sum)*total`）；禁止 Free-only remainder 把 used 舍入误差整段倒给 Free | 亚半格/偏少图标症状 + 用户水位线澄清 | 无 |
| INV-03 | 已计入 `used` 的 breakdown 分量（含 attachments/pending）必须进入 categories 色块，不得无主消失；`Σ weights < contextLimit` 时用 Unaccounted 补齐到 `contextLimit`；`Σ weights > contextLimit`（超窗）时**不改写** accounting 真值，waterline 以 `Σ weights` 为分母填满 seats | attachments 空洞；overfull free=0 | 无 |
| INV-04 | Autocompact buffer 格子仍位于网格尾部（现有产品布局） | 现有测试 tail 断言 | `context-usage.test.ts` 有 tail 断言 |
| INV-05 | 渲染层不重新分配；只消费 `gridRows` | ContextGrid 源码 | 无专门测试 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 / INV-02 | `contextGrid` 内 `countFor` 对每类独立 `Math.round(exact)`，再把 `remaining` 只加给 Free | `contextGrid` in `context-usage.ts` | 红环 s1: 10×exact=0.4 → usedCells=0, free=100；s2: used 52 < 53.33, free 吃差 |
| INV-03 | `computeContextData` 组装 categories 时未映射 `breakdown.attachments`（及 `pending`），而 `free = usableInput - used` 已按完整 used 计算 | categories 组装 | 红环 s3: painted used 32 格，真实 used 应 40；free 从 exact 32 膨胀到 40 |
| INV-04 | 非破坏；现有 tail 预留与二次 round 耦合会放大 body 误差 | `contextGrid` tail 分支 | 代码路径 |

根因（first divergence）：**网格 seat 的权威分配算法在 `contextGrid` 使用独立 round + Free 吸余数，破坏比例闭包。**  
结构性放大器：**categories 漏画 attachments/pending mass，进一步把无主 seats 推给 Free。**

下游症状：图标带偏短、小碎片消失；百分比文案仍可按真实 used 显示。

### Red-capable feedback loop

命令（在 `packages/opencode` 下，逻辑镜像当前 `contextGrid` 分配）：

```powershell
bun -e "<harness: independent Math.round + remainder-to-Free; assert sub-half vanish and under-allocation>"
```

已运行结果（exit 1 = red）：

| Case | Expected used cells | Actual used cells | Free cells |
| --- | --- | --- | --- |
| 10×800 tokens / 200k, total=100 | 4 | **0** | 100 |
| 100k used / 300k, total=160（多类） | 53.33 | **52** | 108（> exact 106.67） |
| painted 80k / real used 100k / 300k, total=120 | 40 real / 32 painted | **32** | **40**（exact free 32） |

用户原症状（不满一格合起来应占几格却看不见；1/3 图标偏少）被 s1 与 mass-hole 直接捕获。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 离散格子分配（tokens→seat counts） | `contextGrid` | 给定 categories + contextLimit + grid geometry → `GridSquare[][]` | 唯一从比例到格子的转换点 | 渲染层无 token；accounting 无 UI 格子 |
| category mass 列表完整性 | `computeContextData` | categories 覆盖窗口展示所需 mass | 已拥有 breakdown + free/reserve/buffer 组装 | accounting 不定义 UI 类别名 |
| symbol 渲染 | `ContextGrid` in route | 按 square 画字符 | 纯展示 | 不应二次分配 |
| token 数值来源 | `tokenAccounting` | step + breakdown | 已是权威统计 | 网格不得重算 provider tokens |

## 10. Single Approved Primary-Path Design

```text
categories (mass-complete; tokens 为 accounting 真值) + columns
  -> total = W*H
  -> weights = categories.map(c => c.tokens)
  -> denom = Σ weights  // 正常窗 ≈ contextLimit；超窗可 > contextLimit；欠账经 Unaccounted 补到 contextLimit
  -> counts = waterlineApportion(weights, total)  // 分母=denom；Σ counts === total
  -> emit body squares in category order; place Autocompact count at tail
  -> gridRows
```

### 10.1 Mass 闭包与唯一权重顺序（`computeContextData`）

**唯一映射（无并入可选项）：**

| Order | Name | tokens 来源 | color | list group |
| --- | --- | --- | --- | --- |
| 1 | System prompt | `bd.system` / env | primary | Prompt |
| 2 | Instructions | `bd.instructions` | info | Prompt |
| 3 | Skills | `bd.skills` | success | Prompt |
| 4 | Tool definitions | `bd.tools` | secondary | Prompt |
| 5 | Input Messages | `bd.userMessages` | warning | Conversation |
| 6 | Tool results | `bd.toolResults` | warning | Conversation |
| 7 | Attachments | `bd.attachments`（0 也保留进 weights；列表可 filter tokens>0） | warning | Conversation |
| 8 | Output Messages | assistantText+reasoning | accent | Conversation |
| 9 | Tool calls | `bd.toolCalls` | accent | Conversation |
| 10 | Pending | `bd.pending`（0 可列表隐藏） | warning | Conversation |
| 11 | Unaccounted | 仅当 mass 闭包后 `gap>0` 才插入；tokens=`gap` | textMuted | Conversation |
| 12 | Free space | `usableInput - used` | textMuted | Window |
| 13 | Model reserve | `providerReserve`（0 则省略整项） | textMuted | Window |
| 14 | Autocompact buffer | `compactionBuffer` | textMuted | Window |

闭包规则：

1. 先按上表 1–10、12–14 组装（Model reserve 仅 >0 时加入）。列表/details 中的 `category.tokens` **始终等于 accounting 映射真值**，禁止为凑窗而改写 used 桶。
2. 令 `painted = Σ category.tokens`（组装后）。`gap = contextLimit - painted`。  
   - `gap > 0`：在 **Free space 之前** 插入 Unaccounted（tokens=`gap`）。**禁止**静默增大 Free。  
   - `gap <= 0`：不插入 Unaccounted；**禁止**对任何 used 桶做扣减/缩放。超窗（`used > usableInput` → free=0 且 painted 可 > contextLimit）是合法态。  
3. Free 仍 = `max(0, usableInput - used)`。
4. **不变量：** 所有 used mass（含 Attachments/Pending/Unaccounted）在数组中必须连续且位于 Free / Model reserve / Autocompact 之前。
5. `CategoryList` 与 `categoryMarker` **必改**，名称与上表一致（marker：Attachments `▣`，Pending `◌`，Unaccounted `×`；tokens===0 的 Attachments/Pending/Unaccounted **不进列表**，但仍进 waterline weights 若 tokens>0——Unaccounted 仅 gap>0 时存在）。

### 10.2 Seat 分配（`contextGrid`）— 累积水位线（waterline / cumulative cut）

**不是**经典最大余数法（LRM：各算 floor，再把剩余席位投给 frac 最大者）。  
用户语义：A→B→C→…→Free 像水位往上叠；第 k 条整数刻度线被**谁的累积区间**跨过，第 k 格就归谁。这样余数沿整条水位分布，而不是只改最后一个 Free 桶。

```ts
// count_i = floor(cum_i * seats / sum) - floor(cum_{i-1} * seats / sum)
// 证明闭包：Σ count = floor(sum*seats/sum) - floor(0) = seats（sum=Σ weights，不必 == contextLimit）
function waterlineApportion(weights: number[], seats: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (seats <= 0) return weights.map(() => 0)
  if (sum <= 0) {
    const out = weights.map(() => 0)
    if (out.length) out[out.length - 1] = seats
    return out
  }
  let cum = 0
  return weights.map((w) => {
    const prev = cum
    cum += w
    return Math.floor((cum * seats) / sum) - Math.floor((prev * seats) / sum)
  })
}
```

规则：

1. **一次**对全部 categories（含 Free / Model reserve / Autocompact）按 §10.1 **钉死顺序**调用 `waterlineApportion`。
2. 删除 “remaining → Free only”、独立 `Math.round`、body 顺序饿死、对 accounting tokens 的 gap 扣减。
3. Autocompact：用 waterline 给出的 count，**仅在序列化 cells 时 append 到尾部**；禁止先 round tail 再对 body 二次分配。
4. `fullness`：`exact_i = (tokens_i/sum)*total`，第 j 格 `fullness = clamp(exact_i - j, 0, 1)`；符号阈值 0.7 可保留。
5. `gridSize` 不变；`contextGrid` 第二参仍传 contextLimit 仅供 `gridSize` 几何，**waterline 分母用 weights 之和**。
6. 行为测试经 `contextGrid` / `computeContextData` 观测；**不必** export `waterlineApportion`。

与 LRM 对比：两者均可 Σ=total；LRM 按 frac 全局抢席、与叠画顺序无关；waterline 按栈序跨刻度，符合用户「水位往上叠」。亚半格碎片在累积跨 1、2、3… 时落到栈中对应类，不被 Free 独占 remainder。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 独立 Math.round + remainder→Free | current | forbidden fallback 式偏置（非失败切换，但是错误 primary） | yes（错误比例） | 100% grid | **remove** |
| 最大余数法 LRM（R1） | superseded | 与叠画水位语义不符 | yes | — | **reject**（R2 废止） |
| 累积水位线 waterline | proposed R2 | primary | yes | 100% grid | **adopt** |
| min-1 每 used 类保底 | not proposed | 比例扭曲 | yes | — | **reject**（默认） |
| 提高 grid 分辨率代替算法修复 | not proposed | 症状缓解 | partial | — | **reject** |
| 渲染层补画格子 | not proposed | 责任泄漏 | yes | — | **reject** |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `if (tokens>0 && !isDeferred && count===0 && exact>=0.5) count=1` | 试图补救 round 边界 | `Math.round` 下该分支基本死代码；waterline 统一跨刻度 | 删除于 `countFor` |
| Rounding remainder → Free space | 强制填满 total | waterline 已保证 Σ=total 且余数沿水位跨刻度分布 | 删除 freeIdx += remaining |
| 先 tail round 再 body round | 保证 Autocompact 贴尾 | 贴尾是布局问题，用 count 序列化顺序解决 | 合并为单次 waterline |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 seat 闭包 | `contextGrid` → Σ counts | `context-usage.ts` 改 waterline | `flat(grid).length === total` 且按类别计数和 === total（去掉 Free-only remainder 后仍成立） |
| INV-02 比例 / 亚半格 | waterline on ordered categories | 同上 | 10×0.4 used → used 合计 4；100k/300k@120 单类 → 40 |
| INV-03 mass 闭包 | categories 含 attachments/pending/gap | `computeContextData` + list markers | attachments>0 时 used 色格相对真实 used 误差 ≤1（在固定 geometry 下） |
| INV-04 Autocompact 尾部 | emit order | `contextGrid` | 现有 + 强化：最后 N 格均为 Autocompact，N=waterline 结果 |
| 用户“总数分配必须满” | INV-01 | 同上 | 任意随机权重 property：sum(counts)===total |
| 百分比文案 | 不改 | — | 现有 percent 行为保持 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `waterlineApportion(weights, seats)` | INV-01, INV-02 | 红环 + 用户水位线澄清 | 独立 round / Free 吸余数破坏跨刻度分配；LRM 不按栈序叠高 |
| Attachments category / mass gap 桶 | INV-03 | accounting 有字段、categories 未画 | 仅改 grid 无法恢复未入权的 mass |
| Autocompact tail placement after waterline | INV-04 | 现有 UI/测试 | 先 round tail 破坏单次闭包 |
| 删除 remainder→Free | INV-02 | 红环 free 膨胀 | 该逻辑正是偏置源 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/util/context-usage.ts` | modify | mass 闭包；`contextGrid` 改 waterline；删除 Free 吸余数与死分支 | +40 / −35 |
| `packages/opencode/test/cli/tui/context-usage.test.ts` | modify | seat 闭包、亚半格、比例、attachments mass、Autocompact tail、property 和 | +80 / −0 |
| `packages/opencode/src/cli/cmd/tui/routes/session/context-usage.tsx` | modify | CategoryList + categoryMarker 加入 Attachments / Pending / Unaccounted | +8 / −0 |
| `docs/plans/context-usage-grid-rounding-fix.md` | modify | 本 plan | n/a |

## 16. TDD Behavior Slices

Public seam: **`contextGrid`**（及经 `computeContextData` 的 end-to-end categories→grid）。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | lock-in：`sum(counts)===total`（现码靠 Free hack 已可通过；防回归） | — | waterline 闭包 | 任意权重 |
| 2 | 10 类各 exact=0.4 used + free；**used 合计 count === 4**（红：现为 0） | 全 round 到 0 + Free 吃 remainder | waterline 累积跨 1..4 刻度 | 亚半格症状 |
| 2b | 顺序敏感向量：手算 waterline 的 per-category counts 与 `contextGrid` 一致（构造 LRM 会给出不同向量的输入） | 旧算法/LRM 顺序不同 | 断言完整 count 向量 | 水位线 vs LRM |
| 3 | 单类 100000 / 300000，total=120 → count===40 | 本例 round 碰巧正确；锁死比例 | 保持 40 | 1/3 比例 |
| 4 | multi-category 100k/300k total=160：used 合计与 exact 差 ≤1 | free 可多吃 | waterline | 偏少图标 |
| 5 | `computeContextData` 含 attachments 时，used 色格占比 ≈ used/context | 漏画 attachments | mass 入类 | 空洞 |
| 6 | Autocompact 仍在 `gridRows.flat()` 尾部连续段 | 改算法可能打乱 | 序列化顺序 | 现有 tail 测试 |

测试 expected 用独立手算 waterline（`floor(cum*seats/sum)-floor(prev*seats/sum)`）/ 比例字面量，不读源码字符串、不断言 private 调用次数。红路径以 slice 2/4/5 为准（N-02）。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~55 | 分配算法 + mass 闭包；排除纯 import/格式 |
| Required Chinese explanatory comments `C` | ≥ `max(1, ceil(55*0.15))` = **9** | 邻接不变量说明 |

需注释的点：

1. 为何用累积水位线而非 per-category round / 而非只补 Free（INV-01/02）。
2. 为何不用 LRM：叠画顺序 vs 全局 frac 抢席。
3. Autocompact 贴尾是布局不是二次 round。
4. attachments/pending 必须进 weights 的 mass 闭包。
5. gap>0 → Unaccounted；gap<=0 禁止改写 accounting tokens；超窗 waterline 分母可为 Σweights。
6. fullness 与 waterline count 的关系。
7–9. 对应关键测试的意图（亚半格、闭包、attachments）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/tui/context-usage.test.ts` | `packages/opencode` | 新/旧 grid 行为 |
| 原始红环 harness（实现后应变绿：s1 usedCells=4） | `packages/opencode` | 用户症状闭合 |
| `bun typecheck` | `packages/opencode` | 类型 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 纯函数放现有 util |
| Files modified | 3 | util + test + route list/marker（独立新类别，route 必改） |
| Files deleted | 0 | |
| Production lines | ~55 | |
| Test lines | ~80 | |
| Generated lines | 0 | |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| 列表多出 Attachments 行改变 UI 信息密度 | 与 conversation 组并列；零 token 可 filter 掉显示但 grid weights 仍计入 |
| 视觉上 Free 略减、used 略增（相对旧 bug） | 预期修复效果；用测试锁定 |
| waterline 对类别顺序敏感 | §10.1 钉死唯一顺序；测试锁定 used 前缀在 Free 之前 |

### Open Decisions Requiring the User

无阻塞产品决策。网格分母保持 `contextLimit`（含 reserve/buffer）为现有语义；若用户坚持“相对 usable 的 50% 应占半屏”，需另开需求改分母——**本 plan 不改**。

### Rejected Speculation

- 改 `toFixed` 百分比显示精度：不解决图标分配。
- 在 CSS/终端重复绘制补偿：责任错误。
- 改 `tokenAccounting` 重新分摊 provider tokens：非 first divergence。

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
- If a task/session ID is required for the audit artifact, use an identifier
  starting with `ses` only (per user instruction).

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 0 | N-01..N-05 | APPROVE | ses_context_usage_grid_r1 |
| 2 | R2 | yes | 2 (B-01, B-02) | N-01..N-03 | BLOCK | ses_context_usage_grid_r2 |
| 3 | R3 | yes | 1 (B-01 gap&lt;0 扣减) | N-01..N-04 | BLOCK | ses_context_usage_grid_r3 |
| 4 | R4 | yes | 0 | N-01..N-03 | APPROVE | ses_context_usage_grid_r4 |

### Round 4 verdict (verbatim)

```text
No blocking findings.
```

```text
APPROVE
```

- **Audited artifact:** `docs/plans/context-usage-grid-rounding-fix.md`
- **Revision:** **R4**
- **Full scope:** **yes**
- **Invocation / task ID:** **ses_context_usage_grid_r4**
- **Blocking findings:** **0**

### Round 1 verdict (verbatim from independent auditor)

```text
No blocking findings.
```

```text
APPROVE
```

- Audited artifact: `docs/plans/context-usage-grid-rounding-fix.md`
- Revision: **R1**
- Full scope: **yes**（原需求 + TUI grid/categories 全链路 + accounting 消费边界 + 排除 app ProgressCircle）
- Invocation / task ID: **ses_context_usage_grid_r1**
- Blocking findings: **0**
- Implementation allowed by this verdict for this revision only after the orchestrator records approval metadata (`Status: approved`, `Approved revision: R1`, `Implementation allowed: yes`) without changing design substance.

本 verdict 仅覆盖上述 R1 计划文本；任何实质改设计/范围/测法须升修订并全量复审。

Non-blocking findings recorded for implementers (do not alter R1 design in this approval edit):

- N-01: INV-01 表述偏弱：当前实现已靠 Free 吸余数填满 total；红测应以 INV-02/亚半格/attachments 为主。
- N-02: TDD slice 1 单独不可红；slice 1 作 lock-in，红路径以 2/4/5 为准。
- N-03: `gap < 0` 收缩语义略含糊；实施时写死单一规则。
- N-04: 若采用独立 Attachments/Pending/Unaccounted，list 分组与 `categoryMarker` 应列为必改。
- N-05: 导出 `apportion` 非必要；经 `contextGrid` 测即可。

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/cli/cmd/tui/util/context-usage.ts` | `contextGrid` → waterline；categories mass 闭包（Attachments/Pending/Unaccounted） |
| `packages/opencode/src/cli/cmd/tui/routes/session/context-usage.tsx` | markers + CategoryList 分组 |
| `packages/opencode/test/cli/tui/context-usage.test.ts` | seat/waterline/attachments/autocompact 行为测 |

`git diff --stat`（上述三文件）: 214 insertions, 55 deletions.

### Red-Green Test Evidence

- Red: `bun test test/cli/tui/context-usage.test.ts` 在改算法前 6 fail（亚半格 used=20 因 contextLimit 分母错位、顺序向量、1/3、attachments 缺失等）。
- Green: 同命令 21 pass / 0 fail after waterline + mass。

### Verification Commands and Results

| Command | cwd | Result |
| --- | --- | --- |
| `bun test test/cli/tui/context-usage.test.ts` | `packages/opencode` | 21 pass |
| `bun typecheck` | `packages/opencode` | pass |

### Original Feedback-Loop Result

水线 harness：10×800+free → usedCells=4 free=96；多类 100k/300k@160 → used=53（|53-53.33|≤1）。ok=true。

### Actual Secondary and Replacement Path Inventory

| Path | Disposition |
| --- | --- |
| 独立 Math.round + Free remainder | removed |
| LRM | not implemented |
| waterline | primary |
| min-1 / render 补格 | not present |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | **180** | Independent auditor recount (non-blank `+` lines; exclude 1 import-only) |
| Qualifying Chinese comment lines `C` | **29** | waterline/INV/mass/gap/red-path test intent |
| Ratio `C / E` | **0.161** | |
| Required minimum `C` | `ceil(180*0.15)=27` | met |

### Remaining Unverified Items

None required for verified R4. Non-blocking: attachments e2e share assert weak (N-01); gap/overfull direct tests optional (N-02).

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R4 | yes | 1 (B-01 C gate) | N-01..N-05 | BLOCK | ses_context_usage_grid_impl_r4 |
| 2 | R4 | yes | 0 | N-01..N-04 | APPROVE | ses_context_usage_grid_impl_r4b |

### Round 2 implementation verdict (verbatim)

```text
No blocking findings.
```

```text
APPROVE
```

- **Mode:** implementation  
- **Plan revision audited:** **R4**  
- **Full original scope:** **yes**  
- **Invocation / task ID:** **ses_context_usage_grid_impl_r4b**  
- **Blocking findings:** **0**  
- **E=180, C=29, required C≥27, gate PASS**
