# precheck 解析器 fail-open 修复方案

## 0. 问题

`splitCommands`（precheck.ts:703）遇到 `>`/`$`/`*`/`&`/换行等"未建模字符"时 `return undefined`，
`evaluateShell`（:428）据此返回 `general` → auto.ts 直接 allow。
导致**整条命令**的 token 分类层（classifyTokens，scp/npm/git 等 cautious 规则所在）被跳过：
`scp X 2>&1`、`scp; echo $HOME` 等本应 cautious 的命令被放行。

## 1. 已阅读的文件/测试/文档（及相关性）

- `src/permission/precheck.ts`：核心。evaluate/evaluateShell/splitCommands/tokenize/evaluateCommand/
  classifyTokens/cautiousRaw/dangerousRaw/rawCommandSegments。是修改对象。
- `src/permission/auto.ts`：precheck.level 路由——dangerous=deny, safe/general=allow, cautious=reviewer。
  确认 general=allow 是 fail-open 的落点。
- `src/permission/index.ts`：Permission.ask → 只对 action=auto 的 pattern 跑 precheck；allow 规则跳过。
  确认 precheck 只在 auto 路径触发。
- `src/tool/shell.ts`：permissionPattern(:194) 把重定向追加进 pattern(:208)；parse(:371) 用 tree-sitter。
  确认 patterns 视图也带 `2>&1`，故 bashEffect 的 maxRisk 两视图都会 bail。
- `test/permission/precheck.test.ts`：**不变量圣经**。逐条确认哪些 general/cautious/dangerous 被锁死。

## 2. 调用点/引用点/旧逻辑确认

- `splitCommands` 仅 `evaluateShell` 调用（本地函数，不导出）。
- `tokenize` 被 `evaluateCommand` 与 `rawWrapperScript` 调用；**tokenize 不在 `>` 上 bail**（只在引号未闭合 bail，:805）。
  → bail 只在 splitCommands。
- `rawCommandSegments`(:890) 是另一个分割器（仅用于包装器载荷提取），按 `;&|\n` 切，不 bail——不改动。
- raw 层（dangerousRaw/cautiousRaw）在 splitCommands **之前**短路；dangerous 命令（rm -rf /、reverse shell、
  凭据外传）无论 split 是否失败都被 raw 捕获。→ 修改 splitCommands 不影响 dangerous 捕获。
- 头部注释(:5)声称 fail-closed，但 :13"解析失败→general" + auto.ts general=allow 实为 fail-open。
  raw 层是对 dangerous 的补偿；cautious-only 命令（scp 等）未被补偿 → 漏。

## 3. 必须保持的既有行为（测试锁定）

| 输入 | 期望 | 依据 |
|---|---|---|
| `echo $HOME` | general | :205（`$` 动态展开）|
| `ls *.ts` | general | :209（glob）|
| `echo hello > out.txt` | general | :227（文件重定向改 FS）|
| `git status & rg TODO src` | general | :69（单 `&`）|
| `git status\nrg TODO src` | general | :70（换行；若 split 会变 safe，破坏）|
| `chmod\n-u+s ...` / `cat\n.env` / `iptables\n-F` / `kill -9\n-1` | general | :746-752（换行分隔使命令与 flag 解耦）|
| `git status '` / `git status &&` / `| git status` / `git status |` / `   ` | general | :231-235（畸形）|
| `rm -rf /tmp/.web_api_cache\n/Users/...` | cautious | :744（raw 层捕 rm）|
| `Remove-Item ... > deleted.log` | cautious | :85（raw 层捕删除）|
| `cmd /c "del ..." 2>&1` / `pwsh -Command "Remove-Item..." 2>&1` | cautious/dangerous | :126-130,:147（raw 层；`2>&1` 未锁 general）|
| `git status && rg TODO src; pwd` | safe | :34（正常 split）|
| `scp ...`（无特殊字符）| cautious | classifyTokens :1136 |

**核心约束**：`$`/glob/文件重定向/单`&`/换行 → general 是**测试锁定且语义合理**（动态/写文件/解耦），
**不能改**。换行**必须 bail 不能 split**（否则 `git status\nrg`→safe 破坏 :70）。

## 4. 推荐方案（手术刀式，仅改 precheck.ts）

### 改动 A：splitCommands 由"整条 bail"改为"按段 bail"

当前：遇 bail 字符 → `return undefined`（整条丢弃，包括已切出的前段）。
改为：遇 bail 字符 → 当前段标记 opaque 并结束，**继续扫描后续段**；返回 `{ segments: string[]; opaque: boolean }`
（segments=干净段，opaque=是否存在被丢弃段）。

- 分隔符（切分）：`;` `|` `&&` `||`（**不变**；换行/单`&`仍是 bail 字符，**不切分**——保 :70/:69）。
- bail 字符（让**当前段** opaque，不毒化整条）：`$` `` ` `` `(` `)` `{` `}` `*` `?` `[` `>` `<` 单`&` 换行。
- **段语义（统一）**：bail 字符结束当前段（标记 opaque、不入 `segments`），紧随其后的字符起开始新段，
  直到下一个分隔符或 bail 字符。空段（前导/尾部/连续分隔符）→ opaque。
- **未闭合引号/悬挂转义**：splitCommands 遇此（:760 `if (quote||escaped) return`）→ 当前段 opaque
  （`git status '` → 末段 opaque、无干净段 → general，保 :231）。

`evaluateShell` 改：`const { segments, opaque } = splitCommands(command)`；干净段跑 `evaluateCommand`；
若 opaque，并入一个 `{level:"general",reason:"opaque shell segment requires explicit approval"}`；
取 max。segments 为空且 opaque → general（等价旧行为）。

**效果**（bail 段不入 segments，余文至下一分隔符为新干净段；post-bail 片段若无可识别命令则归类 general）：
- `scp; echo $HOME` → bail 段="echo "(到`$`止)；干净段=["scp"](cautious) + ["HOME"](general) → max(cautious,general,general)=**cautious**（修）。
- `git status & rg TODO src` → bail 段="git status"(单`&`)；干净段=["rg TODO src"](safe) → max(safe,general)=general ✓。
- `git status\nrg TODO src` → bail 段="git status"(换行)；干净段=["rg TODO src"](safe) → general ✓。
- `echo $HOME` → bail 段="echo "(到`$`止)；干净段=["HOME"](general) → max(general,general)=general ✓。

### 改动 B：fd-merge 重定向跳过（不 bail）

在 splitCommands 扫描到 `>` 或 `<` 时，先看是否 fd-merge（`>&\d` / `>&-` / `<&\d` / `<&-`，即 `2>&1`/`1>&2`/`>&2`/`2>&-`）：
- 是 → **原子消费**该 fd-merge token（连同 `&` 与 fd 数字一起跳过并前进索引），**继续当前段**（不 bail）。
- 否（`>file`/`>>file`/`<file`/`2>file`/`2>/dev/null` 等文件重定向）→ 当前段 opaque（保 :227）。

**实施关键（成败点）**：`2>&1` 中的 `&` **必须在 `>`/`<` 分支内原子消费**，绝不能让循环继续到 `&` 字符触发
单 `&` bail（:751）。`>` 检查（:740）与 `&` 检查（:751）是独立分支，必须在 `>`/`<` 分支内匹配 fd-merge 后 `continue`
并跳过 `&1`，否则 `scp 2>&1` 会因 `&` bail 变 opaque→general，改动 B 失效。

**边界**：
- `>&2`（无前导数字）→ `>&\d` 匹配 → 跳过 → 段干净（fd-merge 语义）。
- `>& /dev/tcp`（`>&` 后非数字/`-`）→ 不匹配 fd-merge → opaque（reverse-shell 由 raw 层 RE_D_REVERSE_SHELL 捕获，双保险）。
- `2>/dev/null` 形如 `2>file` → opaque → general（不做 `/dev/null` 特例，避免过度假设）。
- `&>`/`&>>`（bash 合并重定向到文件）→ 单 `&` 先 bail → general（与文件重定向一致，非回归）。

**效果**：`scp X 2>&1` → 段内 `2>&1` 原子跳过（前导 fd 数字 `2` 保留于段内，无害——classifyTokens 按 tokens[0] dispatch）→ 段="scp X 2" → cautious（修）。
`scp 2>&1; & 7z ...; Get-Content ...` → 段1="scp"(cautious) + 段2(`&` opaque) + 段3(Get-Content general) → cautious（修，真实用例）。
**保持**：`echo hello > out.txt` → `> out.txt` 非 fd-merge → opaque → general ✓。

### 不做的事（明确排除）

- **不**把 scp 等规则复制到 cautiousRaw（用户明确否决；且 raw 层只该放语义正则）。
- **不**改 opaque fallback 为 cautious（会破坏 :69/:70/:205/:209/:227 等 general 断言，且 PowerShell `$` 噪声大）。
- **不**让换行/单`&` split（破坏 :70/:69）。
- **不**处理 `$`/glob/`()`/`{}`（测试锁定 general + 语义动态，不可改）。
- **不**引入 tree-sitter 到 precheck（precheck 同步、零依赖；改契约超出手术刀范围）。

## 5. 正常/错误/并发/安全边界

- **正常路径**：无 bail 字符 → split 正常 → 行为完全不变（segments=旧 string[], opaque=false）。
- **fd-merge 路径**：`2>&1` 跳过 → 段干净 → token 层可达。
- **opaque 段路径**：bail 字符 → 该段 general，其他段仍分类取 max。
- **dangerous 不受影响**：dangerousRaw 在 split 前 short-circuit；rm -rf /、reverse shell 等仍 deterministic deny。
- **错误路径**：畸形引号 → tokenize 返回 null（evaluateCommand :442 general）；splitCommands 未闭合引号/悬挂转义 → 当前段 opaque（见改动 A）；空命令（:410）general——不变。
- **并发/退出/清理**：precheck 是纯同步函数，无状态、无 IO、无副作用。无并发/清理问题。
- **安全边界**：fail-open 缩窄（fd-merge + 按段不再毒化），但 `$`/glob/文件重定向 仍 general（既有边界，不回退）。
  dangerous 仍 fail-closed（raw 层）。

## 6. 行为级测试计划

先写测试（当前实现下暴露缺口），再实现：

新增 test("marks scp cautious through fd-merge redirect"):
- `scp host:a b 2>&1` → cautious（当前 general，暴露缺口）
- `scp host:a b 1>&2` → cautious
- `scp host:a b 2>&1; echo done` → cautious
- `scp host:a b 2>&1 | grep x` → cautious（`|` 切分 + fd-merge）
- `echo hello > out.txt` → general（回归守卫，:227 不退化）
- `echo hello >> out.txt` → general（回归守卫）

新增 test("does not let opaque segment poison cautious sibling"):
- `scp host:a b; echo $HOME` → cautious（当前 general，暴露缺口）
- `scp host:a b; ls *.ts` → cautious
- `git status; scp host:a b` → cautious
- `git status & rg TODO src` → general（回归守卫，:69 不退化）
- `git status\nrg TODO src` → general（回归守卫，:70 不退化）
- `echo $HOME` → general（回归守卫，:205 不退化）

实现后验证：`bun test test/permission/precheck.test.ts` 全绿（含既有 820 行不变量）。

## 7. 验证命令

```
cd packages/opencode
bun test test/permission/precheck.test.ts
bun test test/permission/            # auto/arity/next/reviewer 不受影响
bun typecheck
```

## 8. git 预估

- 修改文件：`src/permission/precheck.ts`（splitCommands + evaluateShell，~30-45 行净增）。
- 新增测试：`test/permission/precheck.test.ts`（~15-20 行断言）。
- **1 个生产文件 + 1 个测试文件**。无迁移、无生成文件、无文档生成。
- 增删行：净增 ~50-65 行。

## 9. 风险与开放问题

- **风险 R1**：fd-merge 的 lookahead 误判。`2>&1` 必须精确匹配 `>&\d`/`>&-`，不能把 `2>&1` 之后的 `1` 当成新段。
  缓解：消费到 fd 数字结束；测试覆盖 `2>&1`/`1>&2`/`>&2`/`2>&-`。
- **风险 R2**：按段 bail 改变 splitCommands 返回类型（string[]|undefined → {segments,opaque}）。
  仅 evaluateShell 一处消费，适配即可。rawCommandSegments 是独立函数，不受影响。
- **风险 R3**：`scp $F dest` / `scp *.gz dest` 仍 general（`$`/glob 在 scp 自身段，bail）。
  这是测试锁定 + 语义动态的既定边界，**不回退**但也不扩展。属已知残留，文档注明。
- **开放问题**：`2>/dev/null` 是否值得特例（discard 语义 benign）？方案默认**不处理**（避免过度假设）；
  若后续有需求再单独加 `/dev/null` 识别。
- **确认无依赖问题**：classifyTokens/unwrap/remoteWrapper 不看跨段内容；按段不影响它们。
  tree-sitter（shell.ts）与 precheck 解耦，不受影响。

## 推荐方案摘要

仅改 `precheck.ts` 两处：(A) `splitCommands` 整条 bail → 按段 bail（bail 字符只让当前段 opaque，
不再毒化兄弟段，修 `scp; echo $HOME`）；(B) fd-merge 重定向 `2>&1` 跳过不 bail（修 `scp 2>&1`）。
`evaluateShell` 适配新返回类型，opaque 段并入 general 取 max。不复制规则到 raw、不改 fallback 为 cautious、
不让换行/`&` split、不引 tree-sitter。全部既有 general/cautious/dangerous 断言保持。约 1 生产文件 + 1 测试文件。

## 10. Subagent 独立复核结论（已完成，硬性步骤）

**结论：可执行**。逐条核验全部既有断言（:34/:69/:70/:85/:126-130/:147/:205/:209/:227/:231-235/:744/:746-752）保持，
A/B 两改动不可互替，冗余最小。复核提出的 3 项澄清（段语义统一、未闭合引号处理、fd-merge `&` 原子消费）
及边界 case 已**并入正文改动 A/B/section 5**，本节仅留复核专属证明。

### 不可互替性证明

- 仅改动 B（无 A）：`scp 2>&1; & 7z; Get-Content` 中单 `&` 仍触发**整条** bail→general，不修复。
- 仅改动 A（无 B）：`scp X 2>&1` 中 `>` 仍 bail → scp 段 opaque→general，不修复。
- 故 A、B 缺一不可。

### 复核确认的非回归边界（详见改动 B / section 9 R3）

`&>`/`&>>`、`>&2`、`>& /dev/tcp`、`2>/dev/null`（改动 B）、`scp $F`/`scp *.gz`（section 9 R3）均维持 general 或由 raw 层捕获，无回归。
