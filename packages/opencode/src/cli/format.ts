export function formatNumber(num: number): string {
  if (!Number.isFinite(num)) return "0"
  if (Math.abs(num) >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + "B"
  if (Math.abs(num) >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M"
  if (Math.abs(num) >= 1_000) return (num / 1_000).toFixed(1) + "K"
  return Math.round(num).toString()
}
