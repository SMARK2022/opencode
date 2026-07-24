// #529：Path A/B 共用半年 lookback，避免浏览与搜索时间窗再次分叉
export const SESSION_LIST_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000
// #529：浏览缓存上限：默认打开 Sessions 列表时的 session.list limit
export const SESSION_LIST_BROWSE_LIMIT = 1600
// #529：搜索结果上限：内容或标题命中后只保留最近更新的 N 条
export const SESSION_LIST_SEARCH_LIMIT = 400
// #544 B2：每批扫描的「候选」session 数（不是命中数）；串行以利 abort 与 SQLite 压力
export const SESSION_LIST_CONTENT_BATCH = 50
// #544：title 首屏后、启动 full-condition scan 前的额外等待（毫秒），吸收慢打改词
// 与输入 debounce(150ms) 分工：debounce 稳定 committed query，本值推迟昂贵 scan
export const SESSION_LIST_CONTENT_DELAY_MS = 250

/**
 * #544 progressive 搜索阶段。
 * - awaiting_first：title 请求未回，列表 empty=Searching…，禁止 Not Found
 * - partial：可有 title overlay 与部分 scan 命中，Spinner 仍转
 * - complete：权威结果仅 scanFullHits（或失败终态），Spinner 关
 */
export type SearchPhase = "awaiting_first" | "partial" | "complete"

/**
 * #529：Path A/B 数据源合流。
 * - 空 query：强制 Path A（browse），忽略 createResource 残留的 searchResults
 * - 非空 query：只消费 search 源；loading 时 undefined 视为 []，不得 ?? 回 browse
 *   （否则无命中/加载中会短暂展示「其他会话」，违反搜索空结果语义）
 */
export function resolveSessionListSource<T>(input: {
  query: string
  searchResults: T[] | undefined
  browse: T[]
}): { source: "browse" | "search"; sessions: T[] } {
  // 空 query 是唯一合法回 browse 的路径：progressive 各阶段都禁止静默回退。
  if (!input.query) return { source: "browse", sessions: input.browse }
  return { source: "search", sessions: input.searchResults ?? [] }
}

/**
 * #544 progressive 视图：非空 query 时用 phase + hits，不再把 loading 伪装成 Not Found。
 * complete 且 hits 空才走 empty 文案；browse 在 query 空时。
 * 任一非空 query 都禁止 ?? 回 browse，否则搜索中会闪现其它会话。
 */
export function resolveProgressiveSessionListSource<T>(input: {
  query: string
  phase: SearchPhase | undefined
  hits: T[]
  browse: T[]
}): { source: "browse" | "search"; sessions: T[]; phase?: SearchPhase } {
  // 空 query 是唯一合法回 browse 的路径：progressive 各阶段都禁止静默回退。
  if (!input.query) return { source: "browse", sessions: input.browse }
  // awaiting_first / partial / complete 均停留在 search 源，禁止回 browse
  return { source: "search", sessions: input.hits, phase: input.phase ?? "awaiting_first" }
}

/** #529/#544：仅搜索路径展示 empty；browse 返回 undefined 沿用默认 */
export function sessionListEmptyLabel(query: string, phase?: SearchPhase) {
  if (!query) return undefined
  // #544：loading 与真·无命中必须可分——未 complete 前禁止 Not Found
  // Searching… 是显式 loading 文案：修复旧版把 undefined 伪装成 Not Found 的假空态。
  if (phase === "awaiting_first" || phase === "partial") return "Searching…"
  return `Not Found ${query}`
}

// #544：Spinner 门控与 empty 文案共用 phase 语义——query 为空时 browse 永不算 loading。
export function isSessionSearchLoading(query: string, phase: SearchPhase | undefined) {
  if (!query) return false
  return phase !== "complete"
}

/**
 * #544 partial 展示：title overlay ∪ scan 流，按 recency 排序后 cap。
 * 不定义 complete：complete 时调用方应只传 scanFullHits / 直接显示 scanFullHits。
 * scan 条目覆盖同 id 的 title 条目，保证展示字段以更新后的 Info 为准。
 */
export function mergeDisplayHits<T extends { id: string; time: { updated: number } }>(
  titleHits: T[],
  scanFullHits: T[],
  cap = SESSION_LIST_SEARCH_LIMIT,
): T[] {
  // Map 去重以 scan 为准：同 id 时后写入的 scan 条目覆盖 title 旧快照。
  const byId = new Map<string, T>()
  // 先 title 后 scan：同 id 时 scan 覆盖 title
  for (const item of titleHits) byId.set(item.id, item)
  for (const item of scanFullHits) byId.set(item.id, item)
  // 二级 id 比较仅作稳定排序，与 list 的 time_updated 主序一致
  return [...byId.values()]
    .toSorted((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id))
    .slice(0, cap)
}

/**
 * #544：early-stop 只数 full-condition scan 命中长度。
 * 禁止用 titleHits.length：title 是全宇宙子集查询，计入 stop 会跳过 recency 前缀 scan，
 * 使 complete 偏离今日 list({search,limit:400})。
 */
// #544：cap 与服务端 list LIMIT 同值——early-stop 后的集合与一次性 search 查询等价。
export function shouldStopSearchScan(scanFullHitsLength: number, cap = SESSION_LIST_SEARCH_LIMIT) {
  return scanFullHitsLength >= cap
}

/**
 * #544 列表展示 hits 选择：
 * - success complete → 仅 scan（权威 top-400）
 * - error complete / partial / awaiting → title∪scan，避免失败抹掉已展示首屏
 */
export function resolveDisplayHits<T extends { id: string; time: { updated: number } }>(input: {
  phase: SearchPhase | undefined
  terminal?: "success" | "error"
  titleHits: T[]
  scanFullHits: T[]
  cap?: number
}): T[] {
  // 双条件终态判定：只有 success+complete 才丢弃 title——error complete 保留首屏。
  if (input.phase === "complete" && input.terminal === "success") return input.scanFullHits
  return mergeDisplayHits(input.titleHits, input.scanFullHits, input.cap)
}

// #544：保持 scan 页返回顺序（已是 recency），满 cap 即截断供 early-stop 使用
export function appendScanHits<T extends { id: string }>(
  scanFullHits: T[],
  pageMatches: T[],
  cap = SESSION_LIST_SEARCH_LIMIT,
): T[] {
  // keyset 翻页理论上不重复，seen 仅防御并发代写回与游标重放。
  const seen = new Set(scanFullHits.map((item) => item.id))
  const next = [...scanFullHits]
  for (const item of pageMatches) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    next.push(item)
    // 达到 SESSION_LIST_SEARCH_LIMIT 后与 list LIMIT 等价，可停扫
    if (next.length >= cap) break
  }
  return next.slice(0, cap)
}
