import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Circle,
  CircleDot,
  Columns2,
  Copy,
  PencilLine,
  Pin,
  PinOff,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { useEngineState } from '@/features/engine'
import { markSessionUnread } from '@/features/engine/store'
import { paneActions } from '@/features/panes/store'
import { useSessionActions, type SessionTarget } from './SessionActions'
export function SessionRow({
  target,
  selected,
  onSelect,
  children,
  trailing,
  className,
  flipKey,
}: {
  target: SessionTarget
  selected: boolean
  onSelect: (id: string) => void
  children: ReactNode
  trailing: ReactNode
  className?: string
  /** 换顺序时这一行滑动用的标记（useFlip 读 data-flip-key）；同一个列表里不重复，不传就不滑 */
  flipKey?: string
}) {
  const { t } = useI18n(),
    actions = useSessionActions(),
    row = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null),
    [coords, setCoords] = useState<{ x: number; y: number } | null>(null)
  const close = (restore = true): void => {
    setPosition(null)
    setCoords(null)
    if (restore) button.current?.focus({ preventScroll: true })
  }
  const unread = useEngineState(s => !!s.unread[target.id])
  // 菜单项点击：先关菜单（焦点不回到行内按钮，动作自己处理），再执行
  const run = (fn: () => void): void => {
    close(false)
    fn()
  }
  const show = (x?: number, y?: number): void => {
    const rect = row.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({ x: x ?? rect.right - 180, y: y ?? rect.bottom + 4 })
  }
  useLayoutEffect(() => {
    if (!position || !menu.current) return
    const rect = menu.current.getBoundingClientRect()
    setCoords({
      x: Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8)),
    })
    const down = (e: PointerEvent): void => {
      if (!menu.current?.contains(e.target as Node) && !row.current?.contains(e.target as Node)) close(false)
    }
    const scroll = (e: Event): void => {
      if (!menu.current?.contains(e.target as Node)) close(false)
    }
    const resize = (): void => close(false)
    document.addEventListener('pointerdown', down)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', resize)
    }
  }, [position])
  useLayoutEffect(() => {
    if (coords) menu.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus({ preventScroll: true })
  }, [coords])
  return (
    <div
      ref={row}
      data-session-row={target.id}
      data-flip-key={flipKey}
      data-archived={target.archived || undefined}
      onContextMenu={event => {
        event.preventDefault()
        show(event.clientX, event.clientY)
      }}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          show()
        }
      }}
      className={cn(
        'group/session relative flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-md pr-2.5 text-list transition-colors',
        selected ? 'bg-selected text-fg' : 'text-fg-secondary hover:bg-hover',
        target.archived && 'text-fg-muted',
        className,
      )}
    >
      <button
        ref={button}
        type="button"
        title={target.title}
        onClick={() => onSelect(target.id)}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-md pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        {children}
      </button>
      <div className="relative flex h-full min-w-6 shrink-0 items-center justify-end">
        <span
          className={cn(
            'flex items-center gap-1.5 group-hover/session:invisible group-focus-within/session:invisible',
            position && 'invisible',
          )}
        >
          {trailing}
        </span>
        <div
          className={cn(
            'absolute right-0 flex items-center gap-0.5',
            position ? 'visible' : 'invisible group-hover/session:visible group-focus-within/session:visible',
          )}
        >
          {[
            {
              key: 'pin',
              label: t(target.pinned ? 'session.unpin' : 'session.pin'),
              icon: target.pinned ? PinOff : Pin,
              run: () => actions.request('pin', target),
            },
            {
              key: 'archive',
              label: t(target.archived ? 'session.restore' : 'session.archive'),
              icon: target.archived ? ArchiveRestore : Archive,
              run: () => actions.request(target.archived ? 'restore' : 'archive', target),
            },
          ].map(({ key, label, icon: Icon, run }) => (
            <button
              key={key}
              type="button"
              disabled={actions.busy}
              aria-label={label}
              title={label}
              onClick={event => {
                event.stopPropagation()
                run()
              }}
              className="flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-selected hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
            >
              <Icon size={15} strokeWidth={1.5} />
            </button>
          ))}
        </div>
      </div>
      {position &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={t('session.menu')}
            data-session-menu
            className="pop-in no-drag fixed z-[70] min-w-44 rounded-lg border border-line-card bg-popover p-1 text-fg shadow-menu"
            style={{
              left: coords?.x ?? position.x,
              top: coords?.y ?? position.y,
              visibility: coords ? 'visible' : 'hidden',
            }}
            onKeyDown={event => {
              const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role=menuitem]')],
                i = items.indexOf(document.activeElement as HTMLButtonElement)
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                close()
              }
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                items[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (i + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
                ]?.focus({ preventScroll: true })
              }
              if (event.key === 'Tab') {
                event.preventDefault()
                close()
              }
            }}
          >
            <MenuItem
              icon={target.pinned ? PinOff : Pin}
              label={t(target.pinned ? 'session.unpin' : 'session.pin')}
              disabled={actions.busy}
              onClick={() => run(() => actions.request('pin', target))}
            />
            <MenuItem
              icon={target.bottomed ? ArrowUpFromLine : ArrowDownToLine}
              label={t(target.bottomed ? 'session.unbottom' : 'session.bottom')}
              disabled={actions.busy}
              onClick={() => run(() => actions.request('bottom', target))}
            />
            <MenuItem
              icon={unread ? Circle : CircleDot}
              label={t(unread ? 'session.markRead' : 'session.markUnread')}
              disabled={target.running}
              onClick={() => run(() => markSessionUnread(target.id, !unread))}
            />
            <MenuItem
              icon={Columns2}
              label={t('session.openInSplit')}
              onClick={() =>
                run(() => {
                  const r = document.querySelector('.pane-area')?.getBoundingClientRect()
                  paneActions.openInSplit(target.id, { width: r?.width ?? 0, height: r?.height ?? 0 })
                })
              }
            />
            <MenuItem
              icon={PencilLine}
              label={t('session.rename')}
              disabled={actions.busy}
              onClick={() => run(() => actions.request('rename', target))}
            />
            <MenuItem
              icon={target.archived ? ArchiveRestore : Archive}
              label={t(target.archived ? 'session.restore' : 'session.archive')}
              disabled={actions.busy}
              onClick={() => run(() => actions.request(target.archived ? 'restore' : 'archive', target))}
            />
            <div role="separator" className="my-1 border-t border-line-subtle" />
            <MenuItem icon={Copy} label={t('session.copyId')} onClick={() => run(() => actions.copyId(target))} />
            <div role="separator" className="my-1 border-t border-line-subtle" />
            <MenuItem
              icon={Trash2}
              label={t('session.deleteMenu')}
              danger
              disabled={actions.busy}
              onClick={() => run(() => actions.request('delete', target))}
            />
          </div>,
          document.body,
        )}
    </div>
  )
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-ui hover:bg-hover disabled:opacity-40',
        danger && 'text-danger',
      )}
    >
      <Icon size={15} strokeWidth={1.5} />
      {label}
    </button>
  )
}
