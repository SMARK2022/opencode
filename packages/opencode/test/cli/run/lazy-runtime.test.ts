import { expect, test } from "bun:test"
import path from "path"

test("importing the run command does not execute the interactive runtime module", async () => {
  // clearAll会连同preload的Solid转换一起清除；仅在子进程注册探针，父进程不改插件表。
  // 子进程只导入命令元数据，runtime被替换为计数器，绝不执行交互handler。
  // 在命令依赖有机会触发转换前取样，验证全局插件注册不提前加载 Babel。
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { createRequire } = await import("node:module");
const babelCoreLoaded = Object.keys(createRequire(import.meta.url).cache).some(
  (file) => /[/\\\\]@babel[/\\\\]core[/\\\\]/.test(file),
);
const key = Symbol.for("opencode.test.run-runtime-loaded");
globalThis[key] = 0;
Bun.plugin({
  name: "run-runtime-eager-probe",
  setup(build) {
    build.onLoad({ filter: /[\\\\/]cli[\\\\/]cmd[\\\\/]run[\\\\/]runtime\\.ts$/ }, () => ({
      contents: 'globalThis[Symbol.for("opencode.test.run-runtime-loaded")]++; export {};',
      loader: "js",
    }))
  },
});
const command = await import("./src/cli/cmd/run");
await Bun.sleep(0);
console.log(JSON.stringify({ command: command.RunCommand.command, loaded: globalThis[key], babelCoreLoaded }));`,
    ],
    {
      cwd: path.join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
      // [0626] 不继承测试进程的 worker/daemon 角色变量，子进程走真实 CLI 模块路径。
      env: { ...process.env, OPENCODE_WORKER: "", OPENCODE_TUI_WORKER: "", OPENCODE_PROCESS_ROLE: "" },
    },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit, stderr).toBe(0)
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!)
  expect(result.command).toContain("run")
  expect(result.loaded).toBe(0)
  expect(result.babelCoreLoaded).toBe(false)
})
