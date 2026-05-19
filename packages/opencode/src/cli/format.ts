// #174：formatNumber 独立模块切断 session 对 stats 的环
export function formatNumber(num: number): string {
  // #174：非有限数显示 0，跳过 K/M/B 除法
  if (!Number.isFinite(num)) return "0"
  // #174：绝对值达 1e9 用 B 后缀
  if (Math.abs(num) >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + "B"
  // #174：绝对值达 1e6 用 M 后缀
  if (Math.abs(num) >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M"
  // #174：绝对值达 1e3 用 K 后缀
  if (Math.abs(num) >= 1_000) return (num / 1_000).toFixed(1) + "K"
  // #174：小额费用保留四位小数；去掉尾零，整数计数与紧凑量级格式保持不变。
  return Number(num.toFixed(4)).toString()
}
