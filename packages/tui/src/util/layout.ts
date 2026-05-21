import type { BaseRenderable, BoxRenderable } from "@opentui/core"

export const layoutGroups = new WeakSet<BaseRenderable>()

const previousByParent = new WeakMap<
  BaseRenderable,
  { frameID: number; previous: WeakMap<BaseRenderable, BaseRenderable | undefined> }
>()

export function setPreLayoutSiblingMargin(el: BoxRenderable, margin: (previous?: BaseRenderable) => number) {
  // Run before Yoga layout so scroll geometry matches the rendered frame.
  el.onLifecyclePass = () => {
    // 导航分组不改变布局邻接层级，工具间距仍由消息容器的父层提供相邻内容。
    const parent = el.parent && layoutGroups.has(el.parent) ? el.parent.parent : el.parent
    if (!parent) return
    const cached = previousByParent.get(parent)
    const previous = cached?.frameID === el.ctx.frameId ? cached.previous : previousSiblings(parent, el.ctx.frameId)
    const sibling = previous.get(el)
    // 组内工具保持紧排，跨助手消息至少隔一行；空消息组不会制造额外间距。
    const boundary = el.parent && sibling?.parent && el.parent !== sibling.parent
      && layoutGroups.has(el.parent) && layoutGroups.has(sibling.parent)
    const value = Math.max(margin(sibling), boundary ? 1 : 0)
    if (el.marginTop !== value) el.marginTop = value
  }
}

function previousSiblings(parent: BaseRenderable, frameID: number) {
  const previous = new WeakMap<BaseRenderable, BaseRenderable | undefined>()
  // 只展开登记的一层分组，跳过空组并保留实际末节点，避免把容器总高度当成分隔依据。
  parent
    .getChildren()
    .flatMap((child) => (layoutGroups.has(child) ? child.getChildren() : [child]))
    .forEach((child, index, children) => previous.set(child, children[index - 1]))
  previousByParent.set(parent, { frameID, previous })
  return previous
}
