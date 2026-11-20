// 机械门禁的唯一规则表。改这里 = 改架构；本目录受保护，只能由维护者在独立 PR 中修改。
// 依赖矩阵与白名单取自官方 v1.19.6 实测依赖图：上游代码在这些规则下为 0 违规。

export const MAIN_BRANCH = "dev1-smark"

// ── 受保护路径：插件拒绝 Agent 写入；PR 修改需维护者加 guard-change 标签 ──
export const PROTECTED_PATHS = [
  "script/guard/",
  ".opencode/plugins/guard.ts",
  ".opencode/opencode.jsonc",
  ".opencode/policy/",
  ".opencode/skills/",
  ".opencode/agent/",
  ".opencode/templates/",
  ".husky/",
  ".github/workflows/",
  ".github/CODEOWNERS",
  ".oxlintrc.json",
]
export const PROTECTED_GLOBS = [/^packages\/[^/]+\/test\/budget\//]

// ── B1 包依赖矩阵（值导入与类型导入都受约束）；"*" 仅授予组合根 ──
export const PACKAGE_DEPS: Record<string, string[] | "*"> = {
  schema: [],
  protocol: ["schema"],
  llm: ["schema"],
  client: ["schema", "protocol"],
  plugin: ["sdk/js"],
  codemode: [],
  core: ["schema", "llm", "plugin", "sdk/js", "effect-drizzle-sqlite"],
  server: ["core", "protocol"],
  "sdk-next": ["client", "core", "server"],
  "sdk/js": [],
  "effect-drizzle-sqlite": [],
  "effect-sqlite-node": [],
  "http-recorder": [],
  ui: [],
  tui: ["core", "plugin", "sdk/js", "ui"],
  cli: ["core", "sdk/js", "server", "tui"],
  "session-ui": ["client", "core", "sdk/js", "ui"],
  app: ["client", "core", "schema", "sdk/js", "session-ui", "ui"],
  enterprise: ["core", "sdk/js", "session-ui", "ui"],
  desktop: ["app", "ui"],
  opencode: "*",
}
// 非主线维护的包：不施加矩阵，但新增包必须登记到上面两处之一（B0）
export const UNGOVERNED = [
  "console/app",
  "console/core",
  "console/function",
  "console/mail",
  "console/resource",
  "console/support",
  "stats/app",
  "stats/core",
  "stats/server",
  "slack",
  "function",
  "web",
  "storybook",
  "script",
  "httpapi-codegen",
]

// ── B2 界面包只能使用 core 的这些叶子入口（不按目录放行：util/ 下也有 flock、which 等宿主能力）──
export const CORE_ENTRY_ALLOW: Record<string, string[]> = {
  app: ["util/array", "util/binary", "util/encode", "util/path", "util/retry"],
  "session-ui": ["util/binary", "util/encode", "util/path"],
  enterprise: ["util/binary", "util/error", "util/iife", "util/lazy"],
  desktop: [],
  ui: [],
  tui: ["flag/flag", "global", "installation/version", "open", "util/flock", "util/glob", "util/which"],
}

export const TYPE_ONLY_DEPS: Record<string, string[]> = { core: ["sdk/js"] }

// 构建生成的数据快照保留依赖检查，跳过手写代码的风格与形状规则。
export const GENERATED_SOURCES = new Set(["packages/core/src/models-snapshot.js"])

// ── B5 server 的 handler / middleware 不得直接拿存储实现 ──
export const SERVER_STORAGE_SCOPE = /^packages\/server\/src\/(handlers|middleware)\//
export const STORAGE_SPEC =
  /^(drizzle-orm(\/|$)|@opencode-ai\/core\/(database|storage)(\/|$))|(\/|^)[^/]*\.sql(\.ts)?$|@opencode-ai\/core\/.*\/sql$/

// ── B6 Desktop 进程隔离 ──
export const DESKTOP_ZONES = {
  renderer: "packages/desktop/src/renderer/",
  main: "packages/desktop/src/main/",
  preload: "packages/desktop/src/preload/",
}

// ── 规则说明：报错时给出修复方向；level=warn 只提示不阻断 ──
export type Level = "error" | "warn"
export const BOUNDARY_RULES: Record<string, { level: Level; fix: string }> = {
  "B0-unregistered-package": {
    level: "error",
    fix: "新包必须在 rules.ts 的 PACKAGE_DEPS 或 UNGOVERNED 中登记，未登记的包不自动获得依赖权限。",
  },
  "B1-package-deps": {
    level: "error",
    fix: "依赖方向不在矩阵内。把共享逻辑下沉到被允许的包，或经 sdk/client 接口调用。",
  },
  "B2-core-entry": {
    level: "error",
    fix: "界面包只能使用登记的 core 叶子入口。领域数据由 server 投影后经 SDK 下发；纯函数放进已登记的 util 模块。",
  },
  "B3-core-v1": { level: "error", fix: "V2 代码不得依赖 V1 兼容层。方向只能是 V1 调 V2。" },
  "B4-relative-escape": { level: "error", fix: "相对路径越过包根会绕开 exports。资源和模块由所属包导出后按包名引用。" },
  "B5-server-storage": {
    level: "error",
    fix: "handler/middleware 禁止导入数据库与表结构。调用 Core 服务，查询与事务归 Core 所有。",
  },
  "B6-desktop-zones": {
    level: "error",
    fix: "renderer 只能通过 window.api 与 preload 的公开类型通信；main/preload 不得引用 renderer。",
  },
  "B7-prod-imports-test": { level: "error", fix: "生产代码不得引用测试、fixture 或 test 目录。" },
  "B8-type-only-dependency": {
    level: "error",
    fix: "Core 的旧 SDK 依赖仅允许 import type / export type；运行时实现归 Core 所有。",
  },
  "B10-dependency-cycle": {
    level: "error",
    fix: "新增引用形成依赖环。将共同契约下沉或通过现有服务接口解耦，历史成环边只能减少。",
  },
  "F1-forwarder-lock": {
    level: "error",
    fix: "兼容入口只能 export 到登记目标；禁止删除入口、改变目标或增加实现。实现放回原所有者。",
  },
}

export type Ratchet = {
  id: string
  level: Level
  scope: "src" | "test" | "all"
  packages?: RegExp
  only?: RegExp
  exclude?: RegExp
  pattern: RegExp
  fix: string
}

const RUNTIME = /^packages\/(core|opencode|tui|server|cli)\//
const BUSINESS = /^packages\/(core|opencode)\/src\/(session|tool|permission)\//

export const RATCHETS: Ratchet[] = [
  // 生命周期与能力入口
  {
    id: "module-state",
    level: "error",
    scope: "src",
    packages: RUNTIME,
    pattern: /^(export )?(let |const \w+\s*(:[^=]+)?=\s*new (Map|Set|WeakMap)\b)/gm,
    fix: "模块级可变状态会跨实例、跨测试泄漏。状态放进 InstanceState 或 Layer 的 scope。",
  },
  {
    id: "raw-timer",
    level: "error",
    scope: "src",
    packages: RUNTIME,
    exclude: /^packages\/tui\/src\/util\/signal\.ts$/,
    pattern: /\b(setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|requestIdleCallback)\s*\(/g,
    fix: "裸定时器是时序补丁。用 Effect.sleep/Schedule 绑定 scope；TUI 用 util/signal 中的具名调度。",
  },
  {
    id: "raw-process",
    level: "error",
    scope: "src",
    packages: RUNTIME,
    exclude: /^packages\/core\/src\/(pty|shell)\/|^packages\/core\/src\/process\.ts$/,
    pattern:
      /\bBun\.spawn(Sync)?\(|from ["'](node:)?child_process["']|["']cross-spawn["']|\bprocess\.kill\(|\bnew Worker\(|\bprocess\.on\(/g,
    fix: "进程与信号经 AppProcess / ChildProcessSpawner 管理生命周期。",
  },
  {
    id: "env-read",
    level: "error",
    scope: "src",
    packages: RUNTIME,
    exclude: /^packages\/core\/src\/flag\//,
    pattern: /\bprocess\.env\b/g,
    fix: "环境变量先在 core/src/flag 声明为 Flag 再读取。",
  },
  {
    id: "runtime-create",
    level: "error",
    scope: "src",
    exclude:
      /^packages\/(core\/src\/effect\/runtime|opencode\/src\/acp\/service|opencode\/src\/effect\/app-runtime|opencode\/src\/effect\/run-service|stats\/core\/src\/runtime)\.ts$/,
    pattern: /\bManagedRuntime\.make\b/g,
    fix: "业务代码禁止创建 ManagedRuntime。通过 AppRuntime / runtime façade 执行，或在登记的装配入口声明。",
  },
  {
    id: "effect-run-business",
    level: "error",
    scope: "src",
    only: BUSINESS,
    pattern: /\bEffect\.run(Promise|Fork|Sync|PromiseExit|SyncExit|Callback)\b/g,
    fix: "业务目录不直接启动 Effect 执行器。走已有 runtime façade 或 EffectBridge。",
  },
  {
    id: "fork-detach",
    level: "error",
    scope: "src",
    packages: RUNTIME,
    pattern: /\bforkDetach\b/g,
    fix: "后台任务必须绑定所属 scope：用 forkScoped 或交给 BackgroundJob。",
  },
  {
    id: "layernode-make",
    level: "error",
    scope: "src",
    exclude: /^packages\/core\/src\/effect\//,
    pattern: /\bLayerNode\.make\b/g,
    fix: "服务用 makeGlobalNode / makeLocationNode 构造，让编译器检查 Global/Location 依赖方向。",
  },
  {
    id: "tool-cause",
    level: "error",
    scope: "src",
    only: /^packages\/[^/]+\/src\/tool\//,
    pattern: /\bEffect\.(catchCause|catchCauseIf|catchAllCause|ignoreCause)\b/g,
    fix: "工具叶子只处理声明的类型错误；中断与 defect 交给执行器。",
  },
  {
    id: "tui-raw-http",
    level: "error",
    scope: "src",
    packages: /^packages\/tui\//,
    pattern: /(?<![\w.])fetch\s*\(|\.fetch\s*\(|method:\s*["'](POST|PUT|PATCH|DELETE)["']/g,
    fix: "TUI 只经生成的 SDK 调用 server；SDK 缺方法就先修生成链。",
  },
  {
    id: "schema-any",
    level: "error",
    scope: "src",
    only: /^packages\/schema\/src\//,
    exclude: /\/v1\//,
    pattern: /\bSchema\.(Any|mutable)\b/g,
    fix: "当前契约禁止 Schema.Any / Schema.mutable。外部数据用 Unknown 并在边界解码。",
  },
  {
    id: "solid-async-effect",
    level: "error",
    scope: "src",
    packages: /^packages\/(tui|app|ui|session-ui|desktop|enterprise)\//,
    pattern: /\bcreate(Effect|RenderEffect|Memo|Computed)\(\s*(on\([^)]*?,\s*)?async\b/g,
    fix: "响应式计算保持同步。异步读取用 createResource，写操作放进具名 action。",
  },
  // 错误处理与类型
  {
    id: "swallow",
    level: "error",
    scope: "all",
    pattern:
      /catch\s*(\([^)]*\))?\s*\{\s*\}|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|null|void 0)\s*\)|Effect\.ignore\b|Effect\.catch\w*\(\s*\(\)\s*=>\s*Effect\.(void|succeed)/g,
    fix: "吞错把失败伪装成成功。返回类型化错误，或让失败沿调用链传播。",
  },
  {
    id: "type-escape",
    level: "error",
    scope: "src",
    pattern: /:\s*any\b|\bas\s+any\b|as unknown as\b|@ts-(ignore|expect-error|nocheck)|(oxlint|eslint)-disable/g,
    fix: "类型逃生舱。修正类型，或在边界处用 Schema 解码。",
  },
  {
    id: "type-escape-test",
    level: "error",
    scope: "test",
    pattern: /@ts-(ignore|nocheck)|(oxlint|eslint)-disable/g,
    fix: "测试只允许在类型负例中使用 @ts-expect-error。",
  },
  {
    id: "history-comment",
    level: "error",
    scope: "all",
    pattern: /^\s*(\/\/|\*).*(#\d{2,5}\b|20\d\d-\d\d-\d\d|事故|先例|\bR\d+\b|INV-\d)/gm,
    fix: "issue 号、revision、日期、事故史写进提交信息和 plan，不进代码注释。",
  },
  // 测试写法
  {
    id: "test-sleep",
    level: "error",
    scope: "test",
    pattern: /\b(Effect\.sleep|Bun\.sleep|sleep|setTimeout|setInterval)\s*\(/g,
    fix: "固定等待会在慢机器上随机失败。用 pollWithTimeout / awaitWithTimeout / Deferred / TestClock。",
  },
  {
    id: "test-skip",
    level: "error",
    scope: "test",
    pattern: /\b(test|it|describe)\.(skip|skipIf|todo|if)\s*\(/g,
    fix: "跳过测试等于删除测试。修复平台差异的根因，或删除该测试并在 PR 说明。",
  },
  {
    id: "test-only",
    level: "error",
    scope: "test",
    exclude: /\/test\/lib\//,
    pattern: /\b(test|it|describe)\.only\s*\(/g,
    fix: ".only 会让同文件其他测试静默不跑。",
  },
  {
    id: "test-platform-branch",
    level: "error",
    scope: "test",
    pattern: /process\.platform\s*===?\s*["']win32["']/g,
    fix: "测试按平台分叉会掩盖实现差异。平台差异由被测模块的接口承担。",
  },
  {
    id: "test-source-exec",
    level: "error",
    scope: "test",
    pattern: /\bnew Function\(|\beval\(/g,
    fix: "截取源码执行的测试只验证了文本。调用正式导出、真实 renderer 或服务 fixture。",
  },
  {
    id: "test-source-read",
    level: "error",
    scope: "test",
    pattern: /(readFileSync|readFile|Bun\.file)\([^)\n]*\.tsx?["'`]/g,
    fix: "行为测试不读取产品源码做断言；架构检查放进 script/guard。",
  },
  {
    id: "test-mock-module",
    level: "error",
    scope: "test",
    pattern: /\bmock\.module\(/g,
    fix: "mock.module 替换整模块且难以恢复。外部依赖通过 transport / 服务 fixture 注入。",
  },
]

// ── 代码形状（shape.ts）：只作用于 TUI 主线运行时代码 ──
export const SHAPE_SCOPE = RUNTIME
export const SHAPE_RULES: Record<string, { level: Level; fix: string }> = {
  "cc-excess": {
    level: "error",
    fix: "函数圈复杂度超过 10。删掉没有生产者的防御分支，或在信任边界用 Schema 一次性解码。",
  },
  "depth-excess": { level: "error", fix: "控制结构嵌套超过 3 层。用提前返回压平，或抽出有名字的函数。" },
  "sync-blocking": {
    level: "error",
    fix: "同步 IO / spawnSync 会阻塞整个事件循环。改用 Effect FileSystem / ChildProcessSpawner 的异步接口。",
  },
  "poll-loop": { level: "error", fix: "循环里 sleep 轮询。改为订阅事件、Deferred 或 Stream。" },
  "defensive-check": {
    level: "warn",
    fix: "新增的 ?. / ?? / === undefined。类型已保证非空时删除（unneeded-guards 会精确判定）。",
  },
  fallback: { level: "warn", fix: "catch 后返回替代值 = 第二条成功路径。确属契约才保留。" },
  "await-in-loop": {
    level: "warn",
    fix: "循环内逐个 await 把 IO 串行化。考虑 Effect.forEach({ concurrency }) 或批量查询。",
  },
}

// ── 改动规模：按提交计，不与上游比较 ──
// 阈值取自本 fork 的历史：src 非测试代码单个提交净增 p90≈290 行；>2000 行的文件上游只有 8 个。
// 超出时由人放行：提交信息里写一行 `Guard-Allow-Large: 理由`，带这行的 git commit 在 OpenCode 里会弹出确认。
export const ALLOW_LARGE_TRAILER = "Guard-Allow-Large"
export const CHANGE_BUDGET = 300 // 单个提交：src 非测试代码净增行数（新文件同样计入）
export const BIG_FILE_LINES = 2000 // 超过这个行数的文件……
export const BIG_FILE_GROWTH = 100 // ……单个提交里最多净增这么多行
export const TINY_MODULE_LINES = 40 // 新文件少于这么多有效行且只有一个导入方 → 合并回去
export const OTHER_RULES: Record<string, { level: Level; fix: string }> = {
  "change-size": {
    level: "error",
    fix: `单个提交净增超过 ${CHANGE_BUDGET} 行。拆成几个各自完整的提交；确属一个整体时，在提交信息里写 \`${ALLOW_LARGE_TRAILER}: 理由\` 交给人确认。`,
  },
  "file-lines": {
    level: "error",
    fix: `文件已超过 ${BIG_FILE_LINES} 行，单个提交里最多再净增 ${BIG_FILE_GROWTH} 行。新逻辑抽成内聚的模块；确有必要时写 \`${ALLOW_LARGE_TRAILER}: 理由\` 交给人确认。`,
  },
  "tiny-module": {
    level: "error",
    fix: `新文件少于 ${TINY_MODULE_LINES} 行有效代码，且只有一个导入方。把它合并回那个调用方，不要为几行代码单独建文件。`,
  },
  "ci-soft": { level: "error", fix: "失败不阻塞的 CI 等于注释。要么设为必过，要么删除该 job。" },
  "ci-timeout": { level: "error", fix: "超时只在各包 test 脚本里定义一次。CI 按平台放宽超时等于给慢测试开后门。" },
}

// ── 平台敏感路径：改到这些文件时 pre-push 才需要跨平台 preflight ──
export const PLATFORM_SENSITIVE = [
  /^packages\/(core|opencode|tui|cli)\/src\/.*(shell|pty|process|spawn|win32|windows|flock|which|glob|watcher|clipboard|terminal|editor|fs-util|filesystem|path|encoding|decoding)/i,
  /(^|\/)package\.json$/,
  /^bun\.lock$/,
  /^patches\//,
]

// ── 运行时代码：PR 改到这里才跑性能基准 ──
export const RUNTIME_PATHS = /^packages\/(core|opencode|tui|server|cli|llm|plugin|sdk\/js)\/src\//
