import {
  InputRenderable,
  RGBA,
  ScrollBoxRenderable,
  TextAttributes,
  type KeyEvent,
  type Renderable,
} from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import { useTheme, selectedForeground } from "../context/theme"
import { entries, filter, flatMap, groupBy, pipe } from "remeda"
import { batch, createEffect, createMemo, createSignal, For, Show, type JSX, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useTerminalDimensions } from "@opentui/solid"
import * as fuzzysort from "fuzzysort"
// #279：isDeepEqual 仍服务于无 key 回退与 preserveSelection，非死导入
import { isDeepEqual } from "remeda"
import { useDialog, type DialogContext } from "./dialog"
import { Locale } from "../util/locale"
import { getScrollAcceleration } from "../util/scroll"
import { useTuiConfig } from "../config"
import { formatKeyBindings, useBindings, useKeymapSelector } from "../keymap"

export interface DialogSelectProps<T> {
  title: string
  titleView?: JSX.Element
  placeholder?: string
  footer?: JSX.Element
  emptyView?: JSX.Element
  options: DialogSelectOption<T>[]
  flat?: boolean
  ref?: (ref: DialogSelectRef<T>) => void
  onMove?: (option: DialogSelectOption<T>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: DialogSelectOption<T>) => void
  skipFilter?: boolean
  renderFilter?: boolean
  locked?: boolean
  preserveSelection?: boolean
  actions?: {
    command: string
    title: string
    side?: "left" | "right"
    hidden?: boolean
    disabled?: boolean | ((option: DialogSelectOption<T> | undefined) => boolean)
    onTrigger: (option: DialogSelectOption<T>) => void
  }[]
  footerHints?: {
    title: string
    label: string
    side?: "left" | "right"
  }[]
  bindings?: readonly Binding<Renderable, KeyEvent>[]
  current?: T
  // #279：与 option.key 同形的稳定业务 identity；提供后 current 高亮不再依赖深比较
  currentKey?: string
  // 可选头部：渲染在 title/filter 和 scrollbox 之间，增加对话框有效高度
  header?: JSX.Element
  // #544：搜索框右侧附属（如 progressive 搜索 Spinner）
  filterAccessory?: JSX.Element
}

export interface DialogSelectOption<T = any> {
  /**
   * #279：对象 value 的稳定业务 identity。DialogSelect 会承载模型、会话、工作区
   * 等较大列表；调用方已知业务 key 时，active/current 热路径不应再依赖
   * 深比较或 JSON 序列化。
   */
  key?: string
  title: string
  titleView?: JSX.Element
  value: T
  description?: string
  details?: string[]
  footer?: JSX.Element | string
  titleWidth?: number
  truncateTitle?: boolean | "left"
  category?: string
  categoryView?: JSX.Element
  disabled?: boolean
  bg?: RGBA
  gutter?: () => JSX.Element
  margin?: JSX.Element
  // #112：会话列表最近用户消息预览行
  previewLines?: string[]
  onSelect?: (ctx: DialogContext) => void
}

export type DialogSelectRef<T> = {
  filter: string
  filtered: DialogSelectOption<T>[]
  moveTo(value: T): void
}

type DialogSelectRow<T> = {
  option: DialogSelectOption<T>
  index: number
  // #279：undefined 表示对象 value 未提供 key，current 匹配时走深比较回退
  identityKey: string | undefined
}

// #279：只有原始值能安全转成字符串 identity；对象 value 必须由调用方提供 key，
// 否则回退深比较——这是无 key 调用方（会话列表等）的兼容路径，不是热路径。
function primitiveKey(value: unknown) {
  if (value === undefined) return
  // #279：null 有稳定 identity（与 undefined 区分），可作为合法 key
  if (value === null) return "null:null"
  const type = typeof value
  // #279：类型前缀避免 string "1" 与 number 1 撞 key
  if (type === "string" || type === "number" || type === "boolean") return `${type}:${String(value)}`
  return
}

// #279：调用方业务 key 优先，原始值仅作无 key 时的回退
function optionIdentityKey<T>(option: DialogSelectOption<T>) {
  return option.key ?? primitiveKey(option.value)
}

function currentIdentityKey(value: unknown, key: string | undefined) {
  return key ?? primitiveKey(value)
}

export function DialogSelect<T>(props: DialogSelectProps<T>) {
  type Action = NonNullable<DialogSelectProps<T>["actions"]>[number]
  type FooterHint = NonNullable<DialogSelectProps<T>["footerHints"]>[number]
  type VisibleAction = (Action & { label: string }) | FooterHint

  const dialog = useDialog()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  const [store, setStore] = createStore({
    selected: 0,
    filter: "",
    input: "keyboard" as "keyboard" | "mouse",
  })
  const [focusedAction, setFocusedAction] = createSignal<number>()
  const actionFocused = createMemo(() => focusedAction() !== undefined)
  let selection: DialogSelectOption<T> | undefined
  let resetSelection = false
  let visibilityGeneration = 0

  let input: InputRenderable

  const actions = createMemo(() => props.actions ?? [])
  const shownActions = createMemo(() => actions().filter((item) => !item.hidden))
  const actionBindings = useKeymapSelector((keymap) =>
    keymap.getCommandBindings({
      visibility: "registered",
      commands: shownActions().map((item) => item.command),
    }),
  )

  const actionLabels = createMemo(() => {
    const labels = new Map<string, string>()

    for (const action of shownActions()) {
      const label = formatKeyBindings(actionBindings().get(action.command), tuiConfig)
      if (label) labels.set(action.command, label)
    }

    return labels
  })
  const visibleActions = createMemo(() => [
    ...shownActions()
      .map((item) => ({ ...item, label: actionLabels().get(item.command) ?? "" }))
      .filter((item) => item.label),
    ...(props.footerHints ?? []),
  ])
  const actionItems = createMemo(() =>
    visibleActions()
      .filter(isActionItem)
      .filter((item) => !isActionDisabled(item)),
  )

  createEffect(() => {
    const index = focusedAction()
    if (index !== undefined && index >= actionItems().length) setFocusedAction(undefined)
  })

  const filtered = createMemo(() => {
    if (props.skipFilter || props.renderFilter === false) return props.options.filter((x) => x.disabled !== true)
    const needle = store.filter.toLowerCase()
    const options = pipe(
      props.options,
      filter((x) => x.disabled !== true),
    )
    if (!needle) return options

    // prioritize title matches (weight: 2) over category matches (weight: 1).
    // users typically search by the item name, and not its category.
    const result = fuzzysort
      .go(needle, options, {
        keys: ["title", "category"],
        scoreFn: (r) => r[0].score * 2 + r[1].score,
      })
      .map((x) => x.obj)

    return result
  })

  // When the filter changes due to how TUI works, the mousemove might still be triggered
  // via a synthetic event as the layout moves underneath the cursor. This is a workaround to make sure the input mode remains keyboard
  // that the mouseover event doesn't trigger when filtering.
  createEffect(() => {
    filtered()
    setStore("input", "keyboard")
    setFocusedAction(undefined)
  })

  const flatten = createMemo(() => props.flat && store.filter.length > 0)

  const grouped = createMemo<[string, DialogSelectOption<T>[]][]>(() => {
    if (flatten()) return [["", filtered()]]
    const result = pipe(
      filtered(),
      groupBy((x) => x.category ?? ""),
      // mapValues((x) => x.sort((a, b) => a.title.localeCompare(b.title))),
      entries(),
    )
    return result
  })

  const flat = createMemo(() => {
    return pipe(
      grouped(),
      flatMap(([_, options]) => options),
    )
  })

  const rows = createMemo(() => {
    const headers = grouped().reduce((acc, [category], i) => {
      if (!category) return acc
      return acc + (i > 0 ? 2 : 1)
    }, 0)
    // #112：details + previewLines 计入虚拟高度，避免滚动裁切
    return flat().reduce(
      (acc, option) => acc + 1 + (option.details?.length ?? 0) + (option.previewLines?.length ?? 0),
      headers,
    )
  })

  const dimensions = useTerminalDimensions()
  const height = createMemo(() => Math.min(rows(), Math.floor(dimensions().height / 2) - 6))

  const selected = createMemo(() => flat()[store.selected])

  // #279：flatRows 把 identity 计算从每次 active/current 深比较收敛为一次 map：
  // 大列表下 O(n) key 构建替代 O(n) 深比较，key 缺失时保留 undefined 走回退。
  // #279：依赖 flat() 重算，过滤后 index 与渲染列表保持一致
  const flatRows = createMemo<DialogSelectRow<T>[]>(() =>
    // #279：map 顺序即渲染顺序，index 直接可用无需二次查找
    flat().map((option, index) => ({
      option,
      index,
      identityKey: optionIdentityKey(option),
    })),
  )
  const rowsByOption = createMemo(() => {
    // #279：WeakMap 不延长 option 生命周期，options 换代后旧条目可被 GC
    const result = new WeakMap<DialogSelectOption<T>, DialogSelectRow<T>>()
    for (const row of flatRows()) result.set(row.option, row)
    return result
  })
  const currentIndex = createMemo(() => {
    const key = currentIdentityKey(props.current, props.currentKey)
    // #279：O(n) 扫描但只做字符串比较；命中即返回，不做冗余遍历
    if (key !== undefined) return flatRows().findIndex((row) => row.identityKey === key)
    // #279：未提供 current 时返回 -1，保持无高亮状态而非误选第一行
    if (props.current === undefined) return -1
    return flatRows().findIndex((row) => isDeepEqual(row.option.value, props.current))
  })

  // #279：仅 current/currentKey 变化时同步选择；options 更新继续由 preserveSelection 保持锚点。
  createEffect(
    on(
      [() => props.current, () => props.currentKey],
      () => {
        const index = currentIndex()
        if (index >= 0) {
          setStore("selected", index)
          selection = flat()[index]
        }
        // #279：index<0（current 不在列表中）时不动 selected，避免高亮抖动
      },
    ),
  )

  createEffect(
    on(
      () => props.options,
      () => {
        if (!props.preserveSelection) return
        if (resetSelection && store.filter.length > 0) {
          const option = flat()[0]
          if (!option) return
          setStore("selected", 0)
          selection = option
          return
        }
        if (!selection) {
          // #279：初次锚定复用 currentKey 匹配，与高亮和延迟滚动保持同一身份语义。
          const index = currentIndex()
          if (index >= 0) {
            setStore("selected", index)
            selection = flat()[index]
            return
          }
          const option = selected()
          if (!option) return
          selection = option
          return
        }
        const previous = selection
        // #279：重建选项时沿用 option.key；无 key 的对象仍按 value 深比较。
        const key = optionIdentityKey(previous)
        const index = flatRows().findIndex((row) =>
          key !== undefined ? row.identityKey === key : isDeepEqual(row.option.value, previous.value),
        )
        if (index >= 0) {
          const option = flat()[index]
          const moved = index !== store.selected || option.category !== previous.category
          setStore("selected", index)
          selection = option
          if (!moved) return
          const value = option.value
          const generation = ++visibilityGeneration
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (generation !== visibilityGeneration) return
              if (!props.preserveSelection || store.filter.length > 0) return
              const current = selected()
              if (!current) return
              if (key !== undefined ? optionIdentityKey(current) !== key : !isDeepEqual(current.value, value)) return
              scrollToSelection(false)
            })
          })
          return
        }
        const next = Math.min(store.selected, flat().length - 1)
        if (next < 0) return
        setStore("selected", next)
        selection = flat()[next]
      },
    ),
  )
  onCleanup(() => {
    visibilityGeneration++
  })

  createEffect(
    // #279：filter/current 变化后延迟滚动，回调再读取最新 key 与列表。
    on([() => store.filter, () => props.current, () => props.currentKey], ([filter]) => {
      if (filter.length > 0) resetSelection = true
      setTimeout(() => {
        // #279：TUI 布局更新会延后一 tick，滚动目标也必须在 callback 执行时
        // 重新解析。这里不能捕获旧 index，否则 filter/options/current 在
        // timeout 前变化时会滚到错误行。
        if (store.filter.length > 0) {
          // #279：过滤态优先回第一行，current 高亮让位于用户搜索意图；
          // preserve=false 同步重置 selection 锚点，保留锚点逻辑不被搜索残留污染
          moveTo(0, true, false)
          return
        }

        const index = currentIndex()
        if (index >= 0) {
          moveTo(index, true)
        }
      }, 0)
    }),
  )

  function move(direction: number) {
    if (props.locked) return
    if (flat().length === 0) return
    let next = store.selected + direction
    if (next < 0) next = flat().length - 1
    if (next >= flat().length) next = 0
    moveTo(next, true)
  }

  function moveTo(next: number, center = false, preserve = true) {
    setFocusedAction(undefined)
    setStore("selected", next)
    const option = selected()
    if (option) {
      selection = option
      resetSelection = !preserve
    }
    if (option) props.onMove?.(option)
    scrollToSelection(center)
  }

  function scrollToSelection(center: boolean) {
    if (!scroll) return
    let remaining = store.selected
    let index = 0
    // Locate the row by position because a unique renderable ID cannot currently be ensured.
    for (const [category, options] of grouped()) {
      if (category) index++
      if (remaining < options.length) {
        index += remaining
        break
      }
      index += options.length
      remaining -= options.length
    }
    const target = scroll.getChildren()[index]
    if (!target) return
    const y = target.y - scroll.y
    if (center) {
      const centerOffset = Math.floor(scroll.height / 2)
      scroll.scrollBy(y - centerOffset)
    } else {
      if (y >= scroll.height) {
        scroll.scrollBy(y - scroll.height + 1)
      }
      if (y < 0) {
        scroll.scrollBy(y)
        // #279：selected index 为 0 即顶部行，避免为边界判断再做一次深比较
        if (store.selected === 0) {
          scroll.scrollTo(0)
        }
      }
    }
  }

  function submit() {
    if (props.locked) return
    setStore("input", "keyboard")
    const index = focusedAction()
    if (index !== undefined) {
      triggerAction(actionItems()[index])
      return
    }
    const option = selected()
    if (!option) return
    option.onSelect?.(dialog)
    props.onSelect?.(option)
  }

  function moveAction(direction: 1 | -1) {
    if (props.locked) return
    const total = actionItems().length
    if (total === 0) return
    setFocusedAction((index) => {
      if (index === undefined) return direction === 1 ? 0 : total - 1
      const next = index + direction
      return next < 0 || next >= total ? undefined : next
    })
  }

  useBindings(() => {
    const visible = shownActions()

    return {
      commands: [
        {
          name: "dialog.select.prev",
          title: "Previous item",
          category: "Dialog",
          run() {
            setStore("input", "keyboard")
            move(-1)
          },
        },
        {
          name: "dialog.select.next",
          title: "Next item",
          category: "Dialog",
          run() {
            setStore("input", "keyboard")
            move(1)
          },
        },
        {
          name: "dialog.select.page_up",
          title: "Page up",
          category: "Dialog",
          run() {
            setStore("input", "keyboard")
            move(-10)
          },
        },
        {
          name: "dialog.select.page_down",
          title: "Page down",
          category: "Dialog",
          run() {
            setStore("input", "keyboard")
            move(10)
          },
        },
        {
          name: "dialog.select.home",
          title: "First item",
          category: "Dialog",
          run() {
            if (props.locked) return
            setStore("input", "keyboard")
            moveTo(0)
          },
        },
        {
          name: "dialog.select.end",
          title: "Last item",
          category: "Dialog",
          run() {
            if (props.locked) return
            setStore("input", "keyboard")
            moveTo(flat().length - 1)
          },
        },
        {
          name: "dialog.select.submit",
          title: "Select item",
          category: "Dialog",
          run: submit,
        },
        ...visible.map((item) => ({
          name: item.command,
          title: item.title,
          category: "Dialog",
          run() {
            if (props.locked) return
            if (isActionDisabled(item)) return
            setStore("input", "keyboard")
            const option = selected()
            if (!option) return
            item.onTrigger(option)
          },
        })),
      ],
      bindings: [
        ...tuiConfig.keybinds.gather("dialog.select", [
          "dialog.select.prev",
          "dialog.select.next",
          "dialog.select.page_up",
          "dialog.select.page_down",
          "dialog.select.home",
          "dialog.select.end",
          "dialog.select.submit",
        ]),
        ...visible.flatMap((item) => tuiConfig.keybinds.get(item.command)),
        ...(visible.length
          ? [
              {
                key: "tab",
                desc: "Next dialog action",
                group: "Dialog",
                cmd: () => moveAction(1),
              },
              {
                key: "shift+tab",
                desc: "Previous dialog action",
                group: "Dialog",
                cmd: () => moveAction(-1),
              },
            ]
          : []),
        ...(props.bindings ?? []).filter((binding) => {
          if (typeof binding.cmd !== "string") return true
          return visible.some((item) => item.command === binding.cmd)
        }),
      ],
    }
  })

  let scroll: ScrollBoxRenderable | undefined
  const ref: DialogSelectRef<T> = {
    get filter() {
      return store.filter
    },
    get filtered() {
      return filtered()
    },
    moveTo(value) {
      const index = flat().findIndex((option) => isDeepEqual(option.value, value))
      if (index >= 0) moveTo(index, true)
    },
  }
  props.ref?.(ref)

  const left = createMemo(() => visibleActions().filter((item) => item.side !== "right"))
  const right = createMemo(() => visibleActions().filter((item) => item.side === "right"))

  function triggerAction(item: VisibleAction | undefined) {
    if (props.locked) return
    if (!item || !isActionItem(item) || isActionDisabled(item)) return
    setStore("input", "keyboard")
    const option = selected()
    if (!option) return
    item.onTrigger(option)
  }

  function isActionItem(item: VisibleAction): item is Action & { label: string } {
    return "onTrigger" in item
  }

  function isActionDisabled(item: Action) {
    return typeof item.disabled === "function" ? item.disabled(selected()) : item.disabled
  }

  function isActionFocused(item: VisibleAction) {
    if (props.locked) return false
    if (!isActionItem(item)) return false
    return actionItems().indexOf(item) === focusedAction()
  }

  function FooterAction(action: { item: VisibleAction }) {
    if (!isActionItem(action.item))
      return (
        <text>
          <span style={{ fg: theme.text }}>
            <b>{action.item.title}</b>{" "}
          </span>
          <span style={{ fg: theme.textMuted }}>{action.item.label}</span>
        </text>
      )
    const item = action.item
    const active = createMemo(() => isActionFocused(item))
    const disabled = createMemo(() => isActionDisabled(item))
    const fg = selectedForeground(theme)
    return (
      <box
        flexDirection="row"
        backgroundColor={active() ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
        onMouseUp={() => triggerAction(item)}
      >
        <text
          fg={disabled() ? theme.textMuted : active() ? fg : theme.text}
          attributes={active() ? TextAttributes.BOLD : undefined}
        >
          {item.title}
        </text>
        <text fg={disabled() ? theme.textMuted : active() ? fg : theme.textMuted}> {item.label}</text>
      </box>
    )
  }

  return (
    <box gap={1} paddingBottom={1} flexGrow={1}>
      <box paddingLeft={4} paddingRight={4}>
        <box flexDirection="row" justifyContent="space-between">
          {props.titleView ?? (
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {props.title}
            </text>
          )}
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
        <Show when={props.renderFilter !== false}>
          <box paddingTop={1} flexDirection="row" gap={1}>
            <box flexGrow={1}>
              <input
                onInput={(e) => {
                  if (props.locked) return
                  batch(() => {
                    setStore("filter", e)
                    props.onFilter?.(e)
                  })
                }}
                focusedBackgroundColor={theme.backgroundPanel}
                cursorColor={theme.primary}
                cursorStyle={tuiConfig.cursor}
                focusedTextColor={theme.textMuted}
                ref={(r) => {
                  input = r
                  input.traits = { status: "FILTER" }
                  setTimeout(() => {
                    if (!input) return
                    if (input.isDestroyed) return
                    input.focus()
                  }, 1)
                }}
                placeholder={props.placeholder ?? "Search"}
                placeholderColor={theme.textMuted}
              />
            </box>
            {/* #544：可选右侧槽——Session list progressive 搜索把 Spinner 挂在这里；
                flexGrow 包输入框保证窄终端下输入区优先占宽，附属只取固有宽度。*/}
            <Show when={props.filterAccessory}>
              <box flexShrink={0} justifyContent="center">
                {props.filterAccessory}
              </box>
            </Show>
          </box>
        </Show>
      </box>
      {/* 可选头部：渲染在 title/filter 和 scrollbox 之间，增加对话框有效高度 */}
      <Show when={props.header}>
        <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
          {props.header}
        </box>
      </Show>
      <box flexGrow={1} flexShrink={1}>
        <Show
          when={grouped().length > 0}
          fallback={
            props.emptyView ?? (
              <box paddingLeft={4} paddingRight={4} paddingTop={1}>
                <text fg={theme.textMuted}>No results found</text>
              </box>
            )
          }
        >
          <scrollbox
            paddingLeft={1}
            paddingRight={1}
            scrollbarOptions={{ visible: false }}
            scrollAcceleration={scrollAcceleration()}
            ref={(r: ScrollBoxRenderable) => (scroll = r)}
            maxHeight={height()}
          >
            <For each={grouped()}>
              {([category, options], index) => (
                <>
                  <Show when={category}>
                    <box paddingTop={index() > 0 ? 1 : 0} paddingLeft={3}>
                      <Show
                        when={options[0]?.categoryView}
                        fallback={
                          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                            {category}
                          </text>
                        }
                      >
                        {options[0]?.categoryView}
                      </Show>
                    </box>
                  </Show>
                  <For each={options}>
                    {(option) => {
                      // #279：row() 从 rowsByOption 取预建 identity，active/current 判定零深比较
                      const row = createMemo(() => rowsByOption().get(option))
                      const active = createMemo(() => !props.locked && row()?.index === store.selected)
                      const current = createMemo(() => {
                        const value = row()
                        if (!value) return false
                        const key = currentIdentityKey(props.current, props.currentKey)
                        // #279：有 key 走 identity 比较；无 key 的对象 value 保留深比较回退，
                        // 兼容会话列表等未提供 key 的调用方
                        if (key !== undefined) return value.identityKey === key
                        if (props.current === undefined) return false
                        return isDeepEqual(option.value, props.current)
                      })
                      return (
                        <box
                          flexDirection="column"
                          position="relative"
                          onMouseMove={() => {
                            if (props.locked) return
                            // #279：mousemove 仅切输入模式，不移动选中，避免 hover 抢焦点
                            setStore("input", "mouse")
                            setFocusedAction(undefined)
                          }}
                          onMouseUp={() => {
                            if (props.locked) return
                            option.onSelect?.(dialog)
                            props.onSelect?.(option)
                          }}
                          onMouseOver={() => {
                            if (props.locked) return
                            if (store.input !== "mouse") return
                            // #279：row 索引 O(1) 取代 findIndex+isDeepEqual 扫描
                            const index = row()?.index
                            if (index === undefined) return
                            moveTo(index)
                          }}
                          onMouseDown={() => {
                            if (props.locked) return
                            const index = row()?.index
                            if (index === undefined) return
                            moveTo(index)
                          }}
                        >
                          <box
                            flexDirection="row"
                            paddingLeft={current() || option.gutter ? 1 : 3}
                            paddingRight={3}
                            gap={1}
                            backgroundColor={
                              active()
                                ? actionFocused()
                                  ? theme.backgroundElement
                                  : (option.bg ?? theme.primary)
                                : RGBA.fromInts(0, 0, 0, 0)
                            }
                          >
                            <Show when={!current() && option.margin}>
                              <box position="absolute" left={1} flexShrink={0}>
                                {option.margin}
                              </box>
                            </Show>
                            <Option
                              title={option.title}
                              titleView={option.titleView}
                              footer={flatten() ? (option.category ?? option.footer) : option.footer}
                              titleWidth={option.titleWidth}
                              truncateTitle={option.truncateTitle}
                              description={option.description !== category ? option.description : undefined}
                              active={active()}
                              current={current()}
                              muted={actionFocused()}
                              gutter={option.gutter}
                            />
                          </box>
                          <For each={option.details}>
                            {(detail) => (
                              <box paddingLeft={3} paddingRight={3}>
                                <text fg={theme.textMuted} wrapMode="none">
                                  {Locale.truncateMiddle(detail, Math.max(1, Math.min(76, dimensions().width - 12)))}
                                </text>
                              </box>
                            )}
                          </For>
                          {/* #112：previewLines 与 details 同为外层 column 子项，勿塞进 title row */}
                          <For each={option.previewLines}>
                            {(line, index) => (
                              <box paddingLeft={3} paddingRight={3}>
                                <text fg={theme.textMuted} wrapMode="none">
                                  {(index() === (option.previewLines?.length ?? 0) - 1 ? "└─ " : "├─ ") +
                                    Locale.truncateMiddle(line, Math.max(1, Math.min(72, dimensions().width - 16)))}
                                </text>
                              </box>
                            )}
                          </For>
                        </box>
                      )
                    }}
                  </For>
                </>
              )}
            </For>
          </scrollbox>
        </Show>
      </box>
      <Show when={props.footer || visibleActions().length} fallback={<box flexShrink={0} />}>
        <box paddingRight={2} paddingLeft={4} flexDirection="row" justifyContent="space-between" flexShrink={0}>
          <box flexDirection="row" gap={2}>
            {props.footer}
            <For each={left()}>{(item) => <FooterAction item={item} />}</For>
          </box>
          <box flexDirection="row" gap={2}>
            <For each={right()}>{(item) => <FooterAction item={item} />}</For>
          </box>
        </box>
      </Show>
    </box>
  )
}

function Option(props: {
  title: string
  titleView?: JSX.Element
  description?: string
  active?: boolean
  current?: boolean
  muted?: boolean
  footer?: JSX.Element | string
  titleWidth?: number
  truncateTitle?: boolean | "left"
  gutter?: () => JSX.Element
  onMouseOver?: () => void
}) {
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const text = createMemo(() => {
    if (props.active && !props.muted) return fg
    if (props.muted && (props.active || props.current)) return theme.textMuted
    if (props.current) return theme.primary
    return theme.text
  })

  return (
    <>
      <Show when={props.current && !props.gutter}>
        <text flexShrink={0} fg={text()} marginRight={0}>
          ●
        </text>
      </Show>
      <Show when={props.gutter}>
        <box flexShrink={0} marginRight={0}>
          {props.gutter?.()}
        </box>
      </Show>
      <text
        flexGrow={1}
        fg={text()}
        attributes={props.active && !props.muted ? TextAttributes.BOLD : undefined}
        overflow="hidden"
        wrapMode="none"
        paddingLeft={3}
      >
        {props.titleView ??
          (props.truncateTitle === false
            ? props.title
            : props.truncateTitle === "left"
              ? Locale.truncateLeft(props.title, props.titleWidth ?? 61)
              : Locale.truncate(props.title, props.titleWidth ?? 61))}
        <Show when={props.description}>
          <span style={{ fg: props.active && !props.muted ? fg : theme.textMuted }}> {props.description}</span>
        </Show>
      </text>
      <Show when={props.footer}>
        <box flexShrink={0}>
          <text fg={props.active && !props.muted ? fg : theme.textMuted}>{props.footer}</text>
        </box>
      </Show>
    </>
  )
}
