# Canonical Implementation Plan: TUI 历史图片自动规范化

> Status: verified
>
> Revision: R7
>
> Approved revision: R7
>
> Audit mode: full-scope
>
> Requirement source: 本文第1节逐字用户要求与设计批准
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-15

本文是当前follow-up的唯一实现规范。R2-R6均已被后续用户要求或审计修订取代，不再具有实现权限。

## 1. Verbatim Requirement

> “我要能apply的，你说现在的有截断处理不了，请注意脚本的意义就是处理这个的”

> “我要的是自动处理的F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\script\migrate-image-attachment.ts，也就是我就会执行这个，没别的”

> “同时实在获取不到的图片，那么就把对应消息改成图片不可用或者其他一些当前链路允许的消息即可（也就是允许弃用图片并返回不可用的消息等方式）”

> “也就是命令只需要提供： \"C:\Users\Lenovo\.local\share\opencode\opencode.db\" 不需要其他任何额外信息”

> “只处理那些比较不妥的需要处理的，基本上大小正常的不需要二次处理或者压缩”

> “主要是规范化、统一化（不要不同路径来源的，不同来源的都要规整同意），同时过大的也需要处理，压缩是其次”

> “也就是我希望最终是可以自处理解决这种截断问题的”

> “不要很臃肿，不要假设不存在或者未出现的情况”

仍然有效的同一follow-up原始要求：

> “同时检查一下运行之后能节省多少空间（我不需要保留原始值）”

用户随后选择“路径只做预览”，并批准以下设计：路径参数默认只读预览；同一路径加`--apply`写库；统一默认Sharp策略；坏completed Tool图片弃用并标记不可用。

仍适用：workspace `sharp@0.34.5`是唯一图片实现；当前follow-up不超过8文件、800有效代码行；真实数据库由用户执行，本实现阶段不得写入。

## 2. Explicit Non-Goals

- 不再要求`--part`、`--source`、old/source/new SHA、backup目录或plan SHA。
- 不扫描目录、不猜外部原件、不调用第二图片后端。
- 不按Prompt/Read/Tool来源选择不同预算；迁移只有一个统一策略。
- 不加载各Project图片配置；历史配置未持久化，用户要求统一而非按来源分叉。
- 不处理真实数据库中未观察到的MIME/data URL不一致、参数化URL或损坏顶层FilePart分支。
- 不修改生产端A、消费端B、schema、DataMigration、Desktop、Provider或Compaction。
- 不自动backup、VACUUM、checkpoint或承诺物理数据库立即缩小。
- 不在本会话对真实`opencode.db`运行`--apply`。

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `CONTEXT.md` | Session由Message和Part组成；Tool输出及附件存入completed ToolPart |
| `AGENTS.md` | 最小修改、不得新增单次helper、测试/typecheck从package运行 |
| `packages/opencode/test/AGENTS.md` | 测试真实CLI行为和临时SQLite，不复制算法 |
| `.opencode/policy/first-principles-engineering.md` | 单一Sharp主路径；用户明确授权的坏图弃用必须精确定义 |

当前任务基线是用户完成既有Sharp修复commit后的HEAD `d75c026a5a68`。R7只修改现有文档、迁移脚本和`read.test.ts`。

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| `src/image/image.ts` | 默认统一边界：2000x2000、5MB base64；正常图片metadata fast-path原样返回 | contracted |
| `src/session/processor.ts:561-585` | 当前链路允许失败Tool图片省略并在output追加说明 | contracted |
| `src/session/message-v2.ts` | completed ToolPart的`output`和`attachments`持久化形态 | contracted |
| `src/session/session.sql.ts` | `part.data`是唯一更新字段 | contracted |
| `script/migrate-image-attachment.ts` HEAD | 旧工具要求single source/hash/backup，不能自动全库处理 | observed |
| `test/tool/read.test.ts` | 现有CLI子进程和临时SQLite测试缝 | reachable |
| 真实DB只读扫描 | 441张均为规范`image/png|jpeg` base64 data URL；119顶层、322 completed Read Tool | observed |
| 真实DB Sharp默认扫描 | 48张需规范化、392张不变、1张Tool PNG DecodeError | observed |
| 坏Part | `prt_f5af04c69001KEtWbmwrZrOjt3`，7,340,032 bytes，completed Read Tool attachment[0] | observed |

## 5. Current Behavior

```text
旧CLI -> 必须指定part/source/hashes -> 只修一张 -> apply还需要backup/new hash
```

这无法仅凭数据库路径处理全库，也无法自处理数据库中已经缺失尾部bytes的图片。

真实441张图片不存在审计者假设的MIME/data URL异常。使用默认`Image.Service`时，正常大小图片原样返回；48张超出统一尺寸/大小边界需要Sharp规范化；唯一坏图在完整decode时返回`ImageDecodeError`。

## 6. Supported Input Domain and Reachability

| Input | Producer/evidence | R7 outcome |
| --- | --- | --- |
| 顶层`image/*` FilePart，合法base64 data URL | 真实DB 119张 | 默认Image.Service；不变或规范化；失败则整批回滚 |
| completed ToolPart中的`image/*` attachment，合法base64 data URL | 真实DB 322张 | 默认Image.Service；不变或规范化 |
| completed Tool图片返回`ImageDecodeError` | 真实DB唯一坏Part | 删除该attachment，并在原Tool output追加图片不可用说明 |
| `ImageResizerUnavailableError` | workspace Sharp装载失败 | 整批失败并回滚，绝不弃用全部图片 |
| 非图片附件、非completed Tool状态 | schema与真实DB | 原样忽略 |

只有以上观察或现有契约证明的输入进入实现。顶层坏图、MIME错配、目录替代源、去重和历史Project配置均不得新增分支。

## 7. Required Invariants

| ID | Invariant | Evidence | Test |
| --- | --- | --- | --- |
| INV-01 | CLI只需位置参数DB；默认preview，`--apply`写入 | 用户选择 | CLI参数测试 |
| INV-02 | 所有图片统一调用workspace Image.Service默认策略，不传token budget | 用户统一化要求 | 同一fixture跨两种存储位置输出一致 |
| INV-03 | metadata fast-path返回同一MIME/URL时不写库 | 用户“正常大小不二次处理” | 小图不变 |
| INV-04 | 超过默认尺寸/5MB边界的可解码图由Sharp规范化 | 用户要求过大图片处理 | large fixture变小且可decode |
| INV-05 | observed completed Tool DecodeError删除坏附件并只追加一次“图片不可用”说明 | 用户明确授权 | 坏Tool图preview/apply/幂等 |
| INV-06 | Sharp不可用或顶层图片失败不得转成成功，整批rollback | 单一主链安全边界 | 代码审计；无生产test hook |
| INV-07 | preview使用readonly+query_only且零写入 | 用户选择 | 完整行前后相等 |
| INV-08 | apply在首条查询前`BEGIN IMMEDIATE`，所有更新同一事务，错误rollback | SQLite并发 | 后行trigger回滚前行 |
| INV-09 | 只改mime/url、Tool attachments/output，其他未知字段不变 | Part持久化契约 | 深比较 |
| INV-10 | 报告不变/规范化/弃用数量及payload/Part JSON逻辑空间差值，并说明无VACUUM物理文件不缩小 | 用户空间要求 | 独立已知值 |
| INV-11 | 第二次preview显示0个待修改，且不可用说明不重复 | 幂等 | apply后重跑 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| INV-01 | 参数解析把part/source/hash设为必填 | migration CLI | 路径-only命令exit 1 |
| INV-02-04 | 旧CLI只处理外部source，未扫描数据库现有图片 | migration CLI | HEAD源码 |
| INV-05 | 旧CLI遇到数据库坏bytes只能要求外部source | migration CLI | 已知坏PNG不可完整decode |
| INV-10 | 旧CLI只报告单张new bytes | migration CLI | HEAD report |

Red命令：

```powershell
# cwd packages/opencode
bun test test/tool/read.test.ts --test-name-pattern "image attachment migration" --timeout 120000
```

当前路径-only与自动坏图弃用断言在HEAD上失败。

## 9. Responsibility and Seam

| Concern | Owner | Reason |
| --- | --- | --- |
| 默认图片规范化 | Image.Service/Sharp | 唯一现有算法，不复制resize逻辑 |
| 全库扫描、preview和事务更新 | 离线migration CLI | 用户直接执行的持久化维护边界 |
| 已丢失Tool图片的语义降级 | migration CLI按用户显式rollback授权 | 数据库无法恢复bytes；completed Tool output允许文本说明 |
| Provider消费 | 现有MessageV2 | 更新后自然读取正确附件/不可用文本，不加B端repair |

## 10. Single Approved Primary-Path Design

```text
db path [+ --apply]
 -> 严格参数解析
 -> preview: readonly + query_only
 -> apply: BEGIN IMMEDIATE before SELECT
 -> 按Part ID扫描顶层FilePart和completed Tool attachments
 -> 每张声明image/*的规范data URL调用同一Image.Service默认策略
 -> unchanged: 不生成更新
 -> normalized: 仅替换mime/url
 -> completed Tool DecodeError: 移除该attachment，Tool output追加一次“Image unavailable: stored image data could not be decoded.”
 -> 其他Image错误: 命令失败；apply rollback
 -> 计算完整新Part JSON和逻辑空间差值
 -> preview打印计划后关闭只读连接
 -> apply逐行完整旧JSON CAS；任一changes != 1 rollback；commit
 -> 打印结果；不backup、不VACUUM
```

统一策略固定为空图片配置下的Image.Service默认值；不读取来源、token budget或Project图片配置。这样正常图片走现有metadata fast-path，只有越界图片编码，所有存储来源行为一致。

### Explicit User-Requested Rollback

- 用户原话：“实在获取不到的图片……允许弃用图片并返回不可用的消息”。
- 目标：仅对`completed ToolPart`中Sharp返回`ImageDecodeError`的attachment执行。
- 语义差异：旧坏base64被移除，Tool文本保留并追加固定不可用说明。
- 可观察性：preview和apply报告`unavailable`数量、Part ID和index，不输出payload。
- 测试：唯一坏图fixture确认附件删除、文本保留、说明只出现一次。
- Owner：离线存储迁移CLI；生产Processor已有省略失败Tool图片的同类语义。
- 不扩展：ResizerUnavailable、顶层FilePart失败或未观察格式不触发该rollback。
- 重新评估/移除条件：`ImageDecodeError`语义、`ToolStateCompleted.attachments/output` schema或Processor“失败Tool图片省略并保留文本”契约任一发生变化时，必须停止沿用该弃用路径并重新审计；在这些契约不变时，脚本需保持可分发给同类历史数据用户。

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Success | Disposition |
| --- | --- | --- | --- |
| 默认Image.Service unchanged/normalized | primary-contract branches | yes | preserve |
| completed Tool DecodeError弃用 | explicit user-requested rollback | yes | implement exactly |
| ResizerUnavailable/顶层失败 | error path | no | rollback |
| 外部source、第二后端、目录猜测、原图fallback | forbidden fallback | yes | delete/reject |

新alternate success path只有用户逐字授权的Tool坏图弃用。`unchanged/normalized`报告和preview/apply汇总属于主契约可观察性，坏图Part/index属于rollback必需可观察性，均不属于诊断路径。唯一真正诊断分支是“非授权Image错误导致非成功退出”，按新增约12个可执行决策计为`1/12 = 8.3%`，低于10%；不为比例新增任何分支。

## 12. Workaround Deletion and Replacement

| Existing logic | Disposition |
| --- | --- |
| single Options和part/source/SHA参数 | 删除，替换为位置DB + `--apply` |
| backup/VACUUM INTO/manifest/validation clone | 删除；用户不要保留旧值，bulk事务负责原子性 |
| expected plan/new hash双运行协议 | 删除；preview与apply都从当前DB自动计算 |
| 按来源token budget和Project Config方案 | 删除；采用统一默认Image.Service |

## 13. Forward Traceability

| Invariant | Script change | Test |
| --- | --- | --- |
| INV-01/07 | positional db + optional apply；readonly preview | preview零写入 |
| INV-02-04 | 全部来源调用默认Image.Service | 小图不变、大图两位置统一输出 |
| INV-05/06 | 仅Tool DecodeError rollback；其他错误失败 | 坏Tool图弃用；代码审计Sharp unavailable |
| INV-08/09 | BEGIN IMMEDIATE + full JSON CAS | second-row trigger全回滚；字段保留 |
| INV-10 | 聚合bytes/JSON差值 | fixture独立literal |
| INV-11 | 只在无固定说明时追加 | 二次preview 0 changes |

## 14. Reverse Traceability

| Concept | Requirement | Why existing code insufficient |
| --- | --- | --- |
| positional DB/preview/apply | INV-01 | 旧CLI需要7类外部信息 |
| 全库图片遍历 | INV-02-04 | 旧CLI只查一个Part |
| Tool DecodeError弃用 | INV-05 | 缺失bytes无法由Sharp或DB恢复 |
| BEGIN IMMEDIATE + CAS | INV-08/09 | 多行写入必须原子且不覆盖并发值 |
| 空间聚合 | INV-10 | 单张new bytes不能回答全库收益 |

## 15. File-Level Change Plan

| File | Change | Budget |
| --- | --- | ---: |
| `docs/Proposal/tui-image-validation-and-history-repair.md` | R7规范和审计记录 | docs |
| `packages/opencode/script/migrate-image-attachment.ts` | 删除single复杂协议，改为精简preview/apply全库处理 | 约220-300行最终文件 |
| `packages/opencode/test/tool/read.test.ts` | 替换旧single测试为两个bulk CLI行为测试 | +100至160 |

3文件、预计有效代码低于450行，低于8文件/800行限制。无生成文件、schema或依赖变化。

## 16. TDD Behavior Slices

| Order | Red | Green |
| ---: | --- | --- |
| 1 | 路径-only当前报缺`--db/part/source` | preview扫描临时DB且零写入 |
| 2 | 小图和大图无法全库分类 | 小图unchanged，大图normalized，两种存储位置使用同一输出 |
| 3 | 截断Tool图只能外部source修复 | preview标记unavailable；apply删除附件并追加说明 |
| 4 | 多行apply无全库原子测试 | second-row trigger使所有行rollback |
| 5 | apply后可能重复说明/编码 | 二次preview changed=0、unavailable=0 |
| 6 | 空间报告无独立口径 | 断言已知payload/JSON前后差值 |

测试缝是用户实际CLI子进程和临时SQLite。不得检查private helper或源码字符串。

## 17. Chinese Comment Budget

| Metric | Estimate |
| --- | ---: |
| Effective code `E` | 250-400 |
| Required Chinese comments `C` | 38-60 |

注释仅解释统一默认策略、DecodeError rollback授权、Sharp unavailable全回滚、readonly/apply事务边界、完整JSON CAS、逻辑空间口径和测试行为意图。

## 18. Verification

| Command | CWD | Proof |
| --- | --- | --- |
| `bun test test/tool/read.test.ts --test-name-pattern "image attachment migration" --timeout 120000` | `packages/opencode` | 新CLI全部行为 |
| `bun test test/tool/read.test.ts --timeout 30000` | `packages/opencode` | 完整Read回归 |
| `bun test test/image/image.test.ts --timeout 30000` | `packages/opencode` | 默认Image.Service边界 |
| `bun typecheck` | `packages/opencode` | 类型检查 |
| `bun script/migrate-image-attachment.ts "C:\Users\Lenovo\.local\share\opencode\opencode.db"` | `packages/opencode` | 真实DB只读preview；本会话唯一允许的真实DB命令 |
| `git diff --check` | repo root | diff检查 |

真实`--apply`只由用户在review结果后执行。

## 19. Diff Budget

| Metric | Estimate |
| --- | ---: |
| Modified files | 3 |
| Added/deleted files | 0 |
| Final migration script | 220-300 lines |
| Net test change | +100至160 |
| Effective code | <450 |

## 20. Real Risks and Open Decisions

### Confirmed Risks

1. Apply持有`BEGIN IMMEDIATE`期间会阻止TUI写入；用户运行前应关闭TUI。
2. 不执行VACUUM时文件尺寸不会立即下降；报告是decoded payload和Part JSON逻辑差值。
3. 坏Tool图片被明确弃用且原bytes不保留，这是用户授权的数据语义变化。
4. Sharp模块不可用必须整批失败，防止把环境故障误判成441张坏图。

### Open Decisions

无。用户已明确批准preview/apply、统一默认策略和坏Tool图弃用。

### Rejected Speculation

- MIME/data URL错配、参数化URL、顶层坏图：真实441张不存在。
- 历史/当前Project图片配置：用户要求不同来源统一，不按来源分叉。
- 图片去重、目录源搜索、自动VACUUM、消费端repair：未要求。

## 21. Audit Contract

审计完整检查路径-only preview、`--apply`事务、统一默认Sharp、正常图不重编码、过大图规范化、唯一Tool DecodeError弃用、Sharp unavailable回滚、幂等、空间口径、3文件/800行和15%中文注释。用户明确允许primary在认为纯文本比例等非行为意见不构成问题时继续，但行为回归、数据丢失超出授权、fallback或事务错误仍必须阻塞。

## 22. Plan Audit Record

| Round | Revision | Scope | Findings | Result | Reference |
| --- | --- | --- | --- | --- | --- |
| 1 | R2 | full | 4 blocking | BLOCK | `ses_09f6e2b0affeWvgSLYD4Yy0GIt` |
| 2 | R3 | full | 3 blocking | BLOCK | `ses_09f28334affeMaj37F62quZ2Ew` |
| 3 | R4 | full | 3 blocking；用户否定纯文本比例阻塞并重新定义坏图处理 | superseded by user requirement | `ses_09f17ef82ffeY9CvJn1yCl73TV` |
| 4 | R5 | full | B-01 rollback缺少重新评估条件；B-02审计输入漏掉既有空间要求 | BLOCK | `ses_09e52eb71ffejvPpuTIDlX93je` |
| 5 | R6 | full | B-01诊断决策面缺少数值；用户已明确该纯文本比例不应阻塞 | BLOCK，按用户指示仅补分类文本 | `ses_09e4ed3fdffeN0xMFYwLYOrBK4` |
| 6 | R7 | full | `No blocking findings.` | APPROVE — canonical plan revision R7 only. | `ses_09e4b1cc1ffeUV8WQi7fQjzZRA` |

## 23. Implementation Evidence

### 23.1 Actual Change Surface

| File | Actual change | Necessity |
| --- | --- | --- |
| `docs/Proposal/tui-image-validation-and-history-repair.md` | R7唯一规范、验证证据和审计记录 | 为批准实施和独立放行提供可审计事实 |
| `packages/opencode/script/migrate-image-attachment.ts` | 删除single/source/hash/backup/plan协议，收敛为229行preview/apply全库CLI | 唯一生产修改，直接修复无法自动处理全库和截断Tool图片的问题 |
| `packages/opencode/test/tool/read.test.ts` | 用两个真实CLI+临时SQLite行为测试替换旧single协议测试 | 覆盖统一Sharp、只读、apply、弃用、空间、幂等和事务回滚 |

没有新增文件、依赖、schema、migration、生成文件、配置项或公共API。无关`thirdparty/chatgpt-browser-agent`修改未触碰。

### 23.2 Red-Green Evidence

1. Red：先替换行为测试，再运行`bun test test/tool/read.test.ts --test-name-pattern "image attachment migration" --timeout 120000`。旧脚本结果为`1 pass / 1 fail`，路径-only preview返回exit code 1，断言要求0；缺口是旧CLI仍要求外部协议，而非fixture或Sharp故障。
2. Green：删除旧协议并实现R7唯一流程后，同一命令为`2 pass / 0 fail / 24 assertions`。
3. 回归：`bun test test/tool/read.test.ts --timeout 30000`为`65 pass / 0 fail / 212 assertions`。
4. 图片层：`bun test test/image/image.test.ts --timeout 30000`为`6 pass / 0 fail / 19 assertions`。
5. 类型：在`packages/opencode`运行`bun typecheck`，`tsgo --noEmit`通过。
6. Diff：仓库根运行`git diff --check`通过，仅有Windows LF/CRLF提示，无whitespace error。

### 23.3 Original Feedback Loop

仅运行真实数据库只读命令：

```text
bun script/migrate-image-attachment.ts "C:\Users\Lenovo\.local\share\opencode\opencode.db"
```

结果：

| Metric | Value |
| --- | ---: |
| status | preview |
| image attachments | 441 |
| unchanged | 392 |
| normalized | 48 |
| unavailable | 1 |
| changed parts | 49 |
| old payload bytes | 256,706,749 |
| new payload bytes | 195,263,239 |
| saved payload bytes | 61,443,510 |
| old Part JSON bytes | 342,576,969 |
| new Part JSON bytes | 260,652,145 |
| logical Part JSON bytes saved | 81,924,824 |

唯一unavailable仍是`prt_f5af04c69001KEtWbmwrZrOjt3`的Tool attachment index 0。命令前后数据库主文件长度和`LastWriteTimeUtc`均相等，确认preview未写库。本会话未运行真实`--apply`。

### 23.4 Actual Semantic Paths

```text
primary:
DB path -> readonly preview / BEGIN IMMEDIATE apply
-> 两种已证图片形态 -> 同一个默认 Image.Service
-> unchanged或Sharp normalized -> 完整Part JSON CAS -> COMMIT

explicit user-requested rollback:
completed Tool attachment + typed ImageDecodeError
-> 删除该attachment -> 保留原Tool output -> 追加固定不可用说明
```

Alternate-success path为0。没有Bun.Image、第二decoder/resizer、来源预算、外部源搜索、原图fallback、catch-and-default、backup、checkpoint或VACUUM。`ImageResizerUnavailableError`、顶层失败和其他错误均失败；apply中任何失败回滚整批。

### 23.5 Chinese Comment Gate

按`git diff HEAD`对生产和测试新增行使用审计者的保守口径：

| Metric | Value |
| --- | ---: |
| Effective code `E` | 253 |
| Qualifying Chinese explanatory comments `C` | 38 |
| Required `ceil(E * 0.15)` | 38 |
| Ratio | 15.02% |

注释分布在位置参数契约、preview/apply事务边界、统一Sharp策略、typed DecodeError授权、附件索引稳定、未知字段保留、完整JSON CAS、空间统计和对应行为断言附近；没有集中注释或表面复述。

### 23.6 Remaining Unverifiable Items

- 真实数据库`--apply`未由实现者运行；这是用户保留的最终操作，而非遗漏验证。
- CLI fixture未单独注入`ImageResizerUnavailableError`、顶层坏图、非completed Tool和同一Tool多个好坏混合附件；独立审计确认这些直接分支当前无可达行为缺陷，属于非阻塞回归测试余量。

## 24. Implementation Audit Record

| Round | Revision | Full scope | Finding classification | Release verdict | Reference |
| --- | --- | --- | --- | --- | --- |
| 1 | pre-R2 | yes | blocking | BLOCK | `ses_09fddb7fcffen8zj58b5BQbEL5` |
| 2 | R7 | yes | `No blocking findings.`；`Non-blocking findings: 无。未发现需要发布前整改的纯风格、冗余抽象或兼容性问题。` | `APPROVE — 仅适用于当前 R7 canonical plan 与本次实际实现 diff。` | `ses_09e3b9935ffery6EmVZ4cm5DL0` |

审计确认：primary-path通过；alternate-success budget为0；唯一非主语义是用户逐字授权的completed Tool typed `ImageDecodeError` rollback，不属于未授权fallback。

审计保留的非阻塞测试风险原文分类：

1. 迁移CLI没有专门注入`ImageResizerUnavailableError`；结论依赖`Image.Service` typed error契约、已有Image/Read测试和脚本直接分支审计。
2. 没有单独构造“顶层坏图”“非图片附件”“非completed ToolPart”或“同一ToolPart多个好坏混合附件”的CLI fixture；当前逻辑可直接追踪且未发现错误，但未来改动可能缺少同等敏感的回归信号。
3. 审计者未重跑真实数据库preview；实现者已按用户授权只读运行并记录主文件长度和mtime不变，该结果不作为审计者独立放行依据。

以上均未显示当前实现存在可达行为缺陷，不构成阻塞。R7实现已完成并verified；任何后续material behavior change必须新建revision并重新全范围审计。
