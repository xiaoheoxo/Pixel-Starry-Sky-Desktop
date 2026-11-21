// 画面停止刷新写进本机日志（docs/ui/logging.md §4.9）：窗口在前台、页面计时器照常在跳，却连着几秒画不出一帧。
// GPU 进程卡住（内存紧张后从磁盘换回来、显卡驱动出问题）时就是这样：按钮点得动、屏幕停在旧的那一帧，别的日志都看不出来。
import type { FrameReport } from '../../../../preload/log'
import { pageElements } from './longTasks'

export const FRAME_TICK_MS = 1_000
/** 准时跳了这么多次都没等到那一帧，算画面停住 */
export const FRAME_STALL_TICKS = 3
/** 计时器晚到超过这么久：主线程被占住了（那是「界面卡住」），这一跳不算数 */
const LATE_MS = FRAME_TICK_MS * 2

export type FrameEvent =
  | { kind: 'probe' }
  | { kind: 'stalled'; stalledMs: number }
  | { kind: 'recovered'; stalledMs: number; inactiveDuring: boolean }

/**
 * 每跳请求一帧，看后面几跳之前回没回来（不常开动画循环）。
 * active：页面可见、有焦点；不在前台、看不见本来就不画，计时器晚到说明主线程被占住，这些跳都重新数。
 */
export function frameWatch() {
  let pending = false
  let since = 0
  let lastTick: number | null = null
  let onTime = 0
  let stalled = false
  let inactiveDuring = false
  return {
    tick(now: number, active: boolean): FrameEvent | null {
      const late = lastTick !== null && now - lastTick > LATE_MS
      lastTick = now
      if (!pending) {
        if (!active) return null
        pending = true
        since = now
        onTime = 0
        return { kind: 'probe' }
      }
      if (stalled) {
        if (!active) inactiveDuring = true
        return null
      }
      if (!active || late) {
        since = now
        onTime = 0
        return null
      }
      if (++onTime < FRAME_STALL_TICKS) return null
      stalled = true
      return { kind: 'stalled', stalledMs: now - since }
    },
    /** 请求的那一帧回来了 */
    frame(now: number): FrameEvent | null {
      if (!pending) return null
      const event: FrameEvent | null = stalled ? { kind: 'recovered', stalledMs: now - since, inactiveDuring } : null
      pending = false
      stalled = false
      inactiveDuring = false
      return event
    },
  }
}

type HeapInfo = { usedJSHeapSize: number }

/** 装上检测（只装在主窗口）；返回卸下（测试用） */
export function installFrameStallLog(): () => void {
  const bridge = window.pixelsky?.log
  if (!bridge?.frames || typeof requestAnimationFrame === 'undefined') return () => {}
  const watch = frameWatch()
  let inputAt: number | undefined
  /** 页面上次从看不见变成看得见（还原、不再被挡住）的时刻；加载后一直看得见为 undefined */
  let visibleAt: number | undefined
  const onInput = (): void => {
    inputAt = performance.now()
  }
  const onVisibility = (): void => {
    if (!document.hidden) visibleAt = performance.now()
  }
  const sinceInput = (now: number): Partial<FrameReport> =>
    inputAt === undefined ? {} : { sinceInputMs: Math.round(now - inputAt) }
  const onFrame = (): void => {
    const now = performance.now()
    const event = watch.frame(now)
    if (event?.kind !== 'recovered') return
    bridge.frames({
      state: 'recovered',
      stalledMs: Math.round(event.stalledMs),
      ...(event.inactiveDuring ? { inactiveDuring: true } : {}),
      ...sinceInput(now),
    })
  }
  const timer = setInterval(() => {
    const now = performance.now()
    const event = watch.tick(now, !document.hidden && document.hasFocus())
    if (event?.kind === 'probe') requestAnimationFrame(onFrame)
    else if (event?.kind === 'stalled') {
      const heap = (performance as Performance & { memory?: HeapInfo }).memory
      bridge.frames({
        state: 'stalled',
        stalledMs: Math.round(event.stalledMs),
        ...sinceInput(now),
        ...(visibleAt !== undefined ? { sinceVisibleMs: Math.round(now - visibleAt) } : {}),
        elements: pageElements(),
        ...(heap ? { heapMb: Math.round(heap.usedJSHeapSize / 1048576) } : {}),
      })
    }
  }, FRAME_TICK_MS)
  const opts = { capture: true, passive: true }
  window.addEventListener('pointerdown', onInput, opts)
  window.addEventListener('keydown', onInput, opts)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    clearInterval(timer)
    window.removeEventListener('pointerdown', onInput, opts)
    window.removeEventListener('keydown', onInput, opts)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
