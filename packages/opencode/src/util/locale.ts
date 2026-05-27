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
  const hours = Math.floor(input / 3600000)
  const days = Math.floor((input % 3600000) / 86400000)
  return `${days}d ${hours}h`
}

export function durationClock(input: number) {
  // 面向“正在刷新”的 turn/clock 展示：起点来自持久化 message timestamp，
  // 和本地刷新 tick 通常不会整秒对齐；这里必须向下取整，避免 1.1s、2.1s
  // 这种看起来像计时漂移的小数秒，同时不夸大已经经过的真实耗时。
  if (input < 1000) return `${input}ms`
  if (input < 60000) return `${Math.floor(input / 1000)}s`
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
  if (str.length <= len) return str
  let end = len - 1
  // Avoid splitting a surrogate pair: if the cut lands on a high surrogate, step back
  if (end > 0 && str.charCodeAt(end - 1) >= 0xd800 && str.charCodeAt(end - 1) <= 0xdbff) end--
  return str.slice(0, end) + "…"
}

export function truncateLeft(str: string, len: number): string {
  if (str.length <= len) return str
  return "…" + str.slice(-(len - 1))
}

export function truncateMiddle(str: string, maxLength: number = 35): string {
  if (str.length <= maxLength) return str

  const ellipsis = "…"
  let keepStart = Math.ceil((maxLength - ellipsis.length) / 2)
  let keepEnd = Math.floor((maxLength - ellipsis.length) / 2)

  // Avoid splitting a surrogate pair at the start boundary
  if (keepStart > 0 && str.charCodeAt(keepStart - 1) >= 0xd800 && str.charCodeAt(keepStart - 1) <= 0xdbff) keepStart--
  // Avoid splitting a surrogate pair at the end boundary
  const endStart = str.length - keepEnd
  if (endStart < str.length && str.charCodeAt(endStart) >= 0xdc00 && str.charCodeAt(endStart) <= 0xdfff) keepEnd--

  return str.slice(0, keepStart) + ellipsis + str.slice(-keepEnd || undefined)
}

export function pluralize(count: number, singular: string, plural: string): string {
  const template = count === 1 ? singular : plural
  return template.replace("{}", count.toString())
}

export * as Locale from "./locale"
