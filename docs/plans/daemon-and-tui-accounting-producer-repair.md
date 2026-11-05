# 1.15 Daemon 与 TUI 性能修复方案

> Revision: R4
>
> Status: verified
>
> Plan performance gate: passed for the measured workloads in section 3
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: 本文第 1、13 节的用户原文及当前 Session 的需求更新
>
> Implementation allowed: completed; further material changes require revision and review
>
> Implementation baseline: 9f52803e68
>
> Last updated: 2026-11-05

本文件是唯一当前方案。R4 替代 R1-R3 的实现路线：保留原有 Message/Part 数据、实时估算及统计公式，修正数据摄入范围与重复计算；不把 footer 切换到 RequestUsage，不为该切换增加 fork 补账或发布顺序改动。

第 3 节保留方案阶段的隔离实验。R4 已获独立方案批准，并由 primary agent 完成源码实施；实际验证记录见第 15 节。使用中的 Daemon 未重启，真实业务数据库未应用本次迁移，源码验证通过不等于已经部署。

## 1. 需求与边界

用户明确要求：

> 最小修改指的是如果可以的话从根源修正，譬如直接让相应内容不进入流程，避免只是从下游进行处理，从生产端规避这种情况，只有解决不了才考虑消费端来进行释放

> 选择的是修改的目标，没让你有选择的进行问题的筛选

> 原来的逻辑 footer 就是带实时估算的……相应的正文、推理、工具数据变化都应该去进行统计，但是统计本身是增量的，它不应该去让每一次统计都把历史的所有数据都读一遍，所以问题是这一块。

> 你的方案修改就要能证明能做到这点，而不是把具体的收益放在以后来验证……你要直接进行D:\Temp\opencode里面简单高效的实验对比来确定相关热点

> 按理来说我当时说的不要超过4秒的offline或者daemon的未响应wall

> 这是plan的验收条件，不应该把任务需求推迟到实施阶段

持续生效的约束：

- 只处理当前 1.15，禁止读取 `11720`。
- Daemon 卡顿、offline 和多 TUI 相互影响是已确认现象。
- 优先级只决定顺序，所有已确认的相关性能问题均纳入方案。
- 保留正文、推理、工具变化带来的实时估算；不通过少算、降精度、停止更新获得性能。
- 新旧 fork 继续使用各自已有的 Message/Part 统计，不建立读取父 Session 的运行时依赖。
- 不为了非性能原因回填旧 fork 账本，不扩大成冷存储错误、Provider 故障或启动问题调查。
- 不增加不必要的状态机、轮询、超时放宽、fallback、历史大小分流或数据迁移。
- 以实测推进；必要的产品分歧才询问用户，不把普通工程判断反复交给用户。

### 验收定义

核心指标是 **连续未响应 wall 不超过 4 秒**，不是平均请求耗时，也不是一批重任务必须在四秒内全部完成。

实验按相邻成功健康响应之间的最长间隔计量 wall，并记录四秒超时次数。既有 TUI 自身的探测超时配置不被修改。此前提到的约 14 秒仅是旧异常窗口记录，不是用户要求或本方案阈值。

方案阶段已运行真实 HTTP 路由 A/B，而非仅列出未来验收步骤。实施阶段重复相同实验是检查落地是否忠实于候选，不是届时才判断方案有没有收益。

## 2. 确认的问题及处理

| ID | HEAD 的实际问题 | 本轮修复位置 | 保留的语义 |
| --- | --- | --- | --- |
| P0-A | 摘要已选出增量 Message，却读取整 Session 的工具 Part 再过滤 | `summary-cache.ts` 的 SQL 摄入入口 | 同一 Message 选择范围、hidden/closed 条件、摘要结果与 cursor |
| P1-A | cursor 的 OR 谓词未使用完整范围索引；parent 查找扫描 Session JSON | cursor 谓词及 Message parent 索引查询 | chronology、同毫秒 ID 顺序、snapshot 上界 |
| P1-B | 每个 footer 重新遍历整个窗口、校准和求和 | `token/accounting.ts` 统一计算链 + Sync 的共享派生结果 | 原始输入、实时估算、所有输出字段 |
| P1-C | prompt、sidebar、subagent footer 也各自运行相同计算 | 同一共享计算入口；控件仅投影/格式化 | 各控件已有显示口径和刷新行为 |
| P1-D | 分页截断同一 request 的历史累计 | 服务端从同一 Message/StepFinish 事实生产页外数字贡献 | 数据仍来自本 Session；不改读另一张账本 |
| P1-E | 上述同步工作占用事务与 Daemon 执行线程，导致请求和 SSE 排队 | 删除无关读取、解码和重复计算，缩短现有事务的实际工作量 | 原子提交、CAS、单写者与错误传播 |
| P2-A | RequestUsage 每次把整个 Assistant 桶的完整记录搬入 JS 归约 | 同一账本 owner 内 SQL 聚合与窄列读取 | 幂等覆盖、整数微美元、状态和错误选择 |

step-finish 与 terminal 分别记录用量事实和终态，不能因为看见两次调用就删除其一。这里优化它们共同支付的归约成本。

### 撤回的错误扩展

以下不是这些测量要求的修复，R4 不再包含：

- footer 改读 RequestUsage HTTP 接口。
- 为该切换增加 fork request 表生产、旧数据补账及 Message/usage 发布顺序重排。
- 减少 footer 的实时估算功能。
- 用 `mounted`、延迟刷新、乐观回显或更长 timeout 隐藏同步阻塞。
- 未经测量就重构 worker、队列、控制面或 SQLite 拓扑。

`opencode stats` 现有代码会使用 RequestUsage，也能从 Session 自己的 Message/Part 显示统计（`cli/cmd/stats/data.ts:887-1019`）。fork 的统计事实已经存在；本方案继续使用这些事实，不制造 A 到 B 的迁移问题。

## 3. 已执行的实验

所有脚本位于 `D:\Temp\opencode`。源数据库以只读方式访问；真实路由实验使用一致 SQLite 快照 `daemon-perf-snapshot-20261105.db`，大小约 5.37GB，备份耗时 22.42 秒。索引实验只修改内存数据库或该快照。

### 3.1 SQL 选择范围与索引

命令：

```powershell
& "C:\Users\Lenovo\.bun\bin\bun.exe" "D:\Temp\opencode\run-query-experiment.ts"
```

| 操作 | HEAD | 候选 | 结果检查 |
| --- | ---: | ---: | --- |
| 无增量的 Part 读取 | 1307.40ms，摄入 85,863 行后全部丢弃 | 0.22ms，零 Part 查询 | 集合一致 |
| 20 条 Message 对应的 Part | 1201.41ms，仍摄入全部 85,863 行 | 3.23ms，读取实际所需 46 行 | 集合一致 |
| Message cursor 空增量 | 11.78ms，索引只用 session_id | 0.24ms，使用 `(time_created,id)` 范围 | 完整 rows 一致 |
| parent 查找，60,628 条 Message 副本 | 80.88ms | 0.85ms | 完整 rows 一致 |
| 552 个 Assistant 的 RequestUsage 归约 | 1.13-3.06ms | 0.35-1.10ms | 数值、状态、错误结果一致 |

索引计划已经实际确认：

```text
Part:    part_message_id_id_idx (message_id=?)
Cursor:  message_session_time_created_id_idx (session_id=? AND (time_created,id)>(?,?))
Parent:  message_session_parent_time_id_idx (session_id=? AND <expr>=?)
```

淘汰的实验：只加 `IN (...)` 仍选 Session 索引，约 590ms；尝试关联查询时仍选 `part_session_idx`，同一结果反而耗时约 5063ms。两者都不进入实施路线。

### 3.2 完整 accounting 等价性与更新成本

文件：

- `accounting-incremental-experiment.ts`：`measure -> summarize -> project` 候选计算链。
- `run-accounting-experiment.ts`：真实 `tokenAccounting()` 作为对照，真实 Solid store/memo 驱动变化。

命令：

```powershell
& "C:\Users\Lenovo\.bun\bin\bun.exe" --conditions=browser "D:\Temp\opencode\run-accounting-experiment.ts"
```

输入：300 条真实消息、2754 个 Part、8 个 footer、30 个 request。

| 更新 | HEAD | 候选 |
| --- | ---: | ---: |
| 初始化 | 243.39ms | 131.53ms |
| 新增文本 Part | 226.82ms | 2.26ms |
| 文本 delta | 24.75ms | 1.92ms |
| 推理更新 | 233.20ms | 1.90ms |
| pending 工具输入 | 226.52ms | 1.22ms |
| 工具完成与输出 | 22.76ms | 1.95ms |
| 已确认 usage 修订 | 204.08ms | 1.11ms |
| 新 step-finish | 190.12ms | 1.14ms |
| Assistant 完成 | 18.97ms | 0.98ms |
| 移除 Part | 176.11ms | 1.50ms |
| 权威快照整体替换 | 247.77ms | 119.32ms |

对每种状态及每个 request，包括默认请求和不存在的 request，比较完整返回值：`step/request/session/contextLimit/contextPercent/breakdown/ratio`。**352 次 deep equality 全部通过**，不是只比较已确认 token 或最终字符串。

普通变化只重新测量一个 Message，再归约缓存的数字贡献；没有重读其他 Message 的正文。各 footer 的轻量投影仍可更新，以保持全局校准变化后的实时估算。该实验不把“减少更新次数”当作优化结果。

### 3.3 分页使用同源数字贡献

```powershell
& "C:\Users\Lenovo\.bun\bin\bun.exe" "D:\Temp\opencode\run-pagination-facts-experiment.ts"
```

从同一 Session 的 Message 与 step-finish 读取一个包含 552 个 Assistant 的 request，模拟只显示最后 25 个：

| 数据 | input | output + reasoning |
| --- | ---: | ---: |
| 可见 25 条 | 9,771 | 14,123 |
| 完整 552 条 | 433,108 | 366,363 |
| 页外贡献 + 可见页贡献 | 433,108 | 366,363 |

读取及解码约 **7.1ms**；样本的页外数字基线只有 **41 字节**。该样本 cost 为 0，费用的一般等价性另由 3.2 的非零 usage 修订覆盖，不用此零费用样本声称验证所有金额边界。

这说明修正分页少计不需要把所有历史正文拉到 TUI，也不需要更换数据源。生产端只返回原事实的数字投影。

### 3.4 真实 HTTP 路由与四秒 wall

文件：`real-route-perf-server.ts`、`run-real-route-perf.ts`。

临时进程直接导入当前仓库的 `Server.Default().app`，运行真实 `SessionHttpApi.diff` 和 `/global/health`，不是简化的假 handler。候选仅通过 Bun 的临时模块变换替换摘要 Part 查询，主仓库文件不变。客户端位于独立进程，测试在同一数据库快照上执行。

同时加入同源页外统计读取：31 个 request，共 3366 字节；候选读取耗时 9-15ms。以下是包含这项额外工作的结果：

| 并发 diff 数 | HEAD 最长无响应 wall | 候选最长无响应 wall | 候选四秒超时 |
| --- | ---: | ---: | ---: |
| 1 | 3781ms | 588ms | 0 |
| 2 | 1669ms | 608ms | 0 |
| 4 | 3106ms | 1150ms | 0 |
| 8 | **6137ms，失败** | **1958ms，通过** | **0** |

此前不含页外投影的一轮，8 并发为 **11297ms -> 1783ms**。所有 diff 返回 200、100 条 viewer 结果，跨模式响应内容一致。

```powershell
& "C:\Users\Lenovo\.bun\bin\bun.exe" "D:\Temp\opencode\run-real-route-perf.ts"
```

明确区分 wall 与业务耗时：候选 8 个并发请求最后完成者约 4703ms，但期间健康请求持续获得响应，最长断档 1958ms。用户规定的是连续 offline/未响应不超过四秒，不是八个业务请求合计必须四秒内完成。

实验配置隔离了用户插件、外部模型请求和文件监控，两个模式使用相同配置；它证明当前复现负载及真实 HTTP/SQLite 主路径的收益，不声称已经替换用户运行中的二进制。

## 4. 具体实现：摘要查询

### 4.1 Part 选择范围

继续使用 `loadToolDiffMessages()` 已选出的 Message 集合，对每个 Message 走既有索引。空数组自然产生零次查询，不加历史大小阈值。

```diff
--- a/packages/opencode/src/session/summary-cache.ts
+++ b/packages/opencode/src/session/summary-cache.ts
@@
-  const selectedMessageIDs = new Set(messages.map((row) => row.id))
-  const parts = db
-    .select()
-    .from(PartTable)
-    .where(and(...partConditions))
-    .orderBy(asc(PartTable.message_id), asc(PartTable.id))
-    .all()
-    .filter((row) => selectedMessageIDs.has(row.message_id))
+  // Message 范围在摄入时生效，空增量不再读取历史 Part。
+  const parts = messages.flatMap((message) =>
+    db.select().from(PartTable)
+      .where(and(...partConditions, eq(PartTable.message_id, message.id)))
+      .orderBy(asc(PartTable.id))
+      .all(),
+  )
```

保留 Message chronology、Part ID 顺序及原过滤。初次完整生成也走同一路径，不增加第二套算法。

### 4.2 Cursor 范围

把等价的 OR 谓词整理成 SQLite 行值比较，让现有复合索引执行范围 seek：

```diff
@@ function afterCursor(cursor: MessageCursor) {
-  return or(
-    gt(MessageTable.time_created, cursor.time),
-    and(eq(MessageTable.time_created, cursor.time), gt(MessageTable.id, cursor.id)),
-  )
+  return sql`(${MessageTable.time_created}, ${MessageTable.id}) > (${cursor.time}, ${cursor.id})`
 }
@@ function throughCursor(cursor: MessageCursor) {
-  return or(
-    sql`${MessageTable.time_created} < ${cursor.time}`,
-    and(eq(MessageTable.time_created, cursor.time), lte(MessageTable.id, cursor.id)),
-  )
+  return sql`(${MessageTable.time_created}, ${MessageTable.id}) <= (${cursor.time}, ${cursor.id})`
 }
```

保留现有 BINARY ID 排序，不以字典序 ID 代替时间，不改 cursor 表示或增加额外版本字段。

### 4.3 Parent 索引

`MessageV2.targetWithAssistantChildren()` 将 target 主键查询与 children 关系查询分开，避免 OR 混合两种身份。两者保留相同 hidden/snapshot 条件，合并后按原 chronology 排序。

```sql
CREATE INDEX message_session_parent_time_id_idx
ON message(session_id, json_extract(data, '$.parentID'), time_created, id);
```

对应 Drizzle schema：

```ts
index("message_session_parent_time_id_idx").on(
  table.session_id,
  sql`json_extract(${table.data}, '$.parentID')`,
  table.time_created,
  table.id,
)
```

此索引同时服务同源 request 统计投影。新增索引不移动或重写 A 数据。迁移通过包内既有 `bun run db generate --name message_parent_lookup` 生成，不手写历史 snapshot。

### 4.4 事务

保留已有 immediate transaction 和 CAS。已验证的主收益来自删除事务里的无关扫描、排序和解码；当前没有必要同时改变锁策略来制造新的并发行为。

真实路由实验保留了原事务类型，已经通过四秒 wall。因而“缩短事务工作量”有当前实证，不把“把 immediate 改成 deferred”作为未经验证的附加补丁。

## 5. 具体实现：统一 accounting 计算链

### 5.1 三个计算阶段，同一套公式

将现有 `token/accounting.ts` 按实际职责整体整理为：

```text
Message + 自己的 Parts
    -> measureMessage：一次计算该 Message 的统计贡献
所有已缓存的贡献
    -> summarizeAccounting：一次生产 Session/request 汇总与校准量
汇总 + requestID/contextLimit
    -> projectAccounting：生成现有 TokenAccounting 返回结构
```

经过完整对照实验的函数体在 `D:\Temp\opencode\accounting-incremental-experiment.ts`，共 232 行。落地时将其整理到原模块，沿用仓库类型和命名，而不是保留一份实验算法作为第二套实现。

原纯函数接口保留为同一计算链的组合入口：

```ts
export function tokenAccounting(messages, getParts, contextLimit?, requestUserID?) {
  return projectAccounting(
    summarizeAccounting(messages.map(message => measureMessage(message, getParts(message.id)))),
    contextLimit,
    requestUserID,
  )
}
```

它继续服务退出时的一次性统计、独立纯函数消费者和既有测试。持续更新的 TUI 消费者复用中间结果，不再各自从头运行该组合入口。

### 5.2 每条 Message 保存什么

保存的都是派生数字或原 metadata 的只读投影，不复制正文：

- 按原顺序的 step token/cost 贡献；无 step-finish 时保留原 message.tokens 口径。
- output 校准需要的字符量和确认 token 量。
- input 校准需要的 step-finish 小样本，继续调用原 `TokenEstimate.learnInputCharsPerToken`。
- 最后 step-start/step-finish 的位置及 inputBreakdown。
- 未确认输出字符量、工具结果字符量、附件估算量和 live breakdown 分类数字。

保留原始取整位置、pending 与 confirmed 切换、cache/pure input 区分、历史 request 选择与 queued orphan 处理。cost 按原 step 顺序累加，不把每段取整后的结果再次求和。

### 5.3 共享与生命周期

共享 owner 放在已有 SyncProvider，按 Session 创建派生计算，生命周期复用现有正文消费者和 Session 释放流程，不新增引用计数、TTL、轮询或业务状态机。

核心连接形式：

```ts
const contributions = mapArray(
  () => store.message[sessionID] ?? [],
  message => createMemo(() => measureMessage(message, store.part[message.id] ?? [])),
)
const snapshot = createMemo(() =>
  summarizeAccounting(contributions().map(read => read())),
)
const read = (contextLimit?, requestID?) =>
  projectAccounting(snapshot(), contextLimit, requestID)
```

Sync 只在首次被消费时建立一个 Session 派生 owner；`releaseSessionParts`、`releaseSession` 和 Provider cleanup 释放对应 owner。复用已有生命周期，避免为了共享计算再建立另一套消费者管理。

普通 Part 更新由 Solid 原有属性依赖使对应 Message 的 memo 失效；快照整体替换或新 Message 身份自然重建相应贡献，不在每种 SSE 事件里手工维护一套 token 增减算法。

这不是逐字符 O(1) 的手写账本：它重算变化 Message 的 Parts，其他消息复用缓存；共享汇总仍遍历小型数字贡献。实测这条更简单的路线已经将更新压到约 1-2ms，没有必要为追求理论 O(1) 添加复杂维护流程。

### 5.4 消费者改动

四处持续消费改成同一个 `sync.session.accounting(sessionID, contextLimit?, requestID?)`：

```diff
--- a/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
+++ b/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
@@
-    const usage = tokenAccounting(messages(), (id) => sync.data.part[id] ?? [], undefined, props.message.parentID).request
+    const usage = sync.session.accounting(props.message.sessionID, undefined, props.message.parentID).request
```

```diff
--- a/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx
+++ b/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx
@@
-    const acc = tokenAccounting(msg, getParts, model?.limit.context)
+    const acc = sync.session.accounting(props.sessionID, model?.limit.context)
```

subagent footer 使用自身 SessionID 调用同一入口；内部 sidebar 插件复用已有 Sync context，不扩展公开插件 API。删除这几处不再使用的 `getParts` 局部变量和 import。

历史 footer、输入区与侧栏的实时输出全部保留。`mounted()` 继续只管理渲染资源，不承担统计正确性或性能补偿职责。

## 6. 分页：同一事实生产小投影

分页外正文不送入 TUI。服务端按当前 Session、涉及的 request 及可见 Message 集合，从 Message/step-finish 读取页外数字贡献，SQL 层排除可见集合，客户端与可见消息贡献合并。

```text
同一 Session 的 Message/Part
  -> 当前页：原有正文与实时事件
  -> 页外：input/output/reasoning/cache/cost 等小型贡献
  -> 同一 accounting 汇总
```

新增的是只读投影，不是新账本、新权威来源或数据迁移。fork 复制的原事实同样有效，不需要给 fork 另建 RequestUsage 记录。

生产端复用第 4 节 parent 索引，Part 关联使用 message_id 索引；只读 step-finish 与必要 Message 标量，不读取工具输出、推理正文或完整历史 transcript。

传输采用一个 Session 级的 TUI accounting 投影请求，跟随分页/权威快照获取；一次覆盖本页涉及的 request，不为每个 Assistant 发请求。请求含 SessionID、requestIDs、visibleMessageIDs，返回 request 到页外数字贡献的映射；作用域始终由 SessionID 限定。

普通可见正文 delta 不重新请求页外贡献。窗口替换更新这份基线；同 Session 页外的计费事实被修订或移除时，通过已有事件路径刷新受影响 request。不会轮询、查询父 Session或回填数据。

页外贡献只补请求累计，不改写当前可见流式估算和校准公式。原 message.tokens 兼容口径与可见性规则继续使用同一计算模块，不另外复制一套费用算法。

临时真实路由实验已经同时执行这项投影：31 个 request、3366 字节、9-15ms，并通过 8 并发四秒 wall；因此它不是留到实施后才测量的额外生产开销。

## 7. RequestUsage 内部聚合

账本本身保留。将完整 Assistant 行读取后 JS reduce 改为 SQL 求和、状态归约，错误选择保留原窄列折叠：

```sql
SELECT count(*) AS assistant_count,
       coalesce(sum(step_count),0) AS step_count,
       coalesce(sum(tokens_input),0) AS tokens_input,
       coalesce(sum(tokens_output),0) AS tokens_output,
       coalesce(sum(tokens_reasoning),0) AS tokens_reasoning,
       coalesce(sum(tokens_cache_read),0) AS tokens_cache_read,
       coalesce(sum(tokens_cache_write),0) AS tokens_cache_write,
       coalesce(sum(tokens_total),0) AS tokens_total,
       coalesce(sum(cost_micros),0) AS cost_micros,
       coalesce(max(status='running'),0) AS has_running,
       coalesce(max(status='error'),0) AS has_error,
       coalesce(max(status='aborted'),0) AS has_aborted,
       coalesce(max(time_completed),0) AS completed
FROM request_usage_assistant
WHERE session_id=? AND request_id=?;
```

普通结算仍覆盖原 Assistant 快照，再更新 request 聚合；重复调用不重复加钱。没有新增长期 delta 账本状态、修复基线或 reparent 流程。

这个改动独立于 TUI 数据源，已单独验证 552 条真实记录的全部归约结果，不改变 Message/usage 发布顺序。

## 8. 文件与完整映射

| 模块 | 必要修改 | 对应验证 |
| --- | --- | --- |
| `session/summary-cache.ts` | Part 精确摄入；cursor 行值比较 | SQL rows 等价、真实 HTTP wall |
| `session/message-v2.ts` | parent 查询按索引；同源页外统计读取 | parent rows 等价、552/25 分页对比 |
| `session/session.sql.ts` 与生成 migration | parent expression index | 实际 EXPLAIN 与内存/快照实验 |
| `token/accounting.ts` | 整理为 measure/summarize/project；保留原入口 | 352 次完整输出对比 |
| `cli/cmd/tui/context/sync.tsx` | 共享派生 owner、生命周期、分页数字基线 | 真实 Solid 更新、快照替换、释放/重新进入 |
| Session footer、prompt、sidebar、subagent footer | 消费共享结果，不重新扫描正文 | renderer 数值和实时展示回归 |
| TUI HTTP group/handler 及对应 SDK 生成链 | Session 级只读 accounting 投影 | 实验查询与请求级负载、作用域测试 |
| `session/request-usage.ts` | SQL 聚合与窄错误列 | 真实桶的完全等价对比 |

`processor.ts`、`prompt.ts` 的记账顺序、`revert.ts`、fork projector、复制存储逻辑不因本次性能方案而改动。它们原有数据生产合同没有因为 footer 换源而被人为改写。

计划中的只读投影属于同一事实的生产/传输优化；若落实到 HTTP schema，按仓库规则生成 SDK，不手工修改 generated 文件。不得用未经测量的另一种统计数据源替换该路径。

## 9. 必要验证与完成条件

方案阶段已有第 3 节实证。实施时使用同一输入/命令防止落地漂移，并补少量生命周期行为测试，不为每个 hunk 构造独立红测。

1. 保留 `test/token/accounting.test.ts` 与 `test/cli/tui/token-estimate.test.ts` 的原字段和口径断言。
2. 在真实 renderer fixture 中验证正文、推理、工具输入输出及 usage 修订都更新展示；多个 footer 消费同一结果。
3. 验证分页、快照替换、Message/Part 删除、切换 Session、释放后重新进入，不残留旧贡献、不重复累计。
4. 摘要覆盖空增量、正常增量、首次完整读取、同毫秒/非单调 ID、hidden/closed 边界和原 CAS 回归。
5. 账本覆盖重复记录、用量修订、混合状态、非零费用；不以调用次数代替金额语义。
6. 重复真实 HTTP A/B 的 1/2/4/8 并发及页外投影，最长未响应 wall 必须不超过 4 秒。加入真实 TUI 后，持续 offline 同样不能超过 4 秒。

所有测试和 `bun typecheck` 从 `packages/opencode` 执行。现有一次性 `/context` 和退出入口继续调用同一纯函数，不引入常驻重算。

如果落地结果偏离已通过的候选，定位实现差异并修正；不再把已确认性能问题延期，不用更长 timeout 或少算数据“通过”。

## 10. 已有开销与责任范围

修正摄入后，真实路由 profiling 中 `prepareDeltaState` 约 6-20ms，完整摘要恢复/投影约 330-479ms。这段仍在四秒 wall 的已测负载预算内。当前不为它添加新缓存状态或第二数据来源，保留既有完整性合同；它不是一个未完成的“以后修复”项目。

若真实目标负载使四秒 wall 再次失败，应继续对该实际阻塞段做实验并修正主路径；不能因为局部查询变快就宣布整个目标达成。独立 worker 只有在必要的同步工作确实无法缩短到预算时才成为有证据的路线，不先重构架构。

初次完整加载需要建立贡献，实测约 132ms；快照整体替换约 119ms。正常流式更新为约 1-2ms。不会把“初始化需要全量”误当成“每个 delta 都应全量”，也不保证任意无限并发/无限输入下的绝对时限。

## 11. Workflow 与历史记录

遵循 `docs/workflow.md` 的第一性原则、owner、单一路径、映射和验证要求。实验与方案修订已经完成；用户本轮要求重新读取 workflow 并继续完整流程，当前进入独立方案审计。旧 revision 的 verdict 不能放行 R4。

| Revision | 历史结果 | 当前处置 |
| --- | --- | --- |
| R1 | 独立审计 BLOCK：footer 切到账本会让新 fork 缺失统计 | 换源路线撤回，触发该问题的改动不存在于 R4 |
| R2 | 新 fork 生产被纳入；审计继续阻断旧 fork 展示变化 | 不以非性能理由增加历史补账 |
| R3 | 澄清用户范围后，旧审计会话仍固定初始基线 | 不继续围绕该审计会话打转；其 verdict 不代表最新用户范围 |
| R4 | 保留原事实和实时估算；完成 SQL、完整 accounting、分页贡献及真实 HTTP wall 实验 | 方案第 4 轮 APPROVE；实现第 3 轮 full-scope APPROVE，当前 verified |

实施时按实际有效增改行数满足仓库中文解释性注释要求；解释集合边界、顺序、数值口径与生命周期，不写重复代码的填充注释。无需 SHA256、无关 git status、全仓取证或新增独立审计材料体系。

## 12. 当前交付

- 当前方案：本文件 R4。
- 可复现实验：`D:\Temp\opencode` 中的 accounting、SQL、分页和真实路由脚本。
- 数据保护：源数据库只读；真实路由只使用隔离快照；源码已按 R4 修改，使用中的 Daemon 未变。
- 已证明的核心收益：消除全历史 Part 摄入；保留完整实时统计，最终普通更新约 1-4ms；8 并发实际源码和正式页外接口下最长未响应 2446ms，低于四秒。1958ms 是此前方案候选的实验结果。
- 没有数据源迁移、fork 回填、实时功能削减或以界面补偿掩盖阻塞。

## 13. 本轮 Workflow 合同与送审映射

### 需求更新原文

> 下面重新读取workflow，然后继续进行相应的完整流程：

> Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.

> 所有方案的实现均不得使用 sub-agent，Edit 必须由你自己进行，所有 sub-agent 进行的修改请你进行撤销掉。

> 注意不要影响全局的配置、数据库等内容

实现与编辑只由 primary agent 执行。已逐项撤销中断的实施子代理对 5 个源码/测试文件及 2 个迁移生成文件的修改，并以限定路径 `git diff --exit-code` 与 untracked 清单核验恢复完成；随后由 primary agent 从恢复后的版本实施，不复用子代理未完成的修改。

用户最新终态更新原文：

```text
**目标终态*   verified-implementation-and-commit3
```

目标终态更新为 `verified-implementation-and-commit`：当前 R4 已 verified，继续仅提交本任务实现、测试、生成文件和本 canonical plan。其他工作区内容保持原样，没有 push 授权；该更新不改变已批准的实现路线或审计结果。

### 仓库上下文、证据与可达性

| 依据 | 对本任务的约束 | 类型 |
| --- | --- | --- |
| 根及 `packages/opencode/AGENTS.md` | 包内测试/typecheck，Drizzle 生成迁移，沿用现有模块风格 | contracted |
| `CONTEXT.md` | Session/Message/Part 归属，AppRuntime 与 InstanceState 边界 | contracted |
| `docs/adr/` | 当前仅有 triage ADR，无适用于此次统计/摘要修复的技术 ADR | contracted |
| HTTP API 与 test 的 `AGENTS.md` | HttpApi group/handler、作用域中间件、真实 Effect fixture 和清理 | contracted |
| `summary-cache.ts:225-301` 及第 3.1、3.4 节脚本 | 增量 Message 后全 Session Part 摄入，真实 HTTP 阻塞与候选收益 | observed |
| `token/accounting.ts`、`token/estimate.ts` 及第 3.2 节脚本 | 原统计公式、多消费端重复计算、实时变化及完整字段等价 | observed |
| Sync 与第 5.4 节四个持续消费者 | 本地 store 的 Message/Part 由分页、快照和 SSE 更新，释放由现有 Sync owner 管理 | reachable |
| `message-v2.ts`、`session.sql.ts` 及第 3.3 节脚本 | parent 查询、页外 request 累计与同源数字投影 | observed |
| `request-usage.ts`、`cli/cmd/stats/data.ts` | 幂等账本聚合、原 Message/Part 统计与 fork 自有事实 | observed |

真实输入是现有 Schema 解码的 Message/Part、当前分页窗口及 Session 级 HTTP 参数。HTTP payload 的原始输入约束属于现有 HttpApi Schema 和作用域中间件；领域层继续按 Session 限定查询，不在内部纯计算中增加重复解析或权限实现。

### 不变量、首次分歧与正向映射

| ID | 行为不变量 | 首次分歧与 owner | 文件/路径 | 行为验证 |
| --- | --- | --- | --- | --- |
| INV-01 | 小增量不摄入无关历史 Part；多窗口最长未响应 wall <=4 秒 | `loadToolDiffMessages` 在 SQL 选取阶段未限制 Message | §4.1、4.4，摘要与真实 HTTP 路由 | 原始 A/B loop；完整 diff 相等 |
| INV-02 | cursor/parent 选择集合和 chronology 不变，查询利用对应索引 | OR 条件将范围限制留给逐行过滤 | §4.2、4.3，Message 查询与 schema/migration | 完整 rows 相等、同毫秒及非单调 ID、hidden/closed/CAS 回归 |
| INV-03 | 原统计字段、估算与刷新语义不变；无关正文不重复测量 | 每个持续控件调用全窗口 `tokenAccounting` | §5，原 accounting owner 与 Sync 派生 owner | 352 次对照；renderer 中正文/推理/工具/usage 更新 |
| INV-04 | request 累计不受窗口截断，fork 仅使用自身事实 | request 选择后仍只累加可见窗口 | §6，Message owner 生产数字、HTTP 传输、Sync 合并 | 552/25 实验；分页交接、修订与移除、Session 隔离 |
| INV-05 | 切换、释放与快照替换无旧贡献或重复累计 | 独立消费计算没有 Session 级共享生命周期 | §5.3，现有 Sync release/cleanup | 释放后重新进入、快照替换、删除与多消费者 |
| INV-06 | 原账本的金额、终态、错误选择及幂等语义不变 | 归约先搬运不需要的完整 Assistant 行 | §7，RequestUsage owner | 552 行对照；重复记录、修订、混合状态、非零费用 |

现有 `test/token/accounting.test.ts`、`test/cli/tui/token-estimate.test.ts` 保护原公式；摘要、Message 与 RequestUsage 的现有回归继续保留。新的行为切片分别位于这些已有公共 seam 或真实 Sync/renderer/HTTP fixture，不对私有 helper 和源码文字建立断言。

### 反向映射、路径与删除项

| 生产概念 | 必要依据 | 现有逻辑为何不足 |
| --- | --- | --- |
| Message 范围索引点查、tuple cursor、parent index | INV-01、02；真实查询及 EXPLAIN | 目前只在 JS 丢弃 Part，OR/JSON 扫描未完成范围 seek |
| measure/summarize/project | INV-03；全字段对照 | 原组合函数不允许复用单 Message 的已测量贡献 |
| Sync Session 派生 owner | INV-03、05；四个持续消费者 | 各组件局部 memo 无法共享，复用现有释放机制即可，不另建业务状态机 |
| 同源数字投影及 Session 级传输 | INV-04；552/25 对照 | 当前页不含页外事实；重拉历史正文或切账本都非必要 |
| RequestUsage SQL 归约与窄错误列 | INV-06；552 行对照 | 已有索引可用，但完整行传入 JS 后才丢弃大部分列 |

新替代成功路径为 0，新生产诊断分支为 0，诊断 decision-surface 占比为 0%。Message.tokens 的既有兼容分支属于原统计合同，保持在同一计算链。临时实验是诊断文件，不进入生产导入链。删除旧全 Session Part 摄入后过滤、四处重复全窗口 accounting 及失效 import/getParts 局部变量；不改 fork、记账顺序、Provider 或冷存储合同。

### TDD、验证与预算

按 §9 的 seam 逐条垂直落地：摘要 SQL 与原始 wall loop；统计完整字段；Sync/renderer 实时变化与释放；同源分页；账本幂等。HEAD 已由真实 wall loop 和分页累计对照捕获缺陷；原公式回归用于防止整理时退化，不为已正确行为人为制造红测。

| 命令 | 工作目录 | 证明内容 |
| --- | --- | --- |
| `bun test test/token/accounting.test.ts test/cli/tui/token-estimate.test.ts` | `packages/opencode` | 原字段与实时估算口径 |
| `bun test test/session/message-v2.test.ts` | `packages/opencode` | Message chronology 与 parent 行为 |
| `bun test test/session test/token test/cli/tui` | `packages/opencode` | 相邻摘要、账本、统计与 TUI 回归 |
| `bun test test/cli/cmd/tui test/server test/storage/cold.test.ts` | `packages/opencode` | N-01 清单补正：实际 Sync fixture、HTTP 作用域及摘要边界回归 |
| `bun typecheck` | `packages/opencode` | 正式类型与 API 接线 |
| `bun run db generate --name message_parent_lookup` | `packages/opencode` | 从 schema 生成索引迁移 |
| `bun ./packages/sdk/js/script/build.ts` | 仓库根 | API 改动后的 SDK 生成链 |
| 第 3 节四个已执行实验命令 | `packages/opencode` | 原始症状、同源分页及完整算法等价 |

文件责任以 §8 为准；预计修改 12-16 个手写生产文件，增加必要的现有 seam 行为测试及一份生成迁移，SDK 按生成器实际输出记录。有效增改代码 E 预计 450-700 行（排除 import-only、格式化、pure-move、generated）；对应中文解释性注释 C 至少 68-105 行，最终按实际 E 重算 `ceil(E*0.15)`，不以下界 68 代替实际比例。注释邻近解释 chronology、校准与取整、pending/confirmed、费用顺序、分页不重计、作用域和释放原因，不复述代码。预算是估算，不授权削减行为或扩大修改。

### 风险、审计与实施记录

已证实或可达的风险是 Solid 字段依赖遗漏、快照/分页异步交接重复累计、费用归约顺序漂移和 HTTP Session 作用域；分别由 §5-9 的单 owner、原公式及行为回归约束。没有待用户抉择的产品差异。无限并发绝对时限、无证据的旧 fork 补账、额外冷存储修复或先行 worker 重构均不驱动本轮生产代码。

独立审计按当前完整用户需求重建证据，不接受旧 revision 的批准、builder 自评或缩小范围。保留 §11 的三轮历史记录；当前为更新需求后的下一轮，收到 verdict 后原样记录 finding ID、分类、放行结论及 invocation。必要修订递增 revision 并清空 approval。

实施证据见第 15、17、19 节；第 3 轮完整范围实现审计已批准，原始 verdict 见第 20 节。

## 14. 独立方案审计：第 4 轮 / R4

Invocation: `ses_e551cdb45ffeEutEDtti1oaulZ`。以下为独立审计员原始 verdict，未改写分类或放行条件。

### Blocking findings

No blocking findings.

### Non-blocking findings

#### N-01 验证命令表遗漏了部分已承诺的回归测试目录

方案 §9、§13 已明确要求 Sync 生命周期、HTTP 作用域和原摘要回归，但命令表中的 `test/cli/tui` 不包含实际 Sync fixture 所在的 `test/cli/cmd/tui`；相关摘要边界测试还位于 `test/storage/cold.test.ts:1985-2073`。

执行时应把这些已承诺测试对应的命令补入记录。这属于验证清单修正：相关行为、owner 和测试 seam 已经映射，不要求扩展生产设计。

### Rejected speculation

以下事项不构成本轮 blocker：

- **旧 fork 补账。** R4 保留 Session 自有 Message/Part 事实，没有引入切换 RequestUsage 后缺失历史统计的问题。
- **预先引入 worker、队列或新的锁策略。** 当前方案直接收窄同步查询和重复计算；现有证据没有证明必须增加这些机制。
- **任意无限并发下的绝对四秒保证。** 方案明确了实测负载范围，用户要求的验收没有被改写成无限输入保证。
- **无证据的数据异常防御。** 不要求纯统计模块重复承担 HTTP Schema、持久化解码或 Session 作用域的职责。

### Requirement and traceability coverage

本轮覆盖原始需求及 R4 全部拟修改区域，并直接读取了相关生产代码、消费者、测试和实验脚本。

| 要求 | 独立核对结果 |
| --- | --- |
| 修复 Daemon 同步阻塞的生产端入口 | `summary-cache.ts:244-282` 确实先选择增量 Message，再全 Session 查询 Part、最后过滤；§4.1 在摄入入口修复首次分歧。 |
| 保持 cursor、顺序及摘要语义 | tuple 比较对应现有 chronology 条件；parent 查询拆分仍受原 hidden、snapshot 和 target 存在条件约束。现有测试覆盖相关边界。 |
| 消除 footer 及其他持续消费者的重复计算 | 已核对 Session footer、prompt、sidebar、subagent footer；§5 的共享贡献计算覆盖这些实际调用点。 |
| 保留实时估算及统计口径 | 候选分解保留原统计链，原纯函数作为组合入口继续存在；实验脚本比较完整返回结构，并驱动正文、推理、工具、usage 和快照变化。 |
| 修复分页截断的 request 累计 | §6 将同 Session 页外事实投影为数字贡献，生产、传输、合并和生命周期均有 owner 与行为验证映射。 |
| 优化 RequestUsage 聚合 | `request-usage.ts:401-468` 的完整行搬运及 JS 归约确实存在；§7 保留幂等覆盖、微美元金额、状态优先级和错误选择。 |
| 方案阶段四秒 wall 验收 | 已核对真实路由实验的服务端变换、独立客户端健康探测和超时判定；记录的验收范围包含 1/2/4/8 并发及页外投影。 |

**执行边界：** 本轮直接核对了实验脚本，没有执行需额外授权的 Bun 命令；1958ms 等耗时是 canonical plan 记录的实验结果，本轮未独立复测。脚本确实使用真实 `/session/.../diff` 和 `/global/health`，并具备捕捉 HEAD 四秒失败、比较候选结果的反馈信号。未发现需要推翻现有实验或重复取证的具体缺陷。

### Primary-path and fallback verdict

**通过。**

- 摘要保留原聚合、事务和 CAS，只修正摄入范围及索引查询。
- accounting 的 `measure → summarize → project` 是同一算法的职责分解；原函数和共享消费者复用该计算链。
- 页外投影读取同一 Session 的原事实，承担分页累计职责。
- RequestUsage 保持原 owner 和数据语义。
- 新增替代成功路径为 **0**；新增生产诊断分支为 **0**。未发现换源 fallback、失败后合成成功或以界面补偿掩盖阻塞。

### Code quality and Chinese-comment verdict

**方案阶段通过。**

改动集中在已确认的查询、统计和传输责任内；保留原公式、现有释放机制和错误传播，没有要求新增业务状态机、轮询或迁移账本。

§13 明确承诺按实际有效增改代码满足 **15% 中文解释性注释目标**：

- 预计 `E = 450–700`
- 对应 `C ≥ 68–105`
- 排除 import-only、格式化、pure-move 和 generated 行
- 注释分布于顺序、校准、取整、分页去重、作用域和释放边界附近

这是可执行的估算。实际 `E/C` 留待实现 diff 独立计算，本轮不以方案估算代替实现审计。

### Release verdict

**APPROVE — 仅适用于 `docs/plans/daemon-and-tui-accounting-producer-repair.md` 的 R4。**

本轮为 full-scope plan audit。该批准允许按 R4 进入实施阶段；实现完成仍须通过约定测试、原始性能反馈 loop、包内检查及独立实现审计。

## 15. R4 实施证据

### 实际修改与必要性

全部手写实现与测试编辑均由 primary agent 完成，实施子代理的旧修改已在开始实施前全部撤销并核验。没有 commit、push、Daemon 重启或真实数据库迁移。

| 文件 | 实际责任 |
| --- | --- |
| `src/session/summary-cache.ts` | 消除增量后的全 Session Part 摄入，tuple cursor 保持原 chronology/CAS |
| `src/session/message-v2.ts` | target/children 分别索引读取；同 Session 页外 Message/step-finish 的关联数字投影 |
| `src/session/session.sql.ts` | parent/chronology expression index |
| `migration/20261105100236_message_parent_lookup/{migration.sql,snapshot.json}` | primary agent 运行既有 Drizzle 命令生成；未手写 snapshot |
| `src/token/accounting.ts` | 单一 measure/summarize/project 链，原纯函数继续组合同一算法 |
| `src/cli/cmd/tui/context/sync.tsx` | Session 共享派生 owner、数字基线、SSE 淘汰转交、旧响应失效与现有释放边界 |
| `src/cli/cmd/tui/routes/session/index.tsx` | 历史 footer 仅选择 parent 与格式化 |
| `src/cli/cmd/tui/component/prompt/index.tsx` | 读取共享实时统计，分页外 user 不再成为统计门禁 |
| `src/cli/cmd/tui/routes/session/subagent-footer.tsx` | 子 Session 消费同一统计 owner |
| `src/cli/cmd/tui/feature-plugins/sidebar/context.tsx` | 内部插件复用 Sync，不扩大公开插件 API |
| `src/server/routes/instance/httpapi/{groups,handlers}/tui.ts` | `/tui/accounting` Schema、同 Session 读取及既有错误/作用域中间件 |
| `src/session/request-usage.ts` | SQL 数字聚合与窄错误列，保留两次记录、幂等、状态和微美元语义 |
| `test/cli/cmd/tui/sync-accounting.test.tsx`、`sync-fixture.tsx` | 真实 Sync 的流式统计、分页替换、释放重入及 fixture transport |
| `test/server/tui-accounting.test.ts` | 真实 HTTP 页外统计、浮点顺序与跨 Session ID 隔离 |
| `test/session/revert-compact.test.ts` | 实际记账接口的分步取整、修订覆盖、终态优先级及首个错误 |
| `packages/sdk/js/src/v2/gen/{sdk.gen.ts,types.gen.ts}` | 官方生成链输出；同时同步已有 server schema 的滞后类型，未手改 generated 文件 |

上表未以 `packages/opencode/` 开头的路径均相对于该包。SDK 的 `./v2` 是当前 1.15 原本在用的导出路径；`MessageV2` 也是现行 `session/message-v2.ts` 模型。本次没有接入 `src/v2/` 的业务迁移路线。

### Red / Green 与回归

| 命令及工作目录 | 结果 |
| --- | --- |
| `bun test --conditions=browser test/cli/cmd/tui/sync-accounting.test.tsx`，`packages/opencode` | red：共享 `accounting` 入口不存在；最小实现后 green |
| `bun test test/server/tui-accounting.test.ts`，`packages/opencode` | red：新入口尚不存在，返回 HTML 而非约定 JSON；接入同源 owner 后 green |
| `bun test --timeout 30000 --conditions=browser test/cli/cmd/tui/sync-accounting.test.tsx test/cli/cmd/tui/sync-parts-lifetime.test.tsx test/cli/cmd/tui/session-message-render.test.tsx test/token/accounting.test.ts test/cli/tui/token-estimate.test.ts`，`packages/opencode` | 最终 132 pass，0 fail，955 assertions；含真实 renderer、实时变化、释放及分页 |
| `bun test --timeout 30000 test/session/message-v2.test.ts test/session/summary-tool-diff.test.ts test/session/revert-compact.test.ts test/server/tui-accounting.test.ts`，`packages/opencode` | 88 pass，0 fail，253 assertions |
| `bun test --timeout 30000 --conditions=browser test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/sync-undefined-messages.test.tsx test/cli/cmd/tui/sync-accounting.test.tsx test/cli/cmd/tui/sync-parts-lifetime.test.tsx`，`packages/opencode` | 50 pass，0 fail，161 assertions |
| `bun test --timeout 30000 test/storage/cold.test.ts -t "summary\|summarize"`，`packages/opencode` | 6 pass，0 fail；验证既有摘要持久化边界，非扩展冷存储调查 |
| `bun typecheck`，`packages/opencode` | pass |
| `bun typecheck`，`packages/sdk/js` | pass |
| `bun ./packages/sdk/js/script/build.ts`，仓库根 | pass；生成与构建使用隔离应用目录及 `OPENCODE_DB=:memory:` |
| `git diff --check -- <本任务实际路径>`，仓库根 | pass |

最初 renderer 的裸 `bun test` 受默认 5 秒限制，在连续 100 次展开/折叠时超时并污染后续 frame；改用包原有的 30 秒测试预算后整组 130 项通过，没有更改测试断言或放宽四秒 Daemon 指标。新分页测试的重新消费遵循异步读取，等待公共统计结果，不读取私有缓存或断言调用次数。

SDK 构建最初遇到两项现有空类型目录，以及 SDK 本地 compiler junction 的既有断链。用户分别授权依赖修复和该断链的删除重建。修复只涉及仓库 `node_modules`，版本沿用现有锁文件；缓存位于 `D:\Temp\opencode`，安装脚本禁用，项目依赖声明与锁文件没有修改。没有以改 tsconfig、伪造类型或跳过构建掩盖错误。

### 原始症状与完整算法回放

`run-accounting-experiment.ts` 当前加载实际落地的三个统计阶段，以只读 `git show HEAD:.../accounting.ts` 的原函数为独立对照；数据来自临时快照服务器，不再请求使用中的 Daemon。300 条 Message、2768 Part、7 footer、28 request，共 **330 次完整字段比较全部一致**。普通更新为 **1.37-2.15ms**，初始化 111.02ms，整体替换 136.70ms。第 3.2 节的 352 次是此前另一组输入的方案实验，两组记录不混写。

最终运行 `bun D:\Temp\opencode\run-real-route-perf.ts`（`packages/opencode`）。候选直接加载实际源码，无候选模块替换；对照只在临时进程加载原 HEAD 摘要。页外读取走正式 `/tui/accounting`，不再用手写实验 handler 代替。

| 并发 diff | 原 HEAD 最长 wall | 实际落地最长 wall | 实际落地四秒 timeout |
| --- | ---: | ---: | ---: |
| 1 | 1994ms | 639ms | 0 |
| 2 | 2223ms | 792ms | 0 |
| 4 | 4398ms | 1398ms | 0 |
| 8 | 11423ms | **2446ms** | **0** |

所有 diff HTTP 200、100 viewer rows，跨模式/并发内容一致；正式页外接口返回本页 28 个 request、2213 字节。脚本在候选 wall >4000ms 或发生 timeout 时直接失败。最后一个重业务请求约 5702ms 不等于连续未响应，健康请求期间持续成功。

### 路径、注释与隔离

新替代成功路径 0。原 Message.tokens 兼容分支保留在同一算法；初次同步的页外 HTTP 错误继续抛出。已有 owner 内的异步事实刷新记录读取失败诊断，不合成零值、切换数据源或报告请求成功；该日志路径在实际 decision surface 中低于 10%。删除了原全 Session Part 读取后过滤及四处全窗口重复 accounting，没有业务状态机、TTL、轮询或 worker 改造。

第 2 轮独立审计的语义计数为 E=624、C=100；B-03 返工删去 user 查找的三行代码及一条注释，新增现有公共接口回归 E=11/C=2，当前为 **E=632，C=101，C/E=15.98%，最低 C=95**。自动按同文本去重的早期估算不作为放行依据。排除空行、import-only、generated、formatter-only 和确认属于 pure-move 的代码，所有新增测试纳入分母。`implementation-comment-metrics.ts` 记录独立基数与确切增量，完整 diff 固定相对任务开始的 `9f52803e68`，不受其他暂存或提交影响；最终仍接受独立审计的语义核对。

真实路由只使用 `D:\Temp\opencode\daemon-perf-snapshot-20261105.db`；测试使用 preload 隔离的内存数据库。只读检查真实数据库 `sqlite_master` 确认本次 `message_session_parent_time_id_idx` **不存在**，没有把迁移应用到真实库。临时快照中过去实验创建的同名索引在正式迁移前移除，随后由实际迁移创建，未改生产 migration 为容错分支。

部署边界是尚未替换用户正在使用的二进制、未在真实 Daemon 上运行新迁移；这符合不影响全局配置和数据库的约束。源码实现与既定隔离负载已验证，Windows Unix PTY 场景限制按第 17 节保留；当前独立实现审计已批准。

## 16. 独立实现审计：第 1 轮 / R4

Invocation: `ses_e551cdb45ffeEutEDtti1oaulZ`。以下原样记录本轮 finding、分类和 verdict；当前按批准路线返工，不新增生产机制或切换数据源。

### Blocking findings

#### B-01 SSE 窗口淘汰会使在途页外累计读取失效，却不补齐基线

- **Violated invariant:** INV-04、INV-05：request 累计不受窗口截断影响；分页交接后不得残留缺失或重复贡献。
- **Evidence class:** reachable
- **Producer and execution path:** 正常 `message.updated` 经 SSE 进入 Sync；当 `/tui/accounting` 正在读取页外基线时，新 Message 使已有 300 条窗口淘汰首个 Assistant。
- **Source evidence:** `packages/opencode/src/cli/cmd/tui/context/sync.tsx:227-246`：读取开始时保存 `revision`；响应返回后先检查代际，不匹配便直接返回。
- **Source evidence:** 同文件 `1192-1207`：淘汰 Assistant 时，只将该 Message 的贡献加入当前 `prefix`，随后执行 `entry.revision++`。
- **Source evidence:** 同文件 `1605-1610、1655`：初次同步可以在该读取被丢弃后继续完成，并标记 `fullSyncedSessions`，没有补发当前窗口的完整基线读取。
- **Source evidence:** `packages/opencode/test/cli/cmd/tui/sync-accounting.test.tsx:53-95`：当前分页测试立即返回基线，未覆盖“读取挂起期间发生 SSE 淘汰”的交错。
- **Canonical-plan evidence:** §5.3、§6、§9.3，以及 INV-04、INV-05。
- **Responsibility owner:** SyncProvider 的窗口与页外基线交接。
- **Concrete behavioral consequence:** 首次基线尚为 `{}` 时发生淘汰，会留下“仅含本次淘汰 Message”的基线；服务端随后成功返回的既有页外累计因代际变化被丢弃。后续可见正文、usage 更新不会重新请求该基线，因此历史 input/output/cost 会持续少计，直到另一次强制同步或重新进入 Session。这正好影响方案要修复的长 request。
- **Minimal correction direction:** 将窗口交接收敛到现有 Session 级基线刷新路径，确保淘汰使在途读取失效后仍取得当前窗口的完整基线，并以延迟 HTTP 响应叠加 SSE 淘汰的公共 Sync 回归验证。

#### B-02 新增 HTTP 路由未注册必过的 HttpApi exerciser 场景

- **Violated invariant:** 新增公开路由必须通过仓库既有的路由覆盖、鉴权和 Effect 必过检查。
- **Evidence class:** reachable
- **Producer and execution path:** 新增 `POST /tui/accounting` 进入 `TuiApi → OpenCodeHttpApi → PublicApi`；CI 从该 OpenAPI 枚举路由，再与独立维护的 `scenarios` 清单比较。
- **Source evidence:** `packages/opencode/src/server/routes/instance/httpapi/groups/tui.ts:235-244`：新增公开端点。
- **Source evidence:** `packages/opencode/src/server/routes/instance/httpapi/api.ts:50`、`public.ts:522-529`：端点进入正式 PublicApi。
- **Source evidence:** `packages/opencode/test/server/httpapi-exercise/index.ts:46-1548`：场景清单没有 `/tui/accounting`；新增的 `tui-accounting.test.ts` 不会注册到此清单。
- **Source evidence:** 同文件 `1562-1565、1596-1597`：未注册路由进入 `missing`，启用 `--fail-on-missing` 时失败。
- **Source evidence:** `.github/workflows/test.yml:285-298、320-323`：coverage、auth、effect 三个必过 job 都启用该参数。
- **Canonical-plan evidence:** §8 的 HTTP/SDK 修改及 §9、§13 的仓库验证要求；§15 当前验证记录未包含这项必过检查。
- **Responsibility owner:** 新增端点对应的既有 HttpApi exerciser 场景。
- **Concrete behavioral consequence:** 当前 diff 会新增一个确定的未覆盖路由，使三个必过 HttpApi job 均无法通过；单独的 HTTP 单测通过不能消除这个失败条件。
- **Minimal correction direction:** 在既有 exerciser 中注册该端点的正式场景，并运行仓库原有的 coverage、auth、effect 检查。

### Non-blocking findings

#### N-01 E/C 记录需要按语义去重修正

本轮逐行复核采用的计数为：

- **E = 552**
- **合格 C = 92**
- **C/E = 16.67%**
- 15% 目标对应最低 **83** 行，已满足。

计算覆盖 14 个手写 tracked 文件及两个新增测试；排除 generated SDK、生成迁移、import-only、空行、JSX pragma 和确认属于原样移动的代码。没有将任意同文本行自动视为 pure-move；重复解释同一测试意图的注释只计一次。

因此与 §15 的 `531/93` 存在记录差异，但中文解释性注释门禁通过，不构成 blocker。

### Rejected speculation

- **V2 业务迁移：** TUI 原本已从 `@opencode-ai/sdk/v2` 导入客户端；本次使用的 `session/message-v2.ts` 也是当前生产模型，没有接入 `src/v2/` 的迁移业务路径。
- **旧 fork 补账或读取父 Session：** 实现继续读取本 Session 的 Message/Part，未引入这类依赖。
- **提前增加 worker、队列或锁状态机：** 当前 diff 已在摘要摄入入口修复全历史 Part 扫描，没有证据要求扩大这些机制。
- **全局配置或业务数据库被修改：** 实际 diff 没有相应修改；检查到的测试 preload 使用隔离目录和内存数据库，性能脚本指向临时快照。本轮未操作运行中的 Daemon 或业务数据库。

### Requirement and traceability coverage

已覆盖全部实际 tracked diff、两个新增测试，以及迁移 SQL 和 snapshot，并核对其直接生产、消费和验证路径。

| 范围 | 审计结果 |
| --- | --- |
| 摘要 Part 精确摄入、空增量、tuple cursor | 修复位于原 owner，保留原过滤、顺序、事务和 CAS |
| parent 查询及索引迁移 | 查询拆分保留 target/children 语义；snapshot 相对上一版仅增加预期索引及迁移元数据 |
| accounting 分解及四处持续消费者 | 共享计算链已接入，原一次性入口继续组合同一算法 |
| 分页累计和生命周期 | **B-01 阻断**：正常 HTTP/SSE 交错可丢失完整基线 |
| RequestUsage SQL 聚合 | 保留微美元、幂等覆盖、状态优先级及首个有效错误选择 |
| HTTP、SDK 和必过验证 | 正式接口与生成客户端已接入；**B-02 阻断** |
| 四秒 wall | 实际源码实验脚本具备阈值失败判断；§15 记录的结果本轮未独立重跑 |

本轮实际执行的 `git diff --check` 通过。Bun 测试、typecheck 和性能回放因非 Git 命令授权尚未获得，没有独立重跑；上述两个 blocker 均由当前可执行调用链直接证明，不依赖猜测或耗时估算。

### Primary-path and fallback verdict

摘要、纯 accounting、共享统计及 RequestUsage 均保留单一语义主路径，未发现新增换源 fallback。

页外统计的权威来源仍是本 Session 的原事实；**B-01 是这条主路径的交接缺陷**，应在 Sync owner 修复，无需另建账本、备用数据源或补偿状态机。

### Code quality and Chinese-comment verdict

中文解释性注释门禁通过，独立计数为 **552 / 92 / 16.67%**。未发现新增 `any` 声明、类型抑制、测试断言削弱或无依据的公开插件 API 扩展。

代码质量放行仍受 **B-02 的必过检查缺口**约束；现有测试也未覆盖 B-01 的可达交错。

### Release verdict

**BLOCK — 针对 R4 的当前实际 implementation diff。**

需要处理 **B-01、B-02**，补齐相应验证后进行下一轮完整范围实现审计。当前不能记录为 `verified`。

## 17. 第 1 轮实现返工与复审材料

B-01 是本次引入的交接回归，不是原 HEAD 的缺陷。新增公共 Sync 测试实际复现出 311 个 step 被少计成 301。修正仅删除淘汰分支中的 `entry.revision++`：窗口身份变化由既有 ID 集合检查触发完整基线重取，请求代际不再同时承担窗口失效。没有增加 pending 状态、补偿队列、额外数据源或新重试分支。修正后该交错回归与其余 Sync 测试 **51 pass / 0 fail / 163 assertions**。

B-02 同样由新增接口引入。只在既有 `test/server/httpapi-exercise/index.ts` 注册一个 protected 场景，验证属于本 Session、尚未产生 Assistant 的 request 返回零累计；未修改 CI、exerciser runner、既有场景、PTY 实现或测试期望。先运行 coverage 实际得到 `missing=1`，补齐后变为 `missing=0`。

| 检查 | 实际结果 |
| --- | --- |
| 既有 exerciser `--mode coverage --fail-on-missing --fail-on-skip` | 全量 159 pass，missing/extra/skip/fail 均为 0 |
| 既有 exerciser `--mode auth --fail-on-missing --fail-on-skip` | 全量 159 pass，missing/extra/skip/fail 均为 0 |
| 既有 exerciser `--mode effect --include /tui/ --fail-on-missing --fail-on-skip` | 全部 17 个 TUI 场景 pass，含新增 `/tui/accounting`；全路由 missing=0 |
| 既有 exerciser `--mode effect --fail-on-missing --fail-on-skip --progress` | 全量完成：158 pass / 1 fail / 0 skip / missing=0；仅 `pty.create` 返回 500 |
| `bun typecheck`，`packages/opencode` | pass，包含新增场景与交错回归 |
| `git diff 9f52803e68 --check -- <全部本任务路径>` | pass |

全量 Effect 首次被 420 秒外层时限中断；随后保留 30 秒单场景预算、增加进度输出并等待全量执行完成，没有跳过失败。唯一未通过的场景使用 `httpapi-exercise/dsl.ts:204-209` 中既有的 `/bin/sh -c "sleep 30"`。只读核对 `dsl.ts` 及 PTY 实现与 HEAD 无 diff，且本机 `platform=win32`、`Bun.which('/bin/sh')=null`。对应 CI gate 明确运行在 `ubuntu-latest`；该 Unix 场景的 Windows 执行前提在本机不可用，保留为平台验证限制，不为本次性能修复改写该场景或声称全量 Effect 已全绿。

所有 exerciser 配置、数据库、项目及缓存均固定到 `D:\Temp\opencode`；隔离 wrapper `run-httpapi-r4.ts` 只向仓库原命令提供隔离环境和既有参数，不改断言。其每次执行使用独立 PID 路径，避免复用未完成运行的配置或数据库。该返工没有修改后端统计、摘要查询或三阶段公式，继续沿用第 15 节的真实路由 2446ms 与完整字段 330 次等价结果。

当前状态为完整范围实现复审；第 1 轮 BLOCK 记录保留，不将已修复的 finding 自行改判为 APPROVE。

## 18. 独立实现审计：第 2 轮 / R4

Invocation: `ses_e551cdb45ffeEutEDtti1oaulZ`。以下保留本轮原始分类与 verdict。

### Blocking findings

#### B-03 新 request 的 user 滑出窗口后，默认统计会丢失已累计用量

- **Violated invariant:** INV-03、INV-04：实时统计持续更新，request 累计不受窗口截断影响。
- **Evidence class:** reachable
- **Producer and execution path:** TUI 已完成同步并建立共享 owner 后，用户在同一 Session 发起新 request；该 request 持续生成 Assistant，最终使自己的 user Message 滑出 300 条窗口。
- **Source evidence:** `packages/opencode/src/session/prompt.ts:2922-2954`：正常循环允许长 request，每轮 Assistant 使用同一个 `lastUser.id`。
- **Source evidence:** `packages/opencode/src/cli/cmd/tui/context/sync.tsx:220-257、1167-1169`：既有 owner 不会因新 request 出现而获取该 request 的基线；user 仍在窗口时，其更新也不触发页外刷新。
- **Source evidence:** 同文件 `1192-1206`：窗口淘汰只为 Assistant 转交贡献；淘汰 user 时不会建立当前 request 的基线键。
- **Source evidence:** `packages/opencode/src/token/accounting.ts:196-245、256-264`：虽然 `requests` 已累计可见 Assistant，默认 `activeRequest` 仍要求窗口中存在 user，或 `prefix[parentID]` 存在；两者都没有时，投影选用空累计。
- **Source evidence:** `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/context.tsx:49-59`：侧栏使用这个默认投影，直接展示受影响的累计及费用。
- **Canonical-plan evidence:** §5、§6、§9.3，以及 INV-03、INV-04。
- **Responsibility owner:** accounting 的活跃 request 选择及 Sync 的窗口交接。
- **Concrete behavioral consequence:** 对同步后才开始的新 request，当窗口变为“299 个已完成 Assistant＋第 300 个正在运行的 Assistant”时，user 刚好被淘汰，而当前 request 尚无 prefix 键。此时默认统计的 `totalInputPure`、历史累计输出和费用会丢失；例如已有 299 个各消耗 1 input token 的完成步骤，默认 `totalInputPure` 会从 299 变成 0。之后的页外 user 更新或下一次 Assistant 淘汰可能恢复它，但当前流式阶段已经显示错误累计。现有新增交错测试在 `sync-accounting.test.tsx:154-155` 显式传入 parentID，因此没有覆盖默认入口。
- **Minimal correction direction:** 在现有 accounting 抽象内将活跃 request 身份与页外数值缓存键解耦，保证 user 滑出窗口不会使已知 request 失选，不再增加消费端补算或补偿状态。

**来源判断：** 这是 R4 已承诺修复的 HEAD 分页截断问题尚未完整覆盖，不是本轮删除 `revision++` 引入的新回归，也不涉及扩大到其他功能。

### Non-blocking findings

#### N-02 全量 Effect 的 Windows PTY 限制保持单独记录

`test/server/httpapi-exercise/dsl.ts:204-209` 使用固定的 `/bin/sh -c "sleep 30"`；该文件及 PTY 实现相对 `9f52803e68` 均无 diff，CI 对应 job 运行于 Ubuntu。

§17 保留了 Windows 上 `pty.create` 的失败，没有将全量 Effect 写成全绿。这项平台验证限制不要求本次性能修复修改 PTY 或放宽既有场景。

### Rejected speculation

- 不要求为旧 fork 补账、查询父 Session 或增加另一份统计数据源。
- 不要求为了上述窗口问题增加状态机、轮询、补偿队列或 worker。
- 不把未修改的 Unix PTY 场景扩展成本次生产修复任务。

### Requirement and traceability coverage

本轮按 `9f52803e68` 核对完整实际 diff，覆盖全部生产区域、消费者、SDK、迁移和新增测试；未将复审范围缩到上一轮两个 finding。

| 范围 | 结论 |
| --- | --- |
| 摘要精确摄入、cursor、parent 查询及索引 | 保持原 owner、过滤、chronology、事务与 CAS |
| 三阶段 accounting 与四处持续消费者 | 单一计算链及共享 owner 保留 |
| 页外累计及生命周期 | **B-03 阻断默认活跃 request 的窗口边界** |
| RequestUsage SQL 聚合 | 金额、幂等、状态和错误选择路径保持 |
| 上轮 B-01 | 已修复：删除多余代际递增后，在途响应能进入既有窗口身份检查并重取完整基线 |
| 上轮 B-02 | 已修复：正式 protected 场景已注册到原 exerciser |
| 性能与隔离 | 性能脚本固定原始 baseline、加载实际候选源码，配置和数据库指向临时环境 |

上轮两个问题都由首次实现引入：B-01 修正只删除一行多余逻辑，B-02 只补既有必过场景注册；对应测试没有扩大生产功能范围。

本轮实际执行的完整 `git diff --check` 通过。Bun 测试、typecheck 和性能回放未独立重跑；§15、§17 的执行结果仍按记录标明，不冒充本轮复测。

### Primary-path and fallback verdict

主路径结构通过：摘要、共享统计、页外事实投影和 RequestUsage 均保留原责任边界，没有新增替代成功路径。

B-03 暴露的是同一抽象内的身份耦合：**页外缓存是否有键，被同时用来决定当前 request 是否存在。** 修正应收敛在这个选择边界。

### Code quality and Chinese-comment verdict

独立核对当前完整 diff 后：

- **E = 624**
- **合格 C = 100**
- **C/E = 16.03%**
- 15% 目标要求最低 **94** 行，已满足。

计数包含两个新增测试及 exerciser 注册，排除 generated、import-only、空行、格式化、JSX pragma 和确认的 pure-move。未发现新增类型抑制、测试断言削弱或无依据的公开插件 API 扩展。

### Release verdict

**BLOCK — R4，基于 `9f52803e68` 的当前完整 implementation diff。**

上轮 **B-01、B-02 已解决**；当前保留 **B-03**。这是第 2 轮完整范围实现审计，当前不能记录为 `verified`。

## 19. B-03 返工与最终验证

先在既有 `test/token/accounting.test.ts` 增加一个公共 `tokenAccounting()` 回归：300 条 Assistant 中，299 条各有已确认的 1 input / 2 output / $1 cost，末条仍在流式；user 已不在页内，不提供显式 request 参数或页外缓存。修改前默认入口实际返回 0/0/$0，预期字面量为 299/598/$299。

修正收敛在 `summarizeAccounting()`：有 Assistant 时直接使用最新 Assistant 由 prompt 生产者确定的 parentID；尚无 Assistant 时才选择当前最后一个 user。删除从窗口再次寻找 user 的变量，以及把 prefix 键存在性当作身份条件的表达式。没有增加 Sync 状态、网络请求、消费端补算或新 fallback，也不改变 token/cost 的归约公式。

最终同组统计、Sync 生命周期与真实 renderer 测试 **132 pass / 0 fail / 955 assertions**，`packages/opencode` 的 `bun typecheck` 通过。再次运行隔离的原公式回放，固定原始 `9f52803e68` 作对照，**330 次完整字段比较全部一致**；普通更新 1.20-3.98ms，初始化 83.34ms、快照替换 149.60ms。已知有意修复的默认分页缺陷由上述独立字面量回归另行锁定，不把错误的旧零值作为应保留结果。

该返工只改变活跃 request 的选择，不触及真实路由负载中的后端摘要或页外查询，因此第 15 节的四秒 wall 记录、SDK 构建、coverage/auth 全量结果及第 17 节的 Effect 验证继续适用。Windows Unix PTY 场景限制原样保留。第 3 轮完整范围实现审计已批准，原始 verdict 如下。

## 20. 独立实现审计：第 3 轮 / R4

Invocation: `ses_e551cdb45ffeEutEDtti1oaulZ`。以下原样记录本轮分类与最终 verdict；该记录只更新审计与状态，不夹带设计或代码修改。

### Blocking findings

No blocking findings.

### Non-blocking findings

#### N-02 Windows 上的 Unix PTY 场景限制保留

全量 Effect 的 `pty.create` 失败仍按 §17 单独记录。其固定 `/bin/sh` 场景及 PTY 实现相对 baseline 未修改，对应 CI 运行于 Ubuntu。本轮不要求修改该既有平台前提，也不将全量 Effect 描述为全绿。

### Rejected speculation

旧 fork 补账、父 Session 依赖、额外状态机或 worker、无当前 producer 的异常输入，以及无限并发下的绝对时限，均不构成本轮阻断依据。

### Requirement and traceability coverage

本轮覆盖相对 **`9f52803e68` 的全部 22 个修改及新增路径**，核对完整 diff、直接调用链、消费者、迁移、SDK 和相关测试；复用了版本未变的已读证据，没有缩小到最后一次修正。

| 范围 | 结论 |
| --- | --- |
| 摘要 Part 精确摄入、cursor、parent 查询及索引 | 在原 owner 修复摄入范围，保留过滤、顺序、事务与 CAS |
| 三阶段 accounting 及四处持续消费者 | 共享同一计算链，实时估算与统计口径保留 |
| 分页累计、异步交接及释放 | B-01、B-03 均已解决 |
| RequestUsage 聚合 | 保留幂等覆盖、微美元、状态优先级及错误选择 |
| HTTP、SDK 与必过场景 | B-02 已解决，正式 protected 场景注册保留 |
| 性能及数据隔离 | 实验使用固定 baseline、实际候选源码和临时快照；没有以超时放宽或少算数据达标 |

三个历史 blocker 的关闭依据：

- **B-01：** `sync.tsx:227-246、1192-1206` 保留窗口身份检查，淘汰不再提前作废请求代际；新增 Sync 测试覆盖读取挂起期间的 SSE 淘汰。
- **B-02：** `httpapi-exercise/index.ts:1524-1542` 已注册 `/tui/accounting` 的既有 protected 场景。
- **B-03：** `token/accounting.ts:196-241` 直接以最新 Assistant 的既定 parentID 确定活跃 request，删除对 user 分页可见性和 prefix 键的身份依赖。`test/token/accounting.test.ts:32-43` 通过默认公共入口，以独立字面量锁定 **299 / 598 / $299**，没有用显式 parent 参数绕过缺陷。

**验证边界：** 本轮实际执行的完整 `git diff --check` 通过。Bun 命令未独立复跑；§15、§17、§19 记录了最终同组 **132 pass / 0 fail**、包内 typecheck、**330 次完整字段等价比较**，以及已测真实路由最长 wall **2446ms**。本轮核对了相应源码、测试、实验脚本及结果适用范围，未将这些记录冒充本轮复测。

### Primary-path and fallback verdict

**通过。**

摘要、accounting、页外投影和 RequestUsage 各自保留单一权威路径。最新修正删除了身份选择中的冗余依赖，未增加 Sync 状态、网络请求、消费端补算或 fallback。

新替代成功路径为 **0**；已有异步刷新错误只记录诊断，不切换来源或合成零值成功。

### Code quality and Chinese-comment verdict

**通过。** 独立核对当前完整手写 diff：

- **E = 632**
- **合格 C = 101**
- **C/E = 15.98%**
- 15% 目标最低要求 **95** 行，已满足。

计数包含所有新增测试，排除 generated、import-only、空行、格式化、JSX pragma 和确认的 pure-move。未发现新增类型抑制、测试断言削弱、无依据的接口扩展或遗留替代算法。

### Release verdict

**APPROVE — 仅适用于 R4、baseline `9f52803e68`，以及本轮核对的 `r4-implementation-audit3.diff` 对应实际实现。**

这是第 **3 轮 full-scope implementation audit**。B-01、B-02、B-03 均已关闭；Windows Unix PTY 验证限制、尚未部署及尚未对真实数据库执行迁移的边界继续保留。
