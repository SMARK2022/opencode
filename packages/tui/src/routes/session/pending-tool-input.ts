// #187：pending 工具输入的可展示统计（路径/文件数/增减行）
export type PendingToolInputStats = {
  // #187：filePath 可空（多文件 patch 时用 fileCount）
  filePath?: string
  // #224：notebook edit 的稳定 cell 定位键，pending 阶段从 cellId 参数流式提取
  cellId?: string
  // #224：notebook edit 操作类型（insert/edit/delete）或 env 操作（configure/restart/save）
  operation?: string
  // #187：apply_patch 多文件计数
  fileCount: number
  // #187：新增行（write/content 或 newString 或 +diff）
  added: number
  // #187：删除行（oldString 或 -diff）
  removed: number
}

// #189：UI 文案纯函数改为先 + 后 -，锁定 +N -M
export function formatPendingCounts(stats: PendingToolInputStats | undefined) {
  if (!stats) return ""
  let out = ""
  // #189：added 优先，与 PendingStats 及 frame 期望一致
  if (stats.added) out += ` +${stats.added}`
  if (stats.removed) out += ` -${stats.removed}`
  return out
}

// #187：pending 标题路径片段（无路径返回空，交给 Preparing 占位）
export function formatPendingPathLabel(filePath: string | undefined, fileCount: number) {
  if (filePath) return filePath
  if (fileCount > 0) return `${fileCount} file${fileCount === 1 ? "" : "s"}`
  return ""
}

// #187：pending 统计刷新间隔；过密会跟手抖，过疏会丢进度感
// #189：从 200 降到 50，跟手流式 raw
export const PENDING_TOOL_INPUT_PROGRESS_INTERVAL = 50

// #187：按 tool 名选择流式 JSON 字段扫描器；未知 tool 空实现
export function createPendingToolInputParser(tool: string) {
  // #187：工具名与 session 渲染器三分支对齐
  if (tool === "apply_patch") return createApplyPatchInputParser()
  if (tool === "edit") return createEditInputParser()
  if (tool === "write") return createWriteInputParser()
  // #224：notebook edit 的 pending 统计需要 filePath/cellId/editType + oldCode/newCode 行数
  if (tool === "vscode_notebook_edit") return createNotebookEditInputParser()
  // #187：bash 等无 raw 进度 UI 的工具返回空 parser
  return {
    push(_input: string) {},
    stats: () => undefined,
  }
}

// #224：notebook edit 的 pending 统计从流式参数提取 filePath/cellId/editType +
// oldCode/newCode 行数。bridge 的 sourceProp 会用 "\n" 拼接 string[] 数组项，
// streaming 统计也必须补上这个隐式换行，否则 pending 阶段的 +N/-N 会低估。
// #224：与 createEditInputParser 不同——notebook edit 还需要 cellId 和 editType
function createNotebookEditInputParser() {
  let filePath = ""
  let cellId = ""
  let operation = ""
  const oldCode = createLineCounter()
  const newCode = createLineCounter()
  const scanner = createJsonStringFieldScanner(
    ["filePath", "cellId", "editType", "oldCode", "newCode"],
    (field, value) => {
      if (field === "filePath") filePath += value
      if (field === "cellId") cellId += value
      if (field === "editType") operation += value
      if (field === "oldCode") oldCode.push(value)
      if (field === "newCode") newCode.push(value)
    },
  )
  return {
    push: scanner.push,
    stats: () => {
      // #224：notebook edit 的 pending 统计只能来自模型正在流式生成的参数，不能在渲染线程
      // 读取 VS Code 或 notebook 文件；full-cell replace/delete 的真实删除行数要等完成后的 diff。
      const stats = pendingStats(filePath, filePath ? 1 : 0, newCode.count(), oldCode.count())
      if (!stats && !cellId && !operation) return undefined
      return {
        ...(stats ?? { fileCount: filePath ? 1 : 0, added: 0, removed: 0, filePath: filePath || undefined }),
        cellId: cellId || undefined,
        operation: operation || undefined,
      }
    },
  }
}

// #187：edit 扫 filePath/oldString/newString，added=new 行 removed=old 行
function createEditInputParser() {
  let filePath = ""
  let nativePath = ""
  // #187：old/new 分开计数，对应 UI -N +M
  const oldString = createLineCounter()
  const newString = createLineCounter()
  const scanner = createJsonStringFieldScanner(["filePath", "path", "oldString", "newString"], (field, value) => {
    // #187：字段值可能分片到达，路径用 += 拼接
    if (field === "filePath") filePath += value
    if (field === "path") nativePath += value
    if (field === "oldString") oldString.push(value)
    if (field === "newString") newString.push(value)
  })
  return {
    push: scanner.push,
    // 两代路径分别累积，兼有字段时保持 legacy filePath 优先而不拼接两个路径。
    stats: () =>
      pendingStats(filePath || nativePath, filePath || nativePath ? 1 : 0, newString.count(), oldString.count()),
  }
}

// #187：write 扫 filePath/content，added=content 行 removed=0
function createWriteInputParser() {
  let filePath = ""
  let nativePath = ""
  const content = createLineCounter()
  const scanner = createJsonStringFieldScanner(["filePath", "path", "content"], (field, value) => {
    // #187：content 分片按字符计行，不缓存全文
    if (field === "filePath") filePath += value
    if (field === "path") nativePath += value
    if (field === "content") content.push(value)
  })
  return {
    push: scanner.push,
    // Write 与 Edit 使用相同路径优先级，流式正文仍只做预览计行。
    stats: () => pendingStats(filePath || nativePath, filePath || nativePath ? 1 : 0, content.count(), 0),
  }
}

// #187：apply_patch 只扫 patchText 字段交给 patch stats
function createApplyPatchInputParser() {
  const patch = createPatchStatsParser()
  const scanner = createJsonStringFieldScanner(["patchText"], (_, value) => patch.push(value))
  return {
    push: scanner.push,
    stats: patch.stats,
  }
}

// #187：全空时返回 undefined，UI 显示 Preparing… 占位
function pendingStats(filePath: string, fileCount: number, added: number, removed: number) {
  if (!filePath && fileCount === 0 && added === 0 && removed === 0) return undefined
  return { filePath: filePath || undefined, fileCount, added, removed }
}

// #187：增量计行：用 chars/newlines/tail，不保存全文
function createLineCounter() {
  let chars = 0
  let newlines = 0
  // #187：tail>0 表示末行无换行也计 1 行
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
      // #187：空串 0 行；"a" 1 行；"a\n" 1 行；"a\nb" 2 行
      if (chars === 0) return 0
      return newlines + (tail > 0 ? 1 : 0)
    },
  }
}

// #187：最小 JSON 字符串字段状态机（含 escape/unicode）
function createJsonStringFieldScanner(fields: readonly string[], onValue: (field: string, value: string) => void) {
  // #187：pending 参数在收尾前不是合法 JSON，只扫可展示字符串字段
  // #187：禁止每次 delta 全量 JSON.parse，避免 O(n^2) 与半截转义炸掉
  // #187：只关心调用方声明的字段名集合
  const wanted = new Set(fields)
  // #187：状态机：inString/escaping/unicode 与 key/value 相位
  let pendingKey = ""
  let expectingValueFor = ""
  // #187：当前正在读的 value 字段名；空表示在 key 相位
  let activeField = ""
  // #224：数组字段状态——oldCode/newCode 可以是 string[]，需要跟踪数组边界
  // #224：arrayField 记录当前正在遍历的数组字段名，空表示不在数组内
  let arrayField = ""
  let arrayFieldHasValue = false
  let key = ""
  // #187：是否位于 JSON 字符串 token 内部
  let inString = false
  let escaping = false
  let unicode: string | undefined

  // #187：解码后的片段：在 value 相位回调，在 key 相位累加 key
  function pushDecoded(value: string) {
    if (activeField) {
      onValue(activeField, value)
      return
    }
    key += value
  }

  // #187：JSON 转义还原，\\uXXXX 走 unicode 缓冲
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
          // #187：收集 unicode 四位 hex
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
          // #187：处理转义序列或进入 \\u
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
          // #224：数组内 string 项也激活 wanted 字段；数组外仍用 expectingValueFor
          // #224：这样 oldCode/newCode 的 string[] 元素也能被 lineCounter 正确计数
          activeField = wanted.has(expectingValueFor) ? expectingValueFor : arrayField
          // #224：分隔换行必须先于第二项内容，才能对齐 sourceProp 的 join("\n")。
          // 空末项也有分隔符，不能把它延迟到结束引号之后补入。
          // 逐字符输入时，第二项尚未闭合也必须立即显示独立的一行。
          if (activeField && arrayField && arrayFieldHasValue) onValue(activeField, "\n")
          if (activeField && arrayField) arrayFieldHasValue = true
          expectingValueFor = ""
          key = ""
          continue
        }
        // #224：保留普通字段的冒号转换，数组扩展不能切断所有工具的字段识别。
        if (char === ":" && pendingKey) {
          expectingValueFor = pendingKey
          pendingKey = ""
          continue
        }
        // #224：进入数组字段——oldCode/newCode 可以是 string[]
        // #224：遇到 [ 后切换到数组模式，后续逗号不再重置 pendingKey
        if (expectingValueFor && char === "[" && wanted.has(expectingValueFor)) {
          arrayField = expectingValueFor
          arrayFieldHasValue = false
          expectingValueFor = ""
          continue
        }
        // #224：退出数组字段——遇到 ] 恢复到普通字段模式
        if (arrayField && char === "]") {
          arrayField = ""
          arrayFieldHasValue = false
          continue
        }
        if (expectingValueFor && !/\s/.test(char)) expectingValueFor = ""
        // #224：数组内不重置 pendingKey——逗号是数组项分隔符不是字段分隔符
        // #224：这确保 string[] 的后续元素仍能被正确识别为同一字段的值
        if (!arrayField && (char === "," || char === "{" || char === "}")) pendingKey = ""
      }
    },
  }
}

// #187：流式解析 apply_patch 文本，累计 +/- 与文件数
function createPatchStatsParser() {
  // apply_patch is line-oriented. Counting only complete lines matches the
  // parser's eventual view and avoids flickering counts from half-written rows.
  const files = new Map<string, { filePath: string; added: number; removed: number }>()
  let line = ""
  let mode: "idle" | "add" | "delete" | "update" = "idle"
  let current: { filePath: string; added: number; removed: number } | undefined

  // #187：登记一个 patch 文件路径并增加 fileCount
  function file(filePath: string) {
    const hit = files.get(filePath)
    if (hit) return hit
    const next = { filePath, added: 0, removed: 0 }
    files.set(filePath, next)
    return next
  }

  // #187：按行识别 *** Update/Add/Delete File 与 diff 行
  function processLine(input: string) {
    const trimmed = input.trim()
    // #187：Begin/End 标记本身不计文件
    if (trimmed === "*** Begin Patch" || trimmed === "*** End Patch") return
    // #187：新增文件头
    if (trimmed.startsWith("*** Add File: ")) {
      current = file(trimmed.slice("*** Add File: ".length))
      mode = "add"
      return
    }
    // #187：删除文件头
    if (trimmed.startsWith("*** Delete File: ")) {
      current = file(trimmed.slice("*** Delete File: ".length))
      mode = "delete"
      return
    }
    // #187：更新文件头
    if (trimmed.startsWith("*** Update File: ")) {
      current = file(trimmed.slice("*** Update File: ".length))
      mode = "update"
      return
    }
    if (!current) return
    // #187：add 模式仅 + 行计入 added
    if (mode === "add" && input.startsWith("+")) current.added++
    // #187：update 的 + 行
    if (mode === "update" && input.startsWith("+")) current.added++
    // #187：update 的 - 行
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
