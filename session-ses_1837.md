# Opencode TUI 组件渲染审计报告

**Session ID:** ses_183716f51ffezgG3ZfCWjQnwqy
**Created:** 2026/5/31 13:42:58
**Updated:** 2026/5/31 15:08:43

---

## User

当前需要你完整检查检查我们的Opencode的TUI各个组件的整体实现是否低渲染开销且代码量实现简洁而不臃肿：

参考F:\ML\PythonAIProject\Claude-Code\opencode\.opencode\skills\vercel-react-best-practices\SKILL.md

审计的目标库在packages/opencode/src中

请你完整审计分析，病给出完整的可读报告（包括表格等）与建议，暂不实施修改

---

## Assistant (Auto · GPT-5.5 · 22.9s)

我会先按“只审计不修改”的方式读取参考准则和 TUI 目录结构，再分组件区域检查渲染路径、hook 使用、状态订阅、列表渲染和代码复杂度。

**Tool: read**

**Tool: glob**

**Tool: grep**

**Tool: grep**

**Tool: glob**

---

## Assistant (Auto · GPT-5.5 · 9.5s)

**Tool: todowrite**

---

## Assistant (Auto · GPT-5.5 · 21.1s)

初步发现 TUI 不是 React DOM/Next，而是 `@opentui/solid` + Solid JSX；我会用参考规则中的“减少订阅、派生状态、热路径列表、定时器/事件监听、静态 JSX/重计算”来等价审计。

**Tool: grep**

**Tool: grep**

**Tool: glob**

**Tool: glob**

**Tool: glob**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 297.4s)

TUI 规模较大，核心 session 文件本身超过 3000 行。我会并行做三条只读审计分支：主 session 热路径、弹窗/列表、插件/侧栏/动画，同时继续在主线程核对关键状态流。

**Tool: task**

**Tool: task**

**Tool: task**

---

## Assistant (Auto · GPT-5.5 · 20.0s)

**Tool: todowrite**

---

## Assistant (Auto · GPT-5.5 · 13.2s)

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 14.6s)

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 8.4s)

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 18.5s)

**Tool: grep**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 16.9s)

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 15.7s)

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 20.3s)

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 17.0s)

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 16.0s)

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 16.2s)

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 19.3s)

**Tool: glob**

**Tool: grep**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 19.5s)

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 19.7s)

**Tool: read**

**Tool: read**

**Tool: grep**

**Tool: grep**

---

## Assistant (Auto · GPT-5.5 · 13.0s)

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 10.8s)

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 11.3s)

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 18.3s)

**Tool: todowrite**

---

## Assistant (Auto · GPT-5.5 · 65.2s)

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 23.5s)

**Tool: todowrite**

---

## Assistant (Auto · GPT-5.5 · 13.7s)

**Tool: todowrite**

---

## Assistant (Auto · GPT-5.5 · 92.7s)

**总体结论**
未实施任何代码修改。本次是静态审计，范围集中在 `packages/opencode/src/cli/cmd/tui` 及其相关 `token/accounting.ts`。

TUI 当前不是 React/Next，而是 `@opentui/solid` + Solid JSX。因此我把参考的 Vercel React 规则映射为 Solid/OpenTUI 里的等价关注点：订阅粒度、派生状态、列表渲染、事件批处理、热路径计算、定时器、I/O 请求去抖、静态 JSX/重计算、以及大组件拆分。

整体判断：TUI 已经有不少性能意识，尤其是 SSE 批处理、part delta 合并、viewport culling、完成态 markdown keyed rendering、插件生命周期清理。但仍存在几个明显的“先做昂贵计算，再节流展示”的反模式，尤其集中在 token accounting、context usage 面板、prompt/autocomplete、通用 DialogSelect。代码简洁性方面，`Session`、`Prompt`、`Autocomplete` 已经明显过大，局部实现偏臃肿，后续维护容易引入宽订阅和热路径退化。

**范围**
| 区域 | 重点文件 | 审计重点 |
|---|---|---|
| 根渲染与生命周期 | `app.tsx`, `context/sdk.tsx`, `context/sync.tsx`, `context/sync-v2.tsx` | SSE 批处理、store 更新、provider 层级、路由渲染 |
| session 主界面 | `routes/session/index.tsx`, `footer.tsx`, `sidebar.tsx`, `context-usage.tsx`, `subagent-footer.tsx` | 长列表、消息/part 渲染、工具卡片、滚动、token 统计 |
| prompt 输入 | `component/prompt/index.tsx`, `autocomplete.tsx`, `history.tsx`, `stash.tsx`, `frecency.tsx` | 每次输入的热路径、autocomplete 请求、extmark 同步、草稿管理 |
| 弹窗系统 | `ui/dialog*.tsx`, `component/dialog-*.tsx` | 通用选择器、过滤/排序、深比较、预览请求 |
| 内置插件 | `feature-plugins/**`, `plugin/**` | sidebar 聚合、插件状态 API、轮询、which-key、debug route |
| 动画/绘制 | `component/bg-pulse*.ts*`, scrollbar render hooks | 每帧工作量、缓存、FPS 管控 |

**评分**
| 维度 | 评分 | 说明 |
|---|---:|---|
| 渲染架构 | 7/10 | Solid 细粒度响应式 + OpenTUI viewport culling 用得正确，但部分派生计算订阅太宽 |
| 流式事件处理 | 8/10 | `SDKProvider` 16ms 批处理和 `SyncProvider` part delta 合并是强项 |
| 热路径计算 | 5/10 | 多处 full session scan、JSON clone、fuzzy/filter/sort 在高频路径触发 |
| 列表/长内容渲染 | 7/10 | session 主列表有 culling，tool block 有折叠，但 dialog/select 与 autocomplete 仍偏重 |
| 代码简洁性 | 5/10 | 大文件过大，职责混合；多个 UI 区域重复做 token accounting 和状态聚合 |
| 插件隔离 | 8/10 | slot/runtime 生命周期、dispose、renderer guard 做得较好 |

**做得好的地方**
| 位置 | 好实践 | 价值 |
|---|---|---|
| `context/sdk.tsx:82-109` | SSE event queue 以 16ms 窗口 `batch` emit | 避免 token 级事件导致每条事件单独刷新 |
| `context/sync.tsx:185-233` | `message.part.delta` coalesce 后再 `batch` 应用 | 明确减少流式 part 更新的响应式抖动 |
| `context/sync.tsx:683-773` | bootstrap 并行拉取 config/provider/session/lsp/mcp 等 | 符合 Vercel `async-parallel` 思路，避免启动瀑布 |
| `routes/session/index.tsx:246-248`, `1241-1263` | session viewport culling + sticky scroll | 长会话场景下避免全量可视树渲染压力 |
| `routes/session/index.tsx:1713-1724`, `1792-1827` | reasoning/text 完成态按 width/content keyed remount | 避免完成态 markdown/code 在无关更新时重复解析 |
| `routes/session/index.tsx:1961-2000` | pending tool input 增量 parser + timer gate | 对 streamed raw input 是正确方向 |
| `routes/session/index.tsx:2302-2311`, `2359-2367` | `BlockTool` 同步决定折叠，避免先挂载大 diff 再隐藏 | 大 diff/write/edit 输出的初始渲染成本可控 |
| `component/bg-pulse.tsx:77-87`, `component/bg-pulse-render.ts:225-259` | 动画组件降低 renderer FPS 到 30，并增量构建 frame cache | 动画成本被封装且有缓存 |
| `plugin/slots.tsx:26-33`, `71-78` | slot registry renderer guard + dispose 后恢复 no-op | 避免多 TUI/test 实例互相泄漏渲染树 |
| `plugin/runtime.ts:397-451`, `571-609` | 插件 scope 用 AbortController 和 disposer 反向清理 | 插件生命周期边界清晰 |

**主要发现**
| 优先级 | 区域 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| P1 | token accounting 重复 full scan，且节流发生在昂贵计算之后 | `component/prompt/index.tsx:373-409`, `feature-plugins/sidebar/context.tsx:39-75`, `routes/session/subagent-footer.tsx:50-83`, `token/accounting.ts:102-241` | Prompt、sidebar、subagent footer 会各自扫描 session messages/parts。流式 part 更新时，50ms throttle 只节流展示，不节流 `tokenAccounting()` 本身 | 把 usage/accounting 提升为共享派生源，按 sessionID 建一个 throttled/incremental accounting。节流应包住源读取和 `tokenAccounting()`，不是只包住结果 signal |
| P1 | Context usage 面板每次响应式变化先 JSON 深克隆，再 throttle | `routes/session/context-usage.tsx:236-260` | 面板打开时，每个 message/part/dimension/provider 变化都会先 `JSON.stringify/parse` 完整 snapshot，然后才进入 500ms throttle | 把 snapshot 构建移动到 throttled callback/resource 内。用 revision signal 触发，timer 到点后再读取当前 store 并深克隆 |
| P1 | 通用 `DialogSelect` 用深比较和 `JSON.stringify` 作为行 id | `ui/dialog-select.tsx:82-94`, `180-210`, `424-449` | 大列表中 active/current/mouseover/mousedown 都可能触发 `isDeepEqual` 或 `JSON.stringify`。模型、session、tool 列表越大越明显 | 给 `DialogSelectOption` 增加稳定 `key` 或 `getKey`，内部 selected/current 都按 key/index 比较，DOM/renderable id 也用 key |
| P1 | Autocomplete 对输入变化直接发文件搜索和 fuzzy 组合，无明显 debounce/stale guard | `component/prompt/autocomplete.tsx:374-425`, `427-462`, `567-610` | 用户每输入一个字符可能触发 SDK `find.files`、排序、frecency、fuzzysort。远程/大仓库时容易卡输入 | 对 `search()` 增加 80-150ms debounce，给请求加 generation/AbortController，旧结果不回写。优先返回最近缓存/本地 alias，远端结果异步补齐 |
| P2 | Prompt 每次内容变更都同步 extmarks，并可能做多重文本扫描 | `component/prompt/index.tsx:854-910`, `1692-1698` | 每次键入都会 `getAllForTypeId`，对每个 extmark 用 `text.indexOf` 查找 placeholder，再 `restoreExtmarksFromParts`。普通短 prompt 没事，多附件/大粘贴时偏重 | 只在 extmark 相关操作、提交前、或 cursor/文本包含虚拟片段时同步。维护 `partsRevision`，避免普通文本输入重建 extmarks |
| P2 | Assistant part 可见性计算有 O(parts²) 形态 | `routes/session/index.tsx:1575-1630` | `visiblePartIDs()` 扫描后，每个 part 又 `indexOf`，还通过 `find` 查上一个 visible part。多 tool/text/reasoning part 的消息会放大 | 一次性派生 `visibleParts` 和 `visibleIndexByID: Map`，part 渲染只做 O(1) lookup |
| P2 | session scrollbar hook 每帧/每 render 遍历所有 children 并分配数组 | `routes/session/index.tsx:296-309`, `1251-1258` | `drawSessionScrollbar` 内调用 `getChildrenSortedByPrimaryAxis().flatMap(...)`，长会话下每次滚动/渲染都会有遍历和 allocation | 缓存 user-message marker 数据。若 OpenTUI 有可见 children API，优先只看 visible children。至少把 `flatMap` 改成无分配 loop |
| P2 | `InlineTool.renderBefore` 里读布局并 `setMargin`，存在布局反馈成本 | `routes/session/index.tsx:2170-2243`, `feature-plugins/system/session-v2.tsx:621-678` | 每个 inline tool 在 render hook 里找 parent/children/previous，可能触发状态写。v1 已有 `ToolPartTopMargin`，但 fallback 仍在 | 在构建 message render model 时确定 spacing，作为 prop 传下去。保留 fallback 仅给外部/legacy 调用 |
| P2 | Model dialog 每次 query 都重建 provider/model 全量列表，且重复 `.some()` | `component/dialog-model.tsx:23-121` | provider catalog 变大时，每个输入字符会排序 providers、entries、filter、favorites/recents membership 检查和 fuzzysort | 拆成 base options memo 和 query filter memo。favorites/recents 用 `Set`，避免 N×M `.some()` |
| P2 | Session list preview 会一次性为最多 50 个 session 拉预览，缺少 stale/cancel guard | `component/dialog-session-list.tsx:53-119` | 打开 session 列表或搜索变化时会发最多 50 session 的分页 message 请求。关闭弹窗后仍可能回写 preview | 增加 generation token/onCleanup guard。只为可见 rows 或 hover/idle 后加载。`scanned += limit` 应改为按实际 `messages.length` 计数 |
| P2 | Plugin state API 每次调用都分配/排序，sidebar/footer 再叠加扫描 | `plugin/api.tsx:154-189`, `feature-plugins/sidebar/mcp.tsx:10-18`, `feature-plugins/home/footer.tsx:21-27`, `feature-plugins/sidebar/files.tsx:10` | `api.state.mcp()` 每次 `Object.entries().sort().map()`，多个插件消费后再 `filter/count` | 在 sync/API 层提供稳定派生：`mcpList`, `mcpConnectedCount`, `mcpHasError`, `lspCount`, `sessionDiffFiles` |
| P2 | Sidebar provider endpoint 每秒轮询 | `feature-plugins/sidebar/context.tsx:78-155` | sidebar 可见时每 1s fetch daemon endpoint status。daemon 虽有缓存，但每个 TUI 仍会产生状态更新和请求 | 稳定后指数退避。只在 sidebar 可见、session running、或 model/provider 变化后短期轮询。更理想是 daemon 推 SSE 状态 |
| P2 | Prompt、sidebar、subagent footer 的 usage UI 代码重复 | `component/prompt/index.tsx:373-409`, `feature-plugins/sidebar/context.tsx:39-75`, `routes/session/subagent-footer.tsx:50-83` | 三处独立维护同一业务概念，性能修复需要改三份，且展示口径容易漂移 | 抽出 `useSessionUsage(sessionID, options)` 或 Sync 派生接口，UI 只负责布局 |
| P2 | 大文件职责过宽 | `routes/session/index.tsx` 共 3116 行，`component/prompt/index.tsx` 共 1996 行，`component/prompt/autocomplete.tsx` 共 869 行 | 不是直接 runtime bug，但维护成本高，热路径边界难看清，容易把新逻辑塞进主组件 | 按稳定 seam 拆分：message render model、tool cards、concrete tool views、session commands、prompt submission、prompt attachments、autocomplete sources |
| P3 | Footer 对 MCP/LSP 做重复宽扫描 | `routes/session/footer.tsx:13-19` | `Object.values(sync.data.mcp)` 被算两次，`Object.keys(sync.data.lsp)` 对数组语义不清且分配 | 合并成一个 memo 返回 `{ connectedMcp, hasMcpError, lspCount }`，LSP 用 `sync.data.lsp.length` |
| P3 | Home tips 为显示一个随机 tip 订阅了大量 shortcut，并 flatMap 全部 tips | `feature-plugins/home/tips-view.tsx:97-148`, `164-288` | 首页 tip 不是关键热路径，但当前会解析/订阅很多实际不显示的 shortcut | 先选候选 tip，再解析该 tip 需要的 shortcut。静态 tip 的 `parse()` 结果可预编译 |
| P3 | which-key 默认禁用，但启用后仍可优化 visible gating | `feature-plugins/system/which-key.tsx:184-258`, `450-465`, `602-605` | `active()`、group/sort、grid cell memo 较多。默认 disabled，所以风险低 | `visible()` 为 false 时不计算 grouped/shown。避免 cell 内 `createMemo`，用局部变量 |
| P3 | debug `session-v2` 有 O(n²) message lookup 和 layout read fallback | `feature-plugins/system/session-v2.tsx:65-69`, `105-120`, `621-678` | 仅 experimental/debug gated，影响有限 | 构建 render model 时一遍算 previous user timestamp 和 tool spacing |
| P3 | 若干 focus `setTimeout(..., 1)` 分散且无显式取消 | `ui/dialog.tsx:77-92`, `ui/dialog-select.tsx:376-384`, `ui/dialog-prompt.tsx:23-30`, `ui/dialog-export-options.tsx:75-82` | 有 `isDestroyed` guard，实际风险低，但重复且不够整洁 | 提供 `focusSoon(renderable)` 小工具，集中 cleanup 和 destroyed check |
| P3 | 部分副作用放在组件 body 或简单 memo 过多 | `component/dialog-skill.tsx:10-15`, `component/dialog-agent.tsx:10-18`, `component/use-connected.tsx:4-8` | Solid 组件 body 通常只执行一次，风险不高，但一致性和可读性一般 | `dialog.setSize("large")` 移到 `onMount`。简单 memo 保留在确有稳定 identity/昂贵计算时 |

**Vercel 规则映射**
| Vercel React 类别 | TUI/Solid 等价检查 | 当前状态 |
|---|---|---|
| Eliminating Waterfalls | 启动和 session sync 是否并行 | 较好。`sync.tsx` bootstrap 和 session sync 多处用 `Promise.all` |
| Bundle Size Optimization | barrel import/动态 import | 对 TUI binary 不是主要瓶颈。本次未发现明显前端 bundle 型问题 |
| Client Data Fetching | 请求去重、全局 listener/轮询去重 | 中等。SSE 集中得好，但 autocomplete 和 sidebar endpoint polling 还有优化空间 |
| Re-render Optimization | 宽订阅、派生状态、先算后 throttle | 主要问题。token accounting/context snapshot 是典型反模式 |
| Rendering Performance | 长列表、静态内容、折叠、viewport | 主 session 好，dialog/autocomplete 和 scrollbar hook 还有改进空间 |
| JavaScript Performance | repeated lookup、Set/Map、合并遍历 | 多处可用 Set/Map 和单 pass 降低扫描，尤其 DialogModel、DialogSelect、plugin API aggregates |
| Advanced Patterns | transient values 用 ref/非响应式变量、稳定事件 | 多处使用 module/global guard 和 cleanup 较好，但 renderBefore 状态写应减少 |

**代码简洁性评估**
| 模块 | 当前形态 | 问题 | 建议拆分边界 |
|---|---|---|---|
| `routes/session/index.tsx` | 3116 行，包含 route、命令、消息渲染、工具框架、具体工具 | 职责太多，局部优化难做，工具渲染映射和 layout 规则混在一起 | `session-commands.tsx`, `message-list.tsx`, `assistant-message.tsx`, `tool-card.tsx`, `tools/*.tsx` |
| `component/prompt/index.tsx` | 1996 行，包含输入、提交、workspace、paste、usage、footer UI | 输入热路径和业务提交交织，extmark 同步难独立优化 | `prompt-submit.ts`, `prompt-attachments.ts`, `prompt-usage.tsx`, `prompt-footer.tsx` |
| `component/prompt/autocomplete.tsx` | 869 行，sources、filter、render、insert 都在一起 | 请求、排序、render 状态耦合，难给 source 单独加 debounce/cache | `autocomplete-sources.ts`, `autocomplete-filter.ts`, `autocomplete-view.tsx` |
| `ui/dialog-select.tsx` | 583 行，通用性强但 value identity 不明确 | 深比较/JSON id 是设计债 | 引入 key API 后内部结构会更简单 |
| `feature-plugins/sidebar/context.tsx` | 208 行，但包含 usage accounting 和 provider latency polling | 两个互不相关的职责 | 拆成 usage view 和 endpoint-status view，或 endpoint status 交给 sync/API |

**推荐路线图**
| 阶段 | 目标 | 预期收益 |
|---|---|---|
| 1 | 修正 `tokenAccounting` 和 `ContextUsagePanel` 的“先算后节流” | 最大幅降低 streaming 时 CPU 抖动，prompt/sidebar/subagent 同时受益 |
| 2 | 给 `DialogSelect` 引入稳定 key/index，去掉深比较和 `JSON.stringify` row id | 改善所有通用选择弹窗，降低大列表交互成本 |
| 3 | Autocomplete 增加 debounce、stale guard、source 分层 | 减少输入时 I/O 和 fuzzy 计算对响应性的影响 |
| 4 | 为 session message 构建 render model | 一次性解决 visible parts、tool spacing、previous sibling lookup 等 O(n²)/layout hook 问题 |
| 5 | 在 Sync/API 层加 aggregates/indexes | sidebar、footer、plugin 消费减少重复 `Object.entries/filter/sort` |
| 6 | 拆分 `Session`、`Prompt`、`Autocomplete` 大文件 | 降低后续改动复杂度，减少性能回归概率 |

**优先建议**
1. 先做共享 `useSessionUsage` 或 sync-level accounting cache。当前三处重复 `tokenAccounting` 是最值得优先处理的性能和代码量问题。
2. 然后修 `ContextUsagePanel` 的 snapshot 节流位置。它是打开面板后的明确重计算热点。
3. 再改 `DialogSelect` 的稳定 key 设计。这个改动能同时影响 command/session/model/tool/mcp 等多个弹窗。
4. Autocomplete 应作为 prompt 响应性的专项优化处理，重点是 request debounce 和 stale response guard。
5. 大文件拆分建议放在性能修复之后做，避免纯移动代码和行为改动混在一起。

**残余风险**
本次没有跑交互式 TUI benchmark，也没有采样 CPU profile。结论基于源码静态审计和热路径推断。若要验证，应优先测三个场景：长会话 streaming、打开 `/context` 面板 streaming、在大仓库中快速输入 `@` 文件 autocomplete。

---

## User

请先不要实施代码修改。请基于当前仓库的已有设计思想、模块边界、代码风格和测试组织，为本次需求构建一份完整、可执行、克制的实现方案。
要求：
- 按照项目现有设计理念和分层方式解决问题。
- 优先复用或微调已有逻辑；不要新增不必要抽象、状态机、配置项、公共 API 或大范围重构。
- 不要过度假设不存在的问题；只处理本需求真实需要覆盖的正常路径、边界路径和错误路径。
- 修改应是手术刀式的：切入点少、行为链路清晰、git 净增量和文件数可控。
- 如果旧逻辑冗余、过期、重复或与新需求冲突，请说明应删除/替换/收敛，而不是叠加新逻辑。
- 注释只解释非显然约束、安全边界、兼容性原因、常量含义和不变量；需要注释时使用清晰中文。
请输出：
1. 需要阅读和确认的现有文件/测试/文档。
2. 当前相关逻辑的职责边界和必须保持的既有行为。
3. 推荐的最小实现方案，并说明为什么比其他方案更符合现有设计。
4. 预计修改/新增/删除的文件，以及每个文件的具体改动。
5. 正常路径、错误路径、并发/退出/清理/安全边界的处理方式。
6. 行为级测试计划：先写哪些测试、当前实现下会暴露什么缺口、实现后如何验证。
7. 建议运行的验证命令。
8. 预估 git 文件数、增删行数和是否涉及生成文件/迁移/文档。
9. 真实风险与开放问题；没有必须用户决策的问题就不要阻塞。
只输出方案，不要改代码。
最终请给出推荐方案摘要。 

因此将完整实现方案写入F:\ML\PythonAIProject\Claude-Code\opencode\docs\draft的markdown中

---

## Assistant (Auto · GPT-5.5 · 26.0s)

我会先补充确认 `docs/draft`、相关测试组织和 package 验证命令，然后只新增一份方案 Markdown，不改实现代码。

**Tool: glob**

**Tool: glob**

**Tool: glob**

**Tool: grep**

**Tool: read**

**Tool: glob**

**Tool: glob**

**Tool: glob**

---

## Assistant (Auto · GPT-5.5 · 13.9s)

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 65.7s)

**Tool: grep**

---

## Assistant (Auto · GPT-5.5 · 9.1s)

**Tool: read**

---

## Assistant (Auto · GPT-5.5 · 30.1s)

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant (Auto · GPT-5.5)

---

## User

---

## Assistant (Compaction · GPT-5.5 · 81.4s)

## Goal
- 为 Opencode TUI 低渲染开销/代码简洁性改进构建一份完整、可执行、克制的实现方案，并写入 `F:\ML\PythonAIProject\Claude-Code\opencode\docs\draft` 下的 Markdown，不实施代码修改。

## User Constraints & Preferences
- 暂不实施功能代码修改。
- 方案必须基于当前仓库已有设计思想、模块边界、代码风格和测试组织。
- 优先复用或微调已有逻辑；不要新增不必要抽象、状态机、配置项、公共 API 或大范围重构。
- 只处理真实需要覆盖的正常路径、边界路径和错误路径，不要过度假设问题。
- 修改应是手术刀式：切入点少、行为链路清晰、git 净增量和文件数可控。
- 旧逻辑若冗余/过期/重复/冲突，应说明删除/替换/收敛，而不是叠加新逻辑。
- 注释只解释非显然约束、安全边界、兼容性原因、常量含义和不变量；需要注释时使用清晰中文。
- 方案输出需包含 9 项：
  1. 需要阅读和确认的现有文件/测试/文档。
  2. 当前相关逻辑的职责边界和必须保持的既有行为。
  3. 推荐的最小实现方案，并说明为什么比其他方案更符合现有设计。
  4. 预计修改/新增/删除的文件，以及每个文件的具体改动。
  5. 正常路径、错误路径、并发/退出/清理/安全边界的处理方式。
  6. 行为级测试计划：先写哪些测试、当前实现下会暴露什么缺口、实现后如何验证。
  7. 建议运行的验证命令。
  8. 预估 git 文件数、增删行数和是否涉及生成文件/迁移/文档。
  9. 真实风险与开放问题；没有必须用户决策的问题就不要阻塞。
- 最终需要给出推荐方案摘要。
- 方案需写入 `F:\ML\PythonAIProject\Claude-Code\opencode\docs\draft` 的 Markdown 文件。

## Progress
### Done
- 已完成一次 TUI 静态审计报告，范围为 `packages/opencode/src/cli/cmd/tui` 及相关 `packages/opencode/src/token/accounting.ts`。
- 确认 TUI 技术栈是 `@opentui/solid` + Solid JSX，不是 React DOM/Next；Vercel React 规则需等价映射为 Solid/OpenTUI 的订阅粒度、派生状态、列表渲染、事件批处理、热路径计算、定时器等。
- 审计主要结论：
  - 整体已有较多性能意识：SSE 批处理、part delta 合并、viewport culling、完成态 markdown keyed rendering、插件生命周期清理。
  - 主要问题集中在“先做昂贵计算，再节流展示”：token accounting、context usage snapshot、DialogSelect 深比较、Autocomplete 请求/fuzzy 热路径。
- 已开始为“实现方案文档”补充读取现有测试/文档组织：
  - `docs/draft/**` glob 返回 `No files found`，但 `docs/` 目录存在 `draft/`。
  - 已读取 `packages/opencode/package.json`，确认脚本：
    - `"typecheck": "tsgo --noEmit"`
    - `"test": "bun test --timeout 30000"`
    - `"test:ci": "mkdir -p .artifacts/unit && bun test --timeout 30000 --reporter=junit --reporter-outfile=.artifacts/unit/junit.xml"`
  - 已发现 TUI 相关测试位于 `packages/opencode/test/cli/tui/**`，包括 `context-usage.test.ts`, `token-estimate.test.ts`, `prompt-submit-race.test.ts`, `plugin-lifecycle.test.ts` 等。

### In Progress
- 正在产出实现方案 Markdown，尚未写入 `docs/draft`。
- 方案应基于前次审计，优先覆盖最小、可测试、低风险的改动路线：
  1. 收敛/共享 token accounting 的重复 full scan，并把节流移动到昂贵计算之前。
  2. 修正 context usage 面板的 JSON snapshot 节流位置。
  3. 给 `DialogSelect` 增加稳定 key/index 比较，减少深比较和 `JSON.stringify`。
  4. 为 Autocomplete 增加 debounce/stale guard。
  5. 其余中低优先级仅列入后续建议，不在本轮手术刀式实现中强推。

### Blocked
- `(none)`

## Files & Code
- `F:\ML\PythonAIProject\Claude-Code\opencode\.opencode\skills\vercel-react-best-practices\SKILL.md`: 审计参考准则；需映射到 Solid/OpenTUI 语境。
- `F:\ML\PythonAIProject\Claude-Code\opencode\docs\draft\`: 目标写入目录；当前 glob `docs/draft/**` 未找到文件，目录存在但为空。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\package.json`: 验证命令来源；`typecheck`, `test`, `test:ci`。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\context\sdk.tsx`: `SDKProvider`；`context/sdk.tsx:82-109` SSE event queue 16ms `batch`，是必须保持的既有性能设计。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\context\sync.tsx`: `SyncProvider`；`context/sync.tsx:185-233` part delta coalesce，`683-773` bootstrap 并行拉取；是现有状态同步边界。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\context\sync-v2.tsx`: experimental/debug v2 message sync；当前不应作为主方案重点。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\routes\session\index.tsx`: session 主界面，约 3116 行；重点热路径包括：
  - `drawSessionScrollbar`：`296-309`, `1251-1258` 每次 render hook 遍历 children。
  - visible parts：`1575-1630` 有 O(parts²) 形态。
  - `createPendingToolInputStats`：`1961-2000` 已有增量 parser + timer gate，是可复用风格。
  - `BlockTool`：`2302-2311`, `2359-2367` 已同步决定折叠，需保持。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\routes\session\context-usage.tsx`: `contextUsageSnapshot()` 在 `27-31` 用 `JSON.stringify/parse` 读取 nested Solid store；`236-260` 当前先深克隆再 throttle，是 P1 改动点。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\routes\session\subagent-footer.tsx`: `SubagentFooter`; `50-83` 重复 `tokenAccounting()`，且 throttle 在昂贵计算之后。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\feature-plugins\sidebar\context.tsx`: sidebar context usage；`39-75` 重复 `tokenAccounting()`，`78-155` provider endpoint 1s polling。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\component\prompt\index.tsx`: Prompt 主文件，约 1996 行；`373-409` usage/token 统计重复扫描，`854-910` extmarks 同步，`1692-1698` 每次内容变更同步 prompt parts。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\token\accounting.ts`: `tokenAccounting()`；`102-241` 一次遍历统计，但当前多个 UI 消费端重复调用。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\ui\dialog-select.tsx`: `DialogSelect`；`82-94`, `180-210`, `424-449` 使用 `isDeepEqual`/`JSON.stringify` 作 active/current/row id，是 P1 改动点。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\component\dialog-model.tsx`: `DialogModel`; `23-121` 每次 query 重建 provider/model 全列表，重复 `.some()`。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\component\dialog-session-list.tsx`: `DialogSessionList`; `53-119` 最多 50 session preview 请求，缺少 stale/cancel guard。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\component\prompt\autocomplete.tsx`: `Autocomplete`; `374-425`, `427-462`, `567-610` 输入变化触发文件搜索、排序、frecency、fuzzysort；需 debounce/stale guard。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\cli\tui\context-usage.test.ts`: 可能承接 context usage snapshot/throttle 行为级测试。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\cli\tui\token-estimate.test.ts`: TUI token 相关已有测试参考，但没有找到 `tokenAccounting` 专门测试。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\cli\tui\prompt-submit-race.test.ts`: Prompt 并发/竞态测试组织参考。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\fixture\tui-runtime.ts`: TUI 测试 fixture 参考。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\fixture\tui-plugin.ts`: 插件/TUI fixture 参考。

## Errors & Fixes
- `docs/draft/**` glob 输出：`No files found`; 状态：`docs/` 目录读取确认存在 `draft/`，说明目标目录为空而非缺失。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\component\prompt\file.tsx` 读取失败：`File not found`; 状态：prompt 子目录无该文件，不要继续按该路径查找。
- `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\component\prompt\command.tsx` 读取失败：`File not found`; 状态：prompt 子目录无该文件，不要继续按该路径查找。
- `packages/opencode/src/**/*accounting*.test.*` glob 输出：`No files found`; 状态：未找到 accounting 专门测试，方案中可建议新增最小测试或复用现有 TUI 测试组织。

## Key Decisions
- 将 Vercel React 规则等价应用到 Solid/OpenTUI，而不是按 React DOM/Next 逐条机械套用；原因是目标 TUI 实际使用 `@opentui/solid`。
- 推荐方案应克制聚焦 P1/P2 中最小闭环，不做大范围拆文件或新公共 API；原因是用户明确要求手术刀式、净增量可控。
- token accounting 优先收敛为共享派生/工具 hook 或局部可复用逻辑，而不是在各 UI 继续叠加 throttle；原因是当前三处重复 full scan 是真实性能和代码重复问题。
- context usage 的修复重点是把 JSON snapshot 构建移动到 throttle 之后，而不是取消 deep clone；原因是现有注释说明 deep clone 用于读取 nested Solid store 字段，行为需要保留。
- `DialogSelect` 应倾向引入稳定 key/index 的最小增强，逐步替换 deep equality；原因是这是通用组件，收益覆盖模型/session/tool 等多个弹窗。
- Autocomplete 改动应优先加 debounce/stale guard，避免重构 sources/render；原因是用户要求少切入点、不要新增不必要抽象。

## Next Steps
- 在 `docs/draft` 下创建一份方案 Markdown，建议文件名类似：
  - `tui-render-cost-implementation-plan.md`
  - 或 `tui-performance-simplification-plan.md`
- 文档按用户要求的 9 项结构撰写，并在末尾给出“推荐方案摘要”。
- 方案内容需明确：
  - 需要继续确认的文件/测试/文档清单。
  - 当前职责边界和必须保持的既有行为。
  - 推荐最小实现路径：token accounting 收敛、context usage throttle 位置修正、DialogSelect key、Autocomplete debounce/stale guard。
  - 预计修改/新增/删除文件和每个文件具体改动。
  - 正常/错误/并发/退出/清理/安全边界。
  - 行为级测试计划和当前实现会暴露的缺口。
  - 验证命令：`bun run typecheck`, `bun test --timeout 30000 ...` 等。
  - 预估 git 文件数/增删行/是否涉及生成文件、迁移、文档。
  - 风险与开放问题，不设置不必要阻塞。
- 写入文档后，最终回复应说明已写入的路径并给出推荐方案摘要；不要实施代码修改。

## Critical Context
- 前次完整审计报告的总体评分：
  - 渲染架构：7/10
  - 流式事件处理：8/10
  - 热路径计算：5/10
  - 列表/长内容渲染：7/10
  - 代码简洁性：5/10
  - 插件隔离：8/10
- 前次审计 P1/P2 优先事项：
  - P1：`tokenAccounting()` 在 Prompt/sidebar/subagent footer 重复 full scan，且 throttle 在计算后。
  - P1：`routes/session/context-usage.tsx` 先 JSON 深克隆，再 throttle。
  - P1：`ui/dialog-select.tsx` 使用 `isDeepEqual` 和 `JSON.stringify` 作为 hot path 比较/id。
  - P1：`component/prompt/autocomplete.tsx` 对输入变化直接触发 SDK file search/fuzzy/sort，缺少 debounce/stale guard。
  - P2：visible parts O(parts²)、scrollbar render hook 遍历 children、model dialog 全量重建、session preview stale/cancel guard、plugin API 重复分配/排序、provider endpoint 1s polling。
- 不建议把本轮方案扩大到大文件拆分；可作为后续阶段，因为 `routes/session/index.tsx`、`component/prompt/index.tsx`、`component/prompt/autocomplete.tsx` 大但纯拆分容易扩大 diff。
- 当前没有必须用户决策的问题；可直接按仓库风格写方案文档。

---

## User

---

## Assistant (Auto · GPT-5.5)

---

