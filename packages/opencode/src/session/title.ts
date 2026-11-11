// #113：会话默认标题生成与判定（从 session.ts 抽出为服务端事实源）
const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

// #113：父/子会话默认标题 = 前缀 + ISO 时间；创建者可注入同一 created，供精确默认标题判定复用。
// created 缺省时仍读取当前时间，既有 Session 创建调用保持原有行为。
export function createDefaultTitle(isChild = false, created = Date.now()) {
  return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date(created).toISOString()
}

// #113：是否仍为自动生成的默认标题（未人工改名）
// 注意：模板字面量中 \d 必须落到 RegExp 源串为数字类
export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}
