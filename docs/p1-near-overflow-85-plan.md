# 方案：Near-Overflow 提示阈值 85% + 模型切换时重置标志

## 1. 已阅读的文件

| 文件 | 行范围 | 为什么相关 |
|---|---|---|
| `src/session/prompt.ts` L2091-2095 | `nearOverflowNotified` 声明 + 注释 | 标志生命周期 |
| `src/session/prompt.ts` L2137 | `const model = yield* getModel(...)` | model 每步重新获取——模型切换在同一 loop 内发生 |
| `src/session/prompt.ts` L2342-2347 | `estimatedInput` 计算 | 使用当前 model 估算 |
| `src/session/prompt.ts` L2367-2371 | compaction 后重置 `nearOverflowNotified = false` | 当前唯一的重置路径 |
| `src/session/prompt.ts` L2373-2389 | near-overflow 检查 + 注入 | 80% 阈值 + `nearOverflowNotified` 防重复 |
| `src/session/overflow.ts` L9-20 | `usable()` 函数 | 基于当前 model 的 context limit 计算 usable tokens |

## 2. 当前问题

`nearOverflowNotified` 标志只在 compaction 后重置（L2369）。当模型切换（如从 128K 小模型切到 1M 大模型）但不触发 compaction 时：

1. 小模型：上下文达到 80% → 提示注入 → `nearOverflowNotified = true`
2. 切到大模型：`model` 在 L2137 重新获取（新模型 1M context），`usableTokens` ≈ 980K，`estimatedInput` ≈ 102K → 10% << 85%
3. `nearOverflowNotified` 仍为 `true` → **后续如果上下文增长到新模型 85% 时不会再次提示**（bug）
4. 反方向：如果大模型先达到 80% → 切到小模型 → 标志仍 `true` → 小模型即使 100% 也不提示（bug）

## 3. 推荐方案

**文件**：`src/session/prompt.ts`

**改动 1**：阈值 0.8 → 0.85（L2379）

**改动 2**：重构 L2377-2389 为双向检查——达到 85% 时注入提示，降到 85% 以下时重置标志

```typescript
// [local-smark] 上下文接近溢出时的轻量提示：首次达到 85% usable 时注入一次。
// 当上下文降到 85% 以下时重置标志——模型切换（如从小模型切到大模型）后
// 上下文占比可能大幅下降，此时重置标志使后续再次达到 85% 时可以重新提示。
// 提示是 ephemeral 的（仅存在于 messages 数组，不持久化到 DB），
// 不会泄漏给 compaction 模型。不限制工具使用、不退化回复质量。
if (!isLastStep) {
  const usableTokens = usable({ cfg: yield* config.get(), model })
  // threshold=0 时（无上下文上限模型）永远不触发注入，但 else 重置仍生效
  const threshold = usableTokens > 0 ? Math.floor(usableTokens * 0.85) : 0
  if (usableTokens > 0 && estimatedInput >= threshold) {
    if (!nearOverflowNotified) {
      messages.push({
        role: "user" as const,
        content: "Context is approaching the model's limit. To avoid context compaction degrading task quality, prefer targeted reads (small offset/limit) over full-file reads, and narrow grep patterns over broad searches. Do not reduce response quality. If work is still in progress, ignore this and continue per user instructions.",
      })
      nearOverflowNotified = true
    }
  } else {
    // 上下文降到阈值以下（或无上限模型）：重置标志，使后续再次达到 85% 时可以重新提示
    nearOverflowNotified = false
  }
}
```

**改动 3**：更新 L2091 注释 "80%" → "85%"

**改动 4**：L2369 compaction 重置注释更新——compaction 后重置仍然是正确的（compaction 降低上下文，自然 < 85%，新逻辑也会重置，但显式重置更清晰）

## 4. 行为分析

| 场景 | 当前行为 | 修改后行为 |
|---|---|---|
| 同模型，上下文增长到 80%+ | 提示注入，标志 true | 提示注入（85%），标志 true |
| 同模型，上下文持续 80%+ | 不重复注入（标志 true） | 不重复注入（标志 true） |
| 同模型，compaction 后 | 标志重置 false | 标志重置 false（compaction + 新逻辑双重保障） |
| 小模型 80%+ → 切大模型 | 标志仍 true，后续不再提示 | 标志重置 false（10% < 85%），后续大模型 85% 时重新提示 |
| 大模型 80%+ → 切小模型 | 标志仍 true，小模型不提示 | 若上下文 > 小模型 100% → compaction 先触发（L2353），不到达 near-overflow 块；若 85%-100% → 标志仍 true，不重复注入（正确，提示已给过） |

## 5. 不修改的部分

- 提示文案内容不变
- `nearOverflowNotified` 仍在 `while(true)` 循环外声明（跨 step 持久）
- 提示仍是 ephemeral（不持久化到 DB，不泄漏给 compaction）
- compaction 后的显式重置（L2369）保留——与新逻辑不冲突

## 6. 预估改动

| 文件 | 增/删 |
|---|---|
| `src/session/prompt.ts` | +10 / -6 |

无新增文件、无新增依赖、无测试变更（feature 无现有测试）。
