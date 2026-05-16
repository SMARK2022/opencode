// 两代会话与daemon观察同一集合，不能在V1 façade维护第二份活动计数。
export { SessionActivity, begin, track, count, onChange } from "@opencode-ai/core/session/activity"
