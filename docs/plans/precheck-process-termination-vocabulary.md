# Canonical Implementation Plan: 进程终止族 precheck 词表化（cautious 基线 + 批量杀 dangerous）

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: 用户原话（2026-09-02 会话）："当前相应的进程终止族的词表构建不完全，因此需要在当前逻辑中进行相应的进程终止的判定。所有的进程终止等内容设置为 cautious，不需要完全设置为 dangerous。但是如果批量杀全部进程的话，就设置为 dangerous。就是那种完全的那种不可逆的那种问题，就是给它设置成 dangerous，否则可以给它设置成这个 cautious。就譬如说它只要关闭一个程序，比如说指定一个 Explorer，那可以设置为这个 cautious，没问题。也就是全部的，就比如说你可以列成类似于 rm -rf 那种形式，才是 dangerous。然后整体的生产文件修改数不超过四个文件，整体修改行数不超过600行，保持整体实现符合现有思想，且整体实现精准精确，按照 token 语言的内容进行相应的实质的一个精确的判定，同时兼顾不同平台，比如 Unix 系列的，或者说 Windows 系列的，或者说 Mac 等等内容的。"
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-09-02

本文件是本任务的唯一实施规范。

## 1. Verbatim Requirement

见上方 Requirement source。拆解（均为用户显式授权）：

1. **R-REQ-1（进程终止族全覆盖）**：进程终止命令（跨 Unix/Windows/macOS）默认 **cautious**（如 taskkill /IM explorer.exe、kill <pid>、Stop-Process -Id）。
2. **R-REQ-2（批量杀全部 → dangerous）**：`kill -9 -1` 级"全部进程"形态保持/扩展为 **dangerous**（rm -rf 同级的不可逆性）；按名批量（pkill/killall/taskkill /IM）不属"全部进程"，为 cautious。
3. **R-REQ-3（token 级精确判定）**：按既有 tokenizer 词法判定，避免英文单词/字符串误报。
4. **R-REQ-4（跨平台）**：Unix（kill/pkill/killall）、Windows（taskkill/tskill、PowerShell Stop-Process 及其 `kill` 别名）、macOS（kill/pkill/killall）。
5. **R-REQ-5（预算）**：生产 ≤4 文件、≤600 行；符合现有词表思想。

## 2. Explicit Non-Goals

- 不改服务管理族（Linux `systemctl stop` 已 cautious :1174-1179；Windows Stop-Service/net stop/sc 属服务状态变更概念，非进程终止——用户原话范围是"进程终止"；如需另行词表化走后续任务）。
- 不改 Permission.ask/auto 路由、reviewer、shell.ts 扫描层（本缺陷在 precheck 分类层，上游正常）。
- 不改既有 `kill -9\n-1`（分段）→ general 契约（:1042-1043）与 `kill -9 -1` → dangerous（:717-718）。
- 不新增 raw 层正则（token 层 tokenize 成功即为权威；raw 层是 tokenize 失败的兜底，现有 RE_D_KILL_ALL 保持）。
- 不含 `sp`：`sp` 实为 Set-ItemProperty 的官方别名，纳入会误伤；`spps`（Stop-Process 官方别名，与 `kill` 并列）**纳入**词表（依 :72-73 "官方别名同级"先例，R2 审计 B-01 更正）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| 根/包 `AGENTS.md` | 测试从 package 目录跑；`bun typecheck`；Effect/词表风格 |
| `.opencode/policy/first-principles-engineering.md` | 单一 primary path；词表归属 precheck（分类 owner）；禁 speculative |
| 先例：`FILE_DELETE_COMMANDS`(:73)、`USER_ACCOUNT_COMMANDS`(:86-89) 及消费点 :1156-1157 | 词表 + classifyTokens 分段判定的既有模式，本方案同构 |
| 先例：`crontab -l` 只读豁免（:1186-1191） | `kill -l`（列信号名，只读）的同构豁免依据 |
| 事故取证（本会话 2026-09-02 探针，真实 precheck 代码） | `Stop-Process -Id <pid> -Force` / `kill <pid>` / `pkill -9 node` / `taskkill /PID x /F` / `kill -1` 全部 general → auto 静默放行；生产事故：另一 agent 的 kill-only 命令零护栏直接执行（用户手动 abort） |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `precheck.ts:73/79-83/86-89`（三个既有词表）、`:1122/:1156`（消费点）、`:1181-1183`（进程终止段现状：仅 kill+-9+-1）、`:1186-1191`（crontab -l 只读豁免先例） | 插入点与同构模式 | observed |
| `precheck.test.ts:717-718`（kill -9 -1 → dangerous 契约）、`:1042-1043`（分段 kill → general 契约） | 既有契约不可破坏 | contracted |
| git 历史 `0436a82b95`（2026-05-25 唯一触及 kill 的 commit，只加了 mass-kill 双条件） | 规则从未覆盖指定 pid 族——非回归而是初始缺口 | observed |
| 分类探针（真实 evaluate，D:\Temp） | 事故形态与边界全表（§1 拆解的 red 证据） | observed |

## 5. Current Behavior

```text
bash ask -> Permission auto -> precheck.evaluate -> bashEffect -> shellEvidenceRisk
  -> evaluateShell -> tokenize -> classifyTokens
       :1181  cmd==="kill" && tokens.includes("-9") && tokens.includes("-1") → dangerous
       其余一切进程终止形态（kill <pid>/kill -1/pkill/killall/Stop-Process/taskkill/tskill）
         → 无规则命中 → general → auto 静默放行（auto.ts:72-76）
```

## 6. Supported Input Domain and Reachability

| Input | Producer | Path | Owner | Classification |
| --- | --- | --- | --- | --- |
| `kill <pid>`、`kill -9 <pid>`、`kill -l`（只读豁免） | 模型 bash 调用 | classifyTokens :1181 段 | precheck | reachable |
| `kill -1` / `kill -9 -1`（信号全部进程） | 同上 | 同上 | precheck | observed（:718 锁定其一） |
| `pkill`/`killall`（按名/模式批量） | 同上 | 同上 | precheck | reachable |
| `Stop-Process`（PS；`kill` 为其官方别名）、`taskkill`/`tskill`（Windows） | 同上 | 同上 | precheck | observed（事故形态） |
| 字符串/参数中的英文 "kill"（如 `echo kill`、`git commit -m "...kill..."`） | 同上 | tokenize 后非首 token / 引号内 | — | observed（token 级天然不误报；`cmd==="echo"` 不命中词表） |

## 7. Required Invariants

| ID | Invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 进程终止族 token 命中 → **cautious**（"process termination requires explicit approval"），覆盖 kill/pkill/killall/stop-process/taskkill/tskill | 用户原话 R-REQ-1；事故探针 | 本计划新增 |
| INV-02 | `kill` 尾操作数为 `-1`（`kill -9 -1`/`kill -1 -1`/`kill -- -1`）与 `killall5` → **dangerous**；信号位 `-1`（`kill -1 1234`）不属此类（R1 审计 B-01） | 用户原话 R-REQ-2；:717 契约；POSIX kill 语法 | :717-718 保留 + 新增边界用例 |
| INV-03 | 既有契约不回归：`kill -9\n-1`（分段）→ general；echo/git -m 含 "kill" 字样 → 原级别不变 | :1042-1043；token 级判定 | :1042-1043 + 新增负例 |
| INV-04 | `kill -l`/`kill -l 9`（flags 全为 -l）保持 general（只读豁免，crontab -l 同构容忍非 flag 实参） | :1186-1191 先例 | 本计划新增 |
| INV-05 | 按名批量（pkill/killall/taskkill /IM explorer.exe）→ cautious 而非 dangerous（用户 Explorer 原话） | 用户原话 R-REQ-2 边界 | 本计划新增 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| INV-01 | classifyTokens 进程终止段（:1181-1183）只识别 `kill` 且要求 -9+-1 双条件；族内其余命令与单 pid 形态无任何词表/规则 → general 直过 | precheck classifyTokens | 2026-05-25 唯一 commit 的初始窄实现 + 本会话探针 |

Red-capable feedback loop：`bun test test/permission/precheck.test.ts -t "process"`——新用例当前红（general ≠ cautious），修复后绿；诊断环=§4 探针（已运行）。

## 9. Responsibility and Seam

| Concern | Owner | Why |
| --- | --- | --- |
| 进程终止族分类 | precheck classifyTokens + 新词表 | 分类 owner；词表消费先例 :1156 |
| 路由/评审 | 既有 auto（cautious→reviewer）不动 | 上游正常 |
| 跨平台命令名归一 | 既有 tokenize 小写化 | 既有行为（remove-item 同构） |

## 10. Single Approved Primary-Path Design

在 `:1181` 进程终止段替换为词表判定（同构 USER_ACCOUNT 模式）：

```ts
// ---- 进程终止 ----
// [注释：族词表依据 + sp 别名排除 + -l 只读豁免 + -1 操作数位语义 + killall5]
if (cmd === "killall5")
  return { level: "dangerous", reason: "mass process kill" }
if (cmd === "kill" && tokens.at(-1) === "-1" && !tokens.slice(1).includes("-l"))
  return { level: "dangerous", reason: "mass process kill" }
if (PROCESS_TERMINATION_COMMANDS.has(cmd)) {
  // 只读豁免（crontab -l 同构，容忍非 flag 实参）：kill -l / kill -l 9 → general
  const args = tokens.slice(1)
  const flags = args.filter((t) => t.startsWith("-"))
  if (args.length > 0 && flags.length > 0 && flags.every((f) => f === "-l")) return undefined
  return { level: "cautious", reason: "process termination requires explicit approval" }
}
```

词表：`new Set(["kill", "pkill", "killall", "stop-process", "spps", "taskkill", "tskill"])`。`killall5`（sysvinit-utils/busybox，唯一语义即向全部进程发信号）独立判 dangerous（R-REQ-2 最纯形态，R1 审计 B-02）。`-1` 判 dangerous 要求**尾操作数位**为 `-1`（`tokens.at(-1)`）：`kill -9 -1`/`kill -1 -1`/`kill -- -1`（尾 token `-1`）→ dangerous；`kill -1 1234`（信号位 -1 + 单 pid）→ 落词表 cautious（R1 审计 B-01：POSIX `kill -<signum> <pid>` 的信号位不得误捕）。`-l` 豁免对齐 crontab 先例（flags 全为 -l 且有实参，容忍非 flag 实参）：`kill -l`/`kill -l 9` → general；裸 `kill`（无实参）→ cautious（N-01 对齐：不再凭空 every-true 豁免）。dangerous 检查置于词表之前保序，:718 契约保留。raw 层 RE_D_KILL_ALL 不动。

为何修复 first divergence：词表使命中族内一切 tokenize 成功形态（INV-01/03/05）；-1 前置分支实现 INV-02；-l 豁免 INV-04。单文件单段修改，无平行实现。

## 11. Secondary and Replacement Path Inventory

| Path | Class | Disposition |
| --- | --- | --- |
| 既有 RE_D_KILL_ALL raw 层 | raw 检测器（tokenize 失败兜底 + 成功路径前置兜住位置无关形态） | preserve |
| `kill -9\n-1` 分段 → general | primary-contract（:1043 契约） | preserve |
| 新词表 cautious | primary-contract branch | add |
| 新 -1 dangerous 前置分支 | primary-contract branch（INV-02） | add |

无新增 fallback/成功路径。

## 12. Workaround Deletion

无既有 workaround（缺口而非补偿）。

## 13. Forward Traceability

| Req/Inv | Path | File | Test |
| --- | --- | --- | --- |
| R-REQ-1/INV-01 | 词表 cautious | precheck.ts | kill <pid>/kill -9 <pid>/pkill x/killall x/Stop-Process -Id 5/taskkill /PID 5/tskill 5 → cautious |
| R-REQ-2/INV-02 | -1 dangerous | precheck.ts | kill -1、kill -9 -1 → dangerous |
| R-REQ-4 | 词表成员 | precheck.ts | 同上跨平台用例 + taskkill /IM explorer.exe → cautious（INV-05） |
| INV-03 | token 级 | — | echo kill → general；git commit -m "…kill…" → cautious（git 规则不变）；kill -9\n-1 → general |
| INV-04 | -l 豁免 | precheck.ts | kill -l → general；kill -l 9 → general（crontab -l 同构容忍非 flag 实参） |
| R-REQ-5 | — | — | §19 预算 |

## 14. Reverse Traceability

| Concept | Req | Evidence | 现有逻辑为何不能承载 |
| --- | --- | --- | --- |
| PROCESS_TERMINATION_COMMANDS 词表 | R-REQ-1/4 | 事故探针全 general | 无任何规则 |
| -1 dangerous 前置 | R-REQ-2 | :717 既有 + kill -1 探针 general | 现要求 -9+-1 双条件 |
| -l 豁免 | 精确性 R-REQ-3 | :1186 先例 | 无规则时 kill -l 会误入 cautious |

## 15. File-Level Change Plan

| File | Change | Responsibility | Lines |
| --- | --- | --- | --- |
| `packages/opencode/src/permission/precheck.ts` | modify | 词表常量 + :1181 段重写 + 中文注释 | +18 / -3（净 ~15） |
| `packages/opencode/test/permission/precheck.test.ts` | modify | 新用例组（~14 断言）+ `kill -1` 边界 | +55 |

生产 1 文件（≤4 ✅）、净 ~15 行（≤600 ✅）。

## 16. TDD Behavior Slices

| # | Red | Green | Regression |
| --- | --- | --- | --- |
| 1 | kill 23148 / kill -9 23148 → cautious | 词表 | — |
| 2 | kill -1 → dangerous；kill -9 -1 → dangerous（既有） | -1 分支 | :717 |
| 3 | pkill -9 node / killall Finder / Stop-Process -Id 5 -Force / taskkill /PID 5 /F / tskill 5 → cautious | 词表 | — |
| 4 | taskkill /IM explorer.exe → **cautious**（非 dangerous，INV-05）；kill -1 1234 → **cautious**（B-01 信号位）；killall5 / killall5 -9 → **dangerous**（B-02） | 词表/-1 尾位 | — |
| 5 | kill -l → general；kill -l 9 → general（crontab -l 同构豁免，N-02 对齐）；kill -l -9 → cautious（非 -l flag 存在） | -l 豁免 | — |
| 6 | echo kill → general；`git commit -m "kill process"` → cautious（git 规则）；kill -9\n-1 → general | —（负例锁） | :1042-1043 |

## 17. Chinese Comment Budget

E ≈ 15 → C ≥ 3（计划 5）：① 族词表构成与平台映射（kill 双语义：Unix 内建 + PS Stop-Process 别名）；② `sp` 排除依据（Set-ItemProperty 官方别名，误伤面）；③ -1 全进程语义（POSIX 负 pid 广播）；④ -l 只读豁免（crontab -l 同构）；⑤ dangerous 前置保序原因（:718 契约）。

## 18. Verification

| Command | cwd | Evidence |
| --- | --- | --- |
| `bun test test/permission/precheck.test.ts` | packages/opencode | 新旧契约全绿 |
| `bun test test/permission/` | packages/opencode | 权限组回归 |
| `bun test test/session/prompt.test.ts -t "auto permission reviewer"` | packages/opencode | cautious→reviewer 链路 |
| `bun typecheck` | packages/opencode | 类型门禁 |

音频/opentui 零交集（仅 precheck 分类层）。

## 19. Diff Budget

生产 1 文件、净 ~15 行；测试 +55。远低于 4 文件/600 行。

## 20. Real Risks / Rejected Speculation

- 风险：裸 `kill`（无实参）→ cautious（词表命中，无空参豁免，N-01 对齐）；`kill -9 0`（进程组）→ cautious（作用域自限）。
- 已知边界（N-04，分割器架构非本计划缝隙）：glob 段污染（`pkill *`、`Stop-Process -Name *`）经 splitCommands bail → opaque → general，词表不生效；引号内模式（`pkill ".*"`）正常 cautious。覆盖声明以此为界。非尾部多 pid `-1` 形态（`kill 123 -1 456`、`kill -s KILL -1 4242`）→ cautious（reviewer 门控；含 -9 者由 raw 层 RE_D_KILL_ALL 位置无关兜住，实测匹配 `kill -9 1234`+` -1` 序列）。
- 拒绝：Stop-Service/net stop/sc 纳入（服务族概念，后续任务）；`osascript quit`（speculative）；raw 层新增正则（token 层权威）；`pkill`/`taskkill /IM` 设 dangerous（用户原话 Explorer → cautious）；`tkill`/`killpg`（标准性/可达性弱，未来备选）。

## 21. Audit Contract / ## 22. Plan Audit Record

审计员须读本文件+原始需求，仓库重建行为，blocking 附证据。记录：

| Round | Audited revision | Full scope? | Blocking | Non-blocking | Result | Invocation |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01：`tokens.includes("-1")` 捕获信号位，`kill -1 1234`（单进程 SIGHUP）误判 dangerous（auto 硬拒），违反 cautious/dangerous 边界；B-02：killall5（Linux 标准杀全部二进制）缺失，“Unix 全覆盖”声明被证伪 | N-01 裸 kill 的 every-true 豁免矛盾；N-02 -l 豁免比 crontab 先例窄；N-03 help 形态无豁免（与 USER_ACCOUNT 先例一致）；N-04 glob 段污染边界未记录 | BLOCK（修订 R2：-1 判定改尾操作数位 tokens.at(-1)；killall5 独立 dangerous；-l 豁免对齐 crontab；裸 kill 不豁免；glob 边界入 §20） | task ses_f9d495f18ffe4QTPH7t9SO24pd |
| 2 | R2 | yes | B-01：§2 以错误事实（「spps 纳入会误伤」——spps 是 Stop-Process 官方别名，与 Set-ItemProperty 的 sp 为不同 token）排除官方别名，`spps -Id <pid>` → general → auto 静默放行，违反 R-REQ-1/INV-01 与 :72-73 官方别名同级先例 | N-01 §13 与 §10/§16 在 `kill -l 9` 上记录矛盾；N-02 非尾部多 pid `-1` 形态边界未入 §20；N-03 RE_D_KILL_ALL 标签不准 | BLOCK（修订 R3：spps 入词表并更正 §2；§13 INV-04 改 general；§20 补边界；§11 改标签） | task ses_f9d3d1d0dffe4IRecEJ9uOTZvn |
| 3 | R3 | yes | 无 | N-01 §13 INV-04 单元格矛盾（已随本 verdict 更正为 general）；N-02 §20 非尾部 -1 边界注记（已补）；N-03 glob/替换形态 general 为既有分割器边界（已声明，建议后续 raw 镜像任务） | APPROVE | task ses_f9d3250f1ffeM0PSrqDHzBgm1d |

## 23. Implementation Evidence / ## 24. Implementation Audit Record

### Actual Files and Diff

生产（1 文件，+21/-1）：`precheck.ts`：① `PROCESS_TERMINATION_COMMANDS` 词表（kill/pkill/killall/stop-process/spps/taskkill/tskill）；② :1181 段重写：killall5 无条件 dangerous、kill 尾位 `-1`（tokens.at(-1)）dangerous（信号位 `kill -1 1234` 落词表 cautious）、-l 只读豁免（crontab 同构）、词表 cautious。

测试（1 文件，+33）：三组新用例（族 cautious 12 断言、kill-all dangerous 4、-l 豁免+负例锁 5）。

### Red-Green

族 cautious 与 kill-all 两组先红（general ≠ 期望）→ 实现后绿；-l 豁免组随实现绿（含 `kill -l -9` 红项）。

### 发现事实披露（Phase 9）

计划 §6/INV-03 预测 `echo kill → general` 有误：既有 wrapper-shadow 启发式（:513-533，为捕获未知前缀遮蔽的内层危险命令而设，`echo rm -rf` 今天即 cautious）使 `echo kill` 在词表化后升 cautious。实现与仓库既有语义一致（同一启发式同语义），非新引入误报类；核心契约（:718 kill -9 -1 dangerous、:1042-1043 分段 general、git -m 不变）全部保持。测试按既有语义断言 cautious 并注释依据，交实现审计裁决。

### Verification

| Command | Result |
| --- | --- |
| `bun test test/permission/precheck.test.ts` | 110 pass / 0 fail（含 3 组新测） |
| `bun test test/permission/` | 281 pass / 0 fail |
| `bun test test/session/prompt.test.ts -t "auto permission reviewer"` | 8 pass / 0 fail |
| `bun typecheck` | clean |

### E/C

生产 E=10（+21 扣 10 注释、1 空行）、C=10（0.63 ≥ ceil(10×0.15)=2）：族构成与平台映射/官方别名同级依据（sp 排除）、killall5 语义、尾位 -1 语义、-l 豁免先例、dangerous 保序。

### Remaining Unverified

glob 段污染形态（§20 已声明边界，属分割器架构）；`kill -L`/`killpg` 等弱标准化变体（§20 拒绝）。

### Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking | Non-blocking | Result | Invocation |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R3 | yes | 无 | N-01 §6/§13/§16 `echo kill` 单元格过时（§23 披露成立：wrapper-shadow 启发式为既有语义，`echo rm -rf` 同构，方向保守）；N-02 行引用/估算漂移 | APPROVE（独立复现：precheck 110/0、permission 281/0、reviewer 8/0、typecheck clean；E/C 重算一致 E=10/C=10） | task ses_f9d1bff53ffevcbYyvaV1p3kF3 |
