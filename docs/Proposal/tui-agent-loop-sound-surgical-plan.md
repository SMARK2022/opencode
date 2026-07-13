# TUI Agent Loop 提示音甜点级实现方案

> 状态：第 4 轮方案审计候选，只用于后续 TDD 实施。本文件不代表生产代码已修改。
> 第 1-3 轮因过度设计（Session settlement 状态机、KV provider 并发重构、compat 通知矩阵、exit flush barrier 等）已全部否决。
>
> 日期：2026-07-13
>
> 硬约束：本阶段只调研和设计；不实施、不 commit、不 push。未来实现不超过 7 个文件、净增约 100 行，不新增依赖、数据库迁移、SDK 生成或公开 plugin interface。
>
> 指定声源：优先使用 `.temp/testing/sfx/bun_tui_chatgpt_error_sfx.zip` 内的 `chatgpt_error_tui_pcm16_mono_48k.wav`；单 Bun executable 使用已提供的 `chatgpt_error_sfx_embedded.ts` 字节模块，不把 WAV 作为运行时外部文件。

## 1. 推荐方案摘要

需求只有三件事：agent loop 结束响一声、abort 不响、Ctrl+P 可开关且默认开。

当前主 TUI 已有完整链路，不需要改 Session、Runner、KV provider 或 exit 生命周期：

```text
session.status busy/retry -> idle
  -> internal:notifications
  -> api.attention.notify({ sound: { name: "done" } })
  -> createTuiAttention
  -> TuiAudio
  -> @opentui/core Audio
  -> 系统默认输出设备
```

做三件事：

1. 把 built-in `done` 从 `bip-bop-01.mp3` 换成内嵌 WAV bytes；其余槽位不变。
2. 给 `TuiAudio` 加一个 keyed bytes loader，复用现有 cache 和 engine。
3. Ctrl+P 加 `app.toggle.sound_effects`，模式与现有 `app.toggle.animations` 完全一致：`kv.get/set("attention_sound_enabled", boolean)`，默认 true。attention host 在播放前读同一 KV key 做 gate。

不改 KV provider、不改 exit、不搞 compat 矩阵。`attention.enabled` 默认从 false 改为 true（落实 `specs/v2/notifications.md` 已有目标）。

abort 不响：现有 `notifications.ts` 已在 error 后抑制 done，abort 走 error attention。保持不变。

预计 7 个文件：

1. `packages/opencode/src/cli/cmd/tui/util/audio.ts`
2. `packages/opencode/src/cli/cmd/tui/attention.ts`
3. `packages/opencode/src/cli/cmd/tui/app.tsx`
4. `packages/opencode/src/cli/cmd/tui/config/tui.ts`
5. `packages/opencode/test/cli/cmd/tui/attention.test.ts`
6. `packages/opencode/test/config/tui.test.ts`
7. `packages/opencode/specs/tui-plugins.md`

## 2. 已阅读并确认的现有文件

### 2.1 核心链路

| 文件 | 已确认事实 |
| --- | --- |
| `src/cli/cmd/tui/feature-plugins/system/notifications.ts` | busy/retry→idle 触发 done；error 后抑制紧邻 idle 的 done；subagent 用 `subagent_done`；abort 走 error attention 不发 done |
| `src/cli/cmd/tui/attention.ts` | `createTuiAttention({ renderer, config, kv })`；built-in pack 的 `done` 当前是 `bip-bop-01.mp3`；`playSound` 遍历 candidates 调 `audio.loadSoundFile`；`soundVolume` 检查 `config.attention.sound` |
| `src/cli/cmd/tui/util/audio.ts` | lazy engine、按 path Promise cache、`play()` 时 `start()` 默认设备、`dispose()` |
| `src/cli/cmd/tui/app.tsx` | `appCommands` 是 `createMemo`，直接内联 `kv.get/set` 做 toggle；`app.toggle.animations`、`app.toggle.paste_summary` 等都是同一模式 |
| `src/cli/cmd/tui/context/kv.tsx` | Solid `createStore`，`get` 读 store，`set` 写 store + 排队 Flock + atomic rename；现有 `animations_enabled` 等 boolean preference 都直接用 |
| `src/cli/cmd/tui/config/tui.ts` | resolved defaults 在 `:331` 行：`enabled: acc.result.attention?.enabled ?? false` |
| `src/cli/cmd/tui/config/keybind.ts` | `command_list` 默认 `ctrl+p` → `command.palette.show` |
| `src/cli/cmd/tui/context/command-palette.tsx` | 读取 reachable `namespace:"palette"` commands |

### 2.2 测试

| 文件 | 已有保障 |
| --- | --- |
| `test/cli/cmd/tui/attention.test.ts` | focus、sound/notification 独立开关、volume clamp、lazy load、fallback、sound pack、KV pack、failure containment、dispose；`FakeKV` 和 `FakeAudioEngine` 可直接扩展 |
| `test/config/tui.test.ts` | attention defaults；当前断言 `enabled: false` |

### 2.3 资产与构建

| 已确认事实 |
| --- |
| ZIP 内 WAV：PCM16、mono、48kHz、56,140 bytes、SHA-256 `02fbf5d8...`、duration 0.586s |
| `chatgpt_error_sfx_embedded.ts` 的 `errorSoundBytes()` 产出相同 hash |
| `bun build --compile` 单文件编译成功 |
| OpenTUI 0.3.4 `Audio.loadSound(Uint8Array)` 可用；无 device 选择时 `start()` 用系统默认设备 |
| 默认 volume 0.4，peak 约 0.16，不 clip |

## 3. 推荐最小实现

### 3.1 `util/audio.ts`：keyed bytes loader

复用现有 `sounds` Map cache：

```ts
// 直接从 bytes 加载并缓存，避免落临时文件；key 必须稳定且唯一
export function loadSound(key: string, bytes: () => Uint8Array | Promise<Uint8Array>) {
  const current = getAudio()
  if (!current) return Promise.resolve(null)
  const cached = sounds.get(key)
  if (cached) return cached
  const task = Promise.resolve(bytes())
    .then((value) => current.loadSound(value))
    .catch((error) => {
      log.debug("failed to load tui sound bytes", { key, error })
      return null
    })
  sounds.set(key, task)
  return task
}
```

让 `loadSoundFile` 复用它：

```ts
export function loadSoundFile(file: string) {
  return loadSound(file, () => Bun.file(file).bytes())
}
```

### 3.2 `attention.ts`：内嵌 bytes + KV sound gate

在文件内放置 verified private payload（来自 `.temp/testing/sfx/chatgpt_error_sfx_embedded.ts`）：

```ts
// 内嵌完成提示音的 WAV 字节；单消费者私有数据，不新增浅模块
// 直接 bytes 避免 temp file 覆盖/残留/Windows lock，保证 single Bun executable 无外部依赖
const ERROR_SFX_WAV_BASE64 = "..." // 56,140 bytes 的 Base64

function errorSoundBytes() {
  return new Uint8Array(Buffer.from(ERROR_SFX_WAV_BASE64, "base64"))
}
```

built-in `done` 从 path 改为 embedded source：

```ts
// done 槽位使用内嵌 bytes 而非 mp3 path；其余槽位不变
type SoundSource = string | { key: string; bytes: () => Uint8Array }

const BUILTIN_PACK: RegisteredSoundPack = {
  ...
  sounds: {
    default: defaultSoundPath,
    question: questionSoundPath,
    permission: permissionSoundPath,
    error: errorSoundPath,
    done: { key: "opencode.default:done:chatgpt-error", bytes: errorSoundBytes },
    subagent_done: subagentDoneSoundPath,
  },
}
```

`playSound` 对 string 调 `loadSoundFile`，对 embedded 调 `loadSound`：

```ts
async function playSound(name: TuiAttentionSoundName, volume: number) {
  // KV 持久化总音效开关；默认 true，Ctrl+P command 直接读写此 key
  const soundEnabled = input.kv?.get<boolean>("attention_sound_enabled", true) ?? true
  if (!soundEnabled) return false
  try {
    for (const source of soundCandidates(name)) {
      const current = typeof source === "string"
        ? await audio.loadSoundFile(source).catch(...)
        : await audio.loadSound(source.key, source.bytes).catch(...)
      if (disposed) return false
      if (current == null) continue
      if (audio.play(current, { volume }) != null) return true
    }
    return false
  } catch (error) {
    log.debug("failed to play attention sound", { error })
    return false
  }
}
```

`soundCandidates` 返回 `SoundSource[]` 而非 `string[]`，filter 逻辑不变。

不需要 `soundEnabled()` / `toggleSound()` 方法 — app.tsx 直接读写 KV，跟 animations 完全一样。

### 3.3 `app.tsx`：Ctrl+P command

在现有 `appCommands` 数组加一项，模式与 `app.toggle.animations` 完全一致：

```ts
// 总音效开关，持久化到 KV；默认启用，与 animations toggle 同一模式
{
  name: "app.toggle.sound_effects",
  title: kv.get("attention_sound_enabled", true) ? "Disable sound effects" : "Enable sound effects",
  category: "System",
  run: () => {
    kv.set("attention_sound_enabled", !kv.get("attention_sound_enabled", true))
    dialog.clear()
  },
},
```

`appCommands` 是 `createMemo`，`kv.get` 读 Solid store，title 随 toggle 自动更新。不需要额外 reactive wiring。

### 3.4 `config/tui.ts`：默认启用

```ts
enabled: acc.result.attention?.enabled ?? true
```

其余 defaults 不变（`notifications=true`、`sound=true`、`volume=0.4`）。

显式 `attention.enabled=false` 继续 hard disable 整个 attention host。

## 4. 必须保持的既有行为

1. no-op idle 不通知。
2. busy/retry 后 idle 才算一次 done。
3. error 后紧邻 idle 不发 done（abort 走 error attention，不发 done）。
4. subagent 用 `subagent_done`，root 用 `done`。
5. config override → active pack → builtin pack 的 fallback 顺序。
6. public `TuiAttentionSoundPack` 继续只接受 path string。
7. text sanitize、focus skip、volume clamp、renderer dispose 不变。
8. `attention.enabled=false` 仍是 hard opt-out。

## 5. 行为级 TDD 计划

### 5.1 先写红测

#### A. 默认启用

`test/config/tui.test.ts`：

```text
完全无 attention 配置 -> enabled === true
显式 enabled:false -> false
```

当前实现第一条失败，因为默认是 false。

#### B. embedded done source + exact asset identity

扩展 `FakeAudioEngine` 支持 bytes loader：

```text
notify(sound.name="done")
-> FakeAudioEngine 收到 bytes
-> bytes.length === 56_140
-> sha256(bytes) === 02fbf5d8967068622673c475ed367dabfc2eeae4e4b1991c3c443e3881b42e01
-> 只 play 一次
```

当前失败，因为 `done` 仍是 mp3 path，且 audio wrapper 没有 bytes loader。

#### C. KV sound toggle

```text
kv.get("attention_sound_enabled") === undefined -> 默认播放
kv.set("attention_sound_enabled", false) -> 后续 sound 不 load/play
kv.set("attention_sound_enabled", true) -> 恢复播放
notification 不随 sound toggle 关闭
```

当前失败，因为 host 不读 `attention_sound_enabled`。

#### D. cache

```text
同一 embedded done 连续两次 -> bytes factory 只调用一次，play 两次
```

保证 Base64 不重复 decode。

### 5.2 保持既有绿测

所有现有 attention/notifications/config 测试不得删除或放宽。

## 6. 正常路径

```text
TUI 启动
  -> TuiConfig attention.enabled=true
  -> KV attention_sound_enabled 缺失 -> 默认 true

Agent loop busy/retry -> idle
  -> notifications 请求 sound name=done
  -> attention 检查 master enabled + KV sound enabled
  -> embedded ChatGPT WAV bytes
  -> TuiAudio 按 key 首次 Base64 decode + native decode
  -> Audio.start 系统默认设备
  -> volume=0.4 播放约 0.584s

第二次 completion 命中 Promise cache
```

## 7. 错误路径

| 失败 | 处理 |
| --- | --- |
| Base64 decode throw | attention catch，debug log，sound=false |
| native WAV decode 返回 null | 无 fallback candidate，sound=false |
| output device 不存在 | `Audio.start()` false，sound=false |
| KV 未 ready | `kv?.get(..., true) ?? true`，默认播放 |

不阻塞 toast，不重试，不影响 Agent outcome。

## 8. 并发、退出与清理

- 同一 embedded key 的并发 load 共享 Promise cache。
- 多 TUI 进程各有独立 Audio engine；KV 文件写入受现有 Flock 保护。一个进程的 toggle 不实时广播给另一个进程；下次启动读取新值。这是现有 KV 语义，不在本次扩展。
- 现有 `onBeforeExit` 顺序不变：dispose plugins → dispose attention → `TuiAudio.dispose()`。
- 不创建 temp WAV，没有 unlink。

## 9. 安全边界

1. Base64 是 build-time trusted static bytes，不接受用户输入。
2. 不执行 shell，不拼命令。
3. 不写共享 `/tmp`。
4. sound failure 不进入 Session error bus。
5. `attention.enabled=false` 优先于 KV sound toggle。

## 10. 中文注释计划

预计手写有效改动约 60-80 行，至少新增 12-16 行分布式中文注释：

1. `attention.ts`：解释内嵌 bytes 而非 temp materialization 的安全/单文件原因。
2. `attention.ts`：解释 KV sound gate 默认 true 的语义。
3. `util/audio.ts`：解释 cache check 必须早于 bytes factory。
4. `app.tsx`：解释 command 与 animations 同模式。
5. `config/tui.ts`：解释默认 true 落实 v2 目标。
6. tests：在 asset hash、KV toggle、cache 断言附近解释回归边界。

## 11. 建议验证命令

```bash
cd packages/opencode
bun test test/cli/cmd/tui/attention.test.ts
bun test test/config/tui.test.ts
bun typecheck
bun run script/build.ts --single --skip-embed-web-ui
```

人工验证：

1. 默认首次启动有 completion sound。
2. Ctrl+P → Disable sound effects 后静音。
3. Ctrl+P → Enable sound effects 后恢复。
4. restart 后保持选择。
5. abort 不响。

## 12. 文件级实施清单

| # | 文件 | 具体改动 | 预估增删 |
| ---: | --- | --- | ---: |
| 1 | `src/cli/cmd/tui/util/audio.ts` | keyed bytes loader；file loader 复用 | +10~-4 |
| 2 | `src/cli/cmd/tui/attention.ts` | private embedded payload、done 改 bytes source、KV sound gate | +28~-6 |
| 3 | `src/cli/cmd/tui/app.tsx` | `app.toggle.sound_effects` command | +8 |
| 4 | `src/cli/cmd/tui/config/tui.ts` | enabled 默认 true | +1~-1 |
| 5 | `test/cli/cmd/tui/attention.test.ts` | embedded hash、KV toggle、cache 行为测试 | +45~60 |
| 6 | `test/config/tui.test.ts` | 默认 true | +2~-1 |
| 7 | `specs/tui-plugins.md` | 默认 true 说明 | +1~-1 |

```text
文件数：7
净增：约 95-117 行（含 1 行超长 Base64 数据行）
```

不涉及：KV provider 改动、exit 改动、依赖、DB migration、SDK generation、public plugin type、Session/Runner、新配置 schema、新 keybind。

## 13. 不采用的方案

1. 不新增 Session settlement / generation event / lifecycle state machine。
2. 不改 KV provider 的写入方式（全量 snapshot 对存一个 boolean 完全够用）。
3. 不加 exit flush barrier。
4. 不搞 notification default compat 矩阵。
5. 不导出 `createSoundEffectsCommand` internal helper — command 直接内联在 `appCommands`。
6. 不使用 `afplay`/`paplay`/PowerShell/外部进程。
7. 不 materialize temp WAV。
8. 不改 Web/Desktop 音效。

## 14. 实施顺序（TDD）

```text
1. 修改 config test：默认 true，确认红
2. 扩展 attention fake + 写 embedded hash/KV toggle/cache tests，确认红
3. 加 TuiAudio keyed bytes loader
4. 修改 attention private embedded done + KV sound gate
5. 加 app Ctrl+P palette command
6. 更新 TUI spec
7. 跑 targeted tests + typecheck
8. 跑 single compile/build smoke
9. 人工验证
10. 统计 15% 中文注释
11. 独立 implementation review
```

## 15. 方案审计记录

1. 第 1 轮：因新增 Session settlement/generation seam 过大而否决。
2. 第 2 轮：阻塞项为默认连带开启 OS notifications、KV override 越过显式配置、command/persistence 未自动化。
3. 第 3 轮：阻塞项为 KV flush 不可行、corrupt JSON 未覆盖、test keymap 缺 enabled-fields addon、覆盖面不足。
4. 第 4 轮：回退到甜点级。不改 KV provider、不加 flush、不搞 compat 矩阵、不导出 command helper。KV toggle 与 animations 完全同模式。只有本轮完整独立复核无阻塞意见后才可放行。
