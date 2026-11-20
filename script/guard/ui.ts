export * as UI from "./ui"
// 门禁的终端输出：每个步骤一行（图标 · 名称 · 细节 · 结果 · 耗时）。
// 终端里原地刷新（转圈 + 进度条）；不是终端（CI、插件、重定向）时只打印开始、定期进度和结果，不输出控制字符。
const out = process.stdout
const live = !!out.isTTY && !process.env.CI
const color = live && !process.env.NO_COLOR
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
export const dim = paint(2)
export const red = paint(31)
export const green = paint(32)
export const yellow = paint(33)
export const cyan = paint(36)

export type State = "ok" | "fail" | "warn" | "skip" | "wait"
const ICON: Record<State, string> = { ok: green("✓"), fail: red("✗"), warn: yellow("△"), skip: dim("–"), wait: yellow("◷") }
const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const TAG = dim("[gate]")

export const clock = (ms: number) =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`

export function bar(ratio: number, width = 18) {
  const n = Math.round(Math.max(0, Math.min(1, ratio)) * width)
  return cyan("━".repeat(n)) + dim("─".repeat(width - n))
}

const head = (icon: string, name: string, detail: string) => `${TAG} ${icon} ${name}${detail ? `  ${dim(detail)}` : ""}`

export function line(state: State, name: string, detail = "", result = "", ms?: number) {
  print(`${head(ICON[state], name, detail)}${result ? `  ${result}` : ""}${ms === undefined ? "" : `  ${dim(clock(ms))}`}`)
}

// 并行步骤运行时，先擦掉汇总行再打印，打印后重画汇总行
function print(text: string) {
  out.write(`${live ? "\r\x1b[2K" : ""}${text}\n`)
  if (live && running.size) draw()
}

// 正在运行的步骤可以有多个（并行）：终端里只保留一行汇总，每个步骤结束时在上方打印它的结果行。
type Running = { name: string; detail: string; progress?: () => string; t0: number }
const running = new Set<Running>()
let frame = 0
let timer: ReturnType<typeof setInterval> | undefined
const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")
// 中日韩字符占两列；超出终端宽度会折行，原地刷新就会错位
const width = (text: string) => [...visible(text)].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e7f ? 2 : 1), 0)

function draw() {
  const spin = cyan(FRAMES[frame++ % FRAMES.length])
  const list = [...running]
  const elapsed = dim(clock(performance.now() - Math.min(...list.map((t) => t.t0))))
  const text =
    list.length === 1
      ? `${head(spin, list[0].name, list[0].detail)}${list[0].progress ? `  ${list[0].progress()}` : ""}  ${elapsed}`
      : `${TAG} ${spin} 并行 ${list.length} 项：${list
          .map((t) => `${t.name} ${t.detail.split(" · ")[0]}${t.progress ? ` ${t.progress()}` : ""}`)
          .join(dim(" · "))}  ${elapsed}`
  const max = (out.columns || 120) - 1
  const fitted =
    width(text) > max ? [...visible(text)].reduce((s, c) => (width(s + c) < max - 1 ? s + c : s), "") + "…" : text
  out.write(`\r\x1b[2K${fitted}`)
}

// progress 返回进度片段（可选）
export function task(name: string, detail: string, progress?: () => string) {
  const self: Running = { name, detail, progress, t0: performance.now() }
  running.add(self)
  let periodic: ReturnType<typeof setInterval> | undefined
  if (live) timer ??= setInterval(draw, 100)
  else {
    out.write(`${head("…", name, detail)}\n`)
    const report = () => out.write(`       ${name} ${progress?.()}  ${clock(performance.now() - self.t0)}\n`)
    if (progress) periodic = setInterval(report, 30_000)
  }
  return {
    done(state: State, result = "") {
      clearInterval(periodic)
      running.delete(self)
      line(state, name, detail, result, performance.now() - self.t0)
      if (live && !running.size) {
        clearInterval(timer)
        timer = undefined
      }
    },
  }
}

export const sub = (text: string) => print(`       ${dim("↳")} ${text}`)
export const note = (text: string) => out.write(`\n${yellow("ℹ")} ${text.replaceAll("\n", "\n  ")}\n`)
export const section = (title: string) => out.write(`\n${red("━━")} ${title} ${red("━".repeat(12))}\n`)
export const raw = (text: string) => out.write(text.endsWith("\n") ? text : `${text}\n`)
