# Grep/Glob 文件系统部分结果处理设计

## 文档状态

| 项目 | 值 |
|---|---|
| 状态 | 已实施并通过独立复核 |
| 调研日期 | 2026-07-11 |
| 当前分支 | `dev-smark` |
| 当前提交 | `4498da0c3` |
| 主线对照 | `origin/dev` / `7acb9ff2403d16baf76655acf27d60c8ef9b1fe6` |
| bundled ripgrep | `15.1.0` |
| 实施状态 | 5 个源码文件和 5 个测试文件已完成手术级实现 |

## 1. 设计摘要

本设计解决用户显式调用 Grep/Glob 时，ripgrep 因部分子路径受到 macOS TCC、Windows ACL 或 Linux 文件权限限制而返回退出码 `2` 的问题。

当前 Glob 将这类常见的遍历错误升级为整个 Tool error。已经枚举出的文件被丢弃，完整 stderr 被持久化、以红色显示并在下一轮作为 `error-text` 返回模型。当前 Grep 已使用 `--no-messages` 并能产生 `partial`，但零匹配分支在检查 `partial` 前返回 `No files found`，形成错误的确定性阴性。

推荐设计只在现有 Ripgrep、两个 Tool、Compaction 和用户报告问题所在的 classic TUI 上做局部调整：

1. 保持现有 streaming `Ripgrep.files()` 及其全部调用方不变。
2. 在同一个 `ripgrep.ts` 内增加仅供 Glob Tool 使用的 bounded `glob()`。
3. `glob()` 使用 `--no-messages`，以“退出码 `2` 且 stderr 为空”表达 completed partial。
4. Glob/Grep 在 Tool output 和 metadata 中传播 `partial`，零结果不得误报为完整无结果。
5. Compaction Search History 保留 partial，避免压缩后重新制造确定性阴性。
6. classic TUI 从 metadata 显示简短 `incomplete` 提示。
7. 复用现有 scoped child、AbortSignal 和 scope finalizer，不重写 timeout、kill 或通用取消链。

设计边界为 5 个源码文件、5 个现有测试文件、不新增文件、预计总 Git churn 约 430 至 775 行，硬上限 1,000 行。

## 2. 已完成的调研

### 2.1 已阅读的源码

| 文件 | 相关性与确认结果 |
|---|---|
| `packages/opencode/src/file/ripgrep.ts` | `files()` 的 streaming contract、`filesArgs()` 顺序、SearchResult、code `0/1/2`、limit、timeout、AbortSignal 和 child scope 的权威实现 |
| `packages/opencode/src/tool/glob.ts` | Glob 当前通过 `rg.files()` + `Stream.take(101)` 收集结果；Stream 末尾失败会丢失全部前缀结果 |
| `packages/opencode/src/tool/grep.ts` | Grep 已消费 `partial`，但 partial-empty 在第 128 行前后被普通空结果早退吞掉；metadata 未保存 partial |
| `packages/opencode/src/tool/tool.ts` | completed output 和 metadata 的清洗、截断边界；布尔 metadata 会原样保留 |
| `packages/opencode/src/session/processor.ts` | Tool error 原样写入 `state.error`；completed Tool metadata 原样写入 Message |
| `packages/opencode/src/session/message-v2.ts` | completed output 作为普通 Tool result text 返回模型；error 作为 `error-text`；metadata 是开放 Record |
| `packages/opencode/src/file/protected.ts` | Protected 是 index/watcher 的扫描策略，不是显式用户搜索的授权或正确性机制 |
| `packages/opencode/src/file/index.ts` | 非 global-home 索引继续使用 streaming `files()`；错误被索引初始化降级，不应随 Glob 修复迁移 |
| `packages/opencode/src/tool/skill.ts` | Skill 依赖 streaming `files()` 和 `Stream.take(10)`；必须保持接口与提前终止行为 |
| `packages/opencode/src/tool/external-directory.ts` | OpenCode Permission 只判断搜索根是否在 Project 外，不等同于 OS ACL/TCC |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts` | HTTP findText 使用 `search().items`；本设计不改变 SearchResult contract |
| `packages/opencode/src/cli/cmd/debug/ripgrep.ts` | debug files/tree 依赖 streaming `files()`，不应被 Glob Tool 的结构化结果迁移影响 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | classic TUI 有 Glob/Grep 专用 renderer；details 关闭时有两层 completed Tool 过滤 |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx` | 第二套 renderer 仅在 experimental event system 下作为 debug plugin 加载 |
| `packages/opencode/src/cli/cmd/tui/plugin/internal.ts` | 确认 session-v2 不是默认生产 renderer，只在 feature flag 开启时注册 |
| `packages/opencode/src/cli/cmd/run/tool.ts` | Glob/Grep 的原始 output 被隐藏，必须从 metadata 摘要显示 incomplete |
| `packages/ui/src/components/message-part.tsx` | Shared UI 把 read/glob/grep/list 收入 context group，折叠和展开状态均不显示 Tool output |
| `packages/opencode/src/session/compaction.ts` | Search History 只保存计数；Tool output 被 Compaction 清除后会把 partial-empty 重新表示为确定性 `0 matches`，必须纳入当前正确性链 |
| `packages/core/src/cross-spawn-spawner.ts` | child 是 scoped resource；scope 退出会终止仍运行的进程，支持 force escalation |
| `origin/dev:packages/core/src/ripgrep.ts` | 主线已有共享 run 和 8 KiB stderr collector，但 glob/grep 公开方法再次映射为数组并丢失 partial |
| `origin/dev:packages/core/src/tool/glob.ts` | 主线 core Tool Output 仍是数组，不能直接作为当前分支的结构化迁移目标 |
| `origin/dev:packages/core/src/tool/grep.ts` | 同上；当前修复不混入 1,127 个提交跨度的主线同步 |

### 2.2 已阅读的测试与约束文档

| 文件 | 相关性与确认结果 |
|---|---|
| `CONTEXT.md` | v1 Session/Message/Tool 是当前生产路径；v2 是进行中的迁移，不能假定 parity |
| `AGENTS.md` | 测试必须从 package 目录运行；手工编辑使用最小修改；不应引入不必要抽象 |
| `packages/opencode/AGENTS.md` | Effect service、scope、测试 fixture 和模块形状约束 |
| `docs/adr/README.md` | 当前是局部 Tool/Ripgrep 修复，不需要新 ADR |
| `packages/opencode/test/file/ripgrep.test.ts` | 现有正常、空结果、limit、timeout、invalid regex、files 测试；无权限 code `2` 结构化覆盖 |
| `packages/opencode/test/tool/glob.test.ts` | 仅覆盖基础匹配和文件路径错误；无 partial 测试 |
| `packages/opencode/test/tool/grep.test.ts` | 已有 Layer.mock seam，可直接构造 partial-empty/partial-items，无需新测试框架 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | 已有真实 OpenTUI 字符帧和 `tool_details_visibility:false` fixture |
| `packages/opencode/test/cli/run/entry.body.test.ts` | 已覆盖 Grep truncated/timedOut 摘要，可扩展 partial |
| `packages/opencode/test/session/message-v2.test.ts` | 已证明 completed output 原样成为 Tool result text、error 原样成为 error-text；无需重复新增本专项测试 |
| `packages/core/test/effect/cross-spawn-spawner.test.ts` | 已证明 scope exit 杀 child、forceKillAfter 和 isRunning 行为；本修复不重复测试底层 spawner |
| `packages/opencode/test/project/project.test.ts` | 提供 `ChildProcessSpawner.makeHandle` 并委托真实 spawner 的现成测试范式 |
| `packages/opencode/test/installation/installation.test.ts` | 提供轻量 scripted stdout/stderr/exit handle 范式 |

### 2.3 搜索确认的调用点和消费者

对 `rg.files()`、`rg.search()`、Ripgrep Service、metadata count/matches/truncated/timedOut、Glob/Grep renderer 和 Tool output visibility 进行了全仓搜索，确认：

1. `rg.files()` 的生产调用方是 File index、Skill、Glob Tool 和 debug ripgrep。
2. `rg.search()` 的生产调用方是 Grep Tool、HTTP file handler 和 debug ripgrep。
3. Glob metadata 的既有消费者使用 `count`、`total`、`truncated`。
4. Grep metadata 的既有消费者使用 `matches`、`totalMatches`、`truncated`、`timedOut`。
5. classic TUI、`opencode run` 和 Shared UI 都有专用/分组 renderer，不会自动显示 completed output 中的 warning。
6. session-v2 renderer 只由 `experimentalEventSystem` 注册，不属于默认路径。
7. ToolStateCompleted metadata 在 Message 和 SDK 中均为开放字典；增加布尔 `partial` 不改变 schema，也不触发 SDK 生成。
8. Compaction Search History 是 Tool output 被清除后的模型证据来源，必须独立传播 partial。
9. Tool 参数 schema 不变，因此参数 snapshot 不应变化。

### 2.4 本轮实机和测试证据

使用 bundled ripgrep `15.1.0` 重新执行只读探针：

| 场景 | stderr | exit |
|---|---|---:|
| 受保护的 PegasusConfiguration，普通 `--files` | `Operation not permitted (os error 1)` | 2 |
| 同目录，增加 `--no-messages` | 空 | 2 |
| `--files --no-messages --glob='['` | invalid glob 诊断仍存在 | 2 |
| `--json --no-messages '(' README.md` | invalid regex 诊断仍存在 | 2 |

另验证了 ripgrep glob 的 last-match-wins：当前顺序 `--glob=!.git/*` 后接用户 `--glob=.git/config` 能返回 `.git/config`；反向顺序返回空。因此新路径必须复用当前参数顺序，不能把默认排除移到用户 glob 后面。

测试基线：

```text
cd packages/opencode
bun test test/file/ripgrep.test.ts test/tool/grep.test.ts test/tool/glob.test.ts
# 25 pass, 0 fail

bun test test/cli/run/entry.body.test.ts test/cli/cmd/tui/session-message-render.test.tsx
# 66 pass, 0 fail

bun typecheck
# pass

cd packages/ui
bun typecheck
# pass
```

现有测试全绿但没有权限 partial 覆盖，构成明确的回归测试缺口。

### 2.5 数据库证据

两份数据库均使用 `sqlite3 -readonly` 查询，没有写入或迁移。

| 数据源 | Glob completed/error | 确认权限 Glob error | 涉及 Session | 最大错误字符 | Grep partial warning | Grep 精确 `No files found` |
|---|---:|---:|---:|---:|---:|---:|
| 当前 Mac live DB | 1679 / 36 | 8 | 5 | 32,040 | 4 | 752 |
| `.temp/testing/opencode.db` Windows 原库 | 4734 / 113 | 40 | 16 | 18,031 | 119 | 1,449 |

Grep 的精确空结果无法事后区分完整空结果和 partial-empty，这正是 metadata/output 必须同时修正的原因。

## 3. 职责边界与不变量

### 3.1 Ripgrep 层

Ripgrep 层负责：

- 构造参数和隔离用户 `RIPGREP_CONFIG_PATH`。
- 启动、读取和 scoped 清理 child。
- 将 exit code、stderr 和结果上限转换为结构化执行语义。
- 保留文件系统平台差异，不让 Tool 解析本地化错误字符串。

Ripgrep 层不负责：

- Tool 文案、颜色或展示。
- OpenCode Permission。
- 自动扩大或缩小用户明确指定的搜索范围。
- Session persistence 或数据库迁移。

### 3.2 Tool 层

Glob/Grep Tool 负责：

- Permission 和搜索根解析。
- 排序、路径格式、结果数量和模型文本。
- 把结构化 `partial` 写入 metadata 和 output。

Tool 不应解析 `Operation not permitted`、`拒绝访问`、`Permission denied` 等本地化字符串。

### 3.3 展示层

展示层只读取 `metadata.partial` 并显示中性警告，不参与错误分类。fatal error 继续使用现有 error renderer；partial 是 completed Tool，不应显示成红色失败。

### 3.4 必须保持的行为

1. `Ripgrep.files()` 的类型、streaming、提前 `Stream.take()` 和 code `2` 失败语义不变。
2. File index、Skill、debug files/tree 不迁移。
3. Glob 正常空结果仍精确为 `No files found`。
4. Grep 正常空结果仍精确为 `No files found`。
5. invalid glob、invalid regex、spawn failure、非预期 exit 仍为 Tool error。
6. Glob 继续最多展示 100 条，并以第 101 条作为 bounded total/truncated 证据。
7. Grep 继续最多展示 64 条，既有 timeout 和截断语义不在本修复中重写。
8. `.git` 默认排除继续位于用户 glob 之前，显式 `.git/config` 搜索仍可覆盖。
9. Glob 不增加 `--follow`；不通过 symlink 扩大 external-directory 边界。
10. 不把被拒绝路径列表写入 output 或 metadata，避免隐私泄漏和上下文洪泛。
11. AbortSignal 中断仍失败，不伪装成 partial。
12. 不修改 input schema、HTTP contract、SDK、数据库或配置。

## 4. 推荐设计

### 4.1 在现有 Ripgrep Service 增加 bounded `glob()`

在 `packages/opencode/src/file/ripgrep.ts` 内增加两个小型内部 contract：

```ts
interface GlobInput extends FilesInput {
  limit: number
}

interface GlobResult {
  items: string[]
  partial: boolean
  truncated: boolean
}
```

`Interface` 增加内部 service method：

```ts
readonly glob: (input: GlobInput) => Effect.Effect<GlobResult, PlatformError | Error>
```

这是 package 内部 Effect service seam，不是 HTTP、SDK 或 Tool input 公共 API。它与 `origin/dev` 已存在的 `Ripgrep.glob()` 命名一致，但当前分支返回结构化完整性，不机械复制主线的数组降维。

### 4.2 参数构造

`filesArgs()` 增加一个仅供内部调用的 `noMessages` 布尔参数，默认 `false`：

- 现有 `files()` 继续调用默认值，行为不变。
- 新 `glob()` 调用 `filesArgs(input, true)`。
- `--no-messages` 放在 `--files` 后。
- 其余顺序完全复用当前实现，特别是默认 `.git` 排除必须早于用户 glob。
- `GlobTool` 不传 `follow`，所以命令中没有 `--follow`。

不新增自动 Protected 排除。用户明确选择的 cwd/pattern 保持原语义，OS 拒绝通过 partial 表达。

### 4.3 bounded 读取和 scope 清理

`glob()` 直接复用现有 `check()`、`command()`、`raceAbort()`、ChildProcessSpawner 和 `Effect.scoped`：

1. spawn 后 forkScoped drain stderr。
2. stdout 使用现有 `decodeText -> splitLines -> clean`。
3. `Stream.take(limit + 1)` 后收集数组。
4. 若观察到第 `limit + 1` 条，立即返回前 `limit` 条和 `truncated=true`。
5. bounded stdout、stderr completion 和 `exitCode` 不得放入同一个 `Effect.all`。sentinel 分支不得 join stderr，也不得读取或等待 `exitCode`，否则 scope 无法退出、finalizer 无法运行。
6. bounded 分支不增加显式 kill 状态机；函数先构造结果并离开 `Effect.scoped`，再由现有 CrossSpawnSpawner finalizer 终止仍运行的 child。
7. 只有未达到 sentinel 的自然完成分支才 join stderr 并等待 `exitCode` 分类。
8. 外层 `raceAbort(program, signal)`；abort 中断 scope 并触发现有 child finalizer。

这与当前 Glob 的 `rg.files().pipe(Stream.take(101))` 生命周期一致，只是把 exit/partial 分类放进能够保留前缀结果的 Effect 中。底层 scope exit kill、force escalation 和 `isRunning` 已有 core 测试，不在本修复重复实现。

### 4.4 exit 分类

只采用本轮对 bundled rg 15.1.0 已验证的最小规则：

| 结果 | 语义 |
|---|---|
| observed `0` | complete，保留 items |
| observed `1` | complete empty |
| observed `2` + trimmed stderr empty | completed partial，保留 items |
| observed `2` + stderr nonempty | fatal，保留 invalid glob/参数诊断 |
| observed 其他 code | fatal |
| 达到 `limit + 1` | completed truncated，由 scope 清理 child |
| AbortSignal | abort error |

达到 limit 后不再等待自然 exit，也不猜测 partial。此时 `truncated=true` 已经准确说明结果不完整；进一步区分未遍历区域是否存在权限拒绝没有可用证据，也没有产品价值。

不解析本地化权限文本，不修改 Search 的 timeout、JSONL parser、kill 竞态或 stderr collector。`--no-messages` 已消除本问题中的权限 stderr 洪泛；通用 error 上限属于独立防御性任务。

### 4.5 Glob Tool

`packages/opencode/src/tool/glob.ts` 改为调用：

```ts
rg.glob({
  cwd: search,
  glob: [params.pattern],
  limit: 100,
  signal: ctx.abort,
})
```

随后只对返回的最多 100 个路径执行当前 stat/mtime/排序逻辑。

metadata 保留原字段并新增 partial：

```ts
{
  count,
  total,
  truncated,
  partial,
}
```

`total` 继续是 bounded 证据而不是精确全量：`items.length + (truncated ? 1 : 0)`，保持当前最多为 101 的行为。

输出矩阵：

| items | partial | 输出 |
|---:|---|---|
| 0 | false | `No files found` |
| 0 | true | `No files found in accessible paths.` + incomplete warning |
| >0 | false | 当前文件列表和 truncated warning |
| >0 | true | 当前文件列表 + incomplete warning |

统一 warning 保持简短，不列路径：

```text
(Search incomplete: some paths were inaccessible and skipped. Narrow the path before relying on absence.)
```

### 4.6 Grep Tool

不修改 `Ripgrep.search()`。只调整 `packages/opencode/src/tool/grep.ts` 的结果消费顺序：

1. timeout-empty 继续优先使用现有 timeout 文案。
2. partial-empty 在普通 `empty` 前返回 incomplete 文案。
3. complete-empty 保持精确 `No files found`。
4. nonempty 继续使用现有匹配格式和既有 partial warning。
5. 所有 completed 分支增加 `metadata.partial`；保留 `matches`、`totalMatches`、`truncated`、`timedOut` 的既有含义。
6. 不修改 post-search stat、排序、64 条限制或 timeout 语义。

### 4.7 Compaction Search History

`packages/opencode/src/session/compaction.ts` 的 `renderSearchHistory()` 在原始 Tool output 被清除后成为模型可见的搜索证据。它必须读取 `metadata.partial`，不能把 partial-empty 重新降维成无条件的 `0`。

最小修改不增加新的状态模型，只在现有 `matches` 单元格追加标识：

```text
0 (incomplete)
```

完整搜索继续显示原数字。partial-items 同样追加 `(incomplete)`。不在本修复扩展 truncated/timedOut 的历史展示，因为它们是已有行为且不属于当前权限 false-negative。

### 4.8 classic TUI

`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`：

- Glob/Grep summary 在 `partial===true` 时追加 `incomplete`。
- 增加同文件私有谓词，仅识别 completed partial 的 Glob/Grep。
- `visiblePartIDs` 和 `ToolPart.shouldHide` 在 details 关闭时继续隐藏普通 completed Tool，但不隐藏 completed partial 的 Glob/Grep。
- fatal error 和其他 Tool 不变。

### 4.9 明确不修改的展示面

`opencode run`、Shared UI 和 `session-v2.tsx` 本次不修改。Tool output 和 metadata 已保证模型与持久化语义正确，classic TUI 覆盖用户报告的红色错误表面；其余 renderer 的 warning parity 作为后续展示任务处理，不参与 Ripgrep/Tool/Compaction 正确性。

其中 session-v2 只在 `experimentalEventSystem` 开启时作为 debug plugin 注册。未来 v2 正式替代当前 Session renderer 时，必须消费同一 `metadata.partial`。`opencode run` 和 Shared UI 当前会把 partial completed 显示成普通成功摘要，这是已知展示缺口，但不会再向模型或数据库制造错误的完整性结论。

## 5. 文件级实施计划

### 5.1 源码文件，5 个，不新增

| 文件 | 具体修改 | 预计增删 |
|---|---|---:|
| `packages/opencode/src/file/ripgrep.ts` | 增加 GlobInput/GlobResult、Interface method、`filesArgs` noMessages 选项和 bounded `glob()`；复用现有 scope/abort | `+70~110 / -5~15` |
| `packages/opencode/src/tool/glob.ts` | 消费结构化结果，保留 count/total/truncated，增加 partial 和 warning | `+25~45 / -15~30` |
| `packages/opencode/src/tool/grep.ts` | 修复 partial-empty 早退，completed metadata 增加 partial | `+15~30 / -5~15` |
| `packages/opencode/src/session/compaction.ts` | Search History 的 matches 单元格保留 incomplete 标识 | `+10~20 / -2~6` |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | partial summary 和 details=false 可见性 | `+20~35 / -4~10` |

### 5.2 测试文件，最多 5 个，不新增

| 文件 | 具体修改 | 预计增删 |
|---|---|---:|
| `packages/opencode/test/file/ripgrep.test.ts` | scripted spawner 覆盖 code2 empty/nonempty、正常、limit、参数顺序和 abort/scope | `+100~170 / -0~10` |
| `packages/opencode/test/tool/glob.test.ts` | Layer.mock 覆盖 partial-empty/items、metadata、正常空结果和 truncated | `+45~80 / -0~5` |
| `packages/opencode/test/tool/grep.test.ts` | partial-empty/items、metadata、正常空结果保持 | `+35~60 / -0~5` |
| `packages/opencode/test/session/compaction.test.ts` | complete/partial empty 和 items 的 Search History 语义 | `+35~60 / -0~5` |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | 实际字符帧覆盖 details true/false partial 和普通 completed 隐藏 | `+35~60 / -0~5` |

不修改 `message-v2.test.ts`：其通用 completed/error 回放测试已经证明 output warning 会进入模型。

### 5.3 删除和收敛

- 不删除生产文件。
- 替换 Glob Tool 中 `rg.files() + Stream.take(101)` 的旧收集块，不在其旁叠加第二套 limit。
- 将 Grep 的 partial-empty 判断放到普通 empty 之前，不保留两套互相竞争的空结果逻辑。
- 不新增公共 utility、状态机、配置、schema、迁移或生成文件。

## 6. 行为级测试计划

### 6.1 测试先行顺序

1. 在 `ripgrep.test.ts` 建立 scripted ChildProcessSpawner，先写 code `2` + empty stderr 的失败测试。当前 Interface 没有 `glob()`，测试首先以类型/行为缺口失败。
2. 增加 code `2` + invalid glob stderr 必须 fatal，防止简单吞 code `2`。
3. 在 `glob.test.ts` 先写 partial-empty/items Tool 测试。当前 Glob 只能整体失败，无法得到 completed partial。
4. 在 `grep.test.ts` 写 partial-empty 测试。当前会错误返回 `No files found`。
5. 在 Compaction 测试写 partial-empty/partial-items 的 Search History 断言。当前都会退化为普通数值。
6. 在 TUI 测试写 metadata.partial 的展示断言。当前 renderer 不显示，并且 classic details=false 会隐藏 Tool。
7. 实施最小代码后逐组转绿，再运行全量相关测试和 typecheck。

### 6.2 Ripgrep 测试矩阵

scripted handle 使用 `ChildProcessSpawner.makeHandle`，捕获 command args，不修改全局 PATH：

| stdout | stderr | code/终止 | 预期 |
|---|---|---|---|
| `a.ts` | empty | 0 | complete items |
| empty | empty | 1 | complete empty |
| `a.ts` | empty | 2 | completed partial，保留 `a.ts` |
| empty | invalid glob | 2 | failure |
| empty | empty | 3 | failure |
| 101+ lines | empty | `exitCode` 永久 pending | `glob()` 仍先返回 100 items/truncated，随后 release latch 证明 scope finalizer cleanup |
| pending | empty | AbortSignal | abort failure，scope cleanup |

命令参数断言：

- 新 `glob()` 包含 `--no-messages`。
- 不包含 `--follow`。
- `--glob=!.git/*` 在用户 `--glob=.git/config` 之前。
- 现有 `files()` 不增加 `--no-messages`，锁定其 contract 不变。

测试同步使用 Deferred/Latch 或 scripted immediate streams，不使用固定 sleep。

### 6.3 Tool 测试矩阵

Glob 和 Grep 均验证：

- complete-empty：精确 `No files found`、`partial=false`。
- partial-empty：completed、不是精确 `No files found`、含 incomplete warning、`partial=true`。
- complete-items：原有输出格式不变。
- partial-items：保留结果并追加 warning。
- fatal pattern：仍失败。
- 既有 count/total 或 matches/totalMatches/truncated 字段不变。

### 6.4 Compaction 和展示测试

- complete-empty Search History 继续显示普通 `0`。
- partial-empty 显示 `0 (incomplete)`。
- partial-items 保留计数并追加 `(incomplete)`。
- 原始 Tool output 被 compacted 后，Search History 仍保留 incomplete。

- classic TUI details=true：partial Glob/Grep 行包含 `incomplete`。
- classic TUI details=false：partial Glob/Grep 仍可见；普通 completed Tool 继续隐藏。

## 7. 错误、并发、退出、清理和安全边界

### 7.1 正常和错误路径

- code `0/1` 保持正常完成。
- code `2` 只有在 `--no-messages` 且 stderr 为空时降级为 partial。
- 任意非空 stderr 的 code `2` fail closed，避免吞 invalid glob。
- spawn/check/abort 错误保持现有失败类型。
- Tool fatal error 继续经过现有 SessionProcessor 和 Message error-text 链。

### 7.2 并发与清理

- stdout 和 stderr 继续并发消费，避免 pipe 回压。
- 自然完成后读取 exit 和 stderr。
- limit 达成后返回 bounded 结果并退出 scope，由 CrossSpawnSpawner finalizer 终止 child。
- abort 通过 `raceAbort` 中断整个 scoped program；不新增 detached fiber。
- 不触碰现有 Search timeout，因此不引入 timeout/limit 双 kill 或 JSON 尾片段的新竞态。

### 7.3 安全

- 不启用 `--follow`，避免通过 Project 内 symlink 扫描 Project 外目录。
- 不把 `Protected` 自动应用到显式 Tool 搜索，避免静默缩小用户请求。
- 不把拒绝路径正文返回模型、UI 或 metadata。
- external-directory Permission 仍在 Tool 层先于 rg 执行。
- invalid glob 保持 fatal，不能利用 partial 分类绕过输入错误。

## 8. 验证命令

所有测试从 package 目录执行：

```text
cd packages/opencode
bun test test/file/ripgrep.test.ts test/tool/glob.test.ts test/tool/grep.test.ts
bun test test/session/compaction.test.ts test/cli/cmd/tui/session-message-render.test.tsx
bun typecheck
```

实施后重新运行 bundled rg 人工验收：

```text
~/.cache/opencode/bin/rg --no-config --files --no-messages \
  "$HOME/Library/Group Containers/group.com.apple.PegasusConfiguration"

~/.cache/opencode/bin/rg --no-config --files --no-messages --glob='[' .
```

验收重点不是 shell exit 变成 0，而是 OpenCode Glob 将 empty-stderr code `2` 变为 completed partial，同时 invalid glob 仍为 Tool error。

## 9. Git 规模、生成和迁移

| 指标 | 预计 |
|---|---:|
| 源码文件 | 5 个现有文件 |
| 测试文件 | 5 个现有文件 |
| 新增文件 | 0 |
| 删除文件 | 0 |
| insertions | 约 400 至 685 |
| deletions | 约 30 至 90 |
| 总 churn | 约 430 至 775 行 |
| 硬上限 | 1,000 行；超过即暂停复审 |

不涉及：

- SDK/OpenAPI 生成。
- Tool 参数 snapshot。
- 数据库 migration。
- Config schema。
- HTTP schema。
- ADR。
- 新说明文档。

## 10. 未采用方案

### 10.1 修改现有 `files()` 直接吞 code `2`

不采用。它会让 File index、Skill 和 debug 调用方静默接受不完整结果，又没有结构化途径知道 partial。

### 10.2 为 `files()` 增加 callback 输出 partial

不采用。可变 callback 会污染 streaming API，并把终态信息放到 Stream 外部，不符合现有 Effect service 设计。

### 10.3 统一重构 Search/Glob 的取消状态机

不采用。当前权限问题不由 timeout 或 kill 失败引起；现有 scoped cleanup 已满足 bounded Glob 的需求。重写会扩大竞态和测试范围。

### 10.4 接通 Protected 或增加平台黑名单

不采用。固定列表无法覆盖 ACL、企业策略和网络盘，也会改变显式搜索范围。partial 是正确性机制，黑名单只能是后续性能策略。

### 10.5 修改 session-v2、其他展示面或主线 core/v2

不采用。session-v2 是 experimental debug，`opencode run` 和 Shared UI 属于展示 parity，origin/dev 是独立迁移线。把它们加入当前核心正确性修复会超过用户限定并制造无关冲突。

### 10.6 只改 UI 或只折叠错误

不采用。数据库和模型仍会收到巨大 error，已枚举的可用结果仍被丢弃。

## 11. 风险和开放问题

### 11.1 已接受的边界

- 达到结果上限后只报告 truncated，不继续等待 exit 来判断 partial。结果已经明确不完整，没有必要延长扫描或增加 kill 协调。
- `opencode run`、Shared UI 和 session-v2 debug renderer 暂不显示 partial。它们不参与模型和持久化正确性；展示 parity 后续单独处理。

### 11.2 实施时的停止条件

出现以下任一情况应停止实施并重新评审：

1. 需要修改第 6 个源码文件或第 6 个测试文件。
2. 总 churn 预计超过 1,000 行。
3. 需要改变 `Ripgrep.files()` contract。
4. 需要修改 Search timeout、CrossSpawnSpawner、HTTP/SDK/schema 或数据库。
5. bundled rg 升级后不再满足“`--no-messages` 隐藏 I/O 错误但保留 pattern 错误”的已验证行为。

## 12. 推荐方案摘要

推荐以 `Ripgrep.glob()` 作为唯一新 seam，在 `ripgrep.ts` 内复用现有参数、spawner、scope 和 abort 逻辑，保留 `files()` 的所有既有调用方。Glob 使用 `--no-messages`，只把 empty-stderr code `2` 解释为 completed partial；非空 stderr 和未知错误继续 fail closed。Glob/Grep Tool 同时把 partial 写入模型 output 和开放 metadata，Compaction Search History 保留 incomplete，classic TUI 显示简短状态。

该设计不新增文件、不修改公共 HTTP/SDK/数据库、不接入 Protected、不重写 cancellation，预计 5 个源码文件、5 个测试文件和 430 至 775 行总 churn。它覆盖当前 Mac/Windows 数据库已经证明的真实问题，同时把次要展示 parity、experimental v2 和主线迁移保留为明确后续，而不将其包装成当前权限修复的必要前置。

## 13. 独立审计记录

方案在写入本文档后交由独立 subagent 读取当前工作树、本文档和相关源码进行全范围审计。

第一轮发现两个阻塞项：

1. Compaction Search History 会把 partial-empty 重新表示为确定性 `0 matches`。
2. bounded Glob 必须明确禁止 sentinel 分支等待 stderr completion 或 `exitCode`，否则 scope finalizer 无法运行。

方案随后整体回退重建：将 Compaction 纳入 5 个源码文件范围，并补充 pending `exitCode` + release latch 的控制流不变量和测试。第二轮按相同范围复审，结果为：

```text
NO BLOCKING FINDINGS
```

第二轮 release checklist 对目标、实现、错误分类、并发清理、安全、测试、兼容和规模均判定为 PASS。审计没有修改任何代码或文档；本文档中的状态更新只记录审计结果，不改变被审计的设计方案。

## 14. 实施与复核记录

实现按本文档限定完成，未新增文件、依赖、配置、schema、migration、SDK/OpenAPI 或生成文件。TDD 红灯分别复现了缺失 Glob seam、Glob partial-empty、Grep partial-empty、Compaction 确定性零结果、classic TUI completed partial 隐藏，以及 timeout + partial metadata 覆盖问题，再逐条实施转绿。

最终验证：

```text
cd packages/opencode
bun test test/file/ripgrep.test.ts test/tool/glob.test.ts test/tool/grep.test.ts \
  test/session/compaction.test.ts test/cli/cmd/tui/session-message-render.test.tsx \
  test/session/message-v2.test.ts test/tool/parameters.test.ts
# 276 pass, 0 fail, 16 snapshots, 609 expect() calls

bun typecheck
# pass

git diff --check -- <本任务 10 个源码/测试文件>
# pass
```

实现完成后交由新的独立 subagent 直接审查当前 Git diff、源码和测试。复核结果为：

```text
NO BLOCKING FINDINGS
```

独立复核重新运行核心 5 个测试文件，结果为 `165 pass, 0 fail`，并确认 typecheck、diff check、5 个生产文件、5 个测试文件、低于 1,000 行的任务独立 churn，以及约 16.1% 的中文解释性注释比例均满足要求。测试中的 DataPathsManager listener warning 为既有非阻塞提示，没有失败或本任务引入证据。
