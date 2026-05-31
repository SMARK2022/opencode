# Opencode TUI 渲染开销与代码收敛实现方案

状态：Draft

目标：在不重写 TUI、不引入新配置、不改变用户可见行为的前提下，针对审计中确认的高频渲染/计算热点做手术刀式收敛，降低 streaming、长会话、弹窗选择和 autocomplete 场景下的重复计算，同时让相关代码更短、更集中、更容易测试。

本方案只针对实现计划，不包含生产代码修改。

## 1. 需要阅读和确认的现有文件/测试/文档

| 类型 | 文件 | 需要确认的点 |
| --- | --- | --- |
| 性能准则 | `.opencode/skills/vercel-react-best-practices/SKILL.md` | 该准则是 React/Next 语境，本次需等价映射到 Solid/OpenTUI：减少宽订阅、热路径计算、重复请求、列表深比较和先算后节流 |
| TUI app/root | `packages/opencode/src/cli/cmd/tui/app.tsx` | Provider 层级、路由挂载、全局上下文边界不应变动 |
| SDK 事件流 | `packages/opencode/src/cli/cmd/tui/context/sdk.tsx` | `SDKProvider` 已有 16ms SSE event queue + `batch`，这是必须保持的流式事件降噪边界 |
| sync store | `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | message/part/session/provider/config 写入边界、part delta coalesce、bootstrap 并行拉取必须保持 |
| sync v2 | `packages/opencode/src/cli/cmd/tui/context/sync-v2.tsx` | 当前更像 experimental/debug seam，本轮不以它作为主要切入点 |
| 信号工具 | `packages/opencode/src/cli/cmd/tui/util/signal.ts` | 已有 `createThrottledSignal`、`createDebouncedSignal`、`createTokenFlowPulse`，优先复用，不新增调度依赖 |
| token accounting | `packages/opencode/src/token/accounting.ts` | `tokenAccounting()` 是统一统计入口，语义、返回结构和现有测试不应改动 |
| Prompt usage | `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | 当前在 prompt 内直接扫描 session token usage；应保留展示口径和 token flow pulse 行为 |
| subagent footer usage | `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` | 当前重复计算同一 usage；应保留 subagent label、快捷键和窄屏展示行为 |
| sidebar context usage | `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/context.tsx` | 当前同时包含 usage 统计和 provider endpoint 轮询；本轮只收敛 usage 统计，不重写轮询 |
| context usage 面板 | `packages/opencode/src/cli/cmd/tui/routes/session/context-usage.tsx` | `contextUsageSnapshot()` 的 JSON roundtrip 有明确注释，用于读取 nested Solid store deltas；本轮保留语义，只移动调用时机 |
| context usage util | `packages/opencode/src/cli/cmd/tui/util/context-usage.ts` | `computeContextData()` 是面板数据计算入口，现有分类/窗口/细节语义不改 |
| DialogSelect | `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` | 通用选择器热路径使用 `isDeepEqual` 和 `JSON.stringify(value)`；需要给内部行 identity 更稳定的 seam |
| DialogSelect 调用方 | `packages/opencode/src/cli/cmd/tui/component/dialog-*.tsx`, `packages/opencode/src/cli/cmd/tui/ui/dialog-*.tsx` | 确认哪些 option value 是对象、哪些可天然使用 primitive key，避免一次性大范围改调用方 |
| Autocomplete | `packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx` | 文件搜索、reference 搜索、fuzzysort、frecency 排序均在输入热路径；本轮只加 debounce/stale guard，不拆 source 架构 |
| TUI context usage 测试 | `packages/opencode/test/cli/tui/context-usage.test.ts` | 已覆盖 snapshot 能追踪 streaming tool input deltas 和 context data 行为，可承接 throttle/snapshot 位置回归 |
| token accounting 测试 | `packages/opencode/test/cli/tui/token-estimate.test.ts` | 已直接测试 `tokenAccounting()`，本轮应避免改 accounting 语义；可新增 TUI usage wrapper 的小测试 |
| Prompt 并发测试 | `packages/opencode/test/cli/tui/prompt-submit-race.test.ts` | 测试组织偏行为镜像，适合参考 autocomplete stale guard 的轻量 harness |
| TUI runtime fixture | `packages/opencode/test/fixture/tui-runtime.ts` | 需要组件级测试时复用已有 fixture，不新增复杂 mock runtime |
| package scripts | `packages/opencode/package.json` | 测试和类型检查必须从 `packages/opencode` 目录运行：`bun run typecheck`、`bun test --timeout 30000` |

当前仓库已有 `docs/draft/`，本方案作为 draft 文档新增；不需要 ADR、迁移或生成文件。

## 2. 当前职责边界和必须保持的既有行为

| 边界 | 当前职责 | 必须保持的行为 |
| --- | --- | --- |
| `SDKProvider` | 订阅 daemon SSE，把事件以 16ms 窗口批量发给 TUI event bus | 不绕过现有 event queue，不让 token/part delta 事件重新变成逐条渲染 |
| `SyncProvider` | 维护 Solid store 中的 session/message/part/provider/config 等投影 | 不改变 store shape，不改变 message/part 更新顺序，不改变 bootstrap 并行拉取 |
| `tokenAccounting()` | 根据 messages + getParts 一次遍历计算 step/request/session usage | 不改变返回类型、统计口径、confirmed/estimate fallback、contextPercent 和 breakdown 语义 |
| Prompt usage UI | 展示当前 step input/output、request totals、context percent、cost 和 pulse | 展示数字和括号累计口径不变；running 时 0 值占位行为不变 |
| Subagent footer usage UI | 在子 session footer 展示同样 usage，并根据宽度决定是否显示 cumulative | subagent index/total、快捷键、窄屏隐藏 cumulative 行为不变 |
| Sidebar context plugin | 展示 Context token/cost 和 provider endpoint 状态 | usage 数字口径不变；endpoint polling 暂不改，避免扩大行为面 |
| ContextUsagePanel | 打开后计算当前窗口、分类网格和细节行 | `contextUsageSnapshot()` 必须继续读取 nested Solid store 字段，特别是 streaming tool raw/text deltas |
| `DialogSelect` | 提供通用过滤、分组、选择、鼠标移动、preview、actions/footer hints | 过滤排序、current 高亮、active 高亮、键盘/鼠标选择、scroll-to-selected 行为不变 |
| Autocomplete | 根据 `/`、`@`、reference 和当前输入生成建议项并插入 prompt part | 插入文件/agent/reference/command 的文本和 part 结构不变；loading 时保留旧结果的体验不变 |
| 测试组织 | TUI 相关行为测试在 `packages/opencode/test/cli/tui`，fixture 在 `test/fixture` | 新测试优先小而行为化，不引入浏览器或交互式 `bun dev` 依赖 |

必须维持的性能设计：

| 设计 | 保持方式 |
| --- | --- |
| SSE 和 part delta 已经在入口处批处理 | 本轮优化不新增第二套 event bus，不改变 sync 写入链路 |
| `tokenAccounting()` 已是一次遍历 | 不拆 accounting 内部，不复制统计逻辑到 UI 测试或组件 |
| context usage snapshot 有深读取目的 | 不用浅拷贝替代 JSON roundtrip；只避免每个响应式变化都提前深克隆 |
| DialogSelect 是通用组件 | key 支持必须向后兼容；无法提供 key 的调用方仍能使用现有 value 语义 |
| Autocomplete 已有 previous options fallback | debounce/stale guard 不应导致输入时列表闪空 |

## 3. 推荐的最小实现方案

推荐做一轮小范围四点改动：

| 顺序 | 改动 | 目标 |
| --- | --- | --- |
| 1 | 新增内部 `useSessionUsage` 小 hook，收敛 Prompt/Subagent/Sidebar 的重复 token usage 计算 | 让 `tokenAccounting()` 在同一 UI 区域内只有一个实现口径，并把 throttle 放到昂贵计算之前 |
| 2 | 调整 `ContextUsagePanel` 的 input 构建方式，让 throttled source 到点后再 snapshot | 保留深 snapshot 语义，但避免 streaming 时每个 nested delta 都先 JSON clone |
| 3 | 给 `DialogSelectOption` 增加可选 `key?: string`，内部优先按 key/index 比较 | 去掉热路径中大多数 `isDeepEqual` 和 `JSON.stringify(value)`，同时兼容旧调用方 |
| 4 | 给 Autocomplete 的文件搜索源增加 debounce 和 stale guard | 减少快速输入时的 SDK `find.files`、排序和 fuzzy 竞争；旧请求返回不覆盖新 query |

### 3.1 为什么这是最小方案

| 候选方案 | 结论 | 原因 |
| --- | --- | --- |
| 在 `SyncProvider` 内做 session usage cache | 暂不推荐 | 更接近全局派生，但会把 UI-only token display 逻辑放进 sync store，影响面更大，且需要设计 cache 生命周期 |
| 新增内部 `useSessionUsage` | 推荐 | 只服务 TUI，复用 `tokenAccounting()` 和 `createThrottledSignal`，能删除三处重复 UI 统计逻辑，文件数和行为面可控 |
| 修改 `tokenAccounting()` 为增量算法 | 暂不推荐 | accounting 语义复杂且已有测试，增量化容易引入边界错算；本需求真实问题是重复调用和节流位置，不是单次算法错误 |
| 重写 ContextUsagePanel 为增量 store | 暂不推荐 | 面板数据含 categories/grid/details/tool definitions/instructions，增量状态机会扩大很多；只移动 snapshot 时机即可解决主要浪费 |
| DialogSelect 要求所有调用方传 `getKey` | 暂不推荐 | 会扩大调用方 diff；可选 `key` 足够覆盖对象 value 热点，旧调用继续可用 |
| Autocomplete 拆成 sources/filter/view 三层 | 暂不推荐 | 架构更清晰，但本轮需求是降低热路径开销；先加 debounce/stale guard 更克制 |

### 3.2 设计细节

#### `useSessionUsage`

建议新增 `packages/opencode/src/cli/cmd/tui/util/session-usage.ts`，只导出 TUI 内部使用的 hook 和类型。

核心行为：

| 行为 | 设计 |
| --- | --- |
| 输入 | `sessionID: Accessor<string | undefined>`，可选 `showWhenRunning?: boolean` |
| 依赖 | 直接使用 `useSync()`，从现有 store 读取 messages、parts、providers、session_status |
| 调度 | 用一个轻量 revision/source 订阅当前 session 的 messages、last assistant parts、provider limit、status；通过 `createThrottledSignal` 先节流 source，再执行 `tokenAccounting()` |
| 输出 | `{ usage, flow }` 或 `{ value, flow }`，其中 value 字段保持 Prompt/Subagent/Sidebar 现有展示所需字段 |
| pulse | 复用 `createTokenFlowPulse`，不要在三个 UI 各自重建比较逻辑 |
| fallback | 无 session、无 last assistant、idle 且无 token 时返回 `undefined` 或 zero state，由调用方保持现有显示逻辑 |

为了避免新抽象过大，hook 不做全局缓存、不做跨组件共享 Map、不引入状态机。它只把三处重复代码收敛到一个内部实现，并把 throttle 包住昂贵读取和 `tokenAccounting()`。

#### ContextUsagePanel snapshot

当前形态是：

```text
Solid store 变化
  -> inputRaw() 立即 JSON snapshot messages/parts
  -> throttled signal
  -> computeContextData()
```

推荐改为：

```text
Solid store 变化
  -> cheap source/revision 更新
  -> throttled signal
  -> buildContextUsageInput() 读取当前 messages/parts 并 JSON snapshot
  -> computeContextData()
```

关键点：

| 点 | 处理 |
| --- | --- |
| nested Solid store deltas | `contextUsageSnapshot()` 保留，继续在最终 build input 时使用 |
| columns/path/provider/config/agent | 仍作为 source 的组成部分，确保尺寸和模型上下文变化能刷新面板 |
| 首次打开 | leading update 立即构建一次 input，不让面板空等 500ms |
| trailing flush | 继续依赖 `createThrottledSignal` 的 leading-and-trailing 语义，流结束后刷新最终数据 |

#### DialogSelect key

建议给 `DialogSelectOption<T>` 增加：

```ts
key?: string
```

内部统一通过 `optionKey(option, index)` 得到 row key：

| 情况 | key 来源 |
| --- | --- |
| option.key 存在 | 使用 option.key |
| value 是 string/number/boolean/null/undefined | 使用稳定 primitive string |
| value 是对象且无 key | fallback 到当前兼容逻辑，但只在必要处使用，逐步减少深比较 |

最小行为调整：

| 热点 | 调整 |
| --- | --- |
| current selection | 先用 `props.current` 的 primitive/fallback key 比较；对象 current 没有 key 时保留 `isDeepEqual` fallback |
| active row | 优先比较 row index 或 row key，不再每行 `isDeepEqual(option.value, selected()?.value)` |
| renderable id | 从 `JSON.stringify(option.value)` 改为 row key，避免对象序列化和循环对象风险 |
| mouseover/mousedown | 通过 row key 或渲染时闭包 index 定位，避免 `flat().findIndex(isDeepEqual)` |

调用方只优先补对象 value 的高价值弹窗：model/session/console org 等。primitive value 调用方无需改动。

#### Autocomplete debounce/stale guard

只改文件搜索相关 resource source，不重写插入逻辑。

| 搜索源 | 调整 |
| --- | --- |
| `files` | 对 `search()` 建 `debouncedSearch`，`store.visible === "@"` 且非 reference search 时才触发远端搜索 |
| `referenceFiles` | 对 `referenceSearch()` 的 query 建 debounce，reference alias 或 directory 变化时立即进入新 generation |
| stale guard | 每次请求递增 generation，await 后如果 generation 已变化则返回上一次可用结果或空结果，不写入过期 options |
| 错误路径 | SDK error 继续返回 `[]`，不 toast、不扩大 UI 行为 |

不引入 `AbortController` 作为第一选择，因为当前 SDK resource 调用未必统一支持 signal；generation guard 已能保证旧结果不污染 UI。如果后续确认 `sdk.client.find.files` 支持 signal，再作为小增强追加。

## 4. 预计修改/新增/删除的文件

| 动作 | 文件 | 具体改动 |
| --- | --- | --- |
| 新增 | `packages/opencode/src/cli/cmd/tui/util/session-usage.ts` | 新增内部 hook/type，封装 last user/assistant 查找、model limit 查找、throttled source、`tokenAccounting()`、`createTokenFlowPulse` |
| 修改 | `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | 删除本地 `UsageInfo`、`usageRaw`、`createThrottledSignal` 和 `createTokenFlowPulse` 重复逻辑；改用 `useSessionUsage(() => props.sessionID)`；保留原 JSX 展示 |
| 修改 | `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` | 删除本地 usage 统计重复逻辑；改用 `useSessionUsage(() => route.sessionID)`；保留 `showCumulative()` 和 subagent footer 布局 |
| 修改 | `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/context.tsx` | 删除本地 usage `stateRaw` 和手写 throttle；改用 `useSessionUsage(() => props.session_id, { zeroWhenMissing: true })` 或等价最小 API；endpoint polling 不改 |
| 修改 | `packages/opencode/src/cli/cmd/tui/routes/session/context-usage.tsx` | 抽出 `buildContextUsageInput(...)` 或局部函数；把 `contextUsageSnapshot()` 调用移动到 throttled input/resource 之后；保留导出的 `contextUsageSnapshot()` 测试入口 |
| 修改 | `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` | `DialogSelectOption` 增加可选 `key`；内部建立 `flatRows` 或 row key helper；active/current/id/mouse 定位优先使用 key/index；对象 fallback 保留 |
| 修改 | 若干 `component/dialog-*.tsx` | 只给对象 value 且列表较大的 option 补 `key`，例如 provider/model、session、console org；不机械改所有调用方 |
| 修改 | `packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx` | 对 file/reference search source 加 debounce 和 generation stale guard；保留现有 `options(prev)` loading 时返回 prev 的体验 |
| 新增/修改测试 | `packages/opencode/test/cli/tui/session-usage.test.ts` 或并入 `token-estimate.test.ts` | 测试新 hook 的纯 helper 部分或导出的 formatting/build 函数；避免依赖完整 TUI runtime |
| 修改测试 | `packages/opencode/test/cli/tui/context-usage.test.ts` | 增加“throttled source 到点前不执行 snapshot/compute”的行为测试，或至少保留 nested delta snapshot 回归 |
| 新增/修改测试 | `packages/opencode/test/cli/tui/dialog-select.test.tsx` | 组件级测试：对象 value + key 时 current/active/mouse selection 不依赖 deep equality/stringify |
| 新增/修改测试 | `packages/opencode/test/cli/tui/autocomplete.test.ts` | 轻量 harness 测 generation stale：旧请求后返回不能覆盖新 query 结果 |

预计不删除文件，不改迁移，不改 SDK 生成文件，不改公共配置。

需要删除/替换/收敛的旧逻辑：

| 旧逻辑 | 处理 |
| --- | --- |
| Prompt/Subagent/Sidebar 三份 usage accounting | 删除重复实现，收敛到 `useSessionUsage` |
| ContextUsagePanel 里的 `inputRaw()` 立即深克隆 | 替换为 throttled 后 build input，不叠加第二份 snapshot |
| DialogSelect 行 id 的 `JSON.stringify(option.value)` | 替换为 row key，fallback 仅为兼容无 key 对象 |
| DialogSelect active/current 的每行深比较 | 替换为 key/index 比较，fallback 仅用于旧对象 current |
| Autocomplete 远端搜索直接跟随每个字符 | 替换为 debounced source + stale guard |

## 5. 正常路径、错误路径、并发/退出/清理/安全边界

### 正常路径

| 场景 | 处理方式 |
| --- | --- |
| session streaming 时 Prompt 显示 token | `useSessionUsage` 订阅当前 session 的轻量 source，throttle 到点后调用一次 `tokenAccounting()`，UI 读取同一 usage shape |
| subagent footer 显示 token | 使用同一 hook，仍按 `dimensions().width > 120` 控制 cumulative 展示 |
| sidebar context 显示 token/cost | 使用同一 hook 的 zero fallback，保留当前四行 Context 展示 |
| 打开 context usage 面板 | 首次 leading 立即 build snapshot 并 compute，后续 streaming delta 最多按 500ms 刷新 |
| DialogSelect 键盘移动 | selected index 更新，row active 用 index/key 判定，scroll 按 row key 找 renderable |
| DialogSelect 鼠标 hover/click | 通过渲染闭包 index 或 row key 定位 option，触发原 `moveTo`/select |
| Autocomplete 输入 `@foo` | debounce 后请求文件；请求期间保留上一轮 options；新结果到达后再参与 fuzzy |
| Autocomplete reference search | reference alias/directory 匹配后 debounce query，请求只接受最新 generation |

### 错误路径

| 错误 | 处理方式 |
| --- | --- |
| sessionID 缺失 | usage hook 返回 `undefined` 或 zero state，调用方保持现有不显示/显示 0 行为 |
| last assistant 不存在 | usage hook 不调用 `tokenAccounting()`，避免无意义扫描 |
| provider/model limit 缺失 | 继续传 `undefined` context limit，保持 `contextPercent: null` 行为 |
| `computeContextData()` resource 失败 | 保持现有 resource 错误/空态处理，不新增 toast 或 retry 状态机 |
| DialogSelect option 无 key 且 value 是对象 | 保留 `isDeepEqual` fallback，避免破坏旧调用方 |
| option value 无法 stringify 或循环引用 | 新 row key 不依赖 JSON stringify；fallback 不应再用于 renderable id |
| SDK `find.files` 返回 error | Autocomplete 继续返回 `[]` 或保留 prev，不弹错误，避免输入期间噪音 |

### 并发、退出和清理

| 风险 | 处理方式 |
| --- | --- |
| streaming 高频 part delta | throttle 包住昂贵计算；trailing flush 确保流结束后最终数字正确 |
| session 切换 | usage hook source 包含 sessionID；切换后旧 session 的 trailing 更新不能覆盖新 session，可用局部 generation 或在 setter 前检查 sessionID |
| context 面板关闭 | Solid owner dispose 后 throttled callback/resource 不应继续写 UI；若新增 timer，必须 `onCleanup` 清理 |
| autocomplete 旧请求晚返回 | generation guard 丢弃旧结果；不把旧 query 结果写入新 options |
| autocomplete 组件卸载 | generation 标记失效；若使用 timer，`onCleanup` 取消 debounce/timer |
| DialogSelect filter 变化 | 保持当前 setTimeout 后 center selected 的行为，但内部定位用 key/index，避免 filter 更新期间深比较放大 |
| 多 TUI 实例 | 不使用 module-level singleton usage cache，避免跨 renderer/session 泄漏 |

### 安全边界

| 边界 | 处理方式 |
| --- | --- |
| 不扩大网络面 | Autocomplete 仍只调用现有 daemon SDK `find.files`；provider endpoint polling 本轮不新增请求 |
| 不改变权限 | 不改 file read、workspace、prompt part 插入权限逻辑 |
| 不改变持久化 | 不改 session/message/part store schema，不改数据库迁移 |
| 不新增配置/API | 不新增用户配置、CLI flag、daemon endpoint 或 SDK API |
| 不吞错误 | 现有 error fallback 保持；本轮性能优化不把业务错误改成静默成功 |

## 6. 行为级测试计划

测试先写，按最小闭环覆盖行为，不把实现细节复制到测试里。

| 顺序 | 测试 | 当前实现会暴露的缺口 | 实现后验证 |
| --- | --- | --- | --- |
| 1 | `session-usage`：同一组 messages/parts 能得到与现有 Prompt/Subagent/Sidebar 一致的 input/output/totals/context/cost | 当前三处各自实现，无法单点验证口径一致，且容易漂移 | 新 hook/helper 输出与现有 `tokenAccounting()` 测试 fixture 对齐 |
| 2 | `session-usage`：快速 part delta 下 throttle 前不调用昂贵 accounting 多次 | 当前 throttle 在 `tokenAccounting()` 之后，测试若加 spy/counter 会看到每次 source 变化都计算 | 多次 source 变化在 throttle window 内只触发有限 accounting；trailing 后最终值正确 |
| 3 | `context-usage`：snapshot 仍能追踪 pending tool `state.raw` nested delta | 已有测试覆盖，必须保持 | 原测试继续通过，证明没有用浅拷贝破坏 nested read |
| 4 | `context-usage`：连续 streaming delta 不会每次都执行 snapshot build | 当前 `inputRaw()` 会先 JSON snapshot 再 throttle | 使用可注入 snapshot/build counter 或导出小 builder，验证 throttle 到点后才 build |
| 5 | `dialog-select`：对象 value + `key` 时 current row 正确高亮并可键盘移动选择 | 当前靠 deep equality；对象较大时成本高，且 row id 依赖 JSON stringify | key 相同即可高亮；active 用 selected index/key；不需要 value 深比较 |
| 6 | `dialog-select`：无 key 的旧对象 value 仍能 current 高亮 | 新 key 机制若做得过激会破坏兼容 | fallback 测试通过，证明不是强制所有调用方改造 |
| 7 | `autocomplete`：两个 `find.files` 请求乱序返回时，旧 query 不能覆盖新 query | 当前 resource 没有明确 stale guard，旧请求晚返回存在污染风险 | generation guard 后只显示最新 query 结果 |
| 8 | `autocomplete`：loading 时保留 previous options | 当前已有 `prev` fallback，应保留 | debounce/stale guard 后仍不闪空 |

建议的测试文件组织：

| 文件 | 覆盖 |
| --- | --- |
| `packages/opencode/test/cli/tui/session-usage.test.ts` | usage helper/hook 的口径、throttle、session switch stale guard |
| `packages/opencode/test/cli/tui/context-usage.test.ts` | 复用现有 context usage 测试，补 snapshot 调用时机 |
| `packages/opencode/test/cli/tui/dialog-select.test.tsx` | 用 `@opentui/solid` `testRender` 测 key/current/active 兼容 |
| `packages/opencode/test/cli/tui/autocomplete.test.ts` | 用轻量 fake SDK/harness 测 debounce/stale guard，不启动完整 TUI |

测试风格约束：

| 约束 | 说明 |
| --- | --- |
| 不从 repo root 跑测试 | 遵守仓库 guard，从 `packages/opencode` 运行 |
| 避免大 mock | 只 stub 最小 SDK `find.files` 或纯 helper；不 mock `tokenAccounting()` 的业务逻辑 |
| 固定 sleep 只用于 debounce | 仓库测试指南允许 debounce/throttle 行为使用真实时间 sleep |
| 不复制实现算法 | token 数字仍通过 `tokenAccounting()` fixture 验证，不在测试里重写计算 |

## 7. 建议运行的验证命令

所有命令均在 `packages/opencode` 目录执行。

| 阶段 | 命令 | 目的 |
| --- | --- | --- |
| 定点 token/accounting | `bun test --timeout 30000 test/cli/tui/token-estimate.test.ts` | 确认 `tokenAccounting()` 语义未回归 |
| 定点 context usage | `bun test --timeout 30000 test/cli/tui/context-usage.test.ts` | 确认 context usage snapshot/data 未回归 |
| 新增 TUI tests | `bun test --timeout 30000 test/cli/tui/session-usage.test.ts test/cli/tui/dialog-select.test.tsx test/cli/tui/autocomplete.test.ts` | 验证本轮新增行为 |
| TUI 相关测试集 | `bun test --timeout 30000 test/cli/tui` | 覆盖 TUI fixture 和既有交互回归 |
| 类型检查 | `bun run typecheck` | 确认 Solid/TUI 类型和泛型改动正确 |
| 全包测试可选 | `bun test --timeout 30000` | 时间允许时扩大信心；仍从 `packages/opencode` 运行 |

不建议把 `bun dev` 作为自动验证命令，因为它是交互式 TUI。若需要人工观察，应按包内 AGENTS 指引用 tmux 启停，避免阻塞终端。

## 8. 预估 git 文件数、增删行数和生成物

| 类别 | 预估 |
| --- | ---: |
| 生产文件修改 | 6-9 个 |
| 测试文件新增/修改 | 3-4 个 |
| 文档文件新增 | 1 个，即本方案 |
| 总文件数 | 10-14 个 |
| 生产代码净增 | 约 +120 到 +220 行 |
| 生产代码删除 | 约 -90 到 -170 行 |
| 测试净增 | 约 +180 到 +320 行 |
| 总净增 | 约 +210 到 +370 行 |
| 生成文件 | 无 |
| 数据库迁移 | 无 |
| SDK 生成 | 无 |
| 配置/API 变更 | 无 |

如果只做前三项、不做 autocomplete，本轮可收敛到约 7-10 个文件；如果 autocomplete 测试需要更好的 seams，文件数可能接近上限。

## 9. 真实风险与开放问题

| 风险 | 等级 | 说明 | 缓解 |
| --- | --- | --- | --- |
| throttle 前移导致 token 数字刷新频率降低 | 中 | UI 数字可能从每个 delta 更新变成最多 50ms 一次 | 现有展示本来就是 50ms throttle；保留 leading/trailing，用户可见语义基本不变 |
| session 切换时 trailing 更新写入旧 usage | 中 | throttled callback 闭包可能持有旧 sessionID | setter 前检查 current sessionID 或 generation，测试覆盖 session switch |
| ContextUsagePanel source 太 cheap 导致漏订阅 nested delta | 中 | 如果 source 只看数组引用，pending raw delta 可能不触发 | source 仍需读取必要 nested 字段或 revision；snapshot 深读取保留，现有 nested delta 测试必须通过 |
| DialogSelect key fallback 兼容性 | 中 | 对象 value 无 key 的调用方可能依赖 deep equality current | fallback 保留；高价值对象调用方逐步补 key，不强制破坏旧行为 |
| renderable id key 冲突 | 低到中 | 同一列表内重复 key 会导致 scroll 定位错误 | 开发期可用局部 fallback `key:index`；测试覆盖重复 primitive/title 场景 |
| Autocomplete debounce 改变体感 | 低到中 | 80-150ms debounce 可能让文件建议略晚出现 | 只 debounce 远端文件搜索；agent/reference alias/command 本地项保持即时 |
| Autocomplete 旧结果保留过久 | 低 | 请求慢时 prev options 可能短暂不匹配 query | 现有已有 prev fallback；可在 query 类型变化时清空，普通字符变化保留 |
| 测试对 Solid scheduler 时间敏感 | 低 | debounce/throttle 测试可能 flake | 只在 debounce 行为使用固定 sleep，时间窗口留余量；避免依赖 renderer 帧 |

开放问题：

| 问题 | 是否阻塞 | 建议 |
| --- | --- | --- |
| `useSessionUsage` 放在 `util/session-usage.ts` 还是 `routes/session/session-usage.ts` | 不阻塞 | 推荐 `util/session-usage.ts`，因为 Prompt、Subagent、Sidebar 都会使用，且仍是 TUI 内部 util |
| DialogSelect 是否需要 `getKey` prop 而非 option.key | 不阻塞 | 本轮推荐 `option.key`，调用方改动更局部；若后续需要统一可再加 `getKey` |
| Autocomplete 是否使用 AbortController | 不阻塞 | 先用 generation guard；确认 SDK 支持 signal 后再追加 abort |
| 是否顺手优化 sidebar endpoint polling | 不阻塞 | 不纳入本轮，避免把 usage 收敛和网络轮询策略混在一起 |
| 是否拆分大文件 | 不阻塞 | 不纳入本轮；等热路径行为修复后再做纯结构拆分 |

当前没有必须用户决策的问题，可以直接按本方案进入 TDD/实现。

## 推荐方案摘要

推荐先做一轮小而完整的 TUI 内部性能收敛：新增 `useSessionUsage` 收敛三处 token usage 重复计算，并把 throttle 前移到昂贵 accounting 之前；调整 `ContextUsagePanel` 让深 snapshot 在 throttled source 后执行；给 `DialogSelectOption` 增加可选稳定 `key`，减少深比较和 `JSON.stringify`；最后给 Autocomplete 文件搜索加 debounce 与 stale guard。

这条路线符合当前仓库设计：继续复用 `SyncProvider`、`tokenAccounting()`、`createThrottledSignal`、`createDebouncedSignal` 和现有 TUI 测试组织，不新增用户配置、daemon API、数据库迁移或大范围重构。预计改动集中在 10-14 个文件，总净增约 210-370 行，其中大部分是行为测试；生产代码主要是删除重复 usage 逻辑并补少量内部 seam。
