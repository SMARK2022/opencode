# OpenCode 改造蓝图与文件级落地方案

## 6.1 设计目标：不是复制 Claude Code，而是有选择地吸收其高回报机制

在真正开始改 OpenCode 之前，必须先把原则说清楚。

你现在最容易走入的误区，不是“改不够多”，而是“贪心地把 Claude Code Rebuilt 所有机制都搬过来”。这会直接毁掉 OpenCode 原本的结构优势。

因此，本蓝图坚持三个原则：

### 原则一：只引入高回报、低破坏的机制
优先移植那些能显著提升上下文性价比、长任务连续性、任务完成稳定性，但不要求重写整个运行时的东西。例如：

- Tool Result Budget
- Session Memory
- 角色化模型路由
- 轻量 Micro-Compaction
- Task 结果标准化

### 原则二：机制以独立服务形式接入，不破坏现有骨架
OpenCode 当前最大的优点是结构分层清楚。所有增强都应优先做成：

- service
- plugin trigger
- policy module
- metadata layer

### 原则三：每一项增强都必须能被 benchmark harness 衡量
否则“感觉更聪明了”这种主观反馈很快会误导你。

## 6.2 第一阶段改造：Preflight Pipeline

### 目标
把当前 OpenCode 在模型请求前较为简洁的准备流程，升级为一个清晰的预处理管线。目标不是无限复杂，而是把“发送前治理”做成显式系统能力。

### 新增模块建议
- `packages/opencode/src/session/preflight.ts`
- `packages/opencode/src/session/tool_budget.ts`
- `packages/opencode/src/session/workset.ts`
- `packages/opencode/src/session/micro_compaction.ts`

### 为什么从这里开始
因为这是影响全局成本与稳定性的最大杠杆，而且对现有结构侵入最小。

## 6.3 第二阶段改造：Tool Result Budget

### 目标
不等 overflow 才治理，而是在每轮前把旧工具输出压到预算内。

### 新增文件
- `packages/opencode/src/session/tool_budget.ts`

### 核心策略
按工具类型分预算：

- bash / webfetch / mcp：高风险膨胀工具，优先治理
- read / grep / glob / codesearch：中风险，按 preview+path 方式折叠
- task / summary：原则上保留摘要，不保留长原文
- edit / write：保留 diff 摘要和结果，不保留不必要重复描述

### 应修改的现有文件
- `session/prompt.ts`：模型调用前注入 budget
- `tool/registry.ts`：为 Tool.Def 补充 `returnsLargeText`、`compactPriority` 等元数据
- `tool/*`：逐步让高膨胀工具输出更多结构化 metadata

## 6.4 第三阶段改造：Session Memory

### 目标
建立“主上下文之外的慢变状态存储”。

### 新增文件
- `packages/opencode/src/session/memory.ts`
- `packages/opencode/src/session/memory_prompt.txt`
- `packages/opencode/src/session/memory_store.ts`

### 触发条件建议
满足以下条件之一时触发 memory 提取：

- token 较上次增长超过阈值；
- 工具调用累计超过阈值；
- plan/build 模式切换；
- task 子代理批量完成；
- full compaction 之前或之后。

### 注入方式建议
不要每轮都自动把 entire memory 注入 system prompt。  
更好的方式是：

- 由 preflight 判断当前任务是否需要 recall；
- recall 时只注入 relevant sections；
- compact 后优先注入 memory 摘要，而非整个长历史。

## 6.5 第四阶段改造：Micro-Compaction

### 目标
在 full compaction 之前，新增一个低成本中间层。

### 新增文件
- `packages/opencode/src/session/micro_compaction.ts`

### 适用对象
- 多段连续 read 输出
- 多段 grep / code search 输出
- 多段 bash 错误输出
- 多个 explore 子代理返回

## 6.6 第五阶段改造：角色化模型路由

### 目标
让 agent 架构真正成为“高质量 / 高性价比”的核心抓手。

### 应修改的现有文件
- `agent/agent.ts`
- `session/prompt.ts`
- `provider/*`
- `config/*`
- 可新增 `agent/router.ts`

### 建议策略
默认路由表：

- build：强模型
- plan：强模型 / reasoning 模型
- general：中档模型
- explore：便宜但长上下文/高搜索性价比模型
- compaction：便宜模型
- summary/title：极便宜模型

## 6.7 第六阶段改造：TaskTool 结果标准化

### 目标
把多 agent 协同从“好用”升级为“可运营、可压缩、可评测”。

### 应修改的文件
- `tool/task.ts`
- `session/prompt.ts`
- `agent/agent.ts`
- 可新增 `session/task_result.ts`

### 推荐结果结构
- `summary`
- `key_files`
- `open_questions`
- `next_actions`
- `confidence`
- `cost`

## 6.8 第七阶段改造：工作集 Workset

### 目标
让系统显式知道“当前真正相关的文件集合”。

### 新增文件
- `session/workset.ts`

### 输入来源
- ReadTool
- EditTool
- TaskTool 结果
- grep/code search 命中
- bash 中出现的文件路径

### 输出用途
- compact 摘要重点保留
- preflight recall 提示
- build agent prompt 提示
- benchmark 统计“工作集膨胀率”

## 6.9 第八阶段改造：观测与评测钩子

### 目标
所有策略升级都必须可量化。

### 建议新增
- `metrics/session_metrics.ts`
- `metrics/tool_metrics.ts`
- `metrics/agent_metrics.ts`

### 关键指标
- 单任务总 token
- compact 次数
- budget 减少量
- 子代理数量与成本
- 工具输出压缩比
- 人工修正轮次
- 首次完成率

## 6.10 推荐实施顺序

1. Preflight Pipeline
2. Tool Result Budget
3. Session Memory
4. TaskTool 结果标准化
5. 角色化模型路由
6. Micro-Compaction
7. Workset
8. Metrics & Harness

## 6.11 最终建议

如果你要让 OpenCode 在未来成为一个：

- 任务质量不差；
- 上下文成本可控；
- 长任务不容易失忆；
- 多 agent 协作自然；
- 结构仍然优雅；

的 CLI，那么最应该坚持的一点是：

**永远以服务与策略的方式增强它，而不是把所有聪明逻辑重新塞回一个巨大的 prompt 主循环。**



## 6.10 再往前一步：建议把改造分成“硬机制”和“软机制”两类

如果把所有改造都放在一个迭代里，你很难判断哪项真正有效。建议你把它们拆成两大类：

### 硬机制
直接影响数据流或会话状态：
- Tool Result Budget
- Session Memory
- Micro-Compaction
- Workset
- Task 结果标准化

### 软机制
更多影响行为策略或成本选择：
- 角色化模型路由
- Prompt cost policy
- Agent-specific output schema
- Compact prompt 强化
- Verification policy

先做硬机制，你会更快看到 token 与连续性改善；  
再做软机制，才能真正提升完成率和体感。

## 6.11 文件级落地顺序的一个更细版本

### Sprint 1：观测打底
改：
- `session/prompt.ts`
- `tool/registry.ts`
- 新增 `metrics/*`

目标：
- 能测每轮 token、每次 tool output 大小、每个 agent 成本。

### Sprint 2：预算层
改：
- 新增 `session/tool_budget.ts`
- `session/prompt.ts`
- 为高噪声工具补 metadata

目标：
- 压低长任务中旧工具输出占比。

### Sprint 3：Session Memory
改：
- 新增 `session/memory.ts`
- `session/compaction.ts`
- `task.ts`

目标：
- 把慢变状态移出主上下文。

### Sprint 4：Task 标准化 + 路由
改：
- `task.ts`
- `agent.ts`
- `session/prompt.ts`
- 新增 `agent/router.ts`

目标：
- 多 agent 成本可控、结果可运营。

### Sprint 5：Micro-Compaction + Workset
改：
- 新增 `session/micro_compaction.ts`
- 新增 `session/workset.ts`
- `read.ts` / `edit.ts` / `bash.ts` 接入工作集更新

目标：
- full compaction 次数下降，长任务连续性上升。

## 6.12 再强调一次：OpenCode 的正确胜法不是变成另一个 Claude

这一点值得反复说。你最终要赢，不是靠“看起来更复杂”，而是靠：

- 在相同预算下完成更多任务；
- 在相同复杂度下让系统更稳；
- 在后续几个月里仍能持续演进而不把自己拖垮。

Claude Code Rebuilt 给你的是大量宝贵启发，但 OpenCode 要走的是“有节制地吸收”，不是“冲动式模仿”。

## 6.13 最终建议

如果你要让 OpenCode 在未来成为一个：
- 任务质量不差；
- 上下文成本可控；
- 长任务不容易失忆；
- 多 agent 协作自然；
- 结构仍然优雅；

的 CLI，那么最应该坚持的一点是：

**永远以服务与策略的方式增强它，而不是把所有聪明逻辑重新塞回一个巨大的 prompt 主循环。**

OpenCode 的成功，不会来自“越来越像 Claude Code Rebuilt”，而会来自：

**在保持自身架构整洁的前提下，有节制地吸收 Claude Code Rebuilt 那些真正高回报的机制。**
