import { useEffect, useRef, type RefObject, type UIEvent } from 'react'
import {
  afterResize,
  followAfterScroll,
  nearBottom as isNearBottom,
  type ScrollPos,
} from '@/features/session/live/scrollFollow'

/**
 * 列表高度变了（卡片长高、图片解码、输入框变高）不一定多一条消息：在底部时跟到底，判断和对话流一样。
 * 用户刚点过或按过键（多半是展开了什么）就不跟，按实际位置重新判断。内容是滚动框的第一个子元素；返回值展开到滚动框上
 */
export function useFollowBottom(scroller: RefObject<HTMLElement | null>, following: { current: boolean }) {
  const lastInteract = useRef(0)
  const lastPos = useRef<ScrollPos | null>(null)
  useEffect(() => {
    const el = scroller.current,
      content = el?.firstElementChild
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const next = afterResize(el, following.current, false, lastInteract.current, performance.now())
      if (next.follow) el.scrollTop = el.scrollHeight
      else following.current = next.stick
    })
    observer.observe(content)
    observer.observe(el)
    return () => observer.disconnect()
  }, [scroller, following])
  const interacted = (): void => {
    lastInteract.current = performance.now()
  }
  return {
    onPointerDown: interacted,
    onKeyDown: interacted,
    onScroll: (e: UIEvent<HTMLElement>): void => {
      const el = e.currentTarget,
        pos = { top: el.scrollTop, height: el.scrollHeight }
      following.current = followAfterScroll(following.current, lastPos.current, pos, isNearBottom(el))
      lastPos.current = pos
    },
  }
}
