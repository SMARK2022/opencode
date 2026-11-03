#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

// 两种Client均从当前Protocol生成，统一入口不遗漏Native消费者。
await $`bun run --cwd packages/client generate`

await $`bun dev generate > ../sdk/openapi.json`.cwd("packages/opencode")

// 各生成入口自行格式化产物，生成检查不批量改写无关源码。
