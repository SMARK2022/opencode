# Read 工具 Stub/Suppress 机制取证分析报告

> 取证范围：两个 `opencode.db` 消息库全量遍历 + `packages/opencode/src/tool/read.ts` 源码静态分析
> 报告类型：问题遍历 + 根因分析 + 修复方案（仅本文档被写入，未改动任何源码）

---

## 0. 执行摘要

本报告完整遍历了 read 工具 stub/suppress 机制的全部潜在问题项，并以两个生产消息库的实证数据交叉验证。核心结论：

1. **stub 机制没有让模型"读不到被隐藏的内容"**——模型不会去捞被 stub 隐去的旧区间，而是去读新区间。这一点是健康的。
2. **模型确实会困惑**：两库合计 **83 次 `retry_same_range` 死循环**（Windows 57 + 本地 26），证明 `stub_same_range_visible` 在"模型找不到上下文中的内容"时引发重读循环。stub 的强语气"do NOT re-read"在此场景反而有害。
3. **sed / Get-Content 的主因是 read 工具自身能力边界**（200 行默认 limit + 16KB 字节上限 + 不支持区间内 grep），不是 stub 机制本身。但存在一个真实副作用缺陷：**shell 旁路读取完全绕过 `visibleReads` 追踪**，使 stub 系统对模型实际已读范围产生盲区。
4. **版本键 `size + mtime(ms)` 脆弱**：等长替换 + 同 ms 写入会静默脏读，且 stub 文案会谎称"最新版"，主动锁定脏数据。

共识别 **27 个问题项**，分 5 类（A 机制正确性 / B 模型行为 / C sed 逃离 / D 其他边界 / E 设计层）。每项均标注严重度、实证证据、是否为工具设计问题、修复方案。

本报告已经过一个独立 sub-agent 完整审阅（核对源码行号、设计风格符合度、完整性、数据自洽性、方案评估），并据审阅意见修订：区分两类 stub 文案语气、修正 E2 行号、修正 Fix 2 I/O 声明、精确化子类型占比、细化 Fix 1"连续"定义、Fix 6 改用 `FileSystem.FileSystem`、补充 D7/D8 两项遗漏、精确化 modifiedMs 引用。

---

## 1. 机制总览

核心逻辑在 `packages/opencode/src/tool/read.ts`。

### 1.1 关键常量

| 常量 | 值 | 位置 | 作用 |
|---|---|---|---|
| `MAX_BYTES` | 16 KB | `read.ts:23` | 单次 read 字节上限，超出则 `cut` 截断 |
| `DEFAULT_READ_LIMIT` | 200 | `read.ts:22` | 未传 limit 时的默认行数上限 |
| `MAX_CONTENT_TOKENS` | 16000 | `read.ts:25` | token 预算硬上限，超出则整次 read 失败 |
| `OVERLAP_MIN_LINES` | 20 | `read.ts:28` | 触发 overlap note 的最小重叠行数 |
| `OVERLAP_MIN_RATIO` | 0.3 | `read.ts:29` | 触发 overlap note 的最小重叠率 |
| `OVERLAP_SUPPRESS_RATIO` | 0.8 | `read.ts:34` | 触发 suppress(stub) 的高重叠阈值 |

### 1.2 关键函数

| 函数 | 位置 | 职责 |
|---|---|---|
| `collectVisibleReads` | `read.ts:204` | 扫描 `ctx.messages`，收集同 canonicalPath、非 stub、未 compacted 的 read 元数据 |
| `findReadStub` | `read.ts:226` | 同版本下判断 same_range / covered_range |
| `findOverlapNote` | `read.ts:241` | 找**单条**最优重叠历史 read，决定是否加 overlap note |
| `computeUnreadRanges` | `read.ts:264` | 用**所有**同版本历史 read 的并集，计算当前请求的未覆盖区间 |
| `lines` | `read.ts:860` | 实际读文件，受 limit + 16KB 双约束 |

### 1.3 stub 触发链

1. `lines()` 读文件 → 得到 `raw[]`（实际返回行）。
2. 构造 `current` metadata：`start = file.offset`，`end = file.offset + raw.length - 1`（**实际返回末行**，非请求 limit）。
3. `findReadStub` → 命中 `same_range` / `covered_range` → 返回 stub。
4. 否则 `findOverlapNote` → 若重叠率 ≥ 0.8 且内容 ≥ 300 字符 → 返回 `high_overlap` stub。
5. 否则正常返回内容（可能带 overlap note）。

---

## 2. 取证方法与数据集

| 数据库 | 路径 | 大小 | read 调用 | stub 总数 | stub 率 | 环境 |
|---|---|---|---|---|---|---|
| Windows 巨量库 | `.temp/testing/opencode.db` | 1.66 GB | 33,935 | 824 | 2.4% | PowerShell（`F:\`、`C:\Users\Lenovo`） |
| 本地库 | `~/.local/share/opencode/opencode.db` | 465 MB | 12,098 | 561 | 4.6% | macOS / zsh |

stub 子类型分布（两库序位一致 covered > same_range > high_overlap，但占比有差异）：

| 子类型 | Windows | 本地 | Windows 占比 | 本地占比 |
|---|---|---|---|---|
| `stub_covered_range_visible` | 570 | 416 | 69.2% | 74.2% |
| `stub_same_range_visible` | 250 | 140 | 30.3% | 25.0% |
| `stub_high_overlap_visible` | 4 | 5 | 0.5% | 0.9% |

方法：对 `part` 表（JSON 列 `data`）用 SQLite `json_extract` 提取 read metadata、stub 状态、bash 命令；用窗口函数（`ROW_NUMBER() OVER PARTITION BY stub`）追踪每个 stub 后续 N 个工具调用；对命中案例人工提取 ±10 条上下文时间线（含 `reasoning`/`text` part）核对模型困惑度。

---

## 3. 问题遍历（27 项）

### A 类：stub 机制正确性

#### A1. 记录的是"实际返回范围"而非"请求范围" — 非缺陷（已验证）

**结论：非 bug。**

`read.ts:699-714`：
```ts
const start = file.offset                                                    // 请求 offset
const end = file.raw.length === 0 ? file.offset - 1 : file.offset + file.raw.length - 1   // 实际返回
const current: ReadMetadata = { ..., start, end, total: file.count, returned: file.raw.length, stub: false }
```
`file.raw.length` 受 `opts.limit`（行上限，`read.ts:880`）+ `MAX_BYTES`（字节上限，`read.ts:892`，命中后该行不入 raw）+ EOF 三重约束。请求 `limit=400` 但字节截断只返回 50 行时，**记录 `start=1, end=50`，而非 `end=400`**。

实证：`read.test.ts:452-466` 固化此行为（`expect(returned).toBeLessThan(100)`）。git 历史（`17b9d5b4f`）显示 `end` 自重构起即基于 `raw.length`，从未用 `params.limit`。

**早期疑虑"后 150 行被误标已读"不成立**：后续读 50-200 时，与旧 read 1-50 交集仅 1 行，低于 `OVERLAP_MIN_LINES(20)`，不会触发任何 stub。

---

#### A2. 80% 阈值不是 IoU — 设计如此（保守方向）

`read.ts:745-750`：
```ts
const overlapLines = overlapEnd - overlapStart + 1          // 分子：与单条历史 read 的交集
const requestedLines = Math.max(1, end - start + 1)         // 分母：当前【实际返回】行数
if (overlapLines / requestedLines >= OVERLAP_SUPPRESS_RATIO) // 0.8
```

**公式 = 单条最优历史交集 / 当前实际返回行数**。这是单向覆盖率，**不是 IoU**（IoU 分母是并集）。分母用"实际返回"而非"请求 limit"是正确的——若误用 `params.limit`，请求 400 实返 50 时分母=400，比例压到 0.125 反而不 suppress，会重复展示已在上下文的内容。

分子是 `findOverlapNote` 选出的**单条**最优历史 read（`read.ts:243-249` `if (!best || lines > best.lines)`），**不是所有历史 read 的并集**。这与 `computeUnreadRanges`（用并集）形成不对称：suppress 判定用单条（保守，宁不误杀），未读引导用并集（精确）。

实证测试 `read.test.ts:991-1014`：历史 `1-160`+`161-200`，请求 `1-200`，最优单条=160 → 0.8 → suppress；并集已全覆盖 → "no new content"。单条达不到 80% 时不 suppress（安全方向偏差）。

---

#### A3. 整文件版本门控，无行级追踪 — 设计缺陷

版本键 = `size + modifiedMs`（`read.ts:230`、`244`、`270`）。这是**整文件、全有或全无**的门控：同版本则历史 read 全部生效；异版本则历史 read 全部作废。**不存在"只 stub A、C，只重读 B"的行级中间态**。

场景：读 ABC → 改 B → 读 ABC：
- 改动被检测到（size 或 mtime ms 变）→ **A、B、C 全部重读**（A、C 被白白重读，浪费但正确）。
- 改动未检测到（见 A4）→ **A、B、C 全部 stub**（含脏 B）。

要做行级，需在 edit 后记录"受影响行区间"，read 时按区间比对——当前完全没有此机制。

---

#### A4. 版本键 `size + mtime(ms)` 脆弱 — 真实缺陷（严重度：中）

`modifiedMs`（`read.ts:177-184`）经 `stat.mtime.pipe(Option.map((time) => time.getTime()), Option.getOrElse(() => 0))` 取得，即 ms 精度 mtime（mtime 缺失时回落 0）。edit/write 经 `writeWithDirs` → `fs.writeFileString`（`filesystem.ts:89,102`）写入，**完全依赖 OS 更新 mtime，无 `utimes` 人工干预、无内容 hash**。

触发条件：**等长替换**（`foo`→`bar`，size 不变）**且** 写入发生在与旧 mtime 同一 ms。

后果链：
1. `current.size === read.size && current.modifiedMs === read.modifiedMs` → 判定同版本。
2. `findReadStub` → `same_range` 命中 → stub。
3. stub 文案（`read.ts:363-366`）断言 "Lines X-Y are the latest version and already in context; do NOT re-read"。
4. 模型上下文里的 B 是**改前的旧 B**，但被断言为最新版 → **静默脏读 + 主动误导**。

碰撞概率：mtime 是 ms 精度，APFS/ext4 原生亚 ms 但 Node `Date` 截到 ms → 同 ms 碰撞窗口真实存在。人工节奏几乎不撞；**agent 自动化"edit 后立即 read"循环**在快机器上可能落入同一 ms。外部触发：formatter/构建工具在同一秒内原地等长重写（旧 HFS+/FAT32 秒级精度）。

本次未在静态数据中直接观测到（难从库反推），但机制风险确凿。

---

#### A5. stub 文案基于弱键"硬断言最新版" — 真实缺陷（严重度：高）

两类 stub 文案语气不同，需区分：
- `read.ts:363-366`（`stub_same_range_visible` / `stub_covered_range_visible`，合计占 stub ~99%）：明确写 "are the latest version and already in context; **do NOT re-read**"。语气最硬，用绝对禁止。
- `read.ts:761-767`（`stub_high_overlap_visible`，占 <1%）：用 "avoid re-reading this range unnecessarily"，语气较温和。

两类文案的"latest version / already in context"断言**完全建立在 size+mtime 之上**。一旦 A4 碰撞，系统不仅给旧内容，~99% 的 stub 还**主动命令模型不要复核**（"do NOT re-read"），把脏读从"被动"升级为"主动锁定"。这实际上强化了本项的严重度——语气最硬的两类恰是占比最高的。

更广义地：即便没有 A4 碰撞，"已在上下文中"≠"模型能定位到"（见 B1）。当内容在长上下文里被淹没或接近 compaction 边缘时，模型实际拿不到，stub 却禁止重读 → 死循环。

---

### B 类：模型行为实证

#### B1. retry_same_range 死循环 — 真实缺陷（严重度：高，已实证）

两库合计 **83 次**（Windows 57 / 本地 26）：模型读完某区间被 stub 后，**在后续 10 个工具调用内重读完全相同的 offset**，再次被 stub。

实证案例（本地库 `ses_1b9622abbffeHqLjV2UkiRi0G2`，`session-pending.ts`）：
```
1779302952018 | READ off=1 lim=80 session-pending.ts [STUB:stub_same_range_visible]
1779302964308 | reasoning: "Exploring helper creation"
1779302966691 | GREP
1779302966697 | READ off=1 lim=80 session-pending.ts [STUB:stub_same_range_visible]  ← 重读同一区间，再次 stub
```
模型读 `off=1 lim=80` → stub（被告知"已在上下文，勿重读"）→ 思考 → grep → **再次读完全相同的 off=1 lim=80** → 再 stub。这正是 `read.ts:344` 注释提到的"连续 13 次 stub 死循环"。

**根因**：stub 断言"已在上下文"，但模型在上下文里找不到（已滚动很远 / 注意力窗口外 / compaction 边缘）。stub 的 `offset=81` 引导出口（`read.ts:346-356`）被模型忽略。

**`stub_same_range_visible`（占 stub 30%）是最易触发循环的子类型**——它对应"完全相同区间"，模型往往是真的没看到内容才重读。

---

#### B2. reread_same_file 高占比但多为引导跟随 — 非缺陷

后续 10 调用内重读同文件：Windows 302 (37%) / 本地 237 (43%)。但细分为：
- `guided_forward_read`（读 stub 末行之后的引导区间）：Windows 79 / 本地 53 — **预期行为**，stub 引导生效。
- `read_no_offset`（同文件从头读，无 offset）：Windows 20 / 本地 85 — 部分是困惑（想刷新全文），部分是合理探索。
- `retry_same_range`：见 B1。
- `read_other_offset`：Windows 30 / 本地 16 — 探索其他区间。

即 reread_same_file 大多是 stub 引导成功的体现，非困惑。

---

#### B3. stub_high_overlap 引导出口小样本有效 — 非缺陷

`stub_high_overlap_visible` 仅 9 例（4W+5H）。抽取样本：
- 请求 `80-179`，coveredBy `80-178`（99/100=0.99）→ suppress → 引导"New unread lines: 179. Read offset=179 limit=1"。
- 请求 `275-304`，coveredBy `280-304`（25/30=0.83）→ suppress → 引导"New unread lines: 275-279"。

小样本下引导文案精确指向未读行，模型可按引导读取。该子类型占比极低（<1%），风险有限。

---

### C 类：sed / Get-Content 逃离

#### C1. read 200 行默认 limit + 16KB 字节上限把模型推向 sed — 工具设计问题（严重度：中）

实证（本地库 `ses_1c9612892…`，`app.tsx` 1388 行）：
```
READ off=1 lim=60 ret=60            ← 小区间正常
READ off=230 lim=35 ret=35          ← 小区间正常
SED  sed -n '518,877p' app.tsx | grep -E "DialogTool|reconnect"   ← 360 行大区间
SED  sed -n '877,1153p' app.tsx     ← 276 行
SED  sed -n '845,1119p' app.tsx > /tmp/...   ← 274 行重定向到文件
```
字节截断实证：`off=1 lim=220 ret=172`（请求 220 行只返回 172）。模型要 518–877 共 360 行，read 至少 2 次调用且仍可能被字节截断；`sed -n '518,877p'` 一次拿到。**这是 read 工具自身限制逼出来的，不是 stub 逼出来的。**

---

#### C2. 区间 + grep 组合 read 无法做到 — 工具能力缺口（严重度：低）
```
sed -n '518,877p' app.tsx | grep -E "DialogTool|reconnect"
```
模型想"在某行区间内 grep"，read 不支持区间内过滤，sed+grep 一条 bash 搞定。

---

#### C3. 读取 git 修订版 read 做不到 — 完全合理（非缺陷）
```
git show 7508670af:.../session/index.tsx | sed -n '60,12p'
```
read 无法读取 git 对象，sed 是正当手段。

---

#### C4. 小区间也用 sed — 习惯 / 规避 read XML 冗余 / 不信任（严重度：低）
```
sed -n '485p' app.tsx          ← 单行
sed -n '1202,1210p' session/index.tsx   ← 9 行
```
这些小区间 `read offset=X limit=N` 完全能胜任且不会被 stub。模型仍用 sed，因 read 输出带 XML 包裹 + outline + metadata 冗长；部分是对"read 可能被 stub"的不信任。

---

#### C5. shell 旁路读取对 visibleReads 完全不可见 — 设计缺陷（严重度：中）

`collectVisibleReads`（`read.ts:204`）只扫描 `tool==="read"` 的 part。模型通过 sed/Get-Content 读过的区间**不进入 visibleReads**，导致：
- 后续 read 工具读同区间不会被 stub（重复返回已在上下文的内容，浪费 token）；
- `computeUnreadRanges` 不知道这些区间已读，可能错误地"引导"模型去读其实已通过 sed 看过的行。

追踪系统是 read-tool-only 的，shell 旁路完全绕过。

实证相关度：本地库 **212 个 stub 后续 10 调用内出现 `sed -n` 读同文件**（精确匹配，38%）。但逐一比对 stub 区间 vs sed 区间：

| stub 区间（被隐去） | 紧随 sed 区间 | 关系 |
|---|---|---|
| 1-120（coveredBy 1-200） | `sed -n '430,470p'` | 新区间，不重叠 |
| 1-50（coveredBy 1-85） | `sed -n '130,215p'` | 新区间，不重叠 |
| 1-50（coveredBy 1-85） | `sed -n '475,565p'` | 新区间，不重叠 |

**所有案例 sed 读取的都是 stub 区间之外的新内容**，而非捞被 stub 隐去的旧内容。即 stub 正确阻止了重读已在上下文的内容；模型接受 stub，转而用 sed 探索文件其他部分。**sed 不是用来突破 stub 封锁，而是读 read 服务不了的大区间。** 但 C5 的追踪盲区副作用仍成立。

---

#### C6. Windows 侧用 Select-String + Get-Content 等价绕过 — 同 C5

Windows 库 sed=0（PowerShell 环境），模型改用 `Select-String`（109 次）+ `Get-Content -TotalCount/-Tail`（45+ 次）。`Get-Content ... | Select-Object -Skip N -First M` 等价 `sed -n 'N,N+M p'`，同样绕过 read 追踪。C5 在 Windows 侧同样成立。

---

### D 类：其他边界情况

#### D1. token 预算硬失败 — 部分缓解（严重度：低）

`estimateTokensForContent > MAX_CONTENT_TOKENS(16000)` 触发整次 read 失败（`read.ts:797-806`），错误信息建议 `limit=N`。

实证：Windows 64 次 / 本地 9 次。失败后模型动作：
- Windows：read 重试 39、grep 12、edit 7、apply_patch 3、glob 2、bash 1。
- 本地：read 重试 8、grep 1。

**绝大多数模型按建议 limit 重试 read**，未显著推向 sed。token 预算失败是可控的。

---

#### D2. read 错误（非 token）— 部分缓解（严重度：低）

read `status=error`：Windows 369 / 本地 108。失败后：
- Windows：read 重试 209、glob 62、grep 46、bash 38、sed -n 1。
- 本地：read 重试 58、glob 16、bash 16、grep 15。

模型主要重试 read 或用 glob/grep 重新定位，**sed 逃离极少**（Windows 仅 1 次）。

---

#### D3. offset 越界 — 可控（严重度：低）

`offset > total` 触发错误（`read.ts:693-697`）。Windows 92 / 本地 22 次。模型通常改用更小 offset 重试。

---

#### D4. compaction 交互 — 正确但存在边界风险（严重度：低）

`collectVisibleReads` 跳过 `part.state.time.compacted` 的 read（`read.ts:212`），compaction.ts `renderInspectedFiles` 同样跳过 stub（`compaction.ts:401`）。逻辑正确：compacted 历史不参与 stub 判定。

边界风险：stub 文案"already in context"假设内容仍可见，但若该内容恰在 compaction 边缘被裁剪，模型找不到 → 触发 B1 死循环。这是 A5 的延伸。

---

#### D5. 目录/图片/二进制分支 — 无 stub 逻辑（非缺陷）

directory 分支（`read.ts:578-605`）、image/pdf 分支（`read.ts:616-677`）、binary 分支（`read.ts:679-688`）均不走 stub/overlap 逻辑，无问题。

---

#### D6. 多 session 父上下文（task.ts）— 一致（非缺陷）

`buildParentInspectedFilesSummary`（`task.ts:30-84`）用同一 `start/end`（实际区间）metadata，跳过 `stub:true`（`task.ts:49`），与 read.ts 一致。父上下文传递的 range 经 `mergeRanges` 合并。无新增问题。

---

#### D7. 同一 turn 并行 read 竞态 — 低风险（严重度：低）

`collectVisibleReads` 扫描 `ctx.messages`，但同一 assistant turn 中并行的工具调用（如模型同时发起两个 read 同一文件）不在彼此的 `ctx.messages` 中（同一批次）。两个 read 都可能 miss 对方的 visible read，导致双倍返回内容。影响有限（仅浪费 token，不致脏读），因为版本门控仍生效，后续重读会被 stub。

---

#### D8. symlink / 硬链接导致 canonicalPath 分裂 — 低风险（严重度：低）

`canonicalReadPath`（`read.ts:172-175`）仅做 normalize + Windows lowercase，**不解析 symlink**。若模型通过不同 symlink 路径读同一物理文件，会生成不同 canonicalPath，visible read 历史无法关联，stub 系统对同一物理文件产生多套追踪。后果是重复返回已在上下文的内容（浪费），不致脏读。

---

### E 类：设计层

#### E1. 无内容 hash / inode 兜底 — 见 A4（严重度：中）

版本键唯一防线是 size + mtime。size 对等长替换无区分力；mtime 是 ms 精度。无 content hash、inode、etag 兜底。

---

#### E2. outline 缓存用同一弱键 — 低风险（严重度：低）

`readOutlineCached`（`read-outline.ts:271` 定义，`:286` 为缓存命中条件）按 `canonicalPath+size+modifiedMs` 缓存 outline。A4 碰撞时 outline 也命中陈旧缓存。但 outline 仅用于导航提示，不构成正确性风险，只影响"导航行号可能过时"。

---

#### E3. findOverlapNote 单条 vs computeUnreadRanges 并集不对称 — 保守安全（非缺陷）

suppress 判定用单条最优（保守，宁不误杀），未读引导用并集（精确）。这是有意的安全方向偏差，不会造成"误隐"。

---

#### E4. findOverlapNote 被重复调用两次 — 性能冗余（严重度：极低）

`findOverlapNote(visibleReads, current)` 在 `read.ts:745`（suppress 判定）和 `read.ts:820`（overlap note 渲染）各调用一次，重复遍历 visibleReads。非正确性问题，可将首次结果复用于第二次以消除冗余。对大 visibleReads 列表有轻微性能影响。

---

#### E5. lines() 对高 offset 的 O(n) 扫描 — 性能（严重度：低）

`lines()`（`read.ts:860-907`）用 `createReadStream` 从头逐行扫描，`if (count <= start) continue`（line 878）丢弃 offset 前的行。对大文件高 offset 读取（如 offset=5000）需扫描前 4999 行。这与 C1（read 能力边界逼向 sed）相关——`sed -n 'X,Yp'` 用 seek 直接跳转更快，是模型偏好 sed 的次要性能因素之一。非 stub 机制问题，但属于 read 工具能力边界。

---

## 4. 根因综合：是工具设计问题还是模型问题？

| 问题项 | 根因归属 |
|---|---|
| A1（实际范围记录） | 非缺陷，设计正确 |
| A3（整文件粒度） | **工具设计**：无行级追踪 |
| A4/A5（弱版本键 + 硬断言） | **工具设计**：版本键脆弱 + 文案过度自信 |
| B1（retry 死循环） | **混合**：stub 文案断言"在上下文"但模型找不到（工具断言与模型可达性脱节） |
| C1（200行+16KB→sed） | **工具设计**：read 能力上限把模型推向 shell |
| C2（区间内 grep） | **工具设计**：read 不支持区间过滤 |
| C3（git 修订版） | 非缺陷，read 本就不应读 git 对象 |
| C4（小区间用 sed） | **模型习惯** + read XML 冗余 |
| C5（shell 旁路不可见） | **工具设计**：追踪系统 read-tool-only |
| D1/D2/D3（错误处理） | 基本可控，模型多按提示重试 |

**结论**：核心可修复问题集中在**工具设计层**——版本键粒度（A3/A4）、stub 文案断言（A5/B1）、read 能力上限（C1）、追踪盲区（C5）。模型行为（B1 重试、C4 习惯）是这些设计缺陷的下游表现，而非独立 bug。

---

## 5. 修复方案（符合当前设计风格）

> 以下方案遵循本仓库 Style Guide：单函数内联、避免 try/catch、Effect 风格、snake_case schema、不 preemptive 抽取单用 helper。仅作设计建议，未改动源码。

### 修复 1（针对 B1/A5）：stub_same_range 连续命中降级为实际返回

**问题**：B1 死循环——模型重读同一区间被反复 stub，因为它在上下文里找不到内容。

**方案**：在 `findReadStub` 或其调用处，检测"同 canonicalPath + 同 start/end + 同版本"的 `stub_same_range_visible` 是否已**连续**出现 ≥2 次（"连续"指中间无其他工具调用打断的同区间 stub 序列）。若是，**降级为正常返回内容**（不再 stub），并在输出加 `<note type="re-fetch">` 说明"上下文中可能难以定位，重新提供"。

落点：`read.ts:716` 之后，stub 命中分支内增加连续计数判断。计数来源：新增 `collectStubHistory`（仅收集 stub part 计数，不进 visibleReads），按时间序检测同区间 stub 是否连续（中间无其他 tool part 打断）。

```ts
// 伪代码（read.ts execute 内，stub 命中后）
const stub = findReadStub(visibleReads, current)
if (stub) {
  // 连续定义：同区间 stub 序列中，相邻两次之间无其他 tool part 打断
  const consecutiveSameStub = countConsecutiveSameRangeStub(ctx.messages, canonicalPath, current)
  if (consecutiveSameStub >= 2) {
    // 降级：fall through 到正常 read，加 re-fetch note
  } else {
    // 原 stub 逻辑
  }
}
```
`countConsecutiveSameRangeStub` 从消息末尾向前扫描，遇到同区间 `stub_same_range_visible` 计数+1，遇到任何其他 tool part 即停止。这样只对"连续紧邻的重试"降级，不影响模型合理回读。

**风险**：轻微增加 token（重发内容），但打破死循环收益更大。连续定义确保不误伤合理回读。

---

### 修复 2（针对 A4/A5/E1）：版本键增加内容指纹兜底

**问题**：等长替换 + 同 ms 写入 → 静默脏读，stub 谎称最新版。

**方案**：版本键从 `size + modifiedMs` 升级为 `size + modifiedMs + contentFingerprint`。fingerprint 取文件**头部** `SAMPLE_BYTES(4096)` 的轻量 hash（复用已有 `readSample` 调用，零额外 I/O；不读尾部以避免额外 seek）。

落点：`read.ts:608-610`，stat 后复用 line 611 已有的 `readSample` 结果计算 fingerprint；`ReadMetadata` 增加 `fingerprint` 字段；`findReadStub`/`findOverlapNote`/`computeUnreadRanges` 的同版本过滤增加 fingerprint 比较。

```ts
// read.ts metadata 构造（复用 line 611 的 sample，不新增 I/O）
const sample = yield* readSample(filepath, size, SAMPLE_BYTES)  // 已存在
const fingerprint = hashHead(sample)  // 仅头部指纹
const current: ReadMetadata = { ..., fingerprint }
// 同版本过滤
const sameVersion = visibleReads.filter(r => r.size === current.size && r.modifiedMs === current.modifiedMs && r.fingerprint === current.fingerprint)
```

**权衡**：零额外 I/O（复用已有 sample）。仅头部指纹的局限：等长同 ms 替换若**仅中部改动且头部恰好不变**时仍漏检——但文件首 4KB 不变的等长中部替换概率极低，且 stub 文案可同步降级（见修复 3）。若需更强指纹，可追加尾部读（增加一次 seek+read），权衡 I/O 成本。

---

### 修复 3（针对 A5/B1）：stub 文案从"硬断言"降级为"可定位锚点"

**问题**：文案 "are the latest version and already in context; do NOT re-read" 在模型找不到内容时有害。

**方案**：`renderReadStub`（`read.ts:332-376`）文案改为提供**可定位锚点**而非绝对禁止：
- 指明"最近一次读取在消息 #N"（需把 message 序号或时间戳纳入 metadata）。
- 语气从 "do NOT re-read" 改为 "已在上下文（消息 #N），如需查看可向上回溯；若未找到可重读 offset=M"。
- 保留 `offset` 出口（已有，`read.ts:346-356`），但不再用绝对禁止语气。

```ts
// renderReadStub 文案调整（read.ts:363-366）
const message =
  input.status === "stub_same_range_visible"
    ? `Lines ${input.start}-${input.end} were read recently (message #${input.refMessageSeq}) and should still be in context. ` +
      `If you cannot locate them, re-read with offset=${nextOffset} is not needed—instead scroll to message #${input.refMessageSeq}. ` +
      offsetExit
    : ...
```

**风险**：低。仅文案变更，不改逻辑。

---

### 修复 4（针对 C1）：read 支持显式大 limit 时放宽字节上限

**问题**：200 行默认 limit + 16KB 字节上限把模型推向 sed。

**方案**：当模型**显式传 `limit`**（非默认）且请求区间合理时，将 `MAX_BYTES` 上限按 `limit` 比例放宽，上限封顶（如 64KB）。默认 limit 仍维持 16KB 以保护无意的大请求。

落点：`read.ts:691` `lines()` 调用，传入动态字节上限：
```ts
const dynamicMaxBytes = params.limit && params.limit > DEFAULT_READ_LIMIT
  ? Math.min(MAX_BYTES * (params.limit / DEFAULT_READ_LIMIT), 64 * 1024)
  : MAX_BYTES
const file = yield* Effect.promise(() => lines(filepath, { limit: params.limit ?? DEFAULT_READ_LIMIT, offset: params.offset || 1 }, dynamicMaxBytes))
```
`lines()` 签名增加 `maxBytes` 参数（`read.ts:860`），内部 `MAX_BYTES` 改用传入值。

**权衡**：单次返回更多内容，减少 sed 逃离动机；但增加单次 token。需配合 token 预算检查（已有 `read.ts:793-806`）。

---

### 修复 5（针对 C2）：read 支持 `grep_within_range` 模式（可选）

**问题**：模型用 `sed -n | grep` 做区间内过滤，read 不支持。

**方案**：read 参数增加可选 `pattern?: string`。若提供，在 `lines()` 返回后按 pattern 过滤行，仅返回匹配行（保留行号）。这把"区间+grep"纳入 read 工具，使其进入 visibleReads 追踪。

落点：`Parameters`（`read.ts:385-393`）增加 `pattern` 字段；`renderReadOutput` 前增加过滤；metadata 记录实际返回的匹配行区间（用于 stub 追踪）。

**权衡**：增加工具复杂度，但消除 C2 逃离动机并修复 C5 盲区（部分）。可作为修复 6 的轻量替代。

---

### 修复 6（针对 C5/E3）：bash 工具识别 sed/Get-Content 区间读取，回写 read 等价 metadata

**问题**：shell 旁路读取完全绕过 visibleReads 追踪。

**方案**：在 bash 工具（`shell.ts`）的输出后处理中，识别命令模式：
- `sed -n 'X,Yp' <file>` / `sed -n 'X,Yp' <file> | grep` 
- `Get-Content <file> | Select-Object -Skip X -First Y`

命中时，向当前 part 的 metadata 写入一条 `read` 等价记录（canonicalPath、start=X、end=Y、stub:false、returned=匹配行数、size+modifiedMs 从 stat 取）。这样 `collectVisibleReads` 会把它纳入追踪。

落点：`shell.ts` 输出处理分支，增加 `detectRangeRead(command)` 辅助，命中则用 `FileSystem.FileSystem` 服务（`yield* fs.stat(...)`，遵循 `packages/opencode/AGENTS.md` "Prefer FileSystem.FileSystem instead of raw fs/promises"）取 size+modifiedMs + 写 metadata。

**权衡**：增加 bash 工具复杂度；正则识别命令有误判风险（需保守，仅匹配高置信模式）。但能消除追踪盲区，使 stub 系统对模型实际已读范围有完整视图。

**优先级排序**：修复 1（B1 死循环，最高收益）> 修复 3（文案，零风险）> 修复 2（版本键）> 修复 4（read 上限）> 修复 6（shell 回写）> 修复 5（区间 grep，可选）。

---

## 6. 遍历完整性声明

本报告遍历的问题项清单（共 27 项，5 类）：

- **A 机制正确性（5）**：A1 实际范围记录 / A2 80%非IoU / A3 整文件粒度 / A4 弱版本键 / A5 硬断言文案
- **B 模型行为（3）**：B1 retry死循环 / B2 reread_same_file / B3 high_overlap引导
- **C sed 逃离（6）**：C1 200行+16KB / C2 区间grep / C3 git修订 / C4 小区间习惯 / C5 shell旁路不可见 / C6 Windows等价
- **D 其他边界（8）**：D1 token预算 / D2 read错误 / D3 offset越界 / D4 compaction / D5 目录图片二进制 / D6 多session父上下文 / D7 并行read竞态 / D8 symlink分裂canonicalPath
- **E 设计层（5）**：E1 无hash兜底 / E2 outline缓存弱键 / E3 单条vs并集不对称 / E4 findOverlapNote重复调用 / E5 lines高offset O(n)扫描

未观察到但机制上需关注的潜在项（已并入上述分析）：compaction 边缘内容丢失（D4）、外部进程等长重写（A4）、inode 复用（未实现，不适用）、同一 turn 并行 read 竞态（D7）、symlink canonicalPath 分裂（D8）。

---

## 7. 附录：关键查询数据

### 7.1 stub 后续 10 调用行为

| 指标 | Windows | 本地 |
|---|---|---|
| retry_same_range（重读被 stub 同区间） | 57 (7.0%) | 26 (4.7%) |
| reread_same_file（含引导跟随） | 302 (37%) | 237 (43%) |
| sed/Get-Content 出现 | 83 | 138 |
| grep 出现 | 472 (58%) | — |
| sed -n 读同文件（精确） | 0（PowerShell） | 212 (38%) |

### 7.2 紧接 stub 的下一个动作（Windows 824 stub）

| 动作 | 次数 | 占比 |
|---|---|---|
| read 其他文件 | 375 | 45.5% |
| read 同文件 | 128 | 15.5% |
| other | 104 | 12.6% |
| grep | 96 | 11.7% |
| bash(非sed) | 66 | 8.0% |
| edit | 43 | 5.2% |
| bash+sed | 5 | 0.6% |

### 7.3 stub → sed 同文件：stub 区间 vs sed 区间（本地库样本）

全部样本中 sed 读取的均为 stub 区间**之外的新内容**，无一例捞取被 stub 隐去的旧内容。

### 7.4 read 错误路径

| 错误类型 | Windows | 本地 | 失败后主要动作 |
|---|---|---|---|
| token 预算超限 | 64 | 9 | read 重试（按建议 limit） |
| read status=error | 369 | 108 | read 重试 / glob / grep |
| offset 越界 | 92 | 22 | 改 offset 重试 |

---

*报告结束。本文档为唯一写入产物，未改动任何源码。*
