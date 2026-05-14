// #141：发布协同升号沿 tip 1.19.x-smark，禁止回写 1.14
// #141：InstallationVersion 编译期注入，与 packages/opencode version 对齐
// #133：版本号以 packages/opencode/package.json 的 1.19.10-smark 为准（文档/VSIX 同步）
// #133：禁止回写 original 1.14.x 以免与 tip baseline 冲突
// #133：scripts.vsix 产物文件名必须与 version 同号
// #133：InstallationVersion 读编译期 OPENCODE_VERSION，注释记录期望发布号
declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
