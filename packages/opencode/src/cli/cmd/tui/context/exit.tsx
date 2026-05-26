import { useRenderer } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { win32FlushInputBuffer } from "../win32"
import * as Log from "@opencode-ai/core/util/log"
import { onCleanup } from "solid-js"

const log = Log.create({ service: "tui" })
export const ExitSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const

type Exit = ((reason?: unknown) => Promise<void>) & {
  message: {
    set: (value?: string) => () => void
    clear: () => void
    get: () => string | undefined
  }
}

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { onBeforeExit?: () => Promise<void>; onExit?: () => Promise<void> }) => {
    const renderer = useRenderer()
    let message: string | undefined
    let task: Promise<void> | undefined
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
    const exit: Exit = Object.assign(
      (reason?: unknown) => {
        if (task) return task
        task = (async () => {
          log.info("tui exit requested", { reason: exitReason(reason) })
          await input.onBeforeExit?.()
          // Reset window title before destroying renderer
          renderer.setTerminalTitle("")
          renderer.destroy()
          log.info("tui renderer destroyed")
          win32FlushInputBuffer()
          if (reason) {
            const formatted = FormatError(reason) ?? FormatUnknownError(reason)
            if (formatted) {
              process.stderr.write(formatted + "\n")
            }
          }
          const text = store.get()
          if (text) process.stdout.write(text + "\n")
          await input.onExit?.()
          log.info("tui exit completed")
        })()
        return task
      },
      {
        message: store,
      },
    )
    const signalHandlers = ExitSignals.map((signal) => {
      const handler = () => {
        log.info("tui exit signal received", { signal })
        void exit()
      }
      process.on(signal, handler)
      return () => process.off(signal, handler)
    })
    onCleanup(() => {
      for (const remove of signalHandlers) remove()
    })
    return exit
  },
})

function exitReason(reason: unknown) {
  if (reason === undefined) return "normal"
  if (reason instanceof Error) return reason.name || "Error"
  return typeof reason
}
