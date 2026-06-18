#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")
const require = createRequire(import.meta.url)

process.chdir(dir)

await import("./generate.ts")

const versionFromEquals = process.argv.find((arg) => arg.startsWith("--version="))?.replace("--version=", "")
if (versionFromEquals) process.env.OPENCODE_VERSION = versionFromEquals

const versionIndex = process.argv.findIndex((arg) => arg === "--version")
if (versionIndex >= 0 && process.argv[versionIndex + 1]) {
  process.env.OPENCODE_VERSION = process.argv[versionIndex + 1]
}

const { Script } = await import("@opencode-ai/script")
import pkg from "../package.json"

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
const osFilter = process.argv.find((a) => a.startsWith("--os="))?.replace("--os=", "")
const archFilter = process.argv.find((a) => a.startsWith("--arch="))?.replace("--arch=", "")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`bun run --cwd ${appDir} build`
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
  ? allTargets.filter((item) => item.os === osFilter && item.abi === undefined && item.avx2 !== false && (!archFilter || item.arch === archFilter))
  : allTargets

// PvRecorder 的 `.node` 必须按目标平台嵌入；运行时再释放到真实 cache 文件，避免 Bun compile 中 `__dirname` 指向 CI 构建路径。
const pvRecorderNativeFilesForTarget = (item: (typeof allTargets)[number]) => {
  if (item.os === "win32") {
    // Picovoice 在 Windows x64 包目录里使用 `amd64` 命名；这里不能直接复用 Bun target 的 `x64` 字符串。
    if (item.arch === "x64") return ["windows/amd64/pv_recorder.node"]
    // Windows arm64 与 Node/Bun 的 arch 名称一致，保持包内 lib 相对路径即可。
    if (item.arch === "arm64") return ["windows/arm64/pv_recorder.node"]
  }
  if (item.os === "darwin") {
    // macOS Intel 包路径沿用 Picovoice 的 `x86_64`，和 release target 的 `x64` 不同。
    if (item.arch === "x64") return ["mac/x86_64/pv_recorder.node"]
    // Apple Silicon 使用单独 native addon，不能和 x64 通过 Rosetta 路径混用。
    if (item.arch === "arm64") return ["mac/arm64/pv_recorder.node"]
  }
  if (item.os === "linux") {
    // Linux x64 只有 glibc/musl 外层 Bun runtime 不同；Picovoice native 路径本身不区分 libc。
    if (item.arch === "x64") return ["linux/x86_64/pv_recorder.node"]
    if (item.arch === "arm64")
      // 官方包只提供 Raspberry Pi CPU 变体；全部嵌入后运行时再按 /proc/cpuinfo 精确选择。
      return [
        "raspberry-pi/cortex-a53-aarch64/pv_recorder.node",
        "raspberry-pi/cortex-a72-aarch64/pv_recorder.node",
        "raspberry-pi/cortex-a76-aarch64/pv_recorder.node",
      ]
  }
  return []
}

function createPvRecorderNativeFileMap(item: (typeof allTargets)[number]) {
  // `with { type: "file" }` 让 Bun 把 native 二进制作为资源嵌入 exe，而不是让 Picovoice 自己从 node_modules 相对路径加载。
  const pvRecorderLib = path.join(path.dirname(require.resolve("@picovoice/pvrecorder-node/package.json")), "lib")
  const imports = pvRecorderNativeFilesForTarget(item).map((file, index) => {
    // require.resolve 兼容 hoisted workspace 安装；spec 再转成相对路径，交给 Bun.build 嵌入真实 native 文件。
    const spec = path
      .relative(dir, path.join(pvRecorderLib, ...file.split("/")))
      .replaceAll("\\", "/")
    return `import file_${index} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  // key 保持 Picovoice 包内 lib 的相对路径，运行时只需按当前 platform/arch 选同一个稳定字符串。
  const entries = pvRecorderNativeFilesForTarget(item).map((file, index) => `  ${JSON.stringify(file)}: file_${index},`)
  return [...imports, "export default {", ...entries, "}"].join("\n")
}

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
}
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

  const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
  const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
  const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
  const workerPath = "./src/cli/cmd/tui/worker.ts"

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  await Bun.build({
    conditions: ["browser"],
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
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/opencode`,
      execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
      // 生成模块只保存“目标平台可用的 native 资源表”，避免所有平台二进制都被塞进每个 release exe。
      "opencode-pvrecorder.gen.ts": createPvRecorderNativeFileMap(item),
    },
    entrypoints: [
      "./src/index.ts",
      parserWorker,
      workerPath,
      ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
      // 虚拟模块必须作为 entrypoint 交给 Bun.build，否则 dynamic import 在 compiled exe 内找不到资源映射。
      "opencode-pvrecorder.gen.ts",
    ],
    define: {
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MIGRATIONS: JSON.stringify(migrations),
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      // 运行时用该常量禁止回退到 @picovoice 的 node_modules 相对路径，防止重新暴露 CI 绝对路径 bug。
      OPENCODE_COMPILED: "true",
    },
  })

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/opencode`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
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
