export function formatDuration(secs: number) {
  if (secs <= 0) return ""
  if (secs < 60) return `${secs}s`
  if (secs < 3600) {
    const mins = Math.floor(secs / 60)
    const remaining = secs % 60
    return remaining > 0 ? `${mins}m ${remaining}s` : `${mins}m`
  }
  if (secs < 86400) {
    const hours = Math.floor(secs / 3600)
    const remaining = Math.floor((secs % 3600) / 60)
    return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`
  }
  if (secs < 604800) {
    const days = Math.floor(secs / 86400)
    return days === 1 ? "~1 day" : `~${days} days`
  }
  const weeks = Math.floor(secs / 604800)
  return weeks === 1 ? "~1 week" : `~${weeks} weeks`
}

// 循环耗时保留秒级累计，与 retry 倒计时的近似 formatDuration 分开。
export function formatDurationCompact(secs: number) {
  if (secs <= 0) return "0s"
  if (secs < 60) return `${secs}s`
  // 分钟边界仍保留 0s，持续 tick 不因省略秒数而改变显示精度。
  if (secs < 3600) {
    const mins = Math.floor(secs / 60)
    const remaining = secs % 60
    return `${mins}m${remaining}s`
  }
  const hours = Math.floor(secs / 3600)
  const mins = Math.floor((secs % 3600) / 60)
  const remaining = secs % 60
  // 小时级别：无剩余秒时省略秒部分，保持显示简洁
  if (hours < 24) {
    return remaining > 0 ? `${hours}h${mins}m${remaining}s` : `${hours}h${mins}m`
  }
  // 天级只保留天和小时，限制 footer 横向宽度。
  const days = Math.floor(secs / 86400)
  const remainingHours = Math.floor((secs % 86400) / 3600)
  return `${days}d${remainingHours}h`
}
