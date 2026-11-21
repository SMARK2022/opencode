import { copyFile, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export async function runTui(base: string, root: string, workspace: string, session: { id: string; title: string }, turns: number, clock: string) {
  const cwd = path.join(root, "packages/tui")
  const dir = await mkdtemp(path.join(os.tmpdir(), "bench-tui-"))
  const driver = `./test/bench-${crypto.randomUUID()}.test.tsx`
  const out = path.join(dir, "metrics.json")
  try {
    await copyFile(path.join(import.meta.dir, "tui-driver.tsx.txt"), path.join(cwd, driver))
    const p = Bun.spawn([process.execPath, "test", "--timeout", "45000", driver], {
      cwd, timeout: 50_000, killSignal: "SIGKILL", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir,
        BENCH_URL: base, BENCH_DIR: workspace, BENCH_SESSION: session.id, BENCH_TITLE: session.title,
        BENCH_TAIL: `tail-${turns - 1}`, BENCH_CLOCK: clock, BENCH_OUT: out },
    })
    if (await p.exited !== 0) throw new Error("TUI 驱动失败，见该轮 stderr")
    return await Bun.file(out).json() as Record<string, number>
  } finally {
    await rm(path.join(cwd, driver), { force: true })
    await rm(dir, { recursive: true, force: true })
  }
}
