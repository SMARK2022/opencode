import { expect, test } from "bun:test"
import path from "path"

test("importing the run command does not execute the interactive runtime module", async () => {
  // Bun.plugin 的模块替换是进程全局的，clearAll 还会清掉 bunfig preload 注册的
  // Solid JSX 转换——同进程使用会污染 shard 内所有后续 tsx 文件。探针因此放在
  // 子进程里跑，父进程只读它的退出码与输出。
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const key = Symbol.for("opencode.test.run-runtime-loaded");
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
console.log(JSON.stringify({ command: command.RunCommand.command, loaded: globalThis[key] }));`,
    ],
    {
      cwd: path.join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
      // 不继承测试进程的 worker/daemon 角色变量，子进程走真实 CLI 模块路径。
      env: { ...process.env, OPENCODE_WORKER: "", OPENCODE_TUI_WORKER: "" },
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
})
