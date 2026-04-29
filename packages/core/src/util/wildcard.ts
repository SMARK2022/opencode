export * as Wildcard from "./wildcard"

import { Wildcard } from "@opencode-ai/schema/wildcard"

// 原 Core 入口保留 Windows 策略；匹配算法只由 Schema 的同一实现承载。
export function match(input: string, pattern: string) {
  return Wildcard.match(input, pattern, process.platform === "win32")
}
