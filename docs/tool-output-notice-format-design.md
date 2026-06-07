# opencode 工具输出提示格式设计

## 结论

opencode 需要把“模型可见的工具输出提示”从当前的临时字符串集合，收敛为一套轻量、稳定、可读的格式约束。

本设计不追求把所有运行时统计都写进上下文。详细统计应留在 tool metadata、日志或 UI 数据结构里。进入模型上下文的提示只保留足够帮助模型继续工作的关键信息：发生了什么、原始内容大致多大、当前显示了哪一段、原文如何恢复。

目标格式分三层：

```text
工具说明 prompt       -> Markdown
块级运行时提示        -> <opencode_notice ... />
高信号摘录            -> <opencode_excerpt ...> + 人类可读摘录正文
原始输出中的内联省略  -> [... short omission marker]
```

这个分层保留了现有 prompt 的可读性，同时让模型输出中的系统提示有统一边界，避免继续出现 `<pytest_summary>`、`[Tool output truncated ...]`、`...output truncated...`、`<shell_metadata>` 等各自为营的格式。

## 背景

当前 shell/bash 工具相关提示大致分散在这些位置：

- `packages/opencode/src/tool/shell/prompt.ts` 与 `packages/opencode/src/tool/shell/shell.txt`：工具说明 prompt，使用 Markdown、编号步骤、示例块。
- `packages/opencode/src/tool/shell.ts`：shell 输出截断、timeout、abort、压缩说明拼接。
- `packages/opencode/src/tool/bash-compress.ts`：终端重绘、重复行、重复块、高熵行、pytest/docker/tsc/npm 摘要、失败诊断摘录。
- `packages/opencode/src/tool/truncate.ts`：通用工具输出截断提示。
- `packages/opencode/src/session/message-v2.ts` 与 `packages/opencode/src/session/compaction.ts`：compaction 过程中 tool output 截断、旧 tool result 清理、recent user memento 截断。

现状不是单点 bug，而是提示语法没有统一层级。相同语义被不同格式表达：

| 语义 | 当前格式示例 | 问题 |
| --- | --- | --- |
| shell 输出被截断 | `...output truncated...` + `Full output saved to:` | 缺少总行数/字节数；不是结构化提示 |
| 通用工具输出被截断 | 自然语言段落 | 与 shell 截断不一致；字段不可稳定解析 |
| 重复输出被压缩 | `... [same line repeated ...]` | 可读，但与其他省略标记不统一 |
| adapter 摘要 | `<pytest_summary>`、`<docker_build_summary>`、`<tsc_diagnostics_summary>` | 每个 adapter 发明一个 tag |
| 高熵内容省略 | `<high-entropy ...>` | tag 命名和块级提示混用 |
| shell 诊断摘录 | `<bash_high_signal_excerpt>` | 方向正确，但 tag 太具体 |
| shell timeout/abort | `<shell_metadata>` | 名字宽泛，字段不结构化 |
| compaction 截断 | `[Tool output truncated for compaction: omitted N chars]` | 与 tool/shell 截断断裂 |

这些提示都会影响模型如何理解工具结果。它们必须像一个轻量 harness：把工具输出的边界、缺失、恢复方式说清楚，但不能把过多实现细节带进上下文。

## 设计原则

### 模型可见提示只保留决策必需信息

模型不需要知道所有内部阶段。例如 shell 输出可能经历：raw stream、PowerShell CLIXML normalize、terminal render、bash compression、tail truncation。默认不应把这些阶段全部展开给模型。

模型可见提示只回答：

```text
发生了什么？
完整内容大致多大？
当前显示了哪一段？
原文在哪里或如何恢复？
```

因此不建议默认输出这些细字段：

```text
presentation_lines
presentation_bytes
returned_lines
returned_bytes
max_lines
max_bytes
```

它们更适合 metadata。模型可见内容应合并为短字段：

```text
total="12438L/912KB"
shown="tail 1000L/16KB"
path="F:\...\tool_xxx"
```

### 块级提示和内联省略分离

块级提示是系统对整段输出的说明，适合结构化 tag。

内联省略发生在原始输出中间，必须短。如果每个重复块都写成 XML 自闭合 tag，压缩本身会浪费 token。

所以块级提示使用：

```text
<opencode_notice ... />
```

内联省略使用短方括号：

```text
[... repeated block 10x, 30L->3L]
```

方括号本身不是问题。问题是同一语义层混用方括号、XML、纯文本。重新分层后，方括号只承担内联省略，不再承担块级系统提示。

### tag 名稳定，语义进入 type/source

不要为每个工具或 adapter 新增 tag 名。

不推荐：

```text
<pytest_summary>
<docker_build_summary>
<tsc_diagnostics_summary>
```

推荐：

```text
<opencode_notice type="command_summary" source="pytest" ... />
<opencode_notice type="command_summary" source="docker" ... />
<opencode_notice type="command_summary" source="tsc" ... />
```

这样模型和后续代码只需要识别少量稳定 envelope。

### 原始输出正文不整体包裹

不要把完整 returned output 包在 XML 里。工具输出本身仍应保持普通文本，便于模型直接读取错误、路径、命令输出和日志。

提示只作为边界或省略说明插入。

## 格式规范

### `opencode_notice`

`opencode_notice` 是块级、单行、模型可见的系统提示。它说明一段工具输出发生了截断、压缩、保存原文、执行异常、命令摘要或 compaction 处理。

默认使用自闭合单行：

```text
<opencode_notice type="output_truncated" source="shell" total="12438L/912KB" shown="tail 1000L/16KB" path="F:\...\tool_xxx" />
```

只有字段较多、确实需要解释时，才允许多行 body：

```text
<opencode_notice type="execution" source="shell" severity="warning">
reason: timeout
timeout_ms: 120000
message: Command exceeded timeout. Retry with a larger timeout only if it is expected to keep running.
</opencode_notice>
```

规则：

- tag 名固定为 `opencode_notice`。
- `type` 必填。
- `source` 必填，取值如 `shell`、`tool`、`truncate`、`compaction`、`pytest`、`docker`、`tsc`。
- `severity` 可选，默认视为 `info`；需要时使用 `info`、`warning`、`error`。
- 默认优先使用短属性，不使用多行 body。
- 多行 body 使用 `lowercase_snake_case: value`。
- 不在 body 中使用 Markdown bullet。
- 不把原始输出正文放进 notice。
- 路径统一使用 `path`，表示完整原文恢复路径。
- 恢复说明只有在路径不足以表达时才使用 `recovery`，避免每次重复长句。

### `opencode_excerpt`

`opencode_excerpt` 用于高信号摘录，例如 shell 失败时额外附带的 root cause/fatal/recent error context。

它的开头是短 tag，后面跟人类可读摘录正文：

```text
<opencode_excerpt type="shell_high_signal" exit="1" contexts="3" errors="8" warnings="14" />

[L301-L307] root_cause
> 304 | ModuleNotFoundError: No module named 'x'
```

规则：

- tag 名固定为 `opencode_excerpt`。
- `type` 必填。
- 摘录正文保持普通文本。
- 行号用 `Lx-Ly`，命中行用 `>`，这是高效且模型友好的格式。
- 如果行号来自原始完整输出，默认不额外说明；如果来自压缩后输出，必须显式标记 `line_source="shown"`。
- 不把每行摘录包装成 XML。

### 内联省略 marker

内联省略 marker 用于替换原始输出中的局部内容。它必须短，不能为了结构化而明显增加 token。

统一格式：

```text
[... reason compact-stats]
```

示例：

```text
[... same line 42x]
[... repeated block 10x, 30L->3L]
[... progress 318 frames->final]
[... high-entropy base64 8KB hash=abc12345]
[... captured stdout omitted 420L]
[... template repeated 86x]
```

规则：

- 内联 marker 不使用 XML。
- 使用 ASCII：`x`、`->`，不要使用 `×`、`→`。
- 能用行数就用 `L`，能用字节就用 `B/KB/MB`。
- hash 只在原文恢复、去重或审计有帮助时出现。
- prefix/suffix 默认不出现；只有高熵内容需要帮助识别时才出现。
- marker 应短于被替换内容，否则不应替换。

## 推荐 type 集合

第一阶段只需要这些类型。不要提前扩展成大 taxonomy。

| type | 使用场景 | 推荐形态 |
| --- | --- | --- |
| `output_truncated` | shell 或通用工具输出被截断 | `opencode_notice` |
| `output_compressed` | 输出经过压缩且需要告知模型 | `opencode_notice` |
| `command_summary` | pytest/docker/tsc/npm adapter 摘要 | `opencode_notice` |
| `execution` | timeout、user_abort、非正常执行元信息 | `opencode_notice` |
| `shell_high_signal` | shell 错误高信号摘录 | `opencode_excerpt` |
| `compaction_truncated` | compaction 中 tool output 或 recent memento 被截断 | `opencode_notice` 或内联 marker |
| `compaction_cleared` | 旧 tool result 被 compact/prune 清理 | `opencode_notice` |

内联 marker 的 reason 不需要成为严格枚举，但建议先收敛为：

```text
same line
repeated block
progress
high-entropy
captured stdout omitted
captured stderr omitted
```

## 标准示例

### shell 输出截断

```text
<opencode_notice type="output_truncated" source="shell" total="12438L/912KB" shown="tail 1000L/16KB" path="F:\...\tool_xxx" />

<returned shell output begins here>
```

如果 shell 输出未保存完整原文，则不能写 `path`。但 shell 当前已经在截断时保存完整 raw output，后续实现应保持这个行为。

### 通用工具输出截断

```text
<opencode_notice type="output_truncated" source="tool" total="100L/6.8KB" shown="head 10L/590B" path="F:\...\tool_xxx" />

<returned tool output begins here>
```

### 输出压缩

默认不需要显示压缩 notice。只有压缩明显改变输出形态，或没有同时发生 truncation 但模型需要知道内容已被折叠时，显示：

```text
<opencode_notice type="output_compressed" source="shell" original="12438L/912KB" compressed="8420L/311KB" saved="66%" />
```

这条 notice 不应每次都出现。详细压缩统计继续放 metadata：`compressionOriginalBytes`、`compressionCompressedBytes`、`compressionSavedBytes`、各类 groups 等。

### 重复块省略

```text
line A
line B
line C
[... repeated block 10x, 30L->3L]
```

### 高熵行省略

```text
[... high-entropy jwt 2KB hash=91af33bc prefix="eyJ..." suffix="...xYz"]
```

如果 prefix/suffix 会让 marker 过长，应只保留：

```text
[... high-entropy jwt 2KB hash=91af33bc]
```

### pytest 摘要

```text
<opencode_notice type="command_summary" source="pytest" failed="3" shown="short_summary" />
```

后面可以继续放普通文本形式的失败测试列表，不需要逐项 XML 化。

### docker 摘要

```text
<opencode_notice type="command_summary" source="docker" steps="12" failed_step="#8" shown="failed_step" />
```

### tsc 摘要

```text
<opencode_notice type="command_summary" source="tsc" diagnostics="TS2322:18,TS7006:3" shown="first_by_code" />
```

### shell 高信号摘录

```text
<opencode_excerpt type="shell_high_signal" exit="1" contexts="3" errors="8" warnings="14" />

[L301-L307] root_cause
  301 | loading config
> 304 | ModuleNotFoundError: No module named 'x'
  305 | command failed
```

### shell timeout

```text
<opencode_notice type="execution" source="shell" severity="warning" reason="timeout" timeout_ms="120000" />
```

### shell 用户取消

```text
<opencode_notice type="execution" source="shell" severity="warning" reason="user_abort" />
```

### compaction 中 tool output 截断

```text
<opencode_notice type="compaction_truncated" source="tool_output" total="10 chars" shown="4 chars" />
```

如果它出现在一段原始文本末尾，也可以更短：

```text
[... compaction truncated 6 chars]
```

这里允许内联 marker，因为 compaction 截断发生在 tool output 正文内部。若作为整段替换，则用 `opencode_notice`。

### 旧 tool result 清理

```text
<opencode_notice type="compaction_cleared" source="tool_output" reason="old_result_pruned" />
```

## 字段压缩规则

模型可见字段必须短。

### 大小格式

使用 compact size：

```text
590B
6.8KB
912KB
1.4MB
```

不需要默认输出精确 bytes。精确 bytes 留在 metadata。

### 行数格式

使用 `L`：

```text
1000L
12438L
```

### 范围格式

`shown` 表示当前返回片段：

```text
shown="head 10L/590B"
shown="tail 1000L/16KB"
shown="middle L500-L700/12KB"
```

shell 默认用 `tail`，通用 tool 默认用 `head`，除非调用方指定 `direction`。

### total 格式

`total` 表示原始完整输出，不表示压缩后输出：

```text
total="12438L/912KB"
```

如果无法计算行数：

```text
total="912KB"
```

如果无法计算字节：

```text
total="12438L"
```

不要写 `unknown`，缺省字段即可。

## 进入上下文的信息预算

块级 notice 应遵守预算：

```text
正常 notice: <= 1 行
异常 notice: <= 4 行
高信号 excerpt header: 1 行
内联 omission: <= 80 字符，越短越好
```

若 notice 因 path 很长超过预算，不截断 path。路径是恢复原文的关键字段。其他字段应为 path 让位。

当已有 `path` 时，不默认追加长 recovery 文案。工具说明 prompt 已经告诉模型可以用 Grep/Read offset/limit 查看完整输出。

## 现有格式迁移映射

| 旧格式 | 新格式 |
| --- | --- |
| `...output truncated...` + `Full output saved to:` | `<opencode_notice type="output_truncated" ... />` |
| `The tool call succeeded but the output was truncated...` | `<opencode_notice type="output_truncated" source="tool" ... />` |
| `<shell_metadata>` | `<opencode_notice type="execution" source="shell" ... />` |
| `<bash_high_signal_excerpt>` | `<opencode_excerpt type="shell_high_signal" ... />` |
| `<pytest_summary>` | `<opencode_notice type="command_summary" source="pytest" ... />` |
| `<docker_build_summary>` | `<opencode_notice type="command_summary" source="docker" ... />` |
| `<docker_failed_step>` | 普通正文，前置 docker command_summary notice |
| `<tsc_diagnostics_summary>` | `<opencode_notice type="command_summary" source="tsc" ... />` |
| `<high-entropy ...>` | `[..., high-entropy ...]` 内联 marker |
| `... [same line repeated ...]` | `[... same line Nx]` |
| `... [previous N lines repeated ...]` | `[... repeated block Nx, XL->YL]` |
| `[Tool output truncated for compaction: omitted N chars]` | `[... compaction truncated N chars]` 或 `opencode_notice` |
| `[Old tool result content cleared]` | `<opencode_notice type="compaction_cleared" ... />` |

## 非目标

本设计不要求：

- 立刻重写所有旧 marker。
- 把 UI metadata、daemon log、tool metadata 全部改成同一文本格式。
- 把工具输出正文整体 XML 化。
- 为每种 adapter 建独立 schema。
- 在模型上下文里输出所有压缩统计。
- 为普通成功输出增加额外 notice。

## 实施顺序建议

第一阶段只做截断提示，因为它最影响用户和模型理解，也最容易保持最小修改面。

目标：

```text
Truncate.output -> <opencode_notice type="output_truncated" source="tool" ... />
Shell tail truncation -> <opencode_notice type="output_truncated" source="shell" ... />
```

同时保留现有 metadata：`truncated`、`outputPath`、compression stats。

第二阶段处理 shell execution metadata：

```text
<shell_metadata> -> <opencode_notice type="execution" source="shell" ... />
```

第三阶段处理 bash-compress 内联 marker：

```text
terminal progress collapsed -> [... progress ...]
same line repeated -> [... same line ...]
repeated block -> [... repeated block ...]
high entropy -> [... high-entropy ...]
```

第四阶段处理 command adapters：

```text
pytest/docker/tsc/npm summaries -> <opencode_notice type="command_summary" source="..." ... />
```

第五阶段处理 compaction marker。

## 测试要求

后续实现应优先补行为测试，而不是只断言函数名或源码结构。

建议覆盖：

- 通用工具按行截断时，notice 包含 `type="output_truncated"`、`source="tool"`、`total`、`shown`、`path`。
- 通用工具按字节截断时，notice 不再输出旧自然语言段落。
- shell tail 截断时，notice 使用 `source="shell"` 且 `shown="tail ..."`。
- 未截断输出不增加 notice。
- 有 Task 权限时，长 recovery 文案不默认进模型上下文；Task 建议如需保留应进入 prompt 或 metadata，而不是截断 notice 长文本。
- 内联 omission marker 短于被替换内容，否则不替换。
- compaction 截断不会把长统计写进模型上下文。

## 关键约束

这套格式的价值不在“更漂亮”，而在让工具输出形成一致的上下文 harness：

```text
原始输出仍然是原始输出。
opencode 插入的内容必须短、稳定、可识别。
详细统计留在 metadata。
恢复路径优先于解释长文。
内联省略要比被省略内容更省 token。
```

后续新增任何工具输出提示时，应先判断它属于哪一层：

```text
工具使用规则     -> Markdown prompt
整段输出状态     -> opencode_notice
精选诊断证据     -> opencode_excerpt
局部内容省略     -> short inline marker
内部观测数据     -> metadata/log，不进模型上下文
```

只要保持这条边界，opencode 的工具输出提示就能在风格上协调一致，同时避免把过多无关信息带入上下文。
