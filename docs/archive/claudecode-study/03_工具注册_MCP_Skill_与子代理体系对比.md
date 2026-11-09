# 工具注册、MCP、Skill 与子代理体系对比：OpenCode vs Claude Code Rebuilt

## 3.1 工具系统为什么不能只看“数量”

agent 工具系统真正重要的是四件事：

- 工具如何被注册和暴露；
- 工具是否与 agent 模式、模型类型、权限边界耦合；
- MCP 与技能是否只是“附加工具”，还是深度参与系统提示词和上下文生命周期；
- 子代理是否是独立一等公民，还是主循环里的临时 hack。

从这个角度看，OpenCode 与 Claude Code Rebuilt 是两种不同的成熟路线。

## 3.2 Claude Code Rebuilt：大而全的工具生态，深度嵌入主系统

从 `tools.ts` 可以看到，Claude Code Rebuilt 的工具面非常大。它不仅包含基础的读写编辑、bash、grep、glob、web、todo、notebook、sleep、LSP、task 管理，还包含 Agent、Skill、DiscoverSkills、Plan、REPL、MCP resource、tool search 等高级工具。这意味着它不是“给模型一把瑞士军刀”，而是构建了一个真正的 agent 工具生态。

更值得注意的是：这些工具并不是统一的“纯函数插件”，而是深度耦合进 `ToolUseContext`。从 `Tool.ts` 看，ToolUseContext 里包含的内容非常多：

- commands
- tools
- mcpClients
- mcpResources
- customSystemPrompt
- appendSystemPrompt
- refreshTools
- renderedSystemPrompt
- app state
- query tracking
- content replacement state
- permission 与 plan mode 相关状态

换句话说，Claude Code Rebuilt 的工具不是外围模块，而是主系统的延伸器官。

### Skill 不只是工具，而是提示词与上下文系统的一部分

Claude Code Rebuilt 的 skill 体系至少包括三层：

- skill discovery / listing 进入系统流程；
- invoked skills 会跨 compact 被保留；
- skill content 预算与 truncation 单独处理。

这说明在 Claude Code Rebuilt 里，skill 本质上是一种介于“工具”和“提示词资源”之间的东西。它既不是全局常驻，也不是一次性读取的纯文档。它会被发现、被调用、被记录、被跨 compact 恢复。

### 子代理：高度原生化，接近内核能力

Claude Code Rebuilt 的 AgentTool 以及相关 built-in agents，给人的感觉不是“主 agent 调另一个助手”，而是“系统内天然存在多角色 agent 工作流”。 explore、plan、verification 等角色不是外置工具集，而是 query 内核认得的参与者。

## 3.3 OpenCode：工具注册更加清晰，MCP/Skill/Task 都是一等对象

### `registry.ts` 是 OpenCode 工具系统的核心资产

OpenCode 的工具系统最值得夸的地方，就是 `registry.ts` 的设计。  
它把工具分为：

- builtin tools
- custom local tools
- plugin tools
- named tools（如 task/read）

并通过统一接口暴露 `ids`、`all`、`named`、`tools(model, agent)`。

更重要的是，它不是机械地把所有工具都暴露给所有 agent。registry 会根据：

- providerID
- modelID
- agent
- feature flags

来决定实际向模型暴露哪些工具。甚至 patch/edit 的暴露方式也会根据模型类型变化，例如 GPT 类模型可走 ApplyPatchTool，其他模型偏向 EditTool/WriteTool。

### plugin tools 与本地 tools 的装载路径非常优雅

OpenCode 不仅支持内置工具，还会扫描配置目录中的 `{tool,tools}/*.{js,ts}`，并把外部定义转为统一 Tool.Def；plugin 也能提供工具。这个结构对于二次开发极其友好，因为你不需要改核心仓库就能加新工具。

### Skill 在 OpenCode 中更轻，但也因此更容易进化

OpenCode 的 SkillTool 与 SystemPrompt.skills 逻辑说明：skills 是被显式列出来的资源，系统提示词会告诉模型“有这些 skill，可用 skill tool 加载”，同时 registry 在工具描述中也能插入当前可用 skills。

这比 Claude Code Rebuilt 轻很多。它的好处是：

- 理解成本低；
- 调试容易；
- 可控性强。

### TaskTool：OpenCode 最值得保留的“未来支点”

OpenCode 的 `TaskTool` 不是“为了支持 subagent 临时加的一个接口”，而是真正把子任务做成了：

- 可创建；
- 可恢复；
- 可指定 agent 类型；
- 可继承和裁剪权限；
- 可独立会话；
- 可被主线程以工具形式调度。

## 3.4 MCP：两者都支持，但 OpenCode 更容易在接入层做治理

Claude Code Rebuilt 的 MCP 能力与系统深度整合，甚至 MCP instructions 会进入 system prompt，mcpClients/mcpResources 也进入 ToolUseContext。它更像“把 MCP 当作系统扩展总线”。

OpenCode 的 MCP 则更多体现在：

- prompt 层将 mcp tools 注入当前 tools；
- 每个 MCP 调用也经过 tool.execute.before/after plugin hook；
- 仍然要走统一 permission ask；
- 输入 schema 会被 provider transform。

这种设计没有 Claude Code Rebuilt 那么“原生一体化”，但治理起来很舒服。你可以很自然地：

- 统计某类 MCP 工具的 token 消耗；
- 给某些 MCP 工具加截断与 summarize wrapper；
- 给某类 MCP 工具单独设权限策略；
- 将高噪声 MCP 输出自动摘要化。

## 3.5 两者在工具与代理体系上的真正差异

### Claude Code Rebuilt 的强项
- 工具生态更全面；
- 技能生命周期更完整；
- 子代理与系统主循环结合得更深；
- tool context 能影响 prompt、agent 行为、状态追踪；
- 并发与只读工具调度更成熟。

### OpenCode 的强项
- registry 设计更干净；
- agent、tool、plugin、provider 的边界更明晰；
- task 作为工具的设计更利于持续扩展；
- 更适合做按模型差异化工具暴露；
- 更适合做可观测、可测试、可替换的工程。

## 3.6 OpenCode 的建议改造方向

### 第一项：给 Tool.Def 增加更多元数据
建议在 registry 层为工具补充元数据，例如：

- `readonly`
- `parallelSafe`
- `returnsLargeText`
- `supportsPreview`
- `preferredForAgents`
- `compactPriority`

### 第二项：把 Skill 做成跨 compact 的弱持久资源
可以做轻量版：

- 记录本 session 已调用 skills；
- compact 时自动把“skill 名称 + 简短摘要 + 文件路径”带入摘要；
- 必要时允许在 compact 后自动重提示已调用 skills。

### 第三项：为 TaskTool 建立子代理结果标准化协议
建议所有子代理结果统一输出：

- `summary`
- `key_files`
- `open_questions`
- `next_actions`
- `confidence`
- `cost`

### 第四项：在 MCP 层增加统一输出瘦身器
高噪声 MCP 工具非常容易把上下文炸掉。建议对 MCP tool output 加统一的：

- preview
- truncation
- optional summary
- path/reference fallback

## 3.7 最终判断

工具、MCP、Skill、子代理这一块，Claude Code Rebuilt 的能力上限更高；  
OpenCode 的工程秩序更好，更适合你继续做体系化增强。

如果你后续只做两件事，我建议优先做：

1. **TaskTool 结果标准化 + 角色化模型路由**  
2. **Skill 与 MCP 输出的跨 compact 轻持久化**



## 3.8 从“工程整洁度”再看一遍：为什么 OpenCode 的 registry 值得你珍惜

如果你真的打算把 OpenCode 做成自己的长期 CLI，那么 `registry.ts` 是最不应该被破坏的模块之一。因为它承担了一个非常关键的职责：**把“系统具有什么能力”和“当前回合向模型展示什么能力”分开。**

这两个概念看似接近，实际上天差地别。

一个项目可以在内部安装二十种工具，但当前回合不一定都该暴露给模型。比如：
- plan agent 不应该看到 edit/write 这类执行工具；
- compaction agent 根本不应该看到 bash；
- 某个 provider 或某类模型不适合暴露 patch 类工具；
- 某些工具在当前 client 模式下就不该打开；
- 某些实验工具只应该在特定 flag 下出现。

Claude Code Rebuilt 也有类似能力，但它的实现路径更偏“系统深处的条件组合”；而 OpenCode 把这件事放在 registry 层，意味着你将来做任何优化，都能围绕一个很干净的中心点展开。

## 3.9 Skill 体系为什么不必一开始就做得像 Claude 那么重

很多人看到 Claude Code Rebuilt 的 skill 机制，会很自然地产生一种冲动：把 OpenCode 的 skill 也做成跨 compact 恢复、跨 agent 记忆、跨 prompt 注入的全功能体系。这个方向没错，但时机要非常谨慎。

因为 skill 体系一旦过重，会迅速出现两个副作用：

第一，skill 会从“按需指令资源”变成“系统级常驻状态”。这会让系统提示词、compact、memory、task 协同都变复杂。  
第二，skill 一旦深度耦合进 query 行为，它就不再只是“可选能力”，而会开始影响几乎所有回合的成本结构。

OpenCode 当前的 skill 体系更轻，反而给了你一个更舒服的演进起点。推荐做法不是直接重构成 Claude 式 rich lifecycle，而是分三步走：

第一步，增强可发现性。  
第二步，增强“已调用 skill”的持久性。  
第三步，增强“重入能力”。

## 3.10 子代理体系的下一阶段：从“会调用”走向“可运营”

OpenCode 今天的 TaskTool 已经能把子代理跑起来，但真正要把多 agent 做成优势，而不是成本黑洞，你还需要再往前走一步：**让子代理成为可以被运营的资源。**

所谓“可运营”，至少包括以下几件事：

### 一，能度量
每个子代理要知道：
- 自己用了多少 token；
- 读了多少文件；
- 调了多少工具；
- 最后产出了什么粒度的结果；
- 是否真的减少了主线程负担。

### 二，能压缩
Explore 类子代理的输出特别容易变成长段观察日志。必须要求它们以结构化 envelope 返回，否则越多子代理，主上下文越快膨胀。

### 三，能恢复
如果用户下一轮继续同一问题，或者任务被 compact 过一次，系统应该尽量恢复已有 task session，而不是再新开一个“几乎重复”的子任务。

### 四，能分档
并不是所有子代理都值得上强模型。  
Explore 可能更适合便宜模型；  
Plan 可能需要更强模型；  
Summary/Compaction 则应该极便宜。

## 3.11 MCP 治理的一个关键原则：不要只盯着权限，要盯着输出形状

很多工程师做 MCP 接入时，第一反应是权限系统。权限当然重要，但从上下文成本角度，更关键的是**输出形状**。

后续对 MCP 的治理，建议你把“输出形状”作为一个一等问题来设计：

- 能否只返回 preview 而把全文落盘；
- 能否返回结构化元数据而非长自然语言；
- 能否对高噪声字段自动做丢弃；
- 能否对长输出先本地 summarize 再回传给模型；
- 能否把“这类 MCP 结果适合 compact 掉”的信号写入 metadata。

## 3.12 最终补充结论

工具、MCP、Skill、子代理这块，Claude Code Rebuilt 给你的是一个“高完成度样板”；OpenCode 给你的是一个“高可塑性平台”。

如果你的目标是继续建设自己的体系，那么工具系统的核心不是“赶紧变多”，而是：
- 让 registry 成为真正的能力总线；
- 让 Skill 保持轻而可进化；
- 让 Task 成为多 agent 的运营中心；
- 让 MCP 输出变成被治理的资源，而不是被动洪水。
