import { useI18n } from '@/i18n/I18nProvider'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from './cn'
import { isTypingTarget, pickByDigit } from './menuDigit'
import { placePopover, type PopoverAlign, type PopoverSide } from './placePopover'

interface PopoverProps {
  open: boolean
  onClose: () => void
  /** 只写宽度 / 高度 / 内边距等样式类（w-72、max-h-96…）；位置由 side / align / offset 决定，别再写 top-full、left-0、mt-1 */
  className?: string
  /** 放在锚点的哪一边，默认 bottom；放不下而对面更宽裕时自动翻到对面 */
  side?: PopoverSide
  /** 和锚点的哪条边对齐：start = 左边 / 上边，end = 右边 / 下边，默认 start */
  align?: PopoverAlign
  /** 和锚点的间隙（px），默认 4（mt-1）；原来写 mb-2 / ml-2 的传 8 */
  offset?: number
  /** 宽度取锚点的宽度（原来的 w-full） */
  matchWidth?: boolean
  /**
   * 锚点元素；不传时用 Popover 所在位置的父元素（原来的 relative 容器）。
   * 弹层渲染到 document.body、position: fixed，不会被窄栏的 overflow 裁掉。
   * 点锚点算「里面」：打开时再点触发按钮，只由按钮自己的 onClick 切换
   */
  anchor?: RefObject<HTMLElement | null>
  /** 去掉默认的 p-1 和最小宽度（自带内边距的面板，例如分支菜单） */
  bare?: boolean
  /** 上下弹出时横向尽量留在这个范围里（窗口坐标，例如锚点所在的窗格）；每次定位时调用 */
  within?: () => { left: number; right: number } | null
  role?: 'dialog' | 'menu'
  'aria-label'?: string
  children: ReactNode
}

/** 弹层嵌套：里层打开时让外层不抢 Esc 和数字键 */
const NestCtx = createContext<{ enter: () => void; leave: () => void } | null>(null)

/**
 * 简单弹出层：点外面或按 Esc 关闭；焦点不在输入框里时按 1–9 选第 N 个菜单项（带 data-menu-item 的，PopoverItem 自带）。
 * 嵌套的弹层各自渲染到 body，靠 React 事件冒泡（穿过 portal）判断「点在里层也算点在外层里面」。
 */
export function Popover({
  open,
  onClose,
  className,
  side = 'bottom',
  align = 'start',
  offset = 4,
  matchWidth = false,
  anchor,
  bare = false,
  within,
  role,
  'aria-label': ariaLabel,
  children,
}: PopoverProps) {
  useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const marker = useRef<HTMLSpanElement>(null)
  /** React 的 mousedown（含里层 portal 冒上来的）先于 document 监听器触发，在这里记一笔 */
  const inside = useRef(false)
  const kids = useRef(0)
  const parent = useContext(NestCtx)
  const nest = useMemo(
    () => ({
      enter: () => void kids.current++,
      leave: () => void kids.current--,
    }),
    [],
  )
  const getAnchor = () => anchor?.current ?? marker.current?.parentElement ?? null

  useEffect(() => {
    if (!open || !parent) return
    parent.enter()
    return () => parent.leave()
  }, [open, parent])

  // 定位：打开、窗口缩放、任意祖先滚动、弹层自己变大变小时重新量
  useLayoutEffect(() => {
    const el = ref.current
    if (!open || !el) return
    const place = () => {
      const a = getAnchor()
      if (!a) return
      const r = a.getBoundingClientRect()
      const vw = window.innerWidth,
        vh = window.innerHeight
      // 先复位再量自然尺寸，免得上一次的限制影响这一次
      el.style.left = '0px'
      el.style.top = '0px'
      el.style.maxHeight = ''
      el.style.overflowY = ''
      el.style.maxWidth = `${vw - 16}px`
      if (matchWidth) el.style.width = `${r.width}px`
      const size = { width: el.offsetWidth, height: el.offsetHeight }
      const p = placePopover(
        r,
        size,
        { width: vw, height: vh },
        { side, align, offset, within: within?.() ?? undefined },
      )
      if (size.height > p.maxHeight) {
        el.style.maxHeight = `${p.maxHeight}px`
        if (getComputedStyle(el).overflowY === 'visible') el.style.overflowY = 'auto'
      }
      el.style.left = `${p.left}px`
      el.style.top = `${p.top}px`
    }
    place()
    const onScroll = (e: Event) => {
      if (!el.contains(e.target as Node)) place()
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getAnchor 只读 ref
  }, [open, side, align, offset, matchWidth, anchor])

  useEffect(() => {
    if (!open) return
    // 捕获阶段先清零，免得里面有人 stopPropagation 后标记残留到下一次点击
    const reset = () => {
      inside.current = false
    }
    const onDown = (e: MouseEvent) => {
      if (inside.current) {
        inside.current = false
        return
      }
      if (getAnchor()?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      // 里面又开着一层（「更多工具」里的打开方式）时 Esc 和数字键都交给里层：Esc 只关最里面那层
      if (e.key === 'Escape') {
        if (kids.current === 0) onClose()
      } else if (!e.defaultPrevented && ref.current && kids.current === 0 && !isTypingTarget(document.activeElement))
        pickByDigit(e, [...ref.current.querySelectorAll<HTMLElement>('[data-menu-item]:not(:disabled)')])
    }
    document.addEventListener('mousedown', reset, true)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', reset, true)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getAnchor 只读 ref
  }, [open, onClose, anchor])

  return (
    <>
      <span ref={marker} hidden />
      {open &&
        createPortal(
          <NestCtx.Provider value={nest}>
            <div
              ref={ref}
              data-popover
              role={role}
              aria-label={ariaLabel}
              onMouseDownCapture={() => {
                inside.current = true
              }}
              className={cn(
                'pop-in no-drag fixed z-[60] rounded-lg border border-line-card bg-popover shadow-menu',
                !bare && 'min-w-44 p-1',
                className,
              )}
            >
              {children}
            </div>
          </NestCtx.Provider>,
          document.body,
        )}
    </>
  )
}

interface PopoverItemProps {
  icon?: ReactNode
  selected?: boolean
  onClick?: () => void
  /** 右边的快捷方式提示，例如「@」 */
  hint?: ReactNode
  disabled?: boolean
  /** 鼠标提示（不可点时说明原因） */
  title?: string
  /** 单选列表里用 menuitemradio + checked，读屏会念「已选中」 */
  role?: 'menuitem' | 'menuitemradio'
  checked?: boolean
  children: ReactNode
}

export function PopoverItem({
  icon,
  selected,
  onClick,
  hint,
  disabled,
  title,
  role,
  checked,
  children,
}: PopoverItemProps) {
  useI18n()
  return (
    <button
      type="button"
      data-menu-item
      role={role}
      aria-checked={role === 'menuitemradio' ? !!checked : undefined}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-fg hover:bg-hover',
        selected && 'bg-selected hover:bg-selected',
        disabled && 'cursor-default opacity-50 hover:bg-transparent',
      )}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {hint && <span className="shrink-0 font-mono text-meta text-fg-faint">{hint}</span>}
    </button>
  )
}
