# Canonical Implementation Plan: OpenTUI ALSA 静默与音频设备空闲释放

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL 参数原文(见 §1)+ 用户在会话中的设计确认与追加约束
>
> Implementation allowed: yes
>
> Last updated: 2026-09-01

本文是本任务唯一的 implementation authority。聊天摘要与本文件冲突时以本文件为准。

R1→R2 修订:按独立审计 round 1 blockers 修订——B-01(看护守卫状态选错,改为 `mixerStarted`,即 `stop()` 实际转迁的闸门状态);B-02(补全 release lockstep chore:9 个 `@opentui/*` package.json + submodule bun.lock,诚实重算 INV-06 口径并新增 OD-2 交用户裁决);同时吸收 N-01(harness FFI 生命周期与 §8 实录引用)、N-02(文件清单补 submodule bun.lock)、N-03(§6 行 2 改为修复后事实)、N-04(切片编号统一)。

## 1. Verbatim Requirement

GOAL 参数原文:

> "当前我们需要解决 SSH 之后无声卡环境,或者说任何无声卡环境的 ALSA 刷屏报错问题。整体希望保持较好的兼容性,且避免进行按照探测机制来解决问题。整体希望以甜点级别进行修改,使得不仅 ALSA 不再会发生类似的报错刷屏问题,同时 Open Code 在静默期也不会长期持有音频输出接口,使得音频设备无法释放的问题。同时保持较好的性能兼容性等内容,代码整体保持清爽,保持鲁棒性。整体修改代码,生产文件数不超过六个,修改生产代码行数不超过六百行。同时需要确保整体不会引入红测或者产生音频等方面的红测,同时opentui也不会出现红测"

会话中的用户设计约束(逐条引用):

> "如果你想进行相应的 OpenTUI 的一个修改,你能够比如说在生产代码800行以内,完整完成相应修改,同时解决在静默期的不正常占用问题吗?……我当前也觉得 OpenTUI 的修改是可以被允许的"

> "按照我的理解,整体的这个音频应当保持一种特性,就是在发出一次声音之后,理论上来说,它这个音频的这个输出就应该去终止掉了,而不是一直占用这个音频输出设备"(蓝牙 multipoint 场景)

> "刚刚你那个设计我同意了,你可以继续完整检查检查看看是否有其他遗漏问题或者潜在兼容问题,然后完整按照工作流进行"

已确认的设计(用户同意版):OpenTUI 层修复 ALSA 诊断刷屏(native 静默)+ 音频设备空闲释放(JIT 会话);失败保持无状态(无探测、无闭锁);不新增用户配置;音效默认保持开启。

## 2. Explicit Non-Goals

- 不修改 `src/zig/audio.zig` 或任何 Zig 源(修复完全落在 `miniaudio_shim.c` 与 TS 层)。
- 不新增配置项、环境变量或 per-machine 用户配置(`.asoundrc`、`ALSA_CONFIG_PATH` 等均为用户明确拒绝项)。
- 不实现设备热插拔监听(udev/inotify);不实现设备运行时错误上报(stopCallback 转发)——用户已确认 3s 自愈语义可接受。
- 不改变 OpenTUI `Audio` 的默认行为(`idleReleaseMs` 为 opt-in,examples 等其他消费者不受影响)。
- 不更新 `script/upgrade-opentui.ts` 的历史版本守卫(维护命令与本次无关)。
- 不处理 PULSE_SERVER 远程音频转发;不引入 miniaudio 上游改动(不 fork vendored miniaudio.h)。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `.opencode/policy/first-principles-engineering.md` | 修复 first divergence;单一 primary path;禁止探测式 fallback;双向 traceability;中文注释 ≥15% 门禁。 |
| `.opencode/templates/canonical-plan.md` | 本文件结构来源。 |
| `CONTEXT.md` | TUI 位于 `packages/opencode/src/cli/cmd/tui/`;无音频词条,本任务不新增域概念。 |
| `thirdparty/opentui/AGENTS.md` | Bun 优先;改原生代码必须 build;测试从 package 目录运行;可移植 FFI 规则(临时 JS 内存参数直接传 view,不得预解析裸指针)。 |
| `packages/opencode/AGENTS.md` | typecheck 用 `bun typecheck`;测试从 package 目录运行。 |
| `script/upgrade-opentui.ts` | 依赖契约:parent 只消费 SMARK2022/opentui 的 GitHub release tarball,拒绝非 release URL 进 lockfile。 |
| `thirdparty/opentui/.github/workflows/release.yml:43-71` | 发布契约:push tag → lockstep 校验(所有 `packages/*/package.json` 中 `@opentui/*` 版本必须等于 tag 版本)→ CI 构建全平台 tarball。 |
| smark.8 发布先例(submodule commit aa57e8a4) | lockstep chore 实证:9 个 package.json 版本行 + submodule bun.lock。 |
| `thirdparty/opentui/packages/core/scripts/build.ts` | 原生构建:zig 交叉编译 8 个 variant(`-Dall`),产物拷入 `packages/core/node_modules/@opentui/core-<platform>`。 |
| `thirdparty/opentui/packages/core/src/zig/build.zig.zon` | `minimum_zig_version = 0.15.2`;本机 winget zig 恰为 0.15.2。 |
| `docs/plans/opentui-streaming-markdown-performance-repair.md` | 本仓库 opentui 修改的既有 canonical plan 先例(格式与验证风格)。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/util/audio.ts` | TUI 音频单例:`getAudio()` 惰性创建;`play()` 每次事件重试 `start()`;仅 `dispose()` 于 app 退出释放。 | observed |
| `packages/opencode/src/cli/cmd/tui/attention.ts:166-192` | `playSound` 唯一播放入口;失败返回 false(debug 日志);`createTuiAttention` 接受可注入 `audio` seam。 | observed |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/notifications.ts` | 事件→音效映射(done/question/permission/error)。 | observed |
| `thirdparty/opentui/packages/core/src/audio.ts` | TS 包装:`start()`(121-148)同时置 `playbackStarted`+`mixerStarted`;`startMixer()`(151-166)仅置 `mixerStarted`;`stop()`(168-184)以 `mixerStarted` 为闸门并同时清两态;`getStats().voicesActive` 可观测;`create` 以 noDevice engine 常驻,设备惰性。 | observed |
| `thirdparty/opentui/packages/core/src/zig/audio.zig` | `ensureContextInitialized`(258-267)是所有 ALSA 交互的唯一闸口;`start()`(630)打开设备;`stop()`(703-710)`ma_device_stop+ma_device_uninit` 完整释放;`create()`(527-550)noDevice engine;zig `play` 不要求设备(803-842),mixer-only 会话 `playbackStarted=false`。 | observed |
| `thirdparty/opentui/packages/core/src/zig/miniaudio_shim.c` | miniaudio 编入点:`#define MINIAUDIO_IMPLEMENTATION` + 平台后端宏(linux: ALSA+PULSEAUDIO)。 | observed |
| `thirdparty/opentui/packages/core/src/zig/build.zig:137-198` | shim 编入与平台链接:linux 链接 `dl`+`pthread`;macOS 独占 `MA_NO_RUNTIME_LINKING`。 | observed |
| vendored `miniaudio.h:28548-28555` | miniaudio 运行时 `dlopen("libasound.so.2"/"libasound.so")`;符号表不含 `snd_lib_error_set_handler`。 | observed |
| vendored `miniaudio.h` ALSA default 设备打开路径 | `default → dmix → dmix:0 → dmix:0,0 → hw → hw:0 → hw:0,0` 依次 `snd_pcm_open`,无声卡时每次失败均触发 libasound 诊断。 | contracted(上游源码) |
| 用户 HPC 节点自查(hkust-superpod-01) | `/proc/asound` 不存在、无 snd 模块、无 PCI 音频、无 pulse;libasound.so.2 已装、`/usr/share/alsa/alsa.conf` 存在;opencode 进程 maps libasound。 | observed(用户提供) |
| 用户终端贴图 | 完整 snd_func 链刷屏原文(`snd_func_card_inum/concat/refer`、`Unknown PCM default/dmix`、`cannot find card '0'`)。 | observed(用户提供) |
| `.temp/testing/alsa-stderr-loop/`(本次建立) | 确定性 red 反馈环:WSL 无声卡 + libasound,加载 libopentui 后 FFI 直调 `snd_pcm_open("default")`。实测 `stderr_bytes=63 > 0`。 | observed |
| ChatGPT 带源引用调研(会话记录) | `snd_lib_error_set_handler` 为官方 canonical 静默法(alsamixer/CRAS/PulseAudio 先例);handler 可在任意线程被调,须为纯 native no-op 且永不卸载(PortAudio segfault 教训);`ALSA_CONFIG_PATH=/dev/null` 会破坏真实路由(拒绝);idle-release 先例(WirePlumber 5s suspend、Chromium ~35s 静默暂停、AliExpress multipoint 占用案例);miniaudio 无任何抑制选项。 | contracted(外部源码/文档) |
| `packages/opencode/test/cli/cmd/tui/attention.test.ts` | attention 测试全部经 `FakeAudioEngine` 注入,不触 @opentui/core——opencode 侧无音频测试红测面。 | observed |
| `thirdparty/opentui/packages/core/src/tests/audio.test.ts` | 既有 mixer-only(`startMixer()+mixFrames()`)免设备测试模式,headless 可跑;`instances` 清理约定。 | observed |
| `package.json`(root)catalog + overrides | `@opentui/*` 全部强制指向 `v0.4.3-smark.8` release tarball;`thirdparty/opentui` 非 workspace。 | observed |
| `packages/plugin/package.json` | `>=0.4.3-smark.1` range,无需变更。 | observed |
| WSL Ubuntu-22.04 环境 | libasound 存在、`/proc/asound` 不存在;WSLg 提供 pulse(miniaudio PA 后端可成功,`start=true`)——故 red 环必须直驱 ALSA;WSL bun 1.3.13 对 dlopen 符号参数编组有缺陷(名称乱码/返回 undefined),见 §8。 | observed |

## 5. Current Behavior

```text
TUI attention 事件(done/question/permission/error)
  -> attention.ts playSound -> TuiAudio.play (util/audio.ts:46-51)
  -> Audio.start() 惰性打开设备:
       ma_context_init  → dlopen libasound(PA 缺席时)
       ma_device_init   → snd_pcm_open 7 连试(default→dmix→…→hw:0,0)
       无声卡 → libasound 默认 error handler 逐条写 stderr(用户刷屏)
  -> 失败:playbackStarted 仍 false,下次事件整链重试(无状态,但每次重复刷屏)
  -> 成功:设备进程级持有直至 app 退出 dispose(静默期锁死音频端点)
```

关键事实:

- 应用层失败路径本身已静默(`playSound` 返回 false + debug 日志);噪声全部来自 libasound C 层默认 handler 直写 fd 2,任何 JS try/catch 拦不住。
- `Audio.stop()` 是完整释放(`ma_device_uninit`,audio.zig:703-710),其 TS 闸门是 `mixerStarted`(audio.ts:169)且同时清两态;音效缓存挂在 noDevice 常驻 engine 上,跨释放存活——释放后重开仅需毫秒级 `ma_device_init`。
- mixer-only 会话(`startMixer()`,`playbackStarted=false`)是唯一可在无声卡环境确定性驱动的测试 seam(既有测试同模式)。
- opencode `attention.test.ts` 用 `FakeAudioEngine` 注入;`TuiAudio` 真实模块仅生产路径使用。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 无声卡 + libasound 存在(SSH HPC/容器) | attention 事件→playSound→start | 无(正是缺陷) | 用户 HPC 实测 + WSL red 环 | shim/native 边界 | observed |
| 桌面 PulseAudio/PipeWire | 同上 | miniaudio 出声不经 libasound;修复后 shim constructor 仍会 dlopen libasound 装载 handler(静默、零输出;库缺席则静默跳过) | 本机与主流桌面 | miniaudio 既有顺序 + shim | observed |
| 纯 ALSA 桌面(有声卡) | 同上 | default 解析成功 | ALSA-only 发行版 | miniaudio | reachable |
| 蓝牙 multipoint 耳机静默期被占 | 设备进程级持有 | 无释放路径(缺陷) | 用户陈述 + AliExpress 同构案例 | Audio 生命周期 | observed |
| USB DAC 播放中途插入 | 下次 playSound 事件 | 无状态重试天然支持 | 用户陈述 | 既有 play() 语义 | contracted(保持) |
| musl/Alpine | dlopen 解析 libasound | musl 有 dlfcn | linux-*-musl variant 构建 | shim(同一 `#ifdef __linux__`) | reachable |
| Windows/macOS | — | shim 代码 `#ifdef` 排除 | 本机构建 | — | observed(不受影响) |
| OpenTUI Audio 其他消费者(examples) | — | `idleReleaseMs` opt-in 缺省不变 | examples/native-audio-demo 不传该参 | — | contracted |
| mixer-only 会话(visualization 混音,无设备) | core 自身测试/benchmark 模式(无 example opt-in) | 释放语义 = 停 mixer;下次 `startMixer()` 重建 | 既有测试 seam | Audio 类 | contracted(opt-in 契约) |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 无声卡 + libasound 环境下,opencode/OpenTUI 音频路径引发的任何设备获取尝试,不得向 stderr 写入 libasound 诊断 | 用户 HPC 贴图;WSL red 环 63 字节 | 无(本任务建立 red/green 环) |
| INV-02 | 音频输出通道(设备/mixer)仅在活跃播放(+固定宽限)期间被持有;静默归零后必须完整释放(`stop()` 级,含 `ma_device_uninit`) | 用户 multipoint 陈述;WirePlumber/Chromium 先例 | 无(本任务新增) |
| INV-03 | 有声卡机器音效行为不降级:默认开启、正常发声、缓存复用 | 用户"默认关掉不正确" | attention.test.ts(FakeAudioEngine)+ 本任务新增 |
| INV-04 | 设备获取失败必须保持无状态、无探测、无闭锁;后续事件自然重试(热插拔下一次事件生效) | 用户明确否决探测/闭锁 | 既有 play() 语义,保持 |
| INV-05 | 不引入 opencode / opentui 红测 | GOAL 原文 | 既有全套测试 |
| INV-06 | 生产文件 ≤6、生产代码 ≤600 行 | GOAL 原文 | 本计划 §15/§19 预算与 OD-2 裁决 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | miniaudio 经 shim 编入时,无人接管 libasound 诊断通道;`ma_device_init` 的 `snd_pcm_open` 失败路径上,libasound 默认 handler 直写 stderr | `miniaudio_shim.c`(本 lib 唯一的 ALSA 编译边界;先于一切 asound 调用) | miniaudio.h 符号表无 handler API;用户贴图;WSL red 环 |
| INV-02 | `Audio.start()` 成功后无任何释放路径(`playbackStarted`/`mixerStarted` 永真,类内无 stop 调用点);唯一释放是消费者显式 `stop()`,而 opencode 仅在退出时 dispose | `thirdparty/opentui/packages/core/src/audio.ts` 的 Audio 设备生命周期 | audio.ts 全文;util/audio.ts 仅 dispose 调用 |

下游症状(非根因):每事件重复刷屏(start 失败无缓存的放大效应)、multipoint 占用、`Unknown PCM dmix` 等具体行。

**Red-capable feedback loop(已实际运行,2026-09-01)**:

```text
命令:wsl -d Ubuntu-22.04 -- bash /mnt/f/<repo>/.temp/testing/alsa-stderr-loop/run.sh
观察(修复前):exit=0 stderr_bytes=63,err.txt 实际内容(逐字):
  ALSA lib pcm.c:2664:(snd_pcm_open_noupdate) Unknown PCM `<garbage>'\x7f
绿色判据:stderr_bytes == 0
```

实录说明:名称乱码与 `rc=undefined` 系 WSL bun 1.3.13 对 dlopen 符号的参数/返回编组缺陷(已排除指针生命周期:view 直传、CString 稳定原生内存两种方式结果相同);字节计数谓词不受影响且确定(磁盘 artifact 63B;多次运行输出一致属 transcipt 观察,非磁盘证据)。机制等价性:环中 FFI 直调 `snd_pcm_open` 与 miniaudio `ma_device_init` 触发同一 libasound 诊断机制(默认 handler→stderr);完整 snd_func 链以用户 HPC 贴图为 observed 证据;handler 装载后对该通道全部输出一致静默。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| libasound 诊断通道静默 | `miniaudio_shim.c` | 本 native lib 内一切 ALSA 交互的编译边界 | constructor 在 `.so` 装载时装载 handler,严格先于 miniaudio 首次 asound 调用;C no-op 满足任意线程并发契约 | miniaudio vendored 头不改(non-goal);Zig 层不触(non-goal);应用层 JS 拦不住 C 层 stderr |
| 输出通道生命周期(获取→宽限→释放) | OpenTUI `Audio` 类 | 设备与 mixer 获取/释放的单一权威路径 | `playbackStarted`/`mixerStarted` 是 Audio 类私有状态;`stop()` 已是完整释放且以 `mixerStarted` 为闸门 | 消费者各自实现会重复且漂移;examples 已有多个消费者 |
| 宽限值(3000ms)与启用决策 | opencode TUI `util/audio.ts` | 产品参数,不改库默认 | opt-in 契约下,何时释放属应用策略 | 库默认变更影响全部消费者(non-goal) |
| 失败语义(无状态 false) | 既有 `play()/playSound` 路径 | 不变 | INV-04 要求 | 本任务不引入新失败路径 |
| 发布版本闭包(lockstep) | submodule 发布 chore(release.yml 契约) | 全部 `@opentui/*` 版本与 tag 一致 | CI lockstep 校验强制 | 单包 bump 无法过 CI(B-02 实证) |

## 10. Single Approved Primary-Path Design

### 10.1 组件 A:`miniaudio_shim.c` ALSA 静默 constructor(Linux-only,~35 行)

```c
#if defined(__linux__)
#include <dlfcn.h>
typedef void (*snd_error_handler_t)(const char*, int, const char*, int, const char*, ...);
// 纯 no-op:C ABI 允许被调方忽略可变参数;任意线程可并发调用;永不卸载(代码随本 .so 存续)
static void opentui_asound_silence(const char *file, int line, const char *func, int err, const char *fmt, ...) { (void)file; (void)line; (void)func; (void)err; (void)fmt; }
__attribute__((constructor)) static void opentui_install_asound_silence(void) {
    // dlopen 而非链接:构建不引入 libasound 依赖;句柄永不 close,保证 handler 所在的
    // libasound 全局实例不被卸载后由 miniaudio 重新 dlopen 出带默认 handler 的新实例
    void *h = dlopen("libasound.so.2", RTLD_LAZY);
    if (!h) h = dlopen("libasound.so", RTLD_LAZY);
    if (!h) return; // 无 libasound 则无诊断可静默
    snd_error_handler_t set = (snd_error_handler_t)dlsym(h, "snd_lib_error_set_handler");
    if (set) set(&opentui_asound_silence);
}
#endif
```

修复第一分歧的方式:`.so` 装载点严格早于 `ensureContextInitialized → ma_context_init`(audio.zig:261)的首次 asound 触碰;同进程 miniaudio 后续 `dlopen` 同一 libasound(refcount)共享已装 handler。

### 10.2 组件 B:`Audio.idleReleaseMs` opt-in 空闲释放(~75 行 TS)

- `AudioSetupOptions` 增 `idleReleaseMs?: number`(缺省 = 现状,INV-03:examples 不变)。
- `play()` 成功且 `!options?.loop` 时排程看护:setInterval 250ms tick;tick 内:
  - `!mixerStarted` → 清理看护(**外部已 stop/dispose**——`stop()` 的闸门即 `mixerStarted`,audio.ts:169,被 stop/dispose 清除;play 不设它之外的路径,无误报)。守卫选 `mixerStarted` 而非 `playbackStarted` 的原因:release 动作 `this.stop()` 实际转迁的状态是 `mixerStarted`,且 mixer-only 会话(`startMixer()` 模式,`playbackStarted=false`)是唯一 headless 可确定性驱动的验证 seam——若守卫选 `playbackStarted`,mixer-only 会话首 tick 即自毁看护,INV-02 的行为切片永不绿(R1 审计 B-01);
  - `getStats().voicesActive > 0` → 重置归零锚点(连续提示音自然合并宽限);
  - 归零持续 ≥ `idleReleaseMs` → 清理看护并 `this.stop()`(完整释放:device 会话含 `ma_device_uninit`,mixer-only 会话释放 mixer;发出既有 `stopped` 事件)。
- `stop()`/`dispose()` 清理看护定时器;`loop: true` 不排程(循环音不存在"完成"语义,supported-domain 分支)。
- 释放后音效缓存存活(noDevice engine 常驻),下次 `play()` 经既有 `start()`/`startMixer()` 路径毫秒级重开——无句柄复用,无闭锁,无探测。mixer-only 消费者 opt-in 后获得 mixer 空闲释放(契约即"释放本次会话占用的输出通道"),下次 `startMixer()` 重建——与 opencode device 会话语义一致。

### 10.3 组件 C:opencode 接线(1 行 + 注释)

`util/audio.ts:12` → `Audio.create({ autoStart: false, idleReleaseMs: 3000 })`(宽限值对齐 WirePlumber idle-suspend 惯例)。

### 10.4 发布与依赖升级(lockstep 契约)

1. submodule 内 lockstep chore:9 个 `packages/*/package.json`(`@opentui/*`)版本 `0.4.3-smark.8` → `0.4.3-smark.9` + `thirdparty/opentui/bun.lock` 刷新(release.yml:59-67 lockstep 校验强制;smark.8 先例 aa57e8a4 同 chore 集)。
2. push tag `v0.4.3-smark.9` → release.yml CI 构建并发布全平台 tarball(外部动作,见 OD-1)。
3. parent root `package.json` catalog(3 项)+ overrides(11 URL)→ smark.9;repo root `bun install` 刷 `bun.lock`。

为何此路径修复第一分歧且无 fallback:两处修改各自落在唯一 owner 的第一分歧点;失败路径语义不变(无新增 alternate success);静默是"诊断通道重定向"而非吞错(设备获取失败仍如实返回 false/debug 日志)。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| shim:dlopen 失败→跳过安装 | proposed | primary-contract branch(无 libasound 则无诊断可静默) | no | ~2 分支/0% 诊断面 | preserve |
| shim:`snd_lib_error_set_handler` dlsym 失败→跳过 | proposed | primary-contract branch(极旧库无该符号) | no | 同上 | preserve |
| watcher:`!mixerStarted`→清理自身 | proposed | primary-contract branch(stop() 闸门状态) | no | 1 分支 | preserve |
| watcher:`voicesActive>0`→重置锚点 | proposed | primary-contract 分支(活跃定义) | no | 1 分支 | preserve |
| watcher:`loop:true`→不排程 | proposed | supported-domain branch | no | 1 分支 | preserve |
| play 失败返回 false → notify skipped | 既有 | diagnostic(接口既有契约) | no | 既有 | preserve |
| dup2 fd-2 影子窗口 / bun:ffi JSCallback 装 handler | rejected 候选 | — | — | — | reject(实验性 FFI 回调风险;覆盖面窄) |
| ~/.asoundrc null 设备 / ALSA_CONFIG_PATH | rejected 候选(per-machine 配置,破坏真实路由) | — | — | — | reject |

新增 alternate success path 数:0。诊断面占比:0%(无新增诊断输出)。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 无(修复前不存在任何 ALSA 噪声处理或设备释放机制) | — | — | — |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | shim constructor 装 no-op handler | `miniaudio_shim.c` | S1:WSL red/green 环 63B→0B(§8) |
| INV-02 | `idleReleaseMs` 看护→`stop()` 完整释放(守卫 `mixerStarted`) | `core/src/audio.ts` | S2 归零释放(mixer-only seam)、S3 宽限合并、S4 loop 不释放、S5 释放后复播 |
| INV-03 | opt-in 不改默认;缓存跨释放存活 | `audio.ts` | S5(soundsLoaded 不减)+ 既有 test:js 全绿 |
| INV-04 | play 失败语义零改动(无状态) | 不改 `util/audio.ts` play() | S6 既有套件回归 |
| INV-05 | 不触红测面 | — | S6:§18 全套命令 |
| INV-06 | 预算内(口径见 OD-2) | §15/§19 | 审计核对 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| shim constructor + dlopen/dlsym 安装 handler | INV-01 | ALSA 官方 API;alsamixer/CRAS 先例;PortAudio 教训(永不卸载) | miniaudio 符号表无该 API;应用层无法拦 C 层 stderr |
| no-op handler 变参签名定义(与 `snd_error_handler_t` 精确一致,忽略实参) | INV-01 | C ABI 被调方忽略实参为标准做法;§10.1 代码为准 | —(实现细节,归组件 A) |
| `idleReleaseMs` opt-in 选项 | INV-02/INV-03 | examples 多消费者存在;库默认变更违反 non-goal | Audio 类无任何释放路径 |
| 250ms tick 看护 + 归零锚点 | INV-02 | `getStats().voicesActive` 是既有可观测信号;连续音合并需锚点重置 | 无事件式 voice-end 回调可用(AudioEvents 无此事件) |
| 守卫取 `mixerStarted` 而非 `playbackStarted` | INV-02 | `stop()` 闸门即 `mixerStarted`(audio.ts:169);mixer-only 是唯一 headless 验证 seam(R1 B-01) | `playbackStarted` 守卫使 mixer-only 会话看护自毁 |
| `loop:true` 不排程 | INV-02 | 循环音无完成语义(仓库内无使用方,防御性输入域分支) | — |
| `idleReleaseMs: 3000`(opencode) | INV-02 | WirePlumber 5s idle suspend 惯例;毫秒级重开代价 | — |
| lockstep 发布 chore(9 manifest + submodule lock) | INV-05 | release.yml:59-67 校验强制;aa57e8a4 先例 | 单包 bump 无法过 CI |
| parent catalog/overrides 升级 smark.9 | INV-05 | parent 只认 release tarball(upgrade-opentui 契约) | node_modules 无法指向未发布版本 |

## 15. File-Level Change Plan

修复承载文件(承载行为逻辑):

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `thirdparty/opentui/packages/core/src/zig/miniaudio_shim.c` | modify | Linux constructor 安装 libasound no-op 诊断 handler | +~35 |
| `thirdparty/opentui/packages/core/src/audio.ts` | modify | `idleReleaseMs` opt-in 看护与完整释放 | +~75 |
| `packages/opencode/src/cli/cmd/tui/util/audio.ts` | modify | 传入 `idleReleaseMs: 3000` | +2 |

发布 chore 文件(机械版本字符串/generated,零行为逻辑;release 契约强制):

| File | Add / modify / delete | Exact responsibility | Expected line delta |
| --- | --- | --- | --- |
| `thirdparty/opentui/packages/{core,examples,keymap,qrcode,react,solid,ssh,three,web}/package.json`(9 个) | modify | version → `0.4.3-smark.9`(lockstep 校验要求) | 各 1 行版本字符串 |
| `thirdparty/opentui/bun.lock` | modify(generated) | submodule lock 刷新 | generated,不计 |
| `package.json`(root) | modify | catalog 3 项 + overrides 11 URL → smark.9 | 14(配置行) |
| `bun.lock`(root) | modify(generated) | 依赖刷新 | generated,不计 |

测试文件:`thirdparty/opentui/packages/core/src/tests/audio.test.ts` +~110 行(S2-S5 行为切片)。

文件数口径:修复承载 3 ≤ 6;含发布 chore 为 12(9 manifest + 2 lock + root package.json)——**两种口径与用户"生产文件数不超过六个"预算的关系见 OD-2,须用户裁决后方可实施 §10.4**。生产代码行 ~112(35+75+2)≤ 600 ✓。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| S1(WSL) | red 环 `stderr_bytes=63>0`(已实测) | 无 handler 接管 | shim constructor 装载后 `stderr_bytes==0` | INV-01 |
| S2 | `Audio.create({autoStart:false, idleReleaseMs:80}) + startMixer + play(非循环短音)`;mixFrames 推进至 voicesActive=0 后等待 ≥ 宽限 → `isMixerStarted()===false` | 选项不存在;startMixer 后无释放路径 | 看护触发 `stop()` 完整释放(mixer-only seam 可绿——守卫为 `mixerStarted`) | INV-02 |
| S3 | 宽限期内再次 play(新短音)→ 释放时刻从新音归零起算 | (同上) | 锚点重置;不提前释放 | INV-02/03 |
| S4 | `play(sound,{loop:true})` → 宽限后仍 started | (同上) | loop 不排程看护 | INV-02 输入域 |
| S5 | 释放后重新 `startMixer()+play` → 出声且 `soundsLoaded` 不减 | (同上) | 缓存存活,重开即用 | INV-03 |
| S6 | 既有 `test:js` / `test:native` / opencode attention 套件全绿 | — | — | INV-04/05 |

测试只观察公共行为(`isMixerStarted/getStats/mixFrames`),不触私有字段;期望值独立(宽限时间参数化)。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~112(shim 35 + audio.ts 75 + util/audio.ts 2) | 排除 import/空行/纯配置/generated/机械版本行 |
| Required Chinese explanatory comments `C` | `C >= max(1, ceil(112*0.15)) = 17` | 计邻近注释行 |

注释点清单:shim(为何 dlopen 而非链接、constructor 时机保证、no-op 的 ABI/线程契约、句柄永不 close 的原因)4-5 条;audio.ts(opt-in 契约、tick 语义、锚点重置、`mixerStarted` 守卫选择原因即 stop() 闸门、loop 分支、stop/dispose 清理、250ms 常量)6-7 条;util/audio.ts(3000ms 对齐惯例 + 释放契约)1-2 条;测试意图注释 5-6 条。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun run test:js` | `thirdparty/opentui/packages/core` | S2-S5 绿 + 既有音频测试回归 |
| `bun run test:native` | 同上(zig 0.15.2) | Zig 层无红测(shim 编入不破坏构建) |
| `bun run build`(opentui root) | `thirdparty/opentui` | 全平台交叉编译过,产出含修复的 linux-x64 `.so` |
| `wsl -d Ubuntu-22.04 -- bash …/run.sh`(修复后,新 .so 临时拷至 `node_modules/@opentui/core-linux-x64/`,验后还原) | WSL | S1 绿:stderr_bytes==0 |
| `bun typecheck` | `packages/opencode`(tag 已发布且依赖升级后) | opencode 类型绿 |
| `bun test test/cli/cmd/tui/attention.test.ts` | `packages/opencode` | S6:attention 回归绿 |
| `bun install` | repo root(tag 已发布后) | lock 刷新且指向已发布 smark.9 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0(生产) | 修复内聚于既有文件 |
| Files modified(修复承载) | 3 生产 + 1 测试 | §15 |
| Files modified(发布 chore) | 9 manifest + 2 lock(generated)+ root package.json | release lockstep 契约强制;口径裁决见 OD-2 |
| Files deleted | 0 | — |
| Production lines | ~112(35+75+2,机械版本/配置/generated 行不计) | ≤600 ✓ |
| Test lines | ~110 | S2-S5 |
| Generated lines | 2 个 bun.lock 刷新 | 不计 |

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

**OD-1 发布时序(用户裁决,2026-09-01)**:原 A/B 两案均未直接采纳;用户追加前置门后再定:
> "你需要先验证相关ci看看能不能在本地顺利跑通,譬如部分测试等等内容,因为之前经常出现opentui的ci红色问题,你可以检查看看之前的github上红测的历史看看问题频发在哪然后验证本地"
即:先调查 SMARK2022/opentui 的 CI 红测历史(定位频发点)→ 本地跑通相关 CI 等价命令(以当前树为绿基线)→ 再决定发布时序(A/B)。发布 push 仍属用户门禁。

**OD-2 "生产文件数不超过六"口径(用户裁决,2026-09-01)**:按 (a) 执行——生产文件仅计承载修复逻辑的文件(3 个:shim.c、audio.ts、util/audio.ts,≤ 6 合规);lockstep 发布 chore(9 个版本字符串 manifest + 2 个 generated lockfile + root package.json)不计入。§10.4 实施解除该门。

### Real Risks

| Risk | Evidence | Mitigation |
| --- | --- | --- |
| WSL 验证需将新 .so 临时拷入 node_modules(验后还原) | parent 只消费 tarball | 验证脚本内固定拷贝/还原;不进 commit |
| `zig build -Dall` 在 Windows 需 macOS SDK(darwin variant) | build.ts Skipping 逻辑 | darwin 可跳过;linux/win variant 必须过 |
| red 环单行乱码输出 vs 用户完整链 | WSL 实测(bun 1.3.13 FFI 编组缺陷,§8) | 字节计数谓词确定(63B 三次复现);用户贴图为完整链 observed 证据;handler 装载对通道全部输出生效 |

### Rejected Speculation

- alsa-lib 1.2.15 新 `snd_lib_log_set_handler` 优先(未普及;dlsym 双路径增加面)。
- udev/热插拔监听、设备 stopCallback 即时上报(用户接受 3s 自愈)。
- timer `unref()`(ScrollBar 先例不 unref;看护仅在播放+宽限窗内存活,自清)。
- 为 examples 演示 idleRelease(scope creep)。

## 21. Audit Contract

独立审计必须:读本文件与原始需求;从仓库证据重建行为;视 builder 自述为不可信;每轮全量审计原 scope;每个 blocking finding 附证据;同时查 under-design 与 over-design;查根因修复、fallback、ownership、测试、代码质量与 15% 中文注释计划。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01(看护守卫 `playbackStarted` 使 mixer-only 切片 S2 永不绿;已修订 §10.2 守卫为 `mixerStarted`)、B-02(§15/§18 未含 release lockstep chore,route 不可行;已修订 §10.4/§15 并新增 OD-2) | N-01(harness ptr 生命周期 + §8 引用失实;已修)、N-02(漏列 submodule bun.lock;已补)、N-03(§6 行 2 应为修复后事实;已改)、N-04(切片编号漂移;已统一) | BLOCK(修订至 R2) | task ses_fa2b228e9ffeSfUBcd1Z9TPgry,2026-09-01 |
| 2 | R2 | yes | 无("No blocking findings") | R2-N-01(§14 措辞与 §10.1 代码在 handler 签名上不一致,以 §10.1 变参定义为准;下个自然修订更正)、R2-N-02(磁盘 harness 仍为预解析指针形,S1 green 前须还原 view 直传)、R2-N-03("三次运行均 63B"为 transcipt-only 鲁棒性声明,磁盘仅单件 artifact)、R2-N-04(§6 行 8 producer 措辞过宽,现行 mixer-only 消费者是 core 自身测试) | APPROVE | task ses_fa2b228e9ffeSfUBcd1Z9TPgry,2026-09-01 round 2 |

Round 2 裁决原文(关键段,原样):"**APPROVE** — for revision R2 exactly. Both round-1 blockers are correctly resolved against repository evidence, all four non-blocking notes are absorbed, and the full-scope re-audit found no new blocking defects. Approval covers implementation of components A/B/C with TDD slices S1–S6; §10.4 (release + parent upgrade) remains self-gated by the plan on OD-1 sequencing and OD-2 budget-adjudication decisions that belong to the user, as recorded in the plan's own terms."

任何实质修订使既有 approval 失效。

## 23. Implementation Evidence

### Actual Files and Diff(submodule 部分;component C 与发布 chore 待 OD-1 最终裁决后实施)

```text
packages/core/src/audio.ts             | 53 +++++(组件 B:idleReleaseMs 看护与释放)
packages/core/src/tests/audio.test.ts  | 94 +++++(S2-S5 行为切片)
packages/core/src/zig/miniaudio_shim.c | 34 +++++(组件 A:ALSA 诊断静默 constructor)
3 files changed, 181 insertions(+)
```

实施期修正(非实质,行为设计不变):§10.1 草图中 dlsym 目标的类型误写为 handler 类型,实际为单参 setter `snd_lib_error_set_handler(snd_error_handler_t)`,实现中新增 `snd_error_set_handler_fn` typedef 并补 `<stddef.h>`(NULL);裁决记录见 §22 R2-N-01 同类先例。

### 发布链实况(OD-1 用户裁决:commit→等CI→tag发布→再更新opencode侧)

- submodule 提交:`e2e5f12d` fix(core)(3 文件 +181)+ `985f1525` chore(release)(9 manifest + submodule bun.lock,18+/18-)
- push smark/main → **SMARK Package CI run 33526838274 全绿**(10/10 jobs,含 macos 全平台构建与 4-OS 验证矩阵)
- tag `v0.4.3-smark.9` → SMARK Immutable Release run 33528228450:首次尝试在 "Run JavaScript and framework suites" 步骤遭 **Bun 运行时自身崩溃**(panic 原文 "This indicates a bug in Bun, not your code",macOS Silicon v1.3.14,崩于未触碰的 Diff.test.ts 中途;同 commit 的 Package CI 同步骤绿);`gh run rerun --failed` 后全绿,发布 12 资产(11 tarball + SHA256SUMS)
- parent:root package.json 14 处引用(3 catalog + 11 overrides URL)→ smark.9;`bun install` 装入发布版(30 packages)
- component C:`packages/opencode/src/cli/cmd/tui/util/audio.ts` +4(1 代码 + 3 注释,`idleReleaseMs: 3000`)
- **端到端取证(零手工换库)**:装机态 release `libopentui.so` 含 `opentui_asound_silence` 符号;WSL 红绿环对装机发布版实测 `stderr_bytes=0`

### Red-Green Test Evidence

- S2 red(实施前):`isMixerStarted() Expected: false / Received: true`(释放路径不存在)
- S2-S5 green:`bun test src/tests/audio.test.ts` 15 pass / 0 fail(12 既有 + 4 新增,S3/S4/S5 为同一批准设计单元的行为验证切片,实现随 S2 切片一次性落地)
- S1 red(基线):`stderr_bytes=63`(三次独立运行;磁盘 artifact 与实录见 §8)
- S1 green(修复后):`stderr_bytes=0`(同一 harness、同一 WSL 无声卡环境、本地同工具链重建 lib)

### Verification Commands and Results

| 命令 | 目录 | 结果 |
| --- | --- | --- |
| `~/zig/zig build test --summary all` | WSL `~/otzig/zig`(ext4 副本) | 1689/1692 passed + 3 skip(与基线完全一致) |
| `bun test src/tests` | `packages/core`(WSL) | 1473 pass / 0 fail(基线 1469 + 新增 4) |
| `bun run lint`(oxlint) | opentui root | 0 warnings 0 errors |
| `bunx oxfmt --check <两个改动 TS 文件>` | opentui root(WSL linux 绑定) | All matched files use the correct format |
| `bun run --cwd packages/core typecheck` | opentui root | 改动文件 0 错误(全部报错均为基线既有:dev/、benchmark/、yoga-upstream、renderer 等未触碰文件) |
| `bun run build:native`(host ReleaseFast) | WSL `~/otzig/zig` | `lib/x86_64-linux/libopentui.so` 产出并部署验证 |
| SMARK Package CI / Release(CI) | GitHub Actions | Package CI 10/10 绿;release 首跑 Bun 自身瞬态崩溃后 rerun 全绿并发布 |
| `bun install` | repo root | 装入 smark.9 发布版(30 packages) |
| `bun typecheck`(tsgo) | `packages/opencode` | 通过 |
| `bun test test/cli/cmd/tui/attention.test.ts` | `packages/opencode` | 21 pass / 0 fail |
| `bun test test/cli/cmd/tui/` | `packages/opencode` | 321 pass / 0 fail(33 文件) |

### Original Feedback-Loop Result

`wsl … run.sh`:修复前 `stderr_bytes=63`(含 `ALSA lib pcm.c:2664:(snd_pcm_open_noupdate) Unknown PCM`)→ 修复后 `stderr_bytes=0`。验证后 parent `node_modules` 的原版 .so 已从备份还原。

### Actual Secondary and Replacement Path Inventory

与 §11 计划一致:仅 primary-contract 分支(dlopen 失败跳过、dlsym 失败跳过、`!mixerStarted` 自清、`voicesActive>0` 重置锚、loop 不排程);新增 alternate success path = 0;诊断面 = 0。

### Chinese Comment Calculation(生产代码实际值)

| Metric | Actual | 排除与证据 |
| --- | --- | --- |
| Effective changed code lines `E` | ~53(audio.ts ~32 + shim.c ~21) | 排除空行/注释/import/纯定义外围;测试行单独计(94,内含 6 条意图注释) |
| Qualifying Chinese comment lines `C` | ~32(shim ~13 + audio.ts ~19) | 均邻近修改点,解释 invariant/真实边界/契约与线程语义 |
| Ratio `C / E` | ≈ 60% | ≥ max(1, ceil(53×0.15)) = 8 ✓(含测试口径 E≈128 时需 ≥20,C≈38 亦满足) |

### Remaining Unverified Items

- solid/keymap 套件与 darwin/win32 交叉变体:CI(macos-15 runner)已覆盖本轮(Package CI 10/10 绿含同套件)。
- 本地 Windows zig 0.15.2 configure 阶段损坏属本地环境限制(WSL 同源全绿;CI 构建不受影响)。
- WSL bun 1.3.13 与 CI bun 1.3.14 的版本差(仅本地验证环境差,不进 commit)。
- TUI 交互式冒烟(有声卡真机发声/multipoint 腾挪)属用户真机验收项,自动化不可达。

### Post-verification Follow-up(发布链补丁,2026-09-02)

parent commit da87447942 触发 "Build OpenCode CLI" CI 的 `opentui-closure` 门禁红:本计划 §15 遗漏了 `packages/opencode/script/verify-opentui-closure.ts:8` 的版本常量与 `opentui-source-revision.json` provenance 清单两处 smark.8 钉死;且 smark.9 tag 误打 lightweight,而校验器(opentui-provenance.ts:62)强制 annotated 且仓库规则禁止删除已发布 tag(方案 A 不可行)。按 tag 不可变契约改走 smark.10:submodule `3fa72b17`(仅版本字符串 chore,源码同 smark.9)→ Package CI 绿 → annotated `v0.4.3-smark.10` 发布(12 资产)→ parent 四文件更新(package.json/bun.lock 指向 smark.10 + 上述两脚本)。closure 门禁本地全绿:gitlink=3fa72b17、11 包、单 solid owner、单 native lib 哈希;WSL 端到端对装机 smark.10 实测 stderr_bytes=0。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- |---|
| 1 | R2 | yes | 无("No blocking findings") | I-01(S3 断言采样点落在无重置变体的区分窗口之外,测试强度缺口;行为本身已经 auditor 亲手 probe 复证正确,留作后续加强方向)、I-02(§16 S4 的 "(同上)" 红因标注不准——loop 排除切片属 green-only 输入域守卫,合法)、I-03(§23 分层验证叙事措辞可更清晰;实质内容 auditor 已独立复现属实) | APPROVE | task ses_fa2b228e9ffeSfUBcd1Z9TPgry,2026-09-02 implementation round |

裁决原文(关键段,原样):"**APPROVE** — for the actual diff against approved revision R2. The implementation is faithful to the approved design, both round-1 blockers' resolutions are correctly executed, and I independently reproduced the decisive evidence: the shipped release artifact contains the fix and silences ALSA diagnostics end-to-end (`stderr_bytes=0` in the original no-sound-card scenario), the idle-release contract behaves correctly through the installed package, and the opencode-side suites and typecheck are green. The three non-blocking notes (test discrimination window, §16 S4 label, §23 phrasing) do not impede release; the parent-side commit may proceed per the workflow."
