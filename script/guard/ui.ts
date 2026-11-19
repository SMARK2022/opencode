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
  out.write(`${head(ICON[state], name, detail)}${result ? `  ${result}` : ""}${ms === undefined ? "" : `  ${dim(clock(ms))}`}\n`)
}

// 正在运行的步骤：progress 返回进度片段（可选）
export function task(name: string, detail: string, progress?: () => string) {
  const t0 = performance.now()
  let frame = 0
  const draw = () =>
    out.write(`\r\x1b[2K${head(cyan(FRAMES[frame++ % FRAMES.length]), name, detail)}${progress ? `  ${progress()}` : ""}  ${dim(clock(performance.now() - t0))}`)
  let timer: ReturnType<typeof setInterval> | undefined
  if (live) {
    draw()
    timer = setInterval(draw, 100)
  } else {
    out.write(`${head("…", name, detail)}\n`)
    if (progress) timer = setInterval(() => out.write(`       ${progress()}  ${clock(performance.now() - t0)}\n`), 30_000)
  }
  return {
    done(state: State, result = "") {
      clearInterval(timer)
      if (live) out.write("\r\x1b[2K")
      line(state, name, detail, result, performance.now() - t0)
    },
  }
}

export const sub = (text: string) => out.write(`       ${dim("↳")} ${text}\n`)
export const note = (text: string) => out.write(`\n${yellow("ℹ")} ${text.replaceAll("\n", "\n  ")}\n`)
export const section = (title: string) => out.write(`\n${red("━━")} ${title} ${red("━".repeat(12))}\n`)
export const raw = (text: string) => out.write(text.endsWith("\n") ? text : `${text}\n`)
