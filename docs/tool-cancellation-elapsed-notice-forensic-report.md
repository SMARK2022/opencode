# OpenCode 工具取消与长耗时 Notice 取证及最小实施方案

> 状态：当前唯一权威方案
> 约束：只调研和规划，不修改源码、测试、配置、数据库或生成文件
> 阈值：普通成功执行达到 120 秒时提示；abort、timeout、non-zero exit 无条件提示 elapsed
> 实施上限：最多 6 个源码文件、最多 6 个测试文件；推荐 5 个源码文件、4 个测试文件

## 0. 推荐摘要

直接复用现有 decorated output、ToolPart metadata、Processor terminalization 和 `MessageV2.toModelMessages()`，不新增 `state.execution`、tracker、terminalizer、canonical event、公共 API、SDK 字段或数据库迁移。

```text
源码 5 个：
  packages/opencode/src/util/output-notice.ts
  packages/opencode/src/tool/shell.ts
  packages/opencode/src/session/prompt.ts
  packages/opencode/src/session/processor.ts
  packages/opencode/src/session/message-v2.ts

测试 4 个：
  packages/opencode/test/tool/shell.test.ts
  packages/opencode/test/session/prompt.test.ts
  packages/opencode/test/session/processor-effect.test.ts
  packages/opencode/test/session/message-v2.test.ts
```

预计 9 个现有文件、约 240-460 行手写增删；不新增源码文件、配置、依赖、生成文件、migration 或历史回填。

## 1. 已阅读和确认的证据

### 1.1 核心源码

| 文件 | 已确认职责 |
| --- | --- |
| `src/util/output-notice.ts` | `ExecutionNotice` 和 XML-like formatter；当前 source 硬编码 shell，reason 为 timeout/user_abort/exit |
| `src/tool/shell.ts` | Bash 自己判定 abort、timeout、exit；output drain 后组装 Notice；已有 `started` 与 `metadata.durationMs` |
| `src/session/prompt.ts` | `resolveTools()` 统一包装 local/MCP；已有 `timedToolExecution()`；另有 Task 和 direct shell 路径；progress metadata 当前会重置 start |
| `src/session/processor.ts` | `failToolCall()`、abort settle、leftover cleanup 和 `interruptedToolMetadata()`；generic cancel 在此终态化 |
| `src/session/message-v2.ts` | completed 直接回放；interrupted error 有 partial output 时按 output-available 回放并隐藏 abort error |

### 1.2 测试和文档

| 文件 | 已确认覆盖 |
| --- | --- |
| `test/tool/shell.test.ts` | Bash abort、timeout、exit、partial output、truncation |
| `test/session/prompt.test.ts` | direct shell cancel、TERM-resistant shell、Bash cancel truncation、真实 SessionPrompt/Adapter |
| `test/session/processor-effect.test.ts` | Processor interrupted metadata、cleanup、experimental event |
| `test/session/message-v2.test.ts` | aborted partial output、error-text、provider message shape |
| `docs/tool-output-notice-format-design.md` | Notice 应短、稳定、只陈述模型可用事实 |
| `docs/abort-latency-fix-plan.md` | AI Bash 500ms escalation 与 direct shell 3 秒 policy 不同 |

### 1.3 当前精确行为和数据库证据

当前 Bash abort：

```text
<opencode_notice type="execution" source="shell" severity="warning" reason="user_abort" />
```

当前 timeout：

```text
<opencode_notice type="execution" source="shell" severity="warning" reason="timeout" timeout_ms="120000" />
```

non-zero exit 已显示 exit code，但三者都没有 elapsed。普通工具取消通常保存为 `status="error"`、`error="Tool execution aborted"`、`metadata.interrupted=true`；有 partial output 时模型只看到 output，取消原因丢失。

只读数据库聚合确认不能给旧记录追溯生成 elapsed：

```text
Mac Bash state.time 与 metadata.durationMs 平均绝对差约 5.9 秒，最大约 3600.5 秒
Windows 样本平均绝对差约 12.7 秒，最大约 6919 秒
Mac 可靠 Bash abort 样本平均约 61.7 秒，最大约 293.6 秒
```

120 秒是当前产品决定，不再依赖旧 5 分钟代理比例。它只控制普通成功 Notice；异常始终显示 elapsed。

## 2. 搜索确认的调用链

1. `formatExecutionNotice()` 生产调用仅在 `shell.ts` 的 timeout/user_abort/exit 和 `prompt.ts` 的 direct shell abort。
2. local tool 统一经过 `resolveTools()` 的 registry wrapper：plugin before、`timedToolExecution()`、attachment assembly、plugin after。
3. MCP 统一经过相邻 wrapper：plugin before、permission、execute、content conversion、truncation、plugin after。
4. Task 由 `handleSubtask()` 单独执行；direct shell 由 `shellImpl()` 单独执行，但都在 `prompt.ts` 内。
5. generic throw/abort 经 `processor.ts:failToolCall()`；stream cancel leftover 经 Processor cleanup；显式 repair 经 `prompt.ts:interruptedToolState()`。
6. generic interrupted replay 集中在 `message-v2.ts` 的 error branch，不需要修改 UI、DB schema 或 SDK。
7. experimental `Tool.Success` 从 `value.output.output` 发布并把同一 output 交给 `completeToolCall()`；`Tool.Failed` 在 error normalization 前发布，cleanup-wins 当前不发布 terminal event。

## 3. 必须保持的既有行为

1. Bash abort 保留 partial output，不伪造 exit。
2. timeout 同时保留配置值 `timeout_ms`。
3. non-zero AI Bash 继续是 completed ToolPart，通过 exit Notice 表达。
4. exit 0、有短输出时不增加 Notice；空输出 exit 0 保留 info exit Notice。
5. truncation Notice 位于头部，execution Notice 位于尾部。
6. AI Bash 500ms kill escalation 和 direct shell 3 秒 policy 均不变。
7. interrupted partial output 继续使用 output-available，保持 provider tool-call/result 配对。
8. attachment、MCP resource、image normalization、`_formattedContent` 和 plugin hook 行为不变。
9. provider-executed tool 无本地执行时间，不伪造 elapsed。
10. 旧记录和旧 decorated output 原样回放。
11. experimental event 的数量、顺序和既有 success/failure/cleanup 不对称不变。
12. Notice 不包含命令、参数、环境变量、原始 metadata 或重试建议。

## 4. 推荐最小实现

### 4.1 `src/util/output-notice.ts`

扩展现有类型：

```ts
type ExecutionNotice = {
  source?: "shell" | "tool"
  severity: "info" | "warning" | "error"
  reason: "timeout" | "user_abort" | "exit" | "completed"
  timeout_ms?: number
  exit_code?: number
  elapsed_ms?: number
}

export const LONG_EXECUTION_NOTICE_MS = 120 * 1000
```

`source` 缺省为 shell，旧调用兼容。增加两个同文件 pure helper：

```text
formatLongExecutionNotice(source, elapsedMs)
formatShellExecutionNotice({ aborted, expired, exitCode, emptyOutput, timeoutMs, elapsedMs })
```

Shell policy 优先级固定为 `timeout -> user_abort -> exit/non-zero/empty -> long completed -> none`，保证一个结果只生成一种系统 outcome。elapsed 必须 `Number.isFinite`、clamp 非负并整数化。

### 4.2 `src/tool/shell.ts`

1. output stream drain 后取得一次 elapsed。
2. 删除 timeout/user_abort/exit 三处分散的 Notice 决策，只调用一次 `formatShellExecutionNotice()`。
3. abort、timeout、non-zero 和空输出 exit 0 增加 elapsed。
4. exit 0、有输出且 elapsed >=120000 时返回 completed Notice。
5. 继续在 truncation/diagnostic 后追加唯一 Notice。
6. 不改 spawn、kill、drain、compression、truncation 或 metadata shape。

### 4.3 `src/session/prompt.ts`

1. `context.metadata()` 在 running progress 时保留 `match.state.time.start`；只有 pending 首次转 running 才取当前时间。
2. local/MCP wrapper 在最终 output 完成、plugin after 完成后计算 elapsed，调用 pure `formatLongExecutionNotice(source, elapsedMs)`，若返回非 undefined 则 `output += "\n\n" + notice`。短成功返回 undefined 不追加；>=120秒返回 completed Notice。
3. local wrapper 对 Bash 跳过 generic completed decoration，避免与 `shell.ts` 重复。
4. abortSignal 已 aborted 但工具正常返回时，追加 user_abort 而不是 completed，再走现有 `completeToolCall()`。
5. MCP 在 truncation 后追加 Notice，attachments/content 原样。
6. Task 在 `handleSubtask()` 完成处按同一 `formatLongExecutionNotice()` 调用追加，attachments 原样。
7. direct shell abort 增加 elapsed；非 abort 且 `formatLongExecutionNotice("shell", elapsed)` 返回非 undefined 时追加 completed。

direct shell 当前读取但丢弃 exit code，non-zero 也保持 completed 语义；长 non-zero direct shell 会显示 completed。本需求不改变该既有语义。AI Bash non-zero 仍显示 exit。

### 4.4 `src/session/processor.ts`

让现有 `interruptedToolMetadata(metadata, elapsedMs)` 覆盖写入：

```text
interrupted=true
executionElapsedMs=非负有限整数
```

调用点为 recognized abort 的 `failToolCall()`、aborted leftover cleanup 和 `prompt.ts:interruptedToolState()`。`failToolCall()` 必须先按 `toolAborted` 分支保留 metadata 并写 marker，不能继续仅在有 autoReview 时保留 metadata。普通 error 行为不变。

该 marker 是内部 replay 事实，不是公共 schema或控制流字段；server finalization 覆盖工具提供的同名键。

### 4.5 `src/session/message-v2.ts`

只修改现有 error/interrupted replay：

```text
interrupted=true + 有效 executionElapsedMs：
  有 partial output -> output + tool user_abort Notice
  无 partial output -> errorText + tool user_abort Notice

无 marker -> 保持旧记录行为
```

不搜索工具正文去重。Bash 自收尾是 completed state，不进入此 generic error 分支。

## 5. 边界、并发、兼容和安全

| 场景 | 结果 |
| --- | --- |
| shell/local/MCP/Task 119999ms 成功 | output 原样 |
| shell/local/MCP/Task 120000ms 成功 | completed + elapsed |
| abort/timeout/non-zero 任意耗时 | 对应唯一 outcome + elapsed |
| old interrupted 无 marker | 原样，不追溯 elapsed |
| provider-executed | 无 elapsed |
| direct shell 长 non-zero | 保持 completed 语义 |

不新增 Map、generation token 或 terminalizer；继续依赖 Processor 的 `readToolCall()`、terminal guard 和 Deferred settle。Bash completed 与 generic interrupted error 互斥，local Adapter 对 Bash skip，abort 优先于 long completed，因此不重复系统 Notice。不解析工具正文中的仿冒 XML。

epoch `end-start` 在系统时钟跳变时可能失真，实施时 clamp；为此不引入新 tracker。新 marker 位于开放 metadata，但不影响权限、终态、重试或控制流，外部伪造最多产生错误提示值，并会在 server cancel finalization 时被覆盖。

experimental event 兼容边界：local/MCP long success 和 cooperative abort 的最终 decorated output 会进入现有 `Tool.Success.content[].text` 并与持久化 output 一致；thrown abort 继续先发布原始 Failed，cleanup-wins 继续不发布 terminal event。模型 Notice 由最终 ToolPart replay 提供，不把 marker 加入 core event schema。

## 6. 行为级测试计划

### `test/tool/shell.test.ts`

1. abort/timeout/non-zero 保留现有行为并包含正整数 elapsed。
2. 直接测试生产 `formatShellExecutionNotice()`：119999 无 completed，120000 有 completed。
3. >=120秒 abort 只有 user_abort；timeout 只有 timeout；non-zero 只有 exit；空输出 exit 0 保留 exit。
4. truncation 后 execution Notice 在尾部且仅一条。

ShellTool 没有 clock seam，不真实等待 120 秒、不全局 mock `Date.now()`。ShellTool 直接调用上述受测 pure policy，真实进程测试负责验证正 elapsed 和输出顺序。

### `test/session/prompt.test.ts`

1. 多次 metadata update 后 start 不变。
2. direct shell abort 有 elapsed，3 秒 policy 不变。
3. local/MCP/Task 真实短成功不追加 Notice，attachments/content 不变——证明 Adapter 调用了 pure 函数并尊重其 undefined 结果。
4. cooperative abort 端到端：Adapter 检测 `abortSignal.aborted`，追加 user_abort Notice，走 `completeToolCall()`；experimental event 开启时 `Tool.Success.content[].text` 等于最终 ToolPart output。
5. local Bash 经过 Adapter 后仍只有一条 execution Notice。
6. `formatLongExecutionNotice()` 的 119999/120000 阈值确定性测试放在同文件或 `shell.test.ts`，不经过 SessionPrompt。

长成功端到端在 SessionPrompt 中不可确定性测试：没有 clock seam，120 秒等待不可接受，全局 mock `Date.now()` 在 Effect 调度/并发/persistence 中不可靠。覆盖策略改为三层：(a) pure 函数精确测试阈值；(b) 真实短成功集成测试证明 Adapter 调用并尊重函数结果；(c) Adapter 代码是 `const notice = formatLongExecutionNotice(source, elapsedMs); if (notice) output += "\n\n" + notice` 的 trivial wiring，由 (a)+(b) 组合覆盖。这是已接受的覆盖缺口，不引入 clock seam 或新依赖。

### `test/session/processor-effect.test.ts`

1. thrown abort 和 cleanup-wins 写 interrupted + elapsed marker。
2. 普通 error 不写 marker。
3. 伪造的 interrupted/elapsed 都被 server value 覆盖。
4. experimental Failed/cleanup event 数量和顺序保持当前基线。

### `test/session/message-v2.test.ts`

1. 新 interrupted 有/无 partial output 均追加一个 tool abort Notice。
2. 旧 interrupted 无 marker 保持现有 fixture。
3. completed Bash 不被追加第二条 Notice。
4. NaN、正负 Infinity、负值和非 number marker 被忽略；有限小数整数化。

当前实现首先会因缺 elapsed、start 重置和取消原因隐藏而红；实现后继续跑现有 abort、timeout、TERM-resistant、partial output 和 truncation 回归。

## 7. 验证命令

从 `packages/opencode` 运行：

```bash
bun test test/tool/shell.test.ts
bun test test/session/prompt.test.ts
bun test test/session/processor-effect.test.ts
bun test test/session/message-v2.test.ts
bun test test/tool/shell.test.ts test/session/prompt.test.ts test/session/processor-effect.test.ts test/session/message-v2.test.ts
bun typecheck
```

最后从仓库根目录运行：

```bash
git diff --check
git diff --stat
```

## 8. Git 改动估算

| 类别 | 文件数 | 预计改动 |
| --- | ---: | ---: |
| 源码 | 5 | 约 100-200 行 |
| 测试 | 4 | 约 140-260 行 |
| 合计 | 9 | 约 240-460 行 |

```text
新增/删除源码文件：0
公共 API：0
配置和依赖：0
数据库 migration：0
SDK 生成：0
历史回填：0
```

第 6 个源码或第 5/6 个测试文件只有现有 fixture 无法覆盖时才允许增加，并需在实施说明中给出理由。

## 9. 明确拒绝的扩大方案

本需求不实施 `state.execution` 公共结构、新 tracker、terminalizer、canonical SyncEvent、legacy/v2 projector 重构、`part.update` 重构、SessionMessageUpdater full-upsert、SDK regeneration、migration、UI redesign、MCP AbortSignal 基础设施重构或 assistant turn Notice。

这些议题并非永远无价值，但不是增加 elapsed Notice 的必要成本；绑入首版会把小型模型提示增强扩大为会话持久化重构。

## 10. 风险与开放问题

1. Generic 普通 error 超过 120 秒首版不提示；AI Bash non-zero 已覆盖。
2. Provider-executed 无本地可信 elapsed，不提示。
3. direct shell 不区分 non-zero，保持既有 completed 语义。
4. Experimental Failed/cleanup event 的既有不对称不修复，但通过测试锁定无回归。
5. Bash 无 clock seam；pure production policy 精确测试阈值，真实进程测试 wiring 的正 elapsed。
6. SessionPrompt 长成功端到端无确定性 clock seam；覆盖依赖 pure 函数 + 短成功 wiring + trivial adapter 代码，不引入新依赖或等待 120 秒。

当前没有必须用户决策的开放问题。

## 11. 独立审计记录

当前 120 秒最小方案必须经过 subagent 同范围完整审计。审计发现阻塞项时先修订本文，再重新完整审计，最多 6 轮；只有出现一次无阻塞结论才能放行。

| 轮次 | 结果 |
| --- | --- |
| 1 | 阻塞：experimental event 边界未定义；错误声称存在 Bash clock seam |
| 2 | 阻塞：event parity 测试放错层；formatter test 未证明 Shell outcome wiring |
| 3 | 阻塞：SessionPrompt 长成功端到端测试无确定性 clock seam |
| 4 | 无阻塞意见，放行 |

## 12. 最终推荐

```text
120 秒固定阈值
5 个现有源码文件
4 个现有测试文件
约 240-460 行手写改动
沿用 decorated output + internal metadata marker + model replay
无新持久化架构、公共 schema、SDK、migration 或配置
```

> OpenCode 在现有 execution Notice 上补充可信范围内的 elapsed；异常只陈述终止事实，长成功只陈述耗时，不推断用户意图，也不借此重构会话持久化系统。
