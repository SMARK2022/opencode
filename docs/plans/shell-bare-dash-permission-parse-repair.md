# Canonical Implementation Plan: Shell 权限扫描裸 `--` 解析修复（fail-open → 精确分类）

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: 用户原话（2026-09-02 会话）："当前我们需要完整完善解决--导致的权限解析出错并完整降级以及回退的巨大问题，需要以精准的方法按照工业级标准进行准确的解析，不得以 Cautious + Fallback 这种方式来粗暴地对所有的命令进行处理。理论上应当尽量绝对准确地去进行相应的分类以及相应的修正。同时保持较好的性能兼容性等内容，代码整体保持清爽，保持鲁棒性。整体修改代码，生产文件数不超过六个，修改生产代码行数不超过六百行。同时需要确保整体不会引入红测或者产生音频等方面的红测，同时opentui也不会出现红测"
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-09-02

本文件是本任务的唯一实施规范。聊天摘要、被取代的修订与 builder 自述不构成实施授权。

## 1. Verbatim Requirement

见上方 Requirement source。可执行拆解（均为用户显式授权）：

1. **R-REQ-1（修复 `--` 解析失效）**：裸 `--` 导致权限扫描产出零 pattern、命令静默绕过权限门禁——必须修复。
2. **R-REQ-2（精确分类，禁止粗暴降级）**：不得以"解析失败→整体 cautious+fallback"处理所有命令；须尽量绝对精确地分类与修正（`git commit -- paths` → cautious、`git log -- paths` → safe）。
3. **R-REQ-3（工业级/鲁棒/清爽/性能兼容）**：方案分层、token 级、有既有仓库先例支撑；代码清爽鲁棒。
4. **R-REQ-4（预算与回归约束）**：生产 ≤6 文件、≤600 行；不引入红测（含音频、opentui 相关）。

## 2. Explicit Non-Goals

- 不修改 precheck.ts（其手写 tokenizer 从未受影响，分类正确——实测 `git commit --only -m x -- paths` 判 cautious）。
- 不修改 Permission.ask/reviewer（评审链路正常；本缺陷在 ask 之前的扫描层）。
- 不修改 tree-sitter wasm grammar（版本钉死 0.25.10，上游修复不可控；以解析输入归一化兼容）。
- 不新增配置项、不引入执行语义变化（归一化仅影响权限解析输入，执行命令保持原文）。
- 不做"解析失败→整体 cautious"通道（用户原话禁止；且违背仓库自有哲学 auto.ts:73-75 "reviewer 只承接 cautious"、precheck.ts:846 "opaque 而非直接 cautious"）。
- 不改变**有意零 pattern 类**的既有行为：CWD 类命令（cd/chdir/pushd 等，shell.ts:42 + :1013 有意跳过，契约测试 shell.test.ts:1716-1735 锁定；CWD 是 FILES 的子集，FILES 其余命令仍产出 pattern）、空命令——它们的零 bash ask 是设计契约而非缺陷。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Permission 术语：ruleset + `ask(Permission.Request)`；Tool 经 ask 升级 |
| 根 `AGENTS.md` + `packages/opencode/AGENTS.md` | 模块形态、Effect 规则、测试从 package 目录跑、`bun typecheck` |
| `.opencode/policy/first-principles-engineering.md` | 单一 primary path；上游保证不得下游重复（precheck 已是分类 owner）；禁 speculative defense-in-depth |
| `packages/opencode/test/AGENTS.md` | `it.live`/capture 夹具模式、`each` 跨 shell 矩阵 |
| 先例：shell.ts:1399 `normalizePowerShellInlinePython` | 定点、高置信、audit 分离的解析前规范化——本方案 L1 的同构先例 |
| 先例：precheck 手写 tokenizer（:435 evaluateShell / :853 tokenize）与 tree-sitter 解析层的职责分界（本计划 §4 实证） | 分类层与解析层分置；风险分级 owner 在 precheck |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/tool/shell.ts:372-374`（parse）、`:802-814`（localCommands：ERROR/string 祖先过滤）、`:983-1029`（collect 产出 patterns/always/raw/dirs）、`:571-625`（ask：`:602` patterns 空即 return，无任何权限请求）、`:1399-1421`（execute：parse → compatibility → collect → ask；inline-python 归一化先例） | 全链路 owner 与 fail-open 点 | observed |
| tree-sitter-powershell **0.25.10**（packages/opencode/package.json:156 钉死）对真实命令的解析实验（仓库同版本 wasm，D:\Temp 探针） | 根因定位：`echo --` → `(ERROR (command_name) (command_argument_sep))`，`--` 无词法节点；`git commit -m "a" -- x.ts`（纯 ASCII）→ 0 个 command 节点；`echo -x`/`echo a b`/`git checkout file.ts` → OK | observed |
| tree-sitter-bash 同 wasm 探针 | `--` 对 bash grammar 完全无害（`git commit -m a -- x.ts`、`echo -- x` 均 OK）；引号化形态 `"--"` 两 grammar 均无害 | observed |
| `packages/opencode/src/permission/precheck.ts:435-475`（evaluateShell→tokenize :853 手写）、`:655-708`（$()/反引号替换边界）、`:751-768`（taint/opaque 分段）、`:1322-1328`（classifyGit state-changing→cautious） | 分类层独立且精确：pattern 原文交给 precheck 即得正确分级；风险构形→cautious 的 owner 在 precheck，不在 shell.ts | observed |
| 生产 DB 取证（2026-09-02 查询） | 近 7 天 3996 条 bash 命令中 **222 条（5.6%）含裸 `--`** 全部静默绕过权限；含 `git diff -- path`、`git log --all` 等日常形态；2026-09-01 实际事故：3 次 `git commit --only … -- <paths>` 零权限 ask 直接执行（工具 part 无 autoReview、无评审记录） | observed |
| `packages/opencode/test/tool/shell.test.ts:114-120`（shells 矩阵：win=bash+pwsh+powershell+cmd）、`:191-198`（capture 夹具捕获 ask）、`:378-454`（pattern 断言先例，如 `expect(bashReq!.patterns).toContain('git commit -m "test"')`） | 红测 seam：跨 shell 矩阵 + patterns 断言 | observed |

## 5. Current Behavior

```text
Tool.execute(params.command)
  -> parse(params.command, ps)                      [:372, :1402]  tree-sitter(ps?powershell:bash)
  -> shellCompatibilityError(tree.rootNode)         [:1406]
  -> collect(root, cwd, ps, shell, instance)        [:983-1029]
       localCommands(root) = commands(root) 过滤 ERROR/string 祖先 + 远程载荷区间  [:802-814]
       每 command 节点 -> parts() tokens -> permissionPattern -> scan.patterns
                                                      （同时产出 scan.always 前缀建议、scan.raw、scan.dirs）
  -> ask(ctx, scan, metadata)                       [:571-625]
       scan.dirs  -> external_directory 权限请求
       :602  if (scan.patterns.size === 0) return   ← 无 bash 权限请求（fail-open 点）
  -> run(原始 command 执行)                          [:1427]
```

**失效路径（观测实证）**：PowerShell grammar 无法归类裸 `--`（词法层直接丢弃该 token，`--` 前缀预留给自减运算符模式）→ `command` 规则在其后断裂且 tree-sitter 不输出残缺规则节点 → `localCommands` 为 0 → `scan.patterns` 空 → `:602` 静默返回 → 命令零权限审查直接执行。链式结构（`&&`/`;`）时 error recovery 偶尔借 pipeline_chain 恢复出 command 节点——形成"同形命令时而评审时而绕过"的彩票行为。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| PowerShell shell 下含引号外独立 `--` token 的任意命令（git commit/checkout/stash/log/diff -- path 等，近 7 天 222 条实测） | 模型 bash 工具调用 | 无（grammar 词法盲区） | parse → 0 command 节点 → patterns 空 → :602 | ShellTool collect/parse | observed |
| **紧邻分隔符的裸 `--`**（`--;`/`--&`/`--|`，如 `git checkout --;git reset --hard`） | 同上 | 无 | **部分恢复**：`--` 所在命令段从树中消失，patterns 非空但缺段 → ask 模式下审批证据缺失（比零 pattern 更隐蔽）；引号化后两段全恢复无 error（探针实证） | ShellTool collect/parse | observed（探针） |
| **有意零 pattern 类**：CWD 类（`cd .`）、FILES 类（仅 dirs）、空命令 | 同上 | 仓库契约（:42/:1013/:602 + 契约测试） | 零 bash ask 为设计行为 | —（不属缺陷域） | contracted |
| 注释类命令（`# comment`，PS grammar 0 command 且 hasError） | 同上 | — | 零 command 节点 → 归入 L2 兜底（原文 pattern 交 precheck，无操作命令分类为放行/未知，无权限放大） | ShellTool collect | reachable |
| 字符串/引号内的 `--`（`echo "a -- b"`） | 同上 | 引号内是数据 | 正常解析，patterns 正常 | — | observed（必须不受归一化影响） |
| PowerShell stop-parsing 序列 `--%` | 同上 | 语法保留字 | 正常解析 | — | reachable（归一化必须排除） |
| bash/cmd shell 下的 `--` | 同上 | bash grammar 接受 | 正常解析 | — | observed（探针 OK） |
| 其它 grammar 失败形态（未闭合引号等既有 :846 语义） | 同上 | 既有 opaque/general 语义 | patterns 可能空 → 同一 :602 | ShellTool collect | reachable（兜底须覆盖，非仅 `--`） |
| 风险构形（$() 命令替换、反引号、子 shell）出现在 pattern 文本 | 归一化/兜底产出的 pattern | precheck tokenize 自带替换边界与 taint 处理（:655-768） | ask → precheck evaluateShell 精确分级 | PermissionPrecheck（既有 owner） | contracted |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | grammar 解析失败（零 command 节点）的**非空命令**必须以原文兜底 pattern 进入 ask；**有意零 pattern 类**（CWD/FILES/空/注释类中不产生 command 节点者）保持既有零 bash ask 行为不变 | 事故实证（3 次零 ask commit）；cd-only 契约测试 :1716-1735；兜底不得扩大审批面 | 本计划新增（当前无）；cd-only 既有契约测试保持绿 |
| INV-02 | 分类精度不降级：`git commit -- paths` 修复后必为 cautious（classifyGit 既有判定），`git log -- paths` 为 safe；不新增"解析失败→整体 cautious"通道 | 用户原话 R-REQ-2；precheck 实测全形态判级正确 | 本计划新增精度锁 |
| INV-03 | 执行语义零变化：实际执行命令保持原始文本；归一化仅作用于权限解析（compatibility+collect）的 parse 输入 | 先例 :1399 inline-python 的解析/执行分离；用户 R-REQ-3 | 既有 shell.test.ts basic/执行类回归 |
| INV-04 | 既有 pattern 消费面兼容：ruleset 通配匹配（`git commit *` 前缀）、`BashArity.prefix` always 建议、raw deny 证据（`GITHUB_TOKEN=*` 类）不因引号化 `--` 改变命中 | shell.ts:1014-1024（前缀取自首 token）、precheck tokenize（引号字符串正常解析） | 既有 shell.test.ts pattern 组（:378-454） |
| INV-05 | 字符串内 `--`、`--%`、`--flag` 不被归一化触碰（数据/保留字/带参 flag 三类豁免） | §6 reachability 行 2/3 | 本计划新增豁免锁 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01（零节点面） | PowerShell grammar 对裸 `--` 无词法归类 → `command` 规则断裂 → `localCommands(root)=0` → `scan.patterns` 空 → `ask:602` 无条件 return | `ShellTool` 的 parse/collect/ask 链（shell.ts） | 同版本 wasm 探针：`echo --` 树中 `--` 无节点；`git commit -m "a" -- x.ts` 0 command 节点；DB 222 条/7 天绕过 + 3 次零 ask commit 事故 |
| INV-01（缺段面） | 紧邻分隔符的 `--` 使 error recovery **丢弃所在命令段**（`git checkout --;git reset --hard` 仅恢复 reset 段）→ patterns 非空但审批证据缺段；引号化后两段全恢复（探针） | 同上 | 探针：裸形态 local=1（仅 reset）/引号形态 local=2 无 error |
| INV-02（精度侧） | 即便有人想修，唯一现成出口是把空 patterns 填成 cautious——被用户原话与仓库哲学双重禁止；精确出口（grammar 恢复 + precheck 独立分类）都存在且未被使用 | 同上 | precheck tokenize 对全部实验形态分级正确（cautious/safe 各归其位） |

Red-capable feedback loop（bug 类）：

- **诊断环（已实际运行，本计划 §4 探针）**：仓库同版本 tree-sitter-powershell wasm 直接解析事故命令 → `FAIL [0]`（0 command 节点）。捕获原始症状：零权限 ask。
- **实施环（TDD 红测，packages/opencode 目录）**：`bun test test/tool/shell.test.ts -t "bare double dash"` —— [pwsh] 变体当前红（零 bash ask / patterns 空），修复后绿。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| parse 输入词法归一化（`--` → `"--"`） | `ShellTool`（shell.ts 新私有函数，ps 分支） | 为 grammar 提供可解析输入；仅解析用，执行不变 | 解析输入的构造者即 owner；先例 :1399 | precheck 不做 tree-sitter 解析（:1506 禁令）；上游 grammar 不可改 |
| patterns 非空兜底 | `ShellTool.collect`（尾部一条 guard） | 非空命令至少一个 pattern 进入 ask | collect 是 patterns 的唯一产出点；空放行点 :602 在同模块 ask | — |
| pattern → 风险分级（cautious/safe/dangerous、$()/反引号/taint） | `PermissionPrecheck`（既有，不动） | evaluateShell 精确分级 | 既有 owner，实测正确 | 在 shell.ts 重复实现即违反"上游保证不得下游重复" |
| `--%`/引号内 `--` 豁免 | 归一化函数自身 | 只改写引号外独立 `--` token | 词法状态机自含 | — |

## 10. Single Approved Primary-Path Design

一条权威路径：**让解析恢复精确产出（L1），并给 patterns 一个非空下限通道（L2），分级始终交给既有 precheck owner**。

```text
execute(params.command)
  const parseInput = ps ? normalizeBareDoubleDash(params.command) : params.command   [L1]
  -> parse(parseInput, ps)          // compatibility + collect 同一树；执行仍用 params.command
  -> collect(...)                    // 既有 per-command patterns（含 always/raw/dirs）不变
       const locals = localCommands(root)  // 既有迭代改为先取列表（同一函数，零语义变化）
       // 既有循环 ... 后：
       if (scan.patterns.size === 0 && locals.length === 0 && parseInput.trim())     [L2]
         scan.patterns.add(parseInput.trim())  // 原文兜底：仅真解析失败（零 command 节点），
                                                // 不触碰 CWD/FILES 有意零 pattern 类；分级交 precheck
  -> ask(...)                       // :602 空集早退对有意零 pattern 类保持可达（契约不变）
  -> run(params.command)             // 执行原文不变
```

**L1 `normalizeBareDoubleDash`（约 30 行）**：单遍字符扫描（引号状态机：`'`/`"`/`` ` `` 进入并计数转义），仅在"引号外、两侧均为 token 边界（空白/串首/串尾/分隔符 `;` `&` `|`）"处把 `--` 改写为 `"--"`。豁免：`--%`（PS stop-parsing 保留字）、任何 `--x` 带 sequel 字符形态（天然不满足独立 token 判定）。仅 `ps===true` 时调用（bash grammar 免疫，探针实证）。

**L2（collect 尾部 2 行 guard）**：兜底 pattern 使用**归一化后解析输入的 trim 原文**（`parseInput`）——precheck 手写 tokenizer 对原文（含 `--`、`$()`、反引号）精确分级；该通道是"进入分类的保底入口"，不是 cautious 通道——满足 R-REQ-2"不得粗暴 cautious"。L2 覆盖一切残余 grammar 失败形态（未闭合引号等），不只 `--`。

**为何修复 first divergence**：L1 消除 `--` 词法盲区 → command 规则闭合 → patterns 按既有精确路径产出（INV-02 由 classifyGit 等既有规则保证）；L2 封死 :602 的空集放行（INV-01 对一切残余失败形态成立）。两层各一条分支，无平行实现、无 fallback 成功路径——L2 不是成功捷径，是把命令送进既有分类 owner 的保底入口。

**性能**：L1 为 O(n) 单遍扫描，仅在含 `--` 子串时快速路径预判（`command.includes("--")` 早退）；解析次数不变（仍一次 parse）。

**Secondary path 分类**：L1/L2 均为 primary contract 内的确定性变换与 guard，非备用成功路径；无新增诊断面。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| per-command patterns（既有） | current | primary-contract branch | — | 主 | preserve |
| L1 归一化后同路径 | proposed | primary-contract 的输入预处理（先例 :1399 同构） | — | 0 新分支（纯函数 + 1 调用点） | add |
| L2 原文兜底 pattern | proposed | primary-contract 的非空下限 guard（仅零 command 节点形态） | no（只保证进入分类） | 1 条 guard | add |
| "空→整体 cautious" | — | forbidden fallback（用户原话禁止） | — | — | reject |
| CWD/FILES 有意零 pattern | current | primary-contract branch（契约行为，cd-only 测试锁定） | — | 既有 | preserve |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 无既有代码级 workaround（缺陷为纯漏洞，非补偿逻辑） | — | — | — |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| R-REQ-1 / INV-01 | L1 归一化 + L2 兜底 | shell.ts | 测 A1/A2（[pwsh] `git commit … -- paths` 产出含 git 前缀 pattern 的 bash ask；当前零 ask 红）；测 E（[pwsh] `git checkout --;git reset --hard` 两段 pattern 均在——当前缺 checkout 段红）；测 D（残余零节点失败形态兜底，未闭合引号命令 patterns 含原文） |
| R-REQ-2 / INV-02 | patterns 交 precheck 既有分级 | 不改 precheck | 测 B（`git log --oneline -2 -- path` 修复后仍为安全类：ask 发生且 pattern 前缀 `git log`，配合 precheck 既有分级无需断言 cautious）；精度锁注释 |
| R-REQ-3 / INV-03 | 归一化仅入 parse | shell.ts | 既有 shell.test.ts basic/执行回归组原样绿（执行原文） |
| INV-04 | pattern 前缀 token 不变 | shell.ts | 既有 :378-454 pattern 组绿 + 测 A1 断言 `startsWith("git commit")` |
| INV-05 | 归一化豁免规则 | shell.ts | 测 C1/C2/C3（字符串内 `--` 不变形；`--%` 不改写；`--flag` 不动） |
| R-REQ-4 | — | — | 全量 §18 回归矩阵（含音频/opentui 无关性论证） |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| normalizeBareDoubleDash | R-REQ-1/INV-01 | 同版本 grammar 探针（`--` 无词法节点） | grammar 不可改；无任何现存输入预处理覆盖该形态 |
| parseInput 仅解析用（执行分离） | R-REQ-3/INV-03 | 先例 :1399 | 现代码 parse 与执行共用原始串——正是缺陷载体，不能沿用 |
| L2 patterns 非空 guard | R-REQ-1/INV-01 | :602 空集放行实证 | collect 现无任何兜底；ask 侧 return 不可作为分类入口 |
| 不在 shell.ts 做风险分级 | R-REQ-2 | precheck :655-768 既有 owner | 上游保证不得下游重复（policy） |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/shell.ts` | modify | ① 新私有 `normalizeBareDoubleDash`（引号状态机 + 分隔符边界 + 豁免）；② execute 内 ps 分支计算 `parseInput` 并用于 :1402 parse（执行/audit 元数据仍用原 command）；③ collect 内 localCommands 先取列表 + 尾部零节点兜底 guard；④ 中文注释 | +62 / -5（净 ~57） |
| `packages/opencode/test/tool/shell.test.ts` | modify（测试） | 测 A1/A2（-- 命令产出 ask+pattern）、B（log 安全类）、C1-C3（豁免）、D（兜底） | +85 |

生产 1 文件（≤6 ✅）、净 ~57 行（≤600 ✅）。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 (A1) | [pwsh] `git commit -m "x" -- a.ts`：capture 收到 bash ask 且 patterns 存在前缀 `git commit` 的项 | 0 command 节点 → patterns 空 → :602 return，requests 空 | L1 ②③ | 既有 pattern 组 |
| 2 (A2) | [pwsh] `git commit --only -m "a" -m "b" -- p1 p2`（事故原形）：同上 | 同上 | L1 | — |
| 3 (B) | [pwsh] `git log --oneline -2 -- path`：ask 发生、pattern 前缀 `git log`（安全类精度锁：修复不得把它变 cautious——分级断言交 precheck 既有测试，此处锁 ask+形态） | 同上 | L1 | INV-02 |
| 4 (C1-C3) | `echo "a -- b"` pattern 不含 `"--"` 改写痕迹；`git push --% something` 不被改写（pattern 原样）；`git log --oneline` flag 不动 | —（豁免锁，随 L1 绿） | L1 豁免分支 | INV-05 |
| 5 (D) | [pwsh] 未闭合引号命令（如 `git commit -m "unclosed`）：patterns 非空（含 trim 原文）→ ask 发生 | 零 command 节点残余失败仍空集 | L2 | INV-01 全形态 |
| 6 (E) | [pwsh] `git checkout --;git reset --hard`：bash ask 的 patterns 同时含 `git checkout` 前缀与 `git reset` 前缀两项 | `--` 紧邻分隔符：error recovery 丢 checkout 段，patterns 仅 reset | L1 分隔符边界 | INV-01 缺段面；R1 审计 B-02 |
| 7 | 既有 shell.test.ts 全量（含 cd-only 契约 ：1716）+ precheck.test.ts + reviewer 相关回归 | — | — | INV-03/04、cd-only 契约、音频/opentui 无关性 |

公开 seam：`Tool.execute` → `ctx.ask`（capture 夹具，跨 shell 矩阵 `each`）；无私有函数断言、无源码文本断言。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~57 | shell.ts 净增；排除注释/空行 |
| Required Chinese explanatory comments `C` | ≥ 9（计划 11） | `ceil(57×0.15)=9` |

注释点：① `--` 词法盲区根因与 grammar 版本钉定依据；② 引号状态机的边界（为何 `'`/`"`/`` ` ``/转义计数）；③ 分隔符 `;&|` 作为 token 边界的依据（R1 审计 B-02 探针：裸形态丢段/引号化全恢复）；④ `--%` 与数据态 `--` 豁免的语法依据；⑤ 为何仅 ps 分支（bash grammar 免疫，探针证据）；⑥ parseInput 与执行的分离契约（INV-03，先例 :1399）；⑦ L2 兜底的语义定位（零 command 节点限定 + 进入分类的入口而非 cautious 通道，R-REQ-2 + cd-only 契约）；⑧ includes("--") 快速路径的性能动机；⑨ 测试意图（A1 红态即事故复现、B 是精度锁、E 是缺段锁）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/shell.test.ts` | packages/opencode | 全量 shell 回归（含新测 A-D）绿 |
| `bun test test/permission/precheck.test.ts` | packages/opencode | 分类层不受影响 |
| `bun test test/permission/` | packages/opencode | 权限组回归 |
| `bun test test/session/prompt.test.ts -t "auto permission reviewer"` | packages/opencode | 评审链路回归 |
| `bun typecheck` | packages/opencode | 类型门禁 |
| `bun test test/tool/` | packages/opencode | 工具组整体（覆盖音频无关性：本 diff 不触任何音频/opentui 路径——改动仅 packages/opencode/src/tool/shell.ts，与 audio/opentui 模块零交集，以路径证据+工具组绿论证） |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | — |
| Files modified（production） | 1 | shell.ts；≤6 ✅ |
| Files deleted | 0 | — |
| Production lines | ~57（净） | ≤600 ✅；甜点级：一个纯函数+一个调用点+一条 guard |
| Test lines | ~85 | 8 个断言面 |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

### Real risks（observed/reachable）

1. **归一化状态机边界**：嵌套引号/反引号/转义组合需正确（C1-C3 + 新增边界用例锁）；错误改写最坏影响是 pattern 文本变形（仍进 ask，不放大权限）——fail-safe 方向。
2. **raw deny 证据含引号化 `--`**：`GITHUB_TOKEN=*` 类 raw 规则匹配不受影响（实测形态前缀匹配）；如未来出现以 `--` 为锚的 deny 规则需改用 L2 原文通道——记录为已知边界。
3. **grammar 升级**（未来 tree-sitter-powershell >0.25.10 修复 `--`）：L1 变为无害幂等（`"--"` 双 grammar 均 OK，探针实证），可随版本移除——注释标注移除条件。

### Open Decisions Requiring the User

无——方案两层均在会话中与用户确认方向（"这种方案差不多可行"）后按其约束精简。

### Rejected Speculation

- "其它未知 grammar 毒物枚举防护"——不可枚举；L2 已对一切残余失败形态封底，枚举属 speculative。
- "在 shell.ts 识别 $()/反引号并升级 cautious"——precheck 既有 owner，下游重复被 policy 禁止。
- "bash/cmd 分支也加归一化"——bash grammar 免疫（探针），无证据支撑改动。
- "把 :602 空集改为直接 deny/cautious"——用户原话禁止的粗暴降级；:602 对有意零 pattern 类（CWD/FILES/空）保持既有契约可达。

## 21. Audit Contract

独立审计员必须：读取本文件与原始需求；从仓库证据重建行为；把 builder 摘要视为不可信；每轮完整原始范围审计；每个 blocking finding 附证据；同时检查 under-design 与 over-design；检查根因修复、fallback、owner、测试、代码质量与 15% 中文注释计划。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01：L2 空集兜底会打红既有 cd-only 契约测试（shell.test.ts:1716-1735，CWD 类有意零 pattern，:42/:1013/:602 契约路径）并扩大审批面，违反 R-REQ-4；B-02：L1 边界谓词仅空白/串首尾，漏 `--;`/`--&` 紧邻分隔符形态——探针实证裸形态丢 checkout 段（审批证据缺段），引号化后两段全恢复，「完整解决 -- 盲区」对该子类为假 | N-01：哲学注释引用漂移（实为 auto.ts:73-75）；N-02：raw 证据将含引号化 `--`（仅影响以裸 `--` 为锚的显式 deny 规则，已记边界）；N-03：零可审查内容类需在 §6 显式分类（已补注释类行） | BLOCK（修订 R2：L2 条件改为零 command 节点（locals.length===0）；L1 边界谓词扩分隔符 `;&|`；§6 域表补紧邻分隔符/有意零 pattern/注释类三行；§7/§8 重写 INV-01 与根因双面；§16 增测 E；N-01 引用更正） | task ses_fa16b3caaffe4gPC5qcD4205X1 |
| 2 | R2 | yes | 无（No blocking findings） | N-01 precheck:1506 引用误植（已随本 verdict 更正为职责分界实证表述）；N-02 "FILES 类"措辞应为 CWD 子集（已更正）；N-03 L2 对零 command 节点非空输入（注释/纯赋值类）有意扩审批面（需实施报告复核）；N-04 INV-02 精度为结构性锁定（precheck 既有 + metadata.command 原文链路），可选直接分级断言；N-05 §15/§17 E 值口径漂移（实施时按实际 diff 重算） | APPROVE（仅限 R2） | task ses_fa1574ed6ffeASlpurJT9hkbsx |

## 23. Implementation Evidence

### Actual Files and Diff

生产（1 文件，+68/-3）：
- `packages/opencode/src/tool/shell.ts`：① `normalizeBareDoubleDash`（引号状态机：`'`/`"`/`` ` `` 三态，双引号内 bash 反斜杠/PS 反引号双转义接受，过度保守方向 fail-safe）+ `isTokenChar`（分隔符 `;&|` + 空白为边界）；② execute 内 `parseInput = ps ? normalizeBareDoubleDash(params.command) : params.command`，parse/compatibility/collect 用 parseInput，执行与 audit 元数据保持原文；③ collect 增 parseInput 参数 + `locals = localCommands(root)` 先取列表 + 尾部零节点兑底 guard。

测试（1 文件，+241）：测 A1/A2/B/E/D + C1/C2/C3 × 2 pwsh 变体（16 个新 it.live），全部走 `fail+capture` 停止模式，断言 bash ask 存在、前缀形态与豁免不改写。

### Red-Green Test Evidence

- A1/A2/B（零 ask 事故形态）：红（bashReq undefined）→ 绿。
- E（缺段锁，R1 审计 B-02）：红（仅 git reset 段）→ 绿（checkout+reset 两段均在）。
- D（零节点兑底）：红（无 ask）→ 绿（原文 pattern 进入 ask）。
- C1-C3（豁免锁）：实现审计 round 1 B-01 补齐为独立公开 seam 用例（[pwsh] `echo "a -- b"` 引号内不改写、`git push --% --force` 保留字原样、`git log --oneline` flag 不引号化），全绿；实现审计 round 2 证实其敏感性（删豁免分支会红）。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/tool/shell.test.ts` | packages/opencode | 202 pass / 0 fail（含 cd-only 契约 + 16 新测：A1/A2/B/E/D + C1/C2/C3） |
| `bun test test/permission/` | packages/opencode | 278 pass / 0 fail（6 文件） |
| `bun test test/session/prompt.test.ts -t "auto permission reviewer"` | packages/opencode | 8 pass / 0 fail |
| `bun typecheck` | packages/opencode | clean（tsgo --noEmit） |

音频/opentui 无关性：本 diff 仅触 `packages/opencode/src/tool/shell.ts`（权限解析输入预处理）与测试，与 audio/opentui 模块零交集；上述四组全绿佐证。

### Original Feedback-Loop Result

诊断环（同版本 wasm grammar 探针）实证的两种失效形态（零 command 节点 / 紧邻分隔符丢段）分别由测 A1-D / 测 E 捕获并转绿；生产事故原形（`git commit --only -m … -- <paths>`）即测 A2。

### Actual Secondary and Replacement Path Inventory

新增决策面：normalizeBareDoubleDash（纯函数）+ parseInput 三元（1）+ collect 零节点 guard（1）。与 §11 一致；无未分类成功路径；CWD/FILES 有意零 pattern 类行为不变（cd-only 契约续绿）。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 40 | shell.ts 新增 65 行中扣 25 注释、0 空行 |
| Qualifying Chinese comment lines `C` | 25 | grammar 根因/版本钉定、状态机边界与转义取舍、分隔符边界依据（B-02 探针）、ps-only 依据、解析/执行分离契约、兑底语义（零节点限定 + cd-only 契约）、快速路径 |
| Ratio `C / E` | 0.63 | — |
| Required minimum `C` | 6 | `ceil(40×0.15)=6` |

### N-03 复核（R2 审计遗留）

零 command 节点非空输入（注释/纯赋值类）确实新增 ask：196 全量测试无任何既有测试断言此类零 ask（auditor R2 已扫描 + 本轮全量绿双重复核）；precheck 对此类原文分类为 general/safe，无权限放大。

### Remaining Unverified Items

- cmd.exe shell（bash grammar 路径）下 `--` 免疫由探针实证 + `each` 矩阵间接覆盖（win 矩阵含 cmd）；无直接 cmd-only `--` 用例（该路径未被修改，无新增风险面）。
- 上游 grammar 未来修复 `--` 后 L1 成为无害幂等（双 grammar 探针均接受 `"--"`），移除条件已在注释标注。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | B-01：INV-05 豁免锁（C1 引号内 `--`、C2 `--%`）为 approved R2 §13/§16 承诺的测试但未实现，全仓无任何等价覆盖（套件对引号状态分支删除不敏感），§23 "由既有 pattern 组回归覆盖"声明失实；实现本身经探针证实正确 | N-01 §23 省略 §18 tool-group 行（审计已补证：仅 shell/parameters 引用 shell.ts，四 seam 全绿）；N-02 L2 对零节点非空输入扩审批面（已批准边界，维持）；N-03 E 测试仅 `;` 变体（谓词与探针覆盖 `--&`/`--|`）；N-04 E/C 记录笔误（重算 E=40/C=25 生产，0.63）；N-05 quoted `"--"` 入 raw 证据（已记录边界） | BLOCK（补齐 C1/C2/C3 公开 seam 用例 + 更正 §23 覆盖声明与行数；shell 全量 202/0） | task ses_fa13b514bffeMOowUyqkcIKI8s |
| 2 | R2 | yes | 无（No blocking findings） | N-01 §23 记录过时（测试 +241/16 新测/202 pass；已随本 verdict 同步更正）；N-02 raw 证据含引号化 `--`（维持）；N-03 E 仅 `;` 变体（维持）；N-04 §10 边界措辞未含 `;&|`（R1 残留，已更正；§22/§16/实现一致）；N-05 全 diff 口径 C/E≈0.13（≥0.10 下限，<15% 目标） | APPROVE（仅限 R2 + 当前 diff：shell.ts +68/-3、shell.test.ts +241；独立复现 202/0、278/0、8/0、typecheck clean） | task ses_fa1262b6dffedgCrrVFx79pCpm |
