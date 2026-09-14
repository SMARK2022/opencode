# Canonical Implementation Plan: forbidden 删除族精准分级与终审文案修正

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: 用户会话原文（见第 1 节逐字引用）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-09-07

本文件是本任务的唯一实施规范。聊天摘要、被取代的修订与 builder 自述不构成实施授权。

## 1. Verbatim Requirement

> 西米请你看一下这个内容是怎么回事儿，它是误检吗，还是说怎么回事儿？我昨天发现它一直有问题。（指 `wsl -- bash -lc 'rm -rf /usr/local/libexec/.linkd'` 与其叶子变体被 "critical recursive delete" forbidden 拦截）
> 而且对于这种 forbidden 的东西，理论上来讲，应当它的提示词都有问题，ask the user for confirmation。但是其实这种命令，本质问用户是都不要通过。所以看一看，只读调研……以及如果要修改的话怎样修改，把这个内容会变得更精准，更准确。

> 完整全面分析分析类似的这种过度宽泛的匹配规则，看一看还有没有其他地方也有这种规则，请全面完整去检查一下。然后按照我的理解，这个内容，就是理论上说直接删除整个这个 user 文件夹，或者删除什么文件夹，才会被视为 forbidden，否则就是正常的 cautious，或者说一个 dangerous。……直接删除 user local 是 forbidden。然后与此同时呢，你说的这个东西，ETC 的子树，ETC 子树我觉得可以变成 dangerous。对，dangerous。然后写上那个，就是需要显示授权。……reason 有一点点短，而且就没有任何这种表示性的一个标准含义，就是 critical recursive delays……模型可能根本就不知道这是什么意思……就比如说 critical recursive delays are forbidden。……就是根目录的一个删除，就这么一个意思。然后类似的请你也完整检查其他内容。然后 ETC SSL 等等这种内容仍然是属于 forbidden，然后再往下的这种子树，可能才是一个 cautious。

> 你这个文案 asks the user for explicit confirmation，这个东西不行啊。……你应该表达，这种情况即使用户授权都无法执行。而且你那个 choose a materially safer approach，这个东西不是已经，后面不是已经有那个提示了吗？

> 按照之前 Plan 的格式，请你将上述全部完整内容修订……写入一个新的 Plan 中。生产文件代码修改数不超过六个文件，生产代码修改行数不超过800行。……你判定这几个规则如果过宽的话，请你适当进行相应的优化，就譬如说，/usr/** C:\User\*\*等等

## 2. Explicit Non-Goals

- 不动 cautious 敏感读取层（readsSensitivePath 族）宽度。
- 不动 RE_D_KILL_ALL（需 -9/-1 双 flag 同段，宽度正确）、RE_D_WINDOWS_FORMAT（format 以盘为对象）、反弹 shell 族、mkfs 族全形态 forbidden、`dd of=/dev`。
- 不动 `/root` 子目录不保护的既有决策（:1805）。
- 不改 reviewer policy_template/prompt；不动五级路由语义与 dangerous 不缓存门。
- 不改 auto.ts：forbidden deny 的终局性由既有 `decision.source === "precheck"` 唯一承载（审计 N-03：:69 是唯一 precheck deny 路径，加字段无必要）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| 根 AGENTS.md | 默认分支 dev；并行 agent 常驻（提交用 --only） |
| packages/opencode/AGENTS.md、test/AGENTS.md | Effect 与测试规范 |
| 提交 ea7c4f30e5（五级拆分） | forbidden=不可逆灾难终审 / dangerous=可授权高风险 语义基准 |
| 提交 4e3b65ce02（git -C reason 聚合） | precheck.ts 当前结构；tokenizeRich 剥损标记既有 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| precheck.ts :150-214（RE_D_RM_RF_ROOT、解释器族、PS/Windows raw 模式）、:588-625（forbiddenRaw）、:1205-1245（rm token 分支、DISK_FORMAT 分支）、:1735-1813（Windows 谓词 + protectedDeleteTarget）、:262-272（RE_C_PYTHON_FILE_REMOVE_CALL）、:1057-1061（解释器 unwrap 返回 ask）、:962-994（tokenizeRich 剥反斜杠）、:599-602（forbiddenRaw 折叠归一化） | 全部触发点与粒度现状 | observed |
| **解释器族真实宽度**（审计 B-01 实证）：:195-202 的 `(?:\/|~|\$HOME|\/etc(?:\/|["']))` 首个裸 `\/` 分支匹配**任意绝对路径**——`os.remove("/tmp/x")`、`shutil.rmtree("/opt/mytool")`、`fs.rmSync("/var/lib/x")` 今天全部 forbidden | 比 /usr 子树更严重的过宽实例（用户要求全面排查的直接证据） | observed（正则语义确定性） |
| Windows cmd 族检测唯一路径（审计 B-02 实证）：`C:\Users\u\AppData` 未加引号时被 tokenizeRich 剥成 `C:UsersuAppData`，token 层 :1811 永不命中；raw 层 windowsCmdTokens（:1756 保留反斜杠）是唯一检测路径，且 forbiddenRaw 只能产 forbidden | Windows 二级 dangerous 必须走 raw 层出口 | observed |
| auto.ts :62-69（forbidden 是唯一 source==="precheck" 的 deny） | 终局性判定无需新字段（N-03） | observed |
| index.ts :137-147（AutoDeniedError）、:353（唯一构造点） | 文案分叉改造点 | observed |
| 探针 D:\Temp\opencode\rm_rf_forbidden_probe.ts（2026-09-07 运行） | 用户案例全 forbidden；`/home/user/Downloads/foo` cautious；`/opt/mytool`、`/var/lib/myapp/data` forbidden；`/tmp` cautious | observed |
| precheck.test.ts forbidden 断言 65+ 处逐条清点 | 唯 :426（/usr/local/bin 二级）需改级；**:147-162 与 :180-188 逐字断言 `reason: "Windows protected directory delete"`（N-01）**——该串在替换范围内，这些断言同步更新；其余全 level-only | observed |
| auto.test.ts / next.test.ts / shell.test.ts / prompt.test.ts | AutoDeniedError 断言全 `toBeInstanceOf`；next.test.ts:831 断言文案 `toContain("Do not retry the same outcome through shell indirection")`——新终审文案保留该子串，零红测 | observed |

## 5. Current Behavior

```text
rm -rf <path> / Remove-Item -Recurse / del|rd /s / 解释器删除调用
  -> raw 层 forbiddenRaw:
     RE_D_RM_RF_ROOT —— 系统根后接 "/" 任意深度 forbidden（用户案例根因）
     解释器族 :195-202 —— 裸 "\/" 分支匹配任意绝对路径，全部 forbidden（B-01 实锤）
     RE_D_PS_RECURSIVE_DELETE_ROOT —— PS 族仅根级（保留）
     windowsProtectedDeleteInCommand —— cmd 族(del/rd/rmdir /s)全子树 forbidden（raw 唯一路径）
  -> token 层：rm/Remove-Item 分支 + windowsProtectedRecursiveDelete → protectedDeleteTarget
     系统根与 Windows 系统目录全子树 forbidden（:1806-1811）；
     未加引号 Windows 反斜杠路径被剥损，token 层对它们不可见（剥损既判）
  -> DISK_FORMAT_COMMANDS：不看参数一律 forbidden（fdisk -l / wipefs 无 -a 同罪）
  -> auto.ts:69 forbidden → deny(source:"precheck")；index.ts:145 单一文案尾部
     "…or ask the user for explicit confirmation…" —— forbidden 授权不可放行，
     该逃生路径不存在，诱发 agent 换形态重试循环（用户实测"一直有问题"）
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| rm -rf/r/-R/--recursive + 系统根任意深度 | bash 文本（含 WSL/ssh/包装器内层） | 路径 token/文本 | RE_D_RM_RF_ROOT + rm token 分支 | precheck | observed |
| del/rd/rmdir /s 或 Remove-Item/ri -Recurse + Windows 路径（未加引号反斜杠为主形态） | 同上 | windowsCmdTokens 保留反斜杠 | raw 层 windowsProtectedDeleteInCommand | precheck | observed |
| 解释器删除调用（os.remove/unlink/rmdir、shutil.rmtree、fs.rmSync/rmdirSync/unlinkSync、subprocess rm -rf）+ 任意路径 | 同上 | 引号字面量 | 解释器族 RE | precheck | observed |
| fdisk -l / parted -l / wipefs 无 -a | 同上 | 参数 token | DISK_FORMAT 分支 :1244 | precheck | reachable |
| forbidden 终审 AutoDeniedError 文案 | index.ts:145 | decision.source==="precheck" | auto.ts:69 → index.ts:353 | auto/index | observed |
| 穿越折叠（/home/../etc）与多斜杠 | 同上 | 折叠归一化必须 raw 双出口共享（N-02） | forbiddenRaw+dangerousRaw | precheck | observed（:412-418 断言） |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 根/家/驱动器根 forbidden 保持 | 既有断言 :136-186 | :41-167 组 |
| INV-02 | 系统根根本身 + 一级子目录 forbidden（/usr/local、/etc/ssl、/home/\<u\>、/var/log、C:\Users\\<u\>） | 用户拍板 | :351-353、:891-892、:406-421、:425、:144 保持 |
| INV-03 | 系统根二级子目录（/usr/local/libexec、/etc/ssl/certs、C:\Users\\<u\>\AppData）→ dangerous，reason 明示"需显式授权"；**三族（bash rm / cmd|PS / 解释器）一致** | 用户拍板"ETC 的子树 → dangerous"、"类似内容完整检查" | 无（新增）；:426 改级 |
| INV-04 | 更深子树 → cautious（用户案例 .linkd） | 用户拍板 | 无（新增） |
| INV-05 | 用户数据根深层与 /root 子目录保持既有豁免，不 widen | :1798-1805 | :403-421 保持 |
| INV-06 | 解释器族 forbidden 收窄为 根/家/系统根一级（裸 `\/` 过宽 bug 修复）；二级 → dangerous；任意路径删除落 cautious 兜底（不低于 rm 同形态层级，防止收窄制造低于矩阵的洞） | B-01 实证 + 矩阵一致 | :196-199、:214-216 保持 + 新增 |
| INV-07 | mkfs 族不变；fdisk/parted/wipefs 只读打印形态 → cautious，写形态 forbidden 保持 | 用户"过宽则优化" | :949-958 保持 + 新增 |
| INV-08 | forbidden 终审文案：含"即使用户授权也无法执行"且不含"ask the user for explicit confirmation"；"Use a materially safer approach" 恰好出现一次；非终审文案字节不变 | 用户拍板文案 | 新增断言；next.test.ts:831 子串保持 |
| INV-09 | forbidden 删除族 reason 全量语义化（含 forbidden 与 root/system directory 表述，无 "critical recursive delete"/"Windows protected directory delete" 黑话）；**替换范围钉死**：forbiddenRaw 全部删除族 return 串 + token 层 "critical recursive delete"/"critical PowerShell recursive delete" + "Windows protected directory delete"（:147-162/:180-188 断言同步更新） | 用户拍板 + N-01 | 断言同步 |
| INV-10 | 压缩路径（raw 短路、wrapper 传播、maxRisk、段聚合、五级路由、tokenizeRich 剥损契约）不变 | 上轮延续 | 全组回归 |
| INV-11 | 折叠归一化（多斜杠、.. 穿越）对 forbidden 与 dangerous 两个 raw 出口同样生效 | N-02 + :412-418 既有断言 | :412-418 保持 + 新增 dangerous 折叠用例 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-03/04 | RE_D_RM_RF_ROOT 系统根分支任意深度命中（:154-157） | precheck.ts raw 层 | 探针 A-D forbidden |
| INV-03/04 | protectedDeleteTarget :1806-1811 系统根与 Windows 系统目录全子树 | precheck.ts token 谓词 | 源码 + 断言 :144 |
| INV-03（Windows） | forbiddenRaw 单出口——Windows 谓词只能产 forbidden，dangerousRaw 无出口（B-02） | precheck.ts raw 层结构 | 源码 :608 |
| INV-06 | 解释器族裸 `\/` 分支匹配任意绝对路径（:195-202），比 /usr 子树更宽（B-01）；且收窄后 rmtree/rmSync 任意路径将落 general（低于矩阵） | precheck.ts raw 层 | 正则语义实证 |
| INV-07 | DISK_FORMAT 分支不看参数（:1244） | precheck.ts token 分支 | 源码 |
| INV-08 | index.ts:145 单一文案给 forbidden 提供不存在的授权路径 | permission/index.ts | 用户实测重试循环 |
| INV-09 | reason 黑话无语义载体 | precheck.ts forbiddenRaw | 用户拍板 |

红态反馈回路（实施前红基线）：

```text
探针 D:\Temp\opencode\rm_rf_tier_probe.ts（cwd=packages/opencode）新期望:
  rm -rf /usr/local/libexec          → dangerous   （当前 forbidden，红）
  rm -rf /usr/local/libexec/.linkd   → cautious    （当前 forbidden，红）
  wsl -- bash -lc 'rm -rf /usr/local/libexec/.linkd/wsl-verify-04' → cautious（红）
  rm -rf /usr/local                  → forbidden   （保持，绿）
  del /s /q C:\Users\u\AppData       → dangerous   （当前 forbidden，红——cmd raw 路径）
  python -c 'import shutil; shutil.rmtree("/etc/ssl/certs")' → dangerous（当前 forbidden，红）
  python -c 'import os; os.remove("/tmp/scratch.txt")' → cautious（当前 forbidden，红——裸 \/ bug）
  fdisk -l / wipefs /dev/sdb1        → cautious    （当前 forbidden，红）
  AutoDeniedError(forbidden).message → 含 cannot be executed even with explicit user
                                       authorization，不含 ask the user（红）
```

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 路径保护层级判定 | precheck.ts protectedDeleteTier（protectedDeleteTarget 演进） | 路径字符串 → "forbidden" \| "dangerous" \| undefined | 唯一持有归一化路径语义的点 | raw 正则无折叠/token 语义 |
| bash rm 文本层二级提升 | RE_D_RM_RF_ROOT 收窄 + 新 RE_D_RM_RF_SYSTEM_SUBTREE（dangerousRaw，消费同一折叠归一化） | forbidden 根/一级；dangerous 恰好二级 | raw 层必须先于包装器短路 | token 层在包装器后可能不可达 |
| Windows cmd+PS 族统一 raw 扫描器 | precheck.ts windowsProtectedDeleteTier（windowsProtectedDeleteInCommand 演进，纳入 remove-item/ri -Recurse） | 命令文本 → tier | 反斜杠剥损后 token 层不可见，raw 是唯一检测路径（B-02）；forbiddenRaw 调 tier=forbidden、dangerousRaw 调 tier=dangerous | token 层只见加引号/正斜杠形态 |
| 解释器族分级 | precheck.ts 解释器 RE 组重写 + cautious 兜底扩展 | forbidden 根/一级；dangerous 恰好二级；任意路径删除 cautious | 同 owner 同矩阵 | — |
| 磁盘工具读写形态 | DISK_FORMAT 分支参数感知 | 打印形态 cautious、写形态 forbidden | 同 owner | — |
| 文案分级 | index.ts AutoDeniedError terminal 字段（terminal = decision.source==="precheck"，无需 auto.ts 变更，N-03） | forbidden 文案无授权假路径 | 文案唯一组装点；终局性由既有 source 承载 | auto.ts 不动 |

## 10. Single Approved Primary-Path Design

```text
precheck.ts:
  protectedDeleteTarget → protectedDeleteTier(input): "forbidden" | "dangerous" | undefined
    归一化沿用现有折叠；系统根：根本身/一级→forbidden、恰好二级→dangerous、更深→undefined；
    用户数据根 /home /Users：一级 forbidden、更深 undefined 保持；/root 子目录 undefined 保持；
    Windows：驱动器根 forbidden；C:\(Windows|Users|Program Files) 根本身 forbidden、
    一级 forbidden、二级 dangerous、更深 undefined
    家目录/环境变量分支（~、$HOME、$env:USERPROFILE、$env:SystemDrive、%USERPROFILE%）一律
    大小写不敏感（审计 R2 B-02：PowerShell env provider 名大小写不敏感，$ENV:USERPROFILE 是
    日常可达形态；承载被删除 RE_D_PS_RECURSIVE_DELETE_ROOT 的 i 旗语义）
  RE_D_RM_RF_ROOT：系统根分支收窄为「根本身或一级子目录」（恰好一段 + 可选尾斜杠）
  新增 RE_D_RM_RF_SYSTEM_SUBTREE（dangerousRaw）：系统根恰好两段 + 可选尾斜杠；
    dangerousRaw 消费与 forbiddenRaw 相同的折叠归一化（N-02：共享折叠 helper，
    消除穿越差异）且剥尾斜杠（R2 N-02：`rm -rf /usr/local/libexec/ > log` 的
    opaque+尾斜杠形态不得掉到 cautious）
  windowsProtectedDeleteInCommand → windowsProtectedDeleteTier(command)：
    段切分 + windowsCmdTokens 保留反斜杠；识别 cmd 族(del/erase/rd/rmdir + /s 系开关)与
    PS 族(remove-item/ri + -Recurse)；对每个目标 token 调 protectedDeleteTier，取最高；
    forbiddenRaw: tier==="forbidden" → forbidden reason；
    dangerousRaw: tier==="dangerous" → dangerous reason
    删除 RE_D_PS_RECURSIVE_DELETE_ROOT（其根级覆盖被子扫描器 forbidden 档完全承载，
    消除重复 owner）与旧 windowsProtectedRecursiveDelete 布尔形态（token 分支改 tier 映射）
  解释器族重写（B-01 真修复）：共享路径交替组常量
    FORBIDDEN_PATH = \/(?=["'\s)])|~|\$HOME|\/(?:系统根)(?:\/[^\/\s"']+)?\/?(?=["'\s)])|
                     \/(?:home|Users)\/[^\/\s"']+\/?(?=["'\s)])
    DANGEROUS_PATH = \/(?:系统根)\/[^\/\s"']+\/[^\/\s"']+\/?(?=["'\s)])
    （审计 R2 B-01：两个常量的边界前瞻前都必须有可选 \/?——否则 "/etc/ssl/" 这类
     tab 补全形态掉到 cautious，低于契约层级；解释器族无 token 层兜底）
    forbiddenRaw：四族（python rmtree/remove、node、subprocess rm）× FORBIDDEN_PATH
    dangerousRaw：四族 × DANGEROUS_PATH（恰好二级）
  cautious 兜底（防收窄制造低于矩阵的洞）：
    RE_C_PYTHON_FILE_REMOVE_CALL 扩入 shutil\.rmtree；
    新增 RE_C_NODE_REMOVE_CALL（fs.rmSync/rmdirSync/unlinkSync 任意路径）与
    RE_C_SUBPROCESS_RM_ANY（subprocess rm 任意路径）→ cautious
    "interpreter file deletion requires explicit approval" 语义串
  DISK_FORMAT：mkfs 族不变；fdisk/parted/wipefs 含 -l/--list 或 wipefs 无 -a/--all
    → cautious "disk partition inspection is read-only"；否则 forbidden 保持。
    flag 判定用合并短开关簇感知（R2 N-01：`wipefs -af /dev/sdb1` 不得漏检，
    复用 hasRecursiveDeleteFlags 同款簇展开先例）
  reason 语义化（INV-09，范围钉死）：
    forbidden 根类 → "recursive delete of filesystem root, home, or top-level system
      directory — forbidden (cannot be authorized)"
    dangerous 二级 → "recursive delete under a system directory — requires explicit
      user authorization"
    PS/解释器/Windows 变体同语义换载体名（含替换 "Windows protected directory delete"）
index.ts（唯一非 precheck 生产变更）：
  AutoDeniedError 加 terminal: Schema.optional(Schema.Boolean)；index.ts:353 传
    terminal: decision.source === "precheck"
  message 分叉：
    terminal → "Auto permission preflight rejected this tool call: {reason}. Do not retry
      the same outcome through shell indirection, generated scripts, alternative tools,
      MCP tools, or other policy workarounds. Use a materially safer approach. This operation
      is terminally forbidden: it cannot be executed even with explicit user authorization."
    非 terminal → 现文案字节不变
```

为何修复 first divergence：分级落在唯一路径语义谓词与两个 raw 出口（各自层级各自 reason，共享折叠）；解释器族裸 `\/` 修复为真实矩阵并重写 current-behavior 认知；Windows 由统一 raw 扫描器承载双族双层级；终局性复用既有 source 语义，无新字段。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 系统根全子树 forbidden | current | 既有缺陷（过宽） | yes（误拦） | 删除族 | replace（分级替代） |
| 解释器族裸 `\/` forbidden | current | 既有缺陷（B-01 更宽） | yes（误拦） | 解释器删除 | replace（真实矩阵） |
| RE_D_PS_RECURSIVE_DELETE_ROOT | current | 将被统一扫描器承载 | yes | PS 删除族 | remove（collapse） |
| 单一 AutoDenied 文案 | current | 既有缺陷（误导） | no | AutoDenied | replace（terminal 分叉） |
| /home /Users 深层豁免、/root 子目录不保护 | current | 既有兼容行为 | yes | 用户数据根 | preserve（INV-05） |
| 压缩/短路/聚合/五级路由/剥损契约 | current | primary-contract | yes | 全部 | preserve（INV-10） |

新增平行走廊：零。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| protectedDeleteTarget 布尔谓词 | 无深度概念时代的二分 | tier 谓词承载三级语义 | precheck.ts :1771-1813 演进（消费点 :1208/:1213/:1747-1753 同步） |
| RE_D_PS_RECURSIVE_DELETE_ROOT | PS 族根级独立正则 | windowsProtectedDeleteTier 统一承载 cmd+PS 双族根级 | precheck.ts :189-192 + :611 删除 |
| "critical recursive delete" 等黑话 reason（含 "Windows protected directory delete"） | 五级拆分沿用旧文案 | 语义化 reason | forbiddenRaw/token 层全部 return 串 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01/02 根与一级 forbidden 保持 | tier + RE 收窄 + 扫描器 | precheck.ts | 既有断言全保持 |
| INV-03 二级 dangerous（三族） | tier + RE_D_RM_RF_SYSTEM_SUBTREE + 扫描器 dangerousRaw 出口 + 解释器 dangerous RE | precheck.ts | slice 2/4/5/6 |
| INV-04 更深 cautious | tier undefined 落默认 | precheck.ts | slice 1 |
| INV-05 用户数据根保持 | tier 分支保持 | precheck.ts | 既有断言组 |
| INV-06 解释器收窄+兜底 | 共享交替组重写 + RE_C 扩展 | precheck.ts | slice 6 |
| INV-07 磁盘只读形态 | DISK_FORMAT 参数感知 | precheck.ts | slice 7 |
| INV-08 终审文案 | AutoDeniedError terminal 分叉（source 判定） | index.ts | slice 8 |
| INV-09 reason 语义化 | 全族 return 串替换（含 Windows 串） | precheck.ts | slice 9 + :147-162/:180-188 更新 |
| INV-10 结构不变 | 不触碰 | — | 全组回归 |
| INV-11 折叠双出口共享 | 共享折叠 helper | precheck.ts | slice 10 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| protectedDeleteTier | INV-02/03/04 | 用户三级矩阵拍板 | 布尔谓词无层级表达力 |
| RE_D_RM_RF_SYSTEM_SUBTREE + 共享折叠 | INV-03/11 | WSL 内层二级 + 穿越折叠一致 | 现仅 forbidden 单档且 dangerousRaw 无折叠 |
| windowsProtectedDeleteTier 统一扫描器 | INV-03（Windows） | B-02：token 层对反斜杠路径不可见，raw 单出口 | 现 forbiddenRaw 只能产 forbidden |
| 解释器共享交替组 + dangerous RE + RE_C 兜底 | INV-06 | B-01：裸 `\/` 过宽；收窄后需不低于 rm 层级 | 现 patterns 粒度错误且无二级档/兜底缺口 |
| AutoDeniedError terminal（source 判定） | INV-08 | 用户文案拍板 | 单一 message 不分级 |
| DISK_FORMAT 参数感知 | INV-07 | fdisk -l 只读事实 | 集合命中即 forbidden |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| packages/opencode/src/permission/precheck.ts | modify | tier 谓词、RE 收窄+新增、共享折叠 helper、Windows 统一扫描器、解释器族重写+RE_C 兜底、DISK_FORMAT 参数感知、reason 语义化、RE_D_PS_RECURSIVE_DELETE_ROOT 删除 | +170/-70（净 ~100） |
| packages/opencode/src/permission/index.ts | modify | AutoDeniedError terminal 字段 + 文案分叉 | +8/-2 |
| packages/opencode/test/permission/precheck.test.ts | modify | :426 改级 + :147-162/:180-188 reason 更新 + 分级 slice | +110/-10 |
| packages/opencode/test/permission/next.test.ts | modify | terminal/非 terminal 文案断言 | +14 |

生产文件 2 个（≤6 ✓）；生产行 ~106（≤800 ✓）。

## 16. TDD Behavior Slices

公共 seam：`PermissionPrecheck.evaluate`（命令文本 → level/reason）；`AutoDeniedError.message`（经 PermissionAuto.evaluate 决策构造）。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `rm -rf /usr/local/libexec/.linkd`、`wsl -- bash -lc 'rm -rf /usr/local/libexec/.linkd/wsl-verify-04'` → cautious | 系统根任意深度 forbidden | tier+收窄 | 用户原始案例 |
| 2 | `rm -rf /usr/local/libexec` → dangerous，reason 含 "requires explicit user authorization" | 无 dangerous 档 | RE_D_RM_RF_SYSTEM_SUBTREE | 二级提升 |
| 3 | `/usr/local`、`/etc/ssl`、`/home/<u>`、`C:\Users\<u>` → forbidden 保持；`Remove-Item -Recurse $ENV:USERPROFILE`（大小写变体）→ forbidden 保持 | 收窄回归锚 + R2 B-02 大小写回归 | 一级 forbidden 语义 + env 分支大小写不敏感 | :353/:891/:144 |
| 4 | `rm -rf /etc/ssl/certs` → dangerous；`rm -rf /home/../etc/ssl/certs` 穿越 → dangerous；`rm -rf /usr/local/libexec/ > log`（opaque+尾斜杠）→ dangerous | 同 2 + 折叠缺失 + 尾斜杠缺失 | 共享折叠+剥尾 | /etc 二级 + INV-11 + R2 N-02 |
| 5 | `del /s /q C:\Users\u\AppData`（cmd raw 路径）→ dangerous；`Remove-Item -Recurse C:\Users\u\AppData`（raw 扫描器）→ dangerous；`del /s /q C:\Users\u\AppData\Local\Temp\x` → cautious | Windows 全子树 forbidden 且无 dangerous 出口 | windowsProtectedDeleteTier 双族 | B-02 修复 |
| 6 | `python -c 'shutil.rmtree("/etc/ssl/certs")'` → dangerous；`shutil.rmtree("/etc/ssl/")`（尾斜杠）→ forbidden；`shutil.rmtree("/etc/ssl/certs/")`（尾斜杠）→ dangerous；`os.remove("/etc/passwd")` → forbidden 保持；`os.remove("/tmp/x")` → cautious（裸 `\/` bug 修复）；`shutil.rmtree("/tmp/x")`、`fs.rmSync("/tmp/x",{recursive:true})` → cautious 兜底 | 裸 `\/` 过宽 + 无二级档 + 兜底缺口 + R2 B-01 尾斜杠 | 解释器族重写+RE_C 扩展+边界 \/? | B-01 修复 |
| 7 | `fdisk -l`、`wipefs /dev/sdb1`（无 -a）→ cautious；`fdisk /dev/sda`、`wipefs -a /dev/sdb1` forbidden 保持 | 裸命令一律 forbidden | 参数感知 | :956-957 |
| 8 | forbidden AutoDeniedError.message 含 "cannot be executed even with explicit user authorization"、不含 "ask the user for explicit confirmation"、"materially safer approach" 恰好一次；reviewer deny 文案字节不变 | 单一文案 | terminal 分叉 | 用户实测循环 |
| 9 | forbidden 删除族 reason 语义化断言（含 "forbidden (cannot be authorized)"）；`"Windows protected directory delete"` 不再出现；:147-162/:180-188 断言同步更新 | 黑话 | 语义替换 | 模型可读性 |
| 10 | `rm -rf /usr/local/bin`（:426 陈旧断言）→ dangerous | 二级改级 | 断言更新 | 唯一改级项 |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~220（生产 ~106 + 测试 ~114） | 排除 import/空行/注释 |
| Required Chinese explanatory comments `C` | ≥ max(1, ceil(220×0.15)) = 33 | 邻近修改点 |

注释点：三级分级矩阵与各族边界、双 raw 出口与共享折叠、Windows 扫描器双族识别与剥损不可见事实、解释器族裸 `\/` bug 修复语义与二级档/兜底理由、fdisk/parted/wipefs 只读形态事实、terminal=source==="precheck" 的唯一性依据（N-03）、reason 语义化范围、/home /root 既有豁免保持。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| bun run D:\Temp\opencode\rm_rf_tier_probe.ts | packages/opencode | 原始回路（用户案例+B-01/B-02 案例）红→绿 |
| bun test test/permission/precheck.test.ts | packages/opencode | 分级 slice + 既有断言回归 |
| bun test test/permission/next.test.ts test/permission/auto.test.ts | packages/opencode | 文案与路由回归 |
| bun test test/permission/ | packages/opencode | 权限全组零红 |
| bun test test/session/prompt.test.ts test/tool/shell.test.ts | packages/opencode | AutoDeniedError 集成面零红 |
| bun typecheck | packages/opencode | 零错（以退出码为准） |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | — |
| Files modified（生产） | 2 | precheck.ts + index.ts |
| Files modified（测试） | 2 | precheck.test.ts + next.test.ts |
| Files deleted | 0 | — |
| Production lines | ~106 | 用户预算 ≤800 |
| Test lines | ~114 | — |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

### 真实风险

- 二级子树 dangerous 进 reviewer 且不缓存（既有缓存门）→ 每条独立重审：层级语义内生代价。
- `/usr/local`（一级）保持 forbidden 是用户拍板。
- 解释器族任意路径删除从 forbidden（裸 `\/` bug）降为 cautious：属修复过宽，且 cautious 不低于 rm 同形态层级。
- PS 族加引号/正斜杠 Windows 路径走 token 层 tier（与 raw 扫描器同谓词），未加引号反斜杠走 raw 扫描器——双层同谓词，无分歧。
- wipefs 无 -a 仅打印签名依赖 util-linux 事实。

### Rejected Speculation

- "/root 子目录纳入保护"——既有决策保持，不 widen。
- "kill 反向 flag 顺序漏洞"——`-1` 前置时 `-9` 非合法 PID 位，非过宽问题。
- "sensitive-read cautious 层宽度"——非 forbidden 族。
- "auto.ts 加 precheckLevel 字段"——N-03：source==="precheck" 已唯一承载终局性，拒绝冗余字段。
- "解释器常量也消费共享折叠归一化"——R3 N-01：`/etc//ssl` 拼接形态掉 cautious（仍 reviewer 门控，保守方向），记录为已接受残留；解释器族拼接路径形态非常规输入，不值得为此再给该族加一套折叠。

### Open Decisions Requiring the User

无（分级矩阵、文案表述、解释器族修复范围均已拍板或审计证实）。

## 21. Audit Contract

独立审计者必须：

- 阅读本文件与第 1 节用户需求原文。
- 从仓库证据重建行为，视 builder 摘要为不可信。
- 每轮审计完整原始范围；每个 blocking finding 附证据。
- 同时检查 under-design 与 over-design。
- 检查根因修复、fallback、owner、测试、代码质量与 15% 中文注释计划。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 解释器族收窄为无效改动（裸 `\/` 分支匹配任意绝对路径，§4/§5 现行行为认知错误；收窄后 rmtree/rmSync 任意路径落 general 低于矩阵）；B-02 Windows cmd 族二级 dangerous 无可执行路径（token 剥损不可见 + forbiddenRaw 单出口） | N-01 reason 替换范围未钉死（"Windows protected directory delete" 在 :147-162/:180-188 有逐字断言）；N-02 dangerousRaw 无折叠归一化；N-03 deny.precheckLevel 无必要（source==="precheck" 已唯一承载终局性） | BLOCK | task ses_f61e00ebeffe0Tnv2eXk8gn21c（2026-09-07） |
| 2 | R2 | yes | B-01r2 解释器共享常量缺尾斜杠容忍（"/etc/ssl/" 掉到 cautious 低于契约，该族无 token 兜底）；B-02r2 删除 RE_D_PS_RECURSIVE_DELETE_ROOT 丢失 i 旗（$ENV:USERPROFILE 大小写变体从 forbidden 降为 cautious，静默安全削弱） | N-01r2 DISK_FORMAT 短开关簇（wipefs -af）漏检风险；N-02r2 bash 二级 RE 与共享折叠缺尾斜杠剥除（opaque+尾斜杠掉到 cautious）；N-03r2 日期元数据 | BLOCK | 同 task（round 2，2026-09-07） |
| 3 | R3 | yes | 无 | N-01r3 解释器常量跑在未经折叠的空白归一化文本上（`/etc//ssl` 多斜杠拼接形态掉 cautious——cautious 仍 reviewer 门控，姿态保守，记录为已接受残留）；N-02r3 日期元数据 | APPROVE | 同 task（round 3，2026-09-07，逐项复验 R2 修复 + 全范围重建） |

R2 修订吸收：B-01 → 解释器族共享交替组真重写（forbidden 根/一级 + dangerous 恰好二级 + RE_C 任意路径 cautious 兜底）；B-02 → windowsProtectedDeleteTier 统一 cmd+PS 双族扫描器并挂 forbiddenRaw/dangerousRaw 双出口；N-01 → INV-09 钉死替换范围含 Windows 串并同步断言；N-02 → 共享折叠 helper；N-03 → auto.ts 移出范围（index.ts 唯一非 precheck 生产变更）。

R3 修订吸收：B-01r2 → 解释器双常量边界前瞻前补可选 \/?（尾斜杠形态层级保持）；B-02r2 → tier 谓词家目录/env 分支大小写不敏感（承载被删 RE 的 i 旗语义）；N-01r2 → DISK_FORMAT 簇感知；N-02r2 → 共享折叠 helper 同剥尾斜杠；N-03r2 → 日期保持。任何实质修订使既有 approval 失效。

## 23. Implementation Evidence

### Actual Files and Diff

- packages/opencode/src/permission/precheck.ts：+201/-101（RE_D_RM_RF_ROOT 收窄、RE_D_RM_RF_SYSTEM_SUBTREE、foldProtectedPathText 共享折叠、解释器族共享交替组重写+RE_DANGER_INTERPRETER_DELETE、RE_C 兜底三件套、windowsProtectedDeleteTier 统一扫描器、windowsRecursiveDeleteTier、protectedDeleteTier 三级分级、highestProtectedDeleteTier、DISK_FORMAT 簇感知收窄、reason 语义化常量、RE_D_PS_RECURSIVE_DELETE_ROOT 删除）
- packages/opencode/src/permission/index.ts：+11/-2（AutoDeniedError terminal 字段 + 文案分叉 + :353 source 判定透传）
- packages/opencode/test/permission/precheck.test.ts：+79/-7（4 个新分级测试块 + :426 改级 + Windows reason 断言同步 + /usr/ 裸尾斜杠回归锚）
- packages/opencode/test/permission/next.test.ts：+21/-0（AutoDeniedError 文案分级测试）

### Red-Green Test Evidence

- 红：新测试块先行写入后运行——precheck 6 fail（4 新块 + :426 所在测试 + Windows 串所在测试）、next 1 fail（文案），红因为旧实现无分级/无语义 reason/无 terminal 分叉。
- 绿返工：首轮绿后发现三处真实缺陷并修复——(1) protectedDeleteTier 尾斜杠剥除把根 "/" 剥成空串（旧谓词同款潜伏 bug，原由已删的 PS raw 正则兜底）；(2) 收窄正则 `+` 不覆盖系统根裸尾斜杠 `/usr/`（改 `*` 并加回归锚断言）；(3) 解释器测试 reason 常量笔误（测试侧修正）。
- 绿：precheck 120/0、next 1/0（新测试）+ 全组 297/0。

### Verification Commands and Results

| 命令 | cwd | 结果 |
| --- | --- | --- |
| bun test test/permission/precheck.test.ts | packages/opencode | 120 pass / 0 fail |
| bun test test/permission/ | packages/opencode | 297 pass / 0 fail（6 文件） |
| bun test test/tool/shell.test.ts | packages/opencode | 204 pass / 0 fail |
| bun test test/session/prompt.test.ts | packages/opencode | 104 pass / 0 fail（落盘 prompt_tier.txt） |
| bun typecheck（tsgo --noEmit） | packages/opencode | exit 0（以退出码为准） |

### Original Feedback-Loop Result

`bun run D:\Temp\opencode\rm_rf_tier_probe.ts`（cwd=packages/opencode）：14/14 全绿——用户两个原始案例（WSL 包装 + 叶子变体）均 cautious 可授权，一级/二级/更深矩阵各形态逐一命中，fdisk -l cautious。

### Actual Secondary and Replacement Path Inventory

- raw 短路/wrapper 传播/maxRisk/段聚合/tokenizeRich 剥损契约：未触碰（preserve）。
- RE_D_PS_RECURSIVE_DELETE_ROOT 与 windowsProtectedDeleteInCommand/ProtectedRecursiveDelete 布尔形态：删除（collapse 进统一扫描器/tier）。
- /home /Users 深层豁免、/root 子目录不保护：保持（preserve）。
- 解释器族 RE_C 兜底扩展：矩阵层级对齐（不是 fallback——修复裸 \/ 过宽的必要补全）。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~205 | 生产 ~115（分级谓词/扫描器/RE 组/文案分叉）+ 测试 ~90；排除空行/纯移动 |
| Qualifying Chinese comment lines `C` | ~58 | 分级矩阵与各族边界、双 raw 出口共享折叠、剥损不可见与扫描器归属、裸 \/ bug 语义、尾斜杠容忍与根 "/" 剥除保护、i 旗承载、簇感知、终端文案分级、对照组/改级断言意图 |
| Ratio `C / E` | ~28% | `N/A` when `E = 0` |
| Required minimum `C` | 31 | `E > 0: C >= max(1, ceil(205*0.15))=31` |

### Remaining Unverified Items

- R3 N-01r3 已接受残留：解释器常量未消费共享折叠（`/etc//ssl` 拼接形态掉 cautious，保守方向）。
- 其余无（全部验证命令绿）。


## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R3 | yes | 无 | N-01 解释器常量未消费共享折叠（`/etc//ssl` 拼接形态掉 cautious，R3 方案审计已记录为已接受残留，姿态保守）；N-02 token 层根 "/" 硬化为刻意修复（旧谓词把 "/" 剥成空串的潜伏 bug，与 raw 层同级） | APPROVE（No blocking findings） | task ses_f61e00ebeffe0Tnv2eXk8gn21c（2026-09-07，独立重跑 297/0+308/0+typecheck+原始回路 14/14；全 diff 逐 hunk 映射 R3 §10） |

仅当当前实现与已批准 plan revision 获得独立全范围 `No blocking findings` 后方可标记 verified。
