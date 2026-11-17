// 选了设备时网页上面的一条（docs/ui/browser-v2.md §3.3）：手机 390×844 · 58% · 横竖 · 触摸，自定义时能改宽高，右边网页主题
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Hand, RotateCcw, X } from 'lucide-react'
import { IconButton, cn } from '@/ui'
import { ActionMenu } from '@/ui/ActionMenu'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import {
  CUSTOM_SIZE,
  deviceSize,
  type BrowserPageTheme,
  type BrowserPreview,
} from '../../../../shared/types/project-browser'
import { DEVICE_ICON, THEME_ICON, currentPreview, deviceActions, deviceName, sizeText } from './browserPreviewMenu'

export function BrowserDeviceBar({
  preview,
  scale,
  compact,
  busy,
  onChange,
}: {
  preview: BrowserPreview
  /** 设备框缩小的比例；还没量出网页区时 null */
  scale: number | null
  /** 窄：不显示网页主题（⋯ 菜单里有），触摸只留图标 */
  compact: boolean
  busy: boolean
  onChange: (next: BrowserPreview) => void
}) {
  useI18n()
  const now = currentPreview(preview),
    size = deviceSize(now)
  const nameButton = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const Icon = DEVICE_ICON[now.device]
  const theme = now.theme ?? 'system'
  return (
    <div
      data-browser-device-bar
      className="flex h-8 shrink-0 items-center gap-1.5 overflow-hidden rounded-md border border-line-card bg-surface px-1 text-label whitespace-nowrap text-fg-muted"
    >
      <button
        ref={nameButton}
        type="button"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title={tr('projectTools.device')}
        onClick={() => {
          const r = nameButton.current?.getBoundingClientRect()
          if (r) setMenu(menu ? null : { x: r.left, y: r.bottom + 4 })
        }}
        className={cn(
          'inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 font-medium text-fg hover:bg-hover',
          menu && 'bg-selected',
        )}
      >
        <Icon size={13} strokeWidth={1.5} />
        {deviceName(now.device)}
        <ChevronDown size={12} className="text-fg-faint" />
      </button>
      {now.device === 'custom' ? (
        <span className="flex shrink-0 items-center gap-0.5 tabular-nums">
          <SizeInput
            label={tr('projectTools.deviceWidth')}
            value={size?.width ?? CUSTOM_SIZE.width}
            onCommit={v =>
              onChange({ ...now, width: now.landscape ? now.width : v, height: now.landscape ? v : now.height })
            }
          />
          ×
          <SizeInput
            label={tr('projectTools.deviceHeight')}
            value={size?.height ?? CUSTOM_SIZE.height}
            onCommit={v =>
              onChange({ ...now, height: now.landscape ? now.height : v, width: now.landscape ? v : now.width })
            }
          />
        </span>
      ) : (
        <span className="shrink-0 tabular-nums">{sizeText(now)}</span>
      )}
      {scale !== null && <span className="shrink-0 tabular-nums">· {Math.round(scale * 100)}%</span>}
      <IconButton
        icon={RotateCcw}
        size={24}
        iconSize={13}
        label={tr('projectTools.deviceRotate')}
        active={!!now.landscape}
        aria-pressed={!!now.landscape}
        disabled={busy}
        onClick={() => onChange({ ...now, landscape: !now.landscape })}
      />
      {size && size.kind !== 'desktop' && (
        <span
          title={tr('projectTools.deviceTouchHint')}
          className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-accent-soft px-1.5 py-0.5 text-accent-fg"
        >
          <Hand size={12} />
          {!compact && tr('projectTools.deviceTouch')}
        </span>
      )}
      <span className="min-w-0 flex-1" />
      {/* 网页主题：只改网页看到的明暗 */}
      {!compact && (
        <span
          role="radiogroup"
          aria-label={tr('projectTools.pageTheme')}
          title={tr('projectTools.pageThemeHint')}
          className="flex shrink-0 rounded-md bg-subtle p-0.5"
        >
          {(['system', 'light', 'dark'] as BrowserPageTheme[]).map(t => {
            const ThemeIcon = THEME_ICON[t]
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={theme === t}
                aria-label={tr(`projectTools.pageTheme.${t}`)}
                title={tr(`projectTools.pageTheme.${t}`)}
                disabled={busy}
                onClick={() => onChange({ ...now, theme: t })}
                className={cn(
                  'inline-flex size-5 items-center justify-center rounded-sm',
                  theme === t ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
                )}
              >
                <ThemeIcon size={12} />
              </button>
            )
          })}
        </span>
      )}
      <IconButton
        icon={X}
        size={24}
        iconSize={13}
        label={tr('projectTools.deviceOff')}
        disabled={busy}
        onClick={() => onChange({ ...now, device: 'responsive', landscape: false })}
      />
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={tr('projectTools.device')}
          actions={deviceActions(now, onChange, busy)}
          onClose={() => {
            setMenu(null)
            nameButton.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </div>
  )
}

/** 自定义宽高：回车或离开时提交，超出范围的夹到 200–4000 */
function SizeInput({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = Number.parseInt(text, 10)
    if (!Number.isFinite(n)) return setText(String(value))
    const v = Math.min(CUSTOM_SIZE.max, Math.max(CUSTOM_SIZE.min, n))
    setText(String(v))
    if (v !== value) onCommit(v)
  }
  return (
    <input
      inputMode="numeric"
      aria-label={label}
      title={`${label} ${CUSTOM_SIZE.min}–${CUSTOM_SIZE.max}`}
      value={text}
      onChange={e => setText(e.target.value.replace(/\D/g, '').slice(0, 4))}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          setText(String(value))
        }
      }}
      className="h-6 w-12 rounded-sm border border-line bg-surface px-1 text-center text-label text-fg outline-none focus:border-accent"
    />
  )
}
