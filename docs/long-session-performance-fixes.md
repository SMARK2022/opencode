# 长会话读取与控制响应修复

日期：2026-11-05。目标版本：`1.19.17-smark`，产品分支：`dev1-smark`。

本文记录 `c495ef00e6` 之后的收尾修改，并区分已经完成的实测与仍未达到的目标。此前提交已修复摘要增量 Part 查询、共享请求用量 footer、SSE 正常取消和 PTY 快速退出，本批不另建替代机制。

## 修复范围

| 路径 | 原因 | 本批修改 |
| --- | --- | --- |
| 会话摘要展示 | 仅需文件计数时也解压、解析完整历史 patch | 冷存储写入同事务维护 `summary_stats`，展示读端直接选择统计 |
| 摘要 codec | 已核验原始字节摘要，仍重新编码整份 JSON 比较排版 | 删除三处读端 canonical 重编码，保留结构、身份、长度及 hash 校验 |
| 取消子会话 | 取消操作遍历所有历史后代 | 使用现有 runner/后台作业身份，只查询活动任务的祖先链 |
| 撤回后重发 | 无 Tool 的只读输入也使历史摘要失效，触发完整重建 | 保留不受影响的归档；必要时仅回退消息游标 |
| 启动模型目录 | 会话页启动即读取全目录，重复构造并长期持有模型配置 | 已连接模型留在同步状态；全目录由连接对话框局部持有 |
| 公共会话查询 | 信息、列表和搜索候选读取内部恢复用 `summary_seed` | 公共列排除 seed；搜索候选只读 ID/时间 |
| 模型默认构造 | 9071 个模型重复校验固定默认结构 | 直接构造固定值，保留动态 ID 校验与容器独立性 |

所有 SQL 仍由后端现有 Session/Storage 模块负责，TUI 只消费接口。没有新增执行状态机、消息正文缓存、GC 调度或超时容忍，也没有关闭 durable 事件。

## 摘要所有权

`ColdStorageTable.summary_stats` 是不可变归档的同行派生投影，包含文件名、增删行、状态以及原 seed/delta 边界，不含 patch。完整摘要仍由归档正文提供，统计投影不取代正文权威。

迁移 `20261105064346_summary_statistics_projection` 只增加 nullable 列，不在升级时遍历和解压历史库。新归档在写入事务内生成投影；旧行第一次需要统计时补齐，保持原 hash、引用计数和更新时间。随后统计读取不再把压缩 BLOB 搬入 JavaScript。

TUI 的 viewer header 在 HTTP handler 中转换为 `statsOnly`，一路传给 `SessionSummary`、`SummaryCache`、`ColdStorage.inspectSummary`。普通 SDK 完整 diff 与指定消息的读取语义不变。展示数量限制在统计读取之后执行，不能用响应截断代替查询裁剪。

读端不再重复写 `session_diff` 兼容镜像；真正摘要写入和撤回路径仍维护镜像。这样避免每次查询把相同历史重新序列化、入库。

### 为什么删除 canonical 比较

写端已经生成 canonical JSON，读端外层已经核验原始字节的长度和摘要。再次序列化整个对象只检查字节排版，且制造与归档等大的字符串和缓冲区。

三处 parser 删除这一重复工作，继续检查 owner、版本、业务结构；pack 继续检查 entry key、唯一性及排序。写入去重时的碰撞复核、完整摘要与统计投影的一致性核对仍保留。实验中的分段比较和 JSON visitor 已移除，没有把全量比较换成另一套比较流程。

## 取消与撤回

实测会话有 3328 个直接子会话、4791 个后代。原路径对已结束历史逐个执行取消，即使当前空闲，abort 也可能超过 10 秒。

`SessionRunState.active()` 返回现有 runner 和运行中后台作业的身份快照，不维护第二份活动状态。`Session.children(parentID, active)` 在数据库内从活动身份向父级追溯，保留承接活动后代的空闲中间节点；不传 active 时仍返回普通子会话列表。

取消入口在等待 runner 前固定子树，沿原 owner 执行取消及终态处理。取消快照只读取消息 ID、role、parentID 和 completed，保留隐藏执行与孤立输入的原有处理语义，不为取消载入完整诊断正文。

撤回输入不一定改变文件摘要。对无 completed Tool、且变更未覆盖旧 opaque seed 的消息，失效入口保留归档；若变更正好是当前游标，仅按 `(time_created, id)` 回退到前一个可见闭合消息，保持同一事务和更新时间。

存在 completed Tool 或覆盖 opaque seed 时继续原失效路径。这是保守边界，不按工具名字猜测是否改变文件；本次只读输入实测不代表所有真实文件修改的撤回都具有相同时延。

## 启动与公共读取

会话页通过 `/config/providers` 获得已连接模型，不再在 bootstrap 请求全部 `/provider` 目录。`createDialogProviderOptions` 在连接对话框内按 workspace 获取完整目录，生命周期随对话框结束。认证后仍刷新服务端连接状态，不依赖旧全局目录副本。

后端内部目录复制使用 `structuredClone`，公共边界原有校验保留。错误建议只保留模型 ID/status；实际模型调用配置仍在 providers 中。未连接 OpenCode 时不启动初始远端刷新，认证变更监听仍负责后续更新。

`Model.Info.empty` 直接构造固定默认值，并对 provider/model 两个动态 ID 保留原构造校验。每个模型获得独立对象，不共享可变容器。

公共 Session 映射使用统一列集合，排除内部恢复正文 `summary_seed`；完整摘要恢复继续走 Storage。搜索先查候选 ID/更新时间，命中后才读取公共信息。两处 StepFinish 补账查询保留 Session 归属过滤，用一元 `+session_id` 排除错误的 Session 索引竞争，复用已有 message 索引。

## 实测结果

环境：Windows，私有 Bun 1.4.4，两个真实 PTY TUI 连接同一个隔离 daemon，模型为 `smark/glm-5.3-flash`。使用用户提供数据库的唯一可写副本，原始 DB/WAL/SHM 与用户常驻 daemon 未修改。重复实验复用副本，因此其中测试输入和派生缓存会增长。

内存数字是进程工作集峰值，不是常态驻留或文本大小；以下 MB 按 1,000,000 bytes 计算。旧版 TUI 约 700MB 是用户报告的常态基线，不能与新版峰值直接当作同一指标比较。

修复前的一次“撤回后发送”复现：daemon 峰值 5,222,686,720 bytes，offline 约 39.6 秒，后续 interrupt 超时。其直接生产源是只读消息撤回引起的大摘要重建。

最近一次双 TUI 完整控制序列：

| 指标 | 结果 |
| --- | --- |
| 首次 Enter 到两窗显示新输入 | 532ms |
| 两次运行态 interrupt | 387ms / 376ms |
| 撤回 API 返回 | 70ms |
| 两窗显示撤回 | 157ms |
| 撤回后 Enter 到两窗显示新输入 | 1621ms |
| 独立探测/控制记录最大耗时 | 2459ms |
| 探测失败 / offline | 0 / 0 |
| 退出 AbortError | 未出现 |
| 两个 TUI 峰值 | 867,921,920 / 860,479,488 bytes |
| daemon 峰值 | 652,726,272 bytes |

发送计时从 Enter 开始，先填好相同完整草稿，20ms 轮询两窗；不把文字注入耗时或模型生成等待混入控制响应。控制仍以 2 秒判失败，对外无响应仍以 4 秒判失败，没有修改产品 timeout 或 offline 显示。

本轮普通路径控制响应达到目标。daemon 约 653MB 仍超过原 600MB 目标；旧行首次补统计的另一轮峰值约 751MB。最后的公共 Session 列裁剪、错误建议目录裁剪完成类型/回归/构建验证，未再次 profile，因此不为它们虚报内存收益。

局部对照还包括：9071 个默认模型构造约 169ms 降到 11ms；StepFinish 点查约 381ms 降到 0.08–0.18ms。局部数字不等价于整次请求耗时。

## 回归验证

关键契约由以下现有入口测试，不增加测试专用生产分支：

- `packages/core/test/model.test.ts`：默认结构符合 schema、动态 ID 校验、对象容器独立。
- `packages/core/test/session-info-selection.test.ts`：公共会话投影及权威请求统计。
- `packages/opencode/test/storage/cold.test.ts`：新旧投影、引用和时间稳定、完整读取损坏校验、只读撤回不解冻重建。
- `packages/opencode/test/session/session.test.ts`：活动祖先链保留空闲桥接节点，默认列表合同不变。
- `packages/opencode/test/session/prompt.test.ts` 和 `revert-compact.test.ts`：取消、孤立输入、撤回与压缩既有语义。
- `packages/tui/test/cli/cmd/tui/sync-live-hydration.test.tsx`：启动完成且已连接模型可用，同时不取全目录。
- Provider/plugin、请求用量和消息投影测试继续覆盖原消费方。

两处 App E2E fixture 与现有生产合同对齐：时间线显式声明自动压缩并精确断言其文案；连接模型测试在认证写入后更新连接状态，不再等待已经取消的 instance disposal。没有修改生产翻译、延长断言期限或跳过测试。

从各包目录运行 `bun run test` 和 `bun typecheck`。线上 `test.yml` 覆盖 Linux/Windows/macOS 核心与 TUI、其他包及 App E2E；`typecheck.yml` 覆盖全部 workspace 和 `script/generate.ts` 生成一致性；CLI 构建 workflow 覆盖发布编译及 smoke。必须检查 warning job 内的真实测试结果，不能仅依据 workflow 最终绿色判定内部测试全过。

本次收尾本地验证记录：

| 检查 | 结果 |
| --- | --- |
| Core model/catalog/plugin/session-info/projector/revert | 269 pass，0 fail |
| Session 与完整 Provider 测试目录 | 780 pass，0 fail |
| 冷存储完整套件 | 44 pass，0 fail |
| 撤回与压缩完整套件 | 19 pass，0 fail |
| Prompt 取消/中断用例 | 19 pass，4 skip，0 fail |
| TUI 完整套件复跑 | 682 pass，2 skip，0 fail |
| Core、opencode、TUI、Schema 类型检查 | 通过 |
| App E2E 类型检查 | 通过 |
| `script/generate.ts` | 通过，SDK/Client/OpenAPI 无新增差异 |

首次 TUI 全套出现临时目录已删除后 `model.json` 异步重命名失败；相关 41 项与 97 项定向测试、随后完整套件均通过。本轮没有通过吞掉写入异常或延长测试期限掩盖该次失败。较大的会话组合套件超过本地命令时间预算，不能计为通过；改为独立运行受影响套件，线上仍保留全量测试。

本地 App E2E 的 Vite 已成功就绪，但缺少对应 Chromium；浏览器安装被权限策略拒绝，未继续安装。浏览器运行结果以包含本批修改的线上 Actions 为准，不能把类型检查当作 E2E 通过。

中文注释覆盖有效逻辑及关键删除、迁移和接线；收尾时按新增中文解释与增删有效代码的保守口径估算超过 15%。生成 schema、纯 import 和格式调整不计入有效代码，不为比例增加生产断言。

## 本地构建

普通 Windows 产物：`packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`，版本 `1.19.17-smark`，198,341,120 bytes。最后完成的无诊断注入构建 SHA256：`0efad4ee040f11feff096982a0a0f806775809ced66e0eb96acfcf71497d183c`。

本地隔离构建使用 `--version=1.19.17-smark --os=win32 --arch=x64 --skip-install --skip-embed-web-ui`，私有 Bun 1.4.4；未替换全局可执行文件。性能脚本、数据库副本、采样日志和编译产物不进入本次源码提交。
