# Canonical Implementation Plan: 跨主机共享存储下的 daemon 锁与数据库单写者保护

> Status: approved
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: 用户原话（见第 1 节）
>
> Implementation allowed: yes
>
> Last updated: 2026-09-20

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 因此下面请你完整全面结合这些相应的问题及情况，完整全面地去检查检查，看看是否有相应的一些优秀的方法，或者说情况能够进行相应的一些优化，使得避免这类数据库冲突或者静态进行编辑导致的一种问题。譬如，你可以完整全面地去分析看一看相应的内容，因为本质上可能它在不同的节点上对应着同样的一个文件系统，那本质上而言可能唯一的锁的形式就只能以文件的形式去存在，但是目前而言又有一个相应的 OpenENCOD 的锁的自动清理机制，本质上导致它的数据库没有正确地进行一定的一个清理或者观察的机制，因此你全面完整去看一看，有没有什么比较好的方法去进行相应的一些调整或者优化。当前是进行只读的完整调研，请你全面完整进行相应的分析，以及对于这类情况进行一个完整全面的一个假设以及看一看这种情况理论上来说应该如何去进行修改。但请注意，理论上而言，如果是那个 OpenENCOD 的锁它没有自行进行清理，那本质上而言，因为也有一种可能是 OpenENCOD 正常退出了，但是它没有清锁，或者锁它没有清好，那本质上而言可能这种就是也可能需要兼顾一下这种情况，避免 OpenENCOD 一启动不起来。所以你可以全面完整去看一看。

事件背景（observed，2026-09-20 远端取证）：用户的 superpod 集群登录节点
slogin-01 / slogin-02 共享同一个 NFS home（`sc-superpod-nfs.hpcstorage.ust.hk:/home`）。
用户在 slogin-01 运行过 opencode TUI（残留 worker pid=551533，持有
`~/.local/share/opencode/opencode.db` 的 3 个 fd），随后在 slogin-02 执行
`opencode -s ses_...`，slogin-02 选主逻辑将 slogin-01 的活 daemon 判死并启动了
第二个 daemon，两个进程跨主机同时写 WAL 模式的 SQLite，造成
`SQLITE_NOTADB`（第 1 页文件头被覆写，全部 68415 页中仅第 1 页完全损毁、
数据页有零星损坏）。表现形式：CLI 反复报 `Error: Unexpected server error.`

## 2. Explicit Non-Goals

- 不改变 SQLite 为存储引擎、不改变 WAL 模式本身（见第 20 节 rejected）。
- 不把数据库迁移到节点本地存储（改变持久化语义，属产品决策而非根因修复）。
- 不改动 maintenance lease（`ServerLock.acquireMaintenanceLease`，
  `server-lock.ts:340-429`）的既有算法与行为；其跨主机同类问题只在第 20 节
  向用户披露，不在本计划修复（见 R1 审计 NB-6/NB-8）。
- **不改变单主机（非共享存储）场景的任何用户可见行为**：同主机多进程
  （daemon + `run`/`stats`/`import`/`serve` 等）并发打开同一个 db 是既有
  受支持行为（`storage/db.ts:104` 的 `[local-smark] busy_timeout=30s` 注释
  即为该语义存在），WAL 同主机多进程是 SQLite 的标准模型。
- 不处理 `Global.Path.state`/`data` 目录位置的可配置化（与本次根因无关）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md`（Runtime 词表：Project/InstanceState/Server；SMARK fork delta: "Daemon — Server Lock, health checks"） | daemon/ServerLock 是本 fork 的自有特性，修复必须留在 fork 语义内 |
| `AGENTS.md`（根）+ `packages/opencode/AGENTS.md` | 测试必须从 `packages/opencode` 运行；`bun typecheck`；模块自导出约定 |
| `.opencode/policy/first-principles-engineering.md` | 根因修复、禁止 fallback、证据分级 |
| `packages/opencode/src/cli/cmd/tui/server-lock.ts` 的既有注释 | lock 的 tmp+rename 原子写、token-owner 语义是既有合同 |
| `packages/opencode/src/cli/cmd/tui/daemon.ts` 注释（"unresponsive 不得 spawn 第二个 daemon"） | 单 owner 复用语义是已声明的合同，remote 分类不得破坏它 |
| R1-R3 独立审计（第 22 节 Round 1-3，BLOCK：B-01/B-02/B-03/B-04/B-05） | R2-R4 修订点的全部来源 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| 远端 `~/.local/share/opencode/log/2026-09-19T*.log`（`SQLITE_NOTADB`、`failed to run data migrations`、`PRAGMA journal_mode = WAL` 失败栈） | 事故的直接观测 | observed |
| 远端 db 取证（68415 页仅第 1 页损毁；sqlite_master 叶页完整；`/proc/551533/fd` 3 个 db 句柄；home 为 NFS） | 双写者事故链的物证 | observed |
| `packages/core/src/global.ts`（`state`/`data` 来自 xdg → 共享 home 时跨主机同路径） | 锁文件与 db 都落在 NFS 共享命名空间 | observed |
| `packages/opencode/src/cli/cmd/tui/server-lock.ts:10-19`（record 无 hostname）、`:124-131`（`alive()`=kill(pid,0)） | 第一分叉点：活性判定绑定主机本地 PID 命名空间 | observed |
| `packages/opencode/src/cli/cmd/tui/daemon.ts:270-289`（`existingOwnerUrl`）、`:332-434`（ensure 选主）、`cli/cmd/daemon.ts:96-157`（stopDaemon） | false-dead→clear→spawn 链路；false-alive→unresponsive-reuse 链路 | observed |
| **`cli/cmd/db.ts:57-67`（`liveDaemon()` 自行 `alive()`+`clearIfOwner()`，调用点 :428、:433、:554、:610、:682、:763）** | R2 B-04：db 维护命令上的第二套未分类活性判定，异机活 lock 会被误删 | reachable |
| `packages/opencode/src/cli/cmd/tui/worker.ts:505`（lock 仅启动时写一次，无心跳）、`:266-324`（close→clearIfOwner 顺序；deadline 故意不清锁） | 锁清理顺序与异常路径的既有合同 | observed |
| `packages/core/src/util/flock.ts:148-282`（mkdir+heartbeat+staleMs；meta.json 已含 `hostname`） | 仓库已有跨进程 mkdir 租约与 hostname、utimes 心跳先例 | observed |
| `server-lock.ts:340-429`（maintenance lease：mkdir(lock)+owner.json+dead-reclaim tombstone rename） | db 写者租约复用的生产验证算法模板 | observed |
| `packages/opencode/src/storage/db.ts:95-151`（`Client()` 打开点；WAL；busy_timeout=30000；close 时 TRUNCATE checkpoint） | 写者租约的挂载点之一 | observed |
| **`cli/cmd/db.ts:834`（`db migrate` 用 `new BunDatabase(Database.getPath())` 直接写开）、`:815-818`（`db` 交互 shell spawn 外部 `sqlite3`）、`:796`（`db <query>` readonly 直开）——全部绕过 `Client()`** | R1 B-01：INV-05 的完整入口清单必须含 db CLI；"静态编辑"向量 | reachable |
| `cli/cmd/serve.ts:19`、`cli/cmd/web.ts:44`、`cli/cmd/acp.ts:26`、`plugin/index.ts:248`（经 `Server.listen`/`Server.Default` 进程内开库）、`index.ts:159-171`（每个 CLI 进程首跑时的 JsonMigration 也走 `Client()`） | INV-05 完整枚举；错误呈现点 | reachable |
| `cli/cmd/run.ts:813-852`、`stats/data.ts:4`、`import.ts:174`（同主机并发 opener 的既有受支持流） | R1 B-02：同主机不得拒绝的直接证据 | reachable |
| `test/cli/tui/server-lock.test.ts`、`test/cli/tui/daemon.test.ts`（write/read/clear/alive/ping、选主、stop、maintenance lease reclaim 等） | 既有测试合同与新增测试挂载点 | observed |
| SQLite 官方文档对 WAL 的限制（-shm 要求所有进程同主机） | 跨主机双写必损坏的外部合同 | contracted |

## 5. Current Behavior

```text
TUI (thread.ts)
  -> Daemon.ensure()
       -> existingOwnerUrl(): ServerLock.read() (NFS 上的 tui-server.json)
            -> alive(lock.pid)  [process.kill(pid,0)，主机本地语义]
            -> dead => 选主 Flock.acquire("opencode.server") -> ServerLock.clear() -> spawn worker
       -> worker: Server.listen() -> InstanceStore -> Database.Client() (WAL 打开共享 db)
       -> worker: ServerLock.write()（仅启动时写一次，无心跳）
  -> worker gracefulShutdown: dispose -> Database.close() -> ServerLock.clearIfOwner(token)
  -> worker 崩溃/SIGKILL：锁残留，靠下次启动 alive(pid) 判死后清理

serve / web / acp / plugin / db CLI(migrate/shell/query) / stats / import / run
  -> 不经过 Daemon.ensure；serve/web/acp/plugin/stats/import/run 经 Server.listen
     或 Database.Client() 进程内开库；db CLI 三条命令用 new BunDatabase / 外部
     sqlite3 直接开库——全部不做任何跨主机所有权检查。
```

- 锁的自动清理（单主机）：pid 死亡 → `dead` → clear → 重启，已有测试覆盖。
- 锁的自动清理（跨主机）：不存在。远端活 pid 在本机 `kill(pid,0)` 返回 ESRCH → 误判 dead。
- 反向误判：远端 lock 的 pid 若与本机无关进程撞号 → `alive` 为真 → `ping(127.0.0.1:port)`
  失败 → `unresponsive` → ensure 复用该 URL → TUI 永远连不上（"启动不起来"）。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| lock 由本机活进程持有 | 本机 worker | pid 命名空间一致 | 现有 responsive/unresponsive 复用 | daemon.ts | observed |
| lock 由本机死进程持有（正常/异常退出未清） | 本机已退出 worker | 无 | dead → clear → spawn（已有测试） | daemon.ts | observed |
| lock 由远端主机活进程持有（共享 NFS home） | 另一节点的 worker | NFS 同路径 | 误判 dead → 双 daemon → db 损坏 | daemon.ts / server-lock.ts | observed（事故） |
| lock pid 与本机无关进程撞号 | OS pid 复用 | 无 | unresponsive-reuse → 启动失败 | server-lock.ts | reachable（用户明确要求覆盖） |
| 远端节点崩溃遗留 lock（无人能清） | 远端 crash | NFS mtime 可见 | 需要心跳+staleness 接管 | daemon.ts | reachable |
| 旧格式（无 hostname）lock 且 pid 本地死 | 升级前安装 | 持久化数据 | **不可判定**（远端活旧 daemon vs 死锁同名同形），禁止静默接管 | server-lock.ts / daemon.ts | observed（R1 B-03：磁盘上现存的 lock 格式） |
| serve/web/acp/plugin/stats/import/run 同主机并发开库 | CLI 入口 | WAL 同主机模型 | 既有受支持行为，不得拒绝 | storage/db.ts | reachable（R1 B-02） |
| 上述入口在异机执行（共享 NFS） | CLI 入口 | 无 | 与 daemon 并发双写 → 同类损坏 | storage/db.ts | reachable（与事故同类） |
| `db migrate`/`db` shell/`db <query>` 直开 | db CLI | 无 | 绕过 Client() 的写/读开库；"静态编辑"向量 | cli/cmd/db.ts | reachable（R1 B-01） |
| 集群节点间时钟偏差 + NFS 属性缓存（acregmax/acdirmax 常见上限 ~60s） | NFS/NTP 配置 | 无 | staleness 判定依赖 mtime 差值与缓存可见性 | 设计常量 | reachable |
| owner 进程被 SIGSTOP/freezer 暂停超过 staleness 窗口后被接管、随后恢复继续写 | 运维/资源管理动作 | 无 | split-brain 残余风险（见第 20 节） | storage/db.ts | reachable（缓解另述） |
| `Flag.OPENCODE_DB === ":memory:"`、测试并行进程各自临时 home | 测试基建 | 无 | 租约必须对 `:memory:` no-op；测试 home 天然隔离 | storage/db.ts | reachable |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 同一时刻最多一个**主机**上的进程集合以写方式持有共享存储上的同一个 opencode db（同主机多进程并发为既有受支持行为） | 事故取证 + SQLite WAL 同主机限制；R1 B-02 修正为 per-host | 无 |
| INV-02 | 另一台主机上的活 owner 绝不能被本机判死（无 false-dead） | 事故根因 | 无 |
| INV-03 | lock pid 被无关进程复用时不得被当作活 owner 复用（无 false-alive 阻塞启动） | 用户要求 + pid 复用可达 | 无 |
| INV-04 | owner 崩溃/未清锁时后续启动必须在有限时间内自动接管；但**不可判定的旧格式 lock 除外**——它只能显式人工接管，不得静默按死处理 | 用户要求；R1 B-03 | 部分（单主机已有） |
| INV-05 | 所有打开 db 的入口——TUI worker、serve、web、acp、plugin、run、stats、import、`db migrate`/`db` shell/`db <query>`、首跑 JsonMigration——都经过同一个跨主机所有权检查 | R1 B-01 的入口枚举证据 | 无 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02 | `existingOwnerUrl()` 对可能写于其他主机的 lock 调用主机本地语义的 `ServerLock.alive(lock.pid)`；record 无 hostname 字段，无从区分"pid 死了"与"pid 不在本机" | `cli/cmd/tui/daemon.ts` 分类 + `cli/cmd/tui/server-lock.ts` record/schema | daemon.ts:270-289；server-lock.ts:10-19、124-131；事故日志与 fd 证据 |
| INV-01/05 | db 的每个打开点（`Client()`、`db.ts` CLI 的 `new BunDatabase`/spawn sqlite3）都不验证跨主机所有权；TUI 选主只是 UX 层约定 | `storage/db.ts` + `cli/cmd/db.ts` | db.ts:95-151；db.ts:796、815-818、834 |

下游症状（双 daemon、SQLITE_NOTADB、"Unexpected server error"）与根因分离：
根因是**锁的活性证明绑定在"主机本地 PID 命名空间"，而锁文件与数据库存在于
"跨主机共享的 NFS 命名空间"**；两个命名空间不一致，且 WAL 的 `-shm` 进一步要求
所有写者同主机（SQLite 外部合同）。

Red-capable feedback loop：

- 事故为 observed（远端日志 + db 取证 + `/proc` fd 证据）。
- 单元级 red：`test/cli/tui/daemon.test.ts` 新增"异主机活 lock → 不 spawn、不清锁"
  ——当前代码必走 dead→clear→spawn，必红。
- 单元级 red：`test/storage/` 新增"异机活 owner 持有 `<db>.owner` 时开库被拒绝"——
  当前无租约概念，必红。
- 工作目录：`packages/opencode`（仓库规则：测试不得在 repo 根运行）。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| db 跨主机所有权租约（mkdir+owner.json+共享心跳+tombstone reclaim） | `storage/db.ts`（`acquireWriterLease`/`releaseWriterLease`，由 `Client()` 与 db CLI 共同调用） | 开库前必须通过租约验证；异机活 owner → typed `DatabaseOwnerError` | 所有进程内开库汇聚于 `Client()`；db CLI 的直开也复用同一原语——一个合同一个实现 | daemon.ts 选主只管 TUI 路径，管不到 serve/CLI/db shell |
| daemon lock 的主机身份与活性分类 | `cli/cmd/tui/server-lock.ts`（record schema + hostname + 分类辅助） | lock 携带 hostname；同机/异机/陈旧/旧格式四态分类只有一个实现；**所有 lock 消费方（`existingOwnerUrl`/`stopDaemon`/`status`/`cli/cmd/db.ts` 的 `liveDaemon()`）共享这一个实现** | lock 文件格式的 owner | worker.ts 只是写锁的调用方 |
| 选主与复用决策 | `cli/cmd/tui/daemon.ts` `existingOwnerUrl`/`ensure`；`cli/cmd/daemon.ts` stop/status；**`cli/cmd/db.ts` `liveDaemon()` 改经同一分类，永不对非本机-dead 的 lock 调 `clearIfOwner`** | remote-live → 不 spawn 不清锁，typed 错误含主机名；旧格式歧义 lock → typed 拒绝并指向 reclaim 命令 | 既有分类函数已是唯一分类实现（connectionInfo 注释要求复用）；db 维护命令是既有消费方（R2 B-04） | — |
| daemon lock 心跳 | worker.ts（持有期间周期 utimes lock 文件） | 心跳只刷 mtime 不改内容，不影响 token 语义 | 持有者最知道自己活着；Flock 有同模式先例 | server-lock.ts 是被动格式层 |
| 同机 pid 撞号收紧（仅 daemon lock） | server-lock.ts `alive` 判定增强（Linux `/proc/<pid>/stat` starttime 对比） | 同机 owner 身份必须比"pid 存在"更强；**不进入 maintenance lease 的 alive()**（Non-Goal #3） | 活性判定本就属于该模块 | daemon.ts 不应自行实现第二套活性判定 |
| 旧格式歧义 lock 的人工接管 | `cli/cmd/daemon.ts` 新增 `reclaim` 子命令 | 用户显式确认后清理指定 lock（pid 本地活时拒绝） | CLI 是用户运维动作的天然入口 | 自动路径无权替用户裁决不可判定情形 |

## 10. Single Approved Primary-Path Design

一个权威语义合同：**db/daemon 的 owner 身份 = (hostname, pid, token)；同主机活性
用 PID 命名空间证明，跨主机活性用心跳 mtime 证明；租约文件落盘在 db/lock 旁
（NFS 上 mkdir 与 mtime 跨主机可见、mkdir/rename 原子）；过期租约用 tombstone
rename 原子接管（沿用 server-lock.ts:340-429 已验证算法）；不可判定的旧格式
lock 只给显式人工接管。**

```text
任何进程内 opener -> storage/db.ts acquireWriterLease(dbPath)
  -> :memory: 直接放行（无文件即无共享）
  -> mkdir <dbPath>.owner/（已有则读 owner.json + heartbeat mtime）
     -> owner.hostname == 本机 && 心跳新鲜（< STALE_MS）
        => 加入：启动本进程心跳（utimes）后开库
           （同主机多进程为既有受支持语义；lease 是"主机所有权"标记而非进程互斥）
     -> owner.hostname != 本机 && 心跳新鲜（< STALE_MS）
        => 抛 DatabaseOwnerError（含远端 host/pid/startedAt，消息可操作）
     -> 心跳过期（>= STALE_MS，无论同机异机）
        => 唯一接管路径：rename <db>.owner -> tombstone（原子、同名目标只一赢家）
           -> 赢家：mkdir -> 写本机 owner.json -> 心跳 -> 开库
           -> 输家：重读 owner 并重分类（异机赢家且新鲜 -> DatabaseOwnerError；
              本机赢家且新鲜 -> 加入后开库）
        （加入分支必须带新鲜度条件：过期租约一律走接管，消除"本机加入与异机接管
          并发各开各的库"的 check-to-act 窗口，见 R3 B-05）
  -> Database.close() 停本进程心跳（保留 lease 目录；心跳自然过期即释放主权）
  -> db.ts CLI（migrate/shell/query）与首跑 JsonMigration 经同一原语：
     Client() 内部调用；db.ts 直开处在 new BunDatabase/spawn 前显式获取、
     退出时释放（外部 sqlite3 进程不受代码约束，属咨询性覆盖，见第 20 节）

TUI -> Daemon.ensure()
  -> existingOwnerUrl() 分类扩展（server-lock.ts 单点实现）：
     lock.hostname == 本机 -> 现有 missing/dead/stopping/responsive/unresponsive 语义不变
     lock.hostname != 本机 -> mtime 新鲜: remote（不 spawn、不清锁，typed 错误
                              含 host/startedAt，提示到该主机操作或等待其过期）；
                              mtime 过期（>= REMOTE_STALE_MS）: 按 dead 接管
     无 hostname 的旧 lock  -> pid 本地活：现语义；
                              pid 本地死：**typed 拒绝 + 指向 `opencode daemon reclaim`**
                              （不可判定情形不静默接管，升级期一次性摩擦，见第 20 节）
  -> worker 写出带 hostname 的 lock，持有期间每 HEARTBEAT_MS utimes
  -> 新增 `opencode daemon reclaim`：仅在 lock pid 本地不活时清理并输出确认信息；
     pid 本地活则拒绝（用户对自己的运维动作负责）

db 维护命令（cli/cmd/db.ts 的 status/vacuum/compress/resume/cleanup/verify/expand）
  -> liveDaemon() 改经 server-lock.ts 的同一分类：
     remote-fresh -> typed 拒绝（"daemon 在 <host> 上存活；127.0.0.1 控制面跨机不可达，
                     请到该主机执行"），不删 lock
     remote-stale -> 按 daemon lock staleness 规则处理
     旧格式歧义    -> typed 拒绝并指向 `daemon reclaim`
     本机-dead     -> 现语义（clearIfOwner 后离线执行）
```

acquireWriterLease 必须是**同步**实现：`Database.Client()` 与 `Database.use` 今天就是
同步接口（db.ts:95-151，65+ 调用点），租约原语只能用同步 fs（readFileSync/statSync/
mkdirSync/renameSync，db.ts:11 已有同类 import），禁止把 Client() 改成 async。
tombstone reclaim 的输家语义沿用 maintenance lease 模板（server-lock.ts:380-393）：
rename 失败者重读 owner 并重分类，落到 DatabaseOwnerError。

要点说明：

- 修复第一分叉点的方式是**让 lock/lease 自证主机身份**，而不是在判定时猜测。
- 心跳间隔 HEARTBEAT_MS 建议 10s；STALE_MS（db 租约）建议 90s；
  REMOTE_STALE_MS（daemon lock）建议 120s。窗口远大于集群 NTP 时钟偏差
  （通常 <1s）与 NFS 属性缓存常见上限（~60s，见第 20 节）。
- remote-live 与歧义 lock 的拒绝是**诊断性分类分支**（typed error，不产生成功
  形态输出），不是 fallback；错误消息必须可操作（owner 主机、启动时间、可用命令）。
- 同机 pid 撞号：`alive()` 在 Linux 上增强为同时比较 `/proc/<pid>/stat`
  starttime 与 `lock.startedAt`（容差数秒）；仅用于 daemon lock 分类，不触碰
  maintenance lease；非 Linux 维持现语义。
- `DatabaseOwnerError` 的呈现点包括首跑 JsonMigration 所在的任意 CLI 启动路径
  （index.ts:159-171 经 Client()）：错误文本自身携带可操作信息，CLI 顶层错误
  打印原样透出即可。
- 同主机 opener 的心跳是**共享主机活性**证据：任一本机 opener 存活都会刷新，
  避免"租约创建者崩溃、同机其他进程仍持有 db"被异机误判过期（B-02 的边界补全）。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 同机 dead→clear→spawn | current | primary-contract branch | yes | 单主机主路径 | preserve |
| 同机 unresponsive→reuse | current | primary-contract branch | yes | 单主机保守复用 | preserve |
| 同机 opener 加入既有 lease | proposed | primary-contract branch（同主机成员） | yes | 同主机开库 | 新增（不改变可见行为） |
| 异机活 owner→DatabaseOwnerError / daemon remote typed refusal | proposed | diagnostic（分类合同内的新终态，不产出成功形态） | no | 跨主机分支 | 新增（INV-01/02 所要求） |
| 异机过期→tombstone reclaim→正常开库/选主 | proposed | primary-contract branch（INV-04 跨主机延伸） | yes | 跨主机分支 | 新增 |
| 旧格式歧义 lock→typed 拒绝 + `daemon reclaim` 人工接管 | proposed | existing shipped compatibility（持久化旧 lock）+ 显式用户运维动作 | no（自动路径）/ yes（用户显式 reclaim） | 升级期一次性 | 新增；两个大版本后可再评估旧格式分支 |
| 任何"远端不可达就本地开第二个 daemon/写者"的路径 | — | forbidden fallback | — | — | reject（正是事故本身） |

诊断性分支（两类 typed refusal）只产生拒绝与指引，合计占比远低于政策的
diagnostic 预算；它们的分类依据：输入域成员（异机活 owner / 不可判定旧 lock）
在主合同下的合法终态。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 无（事故后的人工修复属一次性运维操作，不在代码内） | — | — | — |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-02 | server-lock.ts：record +hostname、分类辅助；daemon.ts：remote/歧义分支 | server-lock.ts / tui/daemon.ts | "异机活 lock → ensure 不 spawn 不清锁，错误含 host" |
| INV-01 | db.ts：acquireWriterLease + Client() 接入；db CLI 三命令接入 | storage/db.ts / cli/cmd/db.ts | "异机活 owner 持租约 → Client() 抛 DatabaseOwnerError" |
| INV-05 | 同上（serve/web/acp/plugin/run/stats/import 经 Client()；db CLI 与 JsonMigration 显式接入） | storage/db.ts / cli/cmd/db.ts | "进程内第二 opener（异机身份注入）被拒绝；同机 opener 被允许" |
| INV-04 | 心跳+staleness 接管（lock 与租约两层）；`daemon reclaim` 命令 | worker.ts / server-lock.ts / db.ts / cli/cmd/daemon.ts | "过期异机 lock/租约被自动接管；旧格式歧义 lock 被拒绝且 reclaim 可清理" |
| INV-02（db 维护命令面） | liveDaemon() 改经同一分类；非本机-dead 不删 lock | cli/cmd/db.ts / server-lock.ts | "异机活 lock 下 `db status`/`db vacuum` 拒绝且不删 lock" |
| INV-03 | alive() 增强：/proc starttime 对比（仅 daemon lock） | server-lock.ts | "pid 撞号（starttime 不符）的 lock 判 dead"（Linux） |
| 旧 lock 兼容 | 无 hostname 字段的拒绝+人工接管分支 | server-lock.ts / daemon.ts / cli/cmd/daemon.ts | "无 hostname + 本地死 pid → 拒绝且不删锁；reclaim 后可启动" |
| 既有单主机并发（B-02 回归钉） | 租约同机加入分支 | storage/db.ts | "同机已持 lease 时第二个 Client()/db CLI 正常开库" |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| ServerLock.hostname 字段 | INV-02 | 事故取证（无 hostname 无法区分远端 owner） | record 当前无该字段（server-lock.ts:10-19） |
| lock/租约心跳（utimes） | INV-04 | 远端 crash 后无 PID 信号可用，mtime 是 NFS 上唯一跨主机活性证据 | 现有 lock 只在启动时写一次，无新鲜度概念 |
| STALE_MS / REMOTE_STALE_MS 常量 | INV-04 | 心跳语义必需；窗口须大于时钟偏差与 NFS 属性缓存 | 无现成常量 |
| db 所有权租约（`<db>.owner/`） | INV-01/05 | serve/web/acp/plugin/db CLI 直开的代码证据 | 选主锁只保护 TUI 路径 |
| DatabaseOwnerError（typed） | INV-01/02 | 拒绝必须可操作且可被 CLI/TUI 区分呈现 | ExistingLiveServerError 只覆盖同机 TUI 选主 |
| /proc starttime 对比 | INV-03 | pid 复用是 OS 可达事件；用户明确要求兼顾"锁没清好启动不起来" | 现有 alive() 只有 kill(pid,0) |
| tombstone rename 接管 | INV-04 | maintenance lease 生产验证的同款算法（server-lock.ts:340-429） | 复用该模式而非新造 |
| `daemon reclaim` 子命令 | INV-04/旧格式兼容 | 旧格式 lock 不可判定（R1 B-03），自动路径无权裁决 | 现有 stop 只处理可判定情形 |
| 共享主机心跳（每个 opener 都 utimes） | INV-01 边界 | 租约创建者崩溃而同机其他 opener 存活的情形 | 单 owner 心跳会误报过期 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/server-lock.ts` | modify | ServerLock record +hostname；write() 写入；同机/异机/陈旧/旧格式分类辅助；alive() 的 /proc starttime 增强（仅 daemon lock 用） | +120 |
| `packages/opencode/src/cli/cmd/tui/daemon.ts` | modify | existingOwnerUrl 增加 remote/歧义分类；ensure/connectionInfo 呈现 | +80 |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | modify | 持有期间心跳 utimes（HEARTBEAT_MS），gracefulShutdown 停心跳（顺序在 clearIfOwner 前） | +25 |
| `packages/opencode/src/storage/db.ts` | modify | acquireWriterLease/releaseWriterLease（mkdir+owner.json+共享心跳+tombstone reclaim）；Client() 接入；DatabaseOwnerError；:memory: no-op | +150 |
| `packages/opencode/src/cli/cmd/db.ts` | modify | migrate/shell/query 三命令在直开前后获取/释放租约；`liveDaemon()` 改经统一分类（R2 B-04） | +70 |
| `packages/opencode/src/cli/cmd/daemon.ts` | modify | stop/status 的 remote/歧义分支文案与拒绝；新增 `reclaim` 子命令 | +60 |
| `packages/opencode/test/cli/tui/server-lock.test.ts` | modify | hostname 分类、staleness、pid 撞号、旧格式用例 | +140 |
| `packages/opencode/test/cli/tui/daemon.test.ts` | modify | remote-live 不 spawn、remote-stale 接管、旧格式拒绝+reclaim 用例 | +140 |
| `packages/opencode/test/storage/db-lease.test.ts` | add | 租约异机冲突/过期接管/同机加入/幂等复用/:memory: no-op 用例 | +160 |
| `packages/opencode/test/cli/cmd/db.test.ts` | add | db CLI 租约接入与维护命令分类用例（slice 9/10） | +100 |

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 异机活 lock（hostname 不同、mtime 新鲜）→ `ensure` 不 spawn、不清锁、错误含主机名 | 现分类把远端 pid 判 dead | remote 分类分支 | 单 owner 不被跨机复制 |
| 2 | 异机 lock 且 mtime ≥ REMOTE_STALE_MS → `ensure` 接管并成功 spawn | 现无心跳/staleness 概念 | stale 接管分支 | 远端崩溃后有限时间可启动 |
| 3 | 异机活 owner 持 `<db>.owner` → `Database.Client()` 抛 DatabaseOwnerError | 现无租约 | 租约获取+异机冲突拒绝 | INV-01/05 |
| 4 | `<db>.owner` 心跳过期 → Client() tombstone 接管并成功开库 | 同上 | reclaim 分支 | INV-04（租约层） |
| 5 | 同机已持**新鲜** lease 时第二进程（或注入同机身份）开库正常（共享 WAL 语义不变） | 无租约 | 同机新鲜加入分支 | B-02：既有单主机多进程行为 |
| 6a | 无 hostname 旧 lock + 本地死 pid → ensure/stop typed 拒绝且不删锁 | 现直接 dead→clear | 歧义拒绝分支 | 升级期不误杀远端旧 owner（B-03） |
| 6b | 对歧义 lock 执行 `daemon reclaim` → 清理后可正常启动 | 无 reclaim 命令 | reclaim 子命令 | 旧格式一次性人工出口（INV-04） |
| 7 | 同机 lock pid 存在但 /proc starttime 与 startedAt 不符 → 判 dead（Linux） | 现 alive() 只看 pid | starttime 对比 guard | INV-03 |
| 8 | worker 持锁期间 lock mtime 被周期刷新；db 租约心跳由任一 opener 刷新 | 无心跳 | heartbeat timer ×2 | stale 判定不误伤活 owner |
| 9 | `db migrate`/shell 在异机活租约下拒绝执行；同机下正常 | 现直开无检查 | db CLI 租约接入 | "静态编辑"向量（INV-05） |
| 10 | 异机活 lock 下 `db status`/`db vacuum` typed 拒绝且不删 lock；新格式本机-dead 时现语义清理 | 现 liveDaemon() 直接 alive()+clearIfOwner | liveDaemon 改经统一分类 | INV-02 在 db 维护面（R2 B-04） |
| 11 | `:memory:` 路径租约 no-op，既有 storage 测试套件不受影响 | 无租约 | no-op 分支 | 测试基建兼容 |
| 12 | 过期自持租约与异机接管并发竞争 → 仅一方开库（rename 输家重分类）；无竞争时本机对接过期租约经接管正常开库 | 加入分支若无新鲜度条件则双写窗口存在（R3 B-05） | 过期一律接管 + 输家重分类 | INV-01 的 check-to-act 窗口闭合 |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~1045（生产 ~505 + 测试 ~540） | 政策口径含测试；排除 import/格式化 |
| Required Chinese explanatory comments `C` | >= max(1, ceil(E * 0.15)) ≈ 157 | 以最终实现实际 E 重算为准 |

需要就近中文解释的点：

- 为什么活性判定必须区分 PID 命名空间与 NFS 命名空间（两类证据不可互换）。
- HEARTBEAT_MS / STALE_MS / REMOTE_STALE_MS 的取值理由（NTP 偏差与 NFS
  属性缓存 acregmax/acdirmax ~60s 的预算；与 Flock staleMs/3 心跳比例一致的先例）。
- tombstone rename 接管为什么原子且只允许一个赢家（引用 maintenance lease 先例）。
- 旧格式 lock 为什么不可判定、为什么只能人工 reclaim（B-03 的升级期合同）及
  再评估条件。
- 租约是"主机所有权"而非"进程互斥"的原因（同机多进程为既有受支持语义）。
- 共享主机心跳为什么由每个 opener 刷新（租约创建者崩溃但同机 opener 存活）。
- 加入分支的新鲜度条件（R3 B-05）：过期租约一律走唯一接管路径的原因，以及
  rename 输家重读重分类的规则来源（maintenance lease 模板）。
- /proc starttime 对比的容差与平台降级理由；为什么只用于 daemon lock 不进
  maintenance lease。
- worker 心跳只刷 mtime 不改内容、不影响 token 语义的原因。
- gracefulShutdown 中"停心跳 → Database.close() → 释放/停租约心跳 →
  clearIfOwner"的顺序约束。
- DatabaseOwnerError / remote / 歧义拒绝为何是诊断性分类而非 fallback。
- `:memory:` no-op 与测试隔离的理由。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/tui/server-lock.test.ts` | `packages/opencode` | 分类/心跳/撞号/旧格式用例通过 |
| `bun test test/cli/tui/daemon.test.ts` | `packages/opencode` | 选主 remote/stale/歧义/reclaim 用例通过，既有用例不回归 |
| `bun test test/storage/db-lease.test.ts` | `packages/opencode` | 租约冲突/接管/同机加入/:memory: 用例通过 |
| `bun test test/cli/cmd/db.test.ts`（新增，slice 9/10 挂载点） | `packages/opencode` | db CLI 租约接入与维护命令分类行为 |
| `bun typecheck` | `packages/opencode` | 类型通过 |
| 手动冒烟：同机双进程开同一 dbPath；异机身份注入再开 | `packages/opencode` | 同机允许、异机拒绝（INV-01 双向） |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 2（test/storage/db-lease.test.ts、test/cli/cmd/db.test.ts） | 租约测试与 db CLI 测试各自独立成文件 |
| Files modified | 8 | 见第 15 节（另新增 test/cli/cmd/db.test.ts） |
| Files deleted | 0 | — |
| Production lines | ~505 | 分类+租约+心跳+错误+reclaim+liveDaemon 改接 |
| Test lines | ~540 | 13 个行为切片 |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

- 时钟偏差与 NFS 属性缓存：staleness 判定依赖 mtime；Linux NFS 客户端属性缓存
  （acregmax/acdirmax 常见上限 ~60s）可能让心跳 mtime 的可见性滞后。HEARTBEAT_MS=10s
  的心跳节奏 + STALE_MS=90s/REMOTE_STALE_MS=120s 的窗口同时大于 NTP 典型偏差
  （<1s）与该缓存上限；若集群关闭 NTP 或调大缓存，需要相应调大常量。
- split-brain 残余：owner 进程被 SIGSTOP/freezer 暂停超过 staleness 窗口后被异机
  接管，随后恢复时仍持有 db fd。maintenance lease 有 `assertOwned` 逐批 fencing
  先例（server-lock.ts:405-415）；db 热路径不加 fencing（无测量依据），仅在
  migration/maintenance 等粗粒度边界可考虑复用同一 token 校验。记录为残余风险。
- 外部 `sqlite3` 交互 shell 的租约是咨询性的：opencode 在 spawn 前获取租约，但
  外部进程本身不受代码约束；用户直接在 opencode 之外手跑 sqlite3 不在威胁模型内。
- remote-live 的拒绝改变了"异机有活 daemon 时本机 TUI 可用"的幻觉——该幻觉
  正是事故入口；拒绝是修复的一部分，错误消息必须告诉用户去哪台机器。
- /proc starttime 增强仅 Linux 生效；Windows/macOS 维持现语义。
- 升级期一次性摩擦：旧格式歧义 lock 需要一次 `daemon reclaim`；升级后新 lock
  全部带 hostname+心跳，自动接管恢复。该窗口在第 6 节与 INV-04 中如实声明。
- maintenance lease 存在同类跨主机 false-dead（server-lock.ts:366 的 alive()），
  本计划按 Non-Goal #3 不修复，向用户披露（见开放决策 3）。
- 跨主机接管延迟：db 租约在干净退出后保留目录、心跳自然过期（STALE_MS≈90s）才
  释放主权；期间异机开库得到 DatabaseOwnerError。有界、可操作、无引用计数复杂度，
  代价已披露（开放决策 2）。
- owner.json 在"创建者崩溃但同机 joiner 存活"时保留已死创建者 pid（共享心跳仍
  新鲜，主权判定正确）；仅外观问题，不处理。

### Open Decisions Requiring the User

1. remote-live 时 TUI 的呈现：直接报错退出（建议）还是交互提示后退出。
2. REMOTE_STALE_MS（建议 120s）与 STALE_MS（建议 90s）、HEARTBEAT_MS
   （建议 10s）是否接受；同时请确认"干净退出后异机最长等待 STALE_MS"的代价。
3. `daemon reclaim` 命令作为旧格式歧义 lock 的唯一出口是本设计的必要组成
   （B-03 修正），请确认接受；maintenance lease 的跨主机同类问题是否另行
   立项修复。
4. db CLI 的交互 shell 在异机活租约下拒绝是否接受（"静态编辑"向量的代价）。

### Rejected Speculation

- `PRAGMA journal_mode=DELETE` 替代 WAL：rollback journal 在 NFS 跨主机下同样
  不被 SQLite 支持，且削弱单机语义；单写者租约落地后 WAL 同主机要求已被满足。
  证据不足且属替代路径，拒绝。
- 把 db 迁到节点本地存储：改变持久化语义、会话不随节点漂移，属产品决策；
  且非根因修复（选主错误的分类仍在）。拒绝作为本计划内容。
- OS 级 `flock`/`fcntl` 作为跨主机互斥：NFSv3 不可靠、NFSv4 依实现；
  仓库已有 mkdir+心跳的生产验证模式。拒绝。
- 在 `existingOwnerUrl` 里对远端 owner 做 TCP 直连健康检查：internal server
  绑定 127.0.0.1（worker.ts:91），跨机不可达；引入它会制造第二类误判。拒绝。
- 同主机进程级互斥（每进程一个 lease 位）：与既有受支持的同机多开语义冲突
  （R1 B-02），且无证据表明同机并发有害。拒绝。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15
  percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 3（B-01 Client() 唯一开库点前提为假，db CLI 绕过；B-02 同机活 owner 拒绝违反 Non-Goal #4；B-03 旧格式 lock 的 staleness 静默接管在升级期必然重建事故） | 10 | BLOCK | adversarial-auditor task ses_f44f0d6d5ffecC0mLTasuPk0N7 |
| 2 | R2 | yes | 1（B-04：cli/cmd/db.ts:57-67 liveDaemon() 自带未分类 alive()+clearIfOwner，异机活 lock 会被 db 维护命令误删，INV-02 仍有第二扇门） | 7 | BLOCK | adversarial-auditor task ses_f44f0d6d5ffecC0mLTasuPk0N7 |
| 3 | R3 | yes | 1（B-05：同机加入分支缺新鲜度条件，过期自持租约与异机 tombstone 接管并发时可出现两个跨主机写者） | 3 | BLOCK | adversarial-auditor task ses_f44f0d6d5ffecC0mLTasuPk0N7 |
| 4 | R4 | yes | No blocking findings. | 2（slice 12 的"Why current code fails"栏目引用 R3 缺陷而非现行代码行为的标注瑕疵；租约测试的同/异机身份注入 seam 属合法测试接缝，实现审计不得误判为生产代码） | APPROVE（No blocking findings，plan-mode 硬门全过：根因在属主模块修复、无 fallback、单一主路径、前后向可追溯、TDD 切片可红、验证命令工作目录正确、风险与 rejected speculation 如实区分、中文注释承诺合规） | adversarial-auditor task ses_f44f0d6d5ffecC0mLTasuPk0N7 |

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Complete only after implementation.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
|  |  | yes |  |  |  |  |
