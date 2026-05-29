#!/usr/bin/env bun
import { $ } from "bun"
import path from "node:path"

const pkg = await Bun.file(path.join(import.meta.dir, "..", "package.json")).json()
const output = path.join("dist", `${pkg.publisher}.${pkg.name}-${pkg.version}.vsix`)

await $`bun x @vscode/vsce package --no-dependencies -o ${output}`
