import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Monitor, PanelRight, RotateCcw, UserRound } from 'lucide-react'
import { Button, IconButton, cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import {
  DEFAULT_SIDEBAR_LAYOUT,
  LAYOUT_PLACEMENTS,
  canPlace,
  moveSidebarActionInLayout,
  resetSidebarLayout,
  rowLimit,
  setSidebarLayout,
  useSidebarPrefs,
  type LayoutAction,
  type SidebarLayout,
  type SidebarPlacement,
} from '@/features/appearance/sidebar'
import { getLayoutIcon } from '@/features/appearance/sidebarIcons'

/** full：落点放不下（底部排满，或设置不能进「不显示」） */
type Drop = { row: SidebarPlacement; index: number; x: number; y: number; height: number; full: boolean }
type Gesture = {
  action: LayoutAction
  pointer: number
  x: number
  y: number
  active: boolean
  original: SidebarLayout
  drop: Drop | null
}

const rowOf = (layout: SidebarLayout, action: LayoutAction): SidebarPlacement =>
  LAYOUT_PLACEMENTS.find(r => layout[r].includes(action)) ?? 'header'
const neighbour = (row: SidebarPlacement, step: -1 | 1): SidebarPlacement | undefined =>
  LAYOUT_PLACEMENTS[LAYOUT_PLACEMENTS.indexOf(row) + step]

/** 顶栏 / 侧栏底部 / 不显示三排的布局编辑；只在松开有效落点时提交，预览按钮不会执行真实动作。 */

/** 落点放不下时的提示：设置不能隐藏，其余是这一排满了 */
function refusal(row: SidebarPlacement, action: LayoutAction): string {
  return row === 'hidden' && action === 'settings'
    ? tr('sidebar.layout.settingsRequired')
    : tr('sidebar.layout.full', { row: tr(`sidebar.layout.${row}`), n: rowLimit(row) })
}

export function SidebarLayoutEditor() {
  useI18n()
  const prefs = useSidebarPrefs()
  const root = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const suppressClick = useRef(false)
  const [selected, setSelected] = useState<LayoutAction>('settings')
  const [drag, setDrag] = useState<{ action: LayoutAction; x: number; y: number; drop: Drop | null } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const row = rowOf(prefs.layout, selected)
  const index = prefs.layout[row].indexOf(selected)
  const prev = neighbour(row, -1),
    next = neighbour(row, 1)
  const canMove = (target: SidebarPlacement | undefined): target is SidebarPlacement =>
    !!target && canPlace(prefs.layout, target, selected)
  const isDefault = LAYOUT_PLACEMENTS.every(r => prefs.layout[r].join() === DEFAULT_SIDEBAR_LAYOUT[r].join())

  function focusAction(action: LayoutAction) {
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLButtonElement>(`[data-layout-action="${action}"]`)
        ?.focus({ preventScroll: true }),
    )
  }

  function commit(action: LayoutAction, target: SidebarPlacement, at: number, layout = prefs.layout) {
    if (!canPlace(layout, target, action)) {
      setAnnouncement(refusal(target, action))
      return
    }
    const next = moveSidebarActionInLayout(layout, action, target, at)
    setSidebarLayout(next)
    setSelected(action)
    setAnnouncement(
      tr('sidebar.layout.moved', {
        action: tr(`sidebar.action.${action}`),
        row: tr(`sidebar.layout.${target}`),
        position: next[target].indexOf(action) + 1,
      }),
    )
    focusAction(action)
  }

  useEffect(() => {
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture.current) return
      event.preventDefault()
      event.stopImmediatePropagation()
      suppressClick.current = gesture.current.active
      gesture.current = null
      setDrag(null)
      setAnnouncement(tr('sidebar.layout.cancelled'))
    }
    window.addEventListener('keydown', cancel, true)
    return () => window.removeEventListener('keydown', cancel, true)
  }, [])

  function targetAt(x: number, y: number, action: LayoutAction, layout: SidebarLayout): Drop | null {
    for (const el of root.current?.querySelectorAll<HTMLElement>('[data-layout-row]') ?? []) {
      const rect = el.getBoundingClientRect()
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue
      const elements = [...el.querySelectorAll<HTMLButtonElement>('[data-layout-action]')].filter(
        b => b.dataset.layoutAction !== action,
      )
      const index = elements.findIndex(b => {
        const r = b.getBoundingClientRect()
        return x < r.left + r.width / 2
      })
      const at = index < 0 ? elements.length : index
      const next = elements[at]?.getBoundingClientRect()
      const last = elements.at(-1)?.getBoundingClientRect()
      const group = el.querySelector<HTMLElement>('[data-layout-items]')!.getBoundingClientRect()
      const row = el.dataset.layoutRow as SidebarPlacement
      // 顶栏一排可能折行，插入线跟随相邻图标所在的那一行
      const beside = next ?? last
      return {
        row,
        index: at,
        x: next ? next.left - 2 : last ? last.right + 2 : group.left,
        y: beside ? beside.top : rect.top + 7,
        height: beside ? beside.height : rect.height - 14,
        full: !canPlace(layout, row, action),
      }
    }
    return null
  }

  function start(event: PointerEvent<HTMLButtonElement>, action: LayoutAction) {
    if (event.button !== 0) return
    suppressClick.current = false
    setSelected(action)
    gesture.current = {
      action,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      active: false,
      original: prefs.layout,
      drop: null,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    if (!current.active && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return
    current.active = true
    current.drop = targetAt(event.clientX, event.clientY, current.action, current.original)
    setDrag({ action: current.action, x: event.clientX, y: event.clientY, drop: current.drop })
  }

  function end(event: PointerEvent<HTMLButtonElement>, cancel = false) {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    gesture.current = null
    suppressClick.current = current.active
    setDrag(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (current.active && !cancel) {
      const target = targetAt(event.clientX, event.clientY, current.action, current.original)
      if (target) commit(current.action, target.row, target.index, current.original)
      else setAnnouncement(tr('sidebar.layout.cancelled'))
    }
  }

  function onKey(event: KeyboardEvent<HTMLButtonElement>, action: LayoutAction) {
    const source = rowOf(prefs.layout, action)
    const at = prefs.layout[source].indexOf(action)
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'ArrowLeft' && at > 0) commit(action, source, at - 1)
    if (event.key === 'ArrowRight' && at < prefs.layout[source].length - 1) commit(action, source, at + 1)
    const target = neighbour(source, event.key === 'ArrowUp' ? -1 : 1)
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && target)
      commit(action, target, Math.min(at, prefs.layout[target].length))
  }

  const DragIcon = drag ? getLayoutIcon(drag.action, prefs.icons) : null
  return (
    <div ref={root} data-sidebar-layout-editor>
      <div
        className="w-full max-w-96 space-y-1 rounded-lg border border-line bg-subtle p-2"
        role="group"
        aria-label={tr('sidebar.layout.preview')}
      >
        {LAYOUT_PLACEMENTS.map(placement => (
          <div key={placement}>
            <div className="px-1 text-meta text-fg-muted">{tr(`sidebar.layout.${placement}`)}</div>
            <div
              data-layout-row={placement}
              className={cn(
                'flex min-h-12 items-center gap-1 rounded-md px-1',
                drag?.drop?.row === placement && (drag.drop.full ? 'bg-hover' : 'bg-accent-soft'),
              )}
              title={drag?.drop?.row === placement && drag.drop.full ? refusal(placement, drag.action) : undefined}
            >
              {placement === 'header' && (
                <span
                  title={tr('sidebar.layout.machineFixed')}
                  className="inline-flex h-8 shrink-0 items-center gap-1 px-1 text-meta text-fg-faint"
                >
                  <Monitor size={14} strokeWidth={1.5} />
                  {tr('sidebar.layout.machine')}
                </span>
              )}
              {placement === 'bottom' && (
                <span
                  title={tr('sidebar.layout.accountFixed')}
                  className="inline-flex h-8 shrink-0 items-center gap-2 px-2 text-fg-faint"
                >
                  <UserRound size={16} strokeWidth={1.5} />
                  <span className="h-1.5 w-10 rounded-full bg-current opacity-40" aria-hidden="true" />
                </span>
              )}
              <div
                data-layout-items
                className={cn('flex min-h-8 min-w-1 flex-wrap items-center gap-1', placement === 'bottom' && 'ml-auto')}
              >
                {placement === 'hidden' && !prefs.layout.hidden.length && (
                  <span className="px-1 text-meta text-fg-faint">{tr('sidebar.layout.hiddenEmpty')}</span>
                )}
                {prefs.layout[placement].map(action => {
                  const Icon = getLayoutIcon(action, prefs.icons)
                  return (
                    <button
                      type="button"
                      key={action}
                      data-layout-action={action}
                      aria-label={tr(`sidebar.action.${action}`)}
                      aria-pressed={selected === action}
                      title={tr('sidebar.layout.drag', { action: tr(`sidebar.action.${action}`) })}
                      onFocus={() => setSelected(action)}
                      onClick={() => {
                        if (suppressClick.current) {
                          suppressClick.current = false
                          return
                        }
                        setSelected(action)
                      }}
                      onPointerDown={event => start(event, action)}
                      onPointerMove={move}
                      onPointerUp={event => end(event)}
                      onPointerCancel={event => end(event, true)}
                      onLostPointerCapture={event => end(event, true)}
                      onKeyDown={event => onKey(event, action)}
                      className={cn(
                        'no-drag inline-flex size-8 shrink-0 touch-none items-center justify-center rounded-md border border-transparent text-fg-muted hover:bg-hover',
                        selected === action && 'border-accent-line bg-accent-soft text-accent-fg',
                        drag?.action === action ? 'cursor-grabbing opacity-40' : 'cursor-grab',
                      )}
                    >
                      <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  )
                })}
              </div>
              {placement === 'header' && (
                <span
                  title={tr('sidebar.layout.panelFixed')}
                  className="ml-auto inline-flex size-8 shrink-0 items-center justify-center text-fg-faint"
                >
                  <PanelRight size={16} strokeWidth={1.5} />
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1" role="group" aria-label={tr('sidebar.layout.controls')}>
        <span className="mr-2 text-ui text-fg-secondary">{tr(`sidebar.action.${selected}`)}</span>
        <IconButton
          icon={ArrowLeft}
          label={tr('sidebar.layout.left')}
          disabled={index === 0}
          onClick={() => commit(selected, row, index - 1)}
          size={32}
        />
        <IconButton
          icon={ArrowRight}
          label={tr('sidebar.layout.right')}
          disabled={index === prefs.layout[row].length - 1}
          onClick={() => commit(selected, row, index + 1)}
          size={32}
        />
        <IconButton
          icon={ArrowUp}
          label={tr('sidebar.layout.toPrev')}
          disabled={!canMove(prev)}
          onClick={() => {
            if (canMove(prev)) commit(selected, prev, prefs.layout[prev].length)
          }}
          size={32}
        />
        <IconButton
          icon={ArrowDown}
          label={tr('sidebar.layout.toNext')}
          disabled={!canMove(next)}
          onClick={() => {
            if (canMove(next)) commit(selected, next, prefs.layout[next].length)
          }}
          size={32}
        />
      </div>
      <p className="mt-2 text-meta text-fg-muted">{tr('sidebar.layout.keyboard')}</p>
      <Button
        variant="ghost"
        icon={RotateCcw}
        className="mt-2 -ml-3"
        disabled={isDefault}
        onClick={() => {
          resetSidebarLayout()
          setAnnouncement(tr('sidebar.layout.resetDone'))
        }}
      >
        {tr('sidebar.layout.reset')}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {drag &&
        DragIcon &&
        createPortal(
          <>
            {drag.drop && !drag.drop.full && (
              <div
                data-layout-insertion
                className="pointer-events-none fixed z-[110] w-0.5 rounded-full bg-accent"
                style={{ left: drag.drop.x, top: drag.drop.y, height: drag.drop.height }}
              />
            )}
            <div
              data-layout-drag-preview
              className="pointer-events-none fixed z-[110] inline-flex size-8 items-center justify-center rounded-md border border-accent-line bg-popover text-accent-fg shadow-menu"
              style={{ left: drag.x + 10, top: drag.y + 10 }}
            >
              <DragIcon size={16} strokeWidth={1.5} />
            </div>
          </>,
          document.body,
        )}
    </div>
  )
}
