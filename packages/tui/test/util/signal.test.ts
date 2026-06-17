import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createTokenFlowPulse } from "../../src/util/signal"

test("token flow pulse highlights input and output increments before resetting", async () => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const [usage, setUsage] = createSignal<{ input: number; output: number } | undefined>({ input: 0, output: 0 })
      const flow = createTokenFlowPulse(usage, 20)

      queueMicrotask(async () => {
        try {
          expect(flow()).toEqual({ input: false, output: false })

          setUsage({ input: 12, output: 0 })
          await Bun.sleep(0)
          expect(flow()).toEqual({ input: true, output: false })

          setUsage({ input: 12, output: 7 })
          await Bun.sleep(0)
          expect(flow()).toEqual({ input: true, output: true })

          await Bun.sleep(30)
          expect(flow()).toEqual({ input: false, output: false })

          setUsage(undefined)
          await Bun.sleep(0)
          expect(flow()).toEqual({ input: false, output: false })

          dispose()
          resolve()
        } catch (error) {
          dispose()
          reject(error)
        }
      })
    })
  })
})
