#!/usr/bin/env bun

// 在其他 import 求值前加载 version-env，确保它们读取到 OPENCODE_VERSION。
import "./version-env"

import { $ } from "bun"
// #489：evidence 链需要 realpath 与 stat；Bun API 覆盖不了的 fs 语义在此显式引入。
import fs from "node:fs"
import path from "path"
import { PromptVoiceAssets } from "../../tui/src/prompt-voice-assets"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { resolveInstallTarget } from "./install-target"
import { createSharpNativeFileMap, runSharpSmoke, sharpPlugin } from "./sharp-native"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
const osFilter = process.argv.find((a) => a.startsWith("--os="))?.replace("--os=", "")
// #103：允许 CI 用 --arch=x64 只打 Windows x64，避免默认双架构
const archFilter = process.argv.find((a) => a.startsWith("--arch="))?.replace("--arch=", "")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : osFilter
    ? // 定向构建供原生环境快速验证，兼容变体留给完整矩阵，避免本机验证重复编译。
      allTargets.filter(
        (item) =>
          item.os === osFilter &&
          item.abi === undefined &&
          item.avx2 !== false &&
          (!archFilter || item.arch === archFilter),
      )
    : allTargets

await $`rm -rf dist`

// #489：OpenTUI 构建证据链——package/native/executable 三层同证据落盘，
// release archive 的 smoke 结果可以借此回溯到确定的 native 输入。
async function packageRoot(name: string, from = dir) {
  // Bun.resolveSync 可能命中 hoisted 或 target reinstall 的不同 entry；向上找 manifest 才能锁定真实包 owner。
  let directory = path.dirname(fs.realpathSync(Bun.resolveSync(name, from)))
  while (directory !== path.dirname(directory)) {
    if (await Bun.file(path.join(directory, "package.json")).exists()) return directory
    directory = path.dirname(directory)
  }
  throw new Error(`Cannot locate package root for ${name}`)
}

async function verifyOpenTuiClosure() {
  const root = path.resolve(dir, "../..")
  const manifest = await Bun.file(path.join(root, "package.json")).json()
  const version = manifest.workspaces.catalog["@opentui/core"]
  const repository = "https://github.com/SMARK2022/opentui"
  const tag = `v${version}`
  const release = `${repository}/releases/download/${tag}`
  // 同一catalog派生整个family；检查锁与override，避免声明版本正确却消费registry或旧tarball。
  const family = [
    "@opentui/core",
    "@opentui/keymap",
    "@opentui/solid",
    ...[
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-arm64-musl",
      "linux-x64",
      "linux-x64-musl",
      "win32-arm64",
      "win32-x64",
    ].map((target) => `@opentui/core-${target}`),
  ]
  const lock = await Bun.file(path.join(root, "bun.lock")).text()
  for (const name of family) {
    const expected = `${release}/${name.replace("@opentui/", "opentui-")}-${version}.tgz`
    if (
      manifest.overrides[name] !== expected ||
      !lock.includes(`"${name}": "${expected}"`) ||
      !lock.includes(`"${name}@${expected}"`)
    )
      throw new Error(`${name} is not locked to ${expected}`)
  }
  // 从实际runtime消费者解析，版本相同但加载两份core或Solid仍会分裂owner；不扫描安装器缓存。
  const consumers = [root, dir, path.join(root, "packages/tui"), path.join(root, "packages/cli")]
  for (const name of ["@opentui/core", "@opentui/keymap", "@opentui/solid"]) {
    const owners = await Promise.all(consumers.map((from) => packageRoot(name, from)))
    if (new Set(owners).size !== 1) throw new Error(`${name} resolves to multiple realpaths: ${owners.join(", ")}`)
    const installed = await Bun.file(path.join(owners[0], "package.json")).json()
    if (installed.name !== name || installed.version !== version || installed.repository?.url !== repository)
      throw new Error(`${name} installed manifest does not match ${tag}`)
  }
  // 保留目标Solid版本及补丁，只要求所有真实入口与同一catalog和realpath一致。
  const solidOwners = await Promise.all(
    [...consumers, await packageRoot("@opentui/solid"), await packageRoot("@opentui/keymap")].map((from) =>
      packageRoot("solid-js", from),
    ),
  )
  const solid = await Bun.file(path.join(solidOwners[0], "package.json")).json()
  if (new Set(solidOwners).size !== 1 || solid.version !== manifest.workspaces.catalog["solid-js"])
    throw new Error("solid-js closure mismatch")
  // 源码身份取父仓索引，版本及发布tag只取root catalog，不再读取手写清单。
  // 完整annotated/peeled远端证据仍独立核对，声明不能冒充授权。
  const gitlink = (await $`git ls-files --stage -- thirdparty/opentui`.cwd(root).quiet().text()).trim().split(/\s+/)[1]
  if (!gitlink || !/^[0-9a-f]{40}$/.test(gitlink)) throw new Error("thirdparty/opentui gitlink is missing or invalid")
  const ref = `refs/tags/${tag}`
  // 完整ref与peeled ref缺一不可，不能把lightweight tag或同名branch当作发布授权。
  const output = await $`git ls-remote --tags ${repository} ${ref} ${`${ref}^{}`}`.cwd(root).quiet().text()
  const refs = new Map(
    output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [commit, name] = line.trim().split(/\s+/, 2)
        return [name, commit] as const
      }),
  )
  if (!refs.has(ref) || refs.get(`${ref}^{}`) !== gitlink)
    throw new Error(`OpenTUI ${tag} is not annotated at gitlink ${gitlink}`)
}

async function sha256(file: string) {
  // 对完整文件计算 hash，不用 mtime 或文件名作为 native identity，避免缓存重用伪造一致性。
  return new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")
}

async function writeOpenTuiBuildEvidence(item: (typeof allTargets)[number], name: string) {
  // musl 变体的包名后缀与 optionalDependencies 的命名契约一致，拼错会导致 resolve 到 glibc 包。
  const suffix = item.os === "linux" && item.abi === "musl" ? "-musl" : ""
  const nativeName = `@opentui/core-${item.os}-${item.arch}${suffix}`
  const nativeRoot = await packageRoot(nativeName)
  const nativeManifest = await Bun.file(path.join(nativeRoot, "package.json")).json()
  const coreManifest = await Bun.file(path.join(await packageRoot("@opentui/core"), "package.json")).json()
  // 声明从root catalog与父仓索引派生，消除随版本手工同步的第二信源。
  const root = path.resolve(dir, "../..")
  const version = (await Bun.file(path.join(root, "package.json")).json()).workspaces.catalog["@opentui/core"]
  // Nix源码归档不携带.git：缺席的源码身份不作声明，安装与产物证据仍照常验证。
  const hasGit = fs.existsSync(path.join(root, ".git"))
  const sourceGitlink = hasGit
    ? (await $`git ls-files --stage -- thirdparty/opentui`.cwd(root).text()).trim().split(/\s+/)[1]
    : undefined
  if (hasGit && !sourceGitlink) throw new Error("thirdparty/opentui gitlink is missing")
  // 同形releaseCommit仍是声明，不替代下方安装/native证据或远端tag授权验证。
  const declaredSource = { schema: 1, sourceGitlink, releaseTag: `v${version}`, releaseCommit: sourceGitlink }
  // target 名、manifest 约束和 native 文件必须同时一致；只记录解析到的包名会掩盖 Bun 选错 ABI 的情况。
  if (
    nativeManifest.name !== nativeName ||
    nativeManifest.version !== coreManifest.version ||
    !nativeManifest.os?.includes(item.os) ||
    !nativeManifest.cpu?.includes(item.arch)
  ) {
    throw new Error(`OpenTUI native manifest does not match ${name}: ${JSON.stringify(nativeManifest)}`)
  }
  // FFI 库扫描覆盖包内全部层级：vendor 把 .so 放在子目录时同样要被证据捕捉。
  const nativeFiles = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: nativeRoot, onlyFiles: true }))).filter(
    (file) => /\.(?:dll|dylib|so)$/.test(file),
  )
  // 每个 target 只允许一个 OpenTUI FFI library；多个候选会让 bundle 选择依赖遍历顺序而失去可复现性。
  if (nativeFiles.length !== 1) throw new Error(`${nativeName} contains ${nativeFiles.length} native libraries`)

  const nativeFile = path.join(nativeRoot, nativeFiles[0])
  const binary = path.resolve(`dist/${name}/bin/opencode${item.os === "win32" ? ".exe" : ""}`)
  const stat = await fs.promises.stat(binary)
  const evidence = {
    target: name,
    opentui: {
      version: coreManifest.version,
      declaredSource,
      package: nativeName,
      file: nativeFiles[0].replaceAll("\\", "/"),
      sha256: await sha256(nativeFile),
    },
    executable: {
      file: path.basename(binary),
      bytes: stat.size,
      sha256: await sha256(binary),
    },
  }
  // bytes 和 hash 共同保留：hash 证明内容，size 还能发现意外空壳或截断产物。
  await Bun.write(`dist/${name}/opentui-build.json`, JSON.stringify(evidence, null, 2) + "\n")
  // stdout 同时供 CI 日志抓取：workflow 失败时可直接从 build step 输出读到 hash 而无需翻 artifact。
  console.log(JSON.stringify(evidence))
}

const binaries: Record<string, string> = {}
if (!skipInstall) {
  // Bun 1.4.4 skips native packages for the other libc by default, but the musl targets need them.
  // #468：只安装目标 OS/arch 的原生变体，避免 macOS CI 下载 win32 包触发 bun IntegrityCheckFailed。
  const { os: installOs, cpu: installCpu } = resolveInstallTarget(osFilter, archFilter, singleFlag)

  // bun 不会在完整性校验失败时自动重试（oven-sh/bun#26879）；手动重试并清缓存防损坏 tarball 阻断 CI。
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await $`bun install --os="${installOs}" --cpu="${installCpu}" --libc="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
      await $`bun install --os="${installOs}" --cpu="${installCpu}" --libc="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
      await $`bun install --os="${installOs}" --cpu="${installCpu}" --libc="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
      break
    } catch (e) {
      if (attempt === 3) throw e
      console.error(`bun install failed (attempt ${attempt}/3), clearing cache and retrying...`, e)
      await $`bun pm cache rm`.quiet().nothrow()
    }
  }
}
// 发布必须在安装完成后核对真实闭包；本地构建不隐式联网，原native/产物证据继续逐target校验。
if (process.env.GITHUB_ACTIONS === "true") await verifyOpenTuiClosure()
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const workerPath = "./src/cli/tui/worker.ts"
  // 编译资源使用稳定的虚拟入口名；跨包源码路径不能拼入bunfs根，否则..会越出资源目录。
  const voiceWorkerPath = "opencode-voice-recorder-worker.ts"
  const packWorkerPath = "opencode-cold-codec-worker.ts"
  const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const sharpFiles = await createSharpNativeFileMap(item)

  const result = await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin, sharpPlugin],
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
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/opencode`,
      execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      // 复用已有虚拟模块机制，源码仍由tui owner维护；编译后无需访问checkout。
      [voiceWorkerPath]: await Bun.file(path.resolve(dir, "../tui/src/prompt-voice-recorder-worker.ts")).text(),
      // 入口只导入Core模块，不能平铺codec源码而破坏其相邻模块解析。
      [packWorkerPath]: 'import "@opencode-ai/core/storage/cold-codec"',
      [treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
      // 生成模块只保存“目标平台可用的 native 资源表”，避免所有平台二进制都被塞进每个 release exe。
      "opencode-pvrecorder.gen.ts": PromptVoiceAssets.createPvRecorderNativeFileMap(item, dir),
      "opencode-sharp.gen.ts": sharpFiles.source,
    },
    entrypoints: [
      "./src/index.ts",
      workerPath,
      // #558：voice Worker 必须同批编译，compiled 运行时才不会回退 checkout 源码文件。
      voiceWorkerPath,
      packWorkerPath,
      treeSitterWorkerPath,
      ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
      // 虚拟模块必须作为 entrypoint 交给 Bun.build，否则 dynamic import 在 compiled exe 内找不到资源映射。
      "opencode-pvrecorder.gen.ts",
      "opencode-sharp.gen.ts",
    ],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
      // #558：compiled 只走 bunfs entrypoint；运行时缺失该 define 即安装损坏。
      OPENCODE_VOICE_WORKER_PATH: bunfsRoot + voiceWorkerPath,
      OPENCODE_PACK_WORKER_PATH: bunfsRoot + packWorkerPath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      // 运行时用该常量禁止回退到 @picovoice 的 node_modules 相对路径，防止重新暴露 CI 绝对路径 bug。
      OPENCODE_COMPILED: "true",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${name}`)
  if (sharpFiles.supported) await runSharpSmoke(item, name.replace(pkg.name, "bun"), sharpFiles.source, Script.version)

  // Embedding the bundle invalidates the linker's ad-hoc signature, and macOS 27+
  // SIGKILLs binaries with invalid pages. Re-sign ad-hoc; release CI re-signs with Developer ID.
  if (item.os === "darwin" && process.platform === "darwin") {
    await $`codesign --force --sign - dist/${name}/bin/opencode`
  }

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/opencode`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const smokeEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && !["OPENCODE_PROCESS_ROLE", "OPENCODE_RUN_ID", "OPENCODE_PID"].includes(entry[0]),
        ),
      )
      // 编译脚本可能继承 worker 角色；必须让 CLI 按 main 角色执行，并拒绝空版本输出。
      const smoke = Bun.spawn([binaryPath, "--version"], {
        env: smokeEnv,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        smoke.exited,
        new Response(smoke.stdout).text(),
        new Response(smoke.stderr).text(),
      ])
      const versionOutput = stdout.trim()
      // stdout 必须来自真实 compiled CLI；stderr 或空字符串不能被当作成功版本输出。
      if (exitCode !== 0 || !versionOutput) {
        throw new Error(stderr.trim() || `version smoke exited ${exitCode} without output`)
      }
      console.log(`Smoke test passed: ${versionOutput}`)
      // #558：voice Worker compiled smoke——以独立角色 spawn，stdout 须恰为固定 marker；stderr 优先透传。
      const voiceSmoke = Bun.spawn([binaryPath], {
        env: { ...smokeEnv, OPENCODE_PROCESS_ROLE: "voice-smoke" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [voiceExit, voiceStdout, voiceStderr] = await Promise.all([
        voiceSmoke.exited,
        new Response(voiceSmoke.stdout).text(),
        new Response(voiceSmoke.stderr).text(),
      ])
      // marker 必须逐字匹配，多余stdout也不能冒充Worker入口成功。
      if (voiceExit !== 0 || voiceStdout.trim() !== "voice-worker-probe-ok") {
        throw new Error(voiceStderr.trim() || `voice worker smoke exited ${voiceExit} without marker`)
      }
      console.log("Voice worker smoke test passed")
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  // 单 target 构建结束时立即写证据；archive 打包与 workflow smoke 都消费该文件。
  await writeOpenTuiBuildEvidence(item, name)

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
