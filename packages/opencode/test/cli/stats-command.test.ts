import { expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import yargs from "yargs/yargs"
import { StatsCommand } from "../../src/cli/cmd/stats"
import { tmpdir } from "../fixture/fixture"
import baseline from "../fixture/stats-baseline.json"

const packageRoot = new URL("../../", import.meta.url)
const moduleURL = (path: string) => JSON.stringify(new URL(path, packageRoot).href)
// file URL 同时覆盖 Windows 盘符和路径空格，子进程不需要复制或改写生产源码。
// 子进程只加载公开命令源码和测试 seed，不执行产品 index、serve 或 daemon，也不 mock 数据/绘图。
const setup = `
  const { AppRuntime } = await import(${moduleURL("src/effect/app-runtime.ts")});
  const { StatsCommand } = await import(${moduleURL("src/cli/cmd/stats.ts")});
  const { seedStatsDatabase } = await import(${moduleURL("test/fixture/stats-database.ts")});
  const { default: yargs } = await import(${JSON.stringify(pathToFileURL(Bun.resolveSync("yargs/yargs", import.meta.dir)).href)});
  const { default: assert } = await import("node:assert/strict");
  Date.now = () => ${baseline.now};
  // 范围切换与旧 oracle 共用固定自然日，不让 today/60 days 取决于测试运行当天。
  Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
  const parse = (args) => yargs(["stats", ...args]).scriptName("opencode").command(StatsCommand).strict()
    // 参数错误保持失败，禁止静默吞掉未知选项后继续执行另一个页面。
    .showHelpOnFail(false).exitProcess(false).fail((message, error) => { throw error ?? new Error(message) }).parseAsync();
  try {
    await AppRuntime.runPromise(seedStatsDatabase());
`

async function execute(body: string) {
  // 临时 cwd 防止 InstanceBootstrap 读取工作区配置；数据库仍由真实 AppRuntime 创建和查询。
  await using dir = await tmpdir()
  const child = Bun.spawn(
    [process.execPath, "--eval", `${setup}\n${body}\n} finally { await AppRuntime.dispose(); }`],
    {
      cwd: dir.path,
      env: {
        ...process.env,
        TZ: "UTC",
        OPENCODE_DB: ":memory:",
        OPENCODE_PURE: "1",
        // 复用既有测试隔离开关，关闭外部插件和网络刷新，不启动任何模型轮次或 daemon。
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_CONFIG: undefined,
        // 父进程测试目录已隔离 HOME/XDG；显式配置路径不能从用户 shell 意外继承进来。
        OPENCODE_CONFIG_DIR: undefined,
        OPENCODE_CONFIG_CONTENT: "{}",
      },
      stdin: "pipe",
      // pipe 保持打开直到测试结束，TTY 输入另由可控流提供，避免宿主 stdin 提前 EOF。
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      // 这里只界定失控测试进程的寿命，交互就绪仍由公开帮助栏决定，不以超时作为成功。
    },
  )
  try {
    // 同时读取输出，避免大幅 ANSI 页面填满管道而让子进程与父进程互相等待。
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    // 返回实际 stdout 字节，调用者不能只凭退出码为零宣称页面或别名一致。
    return stdout
  } finally {
    // 测试断言或启动失败时仍关闭隔离进程；不把挂起/超时转成验收成功。
    if (child.exitCode === null) child.kill()
    child.stdin.end()
    await child.exited
  }
}

// 只在隔离子进程模拟终端能力；输入从已输出的帮助栏推进，不依赖固定 sleep 猜就绪。
const terminal = (keys: string[]) => `
  const { PassThrough } = await import("node:stream");
  // 可控输入流通过同一 stdin 接口驱动真实循环，避免向测试宿主的物理终端设置 raw mode。
  const stdin = new PassThrough();
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  const targets = [[stdin, "isTTY"], [stdin, "isRaw"], [stdin, "setRawMode"], [process.stdout, "isTTY"], [process.stdout, "write"]];
  const descriptors = targets.map(([target, key]) => [target, key, Object.getOwnPropertyDescriptor(target, key)]);
  // 记录 descriptor 而不只记值，才能归还原先不存在或通过 getter 提供的终端属性。
  const raw = [];
  const frames = [];
  const writes = [];
  const keys = ${JSON.stringify(keys)};
  const events = ["data", "end", "error"];
  const listeners = events.map((event) => stdin.listenerCount(event));
  // 监听器基线在循环注册前捕获；退出后检查增加的 data/end/error handler 已全部移除。
  stdin.pause();
  Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(stdin, "isRaw", { value: false, writable: true, configurable: true });
  Object.defineProperty(stdin, "setRawMode", { value: (value) => { raw.push(value); stdin.isRaw = value; return stdin; }, configurable: true });
  // 同时记录协议调用与可观察 raw 状态，不能由测试清理函数替生产 finalizer 归还 raw mode。
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  let screen = "";
  let initialPaused;
  let result;
  try {
    Object.defineProperty(process.stdout, "write", { configurable: true, value: (chunk) => {
      const text = chunk.toString();
      writes.push(text);
      if (text === "\\x1b[?25l") initialPaused = stdin.isPaused();
      // 光标隐藏是进入循环的公开信号，paused 状态应相对这一时点恢复而非相对 bootstrap 前。
      if (text === "\\x1b[2J\\x1b[H") screen = "";
      // 清屏分隔完整帧；新一帧不能把上一页尾部残留当作当前页内容通过验收。
      else if (text.startsWith("\\n\\n") && text.includes("q/Esc quit")) {
        frames.push({ body: screen, help: text });
        // 帮助栏在正文之后写出，收到它才发送下一键，避免快进按键跳过未绘制的页面。
        const key = keys.shift();
        assert.notEqual(key, undefined, "unexpected extra interactive frame");
        // 多出一帧必须失败，不能忽略未计划的重绘后仍只比对预期几页。
        queueMicrotask(() => {
          if (key === "EOF") return stdin.end();
          // 用 stream 自身的 end/destroy 发射生命周期信号，不手工伪造私有 runner 的返回值。
          if (key === "ERROR") return stdin.destroy(new Error("terminal fixture input failure"));
          // 分两次 data 发送方向键，真实验证 ESC 前缀等待而不是只测完整转义序列。
          if (key.startsWith("\\x1b[")) {
            stdin.write(Buffer.from("\\x1b"));
            queueMicrotask(() => stdin.write(Buffer.from(key.slice(1))));
            return;
          }
          stdin.write(Buffer.from(key));
        });
      } else screen += text;
      return true;
    }});
    await parse(["--interactive", "--all-time", "--color", "never"]);
    result = { frames, raw, hidden: writes.includes("\\x1b[?25l"), shown: writes.at(-1) === "\\x1b[?25h\\x1b[0m\\n",
      // EOF/error 的可读端已销毁，不再有 open-stream paused 状态；raw 和监听器仍须完整归还。
      restored: !stdin.isRaw && (stdin.destroyed || stdin.isPaused() === initialPaused) && events.every((event, index) => stdin.listenerCount(event) === listeners[index]) };
  } finally {
    // 生产 finalizer 的状态先被记录；测试再恢复 descriptors，绝不通过测试清理伪造恢复成功。
    for (const [target, key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
    Object.defineProperty(process, "stdin", stdinDescriptor);
    stdin.destroy();
  }
  console.log(JSON.stringify(result));
  // 元数据只在恢复 stdout 后打印，父进程观察到的是生产恢复完成前捕获的状态。
`

test("stats help exposes only the canonical source pages", async () => {
  // 直接执行公开 builder，不进入 src/index 或 daemon；旧 Gallery 不能继续占据公开页面职责。
  if (typeof StatsCommand.builder !== "function") throw new Error("Stats command builder is unavailable")
  const parser = await StatsCommand.builder(
    yargs([]).scriptName("opencode stats").locale("en").wrap(120).exitProcess(false),
  )
  const help = await parser.getHelp()
  for (const page of ["dashboard", "breakdown", "timeline", "sessions", "insights"]) expect(help).toContain(page)
  expect(help).not.toContain("chart gallery")
  expect(help).not.toContain("show cost-only")
  expect(help).not.toContain("project cost run-rate")
  expect(help).toBe(baseline.help)
  // 固定旧 builder 的整段帮助作为独立预期，标题存在不能掩盖旧 Gallery 或隐藏别名漂移。
})

test("Stats help snapshot matches the public builder without starting the product", async () => {
  if (typeof StatsCommand.builder !== "function") throw new Error("Stats command builder is unavailable")
  // 外层只提供现有全局参数；真正的 Stats 命令、排序、aliases 与说明仍由公开 builder 生成。
  const parent = yargs([])
    .scriptName("opencode stats")
    .usage(`$0\n\n${StatsCommand.describe}`)
    .locale("en")
    .wrap(100)
    .help("help", "show help")
    .alias("help", "h")
    .version("version", "show version number", "test")
    .alias("version", "v")
    .option("print-logs", { describe: "print logs to stderr", type: "boolean" })
    .option("log-level", { describe: "log level", type: "string", choices: ["DEBUG", "INFO", "WARN", "ERROR"] })
    .option("pure", { describe: "run without external plugins", type: "boolean" })
    .exitProcess(false)
  const parser = await StatsCommand.builder(parent)
  // 只按 JavaScript 模板字面量语义读取快照容器的 CRLF，不正规化任何实际页面输出。
  const snapshot = (
    await Bun.file(new URL("help/__snapshots__/help-snapshots.test.ts.snap", import.meta.url)).text()
  ).replaceAll("\r\n", "\n")
  const prefix =
    'exports[`opencode CLI help-text snapshots every documented command emits stable help text: opencode stats --help 1`] = `\n"'
  const expected = snapshot.split(prefix)[1]?.split('"\n`;')[0]
  // 只检查 Stats 区块，其余命令快照属于其他迁移任务，不运行产品入口批量重写。
  expect(await parser.getHelp()).toBe(expected)
})

test("real StatsCommand handlers and aliases emit the pinned canonical pages", async () => {
  const cases = [
    // 根命令与显式 Dashboard 各执行一次，能发现只恢复子命令而遗漏默认入口。
    { key: "root", args: [], page: "dashboard" },
    { key: "dashboard", args: ["dashboard"], page: "dashboard" },
    { key: "dash", args: ["dash"], page: "dashboard" },
    { key: "overview", args: ["overview"], page: "dashboard" },
    { key: "summary", args: ["summary"], page: "dashboard" },
    ...["model", "provider", "agent", "source", "project", "tool", "status"].map((by) => ({
      key: `breakdown-${by}`,
      args: ["breakdown", by],
      page: `breakdown-${by}`,
    })),
    { key: "by", args: ["by", "provider"], page: "breakdown-provider" },
    { key: "models", args: ["models"], page: "breakdown-model" },
    { key: "model", args: ["model"], page: "breakdown-model" },
    { key: "providers", args: ["providers"], page: "breakdown-provider" },
    { key: "provider", args: ["provider"], page: "breakdown-provider" },
    { key: "timeline", args: ["timeline"], page: "timeline-tokens" },
    { key: "daily", args: ["daily"], page: "timeline-tokens" },
    { key: "tokens", args: ["tokens"], page: "timeline-tokens" },
    { key: "token", args: ["token"], page: "timeline-tokens" },
    { key: "costs", args: ["costs"], page: "timeline-cost" },
    { key: "cost", args: ["cost"], page: "timeline-cost" },
    { key: "heatmap", args: ["heatmap"], page: "timeline-heatmap" },
    { key: "heat", args: ["heat"], page: "timeline-heatmap" },
    { key: "sessions", args: ["sessions"], page: "sessions" },
    { key: "session", args: ["session"], page: "sessions" },
    { key: "insights", args: ["insights"], page: "insights" },
    { key: "insight", args: ["insight"], page: "insights" },
    { key: "forecast", args: ["forecast"], page: "forecast" },
    { key: "run-rate", args: ["run-rate"], page: "forecast" },
    { key: "forecast-flag", args: ["insights", "--forecast"], page: "forecast" },
    { key: "models-shortcut", args: ["--models"], page: "breakdown-model" },
    { key: "tools-shortcut", args: ["--tools"], page: "breakdown-tool" },
    { key: "non-tty", args: ["--interactive"], page: "dashboard" },
    // 非 TTY 必须是同一 Dashboard 加一次换行，不可夹带清屏、光标隐藏或键盘循环输出。
  ]
  const result = await execute(`
    for (const entry of ${JSON.stringify(cases)}) {
      process.stdout.write("\\x1e" + entry.key + "\\x1f");
      await parse([...entry.args, "--all-time", "--color", "never"]);
    }
    for (const [shortcut, dimension] of [["--models", "model"], ["--tools", "tool"]]) {
      process.stdout.write("\\x1elimited-" + dimension + "\\x1f");
      await parse([shortcut, "1", "--all-time", "--color", "never"]);
      process.stdout.write("\\x1ecanonical-" + dimension + "\\x1f");
      await parse(["breakdown", dimension, "--limit", "1", "--all-time", "--color", "never"]);
    }
  `)
  // 帧标记只分隔测试进程中的多次调用，正文仍是未经 console spy 或正规化的实际 stdout。
  const [prefix, ...chunks] = result.split("\x1e")
  // 前缀必须为空；不能把启动时意外发射的正文或日志悄悄丢掉。
  expect(prefix).toBe("")
  const outputs = Object.fromEntries(
    chunks.map((chunk) => {
      const separator = chunk.indexOf("\x1f")
      return [chunk.slice(0, separator), chunk.slice(separator + 1)]
    }),
  )
  for (const entry of cases) {
    const golden = baseline.cases.find(
      (item) => item.fixture === "all" && item.columns === 120 && item.color === "never" && item.page === entry.page,
    )
    if (!golden) throw new Error(`Missing canonical page ${entry.page}`)
    expect(outputs[entry.key], entry.key).toBe(`${golden.expected}\n`)
    // 换行属于 console 的真实输出协议；页面本体的所有 ANSI/空格仍直接取固定源字符串。
  }
  // 显式 N 的 shortcut 必须与 canonical limit 等价；两个入口都消费实际数据库，不替换 handler。
  for (const dimension of ["model", "tool"])
    expect(outputs[`limited-${dimension}`]).toBe(outputs[`canonical-${dimension}`])
}, 45_000)

test("TTY navigation reproduces all five pages and r/R ranges and restores the terminal", async () => {
  const result: unknown = JSON.parse(
    await execute(terminal(["n", "\t", "\x1b[C", "n", "n", "p", "\x1b[D", "r", "R", "q"])),
  )
  const frames = [
    // 五页先完整向前循环，再通过 p/分片左键返回；不能只证明单个 next 操作生效。
    "dashboard",
    "breakdown-model",
    "timeline-tokens",
    "sessions",
    "insights",
    "dashboard",
    "insights",
    "sessions",
    "sessions",
    "sessions",
  ].map((page, index) => {
    const golden = baseline.cases.find(
      (item) => item.fixture === "all" && item.columns === 120 && item.color === "never" && item.page === page,
    )
    if (!golden) throw new Error(`Missing interactive page ${page}`)
    const view = page === "breakdown-model" ? "breakdown" : page === "timeline-tokens" ? "timeline" : page
    return {
      body: index === 8 ? baseline.interactive.sessions60 : golden.expected,
      // 60 日帧来自旧 Data 与旧 renderer 的额外执行，不由当前 range 结果自证。
      help: `\n\n${view} · ${index === 8 ? "60 days" : "all time"} · n/→ next · p/← previous · r/R range · q/Esc quit\n`,
    }
  })
  // 正文和底栏都逐字对齐固定源，不能只凭当前页标题证明其他图形完整。
  expect(result).toEqual({ frames, raw: [true, false], hidden: true, shown: true, restored: true })
}, 45_000)

test("TTY Esc, Ctrl-C, EOF and input errors all release raw mode and listeners", async () => {
  const golden = baseline.cases.find(
    (entry) =>
      entry.fixture === "all" && entry.page === "dashboard" && entry.columns === 120 && entry.color === "never",
  )
  if (!golden) throw new Error("Missing initial interactive page")
  for (const key of ["\x1b", "\x03", "EOF", "ERROR"]) {
    // 四类退出分别经过真实输入路径，各自创建隔离 runtime，不借前一用例的清理状态通过。
    const result: unknown = JSON.parse(await execute(terminal([key])))
    expect(result, key).toEqual({
      frames: [
        {
          body: golden.expected,
          help: "\n\ndashboard · all time · n/→ next · p/← previous · r/R range · q/Esc quit\n",
        },
      ],
      raw: [true, false],
      hidden: true,
      shown: true,
      restored: true,
    })
  }
}, 90_000)
