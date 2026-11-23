export type DotScrollPosition =
  | { bottom: true }
  | { bottom: false; top: number; anchor?: { id: string; offset: number } }

export const DOT_BOTTOM: DotScrollPosition = { bottom: true }

export function nearDotBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
}: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return scrollHeight - scrollTop - clientHeight <= 48
}

export function captureDotScroll(scroller: HTMLElement, messages: HTMLElement): DotScrollPosition {
  if (nearDotBottom(scroller)) return DOT_BOTTOM
  const viewport = scroller.getBoundingClientRect().top
  for (const node of messages.children) {
    const id = (node as HTMLElement).dataset.dotScrollRow
    if (!id) continue
    const box = node.getBoundingClientRect()
    if (box.bottom > viewport)
      return { bottom: false, top: scroller.scrollTop, anchor: { id, offset: box.top - viewport } }
  }
  return { bottom: false, top: scroller.scrollTop }
}

export function restoreDotScroll(scroller: HTMLElement, messages: HTMLElement, position: DotScrollPosition): void {
  if (position.bottom) {
    scroller.scrollTop = scroller.scrollHeight
    return
  }
  const row =
    position.anchor &&
    Array.from(messages.children).find(node => (node as HTMLElement).dataset.dotScrollRow === position.anchor?.id)
  scroller.scrollTop =
    row && position.anchor
      ? scroller.scrollTop +
        row.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        position.anchor.offset
      : position.top
}
