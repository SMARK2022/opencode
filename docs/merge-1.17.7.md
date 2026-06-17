# SMARK 分支合并 1.17.7 逐提交保留审查

审查时间：2026-06-16

审查目标：逐一核对 `smark/dev-smark` 自分支创建以来相对 `upstream/dev` 的非 merge 自有提交是否在当前 `dev` 合并结果中体现，避免功能退化或降级。

审查基准：`git log --no-merges upstream/dev..HEAD`，共 326 条非 merge 提交；merge commit 已排除。

当前仓库状态：合并冲突已解决；本文档为本轮审查新增记录，后续恢复改动仍需最终检查并按需 stage/commit。

说明：表格保留 `git log` 的逆时间顺序，但覆盖范围从最早 2026-04-21 到最新 2026-06-15。`packages/opencode/src/cli/cmd/tui/**` 中大量实现已迁移到 `packages/tui/src/**`，旧路径多为兼容 re-export；证据优先记录当前真实实现路径。

## 状态定义

| 状态 | 含义 |
|---|---|
| 保留 | 当前合并结果中有明确实现或测试证据，功能未见退化。 |
| 上游等价覆盖 | 旧实现形态被上游或后续本地重构替代，但核心意图仍等价保留。 |
| 部分保留-风险 | 可确认核心实现存在，但仍有子意图、边界或测试证据不足。 |
| 未体现-风险 | 当前合并结果中未找到对应行为，存在明确退化或缺口。 |
| 版本号历史不适用 | 版本号、模型快照等历史状态已被后续版本覆盖，不应按旧值保留。 |

## 风险摘录

| 风险等级 | commit | 结论 | 后续建议 |
|---|---|---|---|
| 低 | `990ddcb47d` | 已恢复手动 compact 的启动 toast、`throwOnError` 与失败 toast。 | 已通过 TUI/opencode typecheck 与 focused opencode 测试。 |
| 低 | `56bce83a05` | 已恢复 read 默认 400 行、24 KiB，并移除 2000 字符单行截断。 | `test/tool/read.test.ts` 已通过。 |
| 低 | `59b83d40cd` / `8304c6752c` | 已同步 core V2 `ToolOutputStore` 为 1000 行/16 KiB；read 保留 24 KiB 源码读取预算。 | `packages/core/test/tool-output-store.test.ts` 已通过。 |
| 低 | `bba9c227df` | 已补回 TUI sync fixture cleanup：测试结束调用 EventSource disposer，并在 finally 中 detach OpenTUI engine。 | focused TUI sync/session render 测试已通过。 |
| 低 | `d86901da7c` | 已复核并补修 Windows/daemon 竞态：flock atomic rename release、desktop shell-env lazy logger 已在当前实现；missing WAL 不再阻断 daemon 首次启动；global SSE 断开按 request/socket close 更新 client count。 | `test/util/flock.test.ts`、`test/database-migration.test.ts`、`test/cli/tui/daemon.test.ts` 已通过。 |
| 低 | `1efc5c8a2a` | 图片/媒体路径已补跑 image/read 边界测试，当前 image pipeline 与 read 附件处理未见退化。 | `test/image/image.test.ts test/tool/read.test.ts` 已通过。 |
| 低 | `b29f35a0c3` | 初步审查误判缺失；复核确认 `session-ses_1837.md` 存在。 | 无需恢复。 |
| 低 | `abd9240ff8` | 复核确认 SDK SSE 首事件 timeout 为 10 seconds。 | 无需处理。 |
| 低 | `5022026137` | 复核确认 shell 在返回前 `Fiber.join(output)`，等待最终输出/metadata。 | 无需处理。 |
| 低 | `39f6ad23cb` | 复核确认 request_usage missing request 返回 `HttpApiError.NotFound`，Slot dispose 保留。 | 无需处理。 |

## 详细逐提交记录

### 批次 A：2026-05-02 到 2026-04-21

| hash | subject 精简 | 原始改动意图 | 当前合并结果证据 | 状态 | 备注 |
|---|---|---|---|---|---|
| `59b83d40cd` | max lines 2000→1000 | 调整 `Truncate.MAX_LINES`、Read 默认行数、配置/SDK 描述，减少工具输出上下文。 | `packages/opencode/src/tool/truncate.ts` 与 `packages/core/src/tool-output-store.ts` 均为 `MAX_LINES = 1000`；read 默认行数恢复为 400。 | 保留 | Shell/truncate 与 core V2 输出边界已同步；read 保留更宽源码读取行数。 |
| `8304c6752c` | max bytes 51200→24576 | 降低工具输出/Read 字节上限，优化内存。 | `packages/opencode/src/tool/truncate.ts` 与 `packages/core/src/tool-output-store.ts` 均为 16 KiB；read 源码读取预算恢复为 24 KiB。 | 保留 | 工具结果投影采用 16 KiB；源码 read 预算保留 `56bce83a05` 的 24 KiB 意图。 |
| `b4bf93f8cb` | 实时 token 估算 | TUI token 估算从服务端/历史 step-finish 获取更准输入 token。 | `packages/tui/src/token/accounting.ts` 使用 `step-finish`、`inputBreakdown`、`totalInput/totalOutput`；`packages/opencode/test/cli/tui/token-estimate.test.ts` 覆盖。 | 保留 | 旧 `packages/opencode/src/cli/cmd/tui/util/token-estimate.ts` 已迁移到 `packages/tui/src/**`。 |
| `1f2d2e958b` | request usage API | 新增 request usage API schema/handler/service 层，暴露请求与 assistant usage。 | `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`、`packages/opencode/src/session/request-usage.ts`、`packages/opencode/src/session/request-usage.sql.ts`。 | 保留 | API 与数据结构均在当前合并结果中。 |
| `40e2013bd4` | daemon 超时常量 | 将 daemon 启动/选举超时抽为常量并延长启动等待。 | `packages/tui/src/daemon.ts` 定义 `DAEMON_START_TIMEOUT_MS`、`SERVER_ELECTION_TIMEOUT_MS`。 | 保留 | 路径迁移到 `packages/tui`。 |
| `145dea7da6` | compaction buffer 默认值 | `overflow.usable` 根据 provider reserve 计算更合理 compaction buffer，至少 5000。 | `packages/tui/src/util/context-usage.ts` 使用 `Math.max(5_000, 20_000 - providerReserve)`。 | 上游等价覆盖 | UI/context usage 保留同口径。 |
| `2e51523e55` | Unicode 宽度/macOS terminal 初始化 | macOS 强制 Unicode 宽度并等待 stdout columns 初始化。 | `packages/tui/src/app.tsx` 设置 `OPENTUI_FORCE_UNICODE`，darwin 等待 `process.stdout.columns`。 | 保留 | 后续 `dbfd53e1cd` 为同类补丁。 |
| `1efc5c8a2a` | sharp optional/media 类型 | 增加 `sharp` optional dependency，改进 `media.ts` 类型处理。 | `packages/opencode/package.json` 有 `optionalDependencies.sharp`；`packages/opencode/src/util/media.ts` 保留 mime sniff/formatSize。 | 部分保留-风险 | `sharp` 依赖保留；原 `media.ts` 中 sharp 处理已迁入 `packages/opencode/src/image/image.ts`，等价性需补测。 |
| `dbfd53e1cd` | 强制 Unicode 宽度 | 解决 macOS CJK 渲染宽度。 | `packages/tui/src/app.tsx`。 | 保留 | 与 `2e51523e55` 合并体现。 |
| `3a94dd4d09` | pending message 状态检查 | pending assistant 仅在 session 非 idle 时显示。 | `packages/tui/src/util/session-pending.ts` 的 `pendingAssistantID(messages,status)`。 | 保留 | 从组件内逻辑抽到 util。 |
| `0734b2e81c` | version/env/plugin warmup | 版本 bump；优化 daemon env、延长启动、插件预热。 | `packages/opencode/package.json` 当前版本 `1.17.7-smark`；`packages/opencode/src/cli/tui/worker.ts` 插件 warmup；`packages/tui/src/daemon.ts` env/proxy。 | 部分保留-风险 | 版本 bump 属历史不适用；功能项保留。 |
| `0a0eb2e94e` | Windows PowerShell UTF-8 | PowerShell 输出编码设置 UTF-8。 | `packages/opencode/src/tool/shell.ts` 设置 `[Console]::OutputEncoding` 和 `$OutputEncoding`；`test/tool/bash-compress.test.ts` 覆盖 CLIXML/PowerShell 正规化。 | 保留 | 当前工具名为 shell，旧 BashTool 迁移。 |
| `d09a5763d2` | post-merge fixes | Windows cross-drive `contains` 修复、测试期望调整。 | `packages/core/src/fs-util.ts` 用 `isAbsolute(result)`；`packages/opencode/test/agent/agent.test.ts` 期望 interactive。 | 保留 | 文件从 `filesystem.ts` 迁移为 `fs-util.ts`。 |
| `e3bbe56b86` | 防模型选择重置 | Prompt 初始化避免异步 messages 加载/重挂导致模型被重置。 | `packages/tui/src/component/prompt/index.tsx` 注释明确 Bug A，使用非订阅读取避免 messages 加载触发。 | 保留 | 当前代码含原始问题说明。 |
| `a6e3b3cdaf` | TUI proxy env | TUI daemon env 代理处理更清晰，避免 loopback 被代理。 | `packages/tui/src/daemon.ts` 的 `applyProxyEnv` 和 TUI 自身 `NO_PROXY`。 | 保留 | 区分 win32/darwin 与 Linux。 |
| `841752f540` | billing header/tool order | 修正 claudecode billing header 注释、系统 prompt 工具输出顺序。 | `packages/opencode/src/provider/claudecode.ts`；`packages/opencode/src/session/system.ts` 工具使用指导。 | 部分保留-风险 | 相关区域保留，但原 billing header block 具体 patch 未完全等价可见。 |
| `f40e2d3695` | 摘要模板 | 强化 compaction summary 模板结构、用户目标/约束。 | `packages/opencode/src/agent/prompt/compaction.txt` 强调 recovery snapshot、constraints、exact output structure。 | 上游等价覆盖 | 当前模板不同于旧中文 subject，但意图保留。 |
| `90c84e172f` | tool timeout/expiry | 调整工具 timeout/过期、工具定义处理和错误处理。 | `packages/tui/src/daemon.ts` startup timeout；`packages/opencode/src/tool/shell.ts` timeout 校验；`packages/tui/src/util/context-usage.ts` 当前工具定义估算。 | 部分保留-风险 | 多处已迁移；未能逐项确认旧 `server-lock/thread/worker/context-usage` 的每个错误处理分支完全等价。 |
| `f9d2e647d8` | 工具/Git 安全指导 | 增强工具使用说明、Git 安全协议、多工具建议。 | `packages/opencode/src/session/system.ts`；`packages/opencode/src/tool/shell/shell.txt`。 | 保留 | 当前提示词中 Git Safety Protocol 明确存在。 |
| `e6094d52b0` | daemon lifecycle/server lock | 实现共享 daemon、server lock、生命周期管理。 | `packages/tui/src/daemon.ts`；`packages/tui/src/server-lock.ts`；`packages/opencode/src/cli/tui/worker.ts`。 | 保留 | 当前架构更完整，含 control port/status/stop。 |
| `f13fd00acf` | context output 统计 | 修正 context usage 输出计算和测试。 | `packages/tui/src/token/accounting.ts`；`packages/opencode/test/cli/tui/context-usage.test.ts`。 | 保留 | 当前以 step-finish/assistant tokens 计算。 |
| `6380ed0b8d` | Read 去重缓存/预热 | 文件 read 去重 key 到 offset/limit，跳过 stub，历史预热。 | `packages/opencode/src/tool/read.ts` 用 metadata/visible reads/stub，并进行 warm。 | 上游等价覆盖 | 原全局 cacheSeeded 方案已重构为 metadata 可见上下文判定。 |
| `d653e1fc1b` | 工具指导+context usage 测试 | 新增 context usage 面板/计算和工具指导测试。 | `packages/tui/src/routes/session/context-usage.tsx`；`packages/tui/src/util/context-usage.ts`；`packages/opencode/test/cli/tui/context-usage.test.ts`。 | 保留 | 路径迁移到 `packages/tui`。 |
| `630dd66666` | DB durable/retry/tool input buffer | 增加 `OPENCODE_DB_DURABLE`、DB WAL/timeout、更少 DB 写入、网络异常 retry。 | `packages/core/src/database/database.ts`；`packages/core/src/flag/flag.ts`；`packages/opencode/src/session/processor.ts`；`session/retry.test.ts` 网络/timeout/statusless 边界。 | 保留 | 普通 statusless API error 仍不重试；真实网络/transport 错误经转换后重试，focused retry tests 已通过。 |
| `16656033a6` | BashTool config service | BashTool 配置服务引用简化，避免过早取 InstanceState。 | `packages/opencode/src/tool/shell.ts` 执行时读取 config/compression/encoding。 | 保留 | 工具已从 BashTool 重构为 shell tool。 |
| `990ddcb47d` | compact async/toast/error | compact 选择改 async，增加 loading toast 和错误处理。 | `packages/tui/src/routes/session/index.tsx` 中 compact action 已恢复 `toast.info`、`throwOnError: true` 与 catch error toast。 | 保留 | 手动 compact 不再静默失败。 |
| `8f6444e154` | build workflow DEB 格式 | 清理 build workflow 空行，修正 Debian control 格式。 | `.github/workflows/build-opencode.yml` control heredoc + `sed -i` 去缩进。 | 保留 | 与后续 `0e50e973aa` 合并。 |
| `0e50e973aa` | Windows build deps | 增加 node-gyp/setup-node/python/msbuild，修正 DEB indent。 | `.github/workflows/build-opencode.yml` setup-node/setup-python/setup-msbuild/bun install；root `package.json` postinstall。 | 保留 | Windows 构建依赖步骤保留。 |
| `d870520f12` | 多平台 workflow 自动触发 | dev-smark push 自动触发多平台构建。 | `.github/workflows/build-opencode.yml`。 | 保留 | macOS/Linux/Windows jobs 均存在。 |
| `20058ecde9` | 新增 CLI build workflow | 构建打包 Linux/macOS/Windows OpenCode CLI。 | `.github/workflows/build-opencode.yml` 全文件，含 release assets/checksums/upload。 | 保留 | 当前 workflow 完整存在。 |
| `1e324d225d` | diff 行统计 | 差异视图显示 +/- 行统计。 | `packages/tui/src/routes/session/index.tsx`；`feature-plugins/sidebar/files.tsx`。 | 保留 | 多处显示 additions/deletions。 |
| `0a3cda97c0` | scroll-view 交互/展开 | 更新 scroll view 与 session turn 展开/收缩显示。 | `packages/ui/src/components/scroll-view.tsx/css`；`packages/tui/src/util/smooth-scrollbar.ts`；`routes/session/index.tsx`。 | 部分保留-风险 | TUI 平滑滚动/marker 保留；web UI 原 session-turn/scroll-view 动态展开是否完全等价未逐项确认。 |
| `90b112f8bb` | final token 计算 | 修复最终 token 的 input/totalInput 逻辑。 | `packages/tui/src/token/accounting.ts`；`packages/opencode/test/cli/tui/token-estimate.test.ts`。 | 保留 | 当前有 step-finish arrives before message token update 的测试。 |
| `6dd9afdea4` | interactive/reviewer agent | 新增 interactive、permission-reviewer agent，增强权限描述。 | `packages/opencode/src/agent/agent.ts`。 | 保留 | reviewer 为 hidden subagent，权限只允许 `permission_review_decision`。 |
| `b815a5764d` | Bash 高熵压缩/诊断 | 增强 bash 压缩：高熵行、诊断上下文。 | `packages/opencode/src/tool/bash-compress.ts`；`packages/opencode/src/tool/shell.ts` diagnostic appendix。 | 保留 | 功能大量保留并扩展。 |
| `6285c07412` | Flag import path | 适配上游 Flag 模块路径重构。 | 当前多处使用 `@opencode-ai/core/flag/flag`，如 `packages/opencode/src/session/system.ts`、`packages/tui/src/app.tsx`。 | 保留 | 路径已统一到 core。 |
| `98ebae3df2` | Windows 管道乱码 | Windows shell 管道输出乱码兼容。 | `packages/opencode/src/tool/shell.ts` 使用 auto text decoder/encoding；`util/text-decoding` 被引用。 | 保留 | 与 UTF-8/CLIXML 正规化共同保留。 |
| `06d4a50185` | 新 prompt 文件/工具指南 | 增加 deepseek/minimax 等 prompt，强化工具指导。 | `packages/opencode/src/session/system.ts`；`packages/opencode/src/session/prompt/deepseek.txt`、`minimax.txt` 存在。 | 保留 | provider prompt 选择保留。 |
| `ab8ce2ad44` | Bash 输出压缩配置 | 增加 bash output compression、配置项、SDK 类型。 | `packages/opencode/src/tool/bash-compress.ts`；`packages/opencode/src/tool/shell.ts`；`packages/sdk/js/src/v2/gen/types.gen.ts`。 | 保留 | 当前工具参数为 `compress_output`。 |
| `7dc9f1ab53` | prompt/tool 指令重构 | 提示词和工具说明一致性、执行指导优化。 | `packages/opencode/src/session/system.ts`；`packages/opencode/src/tool/shell/shell.txt`；`task.txt`。 | 保留 | 后续多次提示词变更覆盖但意图保留。 |
| `13fd8ab5dc` | 完整提示词并行调用 | 更新多模型 prompt，强化并行工具调用一致性。 | `packages/opencode/src/session/system.ts` 批量/并行调用规则；多个 `session/prompt/*.txt` 存在。 | 保留 | 当前规则集中在 shared system section。 |
| `634fdbefd2` | 粘贴占位符替换 | 粘贴文本虚拟占位符正确替换原文，修坐标不匹配。 | `packages/tui/src/prompt/part.ts`；`packages/tui/src/component/prompt/index.tsx`。 | 保留 | 有 `expandPastedTextPlaceholders/expandTrackedPastedText`。 |
| `5a7f139b02` | 输入/系统块合并 | 优化输入文本处理、系统块合并，保留字段。 | `packages/opencode/src/session/llm/request.ts` 合并 system blocks；`packages/tui/src/component/prompt/index.tsx` 粘贴/输入处理。 | 保留 | LLM request 层有明确合并逻辑。 |
| `b2b12b0abf` | provider extends/claude header | provider 支持 `extends` 继承模型/默认值，并加 Claude header。 | `packages/core/src/v1/config/provider.ts`；`packages/opencode/src/provider/alias.ts`；`provider/claudecode.ts`。 | 保留 | V1 provider config 保留 `extends`；V2 provider config 未见该字段。 |
| `17b46ab162` | compact duration format | 增加 compact duration 格式化，优化时间显示。 | `packages/tui/src/util/locale.ts`；`routes/session/index.tsx`。 | 保留 | 当前有 `duration` 与 `durationClock`。 |
| `b94a795278` | 输入/overhead 估算 | 增加用户输入和请求开销估算，优化 context 管理。 | `packages/opencode/src/token/estimate.ts`；`packages/tui/src/token/estimate.ts`、`accounting.ts`。 | 上游等价覆盖 | 当前估算边界重构为 `TokenEstimate` 与 persisted snapshot。 |
| `aa6db0f326` | system prompt env/git | 增强 system prompt：环境信息、工具指南、git 上下文。 | `packages/opencode/src/session/system.ts` env/git 与工具/安全指导。 | 保留 | 当前 prompt 还包括 shell/OS/date/model 信息。 |
| `4b7f10eebc` | version 1.14.20-smark | 版本号历史 bump。 | 当前 `packages/opencode/package.json` 为 `1.17.7-smark`。 | 版本号历史不适用 | 后续版本覆盖。 |
| `50eeb8a6c4` | version 1.14.21-smark | 版本号历史 bump。 | 当前 `packages/opencode/package.json` 为 `1.17.7-smark`。 | 版本号历史不适用 | 后续版本覆盖。 |
| `59dd32a7c7` | request usage tracking | 新增 request_usage 表、CLI stats/session 展示、服务层记录。 | `packages/opencode/src/session/request-usage.ts`；`request-usage.sql.ts`；`cli/cmd/session.ts`；`cli/cmd/stats/data.ts`。 | 保留 | 功能仍是当前重要本地改动。 |
| `9e14f85c9a` | lastStepFinish | 修复 lastStepFinish 索引有效时取 step-finish。 | `packages/tui/src/token/accounting.ts` 使用 `findLastIndex` 和 `stepSF`；`token-estimate.test.ts` 覆盖。 | 保留 | 当前逻辑比旧组件内实现更集中。 |
| `d302fa6f05` | claudecode 动态鉴权 | claudecode provider 支持动态 auth/baseURL/API key。 | `packages/opencode/src/provider/provider.ts` 按 `ANTHROPIC_AUTH_TOKEN` 选择 bearer，按 `CLAUDECODE_API_KEY`/auth/options 选择 x-api-key；`provider/claudecode.ts` 执行对应 header。 | 保留 | provider/retry focused tests 已通过。 |
| `61bcd2aae6` | 无 assistant usage 为 0 | 请求助手输入输出统计在无 assistant 时返回 0。 | `packages/tui/src/token/accounting.ts`；`feature-plugins/sidebar/context.tsx` 无 last/lastUser 返回 0；`token-estimate.test.ts`。 | 保留 | UI 层已防空。 |
| `bbbf5f1dd9` | claudecode provider | 增加 claudecode provider 支持。 | `packages/opencode/src/provider/claudecode.ts`；`packages/opencode/src/provider/provider.ts`。 | 保留 | provider 文件仍存在。 |
| `b1bf9c5a50` | 总输入输出统计 | 添加 total input/output，优化 assistant message 统计。 | `packages/tui/src/token/accounting.ts`；sidebar 显示 `totalInput/totalOutput`。 | 保留 | 当前 UI 显示 input/output total。 |
| `589bb20e90` | version env --version | build 支持 `--version` 设置 `OPENCODE_VERSION`。 | `packages/opencode/script/build.ts`。 | 保留 | 单独 `version-env.ts` 已消失，但功能内联保留。 |
| `fc63945230` | token flow pulse | 增加 token 流动状态 pulse。 | `packages/tui/src/util/signal.ts`；`component/prompt/index.tsx`；`subagent-footer.tsx`。 | 保留 | input/output 增长时 pulse。 |
| `5b4ab2741b` | tool_delta token 计算 | assistant/tool_delta token 计算、无 assistant 显示 0、总 IO。 | `packages/tui/src/token/accounting.ts` live breakdown；`packages/opencode/src/session/processor.ts` tool input delta buffering/part delta。 | 保留 | 当前以 `inputBreakdown`/live chars 推导。 |
| `4d3c3d4e54` | build os filter | build 脚本支持 OS 过滤。 | `packages/opencode/script/build.ts` `--os/--arch`；workflow 使用对应参数。 | 保留 | 当前 workflow 依赖此功能。 |
| `984de21dfb` | version env load | 模块评估时设置 `OPENCODE_VERSION`。 | `packages/opencode/script/build.ts`。 | 上游等价覆盖 | 原 `script/version-env.ts` 不存在，但 build-time define 保留版本注入。 |
| `bb43016295` | usage 无回复为 0 | 无回复时 usage 计算显示 0。 | `packages/tui/src/feature-plugins/sidebar/context.tsx`。 | 保留 | 和 `61bcd2aae6` 合并体现。 |
| `6c994e2db3` | throttled signal/tool output chars | 添加 throttled signal，context/subagent usage 支持工具输出字符估算。 | `packages/tui/src/util/signal.ts`；`routes/session/context-usage.tsx`；`util/context-usage.ts`。 | 保留 | 当前节流与 usage 面板均存在。 |
| `bc7a6f1778` | git context 调用修复 | 修复获取 git context 的调用方式。 | `packages/opencode/src/session/system.ts` 使用 `git.branch/status/run([...],{cwd})`。 | 保留 | 当前并行采集 git 字段。 |
| `a461c299ff` | usage IO 流量显示 | 消息 usage 增加输入/输出流量显示。 | `packages/tui/src/feature-plugins/sidebar/context.tsx`；`component/prompt/index.tsx`。 | 保留 | UI 显示 input/output 与 total。 |
| `cebacb4b15` | read 设备保护/恶意提醒 | Read 增加设备文件保护和高风险文件提醒。 | `packages/opencode/src/tool/read.ts` 有 `BLOCKED_DEVICE_PATHS`、`HIGH_RISK_EXTENSIONS`；高风险提醒目前被注释。 | 保留 | 设备保护保留；恶意提醒按后续提交注释。 |
| `9f117055c5` | ClaudeCode-like git context | 添加 git context 和配置选项逻辑。 | `packages/opencode/src/session/system.ts`；`packages/core/src/flag/flag.ts` 含 git/config 相关 flag。 | 保留 | 当前 env block 含 branch/default/status/recent commits。 |

### 批次 B：2026-05-08 到 2026-05-03

| hash | subject 精简 | 原始改动意图 | 当前合并结果证据 | 状态 | 备注 |
|---|---|---|---|---|---|
| `6e38594c33` | 会话列表预览 2 行 | 将 session list 预览行数从 1 增至 2。 | `packages/tui/src/component/dialog-session-list.tsx` 中 `SESSION_LIST_PREVIEW_LINES = 2`。 | 保留 | 代码已迁移到 `packages/tui`。 |
| `51a0d39deb` | provider alias 多身份 | 支持 provider `extends` 别名、独立 auth、模型继承与 hook 映射。 | `packages/opencode/src/provider/alias.ts`；`provider.ts` 的 `runWithAlias`/`buildBaseProviderMap`；`plugin/index.ts` 的 alias hook。 | 保留 | 别名上下文、auth 重写、provider/model hook 映射均存在。 |
| `c48d9fa92` | 默认会话标题 | 抽出默认标题创建/校验，避免误改非默认标题。 | `packages/opencode/src/session/title.ts`；`session.ts` 创建时调用；`prompt.ts` 标题更新前校验。 | 保留 | 标题逻辑完整保留。 |
| `c3c396034a` | DialogSelect 预览行 | `DialogSelectOption` 支持 `previewLines`，滚动/高度计入预览。 | `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` 中 `previewLines?: string[]`、`rows()` 统计 preview 行。 | 保留 | 当前仍在旧路径兼容层；session list 使用迁移后的 TUI 组件。 |
| `a6a79e01fb` | BlockTool 折叠优化 | 用 memo/signal 同步判断可折叠，减少首次渲染重成本。 | `packages/tui/src/routes/session/index.tsx` 中 `BlockTool` 使用 `createMemo` 的 preview/threshold/collapsible/collapsed。 | 保留 | 当前还有避免大 diff 首帧 mount 成本的注释。 |
| `b6690c2cc8` | VSIX 打包/版本 1.14.32 | 更新 VSCode 扩展版本并改 VSIX 打包避免 Windows npm 路径问题。 | `sdks/vscode/package.json` 当前 `version=1.15.5`，`scripts.vsix="bun run package && bun ./script/vsix.ts"`；`sdks/vscode/script/vsix.ts`。 | 版本号历史不适用 | 打包逻辑保留并演进；旧版本号被后续版本替代。 |
| `14d55305ba` | 版本 1.14.32-smark/平滑滚动条 | 更新 CLI 版本并添加/使用平滑滚动条渲染。 | `packages/opencode/package.json` 当前 `1.17.7-smark`；`packages/tui/src/util/smooth-scrollbar.ts`；`routes/session/index.tsx` 调用 `drawSmoothScrollbar`。 | 版本号历史不适用 | 版本号被后续覆盖；滚动条功能保留。 |
| `e863ec3483` | TUI 宽度/Win 插件路径/Win 测试 | macOS/Windows 终端宽度处理、插件 file URL 路径修正、Windows 测试适配、权限错误码扩展。 | `packages/tui/src/app.tsx` 处理 mac/darwin width 与 `OPENTUI_FORCE_UNICODE`；`plugin/loader.ts` 处理 Win `fileURLToPath(...).replaceAll("\\", "/")`；测试中有 win32 分支。 | 部分保留-风险 | 主要 TUI/loader/测试适配保留；权限源码中“更多错误码”的明确证据不足。 |
| `f0f0c3a6dd` | Prompt `renderBefore` | 用 `renderBefore` 在 box 渲染前测量宽度，优化布局/usage 显示。 | `packages/tui/src/component/prompt/index.tsx` 中 `syncPromptWidth` 与 `<box ... renderBefore={syncPromptWidth}>`。 | 保留 | 迁移到 `packages/tui` 后仍保留。 |
| `ed792909b7` | `includeHidden` 过滤 | 消息分页/流式读取支持是否包含隐藏消息。 | `packages/opencode/src/session/message-v2.ts` 中 `page({ includeHidden })`、`stream(sessionID,{includeHidden})` 与 hidden message/part 过滤。 | 保留 | 当前默认 `stream` 包含 hidden，显式 `false` 过滤。 |
| `e8675ce415` | VSCode notebook 编辑增强 | 增强 cellId 解析、编辑错误提示、source/summary 展示。 | `sdks/vscode/src/notebook/edit.ts` 的 `resolveNotebookCell`、oldCode 唯一匹配错误提示；`format.ts/source.ts/summary.ts`。 | 保留 | notebook 编辑链路存在且更完整。 |
| `d00a0ceaca` | CI 自动版本/资产上传 | build workflow 自动取版本、生成 tag、上传 release assets。 | `.github/workflows/build-opencode.yml` 中 `jobs.version`、`Create release if missing`、`Upload release assets with retry`。 | 保留 | 当前 workflow 已扩展到多平台资产。 |
| `74a9ca56ea` | Windows 构建架构 | build 脚本支持 Windows 架构过滤，workflow 调用 Windows x64。 | `packages/opencode/script/build.ts` 支持 `--os`/`--arch`、`win32 arm64/x64` targets；workflow 使用 `--os=win32 --arch=x64`。 | 保留 | Windows x64 打包仍在。 |
| `ad41ba3737` | `poe-oauth` 0.0.6 override | 升级/锁定 `poe-oauth`，避免依赖问题。 | 根 `package.json` 中 `overrides.poe-oauth = "0.0.6"`。 | 保留 | override 明确存在。 |
| `d2a0ec015c` | notebook run/env 选项 | VSCode notebook run/environment 参数和 cellId 解析增强。 | `packages/opencode/src/plugin/vscode-bridge.ts` 注册 `vscode_notebook_run`、`vscode_notebook_env` schemas；`sdks/vscode/src/notebook/run.ts`/`env.ts`。 | 保留 | 已被后续 notebook env/run 重构吸收。 |
| `06db750ab9` | hoisted linker/删废依赖 | 使用 Bun hoisted linker，清理废弃依赖/CI 安装。 | `bunfig.toml` 中 `linker = "hoisted"`；workflow Windows 使用 `bun install --linker hoisted`。 | 保留 | 当前仍使用 hoisted。 |
| `707d679466` | agent notebook 权限/usage | 增加 VSCode notebook 权限选项、计划模式说明、usage 统计优化。 | `agent/agent.ts` 内置 agent 权限/描述；`packages/tui/src/util/context-usage.ts` 与 `token/accounting.ts` 有细分 usage。 | 保留 | 已随 TUI package 迁移保留并扩展。 |
| `f430485822` | hidden message/undo | undo 不删除消息而标记 hidden，保留数据库记录。 | `session/revert.ts` 写入 `hidden: { reason:"undo" }`；`message-v2.ts` hidden 过滤；`test/session/revert-compact.test.ts`。 | 保留 | 当前 hidden 还用于 compaction/reviewer。 |
| `ace5c58413` | VSCode docs/命名 | README/package 描述、主页、OpenCode 表述统一。 | `sdks/vscode/package.json` 的 `displayName`/`description`/`homepage`/`publisher`；`sdks/vscode/README.md`。 | 保留 | 已更新到当前 SMARK OpenCode IDE Bridge 文案。 |
| `254082aeca` | WSL/跨平台构建文档 | 添加 WSL 迁移、VSIX 打包指南。 | `docs/OpenCode_Build_Migration_Guide.md`；`docs/VSIX-Packaging.md`。 | 保留 | 文档文件仍存在。 |
| `4dec9d1582` | 工具管理/权限合并 | 添加 TUI 工具管理对话框，权限过滤可用工具。 | `packages/tui/src/component/dialog-tool.tsx`；`tool/selection.ts`；`session/prompt.ts` 的 `ToolSelection.enabled(...)`；`session/llm/request.ts`。 | 保留 | 当前还过滤 registry/MCP/LLM request 工具。 |
| `81efcbb1d8` | notebook source 渲染 | 优化虚拟文档行范围、字节/行限制处理。 | `sdks/vscode/src/notebook/source.ts`；`format.ts`；`summary.ts`。 | 保留 | source/summary 模块仍承担该逻辑。 |
| `3ae1d112f2` | notebook env 诊断 | 增强 kernel 选择/配置诊断信息。 | `sdks/vscode/src/notebook/env.ts`；`plugin/vscode-bridge-descriptions.ts` env 描述含 status/诊断建议。 | 保留 | env 模块当前明显更完整。 |
| `2f1ab5812e` | notebook env 重构/合并 restart | 合并 kernel restart 到 env 操作并增强描述/超时。 | `packages/opencode/src/plugin/vscode-bridge.ts` 中 `operation: ["info","configure","restart","save"]`；`sdks/vscode/src/notebook/env.ts`。 | 保留 | 原独立 kernel 逻辑已被 env 重构覆盖。 |
| `124adc90ec` | 重启 Jupyter kernel | 增加 restart 操作、清运行状态、记录原因。 | `vscode-bridge.ts` 的 `operation.restart`；`vscode-bridge-descriptions.ts` restart 文档；`sdks/vscode/src/notebook/env.ts`。 | 上游等价覆盖 | 原独立 `kernel.ts` 已由 env 重构覆盖。 |
| `56bce83a05` | read 默认 400/24KB/不截长行 | 提高 read 默认行数和字节上限，移除行长截断。 | `packages/opencode/src/tool/read.ts` 为 `DEFAULT_READ_LIMIT = 400`、`MAX_BYTES = 24 * 1024`，且不再按 2000 字符截断单行；`read.txt` 同步 400/24KB。 | 保留 | `test/tool/read.test.ts` 已覆盖长行保留。 |
| `94eb97b93f` | VSCode 扩展 ID/license | 改扩展 ID、publisher、license、图标/README。 | `packages/opencode/src/ide/index.ts` 安装 `SMARK2022.opencode-ide-bridge`；`sdks/vscode/LICENSE`；`sdks/vscode/package.json` publisher/name。 | 保留 | 扩展身份仍是 SMARK2022/opencode-ide-bridge。 |
| `284c6bf166` | PowerShell CLIXML 解码 | bash-compress 检测/解码 PowerShell CLIXML。 | `tool/bash-compress.ts` 中 `transformPowerShellClixml`、`decodePowerShellClixmlPlain`、`normalizePowerShellOutput`。 | 保留 | CLIXML decode/normalize 明确存在。 |
| `930624b8fa` | VSCode bridge registry | 移除 env 桥接，增强 registry 选择。 | `packages/opencode/src/ide/vscode-bridge.ts` 的 registry resolve/scoring/cache；`sdks/vscode/src/bridge-registry.ts`。 | 保留 | 当前以 registry discovery 为主。 |
| `3c72d78b8c` | write 覆盖 diff | write 覆盖已有文件时生成 diff metadata，TUI 以 git diff 展示。 | `tool/write.ts` 的 `createTwoFilesPatch`、`metadata.diff`；`packages/tui/src/routes/session/index.tsx` 展示 preview diff。 | 保留 | write metadata diff 保留。 |
| `66ddc4e2fe` | token 估计附件影响 | token/context 估算考虑附件输入字符。 | `packages/tui/src/token/estimate.ts` 中 `AttachmentTokenEstimate`/`estimateAttachment`；`token/accounting.ts` 处理 attachments/media tokens。 | 保留 | 附件 token 独立参与 input 估算。 |
| `7759649fd1` | notebook 请求文件锁 | VSCode bridge 按文件串行化请求，优化 run。 | `sdks/vscode/src/bridge.ts` 有 per-filePath mutex 注释与路由串行；`notebook/run.ts`。 | 保留 | 文件级 mutex 仍存在。 |
| `2e8c148edf` | NetworkProxy provider/plugin fetch | 引入/增强 NetworkProxy 给 plugin/provider fetch 使用。 | `packages/core/src/network-proxy.ts`；`provider/provider.ts` 使用 `NetworkProxy.fetch`/`fetchWithRoute`；`core/src/npm.ts`。 | 保留 | 网络代理作为 core 服务保留。 |
| `afccfe84a5` | VSCode bridge 初版 | 添加 VSCode bridge，支持 summary/source/run/edit/output。 | `packages/opencode/src/plugin/vscode-bridge.ts` 工具注册；`sdks/vscode/src/bridge.ts` HTTP endpoints；`src/notebook/*`。 | 保留 | 功能已大幅扩展。 |
| `85442a1f1e` | notebook 行范围修正 | 优化虚拟文档行范围与 source 渲染效率。 | `sdks/vscode/src/notebook/source.ts`、`format.ts`、`summary.ts`。 | 保留 | 当前仍为模块化实现。 |
| `0a8361dfa4` | notebook 参数/错误处理 | 强化命令/env/run/edit/source 解析和错误处理。 | `sdks/vscode/src/notebook/commands.ts`、`edit.ts`、`env.ts`、`run.ts`、`resolve.ts`。 | 保留 | 错误提示与参数校验仍在。 |
| `8812fd3d58` | notebook edit 文档/匹配 | 增强 oldCode 字符串匹配和上下文。 | `sdks/vscode/src/notebook/edit.ts` 中 `matchAndReplace`、`buildContext`、唯一匹配错误提示。 | 保留 | 编辑匹配逻辑保留。 |
| `3bab13f27c` | notebook 工具重构 | notebook schema、summary、cell identification、output handling 大重构。 | `packages/opencode/src/plugin/vscode-bridge.ts` schemas/views；`sdks/vscode/src/notebook/{commands,edit,env,format,output,resolve,run,source,summary}.ts`。 | 保留 | 当前 notebook 子系统即该重构后的形态。 |
| `9768471cf3` | claudecode/provider thinking | 推断 Anthropic thinking 变体并扩展 provider。 | `provider/provider.ts` 中 `isAnthropicThinkingModel` 与 thinking 分支；`test/provider/provider.test.ts`。 | 保留 | provider thinking/variant 逻辑仍在。 |
| `c9d477841b` | proxy TTL/plugin exports | 调整 NetworkProxy TTL，增强插件导出处理。 | `core/src/network-proxy.ts` 中 `PROXY_TTL = 10_000`；`plugin/index.ts` 支持 default/named/server exports。 | 保留 | 逻辑保留且 plugin v1 读取更完整。 |
| `4141d5e979` | API URL 默认配置 | 为 SDK provider 增加默认 API URL，优化模型 API 获取。 | `provider/provider.ts` 中 `SDK_DEFAULT_API_URL`、`apiUrl()`、调用处 `url: apiUrl(...)`。 | 保留 | 默认 Anthropic/Google/OpenAI URL 仍存在。 |
| `4d55a2c0f4` | tool call/result 分类 | context usage 将 tool calls 和 tool results 分开。 | `packages/tui/src/token/accounting.ts` 中 `toolCalls`/`toolResults`；`routes/session/context-usage.tsx` 分类显示。 | 保留 | 分类保留。 |
| `f75419bd78` | 全局 fetch proxy/npm 超时 | 增强 NetworkProxy，安装 global fetch，npm proxy options。 | `core/src/network-proxy.ts` 中 `installGlobalFetch`、`npmProxyOptions`；`core/src/npm.ts` 调用。 | 保留 | 全局 fetch/npm proxy 能力存在。 |
| `a09787f293` | input chars + breakdown token | 结合 inputChars/inputBreakdown 改善 token 估算。 | `packages/tui/src/token/accounting.ts` 中 input chars/breakdown 分配；`src/token/estimate.ts` 中 `learnInputCharsPerToken`。 | 保留 | 当前估算体系保留并演进。 |
| `d95dc89b85` | 网络代理初版 | 引入 NetworkProxy、npm config、请求处理。 | `packages/core/src/network-proxy.ts`；`packages/core/src/npm-config.ts`；`packages/core/test/network-proxy.test.ts`。 | 保留 | 已演进为 core 网络代理模块。 |
| `efae0086f4` | IDE SDK 结构重构 | VSCode 扩展从单文件拆分到 bridge/notebook/util 等模块。 | `sdks/vscode/src/extension.ts` 仅激活/注册；`bridge.ts`；`notebook/*.ts`；`util.ts`。 | 保留 | 模块化结构仍在。 |
| `d34ed37bb4` | notebook IDE runtime 初版 | VSCode 扩展增加 notebook runtime/commands。 | `sdks/vscode/src/notebook/commands.ts`；`extension.ts` 注册 `notebookBridgeTools`；`package.json` command。 | 保留 | 后续重构保留功能。 |
| `43455e508d` | assistant reasoning 预览 | 助手 reasoning 可折叠、预览摘要。 | `packages/tui/src/routes/session/index.tsx` 的 `ReasoningPart`、preview、`reasoningSummary`、`ReasoningHeader`。 | 保留 | 当前支持 hide/minimal/expand。 |
| `a6b9a6a56d` | 父代理权限过滤 | task subagent 继承/限制父代理权限，防止绕过。 | `tool/task.ts` 的 `deriveSubagentSessionPermission(...)`；`agent/subagent-permissions.ts`；`test/agent/plan-mode-subagent-bypass.test.ts`。 | 保留 | 当前实现覆盖父 agent/session ceilings。 |

### 批次 C：2026-05-18 到 2026-05-09

| hash | subject 精简 | 原始改动意图 | 当前合并结果证据 | 状态 | 备注 |
|---|---|---|---|---|---|
| `201e910402` | stats 会话/工具事件统计重构 | 减少重复会话扫描，修正工具事件归因和统计准确性。 | `packages/opencode/src/cli/cmd/stats/data.ts` 中 `aggregateSession`、`toolEventsFromAssistants`、`componentsFromStep`、`toolUsage`。 | 保留 | 当前实现仍按 session 聚合并做工具上下文 token 归因。 |
| `6283df82e6` | daemon 启动退出状态/错误消息 | TUI daemon 启动逻辑增强；shell/daemon 测试覆盖退出状态。 | `packages/opencode/src/cli/tui/worker.ts` 中 `gracefulShutdown`、lock/control server；`packages/opencode/test/cli/tui/daemon.test.ts`。 | 保留 | daemon 代码后续迁移到 `src/cli/tui`，cmd 下为 re-export。 |
| `595de9b005` | 输出字节限制调至 16KB | tool 输出/read/vscode bridge 限制和说明改成 16 KB。 | `packages/opencode/src/tool/truncate.ts` 与 `packages/core/src/tool-output-store.ts` 为 16 KiB；read/vscode notebook source 保留 24 KiB 读取预算。 | 上游等价覆盖 | 输出投影边界收敛为 16 KiB；源码读取预算按 `56bce83a05` 保留 24 KiB，避免长源码读取退化。 |
| `9a6cfa492f` | stats 排序和工具用量 | stats 增加工具使用数据、排序逻辑和渲染宽度测试。 | `packages/opencode/src/cli/cmd/stats/data.ts` 中 `ToolUsage`/`toolUsage.sort`；`render.ts` 中 `sortGroups`。 | 保留 | 当前 stats 已有更完整 dashboard/timeline/breakdown。 |
| `1a88ba6a6e` | stats 端点信息丰富/模块化 | 将 stats 拆成 `stats/{charts,data,insights,render}.ts` 并增强渲染/insights。 | `packages/opencode/src/cli/cmd/stats/charts.ts`、`data.ts`、`insights.ts`、`render.ts`。 | 保留 | 结构仍在。 |
| `f0a47a1448` | 附件 token 估算 | 新增媒体/附件 token 估算并接入 prompt/message/token accounting。 | `packages/tui/src/token/estimate.ts` 中 `estimateAttachment`、`sanitizeModelMessages`、`estimateUploadInput`；`message-v2.ts` 中 `inputBreakdown.media`。 | 上游等价覆盖 | 原 `util/attachment-token.ts` 已迁入 TUI token estimate 与 message schema。 |
| `57eecce76b` | stats 入口和图表初建 | stats CLI 初步拆 chart/data/insight/render，增加图表。 | `packages/opencode/src/cli/cmd/stats/*.ts`。 | 上游等价覆盖 | 后续 commit 进一步重构覆盖早期文件形态。 |
| `59aeb3d239` | daemon idle timeout env | 支持 env 配置 daemon 空闲超时并加测试。 | `packages/opencode/src/cli/tui/worker.ts` 中 `OPENCODE_DAEMON_IDLE_TIMEOUT_MS`、`OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS`；daemon tests。 | 保留 | 当前还增加 startup idle / launcher watcher。 |
| `595b0e8f3e` | text-decoding buffer short ASCII | 短 ASCII 前缀缓冲，改善 UTF-16LE 自动识别。 | `packages/opencode/src/util/text-decoding.ts` 中 `shouldBufferAsciiPrefix`、`UTF16_PROBE_BYTES`、ASCII buffer 注释。 | 保留 | 未见退化。 |
| `49650e2f95` | IDE bridge registry active file | TUI 使用 IDE bridge registry 发现活动文件，移除 port 推送。 | `packages/tui/src/context/editor.ts` 中 bridge source/polling/selection；`packages/opencode/test/ide/vscode-bridge.test.ts`。 | 保留 | TUI 文件迁至 `packages/tui`，cmd 下 re-export。 |
| `a686ccf720` | Windows build Bun 安装 | Windows build workflow 改用新 Bun 安装方式并安装依赖。 | `.github/workflows/build-opencode.yml` 的 `build-windows`、`oven-sh/setup-bun@v2`、`bun install --linker hoisted`。 | 保留 | 未见退化。 |
| `704fe80257` | codex custom headers/User-Agent | Codex 插件支持自定义 HTTP headers 与 User-Agent，补测试。 | `packages/opencode/test/plugin/codex.test.ts`；`packages/opencode/test/session/llm.test.ts` 的 User-Agent cases。 | 保留 | 功能与 provider header 支持并存。 |
| `2c720138d3` | provider custom headers/User-Agent | provider config/options 支持 headers 与 `header-ua`。 | `packages/core/src/v1/config/provider.ts` 的 `options.headers`、`options.header-ua`；`packages/opencode/test/provider/provider.test.ts`。 | 上游等价覆盖 | 配置 schema 已迁到 core v1 config。 |
| `f2d3d0d44b` | install options/profile | install 脚本支持 version、profile、安装路径等选项。 | `install` 中 `--version`、`--path-profile`、`--all-shell-profiles`、`OPENCODE_INSTALL_DIR`；install-script tests。 | 保留 | README 也有对应安装说明。 |
| `442fd61eab` | typecheck/TUI keymap/API/lock | 修剩余 typecheck，迁移 TUI keymap/API，扩 daemon lock 接口。 | `packages/tui/src/server-lock.ts`；`packages/tui/src/config/keybind.ts`；`packages/opencode/src/cli/cmd/tui/server-lock.ts` re-export。 | 保留 | 后续 TUI 包拆分覆盖原路径。 |
| `2e65029d4e` | 禁用 RPC-thread | TUI 架构调整，禁用 per-TUI RPC thread，事件处理测试。 | `packages/opencode/src/cli/tui/worker.ts` 的 deprecated-rpc-thread 注释；`packages/opencode/src/cli/cmd/tui/thread.ts` re-export 限定 API。 | 保留 | 明确保留“共享 daemon owns SQLite”语义。 |
| `970ee408ae` | streaming event semantics | 增强事件处理，增加 streaming semantics 测试。 | `packages/tui/src/context/event.ts` 中 `server.connected`、directory normalization；`packages/opencode/test/cli/cmd/tui/session-integration.test.ts`。 | 保留 | 事件过滤仍有专门逻辑。 |
| `fce16528f4` | anthropic tool policy | refine `anthropic.txt` 工具使用策略。 | `packages/opencode/src/session/prompt/anthropic.txt` 中 `tool_usage_policy`。 | 保留 | 当前 prompt 内容后续有上游扩写，但策略区仍存在。 |
| `350a442717` | 大范围测试/功能重构 | 大量测试与 util/lock/schema/keybind/read 等功能整理。 | `packages/opencode/src/util/schema.ts`、`effect-zod.ts`、`keybind.ts`、`lock.ts`；多个 TUI/session/read 测试。 | 部分保留-风险 | commit 过宽且后续上游大幅移动，核心文件仍在但不能完全证明所有细小 bugfix 无退化。 |
| `7508670afb` | bump 1.15.3 | 版本号和文档配置 bump。 | `packages/opencode/package.json` 当前 `1.17.7-smark`。 | 版本号历史不适用 | 已被后续版本覆盖。 |
| `589d2624d7` | surrogate-safe truncate | 截断避免切割代理对，补 locale/text-decoding 测试。 | `packages/opencode/src/util/text-decoding.ts`；`packages/opencode/test/provider/transform.test.ts` surrogate sanitization。 | 保留 | 当前文本处理仍覆盖 surrogate 场景。 |
| `1ce61c81d5` | decision mode agent | 添加 decision/decide agent、迁移和权限测试。 | `packages/opencode/src/agent/agent.ts` 中 `decide` agent、`permission_review` agent；storage migration/test 仍存在。 | 保留 | agent 权限隔离也保留。 |
| `16168b804f` | 中文 README 完整化 | 重写中文 README，语言链接指向。 | `README.md` 中文主体、语言链接 `README.en.md` 等。 | 保留 | 当前 README 已继续演进但中文默认保留。 |
| `fd6a520984` | README.zh -> README | 中文 README 成为默认 README。 | `README.md` 中文；当前也有 `README.zh.md`。 | 保留 | 多语言 README 后续恢复 `README.zh.md`，但中文默认未退化。 |
| `a21caa805d` | README.md -> README.en | 英文 README 改名为 README.en.md。 | `README.en.md` 存在，`README.md` 为中文。 | 保留 | 未见退化。 |
| `232979d4fe` | shell ssh/wsl Unix 兼容 | 允许远程 ssh/local wsl payload 使用 Unix 命令并测试错误处理。 | `packages/opencode/src/tool/shell.ts` 中 `REMOTE_SHELL_COMMANDS`、`WSL_OPTIONS_WITH_VALUE`、`SSH_OPTIONS_WITH_VALUE`；`precheck.test.ts` ssh/wsl cases。 | 保留 | 当前 precheck/shell 仍区分 host 与 guest payload。 |
| `3fc69fb245` | context snapshot tool input delta | context usage 快照支持流式工具输入增量跟踪。 | `packages/tui/src/routes/session/context-usage.tsx` tool state refresh key 含 input/output/attachments；context usage tests。 | 保留 | TUI 包迁移后仍保留。 |
| `dacb88948b` | install version/env/errors | install 脚本支持版本指定、环境变量、错误输出。 | `install` 中 `VERSION`、`OPENCODE_INSTALL_DIR`、`print_message`；install tests。 | 保留 | 与 `f2d3d0d44b` 后续增强合并。 |
| `69f32338dd` | terminal control char cleanup | shell 输出中的控制字符清理/转义。 | `packages/opencode/src/tool/bash-compress.ts` 的 ANSI/CLIXML/terminal display pipeline；bash-compress tests。 | 保留 | 逻辑已并入 bash-compress。 |
| `5231d21898` | preview diff/session pending | 增加 preview diff 与 session assistant pending 状态管理。 | `packages/tui/src/util/preview-diff.ts`；`packages/tui/src/util/session-pending.ts`；对应 tests。 | 保留 | 未见退化。 |
| `188cbee1b7` | session/event bug fixes | 会话处理、事件发布、HTTP API SDK、revert/compact 修复。 | `packages/tui/src/context/event.ts`；`packages/opencode/src/session/prompt.ts`；`packages/opencode/test/server/httpapi-sdk.test.ts`。 | 部分保留-风险 | 改动面很宽，主要 session/event 证据存在，但无法逐一归因所有 bugfix。 |
| `a79689db16` | session/activity/daemon heartbeat | 会话活动、心跳、daemon 处理增强。 | `packages/opencode/src/cli/tui/worker.ts` 中 `SessionActivity.count()`、`onChange`、SSE client idle logic；`packages/opencode/src/session/activity.ts`。 | 保留 | 当前 daemon idle 依赖 activity。 |
| `10f01867e2` | interrupt confirm | 中断确认计数/确认时间。 | `packages/tui/src/component/prompt/interrupt.ts` 中 `INTERRUPT_CONFIRMATION_MS`、`advanceInterruptCount`；`prompt-interrupt.test.ts`。 | 保留 | 保留 double-press abort 语义。 |
| `7636c268c2` | proxy/provider/task cancel tests | NetworkProxy 不受 mocked fetch 影响、移除 HttpClient 依赖、任务取消传播测试。 | `packages/core/test/network-proxy.test.ts`；`packages/opencode/test/session/prompt.test.ts`；`packages/opencode/test/tool/task.test.ts`。 | 保留 | NetworkProxy tests 明确覆盖 global fetch mock。 |
| `36b84e5de2` | macOS/cross-platform tests | macOS 测试修正、路径解析、工具中断处理。 | `packages/opencode/test/tool/grep.test.ts`；`packages/opencode/test/server/httpapi-json-parity.test.ts`；`packages/opencode/src/session/processor.ts`。 | 保留 | 多为测试兼容性，当前相关测试仍在。 |
| `8e4a9b2768` | bump 1.14.42 | 全包版本号至 1.14.42。 | `packages/opencode/package.json` 当前 `1.17.7-smark`。 | 版本号历史不适用 | 已被后续版本覆盖。 |
| `f0cc012dbc` | provider version override | 自定义 provider/client version override，特别 claudecode。 | `packages/core/src/v1/config/provider.ts` 中 `options.version`；`packages/opencode/src/provider/claudecode.ts` 注释支持 options.version。 | 保留 | 未见退化。 |
| `77ec24d3c4` | opentui overrides | package overrides for `@opentui/core/solid`。 | `package.json` 中 `overrides["@opentui/core"] = "catalog:"`，catalog 管理 opentui deps。 | 保留 | 当前 only core override 可见；solid 已 catalog 管理。 |
| `0277deba50` | read 保留 XML 敏感内容 | read 输出结构调整，文件内容不 XML escape，仅 wrapper escape。 | `packages/opencode/src/tool/read.ts` 的 Keep source text verbatim / `escapeXmlText`；`read.test.ts` XML-sensitive tests。 | 保留 | 未见退化。 |
| `f019cdd568` | TUI session preview/border | session 组件内容预览、自定义边框。 | `packages/tui/src/routes/session/index.tsx`；`packages/tui/src/component/border*`。 | 上游等价覆盖 | 原路径迁至 `packages/tui`，功能形态已被后续 TUI 重构覆盖。 |
| `238079f024` | bump 1.14.41 + session path | session 路径管理增强，兼容 Windows/global path。 | `packages/opencode/src/session/path.ts` 中 `relative`、`aliases`、drive-qualified Windows path。 | 保留 | 版本号部分历史不适用；路径功能保留。 |
| `17b9d5b4f3` | read metadata/stub/outlines | read 工具完整重构：metadata、stub、outline、上下文稳健性。 | `packages/opencode/src/tool/read.ts` 中 `ReadMetadata`、`collectVisibleReads`、`findReadStub`；`read-outline.ts`。 | 保留 | 未见退化。 |
| `190d962e1d` | bump 1.14.41 | 全包版本号至 1.14.41。 | `packages/opencode/package.json` 当前 `1.17.7-smark`。 | 版本号历史不适用 | 已被后续版本覆盖。 |
| `8acb3fecbf` | session input chars/token estimate | prompt/session 压缩加入 input char 与 token 估算。 | `packages/opencode/src/session/message-v2.ts` 中 `inputChars`、`inputTokens`、`inputBreakdown`；`packages/tui/src/token/accounting.ts`。 | 保留 | 现已更完整。 |
| `b5b29eabb8` | TUI session/error recovery | TUI daemon/sdk/thread 错误恢复。 | `packages/opencode/src/cli/tui/worker.ts`；`packages/tui/src/context/sdk.tsx`；daemon/thread tests。 | 保留 | 后续 daemon 架构迁移后仍保留恢复逻辑。 |
| `563ac8f18e` | ripgrep max file/result limit | ripgrep 最大文件/结果限制，广泛搜索报错。 | `packages/core/src/ripgrep.ts` 中 `maxFiles`、`MAX_SEARCH_RESULTS`、`SearchTooBroadError`；grep tests。 | 上游等价覆盖 | 原 `packages/opencode/src/file/ripgrep.ts` 迁入 core。 |
| `daf41ca522` | tool completed/manual compact/text stream | 工具完成状态更新、手动压缩、文本 part 流式渲染。 | `packages/tui/src/config/keybind.ts` 中 `session_compact`；`packages/opencode/src/session/prompt.ts`；`packages/tui/src/feature-plugins/system/session-v2.tsx`。 | 保留 | 未见退化。 |
| `95a96c38e9` | context usage instructions/skills | context usage 计算加入 instructions/skills。 | `packages/tui/src/util/context-usage.ts` 中 `instructions`、`skills`；`packages/opencode/test/cli/tui/context-usage.test.ts`。 | 保留 | 未见退化。 |
| `3bed2cfd53` | streaming assistant/reasoning render | TUI 流式消息、assistant/reasoning part 渲染优化。 | `packages/tui/src/feature-plugins/system/session-v2.tsx`；`packages/tui/src/routes/session/index.tsx`。 | 保留 | 未见退化。 |
| `a5ea69d8ea` | directory normalization | Windows 路径比较规范化。 | `packages/tui/src/context/event.ts` 中 `normalizeDirectory`、`sameDirectory`。 | 保留 | 明确保留 Windows slash/case 处理。 |
| `9897db4108` | bump 1.14.40 | 全包版本号至 1.14.40。 | `packages/opencode/package.json` 当前 `1.17.7-smark`。 | 版本号历史不适用 | 已被后续版本覆盖。 |
| `afbe5289aa` | session path Windows global | Windows global session path 规范化和兼容历史路径。 | `packages/opencode/src/session/path.ts` 中 `aliases`、`windowsAbsolute`、drive-relative query。 | 保留 | 未见退化。 |
| `5baa17d804` | line ending preservation | apply_patch/edit/write 保留原始 LF/CRLF。 | `packages/opencode/src/util/line-ending.ts`；`packages/opencode/src/tool/edit.ts`；`edit.test.ts` CRLF/LF cases。 | 保留 | 测试覆盖很多 LF/CRLF 场景。 |
| `43948adfde` | PowerShell stderr bytes | PowerShell 输出处理：原生 stderr bytes 保持并规范化。 | `packages/opencode/src/tool/shell.ts` 的 `createAutoTextDecoder`；`bash-compress.ts` PowerShell normalize；shell/text-decoding tests。 | 保留 | 与 CLIXML/auto decoding 合并。 |
| `3ff2620ec1` | PowerShell CLIXML decode | 解码/规范化 PowerShell CLIXML 为纯文本。 | `packages/opencode/src/tool/bash-compress.ts` 的 `POWER_SHELL_CLIXML_*`、`normalizePowerShellOutput`；`bash-compress.test.ts`。 | 保留 | 未见退化。 |
| `831d484631` | multi text encoding | UTF-8/UTF-16/GB18030 自动/显式解码策略。 | `packages/opencode/src/util/text-decoding.ts` 中 `TextEncoding`、`decodeText`、`createAutoTextDecoder`；`config.ts` 的 `shell_encoding`。 | 保留 | 未见退化。 |
| `2b4a23f055` | token accounting request chars | request body chars、估算 token、breakdown。 | `packages/opencode/src/session/message-v2.ts` 的 `InputBreakdownSchema`；`packages/tui/src/token/accounting.ts`。 | 保留 | 当前更完整。 |
| `f5f094895b` | auto text decoder | 自动文本解码器，UTF-8/UTF-16LE 检测。 | `packages/opencode/src/util/text-decoding.ts` 中 `detectTextEncoding`、`decodeAutoSegment`、`createAutoTextDecoder`。 | 保留 | 未见退化。 |
| `0cd54998e4` | prompt time/bridgeUri/context throttle | prompt 流式时间、`bridgeUriToPath`、context usage 节流。 | `packages/tui/src/util/session-pending.ts` duration helpers；`packages/tui/src/context/editor.ts` bridge source/selection。 | 部分保留-风险 | streaming duration 和 bridge 功能可见；未直接定位到同名 `bridgeUriToPath`，可能被后续重构内联/替代。 |
| `5959a791ff` | step-start token breakdown | 流式期间从 step-start 提供 input breakdown。 | `packages/opencode/src/session/message-v2.ts` 的 `StepStartPart.inputBreakdown`；`packages/tui/src/routes/session/context-usage.tsx` step-start refresh key。 | 保留 | 未见退化。 |
| `f3dd302716` | local TDZ fix | 首次渲染前保持 local 可用，避免 Bun TDZ。 | `packages/tui/src/routes/session/index.tsx` 当前路径保留并重构。 | 上游等价覆盖 | 文件后续大幅迁移/重构；未见对应 TDZ 风险残留。 |
| `1ca386e353` | token estimate stream refactor | token accounting 精确统计和 breakdown 重构。 | `packages/tui/src/token/accounting.ts`；`packages/tui/src/token/estimate.ts`；token-estimate tests。 | 保留 | 未见退化。 |
| `fdb0447556` | session search | session list/search 支持 title 或 message 内容过滤。 | `packages/core/src/session/search.ts` 中 `searchCondition`、`messagePartMatches`；`packages/opencode/src/session/session.ts` imports `searchCondition`。 | 上游等价覆盖 | 原 opencode session search 迁到 core。 |
| `ca04b07955` | dialog session list + version | 对话列表显示更新，VSCode ESLint 警告规则，版本号。 | `packages/tui/src/component/dialog-session-list.tsx`；`sdks/vscode/eslint.config.mjs`；version 已为 `1.17.7-smark`。 | 保留 | 功能部分保留；版本号历史不适用。 |
| `5a7024df0d` | husky Windows Bun path | Windows 上 husky pre-push Bun 路径。 | `.husky/pre-push`。 | 保留 | 未见退化。 |
| `31b18c9638` | bump 1.14.39 | 版本号一致性。 | `packages/opencode/package.json` 当前 `1.17.7-smark`。 | 版本号历史不适用 | 已被后续版本覆盖。 |
| `5cc7957242` | provider WithInstance tests | provider 实例引用测试一致性，system test 增补。 | `packages/opencode/test/provider/provider.test.ts`；`packages/opencode/test/session/system.test.ts`。 | 保留 | 测试语义仍在。 |
| `9ab94ccbe2` | shell compression/session info/stats imports | shell 输出压缩选项、session info effect、stats import、editor/worker 修复。 | `packages/opencode/src/tool/shell.ts` 的 `bashCompressionEnabled`；`packages/opencode/src/tool/shell/prompt.ts`；`cli/cmd/session.ts`；`cli/cmd/stats.ts`。 | 保留 | 当前 shell compression 和 session/stats 入口仍存在。 |

### 批次 D：2026-05-29 到 2026-05-19

| hash | subject 精简 | 原始改动意图 | 当前合并结果证据 | 状态 | 备注 |
|---|---|---|---|---|---|
| `ab8a58de6c` | session export 从 daemon 读全量 | TUI 导出不再用本地渲染窗口，失败不写 partial。 | `packages/opencode/test/cli/cmd/tui/session-export.test.tsx` 覆盖 reads complete transcript from daemon 与 does not write partial。 | 保留 | 功能/回归测试仍在。 |
| `f29622f104` | bump 1.15.5-smark | README/workflow/opencode/vscode 版本一致。 | `packages/opencode/package.json` 当前 `1.17.7-smark`；`sdks/vscode/package.json` 当前 `1.15.5`。 | 版本号历史不适用 | opencode 版本已前进，VS Code 包仍是 1.15.5。 |
| `d906155223` | notebook language-only/空数组保护 | language-only 保留 source；拒绝 `oldCode/newCode: []`。 | `sdks/vscode/src/notebook/edit.ts` 中 `rejectEmptySourceArray`、`handleTypeChange` fallback `newSource = targetCell.document.getText()`。 | 保留 | 未见退化。 |
| `a78bedf5a5` | compaction 不重复上传已总结历史 | 后续压缩用 filtered history，previous summary 单独传。 | `packages/opencode/src/session/compaction.ts` 使用 `MessageV2.filterCompacted(rawHistory)`、`previousSummary`，并有“不能再次进入 provider 请求”注释。 | 保留 | 后续 compaction 重构仍保留此边界。 |
| `615fcee676` | reviewer OAuth/非 OAuth 一致测试 | 权限审查服务覆盖 OAuth 与普通请求。 | `packages/opencode/src/permission/reviewer/service.ts`；`packages/opencode/test/permission/reviewer-service.test.ts`。 | 保留 | reviewer 服务已更复杂，但测试入口保留。 |
| `75a4cc2bbb` | stats 移除背景 ANSI | panel/chart 不输出固定背景色，新增回归测试。 | `packages/opencode/src/cli/cmd/stats/render.ts` 使用 `BACKGROUND_RESET = "\x1b[49m"`；`stats-render-width.test.ts` 覆盖不输出 terminal background ANSI。 | 保留 | 使用 49m 重置而非设置背景色。 |
| `425c3b9b73` | apply_patch 删除显示行数 | 删除文件有 patch 数据时显示 `+/-`，兼容 legacy。 | `packages/tui/src/routes/session/index.tsx` 解析 apply_patch added/removed；`session-message-render.test.tsx` 覆盖删除/legacy。 | 保留 | TUI 代码迁移到 `packages/tui`，opencode 旧路径 re-export。 |
| `9c4cf37be9` | promptOffsetWidth 应用 | 用 display-width 处理 cursor/extmark/virtual text。 | `packages/tui/src/prompt/display.ts` 中 `promptOffsetWidth` newline 算 1；`packages/tui/src/component/prompt/index.tsx` 多处调用。 | 保留 | 路径已从 opencode TUI 迁移到 `packages/tui`。 |
| `9711fd1859` | grep filter 紧凑显示 | TUI/run scrollback 不暴露 include/exclude 参数名。 | `packages/tui/src/routes/session/index.tsx` 中 `grepPatterns`/`grepFilter`；`packages/opencode/src/cli/cmd/run/tool.ts` 同名逻辑。 | 保留 | 当前仍用 `!glob` 表示 exclude。 |
| `06c953137c` | parser 支持 shellscript/toml | `.sh/.bash/.zsh/.ksh` 和 `.toml` 高亮/LSP。 | `packages/opencode/src/lsp/language.ts` 中 `.sh`/`.bash` 映射 `shellscript`，`.toml` 映射 `toml`。 | 保留 | LSP 映射仍在。 |
| `d9c92e000c` | grep timeout/include/exclude | grep 参数支持 timeout/include/exclude，结果提示超时。 | `packages/opencode/src/tool/grep.ts` schema 含 `include/exclude/timeout`；`packages/core/src/ripgrep.ts` 支持 timeout/exclude/glob。 | 保留 | ripgrep 实现迁入 core，功能保留。 |
| `611142bbcc` | 会话耗时/时间戳 | pending/assistant 时间计算更准确。 | `packages/tui/src/context/data.tsx` 维护 `time.created/completed`；`packages/opencode/test/cli/cmd/tui/session-pending.test.ts`。 | 保留 | TUI 状态来源迁移，测试保留。 |
| `ad4e0d983c` | compaction 接口重构 | 新 compact 接口、状态/错误处理、message-v2 支持。 | `packages/opencode/src/session/compaction.ts` 的 `compact` 流程、`compactionPart`；`message-v2.ts` compaction-aware 逻辑。 | 保留 | 后续多次重构但核心接口仍在。 |
| `a254f367d9` | daemon idle 注释 4s | 注释同步 idle timeout 从 8s 到 4s。 | `packages/opencode/src/cli/tui/worker.ts` 中 `IDLE_TIMEOUT_MS` 默认 `4_000`。 | 保留 | 实际文件迁至 `src/cli/tui/worker.ts`。 |
| `a6bf252a10` | provider/fetch 日志 | release 日志级别、fetch timing/SSE 诊断。 | `packages/opencode/src/provider/provider.ts` 中 `fetchLog`、`timing`、`wrapSSE`、`providerFetchRequestID`。 | 保留 | release 日志级别未逐项确认，但 fetch 诊断保留。 |
| `7f3ee0d91e` | daemon idle 30s→4s | 守护进程空闲退出缩短。 | `packages/opencode/src/cli/tui/worker.ts` 中 `OPENCODE_DAEMON_IDLE_TIMEOUT_MS ?? 4_000`。 | 保留 | 支持环境变量覆盖。 |
| `ce13a7a771` | tokenAccounting 去双计数 | in-flight 上传估算不重复计 input。 | `packages/opencode/src/token/accounting.ts` 注释 daemon inputBreakdown；`packages/opencode/src/token/estimate.ts` 中 `estimateUploadInput`。 | 保留 | 后续 token 域重构覆盖并保留。 |
| `5b34dda2ff` | 工具/流 timing 日志 | 工具执行 timing、stream timing 诊断。 | `packages/opencode/src/session/prompt.ts` 中 `logToolTiming`/tool timing；`processor.ts` 中 `stream timing` 日志。 | 保留 | 未见退化。 |
| `c4d832cc3d` | stats 工具统计测试 | input breakdown/source/status/tool stats 兼容。 | `packages/opencode/src/cli/cmd/stats/data.ts` 中 `inputBreakdown`、`toolSchemas/toolCalls/toolResults`；`stats-data.test.ts`。 | 保留 | 统计维度扩展后仍覆盖。 |
| `1035b75f68` | daemon 启停/信号 | 启动 idle、退出 signal、日志、测试。 | `packages/opencode/src/cli/tui/worker.ts` 的 startup idle、launcher watcher、`gracefulShutdown`；`context/exit.tsx` 的 `ExitSignals`。 | 保留 | 文件迁移/re-export，功能保留。 |
| `564b45dcaa` | notebook summary 行为测试 | edit/run/env 操作摘要更完整。 | `sdks/vscode/src/notebook/summary.ts`、`format.ts`；`packages/opencode/test/plugin/vscode-notebook-tool-summary.test.ts`。 | 保留 | 测试仍在。 |
| `006161d73b` | notebook 大插入预览/高亮 | TUI notebook diff/preview、large insert metadata。 | `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` 覆盖 oversized notebook insert 和 language syntax highlighting。 | 保留 | 渲染代码迁至 `packages/tui`。 |
| `021d5ad6c3` | 外部目录 auto 审查 | 危险 shell 拒绝，外部路径进入 cautious。 | `packages/opencode/src/permission/auto.ts` cautious reviewer；`precheck.ts` dangerous raw；`auto.test.ts` external-dir cases。 | 保留 | 后续权限系统增强覆盖。 |
| `bba4bb002a` | bump 1.15.4 | 版本号提升到 1.15.4。 | 当前 `packages/opencode/package.json` 为 `1.17.7-smark`。 | 版本号历史不适用 | 已被后续版本覆盖。 |
| `151cf939ba` | models snapshot | 更新模型快照。 | `packages/core/src/models-snapshot.js` 当前存在且已有后续修改。 | 版本号历史不适用 | 用户已指定 `packages/core/src/models-snapshot.js` 不重要，按上游即可。 |
| `a672bf6862` | session 路径切换 | global path/目录 fallback、临时 git repo 测试。 | `packages/opencode/src/session/session.ts` 中 `relatedPathConditions`、`directoryMatchesPath`、`globalPath` fallback。 | 保留 | 当前逻辑更复杂但保留意图。 |
| `b2cf8c8369` | reviewer JSON 决策/重试 | 支持 JSON 文本 decision、协议重试。 | `packages/opencode/src/permission/reviewer/service.ts`、`schema.ts`；`auto.ts` reviewer failure fallback/retry 边界。 | 保留 | 后续 service 重构仍含 JSON/失败策略。 |
| `d1d940d70f` | Windows sandbox 设计文档 | 新增 opencode/codex sandbox 迁移设计。 | `docs/opencode-sandbox-windows-design.md`、`docs/codex-sandbox-windows-design.md`。 | 保留 | 文档仍存在。 |
| `563ee64fea` | Auto→auto | 统一小写 auto。 | `packages/opencode/src/agent/agent.ts` 中 `auto: { name: "auto" }`、`EXPLICIT_ONLY_PRIMARY_AGENT_NAMES = new Set(["auto"])`。 | 保留 | 当前仍小写。 |
| `1b8b8b9dae` | notebook editing 能力 | 新增 notebook edit TUI/bridge/metadata。 | `packages/tui/src/routes/session/notebook-tool.tsx`；`packages/opencode/src/plugin/vscode-bridge.ts`；VS Code `notebook/edit.ts`。 | 保留 | 路径迁移但功能保留。 |
| `f71acd28f6` | vscode-bridge 权限 | notebook edit/env/run 权限更精确。 | `packages/opencode/src/plugin/vscode-bridge.ts`；`packages/opencode/test/plugin/vscode-bridge.test.ts`。 | 保留 | 测试仍在。 |
| `8627ea829f` | precheck 删除/移动增强 | find/Python 删除等进入审查。 | `packages/opencode/src/permission/precheck.ts` 中 `RAW_FILE_DELETE_PATTERN`、`RE_D_PYTHON_RMTREE`、`FILE_MOVE_COMMANDS`。 | 保留 | 规则已大幅扩展。 |
| `aa1d0d27c3` | PowerShell 静默偏好 | 避免模块日志污染输出。 | `packages/opencode/src/tool/shell.ts` 设置 `$ProgressPreference`、`$VerbosePreference`、`$DebugPreference`。 | 保留 | 当前仍静默。 |
| `0436a82b95` | precheck 增强 | 分类/场景测试扩充。 | `packages/opencode/src/permission/precheck.ts` 五阶段 fail-closed 设计；`precheck.test.ts`。 | 保留 | 后续规则更多。 |
| `dddd6516ff` | bridge registry 容错/原子写 | 忽略损坏 registry，临时文件 rename 发布。 | `packages/opencode/src/ide/vscode-bridge.ts` 中 `CORRUPT_REGISTRY_GRACE_MS`、`readEntry`；`sdks/vscode/src/bridge-registry.ts` 中 temp+rename。 | 保留 | 未见退化。 |
| `39c1c1755b` | VS Code 版本格式 | 修正 VS Code package 版本格式。 | `sdks/vscode/package.json` 为 `"version": "1.15.5"`。 | 版本号历史不适用 | 当前保持非 `-smark` VSIX 版本格式。 |
| `5aff2e10e3` | precheck 删除/移动审查 | 文件删除/移动命令安全审查。 | `packages/opencode/src/permission/precheck.ts` 中 `FILE_DELETE_COMMANDS`、`FILE_MOVE_COMMANDS`、raw patterns。 | 保留 | 被后续增强覆盖。 |
| `4e7e1efcbd` | auto-review abort | 工具执行中止状态/错误处理。 | `packages/opencode/src/session/prompt.ts`、`processor.ts`；`prompt.test.ts` abort/retry 相关仍在。 | 保留 | 未见功能缺失。 |
| `9e190548fc` | 虚拟终端显示 | 部分控制序列缓冲、max lines/chars。 | `packages/opencode/src/tool/bash-compress.ts` 中 `VirtualTerminalOptions.maxLines/maxChars/bufferPartialControl`、`createTerminalDisplay`。 | 保留 | 功能保留且扩展。 |
| `347a9a0057` | auto-review 上下文/UI | 工具审查 metadata、状态渲染、retry。 | `packages/tui/src/routes/session/index.tsx` auto review chrome；`packages/opencode/src/session/retry.ts`；`permission/reviewer/service.ts`。 | 保留 | TUI 迁移后仍在。 |
| `cb7fb80142` | 点击 task 打开子会话 | child session 跳转、强制刷新过期子会话。 | `packages/tui/src/routes/session/index.tsx` 中 `subagent`/`children`/force-refresh 注释。 | 保留 | 证据显示专门处理 Task metadata 早于子会话内容。 |
| `26bf6a4193` | viewport 流式到底 | 流式增长时底部可见。 | `packages/tui/src/routes/session/index.tsx` 中 `viewportStuckToBottom`、`shouldCullSessionViewport`、scroll bottom 逻辑。 | 保留 | 当前 viewport 逻辑更完整。 |
| `416bf11aef` | docs 移动 prompts | 开发指南移到 docs。 | `docs/prompts.md` 存在，根 `prompts.md` 不再作为主文件。 | 保留 | 文档移动保留。 |
| `3bb4262388` | 外部目录 tool 证据 | tool-origin evidence 优化 auto 决策。 | `packages/opencode/test/permission/auto.test.ts` 覆盖 tool-origin external directory；`tool/external-directory.test.ts`。 | 保留 | 当前 auto test 覆盖 tool-origin。 |
| `12663b5e09` | 自动审批/transcript | reviewer/transcript/TUI 状态增强。 | `packages/opencode/src/permission/reviewer/transcript.ts`、`service.ts`；`reviewer-prompt.test.ts`。 | 保留 | 后续 policy/transcript 改动保留。 |
| `d476e71e61` | reviewID 追踪 | 添加 reviewID 和 review start 事件。 | `packages/opencode/src/permission/index.ts` reviewID schemas/events；`auto.ts` 中 `crypto.randomUUID()`、`onReviewStart`。 | 保留 | 明确保留。 |
| `d3f25aad5b` | WSL/SSH 权限边界 | 区分 host/remote command 权限。 | `packages/opencode/src/tool/shell.ts` 中 `REMOTE_SHELL_COMMANDS`、`WSL_OPTIONS_WITH_VALUE`、`SSH_OPTIONS_WITH_VALUE`。 | 保留 | 当前 shell scanner 保留 remote 分段设计。 |
| `4847e71642` | policy/prompt/transcript 可见证据 | 只用可见证据、风险策略调整、transcript 测试。 | `packages/opencode/src/permission/reviewer/policy/policy.md`、`prompt.ts`、`transcript.ts`；`reviewer-prompt.test.ts`。 | 保留 | 后续 policy 文件仍存在。 |
| `5f3d18e85b` | compact 避免虚假 tailID | hidden message 可作边界但不包含。 | `packages/opencode/src/session/compaction.ts` tail/summary boundary 注释；`message-v2.ts` 的 `filterCompacted`。 | 保留 | 后续 compaction 保留边界思路。 |
| `d7eb5239e4` | filterCompacted ordering | compacted message ordering 修复。 | `packages/opencode/src/session/message-v2.ts`；`packages/opencode/test/session/message-v2.test.ts`。 | 保留 | 功能保留；snapshot 变化属历史。 |
| `773ad40748` | auto 路由串联修正 | shell/external-dir auto 路由一致。 | `packages/opencode/src/permission/index.ts` mixed auto/ask 注释；`auto.ts`；`shell.ts`。 | 保留 | 当前实现更严格。 |
| `8ae5a36f94` | permission schema/precheck levels | precheck levels、schema/tests 调整。 | `packages/opencode/src/permission/precheck.ts` 中 `LEVELS = ["safe","general","cautious","dangerous"]`；`reviewer/schema.ts`。 | 保留 | 保留并扩展。 |
| `eb266f39a9` | auto agent | 新增可显式选择 auto agent。 | `packages/opencode/src/agent/agent.ts` 的 `auto` native agent、`EXPLICIT_ONLY_PRIMARY_AGENT_NAMES`。 | 保留 | 当前保证不会隐式默认启用。 |
| `d4f24d4434` | hidden reviewer protocol | 隔离 permission-reviewer agent/tool。 | `packages/opencode/src/agent/prompt/permission-reviewer.txt`；`packages/opencode/src/tool/permission_review_decision.ts`；registry 测试。 | 保留 | hidden reviewer 仍是 reserved。 |
| `7e2a92c8e5` | auto review 接入 permission flow | Permission 流程调用 reviewer/cache/precheck。 | `packages/opencode/src/permission/index.ts` 使用 `PermissionReviewer.Service`、auto request、cache hit、review events。 | 保留 | 当前逻辑更细分。 |
| `09fcecbcdc` | reviewer auto decision service | auto/reviewer/cache/circuit/policy/transcript。 | `packages/opencode/src/permission/reviewer/service.ts`、`circuit-breaker.ts`、`schema.ts`、`transcript.ts`。 | 保留 | 后续增强覆盖。 |
| `38863f98f8` | deterministic shell precheck | 静态 shell 预审器。 | `packages/opencode/src/permission/precheck.ts` fail-closed 五阶段、dangerous/cautious raw patterns。 | 保留 | 当前 precheck 大幅扩展。 |
| `998d3ca0f7` | auto review config schema | config 支持 auto_review。 | `packages/opencode/src/config/permission.ts`；`packages/opencode/test/config/config.test.ts`。 | 保留 | schema 保留。 |
| `bb5a2b41f2` | models snapshot | 更新模型快照。 | `packages/core/src/models-snapshot.js` 当前存在且已有后续修改。 | 版本号历史不适用 | 用户已指定该文件不重要，按上游即可。 |
| `454703956a` | upload token estimate 对齐 | confirmed usage 与 pending estimate 对齐。 | `packages/opencode/src/token/estimate.ts` 中 `learnInputCharsPerToken`/`estimateUploadInput`；`token-estimate.test.ts`。 | 保留 | 后续 token 域重构保留。 |
| `cac74b551d` | token helpers 迁入 token 域 | 从 util/TUI 移到 `src/token`。 | `packages/opencode/src/token/accounting.ts`、`estimate.ts`。 | 保留 | 结构性迁移保留。 |
| `b47dd66b83` | 重连/提交失败恢复 | run transport/TUI sync replay/retry 边界。 | `packages/opencode/test/cli/run/stream.transport.test.ts` replay/resize/persisted delta tests；`sync.test.tsx`。 | 保留 | 当前测试覆盖很多恢复场景。 |
| `a8478caff8` | 超时/连接错误重试 | 特定 provider/connection 错误重试。 | `packages/opencode/src/session/retry.ts`、`message-v2.ts`；`packages/opencode/test/session/retry.test.ts`。 | 保留 | retry 测试仍在。 |
| `8d2352918c` | TDD 指南 | 新增 `prompts.md` TDD 指南。 | `docs/prompts.md`。 | 保留 | 后续移入 docs。 |
| `ff399b61bd` | pending 50ms/prompt width | pending tool input 刷新 50ms、prompt width 改进。 | `packages/tui/src/routes/session/pending-tool-input.ts` 中 `PENDING_TOOL_INPUT_PROGRESS_INTERVAL = 50`；promptOffsetWidth 调用。 | 保留 | models snapshot 夹带属历史。 |
| `0e387c9920` | read.txt 成功编辑后别重读 | read tool 文档说明。 | `packages/opencode/src/tool/read.txt` 含 `After a successful edit...skip re-reading...`。 | 保留 | 文档原句保留。 |
| `7f397680e3` | 实时删改行数 | pending tool input parser/stats。 | `packages/tui/src/routes/session/pending-tool-input.ts` 解析 apply_patch/edit/write/notebook，`added/removed`；TUI index 渲染 `+/-`。 | 保留 | 后续加入 notebook 支持。 |
| `89c4f7d15a` | 消息增量性能/sync | partial delta merge、sync 测试。 | `packages/opencode/test/cli/cmd/tui/sync.test.tsx`；`packages/tui/src/context/data.tsx` delta append/update。 | 保留 | 当前 sync 逻辑保留。 |
| `a505b9721c` | Assistant/InlineTool 间距 | 消息渲染间距优化/测试。 | `packages/tui/src/routes/session/index.tsx` 中 `InlineToolRow` spacing logic；`session-message-render.test.tsx`。 | 保留 | TUI 迁移后保留。 |
| `d7b11daa5e` | session layout 宽度 | 内容宽度计算和测试。 | `packages/tui/src/routes/session/layout.ts` 中 `sessionMessageContentWidth`；`session-layout.test.ts`。 | 保留 | opencode 旧 layout re-export。 |
| `8facd64e27` | stats 日期/刻度 | human-readable date labels/chart ticks。 | `packages/opencode/src/cli/cmd/stats/render.ts` 中 `shortDate/dateRange`；`stats-render-width.test.ts` 覆盖 stable date labels。 | 保留 | 后续 dashboard 重构保留。 |
| `aa18b74b81` | responsive dashboard | stats dashboard 响应式新版布局。 | `packages/opencode/src/cli/cmd/stats/render.ts` 中 `renderDashboard`；tests 覆盖 responsive sectioned overview。 | 保留 | 未见退化。 |
| `640604259f` | InlineTool/Assistant 边距 | 边距逻辑和测试。 | `packages/tui/src/routes/session/index.tsx` 中 `InlineToolRow` previous-inline/subagent spacing；渲染测试仍在。 | 保留 | 被后续 `a505b9721c` 扩展。 |
| `746356e518` | BlockTool collapsible | `collapsible` 替代 `canCollapse`。 | `packages/tui/src/routes/session/index.tsx` 中 BlockTool/InlineTool 折叠逻辑、`collapsible` 语义。 | 保留 | 当前命名/结构可能变化，但折叠功能仍在。 |
| `f453ffa6ad` | session viewport 管理 | 滚动/streaming assistant viewport。 | `packages/tui/src/routes/session/index.tsx` 中 `viewportStuckToBottom`、`shouldCullSessionViewport`；`session-pending.test.ts`。 | 保留 | 后续 viewport 增强覆盖。 |
| `6bfd312062` | BlockTool/Shell preview | 预览字符计数、折叠。 | `packages/tui/src/routes/session/index.tsx` long single-line visual row 注释、preview limit/overflow。 | 保留 | 未见退化。 |
| `71ff3e1a3a` | compaction input estimate | summary assistant 存 input 估算。 | `packages/opencode/src/session/compaction.ts` 中 `TokenEstimate.sanitizeModelMessages`、`estimatedInput`、`inputTokens`。 | 保留 | 当前还记录 `system_compaction` request usage。 |
| `27a7a17c59` | responsive dashboard 测试 | 折叠 top table 正确显示。 | `packages/opencode/test/cli/stats-render-width.test.ts` dashboard responsive/top table 相关测试。 | 保留 | 测试仍在。 |

### 批次 E：2026-06-15 到 2026-05-29

| hash | subject 精简 | 原始改动意图 | 当前合并结果证据 | 状态 | 备注 |
|---|---|---|---|---|---|
| `c215c82f9b` | bump SMARK CLI 1.15.7 | 更新多语言 README 与 `packages/opencode/package.json` 版本号到 1.15.7。 | `packages/opencode/package.json` 当前为 `1.17.7-smark`。 | 版本号历史不适用 | 后续版本已前进，不应回退到 1.15.7。 |
| `bba9c227df` | TUI EventSource 清理 | 修改 `sync-fixture.tsx`，测试后不遗留事件源/状态。 | `packages/opencode/test/fixture/tui-sdk.ts` 的 `createEventSource()` 有 `dispose()`；`packages/opencode/test/cli/cmd/tui/sync-fixture.tsx` 在 renderer destroy 中调用 `events.dispose()` 与 `engine.detach()`。 | 保留 | focused sync/session render tests 已通过。 |
| `d86901da7c` | Windows CI 竞态/桌面导入 | 修复 `flock.ts`、desktop server/shell-env、daemon 测试竞态。 | `packages/core/src/util/flock.ts` 用 atomic rename release；desktop shell-env 避免顶层 logger 导入；daemon 首启 missing WAL 与 SSE disconnect 问题已补修。 | 保留 | flock/database/daemon tests 已通过。 |
| `02f84d332c` | Node fs 写 fixture | repo_clone/sync fixture 改用 Node fs，避免 Windows Bun 写入空内容。 | `packages/opencode/test/tool/repo_clone.test.ts` 使用 `node:fs/promises` 写入并读回校验。 | 保留 | 原始 Windows fixture 内容一致性保护仍在。 |
| `7ccf79b7fe` | Windows git 提交校验 | 优化 git staged/commit 文件检查，修复 CI 提交验证。 | `packages/opencode/test/tool/repo_clone.test.ts` 校验 staged 与 `ls-tree HEAD`。 | 保留 | 与后续 `7470e100e4` 共同保留。 |
| `7470e100e4` | repo_clone 提交校验 | 修复 Windows 克隆测试提交校验。 | `packages/opencode/test/tool/repo_clone.test.ts` 验证 HEAD tree/remote bare 内容。 | 保留 | 当前实现避免 CRLF 内容误杀，只确认文件进入树。 |
| `2ea89915f2` | 测试 Windows 兼容 | 增强 enterprise/opencode 测试，减少 shell 命令延迟/竞态。 | `packages/opencode/test/tool/repo_clone.test.ts` 中 `waitForContent` 轮询；`sync-fixture.tsx` 有 wait helper。 | 保留 | 相关等待/轮询策略仍在。 |
| `95aaee58d4` | README 迁移/MCP 风险提示 | 添加数据库迁移警告、可选 MCP 集成说明和 README 测试。 | `README.md`、`README.en.md` 含风险提示；`packages/opencode/test/docs/readme.test.ts`。 | 保留 | 中英文风险提示均存在。 |
| `6210bb5c3f` | 会话列表 limit/time range | TUI 会话列表增加 limit 与时间范围，优化检索性能。 | `packages/tui/src/context/sync.tsx` 使用 90 天 start 与 `limit: 1200`。 | 保留 | 文件从 opencode shim 转到 `packages/tui`，功能保留。 |
| `3f959c5549` | Playwright 安装流程 | Windows CI 使用锁定 Playwright CLI，增加 plugin deps 等测试。 | `.github/workflows/test.yml`；`packages/opencode/test/ci/upstream-e2e-workflow.test.ts`；`packages/opencode/test/fixture/plugin-deps.ts`。 | 保留 | 明确避免 `bunx playwright`。 |
| `f325360dd9` | 日志目录自愈 | 日志系统在目录缺失时恢复，测试覆盖。 | `packages/core/src/util/log.ts` 中 recursive mkdir 与 stream error ignore；`packages/opencode/test/util/log.test.ts`。 | 保留 | 自愈逻辑保留。 |
| `9878a7b146` | Playwright 1.60.0/E2E | 升级 Playwright 并添加 E2E workflow 测试。 | 根 `package.json` 中 `@playwright/test: 1.60.0`；`packages/opencode/test/ci/upstream-e2e-workflow.test.ts`。 | 保留 | 版本与测试均体现。 |
| `ac8ef7b82d` | voice recorder 缓冲 | 增强录音缓冲与测试。 | `packages/opencode/src/cli/cmd/tui/prompt-voice-recorder.ts` re-export；`packages/opencode/test/cli/tui/prompt-voice-recorder.test.ts`。 | 保留 | 实现主体已迁移到 `packages/tui`，兼容 shim 保留。 |
| `aeddbe5208` | prompts 注释/方案说明 | 更新 `docs/prompts.md` 中注释要求与方案构建说明。 | `docs/prompts.md` 存在且为当前提示词文档。 | 保留 | 文档仍在；具体措辞后续可能叠加修改。 |
| `bd6728445b` | 自动压缩边界标记 | TUI 渲染 compaction 边界标记与测试。 | `packages/opencode/src/session/compaction.ts` 有 compaction event/marker；`session-message-render.test.tsx` 覆盖。 | 保留 | marker 逻辑仍存在。 |
| `37843053f4` | WAV 录音与转录 | 添加 voice input/recorder、WAV 输出、转录配置与测试。 | `packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts` re-export；`config/tui-schema.ts` voice 配置；prompt-voice-input/recorder tests。 | 保留 | TUI voice 配置和测试仍在。 |
| `9398ed0d72` | compaction 文件证据 | evidence 记录文件大小/mtime，判断 current/stale/deleted。 | `packages/opencode/src/session/compaction.ts` 中 `modifiedMs`、`statEvidence`、evidence table。 | 保留 | 证据表含 total/modified/status。 |
| `ac96799d7e` | 兼容测试/env 支持 | 更新测试配置，增加环境变量兼容。 | `.github/workflows/test.yml`；`httpapi-listen.test.ts`；`session/prompt.test.ts`。 | 部分保留-风险 | 多处后续重构，未能确认每个 env 兼容点完全保留。 |
| `bc72f6c2eb` | auto-review 元数据/跨平台测试 | 自动审查元数据包含工具信息，测试脚本跨平台。 | `packages/opencode/src/permission/index.ts` review metadata；`reviewer-service.test.ts` patterns/shell evidence。 | 保留 | review metadata 与 shell evidence 仍被测试。 |
| `f16126f7ee` | Linux 测试/read 恶意提醒注释 | 修复 Linux 测试；注释 read tool 恶意代码提醒。 | `packages/opencode/src/tool/read.ts` 中高风险提醒逻辑被注释。 | 保留 | 原“注释提醒逻辑”仍体现。 |
| `abd9240ff8` | SDK 事件 timeout 10s | Windows 下 SDK 事件超时从 1s 调到 10s。 | `packages/opencode/test/server/httpapi-sdk.test.ts` 中 `duration: "10 seconds"`。 | 保留 | 已复核确认。 |
| `d7f6ce2fcf` | shell 隐藏诊断/输出 | ShellTool 支持隐藏诊断与压缩输出处理。 | `packages/opencode/src/tool/shell.ts`；`packages/opencode/src/tool/bash-compress.ts`；`shell.test.ts`。 | 保留 | 诊断 collector/appendix/compression 仍在。 |
| `ca4e54b976` | 修复测试不通过 | 修复 TUI/session/install/shell 多项测试。 | `install-script.test.ts`；`tool/shell.test.ts`；`session-message-render.test.tsx`。 | 保留 | 相关测试仍存在并被后续增强。 |
| `5022026137` | shell 等最终 metadata | ShellTool 返回前等待最终输出 metadata。 | `packages/opencode/src/tool/shell.ts` 在子进程 exit/abort/timeout 后 `Fiber.join(output)`，注释明确等待 stream 处理完最后 chunk 与 metadata。 | 保留 | 已复核确认。 |
| `b734bd7f4b` | sync 消息限制 | 增加 TUI session messages limit。 | `packages/tui/src/context/sync.tsx` 调用 `session.messages({ sessionID, limit: 300 })`。 | 保留 | 当前 hydration message limit 为 300。 |
| `4d817f4d95` | shell 执行 notice | 空输出/退出码处理，模型可见 execution notice。 | `packages/opencode/src/util/output-notice.ts`；`packages/opencode/src/tool/shell.ts`。 | 保留 | `formatExecutionNotice` 保留。 |
| `aab94207d0` | shell 压缩测试边界 | 更新测试/快照，关闭压缩验证截断边界。 | `packages/opencode/test/tool/shell.test.ts`；`parameters.test.ts.snap`。 | 保留 | 测试与快照仍在。 |
| `2f6cc1849c` | compaction evidence handoff | 压缩体验优化，添加 evidence handoff。 | `packages/opencode/src/session/compaction.ts` 中 `EVIDENCE_HANDOFF_KIND`；`message-v2.ts` 过滤逻辑；compaction/message-v2 tests。 | 保留 | evidence handoff 与过滤逻辑保留。 |
| `625f8b99bd` | harness 调研文档 | 添加 agent workflow forensic reports，为 harness 改善准备。 | `docs/opencode-agent-workflow-forensic-report.md`、`docs/opencode-deepseek--agent-workflow-forensic-report.md`、`docs/opencode-qwen-agent-workflow-forensic-report.md`。 | 保留 | 文档文件仍存在。 |
| `57fb3083ff` | README.zht/SMARK README | 全量更新 README，多语言说明 SMARK branch。 | `README.zht.md`、`README.en.md`、`README.md`。 | 保留 | 后续 README 仍含 SMARK 增强说明。 |
| `c90f03ed7c` | 归档 GitHub action integration | 将 `github/`、containers 等移动到 `archived/`。 | `archived/github/action.yml`；`archived/containers/README.md`。 | 保留 | 归档目录存在。 |
| `69385b87b0` | permission raw deny/env | 支持 raw deny 模式和环境变量处理。 | `packages/opencode/src/permission/index.ts` raw deny；`packages/opencode/src/tool/shell.ts` env expansion。 | 保留 | raw deny 与 PowerShell env 解析均体现。 |
| `4e83d3936d` | 版本号 1.15.16 | bump package/README/workflow 版本。 | `packages/opencode/package.json` 当前 `1.17.7-smark`。 | 版本号历史不适用 | 后续版本覆盖。 |
| `4ffd64a04a` | bash/shell 压缩优化 | 优化 bash-compress、shell 输出压缩和测试。 | `packages/opencode/src/tool/bash-compress.ts`；`packages/opencode/test/tool/bash-compress.test.ts`。 | 保留 | 压缩器增强版完整存在。 |
| `3d87c32fd8` | opencode_notice 格式 | 统一 shell 压缩/截断回显 notice 格式。 | `packages/opencode/src/util/output-notice.ts`；`docs/tool-output-notice-format-design.md`。 | 保留 | 当前工具输出实际也使用 `<opencode_notice ... />`。 |
| `67207006f5` | 配置项 | `.opencode`/gitignore/model snapshot 配置调整。 | `.opencode/opencode.jsonc`；`.opencode/.gitignore`；`.gitignore`。 | 保留 | 配置文件仍存在；model snapshot 另按历史不适用处理。 |
| `91fd83655d` | 子代理权限推导 | 子代理继承 parent agent/session 权限 ceiling，加强审计。 | `packages/opencode/src/agent/subagent-permissions.ts`；`packages/opencode/src/tool/task.ts`；`plan-mode-subagent-bypass` 和 `task.test.ts`。 | 保留 | 关键安全语义保留。 |
| `00ec4b85ca` | TUI 渲染开销 | 降低 context panel 与 dialog select 渲染开销。 | `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx`；`dialog-select.test.tsx`、`context-usage.test.ts`。 | 保留 | dialog select memo/identity key 仍在。 |
| `b29f35a0c3` | 记录 TUI 审计会话 | 修改 `.opencode` 并新增 `session-ses_1837.md`。 | 复核确认 `session-ses_1837.md` 存在，文件头为 `Opencode TUI 组件渲染审计报告`。 | 保留 | 初步审查误判缺失；当前已确认文件存在。 |
| `edae95237e` | 图片附件压缩边界 | 统一 image/read/registry/media 图片附件压缩边界。 | `packages/opencode/src/image/image.ts`；`packages/opencode/test/tool/read.test.ts`；`docs/draft/image-processing-unification-plan.md`。 | 保留 | image resize/limit 逻辑保留。 |
| `a91b23ab8f` | 图片边界测试 | 补充 image/read 图片附件边界用例。 | `packages/opencode/test/image/image.test.ts`；`packages/opencode/test/tool/read.test.ts`。 | 保留 | 测试文件仍存在。 |
| `2908d5c3cb` | React 性能技能/草案 | 添加 Vercel React best practices skill 与设计草案。 | `.opencode/skills/vercel-react-best-practices/SKILL.md`、rules；`docs/draft/tui-render-cost-implementation-plan.md`。 | 保留 | 大量 rules 文件仍在。 |
| `e58ec8b0ec` | 常用提示词模板 | 补充 `docs/prompts.md`。 | `docs/prompts.md`。 | 保留 | 文档仍存在。 |
| `3282685c3a` | daemon stop 后 TUI 退出 | 安全处理 stop 后 TUI 退出和 global handler。 | `packages/opencode/src/cli/cmd/daemon.ts`；`packages/opencode/test/cli/tui/daemon.test.ts`。 | 保留 | safe stop 与 exitCode 路径保留。 |
| `2910ec2094` | Bun exitCode 清理 | 修复 Linux 测试因 exitCode 未清理误失败。 | `packages/opencode/test/cli/tui/thread.test.ts`。 | 保留 | 与 `99f7330664` 同类。 |
| `000caddcbd` | Windows SDK 构建卡住 | SDK build 改用 Node 跑 tsc，避免 Bun 卡住。 | `packages/sdk/js/script/build.ts` 使用 `node ... tsc`。 | 保留 | 明确注释 Windows CI 边界。 |
| `738333f799` | Linux 测试异常 | 修复 TUI session message render Linux 测试。 | `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx`。 | 保留 | 测试文件仍存在。 |
| `99f7330664` | exitCode 重置 | 每次运行 test 后重置 exitCode。 | `packages/opencode/test/cli/tui/thread.test.ts`。 | 保留 | 与 `2910ec2094` 后续叠加。 |
| `f9dec59534` | Slot useRenderer | Slot 使用 renderer 唯一性，避免渲染树泄漏。 | `packages/opencode/src/cli/cmd/tui/plugin/slots.tsx` 使用 `useRenderer()` guard；`instruction.test.ts`。 | 保留 | guard 保留。 |
| `39f6ad23cb` | usage 404/Slot dispose/测试 | request usage 不存在返回 404；Slot dispose 清理旧视图；测试稳定化。 | `slots.tsx` 有 dispose；`handlers/session.ts` 对 missing `request_usage` 返回 `HttpApiError.NotFound`；`groups/session.ts` 声明 404。 | 保留 | 已复核确认。 |
| `0baf112723` | network proxy | 基础设施 HTTP client 支持代理请求；测试注入修正。 | `packages/core/src/network-proxy.ts`；`packages/core/src/models-dev.ts`；`packages/core/test/network-proxy.test.ts`。 | 保留 | `infrastructureHttpClientLayer` 保留。 |
| `f9a6e97e3c` | VSIX 文档/打包 | 完善 IDE Bridge/VSIX 打包流程。 | `docs/VSIX-Packaging.md`；`sdks/vscode/README.md`；`sdks/vscode/script/vsix.ts`。 | 保留 | 文档和脚本均存在。 |
| `af643f7f77` | workflow 解析/包测试 | 修复 test workflow 解析和上游包测试命令。 | `.github/workflows/test.yml`；`packages/opencode/test/ci/upstream-e2e-workflow.test.ts`。 | 保留 | workflow 当前有核心/警告分层。 |
| `751a481533` | 会话搜索收敛 | Session search 限定可见字段，避免整段 JSON/hidden/tool result 命中。 | `packages/core/src/session/search.ts`；`packages/opencode/test/server/session-list.test.ts`。 | 上游等价覆盖 | 原 `packages/opencode/src/session/search.ts` 已迁移到 core。 |
| `3798c7696f` | auto-review 失败回退人工 | reviewer 失败默认回到 user approval。 | `packages/opencode/src/permission/auto.ts`；`packages/opencode/test/permission/auto.test.ts`。 | 保留 | 默认 fallback=user 保留。 |
| `77d9a32b4f` | actions 流程重构 | CI 区分核心必过和上游 warning。 | `.github/workflows/test.yml`；`.github/workflows/typecheck.yml`。 | 保留 | `continue-on-error: true` 的 warning job 保留。 |
| `bd57082d7a` | 归档旧 test workflow | 将旧 workflow 归档。 | `archived/github-workflows/test.yml`；`.github/workflows/test.yml`。 | 保留 | 旧 workflow 在 archived，当前新 workflow 在 `.github`。 |
| `0b4c22d4a2` | reviewer 复用 chat provider hook | 兼容 Codex 审查请求，复用 provider hook。 | `packages/opencode/test/permission/reviewer-service.test.ts`；`permission/reviewer/service.ts`。 | 保留 | 测试验证 hook header 与 max_output_tokens 处理。 |
| `a0714815cb` | 归档非核心 Actions | 归档 beta/publish/review 等非核心 workflows。 | `archived/github-workflows/beta.yml` 等；当前 `.github/workflows` 主要为 test/build/typecheck。 | 保留 | 归档目录完整存在。 |
| `290ba976a3` | daemon stop/status | 增加 TUI shared daemon 管理，支持 graceful stop/status。 | `packages/opencode/src/cli/cmd/daemon.ts`；`packages/opencode/src/index.ts`；`daemon.test.ts`。 | 保留 | `daemon stop` 命令保留；status 在 daemon/server-lock 侧。 |
| `6b7ac3cdcb` | endpoint-status | daemon 侧 provider endpoint 状态查询，TUI 读取统一网络状态。 | `packages/opencode/src/server/shared/tui-endpoint-status.ts`；`packages/opencode/test/server/tui-provider-endpoint-status.test.ts`。 | 保留 | 使用 `NetworkProxy.resolveProxyRoute/routedFetch`。 |
| `60f600d1dc` | compaction memento rawHistory | memento 从 rawHistory 采集并按 20%/20K budget 截断。 | `packages/opencode/src/session/compaction.ts` 中 budget 常量与 recent user memento；compaction tests。 | 保留 | budget 常量和 recent user memento 仍在。 |
| `4ed5d29c6b` | 保留最近用户指令 | compaction 保存最近用户消息到 memento。 | `packages/opencode/src/session/compaction.ts` 中 `collectRecentUserMessages`；`message-v2.ts` 过滤逻辑。 | 保留 | `collectRecentUserMessages` 保留。 |
| `9d86acdde9` | compaction tail 参数 | 调整默认 tail turns 和 preserve token 参数。 | `packages/opencode/src/session/compaction.ts` 中 `DEFAULT_TAIL_TURNS=4`、`DEFAULT_PRESERVE_RECENT_USER_TOKENS=20000`。 | 保留 | 参数保留。 |

## 总结

非 merge 提交总数：326。

已完整记录：326。

明确保留或等价覆盖：大多数功能性提交均有当前实现路径或测试证据，尤其是 daemon/server-lock、TUI package 迁移、voice/notebook、bash/shell 压缩、PowerShell/编码、request_usage、stats dashboard、context usage、permission auto-review、NetworkProxy、SDK/VSIX、CI/Windows 兼容与 compaction evidence handoff。

历史不适用：版本号 bump、模型快照类提交已由后续版本或上游快照覆盖，其中 `packages/core/src/models-snapshot.js` 已按用户指示不作为重要保留目标。

本轮已处理的明确退化：`990ddcb47d` 手动 compact toast/error、`56bce83a05` read 默认 400/24KB/不截长行、`packages/core/src/tool-output-store.ts` 的 1000 行/16 KiB、`bba9c227df` EventSource fixture cleanup、`d302fa6f05` claudecode 动态鉴权，以及 daemon 首启 missing WAL / SSE disconnect 竞态。

仍需补证的风险：`350a442717` 和 `188cbee1b7` 这类大范围 bugfix commit 的细粒度逐项等价性仍无法完全形式化证明；当前以相关实现路径、focused tests 与 typecheck 作为保留证据。
