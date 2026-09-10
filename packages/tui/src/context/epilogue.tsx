import { createSimpleContext } from "./helper"

// R19 惰性退出快照：set 接受字符串或 producer——producer 存储而不求值，
// 在退出边界（Tui.run 返回处）才调用，消除 per-part-delta 的 tokenAccounting 热路径。
export const { use: useEpilogue, provider: EpilogueProvider } = createSimpleContext({
  name: "Epilogue",
  init: (props: { set(value?: string | (() => string | undefined)): void }) => props.set,
})
