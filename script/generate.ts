#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

// 两种Client都从Protocol重生成，统一入口同时覆盖legacy SDK与新客户端。
await $`bun run --cwd packages/client generate`

await $`bun dev generate > ../sdk/openapi.json`.cwd("packages/opencode")

await $`bun ./script/format.ts`
