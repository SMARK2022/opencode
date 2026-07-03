// 将 build.ts 的 CLI 参数映射为 bun install 的 --os / --cpu 目标。
// 优先级必须与 build.ts 的 target 过滤逻辑（L158-179）一致：singleFlag > osFilter > "*"。
// 不一致会导致安装非目标平台的原生包（例如 --single --os=darwin 在 Linux 上安装 darwin 包），
// 触发 bun 的 IntegrityCheckFailed（oven-sh/bun#26879）。
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
