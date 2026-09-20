# Canonical Implementation Plan: 单 Bash 工具的原生引用与模型调用成功率

> Status: verified
>
> Revision: R9
>
> Approved revision: R9
>
> Audit mode: full-scope
>
> Requirement source: 本会话用户原文，见 §1
>
> Implementation allowed: completed; further changes require separate authorization
>
> Last updated: 2026-09-20
>
> Repository baseline: `d8e5e44353d8659094995c2ec999ae01543e9222`

唯一 canonical plan。按用户明确授权修正单引号展开说明，其余提示修改仍须逐次同意；保留已限定的执行、配置与权限逻辑修复及其他工具运行行为。原评测结果完整保留，最终目标保持verified-implementation。

## 1. Verbatim Requirement

> 请注意，你需要完整按照这个内容构建相应的plan，与此同时请注意，理论上我的目标要求是最终的harness能够完整准确的执行和诱导模型执行正确的 包含$命令的撰写、执行；以及反斜杠相关内容的撰写与执行；
>
> 整体目标是提高模型输出并在opencode运行的成功率，同时整体如果要修改prompt则应当保持场景泛化性精确性以及相应的修改行数理论上净增小于10行

> 因此我拒绝加入exec作为bash工具内容，也就是我不希望构建一套新的toolcall的schema，请重新完整思考构建，找到相应的处理方案使得整体的bash的失败或者解析错误概率有相应降低且整体方案更为通用鲁棒的完整方案：

> 不得按照分支处理转译的思路，这会导致逻辑混乱且不同环境支持程度不足

最新收敛要求：

> 在 pwsh 下，凡是不希望 PowerShell 当前这一层展开的 payload，优先用单引号 `'...'`；复杂/多行时再升级成单引号 here-string `@'...'@`。
>
> 请保持整体方案不要过度臃肿或者堆积过量过时内容，过时或者弃用的内容可以直接移除，整体方案保持清爽

最新提示要求：

> 你的 WSR 为什么不加一行提醒呢？告诉他应该使用 exec。
>
> 你并不是一个事实上适合 agent，或者给模型看的一种调用规则。

这里的 exec 指 WSL 的 `--exec` 参数，继续保持单个 Bash Tool。

实施中的最新范围要求（逐字）：

> 不得在原有基础上引入新的不在原来限定范围的权限限定，即使是既有权限边界
>
> 审计中的一些内容譬如让你优化超出原有范围内的更细节的模型也不得进行
>
> 譬如原有内容没有对某种执行方式作出限定，现在也不得进行限定，最多能做的是让之前的权限系统适配我们的单引号或者exec的剥离机制
>
> 保持权限系统生产不改动测试就不改动的原则，不平白无故增加复杂度
>
> 如果生产代码没了那就行内注释跟着没呗，最多加一两行占位解释为什么移除的注释

> 整体生产代码修改行数不超过1200行，不超过8个生产代码文件
>
> 当然如果出现了重复的提示词或者重复的这种分支逻辑你可以进行相应的移除，譬如多处地方都进行了针对性的fork组装，但是本来可以写到同一个地方

测试与评测新增文件沿用后续用户授权，评测入口位于 `packages/opencode/test/eval-shell-intent.ts`；保留 cmd、Windows PowerShell 5.1 与 pwsh 各自的语法说明，重复组装集中于 ShellPrompt。

权限改动只承接本次原文执行与引用/参数解析的变化，沿用已有动作风险规则。审计意见同样受此范围约束。未改的权限生产逻辑，其测试与注释原样保留；退役逻辑的行内注释随代码删除。

### 1.1 当前修改授权（优先于较早方案中的提示修改安排）

> 因此请你修正方案，不得使用之前那种我没有授权你，也没有允许你进行额外的这种提示词修改的内容。每一次提示词修改都必须经过我的同意。你所能改动的内容只有相应Play中的具体的一些逻辑等等内容。本质上而言，大概率情况下我是不在这里的，所以相当于相应的提示词本质上你是不得修改的。即使审计员报出了这个审计的问题，你也不得进行修改。你应当将其视为无效审计，或者应当视为用户授权的既有缺陷。

> 我认为不得改变其他工具的运行状态或者运行行为，这会导致不确定性和歧义性，所以仍然保持原样。

> 我说过了，我指的实质性修改指的是你做出超出我授权范围内的额外修改的时候，属于未授权修改，而不是你任何在 Workflow 内部的修改。请注意这点，继续工作。不得在任何时候进行block。

> 大多数时候的实时请你自行进行，避免子agent无法理解你的意图。同时注意不得对额外的或者超出范围授权的内容增加改动，譬如但不限于审计员指出一个新的环境下有一个新的命令又有什么什么新的问题，那本质上这种内容不在讨论范围内，除非你问用户。

- 每次提示词增删、替换、示例增加、去重、移动或渲染调整均须用户明确同意具体修改；工作流授权、旧revision批准及审计建议均保留其原范围。
- 用户离线期间保持现有模型可见文字与组装规则。范围覆盖系统提示、Tool description、schema字段说明、shell分版本指导、错误提示和用于模型评测的任务文字。
- 已有工作区提示差异保留追溯；本轮只执行下述用户明确要求的单引号说明修正，其余文字调整继续逐次取得同意。
- 继续修订方案、审查源码、验证及修复已授权逻辑。primary直接完成主要工作，独立auditor承担规定的审计。
- 其他工具、Git Bash启动模式、MSYS/CYGWIN等环境变量、外部程序参数处理政策保持现状。新增环境或命令的问题先作范围归属记录，进入额外修复前取得用户授权。

紧随其后的用户明确授权（逐字）：

> 我刚说过了，我刚要求你把那个东西去改掉，因为之前那个内容我本质上就没有授权你进行改。
>
> 相关提示词必须写成你更精确的那种说法。
>
> 我从来没有告诉你过，让你把提示词写成什么什么什么什么按照原文保留等等这种话，因为这种话是你自己意淫的。
>
> 我再次重复，保持长城任务完整准确进行，必须最终真正完成整个任务，才能进行不调用工具的回报。

本轮授权定位到 `powershellNotes` 中的单引号说明：移除 `to pass ... as text` 的传递承诺，采用§10.2的准确展开规则。此项同步到对应行为测试，其他提示文字保持。全过程持续推进至真实verified-implementation，遇到返工继续按授权范围处理。

| ID | 可验收要求 |
| --- | --- |
| R1 | 一个 `bash` Tool，既有参数 shape、默认 shell 选择与配置兼容性保持。 |
| R2 | 正确表达本层展开、下一层展开、字面 `$`，以及反斜杠、引号和换行。 |
| R3 | JSON 标准解码一次；执行正文保真；移除 Python 内容猜测改写。 |
| R4 | 原生引用指导的目标保留；当前文字冻结，每次修改按§1.1单独取得用户同意。 |
| R5 | 本任务所有模型可见提示合计净增 <=9 行，各渲染 profile 同样 <=9 行。 |
| R6 | 保留源码风险审查、精确 native 退出码、输出、取消、超时及执行证据。 |
| R7 | 工具保真与模型生成质量分别验收；成功包含预期值检查。 |
| R8 | 每次提示词修改须有用户明确授权；审计发现适用§21的范围与已接受缺陷处理。 |

## 2. Explicit Non-Goals

- 保留 `command/workdir/timeout/description/compress_output` 字段、类型、必填性及默认值；当前字段说明按§1.1冻结。
- 不新增 Exec、工具参数、自动 shell 分流、源码修复重试、隐式文件或 Base64 bootstrap。
- 不强制所有环境改用 pwsh/Git Bash，不修改用户 `cfg.shell`、PTY 或既有 shell 查找回退。
- 不整体 revert `49b80965ed`，不撤回后续权限语法、Git cwd 和风险等级修复。
- 不以整体 cautious 替代精确解析，不执行历史业务源码，不上传会话原文或凭据。
- 不引入持久 shell、通用执行框架重构或长篇 shell 场景教程。

## 3. Repository Context

根与 package `AGENTS.md` 要求最小正确修改、Effect 现有 service/layer、package 内测试和 `bun typecheck`；`CONTEXT.md` 确定 Tool/Permission/Session 边界。ADR 索引未规定另一套 shell 合同。

遵循 `.opencode/policy/first-principles-engineering.md`。保留已验证的 `docs/plans/shell-bare-dash-permission-parse-repair.md` R2 的分析/执行隔离和精确分类；`docs/powershell-inline-python-normalization-plan.md` 是旧适配的历史记录。第三方 Pi、上游 OpenCode 仅作参考，不移植额外工具。

## 4. Files and Evidence Read

以下 `src/`、`test/` 相对 `packages/opencode/`。

| Source | 证据 | Class |
| --- | --- | --- |
| `src/tool/shell.ts:410,543,556,1368,1403` | normalizer 折半反斜杠、改引号和插值语义，执行另一份 command | observed |
| `src/tool/shell.ts:620,661,1009,1143,1270` | 原生传输、UTF-8 环境、runner、终态与生命周期 | observed |
| `src/tool/shell/prompt.ts:22,55,126,172,222` | 已有引用提示、通用字段说明、换行限制及重复指导 | observed |
| `src/session/system.ts:206`、`src/tool/shell.ts:1327` | `acceptable()` 与 `acceptable(cfg.shell)` 分裂 | observed |
| `src/shell/shell.ts:159`、`src/session/prompt.ts:1714` | direct shell 的 command 插入 eval 字符串后提前展开 | observed |
| `src/shell/parse.ts:46,86,110` | bare dash、PowerShell 引用边界和 literal pipeline 事实遗漏 | observed |
| `src/permission/precheck.ts:501,550,605,726,733`、`auto.ts:70` | stdin/source 风险入口、包装器覆盖及 general allow | observed |
| `src/util/output-notice.ts`、`test/tool/shell.test.ts:2292,2314,2333,2662` | 精确 native code、notice 与真实反斜杠测试合同 | contracted |
| `test/shell/shell.test.ts`、`test/session/system.test.ts`、`test/permission/precheck.test.ts` | 可复用公共 seam | observed |
| `.temp/thirdparty/pi/packages/coding-agent/src/core/tools/bash.ts:95`、`tools/index.ts:195` | Pi command-string 主接口；本地 revision `e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe` | observed |
| `thirdparty/opencode-11720/packages/opencode/src/tool/shell.ts:293` | 本地上游基线的 command-string 执行路径 | observed |

### 4.1 历史与实验基线

数据库只读查询，截止 `1789796586485`：151,092 条 Bash、90,400 条冷存储、5,441 条 adaptation、5,139 条 adaptation exit 0。历史成功记录恢复原生解析后，658 条 Python 语法错误、113 条 PowerShell 语法错误、9 条 AST 改变、10 条动态展开、4,349 条 AST 相同。单位为调用记录，含重复/诊断调用。

以旧 adaptation 实际源码为比较对象：5,441 个 literal here-string 经 PowerShell 官方 Parser 解析且字符一致；5,423 份可解析 Python 源码在附加管道尾部 CRLF 后 AST 相同；18 份源码自身语法检查失败。源码中观察到 10 次 `sys.argv` 引用。这些是静态保真证据，历史业务源码未执行。

最新 WSL 精确对照（pwsh，纯打印）：

| command | 输出 |
| --- | --- |
| `wsl -- bash -lc 'echo "$HOME"'` | `/root` |
| `wsl -- bash -lc 'HOME=/__target_probe__; echo "$HOME"'` | `/root` |
| `wsl --exec bash -lc 'HOME=/__target_probe__; echo "$HOME"'` | `/__target_probe__` |
| `wsl -- bash -lc 'echo \"\$HOME\"'` | `"/root"` |
| `wsl --exec bash -lc 'echo \"\$HOME\"'` | `"$HOME"` |

含义：单引号让 PowerShell 保留字符串中的字符；WSL `--` 仍带默认 shell，`--exec` 指定直接程序。单独打印 HOME 会掩盖展开层差异。此区别同时进入测试和一行可执行的 WSL 提醒。

### 4.2 评测预检发现

R4 实施准备中的评测器遗漏 Windows `PATHEXT`。真实隔离子进程对照：相同 Python 目录 PATH 与 SystemRoot，`Get-Command python` 在 PATHEXT 空时 exit1/空输出，在 `.COM;.EXE;.BAT;.CMD` 时 exit0并返回 `D:\ProgramData\miniforge3\python.exe`。评测结果文件中的 PowerShell Python/Node 未找到与此吻合，Git Bash 可找到同一 Python。首次分歧属于评测器 `minimalEnv`，生产 runner 保持原基线。

截至本次修订，评测 ledger 共51次 provider 请求（Kimi48、GPT3）。这批记录包含环境故障、JSON/SSE 协议错配及一次120秒 provider超时，整体归入诊断批次，保留原记录与费用，不参与正式 baseline/candidate 比较。GPT Responses 网关返回 SSE，官方 SDK `streamText` 已成功取得一个完整工具调用；普通 `generateText` 对该网关的 JSON 解码失败。R5 统一采用 SDK 流式入口，事件解析归属 SDK。

### 4.3 已有 conda 覆盖的承接

旧 normalizer 明确支持 `conda run --name=agent`、`--prefix=C:\envs\agent`、`--cwd=H:\work` 后的 Python `-c`，并把实际源码交给两个权限门禁的既有 `sourceRisk`。移除该证据后，当前 grammar 在裸等号选项处断裂：`conda run --name=agent python -c "import os; os.remove('example.tmp')"` 得到不完整命令，风险降为 general。只把选项在分析表示中写为 `"--name=agent"`，同一 grammar 得到完整 argv，既有规则返回 cautious。prefix/cwd 精确对照结果相同。

已运行 package 内只读分类断言：以上 command 调用 `PermissionPrecheck.evaluate` 后 `assert.equal(result.level, "cautious")`，实际 general，exit1。危险源码仅作为字符串，未执行。此项是撤掉执行改写造成的已有覆盖回退，修复归属 `ShellParse` 的分析表示及既有 conda/Python 参数识别，不新增动作规则、风险等级或审批条件。

## 5. Current Behavior

`模型 JSON -> SDK 解码 -> 配置 shell -> 权限分析 -> 部分 Python 内容改写 -> 原文/改写命令执行 -> 既有 runner`。

当前问题分别属于：模型引用指导、normalizer 的额外语义、配置提示、权限语法事实、direct-shell 参数传递、PowerShell 终态。修复按 owner 落位，不建立第二套执行方式。

## 6. Supported Input Domain and Reachability

| 输入 | 实际入口/owner | Class |
| --- | --- | --- |
| JSON `\n/\\n/\\/\"` | SDK 已解码字符串，ShellTool 原文执行 | contracted |
| 本层/下一层/字面 `$`、引号、路径与正则 | 公开 command 的原生引用语法 | observed |
| 单引号 payload、here-string、heredoc | shell 原生参数或管道 | observed |
| bare `-`、versioned Python、py、静态 conda run | 语法事实与解释器参数角色 | observed |
| stdin 数据、argv[0]、文件入口 | 程序既有接口，由调用者明确选择 | reachable |
| SSH/WSL 嵌套解释 | 本地引用及目标程序的明确调用参数 | observed |
| 非默认 cfg.shell、用户 direct shell | SystemPrompt、Shell.args、SessionPrompt.shell | observed |

## 7. Required Invariants

| ID | 不变量 |
| --- | --- |
| I1 | 单 `bash` 和原 schema；当前配置及查找政策保持。 |
| I2 | 解码后的用户 command 正文逐字符保留，无内容猜测或自动重试。 |
| I3 | 系统、工具、权限和执行采用同一配置解析规则。 |
| I4 | `$`、反斜杠、引号、JSON/脚本/输出换行由独立语义 oracle 验证。 |
| I5 | 单引号表示“本层字面量”；后续解释取决于目标程序，here-string 仅是字面值构造。 |
| I6 | 原有源码风险在两个权限 gate 保留；stdin 的代码与数据角色分开。 |
| I7 | 最终成功 0；失败保留本脚本已有 native 非零码，否则 1；显式 exit 保留原码。 |
| I8 | 提示合计及各渲染 profile 净增 <=9 行，UTF-8 文本净增 <=600 bytes。 |
| I9 | 模型成功率有 baseline/candidate 实证，exit 0 同时检查预期值。 |
| I10 | 输出、超时、取消、排空、压缩、worktree 与历史兼容由既有 owner 承担。 |
| I11 | 正式评测先证明同一最小环境能调用各目标程序；诊断请求计入总预算，环境故障与命令语义失败分别记录。 |

## 8. First Divergence and Root Cause

| 失真点 | Owner | 修复 |
| --- | --- | --- |
| JSON 之后又折半反斜杠并改写 Python 引用 | ShellTool | 删除 normalization，执行原 command |
| 系统提示忽略 cfg.shell | SystemPrompt | 使用同一 Config 服务结果 |
| 模型混用宿主/下游转义 | ShellPrompt | 简短的单引号优先、明确当前层插值规则 |
| bare `-` / literal pipeline 未成为正确权限事实 | ShellParse | 修复分析表示及 stdin 绑定 |
| direct shell 在 eval 前提前展开正文 | Shell.args | 独立位置参数传递 |
| block 外残留 LASTEXITCODE 误判 | psEncoded | 同一 block 内观察最终状态并保留 native code |
| 评测最小环境遗漏 Windows 程序后缀查找变量 | eval-shell-intent | 补齐必要环境并通过真实 Python/Node/子 shell 预检后冻结 |

已运行的失败反馈环（真实 Bash Tool，纯计算）：

```powershell
python -B -c "x=[ord(c) for c in r'\""']; print(x); assert x == [92,34]"
```

当前 `[34,34]`、AssertionError、exit 1；`& { <同一命令> }` 原生路径 `[92,34]`、exit 0。另在 package 内调用 `PermissionPrecheck.evaluate` 检查 `@'\nimport os; os.remove('example.tmp')\n'@ | python -`，当前 general，预期 cautious；仅分类字符串。实施须保留这两项有效红测。

## 9. Responsibility and Seam

SDK 拥有 JSON；ShellTool 拥有原文执行；ShellPrompt/SystemPrompt 拥有正确指导；ShellParse 拥有语法事实；PermissionPrecheck 拥有风险；Shell.args 拥有 direct-shell 参数；既有 runner/output-notice 拥有生命周期与结果；离线评测只验证模型质量。

## 10. Single Primary-Path Design

### 10.1 执行与配置

`已解码 command -> Shell.acceptable(cfg.shell) -> 原文权限分析 -> cmd(shell, command, cwd, env) -> 既有 runner`。

删除 normalizer、专属常量/helper、executeCommand/adaptation、规范化 audit 与新 commandAdaptation 写入。历史数据库字段保留。EncodedCommand、UTF-8 环境和其它 shell 的原生 argv 保留。

SystemPrompt.layer 获取 Config.Service，getEnvExtras 使用 `config.get()` 与 `Shell.acceptable(cfg.shell)`；继续采用现有缓存与查找政策。此项修复配置数据来源，保留原配置支持范围；模型可见文字和组装规则按§1.1冻结。

### 10.2 提示词冻结与语义边界

撤销追加Python/Node示例、压缩其他措辞或继续合并提示的实施安排。仅按§1.1最新授权替换一行单引号说明；字段说明、换行规则及各shell渲染分支保持。提示词净增小于10行等原要求继续适用。

用户原意限定于PowerShell本层展开：单引号内的变量名称与子表达式保持未求值状态，反斜杠按普通字符处理。此前工作区的 `to pass ... as text` 把这一规则扩成后续参数传递承诺，本轮按明确授权删除该措辞并替换为：

```text
- In single-quoted strings, PowerShell leaves $name and $(...) unevaluated; backslash is ordinary. Write '' for a single quote.
```

独立纯打印反馈已在PS5.1.26100.9444、pwsh7.6.6验证：`$s = 'print("hello")'` 的PowerShell变量均含两个码点34；变量 `$HOME` 字面值码点为36,72,79,77,69；普通路径反斜杠保持码点92。实际外部程序参数对照另列为原生行为，展开规则的测试预期只观察PowerShell字符串求值结果。

PowerShell字符串求值、外部程序参数传递分别验证；测试报告说明确定发生的转换及版本条件。解释器输入示例继续限于既有测试/取证，加入模型可见提示需要逐次授权。

提示预算继续如实统计：所有模型可见文本及各profile净增<=9行、<=600 UTF-8 bytes。按一次调用实际渲染的工具说明、字段说明、系统指令及该次终态notice计量；三种互斥终态各自验证，并额外列出全部变体相加的诊断数字。重新计算已授权单行修正后的全量结果，§23.4保留先前实测。当前render基线仍为pwsh 109行/8547 bytes、powershell 109/8421、bash 100/7754、cmd 106/7713（输出限制1000行/16384 bytes）。

### 10.3 嵌入命令和程序源码

先选正确的单引号引用；复杂文本使用字面块。here-string 可以作为参数值或管道数据，它自身不改变 native argv 规则。PowerShell 7 的 `python -c 'print("$HOME")'` 正常；PowerShell 5.1 的 Legacy native binder 会消耗内嵌双引号，这项实测差异必须继续保留在测试中。

需要通过 stdin 执行的临时代码可明确写成：

```powershell
@'
print(r'C:\Temp\x', '$HOME')
'@ | python -
```

该例子是测试/文档材料，不是新增 production prompt 段落。Bash 使用 quoted heredoc。保留解释器、flags 与 cwd；`-c`、stdin、文件入口的 argv/traceback 语义由调用者选择，不自动重构。stdin 已承载业务数据时使用正确原生 -c/-e 引用或任务已有脚本接口；文件创建遵循现有授权。

WSL 示例采用显式 `--exec` 来指定目标 Bash；SSH 按目标 shell 规则解释。PowerShell 文本管道附加本机换行，Python/Node 的容忍能力不能推广为 Bash stdin 的保证。测试覆盖合法 argv、LF 脚本等入口，Harness 不自动改 CRLF、追加结束代码或包装执行器。

### 10.4 权限精确承接

- ShellParse 扩展现有 bare `--` 分析表示以支持独立 `-`，区分算术、负数、自减、flags、`--%` 与字符串内容；仅分析表示变化。
- 字面扫描按 PowerShell 原生规则处理单引号的 `''`、双引号的反引号/成对引号、here-string 与注释，删除反斜杠保护 PowerShell 关闭引号的旧假设。
- AST offsets 以实际解析表示为基准；原 command 独立用于审计与执行。
- 从 pipeline 首个字面表达式提取内容，为消费者增加内部 stdin 事实；Bash heredoc 复用输入角色。静态单引号块精确提取，插值表达式保持 dynamic，分析不执行表达式。
- Precheck 仅在解释器消费 stdin 源码时调用 sourceRisk；script.py/-c 的 stdin 仍是数据。补齐 python3.x、py、静态绝对路径、既有 flags 和 conda run 前缀的角色识别。
- conda 的静态 `--name=value`、`--prefix=value`、`--cwd=value` 在已有分析兼容扫描中保留为一个等值引用参数，恢复旧 normalizer 已覆盖的 Python 源码入口；原命令仍逐字符执行。限定在 conda run 的既有静态参数域，动态值、其它程序及其它执行方式沿用原政策，不扩成通用包装器安全加固。
- 外层风险与源码风险取 max，bash/external_directory 两 gate 使用同一原 command 分析；退出 normalization 专属 inline_scripts 生产/消费，保留 sourceRisk 算法。
- 普通数据、动态/opaque 及其它政策保持；推荐的静态入口必须恢复精确风险分类，不能统一降级或升级。
- 当前实现中曾新增的普通动态 stdin general 下限已移除；对应额外断言也已移除。conda/Python 识别只服务已有源码规则在新引用表示下的承接，审查其影响域并移除超出该范围的通用执行器识别扩张。权限测试仅对应本次实际修改路径，保留旧源码风险用例的等价迁移，不新增未改风险模型的细分边界断言。

### 10.5 direct shell 与终态

Shell.args 的 Bash/Zsh 初始化脚本使用 `eval "$2"`；argv 保留 `"opencode", cwd` 并追加原 command。保持 login/rc、aliases 和 cwd；受控 HOME/rc fixture 验证实际参数传递。

PowerShell 保留编码、输出流和 scriptblock，删除 block 外 LASTEXITCODE postlude，在用户命令之后追加固定状态汇聚：

```powershell
& {
    <原 command>
    if ($?) { exit 0 }
    if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    exit 1
} 3>&1 4>&1 5>&1 6>&1
```

保留 native 7/9/42 的既有 metadata/notice 断言。最终成功优先消除残留码误判；纯 cmdlet 失败为 1；`native 7; Write-Error` 保留 7；显式 exit/return 保持控制流。本次进程 prelude 不运行 native 程序，状态来自本次脚本。PS5.1/7 各 12 项纯计算实验已验证，包括恢复、param、Information、throw；实施以独立常量作为回归预期。

既有失败 notice 增加真实 shell 名称，计入提示预算；输出、超时、取消、排空与 worktree 继续复用原 runner。

## 11. Secondary and Replacement Path Inventory

| Path | 分类 | 处置 |
| --- | --- | --- |
| 配置 shell 的 command 执行 | primary contract | 唯一生产执行路径 |
| 原生引用、字面块、-c/文件/管道 | 支持的语言输入域 | 调用者显式表达 |
| Python 猜测改写 | 首次语义失真 | 删除 |
| bare-dash 分析表示、现有 shell 查找/kill 行为 | existing compatibility | 保留并修复归属内行为 |
| 失败 notice shell 属性 | diagnostic | 沿用现有分支，新增诊断决策分支 0 |
| 离线模型评测 | test-only | 显式授权运行 |

新增 alternate success path 0；诊断 decision-surface 增量 0%。自动转译、自动文件、Exec、失败后替代执行均排除。

## 12. Workaround Deletion and Replacement

删除 INLINE_PYTHON_*、normalizer/helper、executeCommand/adaptation、normalization audit、新 adaptation 标签和专属附加证据；用原 command 的参数及 stdin 风险识别承接。此前已合并的 shellGuidance 保留当前状态，后续文字与组装调整适用§1.1；用独立参数替换 eval 字符串嵌入；用 block 内真实状态替换外层残留码汇聚。历史记录保留。

## 13. Forward Traceability

| 要求 | 修改路径 | 行为测试 |
| --- | --- | --- |
| R1 | ShellTool/schema | 原字段/默认值、单 bash 工具 |
| R2/R3 | shell.ts、shell/shell.ts | JSON、码点、各层变量、路径/正则/换行 |
| R4/R5/R8 | ShellPrompt/SystemPrompt及§1.1 | 配置数据一致、提示冻结与原行/字节实测记录；具体文案变更逐项匹配用户授权 |
| R6 | ShellParse/Precheck | 两 gate、literal/data、bare dash、解释器/conda |
| R6 | psEncoded/runner | 精确退出码、cmdlet 失败、输出、超时/取消 |
| R7 | 固定夹具与 opt-in eval | 首次语义正确率、最多一次修正、成本 |
| I11 | eval CLI / ShellTool.execute | 三 shell 中 Python、Node、子 shell 的纯打印预检与固定独立预期 |

## 14. Reverse Traceability

| Concept | 需求与证据 |
| --- | --- |
| SystemPrompt 获取 cfg.shell | R4/R5：直接观察到提示/执行分裂 |
| 已有引用指导的保留 | R2/R4/R8：当前文本冻结；历史措辞问题按用户指定的既有缺陷处理 |
| literal stdin/解释器角色 | R6：真实删除源码当前被判 general |
| bare - / 原生引用分析 | R6：grammar 节点缺失及旧引用假设 |
| 状态汇聚与位置参数 | R2/R6：真实误判与提前展开实验 |
| prompt 预算和模型评测 | R5/R7：用户硬约束及真实成功率目标 |
| 环境预检与诊断批次隔离 | I11：实测 PATHEXT 遗漏使语义评测变成程序查找失败；原纯 shell 打印预检覆盖不到 native 程序查找 |

## 15. File-Level Change Plan

`packages/opencode/` 下的文件：

| 文件 | 操作/责任 |
| --- | --- |
| `src/tool/shell.ts` | 修改：删除Python执行改写、固定终态、保留runner；模型可见文字与组装冻结 |
| `src/tool/shell/prompt.ts` | 仅替换§10.2明确授权的单引号说明，其余内容冻结 |
| `src/session/system.ts` | 修改：读取相同配置 shell |
| `src/shell/shell.ts` | 修改：direct shell 正文位置参数 |
| `src/shell/parse.ts` | 修改：原生引用、bare dash、stdin 事实与 offset |
| `src/permission/precheck.ts` | 修改：程序/数据角色、解释器和包装器、退出旧证据 |
| `src/util/output-notice.ts` | 保留当前已有失败notice实现；新增或改写模型可见内容逐次取得用户同意 |
| `test/tool/shell.test.ts` | 修改：替换适配语义测试，执行/权限/终态矩阵 |
| `test/tool/shell-prompt.test.ts` | 按授权更新单引号说明预期，保留schema及其他文字断言，复核全量预算 |
| `test/tool/__snapshots__/parameters.test.ts.snap` | 冻结当前快照；具体用户批准的字段说明变更才同步对应快照 |
| `test/shell/parse.test.ts` | 新增：公开 analyze 事实 |
| `test/shell/shell.test.ts`、`test/session/prompt.test.ts` | 修改：真实 direct-shell 参数、rc 与用户入口 |
| `test/session/system.test.ts` | 修改：Config 供给、配置 shell 一致 |
| `test/permission/precheck.test.ts` | 修改：literal source/data、两 gate 与旧政策 |
| `test/fixture/shell-intent.ts` | 保留固定任务及独立语义预期，模型可见任务文字冻结 |
| `test/eval-shell-intent.ts` | 显式授权模型评测；原始记录、当前批次与累计预算保持可追溯；以独立同输入基线证据区分新增/继承字符失真 |

实施时在旧 `docs/powershell-inline-python-normalization-plan.md` 增加本计划指针，保留原历史事实。其它第三方、SDK、数据库 schema、agent 默认权限和 CI 保持。额外必要改动先修订本计划。

## 16. TDD Behavior Slices

公共 seams：ShellTool.execute、Shell.args 实际 argv、ShellParse.analyze、PermissionPrecheck.evaluate、SystemPrompt.environment、ShellPrompt.render、SessionPrompt.shell。

| 顺序 | Red -> Green |
| --- | --- |
| 1 | 冻结提示计数、脱敏任务及当前生成基准 |
| 2 | 配置提示分裂 -> 同一 cfg.shell |
| 3 | literal/bare - 风险遗漏 -> 精确语法事实与两 gate 分级 |
| 4 | 合法引用被 normalizer 改写 -> 原文执行；保留明确插值 |
| 5 | 单引号说明越过PowerShell本层 -> 授权的准确展开说明；真实PowerShell字符串码点及其他提示保持回归 |
| 6 | direct shell 提前展开 -> 位置参数保真及初始化回归 |
| 7 | cmdlet 失败 exit 0 -> 精确 native code + 最终状态；lifecycle 回归 |
| 8 | 模型质量未知 -> Gate-Q 对照通过 |
| 9 | 报告将继承失真计作新增 -> 同输入基线证据分类；验证未知为pending、基线正常/当前失真为rework、共同失真单列继承，成功率与失败次数保持 |

逐 slice 红绿推进。真实反斜杠用 String.raw/程序化数量构造并先断言输入；预期来自固定码点、值和语言合同，不复制 normalizer 或 epilogue 算法。

## 17. Chinese Comment Budget

结合已实现的真实评测器和行为测试，预计有效新增/修改 E=1200–1700，C 至少 ceil(E×0.15)，约180–255；删除、纯移动、imports、生成、格式化排除。解释性注释放在引用边界、offset、stdin 角色、参数元数、风险聚合、状态优先级、位置参数及测试意图附近。保留代码的原注释保持；删除逻辑的配套行内注释随代码删除，需要交代原因时最多保留一两行说明。prompt 预算独立计数。

## 18. Verification

### Gate-D：确定性验证

在 `packages/opencode`：

```text
bun test test/shell/parse.test.ts test/permission/precheck.test.ts
bun test test/tool/shell-prompt.test.ts test/session/system.test.ts
bun test test/tool/parameters.test.ts
bun test test/tool/shell.test.ts test/shell/shell.test.ts test/session/prompt.test.ts --timeout 30000
bun typecheck
```

仓库根运行 `git diff --check`。矩阵覆盖 PS5.1、PS7、Git Bash/Bash、POSIX Bash/Zsh direct-shell 初始化及现有 cmd 回归。验收既包含展开后的值，也包含应保留的字面字符、参数边界、执行状态和权限。

WSL 用纯打印命令区分 `--`/`--exec`；SSH 用受控参数接收器与本地目标解释器验证边界，真实网络验证须明确授权。数据库语料只读、仅静态检查；临时产物保留聚合计数，仓库夹具全部脱敏。

### Gate-Q：模型生成质量

- 12 类意图 × PS7/PS5.1/Bash =36 个固定任务：本层/下层/字面 `$`、引号、路径反斜杠、正则、三类换行、Python 多行、Node 模板、stdin 数据、跨解释器、真实成功。
- 当前主要模型 + 一个历史高故障模型，baseline/candidate各36例；每例最多一次修正。有效累计授权上限375，覆盖同一总账全部历史与当前请求。固定模型/版本/sampling/token上限、fixture hash、完整渲染提示和环境。
- baseline 在生产修改前采集，candidate 在修改后采集。评测脚本复用公开 Provider.getModel/getLanguage、SDK streamText 和真实 Tool seam，不进入生产重试链。两个条件使用相同 SDK 调用方式与 sampling；完整保留返回的 toolCalls、text、usage、finishReason，参数验证失败也保留原响应。
- 先生成临时清单，独立审查命令仅操作隔离 fixture 后记录 hash，再执行；环境仅含必要测试变量，真实凭据/业务数据/外部网络排除。修正也经过同一审查。
- 指标：首次语义正确率、最多两次调用成功率、引用错误、exit0但值错误、每成功任务调用数、tokens、墙钟时间。
- 通过标准：总首次正确率及 Python/Node 子集均 >=baseline；各 shell 两次内成功率 >=baseline；引用/解析失败减少至少50%（baseline为0则candidate也为0）；新增静默字符漂移和权限误放行均0；每成功任务平均工具调用数 <=baseline。
- script 参数为 `--phase generate|execute-reviewed|report --condition baseline|candidate --model provider/model --artifacts <approved-temp-dir> --max-provider-calls 72`。每模型每条件最多72次，累计预算落盘，重启保持计数。
- 模型选择和调用授权是运行前提。未运行或未过阈值时 Gate-Q 保持 pending/rework；确定性绿测不代替生成质量结果。

评测结果及失败计数原样保留，低成功率本身不授予提示改写权限。区分本次逻辑回归、冻结提示的既有缺陷、外部程序既有行为及模型生成失败，仅用于确定修改归属。提示缺陷按用户要求保留，其真实失败继续计入原始统计。修改范围合规只证明授权边界，Gate-Q仍是行为放行门禁；Gate-Q为rework时继续完成授权范围内的修复与验证，全部适用门禁通过后才标记verified-implementation。

“新增静默字符漂移”以同一command在基线与当前实现的对照判定。`harnessCharacterDrift`继续记录样本实际字符损失；为true的candidate另由独立审核填写 `baselineCharacterDrift` 与非空 `baselineEvidence`，指向相同输入在基线的执行证据或已核实完全相同的启动路径、环境与基线commit。基线同样失真列为继承缺陷，基线保持字符而当前失真列为新增回归；基线对照未知保持pending。已有样本、失败分类、精确成功率、请求成本及权限误放行门禁保持，继承缺陷仍计入引用错误和失败统计。修正归属仅在评测报告，其他工具及启动行为保持原样。

当前具体证据是 `R8-candidate-kimi-k3-bash-06-1`：两个反斜杠在Git Bash入口变成一个；`cmd`的Bash启动参数、CrossSpawnSpawner及环境与基线commit `d8e5e44353d8659094995c2ec999ae01543e9222`相同。原报告把所有candidate字符损失均计入名为newSilentCharacterDrift的项，无法区分本次回归和用户要求保留的既有行为。独立同输入归因修正此报告边界，零新增要求继续保持。

R5原采集细则（历史预算，当前有效上限见本节）：

- `--check-fixtures` 通过真实 ShellTool，在与正式执行完全相同的最小环境中分别运行 PS7/PS5.1/Bash、Python、Node 和子 shell 的纯打印探针，检查独立常量与实际程序版本。Windows 白名单包括必要 PATH 目录、SystemRoot、ComSpec、PATHEXT、临时目录和测试 HOME；保留已有 Python UTF-8 设置。用户 shell.env 插件在评测层隔离，生产插件行为保持。
- 系统输入复用真实 `SystemPrompt.environment`，工具 description/schema 来自真实 ShellTool.init；固定隔离实例、无 git 业务数据的会话和评测日期。模型身份按各模型保留，prompt 冻结键包含模型、任务、条件；同一模型跨条件只允许批准的提示变化。环境段提供配置修复前后的真实行为，评测器不手写第二份 shell 规则。
- 12类任务继续各覆盖三个 shell；任务只陈述操作和输出，明确 Python/Node/子 shell 等必要机制，审查排除仅回显目标答案的规避。输出比较仅统一平台换行并允许打印接口的单个终止换行，保留其它字符。第二次生成收到首个实际工具输出；生成失败反馈明确标为生成失败。
- 正式数据使用 R5 批次和独立临时产物目录；原51次请求原样保留为 R4 diagnostic。已有本地评测账本按批次区分记录，全局288预算统计全部批次，新正式模型/条件各至多72次。剩余237次可覆盖144次正式首轮及至多93次修正，实际触及预算即停止并保留 pending，继续运行需用户授权。账本属于临时评测产物，应用数据库和迁移保持原样。
- 请求前持久预留预算，响应与工具结果逐条落盘；provider失败记录独立类别和实际可得 usage，缺失成本显式标为 unknown。每例最多两次请求，取消或超时同样计费，不自动换 provider 或补造命令。基础设施失败单列，Gate-Q 完整结果需同时展示其影响，完整提示与响应证据缺失时保持 pending。
- 已记录的 provider 超时以原请求、终态错误和调用次数构成失败证据，未返回的工具正文与 usage 明确记为 unknown，不伪造成功或排除失败任务。效率对照统一报告每成功任务的模型请求次数，包含生成失败和拒绝项；另外分列返回的 toolcall 数与实际执行次数，避免生成失败被计作零成本。完整响应缺失且无终态错误记录的样本继续 pending。
- 审查绑定完整参数和生成证据 hash；拒绝项作为失败记录，不执行。执行前核对记录哈希、模型参数、实际 shell 和环境；已执行结果保持，重启处理尚未执行项。最终报告包含各模型/各shell、Python/Node子集、首次/两次成功、解析失败、exit0值错误、调用/token/耗时与未知成本，逐项检验原阈值。
- 引用错误与字符漂移由脱敏 command/result 的独立评估记录支撑，记录绑定生成参数与结果 hash；评测器读取这份记录形成分类统计，未知分类继续 pending。此评估仅解释评测结果，不进入生产权限逻辑、不添加审批规则或未改权限代码的测试。

## 19. Diff Budget

7 个 production 文件修改，production 净约 -160 至 +80 行；4 个测试/评测文件新增、5 个既有测试修改，测试/评测净约 +900 至 +1500 行。预算调整来自已实现的真实环境/SDK评测、持久计费和分类报告，不增加生产范围。新增 production 文件/Tool/schema字段/依赖/生成/应用迁移均0。提示目标净增<=0、硬上限9。预算偏离须说明并修订，不牺牲确认行为。

## 20. Real Risks and Open Decisions

| 风险 | 验收处理 |
| --- | --- |
| 771 条旧成功调用原样重放有语法回退 | 既有提示条件下的历史静态检查与Gate-Q；提示改动按§1.1逐次授权 |
| 单引号只保护本层 | 子程序/WSL 目标层对照；避免用单独 HOME 输出作证据 |
| here-string 值仍需选择参数/stdin接口，PS5.1 有 Legacy binder | 实际进程测试，保持显式输入角色；不自动转写 |
| stdin/-c/file 的 argv/traceback 差异与 delimiter 碰撞 | 固定边界夹具，模型用合法原生接口，Harness 不模拟模式 |
| CRLF 对 Bash stdin 的影响 | 明确的 LF/合法 argv 回归，保留目标程序原生语义 |
| bare-dash 分析污染字符或 offset | 原文执行、字面块、注释、算术交叉回归 |
| 状态修改丢 native 码 | 保留7/9/42旧断言，补恢复与cmdlet失败矩阵 |
| 模型评测随机性/成本 | 固定条件、完整逐例记录、硬预算和上线门槛 |
| 评测器自身环境故障污染基线 | R4诊断批次保留并计费；R5先通过真实 native 程序预检，再采正式基线 |

实施评测前由用户指定两个模型及调用授权。其余路线、接口、预算与通过标准已确定。

Rejected speculation：新增Exec或全局切shell并非本任务路线；JSON标准解码与执行层额外转义分别归属；历史compile成功与业务成功分别计量；文件工具保持既有权限，不扩展为隐式执行器。

## 21. Audit Contract

独立auditor对每个revision按完整原始要求及§1.1最新授权边界检查当前代码、生产者/消费者、权限、TDD与质量门禁。原6轮记录保留，用户后续另授权最多3轮方案审计。设计修订增加revision并清空approval，实际实现另行完整审计。

提示词审计处理遵循用户原文：

- 建议新增、删除、替换或重组提示词以修复既有问题，属于本轮无效的修改要求；事实性发现保留，分类为用户授权保留的既有提示缺陷。
- 每项记录具体文字/位置、可观察影响、用户授权引用和保留理由。用户已明确要求修正的§10.2单引号措辞按授权修复；其他冻结提示的既有问题单列保留。保留缺陷的接受不扩展为新文案的实施授权。
- 本次逻辑修改新增的字符改写、错误执行、权限回退或结果失真仍按行为证据处理。若发现未经用户同意的新提示修改，首先记录授权违规，生产文字的具体修正或回撤仍须用户明确同意。
- 新环境/新命令中发现的额外问题先核对范围；已要求原样保留的外部工具与启动行为作为现状记录。审计员的建议本身不扩展修改范围。
- 分歧复议提供原文授权、具体文件与行为证据，由同一auditor复核分类。审计原始结论原样存档，用户接受的缺陷单列；实施和统计结果保持可追溯。

## 22. Plan Audit Record

| Round | Revision | Full scope | Blocking | Non-blocking | Verdict | Reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 PowerShell 终态修复丢弃既有 native 退出码 | N-01 历史统计尚未独立复核 | BLOCK | ses_f47318a58ffeEfZFyEfUP8H5fK |
| 2 | R2 | yes | No blocking findings. | N-01 历史统计尚未独立复核，继续保留 | APPROVE | ses_f47318a58ffeEfZFyEfUP8H5fK |
| 3 | R3 | yes | No blocking findings. | N-01 历史统计及探针尚未独立复核，继续保留 | APPROVE | ses_f47318a58ffeEfZFyEfUP8H5fK |
| 4 | R4 | yes | No blocking findings. | N-01 历史统计及探针尚未独立复核，继续保留 | APPROVE | ses_f47318a58ffeEfZFyEfUP8H5fK |
| 5 | R5 | yes | No blocking findings. | N-01 部分实验与统计仍未独立复现，继续保留 | APPROVE | ses_f47318a58ffeEfZFyEfUP8H5fK |
| 6 | R6 | yes | No blocking findings. | N-01 部分统计和实验仍未独立复现，继续保留 | APPROVE | ses_f47318a58ffeEfZFyEfUP8H5fK |
| 7 | R7 | yes | B-02 Gate-Q未通过时，新增“授权范围验收”缺少明确的放行约束 | N-01 部分实验和汇总仍未独立复现；N-02 评测续接合同需要保持一致 | BLOCK | ses_f47318a58ffeEfZFyEfUP8H5fK |
| 8 | R8 | yes | No blocking findings. | N-01 部分实验和汇总仍未独立复现；N-02 评测续接合同仍需保持一致 | APPROVE | ses_f47318a58ffeEfZFyEfUP8H5fK |
| 9 | R9 | yes | No blocking findings. | N-01 部分实验和汇总仍未独立复现；N-02 评测续接记录仍需统一 | APPROVE | ses_f47318a58ffeEfZFyEfUP8H5fK |

R9原始结论：**APPROVE — 仅批准 `docs/plans/shell-native-script-fidelity-and-model-success.md` 的 R9，full-scope。**

R9独立结论：No blocking findings.

**N-01 — 部分实验和汇总仍未独立复现，继续保留。** 本轮直接读取了 R8 candidate 的生成命令和失败结果，以及当前启动路径；没有重新运行同输入基线实验、全部模型评测或账本汇总。因此，不能把计划记载的“基线同样失真”直接当成本审核员已完成的归因。

**N-02 — 评测续接记录仍需统一。** 当前评测器已采用 `baselineRevision = "R5"`、`revision = "R8"` 和累计上限 `375`，原先的代码配置差异已消除；计划 §18 仍保留 288 上限及旧剩余次数。历史数字可以保留，但当前执行合同应明确指向有效批次和累计上限，避免后续误读。

R8原始结论：**APPROVE — 仅批准 `docs/plans/shell-native-script-fidelity-and-model-success.md` 的 R8，full-scope。**

R8独立结论：No blocking findings.

**N-01 — 部分实验和汇总仍未独立复现，继续保留。** 本轮核对完整 R8、当前仓库状态及此前直接读取的源码和证据，没有重新运行测试、模型对照、传输探针或账本汇总。

**N-02 — 评测续接合同仍需保持一致。** §18 保留旧上限 288，§23.5 记录后续上限 375；当前评测器仍使用 R5 批次和 288 上限。正式续测前需要按有效授权同步累计预算与批次引用，保持旧 candidate 不被覆盖。现状没有放宽运行上限，本项不阻止计划批准。

R7原始放行结论：**BLOCK — 当前 R7 尚不能获得清洁计划批准。**

B-02原始最小修正方向：明确“授权范围验收”只说明修改合规性，不能替代Gate-Q或授权verified-implementation。此意见不授权任何提示或外部程序行为修改。§18据此保留Gate-Q完整放行要求。

R2 原始结论：**APPROVE — 仅批准 `docs/plans/shell-native-script-fidelity-and-model-success.md` 的 R2，full-scope。**

R3 原始结论：**APPROVE — 仅批准 `docs/plans/shell-native-script-fidelity-and-model-success.md` 的 R3，full-scope。**

R4 原始结论：**APPROVE — 仅批准 `docs/plans/shell-native-script-fidelity-and-model-success.md` 的 R4，full-scope。**

R4 独立结论：No blocking findings.

**N-01 — 历史统计及探针尚未独立复核，继续保留。** §4.1 的历史统计、新增 WSL 对照和 §10.5 的 PowerShell 状态矩阵，本轮未由审核员重新执行。它们属于计划记载，实施阶段仍需提供可追溯验证证据，不能报告为独立审计复现结果。

完整审计转录由上述 invocation 追溯。Gate-D、Gate-Q、实际 prompt 预算、实际 E/C 和完整独立实现审计仍是交付条件。

R5 原始结论：**APPROVE — 仅批准 `docs/plans/shell-native-script-fidelity-and-model-success.md` 的 R5，full-scope。**

R5 独立结论：No blocking findings.

**N-01 — 部分实验与统计仍未独立复现，继续保留。** 历史数据库统计、WSL 对照、PowerShell 终态矩阵、51 次请求总数及 PATHEXT 对照实验，本轮未重新执行。

审核员原文：本轮审查对象是当前 canonical plan **R5**，范围覆盖完整原始要求、全部生产修复、测试与评测设计。相关生产源码及既有回归测试仍无工作区差异；新增评测脚本和夹具已直接读取。本结论是计划批准，不是实现验收。

## 23. Implementation Evidence

R6 原始结论：**APPROVE — 仅批准 `docs/plans/shell-native-script-fidelity-and-model-success.md` 的 R6，full-scope。**

R6 独立结论：No blocking findings.

R6 伴生快照复核原文：**允许作为 R6 的伴生快照修正记录并实施；无需新的设计授权。** 同一 auditor invocation `ses_f47318a58ffeEfZFyEfUP8H5fK` 将 §15 漏列的既有快照消费者判为 Non-blocking 追溯记录补全；仅更新 `bash.properties.command.description`，保持原断言与其他 schema 内容。

**N-01 — 部分统计和实验仍未独立复现，继续保留。** 本轮未重新执行历史统计、conda grammar 分类探针、跨 PowerShell 状态矩阵或模型评测；§23 的通过数、基线成功率和调用账本总数仍属于待核验的实施证据。

审核员原文：**当前实现仍需按 R6 收敛。** 直接读取的源码显示，conda 仍加入了共享 `directStart`，Python 版本归一化仍位于通用命令名函数。R6 §10.4 已明确要求检查并移除超出源码承接范围的识别扩张。因此，计划批准不能解释为这些现有改动已获实现批准。

用户已授权完整实施，以及 `gpt-6-astra` / `kimi-k3` 的 baseline/candidate 评测，累计最多288次 provider 调用。R5正式基线已在生产修改前完成采集：GPT首轮29/36、两次内36/36，共43请求；Kimi首轮24/36、两次内35/36，共48请求，包含2次provider超时。加上R4诊断51请求，总计142，剩余146。R5正式产物位于 `D:\Temp\opencode\shell-intent-gate-q-r5`，fixture hash为 `89b7504deeab7e719c29e196c73d3aab00ac13a1148d49b2dd0692ae0c153deb`。R6沿用该批次，模型、sampling、任务、实际环境和日期保持冻结。

已实现：SystemPrompt配置一致、Shell.args位置参数、原生命令执行移除normalizer、权限原文/source角色、PowerShell终态及分shell提示。Python码点红测复现adapter改写，移除后PS7原生输出 `[92,34]`；PS5.1同文原生binder输出 `[34]`，按真实引擎语义建立版本预期。两gate测试的tmpdir返回值已修正，normalizer专属测试已替换为原生引用与源码输入行为测试。conda补偿限定于PowerShell的已有Python源码入口；Bash普通命令分类沿用既有路径。

已有生成/执行证据：`D:\Temp\opencode\shell-intent-gate-q-r4`；账本 `D:\Temp\opencode\shell-intent-gate-q-r4-ledger.sqlite`。R4诊断样本审查任务 `ses_f45b9444dffeykBrTm2560ruyS`，33份生成记录、32份批准、1份拒绝；实际执行结果与审查hash不匹配的pending记录全部保留。此为命令安全/任务意图审查，独立实现审计仍待完成。

### 23.1 2026-09-20 完整验证结果

以下命令工作目录均为 `packages/opencode`：

| 命令 | 结果 |
| --- | --- |
| `bun test test/tool/shell.test.ts --timeout 30000` | 204 pass，688 assertions |
| `bun test test/shell/parse.test.ts test/permission/precheck.test.ts test/tool/shell-prompt.test.ts test/session/system.test.ts test/tool/parameters.test.ts` | 257 pass，16 snapshots，1466 assertions |
| `bun test test/session/prompt.test.ts -t "auto permission reviewer retries transient provider failures before recording the decision" --timeout 30000` | 1 pass，3 assertions，8.62秒；模拟503后正常恢复 |
| `bun test test/session/prompt.test.ts --timeout 30000 --dots` | 105 pass，14既有skip，472 assertions，542.17秒；诊断任务 `ses_f44c14c69ffebtTL3zMFZBx6np` 实跑 |
| `bun typecheck` | exit 0 |

先前整文件测试在外层360秒截止，完整运行542.17秒通过；保留原测试断言与每测试超时。Zsh本机缺失，相关执行项继续列为环境未验证。仓库根 `git diff --check` 通过，输出包含checkout的LF/CRLF提示。

### 23.2 Gate-Q 完整结果与失败解释

正式四组生成、独立命令审批、实际执行、一次修正及独立语义评估已完成。报告命令：`bun run test/eval-shell-intent.ts --phase report --artifacts D:\Temp\opencode\shell-intent-gate-q-r5`。最终 `gate: rework`；累计231/288请求，余57，包含R4诊断51。正式baseline91请求，candidate89请求。provider超时及无效调用全部计入失败与成本。

| 模型/条件 | 请求 | 首次正确/36 | 两次内正确/36 | 引用/解析失败 |
| --- | ---: | ---: | ---: | ---: |
| GPT baseline | 43 | 29 | 36 | 7 |
| GPT candidate | 44 | 28 | 34 | 4 |
| Kimi baseline | 48 | 24 | 35 | 2 |
| Kimi candidate | 45 | 27 | 35 | 2 |

合计首次正确53/72→55/72；两次内71/72→69/72；引用失败9→6（目标最多4）；每成功任务请求91/71→89/69。pwsh两次内24/24→24/24；PS5.1为24/24→22/24；Bash为23/24→23/24。Python首次10/12→9/12，Node首次4/6→3/6。权限误放行在这些离线样本中为0。

独立评估：GPT `ses_f44da432effewacp8Veqv591bC`，Kimi `ses_f44da42eeffe1ikxzQV02I1mla`。完整assessment绑定generated/result hash，除assessment外原始证据逐字保持。GPT candidate为success34、quote-parse4、value2、policy1、generation3；Kimi为success35、quote-parse2、value2、generation6。

剩余任务失败：GPT PS5.1 Node模板的嵌入双引号被Legacy binder消费；GPT Bash JSON换行脚本在启动参数传输时损失一个反斜杠；Kimi PS5.1字面引号任务两次均返回无效工具调用。其它首轮失败包括模型遗漏前缀/变量初始化、单行Python违背多行任务要求、子PowerShell输出CLIXML及引用错误。

### 23.3 新确认的 Git Bash 传输边界

`R5-candidate-gpt-6-astra-bash-06-2` 的原command包含两个反斜杠；Bash入口 `$BASH_EXECUTION_STRING` 已变为一个。独立诊断分别经Bun、Node、上游Effect及生产CrossSpawnSpawner复现，最后JavaScript spawn参数仍完整。相同参数交给普通Windows Python/Node时字符保持；Git Bash/Cygwin runtime重建argv时发生变化。同一固定脚本经Bash stdin入口运行输出正确。

生产链路：`src/tool/shell.ts` 的 `cmd` → `ChildProcess.make(shell,["-c",command])` → `packages/core/src/cross-spawn-spawner.ts:282` → cross-spawn → Windows进程命令行 → Git Bash runtime。baseline与candidate的此路径一致，所以这是原有传输缺陷在candidate新样本中被检出。报告中的 `newSilentCharacterDrift` 计数1表示candidate观察值；缺陷引入时间为既有baseline路径。

固定纯打印复现（package目录）：

```powershell
bun -e 'const bash="D:/Program Files/Git/bin/bash.exe"; const q=String.fromCharCode(39); const script=`printf "%s" "$BASH_EXECUTION_STRING"; : ${q}A\\\\nB${q}`; const r=Bun.spawnSync([bash,"-c",script],{cwd:"D:/Temp/opencode",stdout:"pipe",stderr:"pipe"}); console.log(JSON.stringify({input:script,output:r.stdout.toString(),equal:script===r.stdout.toString(),exit:r.exitCode}));'
```

实测 `equal:false, exit:0`；相邻码点从 `39,65,92,92,110,66,39` 变为 `32,39,65,92,110,66,39`。用户随后明确要求其他工具与启动行为保持原样，R7据此保留原传输边界；该既有行为作为实测现状记录。冻结的candidate数据保持原样。

### 23.4 提示与改动规模核算

生产7文件，新增247行、删除357行，总604行，满足8文件/1200行上限。prompt计数任务 `ses_f44aab1adffeIx2M0asEFYRsJ7` 使用git基线与当前公开renderer在内存中对照，路径及输出限制固定。

完整description+schema+system指令+三种失败notice变体，净行/bytes：win32 pwsh -4/-151、powershell -5/+39、cmd -5/-61、Bash -2/+23、Zsh -2/+18；linux pwsh +3/+277、powershell +4/+606、cmd +2/+276、Bash 0/+68、Zsh 0/+63。所有单次结果profile均通过；合计变体口径下linux/powershell超600字节上限6字节。system环境选择值单列为运行环境差异，匹配shell时新增指令为0。

注释核算任务 `ses_f44a5ceb6ffe5pnnkTc54bcBie`：E=1303、合格C=187、要求196，覆盖14.35%。机械计数E=1311/C候选201；进一步排除8行纯移动/格式片段及14行重复、移除历史或解释不准确的注释。删除576行、imports45、空行61、generated snapshot均排除；评测器633有效代码行计入。此为实施核算，独立实现审计仍待进行。后续应结合实际代码修订完善邻近机制说明。

### 23.5 当前开放决定

R5旧candidate结果保持rework；当前评测与实施结果见§23.6。其他工具及启动行为保持现状，提示仅作用户明确要求的单引号说明修正。当前按批准设计提交独立实现审计，commit/push均0。

后续授权：用户在确认“增加最多3轮方案审计，并将累计请求上限从288提高到375（增加87次）”的问题中选择 **“授权审计与复测”**。新增审计额度3轮，当前累计请求231，后续可用144；既有结果保持，新candidate独立标记。此次研究新增provider请求0。

传输设计进一步研究：Git Bash runtime的 `build_argv → quoted → globify` 受已有glob/noglob选项影响。目标参数码点 `[65,92,92,92,32,66]`，整体单引号、相邻引用拼接、反斜杠放置于引用外等形式在默认glob模式剩两个反斜杠、noglob模式保留三个。固定纯打印语料枚举1672种引用片段划分同样检出该差异。按runtime环境分别编码能够通过869参数语料，但引入用户已排除的环境分支式转义，作为淘汰研究路径记录。用户随后要求启动行为保持现状，该扩展修复路线退出R7实施范围；当前生产文件保持。

### 23.6 当前实施证据

单引号说明已替换为§10.2授权原文。对应测试先运行得到 `0 pass / 1 fail`，生产仅替换该行后，`bun test test/tool/shell-prompt.test.ts test/tool/parameters.test.ts` 得到91 pass、16 snapshots、608 assertions；其他提示、schema和快照保持。

所有下列命令在 `packages/opencode` 执行：

| 验证 | 结果 |
| --- | --- |
| `bun test test/shell/parse.test.ts test/permission/precheck.test.ts test/tool/shell-prompt.test.ts test/session/system.test.ts test/tool/parameters.test.ts` | 257 pass，16 snapshots，1466 assertions |
| `bun test test/tool/shell.test.ts test/shell/shell.test.ts --timeout 30000` | 215 pass，1 skip，713 assertions；skip为本机Zsh缺失 |
| `bun test test/session/prompt.test.ts --timeout 30000 --dots` | 105 pass，14既有skip，472 assertions，582.40秒；保留原每测试时限 |
| `bun typecheck` | exit 0 |
| 仓库根 `git diff --check` | exit 0，包含LF/CRLF checkout提示 |

一次整文件会话测试在外层650秒时限终止；随后以充足外层时限完整运行通过，测试本身的超时、断言和跳过项保持。测试覆盖终态、输出排空、取消、超时、worktree与两权限gate，旧normalizer专属行为已移除。

评测实际使用原R5基线与R8候选数据；canonical revision与数据批次分别标识设计和已冻结采样。累计313/375请求，余62；当前candidate共82请求。原51诊断及旧89候选请求继续计费，原始生成/结果/判断全部保留。报告命令：`bun run test/eval-shell-intent.ts --phase report --artifacts D:\Temp\opencode\shell-intent-gate-q-r5`，最终 `gate: pass`。

| 模型/条件 | 请求 | 首次成功 | 两次内成功 | 引用错误 |
| --- | ---: | ---: | ---: | ---: |
| GPT baseline | 43 | 29/36 | 36/36 | 7 |
| GPT candidate | 38 | 34/36 | 36/36 | 0 |
| Kimi baseline | 48 | 24/36 | 35/36 | 2 |
| Kimi candidate | 44 | 28/36 | 36/36 | 3 |

合计首次53/72→62/72，两次内71/72→72/72，引用错误9→3，每成功任务请求91/71→82/72。Python首次10/12→11/12，Node首次4/6→5/6；三个shell两次内均24/24。原始分组诊断继续展示pwsh首轮与成本等变化，正式门禁沿用§18列出的总量/子集/两次指标。provider超时6次仍按失败计费。

独立语义评估：GPT `ses_f44da432effewacp8Veqv591bC`，Kimi `ses_f44da42eeffe1ikxzQV02I1mla`。权限误放行0；candidate实际字符失真1，独立同输入证据确认继承1、新增0。`R8-candidate-kimi-k3-bash-06-1` 的exit1、quote-parse及harnessCharacterDrift:true全部保留。

同输入归因核实了基线commit下完整cmd、shellEnv、CrossSpawnSpawner、cross-spawn及锁定依赖，并使用原冻结环境和实际共享启动链：193字符的正文在两次入口均为191字符，唯一差异是相同两处 `[92,92,110]→[92,110]`；两次错误输出逐字一致。`baselineEvidence`记录证据，原始文件保持。通过公开报告入口隔离文件输入的三态测试：未知→pending、基线正常/当前失真→rework、基线同样失真→pass；三次的44请求、36成功、3引用错误保持。隔离测试的报告写入被替代为空操作，实际assessment保持独立审核结果。

完整prompt实测按真实单次调用profile：win32 pwsh -4行/-162 bytes、powershell -5/+16、cmd -5/-85、Bash -2/-3、Zsh -2/-6；linux pwsh +3/+266、powershell +4/+583、cmd +2/+252、Bash 0/+42、Zsh 0/+39。各终态均满足9行/600 bytes。三种互斥notice全部相加的诊断值中linux/powershell为+621 bytes；实际一次结果只返回一种notice。匹配shell的系统指令差异0，实际shell名称变化单列为配置修复数据。

生产7文件，新增247/删除357，总604行；shared spawner、其他工具与启动环境保持。实际E=1320，合格C=201，要求198，比例15.23%。机械E=1349，排除21行动态import与8行纯移动/格式片段；C候选212，排除11行历史移除说明、重复或通用解释。generated snapshot、删除行、空行、其他imports另行排除。评测器650有效代码行与77合格注释计入。代表注释解释位置参数、offset、解释器输入角色、2048含推理token、真实时钟与冻结日期、同输入归因及失败计数；保持原有效行内注释。

完整119项会话测试通过后，工作区 `test/session/prompt.test.ts` 尾部出现并行工作的 `TEMP REPRO` / `REPRO resume after reverting continuation` 追加段。本任务保留该段原样，E/C与改动归属只包括本任务的direct-shell新增用例；随后单独重跑该用例得到1 pass、5 assertions。前述105 pass/14 skip对应追加段出现前的119项整文件结果。

## 24. Implementation Audit Record

| Round | Approved revision | Full scope | Blocking | Verdict | Reference |
| --- | --- | --- | --- | --- | --- |
| 1 | R9 | yes | No blocking findings. | APPROVE | ses_f47318a58ffeEfZFyEfUP8H5fK |

原始放行结论：**APPROVE — 当前任务归属的完整实现 diff，基于批准计划 R9，full-scope。**

独立结论：No blocking findings.

**N-01 — 历史取证仍有复现限制。** 历史数据库全量统计未重跑；当前 Gate-Q 的账本、生成/结果摘要绑定、分类和核心指标已独立复核，不再仅依赖 builder 汇总。

**N-02 — 历史预算文字仍有歧义。** 计划保留早期 288 次上限记录，实际评测器执行当前 375 次累计上限。本轮核实总账为 313 次，没有超额。

**N-03 — Zsh 实际执行未验证。** 本机缺少 Zsh，对应用例跳过。Bash 初始化、direct-shell 参数传递和 Session 入口回归均已执行通过。

审计员独立运行：解析/权限/提示/系统/参数257 pass、16 snapshots；Shell执行/初始化215 pass、1 skip；Session105 pass、14既有skip，已区分无关并行复现；包内bun typecheck及git diff --check通过。独立normalizer对照中基线输出 `[34,34]`，原生路径输出 `[92,34]`，确认原始缺陷的反馈信号。

审计员独立复核Gate-Q：首次53/72→62/72，两次内71/72→72/72，引用错误9→3，Python首次10/12→11/12，Node首次4/6→5/6，每成功任务请求91/71→82/72；三个shell两次内均24/24。新增字符漂移与评测样本权限误放行均0；同输入归因确认继承失真1项，原失败保留。累计313/375请求。

独立prompt计量最大净增4行、583 bytes。独立代码质量与注释结论：生产7文件、247新增/357删除、共604行；候选有效代码1330行，排除3行明确纯移动后E=1327；候选注释212行，排除6行后合格C=206，要求200，比例15.52%。该独立逐行分类与§23的primary核算分别保留，两者均通过15%门禁。

原始路径结论：生产执行保持唯一主路径；Python猜测改写及专属附加证据已移除；评测修正和基线归因保持在测试入口；其他工具及共享spawner保持。完整实现达到verified-implementation，放行限于本任务归属diff。审计外部模型调用0，源码/快照/原始评测证据修改0；本任务commit/push均0。
