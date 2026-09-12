import { Effect, Layer } from "effect"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"

// 反馈测试替换外部进程边界，仍执行真实mutation/formatter结果投影；意外调用其它能力会显式失败。
export const feedbackLsp = Layer.mock(LSP.Service, {
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  hasClients: () => Effect.succeed(false),
  touchFile: () => Effect.void,
  diagnostics: () => Effect.succeed({}),
})

// 常态分支不执行外部formatter；需要文本变化的切片使用各文件已有的受控格式化层。
export const feedbackFormat = Layer.mock(Format.Service, {
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  file: () => Effect.succeed(false),
})

