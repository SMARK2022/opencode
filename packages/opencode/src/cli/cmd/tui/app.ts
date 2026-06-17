import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { run } from "../../../../../tui/src/app"
import type { TuiInput } from "../../../../../tui/src/app"

export { run }
export type { TuiInput }

export function tui(input: TuiInput) {
  return Effect.runPromise(run(input).pipe(Effect.provide(Global.defaultLayer)))
}
