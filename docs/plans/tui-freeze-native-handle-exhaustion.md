# TUI 超长会话卡死：native handle 注册表耗尽 + 渲染生命周期 根因调查

> Status: verified
> Approved revision: 3
> Revision: 3（新增 §9 R2 根因与修复方案）
> 审计：方案审计 APPROVE（No blocking findings）；实现审计 APPROVE（No blocking findings，adversarial-auditor 独立复跑全套件+原始反馈环核实）；非阻塞记录修正已采纳（构建无关表述、唯一性收窄、preview 调用点计数、净增长口径）
>
> 最后更新：2026-09-11
>
> 触发会话：`ses_041cd5549ffeSiDWyPpcy8Xrsl`（19096 消息 / 80881 parts / 120MB / 2845 次编辑 / 数百 subagent 子会话）

本文档完整记录一次 TUI 卡死的**现象、日志路线、根因传导链条、复现实验证据与优化方向**。全部结论有实测证据支撑。

---

## 1. 现象与问题

### 1.1 用户观察到的卡死症状

某个**超长上下文会话**的 TUI，运行一段时间后进入卡死状态：

- 从某个消息节点开始，**之后的所有工具（Bash/Edit 等）渲染为空卡片**，只有偶尔的纯白色正文能显示
- 整体消息不再更新，TUI 一直"转圈"（spinner 图标）
- 按 Ctrl-C 无响应，**TUI 与 daemon 失去联系**
- 但**页面能翻动（滚动正常）**，**窗口大小变化时消息区不跟随（resize 失效）**
- 只能关掉终端重开
- **连接同一个 daemon 的其他 TUI 都正常**，只有这一个卡死

### 1.2 进程级取证（卡死 TUI = PID 5068）

| 维度 | 卡死 TUI | 健康 TUI 对比 |
|---|---|---|
| 主线程 (22244，创建最早) | **Running 状态，累计 5841s CPU，提交栈 415KB**，RIP 在 bun.exe 内执行 JIT 代码，栈上同一批 JIT 函数地址重复几十次（深度递归/热循环特征） | — |
| 其余 27 个线程（含 tree-sitter worker 池） | 全部 idle（Wait） | — |
| 网络连接 | **0 条，30 秒内零重连尝试**（SSE 彻底死亡且不再重连） | 各持 2-3 条到 daemon:4096 |
| 内存 RSS | **2086MB**（健康 TUI 的 ~2 倍），稳定不再增长 | 878MB–1.3GB |
| daemon (2140) | **完全健康**（health 200，仍在写该会话 DB） | — |
| 二进制 | 含 .11 修复（`ownedSyntaxStyles` 标记在） | — |

**症状矛盾的解答**：滚动正常 + spinner 在转 + 内容冻结 + resize 失效 + SSE 死亡——因为 Windows 默认 **threaded renderer（`useThread=true`）**：native 渲染线程持续把最后一帧重绘（所以滚动/ spinner 还在），但 **JS 主线程被同步计算彻底卡死**（所以 SSE、新内容、resize、输入全死）。

---

## 2. 日志路线（一个重要副发现）

### 2.1 "TUI 写不出日志" 是误读

排查初期我以为 TUI/daemon 的日志文件是 0 字节（`Get-ChildItem` 显示 size=0）。**这是误读**：

- 进程持有日志文件句柄做**异步缓冲写入**时，Windows 目录列表显示的 size **滞后不更新**
- 用共享读模式（`FileShare.ReadWrite`）直接读文件内容，**所有进程的日志都在正常写入**

实测当前日志真实内容：

| 进程 | 真实内容 |
|---|---|
| 卡死 TUI (040705.log) | **4677 字节**（含错误信号）|
| 健康 TUI (040812.log) | 1833 字节 |
| 健康 TUI (040630.log) | 1380 字节 |

### 2.2 日志服务实际可用且暴露了卡死信号

`packages/core/src/util/log.ts` 的 Log 服务（DEBUG/INFO/WARN/ERROR 四级，写 `~/.local/share/opencode/log/`，保留最近 10 个）本身工作正常。**正是卡死 TUI 的日志暴露了根因信号**（见第 3 节）。

### 2.3 日志体系真实但次要的缺口（供后续单独小做）

1. **极快退出丢缓冲日志**：`process.exit()` 太快时异步缓冲的最后几条写会丢（编译二进制复现确认：立即 exit → 0 字节）
2. **ErrorBoundary 捕获渲染崩溃但只显示不落盘**（`component/error-component.tsx`）
3. **SSE 断连/重连无日志**（`context/sdk.tsx:162` 有意静默）
4. **Log payload 无大小上限**（`build()` 对 object 直接 `JSON.stringify`，误传大对象会撑爆日志）

> 这些是 diagnosability 增强，不是本次卡死的根因，不进本次修复范围。

---

## 3. 卡死的完整根因传导链条

### 3.1 日志暴露的两个 native 资源错误（卡死 TUI 独有）

| 时间（本地） | 错误 | 含义 |
|---|---|---|
| 13:00 | `Failed to create TextBuffer`（`zig.ts:3772`）| **native handle 注册表耗尽**（最早错误）|
| 13:07 起 ×17 | `NativeSyntaxStyle is destroyed`（`syntax-style.ts:117`）| **共享 SyntaxStyle 被销毁后仍被引用（use-after-destroy）** |

这两个错误**只在卡死 TUI 出现**（健康 TUI 全 0 错误）。

### 3.2 根因链（每一环都有实测证据）

**① 巨型补丁重放会话**：19096 消息 / 80881 parts（120MB）/ **2845 次编辑** / 数百 subagent 子会话 → TUI 持续高强度流式渲染、消息窗口快速滑动。

**② reconciler 把销毁 defer 到 process.nextTick**：Solid reconciler 的 `_removeNode`（`thirdparty/opentui/packages/solid/src/reconciler.ts:133`）把 renderable 销毁**推迟到 `process.nextTick`**，且带 `!node.parent` 条件——不是同步销毁。

**③ 持续负载下销毁追不上创建（暂时性累积）**：实测窗口滑动时——

| 滑窗次数 | treeRenderables（渲染树，有界在缩） | registry（JS 注册表） | heap | RSS |
|---|---|---|---|---|
| 0 | 5691 | 4306 | 595MB | 1490MB |
| 30 | 5356 | 4486 | 643MB | 2122MB |
| 60 | 5006 | 4666 | 705MB | 2229MB |
| 90 | 4690 | **4846** | 756MB | 2304MB |
| **settle 空闲 3s 后** | 5008 | **3896（回落 950）** | **281MB（回落 424MB）** | **893MB（回落 1336MB）** |

- 渲染树有界且正常裁剪（窗口滑动正确），但 **renderable 注册表线性 +6/次滑窗、RSS +9MB/次滑窗**
- **空闲后（settle）注册表/RSS 回落** → 证明是"deferred destroy 追不上创建"的**暂时性累积**，不是永久泄漏

**④ native handle 注册表耗尽**：注册表有**硬上限 65535**（`handles.zig:10` `MAX_SLOTS = INDEX_MASK`，`INDEX_BITS=16`）。实测——

- **每个 TextBufferRenderable 占 4 个 handle**（native_renderable + text_buffer + syntax_style + text_buffer_view）
- **复现确认：创建 16383 个存活 Code renderable 时注册表耗尽**，报 `Failed to create SyntaxStyle`（65535 / 16383 ≈ 4.0）
- 持续累积超上限 → `handles.insert` 返回 `OutOfHandles`（`handles.zig:146`）→ `createTextBuffer` 返回 `INVALID_HANDLE`（`lib.zig:1470`）→ 抛 `Failed to create TextBuffer`

**⑤ use-after-destroy**：共享 SyntaxStyle 在 renderable 异步高亮（等 tree-sitter worker 返回）在途时被销毁 → worker 返回后仍引用已销毁样式。已复现确认调用栈：`guard → getStyle → treeSitterToTextChunks → Code.startOneShotHighlight`（`Code.ts:668`）。**这正是"工具渲染空卡片、纯文本正常"症状的机制**——Code/Diff 需要 SyntaxStyle 高亮，销毁后渲染失败；纯文本不需要高亮，所以还能显示。

**⑥ 渲染崩溃 → 主线程阻塞 → 卡死**：native 耗尽后新 renderable 创建不了，渲染失败；累积的资源压力让渲染越来越慢（滑窗测试 320s 超时）；最终主线程阻塞（minidump 取证：主线程 Running、415KB 栈、JIT 代码自旋、SSE 0 连接）→ 卡死。

### 3.3 与 .11 修复的关系

**.11 修的是 Diff 退休时的 owned-style 泄漏**（`Diff.ts` 的 `destroySelf` + `ownedSyntaxStyles`）。这次卡死的根因是 **reconciler 的 nextTick 延迟销毁在持续负载下追不上创建 → native handle 注册表（65535）耗尽 + 共享样式 use-after-destroy**——是 **.11 完全没覆盖的、更底层的渲染生命周期路径**。这解释了为什么装了 .11 仍卡死。

### 3.4 第二轮实测修正（重要）

用户质疑：一条消息 5 秒产出一次，销毁再慢也该追得上，不该耗尽；且闪屏有时不是全屏。重新实测后修正如下：

**1. 单个 renderable 的销毁是干净的（排除销毁侧泄漏）**：对 code/diff/markdown/text/table/box 各做 300 次 [创建→render→destroyRecursively→settle]，settle 后 JS registry 归 1、native 容量仍 =16382（全新对照），**零泄漏**。复现脚本：`.temp/Testing/bench-destroy-leak.ts`。

**2. 流式单条 markdown 0 churn**：223 个 delta 只建 3 个 renderable（每块一个），尾部块完全原地更新，registry 稳定。复现：`.temp/Testing/bench-streaming-churn.ts`。**这证实正常流式不该让 renderable 疯涨。**

**3. 滑窗 registry 的“增长”几乎全是“列表变复杂”，不是泄漏**：容量测试里 settle 后 registry 每 20 窗净增 ~+17 renderable，与“模板消息(10 part≈29 renderable)替换原消息(平均4 part≈12 renderable)”的复杂度差 (29-12=17) **完全吻合**。所以 **JS renderable 没有显著的永久泄漏**。

**4. 决定性 A/B 实测（钉死根因）**：隔离实验 `.temp/Testing/repro-reconciler-leak.tsx` 用 `<Show>` 反复挂载/卸载一个复杂子树（走真实 reconciler 销毁路径）：

| 阶段 | registry | 积压 |
|---|---|---|
| baseline | 10 | 0 |
| **A：紧凑循环（仅 renderOnce，不让出事件循环）× 400** | **3210** | **+3200（每轮净 +8，无上限）** |
| A 后 settle（空闲） | 10 | 完全排干 |
| **B：同样操作但每轮 setTimeout 让出事件循环 × 400** | **10** | **0** |

这证明：**reconciler 把销毁 defer 到 `process.nextTick`（`reconciler.ts:133`），当主线程被连续同步渲染/协调占满（不 yield 事件循环）时，这些 nextTick 回调被饿死，待销毁 renderable 积压无上限增长；一旦让出事件循环立即排干。** native 容量压测后仍 ≈16382（全新），**无 native-only 泄漏、无 reconciler 永久泄漏**——纯粹是“饿死导致积压”。

**5. 修正之前的“超线性 churn”误判**：churn 栈实验（`.temp/Testing/zz-churn-source.test.tsx`）显示**每次滑窗同步仅新建 ~30 个 renderable（正好一条新消息的 markdown body + box/text 包装），是正确增量的**。容量测试里 maxNum 每窗 184→378 的增长发生在 **settle 的异步阶段**（不是同步滑窗），不是“滑窗全局重渲”。所以消息列表渲染**确实是增量的**，问题不在创建量，在销毁时差。

**6. 冻结日志时间线**：首次 `Failed to create TextBuffer` 在启动 **~8 小时后**（`2026-09-09T21:35` 启动 → `2026-09-10T05:44` 首错），1.4h 后 `NativeSyntaxStyle is destroyed` ×3。慢起始 = 需要“连续无空闲的自主操作”让积压单调累积，与交互式使用（有停顿即排干）区别开。

**根因定位到行**：`thirdparty/opentui/packages/solid/src/reconciler.ts:133-138` `_removeNode` 把 `destroyRecursively()` 无界 defer 到 `process.nextTick`。主线程紧凑渲染时 nextTick 被饿死 → 待销毁 renderable（每个 ~4 native handle）积压 → 填满共享注册表（`handles.zig` `MAX_SLOTS=65535`）→ `Failed to create TextBuffer` → 渲染崩溃 → 主线程自旋 → 卡死。

### 3.5 生产侧根因（用户追问“为何生产过快、且与消息数正相关”的答案）

用户坚持问生产侧。逐项实测（真实 300 条会话 + 插桩 tokenAccounting 调用计数）：

**1. renderable 的“生成数量”其实不快**（`.temp/Testing/zz-production-rate.test.tsx`、真实路由插桩）：
| 操作 | 新建 renderable |
|---|---|
| 流式 text delta（进行中消息，走 `streaming=true` 原地更新） | **0.2 个/delta** |
| tool 生命周期（pending→running→completed，62 事件） | **0 个** |
| 滑入一条新复杂消息 | **~24-30 个（仅此一条）** |

所以“renderable 生成过快”在**数量**上不成立。

**2. 真正随消息总数超线性膨胀的是“每个事件的计算成本”——`tokenAccounting`**（`.temp/Testing/zz-emit-timing.test.tsx` 插桩实测）：

| 消息总数 | emit(store更新) | render | **tokenAccounting（30 个 delta 累计）** |
|---|---|---|---|
| 50 | 0.01ms | 1.15ms | 0 次 / 0ms |
| 150 | 1.33ms | 3.43ms | 5 次 / 32ms |
| 300 | 19.2ms | 6.2ms | **34 次 / 456.9ms ≈ 15ms/delta** |

- **位置**：`session/index.tsx:236` `sessionUsage = createMemo(() => tokenAccounting(messages(), (id) => sync.data.part[id] ?? []))`，被 `:486` 的 `createEffect`（exit message 快照）读取——**每个 part delta 都触发它重算**；另有 `:1842` 每条 assistant footer 的 `turnUsage`。
- **为何 O(总数)**：`tokenAccounting`（`accounting.ts:176-186,223-225`）对每个 part 做 `parts.slice(0,i).findLastIndex()`（**O(parts²)**）+ tool part `JSON.stringify(input)`，最后 `learnInputCharsPerToken` 再 map 全部消息。任何 part 变化都让它读全表重算。
- **后果**：会话越大、每条 delta 的 tokenAccounting 越贵（150→300 超线性：32ms→457ms）。补丁重放这类连续自主操作里事件密集，这个 O(总数) 计算把主线程占满 → nextTick 销毁被饿死 → 积压 → 耗尽。

**结论：用户“生产速度与总消息数正相关”的直觉完全正确——但“过快的生产”不是 renderable 的生成数量，而是 `tokenAccounting` 的 O(总数) 计算成本随消息数膨胀，挤占了销毁所需的主线程空隙。**

### 3.6 tokenAccounting 消费者、兼容性边界与冗余清单

**消费者与实时性需求**（决定能怎么改）：

| 消费者 | 位置 | 读取时机 | 需要实时吗 |
|---|---|---|---|
| `sessionUsage` → exit message | `session/index.tsx:236` 定义、`:486` createEffect 读取 | **仅退出时**（`context/exit.tsx` 的 `exit()` 里 `store.get()` → `stdout.write`） | **不需要** |
| `turnUsage` → footer | `:1842` 定义、`:1964` 显示 | 每条 assistant footer 实时显示 | 需要（但只需当前 request） |

`exit.message` 是个纯 store（`set` 存变量，唯一读取点在 `exit()` 函数），**退出那一刻才被消费**。

**兼容性结论（回答“会不会计数出错/异常退出问题”）**：
- exit 快照改为**退出时惰计算**：用退出那一刻的最终 store 状态算一次，结果与现在**完全一致**（甚至更准）。
- **异常退出（崩溃/强杀）**：现有写法同样打不出来（`exit()` 根本没机会跑），所以惰计算**不引入任何回归**；正常退出（SIGINT/SIGTERM）走 `exit()`，惰计算照常给出正确计数。
- 唯一代价：退出时多花 ~15ms（300 条会话），换运行期每分钟省掉成百上千次 O(总数) 重算。

**冗余清单**（用户原则“需要时才遍历、需要记录时才记录”）：

| 冗余点 | 位置 | 问题 | 修法 |
|---|---|---|---|
| exit 快照随 delta 重算 | `:486` createEffect | 退出才用的值，却每个 delta O(总数) 全量遍历 | **退出时惰计算**（主凶，治本） |
| turnUsage 全表遍历 | `:1842` | 只求当前 request，却 `for (msg of messages)` 遍历全部（`accounting.ts:144`） | 按 parentID 只算当前 request |
| O(parts²) 内层循环 | `accounting.ts:176-186` | 每个 step-finish `parts.slice(0,i).findLastIndex()` 回扫 | 一次正向遍历即可 O(parts) |
| 每次调用 map 全表 | `accounting.ts:223-225` | `learnInputCharsPerToken` 每次 `messages.map(...)` 全部 | 可增量缓存 ratio |

**串起来的因果**：`sessionUsage` createEffect 是主凶——每个 delta 跑 tokenAccounting（300 条时 ~15ms），占满主线程 → `reconciler.ts:133` 的 nextTick 销毁饿死 → 积压涨满 65535 → 卡死。修复 sessionUsage 冗余重算既消除生产侧主线程占用，又间接解除销毁被饿死的根源。

---

## 4. 渲染行为分析（纠正"全量重渲染"怀疑）

**用户怀疑**：滑窗（300 条截断、顶掉最旧）时是否全量重渲染整个消息列表？

**实测结论：不是，消息列表是增量更新的。**

| 测量 | 结果 | 含义 |
|---|---|---|
| ScrollBox 子树 renderable **身份保留率** | **99.7%**（slide 5→6，5594/5610 个是同一个对象）| `<For>` 正确做了"移除顶部 + 底部新增 + 中间不动" |
| renderOnce（native 渲染） | **30ms，稳定不降级** | 渲染不是瓶颈 |
| **emit（store 更新）** | **1554ms/次滑窗** | **瓶颈在 store 更新层** |
| tokenAccounting | 3-5ms | 已排除 |

- 消息列表的 Solid `<For each={messages()}>`（`session/index.tsx:1353`）keyed reconciliation 工作正常
- store 更新是增量的（`sync.tsx` 用 splice/shift/reconcile 保留未变消息引用）
- **真正的瓶颈在 store 更新触发的 Solid recompute（1554ms/次滑窗），不在渲染**

> 说明：store 更新 1554ms 的确切慢计算点本次未完全钉死（已排除 tokenAccounting）。这是流畅度问题（每条消息的更新延迟），与卡死根因（handle 耗尽）是两个独立问题。

---

## 5. 优化方向（如何让 TUI 更顺畅 + 不卡死）

> 第二轮实测修正了优先级：**销毁本身干净、流式本身 0 churn**（3.4 节），所以问题不在“销毁太慢”，而在**创建太多 + 存活树太大 + 销毁时差**。用户“该减少创建而非加速销毁”的直觉是对的。

### A. 首要：减少 renderable 的创建量（治本）

用户指出“同步销毁只是卡顿搬家”，正确。真正该做的是**让滑窗/更新根本不该产生那么多 renderable**：

- **修复滑窗的超线性 churn**：滑窗理应只“顶掉一条 + 新增一条”（~40 renderable），实测却随列表膨胀到每窗新建数百个。需定位那个在滑窗时重算并重建 JSX 的 `createMemo`（churn 栈落在 `session/index.tsx` 消息/part 渲染区），让滑窗真正增量。**这是用户“全局重渲染”直觉的正确部分。**
- **减少每条消息的 renderable 数**：300 条复杂消息 ≈ 5400 renderable ≈ 21600 handle，已占 65535 的 1/3，余量太薄。每条消息 renderable 数降下来，余量就出来了。

### B. 安全网：让销毁追得上创建（治标，防耗尽）

> 不能简单全改同步销毁（会在大负载时一次阻塞）。是“有界追平”，不是“同步化”。

- 给 reconciler 的 pending destroy 队列设**上限**：积压超过阈值时在移除路径上**同步 drain 最旧一批**，保证 native handle 存活数永远远低于 65535。即使 A 做完，这层也值得留作突发负载的硬顶。

### C. use-after-destroy 竞态（修复“工具空卡片”）

- 共享 SyntaxStyle 的退休（`theme.tsx` 的 `createSyntaxStyleMemo` 里 `renderer.idle().then(destroy)`）应**等所有在途异步高亮完成**再销毁，或给引用方“样式已失效”的安全降级
- 消除 `NativeSyntaxStyle is destroyed` 洪水 → 工具卡片不再空白

### D. store 更新成本（流畅度，非卡死）

- 定位 store 更新时 Solid recompute 里那个 1554ms 的昂贵计算（tokenAccounting 已排除）

### E. 日志体系健康化（诊断增强，配套）

- 极快退出/崩溃时把缓冲日志兜底落盘；ErrorBoundary 渲染崩溃落盘；SSE 断连/重连状态日志；Log payload 截断上限

---

## 6. 复现实验清单（本文档的证据来源）

所有临时脚本在 `.temp/Testing/`（工作区保持清洁）：

| 脚本 | 验证内容 | 结果 |
|---|---|---|
| `repro-tui-log.ts` / `repro-log-compile.ts` | Log 服务在源码/编译二进制下能否落盘 | 能（stay/loop 模式 flush 正常）|
| `repro-syntax-destroy.ts` | 共享 SyntaxStyle 在异步高亮在途时销毁 → use-after-destroy | **复现成功**（`NativeSyntaxStyle is destroyed`）|
| `repro-handle-cap.ts` | native handle 注册表容量 | **16383 个存活 renderable 耗尽（每个 4 handle，上限 65535）** |
| `repro-native-leak.ts` | renderable create/destroy 是否平衡 | JS 注册表有界（无 JS 层泄漏）|
| `zz-repro-freeze.test.tsx` | 真实 300 消息会话的滑窗泄漏 + 渲染耗时 + 身份保留率 | 注册表 +6/次滑窗、RSS +9MB/次滑窗、保留率 99.7%、settle 后回落 |
| `bench-destroy-leak.ts` | 各类型 renderable 300 次创建/销毁循环后 native 容量 | **code/diff/markdown/text/table 全干净，零泄漏** |
| `bench-streaming-churn.ts` | 流式单条 markdown 的 renderable churn | **223 delta 仅建 3 个 renderable，0 churn** |
| `zz-capacity-repro.test.tsx` | 真实 300 消息连续滑窗 + settle 后 registry | settle 后净增≈复杂度差（非泄漏）；每窗 churn 超线性 184→378 |
| `zz-churn-source.test.tsx` | 滑窗时 renderable 创建（按 id 聚合） | **每次滑窗同步仅新建 ~30 个（一条新消息），是正确增量**；超线性增长发生在 settle 异步阶段 |
| `repro-reconciler-leak.tsx` | **A/B：紧凑循环 vs 让出事件循环 对 deferred-destroy 积压的影响** | **紧凑循环积压无上限（+8/轮→3210），让出即排干为 0；native 容量无损漏** |

---

## 7. 剩余待确认项

1. **store 更新 1554ms 的确切慢计算点**：已排除 tokenAccounting（3-5ms）和渲染（30ms）。需在下一步用 Solid profiler 定位是哪个 memo/effect/协调在 store 更新时昂贵。
2. **主线程阻塞的最终精确触发点**：minidump 显示主线程在 JIT 代码自旋（415KB 栈），但编译二进制无符号、读不出具体 JS 函数。卡顿根因（handle 耗尽）已确认；主线程自旋是耗尽后的下游表现还是独立问题，可在修复后用 dev 构建（带符号）复核。
3. ~~deferred destroy 的 `!node.parent` 条件是否会永久泄漏~~ **已由 A/B 实测解决**：紧凑循环下积压无上限增长，但让出事件循环即完全排干为 0，native 容量无损失——不是永久泄漏，是 **nextTick 被饿死导致的暂时积压**（§3.4 第 4 条）。

---

## 8. 结论

**卡死根因（最终、定位到行）：`thirdparty/opentui/packages/solid/src/reconciler.ts:133-138` 的 `_removeNode` 把 renderable 的 `destroyRecursively()` 无界 defer 到 `process.nextTick`。当主线程被连续同步渲染/协调占满（不 yield 事件循环）时，这些 nextTick 回调被饿死，待销毁 renderable 积压无上限增长（A/B 实测：紧凑循环 +8/轮无上限，让出事件循环即排干为 0）。每个 renderable 在共享 native handle 注册表（`handles.zig` `MAX_SLOTS=65535`）占 ~4 个 handle。补丁重放这类几小时无空闲的连续自主操作让积压单调涨满 65535 → `Failed to create TextBuffer` → 渲染崩溃 → 主线程自旋 → 卡死。**

**已排除（实测干净）**：单个 renderable 销毁零泄漏；流式单条 markdown 0 churn；滑窗 registry 增长≈复杂度替换（非 JS 泄漏）；reconciler defer 路径无永久泄漏（settle/让出即排干）；无 native-only 泄漏。**已确认**：卡死 = handle 耗尽；根本机制 = **deferred-destroy 在连续无空闲负载下被饿死、积压无上限**。

**修复主方向（双侧，治本优先）**：

1. **生产侧治本**：`tokenAccounting` 不该在每个 part delta 上 O(总数) 重算。`session/index.tsx:486` 的 exit-message `createEffect` 只需退出时的最终快照，不该随 delta 重算；应改为**退出时惰计算**或对 accounting 做**增量/节流**。这直接消除“随消息数膨胀的主线程占用”。
2. **销毁侧安全网**：`reconciler.ts:133` 的 deferred-destroy 积压设**上限**，超阈值同步 drain，保证连续负载下也不无界增长（不改变正常 defer 语义，只兼底）。
3. **配套**：修复共享 SyntaxStyle use-after-destroy（`NativeSyntaxStyle is destroyed` → 工具空卡片）。

---

## 9. R2 根因（已交付修复后仍崩溃的真根因）：BlockTool `hasPreview` 丢弃式求值泄漏

> 用户提示词溯源：msg_08d2287c7（装了 .12 修复的正式二进制仍在同一超长会话报 `Failed to create TextBuffer`）、msg_08af5978f（“Renderable 是怎么来的、为什么生成超过销毁”）、msg_08a2cea2b（“该查的是为什么产生这么多 renderable、能不能避免，而不是加速销毁”）。

### 9.1 现象

装上 R1 修复（exit 惰计算 + reconciler 上限，0.4.3-smark.12）后，用户的同一超长会话**仍然随时间推移报 `Failed to create TextBuffer`**。说明耗尽除了“销毁饿死积压”（R1 已修）之外，还存在一条**永久泄漏**路径——创建后从未进销毁链。

### 9.2 实测证据（复现测试 `zz-repro-freeze.test.tsx`，真实 300 条重型消息满窗滑窗 200 次 + settle）

泄漏检测法：settle 后扫 `Renderable.renderablesByNumber`（销毁时会 `delete`，见 `Renderable.ts:1568`），对每个对象**向上走 parent 链**，链顶到不了 root 的才是真正脱离树的永久泄漏（向下走 getChildren 会漏 ScrollBox 内部节点造成误判）。

**结论：共 378 棵泄漏子树；其中滑窗期间新建 157 棵，基线挂载期 221 棵。**

- 泄漏单元精确到组件：**每棵 = Box×2 + DiffRenderable×1 + CodeRenderable×1 + LineNumberRenderable×1 + GutterRenderable×1（共 6 个 renderable ≈ 18 个 native handle）**，内容预览为 patch diff。
- 创建滑窗分布均匀（0-19:13棵 … 180-199:16棵），与含 `patch` part 的 assistant 消息一一对应。
- 另有 TextRenderable 泄漏 297 个（同一根源，走 preview `Show` 的 fallback `<text>` 分支）。

### 9.3 创建调用栈（插桩 `renderablesByNumber.set` 捕获，实锤）

```
new DiffRenderable ← createElement (reconciler.ts:235)
  ← session/index.tsx DiffView 的 <diff>（源码 2997）
  ← ApplyPatch 的 preview prop（源码 3465-3485 的 <DiffPreview>）
  ← untrack ← createMemo ← BlockTool（源码 2789 hasPreview memo）
```

TextRenderable 泄漏栈同样终于 **BlockTool 的同一个 createMemo**（走 `<text>` fallback 分支，源码 3472-3476）。

### 9.4 根因（定位到行）

**`session/index.tsx:2789` `BlockTool` 的 `const hasPreview = createMemo(() => props.preview !== undefined)`。**

- Solid 的 JSX prop 是 getter；访问 `props.preview` 会**立即执行整个 JSX 表达式**。
- **JSX prop getter 访问即整树求值（与构建无关）**：`createComponent` 在 solid-js 的 server 与 client 构建中都**同步立即执行**组件函数（`createComponent(DiffPreview)` → DiffPreview → DiffView → intrinsic `<diff>` → `new DiffRenderable()`，占 4 个 native handle + 构造缓存的 left side Code/LineNumber/Gutter）。（审计修正：此前“server.js eager SSR 专属”的表述不准确——静态解析虽指向 server.js，运行时 memo 失效/重算为 client 语义；但泄漏机制在两种构建下同样成立。）
- `hasPreview` 只是拿这个棵树做 `!== undefined` 判断，**判断完就丢弃**——从未插入渲染树（reconciler 根本不知道它存在），也从未销毁（不在任何销毁队列里）→ **永久泄漏**。
- 泄漏频率：每个带 `preview` 的 `BlockTool` 挂载泄漏 1 棵；`view()`（宽度跨 120 的 split/unified 切换）或 theme 变化使 memo 失效时**再泄漏 1 棵**。
- 数学闭环：用户会话 2845 个 patch part × 每棵 ≈18 handle ≈ **5.1 万**，加基线挂载 ≈ 4 千 → 填满 65535 → `Failed to create TextBuffer`。与生产会话规模完全吻合。

**对 §3.4 第 3 条的修正**：当时用模板消息（无 patch preview）测得“settle 后净增≈复杂度差、无显著永久泄漏”；换成含 patch part 的真实重型消息后永久泄漏才暴露。R1 的 reconciler 上限修的是“销毁被饿死”的暂时积压，防不住这种“从未进销毁链”的永久泄漏。

### 9.5 修复方案（治本、单点、零接口变化）

只改 `BlockTool` 一个组件（`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`），让 preview 树**只构造一次**，同一棵树同时服务存在性检查与挂载：

```ts
// 2789 附近
const previewTree = createMemo(() => props.preview)      // 只构造一次
const hasPreview = createMemo(() => previewTree() !== undefined)
// 2849: {props.preview} → {previewTree()}
```

- 语义不变：现状是构造 2 次（1 次被 memo 丢弃、1 次被挂载），修复后构造 1 次并挂载。渲染结果完全一致。
- memo 失效（view/theme 变化）时：memo 重算构造新树，插入点 `{previewTree()}` 重跑 → reconciler 对旧树走正常 removeNode→deferred destroy（销毁链已验证干净），无泄漏。
- 接口零变化（`preview?: JSX.Element` 保留），全部 7 个 `preview={` 调用点（2417/2431/2930/3072/3094/3364/3465）无需改动。
- 范围核查：这是**唯一实测泄漏源 / 唯一热路径**（全部 378 棵泄漏子树的创建栈均终于此）。`dialog-select.tsx` 的 `filterAccessory|header|footer` 同属“存在性检查触发 getter 求值”模式但为低频对话框路径（非阻塞观察项，不进本次范围）；`notebook-tool.tsx:24` 的 `preview` 是 view-model 对象上的 JSX 字段（非 Solid props getter，访问不触发新构造），不受影响。

### 9.6 验证

- **Red→Green**：复现测试加断言——滑窗+settle 后“脱离树的存活 renderable 子树数 = 0”（修复前 157 棵滑窗期泄漏，修复后应为 0）。
- 新增聚焦回归测试：挂载带 preview 的 BlockTool，断言 registry 增量 == 实际挂载节点数（无丢弃副本）。
- 回归：TUI 套件（323 tests）+ typecheck。

### 9.7 修改预算

生产代码 1 文件（session/index.tsx）、~4 行；测试 1-2 个文件。远低于预算上限。

### 9.8 实施证据（R3 已实施）

**实际 diff**（与批准方案一致，无偏差）：

- `src/cli/cmd/tui/routes/session/index.tsx`：BlockTool 内 `hasPreview` 前插入 `previewTree = createMemo(() => props.preview)` 并改由它供给存在性检查；挂载点 `{props.preview}` → `{previewTree()}`。净 +2 行代码 + 4 行中文注释（ invariant：JSX prop getter 访问即整树求值，存在性检查不得构造丢弃副本）。
- `test/cli/cmd/tui/session-message-render.test.tsx`：新增回归测试 `apply_patch preview card mounts without leaking discarded preview tree`（挂载含 patch 的 apply_patch 卡片 → settle 排干 deferred destroy → 断言本用例新建的每个 renderable 的 parent 链都能到达 root）+ `Renderable` import 1 行。

**Red→Green**：

- Red（未修复）：测试失败，detached = `[BoxRenderable#box-11, BoxRenderable#box-12, DiffRenderable#diff-1, …]`（正是被 hasPreview memo 丢弃的 DiffPreview 子树）。首次 red 是在无快照隔离版本上跑出；补加快照隔离（排除同文件串行套件的历史注册表污染）后在未修复代码上复跑依然 red（泄漏对象为本用例新建、不在快照内）。
- Green（修复后）：单测通过；原始反馈环（300 条真实重型会话满窗滑窗 200 次 + settle）泄漏子树 **378 → 0**；200 滑窗 registry 按类型净增仅 +19（Box+11/Code+2/Text+5/Markdown+1，全部存活且挂于树上，属 §3.4 已确认的复杂度漂移；修复前为 +296 且全为脱树泄漏）。

**验证命令与结果**（cwd 均为 `packages/opencode`）：

| 命令 | 结果 |
|---|---|
| `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "leaking discarded preview tree"`（修复前） | red：detached 含 DiffPreview 子树 |
| 同上（修复后） | green：1 pass |
| `bun test test/cli/cmd/tui/zz-repro-freeze.test.tsx`（原始反馈环，修复后） | 泄漏子树 0 棵；registry 200 滑窗净增长 0 |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx` | 90 pass / 0 fail |
| `bun test test/cli/cmd/tui/`（34 文件全套件） | 325 pass / 0 fail |
| `bun typecheck` | 通过（tsgo --noEmit 无输出） |

**E/C**：E=3（生产：previewTree 行 + hasPreview 修改行 + 挂载点修改行）+ 测试 E≈50；C=4（生产 invariant 注释块）+ 测试 C=6。合计 C=10 ≥ ceil(53×0.15)=8 ✓。

**次要/替代路径清单**：无。无 fallback、无接口变化、无新增生产概念。

**未决/未验证项**：`zz-repro-freeze.test.tsx`（调查脚本）按惯例应移至 `.temp/Testing\`，但移动被权限预检拦截（需要用户显式授权文件移动）；该文件不进 commit（untracked，commit 用 `--only` 显式路径排除），待用户确认后清理。dialog-select 的同模式 JSX 存在性检查为低频对话框路径，按审计结论不扩 scope。
