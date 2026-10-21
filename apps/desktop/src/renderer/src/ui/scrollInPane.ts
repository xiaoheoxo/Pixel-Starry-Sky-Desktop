// 把元素滚到它所在滚动区域的开头 / 中间 / 刚好看得见（nearest），只滚这一个区域。
// 不用 el.scrollIntoView：它会把所有能滚的上层都滚一遍，连 overflow: hidden 的外层（设置弹窗的遮罩、
// 主界面的布局容器）也会被滚动，整块界面被顶出窗口；nearest 在元素被外层裁掉时也一样。

/** 最近的能滚动的上层（overflow-y 为 auto / scroll） */
export function scrollPaneOf(el: HTMLElement): HTMLElement | null {
  let pane = el.parentElement
  while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement
  return pane
}

export function scrollInPane(
  el: Element | null | undefined,
  block: 'start' | 'center' | 'nearest',
  opts: { pane?: HTMLElement | null; behavior?: ScrollBehavior } = {},
): void {
  if (!(el instanceof HTMLElement)) return
  const pane = opts.pane ?? scrollPaneOf(el)
  if (!pane) return
  const box = el.getBoundingClientRect()
  const offset = box.top - pane.getBoundingClientRect().top - pane.clientTop
  let top: number
  if (block === 'start') top = pane.scrollTop + offset
  else if (block === 'center') top = pane.scrollTop + offset - (pane.clientHeight - box.height) / 2
  else if (offset < 0) top = pane.scrollTop + offset
  else if (offset + box.height > pane.clientHeight)
    top = pane.scrollTop + offset + Math.min(box.height, pane.clientHeight) - pane.clientHeight
  else return
  pane.scrollTo({ top: Math.max(0, top), behavior: opts.behavior ?? 'auto' })
}
