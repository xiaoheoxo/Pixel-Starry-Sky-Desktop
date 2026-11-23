import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { captureDotScroll, DOT_BOTTOM, nearDotBottom, restoreDotScroll, type DotScrollPosition } from './scrollPosition'
import { dotViewCache } from './viewCache'

export function useDotScroll(roomKey: string, visible: boolean) {
  const scroller = useRef<HTMLDivElement>(null)
  const messages = useRef<HTMLDivElement>(null)
  const [initial] = useState(() => dotViewCache.readScroll(roomKey) ?? DOT_BOTTOM)
  const position = useRef(initial)
  const shown = useRef(visible)
  shown.current = visible
  const prepend = useRef<DotScrollPosition | null>(null)
  const wasVisible = useRef(false)
  const [showJump, setShowJump] = useState(false)

  const trackScroll = () => {
    const el = scroller.current
    if (!visible || !el?.clientHeight || !messages.current) return
    position.current = captureDotScroll(el, messages.current)
    dotViewCache.putScroll(roomKey, position.current)
    setShowJump(!position.current.bottom)
  }

  // Snapshot the visible row just before inserting older messages, not at fetch start.
  const beforePrepend = useCallback(() => {
    const el = scroller.current
    if (shown.current && el?.clientHeight && messages.current) prepend.current = captureDotScroll(el, messages.current)
  }, [])

  // Before painting a reactivated tab, restore the last visible row or pin the latest message.
  useLayoutEffect(() => {
    const el = scroller.current
    const list = messages.current
    const canMeasure = Boolean(visible && el?.clientHeight && list)
    if (canMeasure && el && list) {
      const wanted = prepend.current ?? (!wasVisible.current || position.current.bottom ? position.current : null)
      if (wanted) {
        restoreDotScroll(el, list, wanted)
        prepend.current = null
      }
      setShowJump(!nearDotBottom(el))
    }
    wasVisible.current = canMeasure
  })

  // Images, composer height and asynchronous Markdown can change geometry without a chat render.
  useLayoutEffect(() => {
    const el = scroller.current
    const list = messages.current
    if (!visible || !el || !list || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!el.clientHeight) {
        wasVisible.current = false
        return
      }
      if (position.current.bottom || !wasVisible.current) {
        restoreDotScroll(el, list, position.current)
        wasVisible.current = true
      }
      setShowJump(!nearDotBottom(el))
    })
    observer.observe(el)
    observer.observe(list)
    return () => observer.disconnect()
  }, [visible])

  const jumpToBottom = () => {
    const el = scroller.current
    if (!el?.clientHeight || !messages.current) return
    position.current = DOT_BOTTOM
    prepend.current = null
    restoreDotScroll(el, messages.current, DOT_BOTTOM)
    dotViewCache.putScroll(roomKey, DOT_BOTTOM)
    setShowJump(false)
    el.focus({ preventScroll: true })
  }
  return { scroller, messages, showJump, trackScroll, beforePrepend, jumpToBottom }
}
