#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"
import { createRequire } from "module"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { resolveInstallTarget } from "./install-target"
import type { BunPlugin } from "bun"

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

async function createSharpNativeFileMap(item: (typeof allTargets)[number]) {
  // Sharp用linuxmusl而Bun target用linux+abi描述；资源包和运行时loader必须采用同一个target名。
  // baseline与AVX2产物共享同一官方addon；CPU能力仍由Sharp官方loader在运行时判定。
  const target = item.os === "linux" ? `${item.abi === "musl" ? "linuxmusl" : "linux"}-${item.arch}` : `${item.os}-${item.arch}`
  // Windows把libvips DLL放在addon包内；Linux/macOS则依赖独立的同target libvips包。
  // 只收集当前target，避免单个可执行文件携带其他平台永远不可达的native资源。
  const packages = [`@img/sharp-${target}`, ...(item.os === "win32" ? [] : [`@img/sharp-libvips-${target}`])]
  const files = (
    await Promise.all(
      packages.map(async (name) => {
        const root = path.dirname(require.resolve(`${name}/package`))
        return (await Array.fromAsync(new Bun.Glob("lib/**/*").scan({ cwd: root, onlyFiles: true }))).map((file) => ({
          absolute: path.join(root, ...file.split("/")),
          relative: `${name}/${file.replaceAll("\\", "/")}`,
        }))
      }),
    )
  ).flat()
  const addons = files.filter((file) => file.relative.endsWith(".node"))
  const libraries = files.filter((file) => /\.(?:dll|dylib|so(?:\..*)?)$/.test(file.relative))
  // 动态require不会告诉Bun缺了哪个transitive文件；构建时先锁住每个target恰好一个addon和必要shared library。
  // addon多于一个同样视为错误，否则运行时选择将依赖文件遍历顺序而失去确定性。
  if (addons.length !== 1 || libraries.length === 0)
    throw new Error(`Incomplete Sharp native package for ${target}: ${addons.length} addon(s), ${libraries.length} library file(s)`)
  const imports = files.map((file, index) => {
    // 保留@img包内相对布局，native RPATH/@loader_path才能从addon定位到对应libvips。
    const spec = path.relative(dir, file.absolute).replaceAll("\\", "/")
    return `import file_${index} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  return {
    source: [
      ...imports,
      "export default {",
      `  target: ${JSON.stringify(target)},`,
      `  version: ${JSON.stringify(pkg.optionalDependencies.sharp)},`,
      `  addon: ${JSON.stringify(addons[0].relative)},`,
      "  files: {",
      ...files.map((file, index) => `    ${JSON.stringify(file.relative)}: file_${index},`),
      "  },",
      "}",
    ].join("\n"),
  }
}

function replaceSharpLoader(source: string, before: string, after: string) {
  // Sharp升级若改变loader结构必须显式失败；宽松replace会生成“构建成功、运行缺addon”的假产物。
  // 精确一次匹配同时防止补丁重复应用，保持打包链只有一个native入口。
  if (source.indexOf(before) === -1 || source.indexOf(before) !== source.lastIndexOf(before))
    throw new Error(`Sharp 0.34.5 loader changed; expected one occurrence of: ${before}`)
  return source.replace(before, after)
}

const sharpPlugin: BunPlugin = {
  name: "opencode-sharp-native",
  setup(build) {
    build.onLoad({ filter: /[\\/]sharp[\\/]lib[\\/]sharp\.js$/ }, async (args) => ({
      // 绝对cache路径会改变path字符串，因此同时把上游CPU guard改为按runtime判断，不能绕过x64-v2检查。
      // cache路径放在搜索首位，但其余官方路径仍由Sharp保留用于普通源码运行和诊断。
      // 这里不捕获加载错误；addon或libvips缺失必须由唯一主链明确失败。
      contents: replaceSharpLoader(
        replaceSharpLoader(
          await Bun.file(args.path).text(),
          "const paths = [",
          "const paths = [globalThis.__OPENCODE_SHARP_NATIVE_PATH,",
        ),
        "path.startsWith('@img/sharp-linux-x64')",
        "runtimePlatform === 'linux-x64'",
      ),
      loader: "js",
    }))
  },
}

const sharpSmokeSource = `
import { Image } from "./src/image/image"
import { TestConfig } from "./test/fixture/config"
import { Effect, Layer } from "effect"
import { PartID, MessageID, SessionID } from "./src/session/schema"

const input = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGP4z8DQAMIMMAYAOOgF/REzMMkAAAAASUVORK5CYII=", "base64")
const result = await Effect.runPromise(Effect.gen(function* () {
  const image = yield* Image.Service
  return yield* image.normalize({
    id: PartID.make("prt_sharp_smoke"),
    messageID: MessageID.make("msg_sharp_smoke"),
    sessionID: SessionID.make("ses_sharp_smoke"),
    type: "file",
    mime: "image/png",
    url: "data:image/png;base64," + input.toString("base64"),
  })
}).pipe(Effect.provide(Image.layer.pipe(Layer.provide(TestConfig.layer({
  get: () => Effect.succeed({ attachment: { image: { auto_resize: true, max_width: 1, max_height: 1, max_base64_bytes: 100000 } } }),
}))))))
const data = Buffer.from(result.url.slice(result.url.indexOf(",") + 1), "base64")
const sharp = (await import("sharp")).default
const metadata = await sharp(data).metadata()
if (metadata.width !== 1 || metadata.height !== 1 || data.length === 0) throw new Error("Compiled Image.Service smoke failed")
console.log(JSON.stringify({ mime: result.mime, width: metadata.width, height: metadata.height, bytes: data.length }))
`

async function runSharpSmoke(item: (typeof allTargets)[number], name: string, sharpFiles: string) {
  // 交叉架构只能做上面的静态资源断言；native smoke仅在当前宿主可执行的target运行。
  // 不尝试模拟异构native ABI，因为那会制造“测试通过”但目标机器无法加载的伪信号。
  if (item.os !== process.platform || item.arch !== process.arch || item.abi) return
  const extension = item.os === "win32" ? ".exe" : ""
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opencode-sharp-smoke-"))
  const outfile = path.join(root, `sharp-smoke${extension}`)
  const cache = path.join(root, "cache")
  await fs.promises.mkdir(cache)
  try {
    // Smoke复用正式Image.Service和同一虚拟资源表，禁止用裸sharp示例掩盖生产loader接线错误。
    // 强制2x2缩到1x1，使测试必经metadata、resize、encode，而非命中小图原样返回。
    const result = await Bun.build({
      conditions: ["browser"],
      tsconfig: "./tsconfig.json",
      plugins: [sharpPlugin],
      compile: { target: name.replace(pkg.name, "bun") as any, outfile, autoloadBunfig: false, autoloadDotenv: false },
      files: { "opencode-sharp.gen.ts": sharpFiles, "opencode-sharp-smoke.gen.ts": sharpSmokeSource },
      entrypoints: ["opencode-sharp-smoke.gen.ts", "opencode-sharp.gen.ts"],
      define: { OPENCODE_COMPILED: "true", OPENCODE_VERSION: `'${Script.version}'` },
    })
    if (!result.success) throw new AggregateError(result.logs, "Failed to build compiled Sharp smoke")
    const run = async () => {
      // 独立cache确保每次build都覆盖首次释放，而不是误用开发机以前留下的native文件。
      // 子进程不共享内存，两个run才能真实覆盖跨进程同时创建同一cache文件的竞争。
      const proc = Bun.spawn([outfile], {
        cwd: cache,
        env: { ...process.env, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) throw new Error(stderr || stdout || `Sharp smoke exited ${code}`)
    }
    // 两个首次启动进程锁住Windows rename loser路径；第三次运行验证已落盘cache可复用。
    // 任一子进程失败都会拒绝整个构建，发布物不会退化为运行时才发现缺少Sharp。
    await Promise.all([run(), run()])
    await run()
  } finally {
    // Windows可能在子进程退出后短暂保留exe/DLL句柄；smoke位于系统tmp，清理失败不能污染release目录或误判产品构建。
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
}

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  // 只安装目标 OS/arch 的原生变体，避免在 macOS 上下载 win32 包触发 bun 的 IntegrityCheckFailed
  const { os: installOs, cpu: installCpu } = resolveInstallTarget(osFilter, archFilter, singleFlag)

  // bun 不会在完整性校验失败时自动重试（oven-sh/bun#26879）；
  // 手动重试并清缓存，防止损坏的缓存 tarball 阻断 CI
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await $`bun install --os="${installOs}" --cpu="${installCpu}" @opentui/core@${pkg.dependencies["@opentui/core"]}`
      await $`bun install --os="${installOs}" --cpu="${installCpu}" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
      break
    } catch (e) {
      if (attempt === 3) throw e
      console.error(`bun install failed (attempt ${attempt}/3), clearing cache and retrying...`, e)
      await $`bun pm cache rm`.quiet().nothrow()
    }
  }
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
  const sharpFiles = (await createSharpNativeFileMap(item)).source

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  const result = await Bun.build({
    conditions: ["browser"],
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
      ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
      // 生成模块只保存“目标平台可用的 native 资源表”，避免所有平台二进制都被塞进每个 release exe。
      "opencode-pvrecorder.gen.ts": createPvRecorderNativeFileMap(item),
      // Sharp 的动态 addon/libvips require无法被Bun静态发现，必须按target显式嵌入完整native布局。
      "opencode-sharp.gen.ts": sharpFiles,
    },
    entrypoints: [
      "./src/index.ts",
      parserWorker,
      workerPath,
      ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
      // 虚拟模块必须作为 entrypoint 交给 Bun.build，否则 dynamic import 在 compiled exe 内找不到资源映射。
      "opencode-pvrecorder.gen.ts",
      "opencode-sharp.gen.ts",
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
  // 异构target无法在当前宿主执行，但编译失败仍必须阻止发布该target的空壳目录。
  // 只把success交给后续smoke会掩盖跨架构解析错误，因此这里是生产构建的硬门槛。
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${name}`)

  await runSharpSmoke(item, name, sharpFiles)

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
