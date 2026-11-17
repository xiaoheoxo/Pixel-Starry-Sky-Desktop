import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  MessageSquareText,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Send,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { Button, IconButton, Popover, ResizeHandle, cn } from '@/ui'
import { notifyOverlayChange } from '@/ui/overlayEvents'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import type { BrowserAnnotation, BrowserPage } from '../../../../shared/types/project-browser'
import {
  BAND_RANGE,
  DEFAULT_DOCK_PREFS,
  DOCKS,
  SIDE_RANGE,
  setDockPrefs,
  useDockPrefs,
  type AnnotationDock,
} from './annotationDock'
import { noteTitle, notesRoute } from './annotationText'

const DOCK_ICON: Record<AnnotationDock, LucideIcon> = {
  top: PanelTop,
  bottom: PanelBottom,
  left: PanelLeft,
  right: PanelRight,
}
/** 收起 / 展开的箭头：朝批注栏收进去的方向 */
const FOLD_ICON: Record<AnnotationDock, [LucideIcon, LucideIcon]> = {
  top: [ChevronUp, ChevronDown],
  bottom: [ChevronDown, ChevronUp],
  left: [ChevronLeft, ChevronRight],
  right: [ChevronRight, ChevronLeft],
}

function NoteItem({
  a,
  n,
  band,
  disabled,
  onRemove,
}: {
  a: BrowserAnnotation
  n: number
  /** 放在上下时一张张卡片横着排 */
  band: boolean
  disabled: boolean
  onRemove: (id: string) => void
}) {
  useI18n()
  return (
    <div
      data-annotation-item
      className={cn(
        'group flex min-w-0 items-start gap-2 rounded-md p-1.5 text-meta text-fg-secondary hover:bg-hover',
        band && 'w-56 shrink-0 border border-line-card @max-[640px]:w-auto @max-[640px]:border-transparent',
      )}
    >
      {a.selector ? (
        <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-label font-semibold text-accent-on">
          {n}
        </span>
      ) : (
        <span className="mt-px size-5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <p className="line-clamp-3 break-words whitespace-pre-wrap" title={a.text}>
          {a.text}
        </p>
        {a.selector && (
          <p className="truncate font-mono text-label text-fg-faint" title={a.selector}>
            {noteTitle(a)}
          </p>
        )}
        {a.missing && <p className="text-label text-warn">{tr('projectTools.elementGone')}</p>}
      </div>
      {a.shot && (
        <img
          src={a.shot}
          alt={tr('projectTools.annotationShot')}
          draggable={false}
          className="h-8 w-12 shrink-0 rounded-sm border border-line-card object-cover"
        />
      )}
      <IconButton
        icon={Trash2}
        size={24}
        iconSize={14}
        label={tr('projectTools.remove')}
        disabled={disabled}
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => onRemove(a.id)}
      />
    </div>
  )
}

/**
 * 批注栏（docs/ui/element-annotation.md §7）：可以放在网页的上下左右，所有网页共用一个位置，记住大小和是否收起。
 * 左右时竖排；上下时横排（写批注 | 条目横着排 | 按钮），太窄时也竖排。
 * dock 是实际放的位置；选了左右但面板太窄时，BrowserTab 暂时放下面（fallback）
 */
export function ElementNotes({
  page,
  dock,
  fallback,
  busy,
  canSend,
  note,
  sent,
  onNote,
  onAnnotate,
  onRemove,
  onClear,
  onSend,
  onRestore,
}: {
  page: BrowserPage
  dock: AnnotationDock
  fallback: boolean
  busy: boolean
  /** 能不能发给会话：有会话、不是演示 */
  canSend: boolean
  note: string
  sent: { pageId: string; notes: BrowserAnnotation[] } | null
  onNote: (value: string) => void
  onAnnotate: () => void
  onRemove: (id: string) => void
  onClear: () => void
  onSend: () => void
  onRestore: () => void
}) {
  useI18n()
  const prefs = useDockPrefs()
  const [menu, setMenu] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dockButton = useRef<HTMLButtonElement>(null)
  // 拖动时盖一层透明浮层：网页是盖在界面上的原生视图，鼠标拖进去就收不到事件了，有浮层时 BrowserTab 换成截图
  useEffect(() => notifyOverlayChange(), [dragging])
  const vertical = dock === 'left' || dock === 'right'
  const band = !vertical
  const folded = prefs.folded
  const count = page.annotations.length
  const route = notesRoute(page.annotations)
  const [FoldIcon, UnfoldIcon] = FOLD_ICON[dock]
  const resize = (v: number, save: boolean) => setDockPrefs(vertical ? { side: v } : { band: v }, save)

  const head = (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1.5 px-2.5 py-1.5',
        folded && vertical ? 'flex-col px-1' : 'min-w-0',
        !folded && 'border-b border-line-card',
      )}
    >
      <h3
        className={cn(
          'flex min-w-0 items-center gap-1.5 text-list font-semibold whitespace-nowrap text-fg',
          folded && vertical ? 'flex-col' : 'flex-1',
        )}
      >
        <MessageSquareText size={15} className="shrink-0" />
        {!(folded && vertical) && tr('projectTools.annotation')}
        <span className="font-normal text-fg-muted">{count}</span>
        {route && !folded && (
          <span className="truncate font-mono text-label font-normal text-fg-faint" title={route}>
            {route}
          </span>
        )}
      </h3>
      {/* 收起时刚发出去的也能放回（展开时在下面的提示条里） */}
      {folded && band && sent?.pageId === page.id && (
        <button
          type="button"
          disabled={busy}
          className="shrink-0 text-meta whitespace-nowrap text-accent-fg underline"
          onClick={onRestore}
        >
          {tr('projectTools.restoreAnnotation')}
        </button>
      )}
      {folded && band && count > 0 && (
        <Button
          variant="primary"
          icon={Send}
          data-annotation-send-folded
          className="h-7 px-2.5 text-meta"
          disabled={!canSend || busy}
          title={canSend ? tr('projectTools.sendAnnotationFull') : tr('projectTools.noConversation')}
          onClick={onSend}
        >
          {tr('projectTools.sendAnnotation')}
        </Button>
      )}
      {!(folded && vertical) && (
        <span className="relative shrink-0">
          <IconButton
            ref={dockButton}
            icon={DOCK_ICON[dock]}
            size={24}
            iconSize={15}
            active={menu}
            aria-haspopup="menu"
            aria-expanded={menu}
            label={tr('projectTools.annotationDock', { p0: tr(`projectTools.dock.${dock}`) })}
            onClick={() => setMenu(!menu)}
          />
          {fallback && (
            <span className="pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-warn" />
          )}
          <Popover
            open={menu}
            onClose={() => setMenu(false)}
            anchor={dockButton}
            side={dock === 'bottom' ? 'top' : 'bottom'}
            align="end"
            role="menu"
            aria-label={tr('projectTools.annotationDockAt')}
          >
            <p className="px-1.5 pt-0.5 pb-1.5 text-label text-fg-faint">{tr('projectTools.annotationDockAt')}</p>
            <div className="grid grid-cols-4 gap-1">
              {DOCKS.map(d => {
                const Icon = DOCK_ICON[d]
                const on = prefs.dock === d
                return (
                  <button
                    key={d}
                    role="menuitemradio"
                    aria-checked={on}
                    data-menu-item
                    onClick={() => {
                      setDockPrefs({ dock: d, folded: false })
                      setMenu(false)
                    }}
                    className={cn(
                      'flex flex-col items-center gap-0.5 rounded-md px-2 py-1.5 text-label whitespace-nowrap',
                      on ? 'bg-accent-soft text-accent-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
                    )}
                  >
                    <Icon size={16} />
                    {tr(`projectTools.dock.${d}`)}
                  </button>
                )
              })}
            </div>
            {fallback && (
              <p className="max-w-52 px-1.5 pt-1.5 text-label text-fg-faint">
                {tr('projectTools.annotationDockFallback', { p0: tr(`projectTools.dock.${prefs.dock}`) })}
              </p>
            )}
          </Popover>
        </span>
      )}
      <IconButton
        icon={folded ? UnfoldIcon : FoldIcon}
        size={24}
        iconSize={15}
        aria-expanded={!folded}
        label={tr(folded ? 'projectTools.annotationUnfold' : 'projectTools.annotationFold')}
        onClick={() => setDockPrefs({ folded: !folded })}
      />
    </div>
  )

  const compose = (
    <form
      onSubmit={e => {
        e.preventDefault()
        onAnnotate()
      }}
      className={cn(
        'flex min-w-0 shrink-0 flex-col gap-1.5',
        band && '[grid-area:compose] @max-[480px]:flex-row @max-[480px]:items-start',
      )}
    >
      <textarea
        value={note}
        rows={2}
        maxLength={4000}
        aria-label={tr('projectTools.annotationPlaceholder')}
        onChange={e => onNote(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (!busy && note.trim()) onAnnotate()
          }
        }}
        placeholder={tr('projectTools.annotationPlaceholder')}
        className={cn(
          'min-h-12 w-full min-w-0 resize-none rounded-md border border-line bg-surface px-2.5 py-1.5 text-list text-fg outline-none placeholder:text-fg-faint focus-visible:border-accent',
          band && '@max-[480px]:min-h-8 @max-[480px]:flex-1',
        )}
      />
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('min-w-0 flex-1 truncate text-label text-fg-faint', band && '@max-[480px]:hidden')}>
          {tr('projectTools.annotationHint')}
        </span>
        <Button type="submit" className="whitespace-nowrap" disabled={busy || !note.trim()}>
          {tr('projectTools.save')}
        </Button>
      </div>
    </form>
  )

  const sentBar = sent?.pageId === page.id && (
    <div className="flex shrink-0 items-center gap-2 rounded-md bg-accent-soft px-2.5 py-1.5 text-meta text-accent-fg">
      <span
        className="min-w-0 flex-1 truncate"
        title={tr('projectTools.annotationSent', { p0: String(sent.notes.length) })}
      >
        {tr('projectTools.annotationSent', { p0: String(sent.notes.length) })}
      </span>
      <button disabled={busy} className="shrink-0 whitespace-nowrap underline" onClick={onRestore}>
        {tr('projectTools.restoreAnnotation')}
      </button>
    </div>
  )

  const list = (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-1 gap-1.5 overflow-auto',
        band ? 'flex-row [grid-area:list] @max-[640px]:flex-col' : 'flex-col',
      )}
    >
      {count ? (
        page.annotations.map((a, i) => (
          <NoteItem key={a.id} a={a} n={i + 1} band={band} disabled={busy} onRemove={onRemove} />
        ))
      ) : (
        <p className="m-auto px-2 text-center text-meta text-fg-faint">{tr('projectTools.annotationEmpty')}</p>
      )}
    </div>
  )

  const actions = (
    <div className="flex shrink-0 gap-1.5">
      <Button
        variant="primary"
        icon={Send}
        className="min-w-0 flex-1 justify-center whitespace-nowrap"
        disabled={!canSend || !count || busy}
        title={canSend ? tr('projectTools.sendAnnotationFull') : tr('projectTools.noConversation')}
        onClick={onSend}
      >
        <span className="truncate">{tr('projectTools.sendAnnotation')}</span>
      </Button>
      <IconButton
        icon={Trash2}
        size={32}
        iconSize={15}
        className="border border-line"
        label={tr('projectTools.clearAnnotations')}
        disabled={!count || busy}
        onClick={onClear}
      />
    </div>
  )

  const body = vertical ? (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      {compose}
      {sentBar}
      {list}
      {actions}
    </div>
  ) : (
    // 宽：写批注 | 条目横着排 | 提示和按钮；窄（< 640）：左边上面写批注、下面提示和按钮，右边条目竖着排
    <div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)_11rem] grid-rows-[minmax(0,1fr)] gap-2 p-2 [grid-template-areas:'compose_list_side'] @max-[640px]:grid-cols-[13rem_minmax(0,1fr)] @max-[640px]:grid-rows-[auto_minmax(0,1fr)] @max-[640px]:[grid-template-areas:'compose_list'_'side_list'] @max-[480px]:grid-cols-[minmax(0,1fr)] @max-[480px]:grid-rows-[auto_minmax(0,1fr)_auto] @max-[480px]:[grid-template-areas:'compose'_'list'_'side']">
      {compose}
      {list}
      <div className="flex min-w-0 flex-col justify-between gap-2 border-l border-line-card pl-2 [grid-area:side] @max-[640px]:justify-end @max-[640px]:border-l-0 @max-[640px]:pl-0">
        {sentBar || <span />}
        {actions}
      </div>
    </div>
  )

  const size = vertical ? prefs.side : prefs.band
  const range = vertical ? SIDE_RANGE : BAND_RANGE
  // 把手在批注栏朝网页的那条边上；往网页方向拖是变大
  const edge = {
    right: '-left-1.5 inset-y-0',
    left: '-right-1.5 inset-y-0',
    bottom: '-top-1.5 inset-x-0',
    top: '-bottom-1.5 inset-x-0',
  }[dock]
  const grow = dock === 'right' || dock === 'bottom' ? -1 : 1

  return (
    <aside
      data-annotation-panel={dock}
      className={cn(
        'relative flex shrink-0 flex-col rounded-lg border border-line-card bg-surface shadow-sm',
        band && '@container',
      )}
      style={folded ? undefined : vertical ? { width: prefs.side } : { height: prefs.band }}
    >
      {!folded && (
        <ResizeHandle
          label={tr('projectTools.resizeAnnotations')}
          axis={vertical ? 'x' : 'y'}
          className={edge}
          value={size}
          min={range.min}
          max={range.max}
          scale={grow}
          onChange={v => {
            setDragging(true)
            resize(v, false)
          }}
          onCommit={v => {
            setDragging(false)
            resize(v, true)
          }}
          onReset={() => resize(vertical ? DEFAULT_DOCK_PREFS.side : DEFAULT_DOCK_PREFS.band, true)}
        />
      )}
      {dragging && <div data-floating className="fixed inset-0 z-10" />}
      {head}
      {!folded && body}
    </aside>
  )
}
