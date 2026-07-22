// Path A/B 共用半年 lookback，避免浏览与搜索时间窗再次分叉
export const SESSION_LIST_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000
// 浏览缓存上限：默认打开 Sessions 列表时的 session.list limit
export const SESSION_LIST_BROWSE_LIMIT = 1600
// 搜索结果上限：内容或标题命中后只保留最近更新的 N 条
export const SESSION_LIST_SEARCH_LIMIT = 400

/**
 * Path A/B 数据源合流。
 * - 空 query：强制 Path A（browse），忽略 createResource 残留的 searchResults
 * - 非空 query：只消费 search 源；loading 时 undefined 视为 []，不得 ?? 回 browse
 *   （否则无命中/加载中会短暂展示「其他会话」，违反搜索空结果语义）
 */
export function resolveSessionListSource<T>(input: {
  query: string
  searchResults: T[] | undefined
  browse: T[]
}): { source: "browse" | "search"; sessions: T[] } {
  if (!input.query) return { source: "browse", sessions: input.browse }
  return { source: "search", sessions: input.searchResults ?? [] }
}

/** 仅搜索路径展示 Not Found；浏览路径沿用 DialogSelect 默认 empty */
export function sessionListEmptyLabel(query: string) {
  if (!query) return undefined
  return `Not Found ${query}`
}
