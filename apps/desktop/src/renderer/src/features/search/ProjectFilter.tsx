import { scrollInPane } from '@/ui/scrollInPane'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Folder } from 'lucide-react'
import { cn } from '@/ui'

interface ProjectOption {
  id: string
  name: string
}

/** 项目筛选使用主题菜单，焦点保持在触发按钮上，Portal 避免被搜索弹窗裁切。 */
export function ProjectFilter({
  projects,
  value,
  onChange,
}: {
  projects: readonly ProjectOption[]
  value: string | null
  onChange: (id: string | null) => void
}) {
  useI18n()
  const options = [
    {
      id: '',
      get name() {
        return tr('session.live.ApprovalCard.allProjects')
      },
    },
    ...projects,
  ]
  const selected = Math.max(
    0,
    options.findIndex(p => p.id === (value ?? '')),
  )
  const label = options[selected].name
  const listId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(selected)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 260, maxHeight: 240 })
  const typeahead = useRef({ text: '', at: 0 })
  const activeIndex = Math.min(active, options.length - 1)

  const show = () => {
    setActive(selected)
    setOpen(true)
  }
  const choose = (index: number) => {
    onChange(options[index].id || null)
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = trigger.current?.getBoundingClientRect()
      if (!r) return
      const width = Math.min(280, Math.max(220, r.width), window.innerWidth - 16)
      const below = window.innerHeight - r.bottom - 14,
        above = r.top - 14
      const height = Math.min(240, options.length * 34 + 8)
      const flip = below < height && above > below
      const maxHeight = Math.max(40, Math.min(240, flip ? above : below))
      setPosition({
        width,
        maxHeight,
        left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
        top: flip ? r.top - 6 - Math.min(height, maxHeight) : r.bottom + 6,
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, options.length])

  useEffect(() => {
    if (!open) return
    scrollInPane(menu.current?.querySelector(`[data-project-index="${activeIndex}"]`), 'nearest')
  }, [open, activeIndex])

  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false)
    }
    const scroll = (e: Event) => {
      if (e.target !== menu.current && !menu.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [open])

  const keydown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return
    if (e.key === 'Tab') {
      setOpen(false)
      return
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      return
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(e.key)) {
      e.preventDefault()
      e.stopPropagation()
      if (!open) {
        show()
        return
      }
      if (e.key === 'Enter' || e.key === ' ') choose(activeIndex)
      else
        setActive(
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? options.length - 1
              : (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length,
        )
      return
    }
    if (e.key.length === 1) {
      e.preventDefault()
      e.stopPropagation()
      const now = performance.now(),
        text = now - typeahead.current.at < 700 ? typeahead.current.text + e.key : e.key
      typeahead.current = { text: text.toLowerCase(), at: now }
      const index = options.findIndex(p => p.name.toLowerCase().startsWith(typeahead.current.text))
      if (index >= 0) {
        setActive(index)
        setOpen(true)
      }
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={tr('search.ProjectFilter.filterProjects', { p0: label })}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        title={label}
        data-project-filter
        className={cn(
          'flex h-7 min-w-0 max-w-52 items-center gap-1.5 rounded-md border px-2 text-meta outline-none focus-visible:border-accent-line focus-visible:ring-2 focus-visible:ring-accent-line/30',
          open
            ? 'border-line bg-selected text-fg'
            : 'border-transparent text-fg-muted hover:border-line hover:bg-hover hover:text-fg',
        )}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={keydown}
        onBlur={() => setOpen(false)}
      >
        <Folder size={13} strokeWidth={1.5} className="shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown
          size={12}
          strokeWidth={1.5}
          className={cn('shrink-0 text-fg-faint transition-transform duration-(--dur-base)', open && 'rotate-180')}
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={listId}
            role="listbox"
            aria-label={tr('search.ProjectFilter.projectFilterOptions')}
            className="pop-in no-drag fixed z-[60] overflow-y-auto rounded-lg border border-line-card bg-popover p-1 shadow-menu"
            style={position}
            onMouseDown={e => e.preventDefault()}
          >
            {options.map((p, i) => (
              <div
                key={p.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === selected}
                data-project-index={i}
                data-project-value={p.id}
                title={p.name}
                onPointerMove={() => setActive(i)}
                onClick={() => choose(i)}
                className={cn(
                  'flex h-[34px] cursor-pointer items-center gap-2 rounded-md px-2.5 text-ui',
                  i === activeIndex ? 'bg-selected text-fg' : 'text-fg-secondary',
                  i === selected && 'font-medium',
                )}
              >
                <Folder size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {i === selected && <Check size={14} strokeWidth={2} className="shrink-0 text-accent-fg" />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
