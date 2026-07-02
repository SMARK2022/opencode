// 安装平台必须与构建过滤一致：singleFlag > osFilter > "*"，避免下载非目标平台原生包。
// 错配会在 macOS 安装 win32 包时触发 IntegrityCheckFailed（oven-sh/bun#26879）。
export function resolveInstallTarget(
  osFilter: string | undefined,
  archFilter: string | undefined,
  singleFlag: boolean,
): { os: string; cpu: string } {
  // singleFlag 优先：--single 只构建当前平台，install 也只装当前平台原生包
  const os = singleFlag ? process.platform : (osFilter ?? "*")
  const cpu = singleFlag ? process.arch : (archFilter ?? "*")
  return { os, cpu }
}
