# Patch Record 0052

## 1. 本轮身份与边界
- Index: 52；Source SHA12: `a6e3b3cdafde`。
- Source full SHA: `a6e3b3cdafde155ac721edcd71761b17bcc254d2`。
- Original: `original/0052-a6e3b3cdafde.patch`，本轮只读，未改写源档。
- Current: `current/0052-a6e3b3cdafde.patch`，本轮手工重写。
- Record: `records/0052-a6e3b3cdafde.md`，历史信息与本轮证据分开保留。
- 仓库根目录：`F:/ML/PythonAIProject/Claude-Code/opencode/thirdparty/opencode-11720`。
- 本轮目标基线为 `v1.18.32`，实际只读工作区到累计 0050。
- 只读工作区：`states/v1.18.32/.test-workspace/repo`；它不是新 0052 的执行产物。
- Builder 状态：`BUILDER_EDITED / UNVERIFIED`，没有本轮独立审计结论。
- 本轮没有重新计算 SHA-256、bytes、累计状态身份或安装指纹。
- 本轮只编辑 0052、0056 的 current 与 records，共四个自有工件。

## 2. 阅读范围与实际 owner
完整阅读 original/current 0052、0056，以及 original/current 0047、0049；并检查实际 0050 工作区的发现、worker、插件和配置服务。
相邻 0051、0053、0054、0055 也已读取：它们没有修改本补丁的 daemon 环境构造 owner。
源补丁的入口在旧 `packages/opencode/src/cli/cmd/tui/thread.ts`，目标入口是 `packages/opencode/src/cli/cmd/tui.ts`。
目标 `discoverOrSpawnDaemon` 负责身份与网络解析、快速复用、持租约复查和唯一生产 `deps.spawn`。
0047 已将父环境全部复制给新 daemon；0049 只调整选举等待、heartbeat、初始等待与轮询频率。
实际 0050 的 env 构造位于 tui.ts 的 daemonFile/printLogs 之后，不能继续引用旧 network.hostname 上下文。
新 0052 按该真实上下文构造 unified diff，并用紧邻 spawn 的原有 worker 注释作为尾部锚点。

## 3. 源意图逐项映射
源 `proxyEnv()` 使用大写优先的空值合并，HTTP、HTTPS、ALL、NO 四组均输出双大小写。
HTTPS 在两种 HTTPS 写法都缺失时继承 HTTP；显式小写 HTTPS 也比 HTTP 继承优先。
源列出 `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`SSL_CERT_DIR` 三个 CA 键。
目标保留完整父环境，比只挑选这些键更完整；CA 键不需要再重复同值赋回。
大小写归一与 HTTPS 继承不是完整复制可以替代的行为，本轮明确补回。
原 source 的 truthy spread 在空值处不写覆盖；本轮按“大写优先”的要求保留已定义空值。
因此空大写会统一覆盖小写，避免两个代理消费者分别使用相反设置。
全缺失的代理组不新增键，既有未知环境键不被裁剪。

## 4. B 项修复前后
- B-52-01，修复前：完整 env 复制后逐键 identity assignment，没有归一效果。
- B-52-01，修复后：从同一个 env 快照选择大写优先值，原位补齐四组双写法。
- B-52-02，修复前：只有 HTTP 配置时 HTTPS 仍缺失，丢失原始继承语义。
- B-52-02，修复后：`HTTPS_PROXY ?? https_proxy ?? http` 只在 HTTPS 缺失时继承。
- B-52-03，修复前：记录把“完整转发”误认为已经覆盖大小写选择语义，并推迟给后来补丁。
- B-52-03，修复后：记录明确复制与归一各自的责任，不依赖 0071 或任何未来功能。
- B-52-04，修复前：旧 diff 的 network 条件和 worker 注释不匹配真实 0047/0049 owner。
- B-52-04，修复后：按实际 0050 的 daemonFile/printLogs/env/spawn 顺序手工重建。
- 以上为 builder 文本修复说明，不是运行验证或独立审核关闭记录。

## 5. 新的生产调用链
发现前先计算 DB/channel 身份与网络配置；失败不会创建备用 daemon。
快速复用和租约内复查继续执行同一 reuse 函数。
只有需要新 spawn 时才复制一次 `process.env`，过滤 undefined，不过滤 CA 或用户变量。
四组代理值只从这一份快照读取，不再创建第二份 process.env 数据源。
归一后的 env 仍由唯一 `deps.spawn` 消费；worker 角色和显式监听运输值在原边界覆盖。
不在 daemon 启动链剥离 `OPENCODE_PROCESS_ROLE` 或 `ELECTRON_RUN_AS_NODE`，不破坏 bootstrap。
就绪仍要求本次子 PID、认证 health、DB/channel 和锁 token 复读。
失败时仍只杀尚未交付的本次 proc handle，原选举 lease 在外层 finally 释放。

## 6. 注入测试工件
只新增一个参数化 test，放在已有 `test/cli/tui/thread.test.ts` 的 single-server enforcement 内。
复用 `baseDeps`、`fakeLock` 和生产 `discoverOrSpawnDaemon`，没有另写发现算法或启动 daemon helper。
替换 read/spawn I/O，spawn 返回注入 proc handle；该用例不创建任何实际子进程。
四组输入覆盖冲突双写法、小写 HTTP 与 HTTPS 继承、显式小写 HTTPS、空大写优先。
断言检查实际 spawn 参数，而不是源码关键字或独立代理 helper 的返回值。
非代理父键逐项比较，包含任意用户变量和三条 CA 路径；生产角色覆盖单独断言。
每组要求恰好一个 spawn 和真实发现流程返回的 URL，复查仍使用既有身份与 token 字段。
finally 精确恢复原始缺失、空值和非空值；本轮没有执行这个测试。

## 7. G 项与手工计数
G-52-01 修复前：三条中文注释主要解释无效重复赋值，未说明真正优先级与继承边界。
G-52-01 修复后：生产四处注释分别解释完整快照、空值优先、HTTPS 继承和实际 spawn 边界。
测试九处中文注释分散解释各输入差异、全量转发、生产参数断言、注入 handle 与环境恢复。
手工口径：新增非空行 64，其中中文注释 C=13，非注释有效行 E=51。
按 E 的 15% 向上取整需 8 条；按全部新增非空行的保守口径需 10 条，均少于 13。
生产自身 E=10、C=4，满足至少三条要求；注释不是用重复空行或无意义说明凑数。
unified diff 两个 hunk 手工数为 old/new 9/23 与 6/57。
这个计数只证明文本构成，不能作为 typecheck、apply 或运行结果。

## 8. 与 0056 的手工衔接
0052 在 tui.ts 增加 14 行，因此原超时附近上下文的位置随之移动。
0056 的 tui.ts 第二个 hunk 使用新 0052 之后的旧侧行号 190，尾部保留原 proc finally。
0056 不再携带旧 0052 的代理 identity loop，也不重新复制或选择 daemon 环境。
安装子进程清理由 0056 的 installation 局部函数负责；它不是 daemon bootstrap 的 env 策略。

## 9. 保留的历史身份
旧记录 current SHA-256 为 `541c5e2ac07eab334265b627471a5509647289f51877de1fc0e44884ba10993a`，bytes 为 1393。
旧记录 state 路径为 `states/0052-a6e3b3cdafde`，cumul/status/builtAt 均记为 None。
旧记录基线为 `4473fc3c…`，tip 为 `d0ceb469…`；它们不是本轮 v1.18.32 的身份断言。
旧指标 E=16、C=3、required=3，对应重复赋值版本，不代表本轮内容。
旧记录宣称 materialize 52、在 51 上 apply-check clean，并称注入 spawn 的 thread 用例保持绿色。
旧记录宣称 50-54 正向与反向双审都认可，且无开放 B/G；这些旧结论现已撤销其当前效力。
原理由把双写法填充推迟到 0071/applyProxyEnv，认为只在 sanitize 后才必要；本轮已纠正该理由。
原残余说明称本补丁不归一大小写、安装身份清理由 0056 负责；前半句被本轮修复取代。
旧验证、旧审计和旧摘要仍保留为迁移历史，不用于证明新文件可应用或可运行。

## 10. 本轮验证状态
使用 read/grep/glob/skill/apply_patch 完成只读核对与手工编辑。
没有运行命令、Git、测试、安装、生成、materialize 或 copies/state 流程。
没有启动 CLI、TUI、opencode、daemon helper，也没有修改实际工作区代码。
新补丁仍待授权流程进行顺序应用、类型与注入测试验证；本记录不填写新 hash 或机器结果。
本轮文本修复已写入，运行与独立审核结论保持 `UNVERIFIED`。

## 11. 后续验证补记（用户提供）
- 用户报告：官方 type60 报告标识 `02-02-41-138Z`，累计 apply60 成功，全部 30 个包类型检查通过；本轮未定位到该报告文件，未独立复核。
- 较早 opencode 六文件结果为 128 个测试通过、337 个断言、46.61 秒，包含 loader-shared 的兼容资格与 pure 用例；不作为 0052 thread 注入用例已运行的证据。
- 0052 daemon/thread 用例未运行；主流程禁止启动 daemon，相关启动链仅有静态源码核对，没有实际启动成功结论。
- 新一轮完整补丁对验证仍在运行，尚无最终结论；历史保留，本补记不将整对补丁标记为通过。
- 当前闭合（用户提供）：fresh FULL 升序 `ses_ed73dac7fffeWCu9fQT5SYrMOD`、降序 `ses_ed73dac47ffexXp5HwFZntRiK6` 均为全部 10 项 PASS，open B/G=0；仅闭合 current 51–60，全部历史保留。
- 最新官方 type60 报告 `02-17-24-266Z`：apply 60/60、全部 30 workspace 类型检查通过；Core 114 pass/1595 expect/17.95s。按用户证据登记，既有 opencode/LLM/TUI 测试范围保留；daemon、hydration UI、macOS 原生终端及编译 CLI WASM 未测，保留 N/未验证边界，不宣称全部 CI 通过。

## 注释上下文同步（2026-10-11）
- 仅随 47 的租约/复读解释移位调整生产 env hunk 起点到 136，old/new 保持 9/23；代理逻辑和测试完全不变。历史保留，本轮未执行命令、重放或测试，不新增 C 或产品结论。
