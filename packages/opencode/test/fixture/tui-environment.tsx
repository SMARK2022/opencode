/** @jsxImportSource @opentui/solid */
import {
  TuiPathsProvider,
  TuiStartupProvider,
  TuiTerminalEnvironmentProvider,
  type TuiPaths,
} from "@opencode-ai/tui/context/runtime"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import path from "path"
import type { ParentProps } from "solid-js"

export function TestTuiContexts(
  props: ParentProps<{
    cwd?: string
    directory?: string
    paths?: Partial<TuiPaths>
  }>,
) {
  const paths = {
    cwd: props.cwd ?? props.directory ?? "/tmp/opencode/packages/opencode",
    home: "/tmp/opencode/home",
    state: "/tmp/opencode/state",
    worktree: "/tmp/opencode",
    ...props.paths,
  }
  mkdirSync(paths.state, { recursive: true })
  if (!existsSync(path.join(paths.state, "kv.json"))) writeFileSync(path.join(paths.state, "kv.json"), "{}")

  return (
    <TuiPathsProvider value={paths}>
      <TuiTerminalEnvironmentProvider value={{ platform: "linux" }}>
        <TuiStartupProvider value={{ skipInitialLoading: false }}>{props.children}</TuiStartupProvider>
      </TuiTerminalEnvironmentProvider>
    </TuiPathsProvider>
  )
}
