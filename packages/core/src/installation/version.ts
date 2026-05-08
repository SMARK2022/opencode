// #118：版本号以 packages/opencode/package.json 的 1.19.7-smark 为准（文档/VSIX 同步）
// #118：禁止回写 original 1.14.x；scripts.vsix 产物名必须与 version 同号
declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
