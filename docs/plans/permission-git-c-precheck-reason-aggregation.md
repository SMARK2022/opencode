# Canonical Implementation Plan: git -C 预检 reason 聚合与 inside/outside 精准分级

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: 用户 Session GOAL 原文（见第 1 节逐字引用）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-09-07

本文件是本任务的唯一实施规范。聊天摘要、被取代的修订与 builder 自述不构成实施授权。

## 1. Verbatim Requirement

> 优化并修改现有的opencode的git -C命令检查的reason提示不全问题，包括但不限于需要更加精准的-C检查剥离逻辑(如果inside+内部命令属于general及以下则默认无问题；如果outsideworktree或者有catious命令则需要提升到相应内容；也就是按照inside/out来进行匹配，同时内部也应当额外匹配)，同时一个命令理论上应当全部跑完同类全部匹配算法才将相应的reason合并（譬如一个命令如果不只是outside还是git风险操作，那最终的reason应当是两行），同时该逻辑适配于其他所有的内容，也就是一个层级检出应当等直到所有的cautious待检项检出之后进行reason的附加；同时需要确保修改后的内容更加精准而不是纯粹的放弃某些压缩路径；生产代码修改文件数不超过4个，生产代码修改行数不超过600行，同时需要避免最终要进行commit的代码出现红测，无论是陈旧红测还是新的红测，即测试有陈旧问题请优化测试，否则优化生产代码逻辑

补充约束（同会话用户原文，逐字）：

> 按照我的理解，整体的git -C命令其实本身并不是一个很严重的cautious的命令；因为理论上git -C其实只是换cwd，只是在检查到一些具有cautious的时候附加reason即可 …… 譬如只是git -C dir status；那本质只是一个完全的只读，尽管是在一个其他目录；但理论上全部都进行拦截会很大程度增加负担；或者如果你能准确检查对应的这个dir的位置是否在当前workdir区域内我也觉得可以

## 2. Explicit Non-Goals

- 不改变 reviewer policy_template.md 的 Judgment Scope 文案（前轮"VCS carve-out"措辞补丁已被用户否决，本任务以数据通道修复替代）。
- 不改变 `Decision = { level, reason: string }` 类型形状；不为 reason 引入数组字段。
- 不放弃现有压缩/短路路径：forbiddenRaw/dangerousRaw/cautiousRaw 的分层短路（evaluateShell :459-464）与 wrapper 载荷短路（:471-474）保持原样。
- 不做 symlink 真实解析（precheck 是纯同步无 I/O 契约，词法判定残留记入风险节）。
- 不改 auto.ts 路由、index.ts 缓存门、reviewer schema——level 集合语义不变。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| 根 AGENTS.md | 默认分支 dev；并行 agent 常驻（index.lock 竞争需等待重试） |
| packages/opencode/AGENTS.md | Effect/模块形态规范；本任务不新增模块，仅改既有函数 |
| packages/opencode/test/AGENTS.md | tmpdir fixture 可用于 cwd 相关测试 |
| CONTEXT.md | 领域词汇：precheck 五级（safe/general/cautious/dangerous/forbidden）为权限系统既有语义 |
| docs/adr/0001（triage） | 与本任务无直接关联，无适用 ADR |
| 提交 ea7c4f30e5（五级拆分） | forbidden/dangerous 拆分的既有架构，本任务不动该层 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| packages/opencode/src/permission/precheck.ts :27-29, :324-361, :450-553, :581-730, :1157-1266, :1395-1511 | Decision 类型、evaluate/bashEffect 入口、evaluateShell 段合并、raw 层、classifyTokens、classifyGit/gitSafe 全链 | observed |
| packages/opencode/src/permission/reviewer/prompt.ts :66-91 | reason 进入 reviewer 上下文的唯一呈现点（"Retry reason:" 标签） | observed |
| packages/opencode/src/permission/reviewer/service.ts :150-179, :91 | precheck.reason 传递链；Time advisory 独立通道（与标签零耦合） | observed |
| packages/opencode/src/permission/auto.ts :37-109 | reason 仅作展示/前缀拼接，无字符串等值消费 | observed |
| packages/opencode/test/permission/precheck.test.ts（git 断言面 :1055-1099, :1195-1197, :1290-1292 及全文 reason 断言核验） | 既有 git -C 断言全部 level-only；全文 reason 断言：:448/:1091（无 -C 路径）+ :148-186 六处 Windows 保护目录删除断言（均非 git 路径，不受本设计影响）[N-03 修正] | observed |
| packages/opencode/test/permission/reviewer-prompt.test.ts :69, :102-144 | 断言传入内容字符串而非 "Retry reason:" 标签；:69 为 system intro 不动 | observed |
| packages/opencode/test/session/prompt.test.ts :2160-2187 | Time advisory/600 words 断言走独立追加项，标签改名不触碰 | observed |
| 生产 DB（~/.local/share/opencode/opencode.db）reviewer 决策取证（2026-09-06~07） | 三次 `git -C … commit` 误放行 rationale 均在反驳弱 -C 信号后用 goal-level 推理补位；06:10-06:13 四次 reviewer 审查 `git -C .temp/API status/show/log`（inside 只读，纯负担） | observed |
| 红态探针 D:\Temp\opencode\gitc_red_probe.ts（2026-09-07 运行） | 10 条用例当前输出，见第 8 节 | observed |

## 5. Current Behavior

```text
bash tool 计划动作(metadata: {command, cwd, shell})
  -> PermissionPrecheck.evaluate (precheck.ts:324)
     -> externalDirectoryEffect / structuredFileEffect（先于 bash 层，跨区绝对路径已在此被独立治理）
     -> bashEffect (:341) —— 只取 metadata.command，cwd 未向下传递
        -> evaluateShell (:450)
           -> raw 层短路（forbidden/dangerous/cautious）
           -> wrapper 载荷短路 (:471)
           -> splitCommands 分段 -> evaluateCommand -> classifyTokens (:1157)
              -> cmd==="git" -> classifyGit (:1400)
                 -> while 扫全局 flag：命中 GIT_UNSAFE_GLOBAL 即早返回
                    {cautious, "git global flag redirects execution context"}
                 -> 子命令分类（reset --hard/状态变更表/config/remote/tag/branch…）
           -> 段合并 (:486-494)：forbidden>dangerous>cautious 各取 find(first)
  -> auto.ts 路由（forbidden→deny；dangerous→reviewer；cautious→reviewer/ask；general/safe→allow）
  -> reviewer: service.ts:166 buildUserPromptItems(transcript, request, precheck.reason)
     -> prompt.ts:82 "Retry reason:\n<reason>"（单字符串，reviewer 的唯一 precheck 知识）
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| `git -C <path> <sub>`（裸 -C + 独立实参） | bash tool 命令文本 | tokens 由 tokenize 产出 | classifyGit | precheck | observed（DB+测试） |
| `git -C<path>` / `git -c<conf>` 附着短形式 | 同上 | 同上 | classifyGit（当前漏检附着形，探针 #9 safe 直过） | precheck | observed（绕过） |
| `git -c/--config-env/--git-dir/--work-tree/--exec-path [值]` | 同上 | 同上 | classifyGit | precheck | observed |
| `git --no-pager …` 安全 boolean 前缀 | 同上 | 同上 | classifyGit while 循环 | precheck | observed |
| 链式 `;`/`&&`/`\|\|`/`\|` 多段（各段可独立命中 cautious） | splitCommands | 分段保序 | evaluateShell 合并 | precheck | observed |
| `metadata.cwd` 有/无 | bash tool 必带 cwd；其他调用方（测试/pattern 路径）可能缺失 | 无 | bashEffect 新读取 | precheck | contracted（approval JSON 实证 metadata 含 cwd） |
| `$VAR`/`~`/通配 -C 实参 | shell 展开前文本 | 静态不可解析 | membership 保守外部 | precheck | reachable |
| 相对路径 `..`/`a/../a`/`.` | 同上 | path.resolve 词法归一 | membership | precheck | reachable |
| win32 盘符大小写差异 | Windows 路径语义 | 大小写不敏感文件系统 | membership 折叠比较 | precheck | reachable |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 同一命令命中的全部同类规则信号必须出现在最终 reason（-C 重定向 + 子命令效应 + 链式各段，去重保序拼接） | DB 误放行根因：reviewer 只见 -C 弱信号 | 无（本任务新增） |
| INV-02 | `git -C <inside-cwd>` 且子命令为 general 及以下 → 与无 flag 同构（safe/general，零 reviewer 负担） | 用户原文"inside+general及以下默认无问题"；DB 负担取证 | 无（新增） |
| INV-03 | outside worktree 或注入 flag（-c/--git-dir/--work-tree/--config-env/--exec-path）→ 至少 cautious 且 reason 携带对应信号 | 用户原文"outsideworktree…提升到相应内容" | precheck.test :1073-1077（level） |
| INV-04 | 存在全局 flag 时子命令仍完整走既有 :1418-1463 分类（不被遮蔽） | 用户原文"内部也应当额外匹配" | 无（新增） |
| INV-05 | 段合并收集全部同层级 cautious/dangerous/forbidden reason 后拼接，层级优先序 forbidden>dangerous>cautious 不变 | 用户原文"所有的cautious待检项检出之后进行reason的附加" | 无（新增） |
| INV-06 | 附着短形式（`-Cdir`/`-cconf`）不得 safe 直过，按同一 membership/注入语义归类 | 探针 #9（safe 绕过实锤） | 无（新增） |
| INV-07 | `metadata.cwd` 缺失或 -C 实参静态不可解析 → 保守按 outside 处理（cautious） | fail-safe 既有哲学（opaque→general 同构） | :1290-1292（$REPO cautious） |
| INV-08 | 级别单调性与 raw 层短路保持：forbidden/dangerous 确定性短路、wrapper 载荷短路、maxRisk 取 max 均不变 | 用户原文"不是纯粹的放弃某些压缩路径" | precheck.test 既有 40+ 断言 |
| INV-09 | `git commit`（无 flag）的 reason 字节不变："git state-changing command requires explicit approval" | :1091 既有精确断言 | precheck.test :1084-1098 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/INV-04 | classifyGit :1406-1409——while 扫全局 flag 时命中 GIT_UNSAFE_GLOBAL 即 `return`，子命令分类（:1418+）永不执行，`git -C X commit` 只产 "git global flag redirects execution context" | precheck.ts classifyGit | 探针 #1；DB 三次误放行 rationale |
| INV-05 | evaluateShell :486-491——段合并 `find(first)` 只保留最高层第一个 decision 的 reason，链式其余段信号丢弃 | precheck.ts evaluateShell | 探针 #6（链式仅单 reason） |
| INV-02 | 同 classifyGit 早返回：inside 只读与 outside 同罪一律 cautious，无法豁免（且 cwd 根本未传入分类链） | precheck.ts bashEffect（未读 metadata.cwd）+ classifyGit | 探针 #3/#4 |
| INV-06 | flag 提取只做精确集合匹配（:1407 无附着短形式检测），`-Cpackages` 落入"安全 boolean"分支被跳过 | precheck.ts classifyGit flag 提取 | 探针 #9（safe 直过） |

根因：**单一 reason 数据通道 + 两处 first-wins 早返回**，使 reviewer 收到被任意截断的证据。下游症状（reviewer 用 goal-level 推理补位、发明默示批准）不是 reviewer 层缺陷。

红态反馈回路（已运行，2026-09-07）：

```text
命令: bun run D:\Temp\opencode\gitc_red_probe.ts   (cwd=packages/opencode)
观察（当前全红于新期望）:
 #1  git -C outside commit → {cautious, "git global flag redirects execution context"}   ← 丢 commit 信号
 #3  git -C inside status  → {cautious, 同上}                                            ← 应 safe
 #4  git -C . status       → {cautious, 同上}                                            ← 应 safe
 #6  链式 pull/add/commit  → {cautious, "git global flag redirects execution context"}   ← 应聚合双信号
 #9  git -Cpackages status → {safe}                                                      ← 附着形式绕过
```

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| -C 剥离与 membership 判定 | precheck.classifyGit | 产 level+完整 reason | 唯一拥有 tokens+cwd 的分类点 | reviewer 只消费 reason；bash tool 不做语义分类 |
| 链式段 reason 聚合 | precheck.evaluateShell | 同层级全量去重拼接 | 唯一看见全部段的合成点 | auto/reviewer 均在下游，无法重组已丢信息 |
| safe 防御层同步 | precheck.gitSafe | -C-inside 不拒、注入仍拒 | classifyGit 返回 undefined 后的 safe 判定守门人 | — |
| reason 呈现框架 | reviewer/prompt.ts | 多规则列表化 + strictest-wins 一句 | reviewer 上下文的唯一组装点 | 改 policy prose 属前轮已否决路线 |

## 10. Single Approved Primary-Path Design

```text
evaluate(input 含 metadata.cwd)
  -> bashEffect 提取 cwd?: string
  -> evaluateShell(command, depth, cwd)
     -> [raw 短路层不变] -> [wrapper 短路不变]
     -> splitCommands 分段 -> evaluateCommand(cmd, depth, cwd)
        -> classifyTokens(tokens, cwd) -> classifyGit(tokens, cwd):
             GIT_FLAG_STRIP（新纯函数，单一事实来源，classifyGit 与 gitSafe 共用）:
               while 扫全局 flag（支持 =附着 与 短选项附着 -Cdir/-cconf）:
                 -C（裸/附着/=-形）-> target = 实参；
                     redirectsInsideCwd(target, cwd) ? 无信号 : push("git -C redirects outside the working directory")
                 注入族(-c/--config-env/--git-dir/--work-tree/--exec-path) -> push("git global flag injects configuration or binary path")
               返回 { reasons[], subIndex }
             subDecision = 既有 :1418-1463 子命令分类（零改动，用 subIndex 定位 sub）
             合并: reasons 为空 -> subDecision（-C inside 与无 flag 完全同构）
                  subDecision 存在 -> { ...subDecision, reason: join([subDecision.reason, ...reasons], "\n") }
                  否则 -> { cautious, reasons.join("\n") }
     -> 段合并: 同层级(forbidden>dangerous>cautious)收集全部 decision，reason 去重保序 join("\n")
     [N-01] 分隔符用换行而非 "; "：逐字匹配用户原文「最终的reason应当是两行」——每条命中规则独占一行，
     reviewer 的信号边界更清晰；两处 join 保持同一分隔符。
  -> gitSafe(tokens, cwd)：-C 经同一 GIT_FLAG_STRIP/membership 判定，inside 不拒；注入族仍拒
  -> prompt.ts:82 标签改为 "Precheck matched rules (adjudicate at the strictest matched rule):\n<reasons>"
```

元数表（skip 语义）：

| flag | 裸形式 | 附着/=-形式 |
| --- | --- | --- |
| `-C` | 跳 2（flag+path） | 跳 1（`-Cdir`） |
| `-c` | 跳 2（flag+conf 对） | 跳 1（`-cconf=v`） |
| `--git-dir`/`--work-tree`/`--config-env` | 跳 2 | 跳 1（=自含） |
| `--exec-path` | 跳 1（可选参：裸形 print-and-exit 不消费子命令位） | 跳 1 |

membership（纯词法，无 I/O）：

```text
redirectsInsideCwd(target, cwd):
  cwd 缺失 | target 空 | 含 $ * ? ~  -> false（保守外部）
  abs = normalize(resolve(cwd, target));  base = normalize(cwd)
  win32: 大小写折叠后 abs===base 或 startsWith(base+sep)；POSIX: 严格字节
```

为何修复 first divergence：三处早返回（flag 遮蔽、段 first-wins、safe 层硬拒）全部替换为"先完整检出、后合并"，reviewer 数据通道从截断变为完备；inside 豁免直接落在 classifyGit 的合并规则里而非旁路。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| classifyGit flag 早返回 | current | primary-contract 内的缺陷分支 | yes（错误单信号） | 100% git 全局 flag 命令 | remove（被合并逻辑替代） |
| evaluateShell find(first) 合并 | current | 同上 | yes（丢信号） | 全部链式命令 | remove |
| raw 层 forbidden/dangerous/cautious 短路 | current | 压缩路径（用户明示保留） | yes | 高风险确定命中 | preserve |
| wrapper 载荷短路 :471-474 | current | 压缩路径 | yes | 包装器命令 | preserve |
| gitSafe :1502 全局 flag 硬拒 | current | 防御层 | no（safe 判定） | safe 回路 | preserve（-C-inside 豁免同步） |
| prompt "Retry reason:" 标签 | current | 呈现层 | no | reviewer 全部请求 | replace（matched-rules 框架） |
| policy VCS carve-out 措辞 | 前轮提案 | forbidden fallback（用户否决） | — | — | reject |

新增平行走廊：零。所有变更都在既有 classifyGit/evaluateShell/gitSafe/prompt 四个 owner 内。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| "git global flag redirects execution context" 一刀切 cautious | 补丁式治理无法区分 -C 与注入、inside 与 outside | membership + 注入分离后按语义精确归类 | classifyGit（reason 串拆分替换） |
| gitSafe 对全局 flag 的防御性硬拒 | classifyGit 曾保证先拦截 | classifyGit 不再一刀切，gitSafe 改用同一 GIT_FLAG_STRIP 保持两层一致 | gitSafe :1498-1503 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 完整 reason | classifyGit 合并 + evaluateShell 聚合 | precheck.ts | slice 1/6/9 |
| INV-02 inside 豁免 | membership + 合并规则空信号 | precheck.ts | slice 2/3 |
| INV-03 outside/注入提升 | membership 保守 + 注入 reason | precheck.ts | slice 4/7 |
| INV-04 子命令透传 | GIT_FLAG_STRIP 后接既有分类 | precheck.ts | slice 1/5/6 |
| INV-05 段聚合 | evaluateShell 同层收集 | precheck.ts | slice 9 |
| INV-06 附着形式 | flag 提取正则 | precheck.ts | slice 8 |
| INV-07 无 cwd 保守 | membership false 分支 | precheck.ts | slice 4 |
| INV-08 压缩路径保留 | 不触碰 raw/wrapper 层 | — | 既有 40+ 断言回归 |
| INV-09 无 flag reason 不变 | 合并规则 reasons 为空走原路 | precheck.ts | 既有 :1084-1098 回归 |
| 呈现框架 | matched-rules 标签 + strictest-wins | prompt.ts | slice 10 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| GIT_FLAG_STRIP 共享纯函数 | INV-02/03/04/06 | 探针 #1/#3/#9 | 现有两个消费点（classifyGit/gitSafe）各自为政且语义均错 |
| redirectsInsideCwd | INV-02/07 | 用户原文 membership 拍板；DB 负担取证 | 现代码根本不接收 cwd |
| 段聚合 join | INV-01/05 | 探针 #6 | find(first) 结构性丢信息 |
| prompt 标签句 | INV-01 呈现侧 | 本任务多信号需求的呈现侧必然要求（用户原文「全部…才将相应的reason合并/两行」）；用户前轮原话「多条规则命中按更严格者审」为辅助锚 | "Retry reason:" 语义误导且无多规则指引 |
| 注入 reason 新串 | INV-03 | -c hooksPath 执行面（classifyGit :1402-1403 既有注释） | 与 -C 混用一串无法区分语义 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| packages/opencode/src/permission/precheck.ts | modify | cwd 透传（evaluate→bashEffect→evaluateShell→evaluateCommand→classifyTokens/safeTokens）；GIT_FLAG_STRIP + redirectsInsideCwd + 注入/-C 语义分离 + 合并；evaluateShell 同层聚合；gitSafe 同步豁免 | +85/-30（净 ~55） |
| packages/opencode/src/permission/reviewer/prompt.ts | modify | :82 标签与一句 strictest-wins 指引 | +2/-1 |
| packages/opencode/test/permission/precheck.test.ts | modify | cwd-aware helper + 新 slice 断言 + 旧 -C 断言 reason 无断言无需动 | +~90 |
| packages/opencode/test/permission/reviewer-prompt.test.ts | modify | 标签断言同步 | +2/-0 |

生产文件 2 个（≤4 ✓），生产行数 ~58（≤600 ✓）。

## 16. TDD Behavior Slices

公共 seam：`PermissionPrecheck.evaluate({permission:"bash", patterns, metadata:{command, cwd?}})`。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `git -C <outside> commit -m x`（cwd=固定目录）reason 同时含 "state-changing command" 与 "redirects outside" | flag 早返回吞子命令 | GIT_FLAG_STRIP+合并 | DB 误放行类 |
| 2 | `git -C . status` → safe | 早返回一律 cautious | membership inside | 只读负担类 |
| 3 | `git -C packages/opencode status`、`git -C a/../a status` → safe；win32 大小写变体仅在 `process.platform === "win32"` 门内断言（POSIX CI 不跑折叠用例，防平台红测）[N-05] | 同上 | resolve+normalize+折叠 | 词法边界 |
| 4 | `git -C .. status`、`git -C "$REPO" status`、无 cwd 元数据 → cautious 且 reason 含 "outside" | 同上（保守分支） | false 分支 | :1290-1292 语义 |
| 5 | `git -C <inside> commit` → cautious 且 reason 仅 "git state-changing command…"（无 redirect 附加） | 同上 | 空信号合并 | inside+写操作 |
| 6 | `git -C <outside> reset --hard` → reason 含 "destructive git reset"+"outside" | 同上 | 合并序 | 高风险组合 |
| 7 | `git -c core.hooksPath=/h status`、`git --git-dir=/x status`、`git --exec-path st` → cautious 且 reason 含 "injects" | reason 串语义 | 注入族 | :1075 语义升级 |
| 8 | `git -C<outside>dir status` 附着 → cautious；`git -C<inside>dir status` → safe | 附着形式漏检（#9 绕过） | 附着正则 | 绕过闭合 |
| 9 | 链式 `git -C <outside> pull; git -C <outside> add f && git -C <outside> commit` → reason 聚合去重含两信号 | find(first) | 段聚合 | INV-05 |
| 10 | buildUserPromptItems 输出含 "Precheck matched rules" 与 "strictest matched rule" | 标签不存在 | prompt.ts | 呈现框架 |

每 slice 独立期望值（字面量字符串），不复现实现逻辑。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~55 | 排除空行/import/纯移动 |
| Required Chinese explanatory comments `C` | ≥ max(1, ceil(55×0.15)) = 9 | 邻近修改点 |

注释点：GIT_FLAG_STRIP 元数表与 --exec-path 可选参例外；-C 与注入族语义分离理由；membership 纯词法契约（无 I/O）+ win32 折叠 + symlink 残留；附着短形式检测；段聚合去重保序不变量；gitSafe 两层一致性；INV-09 字节不变约束；prompt 标签语义；保守外部 fail-safe。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| bun run D:\Temp\opencode\gitc_red_probe.ts | packages/opencode | 原始反馈回路：10 用例全绿于新期望 |
| bun test test/permission/precheck.test.ts | packages/opencode | slice 红→绿 + 既有 115 断言零红 |
| bun test test/permission/reviewer-prompt.test.ts | packages/opencode | slice 10 + 既有断言零红 |
| bun test test/permission/ | packages/opencode | 权限全组（~290）零红 |
| bun test test/session/prompt.test.ts | packages/opencode | reviewer 集成（Time advisory 等）零红 |
| bun typecheck | packages/opencode | 类型零错 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | — |
| Files modified（生产） | 2 | precheck.ts + prompt.ts |
| Files modified（测试） | 2 | 对应两个测试文件 |
| Files deleted | 0 | — |
| Production lines | ~58 | 用户预算 ≤600 |
| Test lines | ~95 | — |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

### 真实风险

- session-cache 值仅为 allow/deny 布尔（session-cache.ts:5），不携带 reason，不存在旧 reason 展示残留；缓存键含 cwd（:66），inside 豁免不会跨目录放大旧缓存批准。[N-04 纠错]
- symlink 指向 cwd 外的目录会词法判 inside：只读子命令场景危害为读到自己 symlink 指向的仓库，记为已接受残留（precheck 无 I/O 契约优先）。
- `git --namespace <arg>` 等极少数吃参安全 flag 误将实参当子命令：既有文档化局限，本任务不改（:1410-1412 注释既有）。

### Rejected Speculation

- "reviewer 需要结构化 reasons 数组"——拼接串已满足唯一消费点（prompt 标签），类型改动波及 5+ 文件无证据支撑。
- "wrapper 层也需聚合"——单命令多可见包装载荷无观测实例，保持压缩路径。
- "prompt 需要逐规则 bullet 列表"——reason 内已含 "; " 分隔，标签句足够。

### Open Decisions Requiring the User

无（membership 边界与注入语义用户已在前轮拍板）。

## 21. Audit Contract

独立审计者必须：

- 阅读本文件与本任务原始需求原文。
- 从仓库证据重建行为，视 builder 摘要为不可信。
- 每轮审计完整原始范围；每个 blocking finding 附证据。
- 同时检查 under-design 与 over-design。
- 检查根因修复、fallback、owner、测试、代码质量与 15% 中文注释计划。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 无 | N-01 分隔符用 "\n" 匹配「两行」；N-02 :79 术语漂移（保留不改，断言锚）+ §14 依据重锚；N-03 :148-186 六处 reason 断言补记；N-04 session-cache 风险注纠错；N-05 slice 3 win32 平台门 | APPROVE | task ses_f84e8d158ffeakqCTJPKkUolDr (2026-09-07, 全范围独立重建证据) |

审计后按合同折入 N-01/N-03/N-04/N-05 与 §14 重锚（N-02 保留 :79 原文不动，系测试断言锚点）：非阻塞记录修正不清空 approval；join 分隔符修正系逐字匹配用户需求的记录纠偏，非设计转向。

任何实质修订使既有 approval 失效。

## 23. Implementation Evidence

### Actual Files and Diff

- packages/opencode/src/permission/precheck.ts：+166/-60（cwd 透传链、GIT_INJECTION_GLOBAL/gitFlagKind/gitRedirectTarget/redirectsInsideCwd、classifyGit 拆分 classifyGitSubcommand+合并、evaluateShell 同层聚合、gitSafe while 重写、盘符相对剥损保守 guard、tokenizeRich per-token 剥损标记透传、未知前缀透传路径 strippedPrefix 重命名补齐、node:path import）
- packages/opencode/src/permission/reviewer/prompt.ts：+4/-1（matched-rules 标签 + strictest-wins 指引）
- packages/opencode/test/permission/precheck.test.ts：+65（新 slice 测试块，含平台可移植 fixture、剥损形态断言与单引号/正斜杠对照组）
- packages/opencode/test/permission/reviewer-prompt.test.ts：+22（标签框架测试）

### Red-Green Test Evidence

- 红：新 slice 测试先行写入后运行 `bun test test/permission/precheck.test.ts` → 1 fail（新测试）/115 pass；`reviewer-prompt.test.ts` → 1 fail/19 pass（红因：无 membership、无多信号、无标签）。
- 绿：实施后 116/116、20/20。
- B-01 返工：fixture 改 resolve 锚定平台绝对路径后曾出现本地 1 红（win32 反斜杠 fixture 被 tokenize POSIX 转义剥成盘符相对剥损形态，误判 inside）；根因修复为 redirectsInsideCwd 增加盘符相对剥损保守 guard（剥损只会多审不会漏审），fixture 改正斜杠形式使 prefix 判定独立受测，新增剥损形态两条断言，回到 116/116、20/20。
- B-01r2 返工：盘符 guard 不完整——反斜杠相对路径剥损（..\other → ..other 被 win32 resolve 挂回 cwd 内）仍误判 inside。根因修复在拥有剥损知识的 seam：tokenize 拆出 tokenizeRich 返回 per-token 剥损标记（tokenize 保持兼容壳供既有两消费点），evaluateCommand/classifyTokens/classifyGit/safeTokens/gitSafe 透传，-C 目标 token 被剥损即保守 outside（含双引号内形态）；新增剥损回归断言与单引号/正斜杠对照组，全部验证重跑绿。

### Verification Commands and Results

| 命令 | cwd | 结果 |
| --- | --- | --- |
| bun test test/permission/precheck.test.ts | packages/opencode | 116 pass / 0 fail（B-01 返工后重跑） |
| bun test test/permission/reviewer-prompt.test.ts | packages/opencode | 20 pass / 0 fail |
| bun test test/permission/ | packages/opencode | 292 pass / 0 fail（6 文件，B-01r3 修复后重跑） |
| bun test test/session/prompt.test.ts | packages/opencode | 97 pass / 0 fail / 111 tests（14 skip，B-01r2 后重跑；B-01r3 仅改一行模板插值不在该套件路径上） |
| bun typecheck（tsgo --noEmit） | packages/opencode | **B-01r3 修复后 exit 0 零错**（r2 轮曾因输出行数误读为干净而虚报——实测当时 exit 2 TS2339，已在 §24 记录；修复后以实际输出+退出码验证） |
| node:path.posix 分支探针 D:\Temp\opencode\posix_membership_probe.ts | packages/opencode | 7/7 OK（B-01 fixture 修复的 POSIX 确定性验证；盘符 guard 为平台无关正则，剥损断言两平台同令牌确定性） |
| B-01r3 修复验证探针 D:\Temp\opencode\r3_probe2.ts | packages/opencode | 3/3：未知前缀透传路径 reason 携带真实内层决策（不再 undefined），含剥损形态穿透剥头路径 |

### Original Feedback-Loop Result

`bun run D:\Temp\opencode\gitc_red_probe.ts`（cwd=packages/opencode）：10/10 达新期望——#1 双信号两行、#3/#4 inside 只读 safe、#6 链式聚合双信号、#7 无 cwd 保守 outside、#8 注入语义串、#9 附着形式随 membership（inside→safe）、#10 $VAR 保守 outside。

### Actual Secondary and Replacement Path Inventory

- raw 层/wrapper 短路/maxRisk：未触碰（preserve）。
- gitSafe 防御层：与 classifyGit 共用 gitFlagKind/gitRedirectTarget/redirectsInsideCwd 同一事实来源（collapse，非平行实现）。
- classifyGit flag 早返回/find(first) 合并/GIT_UNSAFE_GLOBAL：已删除（remove）。
- "Retry reason:" 标签：已替换（replace）。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 175 | 实现审计 r3 独立重算口径：生产 115 + 测试 60；排除 import 1、空行、注释 |
| Qualifying Chinese comment lines `C` | 70 | 生产 47 + 测试 23；membership 词法契约/盘符剥损 guard/per-token 剥损标记语义与 seam 归属/win32 折叠/保守分支、注入二分、附着归一化、元数表与 --exec-path 例外、合并规则与「两行」、段聚合全量收集、gitSafe 防御一致性、cwd 基准、prompt 标签动机、fixture 平台可移植理由、剥损/对照组断言意图 |
| Ratio `C / E` | ~40% | `N/A` when `E = 0` |
| Required minimum `C` | 27 | `E > 0: C >= max(1, ceil(175*0.15))=27` |

### Remaining Unverified Items

- 无（全部验证命令绿；symlink 逃逸与 --namespace 误判为计划内已接受残留/既有局限）

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 新测试块 fixture 硬编码 win32 专属 cwd，POSIX CI（ubuntu/macOS 必过核心测试）5 断言红，违反无红测硬约束 | N-01 §23 数字漂移（+135/-49 vs 实际 +129/-53）；N-02 :1091 引用漂移（实为 force-push 断言）；N-03 远程包装器载荷以本地 cwd 为 membership 基准的观察（owner 已记录，仅观察） | BLOCK | task ses_f84b70b54ffew3GMeXOMGUItTo（含中断后续起，2026-09-07） |
| 2 | R1 | yes | B-01r2 盘符剥损 guard 不完整：反斜杠相对路径剥损（..\other → ..other）误判 inside，`git -C ..\other status` / `..\..` safe 直过漏审（本次 diff 新引入，INV-03/07 违反） | N-01r2 §23 E/C 表未刷新（重算 E=146/C=58）；N-02r2 POSIX 冒号文件名过度保守（fail-safe 方向已接受）；N-03r1 复验未变（远程包装器本地 cwd 基准，仅观察） | BLOCK | 同 task（round 2，2026-09-07，含真实 seam 复现探针） |
| 3 | R1 | yes | B-01r3 重命名漏改 :558 `stripped.reason`（现为 boolean[]）→ typecheck exit 2 TS2339（CI typecheck 作业必红）+ 未知前缀透传路径 reason 退化为字面量 undefined | N-01r3 §23 E/C 重算 E=175/C=70/40%；N-02r3 双引号反斜杠过度审查（已接受方向）；N-03 未变（远程包装器，仅观察） | BLOCK | 同 task（round 3 终轮，2026-09-07，typecheck 复现+运行时探针） |
| 4（全新会话终审） | R1 | yes | 无 | N-01 同类 flag 重复时 reason 重复行（段合并层去重已足够，无信号损失）；N-02 远程包装器本地 cwd 基准（保守方向，owner 已记录）；N-03 §23 E/C 估算漂移（审计重算 E≈175/C≈64，两种口径均过门）；N-04 实现命名与 §10 GIT_FLAG_STRIP 形状漂移（语义同一、双消费点共享单一事实来源） | APPROVE（No blocking findings） | task ses_f83d8700effee2221cDyzKdgzF（2026-09-07，独立重跑 136/0+292/0+97/0/14skip+typecheck exit 0+原始回路 10/10；三项历史 blocker 均在 owner 处验证修复而非掩盖） |

B-01 返工（同 owner 测试文件 + membership 生产 guard）：fixture resolve 锚定平台绝对路径；返工中发现并根因修复 tokenize 剥损孪生问题（盘符相对剥损形态保守 outside guard，剥损只会多审不会漏审）；新增剥损形态断言；全部验证命令重跑绿。N-01 已按审计口径修正 §23。N-02 确认：无 flag 字节不变由 reasons 为空分支结构保证且有 inside 单行断言钉住。N-03 记录为观察（owner：remote 递归调用点，若收紧传 undefined 即可，无需新机制）。

B-01r2 返工（auditor 指定方向：剥损事实归属 tokenize→classifyGit seam）：tokenizeRich per-token 剥损标记（tokenize 兼容壳零波及其他消费点）→ evaluateCommand/classifyTokens/classifyGit/safeTokens/gitSafe 透传 → 被剥损的 -C 目标一律保守 outside；双引号内反斜杠同样剥损同样保守（POSIX 双引号转义与 tokenizer 语义一致，pwsh 字面量语义下属过度保守已接受方向）；单引号字面量与正斜杠形式保持真实 membership。剥损回归断言 5 条 + 对照组 2 条。全部验证重跑绿（292/0、97/0/14skip、typecheck 零错、原始回路 10/10）。N-01r2 已刷新 §23。

B-01r3 返工（单 token 机械修复）：:558 插值改 `${strippedPrefix.reason}`；重跑 bun typecheck exit 0（实际输出+退出码验证，非行数猜测）；r3_probe2 3/3 验证未知前缀透传路径 reason 完好（含剥损形态穿透剥头路径）；116/0、292/0。同时诚实记录：r2 轮 §23 的「typecheck 零错」系输出行数误读的虚报，r3 审计以 exit 2 实锤后本表已纠正为以退出码为准。轮次上限 3/3 已用：按 r3 审计意见，对修正后代码树发起全新独立审计，终审 APPROVE。

仅当当前实现与已批准 plan revision 获得独立全范围 `No blocking findings` 后方可标记 verified。
