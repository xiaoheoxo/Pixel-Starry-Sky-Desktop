// 对话标签卸载后再挂载时恢复位置（docs/ui/renderer-memory.md §3.3.3，D123）：
// 滚动位置、是不是贴着底部、D121 显示的轮数（不在底部时，已经显示的不会被再藏回去；贴着底部时不存，回来按设置重新折叠）都按会话 id 存在这里。
// 其余看的状态（展开的工具输出、查找框、追踪面板）不存，卸载后回到默认。
import { SESSION_REMOVED_EVENT } from '@/features/engine/sessionLifecycle'

export interface TranscriptPlace {
  /** D121 的窗口：从头隐藏了几轮；null：没存（贴着底部时不存，回来按设置的轮数重新折叠，A7） */
  hidden: number | null
  /** 当时是不是贴着底部（stick） */
  atBottom: boolean
  /** 最上面那条可见条目和它离对话区顶部的距离 */
  anchor: { itemId: string; offset: number } | null
  /** 找不到锚点时的退路 */
  scrollTop: number
}

/** 最多记这么多个会话，旧的丢掉 */
export const MAX_PLACES = 100

// Map 保持插入顺序：每次存都先删再放，最前面的就是最久没动过的
const places = new Map<string, TranscriptPlace>()

export function savePlace(sessionId: string, place: TranscriptPlace): void {
  places.delete(sessionId)
  // 贴着底部离开的：窗口不存。不然点过「显示全部」的长对话切走再回来还是全量挂在 DOM 上
  places.set(sessionId, place.atBottom && place.hidden !== null ? { ...place, hidden: null } : place)
  while (places.size > MAX_PLACES) places.delete(places.keys().next().value as string)
}

export const placeOf = (sessionId: string | null): TranscriptPlace | null =>
  (sessionId && places.get(sessionId)) || null

export const forgetPlace = (sessionId: string): void => void places.delete(sessionId)

// 会话删除 / 归档时一起丢（和 engine store 清理快照同一个信号）
if (typeof window !== 'undefined')
  window.addEventListener(SESSION_REMOVED_EVENT, e => {
    for (const id of (e as CustomEvent<{ ids?: string[] }>).detail?.ids ?? []) forgetPlace(id)
  })

/**
 * 重新挂载时隐藏几轮：有保存的就用它（切到别的标签再回来，已经显示的保持）；
 * 设置是「全部」(windowSize 为 null) 时不隐藏；轻量模式（capped）下至少隐藏到只显示设置的轮数；
 * 离开时贴着底部（atBottom）的也一样取较大的，不让展开过的窗口一直留着
 */
export function restoredHidden(
  saved: number | null,
  wanted: number,
  windowSize: number | null,
  capped: boolean,
  atBottom = false,
): number {
  if (windowSize === null) return 0
  if (saved === null) return wanted
  return capped || atBottom ? Math.max(saved, wanted) : saved
}

/** 记下最上面那条底边在可见区下面的条目的位置（和「显示更早的」保持位置用的是同一个办法） */
export function anchorOf(scroller: HTMLElement): TranscriptPlace['anchor'] {
  const box = scroller.getBoundingClientRect()
  for (const row of scroller.querySelectorAll<HTMLElement>('[data-search-item]')) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom > box.top + 1 && row.dataset.searchItem)
      return { itemId: row.dataset.searchItem, offset: rect.top - box.top }
  }
  return null
}

/** 把对话区滚回保存的位置：先按锚点，条目不在了用 scrollTop */
export function scrollToPlace(scroller: HTMLElement, place: TranscriptPlace): void {
  const row = place.anchor
    ? Array.from(scroller.querySelectorAll<HTMLElement>('[data-search-item]')).find(
        e => e.dataset.searchItem === place.anchor?.itemId,
      )
    : undefined
  if (row && place.anchor)
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - place.anchor.offset
  else scroller.scrollTop = place.scrollTop
}

// 遥测（docs/ui/renderer-memory.md §3.2.1）：挂着的对话流和各自显示的轮数
const views = new Map<symbol, () => number>()

/** 登记一个挂着的对话流；返回取消登记的函数 */
export function registerTranscriptView(shownTurns: () => number): () => void {
  const key = Symbol('transcript-view')
  views.set(key, shownTurns)
  return () => void views.delete(key)
}

export const transcriptViewStats = (): { sessionViews: number; shownTurnsMax: number } => ({
  sessionViews: views.size,
  shownTurnsMax: Math.max(0, ...[...views.values()].map(f => f())),
})
