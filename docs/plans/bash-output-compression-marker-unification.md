# Canonical Implementation Plan: Bash 输出压缩标记方言统一与脱敏一致性修复

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: 用户会话需求（原文见 §1）
>
> Implementation allowed: yes
>
> Last updated: 2026-09-06

本文件是本任务的唯一实施规范。聊天摘要、被取代的修订和 builder 自述不构成实施授权。

## 1. Verbatim Requirement

> 我觉得当前这种方案比较不错，所以你可以看一看，为我进行相应的一个工作区的 plan 的一个修改，并且整体的修最终方案的修改文件数，生产文件代码应当不超过四个文件，同时生产代码行数修改不超过800行，整体风格保持一致性，且如果有死代码或旧代码应当被移除，且旧 plan 中的相关不合理或者弃用内容也应当被移除。也就是保持精准修改，且保持主逻辑整体优化，风格自然，且避免出现过多冗余或残留。同时注意修改不应当让最终状态存在相关方面的红测，如果测试过时应当进行修改，如果生产代码逻辑错误导致了最终稳定性下降，应当优化生产代码。

前置会话中已确认的方案要素（用户逐项认可）：

1. 脱敏与压缩绑定是**接受的默认行为策略**（"本质上而言，模型默认是不会关闭压缩开关的……这本身是一种默认行为的一种脱敏……脱敏和这个压缩是可以进行绑定的"），不作为安全问题处理。
2. 标记零文档问题需修复："确实你说的这些零标记的一些文档什么 redacted、high entropy，还有什么 same line repeated 等等的 prompt，就是没有任何的一个解释"。
3. 标记语言风格不一致需统一："它们的设计风格……语言风格好像都不是特别一致"，需给出大小写、标识符、内容的一致方案。
4. 标记图例应挂在 compress 相关介绍里（compressionGuidance），"保持其高等的这种性价比……避免输入过多冗余的内容，或者说也避免直接默认就诱导它去关闭这个 compress 选项"。
5. 沿用 `docs/tool-output-notice-format-design.md` 的分层思想，另起新 plan（本文件）；旧设计文档中不合理/弃用内容同步清理。
6. 新建本 canonical plan（用户更正："你应当是创建一个新的 plan，因为当前这个 plan 的它的位置啊等等内容不符合设计标准"）。

**R2 修订（用户在 R1 实施中途提出，为本修订唯一驱动）：**

> 现在请稍等一点点……比如说这个凭据，你可以理论上来说是可以适当保留前六位或者前五位。比如说前七位，这样的话就能够使得我们整体的这么一个内容具有一定的可识别性嘛……同时也能够起到匿名作用，然后又不会完全地把那些它需要的信息给丧失掉……高生行理论上来说也可以保留，比如说前七位……比如说你看 SK，横杠，然后后面还能保留四位……[内部可以保留七个字符作为头？你看看怎么比较合适一点]

要点：凭据（特定值型与键值型）与高熵行的省略/替换标记保留首 7 字符头部，兼顾可识别性与匿名性；短值不保留头部（见 INV-07 的 ≥16 字符门槛，防止 8-15 字符短凭据被泄露大半）。

**R3 修订（审计 Round 2 B-01/N-01..N-05 修复）：**

- B-01：唯一化 CLIXML 闸门语义为 **gate-on-decoded**（闸门求值于解码后文本，与 win32 路径一致）；解码后 <200B 的输出按 §1 要素 1 用户接受的绑定策略跳过脱敏（显式接受边界，非缺陷）；§7/§8/§16/§18 验收判据同步对齐，T2 fixture 钉为解码 ≥200 字符并补 <200B 接受边界钉死用例。
- N-02：T3 bar/list fixture 需独立满足 `shouldCompressOutput`（≥200B）：bar 改 `"=".repeat(220)`、list 改 25 项；高熵断言补 `head=`（N-03）。
- N-04：generic 脱敏捕获开引号并回写（`password="Super…"` → `password="SuperSe…[redacted]`），T5 补带引号用例。
- N-01：§23 注明 §4-§12 行号基于 HEAD（2153 行）基线，工作树已部分实施（1856 行）。
- N-05：§14 注明 ≥16 门槛对特定值型家族恒真，实际作用于键值型短值（统一常量规则，记录性）。

## 2. Explicit Non-Goals

- 不将 redaction 从压缩开关解耦（`compress_output=false`、`tool_output.bash_compression=false`、`<200B` 闸门跳过脱敏均为用户接受的策略，保持原样）。
- 不实现 `output_compressed` 块级 notice（设计文档默认不显示；图例已覆盖可发现性）。
- 不改截断/执行通知家族（`<opencode_notice type="output_truncated|execution|compaction_cleared|task_id">`）与 `output-notice.ts`。
- 不改 compaction.ts（其 `[redacted]` 保留键名方言即目标方言，是统一方向的锚点）。
- 不改诊断附录触发条件（`durationMs>=2000`、`abnormalExit||fatal` gating）与压缩统计 metadata 字段集（除 `enableCommandAdapters` 配置删除外）。
- 不接线命令适配器（决策为删除，不是 notice 化或启用）。
- 不做 bytes→KB 格式化（保持 `${bytes}B`，避免第 5 个生产文件与双实现漂移）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | 领域词汇：Tool/Session/Message；`tool/` 含 `bash-compress.ts`；SMARK fork 以 `[local-smark]` 标注本地增强 |
| 根 `AGENTS.md` | 默认分支 dev；并行工具；测试从包目录运行 |
| `packages/opencode/AGENTS.md` | 模块形态（multi-sibling 无 barrel）；Effect 规则；`bun typecheck` 从包目录 |
| `packages/opencode/test/AGENTS.md` | 测试 fixture/Effect 模式；`it.live` 用于真实进程 |
| `docs/tool-output-notice-format-design.md` | 分层格式契约：块级 `<opencode_notice>` / 摘录 `<opencode_excerpt>` / 行内 `[... reason stats]` ASCII 短标记 / 统计进 metadata；内联 marker 规则（ASCII `x`/`->`、`L`/`B/KB`、prefix/suffix 默认不出现、marker 必须短于被替换内容） |
| `docs/plans/shell-user-model-output-panel-isolation.md:38,52` | 边界：不得重设计 `<opencode_notice>` 格式与 output-notice.ts taxonomy；本 plan 遵守（只改 bash-compress 内联层与新增 excerpt 头） |
| `.opencode/policy/first-principles-engineering.md` | 单一权威路径、禁 fallback、删除 superseded workaround、15% 中文注释门禁 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/tool/bash-compress.ts`（全文 2153 行） | 压缩/脱敏/CLIXML/诊断/适配器全部生产点 | observed |
| `packages/opencode/src/tool/shell.ts`（1-380, 1100-1514） | 消费方：管线组装、guidance、head/tail、附录拼接 | observed |
| `packages/opencode/src/tool/shell/prompt.ts`（全文） | `${compressionGuidance}`/`${shellGuidance}` 占位符恒传 `""`（:288-289），真拼接在 shell.ts:1436-1439 —— 死占位符 | observed |
| `packages/opencode/src/tool/shell/shell.txt`（:9,:15） | 两个死占位符所在模板行 | observed |
| `packages/opencode/src/util/output-notice.ts`（全文） | notice 家族与 `formatNotice`；不动 | observed |
| `packages/opencode/src/session/compaction.ts`（:466-477 证据表脱敏；:82-124 摘要模板） | `[redacted]` 保留键名目标方言锚点；`## Critical Context` 是 LLM 生成段落非 harness 标记 | observed |
| `packages/opencode/src/session/message-v2.ts`（:399-407,:1232-1241） | `[... compaction truncated N chars ...]` 与 `compaction_cleared` 已是目标方言（阶段 5 已完成） | observed |
| `packages/opencode/src/tool/truncate.ts`（全文） | `output_truncated` notice 与全文文件写入（不动） | observed |
| `packages/opencode/test/tool/bash-compress.test.ts`（全文 134 行） | 10 个既有测试；:47,:61 断言 `powershell-clixml` 包装、:109/:116 断言旧标记文案 —— 需随方言更新 | observed |
| `packages/opencode/test/tool/shell.test.ts`（:1-110 harness、:2301-2356 附录用例） | :2321/:2349 断言 `<bash_high_signal_excerpt>`；`initShell()` 暴露 description 公共 seam | observed |
| `D:\Temp\opencode\repro-v2.ts` 运行结果（见 §8） | red-capable 反馈环路 | observed |
| grep 全仓 `applyCommandAdapter|detectCommandAdapter|CommandAdapter|enableCommandAdapters|OPENCODE_BASH_ENABLE_COMMAND_ADAPTERS` | 仅 bash-compress.ts 自引用（14 处），src/test 均无外部调用方 —— 死代码证明 | observed |

注意（方法论）：探测脚本的输出必须 base64 包裹后读取——本会话自身的 bash 输出压缩会改写重复性探测输出（实测曾将 `"repeat-me\n"×20` 的 JSON 输出折叠为 `[repeated "repeat-me\n" ×N]`），双层混淆会导致误判。

## 5. Current Behavior

```text
子进程 stdout chunks
  → shell.ts onChunk（内存窗口 keep=maxBytes*2，溢出 chunk 喂 hiddenDiag）
  → shell.ts:1291 win32+PowerShell: normalizePowerShellOutput（纯 CLIXML 块解码为无包装纯文本）
  → shell.ts:1295 compressVisibleOutput(normalized)
      ├─ bash-compress.ts:1677 transformPowerShellClixml 命中 → 早返回：
      │    文本 = `<high-entropy powershell-clixml>…</high-entropy powershell-clixml>` 包装
      │    （跳过脱敏与全部压缩；stats 谎报 applied=true, highEntropyLines=1）
      ├─ gate: enabled / shouldCompressOutput（<200B 直接原样返回 → 脱敏也跳过——用户接受）
      ├─ redactSecrets → `<REDACTED_API-KEY>` 等（generic 模式连键名一起吞掉）
      ├─ VirtualTerminal 渲染（\r/ANSI）
      ├─ template → blocks → same → highEntropy → inline 各压缩遍（旧方言标记）
      └─ applied 谓词不含 secretsRedacted → 仅脱敏命中时回退返回未脱敏原文（INV-01 bug）
  → shell.ts:1311 head/tail 窗口（hidden 喂 hiddenDiag）
  → 截断 notice（output_truncated，块级 XML，已是目标方言）
  → renderDiagnosticAppendix → `<bash_high_signal_excerpt>`（INV-03 旧方言）
  → formatShellExecutionNotice（execution，已是目标方言）
  → 模型可见 output；userOutput 走 display.value()（不混入标记）
```

工具描述：`shell.ts:1428-1439` 组装 compressionGuidance（2 条 bullet，无标记图例）追加到 `ShellPrompt.render` 结果之后；`shell.txt:9,:15` 的 `${shellGuidance}`/`${compressionGuidance}` 占位符由 `prompt.ts:288-289` 恒填 `""` —— 残留死位。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| ≥200B 且 ≥5 换行或含 \r 或长行的 shell 输出 | 任意命令 stdout | shell.ts 解码/归一后调用 | compressVisibleOutput 全管线 | bash-compress | observed |
| <200B 或压缩禁用的输出 | 同上 | 同上 | gate 直通（脱敏跳过——用户接受） | bash-compress | observed |
| 含 `password=/token=/sk-/eyJ…/AKIA…/ghp_/BEGIN PRIVATE KEY` 的输出 | 命令回显密钥 | 无 | redactSecrets | bash-compress | observed |
| 纯 PowerShell CLIXML 块 | pwsh stderr/stdout | shell.ts:1291 仅 win32+ps 预解码 | 非 win32 路径走 compressVisibleOutput 内部 CLIXML 分支 | bash-compress | observed |
| 混合 CLIXML+stdout 块 | 同上 | isPurePowerShellClixmlBlock 拒绝解码 | passthrough | bash-compress | observed（test:67-84） |
| 命令失败 + ≥2s + fatal/error 行 + 隐藏文本 | hiddenDiag 三队列 | 只收窗口丢弃文本 | renderDiagnosticAppendix | bash-compress | observed（test:2301-2328） |
| npm/pytest/docker/tsc 适配器路径 | 无（零调用方） | — | 不可达 | — | 死代码（grep 证明） |

Speculative 行（不驱动生产逻辑）：恶意构造的伪标记文本（模型上下文注入）——无 threat model 证据，仅记录。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 压缩启用且过闸时，redactSecrets 的脱敏结果必须体现在返回文本与 stats 中；仅脱敏命中（无压缩分组）不得回退原文 | repro-v2 [1]（508B、distinct 行、`password=SuperSecret99` → applied=false、secret visible=true） | 无（零覆盖，本 plan 补） |
| INV-02 | 纯 CLIXML 解码输出为无包装纯文本；闸门求值于解码后文本（gate-on-decoded，与 win32 路径一致），过闸后继续经过脱敏与压缩——解码后 <200B 的输出按用户接受的绑定策略（§1 要素 1）跳过脱敏（显式接受边界）；非 win32 与 win32（normalizePowerShellOutput）路径对同一输入产生一致文本 | repro-v2 [2]（300B CLIXML → 包装存在 + `token=Tok…` 明文 + stats 谎报）；win32 路径 shell.ts:1291 无包装且闸门同样求值于解码文本 | test/bash-compress.test.ts:29-65（断言包装存在，需反转）；:86-101 |
| INV-03 | 行内省略/替换标记统一为 `[... reason stats]` ASCII 方言；摘录统一为 `<opencode_excerpt …>`；redaction 与 compaction 同族 `[redacted…]` 且保留键名 | 设计文档 §内联 marker/§opencode_excerpt/迁移表；repro-v2 [3][4]；compaction.ts:466-472 | test/bash-compress.test.ts:109,:116；test/shell.test.ts:2321,:2349（断言旧方言，需更新） |
| INV-04 | 工具描述（compressionGuidance）枚举标记家族，声明 harness 插入、首现/错误行保留、省略是有意的；不诱导关闭压缩 | 用户原文（§1 要素 3/4）；shell.ts:1428-1439 现无图例 | 无（本 plan 补） |
| INV-05 | 死代码移除：命令适配器 4 类+注册表+2 导出+`enableCommandAdapters` 配置+env；shell.txt/prompt.ts 死占位符 | 用户原文（§1）；grep 14 处自引用零外部调用 | 无（import 编译即验证） |
| INV-06 | 范围守卫：notice 家族、诊断触发条件、压缩统计 metadata、compaction 方言、userOutput 面板隔离均不变 | shell-user-model-output-panel-isolation.md INV-02；本 plan §2 | 既有测试全量回归 |
| INV-07 | 脱敏替换与高熵省略保留首 7 字符头部以维持可识别性，且仅当原值/原行 ≥16 字符时保留（短值不保留，防 8-15 字符凭据被泄露大半） | 用户 R2 原文（§1）；AWS/GitHub/OpenAI 控制台均展示 key 前 7 字符的通行实践 | T5/T3 高熵断言 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `bash-compress.ts:1743-1745` `applied` 谓词的 OR 链不含 `secretsRedacted`；:1749 `applied=false` 时返回原始 `text`（脱敏已做但被丢弃），:1750 返回 emptyStats（secretsRedacted 谎报 0） | `compressVisibleOutput` | repro-v2 [1] |
| INV-02 | `bash-compress.ts:1676-1691` CLIXML 早返回：包装文本 + 跳过脱敏/压缩 + stats 谎报；与 shell.ts:1291 win32 路径（无包装、继续管线）分叉 | `compressVisibleOutput` CLIXML 分支 | repro-v2 [2]；两路径源码 |
| INV-03 | 10 处标记生产点各自为政（:604,:1071,:1139,:1368,:1407,:1209/:1249,:1437,:1462,:316,:2054-2072）：`×` 非 ASCII、`N more times` vs `Nx`、raw bytes、XML tag 用于行内、SCREAMING vs snake_case vs kebab-case 三风格并存；generic 脱敏吞键名 | 各标记生产函数 | repro-v2 [3][4]；源码行号 |
| INV-04 | `shell.ts:1428-1439` guidance 无图例段落 | shell.ts 工具描述组装 | 源码 |
| INV-05 | `bash-compress.ts:28-43,:114-116,:245,:745-999` 适配器全家无调用方；`shell.txt:9,:15` + `prompt.ts:288-289` 死占位符 | 上述位置 | grep 全仓 |
| INV-07 | R1 设计将凭据/高熵内容全隐（无头部），丧失用户要求的可识别性 | redactSecrets / compressHighEntropyLines | 用户 R2 原文；通行控制台实践 |

反馈环路（red-capable，bug 部分）：

- 命令：`bun run D:\Temp\opencode\repro-v2.ts`（导入真实 `src/tool/bash-compress.ts`；输出 base64 防本会话压缩改写）。
- 观测（2026-09-06）：
  - [1] inputBytes=508，applied=false，secretsRedacted=0，**secret visible=true**（INV-01 症状）。
  - [2] inputBytes=300，applied=true，highEntropyLines=1（谎报），wrapper present=true，**secret visible=true**（INV-02 症状）；解码 base64 = `<high-entropy powershell-clixml>deploy failed token=Tok1234567890 …</high-entropy>`。
  - [3] `repeat-me\n... [same line repeated 24 more times]`；[4] `[repeated "abc" ×6000]`（INV-03 现状样本）。
- 最小化复现：[1] 的 11 行 distinct 文本即为最小输入（≥200B、无任何可压缩模式、含一个 generic 密钥）。
- 终态判据：同一脚本复跑（fixture 同步 R3 修订：[2] 消息加长至 ≥200 字符）→ [1] secret visible=false 且 secretsRedacted≥1；[2] wrapper=false 且解码文本 ≥200B 的 token 值替换为 `[redacted]` 族；解码 <200B 的 CLIXML 密钥按绑定策略保持可见（接受边界，显式记录非缺陷）；[3][4] 输出新方言。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 输出脱敏（默认行为级） | bash-compress `redactSecrets` | 压缩管线第 0 步 | 与压缩同管线是用户接受的绑定策略 | compaction.ts 的 `redactCommand` 只负责证据表命令列，不共享输出域 |
| CLIXML 解码 | bash-compress `decodePowerShellClixmlPlain`（单一实现） | 纯块解码、混合 passthrough | win32 `normalizePowerShellOutput` 与内部路径共用此实现，消除分叉即消除双实现 | shell.ts 只做调用点选择，不拥有解码器 |
| 行内/摘录标记方言 | bash-compress 各生产函数 | 设计文档三层格式 | 标记的生产者唯一 | output-notice.ts 只拥有块级 notice 家族（panel-isolation plan 边界） |
| 标记图例 | shell.ts compressionGuidance | 模型可见工具描述 | guidance 的既有 owner；config 可达（bashCompressionEnabled） | prompt.ts 无 config 访问（render 无 config 参数），故 shell.ts 追加是既有正确 seam |
| 死代码删除 | bash-compress / shell.txt / prompt.ts | — | 适配器与占位符的宿主 | — |

## 10. Single Approved Primary-Path Design

一条权威管线（对 `compressVisibleOutput` 内部结构收敛，非新增成功路径）：

```text
text
  → 0: transformPowerShellClixml（前置、无条件、纯解码无包装；解码是编码正确性修复，
       先于 enabled/shouldCompress 闸门，与 win32 normalizePowerShellOutput 行为对齐；
       null 时原文直通）
  → gate(enabled, shouldCompressOutput(source))：闸门求值于解码后文本（gate-on-decoded，
     与 win32 路径一致）；解码后 <200B 的输出按用户接受的绑定策略（§1 要素 1）跳过脱敏
     ——显式接受边界；不过闸 → 返回 source（解码文本）+ emptyStats
  → redactSecrets（两类词表，见下）
  → VirtualTerminal 渲染 → template → blocks → same → highEntropy → inline（统一方言）
  → applied := secretsRedacted > 0 || (compressedBytes < originalBytes && 任一分组>0)
  → applied ? 返回管线文本 : 返回 source
```

标记方言精确映射（生产字符串，一次定死）：

| # | 现行（行号） | 新方言 |
| --- | --- | --- |
| 1 | `... [terminal progress collapsed: N frames]`（:604） | `[... progress ${frames} frames->final]` |
| 2 | `... [previous W lines repeated R-1 more times]`（:1071） | `[... repeated block ${repeats}x, ${width*repeats}L->${width}L]` |
| 3 | `... [same line repeated N-1 more times]`（:1139） | `[... same line ${count}x]` |
| 4 | `... [template repeated N times: "..."]`（:1368） | `[... template repeated ${count}x]`（first:/last: 实例行保留） |
| 5 | `[repeated "p" ×N]`（:1209,:1249） | `[... repeated ${quotePattern(pattern)} x${repeats}]` |
| 6 | `[bar N×"="]` 等（:1437） | `[... ${name} ${count}x]` |
| 7 | `... (N more)`（:1462） | `[... ${items.length - 6} more]` |
| 8 | `<high-entropy T omitted: N bytes, hash=…, prefix=…, suffix=…>`（:1407） | `[... high-entropy ${type} ${bytes}B hash=${hash} head=${head}]`，head=行首 7 字符（R2：用户要求保留可识别性；无后缀） |
| 9 | `<high-entropy powershell-clixml>…</…>`（:1562，随早返回删除） | 删除包装，解码正文直出 |
| 10 | `<bash_high_signal_excerpt>` + `(root cause)`/`(fatal)`（:2054-2072） | 头行 `<opencode_excerpt type="shell_high_signal" exit="N" contexts="N" errors="N" warnings="N" />`；正文首行 `Error contexts omitted from the visible output:`；块头 `[Lx-Ly] root_cause` / `[Lx-Ly] fatal` / `[Lx-Ly]`；正文行保持 `  N \| text` 与 `> N \| text`。属性由 renderDiagnosticAppendix（持有 options.exitCode 与 snapshot 计数）构造后传入正文渲染 |
| 11 | `<REDACTED_API-KEY>` 等（:316） | 两级方言+头部保留（R2）：特定值型→原值 ≥16 字符时 `${match.slice(0,7)}…[redacted ${name}]`（如 `sk-abcd…[redacted api-key]`），短于 16 无头部；generic 键值型→正则改为 `\b(password|passwd|pwd|secret|token|key|api[_-]?key)(\s*[:=]\s*)(["']?)([^"'\s]{8,})["']?` 捕获键名、分隔符、开引号与值（收尾可选闭引号不捕获），值 ≥16 字符时 `${key}${sep}${quote}${value.slice(0,7)}…[redacted]`，否则 `${key}${sep}${quote}[redacted]`（保留键名与开引号，与 compaction.ts:466-472 同族；`\b` 同时修复 `monkey=…` 误伤；N-04 引号回写；NB-01 字面转写修正：分组按本句为准） |

`stats.secretsRedacted` 继续计数全部替换；CLIXML 解码不再计入 `highEntropyLines`/`applied`（解码非压缩，stats 如实）。

图例（shell.ts compressionGuidance 追加第 3 条 bullet，约 +60 token 固定成本）：

```text
- Short harness markers may appear inside compressed output; the command did not
  print them: `[... same line Nx]`, `[... repeated block Nx]`, `[... template
  repeated Nx]`, `[... progress N frames->final]`, `[... high-entropy <kind>
  <size>B head=...]` (oversized base64/JWT/hash lines), `[redacted ...]` (detected
  secrets; a short head is kept for identification). First occurrences and error
  lines are preserved; omitted content is intentionally dropped, not a failure
  to investigate.
```

删除清单（死代码/残留）：`CommandAdapter`/`CommandAdapterContext` 类型、4 个 Adapter 类、`COMMAND_ADAPTERS`、`detectCommandAdapter`/`applyCommandAdapter` 导出、`CompressionConfig.enableCommandAdapters` 字段 + 默认值 + `OPENCODE_BASH_ENABLE_COMMAND_ADAPTERS` env、`bashCompressionMetadata` 不变；`shell.txt:9` `${shellGuidance}` 与 `:15` `${compressionGuidance}` 两行、`prompt.ts:288-289` 对应 `""` 传参。

设计文档同步（`docs/tool-output-notice-format-design.md`）：迁移表标注已完成项（bash-compress 内联层、excerpt、REDACTED 补目），适配器 4 条目改记"已删除（死代码）"，实施顺序段落移除已完成/弃用步骤；并在该文档记录高熵标记采用 `${bytes}B` 原始字节单位（N-03 记录修正：防文档示例 `8KB` 与实现漂移，理由=避免第 5 个生产文件/双实现），以及 R2 定向偏离：脱敏与高熵标记保留 7 字符头部（head=，用户授权，覆盖"prefix/suffix 默认不出现"）。

为何修复 first divergence：INV-01/02 的回退点都在 `compressVisibleOutput` 的返回谓词与早返回分支——本设计直接修改该分支归属（早返回并入主管线、谓词补全），不新增任何下游补偿；INV-03/04/05 均为生产点原文与 prompt 的定点替换/删除，无路径分叉。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| CLIXML 早返回（包装+跳闸） | current | 主管线旁路（INV-02 分叉根源） | yes | 并入主管线后删除 | remove |
| CLIXML decode→continue（前置步骤） | proposed | primary-contract branch（编码修复语义，闸门前执行） | yes（解码正确性，非备用成功） | 主管线第 0 步 | preserve（即 primary） |
| win32 `normalizePowerShellOutput`（shell.ts:1291） | current | existing compatibility（调用点，与内部路径共享 `decodePowerShellClixmlPlain` 单一实现） | n/a（前置归一） | 1 个既有调用点 | preserve |
| 混合 CLIXML 块 passthrough（isPurePowerShellClixmlBlock 拒绝） | current | contracted pass-through（test:67-84 契约） | no（原样保留） | 既有 | preserve |
| gate 跳过（<200B / disabled / compress_output=false，含脱敏跳过） | current | explicit user-accepted policy（§1 要素 1） | n/a | 既有闸门 | preserve |
| 命令适配器 | current | 死代码 | 不可达 | 0（删除） | remove |

新增 alternate success path 数：0。诊断行为占比：excerpt 头行属性构造为对既有诊断输出的重组，不新增分支语义，占比 <10%。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| CLIXML 早返回 + `<high-entropy powershell-clixml>` 包装 | 历史上把解码当作"高熵处理"的一种 | 解码是编码修复，属主管线第 0 步；包装语义与"省略"冲突且造成平台分叉 | bash-compress.ts:1546-1563 删除 `transformPowerShellClixml` 的包装版与早返回块，保留纯解码并前置 |
| 4 个命令适配器 + 注册表 + 2 导出 + 配置项 | Phase 4 设想未接线 | 零调用方死代码；用户要求移除 | bash-compress.ts:28-43,:739-999；config 字段 :114-116,:245 |
| `shell.txt`/`prompt.ts` 死占位符 | guidance 迁移到 shell.ts 追加后的残留 | 真实 seam 在 shell.ts，占位符恒 `""` | shell.txt:9,:15；prompt.ts:288-289 |
| `applied` 谓词字节守卫对脱敏的误伤 | 谓词只度量压缩分组 | 脱敏命中即视为"已应用"（正确性优先于字节数） | bash-compress.ts:1743-1751 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | applied 谓词 + 返回分支 | bash-compress.ts | T1（secrets-only 输入：secret 不可见、applied=true、secretsRedacted≥1） |
| INV-02 | CLIXML 前置解码并入管线 | bash-compress.ts | T2（纯 CLIXML：无包装、token 值→`[redacted]` 族、stats 不谎报）；T2b（与 normalizePowerShellOutput 同输入同输出） |
| INV-03 #1-#9 | 各标记生产点字符串 | bash-compress.ts | T3a-T3e（same/block/template/inline/progress/high-entropy/list/bar 新方言断言，独立字面期望值） |
| INV-03 #10 | renderDiagnosticAppendix/Contexts 重组 | bash-compress.ts | T4（shell.test.ts live：失败长命令输出含 `<opencode_excerpt type="shell_high_signal"` 与 `root_cause`；可见 fatal 用例不含 excerpt） |
| INV-03 #11 | redactSecrets 两类词表 | bash-compress.ts | T5（含头部保留断言） |
| INV-07 | 头部保留（SECRET_HEAD_CHARS=7、SECRET_HEAD_MIN_LENGTH=16） | bash-compress.ts | T5（长值/短值/特定值三类）；T3 高熵 head= 断言 |
| INV-04 | compressionGuidance 图例 | shell.ts | T6（`initShell().description` 含标记家族与"command did not print"；压缩禁用配置下不含图例段） |
| INV-05 | 适配器/占位符删除 | bash-compress.ts、shell.txt、prompt.ts | T7（`bun typecheck` 编译期验证导出消失；grep 零残留）；既有全量测试回归 |
| INV-06 | 无（守卫） | 无生产改动 | 既有 shell.test.ts / compaction.test.ts / bash-compress.test.ts 全绿 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| applied 谓词补 secretsRedacted | INV-01 | repro-v2 [1] | 现谓词 OR 链无该项，回退分支丢弃脱敏结果 |
| CLIXML 前置解码 + 删包装 | INV-02 | repro-v2 [2]；两路径源码分叉 | 早返回结构性地跳过脱敏/压缩，无法在分支内修补 |
| 10 处标记字符串重写 | INV-03 | 设计文档契约 + repro 样本 | 现文案即不一致本身 |
| excerpt 头行属性构造（renderDiagnosticAppendix 传参） | INV-03 #10 | 设计文档 §opencode_excerpt | 现私有 tag 无属性层；属性数据（exit/counts）只在 appendix 层可达 |
| redaction generic 正则捕获前缀+值 + `\b` | INV-03 #11 | compaction.ts:466-472 同族方言；`monkey=` 误伤实测推演 | 现正则无捕获组吞键名、无词边界 |
| 头部保留（SECRET_HEAD_CHARS=7 + SECRET_HEAD_MIN_LENGTH=16） | INV-07 | 用户 R2 原文（§1） | 全隐头部丧失可识别性；无门槛则短凭据泄露大半（N-05：特定值型家族最小匹配 ≥20 字符，门槛恒真，实际作用于键值型 8-15 字符短值——统一常量规则） |
| guidance 图例 bullet | INV-04 | 用户原文 §1 要素 3/4 | 现有 2 条 bullet 无任何标记说明 |
| 适配器/占位符删除 | INV-05 | grep 零调用方 | 死代码本身 |

无一概念以"best practice/未来扩展"立项。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/bash-compress.ts` | modify | applied 修复；CLIXML 前置解码+删包装；10 处标记方言；redaction 两类词表；excerpt 重组；删除适配器全家+配置字段 | +110 / −280（净 −170） |
（N-01 记录修正：四文件合计 +119/−284，净 −165）
| `packages/opencode/src/tool/shell.ts` | modify | compressionGuidance 追加图例 bullet | +9 |
| `packages/opencode/src/tool/shell/shell.txt` | modify | 删除 2 个死占位符行 | −2 |
| `packages/opencode/src/tool/shell/prompt.ts` | modify | 删除 2 个 `""` 传参 | −2 |
| `packages/opencode/test/tool/bash-compress.test.ts` | modify | 更新 4 处旧方言断言；新增 T1/T2/T2b/T3a-e/T5 用例 | +150 / −6 |
| `packages/opencode/test/tool/shell.test.ts` | modify | :2321/:2349 excerpt 断言更新；新增 T6 图例用例 | +18 / −2 |
| `docs/tool-output-notice-format-design.md` | modify | 迁移表完成态标注、REDACTED 补目、适配器条目改删除、实施顺序清理 | +12 / −18 |

生产文件 4 个（恰好预算上限）、生产代码改动约 +121/−284（净 −163，远低于 800 行上限）。

## 16. TDD Behavior Slices

Seam（预先约定）：S1 = `compressVisibleOutput`（bash-compress 公开导出）；S2 = `ShellTool` 注册定义（`initShell().description`）与 `execute` 输出（shell.test.ts 既有 harness）。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | T1: 508B distinct 行 + `password=SuperSecret99` → 期望 text 不含密钥、`stats.secretsRedacted===1`、`stats.applied===true`（repro[1] 场景入测试） | applied 谓词回退原文 | 谓词补 `secretsRedacted > 0`，返回管线文本 | 既有压缩收益用例不回退 |
| 2 | T2（gate-on-decoded 钉死，B-01 修订）: 纯 CLIXML 解码消息 ≥200 字符（单行经 length≥80 分支过闸）→ 期望无 `high-entropy` 包装、token 值为 `[redacted]` 族、`applied` 不因解码为 true、`highEntropyLines===0`；另钉接受边界：解码消息 <200B 变体 token 明文可见（绑定策略，非缺陷） | 早返回+包装+跳脱敏；192 字符 fixture 在两种读法下均不可绿（B-01） | 前置解码并入管线，闸门求值解码文本 | test:29-65 行为反转后稳定；:67-84 混合 passthrough 不变 |
| 3 | T2b: 同一纯 CLIXML 输入（解码文本 <200B、无密钥、无可压缩模式，如 test:29-49 型 fixture）断言 `compressVisibleOutput(x).text === normalizePowerShellOutput(x)`（N-02 记录修正：fixture 需钉住等式成立条件，避免管线内脱敏/压缩使两路径分歧） | 现两路径输出不同（包装 vs 纯文本） | 删包装后天然一致 | 平台分叉消除的显式锁 |
| 4 | T3（8 个独立用例，N-02/N-03 修订）：same-line/block/template/inline/progress/high-entropy/list/bar 各一输入，断言新方言字面值（独立期望）；**fixture 须独立满足 `shouldCompressOutput` ≥200B**：bar 用 `"=".repeat(220)`→`[... bar 220x]`，list 用 25 项→`[... 19 more]`，高熵断言含 `head=7字符`；same-line 25 行（249B）、block 25 行（324B）、template 8 行（~350B）、progress 含 \r（~265B）均过闸 | 现文案为旧方言；bar 120B/list 198B fixture 不过闸（N-02） | 各生产点字符串替换 | 旧文案断言同步更新（test:109,:116） |
| 5 | T5: 短值 `password=SuperSecret99`（13 字符）→ `password=[redacted]`（无头）；长值 `token=abcdefghijklmnop`（16 字符）→ `token=abcdefg…[redacted]`；`sk-abcdefghijklmnopqrstuvwxyz` → `sk-abcd…[redacted api-key]`；`monkey=abcdefghij` 原样 | 现正则吞键名/无词边界/无头部保留/吞引号 | 捕获前缀+开引号+值 + `\b` + 7 字符头部（仅 ≥16 字符）；T5 补带引号用例 `password="SuperSecretValue123"` → `password="SuperSe…[redacted]`（N-04） | compaction 方言一致性 + R2 可识别性 |
| 6 | T4: shell.test.ts live 失败长命令 → `<opencode_excerpt type="shell_high_signal"` + `root_cause`；可见 fatal 用例 `not.toContain("<opencode_excerpt")` | 现为 `<bash_high_signal_excerpt>` | excerpt 重组 | exit notice 独立性（既有断言）不变 |
| 7 | T6: `initShell().description` 含 `harness markers` 家族与 "the command did not print"；config `bash_compression:false` 下 description 不含图例段 | 现无图例 | guidance bullet | 既有 2 条 bullet 保留 |
| 8 | T7/回归: `bun typecheck` + 两个测试文件全量 + compaction.test.ts | — | — | INV-06 |

每片先红后绿；期望值全部为独立字面量（不重算实现逻辑）。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ≈245 | 生产 +135（含头部保留常量/门槛 ~+16）+ 测试净 +110；排除 import/纯格式 |
| Required Chinese explanatory comments `C` | ≥37 | `if E > 0: C >= max(1, ceil(245*0.15)) = 37` |

需就近中文注释的点：applied 谓词"脱敏命中即应用（正确性优先于字节）"；CLIXML 前置"解码是编码修复，先于压缩闸门，与 win32 normalize 路径对齐"；`\b` 词边界"防 monkey= 类误伤"；generic 保留键名"与 compaction 证据表方言同族"；excerpt 属性构造"数据只在 appendix 层可达"；图例 bullet"防诱导关压缩的三要素"；每个新标记的"短于被替换内容"约束；测试的 behavioral intent（图例断言、方言锁、回退锁）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/bash-compress.test.ts` | packages/opencode | T1/T2/T2b/T3/T5 绿；既有 10 用例（更新后）绿 |
| `bun test test/tool/shell.test.ts` | packages/opencode | T4/T6 绿；notice/截断/面板隔离全量回归 |
| `bun test test/session/compaction.test.ts` | packages/opencode | INV-06（compaction `[redacted]` 方言与 Evidence 不受影响） |
| `bun typecheck` | packages/opencode | 适配器导出删除后零编译残留（T7） |
| `bun run D:\Temp\opencode\repro-v2.ts` | D:\Temp\opencode | 原始反馈环路复跑：LEAK 全 false、wrapper=false、新方言输出 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 无新模块 |
| Files modified | 7（生产 4 + 测试 2 + 文档 1） | 用户预算：生产 ≤4 文件、≤800 行 |
| Files deleted | 0 | 删除以行级进行 |
| Production lines | ≈ +135 / −284（净 −149；R1 为 +119/−284，R2 头部保留与门槛约 +16） | 主要由适配器删除（−240）驱动 |
| Test lines | +168 / −8 | 8 片行为切片 + 断言更新 |
| Generated lines | 0 | 无 |

## 20. Real Risks and Open Decisions

### Real risks

- CLIXML 并入管线后，解码文本可能触发模板/同线压缩，test:51-65 断言需按新行为更新（实施时以实际输出为准，保持"解码信息不丢"的契约断言）。
- shell.test.ts live 用例含 2100ms 睡眠跨 `diagnosticMinRuntimeMs=2000` 阈值，属既有模式，不新增时序敏感面。
- 图例 +~60 token/会话固定成本（用户已接受：换调试收益与输出侧每次出现的净省）。
- 删除 `enableCommandAdapters` 配置字段是对 `CompressionConfig` 类型的 breaking 收缩——零调用方（grep 证明），无兼容消费者。

### Open Decisions Requiring the User

无（方言选型、绑定策略、删除决策均已在会话中确认并引用于 §1）。

### Rejected Speculation

- redaction 与压缩解耦（用户明确拒绝，引用见 §1 要素 1）。
- `output_compressed` notice（设计文档默认不显示；图例已覆盖）。
- 摘录 `line_source="shown"` 属性（行号恒来自隐藏原始流，设计文档默认无需标注）。
- 高熵标记保留 suffix/后缀（用户仅要求头部；尾缀无额外可识别性收益）——R2 头部保留为用户授权的对设计文档"prefix/suffix 默认不出现"规则的定向偏离，设计文档同步段一并记录。
- 复用/导出 `output-notice.ts` 的 `formatBytes` 做 KB 格式化（引入第 5 个生产文件与跨模块耦合，`${bytes}B` 已满足短格式）。
- `×`→`x` 之外的标记语义增强（如重复块保留更多实例）——无需求证据。

## 21. Audit Contract

独立审计者必须：

- 阅读本文件当前修订与 §1 原始需求。
- 从仓库证据重建行为，将 builder 摘要视为不可信。
- 每轮审计完整原始范围（§13/§14 双向映射、§15 文件计划、§16 切片、§17 注释预算）。
- 每个 blocking finding 附证据（observed/contracted/reachable）。
- 同时检查 under-design 与 over-design。
- 检查根因修复、fallback、ownership、测试、代码质量与 15% 中文注释计划。
- 生产文件数 ≤4、生产代码 ≤800 行、无红测终态为用户的硬约束（违反即 blocking）。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 无 | N-01 §15 行数算术漂移（+121 应为 +119）；N-02 T2b fixture 需钉住等式成立条件；N-03 建议设计文档同步记录 `${bytes}B` 单位决定；N-04 "T3a-T3e" 标签与 8 类标记不对应；N-05 图例 `[... progress N frames]` 与标记 #1 `frames->final` 措辞差异 | **No blocking findings. APPROVE**（R1，full scope；N-01…N-05 为记录修正，不清空 approval） | task ses_f8a79b6e6ffes8yUf6sytxNQsb |
| 2 | R2 | yes | B-01 CLIXML 闸门语义自相矛盾：§10 gate-on-decoded 与 §8 repro[2] 终态判据、§16 T2 绿态、§18 "LEAK 全 false" 互斥，两种读法至少一条 contracted 验收必败（fixture 192 字符实数复算） | N-01 行号/行数基于 HEAD 基线已漂移；N-02 bar 120B/list 198B fixture 不过闸；N-03 高熵断言缺 head=；N-04 替换模板吞可选引号；N-05 ≥16 门槛对特定值型恒真 | **BLOCK**（R2，full scope；B-01 修复后升 R3 重审） | task ses_f8a61f084ffexo88l1ux8lzL7U |
| 3 | R3 | yes | 无 | NB-01 §10 #11 正则字面转写与自身示例不一致（非捕获前缀但引用 ${key}、未消费闭引号）——以示例为准已作记录修正；NB-02 工作树 5 处 fixture 滞后 R3 规范（T2 192 字符/bar 120B/list 20 项/高熵缺 head=/T5 缺头部用例）为实施期检查点；NB-03 §15/§19 行数估算漂移（+119/+121/+135 三读，均在预算内）；NB-04 \\${count\\} 语义未文字消歧（树内测试钉 total，与图例一致） | **No blocking findings. APPROVE**（R3，full scope，round 3/6；NB-01..NB-04 为记录修正与实施检查点，不清空 approval） | task ses_f8a4fade5ffeMfrH1BruoE64qp |

R3 已批准；实施按 R3 执行（含 NB-02 五处 fixture 同步）。

## 23. Implementation Evidence

（实施后填写。）

**R1 实施中断记录（2026-09-06）**：R1 批准后已实施并验证红相（bash-compress.test.ts 对当前生产 14 fail / 6 pass，失败理由经独立探针核实）；生产编辑完成部分——适配器区段删除（262 行，脚本带内容验证）、`enableCommandAdapters` 配置与接口删除、SECRET_VALUE_PATTERNS/SECRET_ASSIGNMENT_RE 结构重写（无头部版）；R2 用户修订到达时按 Phase 9 暂停。已完成部分与 R2/R3 设计方向一致（替换格式需按 R2 补头部门槛、R3 补引号回写），无需回退。

**基线说明（N-01）**：本 plan §4-§12 中的源码行号与 §15/§19 的删除量估算基于 HEAD 基线（bash-compress.ts 2153 行）；工作树已部分实施（当前 1856 行，applied 谓词约 :1446-1454、excerpt 约 :1755-1777、适配器区段已不存在）。

### Actual Files and Diff

`git diff --numstat`（仅本 GOAL 路径；工作树另有他人并行的 voice/TUI 修改，未触碰）：

| File | +/- | 说明 |
| --- | --- | --- |
| `packages/opencode/src/tool/bash-compress.ts` | +88 / −385 | 适配器删除（含配置/env）、脱敏两级方言+头部保留+引号回写、10 处标记方言、CLIXML gate-on-decoded 重构、applied 谓词修复、excerpt 重组 |
| `packages/opencode/src/tool/shell.ts` | +3 / −0 | compressionGuidance 图例 bullet |
| `packages/opencode/src/tool/shell/shell.txt` | 0 / −4 | 死占位符删除 |
| `packages/opencode/src/tool/shell/prompt.ts` | 0 / −2 | 死 `""` 传参删除 |
| `packages/opencode/test/tool/bash-compress.test.ts` | +194 / −7 | 4 处旧方言断言更新 + 15 个新用例（含 B-01 边界钉死） |
| `packages/opencode/test/tool/shell.test.ts` | +32 / −3 | excerpt 断言更新 + T6 图例两用例 |
| `docs/tool-output-notice-format-design.md` | +7 / −7 | 迁移状态/适配器删除/REDACTED 补目/head 偏离/B 单位（N-02 修正：实测 numstat） |

生产文件 4 个（预算上限 4）；生产代码 +91/−391（预算 ≤800，运低于限）。

### Red-Green Test Evidence

- 红（实施前，对未修改生产代码）：bash-compress.test.ts **14 fail / 6 pass**（含 INV-01 密钥可见、INV-02 wrapper+明文、全部新方言断言）；失败理由经独立探针（D:\Temp\opencode\probe-clixml.ts hex 输出）核实，排除会话压缩层双重改写干扰。
- 绿（实施后）：bash-compress.test.ts **21 pass / 0 fail**；shell.test.ts **204 pass / 0 fail**（含 T4 excerpt live 用例与 T6 图例正反两例）。
- 实施中修正：progress fixture 期望帧数 5→4（5 段 CR 连接=4 帧，期望值错误非实现错误）；一处注释转义断裂即修。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/tool/bash-compress.test.ts` | packages/opencode | 21 pass / 0 fail |
| `bun test test/tool/shell.test.ts` | packages/opencode | 204 pass / 0 fail（158s，live） |
| `bun test test/session/compaction.test.ts` | packages/opencode | 72 pass / 0 fail（INV-06） |
| `bun typecheck` | packages/opencode | 本 GOAL 六文件零错误；exit 2 来自 HEAD 既有的 TUI voice/attention 面（src/cli/cmd/tui/*，与本次改动无关，git status 证实这些文件未修改） |
| `grep applyCommandAdapter\|enableCommandAdapters` | 仓库根 | src/test 零残留（仅 plan 文档与 thirdparty 历史存档） |

### Original Feedback-Loop Result

`bun run D:\Temp\opencode\repro-v2.ts`（R3 判据，输出 base64 防会话压缩改写）：
- [1] secret visible=**false**、secretsRedacted=1、applied=true（INV-01 终态）
- [2] 长（≥200 字符解码）：wrapper=**false**、token=**[redacted]**、statsLie=0（INV-02 终态）；[2s] 短（<200B）：token 可见、applied=false（接受边界，已钉测试）
- [3] `repeat-me\n[... same line 25x]`；[4] `[... repeated "abc" x6000]`
- [5] `auth uses sk-abcd…[redacted api-key] here`（R2 头部保留实测）

### Actual Secondary and Replacement Path Inventory

- CLIXML decode→continue（gate-on-decoded）：primary-contract 分支（编码修复语义）；早返回旁路已删除；新增 alternate success path = 0。
- win32 `normalizePowerShellOutput` 调用点：既有 shipped（共享单一解码实现）；混合块 passthrough：既有契约（测试锁）；闸门跳过（<200B/禁用/compress_output=false）：用户接受策略。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ≈268 | 生产 +91 中剔 27 行注释 ≈ 64；测试 +226 中剔 ~20 行注释 ≈ 206；合计 270，保守取 268（另剔除纯格式行） |
| Qualifying Chinese comment lines `C` | 49 | bash-compress 27、shell 2、bash-compress.test ~17、shell.test 3；均邻决策点（谓词/闸门/词边界/头部门槛/excerpt/图例/fixture 意图） |
| Ratio `C / E` | ≈0.183 | ≥0.15 |
| Required minimum `C` | ≥41 | `ceil(268×0.15)=41`；实际 49 ✓ |

### Remaining Unverified Items

- `bun typecheck` 全包级 exit 2 由 HEAD 既有 TUI voice/attention 错误导致（他人并行工作面，非本 GOAL 路径，未触碰不修）；本 GOAL 六文件零类型错误已单独验证。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R3 | yes | 无 | N-01 设计文档同步用状态注记而非删除已完成阶段段落（已补做折叠；无重审触发）；N-02 §23 设计文档 numstat 漂移（+8/−6 实为 +7/−7，已修正）；N-03 transformPowerShellClixml 与 normalizePowerShellOutput 为 8 行同构包装（plan 批准形态，解码算法单一源）；N-04 context-usage.ts 存在既有死占位符替换（改动前即 no-op，非本 GOAL 路径与预算内） | **No blocking findings. APPROVE**（R3 实现审计，round 1/3，full scope；E≈270/C≈48-50/比值≈0.18 独立复算达标） | task ses_f8a36957bffee1bob7qThLp6yF |
