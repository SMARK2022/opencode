/** @jsxImportSource @opentui/solid */
import { expect, test as _test } from "bun:test"
// [local-smark] 权威副本已迁移至 packages/tui/test/malformed-sgr-mouse.test.tsx；此处整文件 skip 保留用例索引
const test = _test.skip as typeof _test
import { testRender } from "@opentui/solid"
// [local-smark] V2 TUI 拆分后 guard 迁移至 packages/tui/src/app.tsx，权威测试副本在
// packages/tui/test/malformed-sgr-mouse.test.tsx；本文件因包边界不可反向导入而停用，
// 保留作为历史用例索引，防止用例清单丢失。
const createMalformedSgrMouseGuard = (..._args: unknown[]): any => undefined
