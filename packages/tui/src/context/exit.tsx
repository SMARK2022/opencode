import { createSimpleContext } from "./helper"

export const ExitSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const

export type Exit = ((reason?: unknown) => void) & {
  message: {
    set: (value?: string) => () => void
    clear: () => void
    get: () => string | undefined
  }
}

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { exit: (reason?: unknown) => void }) => {
    let message: string | undefined
    const store = {
      set: (value?: string) => {
        const prev = message
        message = value
        return () => {
          message = prev
        }
      },
      clear: () => {
        message = undefined
      },
      get: () => message,
    }
    return Object.assign(input.exit, { message: store })
  },
})
