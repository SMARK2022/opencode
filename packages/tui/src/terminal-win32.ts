import { dlopen, ptr } from "bun:ffi"
import type { ReadStream } from "node:tty"

const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001

const kernel = () =>
  dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
    FlushConsoleInputBuffer: { args: ["ptr"], returns: "i32" },
    // FreeConsole：使调用进程脱离当前控制台。daemon worker 用它从源头阻断
    // CTRL_C_EVENT 送达（等价 Unix detached 进程组），是 Windows 上唯一可靠的
    // 进程级隔离手段——SetConsoleCtrlHandler(NULL, TRUE) 在 Bun 上无效，因为
    // Bun 自行接管 Ctrl+C 且绕过 console control handler 链（已实证）。
    FreeConsole: { args: [], returns: "i32" },
  })

let k32: ReturnType<typeof kernel> | undefined

function load() {
  if (process.platform !== "win32") return false
  try {
    k32 ??= kernel()
    return true
  } catch {
    return false
  }
}

/**
 * Clear ENABLE_PROCESSED_INPUT on the console stdin handle.
 */
export function win32DisableProcessedInput() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)
  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return

  const mode = buf[0]!
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
  k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
}

/**
 * Discard any queued console input (mouse events, key presses, etc.).
 */
export function win32FlushInputBuffer() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  k32!.symbols.FlushConsoleInputBuffer(handle)
}

/**
 * Detach the calling process from the current console (process-level, not console-global).
 *
 * The daemon worker shares the same Windows console as the TUI. When the user
 * presses Ctrl+C, the console broadcasts CTRL_C_EVENT to every attached process;
 * the worker has no (reliable) signal handler to intercept it, and Bun's default
 * behaviour terminates the process immediately — killing the daemon even when it
 * is serving an active session, violating the "daemon exits by idle / activity"
 * design.
 *
 * Unlike the TUI-side win32InstallCtrlCGuard (which toggles ENABLE_PROCESSED_INPUT,
 * a console-global flag), this function calls FreeConsole so the worker process
 * detaches from the console entirely, cutting off event delivery at the source.
 * Unix achieves the same effect via detached:true (separate process group);
 * Windows cannot use detached:true (Bun #31603: detached child is bound to a
 * kill-on-close job object and dies when the parent exits), so FreeConsole is
 * the equivalent path.
 *
 * Does not check process.stdin.isTTY: the worker's stdin is "ignore" (not a TTY)
 * but it is still attached to the console inherited from the launcher — which is
 * exactly why Ctrl+C reaches it. SetConsoleMode depends on a stdin handle hence
 * checks isTTY; FreeConsole operates on the process attachment and does not.
 *
 * Side effect: console stdio handles become invalid for the calling process.
 * In the default mode worker logs go to a file (log.ts init print=false uses
 * createWriteStream), so they are unaffected; only --print-logs debug mode writes
 * to stderr, which is why worker.ts gates this call behind !printLogs.
 */
export function win32DetachConsole() {
  if (process.platform !== "win32") return
  if (!load()) return
  k32!.symbols.FreeConsole()
}

let unhook: (() => void) | undefined

/**
 * Keep ENABLE_PROCESSED_INPUT disabled.
 *
 * On Windows, Ctrl+C becomes a CTRL_C_EVENT (instead of stdin input) when
 * ENABLE_PROCESSED_INPUT is set. Various runtimes can re-apply console modes
 * (sometimes on a later tick), and the flag is console-global, not per-process.
 *
 * We combine:
 * - A `setRawMode(...)` hook to re-clear after known raw-mode toggles.
 * - A low-frequency poll as a backstop for native/external mode changes.
 */
export function win32InstallCtrlCGuard() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return
  if (unhook) return unhook

  const stdin = process.stdin as ReadStream
  const original = stdin.setRawMode

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)

  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
  const initial = buf[0]!

  const enforce = () => {
    if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
    const mode = buf[0]!
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
    k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
  }

  // Some runtimes can re-apply console modes on the next tick; enforce twice.
  const later = () => {
    enforce()
    setImmediate(enforce)
  }

  let wrapped: ReadStream["setRawMode"] | undefined

  if (typeof original === "function") {
    wrapped = (mode: boolean) => {
      const result = original.call(stdin, mode)
      later()
      return result
    }

    stdin.setRawMode = wrapped
  }

  // Ensure it's cleared immediately too (covers any earlier mode changes).
  later()

  const interval = setInterval(enforce, 100)
  interval.unref()

  let done = false
  unhook = () => {
    if (done) return
    done = true

    clearInterval(interval)
    if (wrapped && stdin.setRawMode === wrapped) {
      stdin.setRawMode = original
    }

    k32!.symbols.SetConsoleMode(handle, initial)
    unhook = undefined
  }

  return unhook
}
