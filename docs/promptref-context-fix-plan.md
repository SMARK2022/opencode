# PromptRef Context Provider 崩溃修复方案

> 状态：待审计 | 不含代码修改，仅设计方案

## 1. 错误现象

用户在 TUI 中点击消息时崩溃：
```
Error: PromptRef context must be used within a context provider
```

触发路径：`onMouseUp` → `dialog.replace(() => <DialogMessage />)` → `DialogMessage` 调用 `usePromptRef()` → 抛出错误。

## 2. 已阅读并确认的文件

| 文件 | 行号 | 相关性 |
|---|---|---|
| `cli/cmd/tui/routes/session/dialog-message.tsx` | 6, 20, 90 | bug 所在：导入并调用 `usePromptRef()`，在 Retry onSelect 中使用 `promptRef.current?.submit()` |
| `cli/cmd/tui/context/prompt.tsx` | 1-18 | PromptRef context 定义，`createSimpleContext({ name: "PromptRef" })` |
| `cli/cmd/tui/context/helper.tsx` | 19-22 | `createSimpleContext` 的 `use()` 方法：`if (!value) throw new Error(`${input.name} context must be used within a context provider`)` |
| `cli/cmd/tui/ui/dialog.tsx` | 140-155, 172-200 | `dialog.replace()` 机制：将 input 存入 `store.stack`，在 `DialogProvider` 的 `<box>` 中渲染 `value.stack.at(-1)!.element` |
| `cli/cmd/tui/app.tsx` | 255-284 | 组件树：`DialogProvider`(258) 在 `PromptRefProvider`(262) **之上** |
| `cli/cmd/tui/routes/session/index.tsx` | 219, 640, 1358 | `promptRef = usePromptRef()`(219) 在 PromptRefProvider 内→正常；`DialogTimeline`(640) 和 `DialogMessage`(1358) 通过 `dialog.replace()` 渲染 |
| `cli/cmd/tui/routes/session/dialog-timeline.tsx` | 10-13, 37 | `DialogTimeline` props（无 submit），`dialog.replace(() => <DialogMessage setPrompt={props.setPrompt} />)` |

## 3. 根因分析

### 组件树嵌套关系（app.tsx:255-284）

```
DialogProvider (258)               ← dialog 内容在此渲染（dialog.tsx:180-200）
  CommandPaletteProvider (259)
    FrecencyProvider (260)
      PromptHistoryProvider (261)
        PromptRefProvider (262)    ← PromptRef context 仅在此时向下提供
          EditorContextProvider (263)
            App (264)              ← session/index.tsx 在此层
```

### dialog.replace() 渲染机制（dialog.tsx:172-200）

`DialogProvider` 的 JSX 结构：
```tsx
<ctx.Provider value={value}>
  {props.children}                    ← 包含 App → PromptRefProvider → session/index.tsx
  <box position="absolute" ...>       ← dialog 内容渲染区
    <Show when={value.stack.length}>
      <Dialog ...>
        {value.stack.at(-1)!.element} ← DialogMessage 在此渲染
      </Dialog>
    </Show>
  </box>
</ctx.Provider>
```

`{value.stack.at(-1)!.element}` 是 `{props.children}` 的**兄弟节点**，不是子节点。SolidJS context 只向后代提供，不向兄弟提供。因此 dialog 渲染区在 `DialogProvider` 层级，**高于** `PromptRefProvider`，`usePromptRef()` 找不到 context。

### 为什么其他 context hook 正常

`DialogMessage` 还使用了 `useSync()`、`useSDK()`、`useRoute()`。它们的 provider 在组件树中位于 `DialogProvider` **之上**：

```
RouteProvider (279) → ... → SDKProvider (277) → ... → SyncProvider (275) → ... → DialogProvider (258)
```

所以这些 context 在 dialog 渲染区可用。只有 `PromptRefProvider` 在 `DialogProvider` 之下，导致 `usePromptRef()` 失败。

### 唯一受影响的调用点

grep 确认 `usePromptRef()` 在 4 处使用：
- `session/index.tsx:219` — 在 App 内（PromptRefProvider 之下）→ 正常 ✅
- `dialog-message.tsx:20` — 在 dialog 渲染区（PromptRefProvider 之上）→ **崩溃** ❌
- `home.tsx:24` — 在 App 内 → 正常 ✅
- `app.tsx:314` — 在 App 内 → 正常 ✅

## 4. 必须保持的既有行为

1. `DialogMessage` 的 Revert/Copy/Fork 选项行为不变
2. `DialogMessage` 的 Retry 选项功能完整（await revert → setPrompt → submit）
3. `DialogTimeline` 的 timeline 导航和消息选择行为不变
4. `session/index.tsx` 的 `promptRef`（line 219）在 PromptRefProvider 内正常工作
5. `setPrompt` prop 链路保持不变（session → DialogTimeline → DialogMessage）

## 5. 推荐方案：通过 prop 传递 submit 回调

### 为什么这个方案最符合现有设计

- **复用现有模式**：`setPrompt` 已经通过 prop 链传递（session → DialogTimeline → DialogMessage），`submit` 采用相同模式
- **不改变组件树**：不需要移动 `PromptRefProvider` 的位置（那会影响其他依赖渲染顺序的逻辑）
- **不引入新抽象**：只是新增一个可选 prop
- **手术刀式**：4 文件，每个文件改动 1-3 行

### 替代方案及为什么不选

| 方案 | 否定原因 |
|---|---|
| 将 `PromptRefProvider` 移到 `DialogProvider` 之上 | 改变组件树结构，可能影响 PromptRef 的初始化时序（promptRef.set 在 App bind 时调用）；且 `PromptRefProvider` 依赖 `DialogProvider` 之下的其他 provider |
| 在 `DialogMessage` 内用 `useDialog` 获取 dialog 上下文再查找 PromptRef | hack 性方案，SolidJS context 不支持跨树查找 |
| 在 dialog 渲染区包裹 `PromptRefProvider` | dialog.tsx 是通用 UI 组件，不应依赖业务 context |

## 6. 预计修改的文件和具体改动

### 6.1 `dialog-message.tsx`（3 处改动）

**改动 1**：移除 import（line 6）
```ts
// 删除：
import { usePromptRef } from "@tui/context/prompt"
```

**改动 2**：移除 `usePromptRef()` 调用，新增 `submit` prop（line 11-20）
```ts
// 当前：
export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  // ...
  const promptRef = usePromptRef()

// 修改后：
export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
  // submit 回调由调用方传入——dialog.replace 渲染上下文脱离 PromptRefProvider，
  // 不能在此组件内直接 usePromptRef，必须通过 prop 传递。
  submit?: () => void
}) {
  // ...
  // 删除 const promptRef = usePromptRef()
```

**改动 3**：Retry onSelect 中替换调用（line 90）
```ts
// 当前：
promptRef.current?.submit()

// 修改后：
props.submit?.()
```

### 6.2 `dialog-timeline.tsx`（2 处改动）

**改动 1**：新增 `submit` prop（line 10-14）
```ts
// 当前：
export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
  setPrompt?: (prompt: PromptInfo) => void
}) {

// 修改后：
export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
  setPrompt?: (prompt: PromptInfo) => void
  submit?: () => void
}) {
```

**改动 2**：传递 `submit` 到 `DialogMessage`（line 37）
```tsx
// 当前：
<DialogMessage messageID={message.id} sessionID={props.sessionID} setPrompt={props.setPrompt} />

// 修改后：
<DialogMessage messageID={message.id} sessionID={props.sessionID} setPrompt={props.setPrompt} submit={props.submit} />
```

### 6.3 `session/index.tsx`（2 处改动）

**改动 1**：`DialogTimeline` 调用点（line 640-649）新增 `submit` prop
```tsx
// 当前：
<DialogTimeline
  onMove={...}
  sessionID={route.sessionID}
  setPrompt={(promptInfo) => prompt?.set(promptInfo)}
/>

// 修改后：
<DialogTimeline
  onMove={...}
  sessionID={route.sessionID}
  setPrompt={(promptInfo) => prompt?.set(promptInfo)}
  submit={() => promptRef.current?.submit()}
/>
```

**改动 2**：`DialogMessage` 调用点（line 1358-1362）新增 `submit` prop
```tsx
// 当前：
<DialogMessage
  messageID={message.id}
  sessionID={route.sessionID}
  setPrompt={(promptInfo) => prompt?.set(promptInfo)}
/>

// 修改后：
<DialogMessage
  messageID={message.id}
  sessionID={route.sessionID}
  setPrompt={(promptInfo) => prompt?.set(promptInfo)}
  submit={() => promptRef.current?.submit()}
/>
```

## 7. 正常/错误/边界路径

### 正常路径（Retry）
```
用户点击消息 → onMouseUp → dialog.replace(<DialogMessage submit={...} />)
→ DialogMessage 渲染（不调用 usePromptRef，不崩溃）
→ 用户选 Retry → await revert → setPrompt → props.submit() → promptRef.current?.submit()
```

### 边界路径
- **submit 未传入**（如未来新增调用点忘记传）：`props.submit?.()` optional chaining，静默不提交，用户需手动回车——降级但不崩溃
- **promptRef.current 为 undefined**（prompt 组件未注册）：`promptRef.current?.submit()` optional chaining，静默不提交

### 不受影响的路径
- Revert/Copy/Fork 选项不使用 `submit`，行为完全不变
- `DialogTimeline` 的 timeline 导航不使用 `submit`，行为不变

## 8. 行为级测试计划

### 当前测试缺口
`DialogMessage` 是 SolidJS 组件，通过 `dialog.replace()` 渲染。现有测试基础设施无 TUI 组件渲染框架，无法直接测试 dialog 内的组件行为。

### 验证方式
1. **Typecheck**：确认 `submit` prop 类型正确，`usePromptRef` import 移除后无 unused import
2. **手动验证**：在 TUI 中点击消息 → 弹出菜单不崩溃 → 选 Retry → revert + 重发正常
3. **回归验证**：现有 `test/session/revert-compact.test.ts` 全部通过（不涉及 TUI 组件）

## 9. 验证命令

```bash
cd packages/opencode && bun run --bun typecheck
cd packages/opencode && bun test test/session/revert-compact.test.ts
```

## 10. git 文件数与行数预估

| 文件 | 改动 | 行数 |
|---|---|---|
| `dialog-message.tsx` | 移除 import + 移除 usePromptRef + 新增 prop + 替换调用 | -2 +3 |
| `dialog-timeline.tsx` | 新增 prop + 传递 prop | +2 |
| `session/index.tsx` | 2 处新增 submit prop | +2 |
| **总计** | **3 文件** | **~7 行净增** |

0 迁移，0 SDK 重新生成，0 新增文件。

## 11. 风险与开放问题

### 已确认无风险
- `promptRef`（session/index.tsx:219）在 `PromptRefProvider` 内，`promptRef.current?.submit()` 正常工作
- `submit` 是可选 prop，现有调用点不传时不会崩溃（但 Retry 无法自动提交）
- 不改变组件树结构，不影响其他 context provider

### 无开放问题
所有调用点（2 处 `DialogMessage`、1 处 `DialogTimeline`）均已确认，`promptRef` 在 `session/index.tsx` 中可用。
