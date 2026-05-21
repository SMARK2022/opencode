export type PendingToolInputStats = {
  filePath?: string
  fileCount: number
  added: number
  removed: number
}

export const PENDING_TOOL_INPUT_PROGRESS_INTERVAL = 200

export function createPendingToolInputParser(tool: string) {
  if (tool === "apply_patch") return createApplyPatchInputParser()
  if (tool === "edit") return createEditInputParser()
  if (tool === "write") return createWriteInputParser()
  return {
    push(_input: string) {},
    stats: () => undefined,
  }
}

function createEditInputParser() {
  let filePath = ""
  const oldString = createLineCounter()
  const newString = createLineCounter()
  const scanner = createJsonStringFieldScanner(["filePath", "oldString", "newString"], (field, value) => {
    if (field === "filePath") filePath += value
    if (field === "oldString") oldString.push(value)
    if (field === "newString") newString.push(value)
  })
  return {
    push: scanner.push,
    stats: () => pendingStats(filePath, filePath ? 1 : 0, newString.count(), oldString.count()),
  }
}

function createWriteInputParser() {
  let filePath = ""
  const content = createLineCounter()
  const scanner = createJsonStringFieldScanner(["filePath", "content"], (field, value) => {
    if (field === "filePath") filePath += value
    if (field === "content") content.push(value)
  })
  return {
    push: scanner.push,
    stats: () => pendingStats(filePath, filePath ? 1 : 0, content.count(), 0),
  }
}

function createApplyPatchInputParser() {
  const patch = createPatchStatsParser()
  const scanner = createJsonStringFieldScanner(["patchText"], (_, value) => patch.push(value))
  return {
    push: scanner.push,
    stats: patch.stats,
  }
}

function pendingStats(filePath: string, fileCount: number, added: number, removed: number) {
  if (!filePath && fileCount === 0 && added === 0 && removed === 0) return undefined
  return { filePath: filePath || undefined, fileCount, added, removed }
}

function createLineCounter() {
  let chars = 0
  let newlines = 0
  let tail = 0
  return {
    push(value: string) {
      for (const char of value) {
        chars++
        if (char === "\n") {
          newlines++
          tail = 0
          continue
        }
        tail++
      }
    },
    count() {
      if (chars === 0) return 0
      return newlines + (tail > 0 ? 1 : 0)
    },
  }
}

function createJsonStringFieldScanner(fields: readonly string[], onValue: (field: string, value: string) => void) {
  // Pending tool arguments are not valid JSON until the model finishes the
  // tool call, so the TUI scans only string fields it can display and never
  // reparses the accumulated raw buffer on every streamed delta.
  const wanted = new Set(fields)
  let pendingKey = ""
  let expectingValueFor = ""
  let activeField = ""
  let key = ""
  let inString = false
  let escaping = false
  let unicode: string | undefined

  function pushDecoded(value: string) {
    if (activeField) {
      onValue(activeField, value)
      return
    }
    key += value
  }

  function decodeEscaped(char: string) {
    if (char === "n") return "\n"
    if (char === "r") return "\r"
    if (char === "t") return "\t"
    if (char === "b") return "\b"
    if (char === "f") return "\f"
    return char
  }

  return {
    push(input: string) {
      for (const char of input) {
        if (inString) {
          if (unicode !== undefined) {
            unicode += char
            if (unicode.length === 4) {
              const code = Number.parseInt(unicode, 16)
              pushDecoded(Number.isFinite(code) ? String.fromCharCode(code) : "")
              unicode = undefined
              escaping = false
            }
            continue
          }
          if (escaping) {
            if (char === "u") {
              unicode = ""
              continue
            }
            pushDecoded(decodeEscaped(char))
            escaping = false
            continue
          }
          if (char === "\\") {
            escaping = true
            continue
          }
          if (char === '"') {
            inString = false
            if (!activeField) pendingKey = key
            activeField = ""
            key = ""
            continue
          }
          pushDecoded(char)
          continue
        }

        if (char === '"') {
          inString = true
          activeField = wanted.has(expectingValueFor) ? expectingValueFor : ""
          expectingValueFor = ""
          key = ""
          continue
        }
        if (char === ":" && pendingKey) {
          expectingValueFor = pendingKey
          pendingKey = ""
          continue
        }
        if (expectingValueFor && !/\s/.test(char)) expectingValueFor = ""
        if (char === "," || char === "{" || char === "}") pendingKey = ""
      }
    },
  }
}

function createPatchStatsParser() {
  // apply_patch is line-oriented. Counting only complete lines matches the
  // parser's eventual view and avoids flickering counts from half-written rows.
  const files = new Map<string, { filePath: string; added: number; removed: number }>()
  let line = ""
  let mode: "idle" | "add" | "delete" | "update" = "idle"
  let current: { filePath: string; added: number; removed: number } | undefined

  function file(filePath: string) {
    const hit = files.get(filePath)
    if (hit) return hit
    const next = { filePath, added: 0, removed: 0 }
    files.set(filePath, next)
    return next
  }

  function processLine(input: string) {
    const trimmed = input.trim()
    if (trimmed === "*** Begin Patch" || trimmed === "*** End Patch") return
    if (trimmed.startsWith("*** Add File: ")) {
      current = file(trimmed.slice("*** Add File: ".length))
      mode = "add"
      return
    }
    if (trimmed.startsWith("*** Delete File: ")) {
      current = file(trimmed.slice("*** Delete File: ".length))
      mode = "delete"
      return
    }
    if (trimmed.startsWith("*** Update File: ")) {
      current = file(trimmed.slice("*** Update File: ".length))
      mode = "update"
      return
    }
    if (!current) return
    if (mode === "add" && input.startsWith("+")) current.added++
    if (mode === "update" && input.startsWith("+")) current.added++
    if (mode === "update" && input.startsWith("-")) current.removed++
  }

  return {
    push(input: string) {
      for (const char of input) {
        if (char === "\n") {
          processLine(line.endsWith("\r") ? line.slice(0, -1) : line)
          line = ""
          continue
        }
        line += char
      }
    },
    stats() {
      if (files.size === 0) return undefined
      const values = Array.from(files.values())
      return {
        filePath: values.length === 1 ? values[0]?.filePath : undefined,
        fileCount: values.length,
        added: values.reduce((sum, item) => sum + item.added, 0),
        removed: values.reduce((sum, item) => sum + item.removed, 0),
      }
    },
  }
}
