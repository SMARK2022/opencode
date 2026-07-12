# PowerShell inline Python 命令规范化方案

> 状态：已实施并完成历史全量回放；实现复核第 3 轮的 `@args` 阻塞已修复，按三轮上限不再追加第 4 轮复核
>
> 最后更新：2026-07-12
>
> 规范优先级：本文件是该改造的唯一实施依据。后续发现、审计意见和方案调整必须先写回本文件，再提交复审；聊天记录中的旧 stdin/bootstrap 方案均已废弃，不得作为实现依据。

## 1. 目标与硬约束

目标是在 Windows PowerShell 中自适应修复模型生成的简单 `python -c "..."` 命令所遭遇的宿主二次解析问题，让较弱模型的 Bash 风格引号也能稳定到达原 Python 解释器。

硬约束：

1. 不把 Python 源码重定向到 stdin、环境变量、临时文件、base64 loader 或 Python bootstrap。
2. 不替换、探测或预启动 Python；保留模型原命令中的 `python`、`python3` 或 `py`，因此继续使用当前 PATH、venv、conda 环境和 launcher 规则。
3. 保留 Python flags、进程环境、cwd、stdin=ignore、退出码、warning policy、`sys.argv[0]`、`__main__`、traceback 和取消/超时链。
4. 适配失败或命令结构不确定时原样执行，不增加 compatibility error 或新的模型可见拒绝。
5. 不削弱现有 permission deny/ask/auto 边界；规范化后实际会执行的源码只能提高风险判断，不能降低原命令风险。
6. 不扩展到 Node/Bun、POSIX shell、cmd、WSL/SSH、用户直接 `SessionPrompt.shell` 或任意复合 shell 命令。
7. 从本文件到完整实现最多改 6 个文件；最终实际为 6 个文件，生产代码与测试新增 680 行，低于用户给出的 800-1000 行代码上限。
8. 方案阶段曾要求获得 subagent 无阻塞意见后才能实施；该门禁已在第 5 轮方案审计完成。

## 2. 取证结论

### 2.1 数据边界

- 数据库：`C:\Users\Lenovo\.local\share\opencode\opencode.db`
- 访问方式：`bun:sqlite`、`readonly: true`
- 稳定统计上界：`time_created <= 1783764224396`
- 目标 Session：`ses_0b2af299fffeopZmS8wjVqC7Bs`
- 标题：`monsterparty.cn完整安全审计与渗透测试`
- 工作目录：`H:\Hyper`
- 主模型：`zhipuai/glm-5.2`

数据库仍可能被其他 Session 写入，因此后续复核必须沿用上述 cutoff，不能把实时增长后的数字与本文件混算。

### 2.2 目标 Session

- 654 个 bash ToolPart。
- 530 个成功，114 个非零退出。
- 413 个 `python -c`。
- 90 个 `python -c` 非零退出。
- 46 个 `SyntaxError`、15 个 `ParserError`，共 61 个语法类失败。
- 保守 quote-normalization 候选能使其中 59/61 份源码通过离线 `compile()`。
- 剩余两条中，一条需要更激进的 Bash `\\` 解码，另一条是模型自身括号不匹配。为避免改变合法 Python 字符串语义，本方案有意不修复前者。

### 2.3 全库样本

- 截止 cutoff 共 624 个 Session、33,127 个 bash 调用、1,521 个 `python -c`。
- 1,074 条命令满足本方案的保守结构边界。
- 其中 1,069 条使用 `python`，5 条使用 `python3`。
- 尾部形态：481 条无尾部、482 条 `2>&1`、109 条 `Select-Object`、2 条 `Out-String`。
- 859 条包含多行源码，最长源码 10,776 字符。
- 244 条包含 Bash 双引号内有特殊意义的反斜杠序列，3 条包含 `$()`。
- 99 条候选曾产生 `SyntaxError|ParserError`。
- 保守 quote-normalization 后 95/99 份源码可通过离线 `compile()`；更激进的完整 Bash 双引号解码是 96/99。
- 保守算法没有令任何历史 raw-valid 源码变为 syntax-invalid；20 条 raw-valid 样本的 AST 会变化。这里的 raw 是尚未移除 Bash 外层 `\"` 的中间文本，不等同于模型预期的 Bash argv；真正风险是少量调用可能原本有意混用 PowerShell 而非 Bash 的反斜杠语义，必须通过代表性行为测试锁定。
- 完整 Bash 解码会让 147 条样本产生额外变化，且曾观察到 157 条 raw/decoded AST 不同，因此本方案不采用完整 Bash 解码。

离线 `compile()` 仅用于分类历史源码，不代表运行这些安全审计/渗透载荷；数据库里的源码从未被执行。

### 2.4 已复现的根因

当前 ShellTool 会把整条命令正确编码为 UTF-16LE `-EncodedCommand`，但这只保护 OpenCode 到 PowerShell 的外层 transport。PowerShell 仍会再次解释 `python -c "..."` 内部内容：

```text
python -c "print('{\"key\":1}')"
```

当前环境稳定产生：

```text
SyntaxError: unterminated string literal
```

同样，源码字符串中的 `$()` 会在 Python 启动前被 PowerShell 展开。顶层 JSON、Tool schema、数据库持久化和 `-EncodedCommand` 本身均未损坏原始工具参数。

### 2.5 PowerShell native argv 差异

仅把源码改成 PowerShell 单引号在 `pwsh` 7 中可行，但在 Windows PowerShell 5.1 中仍会由 legacy native argument binder 吞掉内部双引号。例如：

```text
python -c 'print("hello")'
```

- PowerShell 7.6.2：输出 `hello`。
- Windows PowerShell 5.1：Python 收到 `print(hello)`，产生 `NameError`。

已验证的稳定方法是：

1. 在当前 PowerShell 子作用域中把 `$PSNativeCommandArgumentPassing` 设为 `Legacy`。PowerShell 5.1 会把它当普通局部变量，PowerShell 7 会显式使用同一 legacy 规则。
2. 对 Python `-c` 的单个 argv 使用 Windows CRT 反向 quoting：双写双引号前的反斜杠，再增加一个保护双引号的反斜杠。
3. 把结果放进 PowerShell 单引号 literal，内部单引号写成 `''`。

该方式已在 PowerShell 7.6.2 和 Windows PowerShell 5.1 上对 Unicode、单双引号、任意反斜杠、`$()`、反引号、百分号、多行和 10K+ 字符参数做 argv code-point 对照。除本方案明确排除的空源码和尾随反斜杠外，Python 收到的源码与目标源码逐字符一致。

## 3. 废弃方案

以下方案不得在实现中恢复：

| 方案 | 废弃原因 |
|---|---|
| stdin + Python bootstrap | 接管 Python 启动路径，改变 traceback/audit hook/compile 行为并增加 stdin 生命周期和 EPIPE 风险；不符合用户最新约束 |
| 临时 `.py` 文件 | 改变 `__file__`、`sys.argv[0]`，引入清理、取消和并发残留问题 |
| 环境变量传源码 | PowerShell 5.1 native argv 仍会吞引号，长源码还会触发 Windows 长度限制 |
| here-string 转 stdin | 仍属于源码转接，并改变 stdin EOF/交互语义 |
| base64/hex + `exec` | 增加 Python wrapper frame、globals/compile/audit 差异，不是纯命令格式化 |
| 预启动 Python 做 `compile()` | 无法可靠确定 conda/venv/launcher/flags，增加一次启动和环境漂移 |
| 完整 Bash 双引号 decoder | 历史上会改变大量合法字符串 AST；比修复观察到的 quote transport 问题更宽 |
| 发现问题后拒绝命令 | 与自适应要求冲突；模糊命令必须保持原样执行 |

## 4. 设计摘要

只在 Windows PowerShell 的模型 ShellTool 路径中，对高置信的单一 inline Python 命令做两步格式化：

1. 从外层双引号源码中移除一层明确的 Bash `\"` 引号转义。
2. 把目标源码编码成 PowerShell 5.1/7 都能无损传给同一个 Python `-c` argv 的单引号参数。

不会生成 Python wrapper，也不会先运行或探测解释器。

示例：

```text
# 模型原始命令，继续用于 ToolPart、权限 UI 和日志
python -c "print('{\"key\":1}')"

# 实际交给现有 psEncoded() 的命令
$PSNativeCommandArgumentPassing = 'Legacy'; python -c 'print(''{\"key\":1}'')'
```

Python 最终收到：

```python
print('{"key":1}')
```

输出、退出码和 runtime traceback 均来自原 Python 进程。

## 5. 代码级算法

### 5.1 内部返回值

在 `packages/opencode/src/tool/shell.ts` 内增加私有函数，不新增模块：

```ts
type InlinePythonNormalization = {
  command: string
  source: string
  audit: string
  tag: "powershell-inline-python-quoting-v1"
}

function normalizePowerShellInlinePython(command: string): InlinePythonNormalization | undefined
```

- `command`：实际交给 `run/cmd/psEncoded` 的格式化命令。
- `source`：Python 最终应收到的可审计源码。
- `audit`：以 `python ... -c <PowerShell-single-quoted-source>` 表示的语义命令，不含 preference-variable 前缀，供 deny-only raw pattern 使用。
- `tag`：只进入结果 metadata，便于数据库度量。

该 helper 只有 ShellTool 一个执行调用方，留在现有文件可减少接口和文件数量。PermissionPrecheck 不重新解析或重建它，只把 `source` 作为附加的“只能提高风险”证据。

### 5.2 前缀扫描

使用约 40-60 行 offset/state scanner，禁止一个贪婪大正则承担完整解析。

允许：

- 可选前导空白。
- 可选 PowerShell call operator `&`。
- bare `python`、`python.exe`、`python3`、`python3.exe`、`py`、`py.exe`，大小写不敏感。
- 明确的无值 flags：`-B -E -I -O -OO -P -q -s -S -u -v`。
- 明确的有值/合并 flags：`-W value`、`-Wvalue`、`-X value`、`-Xvalue`。
- `py` launcher 的 `-3`、`-3.x`、`-32`、`-64`；版本选择器只允许紧随 executable、位于其他 Python flags 之前。scanner 只识别边界，必须原样保留所有 token 文本和顺序。
- 恰好一个 `-c`，后跟 PowerShell 外层双引号源码。

不命中并原样执行：

- 动态 executable、alias/function 定义、显式复杂 executable expression。
- `-i`、`--%`、未知或引号化 flag value。
- 多个解释器调用、命令前缀赋值、`&&`/`||`/`;` 后续命令。
- Python argv、任意 input/output redirection、未建模 pipe。
- 空源码、NUL、源码尾随反斜杠、PowerShell backtick escape。
- 无法完整消费的任意结构。

`conda run` 仅支持完整消费的显式结构：`conda run` 后可带 `-n/--name/-p/--prefix/--cwd` 单值选项、`--dev/--debug-wrapper-scripts/--no-capture-output/--live-stream` 及 `-v/-vv/-vvv`，随后必须是受支持的 Python executable。整个前缀原样保留，因此 conda environment、PATH 和 launcher 从不被 harness 猜测或替换；未知 conda 结构原样 fallback。

### 5.3 源码边界与允许尾部

- opening quote 来自 scanner 确认的 `-c` 参数。
- closing quote 从左向右寻找：跳过奇数反斜杠保护的 Bash `\"`；首个能让剩余字符串完整匹配允许尾部的非转义 `"` 才是边界。若更早 quote 后出现 shell operator、换行或额外 argv，立即原样 fallback，禁止把复合命令吸进 Python source。
- 允许尾部必须按以下顺序完整消费；管道符不可省略，`<uint>` 仅允许 ASCII 非负十进制整数（可有前导零，不允许符号）。尾部 whitespace 仅允许空格和水平制表符，不允许多行空白，避免跨行吸收后续命令：

```text
whitespace [2>&1] [| Select-Object (-First|-Last|-Skip) <uint>] whitespace
whitespace [2>&1] [| Out-String -Stream] whitespace
```

- `Select-Object` 仅允许单一参数形式。历史 109 条 `Select-Object` 尾部已逐一验证：52 条 `-Last 200`、46 条 `-First 210`，其余 11 条也均为单一 `-First` 或 `-Last`，无任何多参数组合（如 `-Skip N -First M`）。多参数组合不命中并原样 fallback，不产生错误。
- Python source 内允许合法的分号语句和 `python`/`py` 文本；复合命令边界由 closing-quote scanner 在抽取 source 前判定，避免把合法 Python 语法误当作 shell operator。
- 源码允许 CRLF/LF 和 10K+ 字符；不按行拆分。
- 找不到唯一完整边界时返回 `undefined`，原命令继续走现有路径。

### 5.4 保守 quote normalization

只处理双引号前的奇数反斜杠 run，移除模型为 Bash 外层 double-quote 添加的一层 escaping：

```ts
function normalizeBashEscapedQuotes(source: string) {
  return source.replace(/\\+"/g, (value) => {
    const count = value.length - 1
    if (count % 2 === 0) return value
    return "\\".repeat((count - 1) / 2) + '"'
  })
}
```

行为：

- `\"` -> `"`
- `\\\"` -> `\"`
- 偶数个反斜杠 + `"` 保持不动，因为它不是明确的 Bash escaped quote。
- 不处理普通 `\\`、`\$`、反引号或 backslash-newline。

这有意放弃一条需要 `\\' -> \'` 才能修复的历史 SQL payload，以换取更小的 Python 字符串语义面。

### 5.5 Windows native argv 编码

对 normalization 后的源码执行 Windows CRT quoting 逆变换：

```ts
function encodeLegacyNativeArgument(source: string) {
  return source.replace(/(\\*)"/g, (_, slashes: string) => slashes + slashes + '\\"')
}

function quotePowerShellLiteral(source: string) {
  return `'${source.replaceAll("'", "''")}'`
}
```

由于 Windows CRT 会把 `2N+1` 个反斜杠加双引号还原为 `N` 个反斜杠加一个 literal 双引号，Python 收到的 argv 与 `source` 一致。

空源码和尾随反斜杠已在结构边界排除，避免 legacy binder 的空 argv 丢失及 closing-quote 歧义。

最终命令：

```ts
const argument = quotePowerShellLiteral(encodeLegacyNativeArgument(source))
const audit = command.slice(0, openingQuote) + argument + suffix
const normalized = `$PSNativeCommandArgumentPassing = 'Legacy'; ${audit}`
```

`$PSNativeCommandArgumentPassing` 的赋值发生在 `psEncoded()` 已有的 `& { ... }` 子作用域中，不写入 Python 环境，也不泄漏到其他工具调用。

### 5.6 长度门限

格式化后先用现有 `psEncoded()` 计算最终 base64 参数长度：

- 若 `psEncoded(normalized).length > 31_500`，返回 `undefined` 并原样执行。
- 历史 1,074 条候选的最大 normalized encoded 长度为 31,024，均在门限内。
- 31,500 为 shell path、固定 flags、空格和 terminating NUL 留出超过 1KB 的 Windows 32,767 字符余量。

长度门限是“放弃优化并原样执行”，不是新的错误。

## 6. ShellTool 接入点

接入顺序必须保持：

1. `tool.execute.before` plugin 和 Tool schema decode 已完成。
2. `ShellTool.execute` 得到最终 `params.command`。
3. 只在 `process.platform === "win32" && Shell.ps(shell)` 时计算 normalization。
4. 仍解析、compatibility-check、collect 原始 `params.command`。
5. 若 normalization 存在：
   - `scan.raw.add(normalization.audit)`，只用于现有 explicit deny 规则。
   - permission metadata 加 `inline_scripts: [normalization.source]`。
6. `external_directory` 和 `bash` 两个 `ctx.ask` 必须从同一个 shared metadata 对象展开，不能只给后发生的 bash 请求加源码证据。
7. `run` 增加私有 `executeCommand` 字段；spawn 使用它，所有 UI、压缩、分类、diagnostic、ToolPart input 和日志仍使用原始 `command`。
8. 最终 result metadata 仅在生效时增加：

```ts
commandAdaptation: "powershell-inline-python-quoting-v1"
```

不持久化第二份完整源码到 Tool result metadata；原始 input 已存在，permission evidence 只在请求期间使用。

## 7. Permission 与安全不变量

### 7.1 单调风险

`packages/opencode/src/permission/precheck.ts` 增加一个小 helper：

```ts
function shellEvidenceRisk(command: string, metadata: Readonly<Record<string, unknown>>) {
  const scripts = Array.isArray(metadata.inline_scripts)
    ? metadata.inline_scripts.filter((item): item is string => typeof item === "string")
    : []
  return scripts.reduce((risk, script) => maxRisk(risk, evaluateShell(script, 0)), evaluateShell(command, 0))
}
```

要求：

- `bashEffect` 对 raw command、canonical pattern command、inline source 取 maxRisk。
- `externalDirectoryEffect` 的 shell 分支也调用同一 helper；dangerous inline source 必须在第一个 external gate 就 deterministic deny。
- 缺失、畸形或 plugin 注入的 `inline_scripts` 不能降低原命令结果；字符串只会作为附加高风险证据，非字符串忽略。
- 不引入 adaptation tag 的 fail-closed 拒绝，因为本方案无需信任 metadata 才能维持安全：原命令始终评估，附加证据只有 max 权限。
- `scan.raw` 中的 `audit` 继续只参与 `Permission.rawDenyPatterns`，不能用于 allow/auto/always。
- `python -c` 仍在 `BANNED_AUTO_ALLOW_PREFIXES`，不得产生宽泛 Always 规则。

### 7.2 保留原始证据

以下位置必须继续保留原始模型命令：

- `state.input.command`
- permission canonical patterns
- permission UI 与 reviewer planned action 的 `command`
- plugin before/after input
- output compression 与 verification classification
- 日志和错误展示

规范化源码是补充证据，不是替换证据。

## 8. 正常、错误、并发与安全路径

### 8.1 正常路径

- 简单 `python -c` 命中，源码经 quote normalization 和 native argv 编码后由同一 Python 执行。
- active venv/conda、PATH、launcher、flags、cwd 和 env 完全沿用原命令。
- `$()`、PowerShell 变量和反引号不再被宿主展开，因为源码位于 single-quoted PowerShell argument 中。
- 现有 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1` 和 output decoder 不变。

### 8.2 错误路径

- 真正 Python `SyntaxError`：由原解释器直接输出，行号、`<string>` 和退出码不增加 wrapper frame。
- Python 不存在、launcher 参数错误、conda/PATH 错误：由原 invocation 直接输出。
- parser 模糊、长度超限、空源码、尾随反斜杠：不优化，原样执行。
- 不做失败后 retry，避免重复执行已有副作用的 runtime error。

### 8.3 取消与并发

- 不改变 stdin、ChildProcess、Fiber、abort、timeout、kill tree 或 output collector。
- 每次调用仍启动独立 PowerShell/Python；唯一 preference variable 位于该 PowerShell 的子作用域。
- 不创建文件、缓存或共享 mutable state，因此无跨调用串流、清理和残留问题。

### 8.4 安全路径

- normalization 可能使以前因 transport 失败而未执行的 Python 真正执行，这是功能目标，因此必须让 source 进入两个 permission gates。
- 原命令与 source 取 maxRisk，任何一方 dangerous 都 deny，任何一方 cautious 都不能降为 general/safe。
- 复合命令不优化，防止错误地把 PowerShell 注入文本吸收到 Python argument 中。

## 9. 文件与行数结果

从本文件开始到完整实现最多涉及以下 6 个文件，不得额外创建 helper、config 或 snapshot 文件：

| 文件 | 结果 | 实际 diff（相对 HEAD） |
|---|---|---:|
| `docs/powershell-inline-python-normalization-plan.md` | 本规范与审计记录 | +约 515 行 |
| `docs/harness-improvement-plan.md` | 旧 P2-5 改为引用本规范 | +1/-1 |
| `packages/opencode/src/tool/shell.ts` | 私有 scanner/formatter、shared evidence、executeCommand | +215/-3 |
| `packages/opencode/src/permission/precheck.ts` | inline source max-risk helper及两个入口复用 | +25/-3 |
| `packages/opencode/test/tool/shell.test.ts` | 两代 PowerShell 真实行为与 fallback 测试 | +358 |
| `packages/opencode/test/permission/precheck.test.ts` | 单调风险、双 gate、畸形附加证据测试 | +82 |

最终结果：

- 生产代码新增 240 行，删除 6 行。
- 行为测试新增 440 行。
- 生产代码与测试合计新增 680 行，未超过用户给出的 800-1000 行代码上限。
- 文档约 516 行，单独承担完整取证、设计和审计记录，不计入代码行数。
- 总文件数严格保持 6，没有新增依赖、配置、迁移、SDK 或生成文件。

明确不改：

- `packages/core/src/cross-spawn-spawner.ts`
- `packages/opencode/src/tool/shell/prompt.ts`
- `packages/opencode/src/shell/shell.ts`
- `packages/opencode/src/permission/index.ts`
- `packages/opencode/src/permission/cache/session-cache.ts`
- `packages/opencode/src/session/prompt.ts`
- 配置 schema、数据库、SDK、依赖和迁移

## 10. TDD 测试计划

### 10.1 Red：ShellTool 回归

先在 `test/tool/shell.test.ts` 增加当前实现会失败的测试：

1. `python -c "print('{\"key\":1}')"` 输出合法 JSON。
2. 源码里的 `$()`、`$env:NAME` 不发生 PowerShell 求值；含 PowerShell backtick 的结构保守 fallback。
3. Python 收到的 Unicode、单双引号、多行、CRLF、反斜杠 argv 与目标逐 code point 一致。
4. 10K+ 源码和历史最大 31,024 encoded 长度可运行。
5. `2>&1`、`Select-Object -First/-Last/-Skip`、`Out-String -Stream` 保持行为。
6. `-B/-E/-I/-S/-u/-W/-X` 与 `py -3` 保持 flags；不可用 launcher 用条件 skip。
7. `sys.executable`、`sys.argv[0]`、`__name__`、`__file__`、`__package__`、`__spec__`、`sys.flags` 与 direct `-c` baseline 一致；baseline 必须由测试进程直接 spawn `[executable, ...flags, "-c", source]`，不能再经过 PowerShell command string。
8. SyntaxWarning 默认、`-W error`、`PYTHONWARNINGS=error` 与 direct baseline 一致且只出现一次。
9. `SystemExit`、runtime exception 和真正 `SyntaxError` 没有额外 bootstrap frame。
10. stdin 仍为 EOF，`input()` 仍抛 EOFError。
11. timeout/abort/并发复用现有测试；通过 metadata 无临时源码路径、traceback 仍为 `<string>`、并发输出不串流和进程正常退出证明无转接残留，禁止用易受并行测试干扰的全局临时目录快照。
12. 空源码、尾随反斜杠、未知 `conda run` 结构、`-i`、Python argv、复合命令、任意 pipe、未知 flags 原样执行且不产生 normalization metadata；支持的 `conda run -n/-p ... python -c` 必须携带 normalization evidence，但测试在 permission gate 中断，不能真实启动 conda。
13. 长度覆盖恰好不超过门限、超过一个 Base64 block、大量引号/反斜杠膨胀和大量非 ASCII；超限时原样执行、无 adaptation metadata，且不报 compatibility error。

现有 `shell.test.ts` 已同时枚举 `pwsh` 与 `powershell`，新测试复用该 fixture；机器缺少某一 shell 时沿用现有条件 skip。

### 10.2 Red：Permission 回归

在 `test/permission/precheck.test.ts` 增加：

1. benign inline source 不降低原始 general/cautious/dangerous。
2. decoded source 中 `shutil.rmtree('/')`、`os.remove('/etc/...')`、subprocess root remove 仍 dangerous。
3. 单文件 remove 仍 cautious。
4. raw command benign、inline source dangerous 时结果 dangerous。
5. raw command dangerous、inline source benign 时仍 dangerous。
6. `inline_scripts` 非数组、混入非字符串或 plugin 额外字符串时不能降低原风险。
7. `external_directory` 与 `bash` 对同一 evidence 得到一致的 dangerous 决策。
8. 无 `inline_scripts` 的所有既有测试保持原结果。
9. 在 ShellTool permission capture 中确认 `normalization.audit -> scan.raw -> metadata.raw_patterns`，并复用现有 Permission 服务 fixture 证明 concrete deny 仍终止；不修改 `permission/index.ts`。

### 10.3 Green 与 Refactor

- 只实现使上述行为通过的最小私有 helper。
- 不为测试导出 parser/formatter；通过真实 ShellTool 行为测试接口。
- helper 超过约 150 行或出现第二调用方前不抽新模块。
- 不修改 CrossSpawnSpawner，因为 stdin 和生命周期没有变化。

## 11. 验证命令

所有命令从 `packages/opencode` 执行，不能在仓库根目录运行 tests：

```text
bun test test/tool/shell.test.ts
bun test test/permission/precheck.test.ts
bun test
bun typecheck
```

额外人工/自动矩阵：

```text
pwsh -NoProfile -NonInteractive ...
powershell -NoProfile -NonInteractive ...
```

完成后：

```text
git diff --stat
git diff --check
git status --short
```

验收必须确认：

- 总文件数不超过 6。
- 总 diff 不超过 1000 行，目标不超过 900；其中生产代码和测试不超过 400 行。
- 没有意外修改 `thirdparty/chatgpt-browser-agent`；该 submodule 在调研开始前已是 dirty 状态。
- 没有配置、依赖、迁移、SDK 或生成文件变化。

## 12. 成功指标与回滚

实施后的数据库度量以 result metadata `commandAdaptation` 为准：

- 目标 Session 类似 workload 的 Python `SyntaxError|ParserError` 显著下降。
- normalization 命令的 transport 类失败率目标下降至少 90%。
- 不增加 PowerShell ParserError、command-line-too-long、权限误放行、timeout 或 orphan process。
- 非 normalization shell 调用的行为和耗时不变。

该功能没有配置开关。若上线后发现语义回归，回滚 `shell.ts` normalization 调用即可恢复原样执行；不涉及数据迁移或持久化格式。

## 13. 已知风险与取舍

| 风险 | 处理 |
|---|---|
| `\"` 修复改变 20 条 raw-valid 历史 AST | raw 是未做 Bash quote 解码的中间文本；剩余风险是有意混用 PowerShell 反斜杠语义的输入。用字符串/JSON/regex/SQL 代表测试锁定，且不做更宽 `\\`/`\$` 解码 |
| 一条历史 payload 仍需完整 Bash `\\` 解码 | 有意不修；宁可保留一次 Python SyntaxError，也不扩大合法字符串改写面 |
| PowerShell Legacy binder 边界复杂 | 强制统一 Legacy 规则，空源码/尾随反斜杠/超长命令原样 fallback，并用两代 shell 做 code-point 对照 |
| normalization 让以前失败的危险 Python 真正执行 | 原命令 + inline source max-risk，同时进入 external_directory 和 bash gate |
| `conda run` 选项面较宽 | 只支持显式白名单并完整消费，原样保留 prefix；未知、动态或引号化结构 fallback，不猜测环境 |
| 旧 P2-5 文档仍主张禁止 python -c | 实施时在允许的第 2 个文档文件中改为引用本规范 |

## 14. Subagent 审计合同

subagent 必须以本文件为输入，并重新检查真实源码，不得只复核聊天摘要。审计范围包括：

1. 数据结论和根因是否支持该改动，而非模型代码本身。
2. Windows PowerShell 5.1 与 PowerShell 7 native argv 算法是否正确。
3. quote-normalization 是否存在更小且同等覆盖的语义面。
4. executable、flags、conda/venv、encoding、cwd、stdin、warning、traceback 是否确实保留。
5. parser 的完整消费和原样 fallback 是否会误吸收复合命令。
6. 原始 command 与 inline source 的 permission 单调风险是否覆盖两个 gate。
7. abort/timeout/output/CLIXML/compression/plugin/persistence 调用链是否未改变。
8. 6 文件、代码与测试 400 行、总 diff 900/1000 行预算是否现实。
9. 测试是否能在不复制实现逻辑的前提下证明 argv 等价。
10. 是否还有会导致安全放行、命令语义改变、解释器环境漂移或新增低效率错误的阻塞问题。

审计输出必须分为：

- 阻塞性意见；若无，原文写“无阻塞性意见”。
- 非阻塞建议。
- 调用链与测试链核对。
- 是否放行。

有任何阻塞意见时，先修改本文件，再按同一完整范围重新审计；不得只在聊天里解释。最多 6 轮，获得明确放行前不得实施。

## 15. 审计记录

| 轮次 | 方案 | 结果 |
|---|---|---|
| 1 | stdin binary framing + Python bootstrap | subagent 提出 globals、warning policy、双 permission gate、畸形 evidence 四项阻塞；随后用户明确否定完整 Python 转接，方案整体废弃 |
| 2 | 修订 stdin bootstrap | 审计任务运行中被用户中止，未形成可采信结论 |
| 3 | 本文件的纯命令/argv 规范化 | subagent：无阻塞性意见，放行；7 项非阻塞澄清已写回规范 |
| 4 | 第 3 轮建议写回后的最终文档一致性确认 | subagent：1 项阻塞——`Select-Object` 多参数未覆盖且未与统计对齐；已验证历史 109 条均为单参数，规范已明确排除多参数并补充 whitespace 定义 |
| 5 | 阻塞解决确认 | subagent：无阻塞性意见，放行；N1 source-content sanity check 已采纳并写入 §5.3 |
| 6 | 全库历史 SyntaxError/ParserError 无执行回放 | 536/536 条经真实 ShellTool 预执行链并在 permission gate 中断；发现并修复 compound quote 吸收、合法 Python 分号误拒与 conda run 缺口。独立复核后又收紧动态 conda/backtick 边界并补齐 attached flags。最终 97 条转译均通过 PowerShell 7/5.1 AST，94 条 Python compile 成功，3 条为原始模型源码错误 |
| 7 | 实现独立复核（3 轮上限） | 第 1-2 轮的动态 conda、flags、backtick 和 operator-in-value 阻塞均已修复；第 3 轮发现 PowerShell `@args` splatting 未拒绝，已在共享 static validator 中修复并补测试。按实现复核三轮上限不再追加第 4 轮，因此该最后一项只有本地主测试证据，没有新的 subagent 放行结论 |
