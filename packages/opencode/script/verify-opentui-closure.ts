#!/usr/bin/env bun

import fs from "node:fs/promises"
import path from "node:path"
import { verifyRemoteAnnotatedTagCommit, verifySourceRevisionAuthorization, type OpenTuiSourceRevisionManifest } from "./opentui-provenance"

const root = path.resolve(import.meta.dir, "../../..")
const version = "0.4.3-smark.4"
const tag = `v${version}`
const repository = "https://github.com/SMARK2022/opentui"
const release = `${repository}/releases/download/${tag}`
const sourceRevisionAuthorized = process.argv.includes("--source-revision-authorized")
// CI在source gitlink更新后必须显式选择此模式，避免release-only校验把新源码误判为伪造发布物。
// 版本、tag和release根必须由同一个常量派生，避免验证器自己拼出跨版本的成功路径。
// URL来源是public fork的immutable release，不接受registry或临时workflow artifact。
// 这条约束保护OpenCode安装图和submodule provenance之间的可追溯关系。
const assets = {
  "@opentui/core": "opentui-core",
  "@opentui/keymap": "opentui-keymap",
  "@opentui/solid": "opentui-solid",
  "@opentui/core-darwin-arm64": "opentui-core-darwin-arm64",
  "@opentui/core-darwin-x64": "opentui-core-darwin-x64",
  "@opentui/core-linux-arm64": "opentui-core-linux-arm64",
  "@opentui/core-linux-arm64-musl": "opentui-core-linux-arm64-musl",
  "@opentui/core-linux-x64": "opentui-core-linux-x64",
  "@opentui/core-linux-x64-musl": "opentui-core-linux-x64-musl",
  "@opentui/core-win32-arm64": "opentui-core-win32-arm64",
  "@opentui/core-win32-x64": "opentui-core-win32-x64",
} as const

const lock = await Bun.file(path.join(root, "bun.lock")).text()
// 先读lock再解析realpath：包目录看似正确时，registry resolution仍可能隐藏在锁文件中。
// 每个family成员都必须同时出现URL key和override value，漏掉任一项都会允许mixed graph。
// 因此这里不是版本检查的重复实现，而是编译前唯一integrity边界。
// package family作为一个闭包验证；任一成员失败都不能输出看似完整的部分evidence。
const packageRoots = await Promise.all(
  Object.entries(assets).map(async ([name, asset]) => {
    const expected = `${release}/${asset}-${version}.tgz`
    // expected URL包含固定tag、asset和version三项，不能只检查公共前缀。
    // 同名asset若来自另一个tag仍是不同ABI来源，必须直接失败。
    // lock必须同时保存release URL和integrity；manifest正确但lock回到registry仍会形成不可复现构建。
    if (!lock.includes(`"${name}@${expected}"`) || !lock.includes(`"${name}": "${expected}"`)) {
      throw new Error(`${name} is not locked to ${expected}`)
    }
    // manifest从实际resolver结果向上定位，不能相信workspace顶层同名目录就是consumer真正加载的副本。
    const packageRoot = await realPackageRoot(name, root)
    const manifest = await Bun.file(path.join(packageRoot, "package.json")).json()
    // packed manifest同时证明name/version和repository owner，避免fork二进制伪装为upstream产物。
    if (manifest.name !== name || manifest.version !== version) {
      throw new Error(`${name} manifest mismatch: ${manifest.name}@${manifest.version}`)
    }
    if (manifest.repository?.url !== repository) {
      throw new Error(`${name} repository mismatch: ${manifest.repository?.url}`)
    }
    return [name, packageRoot] as const
  }),
)

// 入口包、plugin peer和spinner必须落到同一个core realpath；版本号相同但加载两份FFI状态仍不安全。
for (const name of ["@opentui/core", "@opentui/keymap", "@opentui/solid"] as const) {
  // 从root、应用和plugin三个真实consumer起点解析，覆盖hoist在不同package目录下的可见性。
  // 只从root解析一次会遗漏plugin自己的嵌套副本。
  const roots = await Promise.all(
    [root, path.join(root, "packages/opencode"), path.join(root, "packages/plugin")].map((from) =>
      realPackageRoot(name, from),
    ),
  )
  // 版本相同仍可能拥有两套FFI或响应式状态，因此成功条件是object identity对应的唯一realpath。
  if (new Set(roots).size !== 1) throw new Error(`${name} resolves to multiple realpaths: ${roots.join(", ")}`)
}

// 从实际runtime consumer解析而非扫描物理目录；Bun hidden store中的旧副本也会进入compiled graph。
// thirdparty源码不属于consumer graph；root、应用、plugin和OpenTUI renderer必须共享同一Solid owner。
const solidPackageRoot = new Map(packageRoots).get("@opentui/solid")
if (!solidPackageRoot) throw new Error("Installed OpenTUI Solid package is missing from closure")
const solidRoots = await Promise.all(
  [root, path.join(root, "packages/opencode"), path.join(root, "packages/plugin"), solidPackageRoot].map((from) =>
    realPackageRoot("solid-js", from),
  ),
)
// 以realpath为key保存版本，使重复consumer不会稀释真正的第二个Solid owner。
const solidVersions = new Map(
  await Promise.all(
    [...new Set(solidRoots)].map(
      async (directory) => [directory, (await Bun.file(path.join(directory, "package.json")).json()).version] as const,
    ),
  ),
)
// realpath唯一和version唯一是两个独立条件；相同版本的两份Solid仍会分裂响应式owner。
// OpenTUI Solid/keymap精确要求1.9.12；任意嵌套1.9.10都会让响应式owner和renderer运行在不同runtime。
if (new Set(solidRoots).size !== 1 || [...solidVersions.values()].some((item) => item !== "1.9.12")) {
  throw new Error(
    `solid-js closure mismatch: ${solidRoots.map((item) => `${item}@${solidVersions.get(item)}`).join(", ")}`,
  )
}

// gitlink缺失会作为undefined进入同一identity比较并失败，不能回退到submodule当前HEAD自证来源。
// 校验阶段读取index，允许在父commit前审计即将提交的source pin；CI中index与HEAD一致。
const gitlink = (await git(["ls-files", "--stage", "--", "thirdparty/opentui"], root)).trim().split(/\s+/)[1]
if (!gitlink) throw new Error("thirdparty/opentui gitlink is missing")
const sourceManifest = sourceRevisionAuthorized
  ? ((await Bun.file(path.join(import.meta.dir, "opentui-source-revision.json")).json()) as OpenTuiSourceRevisionManifest)
  : undefined
const nestedHead = (await git(["-C", "thirdparty/opentui", "rev-parse", "HEAD"], root)).trim()
const nestedStatus = (await git(["-C", "thirdparty/opentui", "status", "--porcelain"], root)).trim()
if (sourceManifest) {
  // manifest同时固定source和旧release身份；只验证其中一项会允许ABI与源码错配。
  if (sourceManifest.schema !== 1 || sourceManifest.releaseTag !== tag || !/^[0-9a-f]{40}$/.test(sourceManifest.releaseCommit)) {
    throw new Error("invalid OpenTUI source revision manifest")
  }
  verifySourceRevisionAuthorization({ parentGitlink: gitlink, nestedHead, nestedStatus, manifest: sourceManifest })
  // source revision and release identity are independent: the source pin must not replace the immutable tag proof.
  await verifyRemoteAnnotatedTagCommit({ repository, tag: sourceManifest.releaseTag, cwd: root, expectedCommit: sourceManifest.releaseCommit })
} else {
  // remote tag证明发布身份，nested HEAD/status另证本次构建源码；两项证据不能互相替代。
  await verifyRemoteAnnotatedTagCommit({ repository, tag, cwd: root, expectedCommit: gitlink })
  // 初始化后的submodule必须可直接审计同一source；dirty或停在workflow branch tip都不能冒充gitlink证据。
  if (nestedHead !== gitlink || nestedStatus) {
    throw new Error(`initialized OpenTUI submodule is not clean at gitlink: head=${nestedHead} status=${nestedStatus}`)
  }
}

// native hash只针对当前宿主实际解析到的target计算，不能用其他平台的cross-build报告替代。
// 这使closure verifier和build.ts各自拥有独立的target ABI证据，避免同一脚本自证。
const platform = process.platform === "win32" ? "win32" : process.platform
const report = process.report?.getReport()
const header = report && typeof report === "object" && "header" in report ? report.header : undefined
// Node report在TypeScript中只承诺object；先收窄header，避免把验证器自身的类型逃逸带进发布门禁。
const glibcVersionRuntime =
  header && typeof header === "object" && "glibcVersionRuntime" in header ? header.glibcVersionRuntime : undefined
const abi = platform === "linux" && !glibcVersionRuntime ? "-musl" : ""
// native包名由当前宿主ABI派生，避免用已安装但不会被本target加载的另一平台二进制通过门禁。
const nativeName = `@opentui/core-${platform}-${process.arch}${abi}`
const nativeRoot = new Map(packageRoots).get(nativeName)
if (!nativeRoot) throw new Error(`No installed native package for ${nativeName}`)
const nativeFiles = (await fs.readdir(nativeRoot)).filter((file) => /\.(dll|dylib|so)$/.test(file))
// 一个target只能有一个FFI入口；多个文件会使Bun和运行时按目录遍历顺序选择不同ABI。
// 失败必须发生在发布前，不能等到用户启动compiled executable才发现选择漂移。
if (nativeFiles.length !== 1) throw new Error(`${nativeName} contains ${nativeFiles.length} native libraries`)
const nativeFile = path.join(nativeRoot, nativeFiles[0])
const nativeHash = new Bun.CryptoHasher("sha256").update(await Bun.file(nativeFile).arrayBuffer()).digest("hex")
// hash输出进入build evidence，后续可以把installed tarball内容与compiled target报告交叉核对。

console.log(
  // 输出保持单行JSON，workflow和人工报告都能直接保存同一份machine-readable evidence。
  JSON.stringify({
    version,
    tag,
    gitlink,
    sourceRevisionAuthorized,
    packages: packageRoots.length,
    solid: { version: solidVersions.get(solidRoots[0]), realpath: solidRoots[0] },
    native: { name: nativeName, file: nativeFile, sha256: nativeHash },
  }),
)

async function realPackageRoot(name: string, from: string) {
  // 从解析后的entry向上寻找manifest，验证的是实际realpath而不是package.json中的声明路径。
  // 这样可以捕获hoisted、嵌套或symlink导致的重复runtime，而不依赖安装器内部布局。
  // resolution起点就是consumer边界，显式传入from可捕获workspace局部hoist和hidden store漂移。
  const entry = Bun.resolveSync(name, from)
  let directory = path.dirname(await fs.realpath(entry))
  // 只沿解析后entry的祖先查找manifest，不能横向扫描并挑选一个期望版本冒充实际owner。
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json")
    if (await Bun.file(manifest).exists()) return fs.realpath(directory)
    directory = path.dirname(directory)
  }
  throw new Error(`Cannot locate package root for ${name} from ${from}`)
}

async function git(args: string[], cwd: string) {
  // Git命令失败必须原样阻断closure；吞掉stderr会把缺失submodule误报成空值不一致。
  // stdout和stderr并行读取，避免子进程pipe在CI长日志下反向阻塞验证器。
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr || `git ${args.join(" ")} exited ${code}`)
  return stdout
}
