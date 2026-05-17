export function titlecase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function time(input: number): string {
  const date = new Date(input)
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export function datetime(input: number): string {
  const date = new Date(input)
  const localTime = time(input)
  const localDate = date.toLocaleDateString()
  return `${localTime} · ${localDate}`
}

export function todayTimeOrDateTime(input: number): string {
  const date = new Date(input)
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

  if (isToday) {
    return time(input)
  } else {
    return datetime(input)
  }
}

export function number(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}

export function duration(input: number) {
  if (input < 1000) {
    return `${input}ms`
  }
  if (input < 60000) {
    return `${(input / 1000).toFixed(1)}s`
  }
  if (input < 3600000) {
    const minutes = Math.floor(input / 60000)
    const seconds = Math.floor((input % 60000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (input < 86400000) {
    const hours = Math.floor(input / 3600000)
    const minutes = Math.floor((input % 3600000) / 60000)
    return `${hours}h ${minutes}m`
  }
  const days = Math.floor(input / 86400000)
  const hours = Math.floor((input % 86400000) / 3600000)
  return `${days}d ${hours}h`
}

export function truncate(str: string, len: number): string {
  // #160：长度未超限则原样返回
  if (str.length <= len) return str
  // #160：预留一位给省略号，再按代理对安全调整 end
  let end = len - 1
  // #160：截断点落在高代理项上时回退一位，避免孤立半个 emoji/CJK 扩展字
  if (end > 0 && str.charCodeAt(end - 1) >= 0xd800 && str.charCodeAt(end - 1) <= 0xdbff) end--
  return str.slice(0, end) + "…"
}

export function truncateLeft(str: string, len: number): string {
  if (str.length <= len) return str
  return "…" + str.slice(-(len - 1))
}

export function truncateMiddle(str: string, maxLength: number = 35): string {
  // #160：未超 maxLength 时不改写路径/标题
  if (str.length <= maxLength) return str

  const ellipsis = "…"
  // #160：中间省略时左右保留长度先按半分配，再按代理对微调
  let keepStart = Math.ceil((maxLength - ellipsis.length) / 2)
  let keepEnd = Math.floor((maxLength - ellipsis.length) / 2)

  // #160：起始边界若切开代理对，缩短 keepStart 保留完整码点
  if (keepStart > 0 && str.charCodeAt(keepStart - 1) >= 0xd800 && str.charCodeAt(keepStart - 1) <= 0xdbff) keepStart--
  // #160：末尾边界若从低代理项起切，缩短 keepEnd 避免孤立低代理
  const endStart = str.length - keepEnd
  if (endStart < str.length && str.charCodeAt(endStart) >= 0xdc00 && str.charCodeAt(endStart) <= 0xdfff) keepEnd--

  // #160：keepEnd 被减到 0 时 slice(-0) 会整串回退，改用 undefined 表示空尾
  return str.slice(0, keepStart) + ellipsis + str.slice(-keepEnd || undefined)
}

export function pluralize(count: number, singular: string, plural: string): string {
  const template = count === 1 ? singular : plural
  return template.replace("{}", count.toString())
}

export * as Locale from "./locale"
