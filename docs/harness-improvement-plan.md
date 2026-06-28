# OpenCode Harness 改造方案与问题分析报告

> 基于 835 sessions / 94,164 tool calls / $1,195.68 total cost 的只读取证分析
> 
> 分析基准：当前仓库 `dev-smark` 分支源码（`packages/opencode/src`）
> 
> 生成时间：2026-06-28

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [设计思想调研](#2-设计思想调研)
3. [问题筛选：Harness 问题 vs 模型问题](#3-问题筛选harness-问题-vs-模型问题)
4. [根因分析与改造方向](#4-根因分析与改造方向)
5. [优先级矩阵](#5-优先级矩阵)
6. [P0 级改造方案（高影响 / 低成本）](#6-p0-级改造方案高影响--低成本)
7. [P1 级改造方案（核心机制改造）](#7-p1-级改造方案核心机制改造)
8. [P2 级改造方案（增强与实验性）](#8-p2-级改造方案增强与实验性)
9. [实施路线图](#9-实施路线图)
10. [风险评估](#10-风险评估)
11. [附录：Finding 到改造项映射](#11-附录finding-到改造项映射)

---

## 1. 执行摘要

### 1.1 分析范围

| 维度 | 数值 |
|---|---|
| 分析会话数 | 835 sessions |
| 工具调用总数 | 94,164 |
| 工具错误总数 | 1,625（1.7%） |
| 总成本 | $1,195.68 |
| 总输入 token | ~2.5B |
| 压缩事件会话 | 100 sessions（316 次 compaction） |
| Subagent 阻塞时间 | 65.2 小时 |
| 确认发现总数 | 64 Confirmed Findings |
| 源文件读取 | 40+ 文件 |

### 1.2 核心结论

通过对 64 个确认发现的逐条分析，排除 4 个纯模型问题后，剩余 **60 个 harness 工程可修复问题**被聚合为 **10 个改造方向**，按优先级分为：

| 优先级 | 数量 | 预计工期 | 核心目标 |
|---|---|---|---|
| **P0** | 8 项 | 1–2 周 | Bug 修复 + 错误诊断 + 基础验证 |
| **P1** | 10 项 | 2–4 周 | Dedup/Compaction/Subagent/Loop 核心机制 |
| **P2** | 14 项 | 按需 | 验证 Gate/Bypass/可观测性增强 |

### 1.3 预期收益

| 指标 | 当前值 | 改造后目标 | 改善幅度 |
|---|---|---|---|
| 工具错误恢复率 | 17–54% | >60% | +2–4× |
| Subagent 阻塞时间 | 65.2h | <40h | -40% |
| 重复读取热文件对 | 1,248 | <600 | -52% |
| 上下文 read output 占比 | 42.7% | <30% | -30% |
| 循环检测覆盖率 | 5.1% | >40% | +8× |
| Compaction 文件保留率 | ~28% | >60% | +2× |
| Typecheck 重跑次数 | 97 | <30 | -69% |

---

## 2. 设计思想调研

### 2.1 仓库身份

这是 opencode 的 **SMARK 增强分支**（`dev-smark` 分支，v1.15.7），一个开源的、终端优先的、provider-agnostic AI 编码 agent，采用 client/server 架构。本地修改通过 `[local-smark]` 标记（190 处，76 个文件）确保上游合并时可恢复。

### 2.2 核心设计哲学

| 设计原则 | 实现方式 |
|---|---|
| **Effect-first 架构** | `Effect.gen`/`Effect.fn` 组合，Schema-first 数据建模，`InstanceState` 按目录隔离状态，`makeRuntime` 共享 memoMap |
| **Tool-first 交互** | `Tool.define()` 自包含工具（参数 schema + execute + metadata），工具是模型与系统交互的唯一接口 |
| **多层权限系统** | precheck 静态分类器 → auto-review LLM 审查 → manual ask 用户确认；auto agent 的 4 级预审查是 LLM-cost 边界 |
| **Compaction 上下文管理** | overflow 触发 → LLM anchored summary → Evidence Handoff → pruning → 4-turn tail |
| **Provider-agnostic** | 多 provider 支持（OpenAI/Anthropic/Google/DeepSeek 等），provider-specific prompts 和 transforms |
| **Agent 系统** | build/auto/decide/plan/explore/general/permission-reviewer，不同权限和 prompt |
| **上游合并纪律** | 以上游为基础，`[local-smark]` 标记保留本地特性增量 |

### 2.3 [local-smark] 改造方向

| 方向 | 描述 |
|---|---|
| LLM-cost-aware 权限路由 | auto agent 4 级预审查（safe/general/cautious/dangerous），safe+general 不调 LLM |
| Token/cost 可观测性 | request_usage DB 表，TUI /context 面板，session list --cost |
| 多实例 daemon 加固 | Server Lock，busy_timeout 30s，WAL 加固，SessionActivity 追踪 |
| Windows/PowerShell 一等支持 | ShellOutputEncoding，CLIXML 解码，UTF-8 pipe，路径规范化 |
| 工具输出纪律/上下文卫生 | read.ts 增强（image/outline/byte-cap），shell.ts auto-permission preflight |

### 2.4 改造约束

所有改造必须遵循：
- `[local-smark]` 标记确保合并可恢复
- Effect-first 实现（`Effect.fn`/`InstanceState`/`Tool.define`）
- 向后兼容（`Schema.optional` 新增字段）
- 渐进式交付（P0→P1→P2，每批 `bun typecheck` + `bun test`）
- 不引入模型行为假设（harness 能 catch/redirect，不依赖"模型会做 X"）

---

## 3. 问题筛选：Harness 问题 vs 模型问题

### 3.1 排除项（纯模型问题，4 项）

以下问题本质属于模型自身能力或行为偏好，harness 工程改造无法根治：

| Finding | 问题 | 排除原因 |
|---|---|---|
| F-29 | 73% 单工具调用（不 batch） | 模型决策不 batch，harness 只能 prompt nudge |
| F-50 | 47 个 grep regex 错误 | 模型 regex 生成质量是模型能力问题 |
| F-32 | edit oldString U 型失败曲线 | oldString 长短选择是模型决策 |
| F-35 | 45% write 是覆写 | 模型工具选择偏好（write vs edit） |

### 3.2 保留项（Harness 可修复，60 项）

保留的 60 项分为 5 种类型：

| 类型 | 数量 | 典型 Finding |
|---|---|---|
| Harness 设计缺陷 | 3 | F-52（quotePattern bug）、F-53（offset=0）、F-24（retry 24 天） |
| Harness 有信息未传递 | 8 | F-26（auto-format silent）、F-38（LSP 不提示）、F-41（typecheck error 未标记） |
| Dedup/Registry/Detection 覆盖不足 | 12 | F-1（read partial-overlap）、F-5（doom_loop）、F-11（semantic loops） |
| Tool 设计导致效率损失 | 15 | F-13（grep 64-cap）、F-17（task 截断）、F-19（write 双倍上下文）、F-43（apply_patch all-or-nothing） |
| Context 管理丢失关键信息 | 22 | F-4（search history 丢失）、F-14（summary 28%）、F-55（pruning 不保护 read） |

---

## 4. 根因分析与改造方向

### 4.1 改造方向总览

```
64 Findings
    ├── 4 排除（纯模型问题）
    └── 60 保留 → 聚合为 10 个改造方向
         ├── 方向1: 工具错误诊断不可操作 (5F)
         ├── 方向2: 上下文信息丢失且模型不知情 (8F)
         ├── 方向3: 循环检测层次不足 (4F)
         ├── 方向4: Subagent 委托效率低下 (5F)
         ├── 方向5: Compaction 信息保留不足 (7F)
         ├── 方向6: 工具 Dedup/Registry 不完整 (3F)
         ├── 方向7: 工具输出缺乏可操作信息 (6F)
         ├── 方向8: Harness Bug 修复 (3F)
         ├── 方向9: 验证与步骤限制缺失 (3F)
         └── 方向10: 工具旁路与未覆盖路径 (7F)
              → 按优先级分配: P0×8, P1×10, P2×14
```

### 4.2 方向详细分析

#### 方向 1：工具错误诊断不可操作

| 属性 | 内容 |
|---|---|
| **涉及 Finding** | F-3（edit oldString）、F-16（apply_patch expected lines）、F-51（binary file）、F-54（notebook cellId）、F-62（跨工具模式） |
| **核心根因** | `edit.ts:709-711`、`apply_patch.ts:137`、`read.ts:618`、notebook_edit 的 error 只报告"期望什么"不报告"实际有什么"。`read.ts:384-388` 的 "Did you mean" 是唯一例外 |
| **改造方案** | 在所有内容匹配工具的 error 中增加 actual content / available alternatives |
| **设计兼容** | Tool.define 模式，[local-smark] 标记，provider-agnostic |

#### 方向 2：上下文信息丢失且模型不知情

| 属性 | 内容 |
|---|---|
| **涉及 Finding** | F-4、F-14、F-26、F-38、F-41、F-55、F-56、F-58 |
| **核心根因** | 5+ 机制拥有信息但不传递给模型——auto-format diff 在 metadata 不在 output、compaction 用 generic notice 不说明丢失了什么、file watcher 检测外部修改不通知、LSP 不可用不提示、typecheck error content 不标记 |
| **改造方案** | 统一"信息前传"原则：harness 的 effect information 必须在 tool output 中对模型可见 |
| **设计兼容** | context hygiene 方向，[local-smark] 标记 |

#### 方向 3：循环检测层次不足

| 属性 | 内容 |
|---|---|
| **涉及 Finding** | F-5（doom_loop）、F-11（semantic loops）、F-42（typecheck re-run）、F-60（跨工具模式） |
| **核心根因** | 4 层循环检测各有盲区——doom_loop 仅同消息精确匹配（10 次触发/816 sessions）、read-stub 仅精确 range（3/130）、overlap-note 非抑制性、无 semantic loop 检测、无跨消息 re-run 检测。4 层合计覆盖率 5.1% |
| **改造方案** | 扩展 doom_loop 到跨消息 sliding window + semantic 3-gram 检测 + typecheck result caching + read overlap suppression |
| **设计兼容** | safety-first 方向，Effect.fn 实现，processor.ts 集成 |

#### 方向 4：Subagent 委托效率低下

| 属性 | 内容 |
|---|---|
| **涉及 Finding** | F-10（92% re-read）、F-17（result 截断）、F-30（12% 空结果）、F-47（65.2h 阻塞）、F-61（跨工具模式） |
| **核心根因** | `task.ts:226-229` 创建全新 session 不传递 parent inspected files；background 被 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` flag 锁定；空结果通过为 "completed"；task result 用 16KB 通用截断 |
| **改造方案** | 启用 background + 传递 inspected files + 空结果验证 + result 截断预算 |
| **设计兼容** | token/cost observability 方向，[local-smark] 标记 |

#### 方向 5：Compaction 信息保留不足

| 属性 | 内容 |
|---|---|
| **涉及 Finding** | F-14、F-36、F-55、F-56、F-57、F-63、F-64 |
| **核心根因** | compaction 多个保留机制各有缺口——LLM summary 28% 保留率、Evidence Handoff 仅 20 files 且排除 search history、pruning 仅保护 skill、splitTurn 跳过 error turns、previous-summary 无质量检查、head/tail 400/2000 偏向 tail、memento budget 20% 对小模型太小 |
| **改造方案** | Evidence Handoff 增加 Search History + pruning 保护 read + splitTurn 保留 error + compaction 计数 + head/tail content-aware + memento min 4K |
| **设计兼容** | context hygiene，compaction.ts 改造，[local-smark] 标记 |

#### 方向 6：工具 Dedup/Registry 不完整

| 属性 | 内容 |
|---|---|
| **涉及 Finding** | F-1（read partial-overlap）、F-27（skill reload）、F-33（outline per-read-range） |
| **核心根因** | read stub 仅精确/覆盖 range 匹配，partial-overlap 仅 note 不 suppress；skill 每次返回完整 ~7KB 无缓存；outline 按 read offset 生成不按 file 缓存 |
| **改造方案** | read overlap>=80% suppress + skill load dedup + read outline per-file cache |
| **设计兼容** | tool output discipline，read.ts/skill.ts 改造 |

#### 方向 7：工具输出缺乏可操作信息

| 属性 | 内容 |
|---|---|
| **涉及 Finding** | F-2（bash timeout）、F-7（bash tail-truncation）、F-13（grep 64-cap）、F-18（glob 100-cap）、F-48（glob stat 慢）、F-31（webfetch 404） |
| **核心根因** | bash timeout 不区分"hung vs slow"，bash truncation 总是 tail 方向，grep/glob 不返回总数，glob 每文件 stat 仅为了 mtime sort，webfetch 404 不建议 search |
| **改造方案** | bash timeout 区分 + truncation command-aware + grep/glob total count + glob mtime sort opt-in + webfetch 404 建议 |
| **设计兼容** | tool output discipline，Windows/PowerShell first-class |

#### 方向 8：Harness Bug 修复

| 属性 | 内容 |
|---|---|
| **涉及 Finding** | F-52（quotePattern crash）、F-53（offset=0）、F-24（retry 24 天） |
| **核心根因** | `bash-compress.ts:669` 不检查 undefined；`read.ts` offset schema 用 `NonNegativeInt`（允许 0）但 tool 逻辑要求 >= 1；`retry.ts:28` `RETRY_MAX_DELAY = 2^31-1` |
| **改造方案** | guard + auto-correct + cap |
| **设计兼容** | Effect error handling，零风险 |

#### 方向 9：验证与步骤限制缺失

| 属性 | 内容 |
|---|---|
| **涉及 Finding** | F-8（45% 无验证）、F-21（Infinity step limit）、F-42（typecheck re-run） |
| **核心根因** | `verificationSection` 仅 prompt 建议无 harness gate；`agent.steps ?? Infinity`，MAX_STEPS prompt 从不触发；typecheck re-run 无 cached result |
| **改造方案** | 默认 step ceiling 200 + session-end verification notice + typecheck caching |
| **设计兼容** | LLM-cost-aware（减少无效 step = 减少 cost） |

#### 方向 10：工具旁路与未覆盖路径

| 属性 | 内容 |
|---|---|
| **涉及 Finding** | F-6、F-20、F-44、F-45、F-46、F-49、F-59 |
| **核心根因** | system prompt 禁止 cat/head/tail/sed 但不禁止 bun -e/python -c/Select-String；无 git tool 导致 5309 git 命令走 bash；WSL output 5% encoding 问题 |
| **改造方案** | 扩展 prompt + invalid tool substitute + WSL UTF-8 强制 + 可选 git 结构化工具 |
| **设计兼容** | tool output discipline，Windows/PowerShell first-class |

---

## 5. 优先级矩阵

### 5.1 评估维度

每个改造项按三个维度评分（1-5）：

| 维度 | 说明 |
|---|---|
| **影响** | 对效率/可靠性/cost 的改善程度 |
| **证据** | Finding 证据的强度和复现率 |
| **成本** | 实现难度（反向：5=简单，1=困难） |

优先级 = 影响 × 证据 × 成本（反向）

### 5.2 完整优先级表

#### P0 级（高影响 / 强证据 / 低成本 / 1-2 周可交付）

| 编号 | 改造项 | 涉及 Finding | 核心改动 | 影响 | 证据 | 成本 | 涉及源文件 |
|---|---|---|---|---|---|---|---|
| P0-1 | Harness Bug 修复 | F-52, F-53, F-24 | quotePattern guard + offset auto-correct + retry cap | 5 | 5 | 5 | bash-compress.ts, read.ts, retry.ts |
| P0-2 | 工具错误诊断增强 | F-3, F-16, F-54, F-51 | edit/apply_patch/notebook/read-binary error 增加 actual content | 5 | 5 | 4 | edit.ts, apply_patch.ts, read.ts, notebook_edit |
| P0-3 | Disabled tools 替代 | F-6 | invalid tool response 增加 substitute directive | 4 | 5 | 5 | invalid.ts, selection.ts |
| P0-4 | LSP 不可用提示 | F-38 | LSP 返回空时追加 "LSP unavailable" | 4 | 5 | 5 | edit.ts, write.ts, apply_patch.ts |
| P0-5 | apply_patch per-file | F-43 | hunk loop 改为 file-level atomicity | 4 | 4 | 3 | apply_patch.ts |
| P0-6 | Blind edit 前读检查 | F-40 | edit 前检查 collectVisibleReads | 4 | 5 | 4 | edit.ts |
| P0-7 | Auto-format surface | F-26 | write/edit output 追加 format diff | 4 | 4 | 4 | write.ts, edit.ts |
| P0-8 | Write input elision | F-19 | 执行后 elide tool input content | 3 | 4 | 3 | message-v2.ts |

#### P1 级（中高影响 / 需要较多开发 / 2-4 周）

| 编号 | 改造项 | 涉及 Finding | 核心改动 | 影响 | 证据 | 成本 | 涉及源文件 |
|---|---|---|---|---|---|---|---|
| P1-1 | Read dedup 增强 | F-1, F-33 | overlap>=80% suppress + whole-file outline cache | 5 | 5 | 2 | read.ts, read-outline.ts |
| P1-2 | Evidence Handoff 扩展 | F-4, F-14 | 增加 Search History + EVIDENCE_FILE_LIMIT 自适应 | 5 | 4 | 3 | compaction.ts |
| P1-3 | Compaction 保留增强 | F-55, F-56, F-57, F-63, F-64 | pruning 保护 read + splitTurn 保留 error + 计数 + content-aware + memento min | 5 | 4 | 2 | compaction.ts, message-v2.ts |
| P1-4 | Subagent 效率 | F-10, F-17, F-30, F-47 | background 默认 + 传递 inspected files + 空结果验证 + 截断预算 | 5 | 5 | 2 | task.ts |
| P1-5 | 循环检测增强 | F-5, F-11, F-42, F-60 | doom_loop 跨消息 + semantic 3-gram + typecheck caching + error breaker | 4 | 5 | 2 | processor.ts, prompt.ts |
| P1-6 | Step ceiling | F-21 | 默认 200 step + 80% 收敛提示 | 4 | 4 | 4 | prompt.ts, agent.ts |
| P1-7 | Grep/Glob count | F-13, F-18 | truncation 时返回 total count | 3 | 5 | 4 | grep.ts, glob.ts |
| P1-8 | Bash truncation 方向 | F-7 | command-aware head/tail direction | 4 | 4 | 3 | shell.ts, truncate.ts |
| P1-9 | Skill load dedup | F-27 | 重复加载返回 stub | 3 | 4 | 4 | skill.ts |
| P1-10 | Typecheck error flag | F-41 | 验证命令 output parse error + hasErrors flag | 3 | 4 | 3 | shell.ts, output-notice.ts |

#### P2 级（中等影响 / 实验性 / 按需实施）

| 编号 | 改造项 | 涉及 Finding | 核心改动 | 影响 | 证据 | 成本 | 涉及源文件 |
|---|---|---|---|---|---|---|---|
| P2-1 | 验证 Gate | F-8 | session-end verification notice | 3 | 3 | 4 | processor.ts |
| P2-2 | Model switching 提示 | F-9 | 切换时注入 transition note | 2 | 3 | 4 | prompt.ts |
| P2-3 | Reviewer 上下文 bound | F-22 | 限制 reviewer 为 sliding window | 3 | 3 | 2 | task.ts, permission |
| P2-4 | WSL encoding | F-44 | WSL output 强制 UTF-8 | 2 | 3 | 3 | shell.ts |
| P2-5 | Tool bypass 检测 | F-45, F-46, F-49, F-59 | 扩展 prompt + bash bypass 检测 | 3 | 4 | 2 | system.ts, shell.ts |
| P2-6 | User correction 持久化 | F-28 | 检测 correction + Evidence Handoff | 3 | 3 | 2 | compaction.ts, prompt |
| P2-7 | Reasoning elision | F-37 | 旧 reasoning 替换为 stub | 3 | 3 | 3 | message-v2.ts |
| P2-8 | Binary file 替代建议 | F-51 | type-specific alternative in error | 2 | 3 | 4 | read.ts |
| P2-9 | Webfetch 404 建议 | F-31 | 404 后建议 websearch | 2 | 3 | 5 | webfetch.ts |
| P2-10 | Todo age tracking | F-15 | 追踪 todo 年龄 + session-end notice | 2 | 3 | 3 | todo.ts |
| P2-11 | Glob stat 优化 | F-48 | mtime sort opt-in | 2 | 3 | 4 | glob.ts |
| P2-12 | Error acknowledgment | F-23 | tool error 后注入 reminder | 2 | 3 | 3 | processor.ts |
| P2-13 | Consecutive error | F-25 | 3 次连续 error 后注入策略变更 | 2 | 3 | 3 | processor.ts |
| P2-14 | Git 结构化工具 | F-20 | git_status/git_diff 返回 JSON | 4 | 3 | 1 | 新工具 |

---

## 6. P0 级改造方案（高影响 / 低成本）

### P0-1：Harness Bug 修复

| 属性 | 内容 |
|---|---|
| **Finding** | F-52, F-53, F-24 |
| **问题** | `bash-compress.ts:669` quotePattern 不检查 undefined → 9 次 JS crash；`read.ts` offset schema 允许 0 但 tool 拒绝 → 10 次 error；`retry.ts:28` RETRY_MAX_DELAY = 2^31-1 → 24.8 天等待风险 |
| **改动** | 1. quotePattern 入口加 `if (typeof pattern !== "string") return ""` 2. offset=0 auto-correct 为 1 3. RETRY_MAX_DELAY 改为 300000（5 分钟） |
| **风险** | 零风险——纯防御性 guard |
| **验证** | `bun test` 确保不破坏现有 quotePattern 行为 |

### P0-2：工具错误诊断增强

| 属性 | 内容 |
|---|---|
| **Finding** | F-3, F-16, F-54, F-51, F-62 |
| **问题** | edit/apply_patch/notebook_edit/read-binary 的 error 只报告"期望什么"不报告"实际有什么" |
| **改动** | 1. edit error 增加 closest match + actual lines（利用 9 个 fuzzy replacer 的中间结果） 2. apply_patch error 增加 actual lines at expected location 3. notebook_edit error 增加 available cellIds list 4. read binary error 增加 type-specific alternative |
| **风险** | 低——增加 error 信息不改变 tool 行为 |
| **验证** | 回放 78 个 edit error + 186 个 apply_patch error，验证恢复率提升 |

### P0-3：Disabled tools 替代建议

| 属性 | 内容 |
|---|---|
| **Finding** | F-6 |
| **问题** | 42 次 apply_patch invalid（工具被 deny），error 只列 available tools 不说用什么替代 |
| **改动** | invalid tool response 增加映射：apply_patch → "Use edit (targeted replacement) or write (full file)" |
| **风险** | 零——仅增加 error 文本 |

### P0-4：LSP 不可用提示

| 属性 | 内容 |
|---|---|
| **Finding** | F-38 |
| **问题** | 12,607 次 edit/write/apply_patch 中 0 次 LSP diagnostics 触发，模型看到 "Wrote file successfully" 误以为无错误 |
| **改动** | 当 `lsp.diagnostics()` 返回空且 LSP server 未运行时，追加 "LSP diagnostics unavailable (no language server running). Run bun typecheck to verify." |
| **风险** | 低——增加提示文本 |

### P0-5：apply_patch per-file atomicity

| 属性 | 内容 |
|---|---|
| **Finding** | F-43 |
| **问题** | 670 个多文件 patch 中，一个文件 context mismatch 导致整个 patch 失败（44 次），成功的 hunk 也被丢弃 |
| **改动** | apply_patch.ts hunk loop 改为 file-level atomic：validate 并 apply 每个文件独立，失败的文件报告 error，成功的文件正常 apply |
| **风险** | 中——改变原子性语义（从 patch-level 到 file-level），需在 release notes 说明 |

### P0-6：Blind edit 前读检查

| 属性 | 内容 |
|---|---|
| **Finding** | F-40 |
| **问题** | 1,291 次 edit（11.1%）在从未读过/写过的文件上执行，oldString 基于假设 |
| **改动** | edit execute 前检查 `collectVisibleReads` + write history，如果文件未读过且未写过，返回 "File X has not been read in this session. Read it first to verify current content." |
| **风险** | 低——可能产生 false positive（write 创建的文件），检查逻辑需同时查 read 和 write |

### P0-7：Auto-format 透明化

| 属性 | 内容 |
|---|---|
| **Finding** | F-26 |
| **问题** | 32% 的 write 有 auto-format 变更，但 format diff 在 metadata 不在 output，模型不知道内容被改了 |
| **改动** | write/edit 的 output 中追加 format diff 摘要："Note: auto-formatter modified the written content. Changed lines: <compact diff>" |
| **风险** | 低——增加 output 文本 |

### P0-8：Write input elision

| 属性 | 内容 |
|---|---|
| **Finding** | F-19 |
| **问题** | write 的 full content 在 tool input 中持久化（4.9M chars），与 output 中的 diff 双倍占用 |
| **改动** | 执行成功后，将持久化的 tool input content 替换为 stub "<content written to disk; see diff in output>" |
| **风险** | 中——改变 message-v2 持久化方式，需确认 compaction replay 和 session replay 兼容 |

---

## 7. P1 级改造方案（核心机制改造）

### P1-1：Read dedup 增强

| 属性 | 内容 |
|---|---|
| **Finding** | F-1, F-33 |
| **问题** | read stub 仅精确/覆盖 range 匹配（130 次中 3 次 stub）；outline 按 read offset 生成不按 file 缓存（0% 覆盖率 for minified files） |
| **改动** | 1. `findReadStub` 增加 overlap>=80% suppress 逻辑 2. `readOutline` 按 path+mtime 缓存 whole-file outline（从 offset 0 扫描），每次 read 复用缓存 |
| **预期** | 减少 1,248 hot pairs 中 >50% 的 partial-overlap re-read |

### P1-2：Evidence Handoff 扩展

| 属性 | 内容 |
|---|---|
| **Finding** | F-4, F-14 |
| **问题** | Evidence Handoff 仅有 Inspected Files / Verified Commands / Todos，排除 search history（grep/glob）；EVIDENCE_FILE_LIMIT 固定 20 |
| **改动** | 1. 增加 "### Search History" section（top 10 grep/glob queries + result counts + scope） 2. EVIDENCE_FILE_LIMIT 自适应：20 + compaction 次数 |
| **预期** | 减少 post-compaction 重复搜索；文件保留率 28%→>60% |

### P1-3：Compaction 保留增强

| 属性 | 内容 |
|---|---|
| **Finding** | F-55, F-56, F-57, F-63, F-64 |
| **问题** | pruning 不保护 read output（42.7% 上下文）；splitTurn 跳过 error turns；previous-summary 无质量检查；head/tail 400/2000 偏向 tail；memento budget 20% 对小模型太小 |
| **改动** | 1. PRUNE_PROTECTED_TOOLS 增加 "read"（或 file-mtime check） 2. splitTurn 保留 error turns 的 tool parts 3. compaction 计数器：第 N 次注入 "Compaction #N, summary fidelity may be degraded" 4. head/tail content-aware（read→head 1000，bash→tail-heavy） 5. preserveRecentUserBudget min 4K tokens |
| **预期** | 减少 cumulative loss；保留 error 上下文；小模型 memento 不再截断 |

### P1-4：Subagent 效率

| 属性 | 内容 |
|---|---|
| **Finding** | F-10, F-17, F-30, F-47 |
| **问题** | 65.2h 阻塞（100% foreground）；92% re-read parent files；12% 空结果；result 16KB 通用截断 |
| **改动** | 1. 移除 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` flag（默认启用 background） 2. task.ts 创建 session 时传递 parent 的 Evidence Handoff inspected-files list 3. output() 空结果返回 error 4. task result 截断预算 32-64KB + tail direction + Summary 合约 |
| **预期** | 阻塞时间 -40%；re-read overlap -50%；空结果消除；截断一致 |

### P1-5：循环检测增强

| 属性 | 内容 |
|---|---|
| **Finding** | F-5, F-11, F-42, F-60 |
| **问题** | doom_loop 仅同消息精确匹配（10 次/816 sessions）；无 semantic loop 检测（51% sessions 有）；typecheck re-run 无 caching（97 次） |
| **改动** | 1. prompt.ts agent loop 维护 sliding window（最近 30 个 tool-call signature），检测重复 3-gram 2. typecheck result caching：无 edit 间隔的重复验证命令返回 cached result 3. read overlap>=80% suppress（与 P1-1 协同） 4. consecutive-error circuit breaker：同工具 3 次 error 后注入策略变更提示 |
| **预期** | 循环检测覆盖率 5.1%→>40%；typecheck re-run -70% |

### P1-6 至 P1-10

| 编号 | 改动摘要 |
|---|---|
| P1-6 | `agent.steps ?? Infinity` 改为 `agent.steps ?? 200`；80% 时注入收敛提示 |
| P1-7 | grep truncation 时 `rg --count` 获取总数；glob truncation 时返回 total file count |
| P1-8 | bash truncation command-aware：git diff/status→head+tail，typecheck/test→tail |
| P1-9 | skill.ts 跟踪已加载 skill，重复加载返回 "Skill X already loaded" stub |
| P1-10 | 对已知验证命令 parse output for "error TS"/"FAIL"/"Error:" patterns，设置 hasErrors metadata |

---

## 8. P2 级改造方案（增强与实验性）

| 编号 | 改动摘要 | 涉及 Finding |
|---|---|---|
| P2-1 | session-end verification notice："Edits were made but no verification was run" | F-8 |
| P2-2 | model switch 时注入 "Model switched from X to Y. Prior turns followed X's conventions." | F-9 |
| P2-3 | permission-reviewer context 限制为 sliding window（最近 N turns + action） | F-22 |
| P2-4 | WSL 命令 output 强制 UTF-8 解码（不依赖 auto-detect） | F-44 |
| P2-5 | 扩展 system prompt 禁止 bun -e/python -c/Select-String；bash 命令 bypass 检测 | F-45, F-46, F-49, F-59 |
| P2-6 | 检测 user correction 信号（"不是"/"不对"/"我说的是"），在 Evidence Handoff 增加 "### User Corrections" | F-28 |
| P2-7 | 旧 reasoning（>5 turns）替换为 1-line stub "Reasoning from turn X (elided; N chars)" | F-37 |
| P2-8 | read binary error 增加 type-specific suggestion（sqlite→bun:sqlite, gzip→gunzip, unknown→strings） | F-51 |
| P2-9 | webfetch 404 追加 "URL not found. Consider using websearch to find the correct URL." | F-31 |
| P2-10 | todo.ts 追踪年龄，>20 turns pending 时注入 "Todo X has been pending for N turns" | F-15 |
| P2-11 | glob mtime sort 改为 opt-in（默认 alphabetical，不需要 stat） | F-48 |
| P2-12 | tool error 后注入 system-reminder "Previous tool call failed: <error>. State how you will address this." | F-23 |
| P2-13 | 同工具 3 次连续 error 后注入 "Tool X has failed 3 times. Consider a different approach." | F-25 |
| P2-14 | 新增 git_status/git_diff 结构化工具（返回 JSON，不受 bash truncation） | F-20 |

---

## 9. 实施路线图

```
Phase 1: P0 交付（1-2 周）
├── Week 1: P0-1（bug 修复）+ P0-3（disabled tools）+ P0-4（LSP 提示）
├── Week 1: P0-2（错误诊断）—— edit/apply_patch/notebook/read-binary
└── Week 2: P0-5（apply_patch per-file）+ P0-6（blind edit）+ P0-7（format）+ P0-8（write elision）

Phase 2: P1 交付（2-4 周）
├── Week 3: P1-1（read dedup）+ P1-9（skill dedup）+ P1-7（grep/glob count）
├── Week 4: P1-2（Evidence Handoff）+ P1-3（compaction 保留）
├── Week 5: P1-4（subagent 效率）+ P1-5（循环检测）+ P1-6（step ceiling）
└── Week 6: P1-8（bash truncation）+ P1-10（typecheck flag）

Phase 3: P2 交付（按需）
├── 独立可交付，无依赖关系
├── 建议优先：P2-5（bypass 检测）、P2-7（reasoning elision）、P2-14（git 工具）
└── 其余按需实施
```

### 9.1 依赖关系

| 改造项 | 依赖 | 说明 |
|---|---|---|
| P0-2（错误诊断） | 无 | 独立 |
| P0-5（apply_patch per-file） | 无 | 独立 |
| P0-6（blind edit） | P0-2 | 需要错误诊断增强配合 |
| P0-7（format surface） | 无 | 独立 |
| P0-8（write elision） | 无 | 独立但需验证 compaction replay |
| P1-1（read dedup） | 无 | 独立 |
| P1-2（Evidence Handoff） | P1-3 | 与 compaction 保留协同 |
| P1-3（compaction 保留） | 无 | 独立但改动 compaction.ts 密集区 |
| P1-4（subagent） | 无 | 独立 |
| P1-5（循环检测） | P1-1 | read overlap suppress 协同 |
| P1-8（bash truncation） | 无 | 独立 |
| P2-14（git 工具） | 无 | 新增工具，独立 feature |

---

## 10. 风险评估

| 风险 | 涉及改造项 | 等级 | 缓解措施 |
|---|---|---|---|
| apply_patch 原子性语义改变 | P0-5 | 中 | release notes 说明；保留 patch-level atomic 作为 config 选项 |
| write input elision 改变持久化 | P0-8 | 中 | 验证 compaction replay + session replay；config flag 控制 |
| background subagent 稳定性 | P1-4 | 中 | config flag 控制默认开启但可关闭；验证 task_status 轮询 |
| compaction.ts 上游合并冲突 | P1-2, P1-3 | 中 | [local-smark] 标记；合并时逐文件恢复 |
| semantic loop 检测开销 | P1-5 | 低 | window size 限制 30；每 step 一次检测 |
| blind edit false positive | P0-6 | 低 | 检查逻辑同时查 read 和 write 历史 |
| Evidence Handoff 膨胀 | P1-2 | 低 | Search History 上限 10 queries；EVIDENCE_FILE_LIMIT 自适应有上限 |

---

## 11. 附录：Finding 到改造项映射

| Finding | 问题摘要 | 改造项 | 优先级 |
|---|---|---|---|
| F-1 | read partial-overlap 仅 note 不 suppress | P1-1 | P1 |
| F-2 | bash timeout "(no output)" 不区分 hung/slow | P2-5(+bash timeout) | P2 |
| F-3 | edit "Could not find oldString" 无 actual content | P0-2 | P0 |
| F-4 | Evidence Handoff 排除 search history | P1-2 | P1 |
| F-5 | doom_loop exact-match 仅 10 次触发 | P1-5 | P1 |
| F-6 | disabled tools 无 substitute 建议 | P0-3 | P0 |
| F-7 | bash tail-truncation 丢失 head | P1-8 | P1 |
| F-8 | 45% edit session 无验证 | P2-1 | P2 |
| F-9 | model switching 无 transition note | P2-2 | P2 |
| F-10 | subagent 92% re-read parent files | P1-4 | P1 |
| F-11 | 51% sessions 有 semantic loops | P1-5 | P1 |
| F-12 | 1248 hot file-session pairs（测量） | P1-1 | P1 |
| F-13 | grep 64-cap 无 total count | P1-7 | P1 |
| F-14 | compaction summary 28% 保留率 | P1-2, P1-3 | P1 |
| F-15 | 26% sessions abandon todos | P2-10 | P2 |
| F-16 | apply_patch error 无 actual content | P0-2 | P0 |
| F-17 | task result 不一致截断 | P1-4 | P1 |
| F-18 | glob 100-cap 无 total + mtime sort 丢失旧文件 | P1-7 | P1 |
| F-19 | write input 双倍上下文（4.9M chars） | P0-8 | P0 |
| F-20 | 无 git tool，5309 git via bash | P2-14 | P2 |
| F-21 | agent.steps ?? Infinity，111 sessions >100 steps | P1-6 | P1 |
| F-22 | permission-reviewer 5.3M chars 上下文 | P2-3 | P2 |
| F-23 | 31.9% tool errors 未 acknowledge | P2-12 | P2 |
| F-24 | retry delay 2.1B ms（24.8 天） | P0-1 | P0 |
| F-25 | 3+ 连续 errors 50% same-tool retry | P2-13 | P2 |
| F-26 | auto-format 32% silent content change | P0-7 | P0 |
| F-27 | skill reload 无 dedup（70 次重复） | P1-9 | P1 |
| F-28 | 1313 user corrections 未持久化 | P2-6 | P2 |
| F-29 | 73% 单工具调用（排除：模型问题） | — | 排除 |
| F-30 | 12% task 空结果 | P1-4 | P1 |
| F-31 | webfetch 404 仅 8% 切 websearch | P2-9 | P2 |
| F-32 | edit U 型失败曲线（排除：模型问题） | — | 排除 |
| F-33 | read-outline 0% 覆盖率 for minified | P1-1 | P1 |
| F-34 | read output 42.7% 上下文（测量） | P1-1 | P1 |
| F-35 | 45% write 是覆写（排除：模型问题） | — | 排除 |
| F-36 | 24 次 compaction 累积损失 | P1-3 | P1 |
| F-37 | reasoning 8.8% 上下文不 elide | P2-7 | P2 |
| F-38 | LSP 0 diagnostics（12,607 edits） | P0-4 | P0 |
| F-39 | editor-context 0% action rate（789 injections） | P2-5 | P2 |
| F-40 | 1291 blind edits（11.1%） | P0-6 | P0 |
| F-41 | 13% typecheck errors 未 acknowledge | P1-10 | P1 |
| F-42 | 97 immediate typecheck re-runs | P1-5 | P1 |
| F-43 | apply_patch all-or-nothing（44 multi-file failures） | P0-5 | P0 |
| F-44 | WSL 5% encoding issues | P2-4 | P2 |
| F-45 | 1757 Select-String 绕过 grep | P2-5 | P2 |
| F-46 | 412 inline scripts 绕过 read | P2-5 | P2 |
| F-47 | 65.2h subagent blocking，0 background | P1-4 | P1 |
| F-48 | glob p90=2349ms（per-file stat） | P2-11 | P2 |
| F-49 | 58 Unix-in-pwsh errors | P2-5 | P2 |
| F-50 | 47 grep regex errors（排除：模型问题） | — | 排除 |
| F-51 | read binary 无 alternative suggestion | P0-2, P2-8 | P0/P2 |
| F-52 | quotePattern .replaceAll on undefined（9 crashes） | P0-1 | P0 |
| F-53 | offset=0 1-indexed confusion（10 errors） | P0-1 | P0 |
| F-54 | notebook cellId 83% non-recovery | P0-2 | P0 |
| F-55 | PRUNE_PROTECTED_TOOLS 仅 skill | P1-3 | P1 |
| F-56 | splitTurn 跳过 error turns | P1-3 | P1 |
| F-57 | previous-summary 无质量检查 | P1-3 | P1 |
| F-58 | 5+ silent feedback gaps（跨工具） | P0-4, P0-7, P1-3 | P0/P1 |
| F-59 | 5+ tool bypass paths（跨工具） | P2-5 | P2 |
| F-60 | 4 loop layers 5.1% coverage（跨工具） | P1-5 | P1 |
| F-61 | subagent 5 compounding inefficiencies（跨工具） | P1-4 | P1 |
| F-62 | error diagnostics 跨工具 non-actionable（跨工具） | P0-2 | P0 |
| F-63 | compaction truncation head/tail bias | P1-3 | P1 |
| F-64 | preserveRecentUserBudget 20% too small | P1-3 | P1 |

---

*报告完成。本报告基于只读取证分析，未修改任何数据库或源码。*
