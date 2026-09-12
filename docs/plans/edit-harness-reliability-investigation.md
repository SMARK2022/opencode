# Edit / Apply Patch Harness 可靠性调查记录

> Status: investigation-in-progress
>
> Revision: R4
>
> Last updated: 2026-09-12
>
> Implementation allowed: no
>
> 本文是持续维护的证据台账，不是已审批的修复方案。记录已确认缺陷、现象、反证、统计修正和待调查项；不得将候选根因写成已确认事实。

## 1. 用户目标与调查边界

用户观察到 edit / apply_patch 大量失败，要求还原具体 Session 中模型如何得到 oldString，判断模型、工具反馈、上下文投影、格式化、并发和流重试分别承担什么原因。不能停留在“文本不匹配”的同义描述。

- 主窗口为最近两周，同时比较最近三周、30天；避免旧实现污染当前结论。
- 用户要求超过十个具体案例，并希望至少充分解释失败中的80%。**当前尚未达到80%逐事件因果解释覆盖率。**
- 数据库：`C:\Users\Lenovo\.local\share\opencode\opencode.db`。
- 查询通过 SQLite URI `mode=ro`、`PRAGMA query_only=ON`；后续批次使用只读事务保持批内一致。
- 冷存储只在内存解压，不调用会持久 thaw 的业务 API，不修改业务数据库。
- 本次授权允许新增、维护本文；没有授权实施生产修复。
- 工具运行本身会产生对话、日志和 tool-output，这不等于执行了业务数据库维护。

## 2. 证据等级与统计纪律

1. **闭合事件**：具有历史工具输入/输出、失败参数、实际差异或后续成功见证，并能对应实现或日志。
2. **实现确认**：当前源码能证明行为，但历史事件归因仍可能缺运行版本/请求正文。
3. **候选关联**：归一化后相同、相邻操作、模型自述或历史文本出现，只用于定位调查方向。
4. **未解释**：缺证据时保留，不为了80%目标强行归类。

数据库中的 input/output 不必然等于当次网络请求逐字内容：存在输入真值回写、compaction、截断、插件投影和冷存储。模型推理中的“已经读过”“路径损坏”“工具二次解码”均为待核实陈述。

已有 fork 会复制历史。按 Session/Part 计数不等于独立执行数；至少两个抽样 Session 复制了同一 `r6_probe_caps.py` 事件。初步以 callID、执行开始时间、input 去重得到445条失败对应426个键，**这不是已验证的最终去重算法**。

## 3. 固定窗口统计

统一截止北京时间 **2026-09-08 04:00:00**，epoch ms `1788811200000`。窗口起点分别为8月25日、8月18日、8月9日04:00。排除 pending，终态率为 `error / (completed + error)`。

| 窗口 | apply_patch completed / error | 失败率 | edit completed / error | 失败率 |
| --- | --- | --- | --- | --- |
| 14天 | 1082 / 370 | 25.48% | 1972 / 500 | 20.23% |
| 21天 | 2495 / 823 | 24.80% | 2847 / 556 | 16.34% |
| 30天 | 3308 / 950 | 22.31% | 3538 / 640 | 15.32% |

30天合计8436条编辑记录、72个 Session；14天3924条、41个 Session；21天6721条、59个 Session。一次全量解压批次校验204个冷存储 payload 的长度及带 kind 前缀的 SHA-256。

### 3.1 已撤销或不能使用的统计

- 早期全库观察为 apply_patch 16553 completed / 2152 error，edit 14771 / 1093；属于活动数据库快照，不能与固定窗口直接混用。
- 直接搜索主表 error/output 正文曾得到4.04% / 3.51%，**已作废**：冷存储 skeleton 的正文为空，被错误当成成功。
- 早期查询没有统一上界，活动 Session 导致1085/371等数字波动；本文使用固定上界结果。
- output 包含 `Failed to update` 的候选：apply_patch 14/21/30天为93/106/128，edit为5/6/6。edit 的输出可能是被编辑代码中的字符串，不能据此认定 partial success；apply_patch 也应按输出结构复核后再计入正式部分失败率。
- 早期正则把包含 `permission` 的文件路径误归权限错误，例如 `FileSystem.writeFile(...permission/precheck.test.ts)`。后续已单列文件写入异常。

### 3.2 最近两周模型/Provider 分布

| 模型 / Provider | 工具 | error / 总调用 | 比例 |
| --- | --- | --- | --- |
| GLM-5.3 / smark | edit | 215 / 1364 | 15.76% |
| GLM-5.3-flash / smark | edit | 230 / 779 | 29.53% |
| DeepSeek-v4-flash-0731 / smark | edit | 55 / 329 | 16.72% |
| GPT-5.6-sol / DaXiao Codex | apply_patch | 245 / 855 | 28.65% |
| GPT-5.6-sol / smark-codex | apply_patch | 84 / 350 | 24.00% |
| GPT-5.6-sol / openai | apply_patch | 13 / 158 | 8.23% |
| GPT-6-astra / smark-codex | apply_patch | 28 / 89 | 31.46% |

这不是公平模型比较。工具、项目、任务、上下文长度、运行版本和 fork 不同。**Flash 的230条失败全部集中于 `ses_041cd5549ffeSiDWyPpcy8Xrsl` 这个补丁迁移 Session。**

### 3.3 GLM 全量失败分解

| 直接失败阶段 | GLM-5.3 | GLM-5.3-flash |
| --- | --- | --- |
| oldString 不匹配 | 94 | 140 |
| 流未完成或取消 | 87 | 1 |
| 未读门禁 | 13 | 69 |
| 文件写入异常 | 8 | 0 |
| 歧义 | 4 | 5 |
| 重叠 | 2 | 0 |
| 无变化 | 2 | 12 |
| 参数/schema | 2 | 1 |
| 文件不存在 | 0 | 2 |
| 其他待细分 | 3 | 0 |
| 总计 | 215 | 230 |

以上是阶段分类，不是根因覆盖率。234条不匹配才是需要逐条追 oldString 的主要集合。

## 4. Harness 已确认问题与高可信事件

### H01. 已执行副作用后的流重试复用旧上下文

Session `ses_f9a9dfba4ffegVZ576cr3ZzMGz`；message `msg_07d5fb7f3001iGrdwnR7BCT2ei`；GPT-6-astra。

- read `prt_07d5fb18f001fZ85Y7Ksd7SpxM` 显示 `Diff.regression.test.ts` 第247/248行为8。
- 成功 patch `prt_07d6016e3001Ctqb11dwpbETsd` 将两处8改9。
- 日志03:37:29记录工具 completed；03:38:28 requestID=963 SSE idle timeout。
- 03:38:30 requestID=969重新发起请求，bodyBytes同为2206127。相同大小单独不证明请求正文相同，但与实现复用输入相互印证。
- `prt_07d617bfd001Eo9ClpBFxstAjk` 再次提交相同8→9补丁，实际已经是9，所以失败。
- `src/session/processor.ts:1149–1200` 的 retry 再调用 `llm.stream(streamInput)`，没有在该重试入口重建成功副作用的上下文。

日志位置：`C:\Users\Lenovo\.local\share\opencode\log\2026-09-07T105132.log`，67874、68088、68092附近。日志时间使用UTC，本文时序转换为北京时间。

30天内成功后相同 input 再失败的候选共7条：GPT-5.6-sol同message 2条/不同message 2条，Astra同message 1条，GLM-5.2不同message 1条，Flash不同message 1条。**只有上述Astra链路已核对超时日志，不能把7条全归流重试。**

### H02. apply_patch 最终落盘内容反馈不完整

实现证据：`src/tool/apply_patch.ts:281–290,348–359,392–462`；`src/session/message-v2.ts:1233–1268`。

- patch diff/files metadata 在 formatter 前生成。
- 写盘后执行 formatter，却不回读重算最终 diff。
- 成功 output 主要是文件列表、部分失败和LSP说明，没有附最终 diff。
- 模型投影消费 `state.output` 和 `state.input`，不会自动把 `state.metadata.diff` 作为正文注入。
- 因此UI/metadata有diff不等于模型收到最终diff；模型提交的patch也不等于格式化后的文本。

对照：edit 在 `src/tool/edit.ts:365–424` 重算post-formatter diff并附 `Changed:`，不能把两种工具混为一谈。

历史关联：EchoPaper `prt_07d74676a001wtSFiVuMu3IQXe` 请求 `recordingWaveform = next.length > 36`，诊断实际为换行后的 `recordingWaveform =` / `next.length > 36`。符合格式化反馈缺失机制，但单凭此处尚不能排除其他写入者。

### H03. Bash 压缩会删除普通CRLF源码中的空白行

这是已闭合的“模型复制了工具输出，但工具输出不忠实”案例。

- Session `ses_041cd5549ffeSiDWyPpcy8Xrsl`，Flash。
- Bash `prt_0570f8758001KjAN6Ct5uQNagv`：先materialize state 8，再 `Get-Content ...subagent-footer.tsx | Select-Object -Skip 32 -First 28`；命令未过滤空行。
- output 中 `const status = ...` 与 `type UsageInfo = ...` 紧邻。
- edit `prt_057129aad001R5QFfqF080RPC6` 的oldString逐字存在于上述output。
- 失败诊断和后续成功edit `prt_057133213001a8f7uFX6jNXzrK` 证明文件中两行之间有空行。
- Bash metadata：compressed=true，originalBytes=2551，compressedBytes=2484，savedBytes=67，carriageReturnGroups=1，其余压缩组为0。
- `src/tool/bash-compress.ts:531–532` 的 `getStableOutput()` 用 `filter(line => line.trim().length > 0)` 删除所有空白行；普通CRLF也可进入虚拟终端路径。
- `compressVisibleOutput` 主路径在1380–1460行。

只在内存调用真实 `compressVisibleOutput()` 的验证：270字节普通CRLF源码包含一处空行，输出264字节、空行消失，stats.applied=true、carriageReturnGroups=1，无空行删除提示。没有创建fixture或修改源码。

影响：Bash读取、日志和脚本输出不能作为逐字编辑依据，即使没有明显截断标记。当前只对上述事件闭合了因果，不能把所有空行不匹配都算作本缺陷。

### H04. edit未读门禁的相对路径身份不一致

实现：`src/tool/edit.ts:120–123` 对目标以instance.directory解析；140–153行的历史比较直接 `path.resolve(p)`，相对路径使用进程cwd，而非该Session项目目录。

同一Flash Session：

- read `prt_04ff9e8a5001gz6LigX3T6qCDO` 成功读取 `.temp\patches\records\0337-e21353edbf23.md`。
- read `prt_04ffa15b2001VeBo0thd8jf0hE` 同相对路径返回stub，明确1–40仍可见；metadata.canonicalPath正确指向thirdparty/opencode-11720下文件。
- edit `prt_04ffae4e1001tBYF9I5jWgTVkj` 同相对路径却报未读；随后还有重复拒绝。

82条门禁失败中，完整历史检索20条存在同规范路径成功read/write/edit；52条只在Bash命令中找到basename提及；10条未找到。这只是候选划分：basename提及不证明Bash确实读到目标，旧历史也可能已compaction。不能把20或52全计为缺陷。

### H05. 失败后恢复读取与去重stub发生冲突

`src/tool/read.ts:205–249` 根据历史metadata、未compacted状态和版本键判断可见性。版本键是size+mtime+head-sample指纹，不是完整文件摘要。

- EchoPaper home失败后，read `prt_07d6336ff001PW4IvGlJQIbr6j` 请求135–179，却返回覆盖90–259的stub。
- `write.ts`失败链 `prt_04f4cccce001s7v43AS3f2K2Je` 前的read `prt_04f4c9ab3001j6Kt3SW3nL89PF` 也被stub抑制。
- matcher要求“read and retry”，read却要求“do NOT re-read”，造成恢复指令冲突。

已确认恢复没有收到新源码；**未证明这些stub对应错误版本或Provider实际漏掉旧read**。应继续检查活跃消息集合、投影截断与metadata可见性是否一致。

### H06. 匹配错误的定位与可操作性不足

- home仅差一个前导空格却返回 `No reliable nearby candidate`；该提示是诊断器未能选可靠候选，不等于文件无目标。
- `src/patch/match.ts` 的closest诊断有4秒和64MiB预算；预算/可靠性不足均可能不给候选。
- apply_patch失败只报文件，未报告具体chunk索引；大量chunk中模型不易知道应该修正哪个old block。
- closest诊断有时只给请求/实际列区间，文本自身又省略，不能假定它足够恢复精确oldString。

### H07. 部分文件成功但整体completed的协议认知风险

`src/tool/apply_patch.ts:262–279,405–408`：全部文件失败才error；有文件成功则执行成功文件，并在output附失败文件。按文件原子，不是整次调用全有或全无。

进一步核对发现 `src/tool/apply_patch.txt:30–36` 没有解释部分成功，也没有明确描述全部chunk对原始快照定位和overlap契约。这里是**实现与工具说明的契约缺口**；尚未独立证明多少重试误操作由此造成。

## 5. 模型/Provider行为：必须与Harness分开记录

### M01. home_view.dart展示分隔空格被当成源码缩进

Session `ses_fa174e32dffeTCMApGdW6PJvHv`；Astra。

- grep `prt_07d67c9a2001lJxBn3qk2zXAT3` 的 `Line 146: ` 分隔符后为22个空格。
- edit patch `prt_07d681a49001NltLYeqKrY8tMu` 删除行去掉 `-` 后为23个空格。
- 两者字符计数实测，不是猜测。另两次失败仍使用相同错误缩进。
- 来源展示前缀混淆是合理机制；单凭结果不能证明模型究竟从read还是grep复制那一个空格。

### M02. Flash把字面反斜杠n当成换行

Session `ses_041cd5549ffeSiDWyPpcy8Xrsl`；失败Parts：

- `prt_04fe417190012YIbadaIh7U0lD`
- `prt_04fe4ae7c0012MmrbrLM0mHHA4`
- `prt_04fe52bef001fxS6Z7n07TQf1H`

DB JSON解码后oldString含实际两个字符 `\n`，不是换行；转换字面转义后与后续成功edit `prt_04fe864db001HYWLbX9QA9klAw` 的旧文本对应。read `prt_04fd7ad98001EOTWldbOjUouDa` 也有真实换行文本。

推理 `prt_04fe4dcb1001H2iGJ0TzFJTT3Z` 反复怀疑缩进、隐藏字符、JSON层数和工具二次解码；模型确实有解释，只是它的管道解释没有被事实支持。没有原始网络参数对照，不能断言最初由模型还是Provider序列化造成。

### M03. GLM-5.3一次异常输出被放大成80条失败

Session `ses_fb40f26b4ffeY3VjfG4svSLFqh`，80条edit `Tool execution did not complete before stream ended` 全在同一assistant message。

- 示例 `prt_051a6a43d001U1SV48aHeMdqZe`、`prt_051a6fb16001Nbn9QueGa4w1lu`、`prt_051a701fe001SFSk6MlkOMiNBc`。
- input={}，但state.raw并非空：含长文档编辑以及非法JSON、异常tab/换行、`newString1`、`F:\tmp`等重复异常参数。
- 该message报告input=94827、output=1920、finish=tool-calls。不能仅凭token数反推网络真实工具调用数。
- 80条占GLM215条失败的37.21%；不能解读成80次正常编辑或匹配失败。
- 其余GLM流类失败7条、Flash1条也都是input={}。

仍需确定异常首先发生于模型生成、Provider适配/代理、SDK解析还是processor生命周期；当前仅闭合“统计集中于单次异常message”和raw非法。

### M04. 旧版本、批次语义与补丁文件多层前缀

- Flash旧文本有时来自先前成功edit的oldString，不是最新newString。
- 部分操作是在逆向重建state-14/state-20/state-21，模型推理 `prt_05807d5250016AUJgHwVhlW9z9` 明确据多个patch推导pre-image；并非单纯抄read。
- 对 `.patch` 文件编辑需要同时处理文件内diff前缀与工具返回diff前缀，多一个/少一个空格或加号即可改变内容。
- 各edit条目和apply_patch chunk对immutable original定位；同一调用中用前一条产生的新文本定位后一条应失败。这是合同，不宜自动放宽成顺序修改。

这些机制都有案例或实现基础，但仍需逐条证明，而不是按文件后缀批量归因。

## 6. 跨Session样本台账

下列20条是不同Session的定点失败抽样，并非随机样本。相邻窗口检索为失败前1小时、后10分钟；“未见先前读取”不等于整个Session从未读过。第7/8条为fork复制事件，不能算独立根因样本。

| # | Session | 失败Part | 文件/观察 |
| --- | --- | --- | --- |
| 1 | ses_fa174e32dffeTCMApGdW6PJvHv | prt_07d74676a001wtSFiVuMu3IQXe | state.dart，单行赋值与实际格式化换行不符 |
| 2 | ses_f9a9dfba4ffegVZ576cr3ZzMGz | prt_07d7253810011CClzMnawXqjQJ | Diff.ts，多个匹配；另有H01完整链 |
| 3 | ses_f8b378e68ffePzMwT7iii55Nw7 | prt_07c29224e002uib94CwxKk7FYq | update.sh，dirname缺少--；read后成功 |
| 4 | ses_041cd5549ffeSiDWyPpcy8Xrsl | prt_079837474001R75OB5TIizWE7l | 0259.patch，空格上下文行被当成+行 |
| 5 | ses_10fb7b41cfferSWcJIpOXdJIGj | prt_07880706f001cWXk0lX5g6dyVl | dorm_audit_aug.py，前次修改后第二块不符 |
| 6 | ses_fc166ef8effeHjRt8s7WK0azSM | prt_0774effcd001uaRsRhETju5hvc | transcribe.py，成功改写后再次大块修改失败 |
| 7 | ses_1762e23a2ffeYBi6TXLUSjJuKP | prt_076acb096001HkGjuedifRY8Uf | r6_probe_caps.py，write后转义不符，read后成功 |
| 8 | ses_f8925cc15ffeEPWfz0EMkdwK4O | prt_076da340d017mzt0DzTFicE6JK | 上条fork复制，不算独立事件 |
| 9 | ses_fa4a6f985ffewzbdTRgY6NxHyM | prt_07686ab38001zPgLJlKU1uXgBL | reviewer-prompt.test.ts，门禁；完整历史其实有旧edit |
| 10 | ses_f8aefd1efffer9qxMHqUeLpEtq | prt_0764b4671002S8nik39A898V9Y | chatgpt-core.js，第二块不符，定点read后成功 |
| 11 | ses_f8af288a6ffemmYSZ0brd66JKQ | prt_075bd3ecf0011auEl4ua7g8Mb5 | bash-compress.ts，九块成功后又用不同旧片段 |
| 12 | ses_00ebf47e6ffejc0zWNlqQRaO0w | prt_070b5fa8a001QT8UT4C5i6dqZT | test_generate_provider.py，门禁，旧历史有读/改 |
| 13 | ses_f9d14159cffeNPomj2tKlu5QhH | prt_0633e18ef001wfOw4NGakC83MX | file-diff.ts，第四块不符 |
| 14 | ses_fa1e77e60ffeBsVgoixXfzndY6 | prt_05e6192c5001td2tQ6O8Eu46J4 | settings.json，门禁，read后两块成功 |
| 15 | ses_fa2ef8cd2ffeDlBpRloUME3nOC | prt_05d812ea2001pVR2jPN1FyvnlQ | audio.test.ts，前次edit后第二块不符，read后成功 |
| 16 | ses_fb0592160ffekmK38a40bM58vb | prt_0580cb0b4001XR7JgWvmnK2coI | mesh-node.sh，反斜杠数量不同，修正后成功 |
| 17 | ses_fb40f26b4ffeY3VjfG4svSLFqh | prt_051f1ec620012zVluSfNkrbk0m | scroll计划文件门禁；另有M03异常输出群 |
| 18 | ses_fb39b7c1effeTceet1hCpuPwmW | prt_0517a2868001jtO3SP4W7hj5Iz | Markdown待核验段遗漏空行，随后成功 |
| 19 | ses_fbdc39136ffeZ2bTXGcvoEAMNK | prt_04f4cccce001s7v43AS3f2K2Je | write.ts第六块不符，恢复read被stub |
| 20 | ses_05d28b468ffet146EjFFXLGrhD | prt_0458410c00017zVvSoas41yNPj | control-plane-migrate.sh，刚read仍歧义，扩大上下文成功 |

## 7. 来源扫描结果与80%目标差距

全量扫描GLM/Flash最近14天445条失败，重点追234条oldString不匹配。

- 第一轮全历史搜索64条找到完全相同文本，但包含25条最近来源为模型reasoning，不能证明工具提供过。
- 第二轮限制同文件来源、前7天、read/Bash/write/成功edit：56条找到字面或变换后对应，178条没有；变换包括解码字面换行、删空行、去缩进、去全部空白。
- 第三轮用前后1小时read和后续成功edit见证：53条有对应，181条无对应。**与第二轮不能相加，窗口与规则不同。**
- 后续成功edit的oldString已可能被 `_syncInput` 真值回写，适合做实际文本见证，不适合证明模型原始提交字节。
- oldString在其他版本或别的文件中出现，不自动证明该文本是来源；必须检查路径、时间、可见性和中间writer。
- 归一化匹配只说明差异形式，不能当因果归类；特别不能把所有空行差异算作H03。

**当前没有合法的“已解释80%”结果，也没有模型/Harness因果占比。** 已知阶段比例可统计，完整来源归因尚未完成。

## 8. 本轮继续检查发现的实现风险

### C01. edit的Changed截断不是连续前缀

`src/tool/edit.ts:408–425` 逐行预算检查，遇到放不下的行使用continue而不是break，之后更短的行仍可被加入。末尾却提示 `more lines omitted`，容易让消费者理解为只截掉尾部。实现可产生缺中间行的diff片段；尚无历史失败链证明它导致oldString错误。应验证输出预算边界和省略位置语义。

### C02. edit成功历史参数与formatter最终结果并非总一致

普通edit在format后回读contentNew，diff正确；但 `_syncInput` 来自 `applied.syncEdits`，仍是formatter前的replacement。create分支则会同步最终内容。模型能同时看到调用参数newString与Changed最终diff两个不同版本。不是说Changed错误，而是必须继续检查模型是否沿用较早的newString，以及参数回写是否让取证丢失原始请求。

### C03. 工具说明未完整呈现当前匹配语义

当前matcher包含PI normalization、唯一性和original-snapshot语义；apply_patch说明强调exact/substring，却未完整说明同文件chunk重叠、无全局顺序依赖和部分成功。说明与实现差异不能直接算运行错误，但可能造成模型使用错误心智模型。需对照各历史版本实际发送的工具schema，而不只检查当前txt。

## 9. R2补充调查：批次依赖与反证

本轮保持同一14天固定窗口，重新检查445条GLM失败和全部2143条GLM编辑终态记录。新增数据库查询为只读事务；运行真实工具纯函数进行内存对照，没有执行文件编辑工具实现或写入fixture。

### 9.1 五条同次调用引用新文本的证据

对234条不匹配定位错误消息中的 `edits[i]`（单条错误取0），检查失败oldString是否完整包含于另一个条目的newString、且不包含于该条目的oldString。找到5条：GLM-5.3为3条，Flash为2条。

| 失败Part | 失败索引 | 产生该文本的索引 | 事件 |
| --- | --- | --- | --- |
| prt_058093723001pHOy2wEsYYt5RF | 4 | 1 | Flash逆向重建prompt版本，后续条目引用同次替换将恢复的hasInFlightTail块 |
| prt_05d812ea2001pVR2jPN1FyvnlQ | 1 | 0 | GLM在audio.test.ts同次添加测试后，再修改新测试中的sleep/断言段 |
| prt_072b8abc0001lbnG6aG0xApLz6 | 3 | 0 | Flash后续条目引用同次新加的Entry/Match import |
| prt_075c853a4001MobbgiyvRm05MP | 1 | 0 | GLM后续条目引用同次新加的bisect-mid调试行 |
| prt_07a5401af001gqQJQO5ZPt46Jo | 5 | 4 | GLM文档条目引用同次替换后才形成的编号段落 |

失败事实说明owner在修改前文件中未找到目标；参数结构证明存在新文本依赖。仍不能仅凭包含关系证明模型主观意图，或证明全部条目除此以外均正确。

真实 `applyEdits` 内存验证：初始 `const a = 1`，同一批 `a→b`、`b→c`，返回 `Could not find edits[1].oldString in memory.ts`。说明实现遵循original-snapshot契约，而非逐条修改后再匹配。

这5条占234条不匹配的2.14%、445条失败的1.12%；不是额外新增失败。它们与前述来源候选重叠，不得与56条或53条机械相加。

**修正此前样本解释**：audio.test.ts不能仅描述为“前次编辑后又抄错”；本次失败批内明确存在先新增、后修改新文本的依赖。`prt_058093...` 和 `prt_075c853...` 在后续成功操作中出现完全相同oldString，也不再构成“matcher拒绝正确文本”的证据：后续文件可能已经经历第一步变更。

### 9.2 批大小与终态相关性

统计以持久化input.edits长度分桶，输入可能已做真值回写；保留fork重复，包含门禁/权限等失败，不能解释为纯匹配概率或公平性能评测。

| 模型 | 条目数 | completed | error | error占比 |
| --- | --- | --- | --- | --- |
| GLM-5.3 | 0 | 0 | 87 | 100%（流类空解析input） |
| GLM-5.3 | 1 | 679 | 51 | 6.99% |
| GLM-5.3 | 2–4 | 361 | 44 | 10.86% |
| GLM-5.3 | 5+ | 109 | 33 | 23.24% |
| Flash | 0 | 0 | 1 | 100% |
| Flash | 1 | 346 | 134 | 27.92% |
| Flash | 2–4 | 179 | 74 | 29.25% |
| Flash | 5+ | 24 | 21 | 46.67% |

GLM的94条不匹配中61条来自多条目调用，Flash的140条中66条来自多条目调用。批大小与失败相关，但可能由任务复杂度、长上下文和同文件原子性共同影响，不能据此证明“批量工具本身有bug”。

### 9.3 Bash空行缺失的差分对照

同一组普通源码行，使用真实 `compressVisibleOutput`，结果如下：

| 输入 | 输出空行 | applied | carriageReturnGroups |
| --- | --- | --- | --- |
| LF | 保留 | false | 0 |
| CRLF | 删除 | true | 1 |
| CRLF + enabled:false | 保留 | false | 0 |
| ANSI reset + LF | 保留 | false | 0 |

这个反证限制H03范围：不能笼统断言所有ANSI输出都会丢空行。内部虚拟终端可能删空行，但最终是否返回压缩文本还受applied判定约束；测试中的ANSI reset场景最终返回原文本。CRLF的缺陷在本对照中稳定可复现。

### 9.4 工具说明与模型行为的责任边界

新读 `src/tool/edit.txt:8` 明确写了original snapshot、不能overlap/nest；第5行明确解释read行号后的分隔空格，第11行说明转义/缩进差异仍失败。

因此C03必须区分工具：**edit已经告知批内原始快照语义，不能将上述5条统一归咎于缺少说明；apply_patch的说明缺口仍需独立评估。** 历史实际发送schema是否含这些描述仍需运行版本证据。

R2增加了可核验机制与反证，但仍未达到80%因果解释目标。剩余匹配失败需要恢复更精确的历史文件版本，不能把“当前扫描未找到来源”转成模型猜测的判决。

## 10. 后续工作与验收

- [ ] 按callID/原始执行时间/fork lineage验证去重，分别报告记录率、执行率、失败链率。
- [ ] 为234条不匹配建立逐条证据：失败条目索引、oldString、先前来源Part、差异、同文件中间写入、恢复结果、置信度。
- [ ] 检查Bash原始输出可恢复性、压缩开关、CRLF/ANSI/模板压缩/脱敏；区分读取命令自身变换和harness变换。
- [ ] 对82条门禁检查真实路径、进程cwd、活跃消息和compaction；不以basename命中替代文件读取证据。
- [ ] 对M03核对原始Provider流/SDK输入，确定80个raw异常调用在哪里首次出现。
- [ ] 检查read的展示行前缀、2000字符长行截断、16KB分页、stub与Provider实际可见输出之间的一致性。
- [ ] 检查格式化、外部编辑、并行工具和子代理的同文件writer时间线；无历史快照时标记不可判定。
- [ ] 按运行版本分层，特别是8月末/9月初工具实现变更，不将当前实现反推全部历史。
- [ ] 扩大非迁移任务、非单一长Session对照；不同模型/Provider分别统计。
- [ ] 80%目标必须以证据闭合的独立失败事件为分子，并公开未解释项；达不到则继续调查，不降低标准。

修复优先级建议仅作为调查结论：先保护已执行副作用后的重试上下文，再修Bash源码保真、路径身份、最终编辑反馈和失败恢复。不得为了降低报错率直接放宽为猜测式模糊写入。

## 11. R3 补充调查：最近一周全量失败与上下文一致性

本轮按用户要求覆盖 edit 与 apply_patch 全部失败，窗口为北京时间 **2026-09-05 00:00 → 2026-09-12**（与 R1/R2 的 09-08 04:00 截止窗口部分重叠，重叠段结论一致）。所有查询沿用只读事务与内存冷存储解压；新增对 pack v2 的 entry 级还原。分析粒度为「失败事件」：edit 按 edits[i] 条目、apply_patch 按文件 hunk 展开，共 681 个事件。

### 11.1 总量与模型分布

2835 次调用、25 个 Session；edit 2026 次（错误 304，**15.0%**），apply_patch 809 次（错误 161，**19.9%**）。对照 R2 固定窗口（edit 20.23% / apply_patch 25.48%）均有下降，但基数仍高。

| 模型 | 工具 | 错误 / 总调用 | 比例 |
| --- | --- | --- | --- |
| glm-5.3-flash | edit | 176 / 717 | 24.5%（全部仍属补丁迁徙 Session `ses_041cd5549ffeSiDWyPpcy8Xrsl`） |
| glm-5.3 | edit | 48 / 465 | 10.3% |
| kimi-k3 | edit | 80 / 844 | 9.5% |
| gpt-6-astra | apply_patch | 99 / 568 | 17.4% |
| gpt-5.6-sol | apply_patch | 40 / 145 | 27.6% |
| gpt-5.6-luna | apply_patch | 22 / 96 | 22.9% |

排除迁徙 Session 后 edit 错误 128 / 1309 ≈ **9.8%**。这不是公平模型比较（任务/项目/上下文不同）。

### 11.2 失败阶段分类（465 条错误）

| 阶段 | edit | apply_patch |
| --- | --- | --- |
| oldString 不匹配 / Failed to find expected lines | 236 | 148 全量 hunk 失败（按文件行细分：99 找不到、53 多处匹配、2 重叠） |
| 未读门禁 | 39 | — |
| 多处匹配（Found N occurrences） | ~8 | （计入上行 53） |
| 流未完成 / aborted | 3+3 | 3+6 |
| schema/参数、无变化、写入异常、权限预检、冲突等 | ~13 | 4 |

### 11.3 事件级一致性还原（681 事件）

方法：对每个失败条目，在同 Session 全部先前语料（read 输出去行号前缀、bash 输出、成功 edit/write/patch 的 old/new 文本、reasoning）中检索 verbatim 与归一化变体；写入者识别修复了 R2 的盲点——**apply_patch 的文件列表必须解析 patchText 分段**，否则同 Session 的 patch 写入全部漏计。修正后桶分布发生决定性迁移：

| 一致性桶 | 事件数 | 占比 | 机制 |
| --- | --- | --- | --- |
| not-in-visible-context | 215 | 31.6% | 见 11.4 G01/G03/G04 细分 |
| verbatim-but-ambiguous | 199 | 29.2% | G02 最小上下文 hunk 在重复文本中多匹配 |
| source-then-overwritten / read-then-overwritten | 132 | 19.4% | G01 自写后陈旧 |
| hit-other-context（read/bash/patch-new/reasoning/write/edit-new） | 91 | 13.4% | G05 跨文件复制、reasoning 重建 |
| never-read-in-session | 35 | 5.1% | G04 全部经 write/edit 触痕过门禁 |
| verbatim-in-context-but-failed 真异常 | 9 | 1.3% | 见 11.5，无一确认为 matcher 缺陷 |

中间写入者总数 299（修正前误报 168）。读取-失败间经历 compaction 的仅 2 例，compaction 不是本周失败的主要因子。最后读取为 stub 的 0 例（H05 的 stub 死循环在本周样本未出现）。

### 11.4 确认的 coherence 缺口（机制级）

- **G01 自写后陈旧（约 246 事件，36%）**：模型用自己的 read/patch 文本构造下一次编辑，但同 Session 后续成功写入已改写该区域；失败前未重新读取。错误文案只有「Failed to find expected lines」，不含任何时效信号。钉死案例 `prt_070892f480018Uom0glSRK8rwt`（sol）：失败 patch 7 个 hunk 中 5 个的 expected 在无中间写入者的见证 read 中逐字存在，仅 2 个真正过期——all-or-nothing 语义正确拒绝，但错误把「5/7 可匹配、2/7 陈旧」报成整文件失败，H06 的诊断粒度成本得到本周实证。
- **G02 最小上下文 hunk 导致歧义（199 事件）**：失败 patch 的 hunk 上下文行分布为 0 行 702、1 行 825、2 行 302；在重复段落多的大文档（`opentui-tui-native-liveness-root-cause-repair.md` 49 次、`opencode-gpt-prompt-transcript.md` 19 次）必然多处匹配。错误文案「Provide more context」可操作但模型重复同一模式。
- **G03 分页部分可见（70/101）**：读过但找不到且无中间写入者的 101 事件中，70 的读取输出带分页标记——模型只见过文件的某一页，却为从未显示的区域构造 oldString。145/215 的读取→失败间隔 <10 分钟，排除「遗忘」，是可见域与编辑目标的结构性错位。
- **G04 write 后无复读编辑（33 事件）**：门禁接受 write 触痕，模型凭「自己写入时的意图文本」构造 oldString；formatter 改写与 `_formattedContent` 真值回写后，上下文中的 write input 已是格式化后版本，与模型记忆不一致。
- **G05 跨文件/同名混淆（45+ 事件）**：45 事件的 oldString 逐字来自**另一个文件**的 read 输出；其中方案文档族（repair.md 与 history 归档）共享大段文本、补丁迁徙 Session 存在 `original\X.patch` 与 `current\X.patch` 同名兄弟目录（22 条门禁即读 original 改 current）。
- **G06 bash 可见性与门禁错位（13/39 门禁）**：模型经 bash 已看到文件内容，门禁（只认 read/write/edit 触痕）拒绝 edit；从模型视角是「我读过却被说没读」。22/39 则是同名异目录的正确拦截。H04 的相对路径 cwd 解析缺陷在本周样本未单独复现，但门禁与 bash 的语义裂缝依旧。
- **H03 仍存活**：`bash-compress.ts:531–532` `getStableOutput()` 的空白行过滤在 2026-09-07 压缩精准化提交后仍然存在；CRLF 源码经 bash 读取仍丢空行。

### 11.5 否证的假设（本周新增反证）

- **CRLF 行尾不一致**：verbatim 命中桶 121 事件全部 old=LF / read=LF，CRLF 假设对本周样本不成立。
- **hunk 内裸空行**：148 个失败 patch 仅 4 个含裸空行，不是主因。
- **同调用移动伪命中**：9 条真异常的 hit 源 patch 均无同调用移除对应文本。
- **跨 Session 写入者**：9 条真异常与 101 条候选 B 抽样 40 条，跨 Session 写入者均为 0。
- **matcher 吞掉现存文本**：唯一钉死案（sol session-diff-count.ts）证明错误来自模型侧部分陈旧；astra 大文档案的文本在失败后见证 read 中不存在且无库内写入者，残余解释为带外替换（用户/编辑器/git 操作，bash 仅见只读 git 命令 45 次）。

### 11.6 可优化点（按证据覆盖排序，均为调查结论，非实施授权）

1. **失败反馈携带时效与进度**：不匹配错误附同文件最近一次成功写入/读取时间与「此后被 N 次写入修改」；apply_patch 报告失败 chunk 索引与已定位成功数（覆盖 G01+H06，约 36%+ 事件）。
2. **歧义诊断增强**：多处匹配时给出候选行号列表或要求的最小上下文行数（覆盖 G02，29%）。
3. **read 分页与 edit 联动**：edit 失败且 oldString 不在任何已显示页内时给出指向性提示（覆盖 G03，需 read metadata 与 edit 联动的设计变更）。
4. **write 结果回显最终内容**：formatter 改写后的最终文本应出现在 output 正文而非仅 input 回写（覆盖 G04）。
5. **bash 读取与门禁语义对齐**：门禁文案区分「从未见过」与「仅经 bash 见过（压缩输出不可作为逐字依据）」；是否让忠实 bash 读取计入触痕是独立设计取舍（覆盖 G06）。
6. **同名兄弟文件警告**：编辑目标与已读文件 basename 相同而路径不同时警告（覆盖 G05）。
7. **H03 空行删除修复**：`getStableOutput` 空白行过滤仍待修复，属既有确认缺陷。

80% 逐事件因果解释目标：本周窗口在事件级（681）完成一致性桶归类，主因六类机制合计覆盖约 98.7%，但桶级归因不等于逐事件闭合；G01/G03 内仍有个案依赖「模型记忆与回写文本差异」的推理链，未达逐事件证据闭合标准。

## 12. R4 用户决策与修复设计（待实施授权）

以下为用户 2026-09-12 审阅 R3 结论后逐条敲定的修复方向与取舍。记录为用户偏好与需求，仍非实施授权；后续以独立 canonical plan / GOAL workflow 推进。

### 12.1 G01 自写后陈旧（约 36% 事件）：文案 + 时效反馈 + 统一 diff 回显

1. **静态文案（edit.txt / apply_patch.txt）**：克制增加一条，位置相对靠前、可用大写等手段保持醒目，但不得占据主导地位。含义：构造 oldString 时以最近一次 read 为底，叠加此后自身 edit/apply_patch/write 返回的作用后结果（diff）；不得凭陈旧 read 转写。
2. **动态时效反馈**：失败时若同文件最近一次成功写入晚于最后一次读取，附一句时效事实。**措辞不得诱导 re-read**——模型自写后已有 diff 作为真值增量，应引导其使用作用后结果，而非每次重读。示例方向：`This file was modified by your own apply_patch after your last read. Use the diffs returned by those calls as the current content.`
3. **统一 post-formatter diff 回显**：write 与 apply_patch 补齐 edit 的 `Changed:` 段，使三个写工具的成功 output 都携带 formatter 后的最终 diff。预算中档（见 12.7）。

### 12.2 G02 歧义（29% 事件）：不强制最小行数 + 最小唯一扩展

1. **不强制最小上下文行数**（避免改动单行 typo 也要凑三行的摩擦）。
2. 现有文案 `Provide more context to make it unique` 后补最短诱导，如 `(more than 3 lines of surrounding context)`。
3. **歧义失败时返回「最小唯一扩展」**：locateExact 已枚举全部候选 span，错误路径上据此计算距唯一还差多少——返回候选行号及向上/向下扩展建议（如 `matches at lines 121, 487; including 2 more lines above or 3 more below disambiguates`）。性能要求：只在失败路径计算，复用已枚举候选，预算与 match.ts 诊断预算（4s / 64MiB）同源；实现保持简洁顺畅，不为单一调用点新增公共 helper，不引入状态机。

### 12.3 G03 分页盲区（约 10% 事件）：失败时列出已显示区间

edit 失败且 oldString 不在任何已展示 read 页内时，附加事实句：该文本不在你已读取的行区间内，随后列出合并排序后的区间（如 `120-260, 400-512`）。区间融合复用 `src/util/range.ts` 的 `mergeRanges`——read.ts 的 stub 覆盖判断与 compaction handoff 已共用同一 helper。仅陈述事实，不强制诱导 re-read。

### 12.4 G04 write 后无复读（33 事件）：靠 formatter diff 回显，不要求重读

好的 harness 应保证模型写完即可直接编辑。write 成功 output 附 post-formatter diff（同 12.1 第 3 条），`_formattedContent` 真值回写维持现状；不追加任何 re-read 要求。

### 12.5 G05 跨文件/同名混淆（45+ 事件）：克制一句提醒

失败时若上下文中存在同 basename、异路径的已读文件（如 `original\X.patch` vs `current\X.patch`、方案文档族），在错误中简短提示一次：`你在上下文中读过的是另一个同名文件：<path>`。保持简短，不展开。

### 12.6 G06 bash/门禁错位（39 条）：不做文案分层，强化劝导

用户明确：bash 输出解析不可信（压缩/变换，H03 未修复），**bash 读取永远不计入触痕**，也不做「仅经 bash 见过」的文案分层（需要完整解析 bash，不可行）。修复收敛为：在 edit.txt 门禁条目处强化劝导——避免使用 bash 输出作为编辑依据，须用 read 工具。

### 12.7 预算纪律与 diff 回显经济学（2026-09-12 数据库实测）

最近一周 3304 次成功写调用的 metadata.diff 实测：

| 工具 | 次数 | diff p50 | p90 | p99 | max | output 被裁 |
| --- | --- | --- | --- | --- | --- | --- |
| edit | 1853 | 1.5KB / 22 行 | 4.4KB / 78 行 | 11KB | 19.3KB | **全周仅 1 次**（48 行省略） |
| apply_patch | 666 | 2.4KB / 36 行 | 6.2KB / 101 行 | 20KB | 50.7KB | 0（当前 output 无 diff） |
| write | 785 | 3.2KB / 64 行 | 10.7KB / 193 行 | 28.5KB | 45.4KB | 0（当前 output 无 diff） |

write 拆分：新建 677 次（86%，diff=全文，与模型刚写入的内容完全重复）、覆写 109 次（14%）。

**决策（用户确认方向）**：

1. **edit**：维持现有 `Changed:` 段。预算 = `truncate.limits()`（默认 1000 行/16KB，可配置）减 2048B/10 行保留 ≈ 14KB/990 行，实测一周仅裁 1 次，预算充足不动。C01 跳行截断校正为连续前缀 + 显式省略计数。
2. **apply_patch**：output 增加 post-formatter 完整 diff 段（同量级预算）。成本约 +3.2KB/次（全周 +2.0MB ≈ 53万 token），换来 landed 锚点，对抗 G01 链式陈旧。
3. **write**：**不全量回显**（86% 新建 diff 是纯冗余，全量回显将多花 3.4MB/周 ≈ 87万 token）。只在 formatter 实际改变内容时回显差异段；实现时需持久化一个 `formattedChanged` 类标志（当前 `_formattedContent` 被 strip，历史上无法测量 formatter 命中率）。常态零成本。
4. 超预算兜底：完整 diff 写入 truncation 工件文件，output 给前缀 + 路径指针（复用 Truncate 服务既有模式，与 bash 输出一致）。

### 12.8 上游机制对照（thirdparty/opencode-11720）

- 上游 edit/write/apply_patch 的成功 output **均不含 diff**：只有成功句 + LSP 诊断；diff 仅进 metadata（供 UI/snapshot）。「模型上下文中的落地真值」上游没有任何机制，完全依赖模型自觉重读。
- 上游工具输出统一截断为 2000 行 / **50KB**（本 fork 收紧为 1000 行 / 16KB），超限全文落 truncation 工件文件并在 metadata 附 `outputPath`。
- 本 fork 的 edit `Changed:` 段已是上游没有的本地增强；write/apply_patch 的 diff 回显与 G01 时效反馈均属上游不存在的进一步改进，无移植冲突，但需自行维护差异。

### 12.9 与正交缺陷的关系

H03（bash 空行删除）与本组修复正交，仍待独立修复；G06 的劝导文案以 H03 存在为前提。H02（apply_patch 无 post-formatter diff）由 12.1 第 3 条覆盖。

## 13. 维护记录

- R1 / 2026-09-08：汇总首轮跨模型调查、第二轮GLM来源追踪及统计撤销；加入Bash空行删除实证、相对路径门禁、80条单message异常、工具说明缺口和edit diff非前缀截断风险。没有实施任何生产修复。
- R2 / 2026-09-08：全量检查234条不匹配的同批newString依赖，找到5条；补充2143条GLM编辑记录的批大小分布、真实applyEdits内存验证及LF/CRLF/关闭压缩/ANSI对照；修正audio.test.ts与后续相同文本成功的解释。仍不宣称已完成80%根因覆盖。
- R3 / 2026-09-12：最近一周全量 edit/apply_patch 失败调查（2835 调用、465 错误、681 事件）。修复分析盲点（apply_patch 写入者解析），建立一致性桶：自写后陈旧 36%、最小上下文歧义 29%、分页部分可见、write 后无复读、跨文件复制、门禁/bash 错位。否证 CRLF/裸空行/同调用移动/跨 Session 写入者假设；未发现 matcher 吞掉现存文本的证据。确认 H03 空行删除仍存活、H06 诊断粒度成本实证。没有实施任何生产修复。
- R4 / 2026-09-12：记录用户审阅 R3 后逐条敲定的修复设计（第 12 章）：G01 文案+时效反馈（不诱导 re-read）+三写工具统一 post-formatter diff 回显（中档预算）、G02 不强制最小行数+失败时返回最小唯一扩展、G03 失败时列出已读区间（复用 mergeRanges）、G05 同名文件提醒、G06 收敛为门禁文案劝导（bash 永不计触痕）。仍非实施授权。
