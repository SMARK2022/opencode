export * as TaskPrompt from "./task-prompt"
import DESCRIPTION from "./task.txt"
// 共享说明保持纯资产入口，V1只读文案时不加载V2会话和调度服务。
export const description = DESCRIPTION
