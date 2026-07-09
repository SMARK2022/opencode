# 内置工具设计对比：Read / Edit / Bash / Task 的系统性分析

## 5.1 为什么这四个工具最值得比较

无论工具列表多长，coding agent 的核心执行闭环始终离不开四类动作：

- **Read**：把世界读进来；
- **Edit**：把改动写回去；
- **Bash**：用运行时验证或探索外部状态；
- **Task**：把复杂任务切给其他 agent/子流程。

这四类工具决定了一个 agent 的基本姿态。

## 5.2 Read：Claude Code Rebuilt 更“生态型”，OpenCode 更“边界清晰”

Claude Code Rebuilt 的读取不是孤立工具。它在整个系统里常与：

- skill discovery
- memory prefetch
- agent exploration
- compact 恢复
- plan mode
- tool search

一起发生。也就是说，它的读文件行为往往嵌在更大的策略里。系统不是简单地“用户叫你 read 你就 read”，而是围绕当前 query、当前技能、当前模式与当前压缩状态去决定读什么、读多少、读后怎样进入后续状态。

OpenCode 的 `read.ts` 则展示了另一种风格。它的边界相当清晰：

- 有默认读取行数限制；
- 有最大行长与最大字节数限制；
- 路径解析明确；
- 目录和文件分开处理；
- 二进制、图片、PDF 会走专门附件逻辑；
- 会在读之前 ask permission；
- 元数据中会标注 preview、truncated、loaded 等信息。

这类 Read 设计非常利于做“高性价比上下文控制”。

### OpenCode 的可优化方向
- 增加重复读取抑制
- 支持“摘要替代原文”的可选模式
- 维护一个工作集视图

## 5.3 Edit：OpenCode 的 Edit 非常适合继续打磨

OpenCode 的 `edit.ts` 是一个非常好的基础实现。它具备几个很关键的优点：

- 使用 per-file semaphore，避免并发编辑同一文件；
- 参数简单明确：`filePath`、`oldString`、`newString`、`replaceAll`；
- 保留行尾风格；
- 在写入前 ask permission，并把 diff 作为 metadata；
- 写入后自动 format、发布 file edited / watcher updated 事件；
- 再跑 LSP diagnostics，把错误反馈回输出。

### OpenCode Edit 应继续增强的方向
- 增加“多处候选匹配解释”
- 把 edit 结果摘要化写入工作集日志
- 为 edit 工具补充“连续编辑批次”概念
- 未来加入“显式 region anchoring”模式

## 5.4 Bash：应当成为受预算控制的高价值工具，而不是上下文黑洞

Claude Code Rebuilt 的 Bash 融入整体权限与风险系统，它在高阶任务中很自然地承担探索、验证、测试等动作。问题不在功能，而在：它返回的信息如果缺少治理，很容易把上下文炸掉。因此 Claude Code Rebuilt 才会非常强调 tool result budget、summary 与压缩层。

OpenCode 当前的优势在于，Bash 处于统一 permission、plugin before/after hook、tool metadata 路径下，说明它天然适合被预算治理系统接管。

### OpenCode 对 Bash 的建议强化
- 建立 Bash Output Normalizer  
- 区分“验证型”与“探索型”命令  
- 把 Bash 结果纳入 ToolResultBudget 的重点治理对象  
- 在 compact 摘要中单独保留“已运行验证步骤”与“失败命令”  

## 5.5 Task：OpenCode 当前最强资产之一

Claude Code Rebuilt 中子代理是整个系统的天然部分，因此表现得非常强大。但 OpenCode 的 `TaskTool` 更适合后续平台化发展。它把子任务做成了：

- 可创建；
- 可恢复；
- 可指定 agent 类型；
- 可继承和裁剪权限；
- 可独立会话；
- 可被主线程以工具形式调度。

这意味着你完全可以围绕 Task 做很多“平台级能力”：

- 子代理缓存；
- 子代理模型分档；
- 子代理质量评分；
- 子代理摘要标准化；
- 子代理并发上限控制；
- 子代理工作集隔离；
- 子代理 token 账本。

### TaskTool 的下一步应当是什么
- 标准化结果输出，不要只是自由文本 `<task_result>`  
- 引入 resume policy  
- 给 explore/build/general/summary 等角色建立不同预算和 compact 策略  
- 把 task 生命周期纳入 benchmark harness  

## 5.6 四个核心工具的总体判断

### Read
OpenCode 更适合继续做成“成本敏感的上下文入口”。  
Claude Code Rebuilt 更像“强 agent 生态中的读取器”。

### Edit
OpenCode 的 Edit 很漂亮，是非常好的长期打磨基础。  
Claude Code Rebuilt 的 Edit 胜在系统协同，而不一定胜在单模块优雅。

### Bash
OpenCode 当前结构更适合把 Bash 做成受预算治理的高价值工具。  
Claude Code Rebuilt 已经证明 Bash 必须被纳入整体上下文系统治理。

### Task
OpenCode 的 TaskTool 是当前最值得下注的基础设施。  
它未必今天就比 Claude Code Rebuilt 更强，但它是更适合你继续做深的一块。



## 5.7 进一步的源码级观察：Read 与 Edit 为什么构成了 OpenCode 的“舒适基础”

OpenCode 这两个工具有一个共同特点：**都在工具层就开始做约束，而不是把约束全部留给主循环或 prompt。**

Read 的约束包括：
- 默认读取上限；
- 目录分页；
- 图片/PDF 特别处理；
- preview 与 loaded 元数据；

Edit 的约束包括：
- 同文件锁；
- old/new string 的严格替换语义；
- permission ask；
- diff metadata；
- format + file watcher + LSP diagnostics。

这意味着 OpenCode 的核心工具不是“黑箱工具”，而是天然携带大量可治理信号。后续你做预算、compact、benchmark 时，这些信号会非常有用。相比之下，很多 agent 项目之所以会慢慢变得不可控，就是因为工具层返回的只是大段文本，缺乏结构化 metadata。

## 5.8 未来最值得新增的一层：工具输出形状契约

如果你真想把 OpenCode 做成一个高性价比 agent，后续一定要建立“工具输出形状契约”。也就是说，不同工具都应该逐渐统一成：

- `title`
- `output`
- `metadata.preview`
- `metadata.truncated`
- `metadata.artifactPath`（如有）
- `metadata.semanticType`
- `metadata.compactPriority`

为什么这件事重要？因为只要工具输出形状统一了：
- Tool Result Budget 才能做得更聪明；
- Micro-Compaction 才能跨工具工作；
- Session Memory 才能知道哪些结果值得沉淀；
- Benchmark 才能比较不同工具链的真实成本。

OpenCode 已经有相当好的雏形，现在最适合把它继续收束成系统级协议。

## 5.9 对 Claude Code Rebuilt 的一个重要启发：工具本身也要有“会话观”

Claude Code Rebuilt 虽然在单个工具实现上未必总是更优雅，但它给你一个很重要的启发：**工具不是一次性动作，而是会话生态的一部分。**

比如读取工具不只是把文件内容给模型，还会影响后续工作集、技能发现、compact 恢复与任务路线；bash 不只是运行命令，而会变成预算治理对象和验证历史；skill 与 task 更是直接参与 agent 行为学。

所以 OpenCode 后续加强工具时，也不要只想着“把每个工具做强”，还要问：
- 这个工具如何被 compact 理解？
- 这个工具如何被 memory 提炼？
- 这个工具的结果如何进入 task handoff？
- 这个工具是否应该在不同 agent 下有不同输出策略？

## 5.10 最终补充结论

从内置工具这一章可以得出一个非常实际的结论：

- OpenCode 已经有一组很适合长期打磨的“优雅基础工具”；
- Claude Code Rebuilt 则提醒你：这些工具最终必须被放回整个会话系统里看。

因此，你后续不需要推翻 OpenCode 的 Read/Edit/Bash/Task 设计，真正应该做的是：

**给它们建立统一的输出治理层与会话级协同关系。**



## 5.11 再进一步：四类工具之间其实应该形成“工具链协同”而不是彼此孤立

真正强的 coding agent，不会把 Read、Edit、Bash、Task 看成四个相互独立的按钮，而会让它们形成一个闭环。Claude Code Rebuilt 给人的“完成任务很顺”之感，某种意义上正来自这种闭环感。

理想状态下，这四类工具之间应该形成如下关系：

### Read -> Task
读取不是终点，而是决定是否值得派发 explore/general/build 子代理的依据。  
如果某文件群已经被 Read 命中并确认为关键工作集，TaskTool 在拆任务时就应该直接携带这些文件线索，而不是让子代理重新从零搜索。

### Task -> Read
子代理返回的结果，不应只是“我看完了，结论如下”，而应明确指出：
- 哪些文件已经足够读过；
- 哪些文件只是可能相关；
- 哪些文件建议主线程继续深读。

这样主线程后续的 Read 才不会盲目重复。

### Read/Edit -> Bash
如果这轮编辑修改了某个测试文件、某个构建入口、某个接口实现，那么 Bash 的下一步验证命令就不应由模型自由发挥，而应尽量从工作集和修改信息中推导。也就是说，Edit 不只是改文件，还应把“建议验证入口”沉淀为结构化元数据。

### Bash -> Session Memory / Compact
验证命令的通过与失败，不应只是短期输出。  
对复杂任务来说，“哪些命令已经跑过、结果如何、失败在哪里”本身就是重要状态，应该在 compact 或 session memory 中被保留。

OpenCode 当前最大的机会，就在于它的工具层已经足够结构化，完全可以把这种协同显式化地做出来，而不必依赖隐藏魔法。

## 5.12 面向 OpenCode 的一个具体建议：建立 Tool Lifecycle Hooks

虽然 OpenCode 已经有 `tool.execute.before/after` 插件触发点，但如果你未来想把工具协同做深，建议继续往前走一步，形成真正的 Tool Lifecycle 约定。比如：

- `tool.normalize.before`
- `tool.execute.before`
- `tool.execute.after`
- `tool.summarize.after`
- `tool.compact.export`
- `tool.memory.export`

这样每类工具都能明确回答五个问题：

1. 执行前需要什么上下文；
2. 执行后原始输出是什么；
3. 对主线程更友好的摘要输出是什么；
4. compact 时该保留什么；
5. memory 时该沉淀什么。

对 Read 而言，compact export 可能是“关键文件列表 + 最近读过的段落范围”；  
对 Edit 而言，memory export 可能是“修改过的文件 + 核心差异 + 需要验证项”；  
对 Bash 而言，summarize after 可能是“命令意图 + 退出码 + 关键 tail”；  
对 Task 而言，compact export 则应是“子代理结论包”。

一旦这套 lifecycle 形成，OpenCode 的工具系统就不只是“能执行”，而会真正成为上下文治理和任务连续性的基础设施。

## 5.13 最终补充结论

内置工具这一章最值得你记住的，不是哪一个单独工具更花哨，而是：

- OpenCode 的工具已经足够优雅，适合做成系统级协议；
- Claude Code Rebuilt 则提醒你：工具最终必须参与整个会话、记忆、compact 与任务流的协同。

如果你后续认真做 Tool Lifecycle、工作集、预算与 memory 的联动，那么 OpenCode 在工具层的长期上限会非常高。
