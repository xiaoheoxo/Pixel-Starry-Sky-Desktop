import { scrollInPane } from './scrollInPane'
import { useI18n } from '@/i18n/I18nProvider'
// 主题下拉框：替代原生 <select>（原生弹出层由系统绘制，不跟随浅色 / 深色主题和设计变量）。
// 写法同 features/search/ProjectFilter.tsx：焦点留在触发按钮上，方向键 / Home / End / Enter / Esc / 首字母跳转，
// 菜单用 Portal 放到 body，不被设置弹窗、滚动容器裁切；滚动或点外面时关闭。
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from './cn'

export interface SelectOption<V extends string> {
  value: V
  label: string
  /** 选项右边的灰色小字 */
  hint?: string
  /** Disabled choices can explain why they are unavailable. */
  description?: string
  disabled?: boolean
}

const ROW = 32

export function Select<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  placeholder,
  mono,
  className,
  icon,
  fitContent = false,
}: {
  /** 无障碍名称（屏幕阅读器读的） */
  label: string
  value: V
  options: readonly SelectOption<V>[]
  onChange: (value: V) => void
  disabled?: boolean
  /** 选项里没有当前值时显示的文字 */
  placeholder?: string
  /** 选项用等宽字（模型名等） */
  mono?: boolean
  className?: string
  icon?: ReactNode
  /** Menus launched by compact icon buttons may need more width than their trigger. */
  fitContent?: boolean
}) {
  useI18n()
  const listId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const selected = options.findIndex(o => o.value === value)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(Math.max(0, selected))
  const [position, setPosition] = useState({ left: 0, top: 0, width: 220, maxHeight: 280 })
  const typeahead = useRef({ text: '', at: 0 })
  const activeIndex = Math.min(active, options.length - 1)
  const current = selected >= 0 ? options[selected] : null

  const show = (): void => {
    if (disabled || options.length === 0) return
    setActive(
      selected >= 0 && !options[selected].disabled
        ? selected
        : Math.max(
            0,
            options.findIndex(o => !o.disabled),
          ),
    )
    setOpen(true)
  }
  const choose = (index: number): void => {
    const o = options[index]
    if (!o || o.disabled) return
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
    if (o.value !== value) onChange(o.value)
  }
  const step = (from: number, dir: 1 | -1): number => {
    for (let i = 1; i <= options.length; i++) {
      const n = (from + dir * i + options.length) % options.length
      if (!options[n].disabled) return n
    }
    return from
  }

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = trigger.current?.getBoundingClientRect()
      if (!r) return
      let contentWidth = 0
      if (fitContent && menu.current) {
        const sample = menu.current.querySelector<HTMLElement>('[data-select-label]')
        if (sample) {
          const style = getComputedStyle(sample)
          const measure = document.createElement('span')
          Object.assign(measure.style, {
            position: 'fixed',
            visibility: 'hidden',
            whiteSpace: 'pre',
            width: 'max-content',
            font: style.font,
            letterSpacing: style.letterSpacing,
          })
          document.body.appendChild(measure)
          for (const option of options) {
            measure.textContent = option.label
            contentWidth = Math.max(contentWidth, measure.getBoundingClientRect().width)
          }
          measure.remove()
        }
      }
      const width = Math.min(
        Math.max(r.width, fitContent ? Math.ceil(contentWidth) + 64 : 180),
        fitContent ? 520 : 360,
        window.innerWidth - 16,
      )
      // Measure wrapped rows at their final width before deciding whether to flip.
      if (fitContent && menu.current) menu.current.style.width = `${width}px`
      const height = Math.min(
        320,
        fitContent ? (menu.current?.scrollHeight ?? options.length * ROW + 8) : options.length * ROW + 8,
      )
      const below = window.innerHeight - r.bottom - 12
      const above = r.top - 12
      const flip = below < height && above > below
      const maxHeight = Math.max(ROW + 8, Math.min(320, flip ? above : below))
      setPosition({
        width,
        maxHeight,
        left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
        top: flip ? r.top - 4 - Math.min(height, maxHeight) : r.bottom + 4,
      })
    }
    place()
    const observer = new ResizeObserver(place)
    if (fitContent && menu.current) for (const row of menu.current.children) observer.observe(row)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('resize', place)
      observer.disconnect()
    }
  }, [open, options, fitContent])

  useEffect(() => {
    if (open) scrollInPane(menu.current?.querySelector(`[data-index="${activeIndex}"]`), 'nearest')
  }, [open, activeIndex])

  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent): void => {
      if (!trigger.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false)
    }
    // 只有触发按钮跟着滚走（滚的是它的祖先）才关；别处在滚（背后的对话流式输出自动滚到底）不关
    const scroll = (e: Event): void => {
      const target = e.target as Node
      if (target === menu.current || menu.current?.contains(target)) return
      if (trigger.current && (target === document || target.contains?.(trigger.current))) setOpen(false)
    }
    // 焦点进了内置浏览器（原生 WebContentsView）、iframe 或别的窗口：那里的点击到不了界面文档，pointerdown 收不到，
    // 触发按钮的 blur 也没有 relatedTarget，只有窗口失焦能看出来。不带 capture，只收 window 自己的 blur（菜单里点选项、滚动、按键都不会触发）
    const blur = (): void => setOpen(false)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', blur)
    }
  }, [open])

  const keydown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return
    if (e.key === 'Tab') {
      setOpen(false)
      return
    }
    // Esc 只关菜单，不关外面的设置弹窗
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
      else if (e.key === 'Home') setActive(step(-1, 1))
      else if (e.key === 'End') setActive(step(options.length, -1))
      else setActive(step(activeIndex, e.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (e.key.length === 1) {
      const now = performance.now()
      const text = (now - typeahead.current.at < 700 ? typeahead.current.text + e.key : e.key).toLowerCase()
      typeahead.current = { text, at: now }
      const index = options.findIndex(o => !o.disabled && o.label.toLowerCase().startsWith(text))
      if (index >= 0) {
        e.preventDefault()
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
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        disabled={disabled}
        title={current?.label ?? placeholder}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={keydown}
        // 焦点去了界面里别的控件才关；没有 relatedTarget 的（焦点落回 body、窗口失焦）这里不管：点外面、Tab、Esc 各自会关，窗口失焦由上面的 effect 关
        onBlur={e => {
          const next = e.relatedTarget as Node | null
          if (next && !menu.current?.contains(next)) setOpen(false)
        }}
        className={cn(
          'flex h-8 w-56 max-w-full min-w-0 items-center gap-2 rounded-md border bg-surface px-2.5 text-left text-ui text-fg outline-none',
          'focus-visible:border-line-strong disabled:cursor-default disabled:opacity-50',
          open ? 'border-line-strong' : 'border-line hover:border-line-strong',
          className,
        )}
      >
        {icon}
        <span className={cn('min-w-0 flex-1 truncate', mono && 'font-mono text-meta', !current && 'text-fg-muted')}>
          {current?.label ?? placeholder ?? ''}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.5}
          className={cn('shrink-0 text-fg-muted transition-transform duration-(--dur-base)', open && 'rotate-180')}
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={listId}
            role="listbox"
            aria-label={label}
            className="pop-in no-drag fixed z-[90] overflow-y-auto rounded-lg border border-line-card bg-popover p-1 shadow-menu"
            style={position}
            onMouseDown={e => e.preventDefault()}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === selected}
                aria-disabled={o.disabled || undefined}
                data-index={i}
                title={o.description ? `${o.label} — ${o.description}` : o.label}
                onPointerMove={() => !o.disabled && setActive(i)}
                onClick={() => choose(i)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2.5 text-ui',
                  fitContent ? 'min-h-8 py-1.5' : 'h-8',
                  o.disabled ? 'cursor-default text-fg-faint' : 'cursor-pointer',
                  !o.disabled && (i === activeIndex ? 'bg-selected text-fg' : 'text-fg-secondary'),
                  i === selected && 'font-medium text-fg',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span
                    data-select-label
                    className={cn(
                      'block',
                      fitContent ? 'whitespace-normal break-words' : 'truncate',
                      mono && 'font-mono text-meta',
                    )}
                  >
                    {o.label}
                  </span>
                  {o.description && (
                    <span className="block whitespace-normal break-words text-label text-fg-muted">
                      {o.description}
                    </span>
                  )}
                </span>
                {o.hint && <span className="shrink-0 text-meta text-fg-faint">{o.hint}</span>}
                <Check
                  size={14}
                  strokeWidth={2}
                  className={cn('shrink-0 text-accent-fg', i !== selected && 'invisible')}
                />
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
