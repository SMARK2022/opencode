/** @jsxImportSource @opentui/solid */
import {
  TuiPathsProvider,
  TuiStartupProvider,
  TuiTerminalEnvironmentProvider,
  type TuiPaths,
} from "../../src/context/runtime"
import type { ParentProps } from "solid-js"
import { EpilogueProvider } from "../../src/context/epilogue"

export function TestTuiContexts(
  props: ParentProps<{
    cwd?: string
    directory?: string
    paths?: Partial<TuiPaths>
  }>,
) {
  return (
    <TuiPathsProvider
      value={{
        cwd: props.cwd ?? props.directory ?? "/tmp/opencode/packages/tui",
        home: "/tmp/opencode/home",
        state: "/tmp/opencode/state",
        worktree: "/tmp/opencode",
        ...props.paths,
      }}
    >
      <TuiTerminalEnvironmentProvider value={{ platform: "linux" }}>
        {/* headless环境补齐App已有的提示上下文，不把正常停机提示当退出错误。 */}
        <EpilogueProvider set={() => {}}>
          <TuiStartupProvider value={{ skipInitialLoading: false }}>{props.children}</TuiStartupProvider>
        </EpilogueProvider>
      </TuiTerminalEnvironmentProvider>
    </TuiPathsProvider>
  )
}
