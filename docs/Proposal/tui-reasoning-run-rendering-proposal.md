# TUI 多 Reasoning Part 聚合折叠完整设计方案

Date: 2026-07-11

Status: implemented

Scope: `packages/opencode` 的主 TUI Session Message 区域。本文只设计渲染阶段行为，不修改 Message、Part、事件、SDK、数据库或 Provider 协议。

## 当前实施状态

当前生产实现使用稳定 `ReasoningRun`、单正文树、共享五行视觉预算和 Markdown `---` source 分隔。
历史 `thinking_visibility` 只控制整个 Thinking 是否可见；run-local `expanded=false` 只控制真实 overflow 正文的 disclosure。
短 run 自然全文且无 toggle；post-conceal 文本经 OpenTUI native word-wrap 测量守住五行上限；`thinking_mode` 只留给独立 v2 debug route。第 1-20 节保留原始调研和方案演进，当前规范以本节及第 21-22 节为准。

## 1. 结论摘要

问题确认存在，而且根因不是当前 5 行阈值设置得不合适，而是阈值、展开状态和渲染容器都绑定在单个 `ReasoningPart` 上。

一个 assistant role Message 可以合法地包含多个 reasoning Part。OpenAI Responses 会把同一个 reasoning item 的多个 summary part 分别发成多个 reasoning 生命周期；Anthropic 也会按 content block 分别发出 reasoning 生命周期。当前 Session processor 会为每个生命周期创建独立 Part，TUI 随后逐 Part 渲染。因此，十个各有两行的 Part 都不会触发单 Part 的 `> 5` 判断，但它们会共同占用数十行终端空间。

推荐方案不是合并数据，也不是把多个 Markdown 字符串拼成一个字符串，而是在 `AssistantMessage` 收到原始 `Part[]` 后、进入具体 Part renderer 前，增加一个纯渲染投影：

1. 把同一个 Message 内、原始 Part 顺序中真正连续的 reasoning Part 识别为一个 `ReasoningRun`。
2. `ReasoningRun` 只有一个标题、一个折叠预算和一个展开状态。
3. 每个成员仍使用自己的 Part ID、文本、时间、metadata、流式更新和 Markdown renderer。
4. 折叠预算作用于整个 run，而不是给每个成员重新分配 5 行。
5. 用 Markdown 外的紧凑 `[seg N/M]` 标记原始 Part 边界，从而区分“多个 Provider 源 segment”和“一个 Part 内的多个标题、段落或列表”，同时避免重复的 `Segment N/M` 标题压过 Thinking 主体。
6. 任意非 reasoning Part 都是硬边界，即使它为空、被隐藏或当前没有 renderer。分组必须发生在可见性过滤之前。

这个 seam 位于 TUI 内部，可以在不触碰持久化和同步协议的情况下完整解决问题。

调研还发现一个相关但独立的现状缺陷：主 Session renderer 把 `showThinking` 固定为 `true`，`ReasoningPart` 又没有读取 `thinkingMode`，所以 `/thinking` 虽然会更新持久化的 `thinking_mode`，正常 Session 视图并不会随之展开或收缩。实验性 v2 debug renderer 已经读取该模式。实现 `ReasoningRun` 时应同时收敛这两个状态源，但不能顺手改变 transcript/export 是否包含 reasoning 的语义。

## 2. 术语

| 术语 | 本文定义 | 是否持久化 |
| --- | --- | --- |
| Message | MessageV2 的一条 Message，包含有序 Part | 是 |
| Reasoning Part | `type: "reasoning"` 的原始 Part；拥有独立 ID、text、metadata 和 time | 是 |
| Source segment | 一个可显示的原始 Reasoning Part。它是 UI 用语，不代表新的领域对象 | 否 |
| Reasoning Run | 同一 Message 内，原始 Part 顺序中一个最大连续 reasoning 序列 | 否 |
| Markdown section | 一个 Reasoning Part 文本内部的标题、段落、列表或代码块 | 只是文本内容 |
| Preview row budget | 一个 Reasoning Run 在折叠态允许使用的正文终端行数，建议继续使用 5 | 否 |

本文刻意使用 `ReasoningRun` 而不是 “merged reasoning”。前者表达的是显示聚合；后者容易被理解为 Part 数据被改写或 Provider 语义被合并。

## 3. 当前显示流程

### 3.1 完整数据流

```text
Provider / AI SDK stream
  -> reasoning-start / reasoning-delta / reasoning-end
  -> SessionProcessor
  -> one persisted ReasoningPart per stream reasoning id
  -> message.part.updated / message.part.delta
  -> SyncProvider store.part[messageID]
  -> Session
  -> AssistantMessage(parts)
  -> For(raw parts)
  -> PART_MAPPING.reasoning
  -> ReasoningPart
  -> one header + one preview + one local expanded signal per Part
```

关键源码定位如下。

| 阶段 | 当前行为 | 源码 |
| --- | --- | --- |
| reasoning 开始 | 按 stream reasoning ID 创建独立 `ReasoningPart` 和新的 ascending Part ID | `packages/opencode/src/session/processor.ts:322-345` |
| reasoning 增量 | 只向对应 Part ID 的 `text` 追加 delta | `packages/opencode/src/session/processor.ts:347-359` |
| reasoning 结束 | 写入该 Part 的 `time.end`，发布最终快照 | `packages/opencode/src/session/processor.ts:361-378` |
| 未正常结束清理 | 为 reasoning map 中每个 Part 分别补终止时间 | `packages/opencode/src/session/processor.ts:896-903` |
| TUI 增量归并 | 只合并同一 session/message/part/field 的相邻 delta，不跨 Part | `packages/opencode/src/cli/cmd/tui/context/sync.tsx:163-197` |
| TUI delta 应用 | 按 `partID` 二分定位并更新原 Part | `packages/opencode/src/cli/cmd/tui/context/sync.tsx:211-245` |
| TUI Part 更新 | 按 Part ID 插入或 reconcile，继续保持每 Part 独立 | `packages/opencode/src/cli/cmd/tui/context/sync.tsx:726-766` |
| Session 读取 | `AssistantMessage` 直接收到 `sync.data.part[message.id]` | `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1372-1378` |
| Message 渲染 | `AssistantMessage` 直接遍历原始 `props.parts` | `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1650-1676` |
| Part 分发 | `reasoning` 映射到 `ReasoningPart` | `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1729-1733` |
| reasoning 渲染 | 每 Part 独立计算内容、行数、overflow 和 expanded | `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1735-1815` |

### 3.2 Part 的持久化和顺序

`ReasoningPart` 是正式的 Message Part，而不是只用于显示的临时字段：

```ts
{
  id,
  sessionID,
  messageID,
  type: "reasoning",
  text,
  metadata?,
  time: { start, end? },
}
```

定义位于 `packages/opencode/src/session/message-v2.ts:157-167`。

数据库中每个 Part 是 `part` 表的一行，主键为 `id`，并通过 `message_id` 关联 Message；索引包含 `(message_id, id)`，见 `packages/opencode/src/session/session.sql.ts:75-90`。读取时显式按 Part ID 排序，见：

- `packages/opencode/src/session/message-v2.ts:745-768`
- `packages/opencode/src/session/message-v2.ts:1176-1188`

Part ID 使用 ascending 时间部分和同毫秒计数器，见 `packages/opencode/src/id/id.ts:18-23`、`51-69`。因此 TUI 获得的数组顺序就是当前系统定义的 Part 创建顺序。

这意味着显示层可以依赖数组相邻性，但不能删除、替换或合成 Part ID。ID 仍然承担以下职责：

- delta 路由；
- 最终快照 reconcile；
- 稳定顺序；
- SDK/API 可观察身份；
- Markdown cache/remount key；
- 后续删除和隐藏事件定位。

### 3.3 当前 Message 和 reasoning 样式

`AssistantMessage` 外层有一条连续左边框，Message 之间的空行位于边框外；同一 Message 内的 Part 间距位于边框内。相关实现位于 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1585-1591`、`1638-1649`。

当前 `ReasoningPart` 样式和交互如下：

| 项目 | 当前行为 |
| --- | --- |
| 根容器 | `paddingLeft={2}`，左边框，`flexShrink={0}` |
| Part 间距 | 不是首个可见 Part 时 `marginTop={1}` |
| 标题 | italic `theme.markdownEmph`，显示 `Thinking (N chars):` |
| 正文 | Markdown `code` renderer，`theme.textMuted`，使用 `subtleSyntax()` |
| 流式 | 每 Part 使用 50ms throttled display content；父 Message 未完成时 `streaming={true}` |
| 完成态 | key 为 `width + preview text`，宽度或内容变化时重新挂载 completed renderer |
| 点击 | mouse up 切换本 Part 的 `expanded`；存在文本选择时不切换 |
| 提示 | overflow 时显示 `▼ expand` 或 `▲ collapse` |

源码位于 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1735-1815`。

### 3.4 当前折叠算法

当前算法等价于：

```ts
const lines = renderedContent.split("\n")
const overflow = lines.length > 5
const preview = overflow && !expanded
  ? [...lines.slice(0, 5), "…"].join("\n")
  : renderedContent
```

它有三个重要性质：

1. 预算是每 Part 5 个源码逻辑行，不是每 Message 或每 reasoning run 5 行。
2. `split("\n")` 不计算终端自动换行，所以一个很长的逻辑行可以占用很多视觉行而仍被判定为一行。
3. 每个 Part 都额外产生标题、边框内间距和可能的 toggle 行，这些 chrome 不进入预算。

`BlockTool` 已经明确记录了相同的自动换行问题，并用字符预算作为逻辑行数之外的防护，见 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2406-2419`。Reasoning renderer 目前没有对应防护。

## 4. 问题复现和根因

设一个 Message 含有 12 个相邻 Reasoning Part，每个 Part 只有 2 个逻辑行：

```text
R1: 2 lines
R2: 2 lines
...
R12: 2 lines
```

当前算法对每个 Part 都得到 `2 <= 5`，所以 12 个 Part 全部展开。粗略占用为：

| 来源 | 行数 |
| --- | ---: |
| 12 个标题 | 12 |
| 12 个正文，每个 2 行 | 24 |
| 11 个 Part 内间距 | 11 |
| 合计 | 47 |

这还没有计算终端换行、Markdown 布局和 Message footer。单 Part 阈值没有违反自身规则，但完全没有实现“限制整段 thinking 占屏”的产品目标。

因此根因是显示单元选错了：

- 数据单元是 Reasoning Part；
- 当前折叠单元也是 Reasoning Part；
- 用户实际感知并希望控制的是一段连续 reasoning 输出，也就是 Reasoning Run。

把阈值从 5 改成 3、2 或 1 只能减轻症状。只要 Part 数量足够多，每 Part 独立预算就仍然可以线性占满屏幕。

## 5. 为什么一个 Message 会有多个 Reasoning Part

### 5.1 OpenAI Responses summary part

当前安装的 `@ai-sdk/openai` 会为 reasoning item 的第一个 summary index 发出 ID `${item.id}:0`，见：

- `node_modules/@ai-sdk/openai/src/responses/openai-responses-language-model.ts:1341-1360`

后续 `response.reasoning_summary_part.added` 会为每个 `summary_index` 发出新的 reasoning start，并把 delta 路由到 `${item_id}:${summary_index}`，见：

- `node_modules/@ai-sdk/openai/src/responses/openai-responses-language-model.ts:1918-1971`

仓库历史中的 `eb84f461b` 还专门修复过 “split OpenAI reasoning summary blocks”。因此多个 summary block 是 Provider 输出的正常结构，不应在 processor 或数据库层重新揉成一个 Part。

### 5.2 Anthropic content block

`@ai-sdk/anthropic` 对每个 `thinking` 或 `redacted_thinking` content block 分别发送 reasoning start，并使用 content block index 作为 ID，见：

- `node_modules/@ai-sdk/anthropic/src/anthropic-messages-language-model.ts:1364-1405`
- `node_modules/@ai-sdk/anthropic/src/anthropic-messages-language-model.ts:1802-1821`

因此多个 Reasoning Part 不是 ChatGPT 特例，也不应通过 Provider 名称做条件判断。

### 5.3 retry 和 step

processor 在每次 `process()` 尝试开始时重置内存中的 `reasoningMap`，见 `packages/opencode/src/session/processor.ts:986-1004`。已经写入的 Part 不会被这个内存重置删除，因此失败尝试和重试可能在同一 Message 下留下多个 reasoning Part。

正常 stream 的 `start-step` 会创建独立 `step-start` Part，见 `packages/opencode/src/session/processor.ts:666-697`。它提供了一个重要结构边界：即使 `step-start` 当前不渲染，也不能先过滤它再把两侧 reasoning 误判为直接相邻。

### 5.4 结论

多个 Reasoning Part 可能表达：

- 一个 Provider reasoning item 的多个 summary segment；
- 多个 Provider content block；
- retry 或 step 形成的多个运行片段；
- 未来 Provider 的其他分块策略。

TUI 不需要理解这些 Provider 私有原因。它只需要尊重原始顺序和硬边界，并把真正相邻的 reasoning 做显示聚合。

## 6. “多个 Part”和“一个 Part 内多个 section”的歧义

这是本方案必须解决的核心语义问题。

一个 Reasoning Part 的文本本身可以是：

```md
**Inspecting the renderer**

First paragraph.

**Checking edge cases**

Second paragraph.
```

当前 `reasoningTitle()` 只识别开头的粗体标题约定，见 `packages/opencode/src/cli/cmd/tui/context/thinking.ts:8-16`。它不能也不应该用来推断文本里有几个 source segment。Markdown 标题、空行或分隔线都只是一个 Part 的内容。

相反，多个 Reasoning Part 的边界由 Part ID 和数组位置确定，与文本格式无关。

因此必须遵守以下显示规则：

| 场景 | 正确显示语义 |
| --- | --- |
| 一个 Part 内有 4 个 Markdown 标题 | 1 个 source segment，4 个内部 section |
| 4 个相邻 Part，每个只有一段文本 | 4 个 source segment，1 个 Reasoning Run |
| 两个 Part，中间有 text/tool/step-start | 2 个 Reasoning Run |
| 一个 Part 以未闭合代码围栏结束，下一 Part 是普通文本 | 两个独立 Markdown renderer，不能让围栏跨 Part 生效 |

仅仅执行 `parts.map(x => x.text).join("\n\n")` 会产生以下问题：

- 用户无法区分 Part 边界和普通空行；
- 一个 Part 的未闭合代码围栏、列表或引用可以吞掉下一 Part；
- 原始 Part ID 不再对应一个可定位 renderable；
- completed Markdown key 和流式 throttle 被迫变成组级状态；
- metadata、time 和 Provider segment 的调试身份被掩盖；
- copy/selection 的边界变化；
- 未来的 per-Part 操作没有挂载点。

所以“共用外壳”是正确的聚合方式，“拼接文本”不是。

## 7. 分组边界

### 7.1 必须基于原始序列

分组输入必须是 `AssistantMessage.props.parts` 的原始顺序，不能是 `visiblePartIDs` 或经过 `PART_MAPPING` 过滤后的数组。

推荐规则：

```text
R R R                         -> [R R R]
R Text R                      -> [R] Text [R]
R Text(empty) R               -> [R] Text(empty) [R]
R StepStart R                 -> [R] StepStart [R]
R Tool(hidden by preference) R -> [R] Tool [R]
R Snapshot R                  -> [R] Snapshot [R]
```

所有非 reasoning Part 都是硬边界，包括：

- text，即使 trim 后为空；
- tool，即使当前偏好隐藏 completed tool；
- step-start 和 step-finish；
- snapshot、patch；
- retry、compaction、agent、file、subtask；
- 当前 TUI 不认识的新 Part 类型。

这样做偏保守，但语义安全。未来如果产品明确决定某种结构 Part 对显示分组透明，应针对该类型单独提出决策，而不是由“当前不可见”自动推导。

### 7.2 不能跨 Message

即使两个连续 assistant role Message 在屏幕上都只显示 reasoning，也不能跨 Message 形成一个 run。Message 是持久化和生命周期边界，Message footer、模型、Agent、错误和完成时间都可能不同。

调用分组函数时每次只传一个 `AssistantMessage.props.parts`，可以从接口形状上保证这一点。

### 7.3 空或 redacted reasoning

原始 blank/redacted Reasoning Part 仍参与 run 拓扑，以免流式开始时组 key 改变。显示层只对规范化后非空的成员创建正文节点和计入可见 segment 数。

这意味着：

- `reasoning(empty), reasoning(text)` 在结构上仍是一个 run；
- 第一段收到 delta 后不需要重新定义 run；
- 整个 run 都为空时不产生可见 UI；
- 非 reasoning 的空 Part 仍然是硬边界。

## 8. 设计约束和不变量

实现必须满足以下不变量。

| 编号 | 不变量 |
| --- | --- |
| I1 | 每个输入 Part 在投影结果中恰好出现一次，直接出现或作为一个 run 的成员出现 |
| I2 | 展平投影结果后，Part 对象身份和顺序与输入完全一致 |
| I3 | 不创建合成 Part ID，不修改原 Part 的 ID、text、metadata、time 或 hidden |
| I4 | 分组只在同一 Message 内发生 |
| I5 | 每个 run 是原始序列中的最大连续 reasoning 序列 |
| I6 | 任意非 reasoning Part 都终止当前 run，不受可见性影响 |
| I7 | grouping 是纯、同步、`O(n)` 的 in-process 计算，没有 I/O 和 Solid side effect |
| I8 | delta 继续按原 Part ID 更新，grouping 不进入 SyncProvider |
| I9 | 展开态每个 source segment 使用独立 Markdown renderer |
| I10 | 折叠态的行数预算属于整个 run，不按成员数倍增 |
| I11 | run key 不依赖 text、字符数、完成状态或最后一个成员 |
| I12 | transcript/export 继续遍历原始 Part，不消费 ReasoningRun |

## 9. 方案比较

| 方案 | 优点 | 主要问题 | 结论 |
| --- | --- | --- | --- |
| 在 processor 合并相邻 reasoning | TUI 无需新抽象 | 改写数据库和事件语义；破坏 Provider segment 身份、delta 路由和历史回放 | 拒绝 |
| 在 SyncProvider 生成合成 Part | 数据库不变 | reducer 必须维护成员 delta、最终快照、删除、乱序和 synthetic ID；同步层承担显示策略 | 拒绝 |
| TUI 拼接多个 `text` 后复用 `ReasoningPart` | 改动看起来较小 | Markdown 边界、Part 身份、流式 key 和歧义问题仍存在 | 拒绝 |
| TUI `ReasoningRun` 外壳，成员独立渲染 | 只改显示；能共享预算；保留所有 Part 语义 | 需要组级状态、preview 分配和行为测试 | 推荐 |
| 建立通用可配置 display-node policy registry | 可扩展到 tool/context 等分组 | 当前只有一个新策略，公开 policy seam 会过度设计 | 暂缓 |

仓库的 Web UI 已经有扫描最大连续 run 的先例：`packages/ui/src/components/message-part.tsx:547-589` 会把连续 context tools 生成 group descriptor，并通过 Part ref 在渲染时重新解析成员，见 `packages/ui/src/components/message-part.tsx:638-716`。这个先例证明 render-only group 是仓库已有模式，但其“先过滤可见 Part 再分组”的具体边界策略不能直接复制到 reasoning。

## 10. 渲染 seam、投影和稳定身份

### 10.1 Seam 位置

正确 seam 是：

```text
AssistantMessage(messageID, raw Part[])
  -> projectMessageParts(messageID, raw Part[])
  -> MessageRenderItem[]
  -> existing Part renderer or ReasoningRun renderer
```

它位于 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1598-1676`。

这个 seam 的依赖全部是 in-process 数据。为控制改动范围，投影 helper 直接作为 `index.tsx` 中靠近 `AssistantMessage` 的私有函数，不新增 module 或公共接口。调用者只需要知道“给出 Message ID 和原始 Part 顺序，得到保序显示项”；最大 run、硬边界、稳定 key 和身份保留都隐藏在实现内。

### 10.2 建议类型

```ts
type MessageRenderItem =
  | {
      kind: "part"
      key: string
      part: Part
    }
  | {
      kind: "reasoning-run"
      key: string
      parts: readonly [ReasoningPart, ...ReasoningPart[]]
    }

function projectMessageParts(messageID: string, parts: readonly Part[]): readonly MessageRenderItem[]
```

每个最大 reasoning run 都必须产生 `reasoning-run`，包括只有一个成员的 run。这样单 Part 和多 Part 共用一套折叠、模式、样式和测试逻辑，不保留第二套 `ReasoningPart` renderer。单成员 run 的最终视觉保持当前样式。

### 10.3 前置边界锚定的 key

```ts
const key = precedingBoundary
  ? `${messageID}:reasoning:after:${precedingBoundary.id}`
  : `${messageID}:reasoning:start`
```

run key 依赖 Message 和 run 前面的原始硬边界，而不依赖任何 reasoning 成员：

- 最后一个成员继续流式增长时不变；
- 新的相邻 Reasoning Part 追加或乱序前插时不变；
- 字符数、换行数和完成状态改变时不变；
- 插入硬边界时，左侧继续使用旧 key，右侧使用该边界锚定的新 key；
- 删除硬边界时，两侧合并到左侧旧 key，左侧展开状态得以保留。

不要使用第一个或最后一个 reasoning Part ID、成员数或文本 hash。第一个 Part ID 会在更早 Part 乱序前插时改变，其余动态值也会让流式更新重置展开状态。

### 10.4 分组伪代码

```ts
function projectMessageParts(messageID: string, parts: readonly Part[]) {
  const result: MessageRenderItem[] = []
  let run: ReasoningPart[] = []
  let precedingBoundary: Part | undefined

  const flush = () => {
    if (run.length === 0) return
    result.push({
      kind: "reasoning-run",
      key: precedingBoundary
        ? `${messageID}:reasoning:after:${precedingBoundary.id}`
        : `${messageID}:reasoning:start`,
      parts: run,
    })
    run = []
  }

  for (const part of parts) {
    if (part.type === "reasoning") {
      run.push(part)
      continue
    }

    flush()
    result.push({ kind: "part", key: `part:${part.id}`, part })
    precedingBoundary = part
  }

  flush()
  return result
}
```

实际代码应遵循仓库风格压缩临时变量，但行为不变量应保持不变。

`AssistantMessage` 不能把每次投影产生的新 descriptor object 直接交给 Solid `<For>`。它应从投影结果派生 primitive string key 数组和当前 key 到 descriptor 的 reactive `Map`，使用 `<For each={renderItemKeys()}>`，再在 callback 中按 key 解析当前 descriptor。run 内成员同样按原始 Part ID 字符串迭代，再解析当前 Part。这样文本 delta 不会重挂 topology，prepend/append 也不会重置 `ReasoningRun` 的局部状态。

## 11. ReasoningRun 渲染设计

### 11.1 渲染层级

```text
AssistantMessage
  ReasoningRun
    GroupHeader
    CollapsedPreview or ExpandedMembers
      CompactSegmentBoundary
      ReasoningBody(part A)
      CompactSegmentBoundary
      ReasoningBody(part B)
    GroupToggle
```

`ReasoningBody` 应保留当前每 Part 的以下能力：

- 独立的 normalized content；
- 独立的 50ms throttled display signal；
- 流式 `CodeRenderable`；
- 完成态按宽度和本 Part 内容 keyed remount；
- `subtleSyntax()`、`theme.textMuted` 和 conceal；
- full renderer 使用 `id={"text-" + part.id}`；preview renderer 使用 `id={"reasoning-preview-" + part.id}`，避免两个常驻树产生重复 ID。

组级 module 只负责：

- 成员列表；
- 标题和总字符数；
- source segment 分隔；
- 聚合 preview；
- overflow；
- expanded state；
- 一次性的 top margin 和左边框。

### 11.2 不拼接 Markdown

展开态必须保留：

```tsx
<For each={run.parts}>
  {(part, index) => (
    <>
      <CompactSegmentBoundary index={index()} count={run.parts.length} />
      <ReasoningBody part={part} />
    </>
  )}
</For>
```

不能改成：

```tsx
<ReasoningBody text={run.parts.map((part) => part.text).join("\n\n")} />
```

`CompactSegmentBoundary` 是普通 TUI text/box，不写进 Markdown 源文本。这样即使某个成员以未闭合代码围栏结束，也不会改变下一个成员的解析。

### 11.3 紧凑 source boundary 标记

多成员 run 的标题包含明确的 source segment 数：

```text
Thinking (8 segments · 1,284 chars):
```

第一个规范化后非空的 source Part 不显示标记；之后的真实 Part 边界使用：

```text
[seg 2/8]
[seg 3/8]
```

`[seg N/M]` 是 source Part 序号，不是视觉行号或 Markdown section 序号。它使用 lowercase、`theme.textMuted`、普通非 italic 文本，并且不增加边框或空行。标记独立于 Markdown renderer，因此一个 Part 的未闭合 fence 不会影响下一个 Part。

不要在标记中追加 `reasoningTitle(part.text)`、Part ID、Provider 名或 metadata。这些信息会增加视觉噪声或暴露内部标识；原始标题仍由该 Part 自己的 Markdown body 正常显示。

单成员 run 可以继续显示：

```text
Thinking (1,284 chars):
```

这样用户可以通过 header 和紧凑序号判断：

- 没有 segment 计数：只有一个真实 source Part，内部仍可有多个 Markdown section；
- `N segments`：存在 N 个真实 source Part；
- `[seg 4/8]`：接下来的正文来自第 4 个 source Part，而不是 Thinking 的第 4 个内部标题。

计数和序号基于规范化后非空的 source Part，而不是 conceal 后的视觉 glyph。如果第一个 source Part 被 Markdown conceal 成视觉空内容，`[seg 2/2]` 可以成为第一个可见字符；它仍然准确表示“当前正文来自 source Part 2”。序号允许跳跃，但一个自身没有任何 post-conceal 可见 glyph 的成员不能显示孤立标记。

### 11.4 折叠态必须有硬上限

只把多个正文共享 5 行预算仍不够。如果成员标记位于 clipping 区域之外，标记本身仍会线性占满屏幕。

建议布局预算：

| 区域 | 折叠态预算 |
| --- | ---: |
| Group header | 1 行 |
| Preview body，包括 segment boundary | 最多 5 个视觉行 |
| Toggle/hidden summary | 1 行 |
| 总计 | 通常最多 7 行 |

所有成员标记都必须位于 preview body 的 5 行 clipping 容器内，或者被 footer 汇总。不能为每个隐藏成员额外保留一行。

折叠示意：

```text
Thinking (10 segments · 932 chars):
first short thought
[seg 2/10]
second short thought
… · +8 segments · ▼ expand
```

展开示意：

```text
Thinking (10 segments · 932 chars):
full markdown for part 1

[seg 2/10]
full markdown for part 2
...
▲ collapse
```

最终 snapshot 可以在不改变语义的前提下微调 footer 标点，但“Thinking 只有一个主标题、标记使用 `[seg N/M]`、成员边界在 Markdown 外、折叠总高度有硬上限”是行为约束。

## 12. 聚合 preview、精确宽度和异步可见性

### 12.1 权威正文宽度

preview 的视觉行预算必须使用实际 `CodeRenderable` 宽度，不能使用终端总宽度或粗略减常量。

当前 `ctx.width` 由 `sessionMessageContentWidth()` 计算。`SESSION_MESSAGE_LEFT_CHROME=4` 已扣除 Message 正文左侧 chrome，现有 `session-layout.test.ts` 通过真实 OpenTUI layout 证明它等于普通 assistant text 的实际宽度。ReasoningRun 路径具有完全相同的 4 cell 左侧 chrome：AssistantMessage 左边框 1、ReasoningRun 左边框 1、ReasoningRun `paddingLeft` 2。

因此 allocator 的唯一宽度输入是 `Math.max(ctx.width, 1)`。现有 `session-layout.test.ts` 增加 reasoning shell 直接测量，覆盖窄/宽终端、sidebar 和 scrollbar 组合；如果实测不等于 `sessionMessageContentWidth()`，应停止实现并修正 layout 口径，而不是叠加 magic number。

### 12.2 静态 preview allocator

折叠 preview 的正文预算固定为 5 个视觉行，包括 `[seg N/M]` 标记。header 和 aggregate toggle 位于预算之外，因此通常总高度最多 7 行。

preview `CodeRenderable` 显式使用 `wrapMode="char"`。full renderer 保持当前默认 word wrap。每个源码逻辑行的保守预算为：

同步预算公式为：

```text
rows(line) = max(1, ceil(conservativeCellWidth(line) / max(ctx.width, 1)))
```

`conservativeCellWidth` 使用以下确定规则逐 Unicode code point 扫描，不依赖平台默认 tab stop：

- `\n` 结束当前视觉行并从下一行第 0 列继续；
- `\t`、C0 和 C1 控制字符各计为 `bodyWidth` 个 cell，即最坏占用一整行；
- 其他字符计为 `Math.max(0, Bun.stringWidth(char))`；
- 加入字符会超过当前行时，先切到下一视觉行再计入；
- 一个字符自身宽于 `bodyWidth` 且没有剩余完整行时，不把它收入该 preview grant。

这个规则可能低估 preview 可利用空间，但不会把特殊字符误判为免费空间。测试覆盖 spaced ASCII、CJK、tab、C0/C1 控制字符和 width=1。

allocator 按 source Part 顺序分配预算：

1. 第一个规范化后非空成员不需要 marker；之后的成员必须同时获得 1 行 marker 和至少 1 行正文预算，否则整个成员留给 footer 汇总。
2. 每个获得预算的成员都有独立 preview body wrapper，`maxHeight` 等于该成员的明确 body row grant，`overflow="hidden"`；所有 marker row 和 body grant 之和不得超过 5。
3. 一个源码行超过 body grant 时，可以把完整源码行交给该成员自己的独立 renderer，由成员 wrapper 只显示获准的前几行；不能把它和下一 Part 拼成 Markdown。
4. 不向 Markdown 注入 ellipsis；遗漏状态由 aggregate footer 表达。
5. run 级 preview wrapper 始终设置正数 `maxHeight={5}` 和 `overflow="hidden"`，作为成员 grant 之外的最终硬上限。
6. estimator 只负责保守分配，不建立 `virtualLineCount` 反馈状态，避免首帧后跳动和渲染反馈环。

折叠 footer 的 `+N segments` 只表示没有获得 preview allocation 的规范化 source Part 数。已经获得 body grant、但随后被 Markdown conceal 成视觉空内容的成员不计入 `N`，也不触发异步预算回收。footer 因而完全由同步 allocator 决定，不随 highlighting completion 变化，避免 preview 文案和高度振荡。

### 12.3 Post-conceal marker readiness

allocator 给 marker 预留一行，并不代表 marker 可以立刻出现。`drawUnstyledText={false}` 时，OpenTUI 在首次 async highlighting 完成前可能没有可见正文；Markdown conceal 还可能把非空源码变成视觉空内容。marker 必须跟随自己的正文可见性，而不是只跟随原始 text 非空。

每个 preview/full 成员树独立维护 readiness guard：

1. 新挂载、内容变化或 completed keyed replacement 都从 `markerReady=false` 开始。
2. 使用 `CodeRenderable.onChunks` 接收 tree-sitter highlight 和 conceal 已经转换后的 `TextChunk[]`；不从原始 Markdown 猜测可见性，也不读取构造阶段尚未启动的 `highlightingDone` placeholder。
3. preview 使用与 allocator 相同的 width、换行和特殊字符规则，只扫描该成员 body row grant 能实际显示的 chunk 文本前缀；该前缀存在占 cell 的非 whitespace glyph 才允许 marker 出现。full body 没有 clipping，可扫描完整 chunk 文本。
4. 每次 `renderedContent` 变化递增 generation 并隐藏 marker；`onChunks` 通过 microtask 更新 signal，并再次检查 component 仍 active、generation 未变化、callback context content 仍等于当前内容。
5. cleanup 使 component inactive 并递增 generation，防止旧 highlight callback 揭示已经替换或销毁的树。
6. `onChunks` 原样返回 chunks，不改变 Markdown 样式、conceal、选择或正文；preview 和 full 树各自维护 readiness，且不得把 `drawUnstyledText` 改为 `true`。

marker 序号始终是 source Part 序号。若前一个成员被完全 conceal，而当前成员在自己的 body grant 内有可见正文，当前 `[seg N/M]` 仍可显示；若当前成员自己的可显示前缀没有可见 glyph，则自己的 marker 必须隐藏。成员级 wrapper 使 marker row 和自己的 body grant 成为明确配对，run 级 clipping 不会在两者之间截断。

真实 renderer 测试必须逐 frame 检查：只要某帧出现 `[seg N/M]`，同一帧中该标记之后的 source Part 必须已有唯一可见 glyph。image-only、delimiter-only、首个成员完全 conceal、已分配首行 conceal 且后文被裁剪、completed keyed remount 都要覆盖。

### 12.4 大内容的挂载策略

`BlockTool` 已经记录 OpenTUI renderable 卸载后重挂同一个 JSX 对象可能变空的问题，并采用“首次展开后常驻，通过 `visible` 切换”的策略，见 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2423-2433`。

ReasoningRun 可沿用该模式：

1. 折叠首帧只挂载 bounded preview。
2. 首次展开时挂载 full body。
3. full body 一旦挂载就保留，后续折叠通过 `visible=false` 隐藏。
4. preview 和 full body 不复用同一个 JSX 实例。

这样可以避免对超长 reasoning 首屏执行完整 Markdown/tree-sitter 工作，同时保证反复展开和折叠稳定。

## 13. 展开状态和 `thinking_mode`

### 13.1 当前不一致

`useThinkingMode()` 定义 `"show" | "hide"`，默认 `hide`，注释明确称它为 collapsed thinking，见 `packages/opencode/src/cli/cmd/tui/context/thinking.ts:4-6`、`28-59`。

Session command 也使用 `Collapse thinking` / `Expand thinking`，见 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:835-850`。

但是主 Session renderer 当前执行：

```ts
const thinkingMode = thinking.mode
const showThinking = createMemo(() => true)
```

见 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:259-262`。随后 `AssistantMessage` 和 `ReasoningPart` 只读取 `showThinking()`，没有读取 `thinkingMode()`，见 `1606-1612`、`1757-1759`。

结果是：

- KV 和 command title 会变化；
- 正常 Session 中的 reasoning 不会跟随全局命令展开或收缩；
- 每个 Part 仍然只由自己的初始 `expanded=false` 和 5 行 overflow 决定；
- 实验性 v2 renderer 却会读取 `thinking.mode()`，见 `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx:451-510`。

### 13.2 推荐状态模型

推荐把组级有效状态定义为：

```text
global mode = show:
  所有 ReasoningRun 完整显示

global mode = hide:
  overflow run 默认折叠
  短 run 完整显示，不显示无意义 toggle
  用户可以局部展开一个 run
```

每个稳定 keyed `ReasoningRun` 自己保存局部 override 和 `bodyMounted` 状态，不持久化，也不需要 `AssistantMessage` 级 Map：

```ts
type RunOverride = "expanded" | "collapsed" | undefined
```

全局 `/thinking` 模式实际变化时，每个现存 run 把 local override 重置为 `undefined`，使 “Collapse thinking” 和 “Expand thinking” 对所有 run 产生确定结果。`show` 的有效状态为 full；`hide` 下 overflow run 默认 compact，短 run 直接 full，用户仍可局部切换。

### 13.3 必须和 transcript/export 解耦

当前 `showThinking()` 还被用于：

- Copy session transcript 的 `thinking` 选项，见 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1047-1067`；
- Export dialog 的默认 thinking 选项，见 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1077-1113`。

`formatTranscript()` 会逐原始 Part 输出 `_Thinking:_`，见 `packages/opencode/src/cli/cmd/tui/util/transcript.ts:60-62`、`84-94`。

如果简单地把 `showThinking` 改成 `thinkingMode() === "show"`，就会把一个屏幕折叠设置意外变成 transcript 内容过滤设置。这违反本方案的 render-only 范围。

建议拆分概念：

| 概念 | 用途 |
| --- | --- |
| `thinkingMode` | 只控制屏幕中的 ReasoningRun 展开/折叠 |
| `includeThinkingInTranscript` | 保持 copy/export 当前默认和显式 dialog 选择，不从折叠状态隐式推导 |

ReasoningRun 不进入 `formatTranscript()`。copy/export 继续遍历原始 Part。

## 14. Solid 生命周期、乱序事件和删除合并

### 14.1 grouping 不应依赖 text

grouping 只读取 Part 的 `type` 和 `id`。普通 `message.part.delta` 只修改成员 `text` 时，不应重建 render topology。

投影可以每次生成新 descriptor，但 `<For>` 必须遍历 primitive string key，并通过 reactive `Map` 解析当前 descriptor。run 内成员同样遍历 Part ID 字符串。不能让 descriptor wrapper object identity 决定 callback root 生命周期。

### 14.2 新 segment 前插和追加

当新 Reasoning Part 紧跟当前 run 追加，或者一个 lexically earlier Part 乱序前插时：

- run key 仍然由 Message 起点或前置硬边界锚定；
- 已有成员保持原 ID 和 renderer；
- 新成员按当前 raw Part ID 顺序进入成员列表；
- 已局部展开的 run 保持展开；
- 折叠态重新计算 aggregate overflow 和未获得 preview allocation 的 segment count。

必须用真实 `message.part.updated` 事件验证：先渲染 B 并展开，再插入更早的 A，run 仍展开；随后追加 C、接收 delta 和最终 snapshot，A/B/C 各出现一次。

### 14.3 Part 完成和 Message 完成

当前主 renderer 用父 Message 的 `time.completed` 决定所有 reasoning body 是 streaming 还是 completed，见 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1754-1755`。Reasoning Part 自身也有 `time.end`。

本次实现建议先保留现有父 Message 口径，避免把 grouping 修复和 streaming renderer 生命周期调整混在一起。每个成员仍保留自己的 completed key，不能把整个 run 包在一个随总文本变化的 keyed subtree 中。

### 14.4 硬边界插入和删除

插入一个非 reasoning Part 是真实 topology 变化：左侧 run 保留旧 key，右侧 run 使用该边界锚定的新 key，并采用默认展开状态。

删除两段 reasoning 之间的硬边界时，两侧合并到左侧 key：

- 左侧 run 的 local override 和已挂载 full body 保留；
- 右侧 run 被正常 dispose，其 override 不得在以后复活；
- 每个 reasoning Part 按原 ID 只出现一次；
- 后续删除任一 reasoning Part 时，header denominator、字符数、preview、full body 和 marker 只更新一次。

这条路径必须使用真实 `message.part.removed` 事件测试，不能只用静态 props snapshot 模拟。

## 15. 可见性、间距和样式规则

### 15.1 可见项

当前 `visiblePartIDs` 按每个 Part 计算 Message 内间距，见 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1606-1619`。

引入 run 后应改为 `visibleRenderItemKeys`：

- text：沿用 trim 后非空；
- reasoning-run：至少有一个规范化后非空成员；
- tool：沿用 showDetails 规则；
- 其他结构 Part：不可见，但仍然已经在 grouping 阶段充当硬边界。

ReasoningRun 只占一个可见 item 位置，因此只有一个 `topMargin`。成员之间的分隔由 run 内部控制，不能继续套用 Message Part 的一行 margin，否则 segment 数仍会线性扩大折叠 chrome。

### 15.2 Tool 间距

当前 tool top margin 会检查前一个可见 Part 是否也是 tool，见 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1657-1661`。

ReasoningRun 对这个规则应表现为一个非 tool item：

- tool 紧跟 reasoning-run 时有正常内部间距；
- reasoning-run 紧跟 tool 时有正常内部间距；
- 连续 tool 的既有 sibling measurement 不变。

### 15.3 建议样式

| 元素 | 建议 |
| --- | --- |
| Message 外层左边框 | 完全不变 |
| ReasoningRun 左边框 | 复用当前 `SplitBorder` 和 `theme.backgroundElement` |
| Group header | 复用 `theme.markdownEmph` 和 italic |
| 正文 | 复用 `subtleSyntax()`、`theme.textMuted`、conceal |
| Segment boundary | 紧凑 `[seg N/M]`，`theme.textMuted`，普通非 italic text，不进入 Markdown，不再嵌套左边框 |
| Toggle | 复用 `▼ expand` / `▲ collapse`，只显示一次 |
| 字符数 | header 显示所有可见成员规范化文本字符数之和 |
| source segment 数 | 多成员时显示，单成员时可省略以保持现有视觉 |

字符数仍然只是信息展示，不参与 identity。当前 `.length` 是 UTF-16 code unit 数而不是 grapheme 或终端 cell 数；视觉行估算应使用 `Bun.stringWidth`，不要用 header 字符数代替。

## 16. 测试方案

### 16.1 TUI 行为测试

现有真实 renderer harness 位于 `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx`。当前文件覆盖了 Message 边框、Part 间距、工具折叠和真实点击，但没有实际 `type: "reasoning"` 的行为测试。`packages/opencode/test/cli/cmd/tui/session-integration.test.ts:175-195` 只有源码字符串断言，不能验证视觉高度、grouping、点击或流式稳定性。

不新增测试文件，直接在现有真实 renderer harness 中用组合场景覆盖：

1. 十个相邻短 reasoning：一个 Thinking header、一个 nested border、一个 toggle；header 使用 `segments · chars`；首 source 无 marker，后续使用 `[seg N/M]`；折叠正文不超过 5 行，总高度通常不超过 7 行。
2. 单成员、短 run、一个 Part 内多个 Markdown section：保持单 source 语义和无意义 toggle 不出现。
3. text、empty text、tool、偏好隐藏 tool、step-start、snapshot 等 raw 非 reasoning Part 均切断 run，并保持现有 item/tool 间距和 Message footer。
4. 每个 source Part 使用独立 Markdown renderer；未闭合 fence 不能污染下一成员；反复 expand-collapse-expand 不产生空白树或重复 ID。
5. group mouseup 保留 selection guard；marker 可被屏幕 selection 选中但不进入 explicit transcript/export。
6. `/thinking` show/hide 重置 local override；reasoning-only abort 显示 interrupted footer；非 abort error 继续使用独立 error panel。
7. 流式顺序：B 展开后乱序前插 A，继续追加 C/delta/final snapshot，状态不重置且内容不重复；插入硬边界后右侧使用默认状态。
8. 删除顺序：left reasoning、boundary、right reasoning；展开 left 后发送真实 `part.removed` 删除 boundary，合并沿用 left 状态；再删除一个 reasoning member，所有 aggregate 数值和内容只更新一次。
9. frame-by-frame marker readiness：普通 append、completed remount、image-only、delimiter-only、leading concealed + visible second、已分配首行 conceal 且可见后文被 clip。任意一帧出现 marker 时，其后成员在同帧必须已有可见 glyph。
10. 窄终端 spaced ASCII、CJK、tab、控制字符均不突破共享 5 行正文预算，且最后一行不能只有孤立 marker。
11. 最新 run 在 sticky bottom 展开后 tail 仍可到达；不新增历史行 anchoring 或改变 viewport culling。

### 16.2 宽度和现有底层保证

现有 `session-layout.test.ts` 增加 reasoning shell 直接宽度断言，证明 `ctx.width` 等于真实 preview `CodeRenderable.width`。覆盖 terminal width、sidebar 和 scrollbar 组合。

以下现有测试不应因 TUI grouping 改动而修改语义：

- processor 捕获 reasoning 和最终 text：`packages/opencode/test/session/processor-effect.test.ts:441-484`；
- retry 不把两次 reasoning 拼成 `onetwo`：`packages/opencode/test/session/processor-effect.test.ts:489-531`；
- stale snapshot 不覆盖 TUI 已累积 reasoning：`packages/opencode/test/cli/cmd/tui/sync.test.tsx:641-672`；
- signed Anthropic reasoning 之间的空 text 是结构边界：`packages/opencode/test/session/message-v2.test.ts:1668-1701`。

尤其是 retry 测试已经表达了一个重要不变量：底层 Reasoning Part 不能被数据合并。TUI group 必须让这个测试完全无感。

## 17. 最小实现范围

所有实现和解释只维护在本设计文档及以下既有文件中，不新增源码、测试或解释性文档：

| 文件 | 修改 |
| --- | --- |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | 增加私有投影 helper；把 `AssistantMessage` 改为稳定 render-item key；用 `ReasoningRun` 和成员 renderer 替换当前局部 `ReasoningPart`；消费 `thinkingMode` |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | 真实 TUI 行为、流式、宽度、点击和间距回归测试 |
| `packages/opencode/test/cli/cmd/tui/session-layout.test.ts` | 证明 reasoning shell 的实际正文宽度等于 `ctx.width` |
| `packages/opencode/test/cli/cmd/tui/session-integration.test.ts` | 删除或收窄已经被行为测试替代的脆弱源码字符串断言 |
| `docs/Proposal/tui-reasoning-run-rendering-proposal.md` | 唯一设计和实施说明，随最终实现保持一致 |

目标只修改 1 个源码文件、3 个测试文件和本 proposal。总代码与测试净改动必须小于 1000 行，预计为 550 至 800 行。若实现需要新增文件、超过这个行数，或者扩展到 6 个以上源码/测试文件，必须停止并重新审计，而不是继续堆叠抽象。

明确不应修改：

- `packages/opencode/src/session/processor.ts`；
- `packages/opencode/src/session/message-v2.ts`；
- `packages/opencode/src/session/session.sql.ts`；
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx`；
- HTTP route 和 SDK schema；
- `formatTranscript()`；
- 数据库 migration。

## 18. 实施顺序

1. 在现有 renderer test 中先加入单成员、十成员、raw boundary 和稳定 key 行为，确认旧实现失败。
2. 在 `index.tsx` 内实现私有 raw Part 投影和前置边界 key，不动数据层。
3. 把 `AssistantMessage` 改为 string-key render items，保持现有 text/tool/error/footer 行为。
4. 把当前 `ReasoningPart` 收敛为单个 `ReasoningRun` shell 和成员 renderer，先达到单成员视觉等价。
5. 加入 compact marker、共享 preview allocator、hard clipping 和 aggregate toggle。
6. 加入 full body lazy mount/常驻切换以及 post-conceal marker readiness。
7. 接通 `thinkingMode`，只控制屏幕 full/compact，不修改 `showThinking`、transcript 或 export。
8. 补齐真实 append/prepend/split/remove/merge、conceal frame、窄终端和 sticky-bottom 行为。
9. 删除被行为测试完整替代的 reasoning 源码字符串断言。
10. 运行完整验证；检查 git diff 的文件数、净代码行和本设计文档是否一致。

建议验证命令都从 `packages/opencode` 运行：

```bash
bun test test/cli/cmd/tui/session-layout.test.ts
bun test test/cli/cmd/tui/session-message-render.test.tsx
bun test test/cli/cmd/tui/session-integration.test.ts
bun test test/cli/cmd/tui/sync.test.tsx
bun test test/cli/cmd/tui/session-export.test.tsx
bun test test/cli/tui/transcript.test.ts
bun test test/session/processor-effect.test.ts
bun typecheck
```

## 19. 风险和缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| descriptor 每次更新都重建 | Solid 重挂，展开状态和流式 renderer 抖动 | `<For>` 只遍历 primitive string key，通过 reactive Map 读取当前 descriptor |
| 乱序前插新 segment 让 key 改变 | 用户展开状态丢失 | key 使用 Message 起点或前置 raw hard boundary，不使用 reasoning Part ID |
| 先过滤不可见 Part | 跨 step/tool/empty text 错误聚合 | grouping 必须先于可见性过滤 |
| 拼接 Markdown | 语义歧义和跨 Part 解析污染 | 每成员独立 renderer，boundary 在 Markdown 外 |
| segment label 自己占满屏幕 | 聚合后仍不能控制高度 | `[seg N/M]` 必须计入同一个 5 行 clipped preview budget |
| 逻辑行漏算自动换行 | 窄终端仍占屏 | `ctx.width` 实测、preview char wrap、保守 cell estimator 和 hard clipping |
| async highlight 尚未显示正文 | 出现孤立 marker | `onChunks` 只根据 post-conceal chunk 的已分配可见前缀揭示 marker |
| 旧 highlight callback 晚到 | 已替换或销毁的成员被错误更新 | content、generation、active 和 cleanup guard |
| collapsed 时完整渲染超长 Markdown | 首屏性能下降 | obvious-overflow 快速路径、bounded preview、full body 首次展开才挂载 |
| full body 反复卸载重挂 | OpenTUI 空白或状态丢失 | 首次挂载后常驻，使用 `visible` 切换 |
| 把 screen mode 复用于 transcript | copy/export 内容意外变化 | 独立 `includeThinkingInTranscript` 概念 |
| hard boundary 删除合并 | 成员重复或右侧状态复活 | 左侧 boundary key 胜出，并用真实 `part.removed` 测试 dispose 和成员去重 |
| 修改范围失控 | 小问题演变为跨层重构 | 不新增文件，1 个源码文件、3 个测试文件、总代码与测试净改动小于 1000 行 |

## 20. v2 和其他 UI 的范围

实验性 v2 Session debug renderer 位于 `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx`，只在 `experimentalEventSystem` 打开时注册，见 `packages/opencode/src/cli/cmd/tui/plugin/internal.ts:23-38`。它也逐个遍历 `message.content` 并逐个渲染 reasoning，见 `session-v2.tsx:311-357`、`451-510`。

v2 reasoning 结构只有 `type`、Provider reasoning `id` 和 `text`，见 `packages/core/src/session-message.ts:113-127`。它与当前生产 MessageV2 Part 不完全同构。

设计边界：

- 第一阶段只修改生产 Session renderer；
- 不为 v2 提前抽取 adapter、公共 helper 或 policy registry；
- v2 若需要 parity，应在独立任务中依据自己的数据模型实现和测试；
- Web/App/Share UI 不在本提案范围内。

## 21. 验收标准

实现完成时必须同时满足：

1. 同一 Message 中 10 个相邻短 reasoning Part 在默认折叠状态下不会线性占满屏幕。
2. 一个 Reasoning Run 的折叠正文最多使用固定 5 个 visual rows，成员数不会倍增预算，通常连同 header/footer 不超过 7 行。
3. 展开后所有原始 reasoning 文本完整、保序可见。
4. 多 source run 使用单一 Thinking 主标题和 Markdown `---` 水平分隔线；不显示重复的 `Segment N/M` 标题。
5. 一个 Part 内多个 Markdown section 不会被误标成多个 source segment。
6. 非 reasoning 原始 Part 永远切断 run，即使它不显示。
7. 每个成员仍保留原始 Part ID、metadata、time 和独立 Markdown renderer。
8. 流式 delta、最终 snapshot、乱序前插、相邻追加、hard boundary 插入/删除和 reasoning member 删除都不丢内容、不重复内容、不错误重置左侧组状态。
9. Message 外边框、Part 间距、Tool 显示和 selection 行为没有回归。
10. 数据库、Message schema、SDK、事件和 SyncProvider 不发生变化。
11. transcript 和 export 仍基于原始 Part，local expand/collapse 不会截断或过滤内容。
12. `/thinking` 的 Show/Hide 文案和整个 Thinking visibility 行为一致。
13. 短 run 无 toggle；长 run 在新 Session 中默认收缩；visibility hide/show 不重置同一 run 的局部 disclosure。
14. preview 的实际 `CodeRenderable.width` 经 layout test 证明等于 overflow measurement 使用的 `ctx.width`。
15. 不新增文件，生产代码只修改 `session/index.tsx`，总代码与测试净改动小于 1000 行。

## 22. 最终建议

采用 `ReasoningRun` 显示聚合，并把它作为生产 TUI `session/index.tsx` 内部的私有渲染抽象。它接收原始有序 Part，隐藏最大连续 run、硬边界、稳定 key、共享五行预算和流式状态保持；不新增文件或公开接口。

最关键的三个决策是：

1. 在 `AssistantMessage` 的渲染 seam 聚合，不在 processor、数据库或 SyncProvider 聚合。
2. 共用折叠外壳但不拼接成员 Markdown，非首 source 在自己的 renderer 中使用 Markdown `---`，同时让 Thinking 保持唯一视觉主体。
3. 对整个 run 应用一个 5 行硬视觉预算，以 post-conceal 文本的 OpenTUI native word-wrap 行数判断 overflow，并让 visibility 与 local disclosure 保持正交。

这三个决策一起解决占屏问题、语义歧义和流式鲁棒性；只做其中任意一个都不完整。
