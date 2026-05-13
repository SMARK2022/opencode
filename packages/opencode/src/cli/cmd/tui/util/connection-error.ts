export function isConnectionError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return true
  if (!(error instanceof Error)) return false

  // Different runtimes surface the same dead-daemon condition with different
  // strings.  Keep the classifier intentionally small and local to the TUI: it
  // is only used to decide whether to wait for daemon recovery instead of
  // treating a transient connection loss as a fatal application error.
  return [
    "network error",
    "fetch failed",
    "Unable to connect",
    "Could not connect",
    "ECONNREFUSED",
    "ECONNRESET",
  ].some((item) => error.message.includes(item))
}

export * as ConnectionError from "./connection-error"
