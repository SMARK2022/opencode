#!/usr/bin/env bun
// #267：脚本替代 npm exec 内联调用——版本号不再写死在 scripts 里，随 package.json 单一来源演进
import { $ } from "bun"
import path from "node:path"

// #267：从 package.json 读取 publisher/name/version 生成 VSIX 文件名
// #267：import.meta.dir 定位到 script/ 目录——向上一级才是扩展根，避免依赖进程 cwd
const pkg = await Bun.file(path.join(import.meta.dir, "..", "package.json")).json()
// #267：输出路径使用 pkg 字段避免版本硬编码
const output = path.join("dist", `${pkg.publisher}.${pkg.name}-${pkg.version}.vsix`)

// #267：--no-dependencies 保持 vsce 不打包 node_modules——扩展运行时依赖由 VS Code 宿主提供
await $`bun x @vscode/vsce package --no-dependencies -o ${output}`
