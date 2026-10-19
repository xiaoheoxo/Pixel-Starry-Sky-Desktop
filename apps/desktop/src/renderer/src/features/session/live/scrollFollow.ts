// 对话流贴底与「回到最新」的判断（docs/ui/conversation-ux.md §2.4），纯函数，LiveTranscript 用

import type { Item } from '@pixelsky/protocol'

/** 离底部不到这么多像素算在底部：新内容到达时自动滚到底，「回到最新」不显示 */
export const STICK_PX = 80

/** 用户点过或按过键之后这么久以内，对话流变高不跟着滚到底（例如刚展开一条工具输出，不要把它顶上去） */
export const INTERACT_MS = 500

export interface ScrollBox {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export const nearBottom = (el: ScrollBox): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX

/** 对话流高度变了：贴底、而且用户最近没有操作时才跟到底 */
export const followResize = (stick: boolean, lastInteract: number, now: number): boolean =>
  stick && now - lastInteract >= INTERACT_MS

export interface ScrollPos {
  top: number
  height: number
}

/**
 * 两次滚动事件之间，用户把对话往上滚了：位置往上走，而且对话流没有变矮。
 * 对话流变矮（下面的卡片收起）时浏览器也会把位置往上夹，那不算用户往上滚
 */
export const scrolledUp = (prev: ScrollPos | null, now: ScrollPos): boolean =>
  !!prev && now.top < prev.top - 1 && now.height >= prev.height

const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

/** 往上滚的按键：↑、PageUp、Home、Shift+空格 */
export const scrollUpKey = (e: { key: string; shiftKey: boolean }): boolean =>
  UP_KEYS.has(e.key) || (e.key === ' ' && e.shiftKey)

/**
 * 滚轮落在对话里一个自己能往上滚的框里（命令输出、代码块等）：这一格滚的是那个框，不是对话，
 * 不算离开底部。target 往上找到 root（不含）为止
 */
export function innerCanScrollUp(target: Element | null, root: Element): boolean {
  for (let el = target; el && el !== root; el = el.parentElement) {
    if (el.scrollTop <= 0 || el.scrollHeight <= el.clientHeight + 1) continue
    const overflow = getComputedStyle(el).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return true
  }
  return false
}

/**
 * 对话区或对话流的高度变了，怎么处理：follow 滚到底；否则按实际位置重新判断是否离开底部。
 * 不管原来贴不贴底都要重新判断：离底部一两百像素时，下面的卡片收起、执行块收起会让底部"自己靠过来"，
 * 这时不一定有滚动事件，不判断的话「回到最新」会留在已经到底的对话上。
 * hold（搜索跳转后，或用户自己往上滚了）只更新按钮，不恢复贴底：用户往上滚了 30px、还在 80px 以内时，
 * 新内容进来不能又把它拉回底部
 */
export function afterResize(
  el: ScrollBox,
  stick: boolean,
  hold: boolean,
  lastInteract: number,
  now: number,
): { follow: true } | { follow: false; stick: boolean; away: boolean } {
  if (followResize(stick, lastInteract, now)) return { follow: true }
  const near = nearBottom(el)
  return { follow: false, stick: hold ? stick : near, away: !near }
}

/**
 * 「回到最新」的滑动被打断（用户滚轮 / 按键 / 拖滚动条等）：位置交给用户，按实际位置重新判断，
 * 不然 jumpToLatest 预先置的贴底会留着，下一段流式内容又把他拽回底部。
 * detached（搜索跳转后暂停）时不改 stick；released（用户往上滚了）时不恢复贴底
 */
export function afterGlideCancel(
  el: ScrollBox,
  stick: boolean,
  detached: boolean,
  released: boolean,
): { stick: boolean; away: boolean } {
  const near = nearBottom(el)
  return { stick: detached ? stick : near && !released, away: !near }
}

/** 一条的文字长度：流式输出时它变长，算有新内容 */
function grownLength(item: Item | undefined): number {
  switch (item?.kind) {
    case 'assistant':
    case 'reasoning':
      return item.text.length
    case 'command':
    case 'tool':
      return item.output.length
    default:
      return 0
  }
}

/** 内容标记：条目增加，或者最后一条变长，标记就变；离开底部期间标记变了算「有新内容」 */
export function contentMark(items: readonly Item[]): string {
  const last = items[items.length - 1]
  return `${items.length}:${last?.id ?? ''}:${grownLength(last)}`
}
