import type { BunPlugin } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

type Target = { os: string; arch: "arm64" | "x64"; abi?: "musl" }
const dir = path.resolve(import.meta.dir, "..")
const require = createRequire(import.meta.url)
const sharpRequire = createRequire(require.resolve("sharp/package.json"))
const metadata = sharpRequire("./package.json") as { version: string; optionalDependencies: Record<string, string> }

export async function createSharpNativeFileMap(item: Target) {
  const target = `${item.os === "linux" && item.abi === "musl" ? "linuxmusl" : item.os}-${item.arch}`
  const addonPackage = `@img/sharp-${target}`
  // 支持矩阵取自当前Sharp包声明，未发布的目标不伪造addon或阻断其他平台构建。
  if (!Object.hasOwn(metadata.optionalDependencies, addonPackage))
    return {
      source: `export default ${JSON.stringify({ target, version: metadata.version, addon: null, files: {} })}`,
      supported: false,
    }
  const packages = [addonPackage, ...(item.os === "win32" ? [] : [`@img/sharp-libvips-${target}`])]
  const files = (
    await Promise.all(
      packages.map(async (name) => {
        const root = path.dirname(sharpRequire.resolve(`${name}/package`))
        return (await Array.fromAsync(new Bun.Glob("lib/**/*").scan({ cwd: root, onlyFiles: true }))).map((file) => ({
          absolute: path.join(root, file),
          relative: `${name}/${file.replaceAll("\\", "/")}`,
        }))
      }),
    )
  ).flat()
  const addons = files.filter((file) => file.relative.endsWith(".node"))
  const libraries = files.filter((file) => /\.(?:dll|dylib|so(?:\..*)?)$/.test(file.relative))
  // 完整相对布局同时满足RPATH和Windows DLL搜索；有addon但无依赖库不能当成成功构建。
  if (addons.length !== 1 || libraries.length === 0) throw new Error(`Incomplete Sharp native package for ${target}`)
  const imports = files.map((file, index) => {
    const spec = path.relative(dir, file.absolute).replaceAll("\\", "/")
    return `import file_${index} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  return {
    supported: true,
    source: [
      ...imports,
      "export default {",
      `target: ${JSON.stringify(target)}, version: ${JSON.stringify(metadata.version)}, addon: ${JSON.stringify(addons[0].relative)},`,
      "files: {",
      ...files.map((file, index) => `${JSON.stringify(file.relative)}: file_${index},`),
      "},",
      "}",
    ].join("\n"),
  }
}

export const sharpPlugin: BunPlugin = {
  name: "opencode-sharp-native",
  setup(build) {
    build.onLoad({ filter: /[\\/]sharp[\\/]lib[\\/]sharp\.js$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const before = "const paths = ["
      // 0.34.5的绝对释放路径也必须执行Linux x64 CPU检查，不能因改写require路径绕过原guard。
      const guard = "path.startsWith('@img/sharp-linux-x64')"
      if (source.indexOf(before) === -1 || source.indexOf(before) !== source.lastIndexOf(before))
        throw new Error(`Sharp ${metadata.version} loader changed`)
      if (source.indexOf(guard) === -1 || source.indexOf(guard) !== source.lastIndexOf(guard))
        throw new Error(`Sharp ${metadata.version} CPU guard changed`)
      return {
        contents: source
          .replace(before, "const paths = [globalThis.__OPENCODE_SHARP_NATIVE_PATH,")
          .replace(guard, "runtimePlatform === 'linux-x64'"),
        loader: "js",
      }
    })
  },
}

export async function runSharpSmoke(item: Target, target: string, files: string, version: string) {
  if (item.os !== process.platform || item.arch !== process.arch || item.abi) return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-sharp-smoke-"))
  const outfile = path.join(root, `sharp-smoke${item.os === "win32" ? ".exe" : ""}`)
  const sharp = (await import("sharp")).default
  // TIFF强制经过共享Sharp adapter，编译验证不能只检查图片metadata或绕过真实归一化服务。
  const input = await sharp(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGP4z8DQAMIMMAYAOOgF/REzMMkAAAAASUVORK5CYII=",
      "base64",
    ),
  )
    .tiff()
    .toBuffer()
  const source = `
import { Image } from "./src/image/image"
import { TestConfig } from "./test/fixture/config"
import { Effect, Layer } from "effect"
import { PartID, MessageID, SessionID } from "./src/session/schema"
const result = await Effect.runPromise(Effect.gen(function* () {
  const image = yield* Image.Service
  return yield* image.normalize({ id: PartID.make("prt_sharp_smoke"), messageID: MessageID.make("msg_sharp_smoke"), sessionID: SessionID.make("ses_sharp_smoke"), type: "file", mime: "image/tiff", url: "data:image/tiff;base64," + ${JSON.stringify(input.toString("base64"))} })
}).pipe(Effect.provide(Image.layer.pipe(Layer.provide(TestConfig.layer({ get: () => Effect.succeed({ attachment: { image: { auto_resize: true, max_width: 1, max_height: 1, max_base64_bytes: 100000 } } }) }))))))
const data = Buffer.from(result.url.slice(result.url.indexOf(",") + 1), "base64")
const sharp = (await import("sharp")).default
const metadata = await sharp(data).metadata()
if (metadata.width !== 1 || metadata.height !== 1 || data.length === 0) throw new Error("Compiled Image.Service smoke failed")
console.log(JSON.stringify({ mime: result.mime, width: metadata.width, height: metadata.height, bytes: data.length }))
`
  try {
    const result = await Bun.build({
      conditions: ["bun", "node"],
      tsconfig: "./tsconfig.json",
      plugins: [sharpPlugin],
      compile: { target: target as Bun.Build.CompileTarget, outfile, autoloadBunfig: false, autoloadDotenv: false },
      files: { "opencode-sharp.gen.ts": files, "opencode-sharp-smoke.gen.ts": source },
      entrypoints: ["opencode-sharp-smoke.gen.ts", "opencode-sharp.gen.ts"],
      define: { OPENCODE_COMPILED: "true", OPENCODE_VERSION: JSON.stringify(version) },
    })
    if (!result.success) throw new AggregateError(result.logs, "Failed to build compiled Sharp smoke")
    const run = async () => {
      // 只使用smoke自己的目录；即使维护者在本机build，也不借用其业务数据库、锁或全局配置。
      const child = Bun.spawn([outfile], {
        cwd: root,
        env: {
          ...process.env,
          XDG_CACHE_HOME: path.join(root, "cache"),
          LOCALAPPDATA: root,
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          OPENCODE_DB: path.join(root, "isolated.db"),
          OPENCODE_LOCK_PATH: path.join(root, "locks"),
          OPENCODE_CONFIG: "",
          OPENCODE_CONFIG_CONTENT: "{}",
          OPENCODE_CONFIG_DIR: path.join(root, "config"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (code !== 0) throw new Error(stderr || stdout || `Sharp smoke exited ${code}`)
    }
    // 两个首次启动验证原子释放竞争，第三次验证同版本资源复用。
    await Promise.all([run(), run()])
    await run()
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
}
