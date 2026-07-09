# LSP 默认启用方案

> 只调研，不改代码。本方案基于穷尽式探索产出，待 subagent 审计通过后再实施。

---

## 一、问题分析

### 用户反馈
"很多情况下都显示 LSP disabled"，说明 LSP 服务器未能正常启动或配置。当前需要特定配置或环境才能启用 LSP，不易使用。

### 根因调研（四个独立来源）

| # | 原因 | 证据 | 影响面 |
| --- | --- | --- | --- |
| 1 | **LSP 全局默认禁用** | `config.ts:230` `lsp: Schema.optional(ConfigLSP.Info)` — 不设置就为 `undefined`；`lsp.ts:157` `if (!cfg.lsp)` — `undefined` 走禁用分支 | **所有未配置 `lsp` 的用户**（最大门槛） |
| 2 | 环境缺少语言运行时 | `server.ts` 中 12 个服务器无自动安装（deno, oxlint, ty, prisma, dart, ocaml, gleam, clojure, nix, haskell, julia, terraform）；部分服务器需 go/ruby/dotnet/elixir/zig | 特定语言用户 |
| 3 | 项目识别条件未满足 | `server.ts:102` TypeScript 需 `Module.resolve("typescript/lib/tsserver.js")`，项目无 TS 依赖则不启动 | 特定项目 |
| 4 | UI 统一显示 "disabled" | `lsp.ts:60` Status schema 只有 "connected"/"error"，不区分原因 | 诊断体验 |

### 官方态度
- **PR #23416**（commit `22190bd`）试图把 `lsp` 默认改为 `true`，**被关闭**。维护者明确说"LSP is intentionally disabled by default"。
- **PR #32876**（Open）是文档修复，明确说明 LSP 默认禁用。
- **Issue #23566 / #27537** 报告文档暗示 LSP 默认启用但实际禁用。

### 其他工具对比
| 工具 | LSP 默认启用 | 自动安装 | 自包含程度 |
| --- | --- | --- | --- |
| **OpenCode** | ❌ 需 `"lsp": true` | ✅ 混合（npm/go/gem/dotnet/fetch） | 中（高于竞品） |
| Claude Code | ❌ 需安装插件 | ❌ 需用户装 binary | 低 |
| Codex CLI | ❌ 无原生 LSP | ❌ | 不适用 |
| Cursor/Windsurf | 随扩展 | 扩展负责 | 中（依赖 IDE 生态） |
| Aider | 无 LSP | 不适用 | 用 tree-sitter 替代 |

**结论**：OpenCode 的 LSP 自动安装程度已高于竞品，但**默认禁用**是最大门槛。

---

## 二、已阅读的文件及相关性

### 核心文件
| 文件 | 为什么相关 |
| --- | --- |
| `src/lsp/lsp.ts:152-211` | LSP Service state 初始化，`if (!cfg.lsp)` 是默认禁用的核心判断。**本次主要修改点。** |
| `src/config/config.ts:230` | `lsp: Schema.optional(ConfigLSP.Info)` — optional 导致默认 `undefined`。 |
| `src/config/lsp.ts` | ConfigLSP schema 定义。`Info = Union([Boolean, Record(String, Entry)])`。 |
| `src/lsp/server.ts` | 37 个服务器定义。10 个用 `Npm.which()`，12 个无自动安装。 |
| `src/effect/runtime-flags.ts:21` | `disableLspDownload: bool("OPENCODE_DISABLE_LSP_DOWNLOAD")` 默认 false。 |
| `src/util/which.ts` | `which()` 在 PATH + `Global.Path.bin` 中查找。 |
| `packages/core/src/npm.ts:197-244` | `Npm.which()` 用 `@npmcli/arborist` 自动安装。**已修复 Issue #9404 的 Bun bug。** |

### 测试文件
| 文件 | 为什么相关 |
| --- | --- |
| `test/lsp/index.test.ts:53-95` | "LSP is unset" 和 "lsp is true" 的对比测试。**需更新。** |
| `test/lsp/lifecycle.test.ts:49-71` | hasClients 在 LSP unset/false/true 下的行为。**需更新。** |
| `test/lsp/client.test.ts` | 诊断逻辑测试。不受影响。 |
| `test/effect/runtime-flags.test.ts:133-145` | `disableLspDownload` 默认 false。不受影响。 |

### 外部调研
| 来源 | 关键结论 |
| --- | --- |
| PR #23416 (Closed) | 官方拒绝默认启用 LSP |
| PR #32876 (Open) | 文档明确 LSP 默认禁用 |
| PR #18308 (Merged) | `@npmcli/arborist` 替换 Bun，**已在本地基线中** |
| PR #14228 (Open) | 插件注册 LSP，未合并 |
| Issue #23566/#27537 | 用户困惑 LSP 默认禁用 |
| Issue #9404 (Closed) | Bun 自动安装 bug，已被 #18308 间接修复 |
| ChatGPT 深度调研 | 确认无统一自包含 LSP 方案；OpenCode 自动安装程度高于竞品 |

---

## 三、必须保持的既有行为

1. **`"lsp": false` 显式禁用整个 LSP 子系统** — 用户可以通过设置 `false` 完全关闭 LSP。
2. **`"lsp": true` 启用所有内置服务器** — 不改变。
3. **`"lsp": { ... }` 对象配置自定义服务器** — 不改变。对象中 `"disabled": true` 仍可禁用单个服务器。
4. **`disableLspDownload` flag** — 仍控制是否允许自动下载/安装。
5. **LSP 按需启动** — 服务器只在 `touchFile` 时基于文件扩展名 spawn，不在启动时全部启动。
6. **`[local-smark]` status() 检查** — write/edit/apply_patch 中空诊断时区分"LSP 未运行"的逻辑不变。
7. **`hasClients` 检查 broken Set** — spawn 失败的 server 会被跳过。
8. **LSP init() 是 fire-and-forget** — 不阻塞 opencode 启动。

---

## 四、推荐的最小实现方案

### 核心改动：默认启用 LSP（2 行）

**文件**：`packages/opencode/src/lsp/lsp.ts`

```ts
// 行 157，从：
if (!cfg.lsp) {
// 改为：
// [local-smark] 默认启用 LSP：未配置时视为 true，仅 false 显式禁用。
// 官方 PR #23416 因"LSP 有意默认禁用"被关闭，但作为 fork 我们选择默认启用
// 以降低使用门槛。LSP 按需启动（touchFile 时 spawn），不影响启动性能。
if (cfg.lsp === false) {
```

```ts
// 行 166，从：
if (cfg.lsp !== true) {
// 改为：
// [local-smark] cfg.lsp 为 undefined（默认启用）时跳过自定义配置遍历，
// 防止 Object.entries(undefined) 报错。仅对象类型才进入自定义配置。
if (cfg.lsp && cfg.lsp !== true) {
```

### 行为变化矩阵

| `cfg.lsp` 值 | 改前行为 | 改后行为 | 变化 |
| --- | --- | --- | --- |
| `undefined`（未配置） | ❌ 禁用 | ✅ 启用所有内置 | **核心变化** |
| `false` | ❌ 禁用 | ❌ 禁用 | 不变 |
| `true` | ✅ 启用所有内置 | ✅ 启用所有内置 | 不变 |
| `{ ... }` | ✅ 启用配置的 | ✅ 启用配置的 | 不变 |

### 为什么这个方案最符合现有设计

1. **最小改动**：2 行核心逻辑改动，不新增抽象、配置项或 API。
2. **复用现有架构**：不改变 LSP Service interface、不改变 server spawn 逻辑、不改变诊断流程。
3. **向后兼容**：`"lsp": false` 仍可禁用；`"lsp": true` 和 `"lsp": {...}` 不受影响。
4. **按需启动**：LSP 服务器只在 `touchFile` 时 spawn（基于文件扩展名），默认启用不会在启动时全部 spawn 37 个服务器。`init()` 是 fire-and-forget。
5. **安全网**：smark 已有的 `[local-smark]` status() 检查确保无 server 时不产生干扰诊断。

### 不做的（及原因）

| 不做的 | 原因 |
| --- | --- |
| 为 12 个无自动安装的服务器添加 Npm.which() | 大部分需要特定语言运行时（dart/ocaml/gleam/clojure/nix/haskell/julia），无法通过 npm 安装；工作量大且收益低 |
| 改进 disabled 状态显示（区分原因） | 需改 Status schema + UI，范围大，与核心需求不直接相关 |
| 回移 PR #14228（插件注册 LSP） | 6 commits，未合并，改动大，风险高 |
| 添加 oxlint 的 Npm.which() | oxlint 的 LSP 模式需 `--lsp` 检查，逻辑复杂，可后续迭代 |

---

## 五、预计修改的文件

### 1. `packages/opencode/src/lsp/lsp.ts`（修改 2 行 + 2 行注释）

行 157：`if (!cfg.lsp)` → `if (cfg.lsp === false)` + 注释
行 166：`if (cfg.lsp !== true)` → `if (cfg.lsp && cfg.lsp !== true)` + 注释

### 2. `packages/opencode/test/lsp/index.test.ts`（修改 ~5 行）

将 "when LSP is unset" 测试改为 "when LSP is false"（加 `config: { lsp: false }`）：

```ts
// 原（行 53）：
it.live("does not spawn builtin LSP for files inside instance when LSP is unset", () =>
  provideTmpdirInstance((dir) =>
    ...
    expect(spy).toHaveBeenCalledTimes(0)
    ...
  ),
)

// 改为：
it.live("does not spawn builtin LSP for files inside instance when LSP is false", () =>
  provideTmpdirInstance(
    (dir) =>
      ...
      expect(spy).toHaveBeenCalledTimes(0)
      ...
    ,
    { config: { lsp: false } },
  ),
)
```

添加默认启用测试：
```ts
it.live("spawns builtin LSP for files inside instance when LSP is unset (default enabled)", () =>
  provideTmpdirInstance((dir) =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
        try {
          yield* lsp.hover({
            file: path.join(dir, "src", "inside.ts"),
            line: 0,
            character: 0,
          })
          expect(spy).toHaveBeenCalledTimes(1)
        } finally {
          spy.mockRestore()
        }
      }),
    ),
  ),
)
```

### 3. `packages/opencode/test/lsp/lifecycle.test.ts`（修改 ~5 行）

将 "when LSP is unset" 测试改为 "when LSP is false"（加 `config: { lsp: false }`）：

```ts
// 原（行 49）：
it.live("hasClients() returns false for .ts files in instance when LSP is unset", () =>
  provideTmpdirInstance((dir) =>
    ...
    expect(result).toBe(false)
    ...
  ),
)

// 改为：
it.live("hasClients() returns false for .ts files in instance when LSP is false", () =>
  provideTmpdirInstance(
    (dir) =>
      ...
      expect(result).toBe(false)
      ...
    ,
    { config: { lsp: false } },
  ),
)
```

添加默认启用测试：
```ts
it.live("hasClients() returns true for .ts files in instance when LSP is unset (default enabled)", () =>
  provideTmpdirInstance((dir) =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.hasClients(path.join(dir, "test.ts"))
        expect(result).toBe(true)
      }),
    ),
  ),
)
```

---

## 六、正常路径、错误路径、并发/安全边界

### 正常路径（默认启用后）
1. 用户安装 opencode，不配置 `lsp`。
2. opencode 启动 → `init()` fire-and-forget → `InstanceState.get(state)` → `cfg.lsp` 为 `undefined` → `cfg.lsp === false` 为 false → 加载所有内置服务器到 `s.servers`。
3. Agent 操作 `.ts` 文件 → `touchFile(file)` → `getClients(file)` → TypeScript server 匹配扩展名 → `server.spawn(root, ctx, flags)` → `which("typescript-language-server")` 或 `Npm.which()` 安装 → client 创建 → 诊断可用。

### 错误路径
- **二进制未安装且下载被禁用**：`flags.disableLspDownload` 为 true → spawn 返回 undefined → server 加入 `broken` Set → `hasClients` 跳过 → lsp 工具抛 "No LSP server available" → write/edit 的 smark status() 检查显示 "LSP diagnostics unavailable"。
- **二进制未安装但允许下载**：`Npm.which()` 触发安装 → 安装成功则正常 → 安装失败则 `Npm.which()` 返回 none → spawn 返回 undefined → 同上。
- **项目无 typescript 依赖**：`Module.resolve("typescript/lib/tsserver.js")` 返回 undefined → spawn 返回 undefined → 同上。
- **`cfg.lsp` 为 `false`**：`cfg.lsp === false` 为 true → 禁用 → servers 为空 → 所有 LSP 操作返回空/抛错。

### 并发
- **多个 touchFile 并发**：`getClients` 有 `spawning` Map 去重，同一 server+root 的 spawn 只执行一次。
- **默认启用不增加并发压力**：服务器仍按需 spawn，不会同时启动 37 个。

### 安全边界
- **资源控制**：`disableLspDownload` 仍控制下载行为。用户可设 `"lsp": false` 完全禁用。
- **向后兼容**：现有配置（`false`/`true`/`{...}`）行为不变。

---

## 七、行为级测试计划

### 先写的测试
1. **默认启用验证**：无 config 时 hasClients(.ts) 返回 true。
2. **显式禁用验证**：`config: { lsp: false }` 时 hasClients(.ts) 返回 false，spawn 不被调用。
3. **显式启用验证**：`config: { lsp: true }` 时 spawn 被调用（已有测试，不变）。
4. **对象配置验证**：`config: { lsp: { eslint: { disabled: true } } }` 时内置 TypeScript 仍可用（已有测试，不变）。
5. **undefined 安全性**：无 config 时 `Object.entries` 不报错（隐含在测试 1 中）。

### 当前实现下会暴露的缺口
- 当前 "when LSP is unset" 测试期望 hasClients=false / spawn=0，改后期望反转。
- 无默认启用的测试覆盖。

### 实现后验证
- `bun test test/lsp/` 全部通过
- `bun typecheck` 通过

---

## 八、建议运行的验证命令

```bash
cd packages/opencode && bun typecheck
cd packages/opencode && bun test test/lsp/
cd packages/opencode && bun test test/tool/lsp.test.ts
```

---

## 九、预估 git 文件数、增删行数

| 文件 | 新增 | 删除 | 说明 |
| --- | --- | --- | --- |
| `src/lsp/lsp.ts` | 4 | 2 | 2 行逻辑 + 2 行注释 |
| `test/lsp/index.test.ts` | 12 | 3 | 改 1 测试 + 加 1 测试 |
| `test/lsp/lifecycle.test.ts` | 12 | 3 | 改 1 测试 + 加 1 测试 |
| **合计** | ~28 | ~8 | 3 个文件，净增 ~20 行 |

无生成文件、无迁移、无新文档（本方案文档除外）。

---

## 十、真实风险与开放问题

### 风险
1. **资源消耗**：默认启用后，agent 操作文件时会触发 LSP spawn。但按需启动（基于扩展名），不会全部启动。首次操作可能触发 `Npm.which()` 安装（几秒到几十秒），之后有缓存。**低风险**。
2. **诊断干扰**：默认启用后，write/edit/apply_patch 会显示诊断。但 smark 已有 status() 检查（无 server 时不显示错误），不会产生干扰。**低风险**。
3. **向后兼容**：未配置 `lsp` 的用户从"禁用"变为"启用"。这是**预期行为变化**，不是回归。用户可设 `"lsp": false` 恢复。**低风险**。
4. **与官方分叉**：官方明确拒绝默认启用（PR #23416）。作为 fork 我们选择不同方向。后续 merge upstream 时需保留此改动。**已知风险，可接受**。

### 开放问题
1. **是否需要文档更新**：opencode.ai/docs/lsp 文档暗示 LSP 自动安装，但实际默认禁用。默认启用后文档与行为一致。如需更新文档，是 separate PR。
2. **是否需要 UI 提示**：默认启用后，用户不再需要知道 `"lsp": true`。但如果 LSP 服务器安装失败，用户仍需知道原因。改进状态显示是后续迭代。
3. **oxlint 自动安装**：oxlint 可通过 npm 安装但当前未用 `Npm.which()`。可作为后续迭代。

---

## 十一、推荐方案摘要

**1 项改动，3 个文件，净增约 20 行：**

**默认启用 LSP**：将 `lsp.ts` 中 `if (!cfg.lsp)` 改为 `if (cfg.lsp === false)`，同时将 `if (cfg.lsp !== true)` 改为 `if (cfg.lsp && cfg.lsp !== true)` 防止 undefined 时 `Object.entries` 报错。

**效果**：用户不再需要在 `opencode.json` 中配置 `"lsp": true`。opencode 安装后即默认启用所有内置 LSP 服务器（按需启动）。已有的自动安装机制（`Npm.which()` / `go install` / `gem install` / `dotnet tool install` / GitHub Release 下载）会自动为 TypeScript、Python、Go、Ruby、C#、Rust、C/C++、Java、Kotlin、YAML、Lua、PHP、Bash、Svelte、Astro、Vue、ESLint、Biome 等语言安装 LSP 服务器。

**不做的**：为 12 个无自动安装的服务器添加安装逻辑（大部分需特定语言运行时）、改进 disabled 状态显示、回移 PR #14228（插件注册 LSP）、oxlint 自动安装。
