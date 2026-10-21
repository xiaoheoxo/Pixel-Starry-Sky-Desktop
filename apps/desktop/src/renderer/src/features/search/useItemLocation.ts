import { tr } from '../../i18n/core'
import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { useToast } from '@/ui'
import { scrollInPane } from '@/ui/scrollInPane'
import { expandItems } from './expand'
import { finishItemNavigation, useItemNavigation, type ItemNavigation } from './navigation'
import { findRanges, setMarks } from './termMarks'

/** 跳转后命中的词标多久 */
const MARK_MS = 3000

/**
 * 该不该开始定位：目标是这个会话、内容就绪才开始。开始时对同一个目标再请求一次展开，
 * 把请求时间刷新成现在——标签先要挂载、快照可能还要重新拉，navigateToItem 时的请求可能已经过期
 * （docs/ui/renderer-memory.md §3.3.3）
 */
export function beginLocate(
  target: ItemNavigation | null,
  sessionId: string | null,
  ready: boolean,
  now?: number,
): boolean {
  if (!target || target.sessionId !== sessionId || !ready) return false
  expandItems(target.sessionId, [target.itemId], now)
  return true
}

/** 等会话 / 隐藏标签渲染完成后定位，仅执行一次。 */
export function useItemLocation(
  sessionId: string | null,
  scroller: RefObject<HTMLDivElement | null>,
  ready: boolean,
  onLocate?: () => void,
) {
  const target = useItemNavigation()
  const latestLocate = useRef(onLocate)
  latestLocate.current = onLocate
  const [highlight, setHighlight] = useState<string | null>(null)
  // 定位到的条目和搜索词：单独保存，跳转结束（target 清空）后还要标出命中
  const [marked, setMarked] = useState<{ el: HTMLElement; terms: string[] } | null>(null)
  const owner = useId()
  const toast = useToast()
  useEffect(() => {
    if (!target || !beginLocate(target, sessionId, ready)) return
    let frame = 0,
      disposed = false
    const deadline = performance.now() + 2500
    const attempt = () => {
      const root = scroller.current
      if (disposed) return
      const el =
        root &&
        Array.from(root.querySelectorAll<HTMLElement>('[data-search-item]')).find(
          e => e.dataset.searchItem === target.itemId,
        )
      if (el && el.getBoundingClientRect().height > 0 && !el.closest('[inert],[aria-hidden="true"]')) {
        latestLocate.current?.()
        scrollInPane(el, 'center', { pane: root, behavior: 'instant' })
        setHighlight(target.itemId)
        if (target.terms.length) setMarked({ el, terms: target.terms })
        finishItemNavigation(target.token)
        return
      }
      if (performance.now() < deadline) frame = requestAnimationFrame(attempt)
      else {
        finishItemNavigation(target.token)
        toast(tr('search.useItemLocation.thisContentNoLonger'))
      }
    }
    frame = requestAnimationFrame(attempt)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
    }
  }, [target, sessionId, ready, scroller, toast])
  // 命中的词标出来（docs/ui/content-highlight.md §2 E）：工具行会先自动展开，等两帧再找文字，3 秒后清掉
  useEffect(() => {
    if (!marked) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setMarks('search-term', owner, findRanges(marked.el, marked.terms)))
    })
    const timer = window.setTimeout(() => setMarked(null), MARK_MS)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      setMarks('search-term', owner, [])
    }
  }, [marked, owner])
  useEffect(() => {
    if (!highlight) return
    const timer = window.setTimeout(() => setHighlight(null), 2000)
    return () => window.clearTimeout(timer)
  }, [highlight])
  return highlight
}
