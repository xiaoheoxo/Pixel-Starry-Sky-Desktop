import { useLayoutEffect, useRef, type RefObject } from 'react'

// 动画的时长和曲线是设计变量 --dur-move / --ease-move（styles/tokens.css）；读不到时用这里的默认值，两边保持一致
const MOVE_MS = 320
const MOVE_EASE = 'cubic-bezier(0.65, 0, 0.35, 1)'

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function moveDuration(): number {
  const raw = cssVar('--dur-move')
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return MOVE_MS
  return raw.endsWith('ms') ? n : raw.endsWith('s') ? n * 1000 : n
}

/** 量容器里每个带 data-flip-key 的行现在的位置（含正在播的动画造成的偏移，也就是眼睛现在看到的位置）；收起 / 看不见的行不量 */
function measure(root: HTMLElement): Map<string, number> {
  const tops = new Map<string, number>()
  for (const el of root.querySelectorAll<HTMLElement>('[data-flip-key]')) {
    if (el.closest('[inert]')) continue
    const rect = el.getBoundingClientRect()
    if (rect.height === 0) continue
    tops.set(el.dataset.flipKey!, rect.top)
  }
  return tops
}

/**
 * 列表换顺序时，行从旧位置滑到新位置（FLIP）：translateY(dy) → none，不留 fill，动画结束后没有残留 transform。
 * - 行用 data-flip-key 标记（同一个容器里不能重复，同一个会话出现在两个列表里要用不同的前缀）
 * - order 是「顺序签名」（行的 key 按顺序拼起来）：只有它变了才动，展开 / 收起、窗口缩放这类布局变化不会滑
 * - enabled 为 false（动画关了）时直接换，不做动画
 * - 新出现的行、不见的行没有「旧位置」/「新位置」，不动；正在播的动画先取消，从眼下的位置接着滑
 * 旧位置在渲染阶段量（这时 DOM 还没改），新位置在 useLayoutEffect 里量，同一次提交内完成，不会闪
 */
export function useFlip(root: RefObject<HTMLElement | null>, order: string, enabled: boolean): void {
  const committed = useRef<string | null>(null)
  const first = useRef<Map<string, number> | null>(null)
  const running = useRef(new Map<string, Animation>())

  // 渲染阶段：顺序要变了，趁 DOM 还是旧的，量一遍旧位置
  if (enabled && committed.current !== null && order !== committed.current && root.current) {
    first.current = measure(root.current)
  }

  useLayoutEffect(() => {
    const el = root.current
    const before = first.current
    first.current = null
    committed.current = order
    const animations = running.current
    if (!before || !el || !enabled) return
    // 上一轮没播完的取消掉，才能量到干净的新位置（旧位置已经包含了它们的偏移）
    for (const a of animations.values()) a.cancel()
    animations.clear()
    const after = measure(el)
    const duration = moveDuration()
    const easing = cssVar('--ease-move') || MOVE_EASE
    for (const row of el.querySelectorAll<HTMLElement>('[data-flip-key]')) {
      const key = row.dataset.flipKey!
      const from = before.get(key)
      const to = after.get(key)
      if (from === undefined || to === undefined) continue
      const dy = from - to
      if (Math.abs(dy) < 1) continue
      const animation = row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration, easing })
      animations.set(key, animation)
      const done = (): void => {
        if (animations.get(key) === animation) animations.delete(key)
      }
      animation.onfinish = done
      animation.oncancel = done
    }
  }, [order, enabled, root])

  // 卸载时把没播完的取消掉
  useLayoutEffect(() => {
    const animations = running.current
    return () => {
      for (const a of animations.values()) a.cancel()
      animations.clear()
    }
  }, [])
}
