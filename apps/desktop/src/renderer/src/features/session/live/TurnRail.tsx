// 对话区右边的滚动条，带轮次刻度（docs/ui/turn-rail.md §8）：原来的轮次跳转条和滚动条合成一条。
// 刻度画在每一轮的实际位置上，和滑块同一把尺子；滑块能拖，点空白处滚到那里，点刻度附近跳到那一轮；
// 鼠标停一会儿在旁边展开轮次列表。设置里关掉轮次时只剩滚动条
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { motionEnabled, onPaneSettled, paneMoving, settledResizeObserver } from '@/features/panes/motion'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { cn } from '@/ui'
import { clampIndex, currentTurn, placeTicks, thumbOf, tickAt, topsFor, type Turn } from './turnRailModel'

/** 滑轨上下留的空 */
const PAD = 4
// 滑块和刻度离右边 5–6px：右侧面板、分屏的拖动条（8px 宽，骑在边线上）会盖住对话区最右边 4px
/** 展开 / 收起列表的延迟：只是路过、去拖滑块时不弹 */
const OPEN_DELAY = 300
const CLOSE_DELAY = 220

interface Metrics {
  scrollTop: number
  view: number
  content: number
  track: number
}

export function TurnRail({
  turns,
  scroller,
  showTurns,
  onBeforeJump,
  onGrab,
  hiddenTurns = 0,
  onShowEarlier,
}: {
  turns: Turn[]
  scroller: RefObject<HTMLDivElement | null>
  /** 设置里的「滚动条上显示轮次」 */
  showTurns: boolean
  /** 跳转前：暂停「贴底跟随」，不然新内容会把视口拉回底部 */
  onBeforeJump: () => void
  /** 在滑块 / 滑轨上按下（拖动、点轨道、点刻度）：滚动权在用户手里了，打断「回到最新」的滑动 */
  onGrab?: () => void
  /** 上面还有几轮没显示（docs/ui/turn-rail.md §9）：滑轨顶部的小标记、列表第一行；turns 只含显示出来的轮 */
  hiddenTurns?: number
  /** 点标记或列表第一行：显示更早的一批 */
  onShowEarlier?: () => void
}) {
  useI18n()
  const rail = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drag = useRef<{ pointer: number; y: number; top: number } | null>(null)
  const [metrics, setMetrics] = useState<Metrics>({ scrollTop: 0, view: 0, content: 0, track: 0 })
  // 量到的位置连同它们对应的轮 id 一起存：turns 缩短 / 换批（回退）后，渲染时按 id 对回当前的轮，不会越界
  const [measured, setMeasured] = useState<{ ids: string[]; tops: number[] }>({ ids: [], tops: [] })
  const [rawCurrent, setCurrent] = useState(0)
  const current = clampIndex(rawCurrent, turns.length)
  const [open, setOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const withTurns = showTurns && turns.length >= 2

  const elementOf = (id: string): HTMLElement | null =>
    scroller.current?.querySelector<HTMLElement>(`[data-search-item="${CSS.escape(id)}"]`) ?? null

  // 尺寸和每一轮的位置：内容高度变了（排版出真实高度、新消息）、窗格大小变了时重量
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      const base = el.getBoundingClientRect().top - el.scrollTop
      setMeasured(
        withTurns
          ? {
              ids: turns.map(t => t.id),
              tops: turns.map(t => {
                const row = elementOf(t.id)
                return row ? row.getBoundingClientRect().top - base : Number.POSITIVE_INFINITY
              }),
            }
          : { ids: [], tops: [] },
      )
      setMetrics({
        scrollTop: el.scrollTop,
        view: el.clientHeight,
        content: el.scrollHeight,
        track: Math.max(0, (rail.current?.clientHeight ?? el.clientHeight) - PAD * 2),
      })
    }
    const soon = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    const ro = settledResizeObserver(soon)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => {
      ro.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
    // elementOf 只读 scroller
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller, turns, withTurns])

  // 滚动：滑块跟着走，算当前轮（每帧最多一次）
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let frame = 0,
      pending = false
    const update = (): void => {
      frame = 0
      setMetrics(m => ({ ...m, scrollTop: el.scrollTop, view: el.clientHeight, content: el.scrollHeight }))
      if (!withTurns) return
      const base = el.getBoundingClientRect().top - el.scrollTop
      const rows = turns.map(t => {
        const row = elementOf(t.id)
        return row ? row.getBoundingClientRect().top - base : Number.POSITIVE_INFINITY
      })
      // 滚到底时最后一轮可能很短、顶部还没到视口顶部：也算最后一轮
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4
      setCurrent(atBottom ? turns.length - 1 : currentTurn(rows, el.scrollTop))
    }
    // 窗格过渡期间贴底的对话每帧都在滚：先不算当前轮（要量每一轮的位置），结束后补一次
    const onScroll = (): void => {
      if (paneMoving(el)) {
        pending = true
        setMetrics(m => ({ ...m, scrollTop: el.scrollTop, content: el.scrollHeight }))
      } else if (!frame) frame = requestAnimationFrame(update)
    }
    const off = onPaneSettled(() => {
      if (!pending) return
      pending = false
      update()
    })
    update()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      off()
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller, turns, withTurns])

  const jump = (index: number): void => {
    const el = scroller.current
    const turn = turns[clampIndex(index, turns.length)]
    const row = turn && elementOf(turn.id)
    if (!el || !row) return
    onBeforeJump()
    setCurrent(clampIndex(index, turns.length))
    const targetTop = (): number => row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12
    // 上面没排版过的块高度是估的，滚到后才算出真实高度、把目标顶走：之后 0.8 秒内每帧对齐一次，用户自己滚动就停
    const settle = (): void => {
      const until = performance.now() + 800
      let stopped = false
      const stop = (): void => {
        stopped = true
      }
      el.addEventListener('wheel', stop, { once: true, passive: true })
      el.addEventListener('pointerdown', stop, { once: true })
      const step = (): void => {
        if (stopped) return
        const want = targetTop()
        if (Math.abs(want - el.scrollTop) > 2) el.scrollTop = want
        if (performance.now() < until) requestAnimationFrame(step)
        else {
          el.removeEventListener('wheel', stop)
          el.removeEventListener('pointerdown', stop)
        }
      }
      requestAnimationFrame(step)
    }
    scrollToward(el, targetTop(), settle)
  }

  const thumb = thumbOf(metrics.scrollTop, metrics.view, metrics.content, metrics.track)
  if (!thumb) return null
  const ticks = withTurns ? placeTicks(topsFor(turns, measured), metrics.content, metrics.track, current) : []

  const later = (next: boolean, delay: number): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(next), delay)
  }
  const go = (index: number): void => {
    jump(index)
    setOpen(false)
  }
  const showEarlier = (): void => {
    setOpen(false)
    onShowEarlier?.()
  }
  const railY = (clientY: number): number => clientY - (rail.current?.getBoundingClientRect().top ?? 0) - PAD

  const onPointerDown = (e: PointerEvent<HTMLElement>): void => {
    const el = scroller.current
    if (!el || e.button !== 0) return
    e.preventDefault()
    onGrab?.()
    if (timer.current) clearTimeout(timer.current)
    setOpen(false)
    const y = railY(e.clientY)
    // 按在滑块上：拖
    if (y >= thumb.top && y <= thumb.top + thumb.height) {
      drag.current = { pointer: e.pointerId, y: e.clientY, top: el.scrollTop }
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(true)
      return
    }
    // 点在刻度附近：跳到那一轮；否则把那个位置滚到视口中间
    const tick = tickAt(ticks, y)
    if (tick) {
      jump(tick.index)
      return
    }
    scrollToward(el, (y / metrics.track) * metrics.content - metrics.view / 2)
  }
  const onPointerMove = (e: PointerEvent<HTMLElement>): void => {
    const el = scroller.current
    const d = drag.current
    if (!el || !d || d.pointer !== e.pointerId) return
    el.scrollTop = d.top + ((e.clientY - d.y) * metrics.content) / Math.max(1, metrics.track)
  }
  const endDrag = (e: PointerEvent<HTMLElement>): void => {
    if (drag.current?.pointer !== e.pointerId) return
    drag.current = null
    setDragging(false)
  }

  const onKey = (e: KeyboardEvent): void => {
    if (!withTurns || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter')) return
    e.preventDefault()
    setOpen(true)
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>('[aria-current]')?.focus())
  }
  const onListKey = (e: KeyboardEvent): void => {
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('[data-turn-item]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      scroller.current?.focus({ preventScroll: true })
      return
    }
    const move = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
    if (!move) return
    e.preventDefault()
    items[Math.min(items.length - 1, Math.max(0, at + move))]?.focus()
  }

  return (
    <nav
      ref={rail}
      data-turn-rail
      aria-label={tr('turnRail.label')}
      className="group/rail absolute top-0 right-0 bottom-0 z-10 w-[18px]"
      onMouseEnter={() => withTurns && !drag.current && later(true, OPEN_DELAY)}
      onMouseLeave={() => later(false, CLOSE_DELAY)}
      onFocus={() => withTurns && later(true, 0)}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) later(false, 0)
      }}
    >
      {/* 滑轨：拖滑块、点位置、点刻度；滚轮照常滚对话 */}
      <div
        role={withTurns ? 'button' : undefined}
        tabIndex={withTurns ? 0 : undefined}
        aria-expanded={withTurns ? open : undefined}
        aria-label={withTurns ? tr('turnRail.label') : undefined}
        data-turn-ticks={withTurns ? ticks.length : undefined}
        onKeyDown={onKey}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onWheel={e => scroller.current?.scrollBy({ top: e.deltaY })}
        className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {/* 有刻度时滑块是刻度后面的一块淡底色（看得到的这几轮），刻度画在上面、不被压着；只有滚动条时还是细滑块 */}
        <span
          data-rail-thumb
          aria-hidden
          style={{ top: PAD + thumb.top, height: thumb.height }}
          className={cn(
            'absolute transition-[width,background-color] duration-(--dur-fast)',
            withTurns
              ? cn(
                  'right-[2px] w-[14px] rounded-[4px]',
                  dragging ? 'bg-fg-faint/40' : 'bg-selected group-hover/rail:bg-fg-faint/25',
                )
              : cn(
                  'right-[6px] rounded-full',
                  dragging ? 'w-2 bg-fg-faint' : 'w-1 bg-selected group-hover/rail:w-2 group-hover/rail:bg-fg-faint/50',
                ),
          )}
        />
        {ticks.map(tick => {
          // 底色里的几轮（屏幕上看得到的）亮一些；刻度都以底色的中线居中
          const inView = tick.y >= thumb.top && tick.y <= thumb.top + thumb.height
          return (
            <span
              key={turns[tick.index]?.id ?? tick.index}
              data-turn-index={tick.index}
              aria-hidden
              aria-current={tick.current ? 'true' : undefined}
              style={{ top: PAD + tick.y }}
              className={cn(
                'pointer-events-none absolute h-[1.5px] -translate-y-1/2 rounded-full transition-[width,opacity] duration-(--dur-fast)',
                tick.current
                  ? 'right-[3px] w-3 bg-fg opacity-90'
                  : cn(
                      'right-[6px] w-1.5 bg-fg-faint group-hover/rail:right-[5px] group-hover/rail:w-2 group-hover/rail:opacity-90',
                      inView ? 'opacity-90' : 'opacity-60',
                    ),
              )}
            />
          )
        })}
      </div>
      {/* 上面还有没显示的轮：滑轨顶部一个淡淡的小标记，在滑块左边、不挡着拖；点它显示更早的一批 */}
      {withTurns && hiddenTurns > 0 && onShowEarlier && (
        <button
          type="button"
          data-turn-earlier-marker
          aria-label={tr('turnRail.earlierItem', { n: hiddenTurns })}
          title={tr('turnRail.earlierItem', { n: hiddenTurns })}
          onClick={showEarlier}
          className="absolute top-[3px] right-[18px] rounded px-0.5 text-[10px] leading-none whitespace-nowrap tabular-nums text-fg-faint opacity-60 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-accent"
        >
          {tr('turnRail.earlierMarker', { n: hiddenTurns })}
        </button>
      )}
      {open && withTurns && (
        <div
          ref={list}
          role="menu"
          data-turn-list
          onKeyDown={onListKey}
          className="pop-in absolute top-1/2 right-full mr-1.5 flex max-h-[min(60vh,440px)] w-[280px] -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line-card bg-popover shadow-popover"
        >
          <div className="flex shrink-0 items-center justify-between px-3 pt-2.5 pb-1.5 text-label text-fg-faint">
            <span>{tr('turnRail.label')}</span>
            <span className="tabular-nums">
              {hiddenTurns + current + 1} / {hiddenTurns + turns.length}
            </span>
          </div>
          <TurnList
            turns={turns}
            current={current}
            onPick={go}
            hiddenTurns={hiddenTurns}
            onShowEarlier={onShowEarlier ? showEarlier : undefined}
          />
        </div>
      )}
    </nav>
  )
}

/** 离得近平滑滚，离得远直接跳（平滑滚过一长段既慢，又要把沿途内容都排版一遍）；动画关了也直接跳 */
function scrollToward(el: HTMLElement, top: number, after?: () => void): void {
  const target = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight))
  const dist = Math.abs(target - el.scrollTop)
  // 已经在目标位置时不会有 scrollend，直接收尾
  if (!motionEnabled() || dist < 1 || dist > el.clientHeight * 3) {
    el.scrollTop = target
    after?.()
    return
  }
  el.scrollTo({ top: target, behavior: 'smooth' })
  if (after) el.addEventListener('scrollend', after, { once: true })
}

function TurnList({
  turns,
  current,
  onPick,
  hiddenTurns,
  onShowEarlier,
}: {
  turns: Turn[]
  current: number
  onPick: (index: number) => void
  hiddenTurns: number
  onShowEarlier?: () => void
}) {
  useI18n()
  const box = useRef<HTMLDivElement>(null)
  // 打开时把当前轮滚到列表中间
  useLayoutEffect(() => {
    box.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'center' })
  }, [])
  return (
    <div ref={box} className="min-h-0 overflow-y-auto px-1.5 pb-1.5">
      {hiddenTurns > 0 && onShowEarlier && (
        <button
          type="button"
          role="menuitem"
          data-turn-item="earlier"
          data-turn-earlier-item
          tabIndex={-1}
          onClick={onShowEarlier}
          className="flex w-full items-baseline gap-2.5 rounded-lg px-2 py-1.5 text-left text-meta text-fg-faint outline-none hover:bg-hover hover:text-fg-secondary focus-visible:bg-hover"
        >
          <span className="w-5 shrink-0 text-right">↑</span>
          <span className="min-w-0 flex-1 truncate">{tr('turnRail.earlierItem', { n: hiddenTurns })}</span>
        </button>
      )}
      {turns.map((t, i) => {
        const active = i === current
        return (
          <button
            key={t.id}
            type="button"
            role="menuitem"
            data-turn-item={i}
            aria-current={active ? 'true' : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => onPick(i)}
            className={cn(
              'relative flex w-full items-baseline gap-2.5 rounded-lg px-2 py-1.5 text-left text-meta outline-none hover:bg-hover focus-visible:bg-hover',
              active ? 'bg-hover text-fg' : 'text-fg-secondary',
            )}
          >
            {active && <span className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent" />}
            <span className={cn('w-5 shrink-0 text-right tabular-nums', active ? 'text-accent-fg' : 'text-fg-faint')}>
              {t.n}
            </span>
            <span className="min-w-0 flex-1 truncate">{t.preview || tr('turnRail.imageOnly')}</span>
          </button>
        )
      })}
    </div>
  )
}
