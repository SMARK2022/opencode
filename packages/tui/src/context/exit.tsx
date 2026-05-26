import { createSimpleContext } from "./helper"

// #235：终端驱动退出信号全量注册——SIGINT/SIGTERM/SIGHUP 统一由 app.tsx 消费
export const ExitSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const

export type Exit = (reason?: unknown) => void

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { exit: Exit }) => input.exit,
})
