# Context Usage 网格图标比例失真：根因诊断与修复方案

> Status: diagnosis-only（本文不改生产代码）
>
> Scope: TUI `/context` 面板 `gridRows` / token icon 分配
>
> Primary code:
> - `packages/opencode/src/cli/cmd/tui/util/context-usage.ts` → `contextGrid`, `computeContextData`
> - `packages/opencode/src/cli/cmd/tui/routes/session/context-usage.tsx` → 渲染
> - `packages/opencode/src/token/accounting.ts` → category token 来源

## 1. 现象

用户在 context usage 网格里看到：

1. 多个组件各自 `exact < 1` 格，单独四舍五入后变成 0 格；加总后本应占好几格，结果整块消失。
2. 例如 used ≈ 100K / context ≈ 300K（理论约 1/3），或 200K / 400K（理论约 1/2），网格上对应图标明显偏少。
3. 百分比文字有时还大致合理，但图标带（symbol 序列）整体“变瘦”。

这是**离散格子分配**问题，不是单纯 UI 刷新问题。

## 2. 当前分配逻辑（现状）

### 2.1 网格规模

`gridSize(contextLimit, columns)` 决定 `width × height = total` 个格子。

### 2.2 每类独立 round + 余数塞 Free

`contextGrid` 核心：

```ts
const exact = (category.tokens / contextLimit) * total
let count = Math.round(exact)
// 再 clamp 到 remaining
// 全部 body 分完后：remaining 一律加给 Free space
```

顺序：

1. 先给 `Autocompact buffer` 预留 `tailCount = round(exact_tail)`。
2. `bodyLimit = total - tailCount`。
3. body 各类按自己的 `Math.round(exact)` 顺序扣 `remaining`。
4. 若还有 `remaining > 0`，**全部**加到 `Free space`。
5. 最后一格用 `fullness = exact - i` 决定 `⛁` / `⛀`（阈值 0.7）。

### 2.3 类别 token 来源

`computeContextData` 组装 categories：

| 类别 | 来源 |
|------|------|
| System / Instructions / Skills / Tool definitions | `acc.breakdown.*` |
| Input Messages / Tool results / Output / Tool calls | `msgDetails.*` |
| Free space | `usableInput - used`（`used = step.input + step.output`） |
| Model reserve | `context - inputLimit` |
| Autocompact buffer | `inputLimit - usableInput` |

**未进入网格类别的 breakdown 字段：**

- `breakdown.attachments`
- `breakdown.pending`

它们会进入 `used`（从而压低 Free 的 token 数），却**不占任何 used 色块**。

## 3. 根因（按贡献排序）

### 根因 A — 独立四舍五入 + 余数只补给 Free（主因）

对每个类别单独 `Math.round(tokens/contextLimit * total)`，**不保证**  
`Σ count_i === total`，也不保证  
`Σ count_used ≈ (used/contextLimit)*total`。

典型失败模式：

| 模式 | 机制 | 视觉效果 |
|------|------|----------|
| 亚半格消失 | 多个类别 `exact ∈ (0, 0.5)` → 各自 round 到 0 | “好几块不满一格”整体归零 |
| 净向下取整 | 多个 used 类 fractional part < 0.5 | used 格数 < 理论格数 |
| 余数归 Free | `remaining` 只加给 Free | Free/空白系统膨胀 |
| 顺序饿死 | 前面 round 向上过多 → 后面 `min(count, remaining)` 变 0 | 后部类别被吃掉 |

复现（纯函数，total=100, context=200_000）：

- 10 个 used 类各 800 tokens → 各 `exact=0.4` → 各 `count=0`
- 合计 exact used = 4 格，实际 used 格 = **0**
- Free 从 exact 96 变成 **100**

这与用户描述的“不满一格的组件合一块应占好几格却几乎看不见”一致。

### 根因 B — 已计入 used 的 token 未映射到网格类别（结构性空洞）

`used = step.input + step.output` 含 attachments / pending 等，  
但 categories 未画 `attachments` / `pending`。

结果：

```
Σ painted_tokens < contextLimit   （差一截“无主” mass）
body 的 exact 之和 < bodyLimit
remaining 再喂给 Free
```

于是：

- 百分比：`used / maxTokens` 仍按真实 used 算（可能显示 ~33%）
- 图标：只有 painted used 类在上色（可能只占 ~25% 格子）

这是“文字占比 vs 图标占比”分叉的重要来源。

### 根因 C — 分母是完整 contextLimit，含 Model reserve / Autocompact

网格按 **全 context 窗口** 铺满，不是按 usable input。

例：usable=200K，used=100K → 用户直觉 50%；  
若 context=400K 且 reserve+buffer 占一半，网格上 used 理论只有 25%。

这不一定是 bug（窗口语义可以包含 reserve），但会放大“怎么只有这么一截”的主观感。  
修复图标分配时要明确产品语义：  
**格子始终表示 contextLimit 全窗**，百分比文案也应对齐同一分母，或在 UI 标明 reserve/buffer。

### 根因 D — 次要视觉因素

1. `fullness < 0.7` 用半实心 `⛀`，边界格看起来更“空”。
2. `tokenAccounting` 内 `alloc = Math.round(chars/denom * input)` 也会让 `Σ category ≠ allocInput`，再叠加网格 round。
3. 百分比展示 `toFixed(1)` 与图标离散化是两套量化；图标误差远大于 0.1% 文案误差。

## 4. 正确不变量

修复后应满足：

1. **闭包**：`Σ count_i === total`（`total = gridW * gridH`）恒成立。  
2. **比例**：对任意类别集合 S，`|Σ_{i∈S} count_i - round_or_floor_exact(Σ tokens_S)| ≤ 类别数` 量级误差，且**不允许**系统性地把误差全部倒给 Free。  
3. **质量守恒**：painted categories 的 token 之和必须等于（或主动补齐到）contextLimit 分母所代表的 mass：  
   `used_painted + free + reserve + buffer === contextLimit`（允许 1 token 舍入差）。  
4. **亚半格可合并**：多个 `exact < 1` 的 used 类，合计 exact ≥ 1 时，应至少分到合计 floor/LRM 对应的格数，而不是全灭。

## 5. 完整解决方案

### 5.1 数据层：先补齐 category mass

在 `computeContextData` 构图前：

1. 增加 `Attachments`（及必要时 `Pending`）类别，token 来自 `bd.attachments` / `bd.pending`；**或**把 attachments 并入 `Input Messages` / `Tool results` 的已有桶，并在详情里拆开。  
2. 计算：

```ts
const painted = sum(non-window categories)
const windowParts = free + providerReserve + compactionBuffer
const gap = maxTokens - (painted + windowParts)
```

3. 若 `gap > 0`：挂到显式 `Unaccounted` 类别，或临时并入最接近语义的桶（优先 Attachments/Pending，禁止默认吞进 Free 而不标注）。  
4. 若 `gap < 0`：按比例或从最大 used 桶扣减，保证 `Σ tokens === maxTokens`（或 === 用于网格的 denom）。

目标：进入 `contextGrid` 的 weights 之和 == `contextLimit`。

### 5.2 分配层：Largest Remainder（Hamilton）替代独立 `Math.round`

替换 `countFor` + “余数塞 Free”：

```ts
function apportion(weights: number[], seats: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (seats <= 0) return weights.map(() => 0)
  if (sum <= 0) {
    // 约定：无权重时全部给最后一个 window 桶，或全空；不要静默丢 seats
    const out = weights.map(() => 0)
    if (out.length) out[out.length - 1] = seats
    return out
  }
  const exact = weights.map((w) => (w / sum) * seats)
  const floors = exact.map((e) => Math.floor(e))
  let remain = seats - floors.reduce((a, b) => a + b, 0)
  const order = exact
    .map((e, i) => ({ i, frac: e - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  const out = floors.slice()
  for (let k = 0; k < remain; k++) out[order[k % order.length].i]++
  return out
}
```

流程：

1. `total = gridW * gridH`。  
2. 对**全部** categories（含 Autocompact / Free / Reserve）一次 `apportion(tokens[], total)`。  
3. 若仍需 Autocompact 固定贴在网格尾部：  
   - 先 `apportion` 得各类 count；  
   - **渲染顺序**把 Autocompact 的 count 个格子 append 到尾部，body 保持原类别顺序；  
   - 不要先 round tail 再在 body 里二次 round。  
4. 删除“remaining → Free only”分支。  
5. `fullness` 仍可用 `exact - localIndex`，但 `exact` 建议改为 `count` 的连续解释：  
   - 前 `floor(exact)` 格 fullness=1；  
   - 若 LRM 多给 1 格，最后一格 fullness = fractional part 或 1（二选一，测试锁死）。

### 5.3 可选增强：最小可见性策略（产品选择）

若希望“任何 tokens>0 的 used 类至少 1 格”：

1. 先给 `tokens>0 && !isDeferred` 的类各 1 席（总数不超过 total）。  
2. 剩余 seats 再对 `weights' = max(0, tokens - tokenPerSeat)` 做 LRM。  

注意：这会轻微牺牲严格比例，应用在“小类别可读性”优先时。  
默认推荐：**纯 LRM**，不强制 min-1，避免小窗下 Free 被挤没。

### 5.4 文案 / 分母对齐

1. 顶栏百分比继续用 `used / maxTokens`，与网格同一 `maxTokens`。  
2. 若产品希望“相对 usable”：  
   - 要么网格分母改 usable（reserve/buffer 另条显示）；  
   - 要么百分比旁标注 `of context` / `of usable`。  
3. 列表里的 `percent(tokens, maxTokens)` 保持与格子同一套 denom。

### 5.5 测试（应新增，回归锁死）

放在 `packages/opencode/test/cli/tui/context-usage.test.ts`：

1. **闭包**：任意 categories + total，`flat(grid).length === total` 且 `Σ count_by_name === total`。  
2. **亚半格合并**：10×`exact=0.4` used + free → used 合计 count === 4（或 3/4/5 内 LRM 合法范围，且 **≠0**）。  
3. **比例**：单类 100K / 300K，total=120 → 该类 count === 40。  
4. **attachments 不丢**：breakdown.attachments>0 时，used 色格合计与 `(used/context)*total` 误差 ≤1（在 mass 补齐后）。  
5. **Autocompact 仍在尾部**：最后 N 格 categoryName === Autocompact buffer，且 N === LRM 结果。  
6. **不把系统误差只塞 Free**：构造 used 全为 `*.4` 的向量，assert Free 的 count ≤ ceil(exact_free)+1，而 used 合计 ≥ floor(exact_used)。

### 5.6 建议实现切分

| Step | 改动 | 风险 |
|------|------|------|
| 1 | 抽出纯函数 `apportion(weights, seats)` + 单测 | 无 UI |
| 2 | `contextGrid` 改 LRM，去掉 Free remainder hack | 网格外观变化 |
| 3 | categories 纳入 attachments/pending 或 gap 桶 | 列表多一行 |
| 4 | 对齐 fullness / 符号阈值（可选） | 纯视觉 |
| 5 | 百分比文案分母说明（可选） | 文案 |

## 6. 非方案（避免）

1. **只把 Math.round 改成 Math.ceil/floor**：仍各自独立，总和仍漂。  
2. **只提高 grid 分辨率**：能减小误差，治不好亚半格全灭与空洞。  
3. **继续 “remaining → Free”**：这是系统偏置的来源。  
4. **在渲染层用 CSS/字符串重复补丁**：根在 `contextGrid` 的整数分配。

## 7. 结论

根因不是“百分比字符串 toFixed”，而是：

1. **`contextGrid` 对每类独立 `Math.round`，余数只补给 Free** → used 图标系统偏少，小碎片可集体归零；  
2. **`attachments`/`pending` 等 mass 进了 used 却未进网格类别** → 无主 token 再被 Free 吃掉；  
3. **全窗分母（含 reserve/buffer）** 会让“相对 usable 的 1/2”在全窗上只占更小一截（语义问题，需产品确认）。

正确修法：  
**category mass 先闭包到 contextLimit，再对固定 total seats 做最大余数法一次分配，保证 `Σ count === total`，并按自然顺序渲染（Autocompact 仅调整放置位置，不二次 round）。**

## 8. 关键代码锚点

- `contextGrid`：`packages/opencode/src/cli/cmd/tui/util/context-usage.ts:601-666`
- categories 组装：同文件 `~760-782`
- 渲染：`packages/opencode/src/cli/cmd/tui/routes/session/context-usage.tsx:207-235`
- breakdown 含 attachments/pending：`packages/opencode/src/token/accounting.ts:384-390`
