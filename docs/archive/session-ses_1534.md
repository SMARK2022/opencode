# OpenCode harness源码优先级调研分析 (fork #1)

**Session ID:** ses_153454a36ffeWROU5Osd5ZnaHr
**Created:** 2026/6/9 22:12:57
**Updated:** 2026/6/10 10:51:36

---

## User

当前我对整个OpenCode的harness工程进行了相应的完整调研，结果发现：

F:\ML\PythonAIProject\Claude-Code\opencode\docs\opencode-deepseek--agent-workflow-forensic-report.md

请你首先全量读入，然后完整结合packages/opencode/src分析一下源码并完整进行一下优先级的排序，按照表格输出P0 P1 ...PN以及对应的#N标号，以及详细原因和实施难易度和整体修改面和修改量大小，以及整体设计是否与现有设计框架整体思想一致

请你完整调研只读并结合源码分析:

---

## Assistant

我会先只读吃完整份 forensic report，再按报告里的编号回查 `packages/opencode/src` 中的真实实现路径，最后给出按优先级排序的表格结论，不做任何文件修改。

**Tool: todowrite**

---

## Assistant

**Tool: read**

**Tool: glob**

**Tool: grep**

---

## Assistant

报告很长（3419 行），我会分块并行读完；同时提取所有 `Confirmed Finding` 和 `Recommendation` 标题，避免漏掉后续优先级项。

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: grep**

---

## Assistant

我已经读到报告第 1320 行，报告后半部分继续扩展到 #64，并且前面初始 P0/P1/P2 后又追加了更严重的工具接口和压缩问题；下一步会把剩余报告读完，再按源码机制分组核验。

**Tool: todowrite**

---

## Assistant

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: grep**

---

## Assistant

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: grep**

---

## Assistant

报告已全量读完，包括最后的源码交叉审计和 Qwen 附录；关键点是原报告自身已纠正了 #5、#6、#8、#13、#35 等部分结论，所以优先级不能直接照最早的 P0/P1/P2，需要按“源码确认后仍成立”的问题重新排序。

**Tool: skill**

**Tool: skill**

---

## Assistant

我会重点核验当前 `packages/opencode/src` 的真实实现，而不是只采纳报告文字；这一步主要覆盖 tool 接口、compaction/prompt、session/fork/request usage、todo/summary 等高影响路径。

**Tool: todowrite**

---

## Assistant

**Tool: task**

**Tool: task**

**Tool: task**

---

## Assistant

源码核验已经完成一轮并行只读分析。接下来我会补几处关键文件的直接行号依据，确保最终表格不是只依赖报告或子任务摘要。

**Tool: todowrite**

---

## Assistant

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant

我还会补查 `grep` 限制、doom-loop、fork、request usage 和工具 registry 这几处，因为它们直接影响哪些报告项是高优先级、哪些只是历史/观测问题。

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant

<thinking>**Need more verification**

I need verify `callProviderMetadata` transfer since it affects #5/#8/#6 classifications. Use grep/read. Also inspect invalid tool and question if in table.

**Tool: grep**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: grep**

---

## Assistant

只读完成：已全量读入 `docs/opencode-deepseek--agent-workflow-forensic-report.md` 3419 行，并结合 `packages/opencode/src` 做了源码核验。没有修改文件。

核心结论：最高优先级不是继续加强 prompt，而是把 harness 的“已读、已验证、已失败、已交接”的证据状态结构化保存，并让 compaction、fork、tool-loop、subagent 共享这些状态。当前设计已经有 `MessageV2.CompactionPart`、tool metadata、`SessionProcessor`、`ToolRegistry`、Effect service seam，适合做结构化深化，不适合只靠提示词补丁。

**源码校正要点**
| 报告项                    | 源码核验结论                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #6 Bash 无 exit code      | 原结论错误。当前 `shell.ts` 捕获 `code`，并写入 `metadata.exit`，同时 diagnostic appendix 使用 `exitCode` 参数。见 `packages/opencode/src/tool/shell.ts:931-1045`。                               |
| #5 apply_patch 无 diff    | 需修正。`output` 文本确实只有文件列表，但 `metadata.diff` 和 `metadata.files` 已存在。问题是“模型可见呈现/利用不足”，不是“没有捕获 diff”。见 `apply_patch.ts:210-219`、`apply_patch.ts:290-320`。 |
| #8 grep 100 条限制        | 当前源码限制是 64，不是 100。`metadata.truncated` 存在，但没有总 hidden 数和 hidden 文件分布。见 `grep.ts:14`、`grep.ts:170-213`。                                                                |
| #13 compaction 过早触发   | 原解释不准确。`PRUNE_MINIMUM` 更像 prune 门槛，不是完整 auto-compaction 触发门槛。见 `compaction.ts:40-43`。                                                                                      |
| #23/#58 fork 从零开始     | 当前源码不成立。`Session.fork` 会克隆父 session 之前的 messages/parts，但没有结构化 fork lineage、todos、summary diff、request usage 等继承。见 `session.ts:734-773`。                            |
| #51 固定 4 chars/token    | 当前已不是纯固定 4。`TokenEstimate` 有默认值 4，但会从历史 provider-confirmed usage 学习 ratio，并单独估算附件 token。见 `token/estimate.ts:1-17`、`token/estimate.ts:91-169`。                   |
| #65 doom-loop 只看同 turn | 成立。检测只取当前 assistant message 的最后 3 个 tool parts，跨 turn 重复不可见。见 `processor.ts:456-467`。                                                                                      |
| #14 tool definitions 很大 | 成立方向正确。`ToolRegistry.tools` 每次组装可用工具定义，并扩展 `task`/`skill` 描述。见 `registry.ts:333-383`。                                                                                   |

**优先级排序**
| 优先级         | 对应 #N                                                    | 实施主题                                                                                                                                 | 详细原因                                                                                                                                                                                                                                                                                                                                                        | 实施难易度 | 修改面和修改量                                                                                                                                                              | 与现有设计框架是否一致                                                                                                                                |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0             | #1, #7, #9, #12, #16, #20, #42, #50                        | 结构化 evidence handoff：已读范围、验证状态、未完成 todo、subagent 摘要、compaction notice、超大 session fallback                        | 这是最大根因。当前 `SUMMARY_TEMPLATE` 只有自然语言 `Files & Code`、`Errors & Fixes`，没有结构化记录“读过哪些 range、哪些命令已验证、哪些 todo 未完成、哪些 subagent 结论要保留”。工具输出越多，compaction 丢失越多，随后 reread/reverify/relaunch subagent。`task` 不在 `PRUNE_PROTECTED_TOOLS`，但直接保护完整 task 输出又会膨胀上下文，正确方向是结构化摘要。 | 高         | 大。涉及 `session/message-v2.ts` schema、`session/compaction.ts`、`MessageV2.toModelMessagesEffect`、`session/processor.ts`、tool metadata 汇总、migration、回放/压缩测试。 | 高度一致。当前已有 `CompactionPart.tail_start_id` 和 `recent_user_messages`，这正是结构化 handoff seam。建议深化这个 Module，而不是散落 prompt 规则。 |
| P1             | #2, #35, #36, #39, #65                                     | 跨 turn 失控保护：doom-loop 扩展、长 tool 序列 checkpoint、错误后策略切换                                                                | 当前 doom-loop 只检测同一 assistant message 内连续 3 次相同 tool input，跨 turn 的 342 次部署、281 steps 单请求不会被拦截。用户长时间无法介入会导致方向漂移。`shell` 的 abort/timeout 已较好，但 read/edit/grep 等错误后的 retry 策略仍弱。                                                                                                                     | 中         | 中。主要在 `session/processor.ts`、`run-state.ts`、permission `doom_loop`、tool error formatting、request step accounting。                                                 | 高度一致。已有 `doom_loop` permission 和 request step_count，只是检测窗口太浅，扩展为跨 turn 频率/指纹断路器符合当前架构。                            |
| P2             | #5, #8, #10, #11, #17, #18, #21, #44, #49, #66, #67, #68   | 工具结果接口可行动化：diff/hidden count/truncation/recovery hints/invalid tool error                                                     | 多个问题不是工具没做事，而是返回给模型的“主 output”太弱。`apply_patch` 有 metadata diff 但 output 极简；`grep` 只说 `64+`，没有 hidden 分布；`invalid` tool 当前返回 completed 风格文本；read/edit 错误缺少恢复提示；大量 bash 复制 dedicated tools，绕过 read stub 和结构化 metadata。                                                                         | 低到中     | 小到中。主要改 `tool/apply_patch.ts`、`grep.ts`、`read.ts`、`edit.ts`、`invalid.ts`、`provider/error.ts`、tool descriptions。                                               | 高度一致。每个 tool 已经是独立 Module，metadata/output 是天然 Interface。这里是加深 tool Interface，不是改全局架构。                                  |
| P3             | #14, #22, #30, #33, #52, #57                               | Tool definition/context budget治理：mode-scoped tools、懒加载/精简 skill/task 描述、提升 batching                                        | tool definitions 固定成本很高，skill 输出还被 compaction 保护。当前 registry 已按模型切 `apply_patch` vs `edit/write`，但仍会把大量可用工具 schema 发给模型。LSP/Plan 等历史 0 调用工具若默认暴露，会消耗上下文。batching 低会重复发送同样前缀。                                                                                                                | 高         | 大。涉及 `tool/registry.ts`、agent/mode permission、provider prompt cache、tool schema generation、TUI/API 对工具可用性的预期。                                             | 中高一致。`ToolRegistry.tools` 已有动态过滤 seam，但“懒加载工具定义”会改变 provider tool contract，需要非常谨慎。                                     |
| P4             | #23, #24, #25, #29, #32, #34, #45, #46, #47, #48, #58, #62 | Resume/fork/staleness 可恢复性：结构化 fork lineage、session age/gap notice、question timeout、agent transition marker、media accounting | 当前 fork 会克隆消息，不是零上下文，但没有结构化父子关系和状态继承。长时间 gap、CWD 变化、agent 切换、synthetic text、图片/PDF 附件都会让模型误判上下文新鲜度。question 没超时会卡住。                                                                                                                                                                          | 中         | 中。涉及 `session/session.ts`、`message-v2.ts`、prompt replay、question tool、media/token accounting、可能需要 schema/migration。                                           | 高。session/message part 本来就是状态边界，增加 lineage/time/transition markers 与现有模型一致。媒体外置引用需注意 provider 支持，设计一致性中等。    |
| P5             | #26, #27, #28, #31, #41, #54, #59, #60, #61                | Request usage / cost / observability 硬化                                                                                                | 这些主要影响审计、账单、排障和 UI。`request_usage_assistant` 没有 FK 到 `request_usage` 或 `message`，root_request_id 链路未强约束，cost/session/request 可不一致，duplicate callID 会影响 forensic 追踪。                                                                                                                                                      | 中到高     | 中到大。涉及 `request-usage.sql.ts`、`request-usage.ts`、processor step lifecycle、migration、历史数据修复。                                                                | 高。已有 request usage tables，只是约束和链路语义不够深。若要 billing-grade，需要更严格 DB contract。                                                 |
| P6             | #3, #4, #37, #38, #63, #69                                 | Prompt/process 层行为修正：anti-sycophancy、明确停止条件、Windows 指令强化、summary_diffs 诊断                                           | yes-man、停止条件、Windows Unix 命令、reasoning 与输出张力都有价值，但比结构化状态低优先级。`summary.ts` 当前已有 diff 计算和写入逻辑，历史空值不能直接判定当前代码没实现，需要单独诊断 snapshot 是否缺失或触发路径是否没跑。                                                                                                                                   | 低到中     | 小到中。主要是 provider prompts、`system.ts`、`summary.ts` 诊断和测试。                                                                                                     | 中。prompt 修正符合现状但脆弱；summary_diffs 若修实现则一致，若只加提示词则不够。                                                                     |
| P7             | #15, #19, #40, #43, #53, #55, #56, #64                     | 低优先级观测/清理：reasoning 不可见、session type/empty tables/version drift/self-analysis/random slug                                   | 这些对 harness 体验和审计有影响，但不是当前 agent 低效/失忆/失控的主因。empty tables、random slug、version drift 更偏数据治理。reasoning token 不可见受 provider 能力约束，盲目保留 chain-of-thought 也有安全和产品风险。                                                                                                                                       | 低到中     | 小到中。schema cleanup、UI/search 改进、文档化、provider 能力分支。                                                                                                         | 部分一致。DB 清理一致；保留 reasoning 原文不一定符合产品和安全边界，建议只保留可见“结论摘要”。                                                        |
| P8（暂不排期） | #6, #13 原始解释, #51 原始解释, Qwen #14                   | 已被源码证伪或显著修正的项                                                                                                               | #6 查询字段错，当前是 `metadata.exit`；#13 把 prune 门槛误当完整 compaction 触发；#51 当前估算已会学习历史 ratio；Qwen #14 已被报告自身通过消息链回溯证伪。                                                                                                                                                                                                     | 无         | 无实现修改，最多补文档或修正 forensic report。                                                                                                                              | 不适用。                                                                                                                                              |

**建议实施顺序**
| 顺序 | 建议落地切片                                                                                                                                    | 原因                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | 先做 P0 的最小结构化 handoff：`CompactionPart` 增加 `inspected_ranges`、`verified_commands`、`active_todos`、`subagent_findings` 的受限摘要字段 | 这是最大杠杆，能同时缓解 reread、reverify、todo 丢失、subagent 重复、compaction 失忆。 |
| 2    | 做 P1 的跨 turn tool fingerprint 断路器和每 N steps checkpoint                                                                                  | 修改面比 P0 小，但能直接阻止 281 steps/342 deploy 这类失控。                           |
| 3    | 做 P2 的工具 output 呈现修复，优先 `apply_patch` diff 摘要、`grep` hidden metadata、`invalid` 改 error、read/edit recovery hints                | 低成本高收益，且不会挑战整体架构。                                                     |
| 4    | 做 P3 的 tool registry 瘦身实验，先按 agent mode/permission 隐藏低频或实验性工具，不要一步到位做完整 lazy loading                               | 直接 lazy loading 风险大，先利用现有 registry filtering seam。                         |
| 5    | 做 P4/P5 的 fork lineage、request usage consistency、cost attribution                                                                           | 这是审计和长期稳定性，不应阻塞前面三类用户可感知改进。                                 |

**总体设计判断**
| 方向                      | 判断                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 结构化 handoff            | 与现有框架高度一致。现有 `MessageV2.CompactionPart` 已经不是纯文本摘要，继续加结构化字段是自然深化。                                   |
| Tool output actionability | 与现有框架高度一致。每个 tool 都有独立 `metadata` 和 `output`，修 Interface 即可。                                                     |
| 跨 turn loop guard        | 与现有框架高度一致。当前已有 `doom_loop` permission，只是观测窗口太窄。                                                                |
| Lazy tool loading         | 方向正确但风险较高。当前 provider 一次性接收工具 schema，懒加载会影响模型可调用工具集合和 prompt cache，需要 feature flag 和回归测试。 |
| Prompt-only 修复          | 设计一致但优先级低。报告里的很多行为问题表面是 prompt，根因是状态没有结构化保存。                                                      |
| 大规模 DB 清理            | 不应优先。除 request/cost 这种影响审计和账单的表，其余 empty tables、slug、version drift 主要是治理问题。                              |

最推荐的第一期目标：不要一次修 69 个点，先把 P0/P1/P2 做成一个“Agent Evidence Handoff”能力。它应该把工具调用产生的关键事实变成小而稳定的结构化状态，并由 compaction/fork/prompt replay 统一消费。这样最符合当前 opencode 的 Effect service + MessageV2 part + tool metadata 架构。

---