# TUI 提示音与通知行为修复方案

> 状态：方案审计候选，只用于后续 TDD 实施。本文件不代表生产代码已修改。
>
> 日期：2026-07-14
>
> 硬约束：本阶段只调研和设计；不实施、不 commit、不 push。未来实现不超过 5 个文件、净增约 50 行，不新增依赖、数据库迁移、SDK 生成或公开 plugin interface。

## 1. 需求

两个问题：

1. **VS Code 双横幅从源头修复** — `attention.ts` 当前总是传默认 title `"opencode"` 给 `triggerNotification`。OpenTUI OSC 99 在 title 非空时发送 title + body 两个 payload，VS Code 某些适配器将它们渲染成两个横幅。修复方式：不传默认 title，让 OpenTUI 只发一个 body payload。不关闭 `notifications` 默认值。
2. **abort 完全静音** — 用户手动 abort 时不播放任何声音（既不是 done 也不是 error），只保留视觉通知。

## 2. 已阅读并确认的现有文件

| 文件 | 相关性 |
| --- | --- |
| `src/cli/cmd/tui/attention.ts:55,210-213` | `DEFAULT_TITLE = "opencode"`；`triggerNotification` 总是收到非空 title，导致 OSC 99 双 payload |
| `src/cli/cmd/tui/feature-plugins/system/notifications.ts` | 通知触发入口；error handler 对 `MessageAbortedError` 仍播放 error 音效 |
| `src/effect/runner.ts:188-192` | `cancel` 先 `idleIfCurrent()` 后 `Fiber.interrupt()`，是通用并发契约不能交换 |
| `src/session/processor.ts:991-1017` | `halt` 先发 `session.error` 后发 `session.status idle`；`MessageAbortedError` 在此产生 |
| `src/cli/cmd/tui/config/tui.ts:332` | 当前 `notifications` 默认值 |
| `test/cli/cmd/tui/attention.test.ts:176,191,253` | 3 处无显式 title 的断言 `title: "opencode"` 需改为 `title: undefined`；line 204 显式传了 `title: "opencode"` 不改 |
| `test/cli/cmd/tui/notifications.test.ts` | abort 测试需更新为 `sound: false` |
| OpenTUI `terminal.zig:writeNotification` | 确认 OSC 99 在 title 非空时发两个 payload，title 为 null/空时只发 body |

## 3. 推荐最小实现方案

### 3.1 `attention.ts`：不传默认 title

当前（`attention.ts:210-213`）：

```ts
return input.renderer.triggerNotification(
  message,
  normalizeText(request.title, DEFAULT_TITLE, TITLE_LIMIT),
)
```

`normalizeText` 在 `request.title` 为空时回退到 `DEFAULT_TITLE`（`"opencode"`），导致 `triggerNotification` 总是收到非空 title。

改为：

```ts
// 不传默认 title：OpenTUI OSC 99 在 title 非空时发送 title + body 两个 payload，
// 某些终端（如 VS Code）将它们渲染成两个通知横幅。
// 传 undefined 让 OpenTUI 只发送一个 body payload。
const title = normalizeText(request.title, "", TITLE_LIMIT)
return input.renderer.triggerNotification(message, title || undefined)
```

`normalizeText` 在 `request.title` 为空时返回 `""`，`"" || undefined` 求值为 `undefined`。OpenTUI 收到 `undefined` 后只发送 body payload。

`DEFAULT_TITLE` 常量保留（其他地方可能引用），但不再用于 `triggerNotification` 的回退。

### 3.2 `notifications.ts`：abort 静音

当前 error handler（行 100-105）：

```ts
api.event.on("session.error", (event) => {
  const sessionID = event.properties.sessionID
  if (!sessionID) return
  if (!active.delete(sessionID)) return
  notify(api, sessionID, sessionErrorMessage(event.properties.error), "error")
})
```

改为：

```ts
api.event.on("session.error", (event) => {
  const sessionID = event.properties.sessionID
  if (!sessionID) return
  if (!active.delete(sessionID)) return
  const isAbort = event.properties.error?.name === "MessageAbortedError"
  // abort 完全静音：用户主动取消，不需要声音提示
  notify(api, sessionID, sessionErrorMessage(event.properties.error), isAbort ? false : "error")
})
```

`notify` 的 `sound` 参数为 `false` 时，`attention.ts` 的 `soundVolume` 返回 `undefined`，不播放声音，视觉通知不受影响。

### 3.3 `config/tui.ts`：保持 `notifications: true`

不修改。VS Code 双横幅已从 `attention.ts` 源头修复，不需要关闭通知。

### 3.4 工作区已有改动的处理

当前工作区有之前未授权的 staged 改动。需要：

| 文件 | 当前 staged 状态 | 目标状态 |
| --- | --- | --- |
| `notifications.ts` | 有 completedTurn/errored 删除/question 静音/subagent 静音 | 保留 + 增加 abort 静音 |
| `notifications.test.ts` | 有更新测试 | 保留 + 更新 abort 断言为 `sound: false` |
| `config/tui.ts` | `notifications: false`（错误） | 恢复为 HEAD（`notifications: true`） |
| `tui.test.ts` | `notifications: false`（错误） | 恢复为 HEAD（`notifications: true`） |
| `specs/tui-plugins.md` | 有描述改动 | 恢复为 HEAD |
| `attention.ts` | 无改动 | 新增 title 修复 |
| `attention.test.ts` | 无改动 | 新增 title 断言更新 |

## 4. 必须保持的既有行为

1. `Runner.cancel` 的 `idleIfCurrent()` → `Fiber.interrupt()` 顺序不变。
2. `attention.ts` 的 `notify` 接口不变，`sound: false` 已有支持。
3. `TuiAttentionSoundNames` 的 6 个槽位不删除。
4. `DEFAULT_TITLE` 常量保留（不删除，只是不再用于 triggerNotification 回退）。
5. `attention.enabled=false` 仍是 hard opt-out。
6. `attention.notifications=true` 默认不变。
7. 正常完成播放 `done`，模型错误播放 `error`，timeout 播放 `error`。
8. question/permission 保留视觉通知（只静音）。
9. subagent 完成静默。
10. `completedTurn` 检查保留（防止 abort 误播 done）。

## 5. 预计修改文件

| # | 文件 | 具体改动 |
| ---: | --- | --- |
| 1 | `src/cli/cmd/tui/attention.ts` | `triggerNotification` 传 `undefined` 而非 `DEFAULT_TITLE` |
| 2 | `src/cli/cmd/tui/feature-plugins/system/notifications.ts` | error handler 对 `MessageAbortedError` 传 `sound: false` |
| 3 | `test/cli/cmd/tui/attention.test.ts` | 3 处无显式 title 的 `title: "opencode"` 改为 `title: undefined`（line 204 显式传 title 不改） |
| 4 | `test/cli/cmd/tui/notifications.test.ts` | abort 测试断言 `sound: false` |
| 5 | `src/cli/cmd/tui/config/tui.ts` | 恢复为 HEAD（`notifications: true`） |
| 6 | `test/config/tui.test.ts` | 恢复为 HEAD（`notifications: true`） |
| 7 | `specs/tui-plugins.md` | 恢复为 HEAD |

实际 vs HEAD 有改动的文件：4 个（attention.ts、notifications.ts、attention.test.ts、notifications.test.ts）。其余 3 个恢复为 HEAD。

## 6. 正常路径、错误路径、边界处理

| 场景 | 事件顺序 | 声音 | 视觉通知 |
| --- | --- | --- | --- |
| 正常完成 | `busy → idle`（assistant 已 completed） | done | 有（title 为 session 标题或 undefined） |
| 用户 abort | `busy → idle`（未 completed）→ `session.error` → `idle` | **无声** | 有 "Session aborted" |
| 模型错误 | `busy → session.error` → `idle` | error | 有 "Session error" |
| 模型超时 | `busy → session.error` → `idle` | error | 有 "Model stopped responding" |
| question | `question.asked` | 无声 | 有 |
| permission | `permission.asked` | 无声 | 有 |
| subagent 完成 | `busy → idle`（有 parentID） | 无声 | 无 |

## 7. 行为级测试计划

### 先写红测

1. **abort 静音**：`busy → idle（未 completed）→ session.error（MessageAbortedError）→ idle` → `sound: false`，不出现 `done` 也不出现 `error`
2. **VS Code 单横幅**：`notify({ message: "hello" })`（无 title）→ `triggerNotification` 收到 `title: undefined`
3. **显式 title 仍传**：`notify({ title: "My Title", message: "hello" })` → `triggerNotification` 收到 `title: "My Title"`
4. 正常完成 → done
5. 模型错误 → error
6. question/permission → `sound: false`
7. subagent → 零通知

### 当前实现下暴露的缺口

- 测试 1：当前 error handler 对 `MessageAbortedError` 传 `"error"`，不传 `false`
- 测试 2：当前 `triggerNotification` 总是收到 `"opencode"`，不收到 `undefined`
- 测试 3：当前 `normalizeText` 回退到 `DEFAULT_TITLE`，显式 title 测试不受影响

## 8. 验证命令

```bash
cd packages/opencode
bun test test/cli/cmd/tui/notifications.test.ts
bun test test/cli/cmd/tui/attention.test.ts
bun test test/config/tui.test.ts
bun typecheck
```

## 9. 预估

| 项目 | 数值 |
| --- | --- |
| 实际改动文件（vs HEAD） | 4 |
| 恢复 HEAD 文件 | 3 |
| 净增 | 约 20-30 行 |
| 删除 | 约 10 行 |
| 生成文件 | 无 |
| 迁移 | 无 |

## 10. 真实风险与开放问题

### 10.1 OSC 99 title 聚合

OpenTUI OSC 99 在 title 非空时发送 title + body 两个 payload，它们共享同一个 notification ID。标准实现应该聚合成一个通知。不传 title 后只发 body，不存在聚合问题。

### 10.2 `normalizeText` 回退行为

改为 `normalizeText(request.title, "", TITLE_LIMIT)` 后，当 `request.title` 为空时返回 `""`，`"" || undefined` 求值为 `undefined`。`triggerNotification` 的类型签名是 `(message: string, title?: string) => boolean`，`undefined` 是合法值。

### 10.3 `DEFAULT_TITLE` 常量

`DEFAULT_TITLE` 仍被 `attention.test.ts` 中显式传 `title: "opencode"` 的测试用例引用。这些测试不受影响，因为 `normalizeText("opencode", "", TITLE_LIMIT)` 返回 `"opencode"`，`"opencode" || undefined` 求值为 `"opencode"`。

## 11. 推荐方案摘要

```text
attention.ts:
  triggerNotification 不传默认 title → OSC 99 只发一个 body payload → VS Code 单横幅

notifications.ts:
  abort (MessageAbortedError) → sound: false → 完全静音
  正常完成 → done
  模型错误/超时 → error
  question/permission → sound: false
  subagent → silent

config/tui.ts:
  notifications 保持 true（不退化）
```
