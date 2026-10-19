import { useEffect, useRef, useState } from 'react'
import { SquareArrowOutUpRight, X } from 'lucide-react'
import { IconButton } from '@/ui'
import { tr } from '../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { SettingsContent, type SectionId } from './SettingsContent'
import { leaveSettings } from './unsavedEdits'

export type { SectionId } from './SettingsContent'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const SIZE_KEY = 'pixelsky.settings-size'
const MIN_W = 640
const MIN_H = 440
/** 和窗口边缘至少留的距离 */
const MARGIN = 12

/** 限制在窗口内：最小 640 × 440，不超过窗口；位置不跑出窗口 */
function clampRect(r: Rect): Rect {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.max(Math.min(MIN_W, vw - MARGIN * 2), Math.min(r.w, vw - MARGIN * 2))
  const h = Math.max(Math.min(MIN_H, vh - MARGIN * 2), Math.min(r.h, vh - MARGIN * 2))
  const x = Math.min(Math.max(MARGIN, r.x), vw - w - MARGIN)
  const y = Math.min(Math.max(MARGIN, r.y), vh - h - MARGIN)
  return { x, y, w, h }
}

/** 打开时：沿用上次的尺寸（默认 980 × 680），在窗口里居中 */
function initialRect(): Rect {
  let w = 980
  let h = 680
  try {
    const s = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null')
    if (s && typeof s.w === 'number' && typeof s.h === 'number') {
      w = s.w
      h = s.h
    }
  } catch {
    /* 忽略 */
  }
  const r = clampRect({ x: 0, y: 0, w, h })
  return clampRect({ ...r, x: (window.innerWidth - r.w) / 2, y: (window.innerHeight - r.h) / 2 })
}

/**
 * 设置浮层的外框：遮罩、拖动标题栏移动、右下角改大小、Esc / 点遮罩 / × 关闭（docs/ui/settings.md §10）。
 * 里面的导航和分区页是 SettingsContent，独立窗口（SettingsWindow）共用。
 * 标题栏的「在独立窗口中打开」把设置弹成一个系统窗口（docs/ui/settings-window.md）。
 */
export function SettingsDialog({
  section,
  onSectionChange,
  onClose,
  onPopOut,
}: {
  /** 与入口共享当前分类，内部导航与搜索跳转也同步更新。 */
  section: SectionId
  onSectionChange: (section: SectionId) => void
  onClose: () => void
  /** 在独立窗口中打开；没有这个入口（演示、没有主进程）时不传，不显示按钮 */
  onPopOut?: () => void
}) {
  const { text, t } = useI18n()
  // 位置和尺寸（docs/ui/settings.md §10）：标题栏拖动移动、右下角拖动缩放；尺寸记在本机，位置每次打开居中
  const [rect, setRect] = useState<Rect>(() => initialRect())
  const rectRef = useRef(rect)
  rectRef.current = rect
  const dialogRef = useRef<HTMLDivElement>(null)

  // 主窗口变小时把对话框收回窗口内
  useEffect(() => {
    const onResize = () => setRect(r => clampRect(r))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /** 按下后跟随鼠标：mode=move 移动，mode=resize 改右下角 */
  const startDrag = (e: React.MouseEvent, mode: 'move' | 'resize') => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const start = { x: e.clientX, y: e.clientY, rect: rectRef.current }
    document.body.style.cursor = mode === 'move' ? 'grabbing' : 'se-resize'
    // 最后一次计算出的尺寸：松手时直接存它，不读 rectRef（松手前可能还没重新渲染，读到的是旧值）
    let last = start.rect
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      const r = start.rect
      last = clampRect(mode === 'move' ? { ...r, x: r.x + dx, y: r.y + dy } : { ...r, w: r.w + dx, h: r.h + dy })
      setRect(last)
    }
    const onUp = () => {
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (mode === 'resize') {
        try {
          localStorage.setItem(SIZE_KEY, JSON.stringify({ w: last.w, h: last.h }))
        } catch {
          /* 忽略 */
        }
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // 焦点放在对话框本身（不显示焦点框），Tab 再进入里面的控件
  useEffect(() => dialogRef.current?.focus(), [])

  return (
    <div
      className="fade-in no-drag fixed inset-0 z-50 bg-scrim"
      onMouseDown={e => {
        if (e.target === e.currentTarget) leaveSettings(onClose)
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-settings-dialog
        className="pop-in outline-none absolute flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-popover"
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      >
        {/* 标题栏空白处按住拖动，移动设置窗口 */}
        <header
          onMouseDown={e => {
            if ((e.target as HTMLElement).closest('button')) return
            startDrag(e, 'move')
          }}
          className="flex h-12 shrink-0 cursor-grab items-center justify-between border-b border-line pr-2 pl-5 select-none active:cursor-grabbing"
        >
          <h2 id="settings-title" className="text-section font-semibold text-fg">
            {t('sidebar.SidebarFooter.settings')}
          </h2>
          <div className="flex items-center gap-0.5">
            {onPopOut && (
              <IconButton
                icon={SquareArrowOutUpRight}
                label={tr('settingsWindow.popOutTip')}
                onClick={() => leaveSettings(onPopOut)}
              />
            )}
            <IconButton icon={X} label={text('关闭（Esc）')} onClick={() => leaveSettings(onClose)} />
          </div>
        </header>

        {/* 右下角的调整大小手柄：拖动改变宽 / 高（记住尺寸，下次打开沿用） */}
        <div
          aria-hidden
          title={tr('settings.SettingsDialog.dragToResize')}
          onMouseDown={e => startDrag(e, 'resize')}
          className="absolute right-0 bottom-0 z-10 flex size-5 cursor-se-resize items-end justify-end p-1 text-fg-faint hover:text-fg-muted"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M9 3 3 9M9 6.5 6.5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </div>

        <SettingsContent
          section={section}
          onSectionChange={onSectionChange}
          standalone={false}
          onClose={onClose}
          onEscape={onClose}
        />
      </div>
    </div>
  )
}
