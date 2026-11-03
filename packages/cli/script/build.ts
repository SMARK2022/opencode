#!/usr/bin/env bun

import { $ } from "bun"
import { rm } from "fs/promises"
import path from "path"
import { Script } from "@opencode-ai/script"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { PromptVoiceAssets } from "../../tui/src/prompt-voice-assets"
import pkg from "../package.json"
import { modelsData } from "./generate"

const dir = path.resolve(import.meta.dirname, "..")
const binary = "lildax"
process.chdir(dir)

await rm("dist", { recursive: true, force: true })

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) return false
      if (item.avx2 === false) return baselineFlag
      return item.abi === undefined
    })
  : allTargets

// Bun 1.4.4 skips native packages for the other libc by default, but the musl targets need them.
if (!skipInstall) await $`bun install --os="*" --cpu="*" --libc="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`

for (const item of targets) {
  const target = [
    binary,
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi,
  ]
    .filter(Boolean)
    .join("-")
  const name = target.replace(binary, "cli")
  console.log(`building ${name}`)
  const voiceWorkerPath = "opencode-voice-recorder-worker.ts"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const result = await Bun.build({
    // Native与旧入口嵌入同一资源表，不复制录音器或引入源码包路径回退。
    files: {
      "opencode-pvrecorder.gen.ts": PromptVoiceAssets.createPvRecorderNativeFileMap(item, dir),
      // 与legacy使用同一虚拟入口，编译后不依赖checkout或构建机的源码路径。
      [voiceWorkerPath]: await Bun.file(path.resolve(dir, "../tui/src/prompt-voice-recorder-worker.ts")).text(),
    },
    entrypoints: ["./src/index.ts", "opencode-pvrecorder.gen.ts", voiceWorkerPath],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: target.replace(binary, "bun") as Bun.Build.CompileTarget,
      outfile: `./dist/${name}/bin/${binary}`,
      execArgv: [`--user-agent=${binary}/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    define: {
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_COMPILED: "true",
      // 同一共享录音器消费compiled地址；缺失资源仍明确失败，不回落到源码态。
      OPENCODE_VOICE_WORKER_PATH: bunfsRoot + voiceWorkerPath,
      OPENCODE_CLI_NAME: `'${binary}'`,
      OPENCODE_MODELS_DEV: modelsData,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "undefined",
      // FFF_LIBC selects the fff native lib variant: "musl" or "gnu".
      FFF_LIBC: item.os === "linux" ? `'${item.abi ?? "gnu"}'` : "undefined",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }

  // 两代都保留真实compiled入口probe；仅匹配当前平台，ack与close由同一生产角色验证。
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const smoke = Bun.spawn([path.resolve(dir, `dist/${name}/bin/${binary}`)], {
      env: { ...process.env, OPENCODE_PROCESS_ROLE: "voice-smoke" },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [exit, stdout, stderr] = await Promise.all([
      smoke.exited,
      new Response(smoke.stdout).text(),
      new Response(smoke.stderr).text(),
    ])
    if (exit !== 0 || stdout.trim() !== "voice-worker-probe-ok")
      throw new Error(stderr.trim() || `voice worker smoke exited ${exit} without marker`)
  }

  await Bun.write(
    `./dist/${name}/package.json`,
    JSON.stringify(
      {
        name: `@opencode-ai/${name}`,
        version: Script.version,
        license: "MIT",
        repository: { type: "git", url: "git+https://github.com/anomalyco/opencode.git" },
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
}
