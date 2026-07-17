#!/usr/bin/env bun

import path from "node:path"

const raw = process.argv[2]
if (!raw) {
  console.error("Usage: bun run script/upgrade-opentui.ts <version>")
  process.exit(1)
}

const ver = raw.replace(/^v/, "")
// 只有已经发布并完成attestation的版本才能进入映射；拒绝任意拼接URL，避免写出不可安装lockfile。
if (ver !== "0.4.3-smark.1") {
  console.error(`Unsupported OpenTUI release: ${ver}`)
  process.exit(1)
}
const root = path.resolve(import.meta.dir, "..")
// thirdparty/opentui是独立Git仓库，root dependency维护命令只能读取其release身份，不能改写源码manifest。
const skip = new Set([".git", ".opencode", ".turbo", "dist", "node_modules", "thirdparty"])
const keys = ["@opentui/core", "@opentui/keymap", "@opentui/solid"] as const
const release = `https://github.com/SMARK2022/opentui/releases/download/v${ver}`
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
// asset表是release contract的完整枚举；动态发现会让缺失平台在本机静默通过。
// 文件名和package name分开记录，避免scope字符进入GitHub asset名称。

// Windows 上 Bun.Glob 返回的路径可能使用 \ 分隔符，必须同时处理 / 和 \
const files = (await Array.fromAsync(new Bun.Glob("**/package.json").scan({ cwd: root }))).filter(
  (file) => !file.split(/[\\/]/).some((part) => skip.has(part)),
)

const setVersion = (cur: string) => {
  // workspace和catalog引用保留其owner；只有真实semver/range由该维护命令升级。
  // range前缀保持不变，plugin peer仍表达兼容下界而不是强制精确版本。
  if (cur === "catalog:" || cur.startsWith("workspace:")) return cur
  if (cur.startsWith(">=")) return `>=${ver}`
  if (cur.startsWith("^")) return `^${ver}`
  if (cur.startsWith("~")) return `~${ver}`
  return ver
}

const editDeps = (obj: unknown) => {
  // dependency字段可能缺失或来自任意JSON，先收窄object再更新已知OpenTUI key。
  // 不创建原本不存在的dependency section，避免维护命令扩大manifest职责。
  if (!obj || typeof obj !== "object") return false
  const map = obj as Record<string, unknown>
  return keys
    .map((key) => {
      const cur = map[key]
      if (typeof cur !== "string") return false
      const next = setVersion(cur)
      if (next === cur) return false
      map[key] = next
      return true
    })
    .some(Boolean)
}

const editCatalog = (obj: unknown) => {
  // catalog只保存semantic identity，URL source继续由root override唯一拥有。
  if (!obj || typeof obj !== "object") return false
  const map = obj as Record<string, unknown>
  return keys
    .map((key) => {
      const cur = map[key]
      if (typeof cur !== "string" || cur === ver) return false
      map[key] = ver
      return true
    })
    .some(Boolean)
}

const editOverrides = (obj: unknown) => {
  // override owner只存在于root；其他package没有该字段时保持无变化。
  if (!obj || typeof obj !== "object") return false
  const map = obj as Record<string, unknown>
  // 11个override共同拥有同一ABI闭包；一次替换避免保留registry native形成mixed graph。
  return Object.entries(assets)
    .map(([name, asset]) => {
      const next = `${release}/${asset}-${ver}.tgz`
      if (map[name] === next) return false
      map[name] = next
      return true
    })
    .some(Boolean)
}

const out = (
  await Promise.all(
    files.map(async (rel) => {
      // 每个manifest只序列化一次，保证catalog、override和peer更新作为同一原子文件变化出现。
      const file = path.join(root, rel)
      const txt = await Bun.file(file).text()
      const json = JSON.parse(txt)
      const hit = [
        editCatalog(json.workspaces?.catalog),
        editOverrides(json.overrides),
        editDeps(json.dependencies),
        editDeps(json.devDependencies),
        editDeps(json.peerDependencies),
      ].some(Boolean)
      // 未命中OpenTUI概念的manifest保持byte-identical，减少无关workspace diff。
      if (!hit) return null
      await Bun.write(file, `${JSON.stringify(json, null, 2)}\n`)
      return rel
    }),
  )
).filter((item): item is string => item !== null)

if (out.length === 0) {
  console.log("No opentui deps found")
  process.exit(0)
}

console.log(`Updated opentui to ${ver} in:`)
for (const file of out) {
  console.log(`- ${file}`)
}
