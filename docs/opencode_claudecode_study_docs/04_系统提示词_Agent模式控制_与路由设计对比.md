# 系统提示词、Agent 模式控制与路由设计对比：OpenCode vs Claude Code Rebuilt

## 4.1 提示词系统不是“写一段长 prompt”，而是系统架构的一部分

在 coding agent 里，系统提示词最常被误解。真正成熟的 agent 系统里，prompt 从来不是一段静态文本，而是：

- 与工具表一起生成；
- 与 agent 模式绑定；
- 与 provider 模板绑定；
- 与 permissions、skills、MCP 指令绑定；
- 与上下文压缩和恢复机制绑定。

这正是 OpenCode 与 Claude Code Rebuilt 差异很大的地方。

## 4.2 Claude Code Rebuilt：提示词是主系统的延伸，而不是独立资源

### `constants/prompts.ts` 的意义：不是一份静态 prompt，而是一整套 section 生成器

Claude Code Rebuilt 的 `prompts.ts` 非常能说明问题。它不是一段单文件 prompt，而是一系列 system prompt sections 的生成系统。你可以看到其中会拼入：

- hooks section
- system reminders
- language section
- output style section
- MCP instructions section
- system section
- doing tasks section
- actions with care section
- 以及大量与工具名、slash commands、plan mode、技能、模型家族、环境信息相关的动态内容

这种设计很强，因为它带来三种收益：

第一，针对不同模型族、不同输出风格、不同语言偏好，可以动态拼接。  
第二，系统提示词本身可以与工具系统深度保持同步。  
第三，可以做缓存友好与动态段分离，从而降低 system prompt 反复发送的成本。

### Claude Code Rebuilt 的 prompt 与工具、skills、MCP 是强联动的

在这个项目里，prompt 不只是描述工具，而是随着：

- 当前工具列表；
- skill discovery 结果；
- MCP server instructions；
- plan mode 状态；
- hooks 配置；
- output style；
- language preference；
- 某些实验 feature

一起变化。

### plan mode 与角色切换在 Claude Code Rebuilt 中更偏“原生状态机”
Claude Code Rebuilt 不只是“有个计划模式工具”，而是 plan mode 会影响权限、影响 prompt 注入、影响 compact 恢复，并且在主系统里被明确视为一种状态。

## 4.3 OpenCode：提示词系统更加模块化，模式控制更显式

### `session/system.ts`：按 provider 选择系统基底 prompt

OpenCode 的提示词体系有一个很好的特点：  
它把 provider-specific prompt 模板单独抽了出来。

在 `system.ts` 里，你能看到它会根据模型 ID 选择：

- anthropic
- gpt
- codex
- gemini
- kimi
- trinity
- default
- 特殊 beast 模板

这一步非常重要。因为不同 provider 对 tool calling、system prompt 风格、冗余约束的容忍度不同。OpenCode 不是试图用一套 prompt 打所有模型，而是承认 provider 差异，并建立 provider prompt 层。

### `session/prompt.ts`：把模式控制、工具注入、任务切换都拉到 prompt 层显式处理

这个文件里能看到：

- 计划模式的 workflow prompt；
- build-switch 提示；
- max-steps 控制；
- structured output system prompt；
- 工具 schema 解析与注入；
- task tool / subagent 调用；
- MCP tool 注入；
- plugin before/after execute 钩子。

尤其是 plan mode，那段 prompt 设计非常明确：  
先用 explore agent 做理解，再用 general agent 做设计，再写 plan file，最后必须 `plan_exit`。

### `agent.ts`：角色不是 prompt 里的约定，而是显式对象

OpenCode 的 agent 角色注册尤其值得保留。`build`、`plan`、`general`、`explore`、`compaction`、`summary`、`title` 都是显式对象，各自有：

- mode
- hidden / native
- permission
- 可选 model
- prompt
- option
- steps

## 4.4 两者最本质的差别

Claude Code Rebuilt 的 prompt 系统非常强，强在：

- 动态 section 极多；
- 与工具和会话状态深度一致；
- 能做缓存分段；
- 与 plan mode、skill、MCP、hooks 深度耦合。

OpenCode 则更像：

- provider 层模板；
- agent 角色层 prompt；
- session/prompt 执行层装配；
- plugin/hook 层补充。

它的表现可能不如 Claude Code Rebuilt 那样“老辣”，但它更利于你做自己的策略创新。

## 4.5 OpenCode 最值得做的路由增强

### 4.5.1 真正的角色化模型路由
默认路由表建议：

- build -> 强模型
- plan -> 强模型或高 reasoning 模型
- general -> 中档模型
- explore -> 便宜长上下文模型
- compaction -> 便宜模型
- summary/title -> 极便宜模型

### 4.5.2 Prompt Layer 应该开始输出“角色成本意识”
比如 explore agent 提示：

- 优先列出关键文件，不要过度展开；
- 尽量用路径、符号名、简要结论，而不是大段复述；
- 对长输出生成结构化 findings。

### 4.5.3 compact / summary agent 应采用专门的高度结构化 prompt
OpenCode 已经有 compact/summary agent，但还可以进一步升级成：

- 当前目标
- 已完成工作
- 未完成工作
- 关键文件
- 关键命令/验证
- 失败尝试
- 用户约束
- 下一轮建议第一步

## 4.6 OpenCode 不应该照抄 Claude Code Rebuilt 的地方

OpenCode 不需要复制的是：

- 过多的实验 feature prompt 分支；
- 与主循环高度纠缠的 prompt 拼接逻辑；
- 太深的内核级隐式模式切换；
- 让工具与 prompt 互相引用到难以维护的程度。

它应该吸收的是“原则”，而不是“复杂度”。

## 4.7 最终判断

提示词与模式控制这一项，Claude Code Rebuilt 的成熟度更高；  
OpenCode 的可设计空间更大。

对你后续项目而言，最优路线是：

- 保留 OpenCode 的 provider prompt 层、agent 对象层、session/prompt 装配层；
- 借鉴 Claude Code Rebuilt 的 section 化思想和动态恢复意识；
- 在 OpenCode 里建立更清晰的角色化模型路由与 compact/summary 结构化输出。



## 4.8 系统提示词真正要解决的，不只是“说什么”，而是“如何少说却不失控”

系统提示词经常被做得越来越长，尤其在 coding agent 里，很容易出现一种坏习惯：一旦发现模型在某件事上做得不好，就往 system prompt 里再加一条规定。久而久之，prompt 变成巨大的规章制度集合。

Claude Code Rebuilt 之所以虽然复杂、却仍然显得相对成熟，关键不在于它“写了更多规定”，而在于它把 prompt 做成了**分层 section**，并且区分了哪些内容可以缓存，哪些内容必须动态生成。

OpenCode 当前已经具备 provider prompt 层和 agent prompt 层，这是很好的开始。后续你应该重点强化的，不是单纯把 prompt 变长，而是做三件事：

### 一，建立“常驻信息”和“动态信息”的明确边界
比如：
- 常驻：基本行为规范、工具哲学、风险原则；
- 角色常驻：某 agent 的工作职责；
- 动态：当前工作目录、当前 agent、当前可用 skills、当前 plan 文件、当前 workset。

### 二，让提示词尽量消费结构化状态，而不是重复自然语言叙事
如果系统已经知道：
- 当前计划文件路径；
- 最近工作集；
- 已调用技能；
- 当前 agent 类型；
- 当前工具列表；

那么 prompt 不应再长篇累牍地“解释世界”，而应尽量使用结构化区块，让模型快速对齐状态。

### 三，让模式控制成为对象化状态，而不是继续堆文字规则
OpenCode 现在这一点做得比很多项目好。plan/build/general/explore/compaction 都是对象，不只是 prompt 中的一句“你现在扮演……”。你后续应继续沿着这条路走，而不是退回到“为了省事，把模式差异都写进一长段 system prompt 里”。

## 4.9 对 OpenCode 的一个重要建议：把 Agent Prompt 设计成“可组合块”而不是“整段模板”

当前 OpenCode 的模式控制已经足够清楚，但如果后续要继续增强，我建议你把 agent prompt 更进一步拆成可组合块，例如：

- `role`：职责说明
- `tooling_policy`：工具使用策略
- `cost_policy`：成本意识与输出节制
- `verification_policy`：验证要求
- `handoff_policy`：对子代理或 compact 的交接格式
- `safety_policy`：高风险动作的确认规则

然后不同 agent 去组合不同块：
- build：role + tooling_policy + verification_policy + safety_policy
- plan：role + tooling_policy（只读版） + handoff_policy
- explore：role + cost_policy + handoff_policy
- compaction：role + handoff_policy + structured summary policy

## 4.10 路由策略应该和 prompt 策略联动，而不是两套平行配置

很多系统在做多模型路由时，只做了“agent A 用模型 X，agent B 用模型 Y”。这远远不够。因为不同模型对 prompt 风格的承载能力不同：

- 有的模型喜欢简短硬规则；
- 有的模型适合较强的步骤化指令；
- 有的模型对 structured output 非常听话；
- 有的模型遇到过长的政策性 prompt 反而变笨。

OpenCode 的 `system.ts` 已经有 provider-specific prompt，这是非常好的基础。后续你做 agent 路由时，应该把路由策略与 prompt block 策略绑在一起。

## 4.11 最终补充结论

系统提示词这一模块里，Claude Code Rebuilt 最值得你学习的，不是某一段具体话术，而是三种意识：

- section 化意识；
- 动态边界意识；
- 状态恢复意识。

而 OpenCode 最值得你坚持的，则是：

- provider 分层；
- agent 对象化；
- prompt 装配集中化；
- 模式切换显式化。

只要你把这两组优点结合起来，OpenCode 在这块不需要照抄 Claude，也能走到非常强的水平。
